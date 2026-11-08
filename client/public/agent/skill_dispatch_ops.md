---
name: dispatch-ops
description: 查询与操作遥感卫星调度系统时使用。
---
# 调度系统操作

业务 CLI 是 `dispatch`（已随会话安装）。常用命令：

- `dispatch tasks` 列任务；`dispatch task <id>` 看详情
- `dispatch create '<JSON>'` 创建任务单（字段见角色提示）
- `dispatch candidates <id>` 候选计算（耗时 10~60 秒，告知用户稍等）
- `dispatch dispatch <id>` 派单分流
- `dispatch sats <关键词>` 查卫星；`dispatch companies` 查公司履约

注意：CLI 输出均为 JSON，解析字段后用业务语言汇报，不要原文粘贴大 JSON。
API 地址已内置，无需配置。
