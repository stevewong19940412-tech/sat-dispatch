// ─── 调度主服务：任务受理 → 候选计算 → 优先级 → 派单/直控 ────────────────
import express from "express";
import { db } from "./db.mjs";
import { nextTaskNo, nextOrderNo } from "./dispatch_schema.mjs";
import {
  normalizeTaskStrips, computeVisibleWindows, forecastCloud, cloudEffective,
  applyConstraints, getCapability, haversineKm,
} from "./candidate_calc.mjs";
import { forecastCloudReal } from "./cloud_forecast.mjs";
import { computeStationPasses, pickUplinkPass } from "./ground_stations.mjs";
import { solveImagingParams, solveUplinkBudget, getPayloadSpec } from "./payload_specs.mjs";
import { rankTask } from "./priority_calc.mjs";
import { solarElevationDegFor } from "./solar.mjs";

export const dispatchApi = express.Router();

// ─── 任务受理 ─────────────────────────────────────────────────────────────
// 生成校验（4.1-4）：字段完整性 + 取值合法性
export function validateTask(t) {
  const errors = [];
  if (!t.targetName) errors.push('目标名称缺失');
  if (!t.geom) errors.push('目标位置缺失');
  if (!['point', 'polygon'].includes(t.geomType)) errors.push('目标位置格式非法');
  if (!['optical', 'sar', 'video'].includes(t.obsType)) errors.push('观测类型缺失或非法');
  if (!t.resolution || t.resolution <= 0 || t.resolution > 1000) errors.push('分辨率要求非法');
  if (!t.windowStart || !t.windowEnd) errors.push('时间窗缺失');
  if (t.windowStart && t.windowEnd && new Date(t.windowEnd) <= new Date(t.windowStart)) errors.push('时间窗起止倒置');
  if (t.maxCloud != null && (t.maxCloud < 0 || t.maxCloud > 1)) errors.push('云量须在[0,1]');
  if (t.maxSlewDeg != null && (t.maxSlewDeg < 0 || t.maxSlewDeg > 45)) errors.push('侧摆角须在[0,45]');
  return errors;
}

// 撤单回退：将已派发任务退回待派单（删其订单、留痕），供人工重新选择派发方式
dispatchApi.post("/tasks/:id/revoke", (req, res) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(+req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  if (!['已派发', '已接单'].includes(t.status))
    return res.status(400).json({ error: `状态 ${t.status} 不可撤回（仅已派发/已接单可撤）` });
  db.prepare("DELETE FROM orders WHERE taskId=?").run(t.id);
  db.prepare("UPDATE tasks SET status='待派单' WHERE id=?").run(t.id);
  db.prepare(`INSERT INTO dispatchLog (taskId, action, detail) VALUES (?, '撤单回退', ?)`)
    .run(t.id, req.body?.reason ?? '人工撤回，重新选择派发方式');
  res.json({ ok: true, status: '待派单' });
});

// 任务级人工确认：AI 建单默认 pendingConfirm=true（待人工确认下发），
// 工作台点"确认下发"后才置 false 并可派发。手工录入默认 false。
dispatchApi.post("/tasks/:id/confirm", (req, res) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(+req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  if (t.status !== '待派单') return res.status(400).json({ error: `状态 ${t.status} 不可确认下发` });
  db.prepare("UPDATE tasks SET pendingConfirm=0 WHERE id=?").run(t.id);
  db.prepare(`INSERT INTO dispatchLog (taskId, action, detail) VALUES (?, '人工确认下发', ?)`)
    .run(t.id, req.body?.note ?? '人工确认下发任务');
  res.json({ ok: true, status: '已确认待派发' });
});

dispatchApi.post("/tasks", (req, res) => {
  const b = req.body ?? {};
  const task = {
    taskName: b.taskName || '未命名任务',
    source: b.source ?? '手工录入',
    targetName: b.targetName,
    targetType: b.targetType,
    geomType: b.geomType,
    geom: typeof b.geom === 'string' ? b.geom : JSON.stringify(b.geom),
    obsType: b.obsType,
    resolution: b.resolution != null ? parseFloat(b.resolution) : null,
    spectral: b.spectral,
    windowStart: b.windowStart,
    windowEnd: b.windowEnd,
    maxCloud: b.maxCloud != null ? parseFloat(b.maxCloud) : 0.3,
    maxSlewDeg: b.maxSlewDeg != null ? parseFloat(b.maxSlewDeg) : 45,
    timelinessHours: b.timelinessHours != null ? parseFloat(b.timelinessHours) : null,
    priority: b.priority ?? '常规',
    isEmergency: b.priority === '应急' || b.isEmergency ? 1 : 0,
    taskPhase: b.taskPhase ?? '未来成像',
    confidence: b.confidence ? JSON.stringify(b.confidence) : null,
    parseNote: b.parseNote,
  };
  const errors = validateTask(task);
  if (errors.length) return res.status(400).json({ error: '生成校验不通过', errors });
  task.taskNo = nextTaskNo();
  task.pendingConfirm = (task.source === '对话下单' || req.body?.source === '对话下单') ? 1 : 0;
  const r = db.prepare(`INSERT INTO tasks (taskNo,taskName,source,targetName,targetType,geomType,geom,
      obsType,resolution,spectral,windowStart,windowEnd,maxCloud,maxSlewDeg,timelinessHours,
      priority,isEmergency,taskPhase,confidence,parseNote,pendingConfirm)
    VALUES (@taskNo,@taskName,@source,@targetName,@targetType,@geomType,@geom,
      @obsType,@resolution,@spectral,@windowStart,@windowEnd,@maxCloud,@maxSlewDeg,@timelinessHours,
      @priority,@isEmergency,@taskPhase,@confidence,@parseNote,@pendingConfirm)`).run(task);
  res.json({ ...task, id: r.lastInsertRowid, status: '待派单' });
});

