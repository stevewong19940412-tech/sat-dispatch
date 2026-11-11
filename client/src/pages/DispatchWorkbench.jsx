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
  // 上注确认弹窗内的错误提示（弹窗遮罩 z-index 200 盖住页面级 msg 条，错误必须就地展示）
  const [uplinkErr, setUplinkErr] = useState(null);
  // 直控参数包查看抽屉（解算通过后即可查看完整参数包，不等上注核验）
  const [packDrawerId, setPackDrawerId] = useState(null);

  const load = useCallback(async () => {
    // 并行拉取（原来是 5 个串行 await，最慢者拖累全部）
    const [t, o, p, c, pl] = await Promise.all([
      api('/dispatch/tasks').catch(() => []),
      api('/dispatch/orders').catch(() => []),
      api('/dispatch/plans').catch(() => []),
      api('/dispatch/companies').catch(() => []),
      api('/dispatch/pool').catch(() => []),
    ]);
    // 浅比较后再 setState：数据未变不重渲染（消除轮询导致的整表卡顿）
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    setTasks(prev => same(prev, t) ? prev : t);
    setOrders(prev => same(prev, o) ? prev : o);
    setPlans(prev => same(prev, p) ? prev : p);
    setCompanies(prev => same(prev, c) ? prev : c);
    setPool(prev => same(prev, pl) ? prev : pl);
  }, []);

  // 全局事件委托兜底：任务包按钮点击（绕过 React 合成事件在特定环境的兼容问题）
  useEffect(() => {
    const h = async (e) => {
      // Tab 切换（data-tab）——与业务按钮同一委托通道
      const tabBtn = e.target.closest?.('button[data-tab]');
      if (tabBtn) { setTab(tabBtn.dataset.tab); return; }
      const btn = e.target.closest?.('button[data-action]');
      if (!btn || btn.disabled) return;
      const { action, taskId } = btn.dataset;
      const t = tasks.find(x => x.id === +taskId);
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      try {
        if (t.pendingConfirm === 1) await api(`/dispatch/tasks/${t.id}/confirm`, { method: 'POST', body: JSON.stringify({}) });
        if (action === 'assign-open') { setAssignMode(t); return; }
        if (!t.rankings?.length) await runCandidates(t.id);
        const fresh = await api(`/dispatch/tasks/${t.id}`);
        if (!fresh.rankings?.length) { setMsg({ ok: false, text: '该任务候选为 0（分辨率/云量/光照无满足者），无法派单' }); return; }
        const channel = action === 'assign-top1' ? '指派' : action === 'assign-inquiry' ? '询价' : action === 'assign-pool' ? '抢单' : '直控';
        const d = await api(`/dispatch/tasks/${t.id}/dispatch`, { method: 'POST', body: JSON.stringify({ channel }) });
        if (action === 'direct') {
          setMsg({ ok: true, text: '✅ 直控方案已建立，正在打开参数包…' });
          setTab('plans');
        } else {
          setMsg({ ok: true, text: `已派给公司：主单 ${d.orderNo ?? ''}${(d.inquiries ?? []).length ? '，询价 ' + d.inquiries.length + ' 家' : ''}` });
        }
        await load(); await openTask(t.id);
      } catch (e2) { setMsg({ ok: false, text: e2.message }); }
    };
    document.addEventListener('click', h, true);
    return () => document.removeEventListener('click', h, true);
  }, [tasks]);
  useEffect(() => {
    load();
    // 轮询节流：弹窗打开或鼠标悬停在可点击元素上时跳过本轮刷新，
    // 防止 15s 轮询重渲染与用户点击竞争（点击被吞/按钮 ref 失效——AI 面板打不开的根因）
    const t = setInterval(() => {
      const interacting = document.querySelector('.modal-overlay') ||
        document.querySelector('button:hover') || document.querySelector('div[style*="cursor: pointer"]:hover');
      if (!interacting) load();
    }, 30000);
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
        const errMsg = (r.validation.errors ?? []).map(e => typeof e === 'object' ? (e.detail?.conclusion || e.msg) : e).join('；');
        setMsg({ ok: r.validation.pass, text: r.validation.pass
          ? `✅ 参数包已生成并通过校验（${r.commands.length} 条动作，总时长 ${r.validation.totalDuration}s）——下方方案卡片状态已更新为「待核验下发」，可点「查看直控参数包」`
          : `❌ 校验驳回：${errMsg}` });
        await load();
      } else if (action === 'reassign') {
        const r = await api(`/dispatch/plans/${planId}/reassign`, { method: 'POST', body: JSON.stringify({ force: false }) });
        setMsg({ ok: true, text: `🔄 已换星：${r.from} → ${r.to}（候选顺位 ${r.rankPos}/${r.totalRanked}${r.imgWinCovered ? '，幅宽可覆盖' : '，注意：该候选幅宽也罩不住目标'}），正在自动重新解算…` });
        await load();
        await planAction(planId, 'generate');
        return;
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

      {/* Tab（顶栏 fixed 不占文档流， paddingTop 避开避免被统计条遮挡） */}
      <div style={{ display: 'flex', gap: 4, padding: '56px 16px 0' }}>
        {[['tasks', '任务管理'], ['orders', '订单跟踪'], ['plans', '应急直控'], ['pool', '任务池'], ['companies', '公司生态']].map(([k, label]) => (
          <button key={k} data-tab={k} style={{ background: 'transparent', border: 'none', color: 'inherit', font: 'inherit', padding: 0, cursor: 'pointer' }}
            style={{
              padding: '7px 18px', cursor: 'pointer', fontSize: 13,
              borderBottom: tab === k ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === k ? 'var(--accent)' : 'var(--text-dim)',
            }}>{label}</button>
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
          runCandidates={runCandidates} doDispatch={doDispatch} busy={busy} advanceOrder={advanceOrder} deleteTask={deleteTask} onRequestDelete={(t) => setDeleteConfirm(t)} setAssignMode={setAssignMode} setMsg={setMsg} setTab={setTab} load={load} planAction={planAction} />}
        {tab === 'orders' && <OrdersTab orders={orders} advanceOrder={advanceOrder} />}
        {tab === 'plans' && <PlansTab plans={plans} planAction={planAction} busy={busy} setUplinkVerify={setUplinkVerify} setPackDrawerId={setPackDrawerId} setUplinkErr={setUplinkErr} />}
        {tab === 'plans' && <PlanPackDrawer plan={plans.find(x => x.id === packDrawerId)} onClose={() => setPackDrawerId(null)} />}
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
                <button key={opt.key} onClick={async () => {
                  try {
                    if (assignMode.pendingConfirm === 1) await api(`/dispatch/tasks/${assignMode.id}/confirm`, { method: 'POST', body: JSON.stringify({}) });
                    if ((assignMode.rankings ?? []).length === 0) {
                      setMsg({ ok: true, text: '该任务候选为 0，正在后台计算候选（约30秒）…' });
                      setAssignMode(null);
                      runCandidates(assignMode.id).then(() =>
                        setMsg({ ok: true, text: '候选计算完成，请重新点「派给公司」选择派单方式' }));
                      return;
                    }
                    setMsg({ ok: true, text: '正在' + (opt.act === 'top1' ? '指派' : opt.act === 'inquiry' ? '发起竞价' : '挂入任务池') + '…' });
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
                }} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '10px 12px', marginBottom: 8, cursor: 'pointer', width: '100%', textAlign: 'left', background: 'transparent', color: 'inherit' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-bright)' }}>{opt.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2 }}>{opt.desc}</div>
                </button>
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
                      const img = (Array.isArray(pack.commands) ? pack.commands : []).find(c => c.action === '成像');
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
                        {(Array.isArray(pack.commands) ? pack.commands : []).map(c => (
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
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14, alignItems: 'center' }}>
                    {uplinkErr && <span style={{ fontSize: 11.5, color: 'var(--danger)', marginRight: 'auto' }}>❌ {uplinkErr}</span>}
                    <button className="btn secondary" onClick={() => { setUplinkVerify(null); setUplinkChecklist({}); }}>取消</button>
                    <button className="btn danger" disabled={!['windowOk', 'tcaAligned', 'commandsValid', 'satArcOk'].every(k => uplinkChecklist[k])}
                      onClick={async () => {
                        try {
                          await api(`/dispatch/plans/${uplinkVerify.id}/confirm`, { method: 'POST', body: JSON.stringify({ stage: '上注', checklist: uplinkChecklist }) });
                          setMsg({ ok: true, text: '上注完成，卫星进入直控执行' });
                          setUplinkVerify(null); setUplinkChecklist({});
                          await load();
                        } catch (e) { setUplinkErr(e.message); }
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
function TasksTab({ tasks, selected, openTask, runCandidates, doDispatch, busy, advanceOrder, deleteTask, onRequestDelete, setAssignMode, setMsg, setTab, load, planAction }) {
  return (
    <div style={{ display: 'flex', gap: 14 }}>
      {/* 任务列表 */}
      <div style={{ flex: selected ? '0 0 46%' : 1 }}>
        <table className="mission-table">
          <thead><tr><th>任务编号</th><th>任务名称</th><th>类型</th><th>分辨率</th><th>优先级</th><th>状态</th><th>来源</th><th>操作</th></tr></thead>
          <tbody>
            {tasks.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 20 }}>暂无任务，点击右上角「新建任务」创建</td></tr>}
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
        <div style={{ flex: 1, border: '1px solid var(--border-bright)', borderRadius: 6, padding: 16, alignSelf: 'flex-start', position: 'sticky', top: 0, maxHeight: 'calc(100vh - 60px)', overflowY: 'auto' }}>
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
                    ? `点目标 ${Number(g.lat).toFixed(4)}°, ${Number(g.lon).toFixed(4)}°（单景覆盖）`
                    : g?.coords ? (() => {
                        const lats = g.coords.map(c=>c[0]); const lons = g.coords.map(c=>c[1]);
                        const dLatKm = (Math.max(...lats)-Math.min(...lats)) * 111;
                        const dLonKm = (Math.max(...lons)-Math.min(...lons)) * 111 * Math.cos(g.coords[0][0]*Math.PI/180);
                        return `面目标 ${g.coords.length} 顶点（约 ${dLatKm.toFixed(0)}km × ${dLonKm.toFixed(0)}km），将拆 ${Math.ceil(Math.max(dLatKm,dLonKm)/12)} 条带覆盖`;
                      })() : '—'}
                </div>
                {topRank?.imgWinStart && (
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                    首选过顶：{topRank.overpassTime?.slice(5, 19)} UTC ｜ 最近距离 {topRank.minDistKm?.toFixed(1)} km ｜ 覆盖窗 {topRank.imgWinStart?.slice(11, 19)}~{topRank.imgWinEnd?.slice(11, 19)}
                  </div>
                )}
              </div>
            );
          })()}


          {/* 执行链路指引（状态驱动）：让 AI 下单与工作台操作无缝衔接 */}

          {/* 排序清单 */}
          {selected.rankings?.length > 0 && (
            <>
              <div className="section-label">候选卫星优先级排序</div>
              <table className="mission-table" style={{ fontSize: 11.5 }}>
                <thead><tr><th>#</th><th>卫星</th><th>公司</th><th>过顶时刻</th><th>侧摆</th><th>云量</th><th>太阳角</th><th>可用度</th><th>优先级评分</th></tr></thead>
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
                      <td style={{ fontFamily: 'var(--font-mono)', color: (r.sunElDeg ?? 40) >= 10 ? 'var(--text-dim)' : 'var(--danger)' }}
                        title={(r.sunElDeg ?? 40) >= 10 ? '光照满足（≥10°）' : '光照不足'}>
                        {r.sunElDeg != null ? `${r.sunElDeg.toFixed(0)}°` : '—'}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{r.availability}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 600 }}>{Number(r.S).toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* 任务包：始终显示（含待确认任务）——通道由人工选择，选择时自动完成确认 */}
          {(
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
                    data-action="direct" data-task-id={selected.id}>{busy ? '执行中…' : '生成直控任务指令'}</button>
                </div>
              )}
              {(selected.directPlans?.length ?? 0) > 0 && (
                <button className="btn secondary" style={{ padding: '3px 12px', fontSize: 11.5 }}
                  onClick={() => { setTab('plans'); setMsg({ ok: true, text: '直控方案见「直控方案」Tab' }); }}>查看直控参数包 →</button>
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
function PlansTab({ plans, planAction, busy, setUplinkVerify, setPackDrawerId, setUplinkErr }) {
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
              {(Array.isArray(p.commands) ? p.commands : []).map(c => (
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
          {/* 校验结果：驳回时逐条展开原因+数值诊断；通过时给参数包查看入口 */}
          {(() => {
            const v = typeof p.validation === 'string' ? (() => { try { return JSON.parse(p.validation); } catch { return null; } })() : p.validation;
            if (!v || !v.errors) return null;
            return (
            <div style={{ fontSize: 11.5, marginBottom: 8, color: v.pass ? 'var(--accent)' : 'var(--danger)' }}>
              独立校验：{v.pass
                ? `✅ 通过（总时长 ${v.totalDuration}s，开关机/间隔/固存/参数 全部合规）`
                : `❌ ${(v.errors ?? []).map(e => typeof e === 'object' ? e.msg : e).join('；') || '校验未通过（无明细）'}`}
              {v.pass && p.paramPack && (
                <button className="btn secondary" data-action="view-pack" data-plan-id={p.id}
                  style={{ padding: '2px 10px', fontSize: 11, marginLeft: 10 }}
                  onClick={() => setPackDrawerId(p.id)}>📄 查看直控参数包</button>
              )}
            </div>
            );
          })()}
          {p.status === '校验驳回' && (() => {
            const v = typeof p.validation === 'string' ? (() => { try { return JSON.parse(p.validation); } catch { return null; } })() : p.validation;
            const detailed = (v?.errors ?? []).filter(e => typeof e === 'object' && e?.detail);
            return (
            <div style={{ fontSize: 11.5, marginBottom: 8, padding: '8px 12px', borderRadius: 4, background: 'rgba(244,82,94,0.06)', border: '1px solid rgba(244,82,94,0.3)' }}>
              {detailed.map((e, i) => {
                const d = e.detail;
                return (
                  <div key={i} style={{ marginBottom: detailed.length > 1 && i < detailed.length - 1 ? 10 : 0 }}>
                    <div style={{ fontWeight: 600, color: 'var(--danger)' }}>❌ {e.msg}</div>
                    <table className="mission-table" style={{ fontSize: 10.5, margin: '6px 0', maxWidth: 480 }}>
                      <tbody>
                        <tr><td style={{ color: 'var(--text-dim)' }}>卫星幅宽</td><td style={{ fontFamily: 'var(--font-mono)' }}>{d.swathKm} km（半宽 {d.halfKm} km）</td></tr>
                        {d.minDistKm != null && <tr><td style={{ color: 'var(--text-dim)' }}>过境最近距离</td><td style={{ fontFamily: 'var(--font-mono)' }}>{Math.round(d.minDistKm * 10) / 10} km</td></tr>}
                        {d.overByKm != null && <tr><td style={{ color: 'var(--danger)', fontWeight: 600 }}>差多少才够拍</td><td style={{ fontFamily: 'var(--font-mono)', color: 'var(--danger)' }}>超出 {d.overByKm} km</td></tr>}
                        {d.slewDeg != null && <tr><td style={{ color: 'var(--text-dim)' }}>TCA 侧摆角</td><td style={{ fontFamily: 'var(--font-mono)' }}>{Math.round(d.slewDeg * 10) / 10}°</td></tr>}
                        {d.actualAltKm != null && <tr><td style={{ color: 'var(--text-dim)' }}>轨道高度</td><td style={{ fontFamily: 'var(--font-mono)' }}>{Math.round(d.actualAltKm)} km</td></tr>}
                      </tbody>
                    </table>
                    <div style={{ color: 'var(--text-main)', fontSize: 11 }}>{d.conclusion}</div>
                    <div style={{ color: 'var(--warn)', fontSize: 11, marginTop: 2 }}>建议：{d.advice}</div>
                  </div>
                );
              })}
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
                <span style={{ color: 'var(--text-dim)' }}>此候选物理上拍不到时，可切换任务候选排序中的下一颗卫星重新解算，无需重新派单：</span>
                <button className="btn secondary" disabled={busy} data-action="reassign-sat" data-plan-id={p.id}
                  style={{ padding: '2px 10px', fontSize: 11, marginLeft: 10 }}
                  onClick={() => planAction(p.id, 'reassign')}>
                  {busy ? '⏳ 换星解算中…' : '🔄 换一颗候选卫星解算'}
                </button>
              </div>
            </div>
            );
          })()}
          {/* 弧段 */}
          {(() => {
            if (!p.arcInfo) return null;
            try {
              const a = typeof p.arcInfo === 'string' ? JSON.parse(p.arcInfo) : p.arcInfo;
              return (
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 8 }}>
                测控弧段：{a.station} {a.arcStart?.slice(11, 16)} ~ {a.arcEnd?.slice(11, 16)} UTC
              </div>
              );
            } catch { return null; }
          })()}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn secondary" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }} onClick={() => planAction(p.id, 'generate')}>
              {busy ? '⏳ 解算中（约10~30秒）…' : p.status === '待确认' ? '① 计算直控参数包' : '重算参数包'}
            </button>
            {p.status === '待核验下发' && <button className="btn secondary" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }} onClick={() => planAction(p.id, '方案')}>② 方案确认（值班）</button>}
            {['待核验下发', '方案已确认'].includes(p.status) && p.paramPack && <button className="btn secondary" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }} onClick={() => setPackDrawerId(p.id)} data-action="view-pack" data-plan-id={p.id}>📄 查看直控参数包</button>}
            {p.status === '方案已确认' && <button className="btn" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }}
              onClick={() => { setUplinkErr(null); setUplinkVerify(p); }}>③ 核验并确认上注</button>}
            {p.status === '执行中' && <button className="btn" disabled={busy} style={{ padding: '3px 12px', fontSize: 11.5 }} onClick={() => planAction(p.id, 'complete')}>④ 执行完成回写</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── 直控参数包查看抽屉（解算通过后的最终产物，独立于上注核验弹窗） ──────
function PlanPackDrawer({ plan, onClose }) {
  if (!plan) return null;
  let pack = null, v = null;
  try { pack = plan.paramPack ? JSON.parse(plan.paramPack) : null; } catch {}
  try { v = plan.validation ? JSON.parse(plan.validation) : null; } catch {}
  const commands = Array.isArray(pack?.commands) ? pack.commands : [];
  const img = commands.find(c => c.action === '成像');
  const ip = img?.param ?? {};
  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 560, maxHeight: '86vh', overflowY: 'auto' }}>
        <div className="modal-header">直控参数包 · {plan.satName}
          <span className="status-pill" style={{ background: 'rgba(45,212,167,0.15)', color: 'var(--accent)', marginLeft: 10 }}>解算通过 · 待上注</span>
          <button className="close-btn" style={{ marginLeft: 'auto' }} onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ fontSize: 12, lineHeight: 1.9 }}>
          {!pack ? <div style={{ color: 'var(--danger)' }}>参数包未生成，请先解算。</div> : (<>
            {/* 一、任务与卫星标识 */}
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', margin: '4px 0' }}>① 任务与卫星</div>
            <table className="mission-table" style={{ fontSize: 11 }}>
              <tbody>
                <tr><td style={{ width: 110, color: 'var(--text-dim)' }}>目标</td><td>{plan.taskName || pack.target?.name || '—'}（{pack.target?.lat?.toFixed?.(4) ?? '—'}, {pack.target?.lon?.toFixed?.(4) ?? '—'}）</td></tr>
                <tr><td style={{ color: 'var(--text-dim)' }}>执行卫星</td><td>{pack.satName}（NORAD {pack.satNoradId}）· {plan.company}</td></tr>
                <tr><td style={{ color: 'var(--text-dim)' }}>载荷</td><td>{pack.payloadSpec?.camera}（幅宽 {pack.payloadSpec?.swathKm}km / 侧摆上限 {pack.payloadSpec?.slewMax}°）</td></tr>
              </tbody>
            </table>
            {/* 二、几何与时序 */}
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', margin: '10px 0 4px' }}>② 成像几何与时序</div>
            <table className="mission-table" style={{ fontSize: 11 }}>
              <tbody>
                <tr><td style={{ width: 110, color: 'var(--text-dim)' }}>成像时窗</td><td style={{ fontFamily: 'var(--font-mono)' }}>{pack.window.start?.slice(5, 19)} ~ {pack.window.end?.slice(5, 19)} UTC</td></tr>
                <tr><td style={{ color: 'var(--text-dim)' }}>最近过顶 TCA</td><td style={{ fontFamily: 'var(--font-mono)' }}>{pack.tca?.slice(5, 19)} UTC ｜ 侧摆 {pack.slewDeg}°</td></tr>
                <tr><td style={{ color: 'var(--text-dim)' }}>成像时段</td><td style={{ fontFamily: 'var(--font-mono)' }}>{pack.imagingStart?.slice(11, 19)} ~ {pack.imagingEnd?.slice(11, 19)} UTC（中点 {pack.imagingCenter?.slice(11, 19)}，已对准 TCA）</td></tr>
                <tr><td style={{ color: 'var(--text-dim)' }}>条带方向</td><td>{pack.stripDirection}</td></tr>
              </tbody>
            </table>
            {/* 三、成像参数 */}
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', margin: '10px 0 4px' }}>③ 成像参数</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-main)' }}>
              {ip.imagingMode} ｜ TDI {ip.tdiStages} 级（{ip.tdiSource?.startsWith('real') ? '文献值' : '典型值'}）｜ 积分 {ip.integrationMs} ms（像移 {ip.imageMotionVelKmS} km/s 匹配）｜ 增益 {ip.gain} ｜ 量化 {ip.quantBits}bit
               ｜ 压缩 {ip.compression}:1 {ip.compressionMode} ｜ 预计数据量 {ip.estDataMB} MB
            </div>
            {/* 四、指令序列 */}
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', margin: '10px 0 4px' }}>④ 指令序列（{commands.length} 条，总时长 {v?.totalDuration ?? '—'}s）</div>
            <table className="mission-table" style={{ fontSize: 10.5 }}>
              <thead><tr><th>#</th><th>动作</th><th>偏移</th><th>时长</th><th>关键参数</th></tr></thead>
              <tbody>
                {commands.map(c => (
                  <tr key={c.seq}><td>{c.seq}</td><td>{c.action}</td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{c.startOffset}s</td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{c.duration}s</td>
                    <td style={{ fontSize: 10, color: 'var(--text-dim)' }}>{c.action === '成像' ? `TDI ${c.param?.tdiStages} / 积分 ${c.param?.integrationMs}ms` : c.param ? Object.entries(c.param).slice(0,2).map(([k,val]) => `${k}=${val}`).join(' ') : '—'}</td></tr>
                ))}
              </tbody>
            </table>
            {/* 五、测控与数传弧段 */}
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', margin: '10px 0 4px' }}>⑤ 测控上注与数传</div>
            <table className="mission-table" style={{ fontSize: 11 }}>
              <tbody>
                <tr><td style={{ width: 110, color: 'var(--text-dim)' }}>上注弧段</td><td>{pack.uplinkPass
                  ? <>{pack.uplinkPass.station} {pack.uplinkPass.arcStart?.slice(5, 19)} ~ {pack.uplinkPass.arcEnd?.slice(5, 19)} UTC（maxEl {pack.uplinkPass.maxElDeg}°，{pack.uplinkPass.arcDurationSec}s）{pack.uplinkBudget && ` ｜ 容量预算 ${pack.uplinkBudget.fits ? '✅ 足够' : '❌ 超限'}`}</>
                  : <span style={{ color: 'var(--danger)' }}>无可用弧段</span>}</td></tr>
                <tr><td style={{ color: 'var(--text-dim)' }}>数传窗口</td><td>{pack.downlinkPass
                  ? `${pack.downlinkPass.station} ${pack.downlinkPass.arcStart?.slice(11, 19)} UTC（maxEl ${pack.downlinkPass.maxElDeg}°）`
                  : '待下一圈过站下传'}</td></tr>
              </tbody>
            </table>
            {/* 校验摘要 */}
            {v && <div style={{ fontSize: 11.5, marginTop: 10, color: v.pass ? 'var(--accent)' : 'var(--danger)' }}>
              独立校验：{v.pass ? `✅ 全部通过（总时长 ${v.totalDuration}s）` : '❌ ' + v.errors.map(e => typeof e === 'object' ? e.msg : e).join('；')}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="btn secondary" onClick={onClose}>关闭</button>
            </div>
          </>)}
        </div>
      </div>
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
      <thead><tr><th>公司</th><th>性质</th><th>简介</th><th title="按星座在轨规模估算的单月可接单景数量级（公开资料）">月接单容量*</th><th>已承接</th><th>承载余量</th><th>履约完成率</th><th>数据档位</th></tr></thead>
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

