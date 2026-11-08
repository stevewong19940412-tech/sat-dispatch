// ─── 遥感卫星统一调度系统：数据模型 ────────────────────────────────────────
// 依据《遥感卫星统一调度系统-开发执行逻辑说明.md》3.x 数据结构
import { db } from "./db.mjs";

db.exec(`
-- 标准任务单（3.2）：全部调度环节统一输入
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskNo TEXT NOT NULL UNIQUE,            -- 任务编号 RSBH-YYYYMMDD-XXX
  taskName TEXT NOT NULL,
  source TEXT DEFAULT '手工录入',          -- 手工录入|批量导入|系统接口推送|对话下单
  createdAt TEXT DEFAULT (datetime('now')),
  -- 目标信息
  targetName TEXT,
  targetType TEXT,                         -- 目标类型枚举
  geomType TEXT NOT NULL,                  -- point|polygon
  geom TEXT NOT NULL,                      -- JSON: {lat,lon} 或 {coords:[[lat,lon],...]}
  -- 成像要求
  obsType TEXT NOT NULL,                   -- optical|sar|video
  resolution REAL NOT NULL,                -- 分辨率要求（米）
  spectral TEXT,                           -- 谱段要求
  -- 约束条件
  windowStart TEXT NOT NULL,               -- 时间窗起
  windowEnd TEXT NOT NULL,                 -- 时间窗止
  maxCloud REAL DEFAULT 0.3,               -- 最大云量 [0,1]
  maxSlewDeg REAL DEFAULT 45,              -- 最大侧摆角
  timelinessHours REAL,                    -- 时效要求（小时）
  -- 管理属性
  priority TEXT DEFAULT '常规',            -- 应急|重点|常规
  isEmergency INTEGER DEFAULT 0,           -- 应急标注
  taskPhase TEXT DEFAULT '未来成像',        -- 历史时相|未来成像
  confidence TEXT,                         -- 置信度记录 JSON
  status TEXT DEFAULT '待派单',            -- 待派单|已派发|... （普通链路）
  parseNote TEXT                           -- LLM 解析备注/澄清记录
);

-- 候选清单（3.3）：任务—条带—卫星—窗口
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId INTEGER NOT NULL,
  stripIdx INTEGER DEFAULT 1,              -- 条带编号（面目标拆分）
  stripCount INTEGER DEFAULT 1,
  satNoradId INTEGER NOT NULL,
  satName TEXT,
  company TEXT,                            -- 承接公司
  windowStart TEXT NOT NULL,
  windowEnd TEXT NOT NULL,
  overpassTime TEXT NOT NULL,              -- 过顶时刻
  slewDeg REAL,                            -- 所需侧摆角
  availability REAL,                       -- 成像可用度评分 A (0-100)
  cloudFc REAL,                            -- 云量预报值
  cloudSource TEXT DEFAULT 'simulated',    -- 云量来源 real|simulated
  orbitGrade TEXT DEFAULT '高',            -- 轨道数据分档 高|中|低
  shadowInfer INTEGER DEFAULT 0,           -- 影子推断标注
  filtered INTEGER DEFAULT 0,              -- 约束筛选是否剔除
  filterReason TEXT,                       -- 筛除原因
  UNIQUE(taskId, satNoradId, stripIdx, windowStart)
);

-- 排序清单（3.4）
CREATE TABLE IF NOT EXISTS rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId INTEGER NOT NULL,
  candidateId INTEGER NOT NULL,
  rank INTEGER,                            -- 顺位
  Q REAL,                                  -- 成像质量评分 0-100
  R REAL,                                  -- 时间窗匹配度 (0,1]
  C REAL,                                  -- 任务完成能力 [0,1]
  S REAL,                                  -- 综合评分
  Qdetail TEXT, Rdetail TEXT, Cdetail TEXT, -- 评分明细 JSON
  UNIQUE(candidateId)
);

-- 电子订单（3.5）：任务与订单 1:1
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId INTEGER NOT NULL,
  orderNo TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,                   -- 指派|询价|抢单|人工裁定|直控
  company TEXT NOT NULL,
  satNoradId INTEGER,
  satName TEXT,
  rankUsed INTEGER,                        -- 承接顺位
  -- 任务要素（冗余自任务单）
  targetName TEXT, obsType TEXT, resolution REAL,
  windowStart TEXT, windowEnd TEXT, maxCloud REAL,
  -- 执行约定
  deliveryDeadline TEXT,                   -- 交付时限
  price REAL,                              -- 预估/成交金额（询价用）
  -- 状态机
  status TEXT DEFAULT '已派发',            -- 已派发|已接单|执行中|已交付|已验收|已失败
  statusHistory TEXT DEFAULT '[]',         -- [{status,time,source}]
  -- 履约记录
  fulfillment TEXT,                        -- 按约完成|未按约
  fulfillmentQuality TEXT,                 -- 完成质量
  failureReason TEXT,
  createdAt TEXT DEFAULT (datetime('now')),
  closedAt TEXT
);

-- 应急直控：执行方案与载荷指令包
CREATE TABLE IF NOT EXISTS directPlans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId INTEGER NOT NULL,
  satNoradId INTEGER NOT NULL,
  satName TEXT,
  company TEXT,
  windowStart TEXT, windowEnd TEXT, overpassTime TEXT,
  strips TEXT,                             -- 条带列表 JSON
  status TEXT DEFAULT '待确认',            -- 待确认|方案已确认|指令已生成|校验通过|校验驳回|上注确认|已上注|执行中|已完成|已失败
  commands TEXT,                           -- 指令包 JSON（动作时间轴）
  commandSummary TEXT,                     -- 自然语言摘要（LLM）
  validation TEXT,                         -- 独立校验结果 JSON
  arcInfo TEXT,                            -- 测控弧段信息 JSON
  createdAt TEXT DEFAULT (datetime('now')),
  updatedAt TEXT
);

-- 运营公司（公司生态）
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL, short TEXT NOT NULL, code TEXT UNIQUE,
  desc TEXT, type TEXT,
  capacity INTEGER DEFAULT 50,
  acceptedCount INTEGER DEFAULT 0,
  fulfillmentRate REAL,
  dataQuality TEXT DEFAULT '高'
);

-- 公司履约历史（C评分 c1 数据源 + 回写）
CREATE TABLE IF NOT EXISTS fulfillmentLog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT, orderId INTEGER, taskId INTEGER,
  outcome TEXT,                            -- 按约完成|未按约
  reason TEXT,
  closedAt TEXT DEFAULT (datetime('now'))
);

-- 任务池（抢单通道）
CREATE TABLE IF NOT EXISTS taskPool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskId INTEGER,
  mergedGroup TEXT,                        -- 拼单组标识
  poolSince TEXT DEFAULT (datetime('now')),
  claimedBy TEXT,
  claimedAt TEXT,
  expiresAt TEXT
);

-- 派单流转记录（指派顺位轨迹）
CREATE TABLE IF NOT EXISTS dispatchLog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId INTEGER,
  taskId INTEGER,
  channel TEXT,
  company TEXT,
  rank INTEGER,
  action TEXT,                             -- 派发|拒接|超时|接单|成交|放弃
  detail TEXT,
  at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_cand_task ON candidates(taskId);
CREATE INDEX IF NOT EXISTS idx_rank_task ON rankings(taskId);
CREATE INDEX IF NOT EXISTS idx_orders_task ON orders(taskId);
`);

export function nextTaskNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const seq = db.prepare("SELECT count(*) c FROM tasks WHERE taskNo LIKE ?").get(`RSBH-${ymd}-%`).c + 1;
  return `RSBH-${ymd}-${String(seq).padStart(3,'0')}`;
}

export function nextOrderNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const seq = db.prepare("SELECT count(*) c FROM orders WHERE orderNo LIKE ?").get(`PO-${ymd}-%`).c + 1;
  return `PO-${ymd}-${String(seq).padStart(3,'0')}`;
}
