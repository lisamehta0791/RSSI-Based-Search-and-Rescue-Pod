import type {
  Area,
  AppState,
  Detection,
  LatLng,
  Pod,
  TargetStatus,
  Team,
  TeamStatus,
  Tier,
} from "@shared/types";

export type * from "@shared/types";

/* ---------------- tiers (decision priority) ---------------- */

export const TIER_ORDER: Record<Tier, number> = { VERY_HIGH: 0, HIGH: 1, LOW: 2, NONE: 3 };

export const TIER_LABEL: Record<Tier, string> = {
  VERY_HIGH: "Very high",
  HIGH: "High",
  LOW: "Low",
  NONE: "None",
};

export const TIER_MEANING: Record<Tier, string> = {
  VERY_HIGH: "Body heat AND phone signal at the same spot — strongest evidence of a survivor.",
  HIGH: "Body heat with no phone signal — phone may be lost or dead. Treat as a person.",
  LOW: "Phone signal only, no body-heat confirmation — could be a dropped phone.",
  NONE: "Nothing on either sensor — not reported.",
};

export const TIER_HEX: Record<Tier, string> = {
  VERY_HIGH: "#dc2626",
  HIGH: "#d97706",
  LOW: "#2563eb",
  NONE: "#6b7280",
};

export const FIRE_HEX = "#ea580c";

/* ---------------- target / team status ---------------- */

export const STATUS_LABEL: Record<TargetStatus, string> = {
  OPEN: "Not assigned",
  ASSIGNED: "Assigned",
  EN_ROUTE: "En route",
  ON_SCENE: "On scene",
  RESCUED: "Rescued",
  NOTHING_FOUND: "Nothing found",
  DISMISSED: "Dismissed",
};

export const TEAM_STATUS_LABEL: Record<TeamStatus, string> = {
  AVAILABLE: "Available",
  ASSIGNED: "Assigned",
  EN_ROUTE: "En route",
  ON_SCENE: "On scene",
  SOS: "SOS",
};

export const STATUS_HEX: Record<TargetStatus, string> = {
  OPEN: "#6b7280",
  ASSIGNED: "#7c3aed",
  EN_ROUTE: "#0891b2",
  ON_SCENE: "#0d9488",
  RESCUED: "#16a34a",
  NOTHING_FOUND: "#64748b",
  DISMISSED: "#94a3b8",
};

export const ACTIVE_STATUSES: TargetStatus[] = ["OPEN", "ASSIGNED", "EN_ROUTE", "ON_SCENE"];

export const TEAM_STATUS_HEX: Record<TeamStatus, string> = {
  AVAILABLE: "#16a34a",
  ASSIGNED: "#7c3aed",
  EN_ROUTE: "#0891b2",
  ON_SCENE: "#0d9488",
  SOS: "#dc2626",
};

export const OK_HEX = "#16a34a";
export const WARN_HEX = "#d97706";

/* ---------------- staleness ---------------- */

/** A pod that hasn't reported for this long is shown offline. */
export const POD_OFFLINE_MS = 5_000;
/** A team whose phone hasn't reported a position for this long is flagged — possible trouble. */
export const TEAM_STALE_MS = 60_000;

export function podOnline(p: Pod, now: number) {
  return p.lastSeen !== null && now - p.lastSeen < POD_OFFLINE_MS;
}

export function teamStale(t: Team, now: number) {
  return !t.position || now - t.position.t > TEAM_STALE_MS;
}

/** Same rule as the backend: tracked device > carrying team's GPS > operator's click. */
export function podPosition(p: Pod, teams: Team[]): LatLng | null {
  if (p.locationMode === "carried" && p.carrierTeamId) {
    const t = teams.find((x) => x.id === p.carrierTeamId);
    if (t?.position) return t.position;
  }
  if (p.locationMode === "tracked" && p.trackedPosition) return p.trackedPosition;
  return p.manualPosition;
}

export const TRACK_SOURCE_LABEL = {
  laptop: "laptop location",
  phone: "phone GPS",
  "pod-gps": "pod GPS module",
} as const;

/* ---------------- targets (things a team can be sent to) ---------------- */

