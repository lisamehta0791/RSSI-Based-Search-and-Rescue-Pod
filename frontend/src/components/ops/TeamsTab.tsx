import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import {
  ACTIVE_STATUSES,
  STATUS_HEX,
  STATUS_LABEL,
  TEAM_STATUS_HEX,
  TIER_HEX,
  WARN_HEX,
  fmtAgo,
  fmtDistance,
  haversine,
  targetsForTeam,
  teamColor,
  teamStale,
  type AppState,
  type LatLng,
  type Team,
} from "@/lib/domain";
import { Btn, TeamStatusBadge, inputCls } from "@/components/bits";

export function TeamsTab({
  state,
  now,
  selectedTeamId,
  onSelect,
  placingTeamId,
  onPlace,
  onDispatch,
  onFocus,
}: {
  state: AppState;
  now: number;
  selectedTeamId: string | null;
  onSelect: (id: string) => void;
  placingTeamId: string | null;
  onPlace: (id: string | null) => void;
  /** enter "assign tasks" mode for this team */
  onDispatch: (id: string) => void;
  onFocus: (p: LatLng) => void;
}) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState("");

  const busy = (t: Team) =>
    targetsForTeam(state, t.id).some((x) => ACTIVE_STATUSES.includes(x.item.status));
  const sos = state.teams.filter((t) => t.status === "SOS").length;
  const noSignal = state.teams.filter((t) => t.status !== "SOS" && teamStale(t, now)).length;
  const free = state.teams.filter((t) => t.status !== "SOS" && !busy(t)).length;
  const working = state.teams.length - free - sos;

  // SOS first, then busy teams, then free.
  const ordered = [...state.teams].sort(
    (a, b) =>
      Number(b.status === "SOS") - Number(a.status === "SOS") ||
      Number(busy(b)) - Number(busy(a)) ||
      a.name.localeCompare(b.name),
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2 text-center">
        <Summary n={free} label="Free" color={TEAM_STATUS_HEX.AVAILABLE} />
        <Summary n={working} label="On a task" color={TEAM_STATUS_HEX.EN_ROUTE} />
        <Summary n={sos} label="SOS" color={TEAM_STATUS_HEX.SOS} />
        <Summary n={noSignal} label="No signal" color={WARN_HEX} />
      </div>

      {ordered.map((t) => (
        <TeamCard
          key={t.id}
          t={t}
          state={state}
          now={now}
          selected={t.id === selectedTeamId}
          placing={placingTeamId === t.id}
          onSelect={() => onSelect(t.id)}
          onPlace={() => onPlace(placingTeamId === t.id ? null : t.id)}
          onDispatch={() => onDispatch(t.id)}
          onFocus={onFocus}
        />
      ))}

      <form
        className="space-y-2 rounded-xl border border-dashed border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void api.createTeam(name, members).then(() => {
            setName("");
            setMembers("");
          });
        }}
      >
        <p className="font-semibold">Add a rescue team</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Team name, e.g. Delta"
          className={inputCls}
        />
        <input
          value={members}
          onChange={(e) => setMembers(e.target.value)}
          placeholder="Members (optional)"
          className={inputCls}
        />
        <Btn tone="primary" type="submit" disabled={!name.trim()}>
          Add team
        </Btn>
      </form>
    </div>
  );
}

function Summary({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div
      className="rounded-lg px-2 py-2"
      style={{ backgroundColor: `color-mix(in oklab, ${color} ${n ? 14 : 6}%, transparent)` }}
    >
      <p
        className="text-2xl font-bold"
        style={{ color: n ? color : "var(--color-muted-foreground)" }}
      >
        {n}
      </p>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
    </div>
  );
}

