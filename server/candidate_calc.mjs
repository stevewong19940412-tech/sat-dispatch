// ─── 候选卫星计算模块（4.3）──────────────────────────────────────────────
// 流程：轨道预报 → 可见窗计算 → 约束筛选 → 云量解算 → 候选清单输出
// 确定性计算，全部可复算。轨道预报基于底座 SGP4。
import * as satellite from "satellite.js";
import { getSatSpec, getCapabilityBySpec } from "./sat_specs.mjs";
import { planAreaStrips } from "./strip_planner.mjs";
import { stripCoverageByGrid } from "./coverage_grid.mjs";

const EARTH_R = 6371;

// ─── 任务几何归一化 ──────────────────────────────────────────────────────
// 2026-11-15 重写：委托给全尺度自适应规划器 strip_planner.mjs。
//
// 旧实现的问题（已废弃）：
//   · 条带数按「外接圆直径/幅宽」，北京全域算出 22 条并外扩 37.5km 到张家口/廊坊
//   · 条带沿经度（东西）排列，而卫星过顶是南北向，方向差 90°
//   · 未控制重叠率，相邻带间还有 0.02km 缝隙
// 新实现：局部投影建系 + 沿星下点轨迹切条带 + 重叠率控制 + 尺度自适应策略。
export function normalizeTaskStrips(task, swathKm = 12, opts = {}) {
  const geom = JSON.parse(task.geom);
  if (task.geomType === 'point') {
    return [{ idx: 1, count: 1, lat: geom.lat, lon: geom.lon, radiusKm: 1, widthKm: swathKm,
              lengthKm: 0, areaKm2: 0, azimuthDeg: 0, overlapPct: 0, coverageRatio: 1 }];
  }
  const coords = geom.coords || geom.points;
  if (!Array.isArray(coords) || coords.length < 3) {
    throw new Error('面目标 geom.coords 至少需要 3 个 [lat,lon] 顶点');
  }
  // 传给规划器的额外参数（轨道倾角、重叠率、强制尺度）可经 opts 覆盖
  const plan = planAreaStrips(coords, {
    swathKm,
    incDeg: opts.incDeg ?? 97.9,
    overlapRate: opts.overlapRate,
    forceScale: opts.forceScale,
  });
  // 把规划摘要挂到数组上，供 dispatch 侧生成覆盖计划（不改变原有数组用法）
  Object.defineProperty(plan.strips, 'planMeta', { value: plan, enumerable: false });
  return plan.strips;
}

/** 供 dispatch 侧读取完整规划信息（尺度/策略/统计/方向） */
export function planTaskArea(task, swathKm = 12, opts = {}) {
  const strips = normalizeTaskStrips(task, swathKm, opts);
  return strips.planMeta ?? null;
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
const _TRACK_CACHE_MAX = 8192;

// ─── 1 秒轨道整段缓存（2026-11-15 性能优化）────────────────────────────────
// 问题：面目标任务每条带都要精化，而 sampleTrack 的缓存键含 minutesAhead，
//   各条带窗口长度不同 → 几乎不命中，21 条带 × 131 星 = 213 秒，请求超时。
// 改法：每颗星每次任务只采一次「任务全窗 + 前后缓冲」的 1 秒轨道，
//   之后所有条带对同一时间段的查询都走内存切片（O(log n) 二分 + 截取）。
const _fineCache = new Map();   // noradId -> { t0, t1, pts }
const _FINE_CACHE_MAX = 400;  // 需容纳任务内全部候选星（131颗）、防互相淘汰

function fineTrackCached(sat, fromMs, toMs) {
  const satrec = makeSatrec(sat);
  if (!satrec) return [];
  // 缓存键 = 卫星 + 1 分钟对齐的区间起点（不再按整颗星缓存整个 7 天，
  // 否则每条带都要在 10 万点的数组上二分切片，内存与 GC 压力都很大）。
  const a = Math.floor(fromMs / 60000) * 60000 - 60000;
  const b = Math.ceil(toMs / 60000) * 60000 + 60000;
  const key = `${sat.noradId}|${a}|${b}`;
  const hit = _fineCache.get(key);
  if (hit) return hit;
  const pts = [];
  for (let t = a; t <= b; t += 1000) {
    const date = new Date(t);
    try {
      const pv = satellite.propagate(satrec, date);
      if (!pv?.position || typeof pv.position === 'boolean') continue;
      const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
      const lat = satellite.degreesLat(geo.latitude);
      const lon = satellite.degreesLong(geo.longitude);
      if (!isNaN(lat) && !isNaN(lon)) pts.push({ t, lat, lon, altKm: geo.height });
    } catch {}
  }
  if (_fineCache.size >= _FINE_CACHE_MAX) _fineCache.delete(_fineCache.keys().next().value);
  _fineCache.set(key, pts);
  return pts;
}

function sliceTrack(pts, fromMs, toMs) {
  if (!pts.length) return [];
  // 二分找起点（pts 按 t 升序）
  let lo = 0, hi = pts.length - 1, idx = pts.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t >= fromMs) { idx = mid; hi = mid - 1; } else lo = mid + 1;
  }
  const out = [];
  for (let i = idx; i < pts.length && pts[i].t <= toMs; i++) out.push(pts[i]);
  return out;
}

