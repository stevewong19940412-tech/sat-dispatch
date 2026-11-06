// 卫星数据导入脚本：从 gp_raw.json（CelesTrak 实抓 OMM JSON）+ 原库 legacy TLE 导入
// 分类逻辑：
//  - all_candidates.json 里标记 legacy 来源 → 按 legacy_remote_sensing.json 的 type 分类
//  - 中国卫星按系列名分类（GAOFEN/YAOGAN/JILIN/SUPERVIEW → imaging/recon，FENGYUN → weather）
//  - 国际卫星按名称关键词分类
import { upsertSatellite, getCategories, db } from "../server/db.mjs";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");

// ─── 分类函数 ─────────────────────────────────────────────────────────────
const ASTRO_KEYS = ['HUBBLE','HST','XMM','CXO','SDO','SWIFT','NUSTAR','ASTROSAT','HINODE','IRIS','HISAKI','GLAST','FGRST','MMS ','POLAR','CLUSTER','MOST','BRITE','SWAS','TIMED','SORCE','SCISAT','STSAT','X-SAT','NEOSSAT','CORIOLIS','SPHEREX'];
const NAV_KEYS = ['GPS','NAVSTAR','GLONASS','BEIDOU','GIOVE','GALILEO','COSMOS ']; // COSMOS 默认非遥感
const COMM_KEYS = ['WGS','AEHF','MUOS','SBIRS','TDRS','INTELSAT','SES ','EUTELSAT','GSAT','SKYNET','COMS'];

function classify(name, country, intlId) {
  const N = name.toUpperCase();
  // 明确非遥感 → 跳过
  if (NAV_KEYS.some(k => N.startsWith(k) || N.includes(` ${k} `)) && !N.includes('BEIDOU')) {
    if (N.includes('NAVSTAR') || N.includes('GLONASS') || N.includes('GPS') || N.includes('GIOVE')) return null;
  }
  if (COMM_KEYS.some(k => N.includes(k))) return null;
  if (ASTRO_KEYS.some(k => N.includes(k))) return null;

  const cn = country === "中国" || country === "China";

  // ── 中国系列 ──
  if (N.includes('GAOFEN') || N.includes('高分')) {
    // 高分1/2/6/9/WV 为光学；3/10/12 为SAR；4 为凝视
    let sub = "optical";
    if (/GAOFEN[- ]?(3|10|12)/.test(N)) sub = "sar";
    if (/GAOFEN[- ]?4/.test(N)) sub = "staring";
    if (/GAOFEN[- ]?5/.test(N)) sub = "hyperspectral";
    return { category: "imaging", subCategory: sub, payloadType: sub === "sar" ? "SAR雷达成像" : "光学成像" };
  }
  if (N.includes('YAOGAN') || N.includes('遥感')) {
    // YAOGAN 系列多为成像侦察或SAR
    return { category: "recon", subCategory: "recon_imaging", payloadType: "成像侦察" };
  }
  if (N.includes('JILIN') || N.includes('吉林')) {
    return { category: "imaging", subCategory: "optical", payloadType: "光学成像（商业遥感）" };
  }
  if (N.includes('SUPERVIEW') || N.includes('高景') || N.includes('GAOJING')) {
    return { category: "imaging", subCategory: "optical", payloadType: "光学成像（高分辨率商业）" };
  }
  if (N.includes('ZIYUAN') || N.includes('资源')) {
    return { category: "imaging", subCategory: "optical", payloadType: "光学成像（资源调查）" };
  }
  if (N.includes('TIANHUI') || N.includes('天绘')) {
    return { category: "imaging", subCategory: "optical", payloadType: "光学成像（测绘）" };
  }
  if (N.includes('FENGYUN') || N.includes('风云')) {
    return { category: "weather", subCategory: "meteorological", payloadType: "气象遥感" };
  }
  if (N.includes('HAIYANG') || N.includes('海洋')) {
    return { category: "science", subCategory: "oceanography", payloadType: "海洋遥感" };
  }
  if (N.includes('HJ-') || N.includes('HUANJING') || N.includes('环境')) {
    return { category: "imaging", subCategory: "optical", payloadType: "环境遥感" };
  }
  if (N.includes('LUOJIA') || N.includes('珞珈')) return { category: "science", subCategory: "remote_sensing", payloadType: "遥感科学" };
  if (N.includes('SDGSAT')) return { category: "science", subCategory: "remote_sensing", payloadType: "可持续发展科学遥感" };
  if (N.includes('CBERS')) return { category: "imaging", subCategory: "optical", payloadType: "光学成像（中巴资源）" };
  if (N.includes('TIANMU')) return { category: "weather", subCategory: "meteorological", payloadType: "气象掩星探测" };

  // ── 国际 ──
  if (N.includes('WORLDVIEW') || N.includes('GEOEYE') || N.includes('PLEIADES') || N.includes('SPOT ')) {
    return { category: "imaging", subCategory: "optical", payloadType: "光学成像（高分辨率商业）" };
  }
  if (N.includes('TERRASAR') || N.includes('PAZ') || N.includes('RADARSAT') || N.includes('SAOCOM') || N.includes('NOVASAR') || N.includes('CAPELLA') || N.includes('NISAR') || N.includes('SIASGE')) {
    return { category: "imaging", subCategory: "sar", payloadType: "SAR雷达成像" };
  }
  if (N.includes('SENTINEL') || N.includes('ALOS')) {
    return { category: "imaging", subCategory: "optical", payloadType: "光学成像（对地观测计划）" };
  }
  if (N.includes('CARTOSAT') || N.includes('RESURS')) {
    return { category: "imaging", subCategory: "optical", payloadType: "光学成像" };
  }
  if (N.includes('FLOCK') || N.includes('DOVE') || N.includes('SKYSAT') || N.includes('PELICAN') || N.includes('SUPERDOVE')) {
    return { category: "imaging", subCategory: "optical", payloadType: "光学成像（Planet 星座）" };
  }
  if (N.includes('KOMPSAT')) return { category: "imaging", subCategory: "optical", payloadType: "光学成像" };
  if (/NOAA|METOP|GOES|METEOSAT|HIMAWARI|DMSP|JPSS|SUOMI|METEOR|ELEKTRO|INSAT|GPM|EWS-G/.test(N)) {
    return { category: "weather", subCategory: "meteorological", payloadType: "气象遥感" };
  }
  if (/LANDSAT|TERRA|AQUA|AURA|ICESAT|SMAP|GRACE|SWARM|CRYOSAT|BIOMASS|GCOM|OCO|SENTINEL-5|ENVISAT|ERS-/.test(N)) {
    return { category: "science", subCategory: "earth_observation", payloadType: "对地观测科学载荷" };
  }
  // KH-11 / NROL / USA 编号侦察星
  if (N.includes('KH-11') || N.includes('NROL') || (N.includes('USA') && country === "USA")) {
    return { category: "recon", subCategory: "recon_imaging", payloadType: "成像侦察" };
  }
  if (N.includes('COSMOS') && (N.includes('RECON') || intlId?.startsWith('201') === false)) {
    // COSMOS 2535(RECON) 保留
    if (N.includes('RECON')) return { category: "recon", subCategory: "recon_imaging", payloadType: "成像侦察" };
  }
  return null; // 无法判定 → 不导入
}

