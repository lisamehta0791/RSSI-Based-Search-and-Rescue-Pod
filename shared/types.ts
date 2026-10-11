/**
 * Data model shared by the server and the dashboard (type-only — no runtime code here).
 * The server is the single source of truth; the dashboard renders snapshots of `AppState`.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** Decision priority from the two-sensor logic (fire is a separate hazard tag, never a tier). */
export type Tier = "VERY_HIGH" | "HIGH" | "LOW" | "NONE";

/** One sensing window from the pod, exactly as the firmware reports it (plus server time). */
export interface Reading {
  podId: string;
  seq: number;
  /** server receive time, epoch ms */
  t: number;
  /** pod uptime ms when the reading was taken */
  up: number;
  mlxOk: boolean;
  objC: number | null;
  ambC: number | null;
  thermal: boolean;
  signal: boolean;
  /** strongest qualifying WiFi frame in the window, dBm (-127 = none heard) */
  rssi: number;
  /** qualifying frames (probe requests) heard in the window */
  probes: number;
  /** null = flame sensor not fitted / disabled in firmware */
  flame: boolean | null;
  /** MQ gas sensor: true = smoke / flammable gas in the air; null = not fitted or still warming up */
  smoke: boolean | null;
  /** MQ gas sensor heater still warming up after power-on (readings not trusted yet) */
  gasWarming: boolean;
  /** raw MQ reading 0..1023 and the learned clean-air value (null = no gas sensor) */
  gasRaw: number | null;
  gasBase: number | null;
  /** position from a GPS module on the pod, if one is fitted (null otherwise) */
  gps: LatLng | null;
  tier: Tier;
}

/**
 * tracked = live position from a device moving with the pod (the laptop it's plugged into,
 *           a phone running the tracker page, or a GPS module on the pod itself)
 * carried = follows a rescue team's live GPS
 * manual  = operator clicks it on the map
 */
export type PodLocationMode = "tracked" | "carried" | "manual";

export type TrackSource = "laptop" | "phone" | "pod-gps";

export interface TrackedPosition extends LatLng {
  accuracyM: number | null;
  t: number;
  source: TrackSource;
}

export interface TrailPoint extends LatLng {
  t: number;
}

export interface Pod {
  id: string;
  name: string;
  locationMode: PodLocationMode;
  manualPosition: LatLng | null;
  trackedPosition: TrackedPosition | null;
  /** recent path of the pod, oldest first (for the trail on the map) */
  trail: TrailPoint[];
  carrierTeamId: string | null;
  lastSeen: number | null;
  lastReading: Reading | null;
  /** how the last reading arrived: serial bridge, WiFi uplink or simulator */
  link: string | null;
}

export type TargetStatus =
  | "OPEN" // waiting for a team
  | "ASSIGNED"
  | "EN_ROUTE"
  | "ON_SCENE"
  | "RESCUED"
  | "NOTHING_FOUND"
  | "DISMISSED";

export interface Detection {
  id: string;
  podId: string;
  firstSeen: number;
  lastSeen: number;
  /** null until the operator places it (pod had no position when it fired) */
  position: LatLng | null;
  tier: Tier;
  thermal: boolean;
  signal: boolean;
  /** flame sensor fired at this spot — person still reported, tagged as hazardous */
  fire: boolean;
  /** gas sensor smelled smoke / flammable gas at this spot — also just a hazard tag */
  smoke: boolean;
  peakObjC: number | null;
  ambC: number | null;
  maxRssi: number;
  /** how many sensor readings this detection lasted */
  hits: number;
  label: string;
  notes: string;
  status: TargetStatus;
  assignedTeamId: string | null;
}

export type AreaKind = "search" | "hazard";

export interface Area {
  id: string;
  kind: AreaKind;
  label: string;
  center: LatLng;
  radiusM: number;
  /** auto-created from a pod's flame or gas sensor, otherwise "operator" */
  source: "operator" | "flame-sensor" | "gas-sensor";
  /** hazard areas stay OPEN — they are warnings, not tasks */
  status: TargetStatus;
  assignedTeamId: string | null;
  createdAt: number;
}

export type TeamStatus = "AVAILABLE" | "ASSIGNED" | "EN_ROUTE" | "ON_SCENE" | "SOS";

export interface TeamPosition extends LatLng {
  accuracyM: number | null;
  t: number;
  source: "gps" | "manual" | "sim";
}

export interface Team {
  id: string;
  name: string;
  members: string;
  status: TeamStatus;
  position: TeamPosition | null;
  sosAt: number | null;
  createdAt: number;
}

export type LogKind =
  | "detection"
  | "detection-upgrade"
  | "hazard"
  | "assignment"
  | "status"
  | "team"
  | "sos"
  | "pod"
  | "system";

export interface LogEntry {
  id: number;
  t: number;
  kind: LogKind;
  text: string;
  detectionId?: string;
  teamId?: string;
  areaId?: string;
  podId?: string;
}

export interface SiteConfig {
  name: string;
  center: LatLng;
  zoom: number;
}

export interface AppState {
  sessionId: string;
  sessionStarted: number;
  site: SiteConfig;
  pods: Pod[];
  detections: Detection[];
  areas: Area[];
  teams: Team[];
  log: LogEntry[];
  /** server clock at snapshot time — clients use it to judge staleness */
  now: number;
}