// AI 建单联动：最近 3 分钟内由 AI 创建的任务（供工作台自动打开）
// CLI 版本对账（旧副本自愈：CLI 启动时对比，旧则提示 --self-update）
dispatchApi.get("/cli-version", (req, res) => {
  res.json({ version: 3 });
});

dispatchApi.get("/latest", (req, res) => {
  const row = db.prepare(`SELECT id FROM tasks WHERE source='对话下单'
    AND createdAt >= datetime('now', '-3 minutes') ORDER BY id DESC LIMIT 1`).get();
  res.json({ taskId: row?.id ?? null });
});

dispatchApi.get("/tasks", (req, res) => {
  const { status, limit = 100 } = req.query;
  const rows = status
    ? db.prepare("SELECT * FROM tasks WHERE status=? ORDER BY id DESC LIMIT ?").all(status, +limit)
    : db.prepare("SELECT * FROM tasks ORDER BY id DESC LIMIT ?").all(+limit);
  res.json(rows);
});

dispatchApi.get("/tasks/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM tasks WHERE id=?").get(+req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  t.geom = JSON.parse(t.geom);
  t.rankings = db.prepare(`
    SELECT r.*, c.satName, c.company, c.windowStart wStart, c.windowEnd wEnd, c.overpassTime, c.slewDeg, c.availability, c.cloudFc, c.cloudSource, c.orbitGrade, c.stripIdx, c.stripCount, c.minDistKm, c.imgWinStart, c.imgWinEnd, c.sunElDeg
    FROM rankings r JOIN candidates c ON c.id = r.candidateId
    WHERE r.taskId=? ORDER BY r.rank LIMIT 30`).all(t.id);
  t.orders = db.prepare("SELECT * FROM orders WHERE taskId=? ORDER BY id DESC").all(t.id);
  t.directPlans = db.prepare("SELECT * FROM directPlans WHERE taskId=? ORDER BY id DESC").all(t.id);
  res.json(t);
});

dispatchApi.delete("/tasks/:id", (req, res) => {
  const id = +req.params.id;
  db.prepare("DELETE FROM tasks WHERE id=?").run(id);
  db.prepare("DELETE FROM candidates WHERE taskId=?").run(id);
  db.prepare("DELETE FROM rankings WHERE taskId=?").run(id);
  db.prepare("DELETE FROM orders WHERE taskId=?").run(id);
  db.prepare("DELETE FROM directPlans WHERE taskId=?").run(id);
  res.json({ ok: true });
});

