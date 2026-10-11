import type { LatLng, Reading, Tier } from "../../shared/types.ts";

export const TIER_RANK: Record<Tier, number> = { VERY_HIGH: 3, HIGH: 2, LOW: 1, NONE: 0 };

/**
 * Two-sensor decision priority (mirrors the firmware's LED/buzzer logic):
 *   thermal + signal -> VERY_HIGH   (double beep)
 *   thermal only     -> HIGH        (single beep — phone may be lost/dead)
 *   signal only      -> LOW         (silent — could be a dropped phone)
 *   neither          -> NONE        (not reported)
 * The flame and gas sensors never change the tier; they only tag the spot as a hazard.
 */
export function deriveTier(thermal: boolean, signal: boolean): Tier {
  if (thermal && signal) return "VERY_HIGH";
  if (thermal) return "HIGH";
  if (signal) return "LOW";
  return "NONE";
}

export function betterTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

export function haversine(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/**
 * Turn one raw firmware JSON object into a Reading. Accepts the compact keys the
 * firmware prints: {pod, seq, up, mlx, obj, amb, thermal, signal, rssi, probes, flame}.
 * flame: -1 = sensor not fitted, 0 = clear, 1 = flame.
 * smoke (MQ gas sensor): -1 = not fitted, -2 = warming up, 0 = clean air, 1 = smoke / gas.
 * gas / gasBase: raw MQ reading and learned clean-air value.
 * Returns null if the payload is not a reading.
 */
export function parseReading(raw: unknown, podId: string, now: number): Reading | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r["type"] !== undefined && r["type"] !== "reading") return null;

  const mlxOk = r["mlx"] === undefined ? num(r["obj"]) !== null : bool(r["mlx"]);
  // The MLX library returns NaN / -999 when the sensor is missing — treat as no data.
  const obj = num(r["obj"]);
  const amb = num(r["amb"]);
  const objC = mlxOk && obj !== null && obj > -100 ? obj : null;
  const ambC = mlxOk && amb !== null && amb > -100 ? amb : null;

  const thermal = bool(r["thermal"]);
  const signal = bool(r["signal"]);
  const flameRaw = num(r["flame"]);
  const flame = flameRaw === null || flameRaw < 0 ? null : flameRaw > 0;
  const smokeRaw = num(r["smoke"]);
  const smoke = smokeRaw === null || smokeRaw < 0 ? null : smokeRaw > 0;
  const gasWarming = smokeRaw === -2;
  const gasRawV = num(r["gas"]);
  const gasBaseV = num(r["gasBase"]);
  // Optional GPS module on the pod: firmware adds "lat"/"lng" once it has a fix.
  const lat = num(r["lat"]);
  const lng = num(r["lng"]);
  const gps =
    lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)
      ? { lat, lng }
      : null;

  return {
    podId,
    seq: num(r["seq"]) ?? 0,
    t: now,
    up: num(r["up"]) ?? 0,
    mlxOk,
    objC,
    ambC,
    thermal,
    signal,
    rssi: num(r["rssi"]) ?? -127,
    probes: num(r["probes"]) ?? 0,
    flame,
    smoke,
    gasWarming,
    gasRaw: gasRawV !== null && gasRawV >= 0 ? gasRawV : null,
    gasBase: gasBaseV !== null && gasBaseV >= 0 ? gasBaseV : null,
    gps,
    tier: deriveTier(thermal, signal),
  };
}
