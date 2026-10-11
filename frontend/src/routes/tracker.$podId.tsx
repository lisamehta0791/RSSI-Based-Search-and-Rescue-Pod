import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { usePodTracker } from "@/hooks/usePodTracker";
import { TrackStatus } from "@/components/ops/PodTab";
import { Btn } from "@/components/bits";

export const Route = createFileRoute("/tracker/$podId")({
  head: () => ({ meta: [{ title: "Pod tracker — RSSI Rescue Pod" }] }),
  component: TrackerPage,
});

/**
 * Open this on a phone that is carried together with the pod. The phone's GPS becomes the
 * pod's live location on the Operations map (the pod itself has no GPS).
 */
function TrackerPage() {
  const { podId } = Route.useParams();
  const [on, setOn] = useState(false);
  const { status, accuracy } = usePodTracker(podId, on, "phone");

  // Keep the screen awake while tracking, where the browser supports it.
  useEffect(() => {
    if (!on) return;
    type WakeLock = { release: () => Promise<void> };
    let lock: WakeLock | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: "screen") => Promise<WakeLock> };
    };
    void nav.wakeLock
      ?.request("screen")
      .then((l) => (lock = l))
      .catch(() => {});
    return () => void lock?.release().catch(() => {});
  }, [on]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-5 py-8">
      <div>
        <p className="text-sm text-muted-foreground">Pod location tracker</p>
        <h1 className="text-3xl font-bold">📡 {podId}</h1>
      </div>
      <p className="text-base">
        Keep this phone <b>with the pod</b> and this page open. Its GPS becomes the pod's live
        position on the Operations map, so every detection is placed where the pod actually was.
      </p>

      {on ? (
        <div className="space-y-3 rounded-2xl border-2 border-green-600 p-5 text-center">
          <p className="text-xl font-bold text-green-600">Sharing location</p>
          <div className="text-base">
            <TrackStatus status={status} accuracy={accuracy} />
          </div>
          <Btn size="lg" className="w-full" onClick={() => setOn(false)}>
            Stop
          </Btn>
        </div>
      ) : (
        <Btn tone="primary" size="lg" className="h-16 w-full text-lg" onClick={() => setOn(true)}>
          Start sharing this phone's location
        </Btn>
      )}

      {status === "insecure" ? (
        <p className="rounded-xl bg-secondary p-4 text-sm">
          Phones only share GPS with <b>https://</b> pages. See "HTTPS for phones" in the README —
          the quickest fix on Android Chrome is the{" "}
          <code>unsafely-treat-insecure-origin-as-secure</code> flag.
        </p>
      ) : null}

      <Link to="/" className="mt-auto text-center text-sm text-muted-foreground underline">
        Back to start
      </Link>
    </div>
  );
}
