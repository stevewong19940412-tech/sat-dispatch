// 调度工作台页面 —— 任务受理/候选排序/派单执行/应急直控
import React, { useState, useEffect, useCallback } from "react";
import { api, fmtTime } from "../lib.js";

const TASK_STATUS_COLOR = {
  '待派单': '#f5a524', '已派发': '#7ec8ff', '已接单': '#7ec8ff', '执行中': '#2dd4a7',
  '已交付': '#2dd4a7', '已验收': '#4ade80', '已失败': '#f4525e', '挂任务池': '#f5a524',
  '直控执行中': '#f5a524',
};


export default function DispatchWorkbench({ onBack, aoiPrefill }) {
  const [tab, setTab] = useState('tasks'); // tasks|orders|pool|plans|companies
  const [tasks, setTasks] = useState([]);
  const [selected, setSelected] = useState(null); // 任务详情
  const [orders, setOrders] = useState([]);
  const [plans, setPlans] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [pool, setPool] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // 删除确认弹窗状态（主组件持有，TasksTab 通过 onRequestDelete 回调触发）
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  // 直控参数包核验弹窗（主组件持有；人工勾选核验项后确认上注）
  const [uplinkVerify, setUplinkVerify] = useState(null);
  // 派给公司方式选择弹窗（指定第一公司/全候选竞价/挂池抢单）
  const [assignMode, setAssignMode] = useState(null);
  const [uplinkChecklist, setUplinkChecklist] = useState({});

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

  // AI 建单联动：进工作台后查最近 3 分钟内 AI 创建的任务，有则自动打开详情
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await api('/dispatch/latest');
        if (!cancelled && d.taskId) {
          await openTask(d.taskId);
          setTab('tasks');
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

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

  const deleteTask = async (taskId) => {
    try {
      await api(`/dispatch/tasks/${taskId}`, { method: 'DELETE' });
      setMsg({ ok: true, text: '任务单已删除（候选/排序/关联订单已级联清理）' });
      if (selected?.id === taskId) setSelected(null);
      await load();
    } catch (e) { setMsg({ ok: false, text: e.message }); }
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
          <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>任务统一由 AI 下单助手建立 · 人工在此审核与推进</span>
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
          runCandidates={runCandidates} doDispatch={doDispatch} busy={busy} advanceOrder={advanceOrder} deleteTask={deleteTask} onRequestDelete={(t) => setDeleteConfirm(t)} setAssignMode={setAssignMode} />}
        {tab === 'orders' && <OrdersTab orders={orders} advanceOrder={advanceOrder} />}
        {tab === 'plans' && <PlansTab plans={plans} planAction={planAction} busy={busy} setUplinkVerify={setUplinkVerify} />}
        {tab === 'pool' && <PoolTab pool={pool} companies={companies} claimTask={claimTask} />}
        {tab === 'companies' && <CompaniesTab companies={companies} />}
      </div>

      {/* 派给公司方式选择弹窗：指定第一公司 / 全候选竞价 / 挂池抢单 */}
      {assignMode && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setAssignMode(null); }}>
          <div className="modal" style={{ width: 440 }}>
            <div className="modal-header">派给公司 · 选择方式
              <button className="close-btn" style={{ marginLeft: 'auto' }} onClick={() => setAssignMode(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>
                任务 {assignMode.taskNo}「{assignMode.taskName}」｜ 候选 {assignMode.rankings?.length ?? 0} 条
              </div>
              {[
                { key: 'top1', title: '派给排名第一的公司', desc: `直接指派 ${assignMode.rankings?.[0]?.company ?? '—'}（${assignMode.rankings?.[0]?.satName ?? '—'}，优先级评分最高）`, act: 'top1' },
                { key: 'inquiry', title: '向所有候选公司发起竞价', desc: `候选公司 ${new Set((assignMode.rankings ?? []).map(r => r.company)).size} 家，报价后人工定标`, act: 'inquiry' },
                { key: 'pool', title: '挂入任务池让公司抢单', desc: '符合条件的公司自行认领，适合小额碎片任务', act: 'pool' },
              ].map(opt => (
                <div key={opt.key} onClick={async () => {
                  try {
                    if (opt.act === 'top1') {
                      const d = await api(`/dispatch/tasks/${assignMode.id}/dispatch`, { method: 'POST', body: JSON.stringify({ channel: '指派' }) });
                      setMsg({ ok: true, text: `已指派 ${d.company ?? ''}（${d.orderNo ?? ''}）` });
                    } else if (opt.act === 'inquiry') {
                      const d = await api(`/dispatch/tasks/${assignMode.id}/dispatch`, { method: 'POST', body: JSON.stringify({ channel: '询价' }) });
                      setMsg({ ok: true, text: `竞价已发起：主单 ${d.orderNo ?? ''}${(d.inquiries ?? []).length ? '，询价 ' + d.inquiries.length + ' 家' : ''}` });
                    } else {
                      await api(`/dispatch/tasks/${assignMode.id}/pool`, { method: 'POST', body: JSON.stringify({}) });
                      setMsg({ ok: true, text: '已挂入任务池，等待公司抢单' });
                    }
                    setAssignMode(null);
                    await openTask(assignMode.id);
                  } catch (e) { setMsg({ ok: false, text: e.message }); }
                }} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '10px 12px', marginBottom: 8, cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>{opt.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2 }}>{opt.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 直控参数包核验与上注确认弹窗（上注前人工逐项核验——遥控作业规范） */}
      {uplinkVerify && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setUplinkVerify(null); }}>
          <div className="modal" style={{ width: 520 }}>
            <div className="modal-header">直控参数包核验 · {uplinkVerify.satName}
              <button className="close-btn" style={{ marginLeft: 'auto' }} onClick={() => setUplinkVerify(null)}>✕</button>
            </div>
            <div className="modal-body">
              {(() => {
                const pack = uplinkVerify.paramPack ? JSON.parse(uplinkVerify.paramPack) : null;
                if (!pack) return <div style={{ fontSize: 12, color: 'var(--danger)' }}>参数包未生成，请先点击「计算直控参数包」。</div>;
                return (<>
                  <div style={{ fontSize: 12, lineHeight: 2, color: 'var(--text-main)' }}>
                    <div>目标：{uplinkVerify.taskName || '—'}</div>
                    <div>卫星：{pack.satName} (NORAD {pack.satNoradId}) ｜ 上注站：{pack.groundStation}</div>
                    <div>成像窗：{pack.window.start?.slice(5, 19)} ~ {pack.window.end?.slice(5, 19)} UTC</div>
                    <div>最近过顶（TCA）：{pack.tca?.slice(5, 19)} UTC ｜ 侧摆 {pack.slewDeg}°</div>
                    <div>上注弧段：{pack.uplinkPass
                      ? `${pack.uplinkPass.station} ${pack.uplinkPass.arcStart?.slice(5, 19)} ~ ${pack.uplinkPass.arcEnd?.slice(5, 19)} UTC（最大仰角 ${pack.uplinkPass.maxElDeg}°，弧段 ${pack.uplinkPass.arcDurationSec}s）`
                      : <span style={{ color: 'var(--danger)' }}>无可用上注弧段（成像前该星未过国内测控站），不能上注</span>}</div>
                    <div>指令序列开始：{pack.sequenceStart?.slice(11, 19)} UTC（TCA 前 {(() => {
                      const d = (new Date(pack.tca) - new Date(pack.sequenceStart)) / 1000; return Math.round(d);
                    })()}s）</div>
                    {(() => {
                      const img = pack.commands.find(c => c.action === '成像');
                      const ip = img?.param ?? {};
                      return (
                        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', margin: '6px 0' }}>
                          成像参数：{ip.imagingMode} ｜ TDI {ip.tdiStages} 级（{ip.tdiSource?.startsWith('real') ? '文献值' : '典型值'}）｜ 积分 {ip.integrationMs} ms（像移 {ip.imageMotionVelKmS} km/s 匹配）｜ 增益 {ip.gain} ｜ 量化 {ip.quantBits}bit
                          <br/>压缩 {ip.compression}:1 {ip.compressionMode} ｜ 条带方向：{pack.stripDirection} ｜ 数传窗口：{pack.downlinkPass
                            ? `${pack.downlinkPass.station} ${pack.downlinkPass.arcStart?.slice(11, 19)} UTC（maxEl ${pack.downlinkPass.maxElDeg}°）`
                            : '待下一圈过站下传'}
                          <br/>载荷：{pack.payloadSpec?.camera}（幅宽 {pack.payloadSpec?.swathKm}km，侧摆 {pack.payloadSpec?.slewMax}°）｜ 本次成像数据量估算 {ip.estDataMB} MB（{ip.estDataRows} 行）
                          {pack.uplinkBudget && (
                            <><br/>上注预算：弧段 {pack.uplinkBudget.budgetKB} KB ｜ 指令需 {pack.uplinkBudget.needKB} KB（压缩上注 23B/条）｜ {pack.uplinkBudget.fits ? '✅ 弧段容量足够' : '❌ 超出弧段容量'}</>
                          )}
                        </div>
                      );
                    })()}
                    <div>指令序列（{pack.commands.length} 条）：</div>
                    <table className="mission-table" style={{ fontSize: 10.5, margin: '4px 0 8px' }}>
                      <thead><tr><th>#</th><th>动作</th><th>偏移</th><th>时长</th></tr></thead>
                      <tbody>
                        {pack.commands.map(c => (
                          <tr key={c.seq}><td>{c.seq}</td><td>{c.action}</td>
                            <td style={{ fontFamily: 'var(--font-mono)' }}>{c.startOffset}s</td>
                            <td style={{ fontFamily: 'var(--font-mono)' }}>{c.duration}s</td></tr>
                        ))}
                      </tbody>
                    </table>
                    {(() => {
                      const v = uplinkVerify.validation ? JSON.parse(uplinkVerify.validation) : null;
                      return v ? <div style={{ fontSize: 11.5, color: v.pass ? 'var(--accent)' : 'var(--danger)', marginBottom: 8 }}>
                        独立校验：{v.pass ? '✅ 通过' : '❌ ' + v.errors.join('；')}</div> : null;
                    })()}
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, margin: '8px 0 6px' }}>上注前核验（逐项确认）</div>
                  {['windowOk', 'tcaAligned', 'commandsValid', 'satArcOk'].map(k => {
                    const label = { windowOk: '成像时窗正确（与任务要求一致）', tcaAligned: '指向对准（成像中点已对准最近过顶点）',
                      commandsValid: '指令校验通过（时序/固存/参数合规）',
                      satArcOk: (() => {
                        const pack = uplinkVerify.paramPack ? JSON.parse(uplinkVerify.paramPack) : null;
                        const up = pack?.uplinkPass;
                        return up ? `上注弧段正确（${up.station} ${up.arcStart?.slice(11, 19)}~${up.arcEnd?.slice(11, 19)} UTC，最大仰角 ${up.maxElDeg}°）`
                          : '上注弧段确认（无可用弧段时此项不可勾选）';
                      })() }[k];
                    return (
                      <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, margin: '4px 0', cursor: 'pointer' }}>
                        <input type="checkbox" checked={uplinkChecklist[k] ?? false}
                          onChange={e => setUplinkChecklist({ ...uplinkChecklist, [k]: e.target.checked })} />
                        {label}
                      </label>
                    );
                  })}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
                    <button className="btn secondary" onClick={() => { setUplinkVerify(null); setUplinkChecklist({}); }}>取消</button>
                    <button className="btn danger" disabled={!['windowOk', 'tcaAligned', 'commandsValid', 'satArcOk'].every(k => uplinkChecklist[k])}
                      onClick={async () => {
                        try {
                          await api(`/dispatch/plans/${uplinkVerify.id}/confirm`, { method: 'POST', body: JSON.stringify({ stage: '上注', checklist: uplinkChecklist }) });
                          setMsg({ ok: true, text: '上注完成，卫星进入直控执行' });
                          setUplinkVerify(null); setUplinkChecklist({});
                          await load();
                        } catch (e) { setMsg({ ok: false, text: e.message }); }
                      }}>确认下发上注</button>
                  </div>
                </>);
              })()}
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗（自定义，不用原生 confirm——嵌入环境会被静默拦截） */}
      {deleteConfirm && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setDeleteConfirm(null); }}>
          <div className="modal" style={{ width: 360 }}>
            <div className="modal-header">删除任务单
              <button className="close-btn" style={{ marginLeft: 'auto' }} onClick={() => setDeleteConfirm(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 13, lineHeight: 1.9, color: 'var(--text-main)' }}>
                确认删除任务 <b style={{ color: 'var(--text-bright)', fontFamily: 'var(--font-mono)' }}>{deleteConfirm.taskNo}</b>
                <span style={{ marginLeft: 6 }}>「{deleteConfirm.taskName}」</span>？
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-dim)' }}>
                  将同时删除其候选卫星、排序清单与关联订单，此操作不可恢复。
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button className="btn secondary" onClick={() => setDeleteConfirm(null)}>取消</button>
                <button className="btn danger" onClick={async () => {
                  const id = deleteConfirm.id;
                  setDeleteConfirm(null);
                  await deleteTask(id);
                }}>确认删除</button>
              </div>
            </div>
          </div>
        </div>
      )}


    </div>
  );
}

