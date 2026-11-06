// 轨道计算核心：SGP4 传播、实时位置、地面轨迹、过境预报
// 算法迁移自原工作台 server/routers/orbit.ts，保持参数一致
// satellite.js 6.x 原生支持 json2satrec(OMM JSON)，GP 数据直接传播；legacy TLE 用 twoline2satrec
import * as satellite from "satellite.js";

const EARTH_R = 6371;

// ─── 统一获取 satrec：兼容 OMM JSON(gpJson) 与两行 TLE ────────────────────
export function satrecFor(sat) {
  if (sat.gpJson) {
    try {
      const gp = typeof sat.gpJson === "string" ? JSON.parse(sat.gpJson) : sat.gpJson;
      const rec = satellite.json2satrec(gp);
      if (rec && rec.error === 0) return rec;
    } catch {}
  }
  return satellite.twoline2satrec(sat.tle1.trim(), sat.tle2.trim());
}

// ─── SGP4 传播 → 地理坐标 ──────────────────────────────────────────────────
export function propagate(sat, date) {
  try {
    const satrec = satrecFor(sat);
    const posVel = satellite.propagate(satrec, date);
    if (!posVel || !posVel.position || typeof posVel.position === "boolean") return null;
    const gmst = satellite.gstime(date);
    const geo = satellite.eciToGeodetic(posVel.position, gmst);
    const lat = satellite.degreesLat(geo.latitude);
    const lon = satellite.degreesLong(geo.longitude);
    const altKm = geo.height;
    if (isNaN(lat) || isNaN(lon) || isNaN(altKm)) return null;
    const vel = posVel.velocity;
    const speedKms = Math.sqrt(vel.x ** 2 + vel.y ** 2 + vel.z ** 2);
    return { lat, lon, altKm, speedKms };
  } catch {
    return null;
  }
}

export function groundTrack(sat, minutesAhead = 90, stepSec = 60) {
  const pts = [];
  const now = Date.now();
  try {
    const satrec = satrecFor(sat);
    for (let t = -10; t <= minutesAhead; t += stepSec / 1000) {
      const date = new Date(now + t * 60000);
      const posVel = satellite.propagate(satrec, date);
      if (!posVel?.position || typeof posVel.position === "boolean") continue;
      const gmst = satellite.gstime(date);
      const geo = satellite.eciToGeodetic(posVel.position, gmst);
      const lat = satellite.degreesLat(geo.latitude);
      let lon = satellite.degreesLong(geo.longitude);
      pts.push({ lat, lon, altKm: geo.height, t });
    }
  } catch {}
  return pts;
}

// ─── 过境预报（迁移自原 getPasses，参数一致） ──────────────────────────────
export function predictPasses(sat, obsLat, obsLon, obsAltKm = 0, hoursAhead = 24, minElevDeg = 5) {
  let satrec;
  try {
    satrec = satrecFor(sat);
  } catch {
    return [];
  }
  const obsLatR = obsLat * Math.PI / 180;
  const obsLonR = obsLon * Math.PI / 180;
  const now = Date.now();
  const stepMs = 30000;
  const totalSteps = Math.round((hoursAhead * 3600000) / stepMs);

  function getElAz(date) {
    try {
      const posVel = satellite.propagate(satrec, date);
      if (!posVel?.position || typeof posVel.position === "boolean") return null;
      const gmst = satellite.gstime(date);
      const geo = satellite.eciToGeodetic(posVel.position, gmst);
      const satLat = satellite.degreesLat(geo.latitude);
      const satLon = satellite.degreesLong(geo.longitude);
      const satAlt = geo.height;
      if (isNaN(satLat) || isNaN(satLon)) return null;
      const satLatR = satLat * Math.PI / 180;
      const satLonR = satLon * Math.PI / 180;
      const obsR = EARTH_R + obsAltKm;
      const satR = EARTH_R + satAlt;
      const ox = obsR * Math.cos(obsLatR) * Math.cos(obsLonR);
      const oy = obsR * Math.cos(obsLatR) * Math.sin(obsLonR);
      const oz = obsR * Math.sin(obsLatR);
      const sx = satR * Math.cos(satLatR) * Math.cos(satLonR);
      const sy = satR * Math.cos(satLatR) * Math.sin(satLonR);
      const sz = satR * Math.sin(satLatR);
      const dx = sx - ox, dy = sy - oy, dz = sz - oz;
      const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const ux = Math.cos(obsLatR) * Math.cos(obsLonR);
      const uy = Math.cos(obsLatR) * Math.sin(obsLonR);
      const uz = Math.sin(obsLatR);
      const el = Math.asin((dx * ux + dy * uy + dz * uz) / range) * 180 / Math.PI;
      const nx = -Math.sin(obsLatR) * Math.cos(obsLonR);
      const ny = -Math.sin(obsLatR) * Math.sin(obsLonR);
      const nz = Math.cos(obsLatR);
      const ex = -Math.sin(obsLonR);
      const ey = Math.cos(obsLonR);
      const north = dx * nx + dy * ny + dz * nz;
      const east = dx * ex + dy * ey;
      const az = ((Math.atan2(east, north) * 180 / Math.PI) + 360) % 360;
      return { el, az };
    } catch { return null; }
  }

  const passes = [];
  let inPass = false;
  let riseTime = 0, riseAz = 0, maxEl = 0, maxAz = 0, maxTime = 0;

  for (let i = 0; i <= totalSteps; i++) {
    const t = new Date(now + i * stepMs);
    const ea = getElAz(t);
    if (!ea) continue;
    const { el, az } = ea;
    if (!inPass && el >= minElevDeg) {
      inPass = true;
      riseTime = t.getTime();
      riseAz = az;
      maxEl = el; maxAz = az; maxTime = t.getTime();
    } else if (inPass) {
      if (el > maxEl) { maxEl = el; maxAz = az; maxTime = t.getTime(); }
      if (el < minElevDeg) {
        inPass = false;
        passes.push({
          riseTime, riseAz: Math.round(riseAz),
          maxTime, maxEl: Math.round(maxEl * 10) / 10, maxAz: Math.round(maxAz),
          setTime: t.getTime(), setAz: Math.round(az),
          duration: Math.round((t.getTime() - riseTime) / 1000),
        });
        if (passes.length >= 10) break;
      }
    }
  }
  return passes;
}

// ─── 星历龄期（天） ────────────────────────────────────────────────────────
export function tleAgeDays(epoch) {
  if (!epoch) return null;
  const t = new Date(epoch).getTime();
  if (isNaN(t)) return null;
  return (Date.now() - t) / 86400000;
}
