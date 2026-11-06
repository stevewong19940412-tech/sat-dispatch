// 数据底座加固第一步：元数据补全 + legacy 卫星 gpJson 匹配 + 历元统一
// - 36 颗缺 country/inclination 的按名称规则补全（METEOSAT→欧洲、GOES→美国、SUOMI→美国等）
// - legacy 卫星若在 webfetch_raw 有同 NORAD 记录，补 gpJson 与新历元
// - 全部卫星补 subCategory（按名称/类别规则）
import { db, getCategories } from "../server/db.mjs";
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = join(__dirname, "..", "data", "webfetch_raw");

// ─── 1. 国家补全规则 ──────────────────────────────────────────────────────
const COUNTRY_RULES = [
  [/METEOSAT|MSG|METOP|EWS-G/, "欧洲气象卫星应用组织"],
  [/GOES|NOAA|DMSP|JPSS|SUOMI|LANDSAT|TERRA|AQUA|AURA|WORLDVIEW|GEOEYE|ICESAT|SMAP|GPM|GRACE|KH-11|NROL|USA /, "美国"],
  [/ELEKTRO|METEOR|ARKTIKA|RESURS|COSMOS/, "俄罗斯"],
  [/HIMAWARI|ALOS|GCOM|IGG/, "日本"],
  [/SENTINEL/, "欧洲航天局"],
  [/KOMPSAT|GEO-KOMPSAT|COMS/, "韩国"],
  [/INSAT/, "印度"],
  [/RADARSAT|SCISAT|NEOSSAT|MOST/, "加拿大"],
  [/CARTOSAT|OCEANSAT/, "印度"],
  [/SPOT|PLEIADES/, "法国"],
  [/TERRASAR|PAZ/, "德国"],
  [/SAOCOM/, "阿根廷"],
  [/CBERS/, "中国/巴西"],
  [/CAPELLA|ICEYE/, "美国/芬兰商业"],
];

function inferCountry(name) {
  const N = name.toUpperCase();
  for (const [re, country] of COUNTRY_RULES) {
    if (re.test(N)) return country;
  }
  return null;
}

// ─── 2. subCategory 补全规则（按 category + 名称）─────────────────────────
function inferSubCategory(sat) {
  const N = sat.name.toUpperCase();
  if (sat.category === "imaging") {
    if (/SAR|TERRASAR|PAZ|RADARSAT|SAOCOM|NOVASAR|CAPELLA|GAOFEN[- ]?(3|10|12)/.test(N)) return "sar";
    if (/GAOFEN[- ]?4/.test(N)) return "staring";
    if (/GAOFEN[- ]?5/.test(N)) return "hyperspectral";
    return "optical";
  }
  if (sat.category === "recon") return "recon_imaging";
  if (sat.category === "weather") return "meteorological";
  if (sat.category === "science") {
    if (/HAIYANG/.test(N)) return "oceanography";
    return "earth_observation";
  }
  return null;
}

// ─── 3. 载荷类型统一 ──────────────────────────────────────────────────────
const PAYLOAD_MAP = {
  sar: "SAR雷达成像",
  optical: "光学成像",
  staring: "光学凝视成像",
  hyperspectral: "高光谱成像",
  recon_imaging: "成像侦察",
  meteorological: "气象遥感",
  oceanography: "海洋遥感",
  earth_observation: "对地观测科学载荷",
};

function inferPayload(sat) {
  const sub = inferSubCategory(sat);
  return PAYLOAD_MAP[sub] ?? sat.payloadType;
}

// ─── 4. 执行补全 ──────────────────────────────────────────────────────────
// 收集 webfetch_raw 全部 GP 记录，按 NORAD 索引
const gpIndex = new Map();
for (const f of readdirSync(RAW).filter(f => f.endsWith(".json"))) {
  try {
    for (const rec of JSON.parse(readFileSync(join(RAW, f), "utf-8"))) {
      gpIndex.set(rec.NORAD_CAT_ID, rec);
    }
  } catch {}
}
console.log("webfetch_raw GP 索引:", gpIndex.size, "条");

