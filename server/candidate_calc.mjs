// ─── 候选卫星计算模块（4.3）──────────────────────────────────────────────
// 流程：轨道预报 → 可见窗计算 → 约束筛选 → 云量解算 → 候选清单输出
// 确定性计算，全部可复算。轨道预报基于底座 SGP4。
import * as satellite from "satellite.js";
import { db } from "./db.mjs";

const EARTH_R = 6371;

// ─── 任务几何归一化 ──────────────────────────────────────────────────────
// 点目标单条带；面目标按幅宽沿垂直航向拆分（简化实现：以 AOI 外接圆估条带数）
export function normalizeTaskStrips(task, swathKm = 12) {
  const geom = JSON.parse(task.geom);
  // 目标三分类（成像任务规划标准口径）：点目标（单景覆盖）/ 线目标 / 面目标（需拆条带）
  // point = 点；area|polygon = 面；其它一律按面兜底（避免区域需求被静默降级成点）
  if (task.geomType === 'point') {
    return [{ idx: 1, count: 1, lat: geom.lat, lon: geom.lon, radiusKm: 1 }];
  }
  // 面目标（area/polygon）：质心 + 半径（用于可见窗判定的等效圆，条带数按直径/幅宽）
  const coords = geom.coords;
  let latSum = 0, lonSum = 0;
  for (const [la, lo] of coords) { latSum += la; lonSum += lo; }
  const cLat = latSum / coords.length, cLon = lonSum / coords.length;
  let maxD = 0;
  for (const [la, lo] of coords) {
    const d = haversineKm(cLat, cLon, la, lo);
    if (d > maxD) maxD = d;
  }
  const stripCount = Math.max(1, Math.ceil((maxD * 2) / swathKm));
  // 条带沿经度方向排布（简化）
  const strips = [];
  for (let i = 0; i < stripCount; i++) {
    const offLon = (i - (stripCount - 1) / 2) * (swathKm / (111 * Math.cos(cLat * Math.PI / 180)));
    strips.push({ idx: i + 1, count: stripCount, lat: cLat, lon: cLon + offLon, radiusKm: swathKm / 2 });
  }
  return strips;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ─── 轨道预报（SGP4，gpJson 优先）────────────────────────────────────────
const _satrecCache = new Map();
function makeSatrec(sat) {
  const hit = _satrecCache.get(sat.noradId);
  if (hit !== undefined) return hit;
  let rec = null;
  if (sat.gpJson) {
    try {
      const gp = typeof sat.gpJson === 'string' ? JSON.parse(sat.gpJson) : sat.gpJson;
      rec = satellite.json2satrec(gp);
      if (rec && rec.error === 0) rec = rec; else rec = null;
    } catch {}
  }
  if (!rec) { try { rec = satellite.twoline2satrec(sat.tle1.trim(), sat.tle2.trim()); } catch { rec = null; } }
  if (_satrecCache.size > 512) _satrecCache.clear();
  _satrecCache.set(sat.noradId, rec);
  return rec;
}

// 卫星星下点轨迹采样：t0 起 minutesAhead 分钟内 stepSec 步长
// SGP4 是纯函数，track 只依赖 (sat, t0, aheadMin, step)，与条带无关——模块级缓存消除
// 长窗分段/多条带场景下同一星的重复 SGP4 计算
const _trackCache = new Map();
const _TRACK_CACHE_MAX = 64;
export function sampleTrack(sat, t0, minutesAhead, stepSec = 30) {
  const satrec = makeSatrec(sat);
  if (!satrec) return [];
  const key = `${sat.noradId}|${Math.floor(t0.getTime() / 60000)}|${minutesAhead}|${stepSec}`;
  const hit = _trackCache.get(key);
  if (hit) return hit;
  const pts = [];
  for (let t = 0; t <= minutesAhead * 60; t += stepSec) {
    const date = new Date(t0.getTime() + t * 1000);
    try {
      const pv = satellite.propagate(satrec, date);
      if (!pv?.position || typeof pv.position === 'boolean') continue;
      const gmst = satellite.gstime(date);
      const geo = satellite.eciToGeodetic(pv.position, gmst);
      const lat = satellite.degreesLat(geo.latitude);
      const lon = satellite.degreesLong(geo.longitude);
      if (!isNaN(lat) && !isNaN(lon)) pts.push({ t: date.getTime(), lat, lon, altKm: geo.height });
    } catch {}
  }
  if (_trackCache.size >= _TRACK_CACHE_MAX) {
    _trackCache.delete(_trackCache.keys().next().value); // FIFO 淘汰
  }
  _trackCache.set(key, pts);
  return pts;
}

// ─── 可见窗计算 ──────────────────────────────────────────────────────────
// 可见条件：星下点距目标 ≤ 侧摆对应地面半径 且 太阳高度角 ≥ 门限（光学）
function solarElevationDeg(lat, lon, date) {
  // 简化太阳高度角计算（亚点精度足够用于光照门限判定）
  const rad = Math.PI / 180;
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000; // 自J2000天数
  const L = (280.460 + 0.9856474 * d) % 360;          // 平黄经
  const g = ((357.528 + 0.9856003 * d) % 360) * rad;  // 平近点角
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad; // 黄经
  const decl = Math.asin(Math.sin(lambda) * Math.sin(23.439 * rad));        // 太阳赤纬
  // 太阳时角
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const ha = (utcH * 15 - 180 + lon) * rad; // 近似
  const latR = lat * rad;
  const sinElev = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, sinElev))) / rad;
}

