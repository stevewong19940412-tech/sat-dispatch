// ─── 区域目标成像规划器（全尺度自适应）──────────────────────────────────────
// 2026-11-15 重写。替代 candidate_calc.mjs 中「按外接圆切经度条带」的旧实现。
//
// 设计依据（见 docs/区域目标成像规划算法设计.md）：
//   · 条带必须平行于卫星地面轨迹（不是平行经纬线）—— 余婧 2015 / Mu 2026
//   · 区域分解 + 条带优选两阶段 —— Wang 2020 综述 / IOP 2018
//   · 相邻条带重叠 10~20%（拼接像素阈值 ≥28px @0.46m）—— 许越 2017
//   · 敏捷卫星同轨多条带拼幅受姿态机动时间约束 —— 余婧 2015 / 唐忠兴 2014
//   · 大区域/超大区域用网格化 + 多星多期 —— 伍国华 2026 / CN115659556A
//
// 核心原则：这是一个**通用规划器**，不是针对某个区域的特例。
// 输入任意多边形，自动判定尺度、选择策略、生成条带、评估可行性。

const R_EARTH = 6371.0; // km
const DEG = Math.PI / 180;

// ─── 尺度定义（全尺度覆盖，无"以后再做"的空档）───────────────────────────────
export const SCALES = [
  { key: 'facility',  label: '单设施',   maxEdgeKm: 10,      minEdgeKm: 0 },
  { key: 'small',     label: '小区域',   maxEdgeKm: 50,      minEdgeKm: 10 },
  { key: 'medium',    label: '中区域',   maxEdgeKm: 300,     minEdgeKm: 50 },
  { key: 'large',     label: '大区域',   maxEdgeKm: 2000,    minEdgeKm: 300 },
  { key: 'national',  label: '全国/超大', maxEdgeKm: Infinity, minEdgeKm: 2000 },
];

/** 各尺度的默认策略参数（可在任务上覆盖） */
// maxStripLenKm：单条带沿轨方向的最大长度（超过则切成多段）。
// 依据：低轨卫星单次过顶的可用成像弧段通常 60~180 秒，地面速度 6.83 km/s，
// 对应可连续扫过约 400~1200 km；但受姿态指向与轨迹夹角影响，实际有效扫过
// 通常只有几百 km 量级。取 100 km 作为「单段可靠可扫长度」，
// 使每条带都能被一次过顶完整覆盖——这是避免"条带名义覆盖、实际只扫中段"的关键。
export const SCALE_POLICY = {
  facility: { overlapRate: 0.15, allowMultiPass: false, gridKm: null, maxStripLenKm: 100, preferSinglePass: true,  note: '单条带/单景，一次过顶完成' },
  small:    { overlapRate: 0.15, allowMultiPass: false, gridKm: null, maxStripLenKm: 100, preferSinglePass: true,  note: '单/双条带，优先同轨拼幅' },
  medium:   { overlapRate: 0.15, allowMultiPass: true,  gridKm: null, maxStripLenKm: 100, preferSinglePass: true,  note: '条带族，优先同轨多带侧摆拼接' },
  large:    { overlapRate: 0.15, allowMultiPass: true,  gridKm: null, maxStripLenKm: 100, preferSinglePass: false, note: '条带族 + 多星分派，长窗口' },
  national: { overlapRate: 0.20, allowMultiPass: true,  gridKm: 16,   maxStripLenKm: 100, preferSinglePass: false, note: '格网化 + 多星多期，强调覆盖与拼图冗余' },
};

/**
 * 局部等距圆柱投影（以质心为原点）。
 * 消除 111*cos(lat) 的近似误差，条带宽度在平面内为常数。
 */
export function makeProjection(cLat, cLon) {
  const cosLat = Math.cos(cLat * DEG);
  return {
    fwd: ([lat, lon]) => [R_EARTH * (lon - cLon) * DEG * cosLat, R_EARTH * (lat - cLat) * DEG],
    inv: ([x, y]) => [cLat + (y / R_EARTH) / DEG, cLon + (x / (R_EARTH * cosLat)) / DEG],
    cLat, cLon, cosLat,
  };
}

