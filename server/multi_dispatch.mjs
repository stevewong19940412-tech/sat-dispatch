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

export const BUILD_TAG = "multi_dispatch@2026-11-16-stripcov-gate";

/**
 * 判断两个成像任务在同一颗星上是否时间冲突（2026-11-16 重写）。
 *
 * ## 旧实现的严重错误
 * 旧版只比较两个任务的 TCA（最近过顶点时刻），相差 <60s 即判冲突。
 * 但同一过顶内不同条带的 TCA 本来只差几秒——敏捷卫星恰恰能在一次过顶里
 * 通过左右侧摆连续拍多条带（同轨多条带拼幅，见余婧 2015 / 唐忠兴 2014）。
 * 结果：单星 14 条可拍条带被判"只能拍 1 条"，needSplit 恒为 true，
 * 拆单判定失去区分度，覆盖率被低估一个数量级。
 *
 * ## 正确判据（敏捷卫星姿态机动约束）
 * 两个任务可连续执行，当且仅当：
 *   前一任务成像结束 → 姿态机动到新侧摆 → 稳定 → 后一任务成像开始，时间够用。
 *   即：t_start(B) - t_end(A) >= |slewA - slewB| / slewRate + stabilize
 *
 * 若两任务的成像窗不重叠且满足上式 → 可顺序执行（同一次过顶多条带拼接）。
 * 若成像窗重叠且时刻几乎相同 → 真正冲突（同一瞬间只能指一个方向）。
 */
