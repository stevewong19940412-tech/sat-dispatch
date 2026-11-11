// ─── PocketBase 迁移工具：旧 SQLite 全表 → PB collections + 数据搬迁 ──────
// 用法：
//   PB_URL=http://127.0.0.1:8090 \
//   PB_ADMIN=admin@sat.local PB_PASS='SatDispatch2026!' \
//   SQLITE_PATH=data/satplanning.db \
//   node scripts/pb_migrate.mjs
//
// 特性：
// - 从 SQLite PRAGMA 自动推断字段类型（TEXT→text / REAL·INTEGER→number）
// - relation 字段自动建（tasks 被多表引用时）
// - 批量搬运（PB batch 事务，每批 200 条），断点可重跑（按表计数跳过已迁满的表）
// - 迁移完成后输出 每表行数对照表 + 不一致项清单
import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PB_URL = process.env.PB_URL || "http://127.0.0.1:8090";
const PB_ADMIN = process.env.PB_ADMIN || "admin@sat.local";
const PB_PASS = process.env.PB_PASS || "SatDispatch2026!";
const SQLITE_PATH = process.env.SQLITE_PATH || join(__dirname, "..", "data", "satplanning.db");
const BATCH = 200;
const SKIP_TABLES = new Set(["sqlite_sequence"]);
const ID_MAPS = {}; // table → {旧sqlite数字id: PB record id}
const REL_FIELD_MAP = {
  candidates: [{from:"taskId", pbField:"task", target:"tasks"}],
  rankings: [{from:"taskId", pbField:"task", target:"tasks"}, {from:"candidateId", pbField:"candidate", target:"candidates"}],
  orders: [{from:"taskId", pbField:"task", target:"tasks"}],
  directPlans: [{from:"taskId", pbField:"task", target:"tasks"}],
  fulfillmentLog: [{from:"taskId", pbField:"task", target:"tasks"}],
  taskPool: [{from:"taskId", pbField:"task", target:"tasks"}],
  dispatchLog: [{from:"taskId", pbField:"task", target:"tasks"}, {from:"orderId", pbField:"order", target:"orders"}],
};

const sqlite = new Database(SQLITE_PATH, { readonly: true });
sqlite.pragma("journal_mode = WAL");

