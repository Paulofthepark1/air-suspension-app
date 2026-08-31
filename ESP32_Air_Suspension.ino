/*
  ESP32 BLE Air Suspension Controller - TARGET MODE

  Firmware updates: the app downloads firmware.bin (built by GitHub
  Actions) on the phone and streams it here over BLE (FWBEGIN / raw
  chunks / FWEND); the ESP32 flashes itself and reboots. Integrity is
  checked by size and MD5 before the new image is accepted.
  ArduinoOTA (IDE network port, via OTA:1 + Wi-Fi credentials stored
  in NVS) remains as a rescue path only.
*/
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Arduino.h>
#include <LittleFS.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WiFiUdp.h>
#include <ArduinoOTA.h>
#include <Preferences.h>
#include <Update.h>
#include <esp_system.h>
#include <sys/time.h>

#define FW_VERSION "2.3.4"

BLEServer* pServer = NULL;
BLECharacteristic* pCharLeft = NULL;
BLECharacteristic* pCharRight = NULL;
BLECharacteristic* pCharTank = NULL;
BLECharacteristic* pCharCmd = NULL;
BLECharacteristic* pCharGraph = NULL;
BLECharacteristic* pCharOtaStatus = NULL;
BLECharacteristic* pCharVersion = NULL;
BLECharacteristic* pCharFwData = NULL;
BLECharacteristic* pCharMode = NULL;

// Wi-Fi credentials live in NVS, set from the app via WIFI: command.
// Only used for the ArduinoOTA rescue path.
Preferences prefs;
String wifiSsid = "";
String wifiPass = "";

// ArduinoOTA rescue mode state
bool otaMode = false;
bool otaWifiConnected = false;
bool otaUpdateStarted = false;
unsigned long otaStartTime = 0;
unsigned long otaConnectedTime = 0;

// BLE firmware transfer state
volatile bool fwReceiving = false;
size_t fwExpectedSize = 0;
size_t fwReceived = 0;
uint32_t fwChunkCount = 0;
unsigned long fwLastChunkTime = 0;
#define FW_ACK_EVERY 64   // chunks per FWACK (must match the app)

bool deviceConnected = false;
bool oldDeviceConnected = false;

// State Tracking (-1 means no sensor / no reading)
int leftPsi = -1;
int rightPsi = -1;
int tankPsi = -1;
int targetLeftPsi = 0;
int targetRightPsi = 0;

enum ControlState {
  IDLE,
  FILLING,
  DEFLATING
};

ControlState leftState = IDLE;
ControlState rightState = IDLE;

bool commandReceived = false; // Solenoids stay off until user sends SET

// ---- DRIVE MODES ----
// TOW: manual SET control (original behavior).
// DAILY: the controller autonomously holds the bags at dailyTargetPsi,
// with or without a phone connected, and persists across reboots.
enum DriveMode { MODE_TOW = 0, MODE_DAILY = 1 };
DriveMode driveMode = MODE_TOW;
int dailyTargetPsi = 10;                        // DTGT: command, NVS-persisted
const int DAILY_MIN_PSI = 5;                    // critical floor — fill below this no matter what
const int DAILY_FILL_HYST = 2;                  // refill when psi <= target - hyst
const int DAILY_DEFL_HYST = 3;                  // deflate when psi >= target + hyst
const int TANK_FILL_MARGIN = 3;                 // tank must exceed target by this for air to flow
const unsigned long DAILY_FILL_MAX_MS = 30000;  // cap a fill attempt — a burst line can't drain the tank
const unsigned long DAILY_COOLDOWN_MS = 45000;  // wait between capped attempts

bool dailyFillingL = false, dailyFillingR = false;
bool dailyDeflatingL = false, dailyDeflatingR = false;
unsigned long dailyFillStartL = 0, dailyFillStartR = 0;
unsigned long dailyCooldownL = 0, dailyCooldownR = 0;
int dailyFillFromL = 0, dailyFillFromR = 0;
int dailyDeflFromL = 0, dailyDeflFromR = 0;
unsigned long lastDailyCheck = 0;
String modeStatusValue = "";
String lastDailyWarn = "";
unsigned long dumpStartMs = 0;

// TOW-mode transition tracking (for the event log)
ControlState prevLeftState = IDLE, prevRightState = IDLE;
unsigned long towStartMsL = 0, towStartMsR = 0;
int towFromPsiL = 0, towFromPsiR = 0;

// ---- FULL AIR-DOWN (DRAIN) ----
// There is no tank dump valve: the only way out of the tank is THROUGH
// a bag circuit (in-valve -> bag -> out-valve -> atmosphere). Sequence:
// vent both bags, then pass-through-bleed the tank one side at a time,
// alternating sides every 30s so coils cool and wear is shared. Valves
// switch staggered 300ms so solenoid inrush never stacks; never more
// than two solenoids energized. Hard time caps.
enum DrainPhase { DRAIN_OFF = 0, DRAIN_BAGS, DRAIN_TANK };
DrainPhase drainPhase = DRAIN_OFF;
bool drainSideRight = false;
unsigned long drainStartMs = 0;
unsigned long drainPhaseMs = 0;
unsigned long drainSwapMs = 0;
unsigned long lastDrainCheck = 0;
const unsigned long DRAIN_BAGS_MAX_MS = 120000; // 2 min cap
const unsigned long DRAIN_TANK_MAX_MS = 600000; // 10 min cap (pass-through is slow)
const unsigned long DRAIN_SWAP_MS = 30000;      // alternate sides every 30s
const int DRAIN_DONE_PSI = 2;

// Graph Logging Variables
unsigned long bootTimestamp = 0;
bool timeSet = false;
bool isStreamingGraph = false;
File streamingFile;
unsigned long lastLogUpdate = 0;
unsigned long graphSinceEpoch = 0;  // GET:<epoch> — stream only newer rows
String graphPendingLine = "";
// The phone keeps the long-term archive; the on-device file is a rolling
// buffer, wiped when it gets big so LittleFS never fills up.
const size_t HISTORY_MAX_BYTES = 300 * 1024;

// ---- PIN DEFINITIONS (ESP32-S3) ----
const int LEFT_AIR_IN_PIN  = 2;
const int LEFT_AIR_OUT_PIN = 42;
const int RIGHT_AIR_IN_PIN = 41;
const int RIGHT_AIR_OUT_PIN = 40;
const int TANK_DUMP_PIN = 39;
const int LEFT_SENSOR_PIN = 4;
const int RIGHT_SENSOR_PIN = 5;
const int TANK_SENSOR_PIN = 6;

