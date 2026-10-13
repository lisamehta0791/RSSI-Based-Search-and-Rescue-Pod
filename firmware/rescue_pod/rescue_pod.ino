/*
  RSSI Rescue Pod — firmware
  Board: NodeMCU 1.0 (ESP-12E Module)

  Every ~0.7 s the pod:
    - listens to WiFi packets that phones transmit (channels 1, 6, 11) and measures their
      strength (RSSI). It never connects to a phone; a switched-off / dead phone can't be heard.
    - reads the MLX90614 infrared thermometer: "human" = 30–38 °C and warmer than ambient.
    - reads the MQ gas sensor (smoke / flammable gas).
    - drives the LEDs and buzzer, and prints ONE JSON line on Serial for the website
      (plus a human-readable "#" line for the Serial Monitor, which the website ignores).

  Wiring:
    3V3 -> MLX90614 VCC      GND -> MLX90614 GND
    D1 (GPIO5)  -> MLX SCL   D2 (GPIO4)  -> MLX SDA
    D5 (GPIO14) -> red LED #1 SIGNAL   (via resistor to GND)
    D6 (GPIO12) -> red LED #2 THERMAL  (via resistor to GND)
    D7 (GPIO13) -> orange LED HAZARD (smoke/gas) (via resistor to GND)
    D8 (GPIO15) -> buzzer (other leg to GND)
    MQ gas sensor module (GAS_DIGITAL, default — no resistors needed):
      VCC -> VIN (5 V)    GND -> GND    DO -> D0 (GPIO16)    AO -> not connected
      Set the alarm level with the blue potentiometer on the module (see GAS settings below).
    MQ gas sensor module (GAS_ANALOG — needs two equal resistors, e.g. 10 kΩ + 10 kΩ):
      VCC -> VIN    GND -> GND    AO -> resistor -> A0, and A0 -> resistor -> GND    DO -> not connected
    D3, D4 -> unused (they must be HIGH at boot)
*/

#include <ESP8266WiFi.h>
#include <Wire.h>
#include <Adafruit_MLX90614.h>

extern "C" {
  #include "user_interface.h"
}

// ---------------- identity ----------------
#define POD_ID "POD-01"            // shown on the dashboard; give each pod its own id

// ---------------- modes ----------------
#define TEST_MODE_WIFI_ONLY false
#define SERIAL_DEBUG_TEXT   true   // also print a human-readable "#" line for the Serial Monitor
#define UPLINK_WIFI         false  // true = POST readings to the server over WiFi (see below)

// ---------------- pins ----------------
#define LED_SIGNAL  D5
#define LED_THERMAL D6
#define LED_HAZARD  D7     // orange LED: smoke / gas
#define BUZZER      D8

// ---------------- thermal (MLX90614) ----------------
#define HUMAN_TEMP_MIN 30.0
#define HUMAN_TEMP_MAX 38.0
// "Ambient" from the MLX90614 is the sensor chip's own temperature. In a warm room (or when the pod
// is held) it sits around 32–33 °C, so a finger at 35 °C is only ~2–3 °C warmer. Tuned on real
// readings: background stays below +0.5 °C, a finger/skin reads +1.5 to +3 °C.
#define HUMAN_DELTA_ABOVE_AMBIENT 1.5   // START detecting when this many °C warmer than ambient
#define HUMAN_DELTA_KEEP          1.0   // ...and KEEP detecting while at least this much warmer
#define THERMAL_HOLD_MS           1200  // keep THERMAL on this long after the last warm reading

// ---------------- signal (passive WiFi listening) ----------------
#define SIGNAL_ALL          0       // every packet, including routers (original behaviour)
#define SIGNAL_PHONES       1       // packets sent by phones/laptops only (recommended)
#define SIGNAL_PROBES_ONLY  2       // only "searching for WiFi" packets (strictest)
#define SIGNAL_MODE         SIGNAL_PHONES

#define RSSI_THRESHOLD      -70     // packet must be stronger than this to count (closer phone)
#define SIGNAL_HOLD_MS      8000    // keep SIGNAL on this long after the last strong packet
#define LISTEN_WINDOW_MS    600     // hop 1/6/11 for this long per reading