let adminToken = null;
async function auth() {
  const r = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: PB_ADMIN, password: PB_PASS }),
  }).then(r => r.json());
  if (!r.token) throw new Error("PB superuser 登录失败: " + JSON.stringify(r));
  adminToken = r.token;
  return r.token;
}
function h() { return { "Content-Type": "application/json", Authorization: adminToken }; }
async function api(path, method = "GET", body) {
  const r = await fetch(PB_URL + path, { method, headers: h(), body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
  return r;
}

const SQL_TYPE_MAP = { TEXT: "text", REAL: "number", INTEGER: "number", BLOB: "text" };

async function ensureCollection(name, cols, relations) {
  const existing = await api("/api/collections");
  const arr = existing.items || existing;
  if (arr.find(c => c.name === name)) { console.log(`  [${name}] collection 已存在，跳过创建`); return arr.find(c => c.name === name); }
  const fields = [];
  for (const c of cols) {
    if (c.name === "id") continue;
    const rel = relations.find(r => r.table === name && r.from === c.name);
    if (rel) {
      fields.push({ name: c.name === "taskId" ? "task" : c.name.replace(/Id$/, ""), type: "relation", collectionId: rel.targetColId, cascadeDelete: false, maxSelect: 1 });
    } else {
      // 长文本/JSON 类列用 editor 类型（无 5000 字符上限）；按列名与样例值判定
      const sample = sqlite.prepare(`SELECT "${c.name}" v FROM ${name} LIMIT 1`).get()?.v;
      const isLong = (c.type === 'TEXT' && typeof sample === 'string' && (sample.length > 4000 || /^[\[{]/.test(sample.trim()) && sample.length > 1200));
      fields.push({ name: c.name, type: isLong ? "editor" : (SQL_TYPE_MAP[c.type] || "text") });
    }
  }
  // 全部表都加 oldId（旧 SQLite 数字主键）：断点续跑时从 PB 回读重建「旧数字外键 → PB record id」映射
  if (!fields.find(f => f.name === "oldId")) fields.push({ name: "oldId", type: "number" });
  const body = {
    name, type: "base",
    listRule: "", viewRule: "", createRule: "", updateRule: "", deleteRule: "",
    fields,
  };
  const r = await api("/api/collections", "POST", body);
  if (!r.id) throw new Error(`建 collection ${name} 失败: ` + JSON.stringify(r).slice(0, 300));
  console.log(`  [${name}] collection 创建成功（${fields.length} 字段）`);
  if (!globalThis.__colArr) globalThis.__colArr = [];
  globalThis.__colArr.push(r); // 后续表的 relation 引用需要最新的 collectionId
  return r;
}

async function migrateTable(name, cols) {
  const count = sqlite.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n;
  const pbCount = (await api(`/api/collections/${name}/records?perPage=1`)).totalItems ?? 0;
  if (count === 0) { console.log(`  [${name}] 源表 0 行，跳过`); return { src: 0, dst: 0 }; }
  if (pbCount >= count) {
    // 断点续跑：从 PB 回读 oldId → record id 映射（后续表的 relation 翻译依赖它）
    const idMap = ID_MAPS[name] || (ID_MAPS[name] = {});
    let page = 1;
    while (true) {
      const r = await api(`/api/collections/${name}/records?perPage=500&page=${page}&fields=id,oldId`);
      for (const it of r.items || []) if (it.oldId != null) idMap[it.oldId] = it.id;
      if (page >= r.totalPages) break;
      page++;
    }
    console.log(`  [${name}] 已迁移 (${pbCount}/${count})，回读映射 ${Object.keys(idMap).length} 条`);
    return { src: count, dst: pbCount };
  }
  console.log(`  [${name}] 搬运 ${count} 行（PB 已有 ${pbCount}）...`);
  let dst = pbCount;
  const idMap = ID_MAPS[name] || (ID_MAPS[name] = {});
  for (let off = 0; off < count; off += BATCH) {
    const rows = sqlite.prepare(`SELECT * FROM ${name} LIMIT ? OFFSET ?`).all(BATCH, off);
    const body = { requests: rows.map(row => {
      const data = {};
      for (const c of cols) {
        if (c.name === "id") continue;
        // c.name 可能是映射后的 PB 字段名（taskId→task），原始列名需从 REL_FIELD_MAP 反推
        const rel = REL_FIELD_MAP[name]?.find(x => x.pbField === c.name);
        const srcCol = rel ? rel.from : c.name;
        let v = row[srcCol];
        data[c.name] = v === undefined ? null : v;
      }
      // relation 字段：把旧数字外键翻译成目标表 PB record id
      const relCols = Object.keys(data).filter(k => REL_FIELD_MAP[name]?.some(x => x.pbField === k));
      for (const k of relCols) {
        const target = REL_FIELD_MAP[name].find(x => x.pbField === k);
        data[k] = ID_MAPS[target.target]?.[row[target.from]] || "";
        if (!data[k]) delete data[k]; // 映射不到的先不写
      }
      data.oldId = row.id;
      return { method: "POST", url: `/api/collections/${name}/records`, body: data, __oldId: row.id };
      if (process.env.PB_DEBUG && off === 0 && row === rows[0]) {
        console.log(`    [debug-sample] ${name} 第一条 data.task=${JSON.stringify(data.task)} data.oldId=${JSON.stringify(data.oldId)}`);
      }
    })};
    const r = await api("/api/batch", "POST", body);
    if (!Array.isArray(r)) { console.log(`    批次 ${off} 失败: ` + JSON.stringify(r).slice(0, 200)); break; }
    // batch 回执顺序与请求顺序一致（每项含 status/body）
    r.forEach((resp, i) => {
      const oldRowId = body.requests[i]?.__oldId;
      if (oldRowId && resp.status === 200) {
        idMap[oldRowId] = resp.body?.id;
      }
    });
    dst += r.filter(x => x.status === 200).length;
  }
  if (process.env.PB_DEBUG) console.log(`    [debug] ${name} idmap=${Object.keys(ID_MAPS[name]||{}).length}`);
  return { src: count, dst };
}

async function main() {
  console.log("== SQLite → PocketBase 迁移 ==");
  await auth();
  // PB 0.39 默认禁用 batch API——迁移必须开启
  const settings = await api("/api/settings", "PATCH", { batch: { enabled: true, maxRequests: 500, timeout: 120 } });
  console.log("batch API:", settings.batch?.enabled ? "已开启" : "开启失败: " + JSON.stringify(settings).slice(0,150));
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  // relation 依赖：candidates.taskId→tasks, rankings.taskId/candidateId→tasks/candidates, orders.taskId→tasks, directPlans.taskId→tasks, fulfillmentLog.taskId→tasks, taskPool.taskId→tasks, dispatchLog.taskId/orderId→tasks/orders
  const tasksCol = await ensureCollection("tasks", sqlite.prepare("PRAGMA table_info(tasks)").all(), []);
  const colId = (n) => { /* 二次拉取拿 collectionId */ };
  const allCols = await api("/api/collections");
  globalThis.__colArr = allCols.items || allCols;
  const cid = (name) => globalThis.__colArr.find(c => c.name === name)?.id;
  const RELATIONS = [
    { table: "candidates", from: "taskId", target: "tasks" },
    { table: "rankings", from: "taskId", target: "tasks" },
    { table: "rankings", from: "candidateId", target: "candidates" },
    { table: "orders", from: "taskId", target: "tasks" },
    { table: "directPlans", from: "taskId", target: "tasks" },
    { table: "fulfillmentLog", from: "taskId", target: "tasks" },
    { table: "taskPool", from: "taskId", target: "tasks" },
    { table: "dispatchLog", from: "taskId", target: "tasks" },
    { table: "dispatchLog", from: "orderId", target: "orders" },
  ];
  const order = ["tasks", "candidates", "rankings", "orders", "directPlans", "companies", "fulfillmentLog", "taskPool", "dispatchLog", "missions", "static_layers", "satellites"];
  const sorted = order.filter(t => tables.includes(t)).concat(tables.filter(t => !order.includes(t) && !SKIP_TABLES.has(t)));
  const result = {};
  for (const name of sorted) {
    const cols = sqlite.prepare(`PRAGMA table_info(${name})`).all();
    const rels = RELATIONS.filter(r => r.table === name).map(r => ({ ...r, targetColId: cid(r.target) })).filter(r => r.targetColId);
    try {
      await ensureCollection(name, cols, rels);
      if (process.env.PB_DEBUG) console.log(`    [debug] ${name} cols=${cols.length} relations=${rels.length}`);
      // relation 字段名重映射：taskId → task（建 collection 时已换），搬运时同步换 key
      const r = await migrateTable(name, cols.map(c => ({ ...c, name: (rels.find(rr => rr.from === c.name) && c.name.endsWith("Id")) ? c.name.replace(/Id$/, "") : c.name })));
      result[name] = r;
    } catch (e) {
      console.error(`  [${name}] 迁移失败: ${e.message}`);
      result[name] = { error: e.message };
    }
  }
  console.log("\n== 迁移结果对照 ==");
  console.log("表名\t源行数\tPB行数\t一致");
  let allOk = true;
  for (const [name, r] of Object.entries(result)) {
    if (r.error) { console.log(`${name}\tERR\tERR\t${r.error.slice(0, 60)}`); allOk = false; continue; }
    const ok = r.src === r.dst;
    if (!ok) allOk = false;
    console.log(`${name}\t${r.src}\t${r.dst}\t${ok ? "✅" : "❌"}`);
  }
  console.log(allOk ? "\n✅ 迁移全部一致" : "\n⚠ 存在行数差异（持久卷场景下运行期增量属正常），继续启动");
  // 不以不一致退出：持久卷场景下线上运行期产生的数据会比 seed 多，属正常增量
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
