// ─── PB 启动自举（node 服务启动后异步执行，幂等）──────────────────────────
// 1. 等待容器内 PB (127.0.0.1:8091) 健康
// 2. 确保 collections 存在（从 seed SQLite 结构建，已存在跳过）
//
// ⚠️ 边界说明（2026-11-15）：本文件是**一次性初始化工具**，不是运行期数据源。
// 运行期所有读写已全量走 PocketBase（见 sat_repo.mjs / pb_repo.mjs），
// 这里的 better-sqlite3 仅在「PB 首次建库」时读取 seed SQLite 的表结构与种子数据，
// 由 counters.migration_done 标记控制——迁移完成后永不再执行。
// 3. 数据迁移（断点续跑：行数满足即跳过+回读映射）
// 复用 scripts/pb_migrate.mjs 的核心逻辑，但以模块形式供 index.mjs 调用
import Database from "better-sqlite3";
import { join, dirname } from "path";
import { existsSync } from "fs";

// 安全：不在源码中内置默认口令。部署时必须通过 PB_PASS 环境变量提供，
// 缺失则启动即失败（快速失败），避免弱口令随代码公开泄露。
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`缺少必需的环境变量 ${name}（PocketBase 管理员口令）。请在部署环境设置后再启动。`);
  }
  return v;
}
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PB_URL = process.env.PB_URL || "http://127.0.0.1:8091";
const PB_ADMIN = process.env.PB_ADMIN || "admin@sat.local";
const PB_PASS = requireEnv("PB_PASS");
// 种子库路径：优先 seed 副本（部署容器只有它），本地开发回退到 data/satplanning.db
const SQLITE_PATH = process.env.SQLITE_PATH || (() => {
  const seed = join(__dirname, "..", "data", "seed-satplanning.db");
  const live = join(__dirname, "..", "data", "satplanning.db");
  return existsSync(seed) ? seed : live;
})();
const BATCH = 200;

const SQL_TYPE_MAP = { TEXT: "text", REAL: "number", INTEGER: "number", BLOB: "text" };
const ID_MAPS = {};
const REL_FIELD_MAP = {
  candidates: [{from:"taskId", pbField:"task", target:"tasks"}],
  rankings: [{from:"taskId", pbField:"task", target:"tasks"}, {from:"candidateId", pbField:"candidate", target:"candidates"}],
  orders: [{from:"taskId", pbField:"task", target:"tasks"}],
  directPlans: [{from:"taskId", pbField:"task", target:"tasks"}],
  fulfillmentLog: [{from:"taskId", pbField:"task", target:"tasks"}],
  taskPool: [{from:"taskId", pbField:"task", target:"tasks"}],
  dispatchLog: [{from:"taskId", pbField:"task", target:"tasks"}, {from:"orderId", pbField:"order", target:"orders"}],
};