export type Target =
  | { kind: "detection"; id: string; item: Detection; position: LatLng | null }
  | { kind: "area"; id: string; item: Area; position: LatLng };

export function targetsForTeam(s: AppState, teamId: string): Target[] {
  const ds: Target[] = s.detections
    .filter((d) => d.assignedTeamId === teamId)
    .map((d) => ({ kind: "detection", id: d.id, item: d, position: d.position }));
  const as: Target[] = s.areas
    .filter((a) => a.assignedTeamId === teamId)
    .map((a) => ({ kind: "area", id: a.id, item: a, position: a.center }));
  return [...ds, ...as];
}

export function rankDetections(ds: Detection[]): Detection[] {
  const active = (d: Detection) => (ACTIVE_STATUSES.includes(d.status) ? 0 : 1);
  return [...ds].sort(
    (a, b) =>
      active(a) - active(b) ||
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      Number(b.fire || b.smoke) - Number(a.fire || a.smoke) ||
      b.lastSeen - a.lastSeen,
  );
}

/* ---------------- geo ---------------- */

export function haversine(a: LatLng, b: LatLng) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Initial compass bearing from a to b, degrees clockwise from north. */
export function bearing(a: LatLng, b: LatLng) {
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function cardinal(deg: number) {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(deg / 45) % 8]!;
}

/**
 * Shortest distance (m) from point p to the straight segment a→b, using a local flat projection
 * (fine at disaster-site scale). Used to warn when the direct route crosses a hazard.
 */
export function distanceToSegment(p: LatLng, a: LatLng, b: LatLng) {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const ky = 110_540;
  const ax = 0;
  const ay = 0;
  const bx = (b.lng - a.lng) * kx;
  const by = (b.lat - a.lat) * ky;
  const px = (p.lng - a.lng) * kx;
  const py = (p.lat - a.lat) * ky;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

/** Hazard zones that the straight line from `from` to `to` passes through. */
export function hazardsOnRoute(areas: Area[], from: LatLng, to: LatLng) {
  return areas.filter(
    (a) => a.kind === "hazard" && distanceToSegment(a.center, from, to) <= a.radiusM,
  );
}

/* ---------------- formatting ---------------- */

export function fmtDistance(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

export function fmtTime(t: number) {
  return new Date(t).toLocaleTimeString("en-GB", { hour12: false });
}

export function fmtAgo(ms: number) {
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

export function fmtLL(p: LatLng | null) {
  return p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : "not placed";
}

/** Walking ETA over rubble at ~1 m/s. */
export function fmtEta(m: number) {
  const s = Math.round(m / 1.0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ---------------- team identity colours ---------------- */

// Distinct from the priority colours (red / amber / blue) so a team is never mistaken for a tier.
const TEAM_PALETTE = [
  "#7c3aed",
  "#0d9488",
  "#db2777",
  "#4f46e5",
  "#65a30d",
  "#0891b2",
  "#a16207",
  "#be185d",
];

/** Stable colour per team (T1 is always the same colour). */
export function teamColor(teamId: string) {
  const n = Number(teamId.replace(/\D/g, "")) || 1;
  return TEAM_PALETTE[(n - 1) % TEAM_PALETTE.length]!;
}

export interface TeamOption {
  team: Team;
  distanceM: number | null;
  free: boolean;
  /** number of unfinished tasks */
  load: number;
}

/** Teams ranked for sending to `target`: free teams first, then nearest; SOS teams last. */
export function rankTeamsFor(s: AppState, target: LatLng | null): TeamOption[] {
  return s.teams
    .map((team) => {
      const load = targetsForTeam(s, team.id).filter((x) =>
        ACTIVE_STATUSES.includes(x.item.status),
      ).length;
      return {
        team,
        load,
        free: load === 0 && team.status !== "SOS",
        distanceM: team.position && target ? haversine(team.position, target) : null,
      };
    })
    .sort(
      (a, b) =>
        Number(a.team.status === "SOS") - Number(b.team.status === "SOS") ||
        Number(b.free) - Number(a.free) ||
        (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9),
    );
}
