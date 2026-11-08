// Blade Agent 接入：任务下单智能助手
// 布局：左侧业务界面（调度工作台/三维态势），右侧对话面板，中间可拖动分割线
import React, { useState, useEffect, useRef, useCallback } from "react";
import { BladeClient } from "@blade-hq/agent-client";
import { BladeProvider, ChatView } from "@blade-hq/agent-react";
import "@blade-hq/agent-react/style.css";

const BA_URL = "https://agent.bladeai.com.cn";
const BA_URL_KEY = "blade-app:sat-dispatch:ba-url";
const CHAT_WIDTH_KEY = "blade-app:sat-dispatch:chat-width";
const SOLUTION_ID = "sat-dispatch-assistant";

function normalizeBaUrl(raw) {
  const url = new URL(raw.trim());
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("服务地址只支持 HTTP 或 HTTPS");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("请填写 Blade Agent Server 根地址");
  }
  return url.origin;
}

function loadBaUrl() {
  try {
    return { value: normalizeBaUrl(BA_URL), error: "" };
  } catch {
    return { value: "", error: "Blade Agent 服务地址未配置" };
  }
}

// ─── Solution / Skill 声明（随会话交付）──────────────────────────────────
const solutionFiles = [
  { path: "solution.yaml", content: `id: ${SOLUTION_ID}
name: 遥感卫星任务下单助手
manifest_version: 3
version: 0.1.0
layout_type: default
initial_mode: executing
initial_message: 请描述您的遥感观测需求（目标位置、观测类型、分辨率、时间窗），我会解析成标准任务单并走调度流程。缺项我会一次列齐向您追问。
skill_tools_enabled: true
roles:
  - dispatch-agent
` },
  { path: "roles/dispatch-agent/role.yaml", content: `id: dispatch-agent
name: 遥感任务下单专员
version: 0.1.0
description: 把用户的观测需求解析为标准任务单，驱动候选计算与派单
layout_type: default
initial_mode: executing
` },
  { path: "roles/dispatch-agent/AGENTS.md.j2", content: `# 遥感卫星任务下单专员

你唯一的业务身份是"遥感卫星任务下单专员"，服务需求方坐席下单。不要罗列平台通用能力。

## 工作流程

1. **理解需求**：用户会用自然语言描述观测需求。你从对话中提取：目标名称、目标位置（纬度/经度，没有就请用户提供或说明用地名近似）、观测类型（optical光学/sar雷达）、分辨率要求（米）、时间窗（起止）、最大云量、时效要求、优先级（常规/重点/应急）。
2. **缺项澄清**：调用 \`dispatch help\` 了解字段含义。必填项（目标位置、观测类型、分辨率、时间窗）缺失时，**单轮合并追问一次列齐全部缺项，每项给建议取值**，不要挤牙膏式多轮追问。
3. **创建任务**：调用 \`dispatch create '<JSON>'\` 创建标准任务单。JSON 字段：taskName/targetName/lat/lon/obsType/resolution/windowStart/windowEnd/maxCloud/timelinessHours/priority。时间窗用 ISO 格式。若返回 needClarify，按 missing 清单合并追问。
4. **候选计算**：任务创建后主动调用 \`dispatch candidates <taskId>\`，向用户汇报通过约束筛选的候选数量、筛除原因分布和排序前三（卫星/公司/过顶时刻/综合评分）。
5. **派单分流**：调用 \`dispatch dispatch <taskId>\`。应急任务会转直控流程并提示用户"待值班确认"；普通任务报告分流通道（指派/询价/抢单）和承接公司。
6. **状态跟踪**：用户问进度时用 \`dispatch task <id>\` 查询任务详情（订单状态、履约记录、直控方案状态）。

## 原则

- 只用 \`dispatch\` CLI 查询和操作，禁止编造卫星数据、公司报价或调度结论。
- 大模型只做理解与编排，调度结论（候选、排序、分流）全部来自确定性计算，如实转述。
- 用户描述模糊时（点/面目标歧义、时间窗过宽、历史时相/未来成像不明），按三类歧义澄清。
- 回答用业务语言，紧凑不啰嗦。` },
];

const skillFiles = [{ path: "SKILL.md", content: `---
name: dispatch-ops
description: 查询与操作遥感卫星调度系统时使用。
---
# 调度系统操作

业务 CLI 是 \`dispatch\`（已随会话安装）。常用命令：

- \`dispatch tasks --json\` 列任务；\`dispatch task <id>\` 看详情
- \`dispatch create '<JSON>'\` 创建任务单（见角色提示的字段说明）
- \`dispatch candidates <id>\` 候选计算（耗时 10~60 秒，告知用户稍等）
- \`dispatch dispatch <id>\` 派单分流
- \`dispatch sats <关键词>\` 查卫星；\`dispatch companies\` 查公司履约

注意：CLI 输出均为 JSON，直接解析字段汇报，不要原文粘贴大 JSON。
API 地址已内置，无需配置。` }];

