# RSSI Rescue & Search Pod

A low-cost handheld pod for disaster search-and-rescue (VIT Chennai college project — Lisa, Ananya Singla, Angel Mittal).
It cross-checks two independent signals — **body heat** (MLX90614) and **a phone's WiFi probe requests** (ESP8266, passive) —
before reporting a possible survivor, and a website turns those reports into tasks for rescue teams.

```
firmware/rescue_pod/   ESP8266 sketch (NodeMCU 1.0) — sensors, LEDs, buzzer, JSON output over USB
frontend/              the website — Operations console (/ops) + one page per rescue team (/team/<id>)
backend/               API + live updates + SQLite database (backend/data/rescue-pod.db)
  tools/               simulate.ts (fake pod for demos), serial_bridge.py (USB reader without a browser)
shared/types.ts        data model used by both frontend and backend
```

There is **one website**. The frontend is what you see; the backend is the part that stores everything and keeps
every screen in sync. `npm run dev` starts both.

## How it works

```
 POD (ESP8266) ──USB cable──► laptop: Operations console in Chrome  ("CONNECT POD (USB)")
   MLX90614 + WiFi listening       │  forwards every reading
   LEDs + buzzer                   ▼
                              backend (port 4000) ── SQLite database
                                   │  live updates to every open screen
                    ┌──────────────┴──────────────┐
            Operations console               Rescuer phones (/team/T1, /team/T2 …)
            map, ranked detections,          their tasks, direction + distance,
            assign teams, live rescuers      status buttons, SOS; send their GPS back
```

## What the ESP8266 can and can't tell you about a phone

