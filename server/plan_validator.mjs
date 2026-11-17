// 工程侧校验 —— 规划完成后由系统（而非 AI）执行的硬性检查
//
// 设计目的（2026-11-17 用户要求）：
//   AI 完成规划后，工程侧要独立校验一遍；不通过就把问题清单发回 solution 侧重新规划，
//   而不是等人工在工作台发现「这个任务派不了 / 拍不到 / 编号对不上」。
//
// 触发时机（用户已确认）：
//   ① 候选算完（candidates 返回前）—— 规划质量不达标就别往下走
//   ② 派单前（dispatch 执行前）—— 防止排队期间状态变化（候选过期、卫星衰减等）
//
// 判定分级：
//   FAIL —— 硬阻断，任务不可用，必须重规划
//   WARN —— 可继续，但须提示（人工决策时参考）
//   PASS —— 通过
//
// 校验项（每项都对应真实踩过的坑）：
//   C1 条带编号自洽    —— 候选 stripIdx 必须落在 1..stripCount（曾出现 stripIdx=11 而只有 10 条带）
//   C2 覆盖完整性      —— 每个条带至少有一个可用候选（否则该带永远拍不到）
//   C3 候选覆盖率门槛  —— 通过的候选 stripCoverage 必须 ≥ 门槛（曾出现覆盖率 0 排 rank1）
//   C4 观测类型匹配    —— 候选卫星载荷类型必须与任务一致（曾出现 SAR 任务派给光学星）
//   C5 规划方案可执行  —— multiPlan 分配的星必须在候选里真实存在
//   C6 一任务一条带    —— 单任务不应有多个条带（拆条带应在建单时完成）
//   C7 时间窗合法      —— 过顶时刻必须落在任务时间窗内
//   C8 无超载簇        —— 同星同窗内条带总成像时长不得超过可用窗（constraintAudit）

const OVERLAP_TOL = 1e-6;

/**
 * 工程侧校验
 * @param {object} ctx
 *   ctx.task         任务记录（geom/geomType/obsType/resolution/windowStart/windowEnd）
 *   ctx.strips       条带总数（number）或条带数组
 *   ctx.candidates   候选行数组（含 stripIdx/stripCoverage/satName/filtered/overpassTime）
 *   ctx.satRows      卫星记录数组（含 name/subCategory）
 *   ctx.multiPlan    分派方案数组（[{stripIdx,satName,...}]）
 *   ctx.constraintAudit 成像时长约束审计结果（可选）
 *   ctx.stage        'candidates' | 'dispatch'（用于措辞）
 * @returns {status, checks[], problems[], suggestions[], canProceed}
 */
