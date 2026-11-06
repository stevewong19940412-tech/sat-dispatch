// 任务管理抽屉（底部）—— 迁移自原 MissionControlTab
import React, { useState, useEffect, useCallback } from "react";
import { MISSION_STATUS_ZH, MISSION_PRIORITY_ZH, api, fmtTime } from "../lib.js";

export default function MissionsDrawer({ minimized, onToggle, onClose, version, onEdit, positions }) {
  const [missions, setMissions] = useState([]);
  const [filter, setFilter] = useState("ALL");
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api("/missions?limit=200");
      setMissions(data);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load, version]);

  // 定时刷新（跟踪任务状态）
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const setStatus = async (m, status) => {
    await api(`/missions/${m.id}`, { method: "PUT", body: JSON.stringify({ status }) });
    load();
    if (selected?.id === m.id) setSelected({ ...m, status });
  };

  const remove = async (m) => {
    if (!confirm(`确认删除任务「${m.name}」？此操作不可恢复。`)) return;
    await api(`/missions/${m.id}`, { method: "DELETE" });
    setSelected(null);
    load();
  };

  const shown = filter === "ALL" ? missions : missions.filter(m => m.status === filter);

  return (
    <div className={`missions-drawer ${minimized ? "minimized" : ""}`}>
      <div className="missions-drawer-header" onClick={onToggle}>
        <span className="title">成像侦察任务</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>
          共 {missions.length} 项
          {missions.length > 0 && ` · 进行中 ${missions.filter(m => m.status === "active").length}`}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn secondary" style={{ padding: "3px 10px", fontSize: 11 }}
            onClick={e => { e.stopPropagation(); onEdit(null); }}>+ 新建</button>
          <button className="close-btn" onClick={e => { e.stopPropagation(); onClose(); }}>✕</button>
        </span>
      </div>

      <div className="missions-drawer-body">
        {/* 状态过滤 */}
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {["ALL", ...Object.keys(MISSION_STATUS_ZH)].map(s => (
            <button key={s} className="btn secondary"
              style={filter === s
                ? { background: "rgba(45,212,167,0.18)", color: "var(--accent)", borderColor: "var(--accent)", padding: "3px 12px", fontSize: 11.5 }
                : { padding: "3px 12px", fontSize: 11.5 }}
              onClick={() => setFilter(s)}>
              {s === "ALL" ? "全部" : MISSION_STATUS_ZH[s]}
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <div style={{ color: "var(--text-dim)", fontSize: 12.5, padding: "20px 0", textAlign: "center" }}>
            暂无任务。点击右上角「新建任务」创建第一个成像侦察任务。
          </div>
        ) : (
          <table className="mission-table">
            <thead>
              <tr>
                <th>任务名称</th><th>代号</th><th>状态</th><th>优先级</th>
                <th>AOI</th><th>指派卫星</th><th>更新时间</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(m => (
                <tr key={m.id} onClick={() => setSelected(selected?.id === m.id ? null : m)}>
                  <td style={{ color: "var(--text-bright)" }}>{m.name}</td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>{m.codename || "—"}</td>
                  <td><span className={`status-pill status-${m.status}`}>{MISSION_STATUS_ZH[m.status]}</span></td>
                  <td className={`priority-${m.priority}`}>{MISSION_PRIORITY_ZH[m.priority]}</td>
                  <td style={{ fontSize: 11.5 }}>{m.aoiName || (m.aoiLat != null ? `${m.aoiLat.toFixed(1)}, ${m.aoiLon.toFixed(1)} r${m.aoiRadiusKm}` : "—")}</td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{m.assignedSatellites?.length ?? 0} 颗</td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>{m.updatedAt?.slice(5, 16)}</td>
                  <td onClick={e => e.stopPropagation()}>
                    <button className="btn secondary" style={{ padding: "2px 8px", fontSize: 11, marginRight: 4 }}
                      onClick={() => onEdit(m)}>编辑</button>
                    <button className="btn danger" style={{ padding: "2px 8px", fontSize: 11 }}
                      onClick={() => remove(m)}>删</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* 选中任务详情 + 状态流转 */}
        {selected && (
          <div style={{ marginTop: 14, padding: "12px 14px", border: "1px solid var(--border-bright)", borderRadius: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <b style={{ fontFamily: "var(--font-display)", letterSpacing: 1 }}>{selected.name}</b>
              <span className={`status-pill status-${selected.status}`}>{MISSION_STATUS_ZH[selected.status]}</span>
              <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                {selected.status !== "archived" && STATUS_FLOW
                  .filter(s => s !== selected.status)
                  .slice(0, 4)
                  .map(s => (
                    <button key={s} className="btn secondary" style={{ padding: "3px 10px", fontSize: 11 }}
                      onClick={() => setStatus(selected, s)}>
                      → {MISSION_STATUS_ZH[s]}
                    </button>
                  ))}
              </div>
            </div>
            <div className="kv-grid">
              <div className="kv"><div className="k">任务描述</div><div className="v" style={{ fontFamily: "var(--font-body)" }}>{selected.description || "—"}</div></div>
              <div className="kv"><div className="k">目标</div><div className="v" style={{ fontFamily: "var(--font-body)" }}>{selected.objectives || "—"}</div></div>
              {selected.aoiLat != null && (
                <>
                  <div className="kv"><div className="k">AOI 圆心</div><div className="v">{selected.aoiLat.toFixed(2)}°, {selected.aoiLon.toFixed(2)}°</div></div>
                  <div className="kv"><div className="k">AOI 半径</div><div className="v">{selected.aoiRadiusKm} km</div></div>
                </>
              )}
              <div className="kv"><div className="k">密级</div><div className="v">{selected.classification}</div></div>
            </div>
            <div className="section-label">指派卫星</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(selected.assignedSatellites ?? []).map(nid => {
                const pos = positions.find(p => p.noradId === nid);
                return (
                  <span key={nid} className="hud-chip" style={{ padding: "3px 10px" }}>
                    {pos?.name ?? `NORAD ${nid}`}{pos && <b style={{ marginLeft: 6 }}>{pos.altKm.toFixed(0)}km</b>}
                  </span>
                );
              })}
              {(selected.assignedSatellites ?? []).length === 0 && (
                <span style={{ color: "var(--text-dim)", fontSize: 12 }}>未指派卫星</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