// ─── 候选卫星计算（4.3）──────────────────────────────────────────────────
dispatchApi.post("/tasks/:id/candidates", async (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(+req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  const opts = {
    windowStart: task.windowStart, windowEnd: task.windowEnd,
    maxSlewDeg: task.maxSlewDeg ?? 45,
    minElevSunDeg: 10,
  };
  const strips = normalizeTaskStrips(task, 12);
  const tCreated = new Date(task.createdAt);

  // 候选卫星范围：观测类型匹配的卫星（SAR任务只看SAR卫星，反之光学）
  const wantSar = task.obsType === 'sar';
  const allSats = db.prepare("SELECT * FROM satellites WHERE decayed=0").all()
    .filter(s => wantSar
      ? s.subCategory === 'sar'
      : ['optical', 'staring', 'hyperspectral'].includes(s.subCategory));
  // 应急任务只看中国卫星（直控前提：国内测控托管）；普通任务全部
  const scope = task.isEmergency ? allSats.filter(s => s.country === '中国') : allSats;

  db.prepare("DELETE FROM candidates WHERE taskId=?").run(task.id);
  const ins = db.prepare(`INSERT INTO candidates (taskId,stripIdx,stripCount,satNoradId,satName,company,
      windowStart,windowEnd,overpassTime,slewDeg,availability,cloudFc,orbitGrade,filtered,filterReason,validRes, cloudSource, sunElDeg, minDistKm, imgWinStart, imgWinEnd)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const winStartT = new Date(task.windowStart).getTime();
  const leadDays = Math.max(0, (winStartT - tCreated.getTime()) / 86400000);
  let inserted = 0, filtered = 0;
  const gapStats = {}; // 能力缺口统计

  for (const sat of scope) {
    const cap = getCapability(sat);
    const company = sat.operator || sat.country;
    let anyInserted = false;
    for (const strip of strips) {
      const windows = computeVisibleWindows(sat, strip, opts);
      for (const w of windows.slice(0, 3)) { // 每条带最多3个窗口
        const overpass = new Date(w.overpass);
        const { cloud, source: cloudSrc } = await forecastCloudReal(strip.lat, strip.lon, overpass, leadDays);
        const sunEl = solarElevationDegFor(strip.lat, strip.lon, overpass);
        const { ceff, availability } = cloudEffective(cloud, w.slewDeg, sunEl);
        const cand = { slewDeg: w.slewDeg, overpassTime: overpass.toISOString(), cloudFc: cloud };
        const { pass, reasons, validRes } = applyConstraints(cand, task, sat, cap);
        if (!pass) {
          filtered++;
          for (const r of reasons) {
            const key = r.split('：')[0];
            gapStats[key] = (gapStats[key] ?? 0) + 1;
          }
        }
        ins.run(task.id, strip.idx, strip.count, sat.noradId, sat.name, company,
          new Date(w.start).toISOString(), new Date(w.end).toISOString(),
          overpass.toISOString(), Math.round(w.slewDeg * 10) / 10,
          Math.round(availability * 10) / 10, Math.round(cloud * 1000) / 1000,
          '高', pass ? 0 : 1, pass ? null : reasons.join('；'), Math.round(validRes * 100) / 100, cloudSrc,
          Math.round(solarElevationDegFor(strip.lat, strip.lon, overpass) * 10) / 10,
          Math.round(w.minDistKm * 10) / 10,
          w.imgWinStart ? new Date(w.imgWinStart).toISOString() : null,
          w.imgWinEnd ? new Date(w.imgWinEnd).toISOString() : null);
        if (pass) inserted++;
        anyInserted = true;
        if (inserted > 200) break; // 上限保护
      }
      if (inserted > 200) break;
    }
    if (inserted > 200) break;
  }

  // 优先级计算（4.4）联动
  const ranked = rankTask(task.id);
  res.json({ taskId: task.id, strips: strips.length, candidates: inserted, filtered, ranked, gapStats });
});

// ─── 派单执行（4.5）──────────────────────────────────────────────────────
// R1~R6 分流判定
function decideChannel(task, ranking, skipR1 = false) {
  // R1 直控：应急 且 时效≤24h（双条件）。仅标"应急"但时效宽的任务（如 40h）降级走 R2~R6，
  // 避免 AI/录入把"尽快"写成应急就绕过询价与人工裁定。
  if (!skipR1) {
    if (task.isEmergency && (!task.timelinessHours || task.timelinessHours <= 24))
      return { channel: '直控', rule: task.timelinessHours ? 'R1 应急且时效≤24h' : 'R1 应急（未填时效，视为最高紧迫）' };
    if (task.isEmergency) {
      // 降级：递归跳过 R1 重新判定，并标注降级原因
      const downgraded = decideChannel(task, ranking, true);
      return { ...downgraded, rule: '应急但时效>24h，降级正常分流（未走直控）｜' + downgraded.rule };
    }
  }
  const companies = [...new Set(ranking.map(r => r.company))];
  if (companies.length === 1) return { channel: '指派', rule: 'R2 候选公司仅一家' };
  // R3 成像要求与时效达到"要求高"：分辨率 ≤1m 且时效 ≤24h
  if (task.resolution <= 1 && task.timelinessHours && task.timelinessHours <= 24) {
    return { channel: '指派', rule: 'R3 高要求按时效逐级指派' };
  }
  // R4 询价条件：候选公司 ≥3 且预估金额达标（简化：分辨率 ≤2m）
  if (companies.length >= 3 && task.resolution <= 2) return { channel: '询价', rule: 'R4 多家候选达标询价' };
  // R5 小额碎片
  if (task.resolution >= 5) return { channel: '抢单', rule: 'R5 小额碎片任务挂池' };
  return { channel: '人工裁定', rule: 'R6 其余任务人工裁定' };
}

dispatchApi.post("/tasks/:id/dispatch", (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(+req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });

  const ranking = db.prepare(`
    SELECT r.*, c.satName, c.company, c.satNoradId, c.overpassTime, c.windowStart, c.windowEnd, c.availability, c.minDistKm, c.imgWinStart, c.imgWinEnd, c.sunElDeg
    FROM rankings r JOIN candidates c ON c.id=r.candidateId
    WHERE r.taskId=? AND c.filtered=0 ORDER BY r.rank`).all(task.id);
  if (ranking.length === 0) return res.status(400).json({ error: '无可用候选，请先执行候选计算' });
  if (task.pendingConfirm) return res.status(400).json({ error: '任务待人工确认下发，请先在工作台点击「确认下发」' });

  // 人工指定通道优先：前端「派给公司」传 channel=公司通道，「生成直控指令」传 channel=直控；
  // 未指定时走 R1~R6 自动判定
  const manualChannel = req.body?.channel;
  let { channel, rule } = manualChannel
    ? { channel: manualChannel, rule: `人工指定通道（覆盖自动判定）` }
    : decideChannel(task, ranking);

  if (channel === '直控') {
    // R1 应急 → 创建直控执行方案（待值班确认）
    // top 候选优选"幅宽可覆盖"（imgWin 非空）的，排序分相同前提下拍到 > 拍不到
    const top = ranking.find(r => r.imgWinStart && r.imgWinEnd) ?? ranking[0];
    const r = db.prepare(`INSERT INTO directPlans (taskId,satNoradId,satName,company,windowStart,windowEnd,overpassTime,imgWinStart,imgWinEnd,status)
      VALUES (?,?,?,?,?,?,?,?,?, '待确认')`).run(task.id, top.satNoradId, top.satName, top.company,
      top.windowStart, top.windowEnd, top.overpassTime, top.imgWinStart, top.imgWinEnd);
    db.prepare("UPDATE tasks SET status='直控执行中' WHERE id=?").run(task.id);
    return res.json({ channel, rule, planId: r.lastInsertRowid, topRank: top });
  }

  // 普通通道
  const orderNo = nextOrderNo();
  const company = ranking[0].company;
  const r = db.prepare(`INSERT INTO orders (taskId,orderNo,channel,company,satNoradId,satName,rankUsed,
      targetName,obsType,resolution,windowStart,windowEnd,maxCloud,deliveryDeadline,status,statusHistory)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    task.id, orderNo, channel, company, ranking[0].satNoradId, ranking[0].satName, ranking[0].rank,
    task.targetName, task.obsType, task.resolution, task.windowStart, task.windowEnd, task.maxCloud,
    task.windowEnd, '已派发', JSON.stringify([{ status: '已派发', time: new Date().toISOString(), source: '平台' }]));
  db.prepare("UPDATE tasks SET status='已派发' WHERE id=?").run(task.id);
  db.prepare("INSERT INTO dispatchLog (orderId,taskId,channel,company,rank,action,detail) VALUES (?,?,?,?,?,?,?)")
    .run(r.lastInsertRowid, task.id, channel, company, ranking[0].rank, '派发', rule);

  // 询价通道：同时向其他候选公司发询价单
  let inquiries = [];
  if (channel === '询价') {
    const cnCompanies = new Set(db.prepare("SELECT short FROM companies").all().map(c => c.short));
    const seen = new Set([company]);
    for (const rk of ranking) {
      if (seen.has(rk.company) || !cnCompanies.has(rk.company)) continue; // 询价仅限国内在册公司
      seen.add(rk.company);
      if (seen.size > 5) break;
      inquiries.push(rk.company);
      db.prepare("INSERT INTO dispatchLog (orderId,taskId,channel,company,rank,action,detail) VALUES (?,?,?,?,?,?,?)")
        .run(r.lastInsertRowid, task.id, '询价', rk.company, rk.rank, '询价单发出', '同步询价');
    }
  }
  res.json({ channel, rule, orderId: r.lastInsertRowid, orderNo, company, inquiries });
});

// 询价报价（模拟公司响应）
dispatchApi.post("/orders/:id/quote", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(+req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  const { quotes } = req.body ?? {}; // [{company, price, valid}] 或由平台模拟
  let list = quotes;
  if (!list) {
    // 平台模拟报价：候选公司按能力给价
    const logs = db.prepare("SELECT company FROM dispatchLog WHERE orderId=? AND action='询价单发出'").all(order.id);
    list = logs.map((l, i) => ({ company: l.company, price: Math.round((8 + i * 2.3) * 10) / 10, valid: true }));
  }
  const valid = list.filter(q => q.valid);
  if (valid.length === 0) {
    return res.json({ result: '全部弃权 → 转抢单', nextChannel: '抢单' });
  }
  valid.sort((a, b) => a.price - b.price);
  const winner = valid[0];
  db.prepare("UPDATE orders SET company=?, price=?, channel='询价' WHERE id=?").run(winner.company, winner.price, order.id);
  db.prepare("INSERT INTO dispatchLog (orderId,taskId,channel,company,action,detail) VALUES (?,?,?,?,?,?)")
    .run(order.id, order.taskId, '询价', winner.company, '成交', `最低价 ${winner.price} 万`);
  res.json({ result: '成交', winner });
});

// 抢单池
dispatchApi.post("/tasks/:id/pool", (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(+req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const expires = new Date(Date.now() + 4 * 3600000).toISOString(); // 4h 有效期
  db.prepare("INSERT INTO taskPool (taskId,expiresAt) VALUES (?,?)").run(task.id, expires);
  db.prepare("UPDATE tasks SET status='挂任务池' WHERE id=?").run(task.id);
  res.json({ ok: true, expiresAt: expires });
});

dispatchApi.post("/pool/:taskId/claim", (req, res) => {
  const { company } = req.body ?? {};
  const taskId = +req.params.taskId;
  const pool = db.prepare("SELECT * FROM taskPool WHERE taskId=? AND claimedBy IS NULL ORDER BY id DESC LIMIT 1").get(taskId);
  if (!pool) return res.status(404).json({ error: '不在任务池或已被认领' });
  db.prepare("UPDATE taskPool SET claimedBy=?, claimedAt=datetime('now') WHERE id=?").run(company, pool.id);
  // 生成订单
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
  const orderNo = nextOrderNo();
  const ranking = db.prepare(`
    SELECT r.*, c.satName, c.satNoradId, c.windowStart, c.windowEnd FROM rankings r JOIN candidates c ON c.id=r.candidateId
    WHERE r.taskId=? AND c.company=? AND c.filtered=0 ORDER BY r.rank LIMIT 1`).get(taskId, company);
  const r = db.prepare(`INSERT INTO orders (taskId,orderNo,channel,company,satNoradId,satName,rankUsed,
      targetName,obsType,resolution,windowStart,windowEnd,maxCloud,status,statusHistory)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    taskId, orderNo, '抢单', company, ranking?.satNoradId ?? null, ranking?.satName ?? null, ranking?.rank ?? null,
    task.targetName, task.obsType, task.resolution, task.windowStart, task.windowEnd, task.maxCloud,
    '已派发', JSON.stringify([{ status: '已派发', time: new Date().toISOString(), source: '抢单成交' }]));
  db.prepare("UPDATE tasks SET status='已派发' WHERE id=?").run(taskId);
  res.json({ ok: true, orderId: r.lastInsertRowid, orderNo });
});

// 订单状态流转（4.5-3）：单向流转
const ORDER_FLOW = {
  '已派发': ['已接单'],
  '已接单': ['执行中'],
  '执行中': ['已交付'],
  '已交付': ['已验收', '已失败'],
};
dispatchApi.post("/orders/:id/status", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(+req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  const { status, source = '公司回传', failureReason } = req.body ?? {};
  const allowed = ORDER_FLOW[order.status] ?? [];
  if (order.status === '已失败' && status === '已派发') {
    // 失败重派：生成新订单
    const orderNo = nextOrderNo();
    const r = db.prepare(`INSERT INTO orders (taskId,orderNo,channel,company,satNoradId,satName,
        targetName,obsType,resolution,windowStart,windowEnd,maxCloud,status,statusHistory)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      order.taskId, orderNo, order.channel, '', null, null,
      order.targetName, order.obsType, order.resolution, order.windowStart, order.windowEnd, order.maxCloud,
      '已派发', JSON.stringify([{ status: '已派发', time: new Date().toISOString(), source: '失败重派' }]));
    return res.json({ ok: true, reDispatched: r.lastInsertRowid, orderNo });
  }
  if (!allowed.includes(status)) return res.status(400).json({ error: `非法流转：${order.status} → ${status}` });
  const hist = JSON.parse(order.statusHistory || '[]');
  hist.push({ status, time: new Date().toISOString(), source });
  const closed = ['已验收', '已失败'].includes(status);
  db.prepare(`UPDATE orders SET status=?, statusHistory=?, closedAt=${closed ? "datetime('now')" : 'closedAt'},
      fulfillment=?, failureReason=? WHERE id=?`).run(
    status, JSON.stringify(hist),
    status === '已验收' ? '按约完成' : status === '已失败' ? '未按约' : null,
    status === '已失败' ? (failureReason ?? '验收不通过') : null,
    order.id);
  // 履约回写
  if (closed) {
    db.prepare("INSERT INTO fulfillmentLog (company,orderId,taskId,outcome,reason) VALUES (?,?,?,?,?)")
      .run(order.company, order.id, order.taskId, status === '已验收' ? '按约完成' : '未按约', failureReason ?? null);
    db.prepare("UPDATE tasks SET status=? WHERE id=?").run(status === '已验收' ? '已验收' : '已失败', order.taskId);
    // 更新公司履约率（EWMA α=0.2 简化）
    const co = db.prepare("SELECT * FROM companies WHERE short=?").get(order.company);
    if (co) {
      const outcome = status === '已验收' ? 1 : 0;
      const newRate = 0.2 * outcome + 0.8 * (co.fulfillmentRate ?? 0.9);
      db.prepare("UPDATE companies SET fulfillmentRate=?, acceptedCount=max(0, acceptedCount-1) WHERE id=?").run(newRate, co.id);
    }
  } else {
    db.prepare("UPDATE tasks SET status=? WHERE id=?").run(status, order.taskId);
  }
  res.json({ ok: true, status });
});

dispatchApi.get("/orders", (req, res) => {
  res.json(db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 200").all());
});

// 卫星类型智能推荐（用户未指定 obsType 时，AI 先调用此接口分析，再请用户确认）
dispatchApi.post("/recommend", (req, res) => {
  const { targetName, lat, lon, resolution, timelinessHours, windowStart, windowEnd } = req.body ?? {};
  const reasons = []; const scores = { optical: 0, sar: 0 };
  // 1. 时效性：24h内交付 → SAR 全天候优势
  if (timelinessHours && timelinessHours <= 24) { scores.sar += 3; reasons.push(`时效要求 ${timelinessHours}h 较紧，SAR 不受光照与云影响，可全天候成像`); }
  else if (timelinessHours && timelinessHours <= 72) { scores.sar += 1; reasons.push("时效 72h 内，SAR 时间窗更灵活"); }
  // 2. 分辨率：高分辨率（≤1m）光学优势明显
  if (resolution && resolution <= 1) { scores.optical += 2; reasons.push(`分辨率 ${resolution}m 属高分辨率需求，光学星（高分/吉林一号/高景）在该档位选择更多`); }
  else if (resolution && resolution >= 5) { scores.optical += 1; reasons.push(`分辨率 ${resolution}m 属中低分辨率，光学星容量充足`); }
  // 3. 时间窗与昼夜：窗内含夜间/晨昏 → SAR
  if (windowStart && windowEnd) {
    const t0 = new Date(windowStart), t1 = new Date(windowEnd);
    const hours = (t1 - t0) / 3600000;
    if (hours <= 6) {
      // 窄窗内若跨晨昏，SAR 更稳
      const h0 = t0.getUTCHours() + t0.getUTCMinutes()/60;
      const localH = (h0 + 8) % 24; // 粗略按东八区（可扩展为按经度算）
      if (localH < 7 || localH > 17) { scores.sar += 2; reasons.push("窗口落在晨昏/夜间时段（当地时间），光学成像光照不足，推荐 SAR"); }
    }
    if (hours >= 48) { scores.optical += 1; reasons.push("窗口较宽（≥2天），光学过顶集中在当地上午 10:30~13:30，命中率足够"); }
  }
  // 4. 天气：72h 预报窗内的目标点查 open-meteo，多云/降水 → SAR
  //    （轻量实现：不阻塞推荐，标注"建议结合 dispatch weather 核实"）
  reasons.push("建议用 dispatch weather <lat> <lon> 核实目标点 72h 内云量：若预报持续 >60%，光学成像大概率不可用，应转 SAR");
  // 5. 目标类型关键词（水面/金属/形变监测 → SAR 特长）
  const name = String(targetName ?? "");
  if (/海域|海面|舰船|港口水面|桥梁形变|沉降|形变|冰/.test(name)) { scores.sar += 2; reasons.push("目标涉及水面/形变/冰情等场景，SAR 的全天候与干涉能力更适配"); }
  if (/植被|农田|城区细节|场馆|道路|绿化|色彩/.test(name)) { scores.optical += 2; reasons.push("目标涉及地物细节/色彩/植被场景，光学更适合"); }
  const winner = scores.optical >= scores.sar ? "optical" : "sar";
  res.json({
    recommended: winner,
    scores,
    reasons,
    note: "推荐仅供参考，请通过 AskUserQuestion 让用户确认最终观测类型后再创建任务"
  });
});

// 供智能体 CLI 的只读 SQL 查询（白名单表，SELECT only）
dispatchApi.post("/_sql", (req, res) => {
  const { sql, args = [] } = req.body ?? {};
  if (!sql || !/^\s*SELECT/i.test(sql)) return res.status(400).json({ error: "仅允许 SELECT" });
  const blocked = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA)\b/i;
  if (blocked.test(sql)) return res.status(400).json({ error: "仅允许 SELECT 查询" });
  try {
    const rows = db.prepare(sql).all(...args);
    res.json(rows);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

dispatchApi.get("/companies", (req, res) => {
  res.json(db.prepare("SELECT * FROM companies ORDER BY id").all());
});

dispatchApi.get("/pool", (req, res) => {
  res.json(db.prepare(`
    SELECT p.*, t.taskName, t.targetName, t.obsType, t.resolution FROM taskPool p
    JOIN tasks t ON t.id=p.taskId WHERE p.claimedBy IS NULL ORDER BY p.id DESC`).all());
});

// ─── 应急直控（4.6）──────────────────────────────────────────────────────
// 指令生成（规则引擎，确定性）+ 独立校验
// 成像参数解算：委托 payload_specs.mjs（三路调研智能体产出的真实型号参数库）
export function buildImagingParams(plan, strip, imagingSec) {
  return solveImagingParams({
    satName: plan.satName, altKm: plan.altKm ?? 500,
    gsdM: plan.resolutionM ?? 2, sunElDeg: plan.sunElDeg ?? 40,
    slewDeg: plan.slewDeg ?? 0, imagingSec,
  });
}

export function generateCommands(plan, sat, strip, windowStart, windowEnd) {
  // 动作时间轴（4.6）：时序基准 = TCA（最近过顶点，即 overpass），而非窗口起点。
  // 低轨卫星地面轨迹速度 ~7.5km/s，成像中点必须对准 TCA，否则指向误差达数百公里。
  const tca = new Date(plan.overpass ?? plan.overpassTime ?? windowStart).getTime();
  const slew = plan.slewDeg ?? 15;
  const omegaMax = 1.0; // °/s 型号配置
  const alphaMax = 0.5; // °/s²
  const slewTime = Math.abs(slew) / omegaMax + omegaMax / alphaMax; // 机动时长公式
  const stabilize = 3.0;   // 稳定 s
  const warmup = 5.0;      // 开机预热 s
  // 成像时长：以「成像覆盖窗」（幅宽半宽内能拍到目标的秒级区间）为准，
  // 不再按窗口长×0.6 或固定值——GAOFEN-14 近正过顶时覆盖窗可能只有 1~5s，
  // 拍 20s 会飞出幅宽 300km。成像中点对准 TCA，时长=覆盖窗时长（保底 1s，封顶 20s）。
  const w0 = new Date(windowStart).getTime();
  const w1 = new Date(windowEnd).getTime();
  const hasImgWin = plan.imgWinStart && plan.imgWinEnd;
  const imgWinSec = hasImgWin
    ? Math.max(1, Math.round((new Date(plan.imgWinEnd) - new Date(plan.imgWinStart)) / 1000))
    : 10;                                              // 无覆盖窗（幅宽罩不住目标）时保守取 10s，校验器会驳回
  const beforeTca = Math.max(0, tca - w0);           // TCA 前可用秒数
  const afterTca = Math.max(0, w1 - tca);            // TCA 后可用秒数
  const imaging = Math.max(1, Math.min(imgWinSec, Math.floor(beforeTca + afterTca), 20));
  // 相邻动作间最小转换间隔 1s（校验器要求 ≥0.5s）
  const gap = 1.0;
  // 时间轴以 TCA 为基准（startOffset 相对 TCA，可为负=提前）
  const preImaging = imaging / 2;                     // 成像前半段在 TCA 之前
  const preAllSec = slewTime + gap + stabilize + gap + warmup + gap + preImaging;
  const preAll = preAllSec * 1000;                    // 毫秒（tca 为 ms 时间戳）
  const t0 = tca - preAll;                            // 姿态机动的绝对开始时刻
  let off = 0;
  const mk = (action, duration, param) => {
    const cmd = { seq: 0, action, startOffset: round1(off), duration: round1(duration), ...(param ? { param } : {}) };
    off += duration + gap;
    return cmd;
  };
  const commands = [
    mk('姿态机动', slewTime, { rollDeg: round1(slew) }),
    mk('姿态稳定', stabilize),
    mk('开机预热', warmup),
    mk('成像', imaging, buildImagingParams(plan, strip, imaging)),
    mk('关机', 1),
  ];
  commands.forEach((c, i) => { c.seq = i + 1; });
  // 绝对时刻：供校验与上注（TCA 基准）——序列内 offset 从 mk 累计，直接复用避免单位错位
  const imgCmd = commands.find(c => c.action === '成像');
  const timeline = {
    tcaIso: new Date(tca).toISOString(),
    sequenceStartIso: new Date(t0).toISOString(),
    imagingStartIso: new Date(t0 + imgCmd.startOffset * 1000).toISOString(),
    imagingEndIso: new Date(t0 + (imgCmd.startOffset + imgCmd.duration) * 1000).toISOString(),
    imagingCenterIso: new Date(t0 + (imgCmd.startOffset + imgCmd.duration / 2) * 1000).toISOString(),
    alignedToTca: true,
  };
  return { commands, timeline };
}
function round1(x) { return Math.round(x * 10) / 10; }
function satellite2json() { return null; }

// 独立校验器（与生成引擎分开实现的判定）
export function validateCommands(commands, sat, plan) {
  const errors = [];
  const switchOn = commands.filter(c => c.action === '开机预热').length;
  if (switchOn > 8) errors.push(`开关机次数超限：${switchOn} > 8`);
  for (let i = 1; i < commands.length; i++) {
    const prev = commands[i - 1], cur = commands[i];
    const prevEnd = prev.startOffset + prev.duration;
    if (cur.startOffset < prevEnd) errors.push(`动作${cur.seq}与动作${prev.seq}时间重叠`);
    if (cur.startOffset - prevEnd < 0.5) errors.push(`动作${prev.seq}→${cur.seq}转换间隔不足0.5s`);
  }
  const total = commands[commands.length - 1].startOffset + commands[commands.length - 1].duration;
  if (total > 600) errors.push(`指令序列总时长${total}s 超固存/能量约束单次600s`);
  const imgCmd = commands.find(c => c.action === '成像');
  if (!imgCmd) errors.push('缺少成像动作');
  if (imgCmd && (imgCmd.param.integrationMs <= 0 || imgCmd.param.compression <= 0)) errors.push('成像参数非法');
  // 指向对准校验（4.6）：成像中点必须落在 TCA 的成像覆盖窗内（±3s 容差），
  // 否则"时序自洽但拍不到目标"。plan.overpassTime + imgWin* 为判据。
  if (imgCmd && plan?.overpassTime) {
    const tca = new Date(plan.overpassTime).getTime();
    const seqStart = new Date(plan.sequenceStartIso ?? plan.windowStart).getTime();
    const imgStart = seqStart + imgCmd.startOffset * 1000;
    const imgCenter = imgStart + imgCmd.duration * 1000 / 2;
    if (!plan.imgWinStart || !plan.imgWinEnd) {
      errors.push('幅宽不覆盖：整个过境弧段内传感器幅宽均罩不住目标，此方案不能成像，请改派其他过顶更近的卫星');
    }
    const winS = plan.imgWinStart ? new Date(plan.imgWinStart).getTime() - 3000 : tca - imgCmd.duration * 500;
    const winE = plan.imgWinEnd ? new Date(plan.imgWinEnd).getTime() + 3000 : tca + imgCmd.duration * 500;
    if (imgCenter < winS || imgCenter > winE) {
      errors.push(`指向偏差：成像中点偏离覆盖窗 ${Math.round(Math.abs(imgCenter - tca) / 1000)}s，不能拍到目标`);
    }
  }
  return { pass: errors.length === 0, errors, totalDuration: total };
}

dispatchApi.post("/plans/:id/generate", (req, res) => {
  const plan = db.prepare("SELECT * FROM directPlans WHERE id=?").get(+req.params.id);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  const sat = db.prepare("SELECT * FROM satellites WHERE noradId=?").get(plan.satNoradId);
  const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(plan.taskId);
  const strips = normalizeTaskStrips(task, 12);
  const planSlew = plan.slewDeg ?? 15;
  const { commands, timeline } = generateCommands({ ...plan, slewDeg: planSlew }, sat, strips[0], plan.windowStart, plan.windowEnd);
  // 测控弧段：真实站星几何计算（站-星仰角≥5°），选成像开始前最后一个可用弧段作为上注弧段
  const passes = computeStationPasses(sat, plan.windowStart, plan.windowEnd);
  // 数传窗口：成像结束后的第一个过站弧段（成像数据下传），无则标注"待下一圈数传"
  const imgEndMs = new Date(timeline.imagingEndIso).getTime();
  const downlinkPass = passes.find(p => p.arcStart >= imgEndMs) ?? null;
  const uplinkPass = pickUplinkPass(passes, timeline.imagingStartIso);
  // 参数包（T/CARSA 3-2022 指令文件要素）：卫星标识、测控弧段、指令序列、几何参数、任务上下文
  const paramPack = {
    satNoradId: plan.satNoradId, satName: plan.satName,
    groundStation: uplinkPass?.station ?? null,
    uplinkPass: uplinkPass ? {
      station: uplinkPass.station, arcStart: new Date(uplinkPass.arcStart).toISOString(),
      arcEnd: new Date(uplinkPass.arcEnd).toISOString(), maxElDeg: uplinkPass.maxElDeg,
      arcDurationSec: Math.round((uplinkPass.arcEnd - uplinkPass.arcStart) / 1000),
    } : null,
    allPasses: passes.map(p => ({ station: p.station, arcStart: new Date(p.arcStart).toISOString(), arcEnd: new Date(p.arcEnd).toISOString(), maxElDeg: p.maxElDeg })),
    window: { start: plan.windowStart, end: plan.windowEnd },
    tca: timeline.tcaIso, sequenceStart: timeline.sequenceStartIso,
    imagingStart: timeline.imagingStartIso, imagingEnd: timeline.imagingEndIso,
    imagingCenter: timeline.imagingCenterIso, alignedToTca: timeline.alignedToTca,
    slewDeg: planSlew,
    target: strips[0],
    stripDirection: '顺轨推扫（轨道飞行方向）',
    downlinkPass: downlinkPass ? {
      station: downlinkPass.station, arcStart: new Date(downlinkPass.arcStart).toISOString(),
      arcEnd: new Date(downlinkPass.arcEnd).toISOString(), maxElDeg: downlinkPass.maxElDeg,
    } : null,
    // 载荷规格与数据量/上注预算（三路调研智能体产出口径，字段带来源标注）
    payloadSpec: getPayloadSpec(plan.satName),
    estDataMB: (() => {
      const img = commands.find(c => c.action === '成像');
      return img?.param?.estDataMB ?? null;
    })(),
    uplinkBudget: uplinkPass ? solveUplinkBudget({
      arcDurationSec: Math.round((uplinkPass.arcEnd - uplinkPass.arcStart) / 1000),
      commandCount: commands.length,
    }) : null,
    commands,
  };
  const validation = validateCommands(commands, sat, { ...plan, sequenceStartIso: timeline.sequenceStartIso });
  if (!uplinkPass) {
    validation.pass = false;
    validation.errors.push('无可上注弧段：成像前该卫星未过任何国内测控站（仰角≥5°），指令无法上注，请改派或调整时窗');
  }
  db.prepare("UPDATE directPlans SET commands=?, validation=?, timeline=?, sequenceStart=?, paramPack=?, arcInfo=?, status=?, updatedAt=datetime('now') WHERE id=?")
    .run(JSON.stringify(commands), JSON.stringify(validation), JSON.stringify(timeline), timeline.sequenceStartIso, JSON.stringify(paramPack),
      uplinkPass ? JSON.stringify({ station: uplinkPass.station, arcStart: new Date(uplinkPass.arcStart).toISOString(), arcEnd: new Date(uplinkPass.arcEnd).toISOString(), maxElDeg: uplinkPass.maxElDeg }) : null,
      validation.pass ? '待核验下发' : '校验驳回', plan.id);
  res.json({ commands, validation, timeline, paramPack });
});

dispatchApi.post("/plans/:id/confirm", (req, res) => {
  const { stage, checklist } = req.body ?? {}; // stage: 方案|上注；checklist: 上注前人工核验勾选
  const plan = db.prepare("SELECT * FROM directPlans WHERE id=?").get(+req.params.id);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  const map = { '方案': '方案已确认', '上注': '已上注' };
  const next = map[stage];
  if (!next) return res.status(400).json({ error: 'stage 须为 方案|上注' });
  // 上注前强制核验（遥控作业规范：上行前阶段必须逐项确认）：
  // 1) 时窗正确 2) 指向对准（TCA） 3) 指令校验通过 4) 卫星/弧段正确
  if (stage === '上注') {
    if (!['待核验下发'].includes(plan.status)) return res.status(400).json({ error: `状态 ${plan.status} 不可上注（须先生成指令并核验）` });
    const required = ['windowOk', 'tcaAligned', 'commandsValid', 'satArcOk'];
    const missing = required.filter(k => !checklist?.[k]);
    if (missing.length) return res.status(400).json({ error: `上注核验未完成，缺项: ${missing.join(', ')}`, required });
    db.prepare(`INSERT INTO dispatchLog (taskId, action, detail) VALUES (?, '上注前人工核验', ?)`)
      .run(plan.taskId, JSON.stringify(checklist));
  }
  if (stage === '方案' && !['待确认', '待核验下发'].includes(plan.status))
    return res.status(400).json({ error: `状态 ${plan.status} 不可确认方案` });
  db.prepare("UPDATE directPlans SET status=?, updatedAt=datetime('now') WHERE id=?").run(next, plan.id);
  // 模拟测控弧段与执行
  if (next === '已上注') {
    // 上注弧段用参数包计算的真实弧段（不再编造）
    const pack = plan.paramPack ? JSON.parse(plan.paramPack) : null;
    const arc = pack?.uplinkPass
      ? { station: pack.uplinkPass.station, arcStart: pack.uplinkPass.arcStart, arcEnd: pack.uplinkPass.arcEnd, maxElDeg: pack.uplinkPass.maxElDeg }
      : null;
    db.prepare("UPDATE directPlans SET arcInfo=?, status='执行中', updatedAt=datetime('now') WHERE id=?")
      .run(arc ? JSON.stringify(arc) : plan.arcInfo, plan.id);
    db.prepare("UPDATE tasks SET status='直控执行中' WHERE id=?").run(plan.taskId);
  }
  res.json({ ok: true, status: next });
});

dispatchApi.post("/plans/:id/complete", (req, res) => {
  const { outcome = '成功' } = req.body ?? {};
  const plan = db.prepare("SELECT * FROM directPlans WHERE id=?").get(+req.params.id);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  db.prepare("UPDATE directPlans SET status=?, updatedAt=datetime('now') WHERE id=?").run(outcome === '成功' ? '已完成' : '已失败', plan.id);
  db.prepare("UPDATE tasks SET status=? WHERE id=?").run(outcome === '成功' ? '已验收' : '已失败', plan.taskId);
  res.json({ ok: true });
});

dispatchApi.get("/plans", (req, res) => {
  res.json(db.prepare("SELECT * FROM directPlans ORDER BY id DESC LIMIT 100").all());
});
dispatchApi.get("/plans/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM directPlans WHERE id=?").get(+req.params.id);
  if (!p) return res.status(404).json({ error: 'plan not found' });
  p.commands = p.commands ? JSON.parse(p.commands) : null;
  p.validation = p.validation ? JSON.parse(p.validation) : null;
  res.json(p);
});