export function validatePlan(ctx) {
  const {
    task = {}, strips = [], candidates = [], satRows = [],
    multiPlan = null, constraintAudit = null, stage = 'candidates',
  } = ctx;

  const stripCount = Array.isArray(strips) ? strips.length : (Number(strips) || 0);
  const checks = [];
  const add = (id, name, status, detail, problems = [], suggestions = []) =>
    checks.push({ id, name, status, detail, problems, suggestions });

  // 只统计"通过筛选"的候选（filtered=0）
  const passing = candidates.filter(c => (c.filtered ?? 0) === 0);

  // ── C1 条带编号自洽 ────────────────────────────────────────────────
  {
    if (stripCount <= 0) {
      add('C1', '条带编号自洽', 'WARN', '条带数为 0（点目标或不适用）');
    } else {
      const bad = [...new Set(candidates.map(c => c.stripIdx).filter(i => i != null && (i < 1 || i > stripCount)))];
      if (bad.length) {
        add('C1', '条带编号自洽', 'FAIL',
          `候选条带号 ${bad.slice(0, 8).join(',')} 超出 1..${stripCount}`,
          bad.slice(0, 20).map(i => `条带号 ${i} 不存在（本任务只有 ${stripCount} 条带）`),
          ['候选计算与条带规划的幅宽口径不一致，请用 dispatch scope 重新确认幅宽后重算候选']);
      } else {
        add('C1', '条带编号自洽', 'PASS', `所有候选条带号落在 1..${stripCount}`);
      }
    }
  }

  // ── C2 覆盖完整性：每条带都要有可用候选 ────────────────────────────
  {
    if (stripCount > 0) {
      const covered = new Set(passing.map(c => c.stripIdx));
      const missing = [];
      for (let i = 1; i <= stripCount; i++) if (!covered.has(i)) missing.push(i);
      if (missing.length === stripCount) {
        add('C2', '覆盖完整性', 'FAIL',
          `全部 ${stripCount} 条带均无可用候选`,
          [`${stripCount} 条带全部无可用过顶，该任务在当前参数下无法完成`],
          ['扩大时间窗', '放宽云量上限', '降低分辨率要求', '改用 SAR 或更宽幅星座']);
      } else if (missing.length) {
        add('C2', '覆盖完整性', 'FAIL',
          `${stripCount} 条带中 ${missing.length} 条无可用候选（缺 ${missing.slice(0, 10).join(',')}${missing.length > 10 ? '…' : ''}）`,
          missing.slice(0, 20).map(i => `条带 ${i} 无任何可用候选，拍摄后存在覆盖缺口`),
          ['扩大时间窗以覆盖更多过顶', '放宽云量上限', '如可接受缺口，拆分任务只对已有候选的条带下单']);
      } else {
        add('C2', '覆盖完整性', 'PASS', `${stripCount}/${stripCount} 条带均有可用候选`);
      }
    }
  }

  // ── C3 候选覆盖率门槛 ──────────────────────────────────────────────
  {
    const minCov = task.minStripCoverage != null ? Number(task.minStripCoverage) : 0.5;
    const zero = passing.filter(c => c.stripCoverage != null && c.stripCoverage < 0.01);
    const low = passing.filter(c => c.stripCoverage != null && c.stripCoverage >= 0.01 && c.stripCoverage < minCov);
    if (zero.length) {
      add('C3', '候选覆盖率门槛', 'FAIL',
        `${zero.length} 条通过候选的条带覆盖率为 0（几何上拍不到）`,
        zero.slice(0, 10).map(c => `条带${c.stripIdx} ${c.satName ?? ''}：覆盖 0%，本次过顶拍不到该带`),
        ['覆盖率门槛未生效，重算候选；或在派单时排除这些候选']);
    } else if (low.length) {
      add('C3', '候选覆盖率门槛', 'WARN',
        `${low.length} 条通过候选覆盖率低于 ${(minCov * 100).toFixed(0)}%`,
        low.slice(0, 10).map(c => `条带${c.stripIdx} ${c.satName ?? ''}：仅覆盖 ${(c.stripCoverage * 100).toFixed(0)}%`),
        ['这些候选可拍但条带覆盖不全，拼接时可能留缝']);
    } else {
      add('C3', '候选覆盖率门槛', 'PASS', `通过候选覆盖率均 ≥ ${(minCov * 100).toFixed(0)}%`);
    }
  }

  // ── C4 观测类型匹配 ────────────────────────────────────────────────
  {
    const wantSar = String(task.obsType ?? '').toLowerCase() === 'sar';
    if (wantSar || task.obsType) {
      const subOf = new Map(satRows.map(s => [s.name, String(s.subCategory ?? '').toLowerCase()]));
      const mismatch = passing.filter(c => {
        const sub = subOf.get(c.satName);
        if (!sub) return false;                    // 卫星库查不到就不判（另有人管）
        return wantSar ? sub !== 'sar' : !['optical', 'staring', 'hyperspectral'].includes(sub);
      });
      if (mismatch.length) {
        const seen = [...new Set(mismatch.map(c => `${c.satName}(${subOf.get(c.satName)})`))].slice(0, 6);
        add('C4', '观测类型匹配', 'FAIL',
          `${mismatch.length} 条候选卫星载荷类型与任务不符`,
          mismatch.slice(0, 10).map(c => `条带${c.stripIdx} ${c.satName}：类型 ${subOf.get(c.satName)}，任务要求 ${task.obsType}`),
          ['候选计算未按观测类型过滤，重算候选', '检查卫星库 subCategory 标注']);
      } else {
        add('C4', '观测类型匹配', 'PASS', `全部通过候选均为 ${wantSar ? 'SAR' : '光学'} 卫星`);
      }
    }
  }

  // ── C5 规划方案可执行：multiPlan 的星必须在候选里真实存在 ───────────
  {
    if (Array.isArray(multiPlan) && multiPlan.length) {
      const passKey = new Set(passing.map(c => `${c.stripIdx}|${c.satName}`));
      const bad = multiPlan.filter(a => !passKey.has(`${a.stripIdx}|${a.satName}`));
      if (bad.length) {
        add('C5', '规划方案可执行', 'FAIL',
          `分派方案中 ${bad.length} 条分配找不到对应候选`,
          bad.slice(0, 10).map(a => `条带${a.stripIdx} → ${a.satName}：候选表中不存在该组合`),
          ['分派方案与候选不一致，请重算候选或重新分派']);
      } else {
        add('C5', '规划方案可执行', 'PASS', `分派方案 ${multiPlan.length} 条分配均有候选支撑`);
      }
    }
  }

  // ── C6 一任务一条带 ────────────────────────────────────────────────
  {
    if (stripCount > 1 && stage === 'dispatch') {
      const idxs = new Set(passing.map(c => c.stripIdx));
      if (idxs.size > 1) {
        add('C6', '一任务一条带', 'WARN',
          `本任务含 ${stripCount} 条带，派单将只取排名最优的 1 条`,
          [`多带任务派单只会覆盖 1 条带，其余 ${stripCount - 1} 带无订单`],
          ['如需逐带下单，请在建单时拆成多个独立任务（order-intake 会自动拆）']);
      } else {
        add('C6', '一任务一条带', 'PASS', '单条带任务，派单口径清晰');
      }
    }
  }

  // ── C7 时间窗合法 ──────────────────────────────────────────────────
  {
    const ws = task.windowStart ? new Date(task.windowStart).getTime() : null;
    const we = task.windowEnd ? new Date(task.windowEnd).getTime() : null;
    if (ws && we) {
      const out = passing.filter(c => {
        if (!c.overpassTime) return false;
        const t = new Date(c.overpassTime).getTime();
        return !(t >= ws && t <= we);
      });
      if (out.length) {
        add('C7', '时间窗合法', 'FAIL',
          `${out.length} 条候选的过顶时刻落在任务时间窗外`,
          out.slice(0, 8).map(c => `条带${c.stripIdx} ${c.satName}：过顶 ${c.overpassTime}，窗外`),
          ['重算候选', '检查任务时间窗设置']);
      } else {
        add('C7', '时间窗合法', 'PASS', '所有候选过顶时刻均在任务时间窗内');
      }
    }
  }

  // ── C8 无超载簇 ────────────────────────────────────────────────────
  {
    const over = constraintAudit?.overLoadedClusters;
    if (over != null) {
      if (over > 0) {
        add('C8', '成像时长约束', 'FAIL',
          `${over} 个卫星聚簇存在过载（同窗内条带总成像时长超过可用窗）`,
          (constraintAudit.clusters ?? []).filter(c => c.overLoaded).slice(0, 8)
            .map(c => `${c.sat}：${c.n} 条带需 ${c.needSec}s，窗口仅 ${c.availSec}s`),
          ['拆到更多卫星或更多过顶窗口', '缩短单条带长度']);
      } else {
        add('C8', '成像时长约束', 'PASS', '无超载聚簇');
      }
    }
  }

  const problems = checks.filter(c => c.status === 'FAIL').flatMap(c => c.problems);
  const suggestions = [...new Set(checks.filter(c => c.status === 'FAIL').flatMap(c => c.suggestions))];
  const status = checks.some(c => c.status === 'FAIL') ? 'FAIL'
    : checks.some(c => c.status === 'WARN') ? 'WARN' : 'PASS';

  return {
    status,
    stage,
    canProceed: status !== 'FAIL',
    checks,
    // 给 solution 侧（AI）的问题清单：说清"哪里不对、应该怎么办"
    problems,
    suggestions,
    summary: status === 'PASS'
      ? '工程侧校验通过，规划可执行'
      : status === 'WARN'
        ? `工程侧校验通过（有 ${checks.filter(c => c.status === 'WARN').length} 项告警），规划可执行但需注意`
        : `工程侧校验未通过（${checks.filter(c => c.status === 'FAIL').length} 项失败），请重新规划`,
  };
}
