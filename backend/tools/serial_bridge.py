"""
Serial bridge: pod (USB) -> coordination server (HTTP).

The pod prints one JSON line per sensing window, e.g.
  {"pod":"POD-01","seq":12,"up":9123,"mlx":1,"obj":33.10,"amb":27.40,"thermal":1,"rssi":-58,"probes":3,"signal":1,"flame":-1}
This script reads those lines from the USB serial port and POSTs them to
  <server>/api/pods/<pod>/readings
Non-JSON lines (the human-readable debug output) are ignored, or echoed with --echo.

Usage:
  pip install pyserial
  python serial_bridge.py                       # auto-detect the NodeMCU port
  python serial_bridge.py --port COM5 --echo
  python serial_bridge.py --server http://192.168.1.20:4000
  python serial_bridge.py --replay capture.txt  # replay saved serial output (no hardware)

Close the Arduino Serial Monitor first — only one program can open the port at a time.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from collections import deque

BAUD = 115200
# USB-serial chips used on NodeMCU boards: CP2102 (Silicon Labs) and CH340 (WCH).
KNOWN_USB_IDS = {(0x10C4, 0xEA60), (0x1A86, 0x7523), (0x1A86, 0x55D4)}


def find_port():
    from serial.tools import list_ports

    ports = list(list_ports.comports())
    for p in ports:
        if (p.vid, p.pid) in KNOWN_USB_IDS:
            return p.device
    for p in ports:
        desc = f"{p.description} {p.manufacturer or ''}".lower()
        if any(k in desc for k in ("cp210", "ch340", "usb-serial", "usb serial", "uart")):
            return p.device
    if ports:
        print("Could not identify the pod. Ports found:", file=sys.stderr)
        for p in ports:
            print(f"  {p.device}  {p.description}", file=sys.stderr)
    return None


class Uploader:
    """Posts readings, keeping a small backlog if the server is unreachable."""

    def __init__(self, server, link, key):
        self.server = server.rstrip("/")
        self.link = link
        self.key = key
        self.backlog = deque(maxlen=200)  # ~2 minutes of readings
        self.last_error = 0.0
        self.sent = 0

    def post(self, pod, readings):
        body = json.dumps(readings).encode()
        req = urllib.request.Request(
            f"{self.server}/api/pods/{pod}/readings",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "X-Pod-Link": self.link, **({"X-Pod-Key": self.key} if self.key else {})},
        )
        with urllib.request.urlopen(req, timeout=3) as res:
            res.read()

    def send(self, reading):
        self.backlog.append(reading)
        # Group by pod so one bridge can, in principle, relay several pods.
        by_pod = {}
        for r in self.backlog:
            by_pod.setdefault(r.get("pod", "POD-01"), []).append(r)
        try:
            for pod, rs in by_pod.items():
                self.post(pod, rs)
            self.sent += len(self.backlog)
            self.backlog.clear()
        except (urllib.error.URLError, OSError) as e:
            now = time.time()
            if now - self.last_error > 5:
                print(f"[bridge] server unreachable ({e}); {len(self.backlog)} reading(s) queued", file=sys.stderr)
                self.last_error = now


def handle_line(line, up, echo):
    line = line.strip()
    if not line:
        return
    if line.startswith("{"):
        try:
            reading = json.loads(line)
        except json.JSONDecodeError:
            if echo:
                print(f"[bridge] bad JSON: {line}")
            return
        up.send(reading)
        if echo:
            flags = " ".join(k.upper() for k in ("thermal", "signal") if reading.get(k)) or "-"
            print(f"#{reading.get('seq')}  obj={reading.get('obj')}  amb={reading.get('amb')}  rssi={reading.get('rssi')}  {flags}")
    elif echo:
        print(line)


def run_serial(args, up):
    import serial  # pyserial

    while True:
        port = args.port or find_port()
        if not port:
            print("[bridge] no pod found — plug it in (retrying in 3 s)", file=sys.stderr)
            time.sleep(3)
            continue
        try:
            with serial.Serial(port, BAUD, timeout=1) as ser:
                print(f"[bridge] reading {port} @ {BAUD} -> {up.server}")
                last_report = time.time()
                while True:
                    raw = ser.readline()
                    if raw:
                        handle_line(raw.decode("utf-8", errors="replace"), up, args.echo)
                    if not args.echo and time.time() - last_report > 10:
                        print(f"[bridge] {up.sent} readings forwarded")
                        last_report = time.time()
        except serial.SerialException as e:
            print(f"[bridge] serial error: {e} (is Serial Monitor open?) — retrying in 3 s", file=sys.stderr)
            time.sleep(3)


def run_replay(args, up):
    with open(args.replay, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    print(f"[bridge] replaying {len(lines)} lines from {args.replay} -> {up.server}")
    while True:
        for line in lines:
            handle_line(line, up, args.echo)
            if line.lstrip().startswith("{"):
                time.sleep(args.interval)
        if not args.loop:
            break
    print(f"[bridge] done, {up.sent} readings forwarded")


def main():
    ap = argparse.ArgumentParser(description="Forward RSSI Rescue Pod serial output to the coordination server")
    ap.add_argument("--port", help="serial port, e.g. COM5 or /dev/ttyUSB0 (default: auto-detect)")
    ap.add_argument("--server", default="http://localhost:4000", help="coordination server URL")
    ap.add_argument("--key", default="", help="pod key, if the server was started with POD_KEY")
    ap.add_argument("--echo", action="store_true", help="print every line (like Serial Monitor)")
    ap.add_argument("--replay", help="replay a saved serial capture instead of reading the port")
    ap.add_argument("--interval", type=float, default=0.7, help="seconds between replayed readings")
    ap.add_argument("--loop", action="store_true", help="loop the replay forever")
    args = ap.parse_args()

    up = Uploader(args.server, "replay" if args.replay else "serial", args.key)
    try:
        if args.replay:
            run_replay(args, up)
        else:
            run_serial(args, up)
    except KeyboardInterrupt:
        print("\n[bridge] stopped")


if __name__ == "__main__":
    main()