/**
 * 太阳同步轨道（倾角 i≈97.9°，逆行）在纬度 φ 处的地面轨迹方位角。
 *
 * 球面关系：cos(i) = cos(φ) · sin(ψ)  →  sin(ψ) = cos(i)/cos(φ)
 * 其中 ψ 为轨迹相对正北的偏角（向西为负）。
 *
 * 历史 bug：曾误用 acos 得 100.35°，实际应为 -10.34°（近正南北偏西），
 * 差 90° 会让条带方向垂直于轨迹，整个区域拆分失效。
 */
export function groundTrackAzimuth(incDeg, latDeg) {
  const cosInc = Math.cos(incDeg * DEG);
  const cosLat = Math.cos(latDeg * DEG);
  if (Math.abs(cosLat) < 1e-6) return 0;
  const ratio = Math.max(-1, Math.min(1, cosInc / cosLat));
  return Math.asin(ratio); // 弧度，负值=向西偏
}

/** 多边形面积（局部平面，shoelace） */
function polygonArea2D(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/** 点是否在多边形内（射线法） */
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi)) inside = !inside;
  }
  return inside;
}

/** 线段与水平线的交点（用于求条带在该带内的 y 范围） */
function clipStripY(poly, xLeft, xRight, yMin, yMax) {
  // 采样法求该 x 区间内在多边形内的 y 覆盖（足够精确，且对凹多边形稳健）
  const NX = 12, NY = 120;
  let yLo = Infinity, yHi = -Infinity, hitCells = 0;
  for (let ix = 0; ix < NX; ix++) {
    const x = xLeft + ((ix + 0.5) / NX) * (xRight - xLeft);
    for (let iy = 0; iy < NY; iy++) {
      const y = yMin + ((iy + 0.5) / NY) * (yMax - yMin);
      if (pointInPoly(x, y, poly)) {
        hitCells++;
        if (y < yLo) yLo = y;
        if (y > yHi) yHi = y;
      }
    }
  }
  if (hitCells === 0) return null;
  // 覆盖率校正：把采样得到的 y 范围按命中格点比例收紧
  return { yLo, yHi, coverage: hitCells / (NX * NY) };
}

/**
 * 主入口：把任意多边形区域规划成条带集合。
 *
 * @param {number[][]} coords   多边形顶点 [[lat,lon], ...]
 * @param {object} opt
 *   swathKm      传感器幅宽（默认 12）
 *   incDeg       主用卫星轨道倾角（默认 97.9，太阳同步）
 *   overlapRate  重叠率（默认按尺度策略）
 *   forceScale   强制指定尺度（测试用）
 * @returns {{scale,policy,strips,stats,direction,projection}}
 */
/**
 * 按给定方向切条带，算出「需要几条 + 总长度」（不做完整条带构造，只做评估）
 *
 * 这是文献里的核心评估函数：
 *   宇航学报 2025 / CCDC 2026 / 航天东方红专利 一致认为
 *   条带划分是 min(条带数) + min(总长度) 的双目标问题，NP-hard，无固定公式，
 *   实践上对候选方向逐一评估、择优。
 *
 * @param polyKm  已投影到局部平面的多边形 [[x,y],...]（km）
 * @param thetaDeg 条带方向（相对 x 轴的旋转角，弧度制由调用方转换）
 * @param swathKm 幅宽
 * @param overlapRate 相邻条带重叠率
 * @param maxStripLenKm 单条带沿轨最大长度
 * @returns { count, totalLenKm, uSpanKm, vSpanKm } 该方向下的条带数、总长、横跨/纵跨
 */
