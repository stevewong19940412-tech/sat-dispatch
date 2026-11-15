// ─── 卫星/任务/图层 仓储层（PocketBase 版，替代原 SQLite db.mjs）──────────────
// 2026-11-15 迁移：系统数据层已全部切 PocketBase，但 index.mjs 仍有一批接口
// 走 SQLite（列表结果永远为空 / 两套数据源并存）。本模块把那些接口的读写全部改走 PB，
// 函数签名与旧 db.mjs 保持一致（同步→异步），调用方只需加 await。
//
// 约定：
//   - PB 侧以 oldId 作为对外数字 id（与 tasks/candidates 等业务表一致）；
//   - JSON 字段（assignedSatellites / tags / payload）在 PB 里存文本，读回时解析。

import { pbAll, pbGetByOldId, pbCreate, pbUpdate, pbDelete } from "./pb_repo.mjs";

// 数字 id 分配器（与 dispatch.mjs 的 pbNextOldId 同口径：取该表当前最大 oldId + 1）
const _oldIdSeeds = new Map();
async function pbNextOldId(table = "missions") {
  if (_oldIdSeeds.get(table) == null) {
    const rows = await pbAll(table, { filter: "oldId>0", fields: "id,oldId", sort: "-oldId" });
    _oldIdSeeds.set(table, rows[0]?.oldId ?? 0);
  }
  const next = _oldIdSeeds.get(table) + 1;
  _oldIdSeeds.set(table, next);
  return next;
}

// ─── 卫星 ─────────────────────────────────────────────────────────────────
function normSat(r) {
  if (!r) return null;
  // PB number 字段未设置时读回 0（SQLite 有 DEFAULT，PB 没有），这里保持原样便于 UI 判断
  return { ...r };
}

export async function getAllSatellites() {
  const rows = await pbAll("satellites", { filter: "decayed=0", sort: "category,name" });
  return rows.map(normSat);
}

export async function getSatellitesByCategory(category) {
  const rows = await pbAll("satellites", { filter: `decayed=0 && category='${category}'`, sort: "name" });
  return rows.map(normSat);
}

export async function getSatelliteByNoradId(noradId) {
  const n = parseInt(noradId, 10);
  if (Number.isNaN(n)) return null;
  const rows = await pbAll("satellites", { filter: `noradId=${n}` });
  return normSat(rows[0] ?? null);
}

export async function searchSatellites(query, limit = 50) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const asNum = parseInt(q, 10);
  if (!Number.isNaN(asNum) && String(asNum) === q) {
    const byId = await pbAll("satellites", { filter: `noradId=${asNum}` });
    if (byId.length) return byId.slice(0, limit).map(normSat);
  }
  // PB 的 ~ 是"包含（忽略大小写）"操作符。
  // 安全（P1 修）：PB filter 用双引号包字符串，必须转义内部双引号与反斜杠；
  // 单引号/括号等在双引号内是普通字符，但清洗后为空时必须返回空，不能变成"匹配全部"。
  const safe = q.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (!safe.trim()) return [];
  const rows = await pbAll("satellites", { filter: `decayed=0 && name~"${safe}"`, sort: "name" });
  return rows.slice(0, limit).map(normSat);
}

export async function getCategories() {
  const rows = await pbAll("satellites", { filter: "decayed=0", fields: "category" });
  const counts = {};
  for (const r of rows) counts[r.category] = (counts[r.category] ?? 0) + 1;
  return Object.entries(counts).map(([category, count]) => ({ category, count }));
}

// ─── 任务（mission）CRUD ───────────────────────────────────────────────────
function parseMission(row) {
  if (!row) return null;
  const j = (v, dflt) => {
    if (v == null || v === "") return dflt;
    if (typeof v !== "string") return v;
    try { return JSON.parse(v); } catch { return dflt; }
  };
  return {
    ...row,
    id: row.oldId ?? row.id, // 对外沿用数字 id
    assignedSatellites: j(row.assignedSatellites, []),
    tags: j(row.tags, []),
  };
}

export async function listMissions(status, limit = 100) {
  const filter = status ? `status='${String(status).replace(/'/g, "")}'` : "";
  const rows = await pbAll("missions", { filter, sort: "-updatedAt" });
  return rows.slice(0, limit).map(parseMission);
}

export async function getMission(id) {
  // 不存在时返回 null（而非抛异常），让路由层回 404 而不是 503
  const rec = await pbGetByOldId("missions", +id).catch(() => null);
  return parseMission(rec);
}

export async function createMission(m) {
  const now = new Date().toISOString();
  const oldId = await pbNextOldId("missions");
  const rec = await pbCreate("missions", {
    oldId,
    name: m.name,
    codename: m.codename ?? "",
    description: m.description ?? "",
    status: m.status ?? "planning",
    priority: m.priority ?? "medium",
    classification: m.classification ?? "unclassified",
    aoiLat: m.aoiLat ?? 0,
    aoiLon: m.aoiLon ?? 0,
    aoiRadiusKm: m.aoiRadiusKm ?? 0,
    aoiName: m.aoiName ?? "",
    assignedSatellites: JSON.stringify(m.assignedSatellites ?? []),
    startDate: m.startDate ?? "",
    endDate: m.endDate ?? "",
    objectives: m.objectives ?? "",
    notes: m.notes ?? "",
    tags: JSON.stringify(m.tags ?? []),
    passCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  return parseMission(rec);
}

export async function updateMission(id, patch) {
  const rec = await pbGetByOldId("missions", +id).catch(() => null);
  if (!rec) return null;
  const merged = { ...parseMission(rec), ...patch };
  const updated = await pbUpdate("missions", rec.id, {
    name: merged.name,
    codename: merged.codename ?? "",
    description: merged.description ?? "",
    status: merged.status,
    priority: merged.priority,
    classification: merged.classification,
    aoiLat: merged.aoiLat ?? 0,
    aoiLon: merged.aoiLon ?? 0,
    aoiRadiusKm: merged.aoiRadiusKm ?? 0,
    aoiName: merged.aoiName ?? "",
    assignedSatellites: JSON.stringify(merged.assignedSatellites ?? []),
    startDate: merged.startDate ?? "",
    endDate: merged.endDate ?? "",
    objectives: merged.objectives ?? "",
    notes: merged.notes ?? "",
    tags: JSON.stringify(merged.tags ?? []),
    passCount: merged.passCount ?? 0,
    lastPassAt: merged.lastPassAt ?? "",
    updatedAt: new Date().toISOString(),
  });
  return parseMission(updated);
}

export async function deleteMission(id) {
  const rec = await pbGetByOldId("missions", +id).catch(() => null);
  if (!rec) return null;
  return pbDelete("missions", rec.id);
}

// ─── 静态图层（火点/风场示例数据）─────────────────────────────────────────
export async function getStaticLayer(layerType) {
  const rows = await pbAll("static_layers", {
    filter: `layerType='${String(layerType).replace(/'/g, "")}'`,
    sort: "-updatedAt",
  });
  const row = rows[0];
  if (!row) return null;
  const p = row.payload;
  if (p == null) return null;
  if (typeof p === "object") return p;
  try { return JSON.parse(p); } catch { return null; }
}

export async function setStaticLayer(layerType, payload) {
  const rows = await pbAll("static_layers", { filter: `layerType='${String(layerType).replace(/'/g, "")}'` });
  const data = {
    layerType,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    updatedAt: new Date().toISOString(),
  };
  if (rows[0]) return pbUpdate("static_layers", rows[0].id, data);
  return pbCreate("static_layers", { ...data, oldId: await pbNextOldId("static_layers") });
}
