// ─── PB 启动自举（node 服务启动后异步执行，幂等）──────────────────────────
// 1. 等待容器内 PB (127.0.0.1:8091) 健康
// 2. 确保 collections 存在（从 seed SQLite 结构建，已存在跳过）
// 3. 数据迁移（断点续跑：行数满足即跳过+回读映射）
// 复用 scripts/pb_migrate.mjs 的核心逻辑，但以模块形式供 index.mjs 调用
import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PB_URL = process.env.PB_URL || "http://127.0.0.1:8091";
const PB_ADMIN = process.env.PB_ADMIN || "admin@sat.local";
const PB_PASS = process.env.PB_PASS || "SatDispatch2026!";
const SQLITE_PATH = process.env.SQLITE_PATH || join(__dirname, "..", "data", "satplanning.db");
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

export async function runSetup() {
  const t0 = Date.now();
  await waitPbHealthy();
  // 开 batch
  await api("/api/settings", "PATCH", { batch: { enabled: true, maxRequests: 500, timeout: 120 } }).catch(() => null);
  // 清 migrations 快照（防按字母序重放断链）——容器内 PB data 目录
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
      const r = await migrateTable(name, cols, rels, sqlite);
      summary.push(`${name}:${r.dst}/${r.src}`);
      if (r.dst < r.src) allOk = false;
    } catch (e) {
      console.error(`[pb_setup] [${name}] 失败: ${e.stack ? e.stack.slice(0, 400) : e.message}`);
      allOk = false;
    }
  }
  console.log(`[pb_setup] 完成 (${((Date.now()-t0)/1000).toFixed(1)}s): ${summary.join(' ')}`);
  return { ok: allOk, summary };
}
