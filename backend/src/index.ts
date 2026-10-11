/**
 * RSSI Rescue Pod — backend (API + live updates + database).
 * Zero dependencies: run with Node 22.18+ / 24 (`node src/index.ts`, types are stripped natively).
 *
 *   pod ──USB──▶ Operations console in Chrome (Web Serial) ──HTTP POST──▶ this server ──SSE──▶ every screen
 *   pod ──USB──▶ tools/serial_bridge.py (alternative, no browser needed) ──HTTP POST──▶ this server
 *   pod ──WiFi uplink (optional firmware mode)──HTTP POST──▶ this server
 *   rescuer phones ──HTTP POST (GPS, status, SOS)──▶ this server
 *   everything is stored in SQLite: data/rescue-pod.db
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Detection, Reading } from "../../shared/types.ts";
import { Db } from "./db.ts";
import { parseReading } from "./logic.ts";
import { HttpError, Store, latLng } from "./store.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env["PORT"] ?? 4000);
const HOST = process.env["HOST"] ?? "0.0.0.0";
const DATA_DIR = process.env["DATA_DIR"] ?? path.join(here, "..", "data");
/** If set, pods/bridges must send this in the X-Pod-Key header. */
const POD_KEY = process.env["POD_KEY"] ?? "";

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "rescue-pod.db");
const db = new Db(DB_FILE);
const store = new Store(db, {
  name: process.env["SITE_NAME"] ?? "VIT Chennai — demo site",
  center: {
    lat: Number(process.env["SITE_LAT"] ?? 12.8406),
    lng: Number(process.env["SITE_LNG"] ?? 80.1534),
  },
  zoom: 18,
});
// Add example teams once, so the console isn't empty (delete them any time in the Teams tab).
if (store.s.teams.length === 0 && !db.getMeta("sample_teams_added")) {
  store.seedSampleTeams();
  db.setMeta("sample_teams_added", "1");
}

/* ---------------- live push (Server-Sent Events) ---------------- */

const streams = new Set<http.ServerResponse>();
let pushTimer: ReturnType<typeof setTimeout> | null = null;

function pushState() {
  const payload = `event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`;
  for (const res of streams) res.write(payload);
}

store.onChange(() => {
  // Coalesce bursts (a pod sends ~1.5 readings/s) into at most 5 pushes/s.
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushState();
  }, 200);
});

// Heartbeat keeps proxies from closing idle streams and refreshes clients' "now" for staleness checks.
setInterval(pushState, 5000).unref();

