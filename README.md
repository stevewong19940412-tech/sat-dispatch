# 遥感卫星统一调度系统 (sat-dispatch)

面向遥感卫星任务的统一调度平台：从区域需求受理 → 条带规划 → 候选卫星计算 → 覆盖判定 → 派单/直控 → 订单履约，全链路的 Web 系统。

## 功能概览

| 模块 | 能力 |
|---|---|
| **三维态势** | Three.js 地球、310 颗卫星实时位置、轨迹、AOI 圈选 |
| **区域规划** | 按尺度自动判定 point/small/medium/large/national，决定是否拆条带、拆几条 |
| **条带划分** | 按可用幅宽切条带，方向沿星下点轨迹择优（± 动中成像偏角内枚举） |
| **候选计算** | 过顶窗口解算、侧摆/分辨率/云量/光照/覆盖率多维约束 |
| **工程校验** | 8 项硬校验（条带编号自洽、覆盖完整性、覆盖率门槛、类型匹配等），不通过阻断 |
| **派单/直控** | 指派 / 询价 / 抢单 / 直控四条通道；直控生成标准指令参数包 |
| **订单履约** | 状态机：已派发 → 已接单 → 执行中 → 已交付 → 已验收 |

## 技术栈

- **前端**：React 18 + Vite + Three.js
- **后端**：Node.js (Express) + PocketBase（数据层）
- **算法**：卫星轨道 SGP4 递推、条带覆盖几何、多星集合覆盖分派
- **智能体**：内置 `dispatch` CLI，供 AI 助手按 Skill 编排调用

## 快速开始

### 环境要求

- Node.js ≥ 20
- pnpm

### 安装与运行

```bash
pnpm install

# 配置环境变量（必需）
cp .env.example .env
# 编辑 .env，设置 PB_ADMIN / PB_PASS

# 开发模式（前端 Vite + 后端 Node）
pnpm dev
```

生产构建：

```bash
pnpm build
PORT=8800 node server/index.mjs
```

> **注意**：服务启动时若缺少 `PB_PASS` 会直接报错退出——本仓库不内置任何默认口令。

## 目录结构

```
server/          后端服务
  dispatch.mjs       调度主路由（建单/候选/派单/直控）
  candidate_calc.mjs 候选计算与约束筛选
  strip_planner.mjs  条带规划与方向择优
  area_judge.mjs     区域尺度判定与幅宽推导
  plan_validator.mjs 工程侧校验（8 项）
  multi_dispatch.mjs 多星集合覆盖分派
  cloud_forecast.mjs 云量预报（open-meteo，72h 真实 + 缓存预取）
  orbit.mjs          轨道递推（SGP4）
client/          前端
  src/scene3d.js     三维地球场景
  src/pages/DispatchWorkbench.jsx  调度工作台
  src/agent/         AI 助手 CLI 与 Skill
data/            卫星基础数据（TLE、载荷参数）
docs/            设计文档
scripts/         数据初始化与维护脚本
```

## 核心设计说明

### 条带幅宽口径（唯一事实源）

全系统幅宽统一由 `area_judge.deriveUsableSwath()` 推导，候选计算、任务详情、建单拆条带、派单复算全部调用同一函数。**不要在任何位置写死幅宽**——历史上曾因候选按 12km、详情按 45km 各算一套，导致条带编号错位（候选 stripIdx 到 38，详情只有 10）。

### 一任务一条带

区域拆单后，每个任务对应一条带。已是条带的任务（有 `parentArea` + `stripIdx>0`）在详情中不再做区域规划，避免"第14带内部又显示 2 条带"的矛盾。

### 云量三档策略

| 时间窗 | 数据源 | 是否参与筛选 |
|---|---|---|
| ≤ 72h | open-meteo 真实预报 | 是 |
| > 72h | 无（模拟场无物理意义） | **否**，标记"未知" |

未知云量的候选按中性可用度（约 49%）参与排序，不因"不知道"而虚报 100%。

### 工程校验

候选算完、派单前各校验一次，FAIL 则阻断并返回结构化问题清单。校验项与对应的历史故障：

| 项 | 故障案例 |
|---|---|
| 条带编号自洽 | 曾出现"条带11/38"而任务只有 10 带 |
| 覆盖完整性 | 有缺口仍派单 |
| 候选覆盖率门槛 | 覆盖率 0% 的候选排 rank1 |
| 观测类型匹配 | SAR 任务派给光学星 |

## CLI 使用

```bash
# 建单（异步：秒回任务列表，候选后台算）
dispatch order-intake '<JSON>'

# 查候选计算进度
dispatch area-status "<区域名>"

# 只重算失败项（不动已通过的条带）
dispatch recalc <taskId> '{"maxCloud":0.5}'

# 覆盖范围判定（不写库）
dispatch scope '<JSON>'
```

## 许可证

内部项目，未开源许可。
