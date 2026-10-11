import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  FIRE_HEX,
  STATUS_HEX,
  TEAM_STATUS_HEX,
  TIER_HEX,
  ACTIVE_STATUSES,
  type Area,
  type Detection,
  type LatLng,
  type Team,
  type Tier,
} from "@/lib/domain";

export type MapSelection = { kind: "detection" | "area" | "team" | "pod"; id: string } | null;

export interface MapPod {
  id: string;
  name: string;
  position: LatLng;
  online: boolean;
  tier: Tier;
  /** recent path, oldest first */
  trail?: LatLng[];
  accuracyM?: number | null;
}

export interface MapTeam {
  team: Team;
  stale: boolean;
  /** the viewer's own team in the rescuer view */
  self?: boolean;
  dim?: boolean;
  /** the team's identity colour (defaults to its status colour) */
  color?: string;
  /** short text after the name, e.g. "→ D-005" */
  task?: string;
}

export interface MapRoute {
  from: LatLng;
  to: LatLng;
  color: string;
  danger?: boolean;
}

interface Props {
  center: LatLng;
  zoom: number;
  pods?: MapPod[];
  detections?: Detection[];
  areas?: Area[];
  teams?: MapTeam[];
  routes?: MapRoute[];
  selected?: MapSelection;
  onSelect?: (sel: NonNullable<MapSelection>) => void;
  /** When set, the map is in "click to place" mode and shows a crosshair. */
  onMapClick?: ((p: LatLng) => void) | null;
  /** Change the key to re-fit the view to these points (e.g. when a new target is assigned). */
  fit?: { key: string; points: LatLng[] } | null;
  /** GPS accuracy circle for the viewer's own position. */
  accuracy?: { center: LatLng; radiusM: number } | null;
  /** team id -> name + colour, to label detections with the team assigned to them */
  teamLabels?: Record<string, { name: string; color: string }>;
  /** keep this point in view (e.g. the moving pod) whenever it changes */
  follow?: LatLng | null;
  /** change the key to fly to this point once ("show on map") */
  focus?: { key: string; point: LatLng } | null;
}

/** Keyed layer bookkeeping so live updates move markers instead of rebuilding the map. */
class Keyed<T extends L.Layer> {
  layers = new Map<string, { layer: T; sig: string }>();
  constructor(private group: L.LayerGroup) {}
  sync<I>(
    items: I[],
    key: (i: I) => string,
    sig: (i: I) => string,
    create: (i: I) => T,
    update: (layer: T, i: I) => void,
  ) {
    const seen = new Set<string>();
    for (const i of items) {
      const k = key(i);
      seen.add(k);
      const s = sig(i);
      const cur = this.layers.get(k);
      if (!cur) {
        const layer = create(i);
        this.group.addLayer(layer);
        this.layers.set(k, { layer, sig: s });
      } else if (cur.sig !== s) {
        update(cur.layer, i);
        cur.sig = s;
      }
    }
    for (const [k, v] of this.layers) {
      if (!seen.has(k)) {
        this.group.removeLayer(v.layer);
        this.layers.delete(k);
      }
    }
  }
}

