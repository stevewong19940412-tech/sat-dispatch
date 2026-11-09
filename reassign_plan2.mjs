// 直控方案改派：删除旧方案（GAOFEN-13 01），按指定候选（GAOFEN-9 04, cand 608）重建方案，
// 卫星/窗口/公司/侧摆全部取自该候选记录，不手工填值。
import { db } from "./server/db.mjs";

const taskId = 8, oldPlanId = 2, candId = 608;
const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
const cand = db.prepare("SELECT * FROM candidates WHERE id=? AND taskId=? AND filtered=0").get(candId, taskId);
if (!cand) throw new Error("候选不存在或已被筛除");

const old = db.prepare("SELECT * FROM directPlans WHERE id=?").get(oldPlanId);
if (!old) throw new Error("旧方案不存在");
if (old.status !== '待确认') throw new Error(`旧方案状态为 ${old.status}，非待确认，拒绝改派`);

// 天文校验：过顶时刻太阳高度角（地质判读可用性）
const { solarElevationDegFor } = await import("./server/solar.mjs");
const sunEl = solarElevationDegFor(33.0047, 97.0088, new Date(cand.overpassTime));

db.prepare("DELETE FROM directPlans WHERE id=?").run(oldPlanId);
const r = db.prepare(`INSERT INTO directPlans (taskId,satNoradId,satName,company,windowStart,windowEnd,overpassTime,status)
  VALUES (?,?,?,?,?,?,?,'待确认')`).run(taskId, cand.satNoradId, cand.satName, cand.company,
  cand.windowStart, cand.windowEnd, cand.overpassTime);

// 日志留痕
db.prepare("INSERT INTO dispatchLog (orderId,taskId,channel,company,rank,action,detail) VALUES (?,?,?,?,?,?,?)")
  .run(null, taskId, '直控', cand.company, null, '方案改派',
    `旧方案#${oldPlanId} ${old.satName} ${old.overpassTime} → 新方案#${r.lastInsertRowid} ${cand.satName} ${cand.overpassTime}（太阳高度角${sunEl.toFixed(1)}°）`);

const bj = t => new Date(new Date(t).getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
console.log(JSON.stringify({
  newPlanId: r.lastInsertRowid,
  from: { planId: oldPlanId, sat: old.satName, company: old.company, overpassBJ: bj(old.overpassTime) },
  to: { sat: cand.satName, company: cand.company, satNoradId: cand.satNoradId,
        overpassBJ: bj(cand.overpassTime), windowBJ: `${bj(cand.windowStart)} ~ ${bj(cand.windowEnd)}`,
        slewDeg: cand.slewDeg, cloud: cand.cloudFc, cloudSource: cand.cloudSource, availability: cand.availability,
        validRes: cand.validRes, sunElevDeg: +sunEl.toFixed(1) },
  taskStatus: db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId).status
}, null, 1));
