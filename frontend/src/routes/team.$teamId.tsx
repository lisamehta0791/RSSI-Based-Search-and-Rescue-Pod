import { createFileRoute, ClientOnly, Link } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLiveState } from "@/hooks/useLiveState";
import { useCompass, useGeolocation } from "@/hooks/useGeolocation";
import { api } from "@/lib/api";
import {
  ACTIVE_STATUSES,
  FIRE_HEX,
  STATUS_HEX,
  STATUS_LABEL,
  TEAM_STATUS_HEX,
  TIER_HEX,
  TIER_MEANING,
  bearing,
  cardinal,
  fmtAgo,
  fmtDistance,
  fmtEta,
  haversine,
  hazardsOnRoute,
  targetsForTeam,
  teamColor,
  teamStale,
  type AppState,
  type LatLng,
  type Target,
  type TargetStatus,
  type Team,
} from "@/lib/domain";
import type { MapRoute } from "@/components/LiveMap";
import { Btn, FireBadge, SmokeBadge, StatusBadge, TierBadge } from "@/components/bits";
import { Connecting } from "@/components/Connecting";

const LiveMap = lazy(() => import("@/components/LiveMap"));

export const Route = createFileRoute("/team/$teamId")({
  head: () => ({ meta: [{ title: "Rescue team — RSSI Rescue Pod" }] }),
  component: TeamPage,
});

/** Send a GPS fix at most this often, unless the team has moved a lot. */
const SEND_EVERY_MS = 3000;
const SEND_IF_MOVED_M = 5;

function TeamPage() {
  const { teamId } = Route.useParams();
  const { state, link, now } = useLiveState();
  if (!state) return <Connecting link={link} />;
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted-foreground">
        <p>Team {teamId} is not registered on this server.</p>
        <Link to="/" className="underline">
          Choose a team
        </Link>
      </div>
    );
  }
  return <TeamView state={state} team={team} now={now} live={link === "live"} />;
}

