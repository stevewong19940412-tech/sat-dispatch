// 卫星任务规划系统 - API 服务器
import express from "express";
import { createServer } from "http";
import {
  db, getAllSatellites, getSatellitesByCategory, getSatelliteByNoradId,
  searchSatellites, getCategories, listMissions, getMission, createMission,
  updateMission, deleteMission, getStaticLayer, setStaticLayer,
} from "./db.mjs";
import { propagate, groundTrack, predictPasses, tleAgeDays } from "./orbit.mjs";
import { dispatchApi } from "./dispatch.mjs";
import "./dispatch_schema.mjs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ─── API ──────────────────────────────────────────────────────────────────
const api = express.Router();

// 类别与计数
api.get("/categories", (req, res) => {
  const counts = Object.fromEntries(getCategories().map(r => [r.category, r.count]));
  const META = {
    imaging: { label: "光学/雷达成像", color: "#10b981", orbitType: "LEO", description: "光学与SAR成像卫星（WorldView/Sentinel/高分/吉林一号等）" },
    recon: { label: "成像侦察", color: "#ef4444", orbitType: "LEO", description: "成像侦察卫星（KH-11/遥感系列/COSMOS等）" },
    weather: { label: "气象对地观测", color: "#22d3ee", orbitType: "MIXED", description: "气象卫星（风云/NOAA/METOP/GOES等）" },
    science: { label: "对地观测科学星", color: "#84cc16", orbitType: "LEO", description: "对地观测科学卫星（Landsat/Terra/Aqua/SWARM等）" },
  };
  res.json(Object.entries(META).map(([key, val]) => ({
    key, ...val, count: counts[key] ?? 0,
  })));
});

// 全部卫星实时位置
api.get("/positions", (req, res) => {
  const date = req.query.timestamp ? new Date(parseInt(req.query.timestamp)) : new Date();
  const sats = getAllSatellites();
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
  res.json({ satellites: positions, timestamp: date.getTime() });
});

// 单星地面轨迹
api.get("/track/:noradId", (req, res) => {
  const sat = getSatelliteByNoradId(parseInt(req.params.noradId));
  if (!sat) return res.status(404).json({ error: "satellite not found" });
  const minutesAhead = parseInt(req.query.minutes ?? "90", 10);
  res.json({ noradId: sat.noradId, track: groundTrack(sat, minutesAhead) });
});

// 卫星档案
api.get("/satellite/:noradId", (req, res) => {
  const sat = getSatelliteByNoradId(parseInt(req.params.noradId));
  if (!sat) return res.status(404).json({ error: "satellite not found" });
  res.json(sat);
});

// 搜索
api.get("/search", (req, res) => {
  const q = req.query.q ?? "";
  res.json(searchSatellites(q, parseInt(req.query.limit ?? "50", 10)));
});

// 过境预报
api.get("/passes/:noradId", (req, res) => {
  const sat = getSatelliteByNoradId(parseInt(req.params.noradId));
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
api.post("/passes/batch", (req, res) => {
  const { noradIds, lat, lon, alt = 0, hours = 24, minElev = 5 } = req.body ?? {};
  if (!Array.isArray(noradIds) || isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: "noradIds[], lat, lon required" });
  }
  const results = [];
  for (const nid of noradIds) {
    const sat = getSatelliteByNoradId(nid);
    if (!sat) continue;
    const passes = predictPasses(sat, lat, lon, alt, hours, minElev);
    results.push({ noradId: nid, name: sat.name, category: sat.category, passes });
  }
  res.json({ results, obsLat: lat, obsLon: lon, hoursAhead: hours, minElevDeg: minElev });
});

// ─── 任务管理 ─────────────────────────────────────────────────────────────
api.get("/missions", (req, res) => {
  res.json(listMissions(req.query.status, parseInt(req.query.limit ?? "100", 10)));
});
api.get("/missions/:id", (req, res) => {
  const m = getMission(parseInt(req.params.id));
  if (!m) return res.status(404).json({ error: "mission not found" });
  res.json(m);
});
api.post("/missions", (req, res) => {
  const { name } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name required" });
  res.json(createMission(req.body));
});
api.put("/missions/:id", (req, res) => {
  const m = updateMission(parseInt(req.params.id), req.body ?? {});
  if (!m) return res.status(404).json({ error: "mission not found" });
  res.json(m);
});
api.delete("/missions/:id", (req, res) => {
  deleteMission(parseInt(req.params.id));
  res.json({ ok: true });
});

// ─── 静态图层 ─────────────────────────────────────────────────────────────
api.get("/layers/:type", (req, res) => {
  res.json(getStaticLayer(req.params.type) ?? { points: [], static: true });
});
api.post("/layers/:type", (req, res) => {
  setStaticLayer(req.params.type, req.body);
  res.json({ ok: true });
});

app.use("/api", api);
app.use("/api/dispatch", dispatchApi);

// ─── 静态文件（构建产物） ─────────────────────────────────────────────────
const distDir = join(__dirname, "..", "client", "dist");
app.use(express.static(distDir));
app.get("/*any", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(join(distDir, "index.html"));
});

const PORT = process.env.PORT || 8600;
createServer(app).listen(PORT, "0.0.0.0", () => {
  console.log(`[satplanning] API server on 0.0.0.0:${PORT}`);
});
