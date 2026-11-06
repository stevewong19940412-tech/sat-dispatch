// 数据库层：better-sqlite3 单文件数据库
import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, "satplanning.db"));
db.pragma("journal_mode = WAL");

// ─── 表结构 ────────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS satellites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  noradId INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  intlDesignator TEXT,
  tle1 TEXT NOT NULL,
  tle2 TEXT NOT NULL,
  gpJson TEXT,
  epoch TEXT,
  objectType TEXT DEFAULT 'PAYLOAD',
  category TEXT NOT NULL,          -- imaging | recon | weather | science
  subCategory TEXT,                -- 细分类：optical/sar/meteorological 等
  country TEXT,
  launchDate TEXT,
  launchSite TEXT,
  missionDescription TEXT,
  operator TEXT,
  payloadType TEXT,                -- 载荷类型：光学成像/SAR/红外/气象等
  altitude REAL,
  inclination REAL,
  period REAL,
  apogee REAL,
  perigee REAL,
  eccentricity REAL,
  resolution TEXT,                 -- 成像分辨率（如 0.5m/1m/SAR）
  source TEXT DEFAULT 'celestrak', -- legacy | celestrak
  decayed INTEGER DEFAULT 0,
  lastUpdated TEXT,
  createdAt TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sat_category ON satellites(category);
CREATE INDEX IF NOT EXISTS idx_sat_norad ON satellites(noradId);
CREATE INDEX IF NOT EXISTS idx_sat_country ON satellites(country);

CREATE TABLE IF NOT EXISTS missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  codename TEXT,
  description TEXT,
  status TEXT DEFAULT 'planning',  -- planning|active|paused|completed|archived
  priority TEXT DEFAULT 'medium',  -- low|medium|high|critical
  classification TEXT DEFAULT 'unclassified',
  aoiLat REAL,
  aoiLon REAL,
  aoiRadiusKm REAL,
  aoiName TEXT,
  assignedSatellites TEXT DEFAULT '[]', -- JSON array of noradId
  startDate TEXT,
  endDate TEXT,
  objectives TEXT,
  notes TEXT,
  tags TEXT DEFAULT '[]',
  passCount INTEGER DEFAULT 0,
  lastPassAt TEXT,
  createdAt TEXT DEFAULT (datetime('now')),
  updatedAt TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mission_status ON missions(status);

