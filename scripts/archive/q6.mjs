import { db } from "./server/db.mjs";
const c = db.prepare("SELECT * FROM candidates WHERE id=608").get();
for (const w of [c.windowStart, c.overpassTime, c.windowEnd]) {
  const { propagate } = await import("./server/orbit.mjs");
  const sat = db.prepare("SELECT * FROM satellites WHERE noradId=?").get(c.satNoradId);
  const p = propagate(sat, new Date(w));
  const dLat = (p.lat - 33.0047) * 111.32, dLon = (p.lon - 97.0088) * 111.32 * Math.cos(33.0047 * Math.PI / 180);
  console.log(w, `星下点 ${p.lat.toFixed(3)},${p.lon.toFixed(3)} 距目标 ${Math.hypot(dLat, dLon).toFixed(1)} km 高度 ${p.altKm.toFixed(0)}km`);
}
