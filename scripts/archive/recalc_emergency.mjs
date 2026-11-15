// 应急任务候选复算：复用系统自身的确定性模块（轨道/几何/约束/云量），
// 唯一差别是不立刻用 timelinessHours 把候选全部筛掉，而是标注时效偏差，
// 交由值班在直控确认环节裁定。生成结果写回 candidates/rankings 表。
import { db } from "./server/db.mjs";
import { normalizeTaskStrips, computeVisibleWindows, getCapability, cloudEffective, haversineKm } from "./server/candidate_calc.mjs";
import { forecastCloudReal } from "./server/cloud_forecast.mjs";
import { solarElevationDegFor } from "./server/solar.mjs";
import { rankTask } from "./server/priority_calc.mjs";

const taskId = +(process.argv[2] || 8);
const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId);
if (!task) { console.error("task not found"); process.exit(1); }

const opts = { windowStart: task.windowStart, windowEnd: task.windowEnd, maxSlewDeg: task.maxSlewDeg ?? 45, minElevSunDeg: 10 };
const strips = normalizeTaskStrips(task, 12);
const tCreated = new Date(task.createdAt);
const leadDays = Math.max(0, (new Date(task.windowStart) - tCreated) / 86400000);

const allSats = db.prepare("SELECT * FROM satellites WHERE decayed=0").all()
  .filter(s => ['optical', 'staring', 'hyperspectral'].includes(s.subCategory));
const scope = allSats.filter(s => s.country === '中国');

db.prepare("DELETE FROM candidates WHERE taskId=?").run(taskId);
db.prepare("DELETE FROM rankings WHERE taskId=?").run(taskId);
const ins = db.prepare(`INSERT INTO candidates (taskId,stripIdx,stripCount,satNoradId,satName,company,
  windowStart,windowEnd,overpassTime,slewDeg,availability,cloudFc,orbitGrade,filtered,filterReason,validRes,cloudSource)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

let kept = 0, filtered = 0;
const gapStats = {};
const rows = [];

for (const sat of scope) {
  const cap = getCapability(sat);
  const company = sat.operator || sat.country;
  for (const strip of strips) {
    const windows = computeVisibleWindows(sat, strip, opts);
    for (const w of windows.slice(0, 3)) {
      const overpass = new Date(w.overpass);
      const { cloud, source: cloudSrc } = await forecastCloudReal(strip.lat, strip.lon, overpass, leadDays);
      const sunEl = solarElevationDegFor(strip.lat, strip.lon, overpass);
      const { availability } = cloudEffective(cloud, w.slewDeg, sunEl);
      const reasons = [];
      const gcand = cap.resolution * (1 + w.slewDeg / cap.slewLimitDeg * 0.5);
      if (gcand > task.resolution) reasons.push(`分辨率不满足：要求${task.resolution}m，候选有效${gcand.toFixed(1)}m`);
      if (w.slewDeg > cap.slewLimitDeg) reasons.push(`侧摆超限：需${w.slewDeg.toFixed(0)}°>上限${cap.slewLimitDeg}°`);
      if (cloud > task.maxCloud) reasons.push(`云量超限：预报${(cloud * 100).toFixed(0)}% > 任务上限${(task.maxCloud * 100).toFixed(0)}%`);
      if (sunEl < 10) reasons.push(`光照不足：太阳高度角${sunEl.toFixed(1)}°`);
      const leadH = (overpass - tCreated) / 3600000;
      if (reasons.length) {
        filtered++;
        for (const r of reasons) { const k = r.split('：')[0]; gapStats[k] = (gapStats[k] ?? 0) + 1; }
      } else {
        kept++;
      }
      const pass = reasons.length === 0;
      const note = pass ? `时效偏差：过顶在创建后${leadH.toFixed(1)}h（任务时效${task.timelinessHours}h，已按应急直控待值班裁定）` : null;
      const r = ins.run(taskId, strip.idx, strip.count, sat.noradId, sat.name, company,
        new Date(w.start).toISOString(), new Date(w.end).toISOString(), overpass.toISOString(),
        Math.round(w.slewDeg * 10) / 10, Math.round(availability * 10) / 10, Math.round(cloud * 1000) / 1000,
        '高', pass ? 0 : 1, pass ? note : reasons.join('；'), Math.round(gcand * 100) / 100, cloudSrc);
      if (pass) rows.push({ id: r.lastInsertRowid, sat: sat.name, company, overpass, leadH, slew: w.slewDeg, cloud, avail: availability, res: gcand });
    }
  }
}

const ranked = rankTask(taskId);
console.log(JSON.stringify({
  taskId, kept, filtered, gapStats, ranked,
  top: rows.sort((a, b) => b.avail - a.avail).slice(0, 8).map(x => ({
    sat: x.sat, company: x.company, overpassBJ: new Date(x.overpass.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16),
    leadH: +x.leadH.toFixed(1), slewDeg: +x.slew.toFixed(1), cloud: x.cloud, availability: x.avail, validRes: +x.res.toFixed(2)
  }))
}, null, 1));
