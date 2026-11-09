// 秒级细采样重算 GAOFEN-9 04 对玉树目标的精确可视窗（复用系统轨道传播与几何口径）
import { db } from "./server/db.mjs";
import { propagate } from "./server/orbit.mjs";
const sat = db.prepare("SELECT * FROM satellites WHERE noradId=?").get(46025);
const T = { lat: 33.0047, lon: 97.0088 };
const alt = propagate(sat, new Date("2026-11-10T04:01:40Z")).altKm;
const hav = (a, b, c, d) => { const R=6371, r=Math.PI/180;
  const x=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2; return 2*R*Math.asin(Math.sqrt(x)); };
const slewOf = d => Math.asin(Math.min(1, d / alt)) * 180 / Math.PI;
// 距目标 200km 内视为相关弧段，秒级扫描
const pts = [];
for (let t = Date.parse("2026-11-10T03:50:00Z"); t <= Date.parse("2026-11-10T04:15:00Z"); t += 1000) {
  const p = propagate(sat, new Date(t));
  if (!p) continue;
  const d = hav(p.lat, p.lon, T.lat, T.lon);
  if (d <= 200) pts.push({ t, d, slew: slewOf(d) });
}
const best = pts.reduce((a, b) => b.d < a.d ? b : a);
// 侧摆上限 40° 时对应地面距离
const maxOff = alt * Math.tan(40 * Math.PI / 180) * 0.9;
const vis = pts.filter(p => p.d <= maxOff);
const bj = ms => new Date(ms + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
console.log(JSON.stringify({
  altitudeKm: +alt.toFixed(0), maxOffKm40deg: +maxOff.toFixed(0),
  nearest: { bj: bj(best.t), distKm: +best.d.toFixed(1), slewDeg: +best.slew.toFixed(1) },
  visibleWindow: vis.length ? { fromBJ: bj(vis[0].t), toBJ: bj(vis[vis.length-1].t), durationSec: vis.length } : null,
  // 成像需 ≥8s 留窗，给出侧摆 ≤15° 的更优弧段
  tight: (() => { const v = pts.filter(p => p.slew <= 15); return v.length ? { fromBJ: bj(v[0].t), toBJ: bj(v[v.length-1].t), minSlew: +Math.min(...v.map(x=>x.slew)).toFixed(1) } : null; })()
}, null, 1));
