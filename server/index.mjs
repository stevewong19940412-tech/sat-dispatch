// 卫星任务规划系统 - API 服务器
import express from "express";
import { createServer } from "http";
// 数据层已全量迁 PocketBase（2026-11-15）：不再依赖 SQLite/db.mjs/dispatch_schema
import {
  getAllSatellites, getSatellitesByCategory, getSatelliteByNoradId,
  searchSatellites, getCategories, listMissions, getMission, createMission,
  updateMission, deleteMission, getStaticLayer, setStaticLayer,
} from "./sat_repo.mjs";
import { propagate, groundTrack, predictPasses, tleAgeDays } from "./orbit.mjs";
import { dispatchApi } from "./dispatch.mjs";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// 请求日志（排障用：确认UI点击是否到达服务端）
app.use((req, res, next) => {
  if (req.method === 'POST') console.log(`[req] ${req.method} ${req.path} ${new Date().toISOString().slice(11,19)}`);
  next();
});
app.use(express.json());

// ─── API ──────────────────────────────────────────────────────────────────
const api = express.Router();

// 类别与计数
api.get("/categories", async (req, res) => {
  const counts = Object.fromEntries((await getCategories()).map(r => [r.category, r.count]));
  // 可调度口径（与任务候选池一致）：只算中国卫星中的光学/凝视/高光谱/SAR。
  // 首页原先只给全库 310 颗的分类计数，容易被误读成"能用的卫星数"——
  // 这两者差异很大（外国星 24 颗 + 气象/科学/海洋等非成像星），故一并返回供前端标注。
  let dispatchable = 0;
  try {
    const all = await getAllSatellites();
    dispatchable = all.filter(s => s.country === '中国'
      && ['optical', 'staring', 'hyperspectral', 'sar'].includes(s.subCategory)).length;
  } catch {}
  const META = {
    imaging: { label: "光学/雷达成像", color: "#10b981", orbitType: "LEO", description: "光学与SAR成像卫星（WorldView/Sentinel/高分/吉林一号等）" },
    recon: { label: "成像侦察", color: "#ef4444", orbitType: "LEO", description: "成像侦察卫星（KH-11/遥感系列/COSMOS等）" },
    weather: { label: "气象对地观测", color: "#22d3ee", orbitType: "MIXED", description: "气象卫星（风云/NOAA/METOP/GOES等）" },
    science: { label: "对地观测科学星", color: "#84cc16", orbitType: "LEO", description: "对地观测科学卫星（Landsat/Terra/Aqua/SWARM等）" },
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  res.setHeader('X-Dispatchable-China', String(dispatchable));
  res.json(Object.entries(META).map(([key, val]) => ({
    key, ...val, count: counts[key] ?? 0, total, dispatchableChina: dispatchable,
  })));
});

// 全部卫星实时位置 —— 服务端共享缓存（对照工作台 sseDataPump 架构）：
// 传播结果全站共享 10s，N 个客户端 5s 轮询只触发 1 次真实计算，其余命中缓存
let _posCache = { data: null, at: 0 };
api.get("/positions", async (req, res) => {
  const date = req.query.timestamp ? new Date(parseInt(req.query.timestamp)) : new Date();
  const now = Date.now();
  if (_posCache.data && now - _posCache.at < 10000) {
    return res.json(_posCache.data);
  }
  const sats = await getAllSatellites();
  const positions = [];
  for (const sat of sats) {
    const pos = propagate(sat, date);
    if (pos) {
      positions.push({
        noradId: sat.noradId, name: sat.name, category: sat.category,
        payloadType: sat.payloadType, country: sat.country,
        ...pos,
        inclination: sat.inclination ?? 0,
        tle1: sat.tle1, tle2: sat.tle2,
        epoch: sat.epoch, tleAgeDays: tleAgeDays(sat.epoch),
      });
    }
  }
  const payload = { satellites: positions, timestamp: date.getTime() };
  _posCache = { data: payload, at: now };
  res.json(payload);
});

// SSE 单连接推送（对照工作台 sseBroadcast.ts）：替代客户端高频轮询
const sseClients = new Set();
let _sseCache = { data: null, at: 0 };
api.get("/sse/positions", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":connected\n\n");
  // 立即推一份当前缓存
  if (_posCache.data) res.write(`data: ${JSON.stringify(_posCache.data)}\n\n`);
  sseClients.add(res);
  const hb = setInterval(() => res.write(":hb\n\n"), 15000);
  req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
});
// SSE 泵：有订阅者才计算，10s 一次
setInterval(async () => {
  if (sseClients.size === 0) return;
  // PB 超时不能变成未捕获拒绝（未处理拒绝在 Node 24 下可能直接终止进程）
  try {
    const date = new Date();
    const sats = await getAllSatellites();
    const positions = [];
    for (const sat of sats) {
      const pos = propagate(sat, date);
      if (pos) positions.push({ noradId: sat.noradId, name: sat.name, category: sat.category, ...pos });
    }
    _posCache = { data: { satellites: positions, timestamp: date.getTime() }, at: Date.now() };
    const frame = `data: ${JSON.stringify(_posCache.data)}\n\n`;
    for (const client of sseClients) client.write(frame);
  } catch (e) {
    console.error("[sse/positions] 位置推送失败:", e?.message ?? e);
  }
}, 10000);

