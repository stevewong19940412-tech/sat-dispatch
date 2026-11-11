---
name: dispatch-ops
description: 查询与操作遥感卫星统一调度系统时使用——下单、候选、派单、直控、批量任务规划的标准操作口径（固化历次任务实测经验）。
---
# 调度系统操作 SOP

业务 CLI 随本 skill 安装在 skill 目录内（`dispatch_cli.py`）。调用方式：

```bash
CLI=$(find /root/.blade/runtime/*/skills/dispatch-ops -name dispatch_cli.py 2>/dev/null | head -1)
python3 "$CLI" <子命令>   # 或先 cp "$CLI" /usr/local/bin/dispatch && chmod +x 之，直接 dispatch <命令>
```

## 铁律（违反任何一条都曾真实翻车）

1. **调度系统是常驻服务，永远不需要"恢复"或重启**。禁止 `blade session copy-dir`、`pnpm install`、重启 server——那是在修不存在的故障。探测可用性：`dispatch companies` 返回 JSON 即通；401 就 `export BLADE_API_TOKEN=$(printenv BLADE_API_TOKEN)` 重试。
2. **地址解析链脚本已内置**：`DISPATCH_APP_BASE` 环境变量 → 页面上下文 → 常驻域名。**禁止写死开发端口（21140/21141/21142）**，端口会漂移。
3. **geom 格式**（不是 GeoJSON！）：点 `{"lat":39.9,"lon":116.4}`；面 `{"coords":[[lat,lon],...]}`。传 GeoJSON 会**静默 0 候选**（最坑）；传 Polygon 给 candidates 会 500。宽窗诊断任务 candidates=0 且 gapStats={} → 先怀疑 geom 格式，再怀疑真无窗。
4. **下单前先 `dispatch preflight`**（秒级、不写库）：时窗跨度/光照可行性/云量源边界/geom 格式一次查完。傍晚窗（当地太阳高度角<10°）光学无解、72h 外云量是模拟场——这两类坑预检直接报。

## 云量双源口径（批量下单必读）

系统云量有两个来源，按**过顶时刻距建单时刻**自动切换，候选行 `cloudSource` 字段标明：

| 范围 | 来源 | 可信度 |
|---|---|---|
| 建单后 72h 内 | open-meteo 真实逐小时预报（`real`） | 可信，按 maxCloud 硬筛 |
| 72h 外 | 内置模拟气象场（`simulated`） | **无物理意义**，真实 100% 它可能给 24%，反之亦然 |

**批量/长窗下单标准动作**：maxCloud 放宽到 1（不筛云）→ 派单 → 过顶前 72h 内重跑 candidates 用真实云量取舍；或改派 SAR（不受云量约束）。汇报时 simulated 云量必须注明"模拟气象场，非真实预报"。解算筛选与展示用的是同一个 `cloudFc` 值（不存在两套），但"可用度"= `cloudEffective()` 几何修正（侧摆劣化+光照打折）后的值，比"100−云量"偏低是设计行为。

## 窗口与光照（下单前先算再下）

- **光学过顶集中在当地 10:30~13:30**（太阳同步轨道）。用户给的早窗/傍晚窗先 `dispatch preflight` 判光照，物理不可行就 AskUserQuestion 给替代（改白天/改 SAR/放宽窗）。
- **"明天 X 点"先换算**：服务器 UTC，"明天"按 Asia/Shanghai；11 月北京 6 点日出、太阳高度角 8 点仅 ~10°。
- **窄窗 candidates=0 且 gapStats 空 ≠ 系统故障**：先用宽窗诊断任务（maxCloud=1、≥3 天窗）验证链路（candidates>0 且 gapStats 有筛除条目 = 链路正常），再筛真实窗口。
- **"某地全境"口径**：先问用户——全市域 polygon / 主城区 / 中心点。全岛/全市 polygon 系统自动拆条带（直径/12km 幅宽），**优先用 polygon 单任务而不是手工拆 N 个点任务**（任务数少、条带连续、跟踪简单）。

## 批量建单（格网测绘类，工程侧刚性入口）

**AI 文本输出不算数**——「生成了 120 个任务」只有 `dispatch batch-create` 返回的 created 数组才是事实。标准动作：

```bash
dispatch batch-create '@任务数组.json' 1   # 末参1=自动确认下发（AI建单两步走自动完成）
```

- 服务端单事务原子落库（≤500条/次，更多分批）；逐条返回 成功(taskId/taskNo)/失败(errors)
- 回执只看三个数：requested / createdCount / failedCount；失败的直接列 errors，无解/坏数据如实报，不写长篇解释
- 建完必须回读断言：`dispatch tasks` 抽查计数与 createdCount 一致

## AI 建单两步走

AI/对话创建的任务 `pendingConfirm=1`：先 `POST /api/dispatch/tasks/<id>/confirm` 确认，再 `dispatch dispatch <id>`。顺序反了报 400"任务待人工确认下发"。CLI 吞错误体时用 `curl -H "Authorization: Bearer $BLADE_API_TOKEN"` 打同 URL 看 error 详情。

## 批量任务流水线（参考 2026-11-10 北京全域 / 11-11 台湾全岛实测）

1. **条带拆分锚点用真实经纬度边界**，不是质心极值；核对=逐带列覆盖区，全覆盖才过。
2. **脚本链落 JSON 断点续跑**：strips → created_tasks → candidates → dispatch_results → 交付 CSV；重跑只补未完成项。
3. **候选计算是瓶颈**：30 天窗全星约 25s/任务（优化后，段栅格对齐+缓存跨任务复用），100 任务约 8 分钟；建单前告知用户量级，分批跑。
4. **SAR 分辨率**：1m 会大量"分辨率不满足"，5m 稳定。
5. **交付前 Counter 统计**渠道/公司/卫星/状态；过顶时间交**北京时间**不要交 UTC 裸值；诊断/探针单先 `dispatch delete` 清掉。
6. **时效口径**：`timelinessHours` 按【创建→过顶】算。"明天完成"类需求会被全筛，应急直控需 ranking 非空。

## 直控链路（应急任务）

直控方案状态机：待确认 → ①计算直控参数包（generate）→ 待核验下发 → ②方案确认（值班）→ 方案已确认 → ③核验并确认上注（四项勾选全勾）→ 已上注/执行中 → ④执行完成回写。**校验驳回不是死胡同**：卡片有「换一颗候选卫星解算」（CLI 侧 `POST /dispatch/plans/<id>/reassign`）。**所有候选都拍不到**时系统 422 拒建并给规划诊断（扩窗/放宽分辨率/改 SAR）——这是初始规划问题不是解算问题。直控最终产物是参数包（解算通过即可在抽屉查看）。

## 大区域无解三归因（按 2026-11-11 长窗漏解 bug 修复后的口径）

1. 长窗已支持分段采样（原 3 天封顶 bug 已修），扩时间窗有效——首选手段；
2. 分辨率太严筛掉能拍的星 → 看诊断 attribution 放宽；
3. 时窗内过顶几何不可行（最近距离 >> 幅宽半宽）→ 改 SAR/宽幅星或核对目标位置。

## 汇报口径

- 任务号、坐标、候选通过数+筛除主因（gapStats）、排序前三、分流通道与承接公司、订单终态。
- CLI 输出均为 JSON：解析字段后用业务语言汇报，**不要原文粘贴大 JSON**。
- 声明云量来源（real=真实预报 / simulated=模拟气象场非真实预报）。
