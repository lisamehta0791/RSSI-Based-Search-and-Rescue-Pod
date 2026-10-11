import { useEffect, useRef, useState } from "react";
import type { GeoStatus } from "@/hooks/useGeolocation";

/** Send at most one position every SEND_EVERY_MS unless the device moved this much. */
const SEND_EVERY_MS = 2000;
const SEND_IF_MOVED_M = 3;

/**
 * Shares THIS device's location as the pod's live location.
 *  - On the Operations laptop the pod is plugged into: source "laptop".
 *  - On a phone carried with the pod (/tracker/<pod>): source "phone".
 * Laptops usually estimate location from nearby WiFi (needs internet), so expect 20–100 m;
 * phones use real GPS (5–15 m outdoors).
 */
export function usePodTracker(podId: string | null, enabled: boolean, source: "laptop" | "phone") {
  const [status, setStatus] = useState<GeoStatus | "off">("off");
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const last = useRef<{ t: number; lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!enabled || !podId) {
      setStatus("off");
      return;
    }
    if (!window.isSecureContext) return setStatus("insecure");
    if (!("geolocation" in navigator)) return setStatus("unavailable");
    setStatus("starting");
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setStatus("ok");
        setAccuracy(p.coords.accuracy);
        const { latitude: lat, longitude: lng } = p.coords;
        const l = last.current;
        const moved = l
          ? Math.hypot(
              (lat - l.lat) * 111_320,
              (lng - l.lng) * 111_320 * Math.cos((lat * Math.PI) / 180),
            )
          : Infinity;
        if (l && Date.now() - l.t < SEND_EVERY_MS && moved < SEND_IF_MOVED_M) return;
        last.current = { t: Date.now(), lat, lng };
        void fetch(`/api/pods/${encodeURIComponent(podId)}/position`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat, lng, accuracyM: p.coords.accuracy, source }),
        }).catch(() => {});
      },
      (err) => setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [podId, enabled, source]);

  return { status, accuracy };
}
