import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveState } from "@/hooks/useLiveState";
import { TEAM_STATUS_HEX, TIER_HEX, podOnline } from "@/lib/domain";
import logo from "@/assets/rssi-rescue-pod-logo.png";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "RSSI Rescue Pod — Field Console" },
      {
        name: "description",
        content:
          "Coordination console for the RSSI-Based Rescue and Search Pod: live pod detections, team assignment and rescuer tracking.",
      },
    ],
  }),
  component: Home,
});

function Home() {
  const { state, link, now } = useLiveState();

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col gap-5 px-4 py-10">
      <div className="flex items-center gap-3">
        <img src={logo} alt="RSSI Rescue Pod logo" className="h-14 w-14 object-contain" />
        <div>
          <h1 className="text-base font-semibold">RSSI Rescue &amp; Search Pod</h1>
          <p className="label-xs">{state ? state.site.name : "field console"}</p>
        </div>
      </div>

      <p className="text-[0.68rem]" style={{ color: link === "live" ? "#22d3a5" : TIER_HEX.HIGH }}>
        {link === "live"
          ? `Server live · ${state?.pods.filter((p) => podOnline(p, now)).length ?? 0} pod(s) online`
          : link === "connecting"
            ? "Connecting to coordination server…"
            : "Cannot reach the coordination server — run `npm run dev` in the project folder."}
      </p>

      <Link to="/ops" className="panel-surface block p-4 transition-colors hover:border-primary">
        <p className="text-lg font-bold text-primary">Operations console →</p>
        <p className="mt-1 text-sm text-muted-foreground">
          For the coordinating organisation: live pod readings, ranked detections, hazard zones,
          team assignment and live rescuer positions.
        </p>
      </Link>

      <section className="panel-surface p-4">
        <p className="text-sm font-semibold">Rescue team view (phone)</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Open on the rescuer's phone. Shares GPS with operations and shows only your assigned
          tasks.
        </p>
        <div className="mt-3 grid gap-1.5">
          {state?.teams.length ? (
            state.teams.map((t) => (
              <Link
                key={t.id}
                to="/team/$teamId"
                params={{ teamId: t.id }}
                className="flex items-center gap-2 rounded-sm border border-border px-3 py-2 hover:bg-secondary"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: TEAM_STATUS_HEX[t.status] }}
                />
                <span className="text-xs font-semibold">{t.name}</span>
                <span className="text-xs text-muted-foreground">{t.members}</span>
                <span className="ml-auto text-[0.6rem] text-muted-foreground">{t.id} →</span>
              </Link>
            ))
          ) : (
            <p className="text-[0.68rem] text-muted-foreground">
              No teams yet — register them in the Operations console.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
