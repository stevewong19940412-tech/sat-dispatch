// ─── 轨道参数自愈（纯 PocketBase 版，容器内运行）───────────────────────────
// 背景：satellites 表的 altitude/period 曾全库错误（高度放大 ~78.8 倍、周期 0.2 倍、
// apogee/perigee 为空），而线上库在持久卷里，部署新代码不会覆盖数据。
// 本模块在服务启动时检查：若发现 alt/真实值 偏离超过阈值（说明仍是坏数据），
// 就用每颗星自己的 gpJson（SGP4）重算并回写，修完打印一行日志。
//
// 幂等：数据正常时不做任何写入。

import * as satellite from "satellite.js";
import { pbAll, pbUpdate, pbAuth } from "./pb_repo.mjs";

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8091";
let _token = null;
async function api(path, method = "GET", body = null) {
  if (!_token) _token = await pbAuth();
  const r = await fetch(PB_URL + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: _token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    _token = null;
    throw new Error(`${method} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  return r.json();
}

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

// ─── 卫星元数据自愈（国家 / 类别）────────────────────────────────────────────
// 背景：库中存在两类错误标注，会让候选清单混入不该出现的星：
//   ① 外国卫星被标成"中国"（SENTINEL-3C、LANDSAT 1/2、NOAA 2 等），
//      一旦收紧"只候中国星"就会漏掉真正的中国星、或错误保留外国星；
//   ② 遥感（YAOGAN）系列的 subCategory 全挂在 recon_imaging（侦察），
//      导致遥-30 这类光学星座从未进入光学候选（中国星数量被人为压到 105）。
// 本函数按系列规则校正，幂等：已是正确值时不写入。
const COUNTRY_RULES = [
  [/^LANDSAT|^NOAA|^GOES|^EWS-G|^DMSP|^WORLDVIEW|^GEOEYE|^TERRA$|^AQUA$|^AURA$|^OCO|^SUOMI/, '美国'],
  [/^SENTINEL/, '欧洲航天局'],
  [/^METEOSAT|^METOP/, '欧洲气象卫星应用组织'],
  [/^SWARM|^CRYOSAT|^GOCE/, '欧洲航天局'],
  [/^PLEIADES|^SPOT/, '法国'],
  [/^ALOS|^HIMAWARI|^GCOM/, '日本'],
  [/^GEO-KOMPSAT|^KOMPSAT/, '韩国'],
  [/^INSAT|^CARTOSAT|^RESOURCESAT/, '印度'],
  [/^ICEYE/, '芬兰'],
  [/^ELEKTRO|^METEOR|^ARKTIKA|^COSMOS|^RESURS/, '俄罗斯'],
  [/^CASSIOPE/, '加拿大'],
  [/^CYGFM/, '中国'], // 天仪研究院（中国商业 SAR 星座）
];

// 遥感子系列类型（依公开资料）：光学 / SAR
const YAOGAN_KIND = [
  [/^YAOGAN[-\s]?3(?![0-9])/i, 'optical'],
  [/^YAOGAN[-\s]?30/i, 'optical'],
  [/^YAOGAN[-\s]?33/i, 'optical'],
  [/^YAOGAN[-\s]?(32|42|12|47)(?![0-9])/i, 'optical'],
  [/^YAOGAN[-\s]?4(?![0-9])/i, 'optical'],
  [/^YAOGAN[-\s]?(31|40|43)(?![0-9])/i, 'sar'],
];

export async function healSatelliteMeta() {
  const sats = await pbAll('satellites', { fields: 'id,noradId,name,country,subCategory,category' });
  const ops = [];
  for (const s of sats) {
    const name = String(s.name || '');
    let country = s.country;
    for (const [re, co] of COUNTRY_RULES) { if (re.test(name)) { country = co; break; } }

    let sub = s.subCategory, cat = s.category;
    if (/^YAOGAN/i.test(name)) {
      for (const [re, kind] of YAOGAN_KIND) {
        if (re.test(name)) { sub = kind; cat = 'imaging'; break; }
      }
    }

    if (country !== s.country || sub !== s.subCategory || cat !== s.category) {
      ops.push({ id: s.id, data: { country, subCategory: sub, category: cat } });
    }
  }
  for (let i = 0; i < ops.length; i += 20) {
    await Promise.all(ops.slice(i, i + 20).map((o) => pbUpdate('satellites', o.id, o.data).catch(() => {})));
  }
  if (ops.length) console.log(`[meta-heal] 卫星国家/类别已校正 ${ops.length} 颗`);
  else console.log('[meta-heal] 卫星国家/类别正常，无需修正');
  return { fixed: ops.length, checked: sats.length };
}

// ─── PB 集合字段补齐（2026-11-16）───────────────────────────────────────────
// 背景：新增业务字段（如 candidates.stripCoverage）时，PB collection 不会自动加，
//   写入会被静默丢弃，表现为"代码改了但字段一直是 null"。
// 这里在启动时检查并补齐必需字段（幂等，已存在则跳过）。
const REQUIRED_FIELDS = {
  candidates: [
    { name: 'stripCoverage', type: 'number' },
  ],
  tasks: [
    { name: 'multiPlan', type: 'text' },   // 分派方案 JSON，派单直接复用（避免重算分叉）
    // 区域拆单：记录所属父区域与条带序号，便于按区域汇总与前端分组展示
    { name: 'parentArea', type: 'text' },
    { name: 'stripIdx', type: 'number' },
    { name: 'stripCount', type: 'number' },
  ],
};

export async function healCollectionFields() {
  let added = 0;
  for (const [table, fields] of Object.entries(REQUIRED_FIELDS)) {
    try {
      const col = await api(`/api/collections/${table}`);
      if (!col?.fields) continue;
      const have = new Set(col.fields.map(f => f.name));
      const missing = fields.filter(f => !have.has(f.name));
      if (!missing.length) continue;
      const newFields = [...col.fields, ...missing.map(f => ({ name: f.name, type: f.type, required: false }))];
      await api(`/api/collections/${col.id}`, 'PATCH', { fields: newFields });
      added += missing.length;
      console.log(`[field-heal] ${table} 补齐字段: ${missing.map(f => f.name).join(', ')}`);
    } catch (e) {
      console.error(`[field-heal] ${table} 失败:`, e.message);
    }
  }
  if (!added) console.log('[field-heal] 集合字段完整，无需补齐');
  return { added };
}
