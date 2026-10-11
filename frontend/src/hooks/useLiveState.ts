import { useEffect, useState } from "react";
import type { AppState } from "@/lib/domain";

export type LinkState = "connecting" | "live" | "lost";

/**
 * Subscribes to the server's Server-Sent Events stream. Every change on the server (a pod
 * reading, an assignment, a rescuer's GPS update) arrives here as a full state snapshot.
 * EventSource reconnects on its own if the laptop/WiFi drops.
 */
export function useLiveState() {
  const [state, setState] = useState<AppState | null>(null);
  const [link, setLink] = useState<LinkState>("connecting");
  /** Server time offset, so "x seconds ago" is right even if the phone's clock is off. */
  const [skew, setSkew] = useState(0);
  const [, tick] = useState(0);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.addEventListener("state", (e) => {
      const s = JSON.parse((e as MessageEvent<string>).data) as AppState;
      setSkew(s.now - Date.now());
      setState(s);
      setLink("live");
    });
    es.onerror = () => setLink(es.readyState === EventSource.CLOSED ? "lost" : "connecting");
    // Re-render every second so ages / online indicators stay current between pushes.
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      es.close();
      clearInterval(id);
    };
  }, []);

  return { state, link, now: Date.now() + skew };
}