function TeamView({
  state,
  team,
  now,
  live,
}: {
  state: AppState;
  team: Team;
  now: number;
  live: boolean;
}) {
  const { fix, status: geo } = useGeolocation(true);
  const compass = useCompass();
  const [placingSelf, setPlacingSelf] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);

  // ---- share our GPS with operations ----
  const lastSent = useRef<{ t: number; p: LatLng } | null>(null);
  useEffect(() => {
    if (!fix) return;
    const last = lastSent.current;
    const moved = last ? haversine(last.p, fix) : Infinity;
    if (last && Date.now() - last.t < SEND_EVERY_MS && moved < SEND_IF_MOVED_M) return;
    lastSent.current = { t: Date.now(), p: fix };
    void api
      .teamPosition(team.id, {
        lat: fix.lat,
        lng: fix.lng,
        accuracyM: fix.accuracyM,
        source: "gps",
      })
      .catch(() => {});
  }, [fix, team.id]);
  // Keep-alive: re-send the last fix every 20 s while standing still so ops doesn't flag us as lost.
  useEffect(() => {
    const id = setInterval(() => {
      const l = lastSent.current;
      if (l && fix) {
        lastSent.current = { t: Date.now(), p: l.p };
        void api
          .teamPosition(team.id, { ...l.p, accuracyM: fix.accuracyM, source: "gps" })
          .catch(() => {});
      }
    }, 20000);
    return () => clearInterval(id);
  }, [fix, team.id]);

  // Prefer the phone's own fix (instant) over the server echo.
  const me: LatLng | null =
    fix ?? (team.position ? { lat: team.position.lat, lng: team.position.lng } : null);

  const targets = useMemo(() => targetsForTeam(state, team.id), [state, team.id]);
  const active = targets.filter((t) => ACTIVE_STATUSES.includes(t.item.status));
  const done = targets.filter((t) => !ACTIVE_STATUSES.includes(t.item.status));
  const current: Target | undefined = active.find((t) => t.id === pickedId) ?? active[0];

  // Alert when a new task arrives.
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(active.map((t) => t.id));
    if (known.current) {
      for (const id of ids) {
        if (!known.current.has(id)) {
          toast.warning(`New task assigned: ${id}`);
          navigator.vibrate?.([200, 100, 200]);
        }
      }
    }
    known.current = ids;
  }, [active]);

  const hazards = state.areas.filter((a) => a.kind === "hazard");
  const routeHazards =
    me && current?.position ? hazardsOnRoute(state.areas, me, current.position) : [];
  const dist = me && current?.position ? haversine(me, current.position) : null;
  const brg = me && current?.position ? bearing(me, current.position) : null;

  const routes: MapRoute[] =
    me && current?.position
      ? [
          {
            from: me,
            to: current.position,
            color: teamColor(team.id),
            danger: routeHazards.length > 0,
          },
        ]
      : [];

  const [fitKey, setFitKey] = useState("");
  const fitPoints = [me, current?.position].filter((p): p is LatLng => !!p);
  const autoFitKey = `${current?.id ?? "none"}|${me ? "me" : "nome"}`;
  const [focus, setFocus] = useState<{ key: string; point: LatLng } | null>(null);

  const setStatus = (s: TargetStatus) => {
    if (!current) return;
    void api.updateTarget(current.kind, current.id, { status: s }, team.name);
  };

  const sos = team.status === "SOS";
  const color = teamColor(team.id);
  const close = dist !== null && dist <= 15;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      {/* ---------- header ---------- */}
      <header
        className="flex items-center gap-3 px-4 py-3 text-white"
        style={{ backgroundColor: color }}
      >
        <div className="min-w-0">
          <p className="truncate text-lg font-bold">{team.name}</p>
          <p className="truncate text-sm opacity-90">{team.members || "Rescue team"}</p>
        </div>
        <span className="ml-auto rounded-full bg-white/20 px-3 py-1 text-sm font-semibold">
          {sos
            ? "SOS sent"
            : active.length
              ? `${active.length} task${active.length > 1 ? "s" : ""}`
              : "Free"}
        </span>
        <span
          className="h-3 w-3 shrink-0 rounded-full border-2 border-white"
          title={live ? "connected" : "reconnecting"}
          style={{ backgroundColor: live ? "#22c55e" : "#f59e0b" }}
        />
      </header>

      <GpsBanner
        geo={geo}
        accuracy={fix?.accuracyM ?? null}
        onManual={() => setPlacingSelf(true)}
        hasPos={!!team.position}
      />

      {sos ? (
        <div
          className="space-y-2 px-4 py-3 text-center text-white"
          style={{ backgroundColor: TEAM_STATUS_HEX.SOS }}
        >
          <p className="text-lg font-bold">
            🆘 SOS sent {team.sosAt ? fmtAgo(now - team.sosAt) : ""}
          </p>
          <p className="text-sm">
            Operations can see your location. Stay where you are if it's safe.
          </p>
          <button
            type="button"
            className="h-11 w-full rounded-lg bg-white text-base font-bold"
            style={{ color: TEAM_STATUS_HEX.SOS }}
            onClick={() => void api.sos(team.id, false, team.name)}
          >
            I'm safe now — cancel SOS
          </button>
        </div>
      ) : null}

      {/* ---------- current task ---------- */}
      <section className="space-y-3 p-4">
        {current ? (
          <div className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground">
                YOUR TASK
                {active.length > 1 ? ` · ${active.indexOf(current) + 1} OF ${active.length}` : ""}
              </p>
              <span className="ml-auto">
                <StatusBadge status={current.item.status} />
              </span>
            </div>

            <div>
              <p className="text-xl font-bold">
                {current.item.label ||
                  (current.kind === "detection"
                    ? `Possible survivor ${current.id}`
                    : `Search area ${current.id}`)}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <span className="text-sm text-muted-foreground">{current.id}</span>
                {current.kind === "detection" ? <TierBadge tier={current.item.tier} /> : null}
                {current.kind === "detection" && current.item.fire ? <FireBadge /> : null}
                {current.kind === "detection" && current.item.smoke ? <SmokeBadge /> : null}
              </div>
            </div>

            {current.kind === "detection" ? (
              <p className="text-sm">
                <b>Found:</b>{" "}
                {[
                  current.item.thermal
                    ? `body heat ${current.item.peakObjC?.toFixed(1) ?? ""}°C`
                    : null,
                  current.item.signal ? "a phone signal" : null,
                ]
                  .filter(Boolean)
                  .join(" + ")}
                . <span className="text-muted-foreground">{TIER_MEANING[current.item.tier]}</span>
              </p>
            ) : null}
            {current.kind === "detection" && current.item.notes ? (
              <p className="rounded-lg bg-secondary px-3 py-2 text-sm">
                <b>Note from operations:</b> {current.item.notes}
              </p>
            ) : null}

            {/* guidance */}
            {current.position ? (
              <div className="flex items-center gap-4 rounded-xl bg-secondary p-3">
                <Arrow bearing={brg} heading={compass.heading} color={color} />
                <div className="min-w-0">
                  <p className="text-3xl font-bold">{dist !== null ? fmtDistance(dist) : "—"}</p>
                  <p className="text-sm text-muted-foreground">
                    {brg !== null
                      ? `Head ${cardinal(brg)} · about ${Math.max(1, Math.round((dist ?? 0) / 60))} min walk`
                      : "Waiting for your location…"}
                  </p>
                  {compass.needsPermission ? (
                    <button
                      type="button"
                      className="text-sm font-medium text-primary underline"
                      onClick={() => void compass.request()}
                    >
                      Turn on compass
                    </button>
                  ) : compass.heading === null && brg !== null ? (
                    <p className="text-xs text-muted-foreground">Arrow is north-up (no compass)</p>
                  ) : null}
                </div>
                <a
                  className="ml-auto shrink-0 rounded-lg border border-input bg-card px-3 py-2 text-center text-sm font-semibold"
                  href={`https://www.google.com/maps/dir/?api=1&destination=${current.position.lat},${current.position.lng}&travelmode=walking`}
                  target="_blank"
                  rel="noreferrer"
                >
                  🗺 Maps
                </a>
              </div>
            ) : (
              <p className="text-sm font-medium" style={{ color: TIER_HEX.HIGH }}>
                Operations hasn't marked this location yet — stand by.
              </p>
            )}

            {routeHazards.length ? (
              <p
                className="rounded-lg border-2 px-3 py-2 text-sm font-semibold"
                style={{ borderColor: FIRE_HEX, color: FIRE_HEX }}
              >
                ⚠ The straight path crosses {routeHazards.map((h) => h.label || h.id).join(", ")} —
                go around it.
              </p>
            ) : null}
            {current.kind === "detection" && current.item.fire ? (
              <p
                className="rounded-lg border-2 px-3 py-2 text-sm font-semibold"
                style={{ borderColor: FIRE_HEX, color: FIRE_HEX }}
              >
                🔥 Fire was detected at this spot. Approach with caution.
              </p>
            ) : null}
            {current.kind === "detection" && current.item.smoke ? (
              <p
                className="rounded-lg border-2 px-3 py-2 text-sm font-semibold"
                style={{ borderColor: FIRE_HEX, color: FIRE_HEX }}
              >
                💨 Smoke or flammable gas was detected here. No flames or sparks; cover your nose
                and mouth; don't stay long.
              </p>
            ) : null}
            {close && current.item.status !== "ON_SCENE" ? (
              <p className="rounded-lg bg-green-600/10 px-3 py-2 text-sm font-semibold text-green-700 dark:text-green-400">
                You're close. Search within about 10 m — use the pod's thermal sensor and signal
                meter.
              </p>
            ) : null}

            {/* the one next step */}
            <NextStep
              status={current.item.status}
              isArea={current.kind === "area"}
              onStatus={setStatus}
            />
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-border p-6 text-center">
            <p className="text-lg font-semibold">No task right now</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Keep this page open. Operations can see your location and will send you a task — your
              phone will vibrate.
            </p>
          </div>
        )}

        {/* other tasks */}
        {active.length > 1 ? (
          <div className="space-y-2">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground">
              ALL YOUR TASKS
            </p>
            {active.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setPickedId(t.id)}
                className={`flex w-full items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left ${t.id === current?.id ? "border-2" : "border-border"}`}
                style={t.id === current?.id ? { borderColor: color } : undefined}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{
                    backgroundColor: t.kind === "detection" ? TIER_HEX[t.item.tier] : "#2563eb",
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{t.item.label || t.id}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.id} · {STATUS_LABEL[t.item.status]}
                  </span>
                </span>
                {me && t.position ? (
                  <span className="shrink-0 text-sm font-semibold">
                    {fmtDistance(haversine(me, t.position))}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {/* ---------- map ---------- */}
      <section className="relative mx-4 mb-4 h-[50vh] min-h-[18rem] overflow-hidden rounded-2xl border border-border">
        <div className="absolute inset-0">
          <ClientOnly fallback={null}>
            <Suspense fallback={null}>
              <LiveMap
                center={me ?? current?.position ?? state.site.center}
                zoom={state.site.zoom}
                detections={targets.flatMap((t) =>
                  t.kind === "detection" && ACTIVE_STATUSES.includes(t.item.status) ? [t.item] : [],
                )}
                areas={[
                  ...hazards,
                  ...targets.flatMap((t) =>
                    t.kind === "area" && ACTIVE_STATUSES.includes(t.item.status) ? [t.item] : [],
                  ),
                ]}
                teams={state.teams.map((t) => ({
                  team:
                    t.id === team.id && fix
                      ? { ...t, position: { ...fix, source: "gps" as const } }
                      : t,
                  stale: t.id === team.id ? false : teamStale(t, now),
                  self: t.id === team.id,
                  dim: t.id !== team.id,
                  color: teamColor(t.id),
                }))}
                routes={routes}
                accuracy={fix ? { center: fix, radiusM: fix.accuracyM } : null}
                fit={{ key: `${autoFitKey}|${fitKey}`, points: fitPoints }}
                focus={focus}
                onMapClick={
                  placingSelf
                    ? (p) => {
                        setPlacingSelf(false);
                        void api.teamPosition(team.id, { ...p, accuracyM: null, source: "manual" });
                      }
                    : null
                }
              />
            </Suspense>
          </ClientOnly>
        </div>
        {placingSelf ? (
          <div className="absolute top-2 left-1/2 z-[500] -translate-x-1/2 rounded-lg border-2 border-primary bg-card px-3 py-1.5 text-sm font-semibold shadow">
            Tap where you are
          </div>
        ) : null}
        <div className="absolute right-2 bottom-2 z-[500] flex flex-col gap-2">
          {me ? (
            <Btn
              size="sm"
              className="shadow"
              onClick={() => setFocus({ key: `${Date.now()}`, point: me })}
            >
              📍 Me
            </Btn>
          ) : null}
          {current?.position && me ? (
            <Btn size="sm" className="shadow" onClick={() => setFitKey(`${Date.now()}`)}>
              ⤢ Me + task
            </Btn>
          ) : null}
          <Btn
            size="sm"
            className="shadow"
            tone={placingSelf ? "active" : "default"}
            onClick={() => setPlacingSelf((v) => !v)}
          >
            {placingSelf ? "Cancel" : "Set my spot"}
          </Btn>
        </div>
      </section>

      {/* ---------- SOS + history ---------- */}
      <footer className="sticky bottom-0 z-[1000] space-y-2 border-t border-border bg-card p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {!sos ? (
          <button
            type="button"
            className="h-14 w-full rounded-xl text-lg font-bold text-white shadow"
            style={{ backgroundColor: TEAM_STATUS_HEX.SOS }}
            onClick={() => {
              if (confirm("Send SOS to Operations with your current location?")) {
                void api.sos(team.id, true, team.name);
                navigator.vibrate?.(400);
              }
            }}
          >
            🆘 SOS — we need help
          </button>
        ) : null}
        {done.length ? (
          <p className="text-xs text-muted-foreground">
            Done today:{" "}
            {done.map((t) => (
              <span
                key={t.id}
                className="mr-2 font-medium"
                style={{ color: STATUS_HEX[t.item.status] }}
              >
                {t.id} {STATUS_LABEL[t.item.status].toLowerCase()}
              </span>
            ))}
          </p>
        ) : null}
      </footer>
    </div>
  );
}

