// 原库 legacy TLE 导入（保底数据）：从原工作台 dump 提取 94 颗遥感卫星 TLE 直接入库
// 后续 CelesTrak 抓取成功后由 seed.mjs upsert 覆盖为最新历元
import { upsertSatellite, getCategories } from "../server/db.mjs";
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");

const legacyMap = JSON.parse(readFileSync(join(DATA, "legacy_remote_sensing.json"), "utf-8"));

// 从原库 dump 提取卫星记录
const dump = execSync("zcat /root/项目/全球开源情报工作台/redroom-osint-workbench/data/redroom-dump-clean.sql.gz", { maxBuffer: 200 * 1024 * 1024 }).toString();
const m = dump.match(/INSERT INTO `satellites` VALUES(.*?);/s);
const rows = m[1];

// 解析每条记录的字段（严格按 dump 结构: id,norad,name,intl,tle1,tle2,epoch,otype,category,...）
const ASTRO = ['HUBBLE','HST','XMM','CXO','SDO','SWIFT','NUSTAR','ASTROSAT','HINODE','IRIS','HISAKI','GLAST','FGRST','MMS','POLAR','CLUSTER','MOST','BRITE','SWAS','TIMED','SORCE','SCISAT','STSAT','X-SAT','NEOSSAT','CORIOLIS'];

function parseRows(raw) {
  const out = [];
  let depth = 0, cur = "", inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { cur += ch; esc = true; continue; }
    if (ch === "'" && !esc) { inStr = !inStr; cur += ch; continue; }
    if (!inStr && ch === "(") { if (depth === 0) cur = ""; depth++; continue; }
    if (!inStr && ch === ")") { depth--; if (depth === 0) { out.push(cur); } continue; }
    cur += ch;
  }
  return out;
}

// 简单 CSV 式切分（引号内逗号不切）
function splitFields(line) {
  const fields = [];
  let cur = "", inStr = false, esc = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { cur += ch; esc = true; continue; }
    if (ch === "'") { inStr = !inStr; cur += ch; continue; }
    if (!inStr && ch === ",") { fields.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  fields.push(cur.trim());
  return fields;
}

function unquote(s) {
  if (s === "NULL") return null;
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\").replace(/\\n/g, "\n");
  }
  return s;
}

const records = parseRows(rows);
console.log("dump 卫星记录:", records.length);

let imported = 0, skippedAstro = 0, skippedComm = 0, notInList = 0, dupNorad = {};
for (const rec of records) {
  const f = splitFields(rec);
  // id,noradId,name,intl,tle1,tle2,epoch,objectType,category,country,launchDate,launchSite,desc,operator,altitude,inclination,period,apogee,perigee,ecc,rcs,decayed,...
  const norad = parseInt(f[1]);
  const name = unquote(f[2]);
  const tle1 = unquote(f[4]);
  const tle2 = unquote(f[5]);
  const epoch = unquote(f[6]);
  const category = unquote(f[8]);
  const country = unquote(f[9]);
  const launchDate = unquote(f[10]);
  const launchSite = unquote(f[11]);
  const desc = unquote(f[12]);
  const operator = unquote(f[13]);
  const altitude = parseFloat(f[14]) || null;
  const inclination = parseFloat(f[15]) || null;
  const period = parseFloat(f[16]) || null;
  const eccentricity = parseFloat(f[19]) || null;
  const decayed = f[21] === "1" || /'/ .test(f[21]);

  // 只导入候选清单里的
  const legacy = legacyMap[String(norad)];
  if (!legacy) { notInList++; continue; }
  if (legacy.type === "science" && ASTRO.some(k => name.toUpperCase().includes(k))) { skippedAstro++; continue; }

  // 分类映射
  const catMap = { imaging: "imaging", recon: "recon", weather: "weather", science: "science" };
  const cat = catMap[legacy.type] ?? "imaging";
  const payloadMap = {
    imaging: "光学/雷达成像",
    recon: "成像侦察",
    weather: "气象遥感",
    science: "对地观测科学载荷",
  };

  dupNorad[norad] = (dupNorad[norad] ?? 0) + 1;

  upsertSatellite({
    noradId: norad,
    name,
    intlDesignator: null,
    tle1, tle2,
    gpJson: null,
    epoch: epoch ? new Date(epoch).toISOString() : null,
    objectType: "PAYLOAD",
    category: cat,
    subCategory: null,
    country,
    launchDate,
    launchSite,
    missionDescription: desc,
    operator,
    payloadType: payloadMap[cat],
    altitude, inclination, period, apogee: null, perigee: null, eccentricity,
    resolution: null,
    source: "legacy",
    lastUpdated: new Date().toISOString(),
  });
  imported++;
}

console.log(`legacy 导入完成: ${imported}, 跳过天文 ${skippedAstro}, 不在清单 ${notInList}`);
console.log("分类计数:", getCategories());