let adminToken = null;
async function auth() {
  const r = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: PB_ADMIN, password: PB_PASS }),
  }).then(r => r.json());
  if (!r.token) throw new Error("PB superuser 登录失败: " + JSON.stringify(r).slice(0, 150));
  adminToken = r.token;
}
function h() { return { "Content-Type": "application/json", Authorization: adminToken }; }
async function api(path, method = "GET", body) {
  await auth();
  const r = await fetch(PB_URL + path, { method, headers: h(), body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
  return r;
}
async function waitPbHealthy(maxSec = 60) {
  for (let i = 0; i < maxSec; i++) {
    try { const r = await fetch(`${PB_URL}/api/health`); if (r.ok) return; } catch {}
    await new Promise(res => setTimeout(res, 1000));
  }
  throw new Error("PB 健康等待超时");
}

async function ensureCollection(name, cols, relations, sqlite) {
  const existing = await api("/api/collections");
  const arr = existing.items || existing;
  const found = arr.find(c => c.name === name);
  if (found) { (globalThis.__colArr ||= []).push(found); return found; }
  const fields = [];
  for (const c of cols) {
    if (c.name === "id") continue;
    const rel = relations.find(r => r.table === name && r.from === c.name);
    if (rel) {
      const targetId = (globalThis.__colArr || []).find(c => c.name === rel.target)?.id;
      if (targetId) fields.push({ name: c.name.replace(/Id$/, ""), type: "relation", collectionId: targetId, cascadeDelete: false, maxSelect: 1 });
      else fields.push({ name: c.name, type: "number" });
    } else {
      const sample = sqlite.prepare(`SELECT "${c.name}" v FROM ${name} LIMIT 1`).get()?.v;
      const isLong = (c.type === "TEXT" && typeof sample === "string" && (sample.length > 4000 || (/^[\[{]/.test(sample.trim()) && sample.length > 1200)));
      fields.push({ name: c.name, type: isLong ? "editor" : (SQL_TYPE_MAP[c.type] || "text") });
    }
  }
  if (!fields.find(f => f.name === "oldId")) fields.push({ name: "oldId", type: "number" });
  const r = await api("/api/collections", "POST", { name, type: "base", listRule: "", viewRule: "", createRule: "", updateRule: "", deleteRule: "", fields });
  if (!r.id) throw new Error(`建 ${name} 失败: ` + JSON.stringify(r).slice(0, 200));
  (globalThis.__colArr ||= []).push(r);
  console.log(`[pb_setup] [${name}] collection 创建（${fields.length} 字段）`);
  return r;
}

async function migrateTable(name, cols, relations, sqlite) {
  const count = sqlite.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n;
  const pbCount = (await api(`/api/collections/${name}/records?perPage=1`)).totalItems ?? 0;
  const idMap = ID_MAPS[name] || (ID_MAPS[name] = {});
  if (pbCount >= count) {
    let page = 1;
    while (true) {
      const r = await api(`/api/collections/${name}/records?perPage=500&page=${page}&fields=id,oldId`);
      for (const it of r.items || []) if (it.oldId != null) idMap[it.oldId] = it.id;
      if (page >= r.totalPages) break;
      page++;
    }
    console.log(`[pb_setup] [${name}] 已就绪 (${pbCount})`);
    return { src: count, dst: pbCount };
  }
  console.log(`[pb_setup] [${name}] 搬运 ${count} 行...`);
  let dst = 0;
  for (let off = 0; off < count; off += BATCH) {
    const rows = sqlite.prepare(`SELECT * FROM ${name} LIMIT ? OFFSET ?`).all(BATCH, off);
    const requests = rows.map(row => {
      const data = {};
      for (const c of cols) {
        if (c.name === "id") continue;
        const rel = REL_FIELD_MAP[name]?.find(x => x.pbField === c.name);
        const srcCol = rel ? rel.from : c.name;
        let v = row[srcCol];
        data[c.name] = v === undefined ? null : v;
      }
      for (const rel of REL_FIELD_MAP[name] || []) {
        const mapped = ID_MAPS[rel.target]?.[row[rel.from]];
        if (mapped) data[rel.pbField] = mapped; else delete data[rel.pbField];
      }
      data.oldId = row.id;
      return { method: "POST", url: `/api/collections/${name}/records`, body: data, __oldId: row.id };
    });
    const r = await api("/api/batch", "POST", { requests });
    if (!Array.isArray(r)) { console.error(`[${name}] 批次失败: ` + JSON.stringify(r).slice(0, 150)); break; }
    r.forEach((resp, i) => {
      if (resp.status === 200) idMap[requests[i].__oldId] = resp.body?.id;
    });
    dst += r.filter(x => x.status === 200).length;
  }
  return { src: count, dst };
}

// counters 集合不在 seed SQLite 里（旧实现是 SQLite INTEGER PRIMARY KEY 自增），
// 但 pbNextSeq 依赖它做 taskNo/orderNo 序列——不建就会每单 500「序列获取失败」。
async function ensureCountersCollection() {
  const existing = await api("/api/collections");
  const arr = existing.items || existing;
  if (arr.find(c => c.name === "counters")) return;
  const r = await api("/api/collections", "POST", {
    name: "counters", type: "base",
    listRule: "", viewRule: "", createRule: "", updateRule: "", deleteRule: "",
    fields: [
      { name: "name", type: "text", required: true },
      { name: "value", type: "number" },
    ],
  });
  if (!r.id) throw new Error("建 counters 失败: " + JSON.stringify(r).slice(0, 200));
  console.log("[pb_setup] [counters] collection 创建");
}

async function healRelations() {
  await auth();
  const cols2 = await api("/api/collections");
  const arr2 = cols2.items || cols2;
  const REL_FIELDS = [
    { table: "candidates", field: "taskId", pbField: "task", target: "tasks" },
    { table: "rankings", field: "taskId", pbField: "task", target: "tasks" },
    { table: "rankings", field: "candidateId", pbField: "candidate", target: "candidates" },
    { table: "orders", field: "taskId", pbField: "task", target: "tasks" },
    { table: "directPlans", field: "taskId", pbField: "task", target: "tasks" },
    { table: "fulfillmentLog", field: "taskId", pbField: "task", target: "tasks" },
    { table: "taskPool", field: "taskId", pbField: "task", target: "tasks" },
    { table: "dispatchLog", field: "taskId", pbField: "task", target: "tasks" },
    { table: "dispatchLog", field: "orderId", pbField: "order", target: "orders" },
  ];
  let fixedRel = 0;
  for (const spec of REL_FIELDS) {
    const col = arr2.find(c => c.name === spec.table);
    if (!col) continue;
    // 兼容两种命名：降级 number 保留原列名（taskId），正常 relation 是 pbField（task）
    const f = col.fields.find(x => x.name === spec.field);
    const fRel = col.fields.find(x => x.name === spec.pbField);
    if (fRel && fRel.type === "relation") continue; // 已是 relation
    if (!f) continue; // 两种名都不存在
    const target = arr2.find(c => c.name === spec.target);
    if (!target) continue;
    const newFields = col.fields.map(x => x.name === spec.field
      ? { name: spec.pbField, type: "relation", collectionId: target.id, cascadeDelete: false, maxSelect: 1 }
      : x);
    const r = await api(`/api/collections/${col.id}`, "PATCH", { fields: newFields });
    if (r.id) { fixedRel++; console.log(`[pb_setup] [${spec.table}.${spec.field}] ${f.type} → relation 自愈`); }
  }
  if (fixedRel) console.log(`[pb_setup] relation 自愈 ${fixedRel} 个字段`);
}

export async function runSetup(opts = {}) {
  const t0 = Date.now();
  await waitPbHealthy();
  await ensureCountersCollection().catch(e => console.error("[pb_setup] counters 自举失败:", e.message));
  // 开 batch
  await api("/api/settings", "PATCH", { batch: { enabled: true, maxRequests: 500, timeout: 120 } }).catch(() => null);
  // 清 migrations 快照（防按字母序重放断链）——容器内 PB data 目录
  // 首迁标记：PB 已完成过一次数据迁移就不再从 seed SQLite 灌数据（否则清空后的数据会被回填）
  const doneFlag = await api(`/api/collections/counters/records?filter=${encodeURIComponent("name='migration_done'")}`).catch(() => null);
  const migrated = doneFlag?.items?.[0]?.value === 1;
  // P0 修复（2026-11-15）：已首迁完成就**根本不打开 SQLite**——运行期只有一个数据源（PB）。
  // 只有「首次建库」且 seed 文件真实存在时才读 SQLite，读完立刻 close，避免句柄泄漏与隐性耦合。
  if (migrated) {
    console.log("[pb_setup] 已迁移过（migration_done=1），跳过数据灌入，不打开 SQLite");
    if (opts.skipRelHeal) return console.log("[pb_setup] 跳过 relation 自愈（skipRelHeal）");
    return await healRelations();
  }
  if (!existsSync(SQLITE_PATH)) {
    console.error(`[pb_setup] 首次初始化但找不到种子库 ${SQLITE_PATH}，跳过灌数据（PB 将为空库）`);
    if (opts.skipRelHeal) return console.log("[pb_setup] 跳过 relation 自愈（skipRelHeal）");
    return await healRelations();
  }
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  const order = ["tasks", "candidates", "rankings", "orders", "directPlans", "companies", "fulfillmentLog", "taskPool", "dispatchLog", "missions", "static_layers", "satellites"];
  const sorted = order.filter(t => tables.includes(t)).concat(tables.filter(t => !order.includes(t)));
  let allOk = true;
  const summary = [];
  for (const name of sorted) {
    try {
      const cols = sqlite.prepare(`PRAGMA table_info(${name})`).all();
      const rels = REL_FIELD_MAP[name] || [];
      await ensureCollection(name, cols, rels, sqlite);
      const r = migrated ? { src: 0, dst: -1 } : await migrateTable(name, cols, rels, sqlite);
      summary.push(`${name}:${r.dst}/${r.src}`);
      if (!migrated && r.dst < r.src) allOk = false;
    } catch (e) {
      console.error(`[pb_setup] [${name}] 失败: ${e.stack ? e.stack.slice(0, 400) : e.message}`);
      allOk = false;
    }
  }
  sqlite.close(); // 首迁读完即释放，运行期不再持有 SQLite 句柄
  if (!migrated) {
    // 写首迁标记
    const flag = await api(`/api/collections/counters/records?filter=${encodeURIComponent("name='migration_done'")}`).catch(() => null);
    if (flag?.items?.[0]) await api(`/api/collections/counters/records/${flag.items[0].id}`, "PATCH", { value: 1 });
    else await api("/api/collections/counters/records", "POST", { name: "migration_done", value: 1 });
    console.log("[pb_setup] 首迁完成，已写标记");
  } else {
    console.log("[pb_setup] 已迁移过（migration_done=1），跳过数据灌入");
  }
  // relation 字段自愈：仅显式触发时执行（启动路径 skipRelHeal=true 跳过，防 PATCH 失败影响启动）
  if (opts.skipRelHeal) {
    console.log("[pb_setup] 跳过 relation 自愈（skipRelHeal）");
  } else {
    await healRelations();
  }
  console.log(`[pb_setup] 完成 (${((Date.now()-t0)/1000).toFixed(1)}s): ${summary.join(' ')}`);
  return { ok: allOk, summary };
}
