// 时序对齐：窗口起点 = 最近过顶点 − (机动+稳定+预热) − 2s 余量，使成像动作覆盖最近过顶点
import { db } from "./server/db.mjs";
import { propagate } from "./server/orbit.mjs";
const sat = db.prepare("SELECT * FROM satellites WHERE noradId=?").get(46025);
const T = { lat: 33.0047, lon: 97.0088 };
const hav=(a,b,c,d)=>{const R=6371,r=Math.PI/180;const x=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;return 2*R*Math.asin(Math.sqrt(x));};
let best=null;
for (let t=Date.parse("2026-11-10T03:55:00Z"); t<=Date.parse("2026-11-10T04:10:00Z"); t+=1000) {
  const p=propagate(sat,new Date(t)); if(!p) continue;
  const d=hav(p.lat,p.lon,T.lat,T.lon); if(!best||d<best.d) best={t,d,alt:p.altKm};
}
const slew=Math.asin(Math.min(1,best.d/best.alt))*180/Math.PI;          // 9.3°
const slewTime=Math.abs(slew)/1.0+1.0/0.5;                              // 与 generateCommands 同一公式
const pre=slewTime+3.0+5.0;                                             // 机动+稳定+预热
const img=Math.max(8, slewTime+3+5+1+8);                                // 窗口长使 imaging≥8s
const imgDur=Math.max(8,Math.min(60,img*0.6));
const ws=new Date(best.t-(pre+2)*1000);                                 // 留 2s 余量
const we=new Date(ws.getTime()+img*1000);
db.prepare("UPDATE directPlans SET windowStart=?, windowEnd=?, overpassTime=?, commandSummary=?, updatedAt=datetime('now') WHERE id=?")
  .run(ws.toISOString(), we.toISOString(), new Date(best.t).toISOString(),
       JSON.stringify({precisionSlewDeg:+slew.toFixed(1), nearestDistKm:+best.d.toFixed(1), basis:"秒级重算并时序对齐"}), 3);
const p=propagate(sat,new Date(best.t));
console.log(JSON.stringify({ws:ws.toISOString(), we:we.toISOString(), overpass:new Date(best.t).toISOString(), slew:+slew.toFixed(1), preS:pre, imgDur, nearestDistKm:+best.d.toFixed(1)},null,1));