// ---------------- MQ gas sensor (smoke / flammable gas) ----------------
// GAS_DIGITAL: the module's DO pin. Its own comparator decides "gas / no gas" using the blue
//   potentiometer. To set it: after warm-up, in clean air, turn the pot until the module's
//   "DO" LED just turns OFF; smoke near the sensor should then turn it ON.
// GAS_ANALOG:  the AO pin through a resistor divider (A0 must stay below 3.3 V). The pod learns
//   the clean-air value and alarms when the reading rises GAS_RISE_ALARM above it.
// Either way readings are ignored for GAS_WARMUP_MS while the heater warms up (orange LED blinks).
#define GAS_OFF             0
#define GAS_DIGITAL         1
#define GAS_ANALOG          2
#define GAS_MODE            GAS_DIGITAL

#define GAS_DO_PIN          D0      // GAS_DIGITAL: module DO -> D0 (GPIO16)
#define GAS_DO_ACTIVE_LOW   true    // most MQ modules pull DO LOW when gas is detected
#define GAS_CONFIRM_READS   2       // DO must agree this many readings in a row (no flicker)

#define GAS_PIN             A0      // GAS_ANALOG: module AO -> divider -> A0
#define GAS_RISE_ALARM      120     // ALARM when this many counts (0..1023) above clean-air baseline
#define GAS_RISE_CLEAR      60      // ...and clear again below this rise (no flicker)
#define GAS_ABSOLUTE_ALARM  650     // alarm at this raw value regardless of baseline

#define GAS_WARMUP_MS       60000   // 1 min; a brand-new sensor is steadier after a few hours powered
#define GAS_BEEP            true    // short low beep when smoke/gas and no person detected

// ---------------- WiFi uplink (optional, untested on hardware) ----------------
// The ESP8266 can't sniff and stay connected at the same time, so every UPLINK_EVERY_MS
// it pauses sniffing, joins the hotspot, POSTs the buffered readings, and resumes.
// Use a phone hotspot or the laptop's hotspot; SERVER_IP is the laptop running server/.
#if UPLINK_WIFI
  #include <ESP8266HTTPClient.h>
  #include <WiFiClient.h>
  const char* WIFI_SSID = "RescueNet";
  const char* WIFI_PASS = "changeme123";
  const char* SERVER_IP = "192.168.137.1";
  const uint16_t SERVER_PORT = 4000;
  #define UPLINK_EVERY_MS   5000
  #define UPLINK_MAX_QUEUED 10
#endif

Adafruit_MLX90614 mlx = Adafruit_MLX90614();
bool mlxOK = false;

volatile uint32_t probeCount = 0;          // phone packets heard this window
volatile int8_t maxRssiThisWindow = -127;
volatile uint32_t lastStrongProbeMs = 0;   // 0 = never
bool thermalState = false;                 // thermal currently detected (for hysteresis)
float gasBase = -1;                        // learned clean-air reading (-1 = not yet)
bool gasAlarm = false;
uint8_t gasStreak = 0;                     // GAS_DIGITAL: consecutive readings disagreeing with gasAlarm
uint32_t lastMlxRetry = 0;
uint32_t lastWarmMs = 0;                   // last reading that passed the thermal test

struct RxControl {
  signed rssi:8;
  unsigned rate:4;
  unsigned is_group:1;
  unsigned:1;
  unsigned sig_mode:2;
  unsigned legacy_length:12;
  unsigned damatch0:1;
  unsigned damatch1:1;
  unsigned bssidmatch0:1;
  unsigned bssidmatch1:1;
  unsigned MCS:7;
  unsigned CWB:1;
  unsigned HT_length:16;
  unsigned Smoothing:1;
  unsigned Not_Sounding:1;
  unsigned:1;
  unsigned Aggregation:1;
  unsigned STBC:2;
  unsigned FEC_CODING:1;
  unsigned SGI:1;
  unsigned rxend_state:8;
  unsigned ampdu_cnt:8;
  unsigned channel:4;
  unsigned:12;
};