// Relay logic - Active-HIGH: 3.3V triggers optocoupler to GND, 0V = relay off
// Active-HIGH is required for 3.3V GPIO → 5V relay boards to avoid chatter
#define RELAY_ON HIGH
#define RELAY_OFF LOW

// Service and Characteristics
#define SERVICE_UUID           "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHAR_LEFT_PSI_UUID     "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define CHAR_RIGHT_PSI_UUID    "beb5483e-36e2-4688-b7f5-ea07361b26a8"
#define CHAR_TANK_PSI_UUID     "beb5483e-36e4-4688-b7f5-ea07361b26a8"
#define CHAR_CMD_UUID          "beb5483e-36e3-4688-b7f5-ea07361b26a8"
#define CHAR_GRAPH_UUID        "beb5483e-36e5-4688-b7f5-ea07361b26a8"
#define CHAR_OTA_STATUS_UUID   "beb5483e-36e6-4688-b7f5-ea07361b26a8"
#define CHAR_VERSION_UUID      "beb5483e-36e7-4688-b7f5-ea07361b26a8"
#define CHAR_FW_DATA_UUID      "beb5483e-36e8-4688-b7f5-ea07361b26a8"
#define CHAR_MODE_UUID         "beb5483e-36e9-4688-b7f5-ea07361b26a8"

// ---- VALVE WRAPPER + LIFETIME ACTUATION COUNTERS ----
// All solenoid writes go through setValve so every OFF->ON edge is counted.
// Counters persist in NVS (saved every 10 min when changed, and on STATS).
uint32_t valveCount[5] = {0, 0, 0, 0, 0}; // Lin, Lout, Rin, Rout, Dump
bool valveState[5] = {false, false, false, false, false};
bool valveCountsDirty = false;
unsigned long lastCounterSave = 0;

int valveIndex(int pin) {
  if (pin == LEFT_AIR_IN_PIN) return 0;
  if (pin == LEFT_AIR_OUT_PIN) return 1;
  if (pin == RIGHT_AIR_IN_PIN) return 2;
  if (pin == RIGHT_AIR_OUT_PIN) return 3;
  if (pin == TANK_DUMP_PIN) return 4;
  return -1;
}

void setValve(int pin, bool on) {
  int i = valveIndex(pin);
  if (i >= 0 && on && !valveState[i]) {
    valveCount[i]++;
    valveCountsDirty = true;
  }
  if (i >= 0) valveState[i] = on;
  digitalWrite(pin, on ? RELAY_ON : RELAY_OFF);
}

void saveValveCounters() {
  if (!valveCountsDirty) return;
  prefs.begin("airsus", false);
  for (int i = 0; i < 5; i++) {
    char key[4] = {'c', (char)('0' + i), 0, 0};
    prefs.putUInt(key, valveCount[i]);
  }
  prefs.end();
  valveCountsDirty = false;
  lastCounterSave = millis();
}

void stopAllSolenoids() {
  setValve(LEFT_AIR_IN_PIN, false);
  setValve(LEFT_AIR_OUT_PIN, false);
  setValve(RIGHT_AIR_IN_PIN, false);
  setValve(RIGHT_AIR_OUT_PIN, false);
  setValve(TANK_DUMP_PIN, false);
}

// ---- EVENT LOG ----
// /events.csv rows: epoch,CODE[:detail...]. Events before the phone has
// synced the clock are buffered with boot-relative time and written with
// corrected epochs once TIME arrives — so reboot reasons are never lost.
const size_t EVENTS_MAX_BYTES = 100 * 1024;
struct PendingEvent { unsigned long ms; char code[48]; };
PendingEvent pendingEvents[20];
int pendingEventCount = 0;

// History rows logged before the clock is known: buffered in a RAM ring
// (up to 24h) with boot-relative time and back-stamped with real epochs at
// the next TIME sync. The clock survives software reboots via the RTC, so
// this ring only matters after a full power cut.
struct PendingRow { uint32_t ms; int16_t l, r, tk, sl, sr; };
const int PENDING_ROWS_MAX = 1440;
PendingRow pendingRows[PENDING_ROWS_MAX];
int pendingRowCount = 0;
int pendingRowHead = 0;

void flushPendingRows() {
  if (pendingRowCount == 0 || !timeSet) return;
  File f = LittleFS.open("/history.csv", FILE_APPEND);
  if (f) {
    int start = (pendingRowHead - pendingRowCount + PENDING_ROWS_MAX) % PENDING_ROWS_MAX;
    for (int i = 0; i < pendingRowCount; i++) {
      PendingRow &p = pendingRows[(start + i) % PENDING_ROWS_MAX];
      f.printf("%lu,%d,%d,%d,%d,%d\n", bootTimestamp + p.ms / 1000, p.l, p.r, p.tk, p.sl, p.sr);
    }
    f.close();
  }
  pendingRowCount = 0;
}

void writeEventRow(unsigned long epoch, const char* code) {
  File check = LittleFS.open("/events.csv", FILE_READ);
  if (check) {
    size_t sz = check.size();
    check.close();
    if (sz > EVENTS_MAX_BYTES) LittleFS.remove("/events.csv");
  }
  File f = LittleFS.open("/events.csv", FILE_APPEND);
  if (f) {
    f.printf("%lu,%s\n", epoch, code);
    f.close();
  }
}

void logEvent(const String& code) {
  Serial.println("EVENT: " + code);
  if (!timeSet) {
    if (pendingEventCount < 20) {
      pendingEvents[pendingEventCount].ms = millis();
      strncpy(pendingEvents[pendingEventCount].code, code.c_str(), 47);
      pendingEvents[pendingEventCount].code[47] = 0;
      pendingEventCount++;
    }
    return;
  }
  writeEventRow(bootTimestamp + millis() / 1000, code.c_str());
}

void flushPendingEvents() {
  for (int i = 0; i < pendingEventCount; i++) {
    writeEventRow(bootTimestamp + pendingEvents[i].ms / 1000, pendingEvents[i].code);
  }
  pendingEventCount = 0;
}

void startDrain() {
  commandReceived = false;
  leftState = IDLE;
  rightState = IDLE;
  stopAllSolenoids();
  resetDailyState();
  drainPhase = DRAIN_BAGS;
  drainStartMs = drainPhaseMs = millis();
  setValve(LEFT_AIR_OUT_PIN, true);
  delay(300); // stagger so solenoid inrush never stacks
  setValve(RIGHT_AIR_OUT_PIN, true);
  logEvent("DRAINSTART");
  setOtaStatus("DRAIN:BAGS", false);
}

void endDrain(const char* reason) {
  stopAllSolenoids();
  drainPhase = DRAIN_OFF;
  logEvent("DRAINEND:" + String((millis() - drainStartMs) / 1000) + "s:" + reason);
  setOtaStatus(String("Drain ") + reason + ".", false);
}

