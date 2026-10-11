import { FIRE_HEX, TEAM_STATUS_HEX, TIER_HEX, fmtTime, type LogEntry } from "@/lib/domain";

const KIND: Partial<Record<LogEntry["kind"], [string, string]>> = {
  detection: ["🔎", TIER_HEX.HIGH],
  "detection-upgrade": ["⬆", TIER_HEX.VERY_HIGH],
  hazard: ["🔥", FIRE_HEX],
  sos: ["🆘", TEAM_STATUS_HEX.SOS],
  assignment: ["👥", "#7c3aed"],
  status: ["✔", "#0891b2"],
  team: ["👥", "#6b7280"],
  pod: ["📡", "#6b7280"],
  system: ["⚙", "#6b7280"],
};

export function LogTab({ log, onPick }: { log: LogEntry[]; onPick: (e: LogEntry) => void }) {
  const rows = [...log].reverse();
  if (!rows.length)
    return <p className="py-8 text-center text-sm text-muted-foreground">Nothing logged yet.</p>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 text-sm">
        <span className="text-muted-foreground">Download:</span>
        <a className="font-medium text-primary underline" href="/api/export/detections.csv">
          Detections (CSV)
        </a>
        <a className="font-medium text-primary underline" href="/api/export/log.csv">
          Log (CSV)
        </a>
        <a className="font-medium text-primary underline" href="/api/export/readings.csv">
          All sensor readings (CSV)
        </a>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {rows.map((e) => {
          const [icon, color] = KIND[e.kind] ?? ["•", "#6b7280"];
          return (
            <li
              key={e.id}
              onClick={() => onPick(e)}
              className="flex cursor-pointer gap-3 px-3 py-2 text-sm hover:bg-secondary"
            >
              <span className="w-16 shrink-0 font-mono text-xs leading-5 text-muted-foreground">
                {fmtTime(e.t)}
              </span>
              <span style={{ color }}>{icon}</span>
              <span>{e.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
