// 真实云量预报层（open-meteo）—— 覆盖内置模拟气象场
// 设计（对照文档 4.3-4 的三档逻辑）：
//   目标点+过顶时刻落在 open-meteo 72h 逐小时预报窗口内 → 用真实预报值（档1：预报场）
//   窗口外（>3天）→ 回退内置确定性模拟场（档3：气候统计）
// 缓存：0.25°网格 × 每次预报请求缓存30分钟，避免同任务多候选重复拉取
import { forecastCloud as simulatedCloud } from "./candidate_calc.mjs";

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map(); // key: "latCell,lonCell" -> { fetchedAt, byHour: Map<"MM-DDTHH", cloud01> }

function cellKey(lat, lon) {
  // 0.25° 网格（open-meteo 逐点预报对相邻点差异不大，网格化提高命中率）
  return `${Math.round(lat * 4) / 4},${Math.round(lon * 4) / 4}`;
}

async function fetchForecast(lat, lon) {
  const key = cellKey(lat, lon);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
    + `&hourly=cloud_cover&timezone=UTC&forecast_days=3`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const data = await res.json();
  const times = data?.hourly?.time ?? [];
  const clouds = data?.hourly?.cloud_cover ?? [];
  const byHour = new Map();
  for (let i = 0; i < times.length; i++) {
    // open-meteo UTC 模式返回 "2026-11-09T05:00"（即 UTC 时刻）
    byHour.set(times[i], Math.max(0, Math.min(1, (clouds[i] ?? 0) / 100)));
  }
  const entry = { fetchedAt: Date.now(), byHour };
  cache.set(key, entry);
  // 防缓存膨胀
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return entry;
}

/**
 * 真实预报优先的云量解算入口（签名与模拟版 forecastCloud 完全一致）。
 * @returns {Promise<{cloud: number, source: "real"|"simulated"}>}
 */
export async function forecastCloudReal(lat, lon, when, leadDays) {
  try {
    const entry = await fetchForecast(lat, lon);
    // 对齐到整小时（open-meteo 是逐小时值）
    const d = new Date(when);
    const hh = `${String(d.getUTCHours()).padStart(2, "0")}:00`;
    const dayKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    const hourKey = `${dayKey}T${hh}`;
    const real = entry.byHour.get(hourKey);
    if (real !== undefined) {
      return { cloud: real, source: "real" };
    }
  } catch {
    // 网络失败/超时 → 静默回退模拟场（调度不被外部服务可用性卡死）
  }
  return { cloud: simulatedCloud(lat, lon, when, leadDays), source: "simulated" };
}

/** 清空缓存（测试用） */
export function clearCloudCache() { cache.clear(); }