export function evalDirection(polyKm, thetaDeg, swathKm, overlapRate = 0.15, maxStripLenKm = 100) {
  const th = thetaDeg * DEG;
  const cosA = Math.cos(th), sinA = Math.sin(th);
  // 旋转到「条带方向对齐 v 轴」的坐标系
  const rot = polyKm.map(([x, y]) => [x * cosA + y * sinA, -x * sinA + y * cosA]);
  const uMin = Math.min(...rot.map(p => p[0]));
  const uMax = Math.max(...rot.map(p => p[0]));
  const vMin = Math.min(...rot.map(p => p[1]));
  const vMax = Math.max(...rot.map(p => p[1]));

  const uSpan = uMax - uMin;          // 垂直条带方向的跨度 → 决定条带数
  const vSpan = vMax - vMin;          // 沿条带方向的跨度 → 决定每带长度

  const step = Math.max(1e-6, swathKm * (1 - overlapRate));
  const count = Math.max(1, Math.ceil(uSpan / step));
  // 每条带沿轨方向按 maxStripLen 分段
  const segCount = Math.max(1, Math.ceil(vSpan / maxStripLenKm));
  const segLen = vSpan / segCount;

  return {
    count: count * segCount,          // 总条带数（横 × 纵分段）
    lateralCount: count,
    segCount,
    totalLenKm: +(count * segLen * segCount).toFixed(1),
    uSpanKm: +uSpan.toFixed(1),
    vSpanKm: +vSpan.toFixed(1),
  };
}

/**
 * 多方向择优：按文献方法选条带划分方向
 *
 * ⚠️ 关键约束（文献前提，不能违反）：
 *   条带方向**必须与星下点轨迹平行**。被动推扫成像时卫星姿态固定，
 *   只能沿轨迹方向扫；只有敏捷卫星"动中成像"才允许与轨迹成小夹角（通常 ≤10°）。
 *   因此候选中**绝不能**包含任意方向（如正东西 90°/0°）——那些方向物理上拍不到。
 *   曾误把 0°/90° 放进候选集，导致算法选出"条带数最少"却根本无法执行的方向。
 *
 * 目标（与 CCDC 2026 / 航天东方红专利一致）：
 *   先最小化条带数，条带数相同则最小化总长度。
 *   候选方向 = 轨迹方位角 ± 动中成像允许的偏角（默认 ±10° 内，5°/10° 档）。
 *
 * @returns { best: {thetaDeg, ...eval}, candidates: [...], reason }
 */
export function chooseBestDirection(polyKm, swathKm, centerLat, incDeg = 97.9, opt = {}) {
  const overlapRate = opt.overlapRate ?? 0.15;
  const maxStripLenKm = opt.maxStripLenKm ?? 100;
  // 动中成像允许的最大偏角（度）。卫星侧摆/俯仰能力有限，超出即拍不到。
  const maxSkewDeg = opt.maxSkewDeg ?? 10;

  // 主方向：地面轨迹方位角（条带与轨迹平行，被动推扫的基准）
  const trackAzDeg = (groundTrackAzimuth(incDeg, centerLat) / DEG);
  // 候选只能在轨迹方位的小偏角邻域内（动中成像微调）
  const cands = [trackAzDeg];
  const step = 5;
  for (let d = step; d <= maxSkewDeg + 1e-9; d += step) {
    cands.push(trackAzDeg - d, trackAzDeg + d);
  }

  const results = [];
  const seen = new Set();
  for (const t of cands) {
    const key = t.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    const ev = evalDirection(polyKm, t, swathKm, overlapRate, maxStripLenKm);
    results.push({ thetaDeg: +t.toFixed(2), ...ev });
  }

  // 排序：条带数少优先，其次总长小；同等条件下偏向贴近轨迹方位（推扫效率高）
  results.sort((a, b) => {
    if (a.count !== b.count) return a.count - b.count;
    if (Math.abs(a.totalLenKm - b.totalLenKm) > 0.5) return a.totalLenKm - b.totalLenKm;
    return Math.abs(a.thetaDeg - trackAzDeg) - Math.abs(b.thetaDeg - trackAzDeg);
  });

  const best = results[0];
  return {
    best,
    trackAzDeg: +trackAzDeg.toFixed(2),
    candidates: results,
    reason: `在轨迹方位 ${trackAzDeg.toFixed(2)}°±${maxSkewDeg}° 的 ${results.length} 个可行方向中，`
      + `${best.thetaDeg}° 需 ${best.count} 条带（总长 ${best.totalLenKm}km）为最少`
      + (Math.abs(best.thetaDeg - trackAzDeg) > 0.5
        ? `，需动中成像偏 ${(best.thetaDeg - trackAzDeg).toFixed(1)}°`
        : '（与轨迹平行，无需偏转）'),
  };
}

