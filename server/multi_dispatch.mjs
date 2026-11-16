// ─── 多星协同分派（区域目标 → 多条带 → 多颗卫星）────────────────────────────
// 2026-11-16 新增。这是"任务规划"的核心能力：不再假设一颗星干完整个区域，
// 而是把区域拆成条带后，按覆盖收益/资源成本分派给多颗卫星，并明确报告覆盖率。
//
// ## 文献依据
// 1. **集合覆盖模型（Set Covering）** —— Perea & Vazquez 2015 (IEEE TAES)
//    "Swath-acquisition planning in multiple-satellite missions"：
//    给定卫星集合与任务时段，从各星候选成像取景中选择一组，覆盖目标区域，
//    明确建模为 set covering problem，并用贪心随机自适应搜索（GRASP）求解。
// 2. **贪心 + 资源最少** —— CN115659556A（国防科大）：
//    以「最大化条带覆盖面积 + 最小化卫星资源使用」为目标，深度自适应大邻域搜索。
//    实用结论：贪心挑选"单位资源覆盖增益最高"的条带分配，能在秒级给出高质量解。
// 3. **多目标建模** —— Chen 2020 (Remote Sensing 12(3):344)：
//    大区域制图的两目标 = 最大区域覆盖率 + 最小卫星资源占用。
// 4. **前向-后向启发式** —— Kandepi 2024 (Acta Astronautica)：
//    大规模区域成像用 forward/backward heuristic search，贪心保证调度性能。
// 5. **网格分派（Mesh Dispatching）** —— ONERA/Airbus 2025：
//    把大区域切成网格分给不同系统，并支持 "re-dispatch" 按进度重新优化。
// 6. **条带集合覆盖 + 六边形网格** —— IFAC 2026 PGE：
//    把条带选择建模为六边形网格上的约束集合覆盖，给出贪心近似比上界。
//
// ## 本实现的分派算法（贪心集合覆盖 + 资源约束）
// 目标：最大化区域覆盖率，同时尽量少用卫星，并在时限内返回。
//   步骤1：每个条带已有若干候选（卫星+过顶时刻+侧摆+实测覆盖率）
//   步骤2：按「覆盖率 × 时间优先度 / 资源冲突」排序，贪心选取
//   步骤3：同一颗星在同一过顶时刻只能执行一个条带（时间冲突检测）
//   步骤4：产出分派方案 + 覆盖率 + 未分配条带及原因

import { coverageGrade } from './coverage_grid.mjs';

/**
 * 判断两个条带任务在同一颗星上是否时间冲突。
 * 同星相邻任务必须留出姿态机动 + 稳定 + 预热时间。
 */
function conflicts(a, b, minGapSec = 60) {
  const ta = new Date(a.overpass).getTime();
  const tb = new Date(b.overpass).getTime();
  return Math.abs(ta - tb) < minGapSec * 1000;
}

/**
 * 多星协同分派主函数。
 *
 * @param {Array} strips  条带列表（来自 strip_planner，含 idx/widthKm/lengthKm/start/end）
 * @param {Map<number, Array>} candByStrip  每个条带的候选列表
 *        候选字段：{satName, satNoradId, company, overpass, slewDeg, stripCoverage, imgWinStart, ...}
 * @param {object} opt
 *        minCoverage     计入"有效覆盖"的最低单带覆盖率（默认 0.85）
 *        allowPartial    是否允许用部分覆盖补位（默认 false）
 *        maxSatsPerTask  单任务最多动用卫星数（默认不限）
 *        satCapacity     每颗星最多承担的条带数（默认不限，可模拟固存/能源约束）
 * @returns {{assignments, satellites, coverage, gaps, stats}}
 */
