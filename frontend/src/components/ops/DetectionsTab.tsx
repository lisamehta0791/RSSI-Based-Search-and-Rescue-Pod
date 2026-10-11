import { useState } from "react";
import { api } from "@/lib/api";
import {
  ACTIVE_STATUSES,
  FIRE_HEX,
  TIER_HEX,
  TIER_MEANING,
  WARN_HEX,
  fmtAgo,
  fmtLL,
  fmtTime,
  haversine,
  rankDetections,
  type AppState,
  type Area,
  type Detection,
  type Tier,
} from "@/lib/domain";
import { Btn, FireBadge, SaveInput, SmokeBadge, StatusBadge, TierBadge } from "@/components/bits";
import { AssignControls } from "./AssignControls";

type Filter = "unassigned" | "active" | "done" | "all";

export function DetectionsTab({
  state,
  now,
  selectedId,
  onSelect,
  placingId,
  onPlace,
  dispatchTeamId,
}: {
  state: AppState;
  now: number;
  selectedId: string | null;
  onSelect: (kind: "detection" | "area", id: string) => void;
  placingId: string | null;
  onPlace: (kind: "detection" | "area", id: string) => void;
  /** set while the operator is assigning tasks to one team */
  dispatchTeamId: string | null;
}) {
  const [filter, setFilter] = useState<Filter>("active");
  const [tierFilter, setTierFilter] = useState<Tier | "ALL">("ALL");

  const active = (d: Detection) => ACTIVE_STATUSES.includes(d.status);
  const matches = (d: Detection) =>
    filter === "all" ||
    (filter === "unassigned"
      ? active(d) && !d.assignedTeamId
      : filter === "active"
        ? active(d)
        : !active(d));
  const rows = rankDetections(state.detections).filter(
    (d) => matches(d) && (tierFilter === "ALL" || d.tier === tierFilter),
  );
  const unassigned = state.detections.filter((d) => active(d) && !d.assignedTeamId).length;
  const counts = (t: Tier) => state.detections.filter((d) => d.tier === t && active(d)).length;
  const searchAreas = state.areas.filter((a) => a.kind === "search");

  return (
    <div className="space-y-3">
      {/* Summary tiles double as tier filters */}
      <div className="grid grid-cols-3 gap-2">
        {(["VERY_HIGH", "HIGH", "LOW"] as Tier[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTierFilter(tierFilter === t ? "ALL" : t)}
            className={`rounded-lg border-2 px-3 py-2 text-left transition ${tierFilter === t ? "" : "border-transparent"}`}
            style={{
              backgroundColor: `color-mix(in oklab, ${TIER_HEX[t]} 12%, transparent)`,
              borderColor: tierFilter === t ? TIER_HEX[t] : undefined,
            }}
          >
            <p className="text-2xl font-bold" style={{ color: TIER_HEX[t] }}>
              {counts(t)}
            </p>
            <p className="text-xs font-medium text-muted-foreground">
              {t === "VERY_HIGH" ? "Very high" : t === "HIGH" ? "High" : "Low"}
            </p>
          </button>
        ))}
      </div>

      <div className="flex rounded-lg bg-secondary p-1 text-sm font-medium">
        {(
          [
            ["unassigned", `Needs a team (${unassigned})`],
            ["active", "Active"],
            ["done", "Completed"],
            ["all", "All"],
          ] as [Filter, string][]
        ).map(([f, label]) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`flex-1 rounded-md px-1 py-1.5 text-xs transition sm:text-sm ${filter === f ? "bg-card shadow-sm" : "text-muted-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {!rows.length ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {state.detections.length
            ? "Nothing matches this filter."
            : "No detections yet. Each time the pod detects heat or a phone, a new entry appears here."}
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((d) => (
            <DetectionCard
              key={d.id}
              d={d}
              state={state}
              dispatchTeamId={dispatchTeamId}
              now={now}
              selected={d.id === selectedId}
              placing={placingId === d.id}
              onSelect={() => onSelect("detection", d.id)}
              onPlace={() => onPlace("detection", d.id)}
            />
          ))}
        </ul>
      )}

      {searchAreas.length ? (
        <div className="space-y-2 pt-2">
          <p className="label-xs">Search areas</p>
          {searchAreas.map((a) => (
            <AreaCard
              key={a.id}
              a={a}
              state={state}
              dispatchTeamId={dispatchTeamId}
              selected={a.id === selectedId}
              placing={placingId === a.id}
              onSelect={() => onSelect("area", a.id)}
              onPlace={() => onPlace("area", a.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DetectionCard({
  d,
  state,
  dispatchTeamId,
  now,
  selected,
  placing,
  onSelect,
  onPlace,
}: {
  d: Detection;
  state: AppState;
  dispatchTeamId: string | null;
  now: number;
  selected: boolean;
  placing: boolean;
  onSelect: () => void;
  onPlace: () => void;
}) {
  const areas = state.areas;
  const live = now - d.lastSeen < 4000;
  const closed = !ACTIVE_STATUSES.includes(d.status);
  const nearHazard = d.position
    ? areas.find((a) => a.kind === "hazard" && haversine(a.center, d.position!) <= a.radiusM + 10)
    : undefined;
  const evidence = [
    d.thermal ? `Heat ${d.peakObjC?.toFixed(1) ?? "?"}°C` : null,
    d.signal ? `Phone ${d.maxRssi} dBm` : null,
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <li
      id={`card-${d.id}`}
      onClick={onSelect}
      className={`cursor-pointer overflow-hidden rounded-xl border bg-card transition ${selected ? "border-primary ring-2 ring-primary/25" : "border-border hover:border-input"} ${closed ? "opacity-70" : ""}`}
      style={{ boxShadow: `inset 5px 0 0 ${TIER_HEX[d.tier]}` }}
    >
      <div className="space-y-2 py-3 pr-3 pl-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-bold">{d.id}</span>
          <TierBadge tier={d.tier} />
          {d.fire ? <FireBadge /> : null}
          {d.smoke ? <SmokeBadge /> : null}
          {live ? (
            <span className="text-xs font-semibold text-green-600">● detecting now</span>
          ) : null}
          <span className="ml-auto text-xs text-muted-foreground">{fmtAgo(now - d.firstSeen)}</span>
        </div>
        <p className="text-sm">
          {evidence}
          <span className="text-muted-foreground">
            {" "}
            · {d.hits} reading{d.hits === 1 ? "" : "s"} · {d.podId}
          </span>
        </p>
        {d.label ? <p className="text-sm font-medium">📍 {d.label}</p> : null}
        {!d.position ? (
          <p className="text-sm font-medium" style={{ color: WARN_HEX }}>
            ⚠ No location — the pod's position wasn't known. Click "Place on map".
          </p>
        ) : null}
        {nearHazard ? (
          <p className="text-sm font-medium" style={{ color: FIRE_HEX }}>
            ⚠ Inside hazard zone "{nearHazard.label}"
          </p>
        ) : null}

        <AssignControls
          state={state}
          dispatchTeamId={dispatchTeamId}
          target={{
            kind: "detection",
            id: d.id,
            position: d.position,
            assignedTeamId: d.assignedTeamId,
            status: d.status,
          }}
        />

        {selected ? (
          <div
            className="space-y-2 border-t border-border pt-3"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-muted-foreground">{TIER_MEANING[d.tier]}</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <span className="text-muted-foreground">First detected</span>
              <span>{fmtTime(d.firstSeen)}</span>
              <span className="text-muted-foreground">Last detected</span>
              <span>{fmtTime(d.lastSeen)}</span>
              <span className="text-muted-foreground">Body heat</span>
              <span>
                {d.thermal ? `${d.peakObjC?.toFixed(1)}°C (room ${d.ambC?.toFixed(1)}°C)` : "No"}
              </span>
              <span className="text-muted-foreground">Phone signal</span>
              <span>{d.signal ? `${d.maxRssi} dBm` : "No"}</span>
              <span className="text-muted-foreground">Location</span>
              <span className="font-mono text-xs leading-5">{fmtLL(d.position)}</span>
            </div>
            <SaveInput
              value={d.label}
              placeholder="Label: building, floor, room…"
              onSave={(label) => void api.updateTarget("detection", d.id, { label })}
            />
            <SaveInput
              multiline
              value={d.notes}
              placeholder="Notes for the rescue team"
              onSave={(notes) => void api.updateTarget("detection", d.id, { notes })}
            />
            <div className="flex flex-wrap gap-2">
              <Btn tone={placing ? "active" : "default"} onClick={onPlace}>
                {placing ? "Click on the map…" : d.position ? "Move on map" : "Place on map"}
              </Btn>
              {!closed ? (
                <Btn
                  onClick={() => void api.updateTarget("detection", d.id, { status: "DISMISSED" })}
                >
                  False alarm
                </Btn>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function AreaCard({
  a,
  state,
  dispatchTeamId,
  selected,
  placing,
  onSelect,
  onPlace,
}: {
  a: Area;
  state: AppState;
  dispatchTeamId: string | null;
  selected: boolean;
  placing: boolean;
  onSelect: () => void;
  onPlace: () => void;
}) {
  return (
    <div
      id={`card-${a.id}`}
      onClick={onSelect}
      className={`cursor-pointer space-y-2 rounded-xl border bg-card p-3 ${selected ? "border-primary ring-2 ring-primary/25" : "border-border"}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-bold">{a.id}</span>
        <span className="text-sm font-medium">{a.label || "Search area"}</span>
        <span className="ml-auto">
          <StatusBadge status={a.status} />
        </span>
      </div>
      <AssignControls
        state={state}
        dispatchTeamId={dispatchTeamId}
        target={{
          kind: "area",
          id: a.id,
          position: a.center,
          assignedTeamId: a.assignedTeamId,
          status: a.status,
        }}
      />
      {selected ? (
        <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <SaveInput
            className="max-w-[12rem]"
            value={a.label}
            placeholder="Label"
            onSave={(label) => void api.updateTarget("area", a.id, { label })}
          />
          <SaveInput
            className="max-w-[6rem]"
            value={String(a.radiusM)}
            onSave={(v) => void api.updateTarget("area", a.id, { radiusM: Number(v) })}
          />
          <span className="text-sm text-muted-foreground">m</span>
          <Btn tone={placing ? "active" : "default"} onClick={onPlace}>
            {placing ? "Click map…" : "Move"}
          </Btn>
          <Btn onClick={() => confirm(`Remove ${a.id}?`) && void api.deleteArea(a.id)}>Remove</Btn>
        </div>
      ) : null}
    </div>
  );
}