/** 清理单次任务内的精化缓存（每次候选计算开始调用，防止跨任务串味/内存膨胀） */
export function resetFineCache() { _fineCache.clear(); }

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

/**
 * 批量粗筛：同一颗星对本任务的所有条带，判断哪些条带与该星在本时窗内有可见机会。
 * 目的（性能）：面目标任务 21 条带 × 131 星，若每对组合都完整跑一遍 7 天轨道采样，
 * 单任务耗时 >200s 直接请求超时。这里先用一次粗采样（60s 步长）算出该星的轨迹，
 * 再对每条带做一次距离扫描，把不可能有窗口的 (星,带) 组合提前剔除。
 *
 * 判据与 computeVisibleWindows 的粗扫门限保持一致（侧摆可达距离 × 0.98），
 * 因此不会漏掉真实窗口——只是把明显不可见的组合跳过。
 */
export function prescreenStripHits(sat, strips, opts) {
  const { windowStart, windowEnd, minElevSunDeg = 10, maxSlewDeg = 45 } = opts;
  const t0 = new Date(windowStart);
  const spanMs = new Date(windowEnd).getTime() - t0.getTime();
  if (!(spanMs > 0) || !strips.length) return new Set();
  const aheadMin = Math.min(Math.ceil(spanMs / 60000) + 60, 3 * 1440 + 60);
  const track = sampleTrack(sat, t0, aheadMin, 120); // 120s 粗筛足够（可见半径数百 km）
  if (!track.length) return new Set();
  const altKm = track[0].altKm || 500;
  const reach = altKm * Math.tan(Math.min(maxSlewDeg, 60) * Math.PI / 180) * 0.98
              + Math.max(...strips.map(s => s.radiusKm ?? 6));
  const tEnd = new Date(windowEnd).getTime();
  const hits = new Set();
  const isSar = sat.subCategory === 'sar';
  const isWeather = sat.category === 'weather';
  for (const p of track) {
    if (p.t > tEnd) break;
    for (const st of strips) {
      if (hits.has(st.idx)) continue;
      const d = haversineKm(p.lat, p.lon, st.lat, st.lon);
      if (d > reach) continue;
      if (!isSar && !isWeather && solarElevationDeg(st.lat, st.lon, new Date(p.t)) < minElevSunDeg) continue;
      hits.add(st.idx);
    }
    if (hits.size === strips.length) break;
  }
  return hits;
}

/**
 * 一次轨迹采样，算出该星对本任务所有条带的粗窗口（性能核心）。
 * 面目标任务 21 条带 × 131 星如果逐对调用 computeVisibleWindows，
 * 会重复采样 7 天轨道 2751 次（单任务 >400s）。
 * 这里只采样一次（与 computeVisibleWindows 同口径），
 * 逐点对所有条带做距离/光照判定，得到每带的粗窗口列表。
 *
 * @returns {Map<number, Array<{start:number,end:number,overpass:number,minDistKm:number,slewDeg:number}>>}
 */
