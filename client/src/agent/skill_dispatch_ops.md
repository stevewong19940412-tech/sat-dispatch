---
name: dispatch-ops
description: 查询与操作遥感卫星调度系统时使用。
---
# 调度系统操作

业务 CLI 脚本随本 skill 安装在 skill 目录内（`dispatch_cli.py`）。调用方式：

```bash
# 先定位 skill 目录（本 skill 安装在 runtime skills 目录下）
CLI=$(find /root/.blade/runtime/*/skills/dispatch-ops -name dispatch_cli.py 2>/dev/null | head -1)
python3 "$CLI" <子命令>
```

常用命令：

- `dispatch tasks` 列任务；`dispatch task <id>` 看详情
- `dispatch create '<JSON>'` 创建任务单（字段见角色提示）
- `dispatch candidates <id>` 候选计算（耗时 10~60 秒，告知用户稍等）
- `dispatch dispatch <id>` 派单分流
- `dispatch sats <关键词>` 查卫星；`dispatch companies` 查公司履约

注意：
- CLI 输出均为 JSON，解析字段后用业务语言汇报，不要原文粘贴大 JSON。
- API 地址已内置在脚本中；脚本需要 `BLADE_API_TOKEN` 环境变量过网关鉴权（沙盒环境已提供）。若调用返回 401，执行 `export BLADE_API_TOKEN=$(printenv BLADE_API_TOKEN)` 重试。
- 把脚本拷到 PATH 里更顺手：`cp "$CLI" /usr/local/bin/dispatch && chmod +x /usr/local/bin/dispatch`，之后直接 `dispatch <命令>`。
