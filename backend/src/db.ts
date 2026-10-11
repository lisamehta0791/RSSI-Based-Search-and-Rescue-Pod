/**
 * SQLite database (Node's built-in node:sqlite — nothing to install).
 * File: backend/data/rescue-pod.db — open it with "DB Browser for SQLite" to inspect.
 *
 * Teams and pods are global; everything else belongs to a session (one rescue operation).
 * The server keeps the working state in memory and writes it here on every change.
 */
import { DatabaseSync } from "node:sqlite";
import type {
  Area,
  Detection,
  LogEntry,
  Pod,
  Reading,
  SiteConfig,
  Team,
} from "../../shared/types.ts";

export interface Counters {
  detection: number;
  area: number;
  team: number;
  log: number;
}

export interface SessionData {
  sessionId: string;
  sessionStarted: number;
  site: SiteConfig;
  counters: Counters;
  pods: Pod[];
  teams: Team[];
  detections: Detection[];
  areas: Area[];
  log: LogEntry[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started INTEGER NOT NULL,
  ended INTEGER,
  site_name TEXT NOT NULL,
  site_lat REAL NOT NULL,
  site_lng REAL NOT NULL,
  site_zoom INTEGER NOT NULL,
  counters TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  members TEXT NOT NULL,
  status TEXT NOT NULL,
  lat REAL, lng REAL, accuracy_m REAL, pos_time INTEGER, pos_source TEXT,
  sos_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location_mode TEXT NOT NULL,
  manual_lat REAL, manual_lng REAL,
  carrier_team_id TEXT,
  last_seen INTEGER,
  link TEXT,
  last_reading TEXT,
  tracked_position TEXT,       -- JSON {lat,lng,accuracyM,t,source}
  trail TEXT                   -- JSON [{lat,lng,t}, ...] recent path
);

CREATE TABLE IF NOT EXISTS detections (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  lat REAL, lng REAL,
  tier TEXT NOT NULL,
  thermal INTEGER NOT NULL,
  signal INTEGER NOT NULL,
  fire INTEGER NOT NULL,
  smoke INTEGER NOT NULL DEFAULT 0,
  peak_obj_c REAL, amb_c REAL,
  max_rssi INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  label TEXT NOT NULL,
  notes TEXT NOT NULL,
  status TEXT NOT NULL,
  assigned_team_id TEXT,
  PRIMARY KEY (session_id, id)
);

CREATE TABLE IF NOT EXISTS areas (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL,
  radius_m REAL NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  assigned_team_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
);

CREATE TABLE IF NOT EXISTS log (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  id INTEGER NOT NULL,
  t INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  detection_id TEXT, team_id TEXT, area_id TEXT, pod_id TEXT,
  PRIMARY KEY (session_id, id)
);

-- Every raw sensing window from every pod (~1.5 per second per pod).
CREATE TABLE IF NOT EXISTS readings (
  session_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  t INTEGER NOT NULL,
  up INTEGER NOT NULL,
  mlx_ok INTEGER NOT NULL,
  obj_c REAL, amb_c REAL,
  thermal INTEGER NOT NULL,
  signal INTEGER NOT NULL,
  rssi INTEGER NOT NULL,
  probes INTEGER NOT NULL,
  flame INTEGER,               -- NULL = sensor not fitted
  smoke INTEGER,               -- MQ gas sensor: NULL = not fitted / warming up
  gas_raw INTEGER, gas_base INTEGER,
  tier TEXT NOT NULL,
  gps_lat REAL, gps_lng REAL   -- only if a GPS module is fitted
);
CREATE INDEX IF NOT EXISTS readings_by_session ON readings(session_id, pod_id, t);
`;

type Row = Record<string, unknown>;
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
const b = (v: boolean) => (v ? 1 : 0);

export class Db {
  private db: DatabaseSync;
  private savedLogId = 0;

  /** true when the database file was just created (used to add the sample teams once). */
  readonly isNew: boolean;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.isNew = !this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
    this.db.exec(SCHEMA);
    // Upgrade databases created by an earlier version of this backend.
    this.addColumn("pods", "tracked_position", "TEXT");
    this.addColumn("pods", "trail", "TEXT");
    this.addColumn("readings", "gps_lat", "REAL");
    this.addColumn("readings", "gps_lng", "REAL");
    this.addColumn("detections", "smoke", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("readings", "smoke", "INTEGER");
    this.addColumn("readings", "gas_raw", "INTEGER");
    this.addColumn("readings", "gas_base", "INTEGER");
  }

  private addColumn(table: string, column: string, type: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!cols.some((c) => c["name"] === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  close() {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return r ? String(r["value"]) : null;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private tx(fn: () => void) {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Load the session that was running when the server last stopped, if any. */
  loadCurrent(): SessionData | null {
    const cur = this.db.prepare("SELECT value FROM meta WHERE key = 'current_session'").get() as Row | undefined;
    if (!cur) return null;
    const id = String(cur["value"]);
    const ses = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    if (!ses) return null;

    const teams: Team[] = (this.db.prepare("SELECT * FROM teams ORDER BY created_at").all() as Row[]).map((r) => ({
      id: String(r["id"]),
      name: String(r["name"]),
      members: String(r["members"]),
      status: r["status"] as Team["status"],
      position:
        r["lat"] === null
          ? null
          : {
              lat: Number(r["lat"]),
              lng: Number(r["lng"]),
              accuracyM: n(r["accuracy_m"]),
              t: Number(r["pos_time"]),
              source: r["pos_source"] as "gps" | "manual" | "sim",
            },
      sosAt: n(r["sos_at"]),
      createdAt: Number(r["created_at"]),
    }));

    const pods: Pod[] = (this.db.prepare("SELECT * FROM pods ORDER BY id").all() as Row[]).map((r) => ({
      id: String(r["id"]),
      name: String(r["name"]),
      locationMode: (r["location_mode"] === "carried" ? "carried" : r["location_mode"] === "manual" ? "manual" : "tracked") as Pod["locationMode"],
      manualPosition: r["manual_lat"] === null ? null : { lat: Number(r["manual_lat"]), lng: Number(r["manual_lng"]) },
      trackedPosition: r["tracked_position"] ? JSON.parse(String(r["tracked_position"])) : null,
      trail: r["trail"] ? JSON.parse(String(r["trail"])) : [],
      carrierTeamId: s(r["carrier_team_id"]),
      lastSeen: n(r["last_seen"]),
      link: s(r["link"]),
      lastReading: r["last_reading"] ? (JSON.parse(String(r["last_reading"])) as Reading) : null,
    }));

    const detections: Detection[] = (
      this.db.prepare("SELECT * FROM detections WHERE session_id = ? ORDER BY first_seen").all(id) as Row[]
    ).map((r) => ({
      id: String(r["id"]),
      podId: String(r["pod_id"]),
      firstSeen: Number(r["first_seen"]),
      lastSeen: Number(r["last_seen"]),
      position: r["lat"] === null ? null : { lat: Number(r["lat"]), lng: Number(r["lng"]) },
      tier: r["tier"] as Detection["tier"],
      thermal: !!r["thermal"],
      signal: !!r["signal"],
      fire: !!r["fire"],
      smoke: !!r["smoke"],
      peakObjC: n(r["peak_obj_c"]),
      ambC: n(r["amb_c"]),
      maxRssi: Number(r["max_rssi"]),
      hits: Number(r["hits"]),
      label: String(r["label"]),
      notes: String(r["notes"]),
      status: r["status"] as Detection["status"],
      assignedTeamId: s(r["assigned_team_id"]),
    }));

    const areas: Area[] = (
      this.db.prepare("SELECT * FROM areas WHERE session_id = ? ORDER BY created_at").all(id) as Row[]
    ).map((r) => ({
      id: String(r["id"]),
      kind: r["kind"] as Area["kind"],
      label: String(r["label"]),
      center: { lat: Number(r["lat"]), lng: Number(r["lng"]) },
      radiusM: Number(r["radius_m"]),
      source: r["source"] as Area["source"],
      status: r["status"] as Area["status"],
      assignedTeamId: s(r["assigned_team_id"]),
      createdAt: Number(r["created_at"]),
    }));

    const log: LogEntry[] = (this.db.prepare("SELECT * FROM log WHERE session_id = ? ORDER BY id").all(id) as Row[]).map(
      (r) => {
        const e: LogEntry = { id: Number(r["id"]), t: Number(r["t"]), kind: r["kind"] as LogEntry["kind"], text: String(r["text"]) };
        if (r["detection_id"]) e.detectionId = String(r["detection_id"]);
        if (r["team_id"]) e.teamId = String(r["team_id"]);
        if (r["area_id"]) e.areaId = String(r["area_id"]);
        if (r["pod_id"]) e.podId = String(r["pod_id"]);
        return e;
      },
    );
    this.savedLogId = log.at(-1)?.id ?? 0;

    return {
      sessionId: id,
      sessionStarted: Number(ses["started"]),
      site: { name: String(ses["site_name"]), center: { lat: Number(ses["site_lat"]), lng: Number(ses["site_lng"]) }, zoom: Number(ses["site_zoom"]) },
      counters: JSON.parse(String(ses["counters"])) as Counters,
      pods,
      teams,
      detections,
      areas,
      log,
    };
  }

  /** Write the whole working state (small: tens of rows) in one transaction. */
  save(d: SessionData) {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, started, site_name, site_lat, site_lng, site_zoom, counters) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET site_name=excluded.site_name, site_lat=excluded.site_lat,
             site_lng=excluded.site_lng, site_zoom=excluded.site_zoom, counters=excluded.counters`,
        )
        .run(d.sessionId, d.sessionStarted, d.site.name, d.site.center.lat, d.site.center.lng, d.site.zoom, JSON.stringify(d.counters));
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('current_session', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(d.sessionId);

      // Teams & pods: replace the table contents (deleted teams disappear).
      this.db.exec("DELETE FROM teams");
      const ti = this.db.prepare(
        "INSERT INTO teams (id,name,members,status,lat,lng,accuracy_m,pos_time,pos_source,sos_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const t of d.teams) {
        const p = t.position;
        ti.run(t.id, t.name, t.members, t.status, p?.lat ?? null, p?.lng ?? null, p?.accuracyM ?? null, p?.t ?? null, p?.source ?? null, t.sosAt, t.createdAt);
      }
      this.db.exec("DELETE FROM pods");
      const pi = this.db.prepare(
        "INSERT INTO pods (id,name,location_mode,manual_lat,manual_lng,carrier_team_id,last_seen,link,last_reading,tracked_position,trail) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const p of d.pods) {
        pi.run(p.id, p.name, p.locationMode, p.manualPosition?.lat ?? null, p.manualPosition?.lng ?? null, p.carrierTeamId, p.lastSeen, p.link, p.lastReading ? JSON.stringify(p.lastReading) : null, p.trackedPosition ? JSON.stringify(p.trackedPosition) : null, JSON.stringify(p.trail));
      }

      this.db.prepare("DELETE FROM detections WHERE session_id = ?").run(d.sessionId);
      const di = this.db.prepare(
        `INSERT INTO detections (session_id,id,pod_id,first_seen,last_seen,lat,lng,tier,thermal,signal,fire,smoke,peak_obj_c,amb_c,
           max_rssi,hits,label,notes,status,assigned_team_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const x of d.detections) {
        di.run(d.sessionId, x.id, x.podId, x.firstSeen, x.lastSeen, x.position?.lat ?? null, x.position?.lng ?? null, x.tier, b(x.thermal), b(x.signal), b(x.fire), b(x.smoke), x.peakObjC, x.ambC, x.maxRssi, x.hits, x.label, x.notes, x.status, x.assignedTeamId);
      }

      this.db.prepare("DELETE FROM areas WHERE session_id = ?").run(d.sessionId);
      const ai = this.db.prepare(
        "INSERT INTO areas (session_id,id,kind,label,lat,lng,radius_m,source,status,assigned_team_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const a of d.areas) {
        ai.run(d.sessionId, a.id, a.kind, a.label, a.center.lat, a.center.lng, a.radiusM, a.source, a.status, a.assignedTeamId, a.createdAt);
      }

      // The log is append-only: insert just the new entries.
      const li = this.db.prepare(
        "INSERT INTO log (session_id,id,t,kind,text,detection_id,team_id,area_id,pod_id) VALUES (?,?,?,?,?,?,?,?,?)",
      );
      for (const e of d.log) {
        if (e.id <= this.savedLogId) continue;
        li.run(d.sessionId, e.id, e.t, e.kind, e.text, e.detectionId ?? null, e.teamId ?? null, e.areaId ?? null, e.podId ?? null);
        this.savedLogId = e.id;
      }
    });
  }

  insertReadings(sessionId: string, readings: Reading[]) {
    if (!readings.length) return;
    this.tx(() => {
      const ri = this.db.prepare(
        `INSERT INTO readings (session_id,pod_id,seq,t,up,mlx_ok,obj_c,amb_c,thermal,signal,rssi,probes,flame,tier,gps_lat,gps_lng,smoke,gas_raw,gas_base)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const r of readings) {
        ri.run(sessionId, r.podId, r.seq, r.t, r.up, b(r.mlxOk), r.objC, r.ambC, b(r.thermal), b(r.signal), r.rssi, r.probes, r.flame === null ? null : b(r.flame), r.tier, r.gps?.lat ?? null, r.gps?.lng ?? null, r.smoke === null ? null : b(r.smoke), r.gasRaw, r.gasBase);
      }
    });
  }

  /** Close the current session; the next save() starts logging into the new one. */
  endSession(id: string) {
    this.db.prepare("UPDATE sessions SET ended = ? WHERE id = ?").run(Date.now(), id);
    this.savedLogId = 0;
  }

  listSessions() {
    return this.db
      .prepare(
        `SELECT s.id, s.started, s.ended, s.site_name AS site,
           (SELECT COUNT(*) FROM detections d WHERE d.session_id = s.id) AS detections,
           (SELECT COUNT(*) FROM readings r WHERE r.session_id = s.id) AS readings
         FROM sessions s ORDER BY s.started DESC`,
      )
      .all();
  }

  readingsCsv(sessionId: string) {
    const rows = this.db.prepare("SELECT * FROM readings WHERE session_id = ? ORDER BY t").all(sessionId) as Row[];
    const cols = ["pod_id", "seq", "t", "mlx_ok", "obj_c", "amb_c", "thermal", "signal", "rssi", "probes", "flame", "smoke", "gas_raw", "gas_base", "tier"];
    const out = [["time", ...cols.filter((c) => c !== "t")].join(",")];
    for (const r of rows) {
      out.push([new Date(Number(r["t"])).toISOString(), ...cols.filter((c) => c !== "t").map((c) => (r[c] ?? "") as string)].join(","));
    }
    return out.join("\n");
  }
}
