import type {
  AppState,
  Area,
  AreaKind,
  Detection,
  LatLng,
  LogEntry,
  Pod,
  PodLocationMode,
  Reading,
  SiteConfig,
  TargetStatus,
  Team,
  TeamPosition,
  TeamStatus,
  TrackSource,
} from "../../shared/types.ts";
import { TIER_RANK, betterTier, haversine } from "./logic.ts";
import type { Db, SessionData } from "./db.ts";

/**
 * One detection = one continuous "event". Consecutive detecting readings belong to the same
 * entry; once the pod goes quiet for longer than this (or moves), the next detection is a
 * NEW entry. Example: hand in front of the sensor, away, back again -> 2 entries.
 */
const EVENT_GAP_MS = 2_500;
/** ...and the event also ends if the pod moved more than this. */
const MERGE_RADIUS_M = 8;
/** Don't repeat the "fire but pod position unknown" log line more often than this. */
const FIRE_LOG_THROTTLE_MS = 20_000;
/** Pod trail: add a point when the pod moved this far, keep this many points. */
const TRAIL_MIN_STEP_M = 2;
const TRAIL_MAX_POINTS = 400;
/** A flame reading within this distance of an existing hazard extends it instead of adding one. */
const HAZARD_MERGE_RADIUS_M = 12;
const HAZARD_DEFAULT_RADIUS_M = 8;
/** Snapshot carries only the newest log entries; the full log is in the database. */
const SNAPSHOT_LOG_LIMIT = 400;

const ACTIVE: TargetStatus[] = ["OPEN", "ASSIGNED", "EN_ROUTE", "ON_SCENE"];
const CLOSED: TargetStatus[] = ["RESCUED", "NOTHING_FOUND", "DISMISSED"];

type Persisted = SessionData;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function newSessionId() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function emptyState(site: SiteConfig, keep?: Pick<Persisted, "pods" | "teams">): Persisted {
  return {
    sessionId: newSessionId(),
    sessionStarted: Date.now(),
    site,
    pods: keep?.pods ?? [],
    teams: keep?.teams ?? [],
    detections: [],
    areas: [],
    log: [],
    counters: { detection: 0, area: 0, team: maxTeamNo(keep?.teams ?? []), log: 0 },
  };
}

export class Store {
  s: Persisted;
  db: Db;
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readingBuffer: Reading[] = [];
  private lastPodlessFireLog = new Map<string, number>();
  /** podId -> id of the detection event currently in progress */
  private currentEvent = new Map<string, string>();

  constructor(db: Db, site: SiteConfig) {
    this.db = db;
    const loaded = db.loadCurrent();
    if (loaded) {
      this.s = loaded;
      this.addLog("system", `Server restarted — resumed session ${this.s.sessionId}`);
    } else {
      this.s = emptyState(site);
      this.addLog("system", `Session ${this.s.sessionId} started`);
    }
    this.saveNow();
    setInterval(() => this.flushReadings(), 1000).unref();
  }

