import { propagate } from "./server/orbit.mjs";
import { db } from "./server/db.mjs";
const sat = db.prepare("SELECT * FROM satellites WHERE noradId=?").get(46025);
const hav=(a,b,c,d)=>{const R=6371,r=Math.PI/180;const x=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;return 2*R*Math.asin(Math.sqrt(x));};
let best=null; const seq=[];
for (let t=Date.parse("2026-11-10T03:55:00Z"); t<=Date.parse("2026-11-10T04:10:00Z"); t+=1000) {
  const p=propagate(sat,new Date(t)); if(!p) continue;
  const d=hav(p.lat,p.lon,33.0047,97.0088);
  if(!best||d<best.d) best={t,d,alt:p.altKm};
}
console.log('最近点', new Date(best.t).toISOString(), '距离', best.d.toFixed(2),'km', '高度', best.alt.toFixed(0));
// 最近点附近 ±10s 逐秒看距离变化速率
for (let k=-10;k<=10;k+=2){ const t=best.t+k*1000,p=propagate(sat,new Date(t)); console.log(k, hav(p.lat,p.lon,33.0047,97.0088).toFixed(2),'km'); }
