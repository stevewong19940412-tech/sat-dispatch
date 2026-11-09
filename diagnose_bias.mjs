import { db } from "./server/db.mjs";
import { propagate } from "./server/orbit.mjs";
import { getCapability } from "./server/candidate_calc.mjs";
const T={lat:33.0047,lon:97.0088};
const hav=(a,b,c,d)=>{const R=6371,r=Math.PI/180;const x=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;return 2*R*Math.asin(Math.sqrt(x));};
const sat=db.prepare("SELECT * FROM satellites WHERE noradId=?").get(46025);
const alt=propagate(sat,new Date("2026-11-10T04:01:40Z")).altKm;
const cap=getCapability(sat);
console.log(`GAOFEN-9 04：高度${alt.toFixed(0)}km，能力表侧摆上限${cap.slewLimitDeg}°，分辨率${cap.resolution}m`);
console.log(`侧摆上限对应地面距离 = alt*tan(40°)*0.9 = ${(alt*Math.tan(40*Math.PI/180)*0.9).toFixed(0)}km  ← 所谓"可见"的判定阈值`);
console.log('');
console.log('【1】20 秒粗采样下，卫星在相邻两点间跑了多远、目标距离变化多少：');
for (let t=Date.parse("2026-11-10T04:00:40Z"); t<=Date.parse("2026-11-10T04:02:40Z"); t+=20000){
  const p=propagate(sat,new Date(t)); const d=hav(p.lat,p.lon,T.lat,T.lon);
  const step = t>Date.parse("2026-11-10T04:00:40Z") ? hav(propagate(sat,new Date(t-20000)).lat,propagate(sat,new Date(t-20000)).lon,p.lat,p.lon) : 0;
  console.log(`  ${new Date(t).toISOString()}  距目标 ${d.toFixed(1)}km   距上一采样点 ${step.toFixed(0)}km`);
}
console.log('');
console.log('【2】系统判定的"窗口"= 第一/最后一个采样点（各是一个 20s 格点），不是真实可见弧段：');
console.log('  系统记录窗口 04:00:40 → 04:02:40（120s），声称过顶 04:01:40');
console.log('  真实：最近点 04:01:34（距73.3km），可见弧段仅 04:01:09–04:02:00（52s）');
console.log('');
console.log('【3】侧摆口径：系统 slew = asin(d/alt)，把目标偏移当球心角；正确应为 atan(d/alt)');
console.log(`  73.3km 处：系统口径 ${(Math.asin(73.3/alt)*180/Math.PI).toFixed(1)}°，几何口径 ${(Math.atan(73.3/alt)*180/Math.PI).toFixed(1)}°`);
console.log('  但两者都远小于 40° 门限，所以侧摆不是筛错原因——它是"判定太宽"的问题');
console.log('');
console.log('【4】成像时长：imaging = 窗口长×0.6，机动起点固定在窗口起点');
console.log('  原窗口 120s → 成像 60s，从窗口+28s 开始，卫星在这 60s 内从 86km 跑到 320km 以外');
console.log('  最近点只有 ±2s 内距目标 ≤2.1km（幅宽半宽），真实可成像时长只有数秒');
