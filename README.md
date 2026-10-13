# RSSI Rescue & Search Pod

A low-cost handheld sensor pod and coordination website for disaster search-and-rescue.

The pod helps rescuers find people trapped in debris by cross-checking two independent signals before it reports
a possible survivor: **body heat** (infrared thermometer) and **a mobile phone's Wi-Fi transmissions** (listened to
passively, with signal strength). An MQ gas sensor marks **smoke or gas hazards** at the same time. The website
turns the pod's detections into a ranked list of locations, lets an operations team assign rescue teams to them,
and guides each team on their phone.

*VIT Chennai college project — Lisa, Ananya Singla, Angel Mittal.*

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Hardware](#hardware)
- [Software architecture](#software-architecture)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Using the system](#using-the-system)
- [Configuration](#configuration)
- [Database](#database)
- [API](#api)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Future work](#future-work)
- [License](#license)

---

## Features

**Pod (ESP8266)**
- Passive Wi-Fi listening on channels 1, 6 and 11 — detects phones without connecting to them or to any network
- Infrared body-heat check that compares the target with the surrounding temperature to avoid false alarms
- MQ gas sensor for smoke and flammable gas (digital output, or analog with automatic calibration)
- Red / red / orange LEDs and a buzzer that follow the decision priority
- One JSON line per reading over USB, read directly by the website

**Operations console (laptop)**
- Live map with the pod's position and path, detections, rescue teams, routes and hazard zones
- Detections ranked by priority; a new entry for every separate detection
- One-click team assignment (best free and nearest team first) or an "assign tasks" mode per team
- Team overview: free, on a task, SOS, no signal — with each team's tasks and distance
- Live mirror of the pod's LEDs and readings, a "hot / cold" phone-signal meter and a built-in serial monitor
- SOS alerts and warnings when a team on a task stops reporting its location
- Session log and CSV downloads; light and dark themes

**Rescuer view (phone)**
- Shows only that team's tasks, with distance, a direction arrow (uses the phone compass) and walking time
- One big next-step button: *We're on our way* → *We've arrived* → *Person rescued* / *Nothing found*
- Hazard warnings when the route crosses a smoke, gas or fire zone
- Shares the team's GPS with operations; SOS button

---

## How it works

### Decision priority

The pod and the website use the same rule:

| Body heat | Phone signal | Priority | Pod buzzer | Meaning |
|:-:|:-:|---|---|---|
| ✔ | ✔ | **Very high** | double beep | A live heat source and a phone at the same spot — strongest evidence |
| ✔ | – | **High** | single beep | Heat is the evidence of life; the phone may be lost, dead or absent |
| – | ✔ | **Low** | silent | A phone is there but no body heat yet — could be a dropped phone |
| – | – | not reported | silent | The pod stays silent rather than guessing |

**A hazard never cancels a person.** When the gas sensor detects smoke or gas, the orange LED lights, a
"Smoke / gas" hazard zone is marked on the map and detections at that spot are tagged 💨 — but the person is still
reported at their normal priority. Rescuers are warned when their route crosses a hazard zone.

**One detection = one entry.** Each time the pod detects something again after 2.5 s of quiet (or after it has moved
more than 8 m), a new entry is created, each with its own team assignment. While a detection continues, its
"readings" counter goes up and its priority can only rise (e.g. High → Very high when a phone is also heard).

### Phone signal (Wi-Fi)

The ESP8266 runs in promiscuous mode and listens to Wi-Fi packets that phones transmit anyway — searching for
networks, or normal traffic when connected to a 2.4 GHz network. Packets sent by routers are ignored. It measures
the **signal strength (RSSI)** of each packet; a strong packet (above −70 dBm) means a phone is close.

What this can and can't do:
- It tells you **whether a phone is near** and **whether you are getting closer** — not the phone's coordinates.
  Walls and debris change RSSI as much as distance does.
- A phone that is **switched off, dead or broken transmits nothing** and cannot be detected by any device. That is
  why the thermal sensor exists: heat without a phone is still a High-priority detection.
- The survivor's phone never needs GPS or location turned on. Every detection is placed at **the pod's position**.

To narrow down a spot, move the pod and follow the signal ("hot / cold"). The website's signal meter shows the
strength, a rough distance band and whether it is getting stronger or weaker. A phone heard at all is usually
within about 1–15 m.

### Body heat (MLX90614)

The MLX90614 is a single-point infrared thermometer, like a laser thermometer: it reads one spot and must be aimed
at the target. It also reports its own chip temperature ("ambient"). A reading counts as human when:
- the object is between **30 °C and 38 °C**, and
- it is at least **1.5 °C warmer** than ambient to switch on, and stays on while **1.0 °C warmer** (prevents flicker).

A detection is held for 1.2 s after the last warm reading. The comparison with ambient matters: in a warm room,
walls and floors can sit inside the 30–38 °C range on their own.

### Smoke and gas (MQ sensor)

The MQ-2 detects smoke and flammable gases (LPG, methane, hydrogen) in the air around the pod. After a 1-minute
warm-up (orange LED blinks), the module's digital output (DO) signals "gas" when the level passes the threshold set
on its potentiometer; the pod confirms it over two readings to avoid flicker. (With the analog wiring option, the pod
instead learns the clean-air level and alarms when the reading rises 120 points above it.) It is not directional — it describes the air where the pod is — so the hazard zone is marked at the pod's
position.

### Where locations come from

The pod has no GPS. Its position comes from one of these (chosen in the Pod tab):

| Source | How | Typical accuracy |
|---|---|---|
| **This laptop** (default) | Turns on automatically when the pod is connected by USB, since the laptop moves with the pod | 20–100 m (laptops estimate location from Wi-Fi; needs internet) |
| **A phone carried with the pod** | Open the pod's *phone tracker* link on that phone | 5–15 m outdoors (real GPS) |
| **A rescue team's phone** | "Follow *team*'s phone GPS" when a team carries the pod | Same as the team's phone |
| **Click on the map** | "Set position by clicking map" | As exact as the click |

The pod's marker moves on the map and leaves a trail. If a GPS module is added later, the firmware only needs to add
`"lat"` and `"lng"` to its JSON line; the backend switches to it automatically.

Rescue teams' locations come from their phones' GPS through the browser.

---

## Hardware

| Component | Purpose |
|---|---|
| ESP8266 — NodeMCU 1.0 (ESP-12E) | Controller; passive Wi-Fi listening |
| MLX90614 infrared thermometer (I²C) | Body-heat detection |
| MQ-2 gas sensor module (MQ-135 / MQ-5 also work) | Smoke / flammable-gas hazard |
| 2 × red LED, 1 × orange LED (+ resistors) | SIGNAL, THERMAL, HAZARD indicators |
| Passive buzzer | Audible priority alert |
| Breadboard, jumper wires, USB cable | |

### Wiring

| NodeMCU pin | Connects to |
|---|---|
| 3V3 | MLX90614 VCC |
| GND | MLX90614 GND, LED cathodes (via resistors), buzzer, MQ GND |
| D1 (GPIO5) | MLX90614 SCL |
| D2 (GPIO4) | MLX90614 SDA |
| D5 (GPIO14) | Red LED #1 — **SIGNAL** (through a resistor to GND) |
| D6 (GPIO12) | Red LED #2 — **THERMAL** (through a resistor to GND) |
| D7 (GPIO13) | Orange LED — **HAZARD** smoke/gas (through a resistor to GND) |
| D8 (GPIO15) | Buzzer (other leg to GND) |
| VIN (5 V) | MQ sensor **VCC** — the heater needs 5 V |
| GND | MQ sensor **GND** |
| D0 (GPIO16) | MQ sensor **DO** (digital "gas / no gas" output) |
| — | MQ sensor **AO**: not connected |
| D3, D4 | Unused (they must be HIGH at boot) |

**Setting the gas alarm level:** the MQ module decides "gas / no gas" itself on its DO pin, using the small blue
potentiometer. After the 1-minute warm-up, in clean air, turn the potentiometer until the module's **DO LED just
turns off**. Smoke near the sensor should then turn it on, and the pod's orange LED with it. The module gets warm
during operation; this is normal.

DO is driven from the module's 5 V supply through its own pull-up resistor. ESP8266 pins are rated for 3.3 V, so for
long-term use add a divider (or use the analog option below); for a prototype the module's pull-up keeps the
current very small.

*Analog option (`GAS_MODE GAS_ANALOG`):* gives a 0–1023 gas level and automatic clean-air calibration instead of the
potentiometer. Connect **AO → resistor → A0** and **A0 → resistor → GND** with two equal resistors (e.g. 10 kΩ each),
because AO can reach 5 V and A0 must stay below 3.3 V.

### Pod outputs

| Output | Meaning |
|---|---|
| Red LED — SIGNAL | A phone is transmitting close by (held 8 s after the last strong packet) |
| Red LED — THERMAL | A human-temperature heat source is in front of the sensor |
| Orange LED | Solid: smoke or gas detected · Blinking: gas sensor warming up |
| Buzzer | Double beep: Very high · single beep: High · short low beep: smoke/gas with no person |

---

## Software architecture

```
 POD (ESP8266) ──USB──► Operations console in Chrome / Edge   (Web Serial: "Connect pod (USB)")
   one JSON line             │  forwards every reading
   per reading               ▼
                       Backend (Node.js, port 4000) ──── SQLite database
                             │  Server-Sent Events: every change pushed to every open screen
              ┌──────────────┴───────────────┐
      Operations console               Rescuer phones  /team/T1, /team/T2, …
      (laptop, /ops)                   tasks, guidance, status, SOS
                                       ── GPS, status and SOS sent back ──►
```

- **Firmware** — Arduino sketch for the ESP8266. Prints a JSON line per ~0.7 s sensing window, e.g.
  `{"pod":"POD-01","seq":12,"obj":34.2,"amb":32.9,"thermal":1,"rssi":-58,"signal":1,"smoke":0,"gas":104,...}`.
- **Frontend** — React + TanStack Start + Tailwind CSS + Leaflet (OpenStreetMap). Reads the pod over USB with the
  browser's Web Serial API and forwards readings to the backend.
- **Backend** — dependency-free Node.js (TypeScript run directly by Node 22.18+). Turns readings into detections,
  manages teams, assignments and hazard zones, stores everything in SQLite (`node:sqlite`) and pushes live state to
  all browsers.
- The frontend's dev server proxies `/api` to the backend, so every device only needs the one address
  (`http://<laptop>:8080`). `npm run dev` starts both.

---

## Repository layout

```
firmware/rescue_pod/rescue_pod.ino   ESP8266 sketch: sensors, LEDs, buzzer, JSON output, optional Wi-Fi uplink
frontend/                            Website
  src/routes/ops.tsx                   Operations console
  src/routes/team.$teamId.tsx          Rescuer phone view
  src/routes/tracker.$podId.tsx        Phone tracker (phone GPS as the pod's location)
  src/components/                      Map, Detections / Teams / Pod / Log tabs, shared UI
  src/hooks/                           Live state, USB serial, geolocation, theme
backend/                             API, live updates, database
  src/index.ts                         HTTP routes and Server-Sent Events
  src/store.ts                         Detection, assignment and hazard logic
  src/logic.ts                         Reading parser and decision priority
  src/db.ts                            SQLite schema and storage
  tools/simulate.ts                    Simulated pod and teams (no hardware needed)
  tools/serial_bridge.py               USB reader for browsers without Web Serial
shared/types.ts                      Data model shared by frontend and backend
scripts/dev.mjs                      Starts backend + website together
```

---

## Getting started

### Requirements

- **Node.js 22.18 or newer**
- **Google Chrome or Microsoft Edge** on the laptop the pod is plugged into (for USB access)
- **Arduino IDE** with the **ESP8266 boards package** and the **Adafruit MLX90614 Library** (installs Adafruit BusIO).
  The MQ gas sensor needs no library.

### Install and run

```sh
git clone <repository-url>
cd rssi-rescue-search-pod
npm install          # installs the website's packages (the backend has none)
npm run dev          # starts the backend (port 4000) and the website (port 8080)
```

Open **http://localhost:8080/ops** for the Operations console. The first start creates the database and three sample
teams (Alpha, Bravo, Charlie).

### Flash and connect the pod

1. Open `firmware/rescue_pod/rescue_pod.ino` in the Arduino IDE, select **NodeMCU 1.0 (ESP-12E Module)** and upload.
   Optionally check the Serial Monitor (115200 baud), then **close it** — only one program can use the port.
2. With `npm run dev` running, open **http://localhost:8080/ops** in Chrome or Edge on the same laptop.
3. **Pod** tab → **Connect pod (USB)** → choose the port named *CP210x* or *USB-SERIAL CH340*.
4. Allow the browser's location request — the pod appears on the map at the laptop's position.

### Quick hardware check

- Point the thermal sensor at your hand from 5–10 cm → THERMAL LED, single beep, a **High** detection.
- Hold a phone with Wi-Fi on next to the pod (connected to a 2.4 GHz network and playing a video, or with its Wi-Fi
  settings screen open) → SIGNAL LED, the signal meter fills.
- Both together → double beep, a **Very high** detection.
- After the orange LED stops blinking and the potentiometer is set, hold a just-blown-out match or incense stick
  near the gas sensor → the module's DO LED and the pod's orange LED light, a low beep, and a "Smoke / gas" hazard
  zone on the map.

### Without hardware

```sh
npm run dev                  # terminal 1
npm run sim                  # terminal 2: a simulated pod walks around the site and detects in bursts
npm run sim -- --teams       # also moves assigned teams toward their tasks
```

**Load sample data** (top right of the console) adds example detections, hazard zones and an assignment.

---

## Using the system

### Operations console — `http://localhost:8080/ops`

- **Map** — the pod (with its path), detections numbered and coloured by priority, teams in their own colours with
  dashed routes to their tasks, hazard zones and search areas. *Follow pod*, *+ Search area*, *+ Hazard zone* and
  *Show on map* filters are at the top right.
- **Detections** — priority counts, filters (*Needs a team*, *Active*, *Completed*, *All*) and one card per detection
  with its evidence, label, notes and team buttons (best match first). Click a card to edit its label and notes,
  move it on the map or dismiss it as a false alarm.
- **Teams** — free / on a task / SOS / no signal summary, each team's tasks and distance, **+ Assign tasks**
  (then click detections on the map or in the list, and *Finish assigning*), *Show on map*, phone link, add / remove
  teams.
- **Pod** — USB connection and serial monitor, live LEDs, the signal meter, temperatures, gas sensor state and the
  pod's location source.
- **Log** — everything that happened, with CSV downloads.

### Rescuer phone — `http://<laptop-ip>:8080/team/T1`

Copy a team's link from the Teams tab and open it on a phone connected to the same Wi-Fi or hotspot as the laptop
(`npm run dev` prints the laptop's address). The phone shows its current task, distance and direction, warnings,
the next-step button, its other tasks and a map, and has an SOS button.

### A typical operation

1. Operations shares each team's link; teams open it and their positions appear on the map.
2. The pod is carried through the area. Detections appear, ranked Very high → High → Low.
3. Operations labels a detection (e.g. "Block B, floor 2, room 204") and sends a team with one click.
4. The team's phone vibrates and shows the task. They tap *We're on our way*, *We've arrived*, then *Person rescued*
   or *Nothing found*; Operations sees each step live.
5. If a team presses SOS, Operations gets a red banner with the team's last location. A team on a task that stops
   reporting its location for a minute is flagged too.
6. Everything is stored in the database; *New session* starts a new operation and keeps the old one.

### GPS on phones (HTTPS)

Browsers only give GPS to pages served over HTTPS (or `localhost`). On `http://192.168.x.x:8080` phones fall back to
*Set my spot* (tap on the map). For real phone GPS, either:
- **Android Chrome (quickest):** open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add
  `http://<laptop-ip>:8080`, enable and relaunch Chrome; or
- **HTTPS:** put `key.pem` and `cert.pem` in `frontend/certs/` and restart — the site switches to `https://`.
  With [mkcert](https://github.com/FiloSottile/mkcert):
  `mkcert -key-file frontend/certs/key.pem -cert-file frontend/certs/cert.pem <laptop-ip> localhost`.

---

## Configuration

### Firmware (`#define`s at the top of `rescue_pod.ino`)

| Setting | Default | Meaning |
|---|---|---|
| `POD_ID` | `"POD-01"` | Name shown on the website; give each pod its own |
| `HUMAN_TEMP_MIN` / `MAX` | 30.0 / 38.0 °C | Human skin temperature range |
| `HUMAN_DELTA_ABOVE_AMBIENT` | 1.5 °C | Warmer than ambient needed to start a thermal detection |
| `HUMAN_DELTA_KEEP` | 1.0 °C | …needed to keep it |
| `THERMAL_HOLD_MS` | 1200 | Hold THERMAL after the last warm reading |
| `SIGNAL_MODE` | `SIGNAL_PHONES` | Packets counted: phones only, all packets (`SIGNAL_ALL`), or searches only (`SIGNAL_PROBES_ONLY`) |
| `RSSI_THRESHOLD` | −70 dBm | Packet strength that counts as "phone close" |
| `SIGNAL_HOLD_MS` | 8000 | Hold SIGNAL after the last strong packet (phones transmit in bursts) |
| `LISTEN_WINDOW_MS` | 600 | Wi-Fi listening time per reading |
| `GAS_MODE` | `GAS_DIGITAL` | `GAS_DIGITAL` (DO → D0), `GAS_ANALOG` (AO → divider → A0) or `GAS_OFF` |
| `GAS_DO_ACTIVE_LOW` | `true` | Most MQ modules pull DO low when gas is detected; set `false` if yours is the opposite |
| `GAS_WARMUP_MS` | 60000 | Ignore the gas sensor while its heater warms up |
| `GAS_RISE_ALARM` / `GAS_RISE_CLEAR` | 120 / 60 | Analog mode: rise above clean air that starts / ends the alarm |
| `GAS_ABSOLUTE_ALARM` | 650 | Analog mode: alarm at this raw value regardless of calibration |
| `GAS_BEEP` | `true` | Low beep for smoke/gas when no person is detected |
| `SERIAL_DEBUG_TEXT` | `true` | Also print a human-readable line (prefixed `#`) |
| `UPLINK_WIFI` | `false` | Send readings over Wi-Fi instead of USB (see below) |

**Wi-Fi uplink (optional, experimental).** The ESP8266 cannot listen and stay connected at the same time. With
`UPLINK_WIFI true` and `WIFI_SSID`, `WIFI_PASS`, `SERVER_IP` set, it pauses listening every 5 s, joins the network,
posts its queued readings to the backend and resumes. It listens less of the time than over USB.

### Backend (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 4000 | Backend port |
| `DATA_DIR` | `backend/data` | Where the database is stored |
| `SITE_NAME`, `SITE_LAT`, `SITE_LNG` | VIT Chennai | Map title and starting centre |
| `POD_KEY` | — | If set, pods and bridges must send it in the `X-Pod-Key` header |

---

## Database

All data is stored in **SQLite** at `backend/data/rescue-pod.db`, created automatically on first start and saved on
every change. It can be opened with [DB Browser for SQLite](https://sqlitebrowser.org/).

| Table | Contents |
|---|---|
| `sessions` | One row per operation; *New session* closes the current one and keeps it |
| `readings` | Every raw sensing window from every pod: temperatures, RSSI, gas value, flags, priority |
| `detections` | Detections with position, priority, hazard tags, status and assigned team |
| `areas` | Search areas and hazard zones |
| `teams` | Rescue teams with their last known position |
| `pods` | Pods with their live position, path and last reading |
| `log` | Timestamped record of detections, assignments, status changes and SOS |
| `meta` | Internal settings (current session) |

`backend/data/` is excluded from Git, so local data is never uploaded.

---

## API

The backend's HTTP API (all paths under `/api`, JSON bodies):

| Method | Path | Purpose |
|---|---|---|
| GET | `/state` | Full current state |
| GET | `/stream` | Server-Sent Events — `event: state` on every change |
| POST | `/pods/:pod/readings` | Firmware JSON object or array (header `X-Pod-Link: usb\|serial\|wifi\|sim`) |
| POST | `/pods/:pod/position` | Live pod position `{lat, lng, accuracyM, source: "laptop"\|"phone"}` |
| PATCH / DELETE | `/pods/:pod` | `{name, locationMode: "tracked"\|"carried"\|"manual", manualPosition, carrierTeamId}` |
| POST | `/pods/:pod/trail/clear` | Clear the pod's path |
| POST / PATCH / DELETE | `/teams[/:id]` | `{name, members}` |
| POST | `/teams/:id/position` | `{lat, lng, accuracyM, source: "gps"\|"manual"}` |
| POST | `/teams/:id/sos` | `{active: true\|false}` |
| PATCH | `/detections/:id`, `/areas/:id` | `{assignedTeamId, status, label, notes, position, radiusM}` |
| POST / DELETE | `/areas[/:id]` | `{kind: "search"\|"hazard", center, radiusM, label}` |
| PATCH | `/site` | `{name, center, zoom}` |
| POST | `/session/reset` | Start a new session |
| POST | `/demo` | Add sample data |
| GET | `/sessions` | All stored sessions |
| GET | `/export/detections.csv`, `/export/log.csv`, `/export/readings.csv`, `/export/session.json` | Downloads (current session) |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Arduino upload fails: *could not open port COMx: Access is denied* | Another program holds the port. Click *Disconnect* in the Pod tab or close the Operations tab, close Serial Monitor and stop `npm run bridge`, then upload. Unplug and replug if needed. |
| *Connect pod (USB)* is missing or says the browser can't read USB | Use Chrome or Edge, on `http://localhost:8080/ops` on the laptop the pod is plugged into. |
| SIGNAL LED never lights | The ESP8266 only hears 2.4 GHz Wi-Fi. Keep the phone's Wi-Fi on, connected to a 2.4 GHz network or on its Wi-Fi settings screen. Check `PhonePkts` / `MaxRSSI` in the serial monitor; try `SIGNAL_ALL` or `RSSI_THRESHOLD -80`. |
| THERMAL doesn't detect | Open the Serial Monitor: each `#` line ends with the reason, e.g. `MLX NOT FOUND - check wiring`, `too cold (<30C)`, `too hot (>38C)` or `not warmer than ambient enough`. Aim at bare skin from 5–10 cm. Keep the warm MQ sensor away from the MLX90614 — its heater warms the thermometer and whatever it sees. In a very warm room, lower `HUMAN_DELTA_ABOVE_AMBIENT`. |
| Gas sensor always / never alarms | Wait for the 1-minute warm-up; a new sensor is unsteady for its first hours powered. Turn the module's potentiometer (DO LED just off in clean air). If the logic seems reversed, set `GAS_DO_ACTIVE_LOW false`. |
| Phone says GPS needs HTTPS | See [GPS on phones](#gps-on-phones-https), or use *Set my spot*. |
| Pod location is far off | Laptop location is approximate; use the phone tracker for real GPS. |
| Phones can't open the site | Phone and laptop must be on the same Wi-Fi or hotspot; allow Node.js through the Windows firewall. |

---

## Limitations

- **No GPS on the pod** — positions come from the laptop, a phone or the operator.
- **Proximity, not position** — RSSI says "closer / further", not distance or coordinates; obstacles change it a lot.
- **Phones must be on and transmitting on 2.4 GHz** to be heard; switched-off or dead phones cannot be detected.
- **Single-point thermal sensor** — it must be aimed at the person.
- **Gas sensor is not directional** and detects smoke and flammable gases together; it can't tell them apart.
- **Phones change their Wi-Fi address (MAC randomisation)**, so the pod can't count or identify phones; rescuers'
  own phones are heard too.
- **Map tiles need internet** (OpenStreetMap); everything else works offline on the local network.
- **The Operations tab must stay open** while the pod is connected by USB.
- **No login** — anyone on the network with a link can open any view.
- **Route guidance is basic** — a straight line with hazard warnings, not path-finding.

## Future work

- **ESP32** — adds Bluetooth listening (phones with Wi-Fi off but Bluetooth on, and iPhones' "Find My" signal for
  hours after shutdown); the ESP32-C5 also hears 5 GHz Wi-Fi.
- **GPS module on the pod** — already supported by the backend.
- **Dedicated IR flame sensor** alongside the gas sensor.
- **Several pods** for rough trilateration of a phone's position.
- **Offline floor-plan maps**, user login, and real path-finding around hazards.

---

## License

MIT — see [LICENSE](LICENSE).