function TeamCard({
  t,
  state,
  now,
  selected,
  placing,
  onSelect,
  onPlace,
  onDispatch,
  onFocus,
}: {
  t: Team;
  state: AppState;
  now: number;
  selected: boolean;
  placing: boolean;
  onSelect: () => void;
  onPlace: () => void;
  onDispatch: () => void;
  onFocus: (p: LatLng) => void;
}) {
  const [more, setMore] = useState(false);
  const color = teamColor(t.id);
  const stale = teamStale(t, now);
  const sos = t.status === "SOS";
  const tasks = targetsForTeam(state, t.id).filter((x) => ACTIVE_STATUSES.includes(x.item.status));
  const link = `${window.location.protocol}//${window.location.host}/team/${t.id}`;

  return (
    <div
      id={`card-${t.id}`}
      onClick={onSelect}
      className={`cursor-pointer overflow-hidden rounded-xl border bg-card transition ${selected ? "ring-2 ring-primary/30" : ""}`}
      style={{
        borderColor: sos ? TEAM_STATUS_HEX.SOS : selected ? "var(--color-primary)" : undefined,
        boxShadow: `inset 5px 0 0 ${color}${sos ? `, 0 0 0 2px ${TEAM_STATUS_HEX.SOS}` : ""}`,
      }}
    >
      <div className="space-y-2 py-3 pr-3 pl-5">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold" style={{ color }}>
            {t.name}
          </span>
          <TeamStatusBadge status={t.status} />
          <span className="ml-auto text-xs text-muted-foreground">
            {t.position ? (
              <span style={{ color: stale ? WARN_HEX : undefined }}>
                {stale ? "⚠ " : "● "}
                {fmtAgo(now - t.position.t)}
              </span>
            ) : (
              "no location yet"
            )}
          </span>
        </div>

        {sos ? (
          <p
            className="rounded-lg px-3 py-2 text-sm font-semibold text-white"
            style={{ backgroundColor: TEAM_STATUS_HEX.SOS }}
          >
            🆘 Needs help {t.sosAt ? `(${fmtAgo(now - t.sosAt)})` : ""} — send help to their last
            location
          </p>
        ) : null}

        {/* tasks */}
        {tasks.length ? (
          <ul className="space-y-1">
            {tasks.map((x) => (
              <li key={x.id} className="flex items-center gap-2 text-sm">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: x.kind === "detection" ? TIER_HEX[x.item.tier] : "#2563eb",
                  }}
                />
                <span className="font-semibold">{x.id}</span>
                <span className="truncate text-muted-foreground">{x.item.label}</span>
                <span
                  className="ml-auto shrink-0 font-medium"
                  style={{ color: STATUS_HEX[x.item.status] }}
                >
                  {STATUS_LABEL[x.item.status]}
                </span>
                {t.position && x.position ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {fmtDistance(haversine(t.position, x.position))}
                  </span>
                ) : null}
                <button
                  type="button"
                  title="Remove this task from the team"
                  className="shrink-0 px-1 text-muted-foreground hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.updateTarget(x.kind, x.id, { assignedTeamId: null });
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Free — no task</p>
        )}

        <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={onDispatch}
            className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold text-white"
            style={{ backgroundColor: color }}
          >
            + Assign tasks
          </button>
          {t.position ? (
            <Btn size="sm" className="h-9" onClick={() => onFocus(t.position!)}>
              Show on map
            </Btn>
          ) : null}
          {sos ? (
            <Btn
              size="sm"
              tone="danger"
              className="h-9"
              onClick={() => void api.sos(t.id, false, "operator")}
            >
              Clear SOS
            </Btn>
          ) : null}
          <Btn size="sm" tone="ghost" className="ml-auto h-9" onClick={() => setMore((m) => !m)}>
            {more ? "Less ▴" : "More ▾"}
          </Btn>
        </div>

        {more ? (
          <div
            className="space-y-2 border-t border-border pt-2 text-sm"
            onClick={(e) => e.stopPropagation()}
          >
            {t.members ? <p className="text-muted-foreground">👥 {t.members}</p> : null}
            {t.position ? (
              <p className="text-muted-foreground">
                Location from{" "}
                {t.position.source === "gps"
                  ? "phone GPS"
                  : t.position.source === "sim"
                    ? "simulator"
                    : "operator (set by hand)"}
                {t.position.accuracyM ? ` · ±${Math.round(t.position.accuracyM)} m` : ""}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Btn
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(link);
                  toast.success(`Link for ${t.name} copied — open it on their phone`);
                }}
              >
                Copy phone link
              </Btn>
              <a
                href={`/team/${t.id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center rounded-lg border border-input px-2.5 font-medium hover:bg-secondary"
              >
                Open team view ↗
              </a>
              <Btn size="sm" tone={placing ? "active" : "default"} onClick={onPlace}>
                {placing ? "Click on the map…" : "Set location by hand"}
              </Btn>
              <Btn
                size="sm"
                tone="ghost"
                className="text-muted-foreground"
                onClick={() => {
                  if (confirm(`Remove ${t.name}? Its tasks go back to "needs a team".`))
                    void api.deleteTeam(t.id);
                }}
              >
                Remove team
              </Btn>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