/** One obvious next action for the current task. */
function NextStep({
  status,
  isArea,
  onStatus,
}: {
  status: TargetStatus;
  isArea: boolean;
  onStatus: (s: TargetStatus) => void;
}) {
  const big = "h-14 w-full rounded-xl text-lg font-bold text-white shadow-sm";
  if (status === "OPEN" || status === "ASSIGNED") {
    return (
      <button
        type="button"
        className={big}
        style={{ backgroundColor: STATUS_HEX.EN_ROUTE }}
        onClick={() => onStatus("EN_ROUTE")}
      >
        🚶 We're on our way
      </button>
    );
  }
  if (status === "EN_ROUTE") {
    return (
      <div className="space-y-1.5">
        <button
          type="button"
          className={big}
          style={{ backgroundColor: STATUS_HEX.ON_SCENE }}
          onClick={() => onStatus("ON_SCENE")}
        >
          📍 We've arrived
        </button>
        <button
          type="button"
          className="w-full text-sm text-muted-foreground underline"
          onClick={() => onStatus("ASSIGNED")}
        >
          Not on our way yet (undo)
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className={big}
          style={{ backgroundColor: STATUS_HEX.RESCUED }}
          onClick={() => onStatus("RESCUED")}
        >
          ✅ {isArea ? "Area cleared" : "Person rescued"}
        </button>
        <button
          type="button"
          className={big}
          style={{ backgroundColor: STATUS_HEX.NOTHING_FOUND }}
          onClick={() => onStatus("NOTHING_FOUND")}
        >
          ✖ Nothing found
        </button>
      </div>
      <button
        type="button"
        className="w-full text-sm text-muted-foreground underline"
        onClick={() => onStatus("EN_ROUTE")}
      >
        Not there yet (undo)
      </button>
    </div>
  );
}

/** Points toward the target. With a compass it's relative to where the phone faces; otherwise north-up. */
function Arrow({
  bearing: b,
  heading,
  color,
}: {
  bearing: number | null;
  heading: number | null;
  color: string;
}) {
  const rot = b === null ? 0 : heading === null ? b : b - heading;
  return (
    <div className="grid h-20 w-20 shrink-0 place-items-center rounded-full border-2 border-border bg-card">
      {b === null ? (
        <span className="text-sm text-muted-foreground">?</span>
      ) : (
        <svg
          viewBox="0 0 24 24"
          width="48"
          height="48"
          style={{ transform: `rotate(${rot}deg)`, transition: "transform 0.3s" }}
        >
          <path d="M12 2 L19 21 L12 16 L5 21 Z" fill={color} />
        </svg>
      )}
    </div>
  );
}

function GpsBanner({
  geo,
  accuracy,
  onManual,
  hasPos,
}: {
  geo: string;
  accuracy: number | null;
  onManual: () => void;
  hasPos: boolean;
}) {
  if (geo === "ok") {
    const poor = accuracy !== null && accuracy > 30;
    return (
      <p
        className="px-4 py-1.5 text-sm font-medium"
        style={{ color: poor ? TIER_HEX.HIGH : "#16a34a" }}
      >
        ● Sharing your location (±{accuracy !== null ? Math.round(accuracy) : "?"} m)
        {poor ? " — weak signal indoors; tap “Set my spot” if it's wrong" : ""}
      </p>
    );
  }
  const msg: Record<string, string> = {
    starting: "Getting your location…",
    denied: "Location is blocked — allow it in the browser settings, or set your spot on the map.",
    unavailable: "Location unavailable — set your spot on the map.",
    insecure: "This link needs https:// for GPS — set your spot on the map for now.",
  };
  return (
    <div
      className="flex items-center gap-2 px-4 py-2"
      style={{
        color: TIER_HEX.HIGH,
        backgroundColor: `color-mix(in oklab, ${TIER_HEX.HIGH} 10%, transparent)`,
      }}
    >
      <p className="text-sm font-medium">
        {msg[geo] ?? geo}
        {hasPos ? " Operations sees your last spot." : ""}
      </p>
      {geo !== "starting" ? (
        <Btn size="sm" className="ml-auto shrink-0" onClick={onManual}>
          Set spot
        </Btn>
      ) : null}
    </div>
  );
}
