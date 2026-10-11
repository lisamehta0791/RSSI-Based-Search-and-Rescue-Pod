import { useState } from "react";
import { api } from "@/lib/api";
import {
  ACTIVE_STATUSES,
  STATUS_LABEL,
  fmtDistance,
  rankTeamsFor,
  teamColor,
  type AppState,
  type LatLng,
  type TargetStatus,
} from "@/lib/domain";
import { selectCls } from "@/components/bits";

const STATUSES: TargetStatus[] = [
  "OPEN",
  "ASSIGNED",
  "EN_ROUTE",
  "ON_SCENE",
  "RESCUED",
  "NOTHING_FOUND",
  "DISMISSED",
];

export interface AssignTarget {
  kind: "detection" | "area";
  id: string;
  position: LatLng | null;
  assignedTeamId: string | null;
  status: TargetStatus;
}

/**
 * One-click team assignment for a detection or search area.
 *  - Not assigned: a row of team buttons, best first (free teams, then nearest).
 *  - Assigned: the team, its progress, and Change / Unassign.
 *  - In "assign mode" for a team: one big add/remove button for that team.
 */
export function AssignControls({
  state,
  target,
  dispatchTeamId,
}: {
  state: AppState;
  target: AssignTarget;
  dispatchTeamId: string | null;
}) {
  const [changing, setChanging] = useState(false);
  const assign = (teamId: string | null) => {
    setChanging(false);
    void api.updateTarget(target.kind, target.id, { assignedTeamId: teamId });
  };
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  // ---- assign mode: one button for the team being dispatched ----
  if (dispatchTeamId) {
    const t = state.teams.find((x) => x.id === dispatchTeamId);
    if (!t) return null;
    const mine = target.assignedTeamId === t.id;
    const other = target.assignedTeamId
      ? state.teams.find((x) => x.id === target.assignedTeamId)
      : undefined;
    return (
      <button
        type="button"
        onClick={(e) => {
          stop(e);
          assign(mine ? null : t.id);
        }}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border-2 text-sm font-semibold transition"
        style={
          mine
            ? { backgroundColor: teamColor(t.id), borderColor: teamColor(t.id), color: "white" }
            : { borderColor: teamColor(t.id), color: teamColor(t.id) }
        }
      >
        {mine
          ? `✓ Assigned to ${t.name} — click to remove`
          : other
            ? `Move from ${other.name} to ${t.name}`
            : `+ Assign to ${t.name}`}
      </button>
    );
  }

  const assigned = target.assignedTeamId
    ? state.teams.find((x) => x.id === target.assignedTeamId)
    : undefined;
  const closed = !ACTIVE_STATUSES.includes(target.status);

  return (
    <div className="space-y-2" onClick={stop}>
      {assigned && !changing ? (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-white"
            style={{ backgroundColor: teamColor(assigned.id) }}
          >
            👥 {assigned.name}
          </span>
          <select
            className={`${selectCls} w-36`}
            value={target.status}
            onChange={(e) =>
              void api.updateTarget(target.kind, target.id, {
                status: e.target.value as TargetStatus,
              })
            }
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="text-sm font-medium text-primary hover:underline"
            onClick={() => setChanging(true)}
          >
            Change team
          </button>
          <button
            type="button"
            className="text-sm text-muted-foreground hover:underline"
            onClick={() => assign(null)}
          >
            Unassign
          </button>
        </div>
      ) : closed && !changing ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {STATUS_LABEL[target.status]}
          <button
            type="button"
            className="font-medium text-primary hover:underline"
            onClick={() => void api.updateTarget(target.kind, target.id, { status: "OPEN" })}
          >
            Reopen
          </button>
        </div>
      ) : (
        <TeamButtons
          state={state}
          target={target}
          onPick={assign}
          onCancel={changing ? () => setChanging(false) : undefined}
        />
      )}
    </div>
  );
}

function TeamButtons({
  state,
  target,
  onPick,
  onCancel,
}: {
  state: AppState;
  target: AssignTarget;
  onPick: (teamId: string) => void;
  onCancel?: (() => void) | undefined;
}) {
  const [all, setAll] = useState(false);
  const options = rankTeamsFor(state, target.position).filter(
    (o) => o.team.id !== target.assignedTeamId,
  );
  if (!state.teams.length) {
    return <p className="text-sm text-muted-foreground">Add a team in the Teams tab first.</p>;
  }
  const shown = all ? options : options.slice(0, 3);
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-muted-foreground">
        SEND A TEAM {onCancel ? "" : "· best match first"}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((o, i) => {
          const c = teamColor(o.team.id);
          const best = i === 0 && o.free && !onCancel;
          return (
            <button
              key={o.team.id}
              type="button"
              onClick={() => onPick(o.team.id)}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border-2 px-3 text-sm font-semibold transition hover:brightness-95"
              style={
                best
                  ? { backgroundColor: c, borderColor: c, color: "white" }
                  : { borderColor: c, color: c, backgroundColor: "var(--color-card)" }
              }
              title={best ? "Free and closest" : undefined}
            >
              {o.team.name}
              <span className="text-xs font-medium opacity-80">
                {o.distanceM !== null ? fmtDistance(o.distanceM) : ""}
                {o.team.status === "SOS"
                  ? " · SOS"
                  : o.free
                    ? " · free"
                    : ` · ${o.load} task${o.load > 1 ? "s" : ""}`}
              </span>
            </button>
          );
        })}
        {options.length > 3 && !all ? (
          <button
            type="button"
            className="h-10 px-2 text-sm font-medium text-primary hover:underline"
            onClick={() => setAll(true)}
          >
            +{options.length - 3} more
          </button>
        ) : null}
        {onCancel ? (
          <button
            type="button"
            className="h-10 px-2 text-sm text-muted-foreground hover:underline"
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