export function computeVisibleWindows(sat, strip, opts) {
  const { windowStart, windowEnd, minElevSunDeg = 10, maxSlewDeg = 45 } = opts;
  const t0 = new Date(windowStart);
  const tEnd = new Date(windowEnd).getTime();
  // 长窗分段：原实现 aheadMin 封顶 3 天——时间窗拉长后只采样前 3 天，后面的解全部漏掉
  // （大区域任务“拉长时间窗也没有解”的根因）。改为：≤3天窗一次采样（原逻辑）；
  // >3天窗切成多段（每段≤3天），每段独立跑同一套粗扫+精化，合并去重。
  const spanMs = tEnd - t0.getTime();
  const SEG_MS = 3 * 86400000;
  // GEO 凝视星判定：24h 星下点经度漂移 <2°（悬停）。GEO 对固定点每天同一时刻同一几何，
  // 分段采样毫无意义且慢（实测 GAOFEN-4 15天窗 11 条带 34s）——整窗一段，粗扫截断
  const probe = sampleTrack(sat, t0, 1440, 300);
  const isGeoSat = probe.length > 2 && Math.abs(probe[probe.length-1].lon - probe[0].lon) < 0.035; // 弧度≈2°
  if (spanMs > SEG_MS && !isGeoSat) {
    const merged = [];
    let segStart = t0.getTime();
    while (segStart < tEnd) {
      const segEnd = Math.min(segStart + SEG_MS, tEnd);
      for (const w of computeVisibleWindows(sat, strip, { ...opts, windowStart: new Date(segStart).toISOString(), windowEnd: new Date(segEnd).toISOString() })) {
        merged.push(w);
      }
      segStart = segEnd;
    }
    // 按过顶时刻排序去重（段边界可能重复同一过顶），每星上限 12 窗
    merged.sort((a, b) => a.overpass - b.overpass);
    const dedup = [];
    for (const w of merged) {
      if (dedup.length && w.overpass - dedup[dedup.length - 1].overpass < 120000) continue; // 2分钟内视为同窗
      dedup.push(w);
    }
    return dedup.slice(0, 12);
  }
  const aheadMin = Math.ceil(spanMs / 60000) + 60; // 单段最多 3 天+1h缓冲
  const track = sampleTrack(sat, t0, aheadMin, 20);
  if (track.length === 0) return [];

  // 地面覆盖半径（km）：侧摆上限对应
  const altKm = track[0].altKm || 500;
  const maxOffKm = altKm * Math.tan(Math.min(maxSlewDeg, 60) * Math.PI / 180) * 0.9; // 简化几何

  const windows = [];
  let inWin = false, winStart = null, best = null;
  for (const p of track) {
    if (p.t > tEnd) break;
    const dKm = haversineKm(p.lat, p.lon, strip.lat, strip.lon);
    const sunEl = solarElevationDeg(strip.lat, strip.lon, new Date(p.t));
    const visible = dKm <= maxOffKm && (sat.category === 'weather' || sunEl >= minElevSunDeg || sat.subCategory === 'sar');
    if (visible && !inWin) {
      inWin = true; winStart = p.t;
      best = { t: p.t, dKm, slewDeg: Math.atan(dKm / altKm) * 180 / Math.PI };
    } else if (visible && inWin) {
      if (dKm < best.dKm) best = { t: p.t, dKm, slewDeg: Math.atan(dKm / altKm) * 180 / Math.PI };
    } else if (!visible && inWin) {
      inWin = false;
      if (best && (best.t - winStart) >= 0) {
        windows.push({ start: winStart, end: p.t, overpass: best.t, minDistKm: best.dKm, slewDeg: best.slewDeg });
      }
      best = null;
    }
  }
  if (inWin && best) {
    windows.push({ start: winStart, end: Math.min(track[track.length-1].t, tEnd), overpass: best.t, minDistKm: best.dKm, slewDeg: best.slewDeg });
  }
  // 只保留与任务窗有交且过顶在任务窗内的；GEO 凝视星（悬停型）对固定点只有"持续可见区"
  // ，粗扫会切出大量碎窗——每段只留前 2 个，避免精化爆炸（实测 GAOFEN-4 单星 34s）
  const isGeo = Math.abs(track[0].period ? track[0].period - 1440 : 0) < 60 || sat.category === 'staring' || sat.subCategory === 'staring';
  const coarse = windows.filter(w => w.overpass >= t0.getTime() && w.overpass <= tEnd).slice(0, isGeo ? 2 : 8);

  // ─── 秒级精化：20s 粗采样对直控指令不够（端点误差可达数百公里）───
  // 对每个粗窗，在 [winStart-20s, winEnd+20s] 内以 1s 步长重采样，
  // 输出精确 TCA（最近过顶点）、精确窗口边界与该时刻的精确侧摆角。
  const refined = coarse.map(w => {
    const rStart = w.start - 30000;
    const rEnd = Math.min(w.end + 30000, tEnd);
    let tcaT = null, tcaD = Infinity;
    // 一次取整段 1s 步长轨道（缓存命中后条带间/段间复用），原先逐点调用
    // sampleTrack(sat, new Date(t), 0.02, 1) 每点都 makeSatrec+propagate，慢 10 倍以上
    const fineTrack = sampleTrack(sat, new Date(rStart), Math.ceil((rEnd - rStart) / 60000) + 1, 1)
      .filter(p => p.t >= rStart && p.t <= rEnd);
    for (const p of fineTrack) {
      const dKm = haversineKm(p.lat, p.lon, strip.lat, strip.lon);
      if (dKm < tcaD) { tcaD = dKm; tcaT = p.t; }
    }
    if (tcaT === null) return w;
    // TCA 前后按可见判据回扫精确窗口边界（1s 步长）
    const fine = fineTrack
      .filter(p => p.t >= Math.max(t0.getTime(), tcaT - 300000) && p.t <= tEnd + 30000);
    let fStart = tcaT, fEnd = tcaT;
    for (const p of fine) {
      const dKm = haversineKm(p.lat, p.lon, strip.lat, strip.lon);
      const sunEl = solarElevationDeg(strip.lat, strip.lon, new Date(p.t));
      const vis = dKm <= maxOffKm && (sat.category === 'weather' || sunEl >= minElevSunDeg || sat.subCategory === 'sar');
      if (vis && p.t < fStart) fStart = p.t;
      if (vis && p.t > fEnd) fEnd = p.t;
    }
    // TCA 时刻精确侧摆（弧长/地心角模型）
    const slew = Math.atan(tcaD / altKm) * 180 / Math.PI;
    // 成像覆盖窗：传感器幅宽半宽内才算"能拍到"（直控口径）。
    // 幅宽按型号真实配置查 DEFAULT_CAPS（GAOFEN 14km / JILIN 12km / SUPERVIEW 12km / ZIYUAN 30km / FENGYUN 500km…）
    const series = Object.keys(DEFAULT_CAPS).find(k => sat.name?.toUpperCase().startsWith(k)) ?? '';
    const caps = series ? DEFAULT_CAPS[series] : null;
    const footprintHalfKm = (caps?.swathKm ?? 14) / 2;
    let imgWinStart = null, imgWinEnd = null;
    for (const p of fine) {
      const dKm = haversineKm(p.lat, p.lon, strip.lat, strip.lon);
      if (dKm <= footprintHalfKm) {
        if (imgWinStart === null) imgWinStart = p.t;
        imgWinEnd = p.t;
      }
    }
    // 采样精化：幅宽穿越窗仅 1.6s 级，直接在已取出的 1s 轨（fineTrack）上重定边界，
    // 不再单独 propagate（原先每窗 240 次 propagate + makeSatrec）
    {
      let s = null, e = null;
      for (const p of fineTrack) {
        const dKm = haversineKm(p.lat, p.lon, strip.lat, strip.lon);
        if (dKm <= footprintHalfKm) { if (s === null) s = p.t; e = p.t; }
      }
      if (s !== null) { imgWinStart = new Date(s).toISOString(); imgWinEnd = new Date(e).toISOString(); }
    }
    return {
      start: fStart, end: fEnd,          // 姿态可及窗（可见弧段）
      imgWinStart: imgWinStart,          // 成像覆盖窗起点（幅宽内；null=整个过境幅宽都罩不住目标）
      imgWinEnd: imgWinEnd,              // 成像覆盖窗终点
      overpass: tcaT,                    // 精确 TCA（最近过顶点）
      minDistKm: tcaD,                   // 精确最小距离
      slewDeg: slew,                     // TCA 时刻精确侧摆（atan 几何）
      refined: true,
    };
  });
  return refined;
}

