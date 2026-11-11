// ─── PB schema 自愈：relation 字段降级检测与修复 ──────────────────────────
// 场景：容器首启时 pb_setup 的 ensureCollection 若在目标 collection 未建时建了依赖表，
// relation 字段会降级为 number；此后业务代码用 relation 语法过滤 → PB 400。
// 本脚本：扫描 REL_FIELD_MAP 中的字段，凡类型为 number 的降级字段，PATCH 为 relation
//（旧数字值无法自动转换的清空——数据迁移期这些字段本来就该存 PB record id）。
// 用法：PB_URL/... node scripts/pb_fix_relations.mjs
const PB_URL = process.env.PB_URL || "http://127.0.0.1:8091";
const PB_ADMIN = process.env.PB_ADMIN || "admin@sat.local";
const PB_PASS = process.env.PB_PASS || "SatDispatch2026!";

const REL_FIELDS = [
  { table: "candidates", field: "task", target: "tasks" },
  { table: "rankings", field: "task", target: "tasks" },
  { table: "rankings", field: "candidate", target: "candidates" },
  { table: "orders", field: "task", target: "tasks" },
  { table: "directPlans", field: "task", target: "tasks" },
  { table: "fulfillmentLog", field: "task", target: "tasks" },
  { table: "taskPool", field: "task", target: "tasks" },
  { table: "dispatchLog", field: "task", target: "tasks" },
  { table: "dispatchLog", field: "order", target: "orders" },
];

async function main() {
  const a = await fetch(`${PB_URL}/api/collections/_superusers/auth-with-password`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: PB_ADMIN, password: PB_PASS }),
  }).then(r => r.json());
  if (!a.token) throw new Error("PB auth 失败");
  const h = { Authorization: a.token, "Content-Type": "application/json" };
  const cols = await fetch(`${PB_URL}/api/collections`, { headers: h }).then(r => r.json());
  const arr = cols.items || cols;
  let fixed = 0, ok = 0;
  for (const spec of REL_FIELDS) {
    const col = arr.find(c => c.name === spec.table);
    if (!col) { console.log(`[${spec.table}] collection 不存在，跳过`); continue; }
    const f = col.fields.find(x => x.name === spec.field);
    if (!f) { console.log(`[${spec.table}.${spec.field}] 字段不存在，跳过`); continue; }
    if (f.type === "relation") { ok++; continue; }
    // 降级字段：PATCH 为 relation
    const target = arr.find(c => c.name === spec.target);
    if (!target) { console.log(`[${spec.table}.${spec.field}] 目标 ${spec.target} 不存在，跳过`); continue; }
    const newFields = col.fields.map(x => x.name === spec.field
      ? { name: spec.field, type: "relation", collectionId: target.id, cascadeDelete: false, maxSelect: 1 }
      : x);
    const r = await fetch(`${PB_URL}/api/collections/${col.id}`, {
      method: "PATCH", headers: h, body: JSON.stringify({ fields: newFields }),
    }).then(r => r.json());
    if (r.id) { console.log(`[${spec.table}.${spec.field}] ${f.type} → relation ✅`); fixed++; }
    else console.log(`[${spec.table}.${spec.field}] 修复失败: ` + JSON.stringify(r).slice(0, 150));
  }
  console.log(`自愈完成：${fixed} 个字段修复，${ok} 个本就正常`);
  return fixed;
}
main().then(n => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
