// ─── 轨道参数修复脚本（2026-11-15）──────────────────────────────────────────
// 问题：satellites 表的 altitude / period 两列全库 310 颗全部错误
//   altitude：约为真实值的 78.8 倍（GAOFEN-1 存 49285.8，实际 644km）
//   period  ：约为真实值的 0.2 倍（存 19.5，实际 97.5 分钟）
//   inclination：正确，不动
// 后果：dispatch.mjs 用 `sat.altitude < 20000` 判定近地轨道，全部落空 →
//       直控驳回诊断里的「必需轨道高度」永远为 null。
//
// 修法：不靠倍率反推（倍率并非常数，影响各不相同），
//      直接从每颗星自己的 TLE/gpJson 用 SGP4 解析出半长轴与周期，这是唯一权威来源。
//      同时补上 apogee / perigee（原库全为空）。
//
// 用法：node scripts/fix_orbit_params.mjs [--dry-run]
//   默认只改 SQLite（种子库）；加 --pb 同步写 PocketBase。

import Database from "better-sqlite3";
import * as satellite from "satellite.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const EARTH_R_KM = 6371;

const DRY = process.argv.includes("--dry-run");
const SYNC_PB = process.argv.includes("--pb");

function satrecOf(sat) {
  if (sat.gpJson) {
    try {
      const gp = typeof sat.gpJson === "string" ? JSON.parse(sat.gpJson) : sat.gpJson;
      const r = satellite.json2satrec(gp);
      if (r && !r.error) return r;
    } catch {}
  }
  try {
    const r = satellite.twoline2satrec(sat.tle1.trim(), sat.tle2.trim());
    if (r && !r.error) return r;
  } catch {}
  return null;
}

/** 由 satrec 解析真实轨道参数（km / 分钟 / 度） */
export function orbitFromSatrec(rec) {
  if (!rec) return null;
  // satrec.a 单位为地球半径（WGS-72 = 6378.137 km）
  const aKm = rec.a * 6378.137;
  const e = rec.ecco ?? 0;
  const altitude = aKm - EARTH_R_KM;
  const apogee = aKm * (1 + e) - EARTH_R_KM;
  const perigee = aKm * (1 - e) - EARTH_R_KM;
  // rec.no 为 rad/min，周期 T = 2π / no
  const periodMin = rec.no > 0 ? (2 * Math.PI) / rec.no : NaN;
  const inclination = (rec.inclo * 180) / Math.PI;
  return {
    altitude: round1(altitude),
    apogee: round1(apogee),
    perigee: round1(perigee),
    period: Math.round(periodMin * 100) / 100,
    inclination: Math.round(inclination * 10000) / 10000,
    eccentricity: e,
  };
}

const round1 = (x) => Math.round(x * 10) / 10;

async function main() {
  const dbPath = process.env.SQLITE_PATH || join(ROOT, "data", "satplanning.db");
  const db = new Database(dbPath);
  const sats = db.prepare("SELECT id, noradId, name, altitude, period, apogee, perigee, inclination, tle1, tle2, gpJson FROM satellites").all();

  console.log(`库：${dbPath}`);
  console.log(`卫星数：${sats.length}${DRY ? "（试运行，不写库）" : ""}\n`);

  const upd = db.prepare(
    "UPDATE satellites SET altitude=?, apogee=?, perigee=?, period=?, inclination=?, eccentricity=? WHERE id=?"
  );

  let fixed = 0, skipped = 0, bigJump = [];
  const changes = [];

  for (const s of sats) {
    const o = orbitFromSatrec(satrecOf(s));
    if (!o) { skipped++; console.warn(`  ⚠ 无法解析 TLE，跳过：${s.name} (${s.noradId})`); continue; }
    const dAlt = Math.abs((s.altitude ?? 0) - o.altitude);
    if (dAlt > 50) bigJump.push({ name: s.name, from: s.altitude, to: o.altitude, dPer: [s.period, o.period] });
    changes.push({ noradId: s.noradId, name: s.name, ...o });
    if (!DRY) upd.run(o.altitude, o.apogee, o.perigee, o.period, o.inclination, o.eccentricity, s.id);
    fixed++;
  }

  console.log(`已修正：${fixed}  跳过：${skipped}  其中高度变化>50km：${bigJump.length}`);
  console.log("\n抽样（前 8 条变化最大的）：");
  for (const b of bigJump.slice(0, 8)) {
    console.log(`  ${b.name.padEnd(26)} 高度 ${b.from} → ${b.to} km   周期 ${b.dPer[0]} → ${b.dPer[1]} min`);
  }

  if (SYNC_PB && !DRY) {
    console.log("\n同步到 PocketBase ...");
    const { pbAll, pbUpdate } = await import("../server/pb_repo.mjs");
    const pbRows = await pbAll("satellites", { fields: "id,noradId" });
    const idMap = new Map(pbRows.map((r) => [r.noradId, r.id]));
    let ok = 0, fail = 0;
    for (const c of changes) {
      const rid = idMap.get(c.noradId);
      if (!rid) { fail++; continue; }
      try {
        await pbUpdate("satellites", rid, {
          altitude: c.altitude, apogee: c.apogee, perigee: c.perigee,
          period: c.period, inclination: c.inclination, eccentricity: c.eccentricity,
        });
        ok++;
      } catch (e) { fail++; if (fail < 4) console.error("  PB 更新失败:", c.name, e.message); }
    }
    console.log(`PB 同步：成功 ${ok}，失败 ${fail}`);
  } else if (SYNC_PB && DRY) {
    console.log("\n（试运行：跳过 PB 同步）");
  }

  db.close();
}

if (process.argv[1] && process.argv[1].endsWith("fix_orbit_params.mjs")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
