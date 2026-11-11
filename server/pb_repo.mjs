// ─── PocketBase 数据访问层（P2/P3 迁移公共地基）─────────────────────────────
// 设计：
//  - 全部业务表已有同 PB collection（见 scripts/pb_migrate.mjs 迁移结果）
//  - 旧 SQLite 数字 id 通过每表 oldId 字段回查（迁移时写入）
//  - 业务代码经此层 CRUD，不直接依赖 PB SDK；后续切库只改本文件
// 环境变量：PB_URL（默认 http://127.0.0.1:8091）、PB_ADMIN、PB_PASS

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8091";
const PB_ADMIN = process.env.PB_ADMIN || "admin@sat.local";
const PB_PASS = process.env.PB_PASS || "SatDispatch2026!";

let _token = null, _tokenExp = 0;
export async function pbAuth() {
  if (_token && Date.now() < _tokenExp) return _token;
  const r = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: PB_ADMIN, password: PB_PASS }),
  }).then(r => r.json());
  if (!r.token) throw new Error("PB auth 失败: " + JSON.stringify(r).slice(0, 200));
  _token = r.token;
  _tokenExp = Date.now() + 14 * 60 * 1000;
  return _token;
}
function h() { return { "Content-Type": "application/json", Authorization: _token }; }
async function api(path, method = "GET", body, retry = 1) {
  await pbAuth();
  const r = await fetch(PB_URL + path, { method, headers: h(), body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && retry > 0) { _token = null; return api(path, method, body, retry - 1); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`PB ${method} ${path} → ${r.status}: ${JSON.stringify(j).slice(0, 300)}`); e.status = r.status; e.pb = j; throw e; }
  return j;
}

// 表名 → collection 名（本系统同名映射）
const COL = (t) => t;

// ── 旧数字 id ↔ PB record id 索引（迁移时写入的 oldId 字段）─────────────────
const _idCache = new Map(); // table → Map(oldId → recordId)
const _revCache = new Map(); // table → Map(recordId → oldId)
export async function pbRecordId(table, oldId) {
  let m = _idCache.get(table);
  if (m?.has(oldId)) return m.get(oldId);
  m = m || new Map(); _idCache.set(table, m);
  const r = await api(`/api/collections/${COL(table)}/records?filter=${encodeURIComponent(`oldId=${oldId}`)}&perPage=1&fields=id,oldId`);
  if (r.items?.[0]) { m.set(oldId, r.items[0].id); return r.items[0].id; }
  return null;
}
export async function pbOldId(table, recordId) {
  let m = _revCache.get(table);
  if (m?.has(recordId)) return m.get(recordId);
  m = m || new Map(); _revCache.set(table, m);
  const r = await api(`/api/collections/${COL(table)}/records/${recordId}?fields=id,oldId`);
  if (r.oldId != null) { m.set(recordId, r.oldId); return r.oldId; }
  return null;
}
export function pbCacheIds(table, pairs) { // 批量预热：[[oldId, recordId], ...]
  const m = _idCache.get(table) || new Map(); _idCache.set(table, m);
  const rev = _revCache.get(table) || new Map(); _revCache.set(table, rev);
  for (const [o, p] of pairs) { m.set(o, p); rev.set(p, o); }
}

// ── 通用 CRUD ──────────────────────────────────────────────────────────────
export async function pbList(table, { filter, sort = "-oldId", limit = 100, page = 1, expand, fields } = {}) {
  const q = new URLSearchParams();
  if (filter) q.set("filter", filter);
  if (sort) q.set("sort", sort);
  q.set("perPage", String(Math.min(limit, 500)));
  q.set("page", String(page));
  if (expand) q.set("expand", expand);
  if (fields) q.set("fields", fields);
  const r = await api(`/api/collections/${COL(table)}/records?${q}`);
  return { items: r.items, total: r.totalItems, page: r.page, totalPages: r.totalPages };
}
// 全量分页拉取（替代 SELECT 无 LIMIT 场景）
export async function pbAll(table, { filter, sort, expand, fields } = {}) {
  const out = []; let page = 1;
  while (true) {
    const r = await pbList(table, { filter, sort, expand, fields, limit: 500, page });
    out.push(...r.items);
    if (page >= r.totalPages || r.items.length === 0) break;
    page++;
  }
  return out;
}
export async function pbGet(table, recordId, { expand } = {}) {
  const q = expand ? `?expand=${expand}` : "";
  return api(`/api/collections/${COL(table)}/records/${recordId}${q}`);
}
export async function pbGetByOldId(table, oldId) {
  const rid = await pbRecordId(table, oldId);
  return rid ? pbGet(table, rid) : null;
}
export async function pbCreate(table, data) {
  return api(`/api/collections/${COL(table)}/records`, "POST", data);
}
export async function pbUpdate(table, recordId, data) {
  return api(`/api/collections/${COL(table)}/records/${recordId}`, "PATCH", data);
}
export async function pbDelete(table, recordId) {
  return api(`/api/collections/${COL(table)}/records/${recordId}`, "DELETE");
}
// 批量（PB batch；≤200/批），返回逐条结果
// method 支持 HTTP 原生值（POST/PATCH/DELETE/PUT）与业务别名（CREATE→POST、UPDATE→PATCH）——
// PB 0.39 的 batch 校验只认 HTTP 方法名，别名在这里归一
const _METHOD_ALIAS = { CREATE: "POST", UPDATE: "PATCH", UPSERT: "PUT" };
export async function pbBatch(ops) { // ops: [{table, method, data, recordId?, oldId?}]
  const results = [];
  for (let i = 0; i < ops.length; i += 200) {
    const chunk = ops.slice(i, i + 200);
    await pbAuth();
    const body = { requests: chunk.map(op => ({
      method: _METHOD_ALIAS[(op.method || "POST").toUpperCase()] || op.method || "POST",
      url: `/api/collections/${COL(op.table)}/records${op.recordId ? "/" + op.recordId : ""}`,
      body: op.data,
    }))};
    const r = await api("/api/batch", "POST", body);
    if (!Array.isArray(r)) throw new Error("PB batch 失败: " + JSON.stringify(r).slice(0, 200));
    r.forEach((resp, j) => {
      const op = chunk[j];
      results.push({ ok: resp.status === 200, table: op.table, data: resp.body, op });
      if (resp.status === 200 && op.method === "POST" && op.oldId != null && resp.body?.id) {
        pbCacheIds(op.table, [[op.oldId, resp.body.id]]);
      }
    });
  }
  return results;
}
// 原子计数器：替代旧 taskNo/orderNo 序列（counters collection，CAS 重试）
export async function pbNextSeq(name) {
  for (let i = 0; i < 20; i++) {
    const r = await api(`/api/collections/counters/records?filter=${encodeURIComponent(`name='${name}'`)}`).catch(() => null);
    const rec = r?.items?.[0];
    if (!rec) {
      const c = await api("/api/collections/counters/records", "POST", { name, value: 1 }).catch(() => null);
      if (c?.id) return 1;
      continue;
    }
    const u = await api(`/api/collections/counters/records/${rec.id}`, "PATCH", { value: rec.value + 1 }).catch(() => null);
    if (u?.value === rec.value + 1) return rec.value + 1;
  }
  throw new Error(`序列 ${name} 获取失败（并发冲突超限）`);
}