// len == 128: management frame (beacon, probe request, ...) — rx_ctrl + first 112 bytes.
// len % 10 == 0: data frame — rx_ctrl + first 36 bytes. Either way the 802.11 header
// starts right after rx_ctrl, so buf[0..1] is the frame-control field.
struct sniffer_buf2 {
  struct RxControl rx_ctrl;
  uint8_t buf[112];
  uint16_t cnt;
  uint16_t len;
};

void promisc_cb(uint8_t *buf, uint16_t len) {
  if (len == 12) return;  // rx_ctrl only, no frame data
  struct sniffer_buf2 *sniffer = (struct sniffer_buf2*) buf;

  uint8_t fc0 = sniffer->buf[0];          // type / subtype
  uint8_t fc1 = sniffer->buf[1];          // flags: bit0 = ToDS, bit1 = FromDS
  bool probeRequest = (fc0 == 0x40);
  bool assocRequest = (fc0 == 0x00) || (fc0 == 0x20);           // phone joining a network
  bool dataFromStation = ((fc0 & 0x0C) == 0x08) && ((fc1 & 0x03) == 0x01);  // phone -> router

  if (SIGNAL_MODE == SIGNAL_PROBES_ONLY && !probeRequest) return;
  if (SIGNAL_MODE == SIGNAL_PHONES && !(probeRequest || assocRequest || dataFromStation)) return;

  int8_t rssi = sniffer->rx_ctrl.rssi;
  probeCount++;
  if (rssi > maxRssiThisWindow) maxRssiThisWindow = rssi;
  if (rssi > RSSI_THRESHOLD) lastStrongProbeMs = millis();
}

void startSniffing() {
  wifi_set_opmode(STATION_MODE);
  wifi_promiscuous_enable(0);
  wifi_set_promiscuous_rx_cb(promisc_cb);
  wifi_promiscuous_enable(1);
}

// ---------------- JSON helpers ----------------
void jsonNum(String &s, const char *key, double v, uint8_t decimals = 2) {
  s += '"'; s += key; s += "\":";
  if (isnan(v) || v < -100) s += "null"; else s += String(v, (unsigned int)decimals);
  s += ',';
}
void jsonInt(String &s, const char *key, long v, bool last = false) {
  s += '"'; s += key; s += "\":"; s += v;
  if (!last) s += ',';
}

#if UPLINK_WIFI
String queued[UPLINK_MAX_QUEUED];
uint8_t queuedCount = 0;
unsigned long lastUplink = 0;

void queueReading(const String &json) {
  if (queuedCount == UPLINK_MAX_QUEUED) {        // drop the oldest
    for (uint8_t i = 1; i < UPLINK_MAX_QUEUED; i++) queued[i - 1] = queued[i];
    queuedCount--;
  }
  queued[queuedCount++] = json;
}

void uplink() {
  wifi_promiscuous_enable(0);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 6000) delay(50);

  if (WiFi.status() == WL_CONNECTED) {
    String body = "[";
    for (uint8_t i = 0; i < queuedCount; i++) { if (i) body += ','; body += queued[i]; }
    body += ']';
    WiFiClient client;
    HTTPClient http;
    String url = String("http://") + SERVER_IP + ":" + SERVER_PORT + "/api/pods/" + POD_ID + "/readings";
    http.begin(client, url);
    http.setTimeout(1500);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Pod-Link", "wifi");
    int code = http.POST(body);
    http.end();
    Serial.printf("[uplink] %u readings -> HTTP %d\n", queuedCount, code);
    if (code == 200) queuedCount = 0;
  } else {
    Serial.println("[uplink] could not join WiFi — keeping readings queued");
  }
  WiFi.disconnect();
  startSniffing();
}
#endif

void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(LED_SIGNAL, OUTPUT);
  pinMode(LED_THERMAL, OUTPUT);
  pinMode(LED_HAZARD, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  digitalWrite(LED_SIGNAL, LOW);
  digitalWrite(LED_THERMAL, LOW);
  digitalWrite(LED_HAZARD, LOW);

  Wire.begin(D2, D1);
  mlxOK = mlx.begin();
  Serial.println(mlxOK ? "MLX90614 detected OK."
                       : "!!! MLX90614 NOT DETECTED — check VCC->3V3, GND, SCL->D1, SDA->D2 (will keep retrying)");
  if (GAS_MODE == GAS_DIGITAL) pinMode(GAS_DO_PIN, INPUT);

  WiFi.persistent(false);   // don't rewrite flash on every (re)connect
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  startSniffing();

  Serial.println("Pod ready.");
}