const sats = db.prepare("SELECT * FROM satellites WHERE decayed=0").all();
let fixedCountry = 0, fixedGp = 0, fixedSub = 0, fixedEpoch = 0, fixedIncl = 0;

const updGp = db.prepare(`UPDATE satellites SET gpJson=?, epoch=?, altitude=?, inclination=?, period=?, country=COALESCE(?, country), intlDesignator=COALESCE(?, intlDesignator), source='celestrak' WHERE noradId=?`);
const updMeta = db.prepare(`UPDATE satellites SET country=COALESCE(?, country), subCategory=?, payloadType=?, inclination=COALESCE(?, inclination) WHERE noradId=?`);

for (const sat of sats) {
  const gp = gpIndex.get(sat.noradId);
  const mu = 398600.4418;

  // 有 GP 记录且当前无 gpJson 或历元更旧 → 用 GP 覆盖
  if (gp && (!sat.gpJson || sat.gpJson === '' || !sat.epoch || new Date(gp.EPOCH) > new Date(sat.epoch))) {
    const n = gp.MEAN_MOTION * 2 * Math.PI / 86400;
    const a = Math.pow(mu / (n * n), 1 / 3);
    updGp.run(
      JSON.stringify(gp), gp.EPOCH,
      Math.round((a - 6371) * 10) / 10,
      gp.INCLINATION ?? sat.inclination,
      Math.round(1440 / gp.MEAN_MOTION * 10) / 10,
      gp.OBJECT_NAME.includes('GAOFEN') || gp.OBJECT_NAME.includes('YAOGAN') || gp.OBJECT_NAME.includes('JILIN') ||
      gp.OBJECT_NAME.includes('FENGYUN') || gp.OBJECT_NAME.includes('ZIYUAN') || gp.OBJECT_NAME.includes('TIANHUI') ||
      gp.OBJECT_NAME.includes('SUPERVIEW') || gp.OBJECT_NAME.includes('HAIYANG') || gp.OBJECT_NAME.includes('LUOJIA') || gp.OBJECT_NAME.includes('SDGSAT')
        ? "中国" : null,
      gp.OBJECT_ID ?? null,
      sat.noradId
    );
    fixedGp++;
  }

  // 重读（可能刚更新过）
  const cur = db.prepare("SELECT * FROM satellites WHERE noradId=?").get(sat.noradId);

  // 国家补全
  let country = cur.country;
  if (!country) {
    const inferred = inferCountry(cur.name);
    if (inferred) { country = inferred; fixedCountry++; }
  }

  // subCategory / payloadType
  const sub = cur.subCategory ?? inferSubCategory(cur);
  const payload = inferPayload({...cur, subCategory: sub});
  if (!cur.subCategory) fixedSub++;

  // inclination 补全
  let incl = cur.inclination;
  if (incl == null) {
    try {
      const gpj = cur.gpJson ? JSON.parse(cur.gpJson) : null;
      if (gpj?.INCLINATION != null) { incl = gpj.INCLINATION; fixedIncl++; }
    } catch {}
  }

  updMeta.run(country, sub, payload, incl, sat.noradId);

  // 历元兜底：仍无 epoch 且有 gpJson 已在上面覆盖；仍无 epoch 且只有旧 TLE → 从 TLE 行解析
  if (!cur.epoch && !gp) {
    const m = cur.tle1?.match(/\.\s*(\d{2})(\d{3})\./);
    if (m) {
      const yy = parseInt(m[1]);
      const doy = parseInt(m[2]);
      const year = yy < 57 ? 2000 + yy : 1900 + yy;
      const epoch = new Date(Date.UTC(year, 0, 1) + (doy - 1) * 86400000).toISOString();
      db.prepare("UPDATE satellites SET epoch=? WHERE noradId=?").run(epoch, sat.noradId);
      fixedEpoch++;
    }
  }
}

console.log(`补全完成: gpJson+历元覆盖 ${fixedGp}, 国家 ${fixedCountry}, subCategory ${fixedSub}, 倾角 ${fixedIncl}, 历元(从TLE) ${fixedEpoch}`);
console.log("分类:", getCategories());