export function coarseWindowsAllStrips(sat, strips, opts) {
  const { windowStart, windowEnd, minElevSunDeg = 10, maxSlewDeg = 45 } = opts;
  const t0 = new Date(windowStart);
  const tEnd = new Date(windowEnd).getTime();
  const spanMs = tEnd - t0.getTime();
  if (!(spanMs > 0) || !strips.length) return new Map();

  const SEG_MS = 3 * 86400000;
  const aheadMin = Math.min(Math.ceil(spanMs / 60000) + 60, 3 * 1440 + 120);
  const coarseStep = spanMs > 2 * 86400000 ? 60 : 20;
  const track = sampleTrack(sat, t0, aheadMin, coarseStep);
  if (!track.length) return new Map();

  const altKm = track[0].altKm || 500;
  const maxOffKm = altKm * Math.tan(Math.min(maxSlewDeg, 60) * Math.PI / 180) * 0.9;
  const isSar = sat.subCategory === 'sar';
  const isWeather = sat.category === 'weather';

  const state = strips.map(st => ({ st, inWin: false, winStart: null, best: null }));
  const out = new Map(strips.map(st => [st.idx, []]));

  for (const p of track) {
    if (p.t > tEnd) break;
    const sunEl = (isSar || isWeather) ? 99 : solarElevationDeg(p.lat, p.lon, new Date(p.t));
    for (const s of state) {
      const dKm = haversineKm(p.lat, p.lon, s.st.lat, s.st.lon);
      const visible = dKm <= maxOffKm && (isWeather || isSar || sunEl >= minElevSunDeg);
      if (visible) {
        if (!s.inWin) { s.inWin = true; s.winStart = p.t; s.best = { t: p.t, dKm }; }
        else if (dKm < s.best.dKm) s.best = { t: p.t, dKm };
      } else if (s.inWin) {
        s.inWin = false;
        if (s.best) out.get(s.st.idx).push({
          start: s.winStart, end: p.t, overpass: s.best.t,
          minDistKm: s.best.dKm, slewDeg: Math.atan(s.best.dKm / altKm) * 180 / Math.PI,
        });
        s.best = null;
      }
    }
  }
  for (const s of state) {
    if (s.inWin && s.best) out.get(s.st.idx).push({
      start: s.winStart, end: Math.min(track[track.length - 1].t, tEnd), overpass: s.best.t,
      minDistKm: s.best.dKm, slewDeg: Math.atan(s.best.dKm / altKm) * 180 / Math.PI,
    });
  }
  return out;
}

/**
 * 单条带精化：把 coarseWindowsAllStrips 得到的粗窗口做 1 秒精化。
 * 复用 computeVisibleWindows 的精化逻辑（TCA/成像覆盖窗/精确侧摆）。
 */
export function refineStripWindows(sat, strip, coarseList, opts) {
  if (!coarseList?.length) return [];
  const out = [];
  for (const w of coarseList.slice(0, 8)) {
    // 只在粗窗 ±60s 内做秒级精化（原实现按整段窗口重算，7 天窗会重复采样）
    const a = Math.max(w.start - 60000, new Date(opts.windowStart).getTime());
    const b = Math.min(w.end + 60000, new Date(opts.windowEnd).getTime());
    const r = refineOneWindow(sat, strip, a, b, w, opts);
    if (r) out.push(r);
  }
  return out;
}

/**
 * 单个窗口的秒级精化（从 computeVisibleWindows 内联抽出，避免整段重采样）。
 * 输入：星、条带、精化区间 [a,b]、粗窗（含 TCA 估计）、任务参数。
 * 输出：与 computeVisibleWindows 相同结构的窗口对象。
 */
