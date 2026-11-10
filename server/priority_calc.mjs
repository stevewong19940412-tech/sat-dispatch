// ─── 优先级计算模块（4.4）：S = Q × R × C ──────────────────────────────
import { db } from "./db.mjs";
import { solarElevationDegFor } from "./solar.mjs";

// （1）成像质量评分 Q = A × fres
export function scoreQ(availability, greq, gcand) {
  const A = availability; // 0-100
  const ratio = greq / gcand;
  let fres = Math.min(1, (1 + Math.log2(ratio)) / 2);
  fres = Math.max(0.5, fres); // 值域 [0.5, 1]
  return { Q: Math.round(A * fres * 10) / 10, fres: Math.round(fres * 1000) / 1000 };
}

// （2）时间窗匹配度 R = mtime × mbak × mlook × mdead
export function scoreR(winCountInTask, overpassTime, windowStart, windowEnd, slewDeg, slewLimitDeg, task) {
  const t1 = new Date(windowStart).getTime();
  const t2 = new Date(windowEnd).getTime();
  const timg = new Date(overpassTime).getTime();
  // 时刻余量
  const mtime = t2 > t1 ? (t2 - timg) / (t2 - t1) : 0.5;
  // 备份机会
  const n = winCountInTask;
  const mbak = n >= 3 ? 1.0 : n === 2 ? 0.9 : 0.7;
  // 侧摆余量
  const mlook = Math.max(0.5, 1 - 0.5 * (slewDeg / Math.max(1, slewLimitDeg)));
  // 时效余量
  let mdead = 1.0;
  if (task.timelinessHours) {
    const td = new Date(windowEnd).getTime() + task.timelinessHours * 3600000;
    const tauP = 2 * 3600000; // 数传处理时延 2h（公司级简化）
    const T0 = 24 * 3600000;  // 满余量基准 24h
    mdead = Math.min(1, Math.max(0, (td - timg - tauP) / T0)) || 0.3;
  }
  const R = mtime * mbak * mlook * mdead;
  return {
    R: Math.round(R * 1000) / 1000,
    Rdetail: { mtime: round3(mtime), mbak, mlook: round3(mlook), mdead: round3(mdead) },
  };
}

// （3）任务完成能力 C = 0.5·c1 + 0.3·c2 + 0.2·c3
// 权重依据：需求文档《遥感卫星统一调度系统-开发执行逻辑说明》第6节参数清单（c1履约率/c2数据质量/c3应用适配）
export function scoreC(company) {
  const c = db.prepare("SELECT * FROM companies WHERE short=? OR name=?").get(company, company);
  if (!c) return { C: 0.6, Cdetail: { c1: 0.6, c2: 0.5, c3: 0.6, note: '公司未登记' } };
  // c1 履约完成率
  let c1 = c.fulfillmentRate;
  const sampleN = db.prepare("SELECT count(*) n FROM fulfillmentLog WHERE company=?").get(c.short)?.n ?? 0;
  if (sampleN < 30) {
    const avg = db.prepare("SELECT avg(fulfillmentRate) a FROM companies WHERE fulfillmentRate IS NOT NULL").get()?.a ?? 0.9;
    c1 = (c1 ?? avg) * 0.9;
  }
  // c2 承载余量
  const c2 = Math.max(0, 1 - (c.acceptedCount ?? 0) / (c.capacity ?? 50));
  // c3 资源质量
  const c3map = { '高': 0.9, '中': 0.75, '低': 0.6 };
  const c3 = c3map[c.dataQuality] ?? 0.6;
  const C = 0.5 * c1 + 0.3 * c2 + 0.2 * c3;
  return { C: round3(C), Cdetail: { c1: round3(c1), c2: round3(c2), c3, sampleN } };
}

// （4）任务排序聚合：候选→评分→排序清单
export function rankTask(taskId) {
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  if (!task) return [];
  const cands = db.prepare("SELECT * FROM candidates WHERE taskId=? AND filtered=0").all(taskId);
  db.prepare("DELETE FROM rankings WHERE taskId=?").run(taskId);
  const ins = db.prepare("INSERT INTO rankings (taskId,candidateId,rank,Q,R,C,S,Qdetail,Rdetail,Cdetail) VALUES (?,?,?,?,?,?,?,?,?,?)");

  const scored = [];
  for (const cand of cands) {
    // 该任务窗内该公司对该条带的可用窗口数（备份机会）
    const winCount = db.prepare(
      "SELECT count(*) n FROM candidates WHERE taskId=? AND company=? AND stripIdx=? AND filtered=0"
    ).get(taskId, cand.company, cand.stripIdx)?.n ?? 1;
    const sat = db.prepare("SELECT * FROM satellites WHERE noradId=?").get(cand.satNoradId);
    const cap = sat ? getCap(sat) : { slewLimitDeg: 40, resolution: 1.0 };

    const { Q, fres } = scoreQ(cand.availability, task.resolution, cand.validRes ?? cap.resolution);
    const { R, Rdetail } = scoreR(winCount, cand.overpassTime, task.windowStart, task.windowEnd, cand.slewDeg ?? 0, cap.slewLimitDeg, task);
    const { C, Cdetail } = scoreC(cand.company);
    const S = (Q / 100) * R * C * 100; // 综合评分（百分制当量）

    scored.push({ cand, Q, fres, R, Rdetail, C, Cdetail, S });
  }

  // 排序：S 降序；同分按数据档位高者优先 → 过顶早者优先
  const gradeRank = { '高': 0, '中': 1, '低': 2 };
  scored.sort((a, b) => {
    if (Math.abs(b.S - a.S) > 0.01) return b.S - a.S;
    const ga = gradeRank[a.cand.orbitGrade] ?? 1, gb = gradeRank[b.cand.orbitGrade] ?? 1;
    if (ga !== gb) return ga - gb;
    return new Date(a.cand.overpassTime) - new Date(b.cand.overpassTime);
  });

  scored.forEach((s, i) => {
    ins.run(taskId, s.cand.id, i + 1, s.Q, s.R, s.C, round3(s.S),
      JSON.stringify({ fres: s.fres, availability: s.cand.availability }),
      JSON.stringify(s.Rdetail), JSON.stringify(s.Cdetail));
  });
  return scored.length;
}

function getCap(sat) {
  // 与 candidate_calc 保持一致的能力查询（简单镜像）
  const N = sat.name.toUpperCase();
  const CAPS = {
    'JILIN': { slewLimitDeg: 45, resolution: 0.75 },
    'GAOFEN-3': { slewLimitDeg: 40, resolution: 1.0 },
    'GAOFEN': { slewLimitDeg: 35, resolution: 0.8 },
    'YAOGAN': { slewLimitDeg: 40, resolution: 1.0 },
    'SUPERVIEW': { slewLimitDeg: 45, resolution: 0.5 },
  };
  for (const [k, v] of Object.entries(CAPS)) if (N.includes(k)) return v;
  return { slewLimitDeg: 40, resolution: 1.0 };
}

function round3(x) { return Math.round(x * 1000) / 1000; }
