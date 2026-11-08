// 调度工作台页面 —— 任务受理/候选排序/派单执行/应急直控
import React, { useState, useEffect, useCallback } from "react";
import { api, fmtTime } from "../lib.js";

const TASK_STATUS_COLOR = {
  '待派单': '#f5a524', '已派发': '#7ec8ff', '已接单': '#7ec8ff', '执行中': '#2dd4a7',
  '已交付': '#2dd4a7', '已验收': '#4ade80', '已失败': '#f4525e', '挂任务池': '#f5a524',
  '直控执行中': '#f5a524',
};


export default function DispatchWorkbench({ onBack }) {
  const [tab, setTab] = useState('tasks'); // tasks|orders|pool|plans|companies
  const [tasks, setTasks] = useState([]);
  const [selected, setSelected] = useState(null); // 任务详情
  const [showNew, setShowNew] = useState(false);
  const [orders, setOrders] = useState([]);
  const [plans, setPlans] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [pool, setPool] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    // 并行拉取（原来是 5 个串行 await，最慢者拖累全部）
    const [t, o, p, c, pl] = await Promise.all([
      api('/dispatch/tasks').catch(() => []),
      api('/dispatch/orders').catch(() => []),
      api('/dispatch/plans').catch(() => []),
      api('/dispatch/companies').catch(() => []),
      api('/dispatch/pool').catch(() => []),
    ]);
    setTasks(t); setOrders(o); setPlans(p); setCompanies(c); setPool(pl);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000); // 8s→15s：列表类数据不需要高频
    return () => clearInterval(t);
  }, [load]);

  const openTask = async (id) => {
    setSelected(await api(`/dispatch/tasks/${id}`));
  };

  const runCandidates = async (id) => {
    setBusy(true); setMsg(null);
    try {
      const r = await api(`/dispatch/tasks/${id}/candidates`, { method: 'POST' });
      setMsg({ ok: true, text: `候选计算完成：${r.candidates} 个候选通过约束（筛除 ${r.filtered}），已生成 ${r.ranked} 条排序` });
      await openTask(id);
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };

  const doDispatch = async (id) => {
    setBusy(true); setMsg(null);
    try {
      const r = await api(`/dispatch/tasks/${id}/dispatch`, { method: 'POST' });
      if (r.channel === '直控') {
        setMsg({ ok: true, text: `R1 应急分流 → 直控执行，已生成执行方案 #${r.planId}（首顺位 ${r.topRank.satName}），待值班确认` });
      } else {
        setMsg({ ok: true, text: `${r.rule} → ${r.channel}通道，订单 ${r.orderNo} 派发至 ${r.company}` + (r.inquiries?.length ? `，同步询价：${r.inquiries.join('、')}` : '') });
      }
      await load(); await openTask(id);
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };

  const advanceOrder = async (orderId, status) => {
    await api(`/dispatch/orders/${orderId}/status`, { method: 'POST', body: JSON.stringify({ status }) });
    await load(); if (selected) await openTask(selected.id);
  };

  const planAction = async (planId, action) => {
    setBusy(true);
    try {
      if (action === 'generate') {
        const r = await api(`/dispatch/plans/${planId}/generate`, { method: 'POST' });
        setMsg({ ok: r.validation.pass, text: r.validation.pass
          ? `指令包生成并通过独立校验（${r.commands.length} 条动作，总时长 ${r.validation.totalDuration}s）`
          : `校验驳回：${r.validation.errors.join('；')}` });
      } else if (action === '方案' || action === '上注') {
        await api(`/dispatch/plans/${planId}/confirm`, { method: 'POST', body: JSON.stringify({ stage: action }) });
      } else if (action === 'complete') {
        await api(`/dispatch/plans/${planId}/complete`, { method: 'POST', body: JSON.stringify({ outcome: '成功' }) });
      }
      await load(); if (selected) await openTask(selected.id);
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };

  const claimTask = async (taskId, company) => {
    await api(`/dispatch/pool/${taskId}/claim`, { method: 'POST', body: JSON.stringify({ company }) });
    await load();
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-deep)', zIndex: 300, display: 'flex', flexDirection: 'column' }}>
      {/* 顶栏 */}
      <div className="topbar">
        <button className="btn secondary" style={{ padding: '4px 12px' }} onClick={onBack}>← 三维态势</button>
        <div className="topbar-brand" style={{ fontSize: 14 }}>调度工作台</div>
        <div className="topbar-stats">
          <span>任务 <b>{tasks.length}</b></span>
          <span>订单 <b>{orders.length}</b></span>
          <span>直控方案 <b>{plans.length}</b></span>
        </div>
        <div className="topbar-right">
          <button className="btn" onClick={() => setShowNew(true)}>+ 新建任务</button>
        </div>
      </div>

      {/* Tab */}
      <div style={{ display: 'flex', gap: 4, padding: '10px 16px 0' }}>
        {[['tasks', '任务管理'], ['orders', '订单跟踪'], ['plans', '应急直控'], ['pool', '任务池'], ['companies', '公司生态']].map(([k, label]) => (
          <div key={k} onClick={() => setTab(k)}
            style={{
              padding: '7px 18px', cursor: 'pointer', fontSize: 13,
              borderBottom: tab === k ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === k ? 'var(--accent)' : 'var(--text-dim)',
            }}>{label}</div>
        ))}
      </div>

      {msg && (
        <div style={{ margin: '8px 16px', padding: '8px 14px', borderRadius: 4, fontSize: 12.5,
          background: msg.ok ? 'rgba(45,212,167,0.1)' : 'rgba(244,82,94,0.1)',
          border: `1px solid ${msg.ok ? 'rgba(45,212,167,0.4)' : 'rgba(244,82,94,0.4)'}`,
          color: msg.ok ? 'var(--accent)' : 'var(--danger)' }}>
          {msg.text}
          <span onClick={() => setMsg(null)} style={{ float: 'right', cursor: 'pointer', color: 'var(--text-dim)' }}>✕</span>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
        {tab === 'tasks' && <TasksTab tasks={tasks} selected={selected} openTask={openTask}
          runCandidates={runCandidates} doDispatch={doDispatch} busy={busy} advanceOrder={advanceOrder} />}
        {tab === 'orders' && <OrdersTab orders={orders} advanceOrder={advanceOrder} />}
        {tab === 'plans' && <PlansTab plans={plans} planAction={planAction} busy={busy} />}
        {tab === 'pool' && <PoolTab pool={pool} companies={companies} claimTask={claimTask} />}
        {tab === 'companies' && <CompaniesTab companies={companies} />}
      </div>

      {showNew && <NewTaskModal onClose={() => setShowNew(false)} onCreated={async (id) => { setShowNew(false); await load(); await openTask(id); setTab('tasks'); }} />}
    </div>
  );
}

// ─── 任务管理 Tab ─────────────────────────────────────────────────────────
function TasksTab({ tasks, selected, openTask, runCandidates, doDispatch, busy, advanceOrder }) {
  return (
    <div style={{ display: 'flex', gap: 14 }}>
      {/* 任务列表 */}
      <div style={{ flex: selected ? '0 0 46%' : 1 }}>
        <table className="mission-table">
          <thead><tr><th>任务编号</th><th>任务名称</th><th>类型</th><th>分辨率</th><th>优先级</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {tasks.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 20 }}>暂无任务，点击右上角「新建任务」创建</td></tr>}
            {tasks.map(t => (
              <tr key={t.id} onClick={() => openTask(t.id)} style={{ background: selected?.id === t.id ? 'rgba(45,212,167,0.08)' : undefined }}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{t.taskNo}</td>
                <td style={{ color: 'var(--text-bright)' }}>{t.taskName}</td>
                <td>{t.obsType === 'sar' ? 'SAR' : t.obsType === 'video' ? '视频' : '光学'}</td>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{t.resolution}m</td>
                <td className={`priority-${t.priority === '应急' ? 'critical' : t.priority === '重点' ? 'high' : 'medium'}`}>{t.priority}</td>
                <td><span className="status-pill" style={{ background: (TASK_STATUS_COLOR[t.status] ?? '#888') + '22', color: TASK_STATUS_COLOR[t.status] ?? '#888' }}>{t.status}</span></td>
                <td><button className="btn secondary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={e => { e.stopPropagation(); openTask(t.id); }}>详情</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 任务详情 */}
      {selected && (
        <div style={{ flex: 1, border: '1px solid var(--border-bright)', borderRadius: 6, padding: 16, alignSelf: 'flex-start', position: 'sticky', top: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <b style={{ fontFamily: 'var(--font-display)', fontSize: 15, color: 'var(--text-bright)' }}>{selected.taskName}</b>
            <span className="status-pill" style={{ background: (TASK_STATUS_COLOR[selected.status] ?? '#888') + '22', color: TASK_STATUS_COLOR[selected.status] }}>{selected.status}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', marginLeft: 'auto' }}>{selected.taskNo}</span>
          </div>
          <div className="kv-grid">
            <div className="kv"><div className="k">目标</div><div className="v">{selected.targetName}</div></div>
            <div className="kv"><div className="k">观测类型</div><div className="v">{selected.obsType === 'sar' ? 'SAR' : '光学'}</div></div>
            <div className="kv"><div className="k">分辨率要求</div><div className="v">{selected.resolution} m</div></div>
            <div className="kv"><div className="k">最大云量</div><div className="v">{(selected.maxCloud * 100).toFixed(0)}%</div></div>
            <div className="kv"><div className="k">时间窗</div><div className="v" style={{ fontSize: 10.5 }}>{selected.windowStart?.slice(5, 16)} ~ {selected.windowEnd?.slice(5, 16)}</div></div>
            <div className="kv"><div className="k">时效要求</div><div className="v">{selected.timelinessHours ? `${selected.timelinessHours}h` : '—'}</div></div>
          </div>

          <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
            <button className="btn" disabled={busy} onClick={() => runCandidates(selected.id)}>① 候选计算</button>
            <button className="btn" disabled={busy || !selected.rankings?.length} onClick={() => doDispatch(selected.id)}>② 派单分流</button>
          </div>

          {/* 排序清单 */}
          {selected.rankings?.length > 0 && (
            <>
              <div className="section-label">排序清单（S = Q × R × C）</div>
              <table className="mission-table" style={{ fontSize: 11.5 }}>
                <thead><tr><th>#</th><th>卫星</th><th>公司</th><th>过顶时刻</th><th>侧摆</th><th>云量</th><th>可用度</th><th>S</th></tr></thead>
                <tbody>
                  {selected.rankings.slice(0, 12).map(r => (
                    <tr key={r.id}>
                      <td style={{ color: r.rank === 1 ? 'var(--accent)' : 'var(--text-dim)', fontWeight: r.rank === 1 ? 700 : 400 }}>{r.rank}</td>
                      <td style={{ color: 'var(--text-bright)' }}>{r.satName}</td>
                      <td>{r.company}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{r.overpassTime?.slice(5, 16)}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{r.slewDeg?.toFixed(0)}°</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }} title={r.cloudSource === 'real' ? '真实气象预报 (open-meteo)' : '内置模拟气象场（超出72h预报窗）'}>
                        {(r.cloudFc * 100).toFixed(0)}%{r.cloudSource === 'real' ? ' 🛰' : ''}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{r.availability}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 600 }}>{r.S}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* 关联订单 */}
          {selected.orders?.length > 0 && (
            <>
              <div className="section-label">关联订单</div>
              {selected.orders.map(o => (
                <div key={o.id} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 12px', marginBottom: 6, fontSize: 12 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{o.orderNo}</span>
                    <span className="status-pill" style={{ background: (TASK_STATUS_COLOR[o.status] ?? '#888') + '22', color: TASK_STATUS_COLOR[o.status] ?? '#888' }}>{o.status}</span>
                    <b>{o.company}</b>
                    <span style={{ color: 'var(--text-dim)' }}>{o.channel}通道 · 顺位#{o.rankUsed ?? '—'}</span>
                    {o.price && <span style={{ color: 'var(--warn)' }}>{o.price} 万</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    {o.status === '已派发' && <button className="btn secondary" style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => advanceOrder(o.id, '已接单')}>公司接单</button>}
                    {o.status === '已接单' && <button className="btn secondary" style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => advanceOrder(o.id, '执行中')}>开始执行</button>}
                    {o.status === '执行中' && <button className="btn secondary" style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => advanceOrder(o.id, '已交付')}>交付成果</button>}
                    {o.status === '已交付' && <button className="btn" style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => advanceOrder(o.id, '已验收')}>验收通过</button>}
                    {o.status === '已交付' && <button className="btn danger" style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => advanceOrder(o.id, '已失败')}>验收不通过</button>}
                  </div>
                </div>
              ))}
            </>
          )}

          {/* 直控方案 */}
          {selected.directPlans?.length > 0 && (
            <>
              <div className="section-label">直控执行方案</div>
              {selected.directPlans.map(p => (
                <div key={p.id} style={{ border: '1px solid var(--warn)', borderRadius: 4, padding: '8px 12px', marginBottom: 6, fontSize: 12 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <b>{p.satName}</b>
                    <span className="status-pill" style={{ background: 'rgba(245,165,36,0.15)', color: 'var(--warn)' }}>{p.status}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>过顶 {p.overpassTime?.slice(5, 16)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                    <button className="btn secondary" style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => planAction(p.id, 'generate')}>生成指令包</button>
                    {p.status === '指令已生成' && <button className="btn secondary" style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => planAction(p.id, '方案')}>方案确认（值班）</button>}
                    {p.status === '方案已确认' && <button className="btn" style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => planAction(p.id, '上注')}>上注前确认</button>}
                    {p.status === '执行中' && <button className="btn" style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => planAction(p.id, 'complete')}>执行完成回写</button>}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 订单跟踪 Tab ─────────────────────────────────────────────────────────
function OrdersTab({ orders, advanceOrder }) {
  return (
    <table className="mission-table">
      <thead><tr><th>订单号</th><th>任务目标</th><th>通道</th><th>承接公司</th><th>卫星</th><th>金额</th><th>状态</th><th>履约</th><th></th></tr></thead>
      <tbody>
        {orders.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 20 }}>暂无订单</td></tr>}
        {orders.map(o => (
          <tr key={o.id}>
            <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{o.orderNo}</td>
            <td style={{ color: 'var(--text-bright)' }}>{o.targetName}</td>
            <td>{o.channel}</td>
            <td>{o.company || '—'}</td>
            <td style={{ fontSize: 11.5 }}>{o.satName || '待定'}</td>
            <td style={{ fontFamily: 'var(--font-mono)' }}>{o.price ? `${o.price}万` : '—'}</td>
            <td><span className="status-pill" style={{ background: (TASK_STATUS_COLOR[o.status] ?? '#888') + '22', color: TASK_STATUS_COLOR[o.status] ?? '#888' }}>{o.status}</span></td>
            <td style={{ color: o.fulfillment === '按约完成' ? 'var(--accent)' : o.fulfillment ? 'var(--danger)' : 'var(--text-dim)', fontSize: 11.5 }}>{o.fulfillment ?? '—'}</td>
            <td>
              {o.status === '已派发' && <button className="btn secondary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => advanceOrder(o.id, '已接单')}>接单</button>}
              {o.status === '已接单' && <button className="btn secondary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => advanceOrder(o.id, '执行中')}>执行</button>}
              {o.status === '执行中' && <button className="btn secondary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => advanceOrder(o.id, '已交付')}>交付</button>}
              {o.status === '已交付' && <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => advanceOrder(o.id, '已验收')}>验收</button>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── 应急直控 Tab ─────────────────────────────────────────────────────────
function PlansTab({ plans, planAction, busy }) {
  return (
    <div>
      {plans.length === 0 && <div style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 30 }}>暂无直控方案（应急任务分流后自动生成）</div>}
      {plans.map(p => (
        <div key={p.id} style={{ border: '1px solid var(--border-bright)', borderRadius: 6, padding: '12px 16px', marginBottom: 12, background: 'var(--bg-panel)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <b style={{ color: 'var(--text-bright)' }}>{p.satName}</b>
            <span className="status-pill" style={{ background: 'rgba(245,165,36,0.15)', color: 'var(--warn)' }}>{p.status}</span>
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{p.company}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', marginLeft: 'auto' }}>
              窗口 {p.windowStart?.slice(5, 16)} ~ {p.windowEnd?.slice(11, 16)} · 过顶 {p.overpassTime?.slice(11, 16)}
            </span>
          </div>
          {/* 指令时间轴 */}
          {p.commands && (
            <div style={{ display: 'flex', gap: 4, margin: '8px 0', flexWrap: 'wrap', alignItems: 'center' }}>
              {p.commands.map(c => (
                <React.Fragment key={c.seq}>
                  <span style={{ padding: '3px 10px', borderRadius: 3, fontSize: 11, fontFamily: 'var(--font-mono)',
                    background: c.action === '成像' ? 'rgba(45,212,167,0.15)' : 'rgba(56,88,140,0.25)',
                    color: c.action === '成像' ? 'var(--accent)' : 'var(--text-main)',
                    border: `1px solid ${c.action === '成像' ? 'rgba(45,212,167,0.4)' : 'transparent'}` }}>
                    {c.seq}.{c.action} {c.duration}s
                  </span>
                  {c.seq < p.commands.length && <span style={{ color: 'var(--text-dim)', fontSize: 10 }}>→1s→</span>}
                </React.Fragment>
              ))}
            </div>
          )}
          {/* 校验结果 */}
          {p.validation && (
            <div style={{ fontSize: 11.5, marginBottom: 8, color: p.validation.pass ? 'var(--accent)' : 'var(--danger)' }}>
              独立校验：{p.validation.pass ? `✅ 通过（总时长 ${p.validation.totalDuration}s，开关机/间隔/固存/参数 全部合规）` : `❌ ${p.validation.errors.join('；')}`}
            </div>
          )}
          {/* 弧段 */}
          {p.arcInfo && (
            <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 8 }}>
              测控弧段：{JSON.parse(p.arcInfo).station} {JSON.parse(p.arcInfo).arcStart.slice(11, 16)} ~ {JSON.parse(p.arcInfo).arcEnd.slice(11, 16)} UTC
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn secondary" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }} onClick={() => planAction(p.id, 'generate')}>生成/重算指令包</button>
            {p.status === '指令已生成' && <button className="btn secondary" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }} onClick={() => planAction(p.id, '方案')}>① 方案确认（值班）</button>}
            {p.status === '方案已确认' && <button className="btn" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }} onClick={() => planAction(p.id, '上注')}>② 上注前确认 → 弧段上注</button>}
            {p.status === '执行中' && <button className="btn" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }} onClick={() => planAction(p.id, 'complete')}>③ 执行完成回写</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── 任务池 Tab ───────────────────────────────────────────────────────────
function PoolTab({ pool, companies, claimTask }) {
  return (
    <div>
      {pool.length === 0 && <div style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 30 }}>任务池为空</div>}
      {pool.map(p => (
        <div key={p.id} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '10px 16px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ flex: 1 }}>
            <b style={{ color: 'var(--text-bright)' }}>{p.taskName}</b>
            <span style={{ color: 'var(--text-dim)', fontSize: 12, marginLeft: 10 }}>{p.targetName} · {p.obsType === 'sar' ? 'SAR' : '光学'} {p.resolution}m</span>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>入池 {p.poolSince?.slice(5, 16)} · 有效期至 {p.expiresAt?.slice(5, 16)}</div>
          </div>
          <select className="mini-input" style={{ width: 160 }} defaultValue="" onChange={e => { if (e.target.value) claimTask(p.taskId, e.target.value); }}>
            <option value="">选择抢单公司…</option>
            {companies.filter(c => c.type !== '国家级').map(c => <option key={c.id} value={c.short}>{c.short}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}

// ─── 公司生态 Tab ─────────────────────────────────────────────────────────
function CompaniesTab({ companies }) {
  return (
    <table className="mission-table">
      <thead><tr><th>公司</th><th>性质</th><th>简介</th><th>报备容量</th><th>已承接</th><th>承载余量</th><th>履约完成率</th><th>数据档位</th></tr></thead>
      <tbody>
        {companies.map(c => (
          <tr key={c.id}>
            <td style={{ color: 'var(--text-bright)' }}>{c.short}</td>
            <td>{c.type}</td>
            <td style={{ fontSize: 11.5, color: 'var(--text-dim)', maxWidth: 320 }}>{c.desc}</td>
            <td style={{ fontFamily: 'var(--font-mono)' }}>{c.capacity}</td>
            <td style={{ fontFamily: 'var(--font-mono)' }}>{c.acceptedCount}</td>
            <td style={{ fontFamily: 'var(--font-mono)' }}>{Math.round((1 - c.acceptedCount / c.capacity) * 100)}%</td>
            <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>{c.fulfillmentRate ? (c.fulfillmentRate * 100).toFixed(1) + '%' : '—'}</td>
            <td>{c.dataQuality}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── 新建任务弹窗 ─────────────────────────────────────────────────────────
function NewTaskModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    taskName: '', targetName: '', targetType: '城区',
    geomType: 'point', lat: '39.9042', lon: '116.4074',
    obsType: 'optical', resolution: '1.0', spectral: '',
    windowStart: '', windowEnd: '', maxCloud: '0.3', maxSlewDeg: '45',
    timelinessHours: '', priority: '常规',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setError('');
    if (!form.taskName || !form.targetName || !form.windowStart || !form.windowEnd) {
      setError('任务名称、目标名称、时间窗为必填'); return;
    }
    setSaving(true);
    try {
      const body = {
        ...form,
        source: '手工录入',
        geomType: form.geomType,
        geom: form.geomType === 'point'
          ? { lat: parseFloat(form.lat), lon: parseFloat(form.lon) }
          : { coords: JSON.parse(form.lat) },
        resolution: parseFloat(form.resolution),
        maxCloud: parseFloat(form.maxCloud),
        maxSlewDeg: parseFloat(form.maxSlewDeg),
        timelinessHours: form.timelinessHours ? parseFloat(form.timelinessHours) : null,
      };
      const r = await api('/dispatch/tasks', { method: 'POST', body: JSON.stringify(body) });
      onCreated(r.id);
    } catch (e) {
      setError(e.error ? (Array.isArray(e.errors) ? e.errors.join('；') : e.error) : e.message);
    }
    setSaving(false);
  };

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-header">新建调度任务
          <button className="close-btn" style={{ marginLeft: 'auto' }} onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-field"><label>任务名称 *</label>
              <input value={form.taskName} onChange={e => set('taskName', e.target.value)} placeholder="如：华北洪涝应急监测" /></div>
            <div className="form-field"><label>目标名称 *</label>
              <input value={form.targetName} onChange={e => set('targetName', e.target.value)} placeholder="如：涿州市区" /></div>
            <div className="form-field"><label>目标类型</label>
              <select value={form.targetType} onChange={e => set('targetType', e.target.value)}>
                {['城区', '农田', '水体', '林地', '港口', '机场', '道路', '工程', '其他'].map(t => <option key={t}>{t}</option>)}
              </select></div>
            <div className="form-field"><label>目标位置（纬度,经度）*</label>
              <input value={`${form.lat},${form.lon}`} onChange={e => {
                const [la, lo] = e.target.value.split(',').map(s => s.trim());
                setForm(f => ({ ...f, lat: la ?? f.lat, lon: lo ?? f.lon }));
              }} placeholder="39.9042,116.4074" /></div>
            <div className="form-field"><label>观测类型 *</label>
              <select value={form.obsType} onChange={e => set('obsType', e.target.value)}>
                <option value="optical">光学</option><option value="sar">SAR雷达</option><option value="video">视频</option>
              </select></div>
            <div className="form-field"><label>分辨率要求（米）*</label>
              <input type="number" step="0.1" value={form.resolution} onChange={e => set('resolution', e.target.value)} /></div>
            <div className="form-field"><label>时间窗起 *</label>
              <input type="datetime-local" value={form.windowStart} onChange={e => set('windowStart', e.target.value)} /></div>
            <div className="form-field"><label>时间窗止 *</label>
              <input type="datetime-local" value={form.windowEnd} onChange={e => set('windowEnd', e.target.value)} /></div>
            <div className="form-field"><label>最大云量（0-1）</label>
              <input type="number" step="0.05" value={form.maxCloud} onChange={e => set('maxCloud', e.target.value)} /></div>
            <div className="form-field"><label>时效要求（小时，可选）</label>
              <input type="number" value={form.timelinessHours} onChange={e => set('timelinessHours', e.target.value)} placeholder="24" /></div>
            <div className="form-field"><label>优先级</label>
              <select value={form.priority} onChange={e => set('priority', e.target.value)}>
                <option>常规</option><option>重点</option><option>应急</option>
              </select></div>
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn secondary" onClick={onClose}>取消</button>
            <button className="btn" onClick={save} disabled={saving}>{saving ? '提交中…' : '生成任务单'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