// ─── 云量解算（4.3-4）：内置模拟气象场 ──────────────────────────────────
// 确定性模拟：区域气候统计（按纬度带的月度基准云量）+ 伪随机空间纹理（可复算）
const CLIMATE_BASE = [
  // 纬度带基准云量 [0,1]（简化分区：极地/高纬/中纬/亚热带/热带）
  { latMax: -60, base: 0.50 }, { latMax: -30, base: 0.40 }, { latMax: 0, base: 0.45 },
  { latMax: 30, base: 0.32 }, { latMax: 60, base: 0.40 }, { latMax: 90, base: 0.50 },
];
// 月度修正系数（北半球；冬季晴朗、夏季多云，南方雨季 5-6 月多云）
const MONTH_FACTOR = [0.95, 0.90, 0.85, 0.85, 0.95, 1.10, 1.25, 1.25, 1.05, 0.85, 0.80, 0.90];

function hash01(seed) {
  // 确定性伪随机 [0,1)
  let x = Math.sin(seed) * 43758.5453;
  return x - Math.floor(x);
}

export function forecastCloud(lat, lon, when, leadDays) {
  const absLat = Math.abs(lat);
  let base = 0.45;
  for (const b of CLIMATE_BASE) { if (absLat <= b.latMax) { base = b.base; break; } }
  const month = when.getUTCMonth();
  let cloud = base * MONTH_FACTOR[month];
  // 空间纹理：0.1° 网格确定性扰动
  const gridSeed = Math.floor(lat * 10) * 73.13 + Math.floor(lon * 10) * 151.7;
  cloud += (hash01(gridSeed) - 0.5) * 0.35;
  // 时间演化：提前量越大越趋近气候均值
  const converge = Math.min(1, leadDays / 5);
  cloud = cloud * (1 - converge * 0.4) + base * converge * 0.4;
  // 天气系统尺度扰动（~3天周期，可复算）
  const sysSeed = Math.floor(when.getTime() / 86400000) * 31.7 + Math.floor(lon / 15) * 57.3;
  cloud += (hash01(sysSeed) - 0.5) * 0.25;
  // 时刻扰动（同一天内不同过顶时刻有差异）
  const tSeed = Math.floor(when.getTime() / 1800000) * 17.3 + Math.floor(lat * 5) * 41.1;
  cloud += (hash01(tSeed) - 0.5) * 0.3;
  return Math.max(0, Math.min(1, cloud));
}

