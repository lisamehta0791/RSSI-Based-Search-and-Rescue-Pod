import { createFileRoute, ClientOnly, Link } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useLiveState, type LinkState } from "@/hooks/useLiveState";
import { usePodSerial } from "@/hooks/usePodSerial";
import { usePodTracker } from "@/hooks/usePodTracker";
import { useTheme } from "@/hooks/useTheme";
import { Connecting } from "@/components/Connecting";
import { api } from "@/lib/api";
import {
  ACTIVE_STATUSES,
  FIRE_HEX,
  OK_HEX,
  TEAM_STATUS_HEX,
  TIER_HEX,
  WARN_HEX,
  hazardsOnRoute,
  podOnline,
  podPosition,
  targetsForTeam,
  teamColor,
  teamStale,
  type AppState,
  type AreaKind,
  type LatLng,
  type Tier,
} from "@/lib/domain";
import type { MapPod, MapRoute, MapSelection } from "@/components/LiveMap";
import { Btn } from "@/components/bits";
import { DetectionsTab } from "@/components/ops/DetectionsTab";
import { TeamsTab } from "@/components/ops/TeamsTab";
import { PodTab, type LaptopTracking } from "@/components/ops/PodTab";
import { LogTab } from "@/components/ops/LogTab";
import logo from "@/assets/rssi-rescue-pod-logo.png";

const LiveMap = lazy(() => import("@/components/LiveMap"));

export const Route = createFileRoute("/ops")({
  head: () => ({ meta: [{ title: "Operations — RSSI Rescue Pod" }] }),
  component: OpsPage,
});

type Tab = "detections" | "teams" | "pod" | "log";

type Placing =
  | { kind: "pod"; id: string }
  | { kind: "team"; id: string }
  | { kind: "detection"; id: string }
  | { kind: "area"; id: string }
  | { kind: "new-area"; areaKind: AreaKind }
  | null;

const LAPTOP_KEY = "laptopTrackPod";

function readPref(): string | null {
  try {
    return localStorage.getItem(LAPTOP_KEY);
  } catch {
    return null;
  }
}

function OpsPage() {
  const { state, link, now } = useLiveState();
  // The USB connection lives here so it survives re-renders of the panels.
  const usb = usePodSerial();

  // "Use this laptop's location" — remembered per browser. It switches on by itself the first
  // time a pod is plugged into this laptop, because the laptop then moves with the pod.
  const [laptopPodId, setLaptopPodIdState] = useState<string | null>(null);
  useEffect(() => {
    const v = readPref();
    if (v && v !== "off") setLaptopPodIdState(v);
  }, []);
  const setLaptopPodId = (id: string | null) => {
    setLaptopPodIdState(id);
    try {
      localStorage.setItem(LAPTOP_KEY, id ?? "off");
    } catch {
      /* ignore */
    }
  };
  const usbPod = usb.podIds[0] ?? null;
  useEffect(() => {
    if (usbPod && !laptopPodId && readPref() !== "off") setLaptopPodId(usbPod);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usbPod]);
  const tracker = usePodTracker(laptopPodId, !!laptopPodId, "laptop");

  if (!state) return <Connecting link={link} />;
  return (
    <Ops
      state={state}
      link={link}
      now={now}
      usb={usb}
      laptop={{
        podId: laptopPodId,
        setPodId: setLaptopPodId,
        status: tracker.status,
        accuracy: tracker.accuracy,
      }}
    />
  );
}

