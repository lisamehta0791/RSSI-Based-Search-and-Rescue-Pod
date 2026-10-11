import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { usePodSerial } from "@/hooks/usePodSerial";
import {
  FIRE_HEX,
  OK_HEX,
  TIER_HEX,
  TIER_MEANING,
  TRACK_SOURCE_LABEL,
  WARN_HEX,
  fmtAgo,
  fmtLL,
  podOnline,
  podPosition,
  type Pod,
  type Reading,
  type Team,
} from "@/lib/domain";
import { Btn, Led, TierBadge, selectCls } from "@/components/bits";

type Usb = ReturnType<typeof usePodSerial>;
export interface LaptopTracking {
  podId: string | null;
  setPodId: (id: string | null) => void;
  status: string;
  accuracy: number | null;
}

const BUZZER = {
  VERY_HIGH: "Double beep",
  HIGH: "Single beep",
  LOW: "Silent",
  NONE: "Silent",
} as const;

export function PodTab({
  pods,
  teams,
  now,
  usb,
  laptop,
  placingPodId,
  onPlace,
}: {
  pods: Pod[];
  teams: Team[];
  now: number;
  usb: Usb;
  laptop: LaptopTracking;
  placingPodId: string | null;
  onPlace: (podId: string | null) => void;
}) {
  return (
    <div className="space-y-3">
      <UsbCard usb={usb} />
      {!pods.length ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No pod has sent data yet. Connect it above — or, without hardware, run{" "}
          <code className="rounded bg-secondary px-1">npm run sim</code> for a simulated pod.
        </div>
      ) : null}
      {pods.map((p) => (
        <PodCard
          key={p.id}
          pod={p}
          teams={teams}
          now={now}
          laptop={laptop}
          placing={placingPodId === p.id}
          onPlace={() => onPlace(placingPodId === p.id ? null : p.id)}
        />
      ))}
    </div>
  );
}

/* ---------------- USB connection + serial monitor ---------------- */

