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

// 在途请求去重：并发预取时同一网格可能被同时请求，复用同一个 Promise
const inflight = new Map(); // key -> Promise

async function fetchForecast(lat, lon) {
  const key = cellKey(lat, lon);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = _fetchForecastUncached(lat, lon, key).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function _fetchForecastUncached(lat, lon, key) {

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
// ── 真实预报有效期（open-meteo 只给 3 天逐小时预报）──────────────────
// 2026-11-18 用户要求："三天外不做云量筛选"。
// 理由：3 天外系统只能给模拟气象场（无物理意义），拿它硬筛候选会误杀。
// 处理：超出有效期直接返回 { cloud: null, source: 'out-of-range' }，
//       applyConstraints 见到 cloud=null 就跳过云量判定，只标注不筛除。
export const FORECAST_VALID_HOURS = 72;

/** 该时刻距现在是否在真实预报有效期内 */
export function withinForecastRange(when) {
  const t = new Date(when).getTime();
  if (!Number.isFinite(t)) return false;
  const hoursAhead = (t - Date.now()) / 3600000;
  return hoursAhead >= -2 && hoursAhead <= FORECAST_VALID_HOURS;
}

/**
 * 批量预取：一次把该区域所有需要的云量网格并发拉回，循环内全命中缓存。
 * 解决"循环里逐次 await 外部 API"导致的几十秒~数分钟耗时。
 * @param {Array<{lat:number, lon:number, when?:string}>} points
 * @param {number} concurrency 并发上限（默认 8，避免打爆 open-meteo）
 * @returns {Promise<{requested:number, cells:number, fetched:number, failed:number}>}
 */
export async function prefetchCloudGrids(points, concurrency = 8) {
  const now = Date.now();
  const keys = new Map(); // cellKey -> {lat, lon}
  for (const p of points || []) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
    // 只预取有效期内的点：3 天外不筛云量，没必要请求
    if (p.when && !withinForecastRange(p.when)) continue;
    const k = cellKey(p.lat, p.lon);
    if (!keys.has(k)) keys.set(k, { lat: p.lat, lon: p.lon });
  }
  // 已在缓存且新鲜的直接跳过
  const todo = [...keys.entries()].filter(([k]) => {
    const hit = cache.get(k);
    return !(hit && now - hit.fetchedAt < CACHE_TTL_MS);
  });
  let fetched = 0, failed = 0;
  let idx = 0;
  const worker = async () => {
    while (idx < todo.length) {
      const [k, v] = todo[idx++];
      try { await fetchForecast(v.lat, v.lon); fetched++; }
      catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length || 1) }, worker));
  return { requested: points?.length ?? 0, cells: keys.size, fetched, failed };
}

export async function forecastCloudReal(lat, lon, when, leadDays) {
  // 3 天外：不做云量筛选（模拟场无物理意义，不拿假数据误杀候选）
  if (!withinForecastRange(when)) {
    return { cloud: null, source: 'out-of-range' };
  }
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
    // 网络失败/超时：不拿模拟值硬筛，返回 null 表示"云量未知，不参与筛选"
  }
  return {
    cloud: null,
    source: 'unavailable',
    simulatedRef: simulatedCloud(lat, lon, when, leadDays),  // 仅供参考，不用于筛除
  };
}

/** 清空缓存（测试用） */
export function clearCloudCache() { cache.clear(); }