function Ops({
  state,
  link,
  now,
  usb,
  laptop,
}: {
  state: AppState;
  link: LinkState;
  now: number;
  usb: ReturnType<typeof usePodSerial>;
  laptop: LaptopTracking;
}) {
  const { theme, toggle } = useTheme();
  const [tab, setTab] = useState<Tab>("detections");
  const [selected, setSelected] = useState<MapSelection>(null);
  const [placing, setPlacing] = useState<Placing>(null);
  const [follow, setFollow] = useState(true);
  /** "Assign tasks" mode: clicking detections / areas assigns them to this team. */
  const [dispatchTeamId, setDispatchTeamId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ key: string; point: LatLng } | null>(null);
  const [show, setShow] = useState({ done: false, low: true, trails: true, hazards: true });
  const dispatchTeam = dispatchTeamId
    ? state.teams.find((t) => t.id === dispatchTeamId)
    : undefined;

  useEffect(() => {
    if (!dispatchTeamId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDispatchTeamId(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatchTeamId]);

  const focusOn = (point: LatLng) => {
    setFollow(false);
    setFocus({ key: `${Date.now()}`, point });
  };

  const startDispatch = (teamId: string) => {
    setDispatchTeamId(teamId);
    setPlacing(null);
    setTab("detections");
  };

  /** In assign mode: add the target to the team, or take it away if it's already theirs. */
  const toggleForDispatch = (kind: "detection" | "area", id: string) => {
    if (!dispatchTeam) return;
    const item =
      kind === "detection"
        ? state.detections.find((d) => d.id === id)
        : state.areas.find((a) => a.id === id);
    if (!item || ("kind" in item && item.kind === "hazard")) return;
    const mine = item.assignedTeamId === dispatchTeam.id;
    void api
      .updateTarget(kind, id, { assignedTeamId: mine ? null : dispatchTeam.id })
      .then(() =>
        mine
          ? toast(`${id} removed from ${dispatchTeam.name}`)
          : toast.success(`${id} assigned to ${dispatchTeam.name}`),
      );
  };

  const select = (sel: NonNullable<MapSelection>) => {
    if (dispatchTeam && (sel.kind === "detection" || sel.kind === "area")) {
      toggleForDispatch(sel.kind, sel.id);
      return;
    }
    setSelected(sel);
    setTab(sel.kind === "team" ? "teams" : sel.kind === "pod" ? "pod" : "detections");
  };

  /* ---------------- map data ---------------- */

  const mapPods: MapPod[] = useMemo(
    () =>
      state.pods.flatMap((p) => {
        const pos = podPosition(p, state.teams);
        if (!pos) return [];
        const online = podOnline(p, now);
        const tier: Tier = online && p.lastReading ? p.lastReading.tier : "NONE";
        const accuracyM =
          p.locationMode === "tracked" ? (p.trackedPosition?.accuracyM ?? null) : null;
        const trail = show.trails ? p.trail : [];
        return [{ id: p.id, name: p.name, position: pos, online, tier, trail, accuracyM }];
      }),
    [state.pods, state.teams, now, show.trails],
  );
  const followPod = mapPods.find((p) => p.online) ?? mapPods[0];
  const followPoint = follow && followPod ? followPod.position : null;

  const mapTeams = useMemo(
    () =>
      state.teams.map((t) => {
        const tasks = targetsForTeam(state, t.id).filter((x) =>
          ACTIVE_STATUSES.includes(x.item.status),
        );
        const task = tasks.length
          ? `→ ${tasks[0]!.id}${tasks.length > 1 ? ` +${tasks.length - 1}` : ""}`
          : "· free";
        return { team: t, stale: teamStale(t, now), color: teamColor(t.id), task };
      }),
    [state, now],
  );

  const teamLabels = useMemo(
    () =>
      Object.fromEntries(state.teams.map((t) => [t.id, { name: t.name, color: teamColor(t.id) }])),
    [state.teams],
  );

  const routes = useMemo(() => {
    const out: MapRoute[] = [];
    for (const t of state.teams) {
      if (!t.position) continue;
      const targets = [
        ...state.detections
          .filter(
            (d) => d.assignedTeamId === t.id && ACTIVE_STATUSES.includes(d.status) && d.position,
          )
          .map((d) => d.position!),
        ...state.areas
          .filter((a) => a.assignedTeamId === t.id && ACTIVE_STATUSES.includes(a.status))
          .map((a) => a.center),
      ];
      for (const to of targets) {
        out.push({
          from: t.position,
          to,
          color: teamColor(t.id),
          danger: hazardsOnRoute(state.areas, t.position, to).length > 0,
        });
      }
    }
    return out;
  }, [state.teams, state.detections, state.areas]);

  const visibleDetections = useMemo(
    () =>
      state.detections.filter(
        (d) =>
          d.status !== "DISMISSED" &&
          (show.done || ACTIVE_STATUSES.includes(d.status)) &&
          (show.low || d.tier !== "LOW"),
      ),
    [state.detections, show.done, show.low],
  );
  const visibleAreas = useMemo(
    () =>
      state.areas.filter((a) =>
        a.kind === "hazard" ? show.hazards : show.done || ACTIVE_STATUSES.includes(a.status),
      ),
    [state.areas, show.done, show.hazards],
  );

  const onMapClick = async (p: LatLng) => {
    const pl = placing;
    if (!pl) return;
    setPlacing(null);
    switch (pl.kind) {
      case "pod":
        await api.updatePod(pl.id, { manualPosition: p, locationMode: "manual" });
        break;
      case "team":
        await api.teamPosition(pl.id, { ...p, accuracyM: null, source: "manual" });
        break;
      case "detection":
        await api.updateTarget("detection", pl.id, { position: p });
        break;
      case "area":
        await api.updateTarget("area", pl.id, { position: p });
        break;
      case "new-area": {
        const label =
          prompt(
            pl.areaKind === "hazard"
              ? "Name this hazard (e.g. Fire, collapsed stairs)"
              : "Name this search area (e.g. Block B floor 2)",
          ) ?? "";
        const a = await api.createArea(pl.areaKind, p, pl.areaKind === "hazard" ? 10 : 20, label);
        if (pl.areaKind === "search") select({ kind: "area", id: a.id });
        break;
      }
    }
  };

  /* ---------------- header status ---------------- */

  const onlinePods = state.pods.filter((p) => podOnline(p, now));
  const sosTeams = state.teams.filter((t) => t.status === "SOS");
  const lostTeams = state.teams.filter(
    (t) => t.position && teamStale(t, now) && (t.status === "EN_ROUTE" || t.status === "ON_SCENE"),
  );
  const activeCount = state.detections.filter((d) => ACTIVE_STATUSES.includes(d.status)).length;

  const placingHint: Record<NonNullable<Placing>["kind"], string> = {
    pod: "Click where the pod is",
    team: "Click where the team is",
    detection: "Click where this detection is",
    area: "Click the new centre of the area",
    "new-area": "Click on the map to mark the area",
  };

  const tabs: [Tab, string, number | null][] = [
    ["detections", "Detections", activeCount],
    ["teams", "Teams", state.teams.length],
    ["pod", "Pod", null],
    ["log", "Log", null],
  ];

  return (
    <div className="flex h-dvh flex-col">
      {/* ================= header ================= */}
      <header className="z-[1000] flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border bg-card px-4 py-2.5">
        <Link to="/" className="flex items-center gap-3">
          <img src={logo} alt="" className="h-10 w-10 object-contain" />
          <div>
            <h1 className="text-lg leading-tight font-bold">Rescue Pod — Operations</h1>
            <p className="text-xs text-muted-foreground">{state.site.name}</p>
          </div>
        </Link>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Chip color={link === "live" ? OK_HEX : WARN_HEX}>
            {link === "live" ? "Server live" : "Reconnecting…"}
          </Chip>
          <Chip color={onlinePods.length ? OK_HEX : "#9ca3af"}>
            {onlinePods.length
              ? `Pod live: ${onlinePods.map((p) => p.name).join(", ")}`
              : "No pod connected"}
          </Chip>
          {sosTeams.length ? (
            <Chip color={TEAM_STATUS_HEX.SOS}>🆘 {sosTeams.length} SOS</Chip>
          ) : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Btn
            onClick={() => {
              void api
                .loadSampleData()
                .then(() => toast.success("Sample detections, zones and an assignment added"));
            }}
          >
            Load sample data
          </Btn>
          <Btn
            onClick={() => {
              if (
                confirm(
                  "Start a new session? The current one is kept in the database. Teams and pods stay.",
                )
              )
                void api.resetSession();
            }}
          >
            New session
          </Btn>
          <Btn onClick={toggle} aria-label="Switch theme">
            {theme === "dark" ? "☀ Light" : "🌙 Dark"}
          </Btn>
        </div>
      </header>

      {/* ================= alerts ================= */}
      {sosTeams.length || lostTeams.length ? (
        <div className="space-y-1 border-b border-border bg-card px-4 py-2">
          {sosTeams.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => select({ kind: "team", id: t.id })}
              className="w-full animate-pulse rounded-lg px-4 py-2.5 text-left text-base font-bold text-white"
              style={{ backgroundColor: TEAM_STATUS_HEX.SOS }}
            >
              🆘 SOS — {t.name} needs help
              {t.position ? " · click to see their last location" : " · no location on record"}
            </button>
          ))}
          {lostTeams.map((t) => (
            <p
              key={t.id}
              className="rounded-lg px-4 py-2 text-sm font-semibold"
              style={{
                color: WARN_HEX,
                backgroundColor: `color-mix(in oklab, ${WARN_HEX} 12%, transparent)`,
              }}
            >
              ⚠ {t.name} hasn't sent a location for over a minute while on a task — check on them.
            </p>
          ))}
        </div>
      ) : null}

      {/* ================= map + sidebar ================= */}
      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_30rem]">
        <section className="relative h-[60vh] lg:h-auto">
          <div className="absolute inset-0">
            <ClientOnly fallback={<MapFallback />}>
              <Suspense fallback={<MapFallback />}>
                <LiveMap
                  center={state.site.center}
                  zoom={state.site.zoom}
                  pods={mapPods}
                  detections={visibleDetections}
                  areas={visibleAreas}
                  teams={mapTeams}
                  routes={routes}
                  selected={selected}
                  onSelect={select}
                  onMapClick={placing ? onMapClick : null}
                  teamLabels={teamLabels}
                  follow={followPoint}
                  focus={focus}
                />
              </Suspense>
            </ClientOnly>
          </div>

          {/* map tools */}
          <div className="absolute top-3 right-3 z-[500] flex flex-col items-end gap-2">
            <Btn
              className="shadow-md"
              tone={follow ? "active" : "default"}
              onClick={() => setFollow((f) => !f)}
            >
              {follow ? "📡 Following pod" : "📡 Follow pod"}
            </Btn>
            <Btn
              className="shadow-md"
              tone={
                placing?.kind === "new-area" && placing.areaKind === "search" ? "active" : "default"
              }
              onClick={() => setPlacing({ kind: "new-area", areaKind: "search" })}
            >
              + Search area
            </Btn>
            <Btn
              className="shadow-md"
              tone={
                placing?.kind === "new-area" && placing.areaKind === "hazard" ? "active" : "default"
              }
              onClick={() => setPlacing({ kind: "new-area", areaKind: "hazard" })}
            >
              + Hazard zone
            </Btn>
            <div className="space-y-1 rounded-xl border border-border bg-card/95 px-3 py-2 text-sm shadow-md">
              <p className="text-xs font-semibold text-muted-foreground">SHOW ON MAP</p>
              {(
                [
                  ["low", "Low (phone only)"],
                  ["done", "Completed"],
                  ["trails", "Pod trail"],
                  ["hazards", "Hazard zones"],
                ] as [keyof typeof show, string][]
              ).map(([k, label]) => (
                <label key={k} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={show[k]}
                    onChange={(e) => setShow((v) => ({ ...v, [k]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {dispatchTeam ? (
            <div
              className="absolute top-3 left-1/2 z-[600] flex max-w-[90%] -translate-x-1/2 items-center gap-3 rounded-xl px-4 py-2.5 text-base font-semibold text-white shadow-lg"
              style={{ backgroundColor: teamColor(dispatchTeam.id) }}
            >
              <span>
                Assigning to {dispatchTeam.name} — click detections or search areas on the map or in
                the list
              </span>
              <button
                type="button"
                onClick={() => setDispatchTeamId(null)}
                className="shrink-0 rounded-lg bg-white px-3 py-1 text-sm font-bold"
                style={{ color: teamColor(dispatchTeam.id) }}
              >
                Finish assigning
              </button>
            </div>
          ) : null}

          <Legend />

          {placing ? (
            <div className="absolute bottom-6 left-1/2 z-[500] flex -translate-x-1/2 items-center gap-3 rounded-xl border-2 border-primary bg-card px-4 py-2 text-base font-semibold shadow-lg">
              👆 {placingHint[placing.kind]}
              <Btn size="sm" onClick={() => setPlacing(null)}>
                Cancel
              </Btn>
            </div>
          ) : null}
        </section>

        <aside className="flex min-h-0 flex-col border-l border-border bg-background">
          <nav className="flex border-b border-border bg-card">
            {tabs.map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`flex-1 border-b-2 px-2 py-3 text-sm font-semibold transition ${tab === key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {label}
                {count !== null ? (
                  <span className="ml-1.5 rounded-full bg-secondary px-2 py-0.5 text-xs text-foreground">
                    {count}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {tab === "detections" ? (
              <DetectionsTab
                state={state}
                now={now}
                selectedId={
                  selected && (selected.kind === "detection" || selected.kind === "area")
                    ? selected.id
                    : null
                }
                onSelect={(kind, id) =>
                  dispatchTeam ? toggleForDispatch(kind, id) : setSelected({ kind, id })
                }
                placingId={
                  placing && (placing.kind === "detection" || placing.kind === "area")
                    ? placing.id
                    : null
                }
                onPlace={(kind, id) => setPlacing({ kind, id })}
                dispatchTeamId={dispatchTeamId}
              />
            ) : tab === "teams" ? (
              <TeamsTab
                state={state}
                now={now}
                selectedTeamId={selected?.kind === "team" ? selected.id : null}
                onSelect={(id) => setSelected({ kind: "team", id })}
                placingTeamId={placing?.kind === "team" ? placing.id : null}
                onPlace={(id) => setPlacing(id ? { kind: "team", id } : null)}
                onDispatch={startDispatch}
                onFocus={focusOn}
              />
            ) : tab === "pod" ? (
              <PodTab
                pods={state.pods}
                teams={state.teams}
                now={now}
                usb={usb}
                laptop={laptop}
                placingPodId={placing?.kind === "pod" ? placing.id : null}
                onPlace={(id) => setPlacing(id ? { kind: "pod", id } : null)}
              />
            ) : (
              <LogTab
                log={state.log}
                onPick={(e) => {
                  if (e.detectionId) select({ kind: "detection", id: e.detectionId });
                  else if (e.areaId) select({ kind: "area", id: e.areaId });
                  else if (e.teamId) select({ kind: "team", id: e.teamId });
                }}
              />
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function Chip({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium"
      style={{ color, backgroundColor: `color-mix(in oklab, ${color} 12%, transparent)` }}
    >
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {children}
    </span>
  );
}

function Legend() {
  const dot = (c: string) => (
    <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: c }} />
  );
  return (
    <div className="absolute bottom-6 left-3 z-[500] hidden space-y-1 rounded-xl border border-border bg-card/95 px-3 py-2 text-xs shadow-md sm:block">
      <p className="font-semibold">Map key</p>
      <p className="flex items-center gap-2">{dot(TIER_HEX.VERY_HIGH)} Very high — heat + phone</p>
      <p className="flex items-center gap-2">{dot(TIER_HEX.HIGH)} High — heat only</p>
      <p className="flex items-center gap-2">{dot(TIER_HEX.LOW)} Low — phone only</p>
      <p className="flex items-center gap-2">📡 Pod · blue line = path it walked</p>
      <p className="flex items-center gap-2">
        {dot(TEAM_STATUS_HEX.EN_ROUTE)} Rescue team · dashed line = route to its task
      </p>
      <p className="flex items-center gap-2">{dot(FIRE_HEX)} Hazard zone (fire, smoke or gas)</p>
    </div>
  );
}

function MapFallback() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  );
}