// 几何修正（4.3-4）：侧摆穿透 + 光照
export function cloudEffective(cloud, slewDeg, sunElevDeg) {
  const cosSlew = Math.max(0.2, Math.cos(slewDeg * Math.PI / 180));
  const ceff = 1 - Math.pow(1 - cloud, 1 / cosSlew);
  // 光照因子：太阳高度角 10°→0.8, 30°+→1.0
  const fsun = sunElevDeg >= 30 ? 1.0 : Math.max(0.3, 0.3 + (sunElevDeg / 30) * 0.7);
  const availability = 100 * (1 - ceff) * fsun;
  return { ceff, fsun, availability: Math.round(availability * 10) / 10 };
}

// ─── 约束筛选（4.3-3）：规则引擎，逐条独立判定 ──────────────────────────
export function applyConstraints(candidate, task, sat, cap) {
  const reasons = [];
  // 观测类型
  const taskObs = task.obsType; // optical|sar|video
  const satIsSar = sat.subCategory === 'sar';
  if (taskObs === 'sar' && !satIsSar) reasons.push('观测类型不符：任务要求SAR，载荷为光学');
  if (taskObs !== 'sar' && satIsSar) reasons.push('观测类型不符：任务要求光学，载荷为SAR');
  // 分辨率（计入侧摆退化的有效分辨率）
  const gcand = cap.resolution * (1 + candidate.slewDeg / cap.slewLimitDeg * 0.5); // 侧摆退化简化
  if (gcand > task.resolution) reasons.push(`分辨率不满足：要求${task.resolution}m，候选有效${gcand.toFixed(1)}m`);
  // 谱段（简化：任务有谱段要求而载荷不匹配）
  if (task.spectral && cap.spectral && !cap.spectral.includes(task.spectral)) {
    reasons.push(`谱段不覆盖：要求${task.spectral}`);
  }
  // 侧摆能力
  if (candidate.slewDeg > cap.slewLimitDeg) reasons.push(`侧摆超限：需${candidate.slewDeg.toFixed(0)}°>上限${cap.slewLimitDeg}°`);
  // 时效
  if (task.timelinessHours) {
    const overpass = new Date(candidate.overpassTime);
    const created = new Date(task.createdAt);
    const leadH = (overpass - created) / 3600000;
    if (leadH > task.timelinessHours) reasons.push(`时效不满足：过顶在${leadH.toFixed(0)}h后，要求${task.timelinessHours}h内`);
  }
  // 云量初判
  if (sat.subCategory !== 'sar' && candidate.cloudFc > task.maxCloud) {
    reasons.push(`云量超限：预报${(candidate.cloudFc*100).toFixed(0)}% > 任务上限${(task.maxCloud*100).toFixed(0)}%`);
  }
  return { pass: reasons.length === 0, reasons, validRes: gcand };
}

