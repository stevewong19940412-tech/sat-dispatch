// 区域规划判定 —— 全尺度统一的「拆不拆、拆几条」裁决器
//
// 设计目标（2026-11-16）：任何大小的区域，都由这一套逻辑给出自洽结论，
// 不依赖调用方临时拍板，也不对特定任务做特例。
//
// 核心问题：区域多大？可用星多宽？两者一比就知道要不要拆、拆几条。
// 难点不在公式，而在「幅宽取哪个值」——
//   · 取 12km（最窄）：条带爆炸，小区域也被切碎
//   · 取 150km（最宽）：可用星少、覆盖能力虚高
// 正确做法：按「满足任务要求的分辨率档，实际有哪些星可用」动态推导，
// 且必须区分「标称幅宽」与「该分辨率下的有效幅宽」。
//
// 判定四档（scale），与条带规划、建单、汇报统一使用：
//   point   点目标        → 不拆
//   small   长边 ≤ 幅宽    → 不拆
//   medium  幅宽 ~ 2倍幅宽 → 横向拆少量
//   large   2倍 ~ 8倍幅宽  → 横向拆多条
//   national > 8倍幅宽     → 多星多期（必须提示）

import { getCapability } from './candidate_calc.mjs';
import { planAreaStrips, groundTrackAzimuth, makeProjection, chooseBestDirection } from './strip_planner.mjs';

const KM_PER_DEG_LAT = 110.57;