// 单星地面轨迹
api.get("/track/:noradId", async (req, res) => {
  const sat = await getSatelliteByNoradId(parseInt(req.params.noradId));
  if (!sat) return res.status(404).json({ error: "satellite not found" });
  const minutesAhead = parseInt(req.query.minutes ?? "90", 10);
  res.json({ noradId: sat.noradId, track: groundTrack(sat, minutesAhead) });
});

// 卫星档案
api.get("/satellite/:noradId", async (req, res) => {
  const sat = await getSatelliteByNoradId(parseInt(req.params.noradId));
  if (!sat) return res.status(404).json({ error: "satellite not found" });
  res.json(sat);
});

// 搜索
api.get("/search", async (req, res) => {
  const q = req.query.q ?? "";
  res.json(await searchSatellites(q, parseInt(req.query.limit ?? "50", 10)));
});

// 过境预报
api.get("/passes/:noradId", async (req, res) => {
  const sat = await getSatelliteByNoradId(parseInt(req.params.noradId));
  if (!sat) return res.status(404).json({ error: "satellite not found" });
  const obsLat = parseFloat(req.query.lat);
  const obsLon = parseFloat(req.query.lon);
  if (isNaN(obsLat) || isNaN(obsLon)) return res.status(400).json({ error: "lat/lon required" });
  const obsAltKm = parseFloat(req.query.alt ?? "0") || 0;
  const hoursAhead = parseFloat(req.query.hours ?? "24") || 24;
  const minElevDeg = parseFloat(req.query.minElev ?? "5");
  const passes = predictPasses(sat, obsLat, obsLon, obsAltKm, hoursAhead, minElevDeg);
  res.json({ passes, obsLat, obsLon, satellite: { noradId: sat.noradId, name: sat.name } });
});

// 多星过境汇总（任务用）
api.post("/passes/batch", async (req, res) => {
  const { noradIds, lat, lon, alt = 0, hours = 24, minElev = 5 } = req.body ?? {};
  if (!Array.isArray(noradIds) || isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: "noradIds[], lat, lon required" });
  }
  const results = [];
  for (const nid of noradIds) {
    const sat = await getSatelliteByNoradId(nid);
    if (!sat) continue;
    const passes = predictPasses(sat, lat, lon, alt, hours, minElev);
    results.push({ noradId: nid, name: sat.name, category: sat.category, passes });
  }
  res.json({ results, obsLat: lat, obsLon: lon, hoursAhead: hours, minElevDeg: minElev });
});

