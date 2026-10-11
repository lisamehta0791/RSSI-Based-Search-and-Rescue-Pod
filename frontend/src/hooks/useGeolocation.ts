import { useEffect, useRef, useState } from "react";

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number;
  t: number;
}

export type GeoStatus = "starting" | "ok" | "denied" | "unavailable" | "insecure";

/**
 * Live GPS from the rescuer's phone. Browsers only allow this on HTTPS (or localhost) —
 * on a plain http://192.168.x.x address the status will be "insecure".
 */
export function useGeolocation(enabled: boolean) {
  const [fix, setFix] = useState<Fix | null>(null);
  const [status, setStatus] = useState<GeoStatus>("starting");

  useEffect(() => {
    if (!enabled) return;
    if (!window.isSecureContext) return setStatus("insecure");
    if (!("geolocation" in navigator)) return setStatus("unavailable");
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setStatus("ok");
        setFix({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracyM: p.coords.accuracy,
          t: Date.now(),
        });
      },
      (err) => setStatus(err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);

  return { fix, status };
}

/**
 * Device compass heading (degrees clockwise from north), when the phone exposes it.
 * iOS needs an explicit permission tap, so `request` must be called from a button.
 */
export function useCompass() {
  const [heading, setHeading] = useState<number | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);
  const attached = useRef(false);

  const attach = () => {
    if (attached.current) return;
    attached.current = true;
    const onAbs = (e: DeviceOrientationEvent) => {
      if (e.absolute && e.alpha !== null) setHeading((360 - e.alpha) % 360);
    };
    const onIos = (e: DeviceOrientationEvent) => {
      const h = (e as DeviceOrientationEvent & { webkitCompassHeading?: number })
        .webkitCompassHeading;
      if (typeof h === "number") setHeading(h);
    };
    window.addEventListener("deviceorientationabsolute", onAbs as EventListener);
    window.addEventListener("deviceorientation", onIos);
  };

  useEffect(() => {
    const DOE = (
      window as unknown as {
        DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
      }
    ).DeviceOrientationEvent;
    if (DOE?.requestPermission) setNeedsPermission(true);
    else attach();
  }, []);

  const request = async () => {
    const DOE = (
      window as unknown as {
        DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
      }
    ).DeviceOrientationEvent;
    try {
      if ((await DOE?.requestPermission?.()) === "granted") {
        setNeedsPermission(false);
        attach();
      }
    } catch {
      /* user declined */
    }
  };

  return { heading, needsPermission, request };
}
