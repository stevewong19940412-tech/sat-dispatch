// App.jsx — 遥感卫星任务规划系统主界面
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createScene, SatelliteLayer, TrackLayer, AoiLayer, EnvLayer, ORBIT_RINGS } from "./scene3d.js";
import {
  CATEGORY_META, CATEGORY_ZH, MISSION_STATUS_ZH, MISSION_PRIORITY_ZH, STATUS_FLOW,
  OBS_PRESETS, api, fmtTime, fmtDur,
} from "./lib.js";
import SatelliteDetail from "./components/SatelliteDetail.jsx";
import MissionsDrawer from "./components/MissionsDrawer.jsx";
import MissionForm from "./components/MissionForm.jsx";
import DispatchWorkbench from "./pages/DispatchWorkbench.jsx";
import { AgentPane, BladeWrapper } from "./agent/AgentPane.jsx";

export default function App() {
  const containerRef = useRef(null);
  const scene3dRef = useRef(null);
  const satLayerRef = useRef(null);
  const trackLayerRef = useRef(null);
  const aoiLayerRef = useRef(null);
  const envLayerRef = useRef(null);

  // ─── 状态 ───
  const [sceneReady, setSceneReady] = useState(false);
  const [categories, setCategories] = useState([]);
  const [enabledCats, setEnabledCats] = useState(new Set(Object.keys(CATEGORY_META)));
  const [positions, setPositions] = useState([]);
  const [isLive, setIsLive] = useState(true);
  const [clock, setClock] = useState(new Date());
  const [selectedSat, setSelectedSat] = useState(null);      // {noradId, ...positions}
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);

  // 图层开关
  const [showRings, setShowRings] = useState(true);
  const [showTrack, setShowTrack] = useState(true);
  const [showFire, setShowFire] = useState(false);
  const [showWind, setShowWind] = useState(false);

  // AOI
  const [aoiMode, setAoiMode] = useState(false);
  const [aoiPoint, setAoiPoint] = useState(null);           // {lat, lon}
  const [aoiRadius, setAoiRadius] = useState(500);

  // 任务
  const [missionsOpen, setMissionsOpen] = useState(false);
  const [missionsMinimized, setMissionsMinimized] = useState(false);
  const [showMissionForm, setShowMissionForm] = useState(false);
  const [editingMission, setEditingMission] = useState(null);
  const [missionsVersion, setMissionsVersion] = useState(0); // 触发任务列表刷新

  // 鼠标地理坐标
  const [cursorGeo, setCursorGeo] = useState(null);
  // 调度工作台
  const [workbench, setWorkbench] = useState(false);
  const [agentVisible, setAgentVisible] = useState(false);

  const groupColors = useMemo(() => {
    const m = {};
    for (const [k, v] of Object.entries(CATEGORY_META)) m[k] = v.color;
    return m;
  }, []);

  // ─── 场景初始化 ───
  useEffect(() => {
    if (!containerRef.current) return;
    const s3d = createScene(containerRef.current);
    scene3dRef.current = s3d;
    satLayerRef.current = new SatelliteLayer(s3d);
    trackLayerRef.current = new TrackLayer(s3d);
    aoiLayerRef.current = new AoiLayer(s3d);
    envLayerRef.current = new EnvLayer(s3d);
    satLayerRef.current.setGroupColors(groupColors);
    setSceneReady(true);

    // 悬停拾取（节流）
    let lastMove = 0;
    const onMove = (e) => {
      const now = Date.now();
      if (now - lastMove < 60) return;
      lastMove = now;
      const geo = s3d.pickGlobe(e.clientX, e.clientY);
      setCursorGeo(geo);
    };
    const container = containerRef.current;
    container.addEventListener("mousemove", onMove);
    return () => {
      container.removeEventListener("mousemove", onMove);
      s3d.dispose();
    };
  }, [groupColors]);

  // ─── 类别列表 ───
  useEffect(() => {
    api("/categories").then(setCategories).catch(() => {});
  }, []);

  // ─── 实时位置轮询 ───
  const fetchPositions = useCallback(async (timestamp) => {
    try {
      const url = timestamp ? `/positions?timestamp=${timestamp}` : "/positions";
      const data = await api(url);
      setPositions(data.satellites);
    } catch {}
  }, []);

  useEffect(() => {
    if (!isLive) return;
    fetchPositions();
    const t = setInterval(fetchPositions, 5000);
    return () => clearInterval(t);
  }, [isLive, fetchPositions]);

  // 时钟
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ─── 位置更新到三维 ───
  useEffect(() => {
    if (!satLayerRef.current) return;
    const visible = positions.filter(s => enabledCats.has(s.category));
    satLayerRef.current.updatePositions(visible);
    if (selectedSat) satLayerRef.current.highlight(selectedSat.noradId);
  }, [positions, enabledCats, selectedSat]);

  // ─── 图层开关到三维 ───
  useEffect(() => {
    const s3d = scene3dRef.current;
    if (!s3d) return;
    s3d.satGroup.parent.getObjectByName // rings 通过 ringGroup 引用
    // 简化：ringGroup 在 scene 上
    s3d.scene.children.forEach(child => {
      if (child.type === "Group" && child.children.length === 3 &&
          child.children[0].geometry?.type === "BufferGeometry") {
        child.visible = showRings;
      }
    });
  }, [showRings]);

  // 火点/风场
  useEffect(() => {
    if (!envLayerRef.current) return;
    if (showFire) {
      api("/layers/fire").then(data => {
        if (data?.points?.length) envLayerRef.current.showFireHotspots(data.points);
      }).catch(() => {});
    } else envLayerRef.current.clearFire();
  }, [showFire]);

  useEffect(() => {
    if (!envLayerRef.current) return;
    if (showWind) {
      api("/layers/wind").then(data => {
        if (data?.points?.length) envLayerRef.current.showWindField(data.points);
      }).catch(() => {});
    } else envLayerRef.current.clearWind();
  }, [showWind]);

  // ─── 点击拾取卫星 ───
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onClick = async (e) => {
      const s3d = scene3dRef.current;
      if (!s3d) return;
      // AOI 模式：点击设定圆心
      if (aoiMode) {
        const geo = s3d.pickGlobe(e.clientX, e.clientY);
        if (geo) {
          setAoiPoint(geo);
          setAoiMode(false);
        }
        return;
      }
      const nid = s3d.pick(e.clientX, e.clientY);
      if (nid) {
        try {
          const sat = await api(`/satellite/${nid}`);
          setSelectedSat(sat);
          satLayerRef.current?.highlight(nid);
        } catch {}
      }
    };
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, [aoiMode]);

  // ─── 选中卫星：画轨迹 ───
  useEffect(() => {
    if (!selectedSat || !trackLayerRef.current) return;
    if (!showTrack) { trackLayerRef.current.clear(); return; }
    api(`/track/${selectedSat.noradId}?minutes=120`).then(data => {
      trackLayerRef.current.showTrack(data.track, CATEGORY_META[selectedSat.category]?.color ?? "#2dd4a7");
    }).catch(() => {});
  }, [selectedSat, showTrack]);

  // ─── AOI 标记 ───
  useEffect(() => {
    if (!aoiLayerRef.current) return;
    aoiLayerRef.current.clear();
    if (aoiPoint) {
      aoiLayerRef.current.drawAoi(aoiPoint.lat, aoiPoint.lon, aoiRadius);
    }
  }, [aoiPoint, aoiRadius]);

  // ─── 搜索 ───
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) { setSearchResults(null); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api(`/search?q=${encodeURIComponent(q)}&limit=30`);
        setSearchResults(r);
      } catch {}
    }, 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const handleSearchPick = (sat) => {
    setSelectedSat(sat);
    setSearchQuery("");
    setSearchResults(null);
    // 镜头聚焦
    satLayerRef.current?.highlight(sat.noradId);
    // 拿当前位置聚焦
    const pos = positions.find(p => p.noradId === sat.noradId);
    if (pos) satLayerRef.current.focusCamera(pos.lat, pos.lon, pos.altKm);
  };

  const missionSaved = () => {
    setShowMissionForm(false);
    setEditingMission(null);
    setMissionsVersion(v => v + 1);
    setMissionsOpen(true);
    setMissionsMinimized(false);
  };

  // ─── 渲染 ───
  return (
    <BladeWrapper>
    <>
      {/* 三维容器 */}
      <div ref={containerRef} style={{ position: "fixed", inset: 0, cursor: aoiMode ? "crosshair" : "default" }} />

      {/* 顶栏 */}
      <div className="topbar">
        <div className="topbar-brand">
          <div className="sigil" />
          遥感卫星任务规划
        </div>
        <div className="topbar-stats">
          <span>在轨遥感 <b>{positions.filter(s => enabledCats.has(s.category)).length}</b></span>
          {categories.map(c => (
            <span key={c.key}>{CATEGORY_META[c.key]?.label ?? c.key} <b>{c.count}</b></span>
          ))}
        </div>
        <div className="topbar-right">
          <span className="clock">{clock.toLocaleTimeString("zh-CN", { hour12: false })}</span>
          <span className={`live-badge ${isLive ? "" : "paused"}`} onClick={() => setIsLive(!isLive)}>
            <span className="dot" />{isLive ? "实时" : "暂停"}
          </span>
          <button className="btn secondary" style={{ padding: "4px 12px" }}
            onClick={() => { setMissionsOpen(true); setMissionsMinimized(false); }}>
            任务管理
          </button>
          <button className="btn secondary" style={{ padding: "4px 12px", borderColor: "var(--accent)", color: "var(--accent)" }}
            onClick={() => setWorkbench(true)}>
            调度工作台
          </button>
          <button className="btn" style={{ padding: "4px 12px" }} onClick={() => setAgentVisible(!agentVisible)}>
            AI 下单助手
          </button>
          <button className="btn" style={{ padding: "4px 12px" }}
            onClick={() => { setEditingMission(null); setShowMissionForm(true); }}>
            + 新建任务
          </button>
        </div>
      </div>

      {/* 左面板折叠按钮 */}
      <button className="panel-toggle" onClick={() => setLeftCollapsed(!leftCollapsed)}>
        {leftCollapsed ? "»" : "«"}
      </button>

      {/* 左侧控制面板 */}
      <div className={`left-panel ${leftCollapsed ? "collapsed" : ""}`}>
        {/* 星座筛选 */}
        <div className="panel-card">
          <div className="panel-card-header">
            遥感星座
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>
              {Object.values(CATEGORY_META).length} 类
            </span>
          </div>
          <div className="panel-card-body">
            {Object.entries(CATEGORY_META).map(([key, meta]) => {
              const cat = categories.find(c => c.key === key);
              const on = enabledCats.has(key);
              return (
                <div key={key} className={`cat-row ${on ? "" : "off"}`}
                  onClick={() => {
                    const next = new Set(enabledCats);
                    if (on) next.delete(key); else next.add(key);
                    setEnabledCats(next);
                  }}>
                  <span className="swatch" style={{ background: meta.color }} />
                  {meta.label}
                  <span className="cnt">{cat?.count ?? 0}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 搜索 */}
        <div className="panel-card">
          <div className="panel-card-header">卫星检索</div>
          <div className="panel-card-body">
            <input className="search-box" placeholder="名称 / NORAD 编号，如：高分 39150 YAOGAN"
              value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            {searchResults && (
              <div className="search-results">
                {searchResults.length === 0 && <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 12 }}>无匹配卫星</div>}
                {searchResults.map(s => (
                  <div key={s.noradId} className="search-item" onClick={() => handleSearchPick(s)}>
                    <span className="swatch" style={{ width: 8, height: 8, borderRadius: 2, background: groupColors[s.category] ?? "#8fa3c8" }} />
                    {s.name}
                    <span className="cat-tag" style={{ background: "rgba(56,88,140,0.25)", color: "var(--text-dim)" }}>
                      {CATEGORY_ZH[s.category] ?? s.category}
                    </span>
                    <span className="nid">{s.noradId}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 图层 */}
        <div className="panel-card">
          <div className="panel-card-header">图层与显示</div>
          <div className="panel-card-body">
            <div className="layer-row" onClick={() => setShowRings(!showRings)}>
              轨道参考环 <span className={`toggle ${showRings ? "on" : ""}`} />
            </div>
            <div className="layer-row" onClick={() => setShowTrack(!showTrack)}>
              星下点轨迹 <span className={`toggle ${showTrack ? "on" : ""}`} />
            </div>
            <div className="layer-row" onClick={() => setShowFire(!showFire)}>
              火点热区（示例） <span className={`toggle ${showFire ? "on" : ""}`} />
            </div>
            <div className="layer-row" onClick={() => setShowWind(!showWind)}>
              海面风场（示例） <span className={`toggle ${showWind ? "on" : ""}`} />
            </div>
          </div>
        </div>

        {/* AOI */}
        <div className="panel-card">
          <div className="panel-card-header">关注区域 AOI</div>
          <div className="panel-card-body">
            <div className="aoi-hint">
              点击按钮进入圈选模式，再点击地球任意位置设定圆心。
            </div>
            <button className={`btn aoi-mode-btn ${aoiMode ? "on" : ""}`}
              onClick={() => setAoiMode(!aoiMode)}>
              {aoiMode ? "圈选中… 点击地球设定圆心" : aoiPoint ? "重新圈选" : "圈选 AOI"}
            </button>
            {aoiPoint && (
              <>
                <div className="kv-grid">
                  <div className="kv"><div className="k">圆心纬度</div><div className="v">{aoiPoint.lat.toFixed(3)}°</div></div>
                  <div className="kv"><div className="k">圆心经度</div><div className="v">{aoiPoint.lon.toFixed(3)}°</div></div>
                </div>
                <div className="form-field" style={{ marginTop: 8 }}>
                  <label>半径（km）</label>
                  <input className="mini-input" type="number" value={aoiRadius}
                    onChange={e => setAoiRadius(Math.max(10, parseInt(e.target.value) || 100))} />
                </div>
                <div className="btn-row">
                  <button className="btn" onClick={() => {
                    setEditingMission(null);
                    setShowMissionForm(true);
                  }}>据此建任务</button>
                  <button className="btn secondary" onClick={() => setAoiPoint(null)}>清除</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* AOI 圈选横幅 */}
      {aoiMode && <div className="aoi-banner">AOI 圈选模式 — 点击地球设定圆心</div>}

      {/* 鼠标坐标 */}
      {cursorGeo && <div className="cursor-coords">{cursorGeo.lat.toFixed(2)}°, {cursorGeo.lon.toFixed(2)}°</div>}

      {/* 右侧卫星详情 */}
      {selectedSat && (
        <div className="right-panel">
          <SatelliteDetail
            sat={selectedSat}
            onClose={() => { setSelectedSat(null); satLayerRef.current?.clearHighlight(); trackLayerRef.current?.clear(); }}
            onCreateMission={(sat) => {
              setEditingMission(null);
              setShowMissionForm(true);
              // 预设指派该卫星
              window.__prefillAssign = [sat.noradId];
            }}
          />
        </div>
      )}

      {/* 底部 HUD */}
      <div className="hud-bottom">
        {ORBIT_RINGS.map(r => (
          <span className="hud-chip" key={r.label}>{r.label}</span>
        ))}
        <span className="hud-chip">拖动旋转 · 滚轮缩放 · 点击卫星查看档案</span>
      </div>

      {/* 任务抽屉 */}
      {missionsOpen && (
        <MissionsDrawer
          minimized={missionsMinimized}
          onToggle={() => setMissionsMinimized(!missionsMinimized)}
          onClose={() => setMissionsOpen(false)}
          version={missionsVersion}
          onEdit={(m) => { setEditingMission(m); setShowMissionForm(true); }}
          positions={positions}
        />
      )}

      {/* 任务表单 */}
      {showMissionForm && (
        <MissionForm
          editing={editingMission}
          aoiPoint={aoiPoint}
          positions={positions}
          onCancel={() => { setShowMissionForm(false); setEditingMission(null); window.__prefillAssign = null; }}
          onSaved={missionSaved}
        />
      )}
      {workbench && <DispatchWorkbench onBack={() => setWorkbench(false)} />}
      <AgentPane
        visible={agentVisible || workbench}
        onClose={() => setAgentVisible(false)}
        getContext={() => ({
          page: workbench ? "调度工作台" : "三维态势",
          selectedTaskId: workbench ? undefined : null,
          timestamp: new Date().toISOString(),
        })}
      />
    </>
    </BladeWrapper>
  );
}