// ─── 任务管理 ─────────────────────────────────────────────────────────────
api.get("/missions", async (req, res) => {
  res.json(await listMissions(req.query.status, parseInt(req.query.limit ?? "100", 10)));
});
api.get("/missions/:id", async (req, res) => {
  const m = await getMission(parseInt(req.params.id));
  if (!m) return res.status(404).json({ error: "mission not found" });
  res.json(m);
});
api.post("/missions", async (req, res) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  res.json(await createMission(req.body));
});
api.put("/missions/:id", async (req, res) => {
  const m = await updateMission(parseInt(req.params.id), req.body ?? {});
  if (!m) return res.status(404).json({ error: "mission not found" });
  res.json(m);
});
api.delete("/missions/:id", async (req, res) => {
  await deleteMission(parseInt(req.params.id));
  res.json({ ok: true });
});

// ─── 静态图层 ─────────────────────────────────────────────────────────────
api.get("/layers/:type", async (req, res) => {
  res.json((await getStaticLayer(req.params.type)) ?? { points: [], static: true });
});
api.post("/layers/:type", async (req, res) => {
  await setStaticLayer(req.params.type, req.body);
  res.json({ ok: true });
});

app.use("/api", api);
app.use("/api/dispatch", dispatchApi);

// 异步路由统一兜底：数据层全部改 PB 后接口都是 async，
// 若 PB 不可用/超时，必须返回 503 而不是让未捕获拒绝拖垮进程。
app.use("/api", (err, req, res, next) => {
  console.error(`[api] ${req.method} ${req.originalUrl} 失败:`, err?.message ?? err);
  if (res.headersSent) return next(err);
  res.status(503).json({ error: "数据服务暂不可用（PocketBase）", detail: String(err?.message ?? err) });
});

// ─── 静态文件（构建产物） ─────────────────────────────────────────────────
// 部署态：client-dist 平铺在 runtime 根；开发态：../client/dist
import { readdirSync } from "fs";
const distDir = existsSync(join(__dirname, "..", "client-dist"))
  ? join(__dirname, "..", "client-dist")
  : join(__dirname, "..", "client", "dist");
// index.html 不缓存（防用户浏览器拿旧HTML指向旧资源hash），带hash的静态资源长缓存
app.use(express.static(distDir, {
  setHeaders(res, path) {
    if (path.endsWith(".html")) res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  },
}));
// 旧构建 hash 请求一律 410 Gone：配合浏览器放弃缓存旧JS（用户强刷一次后永不再遇）
app.use((req, res, next) => {
  const m = req.path.match(/^\/assets\/(index-[\w-]+\.js)$/);
  if (m && !existsSync(join(distDir, 'assets', m[1]))) {
    // 旧构建 hash 请求 → 302 到当前最新 index-*.js（浏览器缓存的旧HTML无需刷新即自动升级到新构建）
    const latest = readdirSync(join(distDir, 'assets')).find(f => /^index-[\w-]+\.js$/.test(f));
    if (latest) return res.redirect(302, `/assets/${latest}`);
  }
  next();
});
app.get("/*any", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(join(distDir, "index.html"));
});

const PORT = process.env.PORT || 8600;
createServer(app).listen(PORT, "0.0.0.0", () => {
  console.log(`[satplanning] API server on 0.0.0.0:${PORT}`);
  // PB 迁移（幂等，异步不阻塞端口 probe）：确保 collections 与种子数据就绪
  // pb_setup 自举改为手动/按需触发（POST /_pb-setup），启动时仅跑迁移不含自愈
  import("./pb_setup.mjs")
    .then(m => m.runSetup({ skipRelHeal: true }))
    .then(() => import("./orbit_heal.mjs"))
    .then(m => m.healOrbitParams())
    .then(m => m.healSatelliteMeta())
    .catch(e => console.error("[startup] PB 初始化/轨道自愈失败:", e.message));
});
