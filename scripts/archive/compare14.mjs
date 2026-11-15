import { db } from "./server/db.mjs";
import { propagate } from "./server/orbit.mjs";
const T={lat:33.0047,lon:97.0088};
const hav=(a,b,c,d)=>{const R=6371,r=Math.PI/180;const x=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;return 2*R*Math.asin(Math.sqrt(x));};
const sat=db.prepare("SELECT * FROM satellites WHERE name=?").get("GAOFEN-14 01");
const cand=db.prepare("SELECT * FROM candidates WHERE taskId=8 AND filtered=0 AND satNoradId=(SELECT noradId FROM satellites WHERE name='GAOFEN-14 01')").get();
console.log('候选记录：过顶',cand.overpassTime,'窗口',cand.windowStart,'~',cand.windowEnd,'侧摆',cand.slewDeg);
for (const t of [cand.windowStart,cand.overpassTime,cand.windowEnd]){
  const p=propagate(sat,new Date(t)); console.log(' ',t,'距目标',hav(p.lat,p.lon,T.lat,T.lon).toFixed(1),'km');
}
// 真实最近点
let best=null;
for(let t=Date.parse("2026-11-10T03:55:00Z");t<=Date.parse("2026-11-10T04:25:00Z");t+=1000){const p=propagate(sat,new Date(t));const d=hav(p.lat,p.lon,T.lat,T.lon);if(!best||d<best.d)best={t,d,alt:p.altKm};}
console.log('真实最近点',new Date(best.t).toISOString(),'距',best.d.toFixed(2),'km 高度',best.alt.toFixed(0));
const half=best.alt*Math.tan((0.8/2+0.02)*Math.PI/180);
let dur=0; for(let t=best.t-60000;t<=best.t+60000;t+=100){const p=propagate(sat,new Date(t));if(hav(p.lat,p.lon,T.lat,T.lon)<=half)dur+=0.1;}
console.log(`幅宽半宽 ${half.toFixed(2)}km，可成像时长约 ${dur.toFixed(0)}s`);