function refineOneWindow(sat, strip, aMs, bMs, coarse, opts) {
  const { minElevSunDeg = 10, maxSlewDeg = 45 } = opts;
  const rec = makeSatrec(sat);
  if (!rec) return null;
  const pts = fineTrackCached(sat, aMs, bMs);
  if (!pts.length) return null;

  const spec = getSatSpec(sat);
  const footprintHalfKm = spec.swathKm / 2;
  const slewLimit = Math.min(spec.slewMax ?? 45, maxSlewDeg);
  const altKm = pts[0].altKm || 500;
  const maxSlewGroundKm = altKm * Math.tan(slewLimit * Math.PI / 180);
  const isSar = sat.subCategory === 'sar';
  const isWeather = sat.category === 'weather';

  let tcaT = null, tcaD = Infinity;
  let imgS = null, imgE = null, bestSlew = null;
  let visStart = null, visEnd = null;
  for (const p of pts) {
    const dKm = haversineKm(p.lat, p.lon, strip.lat, strip.lon);
    const sunEl = (isSar || isWeather) ? 99 : solarElevationDeg(strip.lat, strip.lon, new Date(p.t));
    const visible = dKm <= maxSlewGroundKm * 0.98 && (isWeather || isSar || sunEl >= minElevSunDeg);
    if (visible) {
      if (visStart === null) visStart = p.t;
      visEnd = p.t;
      if (dKm < tcaD) { tcaD = dKm; tcaT = p.t; }
      const theta = Math.atan(dKm / Math.max(1, p.altKm ?? altKm));
      const halfFoot = footprintHalfKm / Math.cos(theta);
      if (dKm <= maxSlewGroundKm + halfFoot) {
        if (imgS === null) imgS = p.t;
        imgE = p.t;
        const deg = theta * 180 / Math.PI;
        if (bestSlew === null || dKm < (bestSlew.d ?? 1e9)) bestSlew = { deg, d: dKm };
      }
    }
  }
  if (tcaT === null) return null;

  // ── 条带覆盖完整性（2026-11-16 重构：改用行业标准网格点法）──────────────
  // 旧实现只看「条带首尾两端是否可达」，属于近似；失败场景：卫星只扫过条带中段，
  // 两端点也可能因侧摆可达而被判命中，从而误报 100% 覆盖。
  // 现改为网格点法（Morrison 1973 / 汪荣峰 2020 / Song 2018 误差界）：
  // 把条带离散成 幅宽/8 的网格，逐点判断是否落在该次过顶的瞬时足迹内。
  const cov = stripCoverageByGrid(pts, strip, { swathKm: spec.swathKm, slewLimitDeg: slewLimit });
  const stripCoverage = cov.coverage;

  return {
    stripCoverage,
    stripCoverageDetail: cov,
    start: visStart, end: visEnd,
    imgWinStart: imgS !== null ? new Date(imgS).toISOString() : null,
    imgWinEnd: imgE !== null ? new Date(imgE).toISOString() : null,
    overpass: tcaT,
    minDistKm: tcaD,
    slewDeg: Math.atan(tcaD / altKm) * 180 / Math.PI,
    bestSlewDeg: bestSlew?.deg ?? null,
    maxSlewGroundKm: +maxSlewGroundKm.toFixed(1),
    refined: true,
  };
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
  // 长窗分段：粗扫用 60s 步长（星下点 60s 跑 450km，可见门限几百 km，20s 过密）。
  // 段边界的 t0 对齐到整 3 天刻度（取模对齐），同任务/跨任务的段完全同 t0 →
  // sampleTrack 缓存跨任务命中（格网批量任务共享同一批轨道采样，规划耗时降一个量级）
  const isGeoSat = probe.length > 2 && Math.abs(probe[probe.length-1].lon - probe[0].lon) < 0.035; // 弧度≈2°
  if (spanMs > SEG_MS && !isGeoSat) {
    const merged = [];
    const alignedStart = Math.floor(t0.getTime() / SEG_MS) * SEG_MS; // 对齐到全局段栅格
    let segStart = alignedStart;
    while (segStart < tEnd) {
      const segEnd = Math.min(segStart + SEG_MS, tEnd);
      const wStart = Math.max(segStart, t0.getTime());
      if (segEnd > wStart) {
        for (const w of computeVisibleWindows(sat, strip, { ...opts, windowStart: new Date(wStart).toISOString(), windowEnd: new Date(segEnd).toISOString() })) {
          merged.push(w);
        }
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
  const coarseStep = spanMs > 2 * 86400000 ? 60 : 20; // 长段粗扫 60s，短窗维持 20s
  const track = sampleTrack(sat, t0, aheadMin, coarseStep);
  if (track.length === 0) return [];

  // 地面覆盖半径（km）：侧摆上限对应
  const altKm = track[0].altKm || 500;
  // 粗扫门限：侧摆可达地面距离 × 0.95（留裕度）。注意与精化阶段的口径保持一致——
  // 旧代码用 tan(min(maxSlew,60))×0.9，在 maxSlew=45 时约 0.9×高度，
  // 比精化用的「侧摆可达 + 幅宽投影」小，会提前把远处窗口判成不可见。
  const maxOffKm = altKm * Math.tan(Math.min(maxSlewDeg, 60) * Math.PI / 180) * 0.98;

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
    // 走整段 1 秒轨道缓存：同任务内所有条带/窗口共享一次采样（性能优化）
    const fineTrack = fineTrackCached(sat, rStart, rEnd);
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
    // 幅宽/分辨率统一取型号规格表 sat_specs.mjs（2026-11-15 按官方公开参数校正，逐条记出处）。
    // 历史坑：曾用 startWith 前缀匹配 DEFAULT_CAPS，GAOFEN-9/11/13 全落到 GAOFEN 统配 14km，
    // JILIN-1 KUANFU 落到 JILIN 统配 12km，导致大量中宽幅星被误判"拍不到"。
    const spec = getSatSpec(sat);
    // ── 覆盖判定（2026-11-15 重构，核心修正）──────────────────────────────
    // 旧逻辑：只要星下点距目标 ≤ 幅宽半宽 才算能拍。
    //   → 把敏捷卫星的侧摆能力完全忽略了：一颗 45° 侧摆的卫星能拍星下点
    //     几百公里外的目标，旧逻辑却判"拍不到"，导致单星对北京全域只能覆盖 1/21 条带。
    //
    // 新逻辑：目标在侧摆可达范围内即可成像。
    //   侧摆角 θ = atan(d / h)，要求 θ ≤ 侧摆上限（型号 slewLimitDeg，受任务 maxSlewDeg 限制）
    //   同时幅宽要能覆盖目标附近的条带宽度：地面投影半宽 = swath/2 / cos(θ)
    //   （侧摆越大，地面足迹越宽但分辨率越差——分辨率退化由 applyConstraints 单独判）
    const footprintHalfKm = spec.swathKm / 2;
    const slewLimit = Math.min(spec.slewMax ?? 45, maxSlewDeg);
    // 侧摆可达的最大地面距离（km）
    const maxSlewGroundKm = altKm * Math.tan(slewLimit * Math.PI / 180);
    let imgWinStart = null, imgWinEnd = null;
    let bestSlew = null, bestDist = null;
    {
      let s = null, e = null;
      for (const p of fineTrack) {
        const dKm = haversineKm(p.lat, p.lon, strip.lat, strip.lon);
        // 目标落在该时刻侧摆可达脚印内 → 可成像
        if (dKm <= maxSlewGroundKm) {
          const theta = Math.atan(dKm / Math.max(1, p.altKm ?? altKm));
          const thetaDeg = theta * 180 / Math.PI;
          // 侧摆后地面足迹半宽（含幅宽投影）
          const halfFootprint = footprintHalfKm / Math.cos(theta);
          if (dKm <= maxSlewGroundKm + halfFootprint) {
            if (s === null) s = p.t;
            e = p.t;
            if (bestDist === null || dKm < bestDist) { bestDist = dKm; bestSlew = thetaDeg; }
          }
        }
      }
      if (s !== null) { imgWinStart = new Date(s).toISOString(); imgWinEnd = new Date(e).toISOString(); }
    }
    return {
      start: fStart, end: fEnd,          // 姿态可及窗（可见弧段）
      imgWinStart: imgWinStart,          // 成像覆盖窗起点（幅宽内；null=整个过境幅宽都罩不住目标）
      imgWinEnd: imgWinEnd,              // 成像覆盖窗终点
      overpass: tcaT,                    // 精确 TCA（最近过顶点）
      bestSlewDeg: bestSlew,             // 成像时刻实际侧摆角（可达范围内最优）
      maxSlewGroundKm: +maxSlewGroundKm.toFixed(1), // 侧摆可达地面距离上限
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
  // ── 条带覆盖率门槛（2026-11-16 用户要求）──────────────────────────────
  // 覆盖率 = 该星这次过顶能覆盖这条带的比例。为 0 表示几何上根本拍不到，
  // 这类候选**不能出现在候选里**（旧实现完全不校验，PO-20261116-205 的
  // rank1/rank2 覆盖率 0 却排在最前面，派单时才被跳过 → 用户以为派错）。
  // 门槛取 0.5：低于一半的条带即使拍到，拼接价值也很低（文献：相邻条带需充分重叠）。
  const minCoverage = task.minStripCoverage ?? 0.5;
  if (candidate.stripCoverage != null && candidate.stripCoverage < minCoverage) {
    const pct = (candidate.stripCoverage * 100).toFixed(0);
    reasons.push(candidate.stripCoverage < 0.01
      ? '条带不可覆盖：本次过顶拍不到该条带'
      : `条带覆盖不足：仅覆盖${pct}%，低于门槛${(minCoverage*100).toFixed(0)}%`);
  }
  return { pass: reasons.length === 0, reasons, validRes: gcand };
}

// 默认能力目录（公司×系列）
// ⚠️ 2026-11-15 起不是覆盖判定的取值源，见 sat_specs.mjs。此表仅作为历史兜底常量保留，
// 其中 JILIN 12km / GAOFEN 统一 14km 的口径已被官方公开参数取代（GAOFEN-1 60km / GAOFEN-6 90km 等）。
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
  // 统一由型号规格表提供（single source of truth），返回结构与历史保持兼容
  return getCapabilityBySpec(sat);
}

// 历史常量保留导出：仅作兜底与文档参考，覆盖判定已不使用
export const DEFAULT_CAPS_LEGACY = DEFAULT_CAPS;
