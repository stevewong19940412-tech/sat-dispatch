import { propagate } from "./server/orbit.mjs";
import { db } from "./server/db.mjs";
const sat = db.prepare("SELECT * FROM satellites WHERE noradId=?").get(46025);
const hav=(a,b,c,d)=>{const R=6371,r=Math.PI/180;const x=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;return 2*R*Math.asin(Math.sqrt(x));};
const ws=Date.parse("2026-11-10T04:01:12.721Z");
for (const off of [28,32,34,36,40,45]) {
  const t=ws+off*1000, p=propagate(sat,new Date(t)), d=hav(p.lat,p.lon,33.0047,97.0088);
  const half=p.altKm*Math.tan((0.5/2+0.02)*Math.PI/180);
  console.log(`窗口+${off}s ${new Date(t).toISOString()} 距目标 ${d.toFixed(2)}km 幅宽半宽 ${half.toFixed(2)}km → ${(d<=half)?'可覆盖':'偏出'}（侧摆 ${(Math.asin(Math.min(1,d/p.altKm))*180/Math.PI).toFixed(1)}°）`);
}
