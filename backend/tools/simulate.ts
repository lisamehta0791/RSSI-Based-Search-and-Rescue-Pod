/**
 * Demo / test driver — stands in for the pod (and optionally for rescuers' phones).
 *
 *   npm run sim                      fake POD-SIM walks around the site sending readings + live position
 *   npm run sim -- --teams           also walk every assigned team toward its target
 *   npm run sim -- --server http://192.168.1.20:4000 --pod POD-01
 *
 * Readings use the exact JSON the firmware prints, so this exercises the real ingest path.
 */
import type { AppState, LatLng } from "../../shared/types.ts";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const SERVER = opt("server", "http://localhost:4000");
const POD = opt("pod", "POD-SIM");
const MOVE_TEAMS = args.includes("--teams");
const SCENE_EVERY_MS = Number(opt("scene", "8000"));

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${SERVER}${p}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Actor": "simulator", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<unknown>;
}

const state = () => api("GET", "/api/state") as Promise<AppState>;

function jitter(c: LatLng, meters: number): LatLng {
  const dLat = ((Math.random() - 0.5) * 2 * meters) / 111_320;
  const dLng = ((Math.random() - 0.5) * 2 * meters) / (111_320 * Math.cos((c.lat * Math.PI) / 180));
  return { lat: c.lat + dLat, lng: c.lng + dLng };
}

/** What the pod is "pointed at" at each spot. Weighted so every tier shows up. */
type Scene = "person+phone" | "person" | "phone" | "empty" | "fire" | "person+fire";
const SCENES: [Scene, number][] = [
  ["person+phone", 0.22],
  ["person", 0.16],
  ["phone", 0.2],
  ["empty", 0.3],
  ["fire", 0.07],
  ["person+fire", 0.05],
];
function pickScene(): Scene {
  let r = Math.random();
  for (const [s, w] of SCENES) if ((r -= w) <= 0) return s;
  return "empty";
}

let seq = 0;
let scene: Scene = "empty";

function reading() {
  seq += 1;
  const amb = 27 + Math.random() * 2;
  const person = scene.startsWith("person");
  const phone = scene.includes("phone");
  const fire = scene.includes("fire");
  // A real pod flickers: a burst of probe requests isn't heard every window.
  const signal = phone && Math.random() < 0.8;
  const obj = person ? 32 + Math.random() * 3.5 : fire && !person ? 60 + Math.random() * 80 : amb + Math.random();
  const thermal = obj >= 30 && obj <= 38 && obj - amb >= 2.5;
  return {
    pod: POD,
    seq,
    up: seq * 700,
    mlx: 1,
    obj: Number(obj.toFixed(2)),
    amb: Number(amb.toFixed(2)),
    thermal: thermal ? 1 : 0,
    rssi: signal ? Math.round(-45 - Math.random() * 22) : Math.round(-80 - Math.random() * 15),
    probes: signal ? 1 + Math.floor(Math.random() * 6) : 0,
    signal: signal ? 1 : 0,
    // Like the real pod: MQ gas sensor on A0 (smoke), no flame sensor.
    smoke: fire ? 1 : 0,
    gas: fire ? 380 + Math.round(Math.random() * 80) : 95 + Math.round(Math.random() * 10),
    gasBase: 100,
    flame: -1,
  };
}

/** The pod walks a slow loop (~80 m across) around the site centre, like a rescuer carrying it. */
let angle = 0;
let centre: LatLng | null = null;
async function walk() {
  centre ??= (await state()).site.center;
  angle += 0.025; // ~1 m/s, walking pace
  const r = 40 + 15 * Math.sin(angle * 3);
  const pos = {
    lat: centre.lat + (r * Math.cos(angle)) / 111_320,
    lng: centre.lng + (r * Math.sin(angle)) / (111_320 * Math.cos((centre.lat * Math.PI) / 180)),
  };
  await api("POST", `/api/pods/${POD}/position`, { ...pos, accuracyM: 8, source: "phone" });
}

/** Alternate "something found" and "nothing here" so each find becomes its own entry. */
let quiet = false;
function nextScene() {
  quiet = !quiet;
  scene = quiet ? "empty" : pickScene();
  console.log(`[sim] scene: ${scene}`);
}

async function moveTeams() {
  const s = await state();
  for (const t of s.teams) {
    const target =
      s.detections.find((d) => d.assignedTeamId === t.id && ["ASSIGNED", "EN_ROUTE"].includes(d.status) && d.position)
        ?.position ??
      s.areas.find((a) => a.assignedTeamId === t.id && ["ASSIGNED", "EN_ROUTE"].includes(a.status))?.center;
    const from = t.position ?? jitter(s.site.center, 120);
    let next = from;
    if (target) {
      const dLat = target.lat - from.lat;
      const dLng = target.lng - from.lng;
      const distDeg = Math.hypot(dLat, dLng);
      const step = 1.5 / 111_320; // ~1.5 m per tick — walking pace over rubble
      next = distDeg <= step ? target : { lat: from.lat + (dLat / distDeg) * step, lng: from.lng + (dLng / distDeg) * step };
    } else if (t.position) {
      continue; // idle teams with a position stay put
    }
    await api("POST", `/api/teams/${t.id}/position`, { ...next, accuracyM: 6, source: "sim" });
  }
}

async function main() {
  console.log(`[sim] sending ${POD} readings to ${SERVER}${MOVE_TEAMS ? " (moving teams too)" : ""}`);
  await walk();
  nextScene();
  setInterval(() => walk().catch((e) => console.error("[sim]", e.message)), 1000);
  setInterval(nextScene, SCENE_EVERY_MS / 2);
  setInterval(() => {
    api("POST", `/api/pods/${POD}/readings`, reading(), { "X-Pod-Link": "sim" }).catch((e) =>
      console.error("[sim]", e.message),
    );
  }, 700);
  if (MOVE_TEAMS) setInterval(() => moveTeams().catch((e) => console.error("[sim]", e.message)), 1000);
}

main().catch((e) => {
  console.error("[sim] cannot reach server:", e.message);
  process.exit(1);
});