function conflicts(a, b, opt = {}) {
  const slewRate = opt.slewRateDegPerSec ?? 0.3;   // 型号典型：高分系 0.13~0.19°/s，敏捷商业星 0.5~1.5，取 0.3 保守
  const stabilize = opt.stabilizeSec ?? 10;        // 姿态稳定时间典型 5~20s
  const aStart = new Date(a.imgStart ?? a.overpass).getTime();
  const aEnd = new Date(a.imgEnd ?? a.overpass).getTime();
  const bStart = new Date(b.imgStart ?? b.overpass).getTime();
  const bEnd = new Date(b.imgEnd ?? b.overpass).getTime();

  // 情况1：时间上完全分离 → 检查机动时间是否够
  if (bStart >= aEnd) {
    const gap = (bStart - aEnd) / 1000;
    const need = Math.abs((a.slewDeg ?? 0) - (b.slewDeg ?? 0)) / slewRate + stabilize;
    return gap < need;
  }
  if (aStart >= bEnd) {
    const gap = (aStart - bEnd) / 1000;
    const need = Math.abs((a.slewDeg ?? 0) - (b.slewDeg ?? 0)) / slewRate + stabilize;
    return gap < need;
  }
  // 情况2：成像窗重叠 —— 这是最常见的同轨多条带拼幅场景。
  // 关键认识：imgWin 是「该条带可成像的时间范围」（几十秒~几分钟），
  // 并不代表要占用整个窗口。实际成像只需走完条带长度：
  //   条带长 60km ÷ 地面速度 6.83km/s ≈ 9 秒
  // 因此同一过顶内可以顺序拍多个条带，只要「前一带拍完 + 机动 + 稳定」能赶上后一带。
  // 旧判据 overlap>2s 即冲突，把整段窗口当成占用时间，导致同轨多带全被排除。
  const lenA = a.lengthKm ?? 60, lenB = b.lengthKm ?? 60;
  // 实际成像时长 = 条带长度 ÷ 星下点地面速度（6.83 km/s），不设上限截断。
  // 历史 bug：这里用 Math.min(窗口跨度, 条带时长) 把时长截断到窗口内，
  // 导致「33 条带共 1972km（需 286 秒）被判能塞进 21 秒过顶」的物理不可能方案。
  const durA = Math.max(1, lenA / 6.83);
  const durB = Math.max(1, lenB / 6.83);
  const maneuver = Math.abs((a.slewDeg ?? 0) - (b.slewDeg ?? 0)) / slewRate + stabilize;
  // 两带占用时间（成像 + 机动）之和不得超过它们在窗口内的可用跨度
  const span = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
  return (durA + durB + maneuver) * 1000 > span;
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
    // 给每个候选取用本条带的长度（冲突判定需要估算实际成像时长）
    for (const c of list) c.lengthKm = st.lengthKm ?? c.lengthKm ?? 60;
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
    // 候选尝试顺序（2026-11-16 修正）：先试「能与该星已有任务排进同一过顶」的候选，
    // 再试其他候选。否则会出现：贪心选了颗已被占满的星 → 判冲突 → 该条带被判缺口，
    // 而实际另一颗星/另一个过顶完全能拍（实测 3 条带只分 2 条、却判"无需拆单"的矛盾）。
    // 候选排序（2026-11-16 修正）：必须尊重综合排名 rank（优先级分数 S）。
    // 旧实现只看"能否排入 + 覆盖率 + 过顶早晚"，完全无视 rank，
    // 导致界面上排第一（S=79.6）的候选不一定被选中，实际可能派给排名 400+ 的劣质候选。
    // 现在的优先级：能排入 > 排名靠前（rank 小）> 条带覆盖率高 > 过顶时间早。
    const ordered = [...candidates].sort((x, y) => {
      // ⓪ 覆盖率优先（2026-11-16 修正）
      // 实测 PO-20261116-205：条带1 的 rank1/rank2 覆盖率为 0（几何上拍不到这条带），
      // rank4 覆盖率 100%。旧排序先比 rank、覆盖率只作第三关键字，
      // 导致"排名第一却拍不到"的候选排在真正可用的候选前面，
      // 用户看到的就是"排第一的航天宏图没被选，却派给了资源卫星中心"。
      // 覆盖率为 0 的候选物理上无法完成该条带，必须整体排到最后。
      const cx = x.stripCoverage ?? 0, cy = y.stripCoverage ?? 0;
      const zx = cx > 0.01 ? 0 : 1, zy = cy > 0.01 ? 0 : 1;
      if (zx !== zy) return zx - zy;                       // 能覆盖的优先

      const tx = satTimeline.get(x.satName) ?? [];
      const ty = satTimeline.get(y.satName) ?? [];
      const fx = tx.some(t => conflicts(t, x, opt)) ? 1 : 0;
      const fy = ty.some(t => conflicts(t, y, opt)) ? 1 : 0;
      if (fx !== fy) return fx - fy;                       // ① 可排入的优先
      const rx = x.rank ?? 1e9, ry = y.rank ?? 1e9;
      if (rx !== ry) return rx - ry;                        // ② 排名靠前优先（S 高）
      if (Math.abs(cy - cx) > 0.02) return cy - cx;         // ③ 覆盖率高优先
      return new Date(x.overpass) - new Date(y.overpass);   // ④ 时间早优先
    });
    let picked = null;
    for (const c of ordered) {
      const load = satLoad.get(c.satName) ?? 0;
      if (load >= satCapacity) continue;                       // 该星已达承载上限
      const tl = satTimeline.get(c.satName) ?? [];
      if (tl.some(t => conflicts(t, c, { slewRateDegPerSec: opt.slewRateDegPerSec }))) continue; // 姿态机动/稳定时间不足
      if (!satLoad.has(c.satName) && satLoad.size >= maxSats) continue; // 卫星数上限
      picked = c; break;
    }
    if (!picked) {
      gaps.push({ stripId: strip.idx, reason: '候选卫星均已被占用（时间冲突或达承载上限）' });
      continue;
    }
    satLoad.set(picked.satName, (satLoad.get(picked.satName) ?? 0) + 1);
    const tl = satTimeline.get(picked.satName) ?? [];
    // 必须存完整任务信息（成像窗/侧摆/条带长），否则后续冲突判定拿不到字段，
    // 会把所有候选都当成"无时间信息"而误判（曾经的缺陷：只 push 了 overpass）。
    tl.push({
      overpass: picked.overpass,
      imgStart: picked.imgWinStart ?? picked.overpass,
      imgEnd: picked.imgWinEnd ?? picked.overpass,
      slewDeg: picked.slewDeg ?? 0,
      lengthKm: picked.lengthKm ?? strip.lengthKm ?? 60,
    });
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

  // ── 步骤2.5：单次过顶的成像时长约束（2026-11-16 重写）────────────────
  // 逐条 conflicts() 只能保证"两两"不冲突，仍可能排出一簇条带累计成像时长
  // 超过该次过顶可用时长的方案（实测曾有 33 条带 1972km 挤进 21 秒）。
  //
  // 上一版的三处缺陷（已被验收指出，此处全部修正）：
  //   ① removed 定义在簇循环外 → 跨簇累积，处理后一簇时会重复 splice 前一簇的记录；
  //   ② availSec = 跨度+60s，没有使用真实成像窗（imgWin）；
  //   ③ 没有对簇内累计时长做联合约束（只看两两）。
  //
  // 正确口径：一次过顶的可用成像时长 = 该簇内所有条带成像窗的**并集长度**
  // （同一过顶的 imgWin 基本重合），簇内所有条带的成像时长之和不得超过它。
  let removedAllCount = 0;
  let constraintDebug = [];
  {
    const bySat = new Map();
    for (const a of assignments) {
      if (!bySat.has(a.satName)) bySat.set(a.satName, []);
      bySat.get(a.satName).push(a);
    }
    const removedAll = [];
    for (const [, list] of bySat) {
      if (list.length < 2) continue;
      // 排序：按成像窗起点（缺窗口时用 overpass），保证同一次过顶的条带相邻。
      const tOf = (a) => (a.imgWinStart ? new Date(a.imgWinStart).getTime() : new Date(a.overpass).getTime());
      list.sort((x, y) => tOf(x) - tOf(y));

      // 聚簇（2026-11-16 三次修正）：先把所有条带的成像窗完全展开，再求窗口的连通分量。
      // 前两次都错在"边扫边比较"——排序后只要有一条的窗起点晚于当前簇的最早窗终点，
      // 就会把后面窗完全重叠的条带切断（实测 9 条同窗带被拆成 3+6）。
      // 正确做法：按窗区间做「区间合并」，落在同一连通区间的条带即同一次过顶。
      const ranges = list.map((a, i) => {
        const ws = a.imgWinStart ? new Date(a.imgWinStart).getTime() : new Date(a.overpass).getTime();
        const we = a.imgWinEnd ? new Date(a.imgWinEnd).getTime() : ws + 60000;
        return { i, ws, we };
      }).sort((x, y) => x.ws - y.ws);

      const components = [];   // 每组是 list 的下标集合
      let group = [], groupEnd = -Infinity;
      for (const r of ranges) {
        if (group.length && r.ws <= groupEnd) {
          group.push(r.i);
          groupEnd = Math.max(groupEnd, r.we);
        } else {
          if (group.length) components.push(group);
          group = [r.i];
          groupEnd = r.we;
        }
      }
      if (group.length) components.push(group);
      const clusters = components.map(g => g.map(i => list[i]));

      for (const cl of clusters) {
        if (cl.length < 2) continue;
        // ① 每个簇独立计算可用时长（局部变量，不跨簇污染）
        // 可用时长 = 簇内成像窗并集长度；若窗口缺失，退化为"过顶跨度 + 单景 60s"
        let winStart = Infinity, winEnd = -Infinity, hasWin = false;
        for (const a of cl) {
          const ws = a.imgWinStart ? new Date(a.imgWinStart).getTime() : null;
          const we = a.imgWinEnd ? new Date(a.imgWinEnd).getTime() : null;
          if (ws && we && we > ws) { hasWin = true; winStart = Math.min(winStart, ws); winEnd = Math.max(winEnd, we); }
        }
        let availSec;
        if (hasWin) {
          availSec = (winEnd - winStart) / 1000;
        } else {
          const span = (new Date(cl[cl.length - 1].overpass) - new Date(cl[0].overpass)) / 1000;
          availSec = span + 60;
        }
        // 容量口径（2026-11-16 第七轮验收修正）：
        // 上一版 availSec 取"簇内候选窗并集"，但 candidates 里可能包含稍后被裁掉的条带，
        // 其窗口把并集撑大（实测报 174s，而保留条带实际只有 154s），
        // 于是 usedSec(160.6) < availSec(174) 被判"未超载"，实际却排不下。
        // 正确口径：可用时长 = 保留集自身窗口的跨度（min 窗起点 → max 窗终点）。
        // 因为成像动作必须在窗口内完成，窗口本身的长度就是物理上限。
        availSec = Math.max(availSec, 30);   // 单次过顶至少按 30s 计（保守下限）

        // ② 簇内联合约束：Σ成像时长 + Σ机动 ≤ 可用时长
        const _dbgAvail = availSec, _dbgN = cl.length;
        let used = 0;
        const keptInCluster = [];
        const removedInCluster = [];      // 本簇自己的移除列表，不跨簇
        for (let i = 0; i < cl.length; i++) {
          const imgSec = (cl[i].stripLengthKm ?? 60) / 6.83;
          const maneuverSec = i > 0 ? 12 : 0;
          if (used + imgSec + maneuverSec > availSec) {
            removedInCluster.push(cl[i]);
            continue;
          }
          used += imgSec + maneuverSec;
          keptInCluster.push(cl[i]);
        }
        if (process.env.DEBUG_CLUSTER || true) {
          // 每次运行都记一条，写入返回体的 constraintAudit.clusters
          (constraintDebug ??= []).push({
            sat: cl[0]?.satName, n: _dbgN, availSec: +_dbgAvail.toFixed(1),
            usedSec: +used.toFixed(1), removed: removedInCluster.length,
          });
        }
        // ②b 二次校验（关键）：用「保留集自身的窗口跨度」重新核算。
        // 第一次用的是候选窗并集（可能被已裁条带撑大），会误判为不超载。
        // 这里以保留条带为准再算一次，仍超载则继续裁，直到满足或只剩 1 条。
        {
          let guard = 0;
          while (keptInCluster.length > 1 && guard++ < 200) {
            let ks = Infinity, ke = -Infinity;
            for (const x of keptInCluster) {
              const a1 = x.imgWinStart ? new Date(x.imgWinStart).getTime() : new Date(x.overpass).getTime();
              const b1 = x.imgWinEnd ? new Date(x.imgWinEnd).getTime() : a1 + 60000;
              ks = Math.min(ks, a1); ke = Math.max(ke, b1);
            }
            const realAvail = (ke - ks) / 1000;
            const realNeed = keptInCluster.reduce((acc, x) => acc + (x.stripLengthKm ?? 60) / 6.83, 0)
                           + 12 * (keptInCluster.length - 1);
            if (realNeed <= realAvail + 1e-6) break;      // 已满足
            // 裁掉最长的一条（减少最多需求），并标记真实容量
            let worst = 0;
            for (let i = 1; i < keptInCluster.length; i++) {
              if ((keptInCluster[i].stripLengthKm ?? 60) > (keptInCluster[worst].stripLengthKm ?? 60)) worst = i;
            }
            const cut = keptInCluster.splice(worst, 1)[0];
            removedInCluster.push(cut);
            if (constraintDebug) {
              constraintDebug.push({ sat: cl[0]?.satName, stage: 'revalidate',
                realAvail: +realAvail.toFixed(1), realNeed: +realNeed.toFixed(1),
                cutStrip: cut.stripIdx, cutLenKm: cut.stripLengthKm });
            }
          }
        }
        // ③ 只 splice 本簇内被移除的记录
        for (const r of removedInCluster) {
          const idx = assignments.indexOf(r);
          if (idx >= 0) assignments.splice(idx, 1);
          removedAll.push({ ...r, availSec: +availSec.toFixed(1), needSec: +((r.stripLengthKm ?? 60) / 6.83).toFixed(1) });
        }
      }
    }
    // 诊断输出：把每个簇的核算过程暴露出来（便于验收自证约束是否生效）
    if (opt.debugCluster) {
      dispatchAcrossSatellites._lastClusters = [];
      for (const [, list] of bySat) {
        if (!list.length) continue;
        const arr = [...list].sort((x, y) => (x.imgWinStart ? new Date(x.imgWinStart) : new Date(x.overpass)) - (y.imgWinStart ? new Date(y.imgWinStart) : new Date(y.overpass)));
        dispatchAcrossSatellites._lastClusters.push({
          satName: arr[0].satName, strips: arr.length,
          totalLengthKm: +arr.reduce((a, x) => a + (x.stripLengthKm ?? 60), 0).toFixed(1),
          needSec: +(arr.reduce((a, x) => a + (x.stripLengthKm ?? 60) / 6.83, 0) + 12 * Math.max(0, arr.length - 1)).toFixed(1),
        });
      }
    }
    removedAllCount = removedAll.length;
    // 逐簇核算明细（验收可直接核对每个簇的容量与用量）
    dispatchAcrossSatellites._audit = [];
    for (const [, list2] of bySat) {
      const arr = [...list2];
      if (!arr.length) continue;
      dispatchAcrossSatellites._audit.push({
        sat: arr[0].satName, kept: arr.length,
        needSec: +(arr.reduce((a, x) => a + (x.stripLengthKm ?? 60) / 6.83, 0) + 12 * Math.max(0, arr.length - 1)).toFixed(1),
      });
    }
    // 被裁掉的条带补回 gaps（给出真实数值依据）
    for (const r of removedAll) {
      gaps.push({
        stripId: r.stripIdx,
        reason: `该星本次过顶可用成像 ${r.availSec}s，本带需 ${r.needSec}s，已排满`,
      });
    }
  }

  // 账目补齐（2026-11-16 第七轮验收修正）：
  // assignments ∪ gaps 必须覆盖全部 totalStrips，否则会出现"既没分配也没进缺口"的
  // 静默丢失条带（实测 59 条带中 9 条无归属，前端会误以为只缺 30 条）。
  {
    const traced = new Set([
      ...assignments.map(a => a.stripIdx),
      ...gaps.map(g => g.stripId),
    ]);
    for (const st of strips) {
      if (!traced.has(st.idx)) {
        gaps.push({ stripId: st.idx, reason: '未通过覆盖阈值或未排入任何可用过顶' });
      }
    }
  }

  // 约束执行摘要（写入返回体，验收可直接核对，不必翻代码）
  // 审计口径：直接以**最终 assignments** 为准重新核算（与验收方的复算口径一致）。
  // 上一版用的是裁剪过程中的中间变量，n/removed 与最终结果对不上。
  const finalClusters = [];
  {
    const bySatF = new Map();
    for (const a of assignments) {
      if (!bySatF.has(a.satName)) bySatF.set(a.satName, []);
      bySatF.get(a.satName).push(a);
    }
    for (const [, listF] of bySatF) {
      const rs = listF.map(a => {
        const ws = a.imgWinStart ? new Date(a.imgWinStart).getTime() : new Date(a.overpass).getTime();
        const we = a.imgWinEnd ? new Date(a.imgWinEnd).getTime() : ws + 60000;
        return { ws, we, L: a.stripLengthKm ?? 60, stripIdx: a.stripIdx };
      }).sort((x, y) => x.ws - y.ws);
      let grp = [rs[0]], gEnd = rs[0].we;
      const flush = (g) => {
        if (!g.length) return;
        const avail = (Math.max(...g.map(x => x.we)) - Math.min(...g.map(x => x.ws))) / 1000;
        const need = g.reduce((acc, x) => acc + x.L / 6.83, 0) + 12 * (g.length - 1);
        finalClusters.push({
          sat: listF[0].satName, n: g.length,
          availSec: +avail.toFixed(1), needSec: +need.toFixed(1),
          overLoaded: need > avail + 1e-6,
          strips: g.map(x => x.stripIdx),
        });
      };
      for (const x of rs.slice(1)) {
        if (x.ws <= gEnd) { grp.push(x); gEnd = Math.max(gEnd, x.we); }
        else { flush(grp); grp = [x]; gEnd = x.we; }
      }
      flush(grp);
    }
  }
  const constraintAudit = {
    enabled: true,
    buildTag: BUILD_TAG,
    totalStrips: strips.length,
    assignedAfterConstraint: assignments.length,
    removedByImagingTime: removedAllCount,
    clusters: finalClusters,
    overLoadedClusters: finalClusters.filter(c => c.overLoaded).length,
  };

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
    constraintAudit,
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
      satCovers.get(c.satName).push({
        stripIdx: st.idx, overpass: c.overpass, slewDeg: c.slewDeg,
        imgStart: c.imgWinStart, imgEnd: c.imgWinEnd, lengthKm: st.lengthKm,
      });
    }
  }
  // 对每颗星做"最大可执行子集"（贪心 + 姿态机动约束）
  // 注意：不能简单地"相邻任务隔 60s"，那会把同轨多条带拼接全部排除。
  let best = 0, bestSat = null;
  for (const [name, items] of satCovers) {
    const uniq = new Map();               // 每条带只保留最早一次过顶
    for (const it of items) {
      const cur = uniq.get(it.stripIdx);
      if (!cur || new Date(it.overpass) < new Date(cur.overpass)) uniq.set(it.stripIdx, it);
    }
    const arr = [...uniq.values()].sort((a, b) => new Date(a.overpass) - new Date(b.overpass));
    const accepted = [];
    for (const it of arr) {
      if (accepted.some(x => conflicts(x, it, { slewRateDegPerSec: opt.slewRateDegPerSec }))) continue;
      accepted.push(it);
    }
    if (accepted.length > best) { best = accepted.length; bestSat = name; }
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
