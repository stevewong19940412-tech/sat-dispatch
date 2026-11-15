# 已停用的 SQLite 层（2026-11-15 归档）

数据层已全量迁移 PocketBase，以下文件**不再被任何代码引用**，仅留作历史参考：

- `db.mjs`：原 SQLite 数据层（better-sqlite3），被 `server/sat_repo.mjs` 取代
- `dispatch_schema.mjs`：原 SQLite 建表脚本（9 张业务表），已无入口

⚠️ 不要把它们移回 `server/` 或重新 import —— 一旦 import 就会在模块顶层
创建/打开 `data/satplanning.db` 并建表，重新引入"双数据源"问题。

运行期唯一数据源：PocketBase（`pb_repo.mjs` / `sat_repo.mjs`）。
一次性初始化（首建 PB 库时读 seed）：`pb_setup.mjs`，由 `counters.migration_done` 控制，已迁移则完全不打开 SQLite。
