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
  if (m?.has(oldId)) {
    const cached = m.get(oldId);
    // 缓存可能指向已删除的记录（多轮批量清理后 oldId 被重新使用）。
    // 命中后做一次存在性校验，失效则清除缓存重新查，避免下游 DELETE 收到 404
    // 被包装成 503「数据服务暂不可用」（用户点删除任务的报错根因）。
    try {
      await api(`/api/collections/${COL(table)}/records/${cached}?fields=id`);
      return cached;
    } catch (e) {
      if (e?.status === 404) { m.delete(oldId); _revCache.get(table)?.delete(cached); }
      else return cached;   // 其他错误不改变映射
    }
  }
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
export async function pbList(table, { filter, sort = "", limit = 100, page = 1, expand, fields } = {}) {
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
  try {
    return await api(`/api/collections/${COL(table)}/records/${recordId}${q}`);
  } catch (e) {
    // 陈旧缓存自愈：record id 404 时清掉该表的 id 映射缓存并重试一次
    // （场景：记录删除重建后 PB record id 变化，_idCache 仍指向旧 id → 详情 404）
    if (e.status === 404 && _idCache.get(table)?.size) {
      const oldId = _revCache.get(table)?.get(recordId);
      if (oldId != null) {
        _idCache.get(table).delete(oldId);
        _revCache.get(table).delete(recordId);
        const fresh = await pbRecordId(table, oldId);
        if (fresh && fresh !== recordId) return pbGet(table, fresh, { expand });
      }
    }
    throw e;
  }
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
  // 删除时同步失效 id 映射缓存（防删除重建同 oldId 后缓存指向已删 record）
  const oldId = _revCache.get(table)?.get(recordId);
  if (oldId != null) {
    _idCache.get(table)?.delete(oldId);
    _revCache.get(table)?.delete(recordId);
  }
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
// 修复记录：①seed 库无 counters 表时集合根本没建 → 以前每轮读/建/写全 500 且被 catch 吞掉，
// 20 轮空转后报「并发冲突超限」，误导排查；②现在首建、失败留痕，并带一个按库内最大序号的保底。
let _seqFallback = {};
export async function pbNextSeq(name) {
  let lastErr = null;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await api(`/api/collections/counters/records?filter=${encodeURIComponent(`name='${name}'`)}&perPage=1`);
      const rec = r?.items?.[0];
      if (!rec) {
        try {
          const c = await api("/api/collections/counters/records", "POST", { name, value: 1 });
          if (c?.id) return 1;
        } catch (e) {
          if (e.status === 404) throw e; // 集合不存在：立即上抛，不再空转
          if (e.status !== 400 && e.status !== 409) throw e; // 并发别人先建了，下一轮读到即可
        }
        continue;
      }
      const next = Number(rec.value || 0) + 1;
      const u = await api(`/api/collections/counters/records/${rec.id}`, "PATCH", { value: next });
      if (Number(u?.value) === next) return next;
    } catch (e) {
      lastErr = e;
      if (e.status === 404) break;
    }
    await new Promise(res => setTimeout(res, 10 + i * 10));
  }
  // 计数器不可用时退到库内最大序号（宁可跳号，不可阻断下单）
  const fb = await _seqFallbackNext(name).catch(() => null);
  if (fb) {
    console.warn(`[pbNextSeq] ${name} 计数器不可用（${lastErr?.message?.slice(0, 120) || "并发冲突"}），退保单号 ${fb}`);
    return fb;
  }
  throw new Error(`序列 ${name} 获取失败：${lastErr ? lastErr.message.slice(0, 200) : "并发冲突超限"}`);
}
async function _seqFallbackNext(name) {
  const now = _seqFallback[name] || 0;
  let fromDb = 0;
  if (name === "taskNo") {
    const r = await pbList("tasks", { sort: "-oldId", limit: 1, fields: "oldId" });
    fromDb = Number(r.items?.[0]?.oldId || 0);
  } else if (name === "orderNo") {
    const r = await pbList("orders", { sort: "-oldId", limit: 1, fields: "oldId" });
    fromDb = Number(r.items?.[0]?.oldId || 0);
  }
  const base = Math.max(now, fromDb);
  // taskNo 是跨日 3 位日号：日期变了就从 1 重起，避免序号无限膨胀
  const ymd = new Date(); const today = `${ymd.getUTCFullYear()}${String(ymd.getUTCMonth() + 1).padStart(2, "0")}${String(ymd.getUTCDate()).padStart(2, "0")}`;
  let fb;
  if (name === "taskNo") {
    // 读当天最大号：任务列表按 oldId 降序，取其中当天任务号的序号
    const r = await pbList("tasks", { sort: "-oldId", limit: 60, fields: "taskNo" });
    let maxSeq = 0;
    for (const t of r.items || []) {
      const m = String(t.taskNo || "").match(/^RSBH-\d{8}-(\d+)$/);
      if (m && String(t.taskNo).includes(today)) maxSeq = Math.max(maxSeq, Number(m[1]));
    }
    fb = Math.max(maxSeq + 1, 1);
    _seqFallback[name] = fb;
  } else {
    fb = base + 1;
    _seqFallback[name] = fb;
  }
  return fb;
}