export const loaded = loadBaUrl();
export const baUrl = loaded.value;
export const baUrlError = loaded.error;

const clientSingleton = baUrl ? new BladeClient({ baseUrl: baUrl }) : null;
export const client = clientSingleton;

// ─── 助手面板组件（右侧对话面板 + 会话菜单 + 设置）─────────────────────────
export function AgentPane({ visible, onClose, getContext }) {
  const [sessionId, setSessionId] = useState(null);
  const [session, setSession] = useState(null);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState([]);
  const [chatWidth, setChatWidth] = useState(() => {
    const saved = parseInt(localStorage.getItem(CHAT_WIDTH_KEY));
    return saved ? Math.min(Math.max(saved, 320), Math.round(window.innerWidth / 2)) : 400;
  });
  const chatWidthRef = useRef(chatWidth);
  chatWidthRef.current = chatWidth;
  const sessionRef = useRef(null);
  sessionRef.current = session;
  const contextRef = useRef(getContext);
  contextRef.current = getContext;

  // attachApp：业务 CLI + 页面上下文
  const attach = useCallback(async (sess) => {
    if (!sess) return;
    try {
      await sess.attachApp({
        cli: {
          command: "dispatch",
          runtime: "python",
          source: new URL("/agent/dispatch_cli.py", location.href),
        },
        getContext: () => contextRef.current?.() ?? {},
      });
    } catch (e) {
      console.warn("attachApp 失败:", e);
    }
  }, []);

  const start = async () => {
    if (!client) { setConnectError("请先配置 Blade Agent 服务地址"); return; }
    setConnecting(true); setConnectError("");
    try {
      if (!client.hasToken()) await client.auth.login();
      // SDK 1.1.1 无 models 接口，直接走模型目录端点（serviceModelId 才是网关模型名）
      const catalogRes = await client.fetch("GET", "/api/config/models");
      const catalog = await catalogRes.json();
      const models = (catalog.models ?? [])
        .filter(m => m.serviceModelId)
        .map(m => ({ id: m.serviceModelId, label: m.label || m.serviceModelId }));
      setModels(models);
      const model = selectedModel || catalog.defaultServiceModel;
      setSelectedModel(model);
      // Solution/Skill 首次上传较慢，超时自动重试一次
      let created;
      try {
        created = await client.sessions.create({
          solution: { role: "dispatch-agent", files: solutionFiles },
          skills: [{ name: "my/dispatch-ops", files: skillFiles }],
          config: { model },
        });
      } catch (e1) {
        setConnectError("首次连接超时，正在重试…");
        created = await client.sessions.create({
          solution: { role: "dispatch-agent", files: solutionFiles },
          skills: [{ name: "my/dispatch-ops", files: skillFiles }],
          config: { model },
        });
      }
      setSession(null);
      setSessionId(created.sessionId);
      setConnected(true);
    } catch (e) {
      console.error('连接失败:', e);
      setConnectError(e instanceof Error ? e.message : String(e));
    }
    setConnecting(false);
  };

  // 会话就绪后 attachApp
  const onSessionReady = async (sess) => {
    setSession(sess);
    await attach(sess);
  };

  // 历史会话
  const loadHistory = async () => {
    if (!client?.hasToken()) return;
    try {
      const page = await client.sessions.listSessionsPaginated({ limit: 30, offset: 0, solution_id: SOLUTION_ID });
      setHistory(page.items ?? []);
    } catch {}
  };
  useEffect(() => { if (showHistory) loadHistory(); }, [showHistory]);

  const openHistory = (id) => {
    setSession(null);
    setSessionId(id); // ChatView key 变化触发重挂载，onSessionReady 会重新 attachApp
    setShowHistory(false);
  };

  // 分割线拖动
  const startResize = (event) => {
    const handle = event.currentTarget;
    try { handle.setPointerCapture(event.pointerId); } catch {}
    document.body.style.userSelect = "none";
    const startX = event.clientX;
    const startWidth = chatWidthRef.current;
    const onMove = (e) => {
      const w = Math.min(Math.max(startWidth + (startX - e.clientX), 320), Math.round(window.innerWidth / 2));
      setChatWidth(w);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      try { localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidthRef.current)); } catch {}
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  if (!visible) return null;

  return (
    <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 350, display: "flex" }}>
      <div className="blade-resizer" onPointerDown={startResize} onDoubleClick={() => setChatWidth(400)}
        role="separator" aria-orientation="vertical" tabIndex={0} />
      <div style={{
        flex: `0 0 ${chatWidth}px`, minWidth: 320, display: "flex", flexDirection: "column",
        background: "#ffffff", borderLeft: "1px solid #e2e8f0", color: "#1e293b",
      }}>
        {/* 面板工具条 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #e2e8f0" }}>
          <button className="agent-tool-btn" title="会话菜单" onClick={() => { setShowHistory(!showHistory); }}>☰</button>
          <span style={{ fontSize: 13, fontWeight: 600, flex: 1, textAlign: "center" }}>任务下单助手</span>
          <button className="agent-tool-btn" title="设置" onClick={() => setShowSettings(true)}>⚙</button>
          <button className="agent-tool-btn" title="收起" onClick={onClose}>✕</button>
        </div>

        {/* 会话菜单浮层 */}
        {showHistory && (
          <div style={{ position: "absolute", top: 44, width: chatWidth - 2, background: "#fff", border: "1px solid #e2e8f0",
            borderRadius: 6, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 50, maxHeight: 400, overflowY: "auto" }}>
            <button className="agent-history-new" onClick={() => { setShowHistory(false); start(); }}>＋ 新建对话</button>
            {history.length === 0 && <div style={{ padding: 12, fontSize: 12, color: "#94a3b8" }}>暂无历史对话</div>}
            {history.map(h => (
              <div key={h.id} className="agent-history-item" onClick={() => openHistory(h.id)}
                style={{ background: h.id === sessionId ? "#f0fdf9" : undefined }}>
                <div style={{ fontSize: 12.5 }}>{h.intent || "新对话"}</div>
                <div style={{ fontSize: 10.5, color: "#94a3b8" }}>{h.created_at?.slice(0, 16)?.replace("T", " ")}</div>
              </div>
            ))}
          </div>
        )}

        {/* 主体 */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {!client ? (
            <div style={{ padding: 20, fontSize: 13 }}>
              未配置 Blade Agent 服务地址。
              <button className="agent-primary-btn" onClick={() => setShowSettings(true)}>打开设置</button>
            </div>
          ) : !connected && !sessionId ? (
            <div style={{ padding: 24, textAlign: "center" }}>
              <div style={{ fontSize: 14, marginBottom: 8, fontWeight: 600 }}>任务下单助手</div>
              <div style={{ fontSize: 12.5, color: "#64748b", lineHeight: 1.8, marginBottom: 16 }}>
                用自然语言描述观测需求，助手自动解析成标准任务单、跑候选计算并完成派单分流。
              </div>
              <button className="agent-primary-btn" onClick={start} disabled={connecting}>
                {connecting ? "连接中…" : "连接 Blade Agent"}
              </button>
              {connectError && <div style={{ color: "#dc2626", fontSize: 12, marginTop: 10 }}>{connectError}</div>}
            </div>
          ) : sessionId ? (
            <ChatView key={sessionId} sessionId={sessionId} onSessionReady={onSessionReady} theme="light" />
          ) : null}
        </div>

        {/* 设置弹窗 */}
        {showSettings && <SettingsModal models={models} selectedModel={selectedModel}
          onSelectModel={setSelectedModel} onClose={() => setShowSettings(false)} />}
      </div>
    </div>
  );
}

function SettingsModal({ models, selectedModel, onSelectModel, onClose }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 400,
      display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "#fff", borderRadius: 8, padding: 20, width: 380 }}>
        <div style={{ fontWeight: 700, marginBottom: 16 }}>设置</div>
        <label style={{ fontSize: 12.5, display: "block", marginBottom: 6 }}>Blade Agent 服务地址</label>
        <input className="agent-input" defaultValue={baUrl} readOnly />
        <div style={{ fontSize: 11, color: "#94a3b8", margin: "4px 0 14px" }}>地址由应用内置，浏览器直接访问 Blade Agent。</div>
        <label style={{ fontSize: 12.5, display: "block", marginBottom: 6 }}>对话模型（新建对话时生效）</label>
        <select className="agent-input" value={selectedModel} onChange={e => onSelectModel(e.target.value)}>
          {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <button className="agent-primary-btn" style={{ marginTop: 16, width: "100%" }} onClick={onClose}>完成</button>
      </div>
    </div>
  );
}

// Provider 包装
export function BladeWrapper({ children }) {
  if (!client) return children;
  return <BladeProvider client={client}>{children}</BladeProvider>;
}