// Open one side's in+out pair so tank air bleeds through that bag circuit
void drainOpenSide(bool right) {
  setValve(right ? RIGHT_AIR_OUT_PIN : LEFT_AIR_OUT_PIN, true);
  delay(300); // stagger inrush
  setValve(right ? RIGHT_AIR_IN_PIN : LEFT_AIR_IN_PIN, true);
}

void drainCloseSide(bool right) {
  setValve(right ? RIGHT_AIR_IN_PIN : LEFT_AIR_IN_PIN, false);
  setValve(right ? RIGHT_AIR_OUT_PIN : LEFT_AIR_OUT_PIN, false);
}

const char* resetReasonStr() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "poweron";
    case ESP_RST_SW: return "restart";
    case ESP_RST_PANIC: return "crash";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_EXT: return "ext-reset";
    default: return "other";
  }
}

// Persist an OTA status message so it survives the reboot after an
// update attempt; the app reads and clears it on next connect.
void setOtaStatus(const String& msg, bool persist) {
  pCharOtaStatus->setValue(msg.c_str());
  pCharOtaStatus->notify();
  if (persist) {
    prefs.begin("airsus", false);
    prefs.putString("otamsg", msg);
    prefs.end();
  }
  Serial.println("OTA status: " + msg);
}

void loadWifiCredentials() {
  prefs.begin("airsus", true);
  wifiSsid = prefs.getString("ssid", "");
  wifiPass = prefs.getString("pass", "");
  driveMode = prefs.getUChar("mode", 0) == 1 ? MODE_DAILY : MODE_TOW;
  dailyTargetPsi = prefs.getInt("dtgt", 10);
  prefs.end();
  if (dailyTargetPsi < DAILY_MIN_PSI) dailyTargetPsi = DAILY_MIN_PSI;
  if (dailyTargetPsi > 50) dailyTargetPsi = 50;
}

void publishModeStatus(const String& s) {
  if (s == modeStatusValue) return;
  modeStatusValue = s;
  pCharMode->setValue(s.c_str());
  pCharMode->notify();
  Serial.println("Mode status: " + s);
}

void resetDailyState() {
  dailyFillingL = dailyFillingR = false;
  dailyDeflatingL = dailyDeflatingR = false;
  dailyCooldownL = dailyCooldownR = 0;
}

void setDriveMode(DriveMode m) {
  driveMode = m;
  prefs.begin("airsus", false);
  prefs.putUChar("mode", m == MODE_DAILY ? 1 : 0);
  prefs.end();
  stopAllSolenoids();
  commandReceived = false;
  leftState = IDLE;
  rightState = IDLE;
  resetDailyState();
  logEvent(m == MODE_DAILY ? "MODE:DAILY" : "MODE:TOW");
  modeStatusValue = ""; // force republish
  if (m == MODE_TOW) {
    publishModeStatus("T");
  } else {
    // loop() takes over within a second; publish a provisional state now
    publishModeStatus("D:OK:" + String(dailyTargetPsi));
  }
  Serial.println(m == MODE_DAILY ? "Mode: DAILY" : "Mode: TOW");
}

// One side of DAILY-mode maintenance. Fill/deflate toward dailyTargetPsi
// with hysteresis; fill attempts are time-capped so a burst bag or empty
// tank can't hold a valve open indefinitely.
void serviceDailySide(int psi, int inPin, int outPin,
                      bool &filling, bool &deflating,
                      unsigned long &fillStart, unsigned long &cooldownUntil,
                      bool tankOk, bool &wantsButCant,
                      int &fillFrom, int &deflFrom, char side) {
  if (psi < 0) { // no sensor reading — keep this side's valves shut
    filling = false;
    deflating = false;
    setValve(inPin, false);
    setValve(outPin, false);
    return;
  }

  if (deflating) {
    if (psi <= dailyTargetPsi) {
      deflating = false;
      setValve(outPin, false);
      logEvent(String("DDEFL") + side + ":" + String(deflFrom) + ">" + String(psi));
    }
    return;
  }

  if (filling) {
    if (psi >= dailyTargetPsi) {
      filling = false;
      setValve(inPin, false);
      logEvent(String("DFILL") + side + ":" + String((millis() - fillStart) / 1000) + "s:" + String(fillFrom) + ">" + String(psi));
    } else if (millis() - fillStart > DAILY_FILL_MAX_MS) {
      filling = false;
      setValve(inPin, false);
      cooldownUntil = millis() + DAILY_COOLDOWN_MS;
      logEvent(String("DFILLCAP") + side + ":" + String(fillFrom) + ">" + String(psi));
      Serial.println("Daily fill attempt capped; cooling down.");
    } else if (!tankOk) {
      filling = false;
      setValve(inPin, false);
      wantsButCant = true;
    }
    return;
  }

  if (psi >= dailyTargetPsi + DAILY_DEFL_HYST) {
    deflating = true;
    deflFrom = psi;
    setValve(inPin, false);
    setValve(outPin, true);
  } else if (psi <= dailyTargetPsi - DAILY_FILL_HYST || psi < DAILY_MIN_PSI) {
    if (!tankOk) {
      wantsButCant = true;
    } else if (millis() >= cooldownUntil) {
      filling = true;
      fillStart = millis();
      fillFrom = psi;
      setValve(outPin, false);
      setValve(inPin, true);
    }
  }
}

void serviceDailyMode() {
  // Unknown tank sensor: allow fills (the 30s cap is the backstop)
  bool tankOk = (tankPsi < 0) ? true : (tankPsi >= dailyTargetPsi + TANK_FILL_MARGIN);
  bool wantsButCant = false;

  serviceDailySide(leftPsi, LEFT_AIR_IN_PIN, LEFT_AIR_OUT_PIN,
                   dailyFillingL, dailyDeflatingL, dailyFillStartL, dailyCooldownL,
                   tankOk, wantsButCant, dailyFillFromL, dailyDeflFromL, 'L');
  serviceDailySide(rightPsi, RIGHT_AIR_IN_PIN, RIGHT_AIR_OUT_PIN,
                   dailyFillingR, dailyDeflatingR, dailyFillStartR, dailyCooldownR,
                   tankOk, wantsButCant, dailyFillFromR, dailyDeflFromR, 'R');

  bool bagsCritical = ((leftPsi >= 0 && leftPsi < DAILY_MIN_PSI) ||
                       (rightPsi >= 0 && rightPsi < DAILY_MIN_PSI)) && !tankOk;
  String st;
  if (bagsCritical) st = "LOWBAGS";
  else if (wantsButCant) st = "LOWTANK";
  else if (dailyFillingL || dailyFillingR) st = "FILL";
  else if (dailyDeflatingL || dailyDeflatingR) st = "DEFL";
  else st = "OK";

  // Log warning transitions to the event log
  if ((st == "LOWTANK" || st == "LOWBAGS") && st != lastDailyWarn) {
    logEvent("WARN:" + st);
  }
  lastDailyWarn = (st == "LOWTANK" || st == "LOWBAGS") ? st : "";

  publishModeStatus("D:" + st + ":" + String(dailyTargetPsi));
}