The ESP8266 never connects to the phone. It **listens** to the WiFi packets every phone with WiFi on transmits anyway
(searching for networks, or normal traffic if it's on a WiFi network) — that's the "transmission radiation". From
each packet it learns **how strong** it is (RSSI) — nothing else. One pod therefore tells you:

- **"Is there a phone near me?"** — yes/no (the SIGNAL LED)
- **"Am I getting closer?"** — the signal gets stronger as the pod moves toward the phone

It **cannot** compute the phone's coordinates, and it **cannot hear a phone that is switched off, dead or broken** —
such a phone transmits nothing at all. That is exactly why the pod also has the thermal sensor: body heat with no
phone is still reported as **HIGH** priority. The survivor's phone never needs GPS or location turned on — the
location always comes from **the pod's own position** when it detects something.

**How you narrow it down to a spot:** move the pod and follow the signal, like a "hot / cold" game. The
**phone-signal meter** (Pod tab) shows the strength, a rough distance band and whether it's getting stronger or weaker.
Where it peaks, aim the thermal sensor; when both fire the pod double-beeps and the detection is logged at the pod's
position. A phone heard at all is within roughly 1–15 m of the pod.

### Where the pod's location comes from (it has no GPS yet)

Pick it in the Pod tab → *Pod location*:

| Option | How | Accuracy |
|---|---|---|
| **Live — this laptop** (default) | Switches on by itself when you connect the pod by USB — the laptop moves with the pod. The browser asks for location permission once. | Laptops estimate location from nearby WiFi (needs WiFi on + internet): often 20–100 m |
| **Live — a phone carried with the pod** | Pod tab → *Copy phone tracker link* → open it on that phone → *Start sharing* | Real GPS: ~5–15 m outdoors |
| **Live — follow a team's GPS** | Choose "follow <team>'s phone GPS" when a rescue team carries the pod | Same as the team's phone |
| **Fixed — click on the map** | "Set position by clicking map" | As exact as your click |

The pod's marker moves on the map and leaves a **blue trail** of where it has been. If you add a **GPS module**
to the pod later, the backend is already ready: make the firmware add `"lat":…,"lng":…` to its JSON line and the pod
will switch to its own GPS automatically.

Rescuers' locations come from **their phones' GPS** through the browser — not from the ESP8266.

**Future upgrade:** an **ESP32** (its Arduino core is already installed) can also listen to **Bluetooth**. That
catches phones with WiFi off but Bluetooth on, and many iPhones keep a Bluetooth "Find My" signal for hours after
shutting down. The ESP8266 has no Bluetooth.

## Decision logic (same on the pod and the website)

| Thermal | Phone signal | Priority      | Pod buzzer  | Meaning                                                |
|:-------:|:------------:|---------------|-------------|--------------------------------------------------------|
| ✔       | ✔            | **VERY HIGH** | double beep | live heat source AND a phone at the same spot          |
| ✔       | –            | **HIGH**      | single beep | heat is the evidence of life; phone may be lost / dead |
| –       | ✔            | **LOW**       | silent      | a phone is there, no body heat yet — could be dropped  |
| –       | –            | not reported  | silent      | pod stays silent rather than guessing                  |

**A hazard never cancels a person.** The pod uses an **MQ gas sensor** (instead of a flame sensor, which we couldn't
get). When it smells smoke or a flammable gas, the orange LED lights, the buzzer gives a short *low* beep (only if
no person is detected — person beeps take priority), a **"Smoke / gas" hazard zone** is marked on the map, and any
detection at that spot is tagged 💨 — the person is still reported at their normal priority. Rescuers are warned
when their straight-line route crosses a hazard zone, and on their phone when their task is in smoke/gas.

**One detection = one entry.** Every time the pod detects something *again* after being quiet for 2.5 s (or after it
moved more than 8 m), a **new entry** is created — 10 separate detections give 10 entries, each with its own team
assignment. While the pod keeps detecting the same thing continuously, that stays one entry and its "readings" counter
goes up (and its priority can go up, e.g. High → Very high when a phone is also heard).

## Setup (once)

Requirements: **Node.js 22.18+** (you have 24), **Chrome or Edge** on the laptop, and the Arduino IDE with the
ESP8266 core and *Adafruit MLX90614* library (already installed on Lisa's laptop).

```sh
cd rssi-rescue-search-pod
npm install          # installs the website's packages (the backend has none)
```

## Testing with the real pod — step by step

1. **Flash the firmware.** Open `firmware/rescue_pod/rescue_pod.ino` in the Arduino IDE, board
   *NodeMCU 1.0 (ESP-12E Module)*, upload. Optionally open Serial Monitor (115200) to check you see lines like
   `{"pod":"POD-01","seq":12,...}` — then **close Serial Monitor** (only one program can use the USB port).
2. **Start the website:** `npm run dev` in the project folder. Leave this terminal open.
3. **Open the Operations console** in Chrome/Edge on the same laptop: <http://localhost:8080/ops>
   (use `localhost` — browsers only allow USB access on localhost or https).
4. **Connect the pod:** open the **Pod** tab, click **Connect pod (USB)** and pick the COM port
   (*CP210x* or *USB-SERIAL CH340*). The board reboots, then `POD-01 · Live via usb` appears with readings updating
   about 1.5× per second. **Serial monitor** shows the raw lines — the same as Arduino's Serial Monitor.
   After a page refresh it reconnects by itself.
5. **Location:** the browser asks to use your location — click **Allow**. The pod now appears on the map at the
   laptop's position (see the table above for a more accurate phone tracker).
6. **Check it's live:**
   - Point the MLX90614 at your hand/face from ~5–10 cm → **THERMAL** LED lights on the pod *and* on the website,
     Object temperature rises above 30 °C, the pod beeps once, and a **HIGH** detection appears.
   - Hold a phone with **WiFi on** right next to the pod. Best: connect the phone to a **2.4 GHz** WiFi network (or
     open its WiFi settings screen so it searches) and play a video — that makes it transmit constantly
     → **SIGNAL** LED lights, the phone-signal meter fills up and says Close / Very close.
     (The ESP8266 only hears 2.4 GHz; a phone talking only on 5 GHz WiFi is silent to it.)
   - Both at once → double beep, **Very high** detection.
   - Take your hand away for 3 seconds and point again → a **second** entry appears.
7. **Assign** — two ways:
   - **From a detection:** each card has "Send a team" buttons, best match first (free teams, then nearest). One click
     assigns. "Change team" / "Unassign" are on the card afterwards. The "Needs a team" filter shows what's left.
   - **From a team:** Teams tab → **+ Assign tasks** on a team → click detections or search areas on the map or in the
     list (click again to remove) → **Finish assigning**.
   Each team has its own colour: its marker, its route line and the "→ Alpha" tag under its detections all use it.
8. **Rescuer side:** Teams tab → **Copy phone link** → open it on a phone on the same WiFi/hotspot as the laptop
   (e.g. `http://192.168.29.171:8080/team/T1` — `npm run dev` prints the laptop's address). The phone shows its task
   with direction and distance. See "HTTPS for rescuer phones" below for real GPS on the phone.

The website never needs the Arduino IDE open. If the laptop has no Chrome/Edge, `npm run bridge` reads the pod
instead (needs `pip install pyserial`).

## Testing without the pod

```sh
npm run dev                  # terminal 1
npm run sim                  # terminal 2: a fake pod "POD-SIM" that walks around the site and detects in bursts
npm run sim -- --teams       # …and also walks assigned teams toward their targets (no phones needed)
```
Remove the fake pod afterwards with **Remove pod** on its card (shown when it's offline).

**Sample data:** the first time the app starts it creates three example teams — **Alpha, Bravo, Charlie** — so you can
assign straight away (edit or remove them in the Teams tab). The **Load sample data** button (top right) adds example
detections, a fire zone, a search area and one assignment, all labelled "SAMPLE".

## The database

Everything is stored in **SQLite** at `backend/data/rescue-pod.db` (built into Node — nothing to install).
Open it with [DB Browser for SQLite](https://sqlitebrowser.org/) to look inside. Tables:

| Table | What's in it |
|---|---|
| `sessions` | one row per rescue operation ("NEW SESSION" closes the current one; old ones are kept) |
| `readings` | every raw sensing window from every pod — temperatures, RSSI, flags, priority |
| `detections` | ranked detections with position, priority, fire flag, status, assigned team |
| `areas` | search areas and hazard zones |
| `teams`, `pods` | registered teams (with last GPS position) and pods (with live position and trail) |
| `log` | everything that happened, with timestamps — detections, assignments, status changes, SOS |

**You don't need to do anything for the database** — the backend creates the file and tables by itself the first time,
and saves every change automatically. Stopping and restarting `npm run dev` resumes where it left off.
Downloads (Log tab): detections, log and all raw sensor readings as CSV.

## A typical session

1. Ops registers teams (Teams tab → Add team) and sends each team its phone link.
2. Each rescuer opens their link on their phone → GPS starts sharing; ops sees them on the map.
3. The pod is placed (or carried). Detections appear ranked: VERY HIGH → HIGH → LOW, fire-tagged ones first within a tier.
4. Ops labels a detection ("Block B, floor 2, room 204") and sends a team with one click.
5. The team's phone shows the new task (and vibrates on Android): distance, direction arrow (uses the phone compass if available),
   walking ETA, hazard warnings, and a Google Maps walking link (needs internet).
6. The phone shows one big next-step button: *We're on our way* → *We've arrived* → *Person rescued* / *Nothing found*. Ops sees every change live.
7. If a team hits **SOS**, ops gets a red banner with their last known position. If a team on a task stops reporting
   its position for over a minute, ops gets a warning — the "rescue the rescuer" case.
8. Everything is in the database and the session log (Log tab, with CSV downloads).

Ops can also drop **search areas** (assignable like detections) and **hazard zones** by hand (e.g. fire seen by
eye, collapsed stairs).

## HTTPS for rescuer phones (needed for GPS)

Browsers only give GPS to pages served over HTTPS (localhost is exempt). On `http://192.168.x.x:8080` the rescuer
view says "GPS needs HTTPS" and falls back to **Set my position** (tap on the map). The same applies to the phone
tracker page. (The laptop at `http://localhost:8080` is fine.) For real GPS on phones, pick one:

- **Quickest for a demo (Android Chrome):** on each phone open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
  add `http://<laptop-ip>:8080`, enable, relaunch Chrome.
- **Self-signed cert:** create `frontend/certs/key.pem` and `frontend/certs/cert.pem` and restart `npm run dev` — it
  switches to `https://` automatically. With mkcert (`choco install mkcert`):
  `mkcert -key-file frontend/certs/key.pem -cert-file frontend/certs/cert.pem <laptop-ip> localhost`.
  Phones will warn about the certificate; tap *Advanced → Proceed* (or install the mkcert root CA on the phone).

GPS inside buildings is often 15–50 m off. The rescuer view shows the accuracy and lets the team correct their
position manually.

## Firmware changes you need to re-test on hardware

The sketch in `firmware/` is your debug build 2 with these changes — please re-verify the SIGNAL behaviour:

1. **JSON line per reading** for the website / bridge. The old debug line is still printed (now prefixed with `#`).
2. **`SIGNAL_MODE`** — which packets count as "a phone is here":
   - `SIGNAL_PHONES` (default): every packet a phone/laptop **sends** — WiFi searches *and* normal traffic from a phone
     that is on a WiFi network. Packets sent **by routers** are ignored, because in v1 any router nearby stronger than
     −70 dBm lit the SIGNAL LED with no phone present.
   - `SIGNAL_ALL`: every packet, exactly like v1.
   - `SIGNAL_PROBES_ONLY`: only WiFi searches (strictest). The previous build used this, and your saved readings
     show why the LED never lit with it: the strongest search packet heard was −84 dBm, below the −70 dBm threshold.
   If SIGNAL still never lights with a phone right next to the pod, check the `PhonePkts` / `MaxRSSI` numbers in the
   serial monitor, try `SIGNAL_ALL`, or lower `RSSI_THRESHOLD` to e.g. −80.
3. **Signal hold** (`SIGNAL_HOLD_MS 8000`). Phones transmit in bursts, so SIGNAL stays on for 8 s after the last
   strong phone packet instead of flickering.
4. Removed the duplicate `HUMAN_DELTA_ABOVE_AMBIENT` define (both 2.0 and 2.5 were defined; 2.5 was the one in effect).
5. **MQ gas sensor instead of the flame sensor** (MQ-2 recommended; MQ-135 / MQ-5 also work; MQ-7 does not —
   it needs a special heater cycle). No library needed — it's read with `analogRead(A0)`.

   | MQ module pin | Connect to | Why |
   |---|---|---|
   | **VCC** | NodeMCU **VIN** (5 V from USB) | The heater needs 5 V — 3V3 is too weak |
   | **GND** | NodeMCU **GND** | |
   | **AO** | **10 kΩ resistor → A0**, and **another 10 kΩ from A0 → GND** | AO can reach 5 V; A0 must stay ≤ 3.3 V. The two resistors halve it |
   | **DO** | not connected | The code uses the analog value |

   **Using it:** after power-on the orange LED **blinks for 1 minute** while the heater warms up (no smoke check
   yet). Then the pod learns the clean-air value and alarms when the reading rises `GAS_RISE_ALARM` (120) above it.
   Test with a just-blown-out matchstick or incense stick near the sensor (not a lighter flame — the module sits
   close to your wiring). The serial monitor line shows `Gas: 412 (clean air 98) SMOKE/GAS!`. If it alarms too easily
   raise `GAS_RISE_ALARM`; if it never alarms, lower it. A brand-new sensor reads unsteadily for its first few hours
   powered — leave it plugged in for a while before a demo. The module gets warm; that's normal.

The firmware compiles for NodeMCU 1.0 (ESP8266 core 3.1.2). The new SIGNAL_PHONES mode has not been run on the
physical pod yet — please check it with the steps above.

### WiFi uplink (optional)
Not needed when you use the USB cable. Set `UPLINK_WIFI true` and fill in `WIFI_SSID`, `WIFI_PASS`, `SERVER_IP` (the laptop's IP on that network, port 4000).
Every 5 s the pod stops sniffing, connects, posts its queued readings, and goes back to sniffing. Joining takes
1–4 s each time, so the pod listens less of the time than over USB. Note: the rescuers' own phones also send probe
requests — expect LOW (signal-only) detections near rescuers.

## API (for reference)

| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/state` · `/api/stream` | full snapshot · Server-Sent Events (`event: state`, on every change) |
| POST | `/api/pods/:pod/readings` | firmware JSON object or array; header `X-Pod-Link: usb\|serial\|wifi\|sim` |
| PATCH / DELETE | `/api/pods/:pod` | `{name, locationMode: "manual"\|"carried", manualPosition: {lat,lng}, carrierTeamId}` |
| POST / PATCH / DELETE | `/api/teams[/:id]` | `{name, members}` |
| POST | `/api/teams/:id/position` | `{lat, lng, accuracyM, source: "gps"\|"manual"}` |
| POST | `/api/teams/:id/sos` | `{active: true\|false}` |
| PATCH | `/api/detections/:id` · `/api/areas/:id` | `{assignedTeamId, status, label, notes, position, radiusM}` |
| POST / DELETE | `/api/areas[/:id]` | `{kind: "search"\|"hazard", center, radiusM, label}` |
| GET | `/api/export/detections.csv` · `/log.csv` · `/readings.csv` · `/session.json` | exports (current session) |
| GET | `/api/sessions` | all sessions in the database |

## Known limitations

- **No GPS on the pod** — locations are operator-placed or borrowed from the carrying team's phone.
- **Single-point thermal sensor** — the MLX90614 reads one spot; the rescuer must aim it (like a laser thermometer).
- **Short range, rough proximity** — RSSI tells you "closer/further", not a distance or a position; walls change it a lot.
- **MAC randomisation** — modern phones change their MAC in probe requests, so the pod can't count or identify phones.
- **Rescuers' own phones** trigger SIGNAL too. Treat LOW detections near your own teams with suspicion.
- **Map tiles need internet** (OpenStreetMap). Without internet everything still works on a blank grid; for offline
  use, a floor-plan image overlay would be the next step.
- **The Operations tab must stay open** while the pod is plugged in — that tab is what reads the USB port.
- **No login** — anyone on the network with the link can open any view. Fine for a demo; add auth before real use.
- **"Safest route" is basic** — a straight line plus warnings when it crosses a marked hazard zone, not path-finding.

## License

MIT — see [LICENSE](LICENSE).