  /* ---------------- plumbing ---------------- */

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 500);
  }

  saveNow() {
    try {
      this.db.save(this.s);
    } catch (e) {
      console.error("database save failed:", (e as Error).message);
    }
  }

  /** Flush + save, for shutdown. */
  close() {
    this.flushReadings();
    this.saveNow();
    this.db.close();
  }

  private flushReadings() {
    if (!this.readingBuffer.length) return;
    const batch = this.readingBuffer;
    this.readingBuffer = [];
    try {
      this.db.insertReadings(this.s.sessionId, batch);
    } catch (e) {
      console.error("could not store readings:", (e as Error).message);
    }
  }

  snapshot(): AppState {
    const { counters: _c, log, ...rest } = this.s;
    return { ...rest, log: log.slice(-SNAPSHOT_LOG_LIMIT), now: Date.now() };
  }

  private addLog(kind: LogEntry["kind"], text: string, refs: Partial<LogEntry> = {}) {
    this.s.counters.log += 1;
    this.s.log.push({ ...refs, id: this.s.counters.log, t: Date.now(), kind, text });
  }

  /* ---------------- lookups ---------------- */

  pod(id: string) {
    const p = this.s.pods.find((x) => x.id === id);
    if (!p) throw new HttpError(404, `pod ${id} not found`);
    return p;
  }
  team(id: string) {
    const t = this.s.teams.find((x) => x.id === id);
    if (!t) throw new HttpError(404, `team ${id} not found`);
    return t;
  }
  detection(id: string) {
    const d = this.s.detections.find((x) => x.id === id);
    if (!d) throw new HttpError(404, `detection ${id} not found`);
    return d;
  }
  area(id: string) {
    const a = this.s.areas.find((x) => x.id === id);
    if (!a) throw new HttpError(404, `area ${id} not found`);
    return a;
  }

  private ensurePod(id: string): Pod {
    let p = this.s.pods.find((x) => x.id === id);
    if (!p) {
      p = {
        id,
        name: id,
        locationMode: "tracked",
        manualPosition: null,
        trackedPosition: null,
        trail: [],
        carrierTeamId: null,
        lastSeen: null,
        lastReading: null,
        link: null,
      };
      this.s.pods.push(p);
      this.addLog("pod", `${id} connected for the first time`, { podId: id });
    }
    return p;
  }

  /**
   * Where the pod is right now:
   *  tracked -> live position from the laptop / phone / GPS module moving with it (falls back to the last manual spot)
   *  carried -> live GPS of the team carrying it
   *  manual  -> where the operator clicked
   */
  podPosition(p: Pod): LatLng | null {
    if (p.locationMode === "carried" && p.carrierTeamId) {
      const t = this.s.teams.find((x) => x.id === p.carrierTeamId);
      if (t?.position) return { lat: t.position.lat, lng: t.position.lng };
    }
    if (p.locationMode === "tracked" && p.trackedPosition) {
      return { lat: p.trackedPosition.lat, lng: p.trackedPosition.lng };
    }
    return p.manualPosition;
  }

  private addTrail(p: Pod, pos: LatLng) {
    const last = p.trail.at(-1);
    if (last && haversine(last, pos) < TRAIL_MIN_STEP_M) return;
    p.trail.push({ lat: pos.lat, lng: pos.lng, t: Date.now() });
    if (p.trail.length > TRAIL_MAX_POINTS) p.trail.splice(0, p.trail.length - TRAIL_MAX_POINTS);
  }

  /* ---------------- pod readings ---------------- */

  ingest(podId: string, readings: Reading[], link: string) {
    if (!readings.length) return;
    const pod = this.ensurePod(podId);
    for (const r of readings) {
      this.readingBuffer.push(r);
      if (r.gps) this.trackPod(pod, { ...r.gps, accuracyM: null }, "pod-gps", false);
      this.applyReading(pod, r);
    }
    pod.link = link;
    pod.lastSeen = Date.now();
    pod.lastReading = readings[readings.length - 1]!;
    this.changed();
  }

  private applyReading(pod: Pod, r: Reading) {
    const pos = this.podPosition(pod);

    if (r.tier !== "NONE") {
      const now = r.t;
      const curId = this.currentEvent.get(pod.id);
      const cur = curId ? this.s.detections.find((d) => d.id === curId) : undefined;
      const continues = cur && now - cur.lastSeen <= EVENT_GAP_MS && samePlace(cur.position, pos);

      if (cur && continues) {
        const before = cur.tier;
        cur.tier = betterTier(cur.tier, r.tier);
        cur.thermal ||= r.thermal;
        cur.signal ||= r.signal;
        cur.fire ||= r.flame === true;
        cur.smoke ||= r.smoke === true;
        cur.lastSeen = now;
        cur.hits += 1;
        cur.maxRssi = Math.max(cur.maxRssi, r.rssi);
        if (r.thermal && r.objC !== null && (cur.peakObjC === null || r.objC > cur.peakObjC)) {
          cur.peakObjC = r.objC;
          cur.ambC = r.ambC;
        }
        if (TIER_RANK[cur.tier] > TIER_RANK[before]) {
          this.addLog("detection-upgrade", `${cur.id} upgraded ${before} → ${cur.tier}`, {
            detectionId: cur.id,
            podId: pod.id,
          });
        }
      } else {
        this.s.counters.detection += 1;
        const d: Detection = {
          id: `D-${String(this.s.counters.detection).padStart(3, "0")}`,
          podId: pod.id,
          firstSeen: now,
          lastSeen: now,
          position: pos,
          tier: r.tier,
          thermal: r.thermal,
          signal: r.signal,
          fire: r.flame === true,
          smoke: r.smoke === true,
          peakObjC: r.thermal ? r.objC : null,
          ambC: r.thermal ? r.ambC : null,
          maxRssi: r.rssi,
          hits: 1,
          label: "",
          notes: "",
          status: "OPEN",
          assignedTeamId: null,
        };
        this.s.detections.push(d);
        this.currentEvent.set(pod.id, d.id);
        const where = pos ? "" : " — pod location unknown";
        this.addLog("detection", `${d.id} ${d.tier.replace("_", " ")} from ${pod.id}${d.fire ? " (FIRE nearby)" : ""}${d.smoke ? " (SMOKE/GAS nearby)" : ""}${where}`, {
          detectionId: d.id,
          podId: pod.id,
        });
      }
    }

    if (r.flame === true) this.hazardAt(pod, pos, r.t, "fire");
    else if (r.smoke === true) this.hazardAt(pod, pos, r.t, "smoke");
  }

  /** Flame or gas sensor fired: mark a hazard zone where the pod is (one zone per spot). */
  private hazardAt(pod: Pod, pos: LatLng | null, now: number, what: "fire" | "smoke") {
    const name = what === "fire" ? "FIRE" : "SMOKE / GAS";
    if (!pos) {
      const last = this.lastPodlessFireLog.get(pod.id) ?? 0;
      if (now - last > FIRE_LOG_THROTTLE_MS) {
        this.lastPodlessFireLog.set(pod.id, now);
        this.addLog("hazard", `${name} detected by ${pod.id} — pod location unknown`, { podId: pod.id });
      }
      return;
    }
    const near = this.s.areas.find(
      (a) => a.kind === "hazard" && haversine(a.center, pos) <= Math.max(a.radiusM, HAZARD_MERGE_RADIUS_M),
    );
    if (near) return;
    const a =
      what === "fire"
        ? this.makeArea("hazard", pos, HAZARD_DEFAULT_RADIUS_M, `Fire (${pod.id})`, "flame-sensor")
        : this.makeArea("hazard", pos, HAZARD_DEFAULT_RADIUS_M, `Smoke / gas (${pod.id})`, "gas-sensor");
    this.addLog("hazard", `${name} hazard ${a.id} created from ${pod.id} ${what === "fire" ? "flame" : "gas"} sensor`, {
      areaId: a.id,
      podId: pod.id,
    });
  }

  /* ---------------- pods ---------------- */

  /** Live position from a device moving with the pod (laptop, phone tracker page, or GPS module). */
  trackPod(
    p: Pod,
    pos: { lat: number; lng: number; accuracyM: number | null },
    source: TrackSource,
    notify = true,
  ) {
    const ll = latLng(pos);
    const first = !p.trackedPosition || p.trackedPosition.source !== source;
    p.trackedPosition = { ...ll, accuracyM: pos.accuracyM, t: Date.now(), source };
    if (first) {
      const what = { laptop: "this laptop's location", phone: "a phone's GPS", "pod-gps": "its own GPS module" }[source];
      this.addLog("pod", `${p.id} is now tracked live using ${what}`, { podId: p.id });
      if (p.locationMode !== "carried") p.locationMode = "tracked";
    }
    if (p.locationMode === "tracked") this.addTrail(p, ll);
    if (notify) this.changed();
    return p;
  }

  setPodPosition(id: string, pos: { lat: number; lng: number; accuracyM?: number | null; source?: string }) {
    const p = this.ensurePod(id);
    const source: TrackSource = pos.source === "phone" ? "phone" : "laptop";
    return this.trackPod(p, { lat: pos.lat, lng: pos.lng, accuracyM: typeof pos.accuracyM === "number" ? pos.accuracyM : null }, source);
  }

  updatePod(
    id: string,
    patch: { name?: string; locationMode?: PodLocationMode; manualPosition?: LatLng | null; carrierTeamId?: string | null },
  ) {
    const p = this.ensurePod(id);
    const before = `${p.locationMode}:${p.carrierTeamId}`;
    if (patch.name !== undefined) p.name = String(patch.name).slice(0, 40) || id;
    if (patch.carrierTeamId !== undefined) {
      if (patch.carrierTeamId !== null) this.team(patch.carrierTeamId);
      p.carrierTeamId = patch.carrierTeamId;
    }
    if (patch.locationMode !== undefined) {
      const m = patch.locationMode;
      p.locationMode = m === "carried" || m === "tracked" ? m : "manual";
    }
    if (patch.manualPosition !== undefined) {
      p.manualPosition = patch.manualPosition ? latLng(patch.manualPosition) : null;
      if (p.manualPosition) {
        this.addTrail(p, p.manualPosition);
        this.addLog("pod", `${p.id} placed at ${fmtLL(p.manualPosition)}`, { podId: p.id });
      }
    }
    if (`${p.locationMode}:${p.carrierTeamId}` !== before) {
      const how =
        p.locationMode === "carried"
          ? `follows ${p.carrierTeamId ? this.team(p.carrierTeamId).name : "(no team)"}'s GPS`
          : p.locationMode === "tracked"
            ? "tracked live"
            : "placed manually";
      this.addLog("pod", `${p.id} location: ${how}`, { podId: p.id });
    }
    this.changed();
    return p;
  }

  /** Forget a pod (e.g. the simulator's POD-SIM). Its past detections stay in the log. */
  deletePod(id: string) {
    this.pod(id);
    this.s.pods = this.s.pods.filter((p) => p.id !== id);
    this.currentEvent.delete(id);
    this.addLog("pod", `${id} removed from the pod list`, { podId: id });
    this.changed();
  }

  clearTrail(id: string) {
    this.pod(id).trail = [];
    this.changed();
  }

  /* ---------------- teams ---------------- */

  createTeam(name: string, members: string) {
    this.s.counters.team += 1;
    const t: Team = {
      id: `T${this.s.counters.team}`,
      name: name.trim().slice(0, 40) || `Team ${this.s.counters.team}`,
      members: members.trim().slice(0, 200),
      status: "AVAILABLE",
      position: null,
      sosAt: null,
      createdAt: Date.now(),
    };
    this.s.teams.push(t);
    this.addLog("team", `${t.name} (${t.id}) registered`, { teamId: t.id });
    this.changed();
    return t;
  }

  updateTeam(id: string, patch: { name?: string; members?: string }) {
    const t = this.team(id);
    if (patch.name !== undefined) t.name = String(patch.name).trim().slice(0, 40) || t.name;
    if (patch.members !== undefined) t.members = String(patch.members).trim().slice(0, 200);
    this.changed();
    return t;
  }

  deleteTeam(id: string) {
    const t = this.team(id);
    for (const target of this.targetsOf(id)) {
      target.assignedTeamId = null;
      if (ACTIVE.includes(target.status)) target.status = "OPEN";
    }
    for (const p of this.s.pods) if (p.carrierTeamId === id) p.carrierTeamId = null;
    this.s.teams = this.s.teams.filter((x) => x.id !== id);
    this.addLog("team", `${t.name} (${t.id}) removed — its targets returned to OPEN`, { teamId: id });
    this.changed();
  }

  setTeamPosition(id: string, pos: { lat: number; lng: number; accuracyM?: number | null; source?: string }) {
    const t = this.team(id);
    const ll = latLng(pos);
    const source: TeamPosition["source"] = pos.source === "manual" || pos.source === "sim" ? pos.source : "gps";
    t.position = { ...ll, accuracyM: typeof pos.accuracyM === "number" ? pos.accuracyM : null, t: Date.now(), source };
    for (const p of this.s.pods) if (p.locationMode === "carried" && p.carrierTeamId === t.id) this.addTrail(p, ll);
    this.changed();
    return t;
  }

  sos(id: string, active: boolean) {
    const t = this.team(id);
    if (active) {
      t.sosAt = Date.now();
      t.status = "SOS";
      const where = t.position ? ` at ${fmtLL(t.position)}` : " — no position on record";
      this.addLog("sos", `SOS from ${t.name}${where}`, { teamId: id });
    } else {
      t.sosAt = null;
      t.status = "AVAILABLE";
      this.refreshTeamStatus(t);
      this.addLog("sos", `SOS for ${t.name} cleared`, { teamId: id });
    }
    this.changed();
    return t;
  }

  private targetsOf(teamId: string): (Detection | Area)[] {
    return [...this.s.detections, ...this.s.areas].filter((x) => x.assignedTeamId === teamId);
  }

  /** Team status follows its most advanced active target, unless it has raised SOS. */
  private refreshTeamStatus(t: Team) {
    if (t.status === "SOS") return;
    const statuses = this.targetsOf(t.id).map((x) => x.status);
    const order: [TargetStatus, TeamStatus][] = [
      ["ON_SCENE", "ON_SCENE"],
      ["EN_ROUTE", "EN_ROUTE"],
      ["ASSIGNED", "ASSIGNED"],
    ];
    t.status = order.find(([s]) => statuses.includes(s))?.[1] ?? "AVAILABLE";
  }

  /* ---------------- detections & areas (targets) ---------------- */

  private target(kind: "detection" | "area", id: string): Detection | Area {
    return kind === "detection" ? this.detection(id) : this.area(id);
  }

  updateTarget(
    kind: "detection" | "area",
    id: string,
    patch: {
      status?: TargetStatus;
      assignedTeamId?: string | null;
      label?: string;
      notes?: string;
      position?: LatLng;
      radiusM?: number;
    },
    actor: string,
  ) {
    const x = this.target(kind, id);
    const touched = new Set<string>();
    if (x.assignedTeamId) touched.add(x.assignedTeamId);

    if (kind === "area" && (x as Area).kind === "hazard" && (patch.assignedTeamId || patch.status)) {
      throw new HttpError(400, "hazard zones are warnings and cannot be assigned");
    }

    if (patch.assignedTeamId !== undefined && patch.assignedTeamId !== x.assignedTeamId) {
      if (patch.assignedTeamId === null) {
        this.addLog("assignment", `${id} unassigned by ${actor}`, refsFor(kind, id));
        x.assignedTeamId = null;
        if (ACTIVE.includes(x.status)) x.status = "OPEN";
      } else {
        const t = this.team(patch.assignedTeamId);
        x.assignedTeamId = t.id;
        // A newly assigned team starts from the beginning, even if the previous team was already en route.
        x.status = "ASSIGNED";
        touched.add(t.id);
        this.addLog("assignment", `${id} assigned to ${t.name} by ${actor}`, { ...refsFor(kind, id), teamId: t.id });
      }
    }

    if (patch.status !== undefined && patch.status !== x.status) {
      const valid: TargetStatus[] = [...ACTIVE, ...CLOSED];
      if (!valid.includes(patch.status)) throw new HttpError(400, `bad status ${patch.status}`);
      x.status = patch.status;
      if (patch.status === "OPEN" && x.assignedTeamId) x.status = "ASSIGNED";
      const team = x.assignedTeamId ? this.s.teams.find((t) => t.id === x.assignedTeamId) : undefined;
      this.addLog("status", `${id} → ${x.status} (${actor})`, { ...refsFor(kind, id), teamId: team?.id });
    }

    if (patch.label !== undefined) x.label = String(patch.label).slice(0, 60);
    if (patch.notes !== undefined && kind === "detection") (x as Detection).notes = String(patch.notes).slice(0, 500);
    if (patch.position !== undefined) {
      const ll = latLng(patch.position);
      if (kind === "detection") (x as Detection).position = ll;
      else (x as Area).center = ll;
      this.addLog("status", `${id} moved to ${fmtLL(ll)} (${actor})`, refsFor(kind, id));
    }
    if (patch.radiusM !== undefined && kind === "area") {
      (x as Area).radiusM = clamp(Number(patch.radiusM) || HAZARD_DEFAULT_RADIUS_M, 2, 500);
    }

    for (const tid of touched) {
      const t = this.s.teams.find((tt) => tt.id === tid);
      if (t) this.refreshTeamStatus(t);
    }
    this.changed();
    return x;
  }

  private makeArea(kind: AreaKind, center: LatLng, radiusM: number, label: string, source: Area["source"]) {
    this.s.counters.area += 1;
    const a: Area = {
      id: `A-${String(this.s.counters.area).padStart(2, "0")}`,
      kind,
      label: label.slice(0, 60),
      center: latLng(center),
      radiusM: clamp(radiusM, 2, 500),
      source,
      status: "OPEN",
      assignedTeamId: null,
      createdAt: Date.now(),
    };
    this.s.areas.push(a);
    return a;
  }

  createArea(kind: AreaKind, center: LatLng, radiusM: number, label: string) {
    const k: AreaKind = kind === "hazard" ? "hazard" : "search";
    const a = this.makeArea(k, center, Number(radiusM) || 15, label || (k === "hazard" ? "Hazard" : "Search area"), "operator");
    this.addLog(k === "hazard" ? "hazard" : "status", `${k === "hazard" ? "Hazard" : "Search area"} ${a.id} "${a.label}" marked by operator`, {
      areaId: a.id,
    });
    this.changed();
    return a;
  }

  deleteArea(id: string) {
    const a = this.area(id);
    this.s.areas = this.s.areas.filter((x) => x.id !== id);
    this.addLog("status", `${a.kind === "hazard" ? "Hazard" : "Area"} ${id} removed`, { areaId: id });
    if (a.assignedTeamId) {
      const t = this.s.teams.find((x) => x.id === a.assignedTeamId);
      if (t) this.refreshTeamStatus(t);
    }
    this.changed();
  }

  /* ---------------- session ---------------- */

  updateSite(patch: Partial<SiteConfig>) {
    if (patch.name !== undefined) this.s.site.name = String(patch.name).slice(0, 60);
    if (patch.center !== undefined) this.s.site.center = latLng(patch.center);
    if (patch.zoom !== undefined) this.s.site.zoom = clamp(Number(patch.zoom) || 17, 3, 20);
    this.changed();
  }

  /** Close the current session (it stays in the database) and start a fresh one. Teams and pods are kept. */
  resetSession() {
    this.flushReadings();
    this.saveNow();
    this.db.endSession(this.s.sessionId);
    const pods = this.s.pods.map((p) => ({ ...p, lastReading: null, trail: [] }));
    this.currentEvent.clear();
    const teams = this.s.teams.map((t) => ({ ...t, status: "AVAILABLE" as const, sosAt: null }));
    const old = this.s.sessionId;
    this.s = emptyState(this.s.site, { pods, teams });
    this.addLog("system", `Session ${this.s.sessionId} started (previous ${old} kept in the database)`);
    this.changed();
  }

  fullLog() {
    return this.s.log;
  }

  /* ---------------- sample data ---------------- */

  /** A point `north` / `east` metres from the site centre. */
  private offset(north: number, east: number): LatLng {
    const c = this.s.site.center;
    return {
      lat: c.lat + north / 111_320,
      lng: c.lng + east / (111_320 * Math.cos((c.lat * Math.PI) / 180)),
    };
  }

  /** Three example rescue teams, standing near the site centre. Used on the very first start. */
  seedSampleTeams() {
    const teams: [string, string, number, number][] = [
      ["Alpha", "Ravi Kumar, Meena S", -70, -50],
      ["Bravo", "Arjun P, Divya R", 50, -80],
      ["Charlie", "Karthik V, Sneha M", -40, 90],
    ];
    for (const [name, members, n, e] of teams) {
      const t = this.createTeam(name, members);
      t.position = { ...this.offset(n, e), accuracyM: null, t: Date.now(), source: "manual" };
    }
    this.addLog("system", "Sample teams Alpha, Bravo and Charlie added — edit or remove them in the Teams tab");
    this.changed();
  }

  /** Example detections, zones and an assignment so every screen has something to show. */
  loadSampleData() {
    if (this.s.teams.length === 0) this.seedSampleTeams();
    const now = Date.now();
    const samples: [Detection["tier"], boolean, boolean, boolean, number, number, string][] = [
      ["VERY_HIGH", true, true, false, 35, 20, "SAMPLE · Block A, ground floor"],
      ["HIGH", true, false, false, -25, 60, "SAMPLE · Library stairwell"],
      ["HIGH", true, false, true, 10, -45, "SAMPLE · Canteen kitchen (fire nearby)"],
      ["LOW", false, true, false, 60, 40, "SAMPLE · Parking lot"],
      ["VERY_HIGH", true, true, false, -55, -15, "SAMPLE · Hostel corridor"],
    ];
    const ids: string[] = [];
    samples.forEach(([tier, thermal, signal, fire, n, e, label], i) => {
      this.s.counters.detection += 1;
      const d: Detection = {
        id: `D-${String(this.s.counters.detection).padStart(3, "0")}`,
        podId: "SAMPLE",
        firstSeen: now - (samples.length - i) * 60_000,
        lastSeen: now - (samples.length - i) * 60_000 + 8_000,
        position: this.offset(n, e),
        tier,
        thermal,
        signal,
        fire,
        smoke: false,
        peakObjC: thermal ? 33.5 + i * 0.4 : null,
        ambC: thermal ? 28.1 : null,
        maxRssi: signal ? -52 - i * 3 : -127,
        hits: 6 + i * 3,
        label,
        notes: "",
        status: "OPEN",
        assignedTeamId: null,
      };
      this.s.detections.push(d);
      ids.push(d.id);
      this.addLog("detection", `${d.id} ${tier.replace("_", " ")} (sample)`, { detectionId: d.id });
    });
    const fire = this.makeArea("hazard", this.offset(14, -52), 12, "SAMPLE · Kitchen fire", "operator");
    this.addLog("hazard", `Hazard ${fire.id} "${fire.label}" (sample)`, { areaId: fire.id });
    const area = this.makeArea("search", this.offset(-10, 120), 25, "SAMPLE · Admin block, floor 1", "operator");
    this.addLog("status", `Search area ${area.id} "${area.label}" (sample)`, { areaId: area.id });

    const alpha = this.s.teams[0];
    if (alpha && ids[0]) {
      this.updateTarget("detection", ids[0], { assignedTeamId: alpha.id }, "sample data");
      this.updateTarget("detection", ids[0], { status: "EN_ROUTE" }, alpha.name);
    }
    this.changed();
  }
}

/** Next team number must not reuse an id still in use (T1, T3 kept -> next is T4). */
function maxTeamNo(teams: Team[]) {
  return teams.reduce((m, t) => Math.max(m, Number(t.id.replace(/^T/, "")) || 0), 0);
}

function samePlace(a: LatLng | null, b: LatLng | null) {
  if (!a || !b) return a === b;
  return haversine(a, b) <= MERGE_RADIUS_M;
}

function refsFor(kind: "detection" | "area", id: string): Partial<LogEntry> {
  return kind === "detection" ? { detectionId: id } : { areaId: id };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}

export function latLng(v: unknown): LatLng {
  const o = v as Record<string, unknown> | null;
  const lat = Number(o?.["lat"]);
  const lng = Number(o?.["lng"]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new HttpError(400, "expected {lat, lng}");
  }
  return { lat, lng };
}

function fmtLL(p: LatLng) {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}
