// WebFetch 抓取的中国遥感卫星 GP 数据入库（去重 + 分类 + upsert）
import { upsertSatellite, getCategories, db } from "../server/db.mjs";
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = join(__dirname, "..", "data", "webfetch_raw");

function classify(name) {
  const N = name.toUpperCase();
  if (N.includes('GAOFEN')) {
    let sub = "optical";
    if (/GAOFEN[- ]?(3|10|12)/.test(N)) sub = "sar";
    if (/GAOFEN[- ]?4/.test(N)) sub = "staring";
    if (/GAOFEN[- ]?5/.test(N)) sub = "hyperspectral";
    return { category: "imaging", subCategory: sub, payloadType: sub === "sar" ? "SAR雷达成像" : "光学成像", desc: "高分系列对地观测卫星，中国高分辨率对地观测系统重大专项。" };
  }
  if (N.includes('YAOGAN')) return { category: "recon", subCategory: "recon_imaging", payloadType: "成像侦察", desc: "遥感系列卫星（公开资料称用于科学试验、国土普查、农作物估产、防灾减灾等领域）。" };
  if (N.includes('JILIN')) return { category: "imaging", subCategory: "optical", payloadType: "光学成像（商业遥感）", desc: "吉林一号商业遥感卫星星座，长光卫星技术有限公司运营。" };
  if (N.includes('SUPERVIEW')) return { category: "imaging", subCategory: "optical", payloadType: "光学成像（高分辨率商业）", desc: "高景一号商业高分辨率遥感卫星星座。" };
  if (N.includes('ZIYUAN')) return { category: "imaging", subCategory: "optical", payloadType: "光学成像（资源调查）", desc: "资源系列陆地资源调查卫星。" };
  if (N.includes('TIANHUI')) return { category: "imaging", subCategory: "optical", payloadType: "光学成像（测绘）", desc: "天绘系列测绘卫星。" };
  if (N.includes('HAIYANG')) return { category: "science", subCategory: "oceanography", payloadType: "海洋遥感", desc: "海洋系列海洋水色/动力环境监测卫星。" };
  if (N.includes('SDGSAT')) return { category: "science", subCategory: "remote_sensing", payloadType: "可持续发展科学遥感", desc: "可持续发展科学卫星1号。" };
  if (/LANDSAT|TERRA|AQUA|AURA|ICESAT|SMAP|GRACE|SWARM|CRYOSAT|GCOM|OCO|SENTINEL-5|CASSIOPE|SHIJIAN|CYGFM/.test(N)) {
    return { category: "science", subCategory: "earth_observation", payloadType: "对地观测科学载荷", desc: "对地观测科学卫星。" };
  }
  if (/SENTINEL|ALOS|ICEYE|GEOEYE|KOMPSAT|CARTOSAT|RESURS|OKEAN|WORLDVIEW|PLEIADES|TERRASAR|SPOT |RESURS/.test(N)) {
    const sub = /SENTINEL-1|ALOS-2|ALOS-4|ICEYE|ROSESAT/.test(N) ? "sar" : "optical";
    return { category: "imaging", subCategory: sub, payloadType: sub === "sar" ? "SAR雷达成像" : "光学成像", desc: "国际对地观测卫星。" };
  }
  if (/NOAA|METOP|GOES|METEOSAT|HIMAWARI|DMSP|JPSS|SUOMI|METEOR|ELEKTRO|INSAT|GPM|EWS-G|FENGYUN/.test(N)) {
    return { category: "weather", subCategory: "meteorological", payloadType: "气象遥感", desc: "气象对地观测卫星。" };
  }
  if (/COSMOS 2535|COSMOS.*RECON/.test(N)) {
    return { category: "recon", subCategory: "recon_imaging", payloadType: "成像侦察", desc: "俄罗斯 Cosmos 系列成像侦察卫星。" };
  }
  if (/COMS/.test(N)) {
    return { category: "weather", subCategory: "meteorological", payloadType: "气象遥感", desc: "韩国通信海洋气象卫星。" };
  }
  if (/ARKTIKA/.test(N)) {
    return { category: "weather", subCategory: "meteorological", payloadType: "气象遥感（北极监测）", desc: "俄罗斯北极气象监测卫星。" };
  }
  if (/KH-11|NROL|USA-224|USA-245|USA-290|RECON/.test(N)) {
    return { category: "recon", subCategory: "recon_imaging", payloadType: "成像侦察", desc: "成像侦察卫星。" };
  }
  return null;
}

let imported = 0, updated = 0, skippedDeb = 0;
const files = readdirSync(RAW).filter(f => f.endsWith(".json"));

for (const f of files) {
  const records = JSON.parse(readFileSync(join(RAW, f), "utf-8"));
  for (const gp of records) {
    const name = gp.OBJECT_NAME;
    // 过滤碎片
    if (name.includes('DEB') || name.includes('R/B') || name.includes('AKM')) { skippedDeb++; continue; }
    const cls = classify(name);
    if (!cls) continue;

    const period = 1440 / (gp.MEAN_MOTION ?? 14);
    const a = 8978.14 / Math.pow(gp.MEAN_MOTION / 227.9, 2 / 3);
    const altitude = a - 6371;
    const launchDate = gp.OBJECT_ID ? `${gp.OBJECT_ID.slice(0, 4)}-${gp.OBJECT_ID.slice(5, 7)}` : null;

    // 已有记录（legacy）保留描述与运营方，仅更新轨道数据
    const existing = db.prepare("SELECT * FROM satellites WHERE noradId = ?").get(gp.NORAD_CAT_ID);

    upsertSatellite({
      noradId: gp.NORAD_CAT_ID,
      name,
      intlDesignator: gp.OBJECT_ID ?? null,
      tle1: existing?.tle1 ?? `1 ${String(gp.NORAD_CAT_ID).padStart(5, "0")}U`,
      tle2: existing?.tle2 ?? `2 ${String(gp.NORAD_CAT_ID).padStart(5, "0")} `,
      gpJson: JSON.stringify(gp),
      epoch: gp.EPOCH ?? null,
      objectType: "PAYLOAD",
      category: cls.category,
      subCategory: cls.subCategory,
      country: "中国",
      launchDate: existing?.launchDate ?? launchDate,
      launchSite: existing?.launchSite ?? null,
      missionDescription: existing?.missionDescription ?? cls.desc,
      operator: existing?.operator ?? null,
      payloadType: cls.payloadType,
      altitude: Math.round(altitude * 10) / 10,
      inclination: gp.INCLINATION ?? null,
      period: Math.round(period * 2) / 10,
      apogee: null, perigee: null,
      eccentricity: gp.ECCENTRICITY ?? null,
      resolution: null,
      source: "celestrak",
      lastUpdated: new Date().toISOString(),
    });
    if (existing) updated++; else imported++;
  }
}

console.log(`WebFetch 数据入库: 新增 ${imported}, 更新(覆盖历元) ${updated}, 跳过碎片 ${skippedDeb}`);
console.log("库中分类计数:", getCategories());
console.log("总卫星数:", db.prepare("SELECT count(*) c FROM satellites WHERE decayed=0").get().c);
