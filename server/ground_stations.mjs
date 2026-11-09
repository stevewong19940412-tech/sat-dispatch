// 国内测控地面站（公开资料坐标）与站-星可见弧段计算
// 用途：直控上注需要"测控弧段"——卫星过站、仰角≥门限的时段，指令在弧段内上注
import { sampleTrack } from './candidate_calc.mjs';
import { haversineKm } from './candidate_calc.mjs';

export const GROUND_STATIONS = [
  { code: 'KS', name: '喀什站',   lat: 39.49, lon: 75.99,  band: 'S/X' },
  { code: 'JMS', name: '佳木斯站', lat: 46.79, lon: 130.34, band: 'S/X' },
  { code: 'SY', name: '三亚站',   lat: 18.27, lon: 109.51, band: 'S/X' },
  { code: 'NN', name: '南宁站',   lat: 22.85, lon: 108.40, band: 'S/X' },
  { code: 'QZ', name: '青藏站',   lat: 29.65, lon: 91.10,  band: 'S/X' },
  { code: 'MN', name: '闽南站',   lat: 24.44, lon: 118.10, band: 'S/X' },
];

// 地球半径
const R = 6371;

// 地面站对卫星的仰角（deg）：用星下点-站的几何近似
// 斜距 d、卫星高度 h、地心角 γ（星下点与站的角距）
// 仰角 = atan( (cos γ - R/(R+h)) / sin γ )
export function elevationDeg(station, satLat, satLon, altKm) {
  const γ = haversineKm(station.lat, station.lon, satLat, satLon) / R; // 地心角（rad）
  const r = R + altKm;
  const cosγ = Math.cos(γ), sinγ = Math.sin(γ);
  const el = (cosγ - R / r) / Math.max(sinγ, 1e-9);
  return Math.atan(el) * 180 / Math.PI;
}

/**
 * 计算卫星在时间窗内过各站的可见弧段（仰角≥minElDeg）
 * 返回 [{station, arcStart, arcEnd, maxElDeg}] 按弧段开始排序
 */
export function computeStationPasses(sat, windowStart, windowEnd, minElDeg = 5) {
  const passes = [];
  for (const st of GROUND_STATIONS) {
    // 30s 步长粗扫全窗
    const track = sampleTrack(sat, new Date(windowStart), Math.min(4320, (new Date(windowEnd) - new Date(windowStart)) / 60000 + 60), 30);
    let inArc = false, arcStart = null, maxEl = 0;
    for (const p of track) {
      if (p.t > new Date(windowEnd).getTime() + 3600000) break;
      const el = elevationDeg(st, p.lat, p.lon, p.altKm || 500);
      if (el >= minElDeg) {
        if (!inArc) { inArc = true; arcStart = p.t; maxEl = el; }
        else if (el > maxEl) maxEl = el;
      } else if (inArc) {
        inArc = false;
        passes.push({ station: st.name, code: st.code, arcStart, arcEnd: p.t, maxElDeg: Math.round(maxEl * 10) / 10 });
      }
    }
    if (inArc) passes.push({ station: st.name, code: st.code, arcStart, arcEnd: track[track.length - 1].t, maxElDeg: Math.round(maxEl * 10) / 10 });
  }
  return passes.sort((a, b) => a.arcStart - b.arcStart);
}

/**
 * 选上注弧段：须满足 arcEnd ≤ 成像窗开始（指令须在成像前上注完成），
 * 且弧段距成像开始最近（保证轨道根数/指令新鲜度）。无满足弧段时返回 null（无法上注，需等待下一圈）。
 */
export function pickUplinkPass(passes, imagingStartIso) {
  const imgStart = new Date(imagingStartIso).getTime();
  // LEO：上注弧段必须成像前结束（arcEnd ≤ 成像开始），取最近的一圈
  const feasible = passes.filter(p => p.arcEnd <= imgStart);
  if (feasible.length > 0) return feasible[feasible.length - 1];
  // GEO/凝视类：弧段持续覆盖成像时刻（arcStart ≤ 成像开始 ≤ arcEnd）＝随时可上注
  const alwaysVisible = passes.find(p => p.arcStart <= imgStart && p.arcEnd >= imgStart);
  if (alwaysVisible) return alwaysVisible;
  return null;
}