export function dispatchAcrossSatellites(strips, candByStrip, opt = {}) {
  const minCoverage = opt.minCoverage ?? 0.85;
  const allowPartial = opt.allowPartial ?? false;
  const maxSats = opt.maxSatsPerTask ?? Infinity;
  const satCapacity = opt.satCapacity ?? Infinity;

  // ── 步骤1：为每个条带挑选"可用候选"并按质量排序 ──
  const pool = [];
  for (const st of strips) {
    const list = (candByStrip.get(st.idx) ?? [])
      .filter(c => c && c.stripCoverage != null)
      .filter(c => c.stripCoverage >= (allowPartial ? 0.5 : minCoverage))
      .sort((a, b) => {
        // 覆盖率优先，其次侧摆小（分辨率好），最后时间早
        if (Math.abs(b.stripCoverage - a.stripCoverage) > 0.02) return b.stripCoverage - a.stripCoverage;
        if (Math.abs(a.slewDeg - b.slewDeg) > 2) return a.slewDeg - b.slewDeg;
        return new Date(a.overpass) - new Date(b.overpass);
      });
    pool.push({ strip: st, candidates: list });
  }

  // ── 步骤2：贪心集合覆盖 ──
  // 排序策略（文献常见的 GRASP 贪心变体）：
  //   候选数少的条带优先（"最受限优先"），避免被别的条带抢走资源后无解。
  pool.sort((a, b) => a.candidates.length - b.candidates.length);

  const assignments = [];
  const gaps = [];
  const satLoad = new Map();       // satName -> 已派条带数
  const satTimeline = new Map();   // satName -> [{overpass}]

  for (const { strip, candidates } of pool) {
    if (!candidates.length) {
      gaps.push({ stripId: strip.idx, reason: allowPartial ? '无任何可用过顶' : `无覆盖率≥${(minCoverage*100).toFixed(0)}%的候选` });
      continue;
    }
    let picked = null;
    for (const c of candidates) {
      const load = satLoad.get(c.satName) ?? 0;
      if (load >= satCapacity) continue;                       // 该星已达承载上限
      const tl = satTimeline.get(c.satName) ?? [];
      if (tl.some(t => conflicts(t, c))) continue;             // 与同星已有任务时间冲突
      if (!satLoad.has(c.satName) && satLoad.size >= maxSats) continue; // 卫星数上限
      picked = c; break;
    }
    if (!picked) {
      gaps.push({ stripId: strip.idx, reason: '候选卫星均已被占用（时间冲突或达承载上限）' });
      continue;
    }
    satLoad.set(picked.satName, (satLoad.get(picked.satName) ?? 0) + 1);
    const tl = satTimeline.get(picked.satName) ?? [];
    tl.push({ overpass: picked.overpass });
    satTimeline.set(picked.satName, tl);
    assignments.push({
      stripIdx: strip.idx,
      stripWidthKm: strip.widthKm,
      stripLengthKm: strip.lengthKm,
      satName: picked.satName,
      satNoradId: picked.satNoradId,
      company: picked.company,
      overpass: picked.overpass,
      slewDeg: picked.slewDeg,
      coverage: picked.stripCoverage,
      grade: coverageGrade(picked.stripCoverage),
      imgWinStart: picked.imgWinStart,
      imgWinEnd: picked.imgWinEnd,
    });
  }

  // ── 步骤3：汇总 ──
  const total = strips.length;
  const covered = assignments.length;
  const sats = [...new Set(assignments.map(a => a.satName))];
  const bySat = {};
  for (const a of assignments) {
    bySat[a.satName] = bySat[a.satName] ?? { company: a.company, strips: 0, totalCoverage: 0, firstOverpass: null, lastOverpass: null };
    const e = bySat[a.satName];
    e.strips++;
    e.totalCoverage += a.coverage;
    const t = new Date(a.overpass).getTime();
    if (!e.firstOverpass || t < new Date(e.firstOverpass).getTime()) e.firstOverpass = a.overpass;
    if (!e.lastOverpass || t > new Date(e.lastOverpass).getTime()) e.lastOverpass = a.overpass;
  }
  const times = assignments.map(a => new Date(a.overpass).getTime());
  const spanDays = times.length ? (Math.max(...times) - Math.min(...times)) / 86400000 : 0;

  return {
    assignments,
    satellites: Object.entries(bySat).map(([name, v]) => ({
      satName: name, company: v.company, strips: v.strips,
      avgCoverage: +(v.totalCoverage / v.strips).toFixed(3),
      firstOverpass: v.firstOverpass, lastOverpass: v.lastOverpass,
    })).sort((a, b) => b.strips - a.strips),
    coverage: {
      totalStrips: total,
      assignedStrips: covered,
      coveragePct: total ? +((covered / total) * 100).toFixed(1) : 0,
      avgStripCoverage: covered ? +(assignments.reduce((s, a) => s + a.coverage, 0) / covered).toFixed(3) : 0,
      areaCoveredKm2: +assignments.reduce((s, a) => s + a.stripWidthKm * a.stripLengthKm * a.coverage, 0).toFixed(1),
    },
    gaps,
    stats: {
      satelliteCount: sats.length,
      spanDays: +spanDays.toFixed(1),
      minCoverage: minCoverage,
      allowPartial,
    },
  };
}

/**
 * 是否建议拆单（多星/多订单）。
 * 依据：单星单过顶无法覆盖全部条带时，必须拆分为多颗星并行。
 */
export function shouldSplitOrder(strips, candByStrip, opt = {}) {
  const minCoverage = opt.minCoverage ?? 0.85;
  // 单星"实际能覆盖"多少条带 —— 必须考虑时间冲突：
  // 同一次过顶只能拍一条带，不同条带的过顶时刻若太近则冲突。
  // 旧实现只数"这颗星有多少条带的候选"，忽略了冲突，会高估单星能力
  // （实测出现：判定"无需拆单"，实际只分了 2/3 条带）。
  const satCovers = new Map();
  for (const st of strips) {
    const list = (candByStrip.get(st.idx) ?? []).filter(c => (c.stripCoverage ?? 0) >= minCoverage);
    for (const c of list) {
      if (!satCovers.has(c.satName)) satCovers.set(c.satName, []);
      satCovers.get(c.satName).push({ stripIdx: st.idx, overpass: c.overpass });
    }
  }
  // 对每颗星按时间排序后做"最大不冲突子集"（贪心选最早结束且不冲突的）
  let best = 0, bestSat = null;
  for (const [name, items] of satCovers) {
    const uniq = new Map();               // 每条带只保留最早一次过顶
    for (const it of items) {
      const cur = uniq.get(it.stripIdx);
      if (!cur || new Date(it.overpass) < new Date(cur.overpass)) uniq.set(it.stripIdx, it);
    }
    const arr = [...uniq.values()].sort((a, b) => new Date(a.overpass) - new Date(b.overpass));
    let count = 0, last = -Infinity;
    for (const it of arr) {
      const t = new Date(it.overpass).getTime();
      if (t - last >= 60000) { count++; last = t; }   // 相邻任务至少隔 60s
    }
    if (count > best) { best = count; bestSat = name; }
  }
  return {
    needSplit: best < strips.length,
    bestSingleSat: bestSat,
    bestSingleCovered: best,
    totalStrips: strips.length,
    candidateSatellites: satCovers.size,
    reason: best < strips.length
      ? `单星最多覆盖 ${best}/${strips.length} 条带（${bestSat ?? '无'}），需拆分为多星协同`
      : `单星 ${bestSat} 即可覆盖全部 ${strips.length} 条带，无需拆分`,
  };
}