export default function LiveMap(props: Props) {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<{
    areas: Keyed<L.Circle>;
    routes: Keyed<L.Polyline>;
    trails: Keyed<L.Polyline>;
    podAcc: Keyed<L.Circle>;
    dets: Keyed<L.Marker>;
    pods: Keyed<L.Marker>;
    teams: Keyed<L.Marker>;
    acc: L.Circle;
  } | null>(null);
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, {
      center: [props.center.lat, props.center.lng],
      zoom: props.zoom,
      zoomControl: true,
      maxZoom: 21,
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 21,
      maxNativeZoom: 19,
      attribution: "© OpenStreetMap contributors",
      className: "site-tiles",
    }).addTo(m);
    L.control.scale({ imperial: false }).addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) =>
      cb.current.onMapClick?.({ lat: e.latlng.lat, lng: e.latlng.lng }),
    );

    const g = () => L.layerGroup().addTo(m);
    // Order matters: later groups draw on top.
    const areas = new Keyed<L.Circle>(g());
    const routes = new Keyed<L.Polyline>(g());
    const trails = new Keyed<L.Polyline>(g());
    const podAcc = new Keyed<L.Circle>(g());
    const acc = L.circle([0, 0], {
      radius: 0,
      color: "#2563eb",
      weight: 1,
      fillOpacity: 0.08,
      interactive: false,
    });
    const dets = new Keyed<L.Marker>(g());
    const pods = new Keyed<L.Marker>(g());
    const teams = new Keyed<L.Marker>(g());
    layers.current = { areas, routes, trails, podAcc, dets, pods, teams, acc };
    map.current = m;
    // Leaflet measures its container once; re-measure when the layout settles.
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      layers.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    pods,
    detections,
    areas,
    teams,
    routes,
    selected,
    onMapClick,
    fit,
    accuracy,
    teamLabels,
    follow,
    focus,
  } = props;

  useEffect(() => {
    const m = map.current;
    const ls = layers.current;
    if (!m || !ls) return;
    const isSel = (kind: string, id: string) => selected?.kind === kind && selected.id === id;
    const select = (sel: NonNullable<MapSelection>) => (e: L.LeafletEvent) => {
      if (cb.current.onMapClick) return; // placing something — let the click reach the map
      L.DomEvent.stopPropagation(e as L.LeafletMouseEvent);
      cb.current.onSelect?.(sel);
    };

    ls.areas.sync(
      areas ?? [],
      (a) => a.id,
      (a) => JSON.stringify([a.center, a.radiusM, a.kind, a.status, a.label, isSel("area", a.id)]),
      (a) => {
        const c = L.circle([a.center.lat, a.center.lng], areaStyle(a, isSel("area", a.id)));
        c.bindTooltip(areaTip(a), { direction: "top" });
        c.on("click", select({ kind: "area", id: a.id }));
        return c;
      },
      (c, a) => {
        c.setLatLng([a.center.lat, a.center.lng]);
        c.setRadius(a.radiusM);
        c.setStyle(areaStyle(a, isSel("area", a.id)));
        c.setTooltipContent(areaTip(a));
      },
    );

    ls.routes.sync(
      routes ?? [],
      (r) => `${r.to.lat},${r.to.lng}|${r.color}`,
      (r) => JSON.stringify(r),
      (r) =>
        L.polyline(
          [
            [r.from.lat, r.from.lng],
            [r.to.lat, r.to.lng],
          ],
          {
            color: r.danger ? FIRE_HEX : r.color,
            weight: 3,
            dashArray: "8 8",
            opacity: 0.9,
            interactive: false,
          },
        ),
      (l, r) => {
        l.setLatLngs([
          [r.from.lat, r.from.lng],
          [r.to.lat, r.to.lng],
        ]);
        l.setStyle({ color: r.danger ? FIRE_HEX : r.color });
      },
    );

    ls.trails.sync(
      (pods ?? []).filter((p) => (p.trail?.length ?? 0) > 1),
      (p) => p.id,
      (p) => JSON.stringify([p.trail?.length, p.trail?.at(-1), p.online]),
      (p) =>
        L.polyline(
          p.trail!.map((q) => [q.lat, q.lng] as [number, number]),
          {
            color: "#2563eb",
            weight: 5,
            opacity: 0.75,
            lineJoin: "round",
            lineCap: "round",
            interactive: false,
          },
        ),
      (l, p) => l.setLatLngs(p.trail!.map((q) => [q.lat, q.lng] as [number, number])),
    );

    ls.podAcc.sync(
      (pods ?? []).filter((p) => p.accuracyM && p.accuracyM > 0),
      (p) => p.id,
      (p) => JSON.stringify([p.position, p.accuracyM]),
      (p) =>
        L.circle([p.position.lat, p.position.lng], {
          radius: p.accuracyM!,
          color: "#2563eb",
          weight: 1,
          fillOpacity: 0.07,
          interactive: false,
        }),
      (c, p) => {
        c.setLatLng([p.position.lat, p.position.lng]);
        c.setRadius(p.accuracyM!);
      },
    );

    const teamOf = (d: Detection) =>
      d.assignedTeamId ? teamLabels?.[d.assignedTeamId] : undefined;
    ls.dets.sync(
      (detections ?? []).filter((d) => d.position),
      (d) => d.id,
      (d) =>
        JSON.stringify([
          d.position,
          d.tier,
          d.fire,
          d.smoke,
          d.status,
          teamOf(d),
          isSel("detection", d.id),
        ]),
      (d) => {
        const mk = L.marker([d.position!.lat, d.position!.lng], {
          icon: detIcon(d, isSel("detection", d.id), teamOf(d)),
          zIndexOffset: tierZ(d.tier),
        });
        mk.bindTooltip(detTip(d), { direction: "top", offset: [0, -12] });
        mk.on("click", select({ kind: "detection", id: d.id }));
        return mk;
      },
      (mk, d) => {
        mk.setLatLng([d.position!.lat, d.position!.lng]);
        mk.setIcon(detIcon(d, isSel("detection", d.id), teamOf(d)));
        mk.setTooltipContent(detTip(d));
      },
    );

    ls.pods.sync(
      pods ?? [],
      (p) => p.id,
      (p) => JSON.stringify([p.position, p.online, p.tier, p.name, isSel("pod", p.id)]),
      (p) => {
        const mk = L.marker([p.position.lat, p.position.lng], {
          icon: podIcon(p, isSel("pod", p.id)),
          zIndexOffset: 2000,
        });
        mk.bindTooltip(`${p.name} · ${p.online ? "online" : "OFFLINE"}`, {
          direction: "top",
          offset: [0, -14],
        });
        mk.on("click", select({ kind: "pod", id: p.id }));
        return mk;
      },
      (mk, p) => {
        mk.setLatLng([p.position.lat, p.position.lng]);
        mk.setIcon(podIcon(p, isSel("pod", p.id)));
        mk.setTooltipContent(`${p.name} · ${p.online ? "online" : "OFFLINE"}`);
      },
    );

    ls.teams.sync(
      (teams ?? []).filter((t) => t.team.position),
      (t) => t.team.id,
      (t) =>
        JSON.stringify([
          t.team.position,
          t.team.status,
          t.team.name,
          t.color,
          t.task,
          t.stale,
          t.self,
          t.dim,
          isSel("team", t.team.id),
        ]),
      (t) => {
        const p = t.team.position!;
        const mk = L.marker([p.lat, p.lng], {
          icon: teamIcon(t, isSel("team", t.team.id)),
          zIndexOffset: 3000,
        });
        mk.on("click", select({ kind: "team", id: t.team.id }));
        return mk;
      },
      (mk, t) => {
        const p = t.team.position!;
        mk.setLatLng([p.lat, p.lng]);
        mk.setIcon(teamIcon(t, isSel("team", t.team.id)));
      },
    );

    if (accuracy && accuracy.radiusM > 0) {
      ls.acc.setLatLng([accuracy.center.lat, accuracy.center.lng]).setRadius(accuracy.radiusM);
      if (!m.hasLayer(ls.acc)) ls.acc.addTo(m);
    } else if (m.hasLayer(ls.acc)) {
      ls.acc.remove();
    }
  }, [pods, detections, areas, teams, routes, selected, accuracy, teamLabels]);

  // keep the followed point (the moving pod) in view
  // fly to a point on request
  const focusKey = focus?.key;
  useEffect(() => {
    const m = map.current;
    if (!m || !focus) return;
    m.flyTo([focus.point.lat, focus.point.lng], Math.max(m.getZoom(), 18), { duration: 0.6 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const followKey = follow ? `${follow.lat.toFixed(6)},${follow.lng.toFixed(6)}` : "";
  useEffect(() => {
    const m = map.current;
    if (!m || !follow) return;
    const inner = m.getBounds().pad(-0.25);
    if (!inner.contains([follow.lat, follow.lng]))
      m.panTo([follow.lat, follow.lng], { animate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey]);

  // crosshair while placing
  useEffect(() => {
    const c = map.current?.getContainer();
    if (c) c.style.cursor = onMapClick ? "crosshair" : "";
  }, [onMapClick]);

  // fit to points when the key changes
  const fitKey = fit?.key;
  useEffect(() => {
    const m = map.current;
    if (!m || !fit || !fit.points.length) return;
    if (fit.points.length === 1)
      m.setView([fit.points[0]!.lat, fit.points[0]!.lng], Math.max(m.getZoom(), 18));
    else
      m.fitBounds(L.latLngBounds(fit.points.map((p) => [p.lat, p.lng])), {
        padding: [48, 48],
        maxZoom: 19,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  return <div ref={el} className="h-full w-full" />;
}

/* ---------------- icons & styles ---------------- */

function tierZ(t: Tier) {
  return { VERY_HIGH: 900, HIGH: 800, LOW: 700, NONE: 600 }[t];
}

function esc(s: string) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

function detIcon(d: Detection, selected: boolean, team?: { name: string; color: string }) {
  const active = ACTIVE_STATUSES.includes(d.status);
  const color = TIER_HEX[d.tier];
  const ring = d.status === "OPEN" ? "transparent" : STATUS_HEX[d.status];
  const cls = [
    "det",
    active ? "" : "det--closed",
    selected ? "det--sel" : "",
    d.tier === "VERY_HIGH" && d.status === "OPEN" ? "det--hot" : "",
  ].join(" ");
  const teamTag =
    team && active
      ? `<span class="det-team" style="--t:${team.color}">→ ${esc(team.name)}</span>`
      : "";
  return L.divIcon({
    className: "map-div",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    html: `<div class="${cls}" style="--c:${color};--r:${ring}">${d.fire ? `<span class="det-fire">🔥</span>` : d.smoke ? `<span class="det-fire">💨</span>` : ""}<span>${Number(d.id.replace("D-", "")) || d.id}</span>${teamTag}</div>`,
  });
}

function detTip(d: Detection) {
  const what = [d.thermal && "heat", d.signal && "phone", d.fire && "FIRE", d.smoke && "SMOKE/GAS"]
    .filter(Boolean)
    .join(" + ");
  return `<b>${d.id}</b> · ${d.tier.replace("_", " ")} · ${what}${d.label ? `<br>${esc(d.label)}` : ""}<br>${d.status.replace("_", " ")} · ${d.hits} reading${d.hits === 1 ? "" : "s"}`;
}

function podIcon(p: MapPod, selected: boolean) {
  const color = p.online ? (p.tier === "NONE" ? "#22c55e" : TIER_HEX[p.tier]) : "#6b7280";
  return L.divIcon({
    className: "map-div",
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    html: `<div class="podtag ${p.online ? "podtag--live" : ""} ${selected ? "podtag--sel" : ""}" style="--c:${color}"><span class="podtag-dot"></span>📡 ${esc(p.name)}</div>`,
  });
}

function teamIcon(t: MapTeam, selected: boolean) {
  const sos = t.team.status === "SOS";
  const color = sos
    ? TEAM_STATUS_HEX.SOS
    : t.stale
      ? "#6b7280"
      : (t.color ?? TEAM_STATUS_HEX[t.team.status]);
  const cls = [
    "teamtag",
    t.team.status === "SOS" ? "teamtag--sos" : "",
    t.self ? "teamtag--self" : "",
    t.stale ? "teamtag--stale" : "",
    t.dim ? "teamtag--dim" : "",
    selected ? "teamtag--sel" : "",
  ].join(" ");
  return L.divIcon({
    className: "map-div",
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    html: `<div class="${cls}" style="--c:${color}"><span class="teamtag-dot"></span><span class="teamtag-name">${esc(t.self ? "YOU" : t.team.name)}${sos ? " · SOS" : t.task ? ` ${esc(t.task)}` : ""}${t.stale && !t.self ? " · no signal" : ""}</span></div>`,
  });
}

function areaStyle(a: Area, selected: boolean): L.CircleMarkerOptions & { radius: number } {
  const hazard = a.kind === "hazard";
  const color = hazard ? FIRE_HEX : a.status === "OPEN" ? "#2563eb" : STATUS_HEX[a.status];
  return {
    radius: a.radiusM,
    color,
    weight: selected ? 4 : 2,
    dashArray: hazard ? undefined : "6 6",
    fillColor: color,
    fillOpacity: hazard ? 0.3 : 0.1,
  };
}

function areaTip(a: Area) {
  return a.kind === "hazard"
    ? `⚠ ${a.id} HAZARD · ${esc(a.label)} · ${a.radiusM} m`
    : `${a.id} SEARCH AREA · ${esc(a.label)} · ${a.status.replace("_", " ")}`;
}
