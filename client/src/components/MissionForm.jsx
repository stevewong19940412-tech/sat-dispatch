// 任务创建/编辑表单 —— 迁移自原 MissionControlTab 表单
import React, { useState, useEffect, useMemo } from "react";
import { CATEGORY_META, CATEGORY_ZH, api } from "../lib.js";

export default function MissionForm({ editing, aoiPoint, positions, onCancel, onSaved }) {
  const [form, setForm] = useState({
    name: "", codename: "", description: "", status: "planning",
    priority: "medium", classification: "unclassified",
    aoiLat: "", aoiLon: "", aoiRadiusKm: "500", aoiName: "",
    objectives: "", notes: "",
    assignedSatellites: [],
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [satFilter, setSatFilter] = useState("");
  const [satCatFilter, setSatCatFilter] = useState("all");

  useEffect(() => {
    if (editing) {
      setForm({
        name: editing.name ?? "", codename: editing.codename ?? "",
        description: editing.description ?? "", status: editing.status ?? "planning",
        priority: editing.priority ?? "medium",
        classification: editing.classification ?? "unclassified",
        aoiLat: editing.aoiLat != null ? String(editing.aoiLat) : "",
        aoiLon: editing.aoiLon != null ? String(editing.aoiLon) : "",
        aoiRadiusKm: editing.aoiRadiusKm != null ? String(editing.aoiRadiusKm) : "500",
        aoiName: editing.aoiName ?? "",
        objectives: editing.objectives ?? "", notes: editing.notes ?? "",
        assignedSatellites: editing.assignedSatellites ?? [],
      });
    } else {
      // 预设：来自 AOI 圈选 / 卫星详情页指派
      const prefill = window.__prefillAssign;
      setForm(f => ({
        ...f,
        aoiLat: aoiPoint ? String(aoiPoint.lat.toFixed(4)) : f.aoiLat,
        aoiLon: aoiPoint ? String(aoiPoint.lon.toFixed(4)) : f.aoiLon,
        aoiRadiusKm: aoiPoint ? String(f.aoiRadiusKm || 500) : f.aoiRadiusKm,
        aoiName: aoiPoint ? "态势圈选区域" : f.aoiName,
        assignedSatellites: prefill ?? f.assignedSatellites,
      }));
      window.__prefillAssign = null;
    }
  }, [editing, aoiPoint]);

  const filteredSats = useMemo(() => {
    let list = positions;
    if (satCatFilter !== "all") list = list.filter(s => s.category === satCatFilter);
    const q = satFilter.trim().toLowerCase();
    if (q) list = list.filter(s => s.name.toLowerCase().includes(q) || String(s.noradId).includes(q));
    return list.slice(0, 200);
  }, [positions, satFilter, satCatFilter]);

  const toggleSat = (nid) => {
    setForm(f => {
      const cur = f.assignedSatellites;
      return {
        ...f,
        assignedSatellites: cur.includes(nid) ? cur.filter(x => x !== nid) : [...cur, nid],
      };
    });
  };

  const save = async () => {
    setError("");
    if (!form.name.trim()) { setError("请填写任务名称"); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        aoiLat: form.aoiLat !== "" ? parseFloat(form.aoiLat) : undefined,
        aoiLon: form.aoiLon !== "" ? parseFloat(form.aoiLon) : undefined,
        aoiRadiusKm: form.aoiRadiusKm !== "" ? parseFloat(form.aoiRadiusKm) : undefined,
      };
      if (editing) {
        await api(`/missions/${editing.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await api("/missions", { method: "POST", body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal">
        <div className="modal-header">
          {editing ? `编辑任务 · ${editing.name}` : "新建成像侦察任务"}
          <button className="close-btn" style={{ marginLeft: "auto" }} onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-field">
              <label>任务名称 *</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="如：华北平原汛期监测" />
            </div>
            <div className="form-field">
              <label>任务代号</label>
              <input value={form.codename} onChange={e => setForm({ ...form, codename: e.target.value })}
                placeholder="如：OP-FLOOD-01" />
            </div>
            <div className="form-field full">
              <label>任务描述</label>
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="form-field">
              <label>状态</label>
              <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
                <option value="planning">规划中</option>
                <option value="active">进行中</option>
                <option value="paused">已暂停</option>
                <option value="completed">已完成</option>
                <option value="archived">已归档</option>
              </select>
            </div>
            <div className="form-field">
              <label>优先级</label>
              <select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
                <option value="critical">关键</option>
              </select>
            </div>
            <div className="form-field">
              <label>AOI 名称</label>
              <input value={form.aoiName} onChange={e => setForm({ ...form, aoiName: e.target.value })} />
            </div>
            <div className="form-field">
              <label>AOI 半径（km）</label>
              <input type="number" value={form.aoiRadiusKm}
                onChange={e => setForm({ ...form, aoiRadiusKm: e.target.value })} />
            </div>
            <div className="form-field">
              <label>AOI 纬度 {aoiPoint && <span style={{ color: "var(--accent)" }}>（已从态势圈选带入）</span>}</label>
              <input type="number" step="0.0001" value={form.aoiLat}
                onChange={e => setForm({ ...form, aoiLat: e.target.value })} placeholder="39.9042" />
            </div>
            <div className="form-field">
              <label>AOI 经度</label>
              <input type="number" step="0.0001" value={form.aoiLon}
                onChange={e => setForm({ ...form, aoiLon: e.target.value })} placeholder="116.4074" />
            </div>
            <div className="form-field full">
              <label>侦察目标</label>
              <textarea value={form.objectives} onChange={e => setForm({ ...form, objectives: e.target.value })}
                placeholder="说明侦察对象、信息需求、成果形式" />
            </div>
          </div>

          <div className="section-label">指派卫星（{form.assignedSatellites.length} 颗已选）</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input className="mini-input" style={{ flex: 1 }} placeholder="筛选：名称/编号"
              value={satFilter} onChange={e => setSatFilter(e.target.value)} />
            <select className="mini-input" style={{ width: 150 }}
              value={satCatFilter} onChange={e => setSatCatFilter(e.target.value)}>
              <option value="all">全部类别</option>
              {Object.entries(CATEGORY_META).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>
          <div className="sat-select-list">
            {filteredSats.length === 0 && (
              <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>
                无匹配卫星（卫星数据加载中或筛选过严）
              </div>
            )}
            {filteredSats.map(s => {
              const sel = form.assignedSatellites.includes(s.noradId);
              return (
                <div key={s.noradId} className={`sat-select-item ${sel ? "selected" : ""}`}
                  onClick={() => toggleSat(s.noradId)}>
                  <span className="sat-check">{sel ? "✓" : ""}</span>
                  <span className="swatch" style={{ background: CATEGORY_META[s.category]?.color ?? "#8fa3c8" }} />
                  {s.name}
                  <span className="nid">{s.noradId} · {CATEGORY_ZH[s.category] ?? s.category}</span>
                </div>
              );
            })}
          </div>

          {error && <div className="form-error">{error}</div>}

          <div className="btn-row" style={{ justifyContent: "flex-end" }}>
            <button className="btn secondary" onClick={onCancel}>取消</button>
            <button className="btn" onClick={save} disabled={saving}>
              {saving ? "保存中…" : editing ? "保存修改" : "创建任务"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