CREATE TABLE IF NOT EXISTS static_layers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  layerType TEXT NOT NULL,  -- fire | wind
  payload TEXT NOT NULL,    -- JSON
  updatedAt TEXT DEFAULT (datetime('now'))
);
`);

// ─── 卫星 CRUD ─────────────────────────────────────────────────────────────
export function upsertSatellite(sat) {
  const stmt = db.prepare(`
    INSERT INTO satellites (noradId, name, intlDesignator, tle1, tle2, gpJson, epoch, objectType,
      category, subCategory, country, launchDate, launchSite, missionDescription, operator,
      payloadType, altitude, inclination, period, apogee, perigee, eccentricity, resolution,
      source, lastUpdated)
    VALUES (@noradId, @name, @intlDesignator, @tle1, @tle2, @gpJson, @epoch, @objectType,
      @category, @subCategory, @country, @launchDate, @launchSite, @missionDescription, @operator,
      @payloadType, @altitude, @inclination, @period, @apogee, @perigee, @eccentricity, @resolution,
      @source, @lastUpdated)
    ON CONFLICT(noradId) DO UPDATE SET
      name=excluded.name, intlDesignator=excluded.intlDesignator,
      tle1=excluded.tle1, tle2=excluded.tle2, gpJson=excluded.gpJson, epoch=excluded.epoch,
      objectType=excluded.objectType, category=excluded.category, subCategory=excluded.subCategory,
      country=excluded.country, launchDate=excluded.launchDate, launchSite=excluded.launchSite,
      missionDescription=excluded.missionDescription, operator=excluded.operator,
      payloadType=excluded.payloadType,
      altitude=excluded.altitude, inclination=excluded.inclination, period=excluded.period,
      apogee=excluded.apogee, perigee=excluded.perigee, eccentricity=excluded.eccentricity,
      resolution=excluded.resolution, source=excluded.source, lastUpdated=excluded.lastUpdated,
      decayed=0
  `);
  return stmt.run(sat);
}

export function getAllSatellites() {
  return db.prepare("SELECT * FROM satellites WHERE decayed = 0 ORDER BY category, name").all();
}

export function getSatellitesByCategory(category) {
  return db.prepare("SELECT * FROM satellites WHERE decayed = 0 AND category = ? ORDER BY name").all(category);
}

export function getSatelliteByNoradId(noradId) {
  return db.prepare("SELECT * FROM satellites WHERE noradId = ? LIMIT 1").get(noradId);
}

export function searchSatellites(query, limit = 50) {
  const asNum = parseInt(query, 10);
  if (!isNaN(asNum)) {
    const byId = db.prepare("SELECT * FROM satellites WHERE noradId = ? LIMIT ?").all(asNum, limit);
    if (byId.length > 0) return byId;
  }
  const q = query.trim().toLowerCase();
  return db.prepare(
    "SELECT * FROM satellites WHERE decayed = 0 AND lower(name) LIKE ? ORDER BY name LIMIT ?"
  ).all(`%${q}%`, limit);
}

export function getCategories() {
  return db.prepare(
    "SELECT category, count(*) as count FROM satellites WHERE decayed = 0 GROUP BY category"
  ).all();
}

// ─── 任务 CRUD ─────────────────────────────────────────────────────────────
function parseMission(row) {
  if (!row) return null;
  return { ...row, assignedSatellites: JSON.parse(row.assignedSatellites || "[]"), tags: JSON.parse(row.tags || "[]") };
}

export function listMissions(status, limit = 100) {
  const rows = status
    ? db.prepare("SELECT * FROM missions WHERE status = ? ORDER BY updatedAt DESC LIMIT ?").all(status, limit)
    : db.prepare("SELECT * FROM missions ORDER BY updatedAt DESC LIMIT ?").all(limit);
  return rows.map(parseMission);
}

export function getMission(id) {
  return parseMission(db.prepare("SELECT * FROM missions WHERE id = ?").get(id));
}

export function createMission(m) {
  const stmt = db.prepare(`
    INSERT INTO missions (name, codename, description, status, priority, classification,
      aoiLat, aoiLon, aoiRadiusKm, aoiName, assignedSatellites, startDate, endDate,
      objectives, notes, tags)
    VALUES (@name, @codename, @description, @status, @priority, @classification,
      @aoiLat, @aoiLon, @aoiRadiusKm, @aoiName, @assignedSatellites, @startDate, @endDate,
      @objectives, @notes, @tags)
  `);
  const r = stmt.run({
    name: m.name,
    codename: m.codename ?? null,
    description: m.description ?? null,
    status: m.status ?? "planning",
    priority: m.priority ?? "medium",
    classification: m.classification ?? "unclassified",
    aoiLat: m.aoiLat ?? null,
    aoiLon: m.aoiLon ?? null,
    aoiRadiusKm: m.aoiRadiusKm ?? null,
    aoiName: m.aoiName ?? null,
    assignedSatellites: JSON.stringify(m.assignedSatellites ?? []),
    startDate: m.startDate ?? null,
    endDate: m.endDate ?? null,
    objectives: m.objectives ?? null,
    notes: m.notes ?? null,
    tags: JSON.stringify(m.tags ?? []),
  });
  return getMission(r.lastInsertRowid);
}

export function updateMission(id, patch) {
  const existing = getMission(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  db.prepare(`
    UPDATE missions SET name=@name, codename=@codename, description=@description,
      status=@status, priority=@priority, classification=@classification,
      aoiLat=@aoiLat, aoiLon=@aoiLon, aoiRadiusKm=@aoiRadiusKm, aoiName=@aoiName,
      assignedSatellites=@assignedSatellites, startDate=@startDate, endDate=@endDate,
      objectives=@objectives, notes=@notes, tags=@tags,
      passCount=@passCount, lastPassAt=@lastPassAt,
      updatedAt=datetime('now')
    WHERE id=@id
  `).run({
    id,
    name: merged.name, codename: merged.codename, description: merged.description,
    status: merged.status, priority: merged.priority, classification: merged.classification,
    aoiLat: merged.aoiLat, aoiLon: merged.aoiLon, aoiRadiusKm: merged.aoiRadiusKm,
    aoiName: merged.aoiName, assignedSatellites: JSON.stringify(merged.assignedSatellites ?? []),
    startDate: merged.startDate, endDate: merged.endDate,
    objectives: merged.objectives, notes: merged.notes, tags: JSON.stringify(merged.tags ?? []),
    passCount: merged.passCount ?? 0, lastPassAt: merged.lastPassAt ?? null,
  });
  return getMission(id);
}

export function deleteMission(id) {
  return db.prepare("DELETE FROM missions WHERE id = ?").run(id);
}

// ─── 静态图层（火点/风场示例数据） ─────────────────────────────────────────
export function getStaticLayer(layerType) {
  const row = db.prepare("SELECT payload FROM static_layers WHERE layerType = ? ORDER BY updatedAt DESC LIMIT 1").get(layerType);
  return row ? JSON.parse(row.payload) : null;
}

export function setStaticLayer(layerType, payload) {
  db.prepare("DELETE FROM static_layers WHERE layerType = ?").run(layerType);
  db.prepare("INSERT INTO static_layers (layerType, payload) VALUES (?, ?)").run(layerType, JSON.stringify(payload));
}