void abortFwTransfer(const String& reason) {
  if (fwReceiving) {
    fwReceiving = false;
    Update.abort();
  }
  setOtaStatus("FWERR:" + reason, false);
}

class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      deviceConnected = true;
    };
    void onDisconnect(BLEServer* pServer) {
      deviceConnected = false;
      if (drainPhase != DRAIN_OFF) {
        // A deliberate, time-capped air-down keeps running through a
        // dropped connection — don't release its valves here.
        if (fwReceiving) {
          fwReceiving = false;
          Update.abort();
        }
        return;
      }
      setValve(TANK_DUMP_PIN, false); // never leave the dump latched
      if (driveMode == MODE_TOW) {
        // Safety stop on disconnect — manual control needs a live phone.
        // DAILY maintenance is autonomous and keeps running.
        commandReceived = false;
        stopAllSolenoids();
        targetLeftPsi = 0;
        targetRightPsi = 0;
        leftState = IDLE;
        rightState = IDLE;
      }
      if (fwReceiving) {
        fwReceiving = false;
        Update.abort();
        Serial.println("FW transfer aborted: BLE disconnected");
      }
    }
};

class MyCmdCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      String rxValue = pCharacteristic->getValue(); // Now officially String for > 3.0.0

      // Expected format: SET:80:85  (Left:Right); "-" leaves that side
      // untouched (per-side set), e.g. SET:80:- or SET:-:85
      if (rxValue.startsWith("SET:")) {
        if (drainPhase != DRAIN_OFF) {
          setOtaStatus("Air-down in progress — stop it first.", false);
          return;
        }
        if (driveMode == MODE_DAILY) {
          setOtaStatus("In Daily mode — switch to Tow for manual control.", false);
          return;
        }
        int firstColon = rxValue.indexOf(':');
        int secondColon = rxValue.indexOf(':', firstColon + 1);

        if (firstColon != -1 && secondColon != -1) {
          String leftStr = rxValue.substring(firstColon + 1, secondColon);
          String rightStr = rxValue.substring(secondColon + 1);

          commandReceived = true; // NOW activate the control loop

          if (leftStr != "-") {
            targetLeftPsi = leftStr.toInt();
            if (leftPsi >= 0) {
              if (targetLeftPsi > leftPsi) leftState = FILLING;
              else if (targetLeftPsi < leftPsi) leftState = DEFLATING;
              else leftState = IDLE;
            } else {
              leftState = IDLE;
            }
          }

          if (rightStr != "-") {
            targetRightPsi = rightStr.toInt();
            if (rightPsi >= 0) {
              if (targetRightPsi > rightPsi) rightState = FILLING;
              else if (targetRightPsi < rightPsi) rightState = DEFLATING;
              else rightState = IDLE;
            } else {
              rightState = IDLE;
            }
          }

          Serial.print("New targets - Left: ");
          Serial.print(targetLeftPsi);
          Serial.print(" Right: ");
          Serial.println(targetRightPsi);
        }
      } else if (rxValue == "MODE:TOW") {
        setDriveMode(MODE_TOW);
      } else if (rxValue == "MODE:DAILY") {
        setDriveMode(MODE_DAILY);
      } else if (rxValue.startsWith("DTGT:")) {
        int t = rxValue.substring(5).toInt();
        if (t < DAILY_MIN_PSI) t = DAILY_MIN_PSI;
        if (t > 50) t = 50;
        dailyTargetPsi = t;
        prefs.begin("airsus", false);
        prefs.putInt("dtgt", t);
        prefs.end();
        modeStatusValue = ""; // force republish with the new target
        if (driveMode == MODE_DAILY) serviceDailyMode();
        else publishModeStatus("T");
        Serial.print("Daily target set to ");
        Serial.println(t);
      } else if (rxValue == "DUMP:1") {
        dumpStartMs = millis();
        setValve(TANK_DUMP_PIN, true);
        Serial.println("Dumping tank...");
      } else if (rxValue == "DUMP:0") {
        setValve(TANK_DUMP_PIN, false);
        if (dumpStartMs > 0) {
          logEvent("DUMP:" + String((millis() - dumpStartMs) / 1000));
          dumpStartMs = 0;
        }
        Serial.println("Stopped dumping tank.");
      } else if (rxValue == "DRAIN:1") {
        if (drainPhase == DRAIN_OFF) startDrain();
      } else if (rxValue == "DRAIN:0") {
        if (drainPhase != DRAIN_OFF) endDrain("stopped");
      } else if (rxValue == "STATS") {
        saveValveCounters();
        String s = "STATS:Lin=" + String(valveCount[0]) + ",Lout=" + String(valveCount[1]) +
                   ",Rin=" + String(valveCount[2]) + ",Rout=" + String(valveCount[3]) +
                   ",Dump=" + String(valveCount[4]);
        setOtaStatus(s, false);
      } else if (rxValue == "INFO") {
        // Device internals for the diagnostics report: uptime, clock state,
        // buffered rows/events, log file sizes, free heap
        size_t histSz = 0, evSz = 0;
        File f1 = LittleFS.open("/history.csv", FILE_READ);
        if (f1) { histSz = f1.size(); f1.close(); }
        File f2 = LittleFS.open("/events.csv", FILE_READ);
        if (f2) { evSz = f2.size(); f2.close(); }
        char buf[160];
        snprintf(buf, sizeof(buf), "INFO:up=%lus,clock=%d,pendRows=%d,pendEv=%d,hist=%uB,ev=%uB,heap=%u",
                 millis() / 1000, timeSet ? 1 : 0, pendingRowCount, pendingEventCount,
                 (unsigned)histSz, (unsigned)evSz, (unsigned)ESP.getFreeHeap());
        setOtaStatus(String(buf), false);
      } else if (rxValue.startsWith("WIFI:")) {
        // Format: WIFI:<ssid>\n<password>  (newline separator — not valid in either field)
        String payload = rxValue.substring(5);
        int sep = payload.indexOf('\n');
        if (sep > 0) {
          wifiSsid = payload.substring(0, sep);
          wifiPass = payload.substring(sep + 1);
          prefs.begin("airsus", false);
          prefs.putString("ssid", wifiSsid);
          prefs.putString("pass", wifiPass);
          prefs.end();
          setOtaStatus("Wi-Fi saved: " + wifiSsid, false);
        } else {
          setOtaStatus("Invalid Wi-Fi setup format.", false);
        }
      } else if (rxValue.startsWith("FWBEGIN:")) {
        // Format: FWBEGIN:<size>:<md5hex>
        int c1 = rxValue.indexOf(':');
        int c2 = rxValue.indexOf(':', c1 + 1);
        if (c2 == -1) {
          setOtaStatus("FWERR:bad begin format", false);
          return;
        }
        size_t size = (size_t) rxValue.substring(c1 + 1, c2).toInt();
        String md5 = rxValue.substring(c2 + 1);
        if (size == 0 || md5.length() != 32) {
          setOtaStatus("FWERR:bad size or md5", false);
          return;
        }
        commandReceived = false;
        drainPhase = DRAIN_OFF; // valves shut just below
        stopAllSolenoids();
        leftState = IDLE;
        rightState = IDLE;
        resetDailyState();
        if (!Update.begin(size)) {
          setOtaStatus(String("FWERR:begin failed: ") + Update.errorString(), false);
          return;
        }
        Update.setMD5(md5.c_str());
        fwExpectedSize = size;
        fwReceived = 0;
        fwChunkCount = 0;
        fwLastChunkTime = millis();
        fwReceiving = true;
        Serial.printf("FW transfer started: %u bytes, md5 %s\n", (unsigned)size, md5.c_str());
        setOtaStatus("FWREADY", false);
      } else if (rxValue == "FWEND") {
        if (!fwReceiving) {
          setOtaStatus("FWERR:no transfer in progress", false);
          return;
        }
        fwReceiving = false;
        if (fwReceived != fwExpectedSize) {
          Update.abort();
          setOtaStatus("FWERR:size mismatch, got " + String(fwReceived) + " of " + String(fwExpectedSize), false);
          return;
        }
        if (!Update.end(true)) { // verifies MD5
          setOtaStatus(String("Update failed: ") + Update.errorString(), true);
          return;
        }
        Serial.println("Update flashed OK. Rebooting...");
        setOtaStatus("Firmware update installed successfully.", true);
        pCharOtaStatus->setValue("FWOK");
        pCharOtaStatus->notify();
        delay(1200); // let the notify get out
        ESP.restart();
      } else if (rxValue == "FWABORT") {
        abortFwTransfer("aborted by app");
      } else if (rxValue == "OTA:1") {
        // Rescue path: join Wi-Fi and open the Arduino IDE network port
        if (fwReceiving) {
          abortFwTransfer("superseded by rescue mode");
        }
        if (wifiSsid.length() == 0) {
          setOtaStatus("No Wi-Fi credentials saved. Use Wi-Fi Setup in the app first.", false);
          return;
        }
        Serial.println("IDE rescue mode requested. Connecting to Wi-Fi...");
        otaMode = true;
        otaWifiConnected = false;
        otaUpdateStarted = false;
        otaStartTime = millis();
        commandReceived = false;
        drainPhase = DRAIN_OFF;
        stopAllSolenoids();

        // Connect to WiFi
        WiFi.mode(WIFI_STA);
        WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
      }
    }
};

class MyFwDataCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      if (!fwReceiving) return;

      // Raw binary chunk — must use getData/getLength (firmware bytes contain NULs)
      uint8_t* data = pCharacteristic->getData();
      size_t len = pCharacteristic->getLength();
      if (len == 0) return;

      if (Update.write(data, len) != len) {
        abortFwTransfer(String("flash write failed: ") + Update.errorString());
        return;
      }
      fwReceived += len;
      fwChunkCount++;
      fwLastChunkTime = millis();

      // Credit-based flow control: the app waits for this before sending more
      if (fwChunkCount % FW_ACK_EVERY == 0) {
        String ack = "FWACK:" + String(fwReceived);
        pCharOtaStatus->setValue(ack.c_str());
        pCharOtaStatus->notify();
      }
    }
};

class MyOtaStatusCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      String rxValue = pCharacteristic->getValue();
      if (rxValue == "CLEAR") {
        pCharacteristic->setValue("");
        prefs.begin("airsus", false);
        prefs.remove("otamsg");
        prefs.end();
      }
    }
};

class MyGraphCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      String rxValue = pCharacteristic->getValue();

      if (rxValue.startsWith("TIME:")) {
         unsigned long currentEpoch = rxValue.substring(5).toInt();
         bootTimestamp = currentEpoch - (millis() / 1000);
         timeSet = true;
         // Mirror into the system clock: the RTC keeps it ticking through
         // software reboots (firmware updates, crashes), so the clock is
         // already synced when we come back up — only a power cut loses it.
         struct timeval tv = { (time_t)currentEpoch, 0 };
         settimeofday(&tv, NULL);
         flushPendingEvents(); // boot/reset events get their real epochs now
         flushPendingRows();   // here (BLE task) — same task as GET, so the
                               // two flush sites can never run concurrently
         Serial.print("Time set! Boot epoch: ");
         Serial.println(bootTimestamp);
      }
      else if (rxValue.startsWith("GET") && !rxValue.startsWith("GETEV")) {
         flushPendingRows(); // make buffered rows part of this sync
         graphSinceEpoch = 0;
         if (rxValue.startsWith("GET:")) {
           graphSinceEpoch = strtoul(rxValue.c_str() + 4, NULL, 10);
         }
         Serial.print("App requested graph data since ");
         Serial.println(graphSinceEpoch);
         graphPendingLine = "";
         isStreamingGraph = true;
         streamingFile = LittleFS.open("/history.csv", FILE_READ);
      }
      else if (rxValue.startsWith("GETEV")) {
         graphSinceEpoch = 0;
         if (rxValue.startsWith("GETEV:")) {
           graphSinceEpoch = strtoul(rxValue.c_str() + 6, NULL, 10);
         }
         graphPendingLine = "";
         isStreamingGraph = true;
         streamingFile = LittleFS.open("/events.csv", FILE_READ);
      }
      else if (rxValue.startsWith("CLEAR")) {
         LittleFS.remove("/history.csv");
         Serial.println("Cleared history");
      }
    }
};

