// 卫星档案详情面板（右侧）—— 迁移自原 SatIntelPanel，剥离情报模块后保留档案/过境/轨迹
import React, { useState, useEffect } from "react";
import { CATEGORY_META, OBS_PRESETS, api, fmtTime, fmtDur } from "../lib.js";

const TABS = [
  { id: "dossier", label: "档案" },
  { id: "passes", label: "过境预报" },
  { id: "coverage", label: "覆盖分析" },
];

export default function SatelliteDetail({ sat, onClose, onCreateMission }) {
  const [tab, setTab] = useState("dossier");
  const [detail, setDetail] = useState(sat);

  // 拉取完整档案
  useEffect(() => {
    api(`/satellite/${sat.noradId}`).then(setDetail).catch(() => {});
  }, [sat.noradId]);

  const meta = CATEGORY_META[detail.category] ?? {};
  const tleAge = detail.epoch ? (Date.now() - new Date(detail.epoch).getTime()) / 86400000 : null;
  const ageClass = tleAge == null ? "" : tleAge < 7 ? "fresh" : tleAge < 60 ? "stale" : "old";

  return (
    <div className="detail-card">
      {/* 头部 */}
      <div className="detail-header">
        <div>
          <div className="sat-name">{detail.name}</div>
          <div className="sat-norad">NORAD {detail.noradId} · {meta.label ?? detail.category}</div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          {tleAge != null && (
            <span className={`tle-age ${ageClass}`}>星历 {tleAge.toFixed(1)} 天前</span>
          )}
          <button className="close-btn" onClick={onClose} style={{ marginLeft: 8 }}>✕</button>
        </div>
      </div>

      {/* Tab */}
      <div className="detail-tabs">
        {TABS.map(t => (
          <div key={t.id} className={`detail-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </div>
        ))}
      </div>

      {/* 内容 */}
      <div className="detail-body">
        {tab === "dossier" && <DossierTab sat={detail} meta={meta} />}
        {tab === "passes" && <PassesTab sat={detail} />}
        {tab === "coverage" && <CoverageTab sat={detail} />}
      </div>

      <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
        <button className="btn" style={{ width: "100%" }}
          onClick={() => onCreateMission(detail)}>
          指派此星 → 新建任务
        </button>
      </div>
    </div>
  );
}

function DossierTab({ sat, meta }) {
  return (
    <>
      <div className="section-label">任务定位</div>
      <div style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--text-main)" }}>
        {sat.missionDescription || "暂无任务描述"}
      </div>

      <div className="section-label">轨道参数</div>
      <div className="kv-grid">
        <div className="kv"><div className="k">轨道高度</div><div className="v big">{sat.altitude != null ? `${Math.round(sat.altitude)} km` : "—"}</div></div>
        <div className="kv"><div className="k">倾角</div><div className="v">{sat.inclination != null ? `${sat.inclination.toFixed(2)}°` : "—"}</div></div>
        <div className="kv"><div className="k">周期</div><div className="v">{sat.period != null ? `${sat.period.toFixed(1)} min` : "—"}</div></div>
        <div className="kv"><div className="k">偏心率</div><div className="v">{sat.eccentricity != null ? sat.eccentricity.toFixed(5) : "—"}</div></div>
        <div className="kv"><div className="k">远地点</div><div className="v">{sat.apogee != null ? `${Math.round(sat.apogee)} km` : "—"}</div></div>
        <div className="kv"><div className="k">近地点</div><div className="v">{sat.perigee != null ? `${Math.round(sat.perigee)} km` : "—"}</div></div>
      </div>

      <div className="section-label">运营与发射</div>
      <div className="kv-grid">
        <div className="kv"><div className="k">国家/组织</div><div className="v">{sat.country ?? "—"}</div></div>
        <div className="kv"><div className="k">运营方</div><div className="v">{sat.operator ?? "—"}</div></div>
        <div className="kv"><div className="k">发射日期</div><div className="v">{sat.launchDate ?? "—"}</div></div>
        <div className="kv"><div className="k">发射场</div><div className="v" style={{ fontSize: 11 }}>{sat.launchSite ?? "—"}</div></div>
        <div className="kv"><div className="k">载荷类型</div><div className="v">{sat.payloadType ?? meta.label ?? "—"}</div></div>
        <div className="kv"><div className="k">数据来源</div><div className="v">{sat.source === "celestrak" ? "CelesTrak 实抓" : sat.source ?? "—"}</div></div>
      </div>

      <div className="section-label">轨道根数（历元数据）</div>
      <div style={{
        fontFamily: "var(--font-mono)", fontSize: 10.5, lineHeight: 1.6,
        background: "rgba(20,30,52,0.6)", padding: "8px 10px", borderRadius: 4,
        color: "var(--text-dim)", wordBreak: "break-all",
      }}>
        {sat.tle1 && sat.tle1.length > 40 ? <>TLE: {sat.tle1}<br />{sat.tle2}</> : <>数据源: CelesTrak OMM（SGP4 直接传播）<br />历元: {sat.epoch?.slice(0, 19)?.replace("T", " ")} UTC</>}
      </div>
    </>
  );
}

function PassesTab({ sat }) {
  const [preset, setPreset] = useState(OBS_PRESETS[0]);
  const [minElev, setMinElev] = useState(5);
  const [hours, setHours] = useState(24);
  const [passes, setPasses] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api(`/passes/${sat.noradId}?lat=${preset.lat}&lon=${preset.lon}&hours=${hours}&minElev=${minElev}`)
      .then(data => setPasses(data.passes))
      .catch(() => setPasses([]))
      .finally(() => setLoading(false));
  }, [sat.noradId, preset, minElev, hours]);

  return (
    <>
      <div className="section-label">观测点</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {OBS_PRESETS.map(p => (
          <button key={p.name}
            className={`btn secondary ${preset.name === p.name ? "" : ""}`}
            style={preset.name === p.name ? { background: "rgba(45,212,167,0.2)", color: "var(--accent)", borderColor: "var(--accent)" } : { padding: "4px 10px", fontSize: 11.5 }}
            onClick={() => setPreset(p)}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="kv-grid" style={{ marginBottom: 10 }}>
        <div className="kv"><div className="k">纬度</div><div className="v">{preset.lat}°</div></div>
        <div className="kv"><div className="k">经度</div><div className="v">{preset.lon}°</div></div>
      </div>

      <div className="form-grid" style={{ marginBottom: 10 }}>
        <div className="form-field">
          <label>最小仰角（°）</label>
          <input className="mini-input" type="number" value={minElev}
            onChange={e => setMinElev(Math.max(0, parseInt(e.target.value) || 0))} />
        </div>
        <div className="form-field">
          <label>预报时长（小时）</label>
          <input className="mini-input" type="number" value={hours}
            onChange={e => setHours(Math.min(72, Math.max(1, parseInt(e.target.value) || 24)))} />
        </div>
      </div>

      <div className="section-label">未来 {hours}h 过境窗口</div>
      {loading && <div style={{ color: "var(--text-dim)", fontSize: 12 }}>计算中…</div>}
      {!loading && passes && passes.length === 0 && (
        <div style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.6 }}>
          当前参数下无过境。可降低最小仰角或延长预报时长。
        </div>
      )}
      {!loading && passes?.map((p, i) => (
        <div className="pass-item" key={i}>
          <div className="pass-time">第 {i + 1} 圈 · {fmtTime(p.riseTime)} 升</div>
          <div className="pass-meta">
            <span>最大仰角 <b className="maxel">{p.maxEl}°</b></span>
            <span>方位 {p.riseAz}°→{p.setAz}°</span>
            <span>持续 {fmtDur(p.duration)}</span>
          </div>
        </div>
      ))}
    </>
  );
}

function CoverageTab({ sat }) {
  const [aoiPoint, setAoiPoint] = useState({ lat: 39.9, lon: 116.4 });
  const [radius, setRadius] = useState(500);
  const [result, setResult] = useState(null);

  useEffect(() => {
    // 用过境预报近似覆盖分析：24h 内星下点进入 AOI 的次数
    api(`/passes/${sat.noradId}?lat=${aoiPoint.lat}&lon=${aoiPoint.lon}&hours=24&minElev=0`)
      .then(data => {
        // minElev=0 即星下点可见，过境次数≈覆盖次数
        setResult({
          passes: data.passes.length,
          totalMin: data.passes.reduce((s, p) => s + p.duration, 0) / 60,
        });
      })
      .catch(() => setResult(null));
  }, [sat.noradId, aoiPoint, radius]);

  return (
    <>
      <div className="section-label">区域覆盖分析（24h）</div>
      <div className="aoi-hint">
        分析该卫星未来 24 小时内星下点进入关注区域的次数与累计可见时长（基于 SGP4 传播）。
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {OBS_PRESETS.map(p => (
          <button key={p.name} className="btn secondary"
            style={aoiPoint.lat === p.lat ? { background: "rgba(45,212,167,0.2)", color: "var(--accent)", borderColor: "var(--accent)" } : { padding: "4px 10px", fontSize: 11.5 }}
            onClick={() => setAoiPoint(p)}>
            {p.name}
          </button>
        ))}
      </div>
      {result ? (
        <div className="kv-grid">
          <div className="kv"><div className="k">进入区域次数</div><div className="v big">{result.passes}</div></div>
          <div className="kv"><div className="k">累计可见时长</div><div className="v big">{result.totalMin.toFixed(0)} min</div></div>
        </div>
      ) : (
        <div style={{ color: "var(--text-dim)", fontSize: 12 }}>分析中…</div>
      )}
      <div className="section-label">轨道特征</div>
      <div style={{ fontSize: 12, lineHeight: 1.7, color: "var(--text-dim)" }}>
        倾角 {sat.inclination?.toFixed(1) ?? "—"}° ·
        高度 {sat.altitude != null ? `${Math.round(sat.altitude)} km` : "—"} ·
        {" "}{sat.inclination > 95 ? "太阳同步轨道，全球近极地覆盖" : sat.inclination < 10 ? "近赤道/地球同步轨道，固定区域覆盖" : "中倾角轨道，中低纬度覆盖"}
      </div>
    </>
  );
}