/** 区域外接矩形的实际地理尺寸（km） */
export function regionSize(coords) {
  const lats = coords.map(c => c[0]);
  const lons = coords.map(c => c[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const cLat = (minLat + maxLat) / 2;
  const widthKm = (maxLon - minLon) * 111.32 * Math.cos(cLat * Math.PI / 180);
  const heightKm = (maxLat - minLat) * KM_PER_DEG_LAT;
  return {
    widthKm: +widthKm.toFixed(1),
    heightKm: +heightKm.toFixed(1),
    maxEdgeKm: +Math.max(widthKm, heightKm).toFixed(1),
    minEdgeKm: +Math.min(widthKm, heightKm).toFixed(1),
    areaKm2: +(widthKm * heightKm).toFixed(0),
    centerLat: +cLat.toFixed(4),
    bbox: { minLat, maxLat, minLon, maxLon },
  };
}

/**
 * 按任务要求筛出可用卫星，并推导「本次规划实际可用的幅宽」
 *
 * 这里解决一个容易搞错的问题：不同卫星幅宽差异极大（11.6km ~ 150km），
 * 用哪一颗的幅宽决定条带数。做法是：
 *   1) 先按观测类型 + 分辨率要求筛出可用星
 *   2) 取这批星里幅宽的中位数偏上值作为「规划幅宽」
 *      —— 既不用最窄（会把小任务切碎），也不用最宽（只有一两颗星能做到，
 *         其余星拍不了，方案实际执行不了）
 *   3) 同时返回幅宽分布，便于解释为什么这么判
 *
 * @param satRows 卫星记录数组（含 subCategory/country 等）
 * @param obsType 'optical' | 'sar'
 * @param resolutionM 分辨率要求（米）
 */
export function deriveUsableSwath(satRows, obsType, resolutionM) {
  const wantSar = String(obsType ?? 'optical').toLowerCase() === 'sar';
  const resReq = Number(resolutionM) || 2;

  const usable = [];
  for (const s of satRows) {
    const sub = String(s.subCategory ?? '').toLowerCase();
    const typeOk = wantSar ? sub === 'sar' : ['optical', 'staring', 'hyperspectral'].includes(sub);
    if (!typeOk) continue;
    if (s.country !== '中国') continue;
    if (s.decayed === 1) continue;
    const cap = getCapability(s);
    if (!cap?.swathKm) continue;
    // 分辨率门槛：卫星分辨率必须不差于任务要求（留 20% 余量）
    if (cap.resolution != null && cap.resolution > resReq * 1.2) continue;
    usable.push({ name: s.name, operator: s.operator ?? s.country, subCategory: sub, cap });
  }

  if (!usable.length) {
    return {
      usableCount: 0, swathKm: 12, minSwathKm: 12, maxSwathKm: 12,
      widest: null, medianSwathKm: 12, top: [],
      note: `没有满足 ${wantSar ? 'SAR' : '光学'} + ${resReq}m 要求的中国在轨卫星`,
    };
  }

  usable.sort((a, b) => (b.cap.swathKm ?? 0) - (a.cap.swathKm ?? 0));
  const swaths = usable.map(u => u.cap.swathKm).sort((a, b) => a - b);
  const minSwathKm = swaths[0];
  const maxSwathKm = swaths[swaths.length - 1];
  // 取「多数星都能达到」的宽度：75 分位（避免被极少数宽幅星拉高）
  const p75 = swaths[Math.min(swaths.length - 1, Math.floor(swaths.length * 0.75))];

  // ── 动中成像偏角能力（文献依据）────────────────────────────────
  // 条带方向原则上必须与星下点轨迹平行（传统 TDI-CCD 推扫的像移约束）。
  // 只有敏捷星支持"动中成像"（条带与轨迹成夹角）：
  //   · 高分多模卫星：官方标称「与星下点轨迹任意方向推扫」
  //   · 泰景三号04星：偏离星下点 50°
  //   · 传统推扫星：偏角 0°，偏了会引入像移导致 MTF 退化
  // 用侧摆能力作敏捷性代理指标（侧摆 ≥35° 视为敏捷平台，允许 10° 偏角）。
  const agileSats = usable.filter(u => (u.cap.slewLimitDeg ?? 0) >= 35);
  const agileRatio = usable.length ? agileSats.length / usable.length : 0;
  // 允许偏角：多数星敏捷才放开，否则强制平行轨迹
  const maxSkewDeg = agileRatio >= 0.5 ? 10 : (agileRatio >= 0.2 ? 5 : 0);

  return {
    usableCount: usable.length,
    minSwathKm, maxSwathKm,
    medianSwathKm: swaths[Math.floor(swaths.length / 2)],
    p75SwathKm: p75,
    swathKm: p75,                     // 规划幅宽：75 分位，兼顾效率与可执行性
    widest: { name: usable[0].name, operator: usable[0].operator, swathKm: maxSwathKm },
    // 动中成像能力
    agileCount: agileSats.length,
    agileRatio: +agileRatio.toFixed(2),
    maxSkewDeg,
    skewNote: maxSkewDeg > 0
      ? `${agileSats.length}/${usable.length} 颗为敏捷平台，允许动中成像偏角 ≤${maxSkewDeg}°`
      : '可用星以传统推扫为主，条带必须平行于星下点轨迹（偏角 0°）',
    top: usable.slice(0, 5).map(u => ({
      name: u.name, operator: u.operator, swathKm: u.cap.swathKm, resM: u.cap.resolution,
      slewLimitDeg: u.cap.slewLimitDeg,
    })),
  };
}

/**
 * 主判定：给定区域 + 任务要求，回答「要不要拆、拆几条、依据是什么」
 *
 * @returns 统一的判定结果，供 scope-judge 接口、order-intake 建单、AI 汇报共用
 */
export function judgeArea({ coords, obsType, resolutionM, satRows, isPoint = false }) {
  const res = {
    requirement: { obsType: String(obsType ?? 'optical').toLowerCase(), resolutionM: Number(resolutionM) || 2 },
  };

  // ① 点目标：永远不拆
  if (isPoint) {
    return {
      ...res,
      region: null,
      scale: 'point',
      needSplit: false,
      stripCount: 0,
      swath: null,
      reason: '点目标只拍一处，无需拆条带',
      nextStep: '直接建 1 个任务',
    };
  }

  // ② 区域尺寸
  const region = regionSize(coords);
  res.region = region;

  // ③ 可用星幅宽
  const swath = deriveUsableSwath(satRows, res.requirement.obsType, res.requirement.resolutionM);
  res.swath = swath;

  if (!swath.usableCount) {
    return {
      ...res,
      scale: 'infeasible',
      needSplit: false,
      stripCount: 0,
      reason: swath.note,
      nextStep: '改用其他观测类型或放宽分辨率',
    };
  }

  const W = swath.swathKm;

  // ④ 按尺度分档
  // 注意：这里比较的是「区域长边」与「规划幅宽」，但条带是沿轨迹方向铺的，
  // 真正的条带数由 planAreaStrips 算（它考虑方位角、重叠率、单条带长度上限）
  let scale, needSplit, reason;
  if (region.maxEdgeKm <= W) {
    scale = 'small';
    needSplit = false;
    reason = `区域长边 ${region.maxEdgeKm}km ≤ 规划幅宽 ${W}km，单星单次可覆盖`;
  } else if (region.maxEdgeKm <= 2 * W) {
    scale = 'medium';
    needSplit = true;
    reason = `区域长边 ${region.maxEdgeKm}km 介于 1~2 倍规划幅宽 ${W}km，需横向拆带`;
  } else if (region.maxEdgeKm <= 8 * W) {
    scale = 'large';
    needSplit = true;
    reason = `区域长边 ${region.maxEdgeKm}km 达规划幅宽 ${W}km 的 ${(region.maxEdgeKm / W).toFixed(1)} 倍，需拆多条带`;
  } else {
    scale = 'national';
    needSplit = true;
    reason = `区域长边 ${region.maxEdgeKm}km 超规划幅宽 ${W}km 的 8 倍，属跨省/全国尺度，需多星多期协同`;
  }

  // ⑤ 若需拆，用条带规划器算准确条带数（与建单完全同一套）
  // national 尺度（跨省/全国）不算精确条带数——那是几千条，既无意义也会拖垮计算，
  // 改为按幅宽粗估量级并提示分批。
  let stripCount = 0, stripDetail = null, direction = null;
  if (needSplit && scale === 'national') {
    stripCount = Math.ceil(region.maxEdgeKm / W);
    stripDetail = { coarse: true, note: '跨省/全国尺度仅给量级估算，实际请按省或区域分批下单' };
  } else if (needSplit) {
    try {
      // 按文献方法做方向择优：在轨迹方位 ±maxSkewDeg 内选条带数最少的方向
      const proj = makeProjection(region.centerLat, (region.bbox.minLon + region.bbox.maxLon) / 2);
      const polyKm = coords.map(proj.fwd);
      const dirPick = chooseBestDirection(polyKm, W, region.centerLat, 97.9, {
        maxSkewDeg: swath.maxSkewDeg,
      });
      direction = {
        chosenDeg: dirPick.best.thetaDeg,
        trackAzDeg: dirPick.trackAzDeg,
        skewDeg: +(dirPick.best.thetaDeg - dirPick.trackAzDeg).toFixed(1),
        reason: dirPick.reason,
        candidates: dirPick.candidates.map(c => ({ thetaDeg: c.thetaDeg, count: c.count })),
      };
      const plan = planAreaStrips(coords, {
        swathKm: W,
        azimuthDeg: dirPick.best.thetaDeg,   // 用择优方向铺带，与判定一致
      });
      stripCount = plan.stats.stripCount;
      stripDetail = {
        swathKm: plan.stats.swathKm,
        stepKm: plan.stats.stepKm,
        overlapPct: plan.policy.overlapPct ?? null,
        azimuthDeg: plan.direction?.azimuthDeg ?? groundTrackAzimuth(region.centerLat),
        maxStripLenKm: plan.policy.maxStripLenKm,
        stripLens: plan.strips.map(s => +(s.lengthKm ?? 0).toFixed(1)).slice(0, 20),
      };
    } catch (e) {
      stripCount = Math.ceil(region.maxEdgeKm / W);
      stripDetail = { error: `条带规划失败，按长边/幅宽粗算: ${e.message}` };
    }
  }

  return {
    ...res,
    scale,
    needSplit,
    stripCount,
    stripDetail,
    direction,
    reason,
    nextStep: scale === 'national'
      ? `该区域需约 ${stripCount} 条带（量级估算），建议按省/区域分批下单，每批单独规划`
      : (needSplit
        ? `拆成 ${stripCount} 个独立任务（每任务一条带），逐条建单`
        : '建 1 个任务即可'),
    caveats: scale === 'national'
      ? ['跨省/全国尺度需要多星多期协同，单次任务链无法一次完成', '建议按省/区域分批下单']
      : [],
  };
}
