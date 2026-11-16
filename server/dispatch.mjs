// ─── 调度主服务：任务受理 → 候选计算 → 优先级 → 派单/直控 ────────────────
import fs from "fs";
import path from "path";
import express from "express";
import {
  pbList, pbAll, pbGet, pbGetByOldId, pbRecordId, pbCreate, pbUpdate, pbDelete, pbBatch, pbNextSeq,
} from "./pb_repo.mjs";

// ─── PocketBase 迁移辅助（T1 读路径切换）──────────────────────────────────
// 响应兼容约定：旧数字 id 继续作为 JSON 的 id 字段（oldId 回填），
// 关系记录（orders/directPlans/taskPool）的 taskId 同理回填，前端无需改动。
const pbNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const pbYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};
const pbTaskNo = (seq) => `RSBH-${pbYmd()}-${String(seq).padStart(3, "0")}`;
// PB 记录 → 旧 API 行：id 回填 oldId（新建无迁移映射时直接用 PB record id）
const pbTaskRow = (r) => ({ ...r, id: r.oldId ?? r.id, createdAt: r.createdAt || "0000-00-00 00:00:00" });
const pbRelRow = (r) => ({ ...r, id: r.oldId ?? r.id, taskId: r.expand?.task?.oldId ?? null });
// 新记录 oldId 分配：迁移库最大 oldId 之上递增，保证响应 id 与旧数字空间不冲突
// （PB 未设置的 number 字段读回是 0，不能用 0 作新建标记——迁移库存在 oldId=0 残留）
const _oldIdSeeds = new Map(); // table → 已分配到的值
async function pbNextOldId(table = "tasks") {
  if (_oldIdSeeds.get(table) == null) {
    const rows = await pbAll(table, { filter: "oldId>0", fields: "id,oldId", sort: "-oldId", limit: 1 });
    _oldIdSeeds.set(table, rows[0]?.oldId ?? 0);
  }
  const next = _oldIdSeeds.get(table) + 1;
  _oldIdSeeds.set(table, next);
  return next;
}
// PB filter 单引号转义（公司名等含引号场景）
const escFilter = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
// companies 60s 内存缓存（quote 打价用；写路径更新后由缓存过期自然刷新）
let _companiesCache = null, _companiesCacheAt = 0;
function companiesCacheAll() {
  return _companiesCache;
}
async function refreshCompaniesCache() {
  if (_companiesCache && Date.now() - _companiesCacheAt < 60000) return _companiesCache;
  _companiesCache = await pbAll("companies");
  _companiesCacheAt = Date.now();
  return _companiesCache;
}
setInterval(() => { refreshCompaniesCache().catch(() => {}); }, 30000).unref?.();
refreshCompaniesCache().catch(() => {});
// 兼容两种 id：纯数字=旧迁移 id（oldId 回查），字符串=PB record id（新任务直用）
async function pbResolveTask(idParam) {
  const s = String(idParam ?? "");
  if (process.env.PB_DEBUG_RESOLVE) console.log(`[resolve] idParam=${s}`);
  if (/^\d+$/.test(s)) {
    const rid = await pbRecordId("tasks", +s);
    if (process.env.PB_DEBUG_RESOLVE) console.log(`[resolve] oldId=${s} → rid=${rid}`);
    return rid ? { rid, oldId: +s } : null;
  }
  return s ? { rid: s, oldId: null } : null;
}
import {
  normalizeTaskStrips, planTaskArea, computeVisibleWindows, coarseWindowsAllStrips, refineStripWindows, forecastCloud, cloudEffective,
  applyConstraints, getCapability, haversineKm,
} from "./candidate_calc.mjs";
import { forecastCloudReal } from "./cloud_forecast.mjs";
import { computeStationPasses, pickUplinkPass } from "./ground_stations.mjs";
import { solveImagingParams, solveUplinkBudget, getPayloadSpec } from "./payload_specs.mjs";
import { summarizeCoveragePlan } from "./strip_planner.mjs";
import { dispatchAcrossSatellites, shouldSplitOrder } from "./multi_dispatch.mjs";
import { coverageGrade } from "./coverage_grid.mjs";
import { rankTaskPB } from "./priority_calc.mjs";
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
dispatchApi.post("/tasks/:id/revoke", async (req, res) => {
  const t = await pbGetByOldId("tasks", +req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  if (!['已派发', '已接单'].includes(t.status))
    return res.status(400).json({ error: `状态 ${t.status} 不可撤回（仅已派发/已接单可撤）` });
  const oldOrders = await pbAll("orders", { filter: `task='${t.id}'`, fields: "id" });
  await pbBatch([
    ...oldOrders.map(o => ({ table: "orders", method: "DELETE", recordId: o.id })),
    { table: "tasks", method: "UPDATE", recordId: t.id, data: { status: '待派单' } },
    { table: "dispatchLog", data: { task: t.id, action: '撤单回退', detail: req.body?.reason ?? '人工撤回，重新选择派发方式', at: pbNow() } },
  ]);
  res.json({ ok: true, status: '待派单' });
});

// 任务级人工确认：AI 建单默认 pendingConfirm=true（待人工确认下发），
// 工作台点"确认下发"后才置 false 并可派发。手工录入默认 false。
// ============ 一站式下单接口（工程侧保证落库，AI 只传参） ============
// POST /order-intake：原子完成 新建任务→格式校验→确认→候选计算→回读断言。
// 设计约束：1) 永远新建任务，禁止复用/改名旧任务 2) geom 格式错误立即 400（不静默）
// 3) 幂等：同目标+同窗口的活跃任务存在时返回已有任务（防止AI重复建单）4) 返回前回读断言落库成功
dispatchApi.post("/order-intake", async (req, res) => {
  const b = req.body ?? {};
  const need = ["taskName", "geomType", "geom", "obsType", "resolution", "windowStart", "windowEnd"];
  for (const k of need) if (b[k] === undefined) return res.status(400).json({ error: `缺少必填参数 ${k}` });

  // geom 格式硬校验（不静默）：point 必须有 lat/lon；polygon/area 必须有 coords≥4
  const g = b.geom ?? {};
  if (b.geomType === "point" && (typeof g.lat !== "number" || typeof g.lon !== "number"))
    return res.status(400).json({ error: "point 目标必须有数字 lat/lon" });
  if (b.geomType !== "point" && (!Array.isArray(g.coords) || g.coords.length < 3))
    return res.status(400).json({ error: "面目标必须有 coords 数组（≥3个顶点）；区域需求禁止简化成点" });

  // 幂等：同目标（中心±0.01°）+ 同窗口的活跃任务直接复用返回（不新建）
  // PB 迁移：status 多值用 (status='a'||status='b') 组合，近 2 天在 JS 内存过滤（PB 时间比较不走 SQLite 方言）
  const active = await pbAll("tasks", { filter: "(status='待派单'||status='已派发'||status='已接单')" });
  const twoDaysAgo = Date.now() - 2 * 86400000;
  // 幂等键（2026-11-15 修复 P0-4）：坐标 + 观测类型 + 分辨率 + 时间窗起点 全部一致才算同一任务。
  // 旧实现只比坐标（且只对点目标生效），导致 SAR 需求被静默挂到同点位的既有光学任务上，
  // 调用方拿回一个 ok 但参数完全不对的任务。
  const norm = (v) => (v == null ? "" : String(v).trim().toLowerCase());
  const existing = active.map(pbTaskRow).find(t => {
    if (!(t.createdAt && new Date(String(t.createdAt).replace(" ", "T") + "Z").getTime() > twoDaysAgo)) return false;
    if (norm(t.obsType) !== norm(b.obsType)) return false;                       // 光学≠SAR
    const resA = Number(t.resolution), resB = Number(b.resolution);
    if (Number.isFinite(resA) && Number.isFinite(resB) && Math.abs(resA - resB) > 1e-6) return false;
    if (norm(t.windowStart) !== norm(b.windowStart)) return false;               // 时间窗不同=新任务
    try {
      const tg = JSON.parse(t.geom ?? "{}");
      if (b.geomType === "point" && tg.lat != null)
        return Math.abs(tg.lat - g.lat) < 0.01 && Math.abs(tg.lon - g.lon) < 0.01;
      // 面目标：顶点数一致且首个顶点近似一致才复用（避免把不同区域混为同一任务）
      if (b.geomType !== "point" && Array.isArray(tg.coords) && Array.isArray(g.coords)) {
        if (tg.coords.length !== g.coords.length) return false;
        const [a, c] = [tg.coords[0], g.coords[0]];
        return Math.abs(a[0] - c[0]) < 0.01 && Math.abs(a[1] - c[1]) < 0.01;
      }
      return false;
    } catch { return false; }
  });
  if (existing) {
    const ranked = await pbAll("rankings", { filter: `task='${existing.id}'`, fields: "id" });
    return res.json({ reused: true, taskId: existing.id, taskNo: existing.taskNo, status: existing.status, candidates: ranked.length ?? null });
  }

  // 1) 新建（沿用 create 逻辑的内部路径：PB 创建，oldId 充当响应数字 id）
  const task = {
    taskNo: pbTaskNo(await pbNextSeq("taskNo")), taskName: b.taskName, targetName: b.targetName ?? b.taskName,
    source: b.source ?? "AI下单助手", geomType: b.geomType === "area" ? "polygon" : b.geomType,
    geom: JSON.stringify(g), obsType: b.obsType, resolution: b.resolution,
    windowStart: b.windowStart, windowEnd: b.windowEnd, maxCloud: b.maxCloud ?? 50,
    priority: b.priority ?? "常规", isEmergency: b.isEmergency ? 1 : 0,
    taskPhase: b.taskPhase ?? null, confidence: b.confidence ?? null, parseNote: b.parseNote ?? null,
    pendingConfirm: 1, status: "待派单", createdAt: pbNow(), oldId: await pbNextOldId(),
  };
  await pbCreate("tasks", task);
  const row = await pbGetByOldId("tasks", task.oldId);
  if (!row) return res.status(500).json({ error: "建单落库失败（回读断言未通过）" });

  // 2) 确认（AI 面板下单=用户委托，服务端原子确认）
  await pbUpdate("tasks", row.id, { pendingConfirm: 0 });

  // 3) 候选计算（异步返回不阻塞？——同步等待保证调用方拿到候选数；自调用用响应数字 id）
  let cand = null;
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8800}/api/dispatch/tasks/${row.oldId}/candidates`,
      { method: "POST", headers: { "Content-Type": "application/json", "X-Operator": "system" } });
    cand = await r.json().catch(() => null);
  } catch (e) { cand = { error: e.message }; }

  // 4) 回读断言
  const final = await pbGetByOldId("tasks", task.oldId);
  if (!final || final.pendingConfirm !== 0)
    return res.status(500).json({ error: "确认状态回读断言失败" });

  res.json({
    ok: true, taskId: final.oldId ?? final.id, taskNo: final.taskNo, status: final.status,
    pendingConfirm: final.pendingConfirm, candidates: cand?.candidates ?? null,
    ranked: cand?.ranked ?? null, filtered: cand?.filtered ?? null,
    geomType: final.geomType,
    note: "任务已落库并完成候选计算，状态=待派单；派单方式由用户在调度工作台人工选择（AI 不可派单）",
  });
});

dispatchApi.post("/tasks/:id/confirm", async (req, res) => {
  const ref = await pbResolveTask(req.params.id);
  if (!ref) return res.status(404).json({ error: 'task not found' });
  const t = await pbGet("tasks", ref.rid);
  if (!t) return res.status(404).json({ error: 'task not found' });
  if (t.status !== '待派单') return res.status(400).json({ error: `状态 ${t.status} 不可确认下发` });
  await pbUpdate("tasks", t.id, { pendingConfirm: 0 });
  await pbCreate("dispatchLog", { task: t.id, action: '人工确认下发', detail: req.body?.note ?? '人工确认下发任务', at: pbNow() });
  res.json({ ok: true, status: '已确认待派发' });
});

dispatchApi.post("/tasks", async (req, res) => {
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
  task.taskNo = pbTaskNo(await pbNextSeq("taskNo"));
  task.pendingConfirm = (task.source === '对话下单' || req.body?.source === '对话下单') ? 1 : 0;
  task.status = '待派单';
  task.createdAt = pbNow();
  task.oldId = await pbNextOldId();
  await pbCreate("tasks", task);
  res.json({ ...task, id: task.oldId, status: '待派单' });
});

// 批量建单（工程侧刚性入口）：格网测绘类任务一次 N 条，单事务原子落库。
// 解决「AI 说生成了 N 个任务但列表里一个都没有」——AI 文本输出不算数，
// 只有本接口返回的 created 数组才是事实。逐条返回 成功(taskId/taskNo)/失败(errors)
dispatchApi.post("/tasks/batch", async (req, res) => {
  const items = Array.isArray(req.body?.tasks) ? req.body.tasks : null;
  if (!items || items.length === 0) return res.status(400).json({ error: 'body 须为 {tasks:[...]}，至少 1 条' });
  if (items.length > 500) return res.status(400).json({ error: `单次上限 500 条（收到 ${items.length}），分批调用` });
  const created = [], failed = [];
  const ops = [];
  for (const b of items) {
    const task = {
      taskName: b.taskName || '未命名任务',
      source: b.source ?? '对话下单',
      targetName: b.targetName,
      targetType: b.targetType,
      geomType: b.geomType === 'area' ? 'polygon' : b.geomType,
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
    if (errors.length) { failed.push({ index: failed.length + created.length, targetName: b.targetName, errors }); continue; }
    task.taskNo = pbTaskNo(await pbNextSeq("taskNo"));
    task.pendingConfirm = (task.source === '对话下单') ? 1 : 0;
    task.status = '待派单';
    task.createdAt = pbNow();
    task.oldId = await pbNextOldId();
    ops.push({ table: "tasks", method: "POST", data: task, oldId: task.oldId });
  }
  if (ops.length) {
    const results = await pbBatch(ops);
    for (const r of results) {
      const t = r.op.data;
      if (r.ok) created.push({ id: t.oldId, taskNo: t.taskNo, targetName: t.targetName, status: '待派单', pendingConfirm: t.pendingConfirm });
      else failed.push({ index: failed.length + created.length, targetName: t.targetName, errors: [r.data?.message ?? 'PB 创建失败'] });
    }
  }
  res.json({ ok: failed.length === 0, requested: items.length, createdCount: created.length, failedCount: failed.length, created, failed });
});

// AI 建单联动：最近 3 分钟内由 AI 创建的任务（供工作台自动打开）
// CLI 版本对账（旧副本自愈：CLI 启动时对比，旧则提示 --self-update）
dispatchApi.get("/cli-version", (req, res) => {
  // 版本号从分发文件实时解析——单一事实源，杜绝"服务端版本号与分发副本不一致"
  try {
    const m = fs.readFileSync(path.join(process.cwd(), "client/dist/agent/dispatch_cli.py"), "utf8")
      .match(/CLI_VERSION\s*=\s*(\d+)/);
    res.json({ version: m ? +m[1] : 0 });
  } catch {
    res.json({ version: 0 });
  }
});

dispatchApi.get("/latest", async (req, res) => {
  const rows = await pbAll("tasks", { filter: "source='对话下单'", sort: "-oldId", fields: "id,oldId,createdAt" });
  const cutoff = Date.now() - 3 * 60000;
  const row = rows.find(r => r.createdAt && new Date(String(r.createdAt).replace(" ", "T") + "Z").getTime() >= cutoff);
  res.json({ taskId: row?.oldId ?? row?.id ?? null });
});

dispatchApi.get("/tasks", async (req, res) => {
  const { status, limit = 500 } = req.query;
  const r = await pbList("tasks", { filter: status ? `status='${status}'` : undefined, sort: "-oldId", limit: +limit });
  res.json(r.items.map(pbTaskRow));
});

dispatchApi.get("/tasks/:id", async (req, res) => {
  const ref = await pbResolveTask(req.params.id);
  if (!ref) return res.status(404).json({ error: 'task not found' });
  let t;
  try { t = await pbGet("tasks", ref.rid); }
  catch (e) { if (e.status === 404) return res.status(404).json({ error: 'task not found' }); throw e; }
  t.id = ref.oldId ?? ref.rid;
  t.geom = JSON.parse(t.geom ?? "{}");
  // P1-4 修复：任务详情也要带区域规划信息，供前端表单回显"这条任务覆盖什么区域、拆成几条带"
  if (t.geomType !== 'point' && t.geom?.coords) {
    try {
      const ap = planTaskArea({ geomType: t.geomType, geom: JSON.stringify(t.geom) }, 12);
      if (ap) t.areaPlan = {
        scale: ap.scaleLabel, strategy: ap.policy.note, stripCount: ap.stats.stripCount,
        direction: ap.direction, areaKm2: ap.stats.polygonAreaKm2,
        redundancyPct: ap.stats.redundancyPct,
        bboxKm: { width: ap.stats.widthKm, height: ap.stats.heightKm },
        swathKm: ap.stats.swathKm, overlapPct: +(ap.policy.overlapRate * 100).toFixed(1),
      };
    } catch {}
  }
  if (!t.createdAt) t.createdAt = "0000-00-00 00:00:00";
  // rankings：旧 SQL 为 rankings JOIN candidates（候选字段平铺），PB 侧用 expand=candidate 组装
  const ranked = await pbList("rankings", { filter: `task='${ref.rid}'`, sort: "rank", limit: 30, expand: "candidate" });
  t.rankings = ranked.items.map(r => {
    const c = r.expand?.candidate ?? {};
    const { expand: _e, collectionId: _c, collectionName: _n, task: _t, ...row } = r;
    return {
      ...row, id: r.oldId ?? r.id, taskId: ref.oldId ?? ref.rid, candidateId: c.oldId ?? null,
      satName: c.satName, company: c.company,
      wStart: c.windowStart, wEnd: c.windowEnd, overpassTime: c.overpassTime,
      slewDeg: c.slewDeg, availability: c.availability, cloudFc: c.cloudFc, cloudSource: c.cloudSource,
      orbitGrade: c.orbitGrade, stripIdx: c.stripIdx, stripCount: c.stripCount, minDistKm: c.minDistKm,
      imgWinStart: c.imgWinStart, imgWinEnd: c.imgWinEnd, sunElDeg: c.sunElDeg,
    };
  });
  t.rankings.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const ords = await pbAll("orders", { filter: `task='${ref.rid}'`, sort: "-oldId" });
  t.orders = ords.map(pbRelRow);
  const plans = await pbAll("directPlans", { filter: `task='${ref.rid}'`, sort: "-oldId" });
  t.directPlans = plans.map(pbRelRow);
  res.json(t);
});

// 数据重置（工程侧管理端点）：清空全部业务流水（订单/方案/候选/排序/池/日志/履约），保留卫星/公司基础表
// 数据重置（工程侧管理端点）：清空全部业务流水（订单/方案/候选/排序/池/日志/履约），保留卫星/公司基础表
dispatchApi.post("/_pb-setup", async (req, res) => {
  try {
    const { runSetup } = await import('./pb_setup.mjs');
    const r = await runSetup();
    res.json({ ok: true, summary: r.summary });
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 300) }); }
});
dispatchApi.get("/_pb-peek", async (req, res) => {
  try {
    const { table, oldId } = req.query;
    if (!table || !oldId) return res.status(400).json({ error: 'table & oldId 必填' });
    const r = await pbList(table, { filter: `oldId=${parseInt(oldId)}`, limit: 5, fields: 'id,oldId,taskNo,taskName,status' });
    res.json(r.items);
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});
dispatchApi.get("/_pbq", async (req, res) => {
  // CLI v7 的 q() 通道：PB 只读代理（线上 PB 仅容器内可见，外部 CLI 无法直连）
  const { table, filter, sort, perPage, expand, fields, page } = req.query;
  const ALLOW = new Set(["tasks", "candidates", "rankings", "orders", "directPlans", "companies", "fulfillmentLog", "taskPool", "dispatchLog", "missions", "satellites"]);
  if (!ALLOW.has(table)) return res.status(400).json({ error: 'collection 不在白名单: ' + table });
  try {
    const p = new URLSearchParams();
    if (filter) p.set('filter', filter);
    if (sort) p.set('sort', sort);
    p.set('perPage', perPage || '200');
    p.set('page', page || '1');
    if (expand) p.set('expand', expand);
    if (fields) p.set('fields', fields);
    const r = await pbList(table, Object.fromEntries(p));
    res.json({ items: r.items, totalItems: r.total, page: r.page, totalPages: Math.ceil((r.total||0)/(parseInt(perPage)||200)) });
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});
dispatchApi.get("/_pb-schema", async (req, res) => {
  try {
    const PB = process.env.PB_URL || 'http://127.0.0.1:8091';
    const auth = await fetch(PB + '/api/collections/_superusers/auth-with-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: process.env.PB_ADMIN || 'admin@sat.local', password: process.env.PB_PASS || 'SatDispatch2026!' }) }).then(r => r.json());
    const cols = await fetch(PB + '/api/collections', { headers: { Authorization: auth.token } }).then(r => r.json());
    const arr = cols.items || cols;
    const out = {};
    for (const name of ['tasks', 'candidates', 'rankings', 'orders', 'directPlans', 'counters']) {
      const c = arr.find(x => x.name === name);
      out[name] = c ? c.fields.map(f => f.name + ':' + f.type).join(',') : 'MISSING';
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});
dispatchApi.get("/_pb-schema", async (req, res) => {
  try {
    const PB = process.env.PB_URL || 'http://127.0.0.1:8091';
    const auth = await fetch(PB + '/api/collections/_superusers/auth-with-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: process.env.PB_ADMIN || 'admin@sat.local', password: process.env.PB_PASS || 'SatDispatch2026!' }) }).then(r => r.json());
    const cols = await fetch(PB + '/api/collections', { headers: { Authorization: auth.token } }).then(r => r.json());
    const arr = cols.items || cols;
    const out = {};
    for (const name of ['tasks', 'candidates', 'rankings', 'orders', 'directPlans', 'counters']) {
      const c = arr.find(x => x.name === name);
      out[name] = c ? c.fields.map(f => f.name + ':' + f.type).join(',') : 'MISSING';
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message.slice(0, 200) }); }
});
dispatchApi.post("/_cleanup", async (req, res) => {
  if (req.headers['x-operator'] !== 'human') return res.status(403).json({ error: '仅工作台人工通道可用' });
  const cleared = {};
  for (const table of ["rankings", "candidates", "orders", "directPlans", "taskPool", "dispatchLog", "fulfillmentLog", "tasks"]) {
    try {
      const all = await pbAll(table, { fields: "id" });
      for (const rec of all) await pbDelete(table, rec.id);
      cleared[table] = all.length;
    } catch (e) {
      cleared[table] = "err: " + e.message.slice(0, 80);
    }
  }
  res.json({ ok: true, cleared });
});

dispatchApi.delete("/tasks/:id", async (req, res) => {
  const ref = await pbResolveTask(req.params.id);
  if (ref) {
    // 级联清理：candidates / rankings / orders / directPlans 四处关联记录先查后删
    for (const table of ["candidates", "rankings", "orders", "directPlans"]) {
      try {
        const rel = await pbAll(table, { filter: `task='${ref.rid}'`, fields: "id" });
        for (const rec of rel) await pbDelete(table, rec.id);
      } catch (e) {
        console.error(`[delete] 级联清理 ${table} 失败: ${e.message.slice(0, 120)}`);
      }
    }
    await pbDelete("tasks", ref.rid);
  }
  res.json({ ok: true });
});

// ─── 候选卫星计算（4.3）──────────────────────────────────────────────────
dispatchApi.post("/tasks/:id/candidates", async (req, res) => {
  const ref = await pbResolveTask(req.params.id);
  const task = ref ? await pbGet("tasks", ref.rid) : null;
  if (!task) return res.status(404).json({ error: 'task not found' });
  if (task.createdAt && !task.createdAt.includes("T")) task.createdAt = task.createdAt.replace(" ", "T") + "Z";

  const opts = {
    windowStart: task.windowStart, windowEnd: task.windowEnd,
    maxSlewDeg: task.maxSlewDeg || 45, // PB number 未设读回 0（SQLite 有 DEFAULT 45，PB 没有）——0 会让可见半径归零、候选全空
    minElevSunDeg: 10,
  };
  const tCreated = new Date(task.createdAt);

  // 候选卫星范围：观测类型匹配的卫星（SAR任务只看SAR卫星，反之光学）
  const wantSar = task.obsType === 'sar';
  const allSats = (await pbAll("satellites", { filter: "decayed=0" }))
    .filter(s => wantSar
      ? s.subCategory === 'sar'
      : ['optical', 'staring', 'hyperspectral'].includes(s.subCategory));
  // 候选范围：默认只取中国卫星（2026-11-15 按业务口径收紧）。
  // 历史行为：仅应急任务筛中国星，普通任务把 Sentinel/Pleiades/WorldView 等外国星也纳入候选，
  // 导致候选清单一堆境外星、且它们无法走国内测控与派单交付。
  const scope = allSats.filter(s => s.country === '中国');

  // ── 条带宽度自适应（2026-11-15 修复：固定 12km 会显著高估条带数）────────────
  // 旧实现一律按 12km 幅宽切条带：30×30km 区域切成 4 条带，
  // 而实际可用的 GF-1（60km 幅宽）一颗就够 1 条带。
  // 新做法：取「满足任务分辨率要求的卫星里最大幅宽」，作为切分幅宽，
  // 上限不超过区域短边的 1.2 倍（避免幅宽远大于目标导致过度覆盖）。
  const taskRes = Number(task.resolution) || 2;
  let swathForPlan = 12;
  try {
    const caps = scope.map(s => getCapability(s)).filter(c => c.resolution <= taskRes * 1.2);
    const maxSwath = caps.length ? Math.max(...caps.map(c => c.swathKm)) : 12;
    const geomObj = JSON.parse(task.geom ?? "{}");
    if (task.geomType !== 'point' && Array.isArray(geomObj.coords)) {
      const lats = geomObj.coords.map(c => c[0]), lons = geomObj.coords.map(c => c[1]);
      const spanKm = Math.min(
        Math.abs(Math.max(...lats) - Math.min(...lats)) * 111,
        Math.abs(Math.max(...lons) - Math.min(...lons)) * 111 * Math.cos(geomObj.coords[0][0] * Math.PI / 180)
      );
      // 条带宽度口径（2026-11-16 定稿）：
      //   · 宽度 = 满足任务分辨率的卫星中「**最小**幅宽」，而不是最大幅宽。
      //   理由：条带是给"任意一颗能接单的星"用的公共划分。若按最大幅宽（如 60km）切，
      //   则窄幅星（12km）根本无法覆盖一个 60km 宽带，只能拍中段；
      //   按最小幅宽切，宽带星可以一次覆盖多条带（它的幅宽是条带的整数倍），
      //   窄幅星也能正好覆盖一条带——这是"向下兼容"的安全划分。
      //   · 长度上限 100km 由规划器负责分段。
      const minSwath = caps.length ? Math.min(...caps.map(c => c.swathKm)) : 12;
      swathForPlan = Math.max(12, Math.min(minSwath, Math.max(12, spanKm)));
    }
  } catch {}
  const strips = normalizeTaskStrips(task, swathForPlan);
  const areaPlan = task.geomType === 'point' ? null : planTaskArea(task, swathForPlan);

  // PB 迁移：旧候选先清后写（batch 原子删除），新候选用 pbBatch 批量插入
  const oldCands = await pbAll("candidates", { filter: `task='${ref.rid}'`, fields: "id" });
  await pbBatch(oldCands.map(c => ({ table: "candidates", method: "DELETE", recordId: c.id })));

  const winStartT = new Date(task.windowStart).getTime();
  const leadDays = Math.max(0, (winStartT - tCreated.getTime()) / 86400000);
  let inserted = 0, filtered = 0;
  const gapStats = {}; // 能力缺口统计
  const candOps = [];  // 候选批量插入（含被筛除行，诊断口径与旧版一致）

  // ── 候选总量控制（2026-11-15 修复 P0-1）────────────────────────────────
  // 旧实现：全局 inserted>200 就三层 break，导致后面的条带完全不被解算，
  //   北京全域 21 条带只算前 7 条、全国 640 条带只算 34 条，却返回 ok。
  // 新实现：按条带分配配额，保证**每条带都至少被解算**（先跑完覆盖面），
  //   总条数超限时按「每条带保留最优若干候选」收敛，并在响应里明确标注是否截断。
  const TOTAL_CAP = 6000;              // 总候选硬上限（防止全国任务写爆库）
  const perStripCap = Math.max(3, Math.floor(TOTAL_CAP / Math.max(1, strips.length)));
  const passPerStrip = new Map();      // stripIdx -> 已插入通过数
  const totalCandidatesHardCap = TOTAL_CAP * 3; // 含被筛除行的总行数上限
  let truncatedEarly = false;

  for (const sat of scope) {
    const cap = getCapability(sat);
    const company = sat.operator || sat.country;
    let anyInserted = false;
    // 一次轨迹采样 → 该星对所有条带的粗窗（性能关键）：
    // 旧写法每条带各跑一遍 7 天轨道采样，21 条带 × 131 星 会重复 2751 次，
    // 单任务耗时 >400s 直接拖死请求。
    const coarseByStrip = coarseWindowsAllStrips(sat, strips, opts);
    if (!coarseByStrip.size) continue;
    for (const strip of strips) {
      const coarseList = coarseByStrip.get(strip.idx);
      if (!coarseList || !coarseList.length) continue;
      const windows = refineStripWindows(sat, strip, coarseList, opts);
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
        candOps.push({ table: "candidates", data: {
          task: ref.rid,
          stripIdx: strip.idx, stripCount: strip.count, satNoradId: sat.noradId, satName: sat.name, company,
          windowStart: new Date(w.start).toISOString(), windowEnd: new Date(w.end).toISOString(),
          overpassTime: overpass.toISOString(), slewDeg: Math.round(w.slewDeg * 10) / 10,
          availability: Math.round(availability * 10) / 10, cloudFc: Math.round(cloud * 1000) / 1000,
          orbitGrade: '高', filtered: pass ? 0 : 1, filterReason: pass ? "" : reasons.join('；'),
          validRes: Math.round(validRes * 100) / 100, cloudSource: cloudSrc,
          sunElDeg: Math.round(solarElevationDegFor(strip.lat, strip.lon, overpass) * 10) / 10,
          minDistKm: Math.round(w.minDistKm * 10) / 10,
          imgWinStart: w.imgWinStart ? new Date(w.imgWinStart).toISOString() : "",
          imgWinEnd: w.imgWinEnd ? new Date(w.imgWinEnd).toISOString() : "",
          stripCoverage: w.stripCoverage ?? 1,
        } });
        if (pass) {
          // 每条带的通过候选不超过配额；超配额仍可落库用于诊断，但不计入通过数
          const cur = passPerStrip.get(strip.idx) ?? 0;
          if (cur < perStripCap) { inserted++; passPerStrip.set(strip.idx, cur + 1); }
        }
        anyInserted = true;
        // 只限制总行数（含筛除诊断行），不再按通过数截断整个条带循环
        if (candOps.length >= totalCandidatesHardCap) { truncatedEarly = true; break; }
      }
      if (truncatedEarly) break;
    }
    if (truncatedEarly) break;
  }

  // 候选落库（pbBatch 批量插入；响应仍返回旧口径数字）
  await pbBatch(candOps);
  const taskNumId = ref.oldId ?? ref.rid; // 响应兼容：旧版此字段为 SQLite 数字 id

  // 优先级计算（4.4）联动：候选已落 PB，rankTaskPB 按任务回读打分并写 rankings
  const ranked = await rankTaskPB(ref.rid, task);

  // ── 初始规划诊断（4.3.1）：所有候选都拍不到时，在建单/派单前就告诉用户「规划有问题」──
  // 问题不在解算环节，而在上游：时窗/分辨率/目标口径定错了。这里归因并给可执行修正建议
  // 诊断查全任务所有条带（SENTINEL 这类幅宽可覆盖但被分辨率筛掉的候选可能在任意条带）
  const diagRows = await pbAll("candidates", { filter: `task='${ref.rid}'` });
  const passingRows = diagRows.filter(r => r.filtered === 0);
  const coverableRows = passingRows.filter(r => r.imgWinStart && r.imgWinEnd);
  let planningDiagnosis = null;
  // P1-3 修复：原本只有"有候选但都拍不到"才诊断；"0 条通过"时反而静默。
  // 改为两种情况都给诊断，只是归因不同。
  if (passingRows.length === 0) {
    const reasons = {};
    for (const r of diagRows.filter(r => r.filtered === 1)) {
      for (const part of (r.filterReason || '').split('；')) {
        const k = part.split('：')[0];
        if (k) reasons[k] = (reasons[k] ?? 0) + 1;
      }
    }
    const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
    // 区分两种 0 候选：
    // ① diagRows 有行但全被约束筛掉（云量/分辨率/侧摆不满足）
    // ② diagRows 为空——粗筛阶段就没有任何「星-条带」有可见机会（时窗内无过顶/夜间/超范围）
    const noPassAny = diagRows.length === 0;
    planningDiagnosis = {
      level: 'NO_CANDIDATE',
      summary: noPassAny
        ? `时窗内 ${scope.length} 颗候选星对 ${strips.length} 条带均无可见过顶——不是约束太严，而是这个时间窗几何上拍不到`
        : `共解算 ${diagRows.length} 条候选记录，全部被约束筛除——当前参数下没有任何一条可执行`,
      attribution: topReasons.length
        ? `主要筛除原因：${topReasons.slice(0, 3).map(([k, v]) => `${k}×${v}`).join('、')}`
        : `时窗内无可见过顶：${strips.length} 条带 × ${scope.length} 颗星均无机会（重访间隙、夜间光照不足，或目标超出侧摆可达范围）`,
      preScreenEmpty: noPassAny,
      suggestions: noPassAny
        ? ['把时间窗扩大到 ≥3 天再算（当前窗太窄，落在重访间隙里）',
           '若必须在该时刻成像，改用 GEO 凝视星或 SAR（不受光照限制）',
           '确认目标坐标是否正确（可先用 dispatch weather <lat> <lon> 核实该点云量/光照）']
        : ['按上面的筛除原因针对性放宽（云量上限 / 分辨率档位 / 时间窗长度）',
           '或改用 SAR（不受云量与光照限制）',
           '或扩大时间窗至 ≥7 天，给更多过顶机会'],
      reasonBreakdown: reasons,
    };
  } else if (passingRows.length > 0 && coverableRows.length === 0) {
    // 排序非空但 0 颗幅宽可覆盖：全部候选都拍不到目标，问题在初始规划
    const passed = diagRows.filter(r => r.imgWinStart && r.imgWinEnd && r.filtered === 1);
    const best = [...passingRows].filter(r => r.minDistKm != null).sort((a, b) => a.minDistKm - b.minDistKm)[0];
    const minDists = passingRows.filter(r => r.minDistKm != null).map(r => r.minDistKm);
    const bestDist = minDists.length ? Math.min(...minDists) : null;
    // 归因：若被筛掉的候选里有幅宽可覆盖的 → 是硬约束（分辨率/时效）把能拍的星筛掉了；
    // 否则 → 时窗内所有可用星过顶都离目标太远（时窗错/目标位置错/需要更宽幅）
    const filteredButCoverable = diagRows.filter(r => r.imgWinStart && r.imgWinEnd && r.filtered === 1);
    const reasons = {};
    for (const r of diagRows.filter(r => r.filtered === 1)) {
      for (const part of (r.filterReason || '').split('；')) {
        const k = part.split('：')[0];
        if (k) reasons[k] = (reasons[k] ?? 0) + 1;
      }
    }
    planningDiagnosis = {
      level: 'PLANNING_FATAL',
      summary: `候选排序 ${passingRows.length} 条中 0 颗卫星幅宽可覆盖目标——按当前任务参数，没有任何一颗星能拍到，问题在初始规划而非解算环节`,
      attribution: filteredButCoverable.length > 0
        ? `有 ${filteredButCoverable.length} 条候选幅宽可覆盖但被约束筛掉（${Object.entries(reasons).slice(0,3).map(([k,v])=>`${k}×${v}`).join('、')}）→ 约束条件定得太严，放宽即可拍到`
        : bestDist != null
          ? `时窗内过顶的卫星全部离目标太远（最近 ${Math.round(bestDist*10)/10}km，最小幅宽半宽 ~7km）→ 时窗选择错误或目标位置/口径有问题，放宽约束也拍不到`
          : '时窗内无过顶窗口 → 时窗选错了（可能落在卫星重访间隙或夜间）',
      bestCandidate: best ? { satName: best.satName, company: best.company, minDistKm: Math.round(best.minDistKm*10)/10, imgWinCovered: !!(best.imgWinStart && best.imgWinEnd) } : null,
      suggestions: filteredButCoverable.length > 0
        ? ['查看被筛候选的 filterReason（候选列表中被筛掉的行），针对性放宽分辨率/时效/云量上限', '或改用观测类型/分辨率档位更匹配的星座（如宽幅星）重新建单']
        : bestDist != null && bestDist < 100
          ? ['把时间窗扩大到 ±3 天重新计算候选（当前时窗内过顶几何不可行）', '或改派 SAR（SAR 幅宽更大且不受云量限制）', '或确认目标位置/面目标范围口径是否正确']
          : ['扩大时间窗（建议 ≥3 天）重新计算候选', '确认目标位置是否正确——当前时窗内过顶几何上不可能拍到', '考虑降低分辨率要求改用宽幅星（幅宽 30km+）'],
    };
  }

  // ── 覆盖计划汇总（2026-11-15 修复 P0-2）──────────────────────────────
  // 旧版把条带规划算出来了却不告诉用户"覆盖了多少"，导致 21 条带只覆盖 7 条
  // 也被当作成功。这里按条带统计：有可用候选=已排程，无=缺口，并明确给出覆盖率。
  let coveragePlan = null;
  let coverageWarning = null;
  // 点目标没有 areaPlan，但也要走多星分派（否则点目标永远只能用第一颗星）
  if (strips.length > 0) {
    const byStrip = new Map();
    for (const r of passingRows) {
      const si = r.stripIdx ?? 0;
      if (!byStrip.has(si) || (r.minDistKm != null && r.minDistKm < (byStrip.get(si).minDistKm ?? 1e9))) {
        byStrip.set(si, { idx: si, satName: r.satName, overpass: r.overpassTime, minDistKm: r.minDistKm,
                          slewDeg: r.slewDeg, imgWin: !!(r.imgWinStart && r.imgWinEnd),
                          stripCoverage: r.stripCoverage ?? 1 });
      }
    }
    // 只有「通过约束且幅宽/侧摆可覆盖」才算真正覆盖该条带
    // 覆盖统计口径（2026-11-16 改为网格点法实测覆盖率）：
    //   full(≥99%)  → 计入「已覆盖」
    //   high(85~99%) → 计入「已覆盖」，但记 warning（可拼接、需补缝）
    //   partial/fragment → 计入「部分覆盖」，明确列出实际覆盖率与缺口公里数
    //   旧口径只认 ≥0.99，会把 81% 的条带直接判死；现在按等级区分，信息更完整。
    const all = [...byStrip.values()].filter(a => a.imgWin);
    const assigned = all.filter(a => (a.stripCoverage ?? 1) >= 0.85);
    const partialStrips = all.filter(a => (a.stripCoverage ?? 1) >= 0.5 && (a.stripCoverage ?? 1) < 0.85)
      .map(a => ({ idx: a.idx, coveragePct: +((a.stripCoverage ?? 0) * 100).toFixed(1),
                    gapKm: a.stripCoverageDetail?.maxGapKm ?? null }));
    // 点目标（areaPlan=null）用合成的 plan 对象走同一套汇总逻辑
    const planForSummary = areaPlan ?? {
      scaleLabel: '点目标', policy: { note: '单点成像，单条带' },
      strips: strips.map(st => ({ idx: st.idx })), direction: null,
    };
    coveragePlan = summarizeCoveragePlan(planForSummary, assigned);
    coveragePlan.partialStrips = partialStrips;
    coveragePlan.coverageMethod = 'grid-point (网格粒度=幅宽/8)';

    // ── 多星协同分派（2026-11-16 新增，任务规划核心能力）──────────────────
    // 任务规划的本质不是"让一颗星干完"，而是：判断要不要拆单 → 把条带分给多颗星。
    // 依据集合覆盖模型（Perea 2015 IEEE TAES / CN115659556A / Chen 2020 RS）：
    //   目标 = 最大化覆盖率，同时尽量少用卫星；贪心选取"单位资源增益最高"的分配。
    try {
      const candByStrip = new Map();
      for (const r of passingRows) {
        const si = r.stripIdx ?? 1;
        if (!candByStrip.has(si)) candByStrip.set(si, []);
        const stDef = strips.find(x => x.idx === si);
        candByStrip.get(si).push({
          satName: r.satName, satNoradId: r.satNoradId, company: r.company,
          overpass: r.overpassTime, slewDeg: r.slewDeg,
          stripCoverage: r.stripCoverage, imgWinStart: r.imgWinStart, imgWinEnd: r.imgWinEnd,
          // 字段名必须是 stripLengthKm —— 分派器读的是 picked.lengthKm / strip.lengthKm，
          // 而 candidates 侧此前只写了 lengthKm，导致恒取兜底 60km，
          // 成像时长约束用错长度、超载簇没被裁掉（第五轮验收 P0-1）。
          lengthKm: stDef?.lengthKm ?? 60,
          stripLengthKm: stDef?.lengthKm ?? 60,
        });
      }
      // 点目标没有 start/end（只有中心点坐标），这里补成同点，避免下游解构 undefined 抛错
      // （曾导致点目标 candidates 稳定 503 "undefined is not iterable"）
      const allStrips = strips.map(st => {
        const lat = st.lat ?? st.start?.[0] ?? 0;
        const lon = st.lon ?? st.start?.[1] ?? 0;
        return {
          idx: st.idx,
          widthKm: st.widthKm ?? swathForPlan,
          lengthKm: st.lengthKm ?? 0,
          start: st.start ?? [lat, lon],
          end: st.end ?? [lat, lon],
        };
      });
      const split = shouldSplitOrder(allStrips, candByStrip, { minCoverage: 0.85 });
      const multi = dispatchAcrossSatellites(allStrips, candByStrip, { minCoverage: 0.85 });
      // 持久化分派方案供派单复用（第五轮 P0-2：派单曾自己重算，输入口径不同导致 0% 一致）
      try {
        await pbUpdate("tasks", ref.rid, { multiPlan: JSON.stringify(multi.assignments.map(a => ({
          stripIdx: a.stripIdx, satName: a.satName, company: a.company,
          overpass: a.overpass, slewDeg: a.slewDeg, coverage: a.coverage,
        }))) });
      } catch (e) { console.error('[multi-plan] 持久化失败:', e.message); }

      coveragePlan.multiSatellite = {
        needSplit: split.needSplit,
        splitReason: split.reason,
        bestSingleSat: split.bestSingleSat,
        bestSingleCovered: split.bestSingleCovered,
        satelliteCount: multi.stats.satelliteCount,
        satellites: multi.satellites,
        coveragePct: multi.coverage.coveragePct,
        assignedStrips: multi.coverage.assignedStrips,
        totalStrips: multi.coverage.totalStrips,
        areaCoveredKm2: multi.coverage.areaCoveredKm2,
        spanDays: multi.stats.spanDays,
        gaps: multi.gaps.slice(0, 30),
        // 口径说明：multiSatellite.coveragePct 是「按可执行分派方案实际排进去的条带占比」，
        // 而 coveragePlan.coveragePct 是「有可用候选的条带占比」。
        // 前者才是真实可交付的覆盖率，统一以后者为准（见下方 authoritativeCoverage）。
        authoritative: true,
        assignments: multi.assignments.map(a => ({
          stripIdx: a.stripIdx, satName: a.satName, company: a.company,
          overpass: a.overpass, slewDeg: a.slewDeg,
          coveragePct: +(a.coverage * 100).toFixed(1), grade: a.grade,
          // 审计字段：让前端/验收能自行复核成像时长与窗口约束
          stripLengthKm: a.stripLengthKm ?? null,
          stripWidthKm: a.stripWidthKm ?? null,
          imagingSec: +((a.stripLengthKm ?? 60) / 6.83).toFixed(1),
          imgWinStart: a.imgWinStart ?? null,
          imgWinEnd: a.imgWinEnd ?? null,
        })),
      };
      // 统一覆盖率口径（修复 F4：同一响应出现 44.1% / 30.5% / 96.6% 三个数）
      // 以「分派方案实际排进去的条带数」为准，其余口径全部对齐。
      const ms = coveragePlan.multiSatellite;
      coveragePlan.coveragePctCandidate = coveragePlan.coveragePct;      // 保留旧口径备查
      coveragePlan.coveragePct = ms.coveragePct;                          // 对外唯一口径
      coveragePlan.scheduled = ms.assignedStrips;
      coveragePlan.unscheduled = ms.totalStrips - ms.assignedStrips;
      coveragePlan.coverageBasis = '按多星分派方案实际可执行条带数';
      // 用分派方案覆盖旧的 gaps / partialStrips（修复：旧逻辑说 33 条"无可用过顶"，
      // 而这些条带在分派方案里已 100% 分派，两套结论互相矛盾）。
      coveragePlan.gaps = ms.gaps ?? [];
      coveragePlan.partialStrips = [];
      coveragePlan.legacyNote = 'gaps/partialStrips 已与 multiSatellite 方案对齐';
    } catch (e) {
      console.error('[multi-dispatch] 分派失败:', e.message);
    }
    if (coveragePlan.coveragePct < 100) {
      coverageWarning = {
        level: coveragePlan.coveragePct === 0 ? 'NONE_COVERED' : 'PARTIAL',
        message: coveragePlan.coveragePct === 0
          ? `本任务 ${coveragePlan.totalStrips} 条带中无一条带存在可用过顶，无法完成区域覆盖`
          : `本任务 ${coveragePlan.totalStrips} 条带中仅 ${coveragePlan.scheduled} 条有可用过顶（覆盖率 ${coveragePlan.coveragePct}%），` +
            `剩余 ${coveragePlan.unscheduled} 条带覆盖缺口，请扩大时窗/增加星座/降低分辨率后重算`,
        gaps: (coveragePlan.gaps ?? []).slice(0, 20),
        suggestion: coveragePlan.coveragePct < 30
          ? '建议改用多星多期方案（拉长时窗至 30~60 天，或加入宽幅星座），单星单窗无法完成'
          : '建议扩大时窗或允许更多卫星参与，补齐剩余条带',
      };
    }
  }
  if (truncatedEarly) {
    coverageWarning = { ...(coverageWarning ?? {}), truncated: true,
      truncationNote: `候选行数达上限（${totalCandidatesHardCap}），部分条带候选未完整解算，实际覆盖可能低于统计值` };
  }

  res.json({
    taskId: taskNumId, strips: strips.length, candidates: inserted, filtered, ranked, gapStats, planningDiagnosis,
    coveragePlan, coverageWarning,
    // 覆盖计划：把"测哪个区域、拆成几条带、沿什么方向、重叠多少"直接返回给调用方
    areaPlan: areaPlan ? {
      scale: areaPlan.scaleLabel,
      strategy: areaPlan.policy.note,
      stripCount: areaPlan.stats.stripCount,
      direction: areaPlan.direction,
      areaKm2: areaPlan.stats.polygonAreaKm2,
      stripAreaKm2: areaPlan.stats.totalStripAreaKm2,
      redundancyPct: areaPlan.stats.redundancyPct,
      bboxKm: { width: areaPlan.stats.widthKm, height: areaPlan.stats.heightKm },
      swathKm: areaPlan.stats.swathKm,
      stepKm: areaPlan.stats.stepKm,
      overlapPct: +(areaPlan.policy.overlapRate * 100).toFixed(1),
      strips: areaPlan.strips.map(st => ({
        idx: st.idx, center: [st.lat, st.lon], start: st.start, end: st.end,
        widthKm: st.widthKm, lengthKm: st.lengthKm, areaKm2: st.areaKm2,
        azimuthDeg: st.azimuthDeg, overlapPct: st.overlapPct,
      })),
    } : null,
  });
});

// 任务级侧摆上限（缺省 45°）
function policyMaxSlew() { return 45; }

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

dispatchApi.post("/tasks/:id/dispatch", async (req, res) => {
  const ref = await pbResolveTask(req.params.id);
  const task = ref ? await pbGet("tasks", ref.rid) : null;
  if (!task) return res.status(404).json({ error: 'task not found' });

  // rankings JOIN candidates → PB relation+expand（candidate 被筛的不取，rank 升序）
  const rankRes = await pbList("rankings", { filter: `task='${ref.rid}'`, sort: "rank", limit: 500, expand: "candidate" });
  const ranking = rankRes.items
    .filter(r => (r.expand?.candidate?.filtered ?? 1) === 0)
    .map(r => {
      const c = r.expand.candidate;
      return {
        id: r.oldId ?? r.id, taskId: ref.oldId ?? ref.rid, candidateId: c.oldId ?? c.id, rank: r.rank,
        Q: r.Q, R: r.R, C: r.C, S: r.S, Qdetail: r.Qdetail, Rdetail: r.Rdetail, Cdetail: r.Cdetail,
        satName: c.satName, company: c.company, satNoradId: c.satNoradId, overpassTime: c.overpassTime,
        windowStart: c.windowStart, windowEnd: c.windowEnd, availability: c.availability,
        minDistKm: c.minDistKm, imgWinStart: c.imgWinStart, imgWinEnd: c.imgWinEnd, sunElDeg: c.sunElDeg,
        // 条带号直接取自展开的候选记录（rankings 表本身没有该字段，靠回查容易失败）
        stripIdx: c.stripIdx ?? 1,
        stripCoverage: c.stripCoverage ?? 1,
      };
    })
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  if (ranking.length === 0) return res.status(400).json({ error: '无可用候选，请先执行候选计算' });
  if (task.pendingConfirm) return res.status(400).json({ error: '任务待人工确认下发，请先在工作台点击「确认下发」' });

  // 工程侧加固：派单只接受工作台人工操作（X-Operator: human 头）。
  // CLI/AI 通道的派单调用一律 403——大模型遵循 skill 指令不稳，能力在工程侧物理断掉。
  if (req.headers['x-operator'] !== 'human') {
    return res.status(403).json({ error: '派单仅限调度工作台人工操作（工程侧加固）。AI/CLI 无派单权限，请引导用户在工作台任务详情点「派给公司」或「生成直控任务指令」。' });
  }
  // 人工指定通道优先：前端「派给公司」传 channel=公司通道，「生成直控指令」传 channel=直控；
  // 未指定时走 R1~R6 自动判定
  const manualChannel = req.body?.channel;
  let { channel, rule } = manualChannel
    ? { channel: manualChannel, rule: `人工指定通道（覆盖自动判定）` }
    : decideChannel(task, ranking);

  if (channel === '直控') {
    // R1 应急 → 创建直控执行方案（待值班确认）
    // 初始规划守门：0 颗候选幅宽可覆盖 → 拒建注定失败的方案，把问题挡在上游。
    // forcePlanning=true 可人工强行建（明确知道拍不到仍要占轨，如占用过顶弧段做别的用途）
    const coverable = ranking.filter(r => r.imgWinStart && r.imgWinEnd);
    if (coverable.length === 0 && !req.body?.forcePlanning) {
      const best = [...ranking].filter(r => r.minDistKm != null).sort((a, b) => a.minDistKm - b.minDistKm)[0];
      return res.status(422).json({
        error: `初始规划问题：候选排序 ${ranking.length} 条中 0 颗卫星幅宽可覆盖目标，直控方案必然校验驳回。` +
          (best?.minDistKm != null
            ? `最近候选 ${best.satName} 过顶距目标 ${Math.round(best.minDistKm)}km（远超幅宽半宽）。`
            : '') +
          ` 请扩大时间窗重新计算候选、改用 SAR/宽幅星，或确认目标位置与分辨率口径后再派单。` +
          ` 如确要强行建单（明知拍不到仍占用弧段），传 forcePlanning=true。`,
        planningFatal: true,
        candidatesTotal: ranking.length,
      });
    }
    // top 候选优选"幅宽可覆盖"（imgWin 非空）的，排序分相同前提下拍到 > 拍不到
    const top = ranking.find(r => r.imgWinStart && r.imgWinEnd) ?? ranking[0];
    const newPlanOldId = await pbNextOldId("directPlans");
    const [planRec] = await pbBatch([
      { table: "directPlans", oldId: newPlanOldId, data: { oldId: newPlanOldId, task: ref.rid, satNoradId: top.satNoradId, satName: top.satName, company: top.company,
        windowStart: top.windowStart, windowEnd: top.windowEnd, overpassTime: top.overpassTime,
        imgWinStart: top.imgWinStart ?? "", imgWinEnd: top.imgWinEnd ?? "", minDistKm: top.minDistKm ?? 0, status: '待确认' } },
      { table: "tasks", method: "UPDATE", recordId: ref.rid, data: { status: '直控执行中' } },
    ]);
    if (!planRec?.ok) return res.status(500).json({ error: '直控方案落库失败', detail: planRec?.data });
    return res.json({ channel, rule, planId: newPlanOldId, topRank: top });
  }

  // 普通通道（PB 迁移：订单/任务状态/派发留痕/询价单批量在 pbBatch 内一次性提交，原子性同旧事务）
  const orderNo = `PO-${pbYmd()}-${String(await pbNextSeq("orderNo")).padStart(3, "0")}`;
  // ── 按条带分派（2026-11-15 修复 P0-3）──────────────────────────────────
  // 旧实现只用 ranking[0] 出一张订单：21 条带的任务也只派 1 条带，
  // 其余 20 条带无人承接却把任务置为"已派发"（静默丢覆盖）。
  // 新实现：每个「有可用候选」的条带各出一张订单（各自选最优候选），
  //   未被覆盖的条带明确列在响应里，任务状态按是否全覆盖区分。
  // rankings 表本身没有 stripIdx 字段（它只有 task/candidate/rank/Q/R/C/S），
  // 条带号在 candidates 表里。必须按 candidateId 回查，否则所有候选都会被归到第 1 条带，
  // 导致 21 条带的任务只出 1 张订单（P0-3 复测未通过的直接原因）。
  const candRows = await pbAll("candidates", { filter: `task='${ref.rid}'`, fields: "id,oldId,stripIdx" });
  const stripById = new Map();
  for (const c of candRows) {
    stripById.set(c.id, c.stripIdx ?? 1);
    if (c.oldId != null) stripById.set(c.oldId, c.stripIdx ?? 1);
  }
  // ── 派单必须按「多星协同分派方案」执行（2026-11-16 修复 P0-F1）─────────
  // 旧实现:每个条带各自选覆盖率最高的候选就出单,完全不检查同星时间冲突,
  //   实测派出 57 单里 45 处同星 0~9 秒冲突 —— 物理上无法执行。
  // 新实现:重新跑 dispatchAcrossSatellites 拿到「可执行的」分派方案,
  //   按该方案逐条出单;无法排进去的条带明确列为缺口并给真实原因。
  const candByStrip = new Map();
  for (const rk of ranking) {
    const si = rk.stripIdx ?? stripById.get(rk.candidateId) ?? 1;
    if (!candByStrip.has(si)) candByStrip.set(si, []);
    candByStrip.get(si).push(rk);
  }
  const totalStrips = (await pbAll("candidates", { filter: `task='${ref.rid}'`, fields: "stripIdx" }))
    .reduce((mx, c) => Math.max(mx, c.stripIdx ?? 1), 1);
  // 条带定义要带长度：冲突判定按「条带长 ÷ 地面速度」估算实际成像时长。
  // 注意：本路由作用域内没有 strips 变量（strips 只在 candidates 路由里），
  // 这里必须从任务 geom 重新规划一次，否则会抛 ReferenceError（v115 的派单 503 根因）。
  const stripLenByIdx = new Map();
  try {
    const geomObj = JSON.parse(task.geom ?? "{}");
    if (task.geomType !== 'point' && Array.isArray(geomObj.coords)) {
      const planned = normalizeTaskStrips(task, 12);
      for (const st of planned) stripLenByIdx.set(st.idx, st.lengthKm ?? 60);
    }
  } catch (e) {
    console.error('[dispatch] 条带长度重算失败，回退默认 60km:', e.message);
  }
  const allStripDefs = [];
  for (let i = 1; i <= totalStrips; i++) allStripDefs.push({ idx: i, lengthKm: stripLenByIdx.get(i) ?? 60 });

  // 优先复用 candidates 阶段已算好并持久化的分派方案（第五轮 P0-2）：
  // 旧实现派单时自己重跑 dispatchAcrossSatellites，但输入用 ranking（Top-N 排序结果）
  // 而非 candidates 的 passingRows，两次结果必然分叉——实测订单与方案一致率 0%。
  let plan = null;
  try {
    if (task.multiPlan) {
      const saved = JSON.parse(task.multiPlan);
      if (Array.isArray(saved) && saved.length) {
        plan = {
          assignments: saved.map(a => ({
            stripIdx: a.stripIdx, satName: a.satName, company: a.company,
            overpass: a.overpass, slewDeg: a.slewDeg, coverage: a.coverage ?? 1,
            grade: coverageGrade(a.coverage ?? 1),
          })),
          satellites: [], gaps: [], stats: { satelliteCount: new Set(saved.map(a => a.satName)).size },
        };
        // 用候选表补齐 gaps：未被分派的条带
        const assignedSet = new Set(saved.map(a => a.stripIdx));
        for (let i = 1; i <= totalStrips; i++) {
          if (!assignedSet.has(i)) plan.gaps.push({ stripId: i, reason: '候选阶段判定无法排入' });
        }
      }
    }
  } catch (e) { console.error('[dispatch] 复用分派方案失败，回退重算:', e.message); }
  if (!plan) plan = dispatchAcrossSatellites(allStripDefs, candByStrip, { minCoverage: 0.85 });
  plan.reused = !!task.multiPlan;
  // 用条带号 + 卫星名回查原始 ranking 记录（订单要写 satNoradId/rank 等字段）
  const rkIndex = new Map();
  for (const rk of ranking) {
    const si = rk.stripIdx ?? stripById.get(rk.candidateId) ?? 1;
    rkIndex.set(`${si}|${rk.satName}`, rk);
  }
  const stripGroups = new Map();
  for (const a of plan.assignments) {
    const rk = rkIndex.get(`${a.stripIdx}|${a.satName}`);
    if (rk) stripGroups.set(a.stripIdx, rk);
  }
  const coveredIdx = [...stripGroups.keys()].sort((a, b) => a - b);
  const gapByStrip = new Map((plan.gaps ?? []).map(g => [g.stripId, g.reason]));
  const uncoveredIdx = [];
  for (let i = 1; i <= totalStrips; i++) if (!stripGroups.has(i)) uncoveredIdx.push(i);

  const batchOps = [];
  const createdOrders = [];
  for (const si of coveredIdx) {
    const rk = stripGroups.get(si);
    const oNo = `PO-${pbYmd()}-${String(await pbNextSeq("orderNo")).padStart(3, "0")}`;
    const oOld = await pbNextOldId("orders");
    createdOrders.push({ stripIdx: si, orderNo: oNo, oldId: oOld, satName: rk.satName, company: rk.company, rank: rk.rank ?? 0 });
    batchOps.push({ table: "orders", oldId: oOld, data: {
      oldId: oOld,
      task: ref.rid, orderNo: oNo, channel, company: rk.company,
      satNoradId: rk.satNoradId ?? 0, satName: rk.satName ?? "",
      rankUsed: rk.rank ?? 0,
      targetName: task.targetName, obsType: task.obsType, resolution: task.resolution,
      windowStart: task.windowStart, windowEnd: task.windowEnd, maxCloud: task.maxCloud ?? 0,
      deliveryDeadline: task.windowEnd, status: '已派发', createdAt: pbNow(),
      statusHistory: JSON.stringify([{ status: '已派发', time: new Date().toISOString(), source: '平台' }]),
    } });
  }
  const fullCovered = uncoveredIdx.length === 0;
  batchOps.push({ table: "tasks", method: "UPDATE", recordId: ref.rid, data: { status: fullCovered ? '已派发' : '部分派发' } });
  batchOps.push({ table: "dispatchLog", data: { task: ref.rid, channel,
    company: createdOrders[0]?.company, rank: createdOrders[0]?.rank ?? 0, action: '派发',
    detail: `${rule}；条带 ${coveredIdx.length}/${totalStrips} 已派${fullCovered ? '' : `，未覆盖 ${uncoveredIdx.length} 条`}`, at: pbNow() } });
  const batchResults = await pbBatch(batchOps);
  const orderRec = batchResults[0];
  if (!orderRec?.ok) return res.status(500).json({ error: '订单落库失败', detail: orderRec?.data });
  return res.json({
    channel, rule,
    orderId: orderRec.data.oldId ?? orderRec.data.id,
    orderNo: createdOrders[0]?.orderNo,
    company: createdOrders[0]?.company,
    inquiries: [],
    stripDispatch: {
      totalStrips,
      dispatchedStrips: coveredIdx.length,
      coveragePct: totalStrips ? +((coveredIdx.length / totalStrips) * 100).toFixed(1) : 100,
      orders: createdOrders,
      uncoveredStrips: uncoveredIdx,
      gapReasons: uncoveredIdx.map(i => ({ stripId: i, reason: gapByStrip.get(i) ?? '无可用候选' })),
      satelliteCount: plan.stats.satelliteCount,
      satellites: plan.satellites,
      multiSatellitePlan: true,
      warning: fullCovered ? null
        : `仅 ${coveredIdx.length}/${totalStrips} 条带已派单，剩余 ${uncoveredIdx.length} 条带无可用候选，任务状态标为「部分派发」`,
    },
  });

  // 询价通道：同时向其他候选公司发询价单
  let inquiries = [];
  if (channel === '询价') {
    const cnCompanies = new Set((await pbAll("companies", { fields: "short" })).map(c => c.short));
    const seen = new Set([company]);
    const inquiryOps = [];
    for (const rk of ranking) {
      if (seen.has(rk.company) || !cnCompanies.has(rk.company)) continue; // 询价仅限国内在册公司
      seen.add(rk.company);
      if (seen.size > 5) break;
      inquiries.push(rk.company);
      inquiryOps.push({ table: "dispatchLog", data: { order: orderRec.data.id, task: ref.rid, channel: '询价', company: rk.company, rank: rk.rank ?? 0, action: '询价单发出', detail: '同步询价', at: pbNow() } });
    }
    if (inquiryOps.length) await pbBatch(inquiryOps);
  }
});

// 询价报价（模拟公司响应）——PB 迁移版（订单数字 id 经 oldId 回查）
dispatchApi.post("/orders/:id/quote", async (req, res) => {
  const order = await pbGetByOldId("orders", +req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  const { quotes } = req.body ?? {}; // [{company, price, valid}] 或由平台模拟
  let list = quotes;
  if (!list) {
    // 平台模拟报价：候选公司按能力给价
    const logs = await pbAll("dispatchLog", { filter: `order='${order.id}' && action='询价单发出'` });
    // 报价解算（国内商业遥感公开行情量级）：基准价 = 分辨率系数 × 条带面积 × 单价
    // 1m级 ~3万/千km²档，0.5m ~8万/千km²档，SAR 5m ~1.5万/千km²档；公司履约率±10%浮动
    const taskRec = order.task ? await pbGet("tasks", order.task) : null;
    const resM = taskRec?.resolution ?? 2;
    const base = resM <= 0.5 ? 8 : resM <= 1 ? 3 : resM <= 2 ? 1.5 : 0.8; // 万元/千km²
    const areaK2 = 100; // 单条带约 12km×8s×7.5km/s≈100km² 量级
    list = logs.map((l, i) => {
      const cap = (companiesCacheAll() || []).find(c => c.short === l.company);
      const adj = 1 + ((cap?.fulfillmentRate ?? 0.9) - 0.9) * 0.5; // 履约好的略高定价
      return { company: l.company, price: Math.round(base * areaK2 / 100 * adj * 10) / 10, valid: true };
    });
  }
  const valid = list.filter(q => q.valid);
  if (valid.length === 0) {
    return res.json({ result: '全部弃权 → 转抢单', nextChannel: '抢单' });
  }
  valid.sort((a, b) => a.price - b.price);
  const winner = valid[0];
  await pbBatch([
    { table: "orders", method: "UPDATE", recordId: order.id, data: { company: winner.company, price: winner.price, channel: '询价' } },
    { table: "dispatchLog", data: { order: order.id, task: order.task, channel: '询价', company: winner.company, action: '成交', detail: `最低价 ${winner.price} 万`, at: pbNow() } },
  ]);
  res.json({ result: '成交', winner });
});

// 抢单池
dispatchApi.post("/tasks/:id/pool", async (req, res) => {
  const ref = await pbResolveTask(req.params.id);
  const task = ref ? await pbGet("tasks", ref.rid) : null;
  if (!task) return res.status(404).json({ error: 'task not found' });
  const expires = new Date(Date.now() + 4 * 3600000).toISOString(); // 4h 有效期
  await pbBatch([
    { table: "taskPool", data: { task: ref.rid, expiresAt: expires, poolSince: pbNow() } },
    { table: "tasks", method: "UPDATE", recordId: ref.rid, data: { status: '挂任务池' } },
  ]);
  res.json({ ok: true, expiresAt: expires });
});

dispatchApi.post("/pool/:taskId/claim", async (req, res) => {
  const { company } = req.body ?? {};
  const ref = await pbResolveTask(req.params.taskId);
  if (!ref) return res.status(404).json({ error: '不在任务池或已被认领' });
  const pools = await pbList("taskPool", { filter: `task='${ref.rid}' && claimedBy=''`, sort: "-oldId", limit: 1 });
  const pool = pools.items[0];
  if (!pool) return res.status(404).json({ error: '不在任务池或已被认领' });
  // 生成订单（ranking 取该公司最优顺位一条，expand=candidate）
  const task = await pbGet("tasks", ref.rid);
  const orderNo = `PO-${pbYmd()}-${String(await pbNextSeq("orderNo")).padStart(3, "0")}`;
  const ranked = await pbList("rankings", { filter: `task='${ref.rid}'`, sort: "rank", limit: 500, expand: "candidate" });
  const ranking = ranked.items
    .map(r => ({ r, c: r.expand?.candidate ?? {} }))
    .filter(x => x.c.company === company && x.c.filtered === 0)
    .sort((a, b) => (a.r.rank ?? 0) - (b.r.rank ?? 0))[0];
  const claimOrderOldId = await pbNextOldId("orders");
  const results = await pbBatch([
    { table: "taskPool", method: "UPDATE", recordId: pool.id, data: { claimedBy: company, claimedAt: pbNow() } },
    { table: "orders", oldId: claimOrderOldId, data: {
      oldId: claimOrderOldId,
      task: ref.rid, orderNo, channel: '抢单', company, satNoradId: ranking?.c.satNoradId ?? 0, satName: ranking?.c.satName ?? "",
      rankUsed: ranking?.r.rank ?? 0,
      targetName: task.targetName, obsType: task.obsType, resolution: task.resolution,
      windowStart: task.windowStart, windowEnd: task.windowEnd, maxCloud: task.maxCloud ?? 0,
      status: '已派发', createdAt: pbNow(),
      statusHistory: JSON.stringify([{ status: '已派发', time: new Date().toISOString(), source: '抢单成交' }]),
    } },
    { table: "tasks", method: "UPDATE", recordId: ref.rid, data: { status: '已派发' } },
  ]);
  const orderRec = results.find(x => x.table === "orders");
  if (!orderRec?.ok) return res.status(500).json({ error: '订单落库失败', detail: orderRec?.data });
  res.json({ ok: true, orderId: orderRec.data.oldId ?? orderRec.data.id, orderNo });
});

// 订单状态流转（4.5-3）：单向流转
const ORDER_FLOW = {
  '已派发': ['已接单'],
  '已接单': ['执行中'],
  '执行中': ['已交付'],
  '已交付': ['已验收', '已失败'],
};
dispatchApi.post("/orders/:id/status", async (req, res) => {
  const order = await pbGetByOldId("orders", +req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  const { status, source = '公司回传', failureReason } = req.body ?? {};
  const allowed = ORDER_FLOW[order.status] ?? [];
  if (order.status === '已失败' && status === '已派发') {
    // 失败重派：生成新订单
    const orderNo = `PO-${pbYmd()}-${String(await pbNextSeq("orderNo")).padStart(3, "0")}`;
    const redispatchOldId = await pbNextOldId("orders");
    const [r] = await pbBatch([{ table: "orders", oldId: redispatchOldId, data: {
      oldId: redispatchOldId,
      task: order.task, orderNo, channel: order.channel, company: '', satNoradId: 0, satName: '',
      targetName: order.targetName, obsType: order.obsType, resolution: order.resolution,
      windowStart: order.windowStart, windowEnd: order.windowEnd, maxCloud: order.maxCloud ?? 0,
      status: '已派发', createdAt: pbNow(),
      statusHistory: JSON.stringify([{ status: '已派发', time: new Date().toISOString(), source: '失败重派' }]),
    } }]);
    if (!r?.ok) return res.status(500).json({ error: '重派订单落库失败', detail: r?.data });
    return res.json({ ok: true, reDispatched: r.data.oldId ?? r.data.id, orderNo });
  }
  if (!allowed.includes(status)) return res.status(400).json({ error: `非法流转：${order.status} → ${status}` });
  const hist = JSON.parse(order.statusHistory || '[]');
  hist.push({ status, time: new Date().toISOString(), source });
  const closed = ['已验收', '已失败'].includes(status);
  const ops = [
    { table: "orders", method: "UPDATE", recordId: order.id, data: {
      status, statusHistory: JSON.stringify(hist),
      closedAt: closed ? pbNow() : (order.closedAt ?? ""),
      fulfillment: status === '已验收' ? '按约完成' : status === '已失败' ? '未按约' : "",
      failureReason: status === '已失败' ? (failureReason ?? '验收不通过') : "",
    } },
  ];
  // 履约回写
  if (closed) {
    ops.push({ table: "fulfillmentLog", data: {
      company: order.company, orderId: order.oldId ?? null, task: order.task,
      outcome: status === '已验收' ? '按约完成' : '未按约', reason: failureReason ?? "", closedAt: pbNow(),
    } });
    ops.push({ table: "tasks", method: "UPDATE", recordId: order.task, data: { status: status === '已验收' ? '已验收' : '已失败' } });
    // 更新公司履约率（EWMA α=0.2 简化）
    const co = (await pbAll("companies", { filter: `short='${escFilter(order.company)}'` }))[0];
    if (co) {
      const outcome = status === '已验收' ? 1 : 0;
      const newRate = 0.2 * outcome + 0.8 * (co.fulfillmentRate ?? 0.9);
      ops.push({ table: "companies", method: "UPDATE", recordId: co.id, data: {
        fulfillmentRate: newRate, acceptedCount: Math.max(0, (co.acceptedCount ?? 0) - 1),
      } });
    }
  } else {
    ops.push({ table: "tasks", method: "UPDATE", recordId: order.task, data: { status } });
  }
  const results = await pbBatch(ops);
  const failed = results.find(r => !r.ok);
  if (failed) return res.status(500).json({ error: '订单状态更新失败', detail: failed.data });
  res.json({ ok: true, status });
});

dispatchApi.get("/orders", async (req, res) => {
  const r = await pbList("orders", { sort: "-oldId", limit: 200, expand: "task" });
  res.json(r.items.map(pbRelRow));
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

// 供智能体 CLI 的便捷查询通道——PB 迁移后 SQL 直查已弃用（T2 口径：一律拒绝并提示专用端点）。
// CLI v7 起 q() 已改为 PB REST 直查（filter/sort/expand），不再依赖本接口；
// 数据读取请用 GET /api/dispatch/tasks|orders|plans|pool|companies 或 GET /api/dispatch/tasks/:id。
dispatchApi.post("/_sql", (req, res) => {
  res.status(410).json({
    error: "SQL 直查通道已随 PocketBase 迁移下线（410 Gone）。请改用专用端点：",
    endpoints: {
      任务列表: "GET /api/dispatch/tasks?status=<状态>",
      任务详情: "GET /api/dispatch/tasks/<id>",
      订单列表: "GET /api/dispatch/orders",
      直控方案: "GET /api/dispatch/plans",
      任务池: "GET /api/dispatch/pool",
      公司: "GET /api/dispatch/companies",
      CLI: "dispatch CLI ≥v7 的 q() 已内置 PB REST 直查，直接升级 dispatch --self-update",
    },
  });
});

dispatchApi.get("/companies", async (req, res) => {
  const r = await pbList("companies", { sort: "oldId", limit: 500 });
  res.json(r.items.map(c => ({ ...c, id: c.oldId ?? c.id })));
});

dispatchApi.get("/pool", async (req, res) => {
  const r = await pbList("taskPool", { filter: "claimedBy=''", sort: "-oldId", limit: 500, expand: "task" });
  res.json(r.items.map(p => {
    const t = p.expand?.task ?? {};
    return { ...pbRelRow(p), taskName: t.taskName, targetName: t.targetName, obsType: t.obsType, resolution: t.resolution };
  }));
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
  // 姿态机动/稳定/预热按型号真实口径（payload_specs 调研库）：
  // 机动速率 高分系0.13~0.19°/s、敏捷商业星0.5~1.5°/s；稳定5~20s；光学开机预热2~10min（取300s量级）
  const spec = getPayloadSpec(plan.satName, sat);  // 传入卫星元数据，SAR/光学判定以实库为准
  const omegaMax = spec?.slewRate ?? 1.0;             // °/s 型号真实值
  const alphaMax = 0.5;                                // °/s² 典型
  // 凝视型载荷（GEO 如 GAOFEN-4，slewRate=0）：指向靠扫描机构/电子稳像，无姿态机动，机动时长为 0
  const slewTime = omegaMax > 0 ? Math.abs(slew) / omegaMax + omegaMax / alphaMax : 0;
  const stabilize = 10.0;  // 稳定 s（调研典型5~20s取中值）
  const warmup = 300.0;    // 相机开机预热 s（光学调研典型2~10min，取5min量级；星上常开制冷按光路准备计）
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
// errors 元素可为字符串或 { code, msg, detail } 结构化对象：detail 携带几何/参数数值，
// 前端据此展开「为什么驳回」的诊断明细，不再只是单句结论
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
    // ── 几何覆盖校验（2026-11-15 修复 P1-2）──────────────────────────────
    // 历史问题：只要候选表里 imgWin 有值就当"拍得到"，但 imgWin 由侧摆可达范围算出，
    // 与"实际成像时刻卫星是否对准目标"是两件事。这里独立复核：
    //   侧摆角 = atan(最近距离 / 轨道高度)，必须 ≤ 该星侧摆上限；
    //   且最近距离不能超过「侧摆可达地面距离 + 幅宽半宽投影」。
    if (plan.minDistKm != null && sat) {
      const caps2 = getCapability(sat);
      const alt2 = Number.isFinite(+sat.altitude) && sat.altitude > 100 && sat.altitude < 20000 ? +sat.altitude : null;
      if (alt2) {
        const theta = Math.atan(plan.minDistKm / alt2) * 180 / Math.PI;
        const slewLimit = Math.min(caps2.slewLimitDeg ?? 45, policyMaxSlew());
        const halfFoot = (caps2.swathKm / 2) / Math.cos(theta * Math.PI / 180);
        const reachKm = alt2 * Math.tan(slewLimit * Math.PI / 180) + halfFoot;
        if (plan.minDistKm > reachKm) {
          errors.push({
            code: 'GEOMETRY_UNREACHABLE',
            msg: '几何不可达：该候选过顶时卫星无法把目标纳入成像范围，此指令下发后拍不到目标',
            detail: {
              satName: plan.satName, minDistKm: +plan.minDistKm.toFixed(1),
              requiredSlewDeg: +theta.toFixed(1), slewLimitDeg: slewLimit,
              swathKm: caps2.swathKm, reachableKm: +reachKm.toFixed(1),
              overByKm: +(plan.minDistKm - reachKm).toFixed(1),
              conclusion: `需侧摆 ${theta.toFixed(1)}°（上限 ${slewLimit}°），最远可达 ${reachKm.toFixed(1)}km，实际 ${plan.minDistKm.toFixed(1)}km，超出 ${(plan.minDistKm - reachKm).toFixed(1)}km`,
            },
          });
        }
      }
    }
    if (!plan.imgWinStart || !plan.imgWinEnd) {
      // 结构化驳回：给出「差多少才够拍」的数值诊断（幅宽/最近距离/侧摆/需要的高度）
      // 数据源：candidates 落库的 minDistKm（精确 TCA 距离）+ sat_specs 型号幅宽（官方公开参数）
      const caps = getCapability(sat);
      const halfKm = caps.swathKm / 2;
      const minKm = plan.minDistKm ?? null;
      // 近地轨道才给出"需多高才够拍"的换算（GEO 凝视星用另一种几何，不适用该口径）。
      // 2026-11-15：卫星 altitude 曾全库放大 ~79 倍，导致这里恒为 null；数据已按 TLE 修正。
      const altKm = Number.isFinite(+sat.altitude) && sat.altitude > 100 && sat.altitude < 20000 ? +sat.altitude : null;
      const overKm = minKm != null ? Math.round((minKm - halfKm) * 10) / 10 : null;
      errors.push({
        code: 'SWATH_NO_COVER',
        msg: '幅宽不覆盖：整个过境弧段内传感器幅宽均罩不住目标，此方案不能成像，请改派其他过顶更近的卫星',
        detail: {
          satName: plan.satName,
          swathKm: caps.swathKm,
          halfKm,
          minDistKm: minKm,                     // 过境弧段内星-目标最近距离
          overByKm: overKm,                     // 最近距离超出幅宽半宽多少 km（差多少才够拍）
          slewDeg: plan.slewDeg ?? null,
          // 要罩住目标所需的等效轨道高度（把最近距离压进半宽内）：alt ≈ dist×cos(slew)…
          // 简化口径：距离 minKm 在侧摆 slewDeg 下对应的必需高度，供运维判断该星是否天生拍不到
          requiredAltKm: minKm != null && altKm != null
            ? Math.round(minKm * Math.cos(Math.atan(minKm / altKm)) * 10) / 10
            : null,
          actualAltKm: altKm,
          conclusion: minKm != null
            ? `最近过顶距目标 ${Math.round(minKm * 10) / 10}km，而 ${plan.satName} 幅宽半宽仅 ${halfKm}km（幅宽 ${caps.swathKm}km）——超出 ${overKm}km，整段过境均无法把目标压进幅宽内`
            : `${plan.satName} 幅宽半宽 ${halfKm}km，过境弧段内未有任何时刻能覆盖目标`,
          advice: '点击「换一颗候选卫星解算」切到过顶更近的候选，或改用幅宽更大的型号（如宽幅星）',
        },
      });
    }
    const winS = plan.imgWinStart ? new Date(plan.imgWinStart).getTime() - 3000 : tca - imgCmd.duration * 500;
    const winE = plan.imgWinEnd ? new Date(plan.imgWinEnd).getTime() + 3000 : tca + imgCmd.duration * 500;
    if (imgCenter < winS || imgCenter > winE) {
      errors.push(`指向偏差：成像中点偏离覆盖窗 ${Math.round(Math.abs(imgCenter - tca) / 1000)}s，不能拍到目标`);
    }
  }
  return { pass: errors.length === 0, errors, totalDuration: total };
}

dispatchApi.post("/plans/:id/generate", async (req, res) => {
  const plan = await pbGetByOldId("directPlans", +req.params.id);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  const sat = (await pbAll("satellites", { filter: `noradId=${plan.satNoradId}` }))[0];
  const task = plan.task ? await pbGet("tasks", plan.task) : null;
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
  await pbUpdate("directPlans", plan.id, {
    commands: JSON.stringify(commands), validation: JSON.stringify(validation), timeline: JSON.stringify(timeline),
    sequenceStart: timeline.sequenceStartIso, paramPack: JSON.stringify(paramPack),
    arcInfo: uplinkPass ? JSON.stringify({ station: uplinkPass.station, arcStart: new Date(uplinkPass.arcStart).toISOString(), arcEnd: new Date(uplinkPass.arcEnd).toISOString(), maxElDeg: uplinkPass.maxElDeg }) : "",
    status: validation.pass ? '待核验下发' : '校验驳回', updatedAt: pbNow(),
  });
  res.json({ commands, validation, timeline, paramPack });
});

// 换一颗候选卫星重新解算（校验驳回后的出路，不能让方案卡死在「校验驳回」）
// 从任务 ranking 顺位往下找下一颗可换的卫星，原地更新本方案，状态回「待确认」
dispatchApi.post("/plans/:id/reassign", async (req, res) => {
  const plan = await pbGetByOldId("directPlans", +req.params.id);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  if (!['待确认', '校验驳回'].includes(plan.status))
    return res.status(400).json({ error: `状态 ${plan.status} 不可换星（仅待确认/校验驳回可换）` });
  // rankings JOIN candidates → PB expand=candidate（换星取值口径与旧 SQL 一致）
  const rankRes = await pbList("rankings", { filter: `task='${plan.task}'`, sort: "rank", limit: 500, expand: "candidate" });
  const ranking = rankRes.items
    .filter(r => (r.expand?.candidate?.filtered ?? 1) === 0)
    .map(r => {
      const c = r.expand.candidate;
      return {
        id: r.oldId ?? r.id, taskId: plan.oldId ?? plan.id, candidateId: c.oldId ?? c.id, rank: r.rank,
        satName: c.satName, company: c.company, satNoradId: c.satNoradId, overpassTime: c.overpassTime,
        windowStart: c.windowStart, windowEnd: c.windowEnd, imgWinStart: c.imgWinStart, imgWinEnd: c.imgWinEnd,
        minDistKm: c.minDistKm,
      };
    })
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  if (ranking.length === 0) return res.status(400).json({ error: '该任务无可用候选排序，无法换星，请先重新计算候选' });
  // 候选去重（同星多过顶窗口取最优顺位）；排除当前已驳回的这颗
  const seen = new Set();
  const rankedSats = [];
  for (const r of ranking) {
    if (seen.has(r.satNoradId)) continue;
    seen.add(r.satNoradId);
    rankedSats.push(r);
  }
  const curIdx = rankedSats.findIndex(r => r.satNoradId === plan.satNoradId);
  // 默认优先跳到下一颗幅宽可覆盖（imgWin 非空）的；传 force=true 则严格按顺位下一颗
  const force = !!req.body?.force;
  let next = null;
  if (force) {
    next = rankedSats[curIdx + 1] ?? null;
  } else {
    next = rankedSats.find((r, i) => i > curIdx && r.imgWinStart && r.imgWinEnd)
      ?? rankedSats.find((r, i) => i > curIdx)
      // 当前已是最后顺位时回绕到第一颗可覆盖的（非当前星）
      ?? rankedSats.find((r, i) => i !== curIdx && r.imgWinStart && r.imgWinEnd)
      ?? (rankedSats.length > 1 ? rankedSats[0] : null);
  }
  if (!next || next.satNoradId === plan.satNoradId) return res.status(400).json({ error: '已没有其他候选卫星可换（该任务排序中仅此一颗）' });
  const pos = rankedSats.findIndex(r => r.satNoradId === next.satNoradId) + 1;
  await pbBatch([
    { table: "directPlans", method: "UPDATE", recordId: plan.id, data: {
      satNoradId: next.satNoradId, satName: next.satName, company: next.company,
      windowStart: next.windowStart, windowEnd: next.windowEnd, overpassTime: next.overpassTime,
      imgWinStart: next.imgWinStart ?? "", imgWinEnd: next.imgWinEnd ?? "", minDistKm: next.minDistKm ?? 0,
      commands: "", validation: "", timeline: "", sequenceStart: "", paramPack: "", arcInfo: "",
      status: '待确认', updatedAt: pbNow(),
    } },
    { table: "dispatchLog", data: { task: plan.task, action: '直控换星', detail: JSON.stringify({ planId: plan.oldId ?? plan.id, from: plan.satName, to: next.satName, toNorad: next.satNoradId, 顺位: `${pos}/${rankedSats.length}`, 幅宽可覆盖: !!(next.imgWinStart && next.imgWinEnd) }), at: pbNow() } },
  ]);
  res.json({ ok: true, planId: plan.oldId ?? plan.id, from: plan.satName, to: next.satName, toNorad: next.satNoradId, rankPos: pos, totalRanked: rankedSats.length, imgWinCovered: !!(next.imgWinStart && next.imgWinEnd) });
});

dispatchApi.post("/plans/:id/confirm", async (req, res) => {
  const { stage, checklist } = req.body ?? {}; // stage: 方案|上注；checklist: 上注前人工核验勾选
  const plan = await pbGetByOldId("directPlans", +req.params.id);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  const map = { '方案': '方案已确认', '上注': '已上注' };
  const next = map[stage];
  if (!next) return res.status(400).json({ error: 'stage 须为 方案|上注' });
  // 上注前强制核验（遥控作业规范：上行前阶段必须逐项确认）：
  // 1) 时窗正确 2) 指向对准（TCA） 3) 指令校验通过 4) 卫星/弧段正确
  if (stage === '上注') {
    // 待核验下发（未单独确认方案）与方案已确认（已走②）均可直接上注——否则先确认方案后会死锁在中间态
    if (!['待核验下发', '方案已确认'].includes(plan.status)) return res.status(400).json({ error: `状态 ${plan.status} 不可上注（须先生成指令并核验）` });
    const required = ['windowOk', 'tcaAligned', 'commandsValid', 'satArcOk'];
    const missing = required.filter(k => !checklist?.[k]);
    if (missing.length) return res.status(400).json({ error: `上注核验未完成，缺项: ${missing.join(', ')}`, required });
    await pbCreate("dispatchLog", { task: plan.task, action: '上注前人工核验', detail: JSON.stringify(checklist), at: pbNow() });
  }
  if (stage === '方案' && !['待确认', '待核验下发'].includes(plan.status))
    return res.status(400).json({ error: `状态 ${plan.status} 不可确认方案` });
  // 模拟测控弧段与执行
  if (next === '已上注') {
    // 上注弧段用参数包计算的真实弧段（不再编造）
    const pack = plan.paramPack ? JSON.parse(plan.paramPack) : null;
    const arc = pack?.uplinkPass
      ? { station: pack.uplinkPass.station, arcStart: pack.uplinkPass.arcStart, arcEnd: pack.uplinkPass.arcEnd, maxElDeg: pack.uplinkPass.maxElDeg }
      : null;
    await pbBatch([
      { table: "directPlans", method: "UPDATE", recordId: plan.id, data: {
        status: '执行中', updatedAt: pbNow(),
        arcInfo: arc ? JSON.stringify(arc) : (plan.arcInfo ?? ""),
      } },
      { table: "tasks", method: "UPDATE", recordId: plan.task, data: { status: '直控执行中' } },
    ]);
  } else {
    await pbUpdate("directPlans", plan.id, { status: next, updatedAt: pbNow() });
  }
  res.json({ ok: true, status: next });
});

dispatchApi.post("/plans/:id/complete", async (req, res) => {
  const { outcome = '成功' } = req.body ?? {};
  const plan = await pbGetByOldId("directPlans", +req.params.id);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  await pbBatch([
    { table: "directPlans", method: "UPDATE", recordId: plan.id, data: { status: outcome === '成功' ? '已完成' : '已失败', updatedAt: pbNow() } },
    { table: "tasks", method: "UPDATE", recordId: plan.task, data: { status: outcome === '成功' ? '已验收' : '已失败' } },
  ]);
  res.json({ ok: true });
});

dispatchApi.get("/plans", async (req, res) => {
  const r = await pbList("directPlans", { sort: "-oldId", limit: 100, expand: "task" });
  res.json(r.items.map(p => {
    const t = p.expand?.task ?? {};
    return { ...pbRelRow(p), taskName: t.taskName, targetName: t.targetName, createdAt: p.createdAt || "0000-00-00 00:00:00" };
  }));
});
dispatchApi.get("/plans/:id", async (req, res) => {
  const p = await pbGetByOldId("directPlans", +req.params.id);
  if (!p) return res.status(404).json({ error: 'plan not found' });
  const row = { ...p, id: p.oldId ?? p.id, taskId: p.expand?.task?.oldId ?? null };
  row.commands = row.commands ? JSON.parse(row.commands) : null;
  row.validation = row.validation ? JSON.parse(row.validation) : null;
  res.json(row);
});
