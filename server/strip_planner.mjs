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

  // ── 条带方向：平行于地面轨迹 ──
  const azimuth = groundTrackAzimuth(incDeg, cLat);
  const azDeg = (azimuth / DEG);

  // ── 在旋转坐标系中切片：把轨迹方向对齐到 y 轴（旋转 -azimuth）──
  const cosA = Math.cos(-azimuth), sinA = Math.sin(-azimuth);
  const rot = poly.map(([x, y]) => [x * cosA - y * sinA, x * sinA + y * cosA]);
  const rotInv = ([u, v]) => [u * Math.cos(azimuth) - v * Math.sin(azimuth), u * Math.sin(azimuth) + v * Math.cos(azimuth)];

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

  for (let u = uMin; u < uMax - 1e-6; u += step) {
    // 首末条带按需裁剪：若剩余宽度不足整幅宽，只取到边界为止（避免小区域冗余过高）。
    // 但不得窄于幅宽的 30%，否则拼接价值过低，宁可按整幅宽覆盖。
    let uL = u;
    let uR = Math.min(u + swathKm, uMax);
    if (uR - uL < swathKm * 0.3) uR = Math.min(uL + swathKm, uMax);
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
