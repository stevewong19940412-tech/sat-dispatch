// ─── 轨道参数自愈（纯 PocketBase 版，容器内运行）───────────────────────────
// 背景：satellites 表的 altitude/period 曾全库错误（高度放大 ~78.8 倍、周期 0.2 倍、
// apogee/perigee 为空），而线上库在持久卷里，部署新代码不会覆盖数据。
// 本模块在服务启动时检查：若发现 alt/真实值 偏离超过阈值（说明仍是坏数据），
// 就用每颗星自己的 gpJson（SGP4）重算并回写，修完打印一行日志。
//
// 幂等：数据正常时不做任何写入。

import * as satellite from "satellite.js";
import { pbAll, pbUpdate } from "./pb_repo.mjs";

const EARTH_R_KM = 6371;
const round1 = (x) => Math.round(x * 10) / 10;

function satrecOf(sat) {
  if (sat.gpJson) {
    try {
      const gp = typeof sat.gpJson === "string" ? JSON.parse(sat.gpJson) : sat.gpJson;
      const r = satellite.json2satrec(gp);
      if (r && !r.error) return r;
    } catch {}
  }
  try {
    const r = satellite.twoline2satrec(String(sat.tle1 || "").trim(), String(sat.tle2 || "").trim());
    if (r && !r.error) return r;
  } catch {}
  return null;
}

export function orbitFromSatrec(rec) {
  if (!rec) return null;
  const aKm = rec.a * 6378.137;
  const e = rec.ecco ?? 0;
  return {
    altitude: round1(aKm - EARTH_R_KM),
    apogee: round1(aKm * (1 + e) - EARTH_R_KM),
    perigee: round1(aKm * (1 - e) - EARTH_R_KM),
    period: Math.round(((2 * Math.PI) / rec.no) * 100) / 100,
    inclination: Math.round(((rec.inclo * 180) / Math.PI) * 10000) / 10000,
    eccentricity: e,
  };
}

/**
 * 检查并修复线上 PB 的轨道参数。幂等：数据已正确时零写入。
 * @returns {{checked:number, fixed:number, skipped:number}}
 */
export async function healOrbitParams({ force = false } = {}) {
  const sats = await pbAll("satellites", { fields: "id,noradId,name,altitude,period,apogee,perigee,tle1,tle2,gpJson" });
  let checked = 0, fixed = 0, skipped = 0;
  const ops = [];

  for (const s of sats) {
    const o = orbitFromSatrec(satrecOf(s));
    if (!o) { skipped++; continue; }
    checked++;
    // 判定是否需要修：高度偏差 > 50km，或远/近地点为空/为 0，或周期偏差 > 5 分钟
    const altOff = Math.abs((s.altitude ?? 0) - o.altitude) > 50;
    const perOff = Math.abs((s.period ?? 0) - o.period) > 5;
    const apoMissing = !(s.apogee > 0) || !(s.perigee > 0);
    if (force || altOff || perOff || apoMissing) {
      ops.push({
        id: s.id,
        data: {
          altitude: o.altitude, apogee: o.apogee, perigee: o.perigee,
          period: o.period, inclination: o.inclination, eccentricity: o.eccentricity,
        },
      });
    }
  }

  // 分批回写（PB 单次请求不宜过大）
  for (let i = 0; i < ops.length; i += 20) {
    const chunk = ops.slice(i, i + 20);
    await Promise.all(chunk.map((op) => pbUpdate("satellites", op.id, op.data).catch(() => { fixed--; })));
    fixed += chunk.length;
  }

  if (fixed > 0) {
    console.log(`[orbit-heal] 轨道参数已修正 ${fixed}/${checked} 颗（其余 ${checked - fixed} 颗本就正确，跳过 ${skipped} 颗无法解析）`);
  } else {
    console.log(`[orbit-heal] 轨道参数正常（检查 ${checked} 颗，无需修正）`);
  }
  return { checked, fixed, skipped };
}