export function planAreaStrips(coords, opt = {}) {
  const swathKm = opt.swathKm ?? 12;
  const incDeg = opt.incDeg ?? 97.9;

  // ── 质心与尺度判定 ──
  let latSum = 0, lonSum = 0;
  for (const [la, lo] of coords) { latSum += la; lonSum += lo; }
  const cLat = latSum / coords.length, cLon = lonSum / coords.length;
  const proj = makeProjection(cLat, cLon);
  const poly = coords.map(proj.fwd);

  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const widthKm = Math.max(...xs) - Math.min(...xs);
  const heightKm = Math.max(...ys) - Math.min(...ys);
  const maxEdgeKm = Math.max(widthKm, heightKm);
  const polyArea = polygonArea2D(poly);

  const scale = opt.forceScale
    ? SCALES.find((s) => s.key === opt.forceScale)
    : SCALES.find((s) => maxEdgeKm > s.minEdgeKm && maxEdgeKm <= s.maxEdgeKm) ?? SCALES[SCALES.length - 1];
  const policy = { ...SCALE_POLICY[scale.key] };
  if (opt.overlapRate != null) policy.overlapRate = opt.overlapRate;

  // ── 条带方向 ──
  // 默认平行于地面轨迹（被动推扫基准）；
  // opt.azimuthDeg 可由方向择优给出（动中成像），此时按指定方向铺带。
  const trackAz = groundTrackAzimuth(incDeg, cLat);
  const azimuth = opt.azimuthDeg != null ? opt.azimuthDeg * DEG : trackAz;
  const azDeg = (azimuth / DEG);

  // ── 在旋转坐标系中切片：把轨迹方向对齐到 v 轴 ──
  // 旋转 R(θ) 把 (x,y) → (u,v)，θ = azimuth 使轨迹方向落到 v 轴：
  //   u =  x·cosθ + y·sinθ
  //   v = -x·sinθ + y·cosθ
  // 逆变换（v 轴回到原坐标）：
  //   x = u·cosθ - v·sinθ
  //   y = u·sinθ + v·cosθ
  // 历史 bug：正向与逆向用了同一套符号，导致条带方向被镜像
  // （实测条带 −> +10.25°，而轨道是 −10.37°，差 20° → 条带与轨道不平行）。
  // 数学推导（已单测验证）：
  //   轨迹方向单位向量 (dx,dy) = (sinθ, cosθ)，θ = azimuth
  //   需找旋转角 φ 使结果落在 v 轴：u = dx·cosφ + dy·sinφ = sin(θ+φ) = 0 → φ = -θ
  //   故正向旋转用 φ = -azimuth（用 +azimuth 会得到 u=-0.354，未对齐 → 条带被镜像）。
  const th = -azimuth;
  const cosA = Math.cos(th), sinA = Math.sin(th);
  const rot = poly.map(([x, y]) => [x * cosA + y * sinA, -x * sinA + y * cosA]);
  const rotInv = ([u, v]) => [u * cosA - v * sinA, u * sinA + v * cosA];

  // 沿垂直轨迹方向（旋转后的 u 轴）推进
  const step = swathKm * (1 - policy.overlapRate);
  const uMin = Math.min(...rot.map((p) => p[0]));
  const uMax = Math.max(...rot.map((p) => p[0]));
  const vMin = Math.min(...rot.map((p) => p[1]));
  const vMax = Math.max(...rot.map((p) => p[1]));

  const strips = [];
  let idx = 0;
  const maxLen = policy.maxStripLenKm ?? 100;
  // 沿轨方向按 maxLen 分段：每条带长度不超过单次过顶可靠可扫长度，
  // 否则会出现"名义上是一条带、实际只能扫到中段"的假覆盖。
  const segCount = Math.max(1, Math.ceil((vMax - vMin) / maxLen));
  const segLen = (vMax - vMin) / segCount;

  // ── 条带位置布局（文献：OVSC 条带位置/长度可变，非固定等间距）──────────────
  // 问题：从西边界起等间距铺（步进 = 幅宽×(1-重叠)），末带常被切成残带。
  //   实测海淀一块 17.7km 宽、幅宽 20km → 带1 18.82km + 带2 仅 1.82km。
  //   残带虽能盖住缺口，但宽度远小于幅宽，拼接质量差、成像资源利用率低。
  // 文献做法（Eur. J. Oper. Res. 2021「Orientational variable-length strip covering」）：
  //   条带的位置与长度是待优化变量，目标是覆盖完整 + 总长最短。
  // 文献约束（许越等 2017「多条带拼接重叠像元数阈值」）：
  //   相邻条带必须保证足够重叠宽度（0.46m 分辨率下 ≥28 像素，敏捷条带阈值更高）。
  //
  // 本实现：先按等间距算条带数 N，再判断末带是否过窄（< 幅宽×40%）。
  //   过窄 → 把整个跨度按 N 条「均匀重分布」，使每条宽度相近且都有充分重叠；
  //   否则保持等间距（满带 + 正常末带）。
  const spanU = uMax - uMin;
  // 条带数：spanU ≤ 幅宽 → 1 条即可整幅覆盖（此时不按 step 铺，否则 17.7km 会被
  // 步进 17km 切成"18.82 + 1.82"两段，正是用户看到的怪现象）。
  // spanU > 幅宽 → 按 step 铺，末带按残宽判断是否重分布。
  let stripCountU;
  if (spanU <= swathKm) {
    stripCountU = 1;
  } else {
    stripCountU = Math.ceil((spanU - swathKm) / step) + 1;
  }
  const lastStripWidthIfEven = stripCountU > 1 ? spanU - (stripCountU - 1) * step : spanU;
  const needRedistribute = stripCountU > 1 && lastStripWidthIfEven < swathKm * 0.4;
  // 均匀布局时每带宽度：各带宽度均不超过幅宽
  const evenWidth = stripCountU > 1
    ? Math.min(swathKm, spanU / stripCountU + swathKm * policy.overlapRate)
    : spanU;

  // 计算每条带的 [uL, uR]
  const uBands = [];
  if (needRedistribute) {
    // 均匀重分布：把 spanU 均分为 stripCountU 段，每段中心对称展开一幅宽
    const segW = spanU / stripCountU;
    for (let i = 0; i < stripCountU; i++) {
      const center = uMin + segW * (i + 0.5);
      let uL = center - evenWidth / 2;
      let uR = center + evenWidth / 2;
      // 首末条带贴边不越界
      if (uL < uMin) { uR += (uMin - uL); uL = uMin; }
      if (uR > uMax) { uL -= (uR - uMax); uR = uMax; }
      uL = Math.max(uL, uMin); uR = Math.min(uR, uMax);
      uBands.push([uL, uR]);
    }
  } else if (stripCountU === 1) {
    // 单条带：整幅宽覆盖整个跨度（居中，不越界）
    const center = (uMin + uMax) / 2;
    let uL = center - swathKm / 2;
    let uR = center + swathKm / 2;
    if (uL < uMin) { uR += (uMin - uL); uL = uMin; }
    if (uR > uMax) { uL -= (uR - uMax); uR = uMax; }
    uL = Math.max(uL, uMin); uR = Math.min(uR, uMax);
    uBands.push([uL, uR]);
  } else {
    for (let u = uMin; u < uMax - 1e-6; u += step) {
      let uL = u;
      let uR = Math.min(u + swathKm, uMax);
      if (uR - uL < swathKm * 0.3) uR = Math.min(uL + swathKm, uMax);
      uBands.push([uL, uR]);
    }
  }

  for (const [bU, beU] of uBands) {
    let uL = bU;
    let uR = beU;
    const actualWidth = uR - uL;
    // 求该条带在旋转系内的覆盖范围（用旋转系多边形做采样）
    for (let seg = 0; seg < segCount; seg++) {
    idx++;
    const segLo = vMin + seg * segLen;
    const segHi = vMin + (seg + 1) * segLen;
    const band = clipStripY(rot, uL, uR, segLo, segHi);
    if (!band) { idx--; continue; }
    const uC = (uL + uR) / 2;
    const vC = (band.yLo + band.yHi) / 2;
    const [xC, yC] = rotInv([uC, vC]);
    const [sLat, sLon] = proj.inv([xC, yC]);
    // 条带两端（沿轨迹方向）
    const [x1, y1] = rotInv([uC, band.yLo]);
    const [x2, y2] = rotInv([uC, band.yHi]);
    const [lat1, lon1] = proj.inv([x1, y1]);
    const [lat2, lon2] = proj.inv([x2, y2]);

    strips.push({
      idx,
      count: 0, // 生成完再回填
      lat: +sLat.toFixed(5),
      lon: +sLon.toFixed(5),
      radiusKm: swathKm / 2,
      // 覆盖计划字段
      azimuthDeg: +azDeg.toFixed(2),
      widthKm: +actualWidth.toFixed(2),
      lengthKm: +(band.yHi - band.yLo).toFixed(2),
      areaKm2: +((band.yHi - band.yLo) * actualWidth).toFixed(1),
      // 条带沿轨迹方向的两个端点
      start: [+lat1.toFixed(5), +lon1.toFixed(5)],
      end: [+lat2.toFixed(5), +lon2.toFixed(5)],
      overlapPct: idx === 1 ? 0 : +(policy.overlapRate * 100).toFixed(1),
      coverageRatio: +band.coverage.toFixed(3),
      segmentIdx: seg + 1,
      segmentCount: segCount,
    });
    }
  }
  for (const s of strips) s.count = strips.length;

  const totalStripArea = strips.reduce((a, s) => a + s.areaKm2, 0);
  return {
    scale: scale.key,
    scaleLabel: scale.label,
    policy,
    direction: {
      azimuthDeg: +azDeg.toFixed(2),
      note: azDeg < 1 ? '近似正南北（沿星下点轨迹）' : `沿星下点轨迹，相对正北偏 ${azDeg.toFixed(1)}°`,
      incDeg,
    },
    strips,
    stats: {
      polygonAreaKm2: +polyArea.toFixed(1),
      totalStripAreaKm2: +totalStripArea.toFixed(1),
      // 冗余 = 条带总面积 / 多边形面积 - 1（应接近 overlapRate，说明重叠受控）
      redundancyPct: +(polyArea > 0 ? (totalStripArea / polyArea - 1) * 100 : 0).toFixed(1),
      widthKm: +widthKm.toFixed(1),
      heightKm: +heightKm.toFixed(1),
      maxEdgeKm: +maxEdgeKm.toFixed(1),
      stripCount: strips.length,
      swathKm,
      stepKm: +step.toFixed(2),
    },
    projection: { cLat: +cLat.toFixed(5), cLon: +cLon.toFixed(5) },
  };
}