// ─── 任务管理 Tab ─────────────────────────────────────────────────────────
function TasksTab({ tasks, selected, openTask, runCandidates, doDispatch, busy, advanceOrder, deleteTask, onRequestDelete, setAssignMode }) {
  return (
    <div style={{ display: 'flex', gap: 14 }}>
      {/* 任务列表 */}
      <div style={{ flex: selected ? '0 0 46%' : 1 }}>
        <table className="mission-table">
          <thead><tr><th>任务编号</th><th>任务名称</th><th>类型</th><th>分辨率</th><th>优先级</th><th>状态</th><th>来源</th><th>操作</th></tr></thead>
          <tbody>
            {tasks.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 20 }}>暂无任务，点击右上角「新建任务」创建</td></tr>}
            {tasks.map(t => (
              <tr key={t.id} onClick={() => openTask(t.id)} style={{ background: selected?.id === t.id ? 'rgba(45,212,167,0.08)' : undefined }}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{t.taskNo}</td>
                <td style={{ color: 'var(--text-bright)' }}>
                  {t.taskName}
                  {t.source === '对话下单' && <span title="由 AI 下单助手创建" style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent)' }}>🤖 AI</span>}
                </td>
                <td>{t.obsType === 'sar' ? 'SAR' : t.obsType === 'video' ? '视频' : '光学'}</td>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{t.resolution}m</td>
                <td className={`priority-${t.priority === '应急' ? 'critical' : t.priority === '重点' ? 'high' : 'medium'}`}>{t.priority}</td>
                <td><span className="status-pill" style={{ background: (TASK_STATUS_COLOR[t.status] ?? '#888') + '22', color: TASK_STATUS_COLOR[t.status] ?? '#888' }}>{t.status}</span></td>
                <td style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{t.source === '对话下单' ? 'AI下单' : t.source === '手工录入' ? '手工' : t.source}</td>
                <td style={{ display: 'flex', gap: 4 }}>
                  <button className="btn secondary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={e => { e.stopPropagation(); openTask(t.id); }}>详情</button>
                  {['待派单', '挂任务池'].includes(t.status) && (
                    <button className="btn danger" style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={e => { e.stopPropagation(); onRequestDelete(t); }}>删除</button>
                  )}
                </td>
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
            <div className="kv"><div className="k">任务名称</div><div className="v">{selected.targetName}</div></div>
            <div className="kv"><div className="k">观测类型</div><div className="v">{selected.obsType === 'sar' ? 'SAR' : '光学'}</div></div>
            <div className="kv"><div className="k">分辨率要求</div><div className="v">{selected.resolution} m</div></div>
            <div className="kv"><div className="k">最大云量</div><div className="v">{(selected.maxCloud * 100).toFixed(0)}%</div></div>
            <div className="kv"><div className="k">时间窗</div><div className="v" style={{ fontSize: 10.5 }}>{selected.windowStart?.slice(5, 16)} ~ {selected.windowEnd?.slice(5, 16)}</div></div>
            <div className="kv"><div className="k">时效要求</div><div className="v">{selected.timelinessHours ? `${selected.timelinessHours}h` : '—'}</div></div>
          </div>

          {/* 目标 AOI：解算出的实际拍摄坐标/区域（给公司执行的依据） */}
          {(() => {
            const g = selected.geom ? (typeof selected.geom === 'string' ? JSON.parse(selected.geom) : selected.geom) : null;
            const topRank = selected.rankings?.[0];
            return (
              <div style={{ margin: '10px 0', padding: '8px 12px', borderRadius: 4, background: 'rgba(45,212,167,0.05)', border: '1px solid rgba(45,212,167,0.25)' }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--accent)', marginBottom: 4 }}>成像目标 AOI（解算值）</div>
                <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-bright)' }}>
                  {g?.lat != null
                    ? `点目标 ${Number(g.lat).toFixed(4)}°, ${Number(g.lon).toFixed(4)}°`
                    : g?.coords ? `面目标 ${g.coords.length} 个顶点多条带` : '—'}
                </div>
                {topRank?.imgWinStart && (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                    首选过顶：{topRank.overpassTime?.slice(5, 19)} UTC ｜ 最近距离 {topRank.minDistKm?.toFixed(1)} km ｜ 覆盖窗 {topRank.imgWinStart?.slice(11, 19)}~{topRank.imgWinEnd?.slice(11, 19)}
                  </div>
                )}
              </div>
            );
          })()}

          {selected.pendingConfirm === 1 && (
            <div style={{ margin: '12px 0', padding: '10px 12px', borderRadius: 4, fontSize: 12.5,
              background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.4)', color: 'var(--text-bright)' }}>
              ⚠ 该任务由 AI 创建，尚未人工确认下发。请核对下方目标 AOI 与任务要素后确认。
              <div style={{ marginTop: 8 }}>
                <button className="btn" disabled={busy} onClick={async () => {
                  try {
                    await api(`/dispatch/tasks/${selected.id}/confirm`, { method: 'POST', body: JSON.stringify({}) });
                    setMsg({ ok: true, text: '已确认下发，进入派单分流' });
                    await openTask(selected.id);
                  } catch (e) { setMsg({ ok: false, text: e.message }); }
                }}>确认下发</button>
              </div>
            </div>
          )}
          {/* 执行链路指引（状态驱动）：让 AI 下单与工作台操作无缝衔接 */}
          {selected.source === '对话下单' && (
            <div style={{ margin: '8px 0 12px', padding: '8px 12px', borderRadius: 4, fontSize: 12,
              background: 'rgba(45,212,167,0.08)', border: '1px solid rgba(45,212,167,0.3)', color: 'var(--text-dim)' }}>
              🤖 本任务由 AI 下单助手创建。
              {selected.status === '待派单' && !selected.rankings?.length && <span> 下一步：点击上方 <b style={{color:'var(--accent)'}}>① 候选计算</b>，再 <b style={{color:'var(--accent)'}}>② 派单分流</b>（也可回 AI 助手说"继续"让它驱动）。</span>}
              {selected.status === '待派单' && selected.rankings?.length && <span> 候选已就绪，下一步：<b style={{color:'var(--accent)'}}>② 派单分流</b>。</span>}
              {(selected.status === '已派发' || selected.status === '已接单' || selected.status === '执行中') && <span> 已进入订单执行，进度在 <b style={{color:'var(--accent)'}}>「订单跟踪」</b>Tab 管理或在下方"关联订单"推进。</span>}
              {(selected.status === '已验收' || selected.status === '已失败') && <span> 本任务已结束，可在「订单跟踪」查看履约记录。</span>}
            </div>
          )}

          {/* 排序清单 */}
          {selected.rankings?.length > 0 && (
            <>
              <div className="section-label">候选卫星优先级排序</div>
              <table className="mission-table" style={{ fontSize: 11.5 }}>
                <thead><tr><th>#</th><th>卫星</th><th>公司</th><th>过顶时刻</th><th>侧摆</th><th>云量</th><th>可用度</th><th>优先级评分</th></tr></thead>
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
                      <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 600 }}>{Number(r.S).toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* 任务包：确认下发后出现，通道由人工选择——派给公司 或 生成直控任务指令 */}
          {selected.pendingConfirm !== 1 && (
            <div style={{ margin: '10px 0', padding: '10px 12px', borderRadius: 4, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6 }}>任务包</div>
              {selected.orders?.length > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 6 }}>
                  公司执行包已生成：{selected.orders.map(o => `${o.orderNo}（${o.company} · ${o.channel}）`).join('、')}，要素含目标 AOI/时窗/分辨率/云量，见订单跟踪 Tab。
                </div>
              )}
              {selected.status === '待派单' && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" style={{ padding: '3px 12px', fontSize: 11.5 }} disabled={busy}
                    onClick={async () => {
                      try {
                        if (!selected.rankings?.length) await runCandidates(selected.id);
                        setAssignMode(selected);   // 打开"派给公司"方式选择弹窗
                      } catch (e) { setMsg({ ok: false, text: e.message }); }
                    }}>派给公司</button>
                  <button className="btn danger" style={{ padding: '3px 12px', fontSize: 11.5 }} disabled={busy}
                    onClick={async () => {
                      try {
                        if (!selected.rankings?.length) await runCandidates(selected.id);
                        const d = await api(`/dispatch/tasks/${selected.id}/dispatch`, { method: 'POST', body: JSON.stringify({ channel: '直控' }) });
                        setMsg({ ok: true, text: '直控方案已建立，在下方「直控执行方案」生成参数包并核验上注' });
                        setTab('plans');
                        await openTask(selected.id);
                      } catch (e) { setMsg({ ok: false, text: e.message }); }
                    }}>生成直控任务指令</button>
                </div>
              )}
              {selected.status === '直控执行中' && (
                <button className="btn secondary" style={{ padding: '3px 12px', fontSize: 11.5 }}
                  onClick={() => setTab('plans')}>查看直控参数包 →</button>
              )}
            </div>
          )}

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
function PlansTab({ plans, planAction, busy, setUplinkVerify }) {
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
            <button className="btn secondary" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }} onClick={() => planAction(p.id, 'generate')}>
              {p.status === '待确认' ? '① 计算直控参数包' : '重算参数包'}
            </button>
            {p.status === '待核验下发' && <button className="btn secondary" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }} onClick={() => planAction(p.id, '方案')}>② 方案确认（值班）</button>}
            {p.status === '方案已确认' && <button className="btn" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }}
              onClick={() => setUplinkVerify(p)}>③ 核验参数包 → 确认上注</button>}
            {p.status === '执行中' && <button className="btn" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }} onClick={() => planAction(p.id, 'complete')}>④ 执行完成回写</button>}
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