void setup() {
  Serial.begin(115200);

  // Set pins to OFF state before making them outputs to avoid relay chatter
  setValve(LEFT_AIR_IN_PIN, false);
  setValve(LEFT_AIR_OUT_PIN, false);
  setValve(RIGHT_AIR_IN_PIN, false);
  setValve(RIGHT_AIR_OUT_PIN, false);
  setValve(TANK_DUMP_PIN, false);

  // Initialize Pins
  pinMode(LEFT_AIR_IN_PIN, OUTPUT);
  pinMode(LEFT_AIR_OUT_PIN, OUTPUT);
  pinMode(RIGHT_AIR_IN_PIN, OUTPUT);
  pinMode(RIGHT_AIR_OUT_PIN, OUTPUT);
  pinMode(TANK_DUMP_PIN, OUTPUT);

  stopAllSolenoids();

  if(!LittleFS.begin(true)){
    Serial.println("LittleFS Mount Failed");
  } else {
    Serial.println("LittleFS Mounted Successfully");
  }

  loadWifiCredentials();

  // Lifetime valve actuation counters
  prefs.begin("airsus", true);
  for (int i = 0; i < 5; i++) {
    char key[4] = {'c', (char)('0' + i), 0, 0};
    valveCount[i] = prefs.getUInt(key, 0);
  }
  prefs.end();

  // The RTC keeps time through software resets — if it holds a plausible
  // value, the clock from before the reboot carries straight over and
  // logging never skips a beat. Only a power cut clears it.
  time_t rtcNow = time(NULL);
  if (rtcNow > 1735689600) { // after Jan 1 2025 = RTC survived the reboot
    bootTimestamp = (unsigned long)rtcNow - (millis() / 1000);
    timeSet = true;
    Serial.print("Clock restored from RTC: ");
    Serial.println((unsigned long)rtcNow);
  }

  // Recorded with its true epoch once the clock is known
  logEvent(String("BOOT:") + resetReasonStr() + ":v" FW_VERSION);

  BLEDevice::init("Air Bags");
  BLEDevice::setMTU(517); // large MTU speeds up BLE firmware transfer

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());
  BLEService *pService = pServer->createService(SERVICE_UUID);

  // Left PSI TX
  pCharLeft = pService->createCharacteristic(CHAR_LEFT_PSI_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
  pCharLeft->addDescriptor(new BLE2902());

  // Right PSI TX
  pCharRight = pService->createCharacteristic(CHAR_RIGHT_PSI_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
  pCharRight->addDescriptor(new BLE2902());

  // Tank PSI TX
  pCharTank = pService->createCharacteristic(CHAR_TANK_PSI_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);
  pCharTank->addDescriptor(new BLE2902());

  // Command RX
  pCharCmd = pService->createCharacteristic(CHAR_CMD_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  pCharCmd->setCallbacks(new MyCmdCallbacks());

  // Graph Data
  pCharGraph = pService->createCharacteristic(CHAR_GRAPH_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_WRITE);
  pCharGraph->addDescriptor(new BLE2902());
  pCharGraph->setCallbacks(new MyGraphCallbacks());

  // OTA Status (notify carries FWREADY/FWACK/FWOK/FWERR + human-readable messages)
  pCharOtaStatus = pService->createCharacteristic(CHAR_OTA_STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_NOTIFY);
  pCharOtaStatus->addDescriptor(new BLE2902());
  pCharOtaStatus->setCallbacks(new MyOtaStatusCallbacks());

  // Surface any status persisted from before the last reboot
  prefs.begin("airsus", true);
  String storedMsg = prefs.getString("otamsg", "");
  prefs.end();
  pCharOtaStatus->setValue(storedMsg.c_str());

  // Firmware Version
  pCharVersion = pService->createCharacteristic(CHAR_VERSION_UUID, BLECharacteristic::PROPERTY_READ);
  pCharVersion->setValue(FW_VERSION);

  // Firmware binary chunks (write-without-response for throughput)
  pCharFwData = pService->createCharacteristic(CHAR_FW_DATA_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  pCharFwData->setCallbacks(new MyFwDataCallbacks());

  // Drive mode + DAILY status ("T" or "D:<OK|FILL|DEFL|LOWTANK|LOWBAGS>:<target>")
  pCharMode = pService->createCharacteristic(CHAR_MODE_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  pCharMode->addDescriptor(new BLE2902());
  modeStatusValue = (driveMode == MODE_DAILY) ? ("D:OK:" + String(dailyTargetPsi)) : String("T");
  pCharMode->setValue(modeStatusValue.c_str());

  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(false);
  pAdvertising->setMinPreferred(0x0);
  BLEDevice::startAdvertising();
  Serial.println("Firmware v" FW_VERSION " — waiting for a client connection...");
}

unsigned long lastSensorUpdate = 0;
unsigned long lastControlUpdate = 0;

void loop() {
  if (otaMode) {
    if (!otaWifiConnected) {
      if (WiFi.status() == WL_CONNECTED) {
        Serial.println("Wi-Fi Connected! Starting ArduinoOTA rescue port...");
        otaWifiConnected = true;
        otaConnectedTime = millis();

        ArduinoOTA.onStart([]() {
          String type;
          if (ArduinoOTA.getCommand() == U_FLASH) {
            type = "sketch";
          } else { // U_FS
            type = "filesystem";
          }
          Serial.println("Start updating " + type);
          otaUpdateStarted = true;
        });

        ArduinoOTA.onEnd([]() {
          Serial.println("\nEnd");
        });

        ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
          Serial.printf("Progress: %u%%\r", (progress / (total / 100)));
        });

        ArduinoOTA.onError([](ota_error_t error) {
          Serial.printf("Error[%u]: ", error);
        });

        ArduinoOTA.begin();
        setOtaStatus("IDE rescue port open on " + WiFi.localIP().toString() + " for 5 minutes.", false);
      } else if (millis() - otaStartTime > 20000) { // 20s timeout
        Serial.println("OTA Wi-Fi Timeout. Rebooting to normal mode.");
        setOtaStatus("Couldn't connect to Wi-Fi \"" + wifiSsid + "\" for rescue mode.", true);
        delay(1000);
        ESP.restart();
      }
    } else {
      ArduinoOTA.handle();

      // 5 min rescue window, then reboot back to normal mode
      if (!otaUpdateStarted && (millis() - otaConnectedTime > 300000)) {
         Serial.println("Rescue window closed. Rebooting to normal mode.");
         setOtaStatus("IDE rescue window closed without an upload.", true);
         delay(200);
         ESP.restart();
      }
    }
    return; // Skip normal air suspension loop while in OTA mode
  }

  // BLE firmware transfer stall watchdog
  if (fwReceiving && millis() - fwLastChunkTime > 30000) {
    abortFwTransfer("transfer stalled (no data for 30s)");
  }

  // --- 1. SENSOR READING & NOTIFICATION ---
  // Runs whether or not a phone is connected: DAILY maintenance needs
  // live readings on its own. Notifies only reach a connected client.
  // While a daily valve is open, sample and service at 10Hz — at 1Hz a
  // fill from a full tank overshoots the target by several PSI before
  // the valve can close (seen in the field: 8 -> 13-14 with target 10).
  if (!fwReceiving) {
    bool dailyValveActive = dailyFillingL || dailyFillingR || dailyDeflatingL || dailyDeflatingR;
    // Pending-row flushing happens in the BLE task (TIME and GET handlers),
    // never here — a loop-task flush could race the BLE-task one.
    if (millis() - lastSensorUpdate > (dailyValveActive ? 100UL : 500UL)) {
      lastSensorUpdate = millis();

      // LEFT SENSOR on Pin 34 (ADC1)
      int rawAdc = analogRead(LEFT_SENSOR_PIN);
      float voltage = rawAdc * (3.3 / 4095.0);

      // Debug output - check Serial Monitor at 115200 baud
      Serial.print("Raw ADC: ");
      Serial.print(rawAdc);
      Serial.print("  Voltage: ");
      Serial.print(voltage, 3);

      char lStr[10];
      // If voltage is below 0.15V, sensor is probably not connected
      if (voltage < 0.15) {
        sprintf(lStr, "---");
        leftPsi = -1; // flag as disconnected
        Serial.println("  PSI: --- (no sensor)");
      } else {
        // Clamp to valid sensor range
        if (voltage < 0.34) voltage = 0.34;
        if (voltage > 3.09) voltage = 3.09;
        // Map 0.34V-3.09V to 0-150 PSI (10k/22k divider)
        leftPsi = (int)((voltage - 0.34) * (150.0 / (3.09 - 0.34)));
        sprintf(lStr, "%d", leftPsi);
        Serial.print("V  PSI: ");
        Serial.println(leftPsi);
      }
      pCharLeft->setValue((uint8_t*)lStr, strlen(lStr));
      if (deviceConnected) pCharLeft->notify();

      // RIGHT SENSOR on Pin 35 (ADC1)
      int rawAdcR = analogRead(RIGHT_SENSOR_PIN);
      float voltageR = rawAdcR * (3.3 / 4095.0);
      char rStr[10];
      if (voltageR < 0.15) {
        sprintf(rStr, "---");
        rightPsi = -1;
      } else {
        if (voltageR < 0.34) voltageR = 0.34;
        if (voltageR > 3.09) voltageR = 3.09;
        rightPsi = (int)((voltageR - 0.34) * (150.0 / (3.09 - 0.34)));
        sprintf(rStr, "%d", rightPsi);
      }
      pCharRight->setValue((uint8_t*)rStr, strlen(rStr));
      if (deviceConnected) pCharRight->notify();

      // TANK SENSOR on Pin 32 (ADC1)
      int rawAdcT = analogRead(TANK_SENSOR_PIN);
      float voltageT = rawAdcT * (3.3 / 4095.0);
      char tStr[10];
      if (voltageT < 0.15) {
        sprintf(tStr, "---");
        tankPsi = -1;
      } else {
        if (voltageT < 0.34) voltageT = 0.34;
        if (voltageT > 3.09) voltageT = 3.09;
        tankPsi = (int)((voltageT - 0.34) * (150.0 / (3.09 - 0.34)));
        sprintf(tStr, "%d", tankPsi);
      }
      pCharTank->setValue((uint8_t*)tStr, strlen(tStr));
      if (deviceConnected) pCharTank->notify();
    }

    // --- 2pre. FULL AIR-DOWN SEQUENCE (bags, then tank) ---
    if (drainPhase != DRAIN_OFF && millis() - lastDrainCheck > 1000) {
      lastDrainCheck = millis();
      if (drainPhase == DRAIN_BAGS) {
        bool bagsEmpty = (leftPsi < 0 || leftPsi <= DRAIN_DONE_PSI) &&
                         (rightPsi < 0 || rightPsi <= DRAIN_DONE_PSI);
        if (bagsEmpty || millis() - drainPhaseMs > DRAIN_BAGS_MAX_MS) {
          // No dump valve exists — bleed the tank through one bag circuit
          setValve(LEFT_AIR_OUT_PIN, false);
          setValve(RIGHT_AIR_OUT_PIN, false);
          delay(300);
          drainPhase = DRAIN_TANK;
          drainPhaseMs = millis();
          drainSideRight = false;
          drainSwapMs = millis();
          drainOpenSide(drainSideRight);
          setOtaStatus("DRAIN:TANK", false);
        }
      } else { // DRAIN_TANK: pass-through bleed, alternating sides
        bool tankEmpty = (tankPsi >= 0) && tankPsi <= DRAIN_DONE_PSI;
        if (tankEmpty) {
          endDrain("complete");
        } else if (millis() - drainPhaseMs > DRAIN_TANK_MAX_MS) {
          endDrain("timed out");
        } else if (millis() - drainSwapMs > DRAIN_SWAP_MS) {
          drainCloseSide(drainSideRight);
          delay(300);
          drainSideRight = !drainSideRight;
          drainOpenSide(drainSideRight);
          drainSwapMs = millis();
        }
      }
    }

    // --- 2a. DAILY MODE MAINTENANCE (1s idle, 100ms while valves open) ---
    if (driveMode == MODE_DAILY && drainPhase == DRAIN_OFF &&
        millis() - lastDailyCheck > (dailyValveActive ? 100UL : 1000UL)) {
      lastDailyCheck = millis();
      serviceDailyMode();
    }

    // --- 2b. TOW CONTROL LOOP (50ms) - only when connected, after SET ---
    if (driveMode == MODE_TOW && deviceConnected && commandReceived && millis() - lastControlUpdate > 50) {
      lastControlUpdate = millis();

      // LEFT SIDE LOGIC (only if sensor is connected)
      if (leftPsi >= 0 && leftState != IDLE) {
        if (leftState == FILLING) {
          if (leftPsi >= targetLeftPsi) {
            leftState = IDLE;
            setValve(LEFT_AIR_IN_PIN, false);
            setValve(LEFT_AIR_OUT_PIN, false);
          } else {
            setValve(LEFT_AIR_IN_PIN, true);
            setValve(LEFT_AIR_OUT_PIN, false);
          }
        } else if (leftState == DEFLATING) {
          if (leftPsi <= targetLeftPsi) {
            leftState = IDLE;
            setValve(LEFT_AIR_IN_PIN, false);
            setValve(LEFT_AIR_OUT_PIN, false);
          } else {
            setValve(LEFT_AIR_IN_PIN, false);
            setValve(LEFT_AIR_OUT_PIN, true);
          }
        }
      } else {
        // No sensor or target reached - ensure solenoids are off
        setValve(LEFT_AIR_IN_PIN, false);
        setValve(LEFT_AIR_OUT_PIN, false);
      }

      // RIGHT SIDE LOGIC (only if sensor is connected)
      if (rightPsi >= 0 && rightState != IDLE) {
        if (rightState == FILLING) {
          if (rightPsi >= targetRightPsi) {
            rightState = IDLE;
            setValve(RIGHT_AIR_IN_PIN, false);
            setValve(RIGHT_AIR_OUT_PIN, false);
          } else {
            setValve(RIGHT_AIR_IN_PIN, true);
            setValve(RIGHT_AIR_OUT_PIN, false);
          }
        } else if (rightState == DEFLATING) {
          if (rightPsi <= targetRightPsi) {
            rightState = IDLE;
            setValve(RIGHT_AIR_IN_PIN, false);
            setValve(RIGHT_AIR_OUT_PIN, false);
          } else {
            setValve(RIGHT_AIR_IN_PIN, false);
            setValve(RIGHT_AIR_OUT_PIN, true);
          }
        }
      } else {
        // No sensor or target reached - ensure solenoids are off
        setValve(RIGHT_AIR_IN_PIN, false);
        setValve(RIGHT_AIR_OUT_PIN, false);
      }
    }
  }

  // --- 2c. TOW STATE TRANSITION LOGGING ---
  if (driveMode == MODE_TOW) {
    if (prevLeftState == IDLE && leftState != IDLE) {
      towStartMsL = millis();
      towFromPsiL = leftPsi;
    } else if (prevLeftState != IDLE && leftState == IDLE) {
      logEvent(String(prevLeftState == FILLING ? "TFILLL:" : "TDEFLL:") +
               String((millis() - towStartMsL) / 1000) + "s:" + String(towFromPsiL) + ">" + String(leftPsi));
    }
    if (prevRightState == IDLE && rightState != IDLE) {
      towStartMsR = millis();
      towFromPsiR = rightPsi;
    } else if (prevRightState != IDLE && rightState == IDLE) {
      logEvent(String(prevRightState == FILLING ? "TFILLR:" : "TDEFLR:") +
               String((millis() - towStartMsR) / 1000) + "s:" + String(towFromPsiR) + ">" + String(rightPsi));
    }
  }
  prevLeftState = leftState;
  prevRightState = rightState;

  // Persist valve counters at most every 10 min
  if (valveCountsDirty && millis() - lastCounterSave > 600000) {
    saveValveCounters();
  }

  // Handle disconnect
  if (!deviceConnected && oldDeviceConnected) {
      delay(500);
      pServer->startAdvertising();
      Serial.println("Start advertising");
      oldDeviceConnected = deviceConnected;
  }

  if (deviceConnected && !oldDeviceConnected) {
      oldDeviceConnected = deviceConnected;
      // Initialize targets to 0 when newly connected
      targetLeftPsi = 0;
      targetRightPsi = 0;
      leftState = IDLE;
      rightState = IDLE;
  }

  // --- 3. GRAPH STREAMING (line-based so rows can be filtered by epoch) ---
  if (isStreamingGraph && !fwReceiving) {
    String pkt = graphPendingLine;
    graphPendingLine = "";
    while (streamingFile && streamingFile.available() && pkt.length() < 160) {
      String line = streamingFile.readStringUntil('\n');
      line.trim();
      if (line.length() == 0) continue;
      if (strtoul(line.c_str(), NULL, 10) <= graphSinceEpoch) continue;
      line += "\n";
      if (pkt.length() + line.length() > 190) {
        graphPendingLine = line; // doesn't fit — goes in the next packet
        break;
      }
      pkt += line;
    }

    if (pkt.length() > 0) {
      pCharGraph->setValue((uint8_t*)pkt.c_str(), pkt.length());
      pCharGraph->notify();
      delay(20);
    } else {
      isStreamingGraph = false;
      if (streamingFile) streamingFile.close();
      pCharGraph->setValue("END");
      pCharGraph->notify();
      Serial.println("Finished streaming graph data.");
    }
  }

  // --- 4. DATA LOGGING (Every 60s; buffered in RAM until the clock is known) ---
  if (!fwReceiving && millis() - lastLogUpdate > 60000) {
    lastLogUpdate = millis();

    // In DAILY the meaningful "set" value is the hold target, not the
    // zeroed tow targets
    int setL = (driveMode == MODE_DAILY) ? dailyTargetPsi : targetLeftPsi;
    int setR = (driveMode == MODE_DAILY) ? dailyTargetPsi : targetRightPsi;

    if (!timeSet) {
      // No clock yet — ring-buffer the row, back-stamped at next TIME sync
      pendingRows[pendingRowHead] = {
        (uint32_t)millis(),
        (int16_t)(leftPsi >= 0 ? leftPsi : 0),
        (int16_t)(rightPsi >= 0 ? rightPsi : 0),
        (int16_t)(tankPsi >= 0 ? tankPsi : 0),
        (int16_t)setL, (int16_t)setR
      };
      pendingRowHead = (pendingRowHead + 1) % PENDING_ROWS_MAX;
      if (pendingRowCount < PENDING_ROWS_MAX) pendingRowCount++;
    } else {
      unsigned long currentEpoch = bootTimestamp + (millis() / 1000);

      // Rolling buffer: the app archives on every connect, so once the file
      // gets big just start fresh instead of filling LittleFS.
      // Also check the last byte: a power cut mid-write leaves a partial row
      // with no newline, and appending onto it would glue two rows together
      // into a corrupt timestamp.
      bool needsNewline = false;
      if (!isStreamingGraph) {
        File check = LittleFS.open("/history.csv", FILE_READ);
        if (check) {
          size_t sz = check.size();
          if (sz > 0) {
            check.seek(sz - 1);
            needsNewline = (check.read() != '\n');
          }
          check.close();
          if (sz > HISTORY_MAX_BYTES) {
            LittleFS.remove("/history.csv");
            needsNewline = false;
            Serial.println("History buffer full — starting a fresh file.");
          }
        }
      }

      File file = LittleFS.open("/history.csv", FILE_APPEND);
      if (file && needsNewline) file.print("\n");
      if (file) {
          char logStr[80];
          sprintf(logStr, "%lu,%d,%d,%d,%d,%d\n", currentEpoch,
                  leftPsi >= 0 ? leftPsi : 0,
                  rightPsi >= 0 ? rightPsi : 0,
                  tankPsi >= 0 ? tankPsi : 0,
                  setL,
                  setR);
          file.print(logStr);
          file.close();
          Serial.print("Logged: ");
          Serial.print(logStr);
      }
    }
  }
}