// ─── 主流程 ───────────────────────────────────────────────────────────────
function main() {
  if (!existsSync(join(DATA, "gp_raw.json"))) {
    console.error("gp_raw.json 不存在，请先运行 scripts/fetch_tle.py");
    process.exit(1);
  }
  const gpList = JSON.parse(readFileSync(join(DATA, "gp_raw.json"), "utf-8"));
  const legacyMap = existsSync(join(DATA, "legacy_remote_sensing.json"))
    ? JSON.parse(readFileSync(join(DATA, "legacy_remote_sensing.json"), "utf-8")) : {};

  // 国家映射（GP 无国家字段，用候选表推断）
  const chinaCandidates = existsSync(join(DATA, "china_candidates.json"))
    ? JSON.parse(readFileSync(join(DATA, "china_candidates.json"), "utf-8")) : {};

  let imported = 0, skipped = 0, legacyImported = 0;
  const detail = { imaging: 0, recon: 0, weather: 0, science: 0 };

  for (const gp of gpList) {
    const nid = gp.NORAD_CAT_ID;
    const name = gp.OBJECT_NAME;
    const isChina = !!chinaCandidates[String(nid)] || name.includes('GAOFEN') || name.includes('YAOGAN') ||
      name.includes('JILIN') || name.includes('FENGYUN') || name.includes('ZIYUAN') || name.includes('TIANHUI') ||
      name.includes('SUPERVIEW') || name.includes('HAIYANG') || name.includes('LUOJIA') || name.includes('SDGSAT');
    const country = isChina ? "中国" : "";

    const cls = classify(name, country, gp.OBJECT_ID);
    if (!cls) { skipped++; continue; }

    // 计算轨道参数
    const period = 1440 / (gp.MEAN_MOTION ?? 14);
    const a = Math.pow(398600.4418 / Math.pow(gp.MEAN_MOTION * 2 * Math.PI / 86400, 2), 1 / 3); // 半长轴 μ/n² 三次方根
    const altitude = a - 6371;

    upsertSatellite({
      noradId: nid,
      name,
      intlDesignator: gp.OBJECT_ID ?? null,
      tle1: `1 ${String(nid).padStart(5, "0")}U ${""}`,
      tle2: `2 ${String(nid).padStart(5, "0")} `,
      gpJson: JSON.stringify(gp),
      epoch: gp.EPOCH ?? null,
      objectType: "PAYLOAD",
      category: cls.category,
      subCategory: cls.subCategory,
      country: country || null,
      launchDate: gp.OBJECT_ID ? `${gp.OBJECT_ID.slice(0, 4)}-${gp.OBJECT_ID.slice(5, 7)}` : null,
      launchSite: null,
      missionDescription: null,
      operator: null,
      payloadType: cls.payloadType,
      altitude: Math.round(altitude * 10) / 10,
      inclination: gp.INCLINATION ?? null,
      period: Math.round(period * 2) / 10,
      apogee: null,
      perigee: null,
      eccentricity: gp.ECCENTRICITY ?? null,
      resolution: null,
      source: "celestrak",
      lastUpdated: new Date().toISOString(),
    });
    imported++;
    detail[cls.category] = (detail[cls.category] ?? 0) + 1;
  }

  console.log(`导入完成: 成功 ${imported}, 跳过(非遥感/无法判定) ${skipped}`);
  console.log("分类分布:", detail);
  console.log("库中类别计数:", getCategories());
}

main();