// 默认能力目录（公司×系列）
export const DEFAULT_CAPS = {
  'JILIN': { resolution: 0.75, swathKm: 12, slewLimitDeg: 45, spectral: '可见光' },
  'GAOFEN': { resolution: 0.8, swathKm: 14, slewLimitDeg: 35, spectral: '可见光' },
  'GAOFEN-3': { resolution: 1.0, swathKm: 10, slewLimitDeg: 40, spectral: 'SAR-C' },
  'YAOGAN': { resolution: 1.0, swathKm: 10, slewLimitDeg: 40, spectral: 'SAR-C' },
  'SUPERVIEW': { resolution: 0.5, swathKm: 12, slewLimitDeg: 45, spectral: '可见光' },
  'ZIYUAN': { resolution: 2.0, swathKm: 30, slewLimitDeg: 32, spectral: '可见光' },
  'TIANHUI': { resolution: 1.0, swathKm: 30, slewLimitDeg: 32, spectral: '可见光' },
  'FENGYUN': { resolution: 500, swathKm: 500, slewLimitDeg: 10, spectral: '多光谱' },
  'HAIYANG': { resolution: 50, swathKm: 500, slewLimitDeg: 20, spectral: '多光谱' },
  'SENTINEL': { resolution: 5, swathKm: 80, slewLimitDeg: 30, spectral: 'SAR-C/多光谱' },
  'LANDSAT': { resolution: 15, swathKm: 185, slewLimitDeg: 15, spectral: '多光谱' },
};

export function getCapability(sat) {
  const N = sat.name.toUpperCase();
  for (const [key, cap] of Object.entries(DEFAULT_CAPS)) {
    if (N.includes(key)) return { ...cap };
  }
  // 默认按类别给
  if (sat.category === 'imaging') return { resolution: 1.0, swathKm: 12, slewLimitDeg: 40, spectral: '可见光' };
  if (sat.category === 'recon') return { resolution: 1.0, swathKm: 10, slewLimitDeg: 40, spectral: 'SAR-C' };
  if (sat.category === 'weather') return { resolution: 500, swathKm: 500, slewLimitDeg: 10, spectral: '多光谱' };
  return { resolution: 30, swathKm: 100, slewLimitDeg: 20, spectral: '多光谱' };
}
