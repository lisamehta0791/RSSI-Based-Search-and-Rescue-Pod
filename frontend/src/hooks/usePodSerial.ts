import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Reads the pod straight from the USB cable using the browser's Web Serial API
 * (Chrome / Edge on a laptop, page opened as http://localhost or https://).
 * Every JSON line the firmware prints is forwarded to the backend, exactly like
 * backend/tools/serial_bridge.py does — so no extra program is needed.
 */

// Minimal Web Serial typings (not in TypeScript's DOM lib yet).
interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}
interface WebSerialPort {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  getInfo(): SerialPortInfo;
}
interface WebSerial {
  requestPort(o?: { filters?: SerialPortInfo[] }): Promise<WebSerialPort>;
  getPorts(): Promise<WebSerialPort[]>;
  addEventListener(type: "disconnect", fn: (e: Event) => void): void;
  removeEventListener(type: "disconnect", fn: (e: Event) => void): void;
}
const serial = (): WebSerial | undefined =>
  typeof navigator !== "undefined"
    ? (navigator as unknown as { serial?: WebSerial }).serial
    : undefined;

export type SerialStatus = "unsupported" | "idle" | "connecting" | "connected" | "error";

const BAUD = 115200;
const CONSOLE_LINES = 300;
const FLUSH_MS = 300;

export function usePodSerial() {
  const [status, setStatus] = useState<SerialStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [sent, setSent] = useState(0);
  const [podIds, setPodIds] = useState<string[]>([]);

  const port = useRef<WebSerialPort | null>(null);
  const reader = useRef<ReadableStreamDefaultReader<string> | null>(null);
  const queue = useRef<Map<string, unknown[]>>(new Map());
  const consoleBuf = useRef<string[]>([]);

  useEffect(() => {
    if (!serial()) setStatus("unsupported");
  }, []);

  // Forward queued readings to the backend in small batches.
  useEffect(() => {
    const id = setInterval(async () => {
      if (!queue.current.size) return;
      const batches = [...queue.current.entries()];
      queue.current.clear();
      for (const [pod, readings] of batches) {
        try {
          const res = await fetch(`/api/pods/${encodeURIComponent(pod)}/readings`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Pod-Link": "usb" },
            body: JSON.stringify(readings),
          });
          if (res.ok) setSent((n) => n + readings.length);
          else setError(`backend rejected readings (HTTP ${res.status})`);
        } catch {
          // backend down — put them back (bounded) and try again next tick
          const back = queue.current.get(pod) ?? [];
          queue.current.set(pod, [...readings, ...back].slice(-200));
        }
      }
    }, FLUSH_MS);
    return () => clearInterval(id);
  }, []);

  // Push console lines to React at most ~4x/s.
  useEffect(() => {
    const id = setInterval(() => {
      if (!consoleBuf.current.length) return;
      const add = consoleBuf.current;
      consoleBuf.current = [];
      setLines((l) => [...l, ...add].slice(-CONSOLE_LINES));
    }, 250);
    return () => clearInterval(id);
  }, []);

  const handleLine = useCallback((raw: string) => {
    const line = raw.trim();
    if (!line) return;
    consoleBuf.current.push(line);
    if (!line.startsWith("{")) return;
    try {
      const r = JSON.parse(line) as { pod?: unknown };
      const pod = typeof r.pod === "string" && r.pod ? r.pod : "POD-01";
      const q = queue.current.get(pod) ?? [];
      q.push(r);
      queue.current.set(pod, q);
      setPodIds((ids) => (ids.includes(pod) ? ids : [...ids, pod]));
    } catch {
      /* half a line after connecting, or noise — ignore */
    }
  }, []);

  const readLoop = useCallback(
    async (p: WebSerialPort) => {
      if (!p.readable) return;
      const decoder = new TextDecoderStream();
      void p.readable.pipeTo(decoder.writable as WritableStream<Uint8Array>).catch(() => {});
      const r = decoder.readable.getReader();
      reader.current = r;
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await r.read();
          if (done) break;
          buf += value;
          const parts = buf.split(/\r?\n/);
          buf = parts.pop() ?? "";
          for (const l of parts) handleLine(l);
        }
      } catch (e) {
        setError(`USB read stopped: ${(e as Error).message}`);
      } finally {
        r.releaseLock();
      }
    },
    [handleLine],
  );

  const openPort = useCallback(
    async (p: WebSerialPort) => {
      setStatus("connecting");
      setError(null);
      try {
        await p.open({ baudRate: BAUD });
      } catch (e) {
        setStatus("error");
        setError(
          `${(e as Error).message} — close the Arduino Serial Monitor (and serial_bridge.py) and try again.`,
        );
        return;
      }
      port.current = p;
      setStatus("connected");
      consoleBuf.current.push("── connected to pod over USB (the board may reboot) ──");
      await readLoop(p);
      // read loop ended: unplugged or disconnected
      try {
        await p.close();
      } catch {
        /* already closed */
      }
      if (port.current === p) {
        port.current = null;
        setStatus("idle");
        consoleBuf.current.push("── USB disconnected ──");
      }
    },
    [readLoop],
  );

  /** Ask the user to pick the pod's COM port (needs a click). */
  const connect = useCallback(async () => {
    const s = serial();
    if (!s) return;
    try {
      const p = await s.requestPort();
      void openPort(p);
    } catch {
      /* user closed the picker */
    }
  }, [openPort]);

  const disconnect = useCallback(async () => {
    const p = port.current;
    port.current = null;
    try {
      await reader.current?.cancel();
    } catch {
      /* ignore */
    }
    try {
      await p?.close();
    } catch {
      /* ignore */
    }
    setStatus("idle");
  }, []);

  // Reconnect automatically after a page refresh if the pod was allowed before.
  useEffect(() => {
    const s = serial();
    if (!s) return;
    let cancelled = false;
    void s.getPorts().then((ports) => {
      if (!cancelled && ports.length === 1 && !port.current) void openPort(ports[0]!);
    });
    const onDisconnect = () => {
      consoleBuf.current.push("── pod unplugged ──");
    };
    s.addEventListener("disconnect", onDisconnect);
    return () => {
      cancelled = true;
      s.removeEventListener("disconnect", onDisconnect);
      void reader.current?.cancel().catch(() => {});
    };
  }, [openPort]);

  return {
    status,
    error,
    lines,
    sent,
    podIds,
    connect,
    disconnect,
    clearConsole: () => setLines([]),
  };
}
