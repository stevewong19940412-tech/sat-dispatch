// 逐星秒级重算：对任务窗内每条中国光学星的最近点，给出最小距离/侧摆/太阳高度角/云量
import { db } from "./server/db.mjs";
import { propagate } from "./server/orbit.mjs";
import { solarElevationDegFor } from "./server/solar.mjs";
import { forecastCloudReal } from "./server/cloud_forecast.mjs";
import { getCapability } from "./server/candidate_calc.mjs";
const T={lat:33.0047,lon:97.0088};
const hav=(a,b,c,d)=>{const R=6371,r=Math.PI/180;const x=Math.sin((c-a)*r/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin((d-b)*r/2)**2;return 2*R*Math.asin(Math.sqrt(x));};
const sats = db.prepare("SELECT * FROM satellites WHERE decayed=0 AND country=? AND subCategory IN ('optical','staring','hyperspectral')").all('中国');
const t0=Date.parse("2026-11-10T00:30:00Z"), t1=Date.parse("2026-11-10T04:30:00Z"); // 北京 08:30-12:30
const out=[];
for (const sat of sats) {
  let best=null;
  for (let t=t0;t<=t1;t+=2000){ const p=propagate(sat,new Date(t)); if(!p) continue;
    const d=hav(p.lat,p.lon,T.lat,T.lon); if(!best||d<best.d) best={t,d,alt:p.altKm}; }
  if(!best) continue;
  const slew=Math.asin(Math.min(1,best.d/best.alt))*180/Math.PI;
  const cap=getCapability(sat);
  const sun=solarElevationDegFor(T.lat,T.lon,new Date(best.t));
  if (best.d<=200 && slew<=cap.slewLimitDeg) {
    const {cloud,source}=await forecastCloudReal(T.lat,T.lon,new Date(best.t),1);
    out.push({sat:sat.name,company:sat.operator,bj:new Date(best.t+8*3600000).toISOString().slice(11,19),
      distKm:+best.d.toFixed(1),slew:+slew.toFixed(1),slewLim:cap.slewLimitDeg,res:cap.resolution,
      sunElev:+sun.toFixed(1),cloud:+(cloud*100).toFixed(0),cloudSrc:source});
  }
}
out.sort((a,b)=>a.distKm-b.distKm);
for (const o of out) console.log(`${o.bj} ${o.sat} [${o.company}] 距${o.distKm}km 侧摆${o.slew}/${o.slewLim}° 分辨率${o.res}m 太阳${o.sunElev}° 云${o.cloud}%`);