/* ---------------- helpers ---------------- */

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(type === "application/json" ? JSON.stringify(body) : String(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function csvCell(v: unknown) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function detectionsCsv(rows: Detection[]) {
  const head = [
    "id", "first_seen", "last_seen", "pod", "tier", "thermal", "signal", "fire", "lat", "lng",
    "peak_obj_c", "ambient_c", "max_rssi_dbm", "hits", "status", "assigned_team", "label", "notes",
  ];
  const teamName = (id: string | null) => (id ? (store.s.teams.find((t) => t.id === id)?.name ?? id) : "");
  const body = rows.map((d) =>
    [
      d.id, new Date(d.firstSeen).toISOString(), new Date(d.lastSeen).toISOString(), d.podId, d.tier,
      d.thermal, d.signal, d.fire, d.position?.lat.toFixed(6), d.position?.lng.toFixed(6),
      d.peakObjC?.toFixed(2), d.ambC?.toFixed(2), d.maxRssi, d.hits, d.status,
      teamName(d.assignedTeamId), d.label, d.notes,
    ].map(csvCell).join(","),
  );
  return [head.join(","), ...body].join("\n");
}

function logCsv() {
  const rows = store.fullLog().map((l) =>
    [new Date(l.t).toISOString(), l.kind, l.text, l.detectionId, l.areaId, l.teamId, l.podId].map(csvCell).join(","),
  );
  return ["time,kind,text,detection,area,team,pod", ...rows].join("\n");
}

/* ---------------- routes ---------------- */

type Handler = (ctx: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: string[];
  body: () => Promise<Record<string, unknown>>;
  actor: string;
}) => unknown | Promise<unknown>;

const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/health$/, () => ({ ok: true, session: store.s.sessionId })],
  ["GET", /^\/api\/state$/, () => store.snapshot()],

  ["GET", /^\/api\/stream$/, ({ req, res }) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return undefined; // keep the response open
  }],

  ["GET", /^\/api\/export\/detections\.csv$/, ({ res }) => {
    res.setHeader("Content-Disposition", `attachment; filename="detections-${store.s.sessionId}.csv"`);
    send(res, 200, detectionsCsv(store.s.detections), "text/csv");
  }],
  ["GET", /^\/api\/export\/log\.csv$/, ({ res }) => {
    res.setHeader("Content-Disposition", `attachment; filename="log-${store.s.sessionId}.csv"`);
    send(res, 200, logCsv(), "text/csv");
  }],
  ["GET", /^\/api\/export\/readings\.csv$/, ({ res }) => {
    res.setHeader("Content-Disposition", `attachment; filename="readings-${store.s.sessionId}.csv"`);
    send(res, 200, store.db.readingsCsv(store.s.sessionId), "text/csv");
  }],
  ["GET", /^\/api\/sessions$/, () => store.db.listSessions()],
  ["GET", /^\/api\/export\/session\.json$/, ({ res }) => {
    res.setHeader("Content-Disposition", `attachment; filename="session-${store.s.sessionId}.json"`);
    send(res, 200, { ...store.snapshot(), log: store.fullLog() });
  }],

  // Pod readings — from the browser's USB connection, the serial bridge, the simulator, or WiFi uplink.
  ["POST", /^\/api\/pods\/([\w-]{1,24})\/readings$/, async ({ req, params, body }) => {
    if (POD_KEY && req.headers["x-pod-key"] !== POD_KEY) throw new HttpError(401, "bad pod key");
    const raw = await body();
    const list: unknown[] = Array.isArray(raw) ? raw : [raw];
    const now = Date.now();
    const podId = params[0]!;
    const readings = list
      .map((r) => parseReading(r, podId, now))
      .filter((r): r is Reading => r !== null);
    const link = String(req.headers["x-pod-link"] ?? "wifi").slice(0, 16);
    store.ingest(podId, readings, link);
    return { accepted: readings.length };
  }],
  ["PATCH", /^\/api\/pods\/([\w-]{1,24})$/, async ({ params, body }) => store.updatePod(params[0]!, await body())],
  // Live pod position from the laptop it's plugged into, or a phone running the tracker page.
  ["POST", /^\/api\/pods\/([\w-]{1,24})\/position$/, async ({ params, body }) => {
    const b = await body();
    return store.setPodPosition(params[0]!, {
      ...latLng(b),
      accuracyM: typeof b["accuracyM"] === "number" ? b["accuracyM"] : null,
      source: String(b["source"] ?? "laptop"),
    });
  }],
  ["POST", /^\/api\/pods\/([\w-]{1,24})\/trail\/clear$/, ({ params }) => {
    store.clearTrail(params[0]!);
    return { ok: true };
  }],
  ["POST", /^\/api\/demo$/, () => {
    store.loadSampleData();
    return { ok: true };
  }],
  ["DELETE", /^\/api\/pods\/([\w-]{1,24})$/, ({ params }) => {
    store.deletePod(params[0]!);
    return { ok: true };
  }],

  ["POST", /^\/api\/teams$/, async ({ body }) => {
    const b = await body();
    return store.createTeam(String(b["name"] ?? ""), String(b["members"] ?? ""));
  }],
  ["PATCH", /^\/api\/teams\/(\w+)$/, async ({ params, body }) => store.updateTeam(params[0]!, await body())],
  ["DELETE", /^\/api\/teams\/(\w+)$/, ({ params }) => {
    store.deleteTeam(params[0]!);
    return { ok: true };
  }],
  ["POST", /^\/api\/teams\/(\w+)\/position$/, async ({ params, body }) => {
    const b = await body();
    return store.setTeamPosition(params[0]!, {
      ...latLng(b),
      accuracyM: typeof b["accuracyM"] === "number" ? b["accuracyM"] : null,
      source: String(b["source"] ?? "gps"),
    });
  }],
  ["POST", /^\/api\/teams\/(\w+)\/sos$/, async ({ params, body }) => {
    const b = await body();
    return store.sos(params[0]!, b["active"] !== false);
  }],

  ["PATCH", /^\/api\/detections\/([\w-]+)$/, async ({ params, body, actor }) =>
    store.updateTarget("detection", params[0]!, await body(), actor)],
  ["PATCH", /^\/api\/areas\/([\w-]+)$/, async ({ params, body, actor }) =>
    store.updateTarget("area", params[0]!, await body(), actor)],
  ["POST", /^\/api\/areas$/, async ({ body }) => {
    const b = await body();
    return store.createArea(
      b["kind"] === "hazard" ? "hazard" : "search",
      latLng(b["center"]),
      Number(b["radiusM"] ?? 15),
      String(b["label"] ?? ""),
    );
  }],
  ["DELETE", /^\/api\/areas\/([\w-]+)$/, ({ params }) => {
    store.deleteArea(params[0]!);
    return { ok: true };
  }],

  ["PATCH", /^\/api\/site$/, async ({ body }) => {
    store.updateSite(await body());
    return store.s.site;
  }],
  ["POST", /^\/api\/session\/reset$/, () => {
    store.resetSession();
    return { session: store.s.sessionId };
  }],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Actor,X-Pod-Key,X-Pod-Link",
    });
    return res.end();
  }
  for (const [method, re, handler] of routes) {
    if (method !== req.method) continue;
    const m = re.exec(url.pathname);
    if (!m) continue;
    try {
      let cached: Record<string, unknown> | undefined;
      const result = await handler({
        req,
        res,
        params: m.slice(1),
        body: async () => (cached ??= (await readBody(req)) as Record<string, unknown>),
        actor: String(req.headers["x-actor"] ?? "operator").slice(0, 40),
      });
      if (!res.headersSent && result !== undefined) send(res, 200, result);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: (e as Error).message });
    }
    return;
  }
  send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, HOST, () => {
  console.log(`Backend on http://${HOST}:${PORT}  (session ${store.s.sessionId}, database ${DB_FILE})`);
  if (POD_KEY) console.log("Pod key required for /api/pods/*/readings");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    store.close();
    process.exit(0);
  });
}
