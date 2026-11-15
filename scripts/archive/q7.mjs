import { propagate } from "./server/orbit.mjs";
import { db } from "./server/db.mjs";
const sat = db.prepare("SELECT * FROM satellites WHERE noradId=?").get(46025);
const hav=(a,b,c,d)=>{const R=6371,r=Math.PI/180;const x=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;return 2*R*Math.asin(Math.sqrt(x));};
const ws=Date.parse("2026-11-10T04:01:14Z"), imgStart=ws+28000, imgEnd=imgStart+36000;
for (const [label,t] of [["成像开始",imgStart],["成像中点",(imgStart+imgEnd)/2],["成像结束",imgEnd]]) {
  const p=propagate(sat,new Date(t)); const d=hav(p.lat,p.lon,33.0047,97.0088);
  const dwell = p.altKm*Math.tan((0.5/2+0.02)*Math.PI/180);
  console.log(`${label} ${new Date(t).toISOString()} 偏差 ${d.toFixed(1)}km 瞬时幅宽半宽 ${(dwell).toFixed(1)}km → ${d<=dwell?'覆盖':'未覆盖'}`);
}