function UsbCard({ usb }: { usb: Usb }) {
  const [showConsole, setShowConsole] = useState(false);
  const box = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (showConsole && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [usb.lines, showConsole]);

  if (usb.status === "unsupported") {
    return (
      <div className="rounded-xl border-2 p-3 text-sm" style={{ borderColor: WARN_HEX }}>
        <p className="font-semibold" style={{ color: WARN_HEX }}>
          This browser can't read USB
        </p>
        <p className="mt-1">
          Open this page in <b>Google Chrome</b> or <b>Microsoft Edge</b> on the laptop the pod is
          plugged into, at <b>http://localhost:8080/ops</b>.
        </p>
      </div>
    );
  }
  const connected = usb.status === "connected";
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base">🔌</span>
        <span className="font-semibold">Pod USB connection</span>
        {connected ? (
          <span className="text-sm font-semibold" style={{ color: OK_HEX }}>
            ● Connected
          </span>
        ) : null}
      </div>
      {connected ? (
        <p className="text-sm text-muted-foreground">
          {usb.podIds.length
            ? `Receiving from ${usb.podIds.join(", ")}`
            : "Waiting for data from the pod…"}{" "}
          · {usb.sent} readings sent
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Plug the pod into this laptop, close Arduino's Serial Monitor, then click Connect and
          choose the port named <b>CP210x</b> or <b>USB-SERIAL CH340</b>.
        </p>
      )}
      {usb.error ? (
        <p className="text-sm font-medium" style={{ color: TIER_HEX.VERY_HIGH }}>
          {usb.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {connected ? (
          <Btn onClick={() => void usb.disconnect()}>Disconnect</Btn>
        ) : (
          <Btn
            tone="primary"
            size="lg"
            disabled={usb.status === "connecting"}
            onClick={() => void usb.connect()}
          >
            {usb.status === "connecting" ? "Connecting…" : "Connect pod (USB)"}
          </Btn>
        )}
        <Btn tone={showConsole ? "active" : "default"} onClick={() => setShowConsole((v) => !v)}>
          Serial monitor
        </Btn>
      </div>
      {showConsole ? (
        <div className="space-y-1">
          <pre
            ref={box}
            className="h-56 overflow-y-auto rounded-lg bg-[#0b1220] p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[#cbd5e1]"
          >
            {usb.lines.length ? usb.lines.join("\n") : "(nothing received yet)"}
          </pre>
          <Btn size="sm" onClick={usb.clearConsole}>
            Clear
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- one pod ---------------- */

function PodCard({
  pod,
  teams,
  now,
  laptop,
  placing,
  onPlace,
}: {
  pod: Pod;
  teams: Team[];
  now: number;
  laptop: LaptopTracking;
  placing: boolean;
  onPlace: () => void;
}) {
  const online = podOnline(pod, now);
  const r = pod.lastReading;
  const pos = podPosition(pod, teams);
  const delta = r?.objC != null && r.ambC != null ? r.objC - r.ambC : null;
  const tier = online && r ? r.tier : "NONE";
  // A gas sensor is fitted if the pod reports a gas value (or is warming one up).
  // Readings saved before the gas sensor was added have no gas fields at all, hence "!= null".
  const gasFitted = !!r && (r.gasRaw != null || !!r.gasWarming || r.smoke != null);
  const trackingHere = laptop.podId === pod.id;
  const tp = pod.trackedPosition;
  const trackerLink = `${window.location.protocol}//${window.location.host}/tracker/${pod.id}`;

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <span
          className="h-3 w-3 rounded-full"
          style={{
            backgroundColor: online ? OK_HEX : "#9ca3af",
            boxShadow: online ? `0 0 8px ${OK_HEX}` : undefined,
          }}
        />
        <span className="text-base font-bold">📡 {pod.name}</span>
        <span className="text-sm text-muted-foreground">
          {online
            ? `Live via ${pod.link ?? "?"}`
            : pod.lastSeen
              ? `Offline · ${fmtAgo(now - pod.lastSeen)}`
              : "Never seen"}
        </span>
        {online && r ? (
          <span className="ml-auto">
            {tier === "NONE" ? (
              <span className="text-sm text-muted-foreground">Nothing detected</span>
            ) : (
              <TierBadge tier={tier} />
            )}
          </span>
        ) : null}
      </div>

      {/* Mirror of the physical LEDs + buzzer */}
      <div className="flex items-center gap-6 rounded-lg bg-secondary px-4 py-3">
        <Led on={online && !!r?.signal} color="#dc2626" label="Signal" />
        <Led on={online && !!r?.thermal} color="#dc2626" label="Thermal" />
        {gasFitted ? (
          <Led
            on={!r || r.gasWarming ? null : online && !!r.smoke}
            color={FIRE_HEX}
            label={r?.gasWarming ? "Gas: warming" : "Smoke / gas"}
          />
        ) : (
          <Led
            on={!r || r.flame === null ? null : online && r.flame}
            color={FIRE_HEX}
            label="Flame"
          />
        )}
        <div className="ml-auto text-right">
          <p className="text-xs text-muted-foreground">Buzzer</p>
          <p
            className="font-semibold"
            style={{ color: tier !== "NONE" ? TIER_HEX[tier] : undefined }}
          >
            {online && r ? (r.tier === "NONE" && r.smoke ? "Low beep (gas)" : BUZZER[r.tier]) : "—"}
          </p>
        </div>
      </div>

      <SignalMeter reading={r} online={online} />

      {r ? (
        <div className="grid grid-cols-3 gap-2 text-sm">
          <Cell
            k="Object temp"
            v={r.objC != null ? `${r.objC.toFixed(1)} °C` : r.mlxOk ? "—" : "Sensor error"}
          />
          <Cell k="Room temp" v={r.ambC != null ? `${r.ambC.toFixed(1)} °C` : "—"} />
          <Cell
            k="Warmer by"
            v={delta != null ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} °C` : "—"}
          />
          <Cell k="Phone packets" v={String(r.probes)} />
          <Cell k="Strongest" v={r.rssi <= -127 ? "none" : `${r.rssi} dBm`} />
          {gasFitted ? (
            <Cell
              k={`Gas sensor${r.gasRaw != null ? ` · ${r.gasRaw}` : ""}${r.gasBase != null ? ` (clean ${r.gasBase})` : ""}`}
              v={r.gasWarming ? "Warming up…" : r.smoke ? "SMOKE / GAS" : "Clean air"}
            />
          ) : (
            <Cell
              k="Flame sensor"
              v={r.flame === null ? "Not fitted" : r.flame ? "FIRE" : "Clear"}
            />
          )}
        </div>
      ) : null}
      {online && r ? <p className="text-sm text-muted-foreground">{TIER_MEANING[r.tier]}</p> : null}
      {online && r?.smoke ? (
        <p
          className="rounded-lg border-2 px-3 py-2 text-sm font-semibold"
          style={{ borderColor: FIRE_HEX, color: FIRE_HEX }}
        >
          💨 Smoke or flammable gas in the air here — a hazard zone has been marked at the pod.
        </p>
      ) : null}
      {online && r?.gasWarming ? (
        <p className="text-sm text-muted-foreground">
          Gas sensor is warming up (about 1 minute after power-on) — smoke/gas isn't checked yet.
        </p>
      ) : null}

      {/* ---- where is the pod? ---- */}
      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <p className="font-semibold">Pod location</p>
          <span className="ml-auto font-mono text-xs text-muted-foreground">{fmtLL(pos)}</span>
        </div>
        <select
          className={`${selectCls} w-full`}
          value={
            pod.locationMode === "carried" ? `team:${pod.carrierTeamId ?? ""}` : pod.locationMode
          }
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("team:"))
              void api.updatePod(pod.id, {
                locationMode: "carried",
                carrierTeamId: v.slice(5) || null,
              });
            else void api.updatePod(pod.id, { locationMode: v as "tracked" | "manual" });
          }}
        >
          <option value="tracked">Live — laptop or phone moving with the pod</option>
          {teams.map((t) => (
            <option key={t.id} value={`team:${t.id}`}>
              Live — follow {t.name}'s phone GPS
            </option>
          ))}
          <option value="manual">Fixed — I'll click it on the map</option>
        </select>

        {pod.locationMode === "tracked" ? (
          <div className="space-y-2 rounded-lg bg-secondary p-3 text-sm">
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={trackingHere}
                onChange={(e) => laptop.setPodId(e.target.checked ? pod.id : null)}
              />
              Use this laptop's location for {pod.name}
            </label>
            {trackingHere ? (
              <TrackStatus status={laptop.status} accuracy={laptop.accuracy} />
            ) : null}
            <p className="text-muted-foreground">
              Or carry a phone with the pod and open the <b>phone tracker</b> on it — phones have
              real GPS (more accurate than a laptop).
            </p>
            <div className="flex flex-wrap gap-2">
              <Btn
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(trackerLink);
                  toast.success(
                    "Phone tracker link copied — open it on the phone carried with the pod",
                  );
                }}
              >
                Copy phone tracker link
              </Btn>
              <a
                href={`/tracker/${pod.id}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center rounded-lg border border-input bg-card px-2.5 font-medium hover:bg-secondary"
              >
                Open tracker ↗
              </a>
            </div>
            {tp ? (
              <p>
                Last position from <b>{TRACK_SOURCE_LABEL[tp.source]}</b> {fmtAgo(now - tp.t)}
                {tp.accuracyM ? ` · ±${Math.round(tp.accuracyM)} m` : ""}
              </p>
            ) : (
              <p style={{ color: WARN_HEX }}>
                No live position yet
                {pod.manualPosition ? " — using the spot clicked on the map" : ""}.
              </p>
            )}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {pod.locationMode !== "carried" ? (
            <Btn size="sm" tone={placing ? "active" : "default"} onClick={onPlace}>
              {placing ? "Click on the map…" : "Set position by clicking map"}
            </Btn>
          ) : null}
          {pod.trail.length > 1 ? (
            <Btn size="sm" onClick={() => void api.clearTrail(pod.id)}>
              Clear trail
            </Btn>
          ) : null}
          {!online ? (
            <Btn
              size="sm"
              tone="ghost"
              className="ml-auto text-muted-foreground"
              onClick={() =>
                confirm(`Remove ${pod.name} from the list?`) && void api.deletePod(pod.id)
              }
            >
              Remove pod
            </Btn>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function TrackStatus({ status, accuracy }: { status: string; accuracy: number | null }) {
  const msg: Record<string, [string, string]> = {
    ok: [OK_HEX, `● Sharing location${accuracy ? ` (±${Math.round(accuracy)} m)` : ""}`],
    starting: [WARN_HEX, "Getting location… allow the browser's location request"],
    denied: [
      TIER_HEX.VERY_HIGH,
      "Location permission was denied — allow it in the browser's site settings",
    ],
    unavailable: [
      TIER_HEX.VERY_HIGH,
      "Location unavailable on this device (laptops need WiFi on + internet)",
    ],
    insecure: [TIER_HEX.VERY_HIGH, "Location needs https:// or localhost — see README"],
    off: ["", ""],
  };
  const [color, text] = msg[status] ?? ["", status];
  return text ? (
    <p className="font-medium" style={{ color }}>
      {text}
    </p>
  ) : null;
}

function Cell({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg border border-border px-2.5 py-1.5">
      <p className="text-xs text-muted-foreground">{k}</p>
      <p className="font-semibold">{v}</p>
    </div>
  );
}

/* ---------------- hot / cold phone-signal meter ---------------- */

// Rough guide for a phone heard by an ESP8266. Walls and bodies easily cost 10–20 dB.
const BANDS = [
  { min: -50, label: "Very close", range: "about 1–2 m", color: "#dc2626" },
  { min: -60, label: "Close", range: "about 2–5 m", color: "#d97706" },
  { min: -70, label: "Nearby", range: "about 5–15 m", color: "#2563eb" },
  { min: -200, label: "Far / behind walls", range: "15 m+ or blocked", color: "#6b7280" },
];

function SignalMeter({ reading, online }: { reading: Reading | null; online: boolean }) {
  const hist = useRef<{ seq: number; rssi: number }[]>([]);
  if (reading && reading.rssi > -127 && hist.current.at(-1)?.seq !== reading.seq) {
    hist.current = [...hist.current, { seq: reading.seq, rssi: reading.rssi }].slice(-8);
  }
  const h = hist.current;
  const avg = (xs: { rssi: number }[]) => xs.reduce((s, x) => s + x.rssi, 0) / xs.length;
  const trend = h.length >= 6 ? avg(h.slice(-3)) - avg(h.slice(-6, -3)) : 0;
  const rssi = online && reading && reading.rssi > -127 ? reading.rssi : null;
  const band = rssi === null ? null : BANDS.find((b) => rssi >= b.min)!;
  const pct = rssi === null ? 0 : Math.min(Math.max((rssi + 95) / 60, 0), 1) * 100;

  return (
    <div className="space-y-1.5 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2">
        <p className="font-semibold">📶 Phone signal — hot / cold</p>
        <span className="ml-auto text-sm text-muted-foreground">
          {rssi === null ? "No phone heard" : `${rssi} dBm`}
        </span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, backgroundColor: band?.color }}
        />
      </div>
      {band ? (
        <p className="text-sm">
          <b style={{ color: band.color }}>{band.label}</b>{" "}
          <span className="text-muted-foreground">— {band.range}</span>
          {Math.abs(trend) >= 3 ? (
            <b style={{ color: trend > 0 ? OK_HEX : WARN_HEX }}>
              {trend > 0 ? "  ▲ Getting stronger — keep going" : "  ▼ Getting weaker — turn back"}
            </b>
          ) : null}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Move the pod around — the bar grows as you get closer to a phone.
        </p>
      )}
    </div>
  );
}