int channels[] = {1, 6, 11};
int chIndex = 0;
uint32_t seq = 0;

void loop() {
  probeCount = 0;
  maxRssiThisWindow = -127;

  unsigned long listenStart = millis();
  while (millis() - listenStart < LISTEN_WINDOW_MS) {
    wifi_set_channel(channels[chIndex]);
    chIndex = (chIndex + 1) % 3;
    delay(100);
  }

  uint32_t lastProbe = lastStrongProbeMs;
  bool signalDetected = lastProbe != 0 && (millis() - lastProbe) < SIGNAL_HOLD_MS;

  // If the thermometer wasn't found at power-on (loose wire), keep trying every 5 s.
  if (!mlxOK && millis() - lastMlxRetry > 5000) {
    lastMlxRetry = millis();
    mlxOK = mlx.begin();
    if (mlxOK) Serial.println("MLX90614 found.");
  }

  double objTemp = mlxOK ? mlx.readObjectTempC() : NAN;
  double ambTemp = mlxOK ? mlx.readAmbientTempC() : NAN;
  // Hysteresis: a higher bar to switch ON than to stay ON, so readings near the edge don't flicker.
  double needed = thermalState ? HUMAN_DELTA_KEEP : HUMAN_DELTA_ABOVE_AMBIENT;
  bool warmNow = mlxOK && !isnan(objTemp) && !isnan(ambTemp) &&
    (objTemp >= HUMAN_TEMP_MIN && objTemp <= HUMAN_TEMP_MAX) &&
    (objTemp - ambTemp >= needed);
  if (warmNow) lastWarmMs = millis();
  bool thermalDetected = warmNow || (lastWarmMs != 0 && millis() - lastWarmMs < THERMAL_HOLD_MS);
  thermalState = thermalDetected;

  // Why THERMAL is on/off — printed in the Serial Monitor line, to make tuning easy.
  const char *thermalWhy =
      !mlxOK                                  ? "MLX NOT FOUND - check wiring" :
      isnan(objTemp) || isnan(ambTemp)        ? "MLX read failed" :
      warmNow                                 ? "HUMAN" :
      thermalDetected                         ? "holding" :
      objTemp < HUMAN_TEMP_MIN                ? "too cold (<30C) - aim closer / at skin" :
      objTemp > HUMAN_TEMP_MAX                ? "too hot (>38C) - not a person" :
                                                "not warmer than ambient enough";

  // smoke: -1 = no gas sensor, -2 = warming up, 0 = clean air, 1 = smoke / gas detected
  int gasRaw = -1;
  int smoke = -1;
  if (GAS_MODE == GAS_DIGITAL) {
    bool doActive = (digitalRead(GAS_DO_PIN) == LOW) == GAS_DO_ACTIVE_LOW;
    gasRaw = doActive ? 1 : 0;                       // printed in the debug line only
    if (millis() < GAS_WARMUP_MS) {
      smoke = -2;
    } else {
      // change state only after GAS_CONFIRM_READS readings in a row disagree with it
      gasStreak = (doActive != gasAlarm) ? gasStreak + 1 : 0;
      if (gasStreak >= GAS_CONFIRM_READS) { gasAlarm = doActive; gasStreak = 0; }
      smoke = gasAlarm ? 1 : 0;
    }
  } else if (GAS_MODE == GAS_ANALOG) {
    gasRaw = analogRead(GAS_PIN);
    if (millis() < GAS_WARMUP_MS) {
      smoke = -2;
      gasBase = gasBase < 0 ? gasRaw : gasBase * 0.8 + gasRaw * 0.2;   // follow it as it settles
    } else {
      if (gasBase < 0) gasBase = gasRaw;
      float rise = gasRaw - gasBase;
      if (!gasAlarm && (rise >= GAS_RISE_ALARM || gasRaw >= GAS_ABSOLUTE_ALARM)) gasAlarm = true;
      else if (gasAlarm && rise < GAS_RISE_CLEAR && gasRaw < GAS_ABSOLUTE_ALARM) gasAlarm = false;
      if (!gasAlarm) gasBase = gasBase * 0.99 + gasRaw * 0.01;          // slow drift in clean air
      smoke = gasAlarm ? 1 : 0;
    }
  }

  seq++;

  // ---- machine-readable line for the bridge / server ----
  String json = "{";
  json += "\"pod\":\"" POD_ID "\",";
  jsonInt(json, "seq", seq);
  jsonInt(json, "up", millis());
  jsonInt(json, "mlx", mlxOK ? 1 : 0);
  jsonNum(json, "obj", objTemp);
  jsonNum(json, "amb", ambTemp);
  jsonInt(json, "thermal", thermalDetected ? 1 : 0);
  jsonInt(json, "rssi", maxRssiThisWindow);
  jsonInt(json, "probes", probeCount);
  jsonInt(json, "signal", signalDetected ? 1 : 0);
  jsonInt(json, "smoke", smoke);
  jsonInt(json, "gas", GAS_MODE == GAS_ANALOG ? gasRaw : -1);        // analog value only
  jsonInt(json, "gasBase", GAS_MODE == GAS_ANALOG && gasBase >= 0 ? (long)gasBase : -1);
  jsonInt(json, "flame", -1, true);     // no flame sensor fitted
  json += "}";
  Serial.println(json);

  // ---- human-readable line (same as v1) ----
  if (SERIAL_DEBUG_TEXT) {
    Serial.print("# Obj: "); Serial.print(objTemp);
    Serial.print(" | Amb: "); Serial.print(ambTemp);
    Serial.print(" | Thermal: "); Serial.print(thermalDetected);
    Serial.print(" ("); Serial.print(thermalWhy); Serial.print(")");
    Serial.print(" || PhonePkts: "); Serial.print(probeCount);
    Serial.print(" | MaxRSSI: "); Serial.print(maxRssiThisWindow);
    Serial.print(" | Signal: "); Serial.print(signalDetected);
    if (GAS_MODE == GAS_DIGITAL) {
      Serial.print(" || Gas DO: "); Serial.print(gasRaw ? "ACTIVE" : "idle");
      Serial.print(smoke == -2 ? " WARMING UP" : smoke == 1 ? " SMOKE/GAS!" : " ok");
    } else if (GAS_MODE == GAS_ANALOG) {
      Serial.print(" || Gas: "); Serial.print(gasRaw);
      Serial.print(" (clean air "); Serial.print((int)gasBase); Serial.print(")");
      Serial.print(smoke == -2 ? " WARMING UP" : smoke == 1 ? " SMOKE/GAS!" : " ok");
    }
    Serial.println();
  }

#if UPLINK_WIFI
  queueReading(json);
  if (millis() - lastUplink >= UPLINK_EVERY_MS) {
    lastUplink = millis();
    uplink();
  }
#endif

  if (TEST_MODE_WIFI_ONLY) {
    digitalWrite(LED_SIGNAL, signalDetected ? HIGH : LOW);
    return;
  }

  digitalWrite(LED_SIGNAL, signalDetected ? HIGH : LOW);
  digitalWrite(LED_THERMAL, thermalDetected ? HIGH : LOW);
  // Orange LED: solid = smoke/gas, blinking = gas sensor still warming up.
  digitalWrite(LED_HAZARD, smoke == 1 || (smoke == -2 && (seq % 2)) ? HIGH : LOW);

  // Buzzer follows the decision priority. Fire never silences a human alert.
  if (thermalDetected && signalDetected) {
    tone(BUZZER, 2000, 100); delay(150); tone(BUZZER, 2000, 100);   // VERY HIGH: double beep
  } else if (thermalDetected) {
    tone(BUZZER, 2000, 150);                                        // HIGH: single beep
  } else if (GAS_BEEP && smoke == 1) {
    tone(BUZZER, 800, 60);                                          // smoke/gas: short LOW beep
  } else {
    noTone(BUZZER);                                                 // LOW / NONE: silent
  }
}
