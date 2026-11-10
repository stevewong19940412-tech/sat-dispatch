// 全局状态与 API 客户端
export const CATEGORY_META = {
  imaging: { label: "光学/雷达成像", color: "#10b981", description: "光学与SAR成像卫星（WorldView/Sentinel/高分/吉林一号等）" },
  recon: { label: "成像侦察", color: "#ef4444", description: "成像侦察卫星（KH-11/遥感系列/COSMOS等）" },
  weather: { label: "气象对地观测", color: "#22d3ee", description: "气象卫星（风云/NOAA/METOP/GOES等）" },
  science: { label: "对地观测科学星", color: "#84cc16", description: "对地观测科学卫星（Landsat/Terra/Aqua/SWARM等）" },
};

export const CATEGORY_ZH = {
  imaging: "成像", recon: "侦察", weather: "气象", science: "科学",
};

export const MISSION_STATUS_ZH = {
  planning: "规划中", active: "进行中", paused: "已暂停", completed: "已完成", archived: "已归档",
};
export const MISSION_PRIORITY_ZH = { low: "低", medium: "中", high: "高", critical: "关键" };
export const STATUS_FLOW = ["planning", "active", "paused", "completed", "archived"];

// 常用观测点
export const OBS_PRESETS = [
  { name: "北京", lat: 39.9042, lon: 116.4074 },
  { name: "三亚", lat: 18.2528, lon: 109.5119 },
  { name: "喀什", lat: 39.4704, lon: 75.9898 },
  { name: "哈尔滨", lat: 45.8038, lon: 126.5350 },
  { name: "青海地面站", lat: 36.2836, lon: 100.6200 },
];

export async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json", "X-Operator": "human" },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDur(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}分${String(s).padStart(2, "0")}秒`;
}