/**
 * 覆盖计划汇总：把条带 + 排程结果合成用户可读的计划。
 * @param {object} plan     planAreaStrips 的返回
 * @param {Array}  assigned 每条带的排程结果 [{idx, satName, overpass, slewDeg, ...} | null]
 */
export function summarizeCoveragePlan(plan, assigned = []) {
  const byIdx = new Map(assigned.map((a) => [a?.idx, a]));
  let ok = 0, miss = 0;
  const gaps = [];
  const sats = new Set();
  const times = [];
  for (const s of plan.strips) {
    const a = byIdx.get(s.idx);
    if (a && a.satName) {
      ok++;
      sats.add(a.satName);
      if (a.overpass) times.push(new Date(a.overpass).getTime());
    } else {
      miss++;
      gaps.push({ stripId: s.idx, reason: a?.reason ?? '时窗内无可用过顶' });
    }
  }
  const spanDays = times.length ? (Math.max(...times) - Math.min(...times)) / 86400000 : 0;
  return {
    scale: plan.scaleLabel,
    policy: plan.policy.note,
    totalStrips: plan.strips.length,
    scheduled: ok,
    unscheduled: miss,
    coveragePct: plan.strips.length ? +((ok / plan.strips.length) * 100).toFixed(1) : 0,
    satsUsed: [...sats],
    spanDays: +spanDays.toFixed(1),
    gaps,
  };
}
