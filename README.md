# Air Suspension Controller

ESP32-S3 air suspension controller with a Web Bluetooth PWA frontend.

- **`index.html` / `app.js` / `style.css`** — the phone app (Chrome, Web Bluetooth)
- **`ESP32_Air_Suspension.ino`** — the controller firmware
- **`Hardware_Specs.md`** — wiring and pinout reference

## How firmware updates work

Every merge to `main` that touches the sketch triggers the **Build Firmware**
GitHub Action, which compiles it with `arduino-cli` for the ESP32-S3 and
publishes `firmware.bin` + `version.json` (size, MD5) to the orphan
`firmware` branch, plus a versioned GitHub Release for history.

The app reads the installed firmware version over BLE and fetches
`version.json` from the `firmware` branch. When a newer version exists, the
**UPDATE FIRMWARE** button lights up. Tapping it:

1. The **phone** downloads `firmware.bin` (so the truck needs no Wi-Fi —
   cellular works).
2. The app streams it to the ESP32 **over Bluetooth** in 200-byte chunks
   with an ack every 64 chunks (`FWBEGIN:<size>:<md5>` → `FWREADY` →
   chunks → `FWACK:<n>` → `FWEND` → `FWOK`).
3. The ESP32 writes it to the spare OTA slot, verifies size and MD5, and
   only then reboots into it. A failed or interrupted transfer aborts
   harmlessly — the running firmware is untouched.

The outcome message is persisted across the reboot and shown in the app on
the next connect.

### Rescue path

If a bad firmware ever makes BLE updates impossible, the Wi-Fi Setup modal
has **OPEN IDE RESCUE PORT**: the controller joins Wi-Fi (credentials saved
in its flash via the app — they are not in this repo) and exposes the
classic ArduinoOTA network port for 5 minutes, so a fix can be pushed from
the Arduino IDE.

### Releasing a new firmware version

1. Edit `ESP32_Air_Suspension.ino` and bump `FW_VERSION`.
2. Merge to `main`.
3. CI builds and publishes; the app offers the update on the next connect.

CI fails the build if the binary exceeds the 1280KB OTA app slot of the
default 4MB partition scheme.

## Drive modes (fw ≥ 2.1.0)

- **TOW** — manual control: set left/right pressures with SET (original
  behavior). Solenoids stop on BLE disconnect.
- **DAILY** — the controller autonomously holds both bags at a target
  (default 10 PSI, adjustable 5–30 in the app) with or without a phone
  connected, persisting across reboots. Refills at target−2 or below the
  5 PSI floor, deflates above target+3, and only opens a fill valve when
  the tank is at least 3 PSI above the target. Fill attempts are capped
  at 30s with a 45s cooldown so a burst line can't drain the tank. From
  fw 2.3.5 the pressure must stay out of band for 5s before a valve
  opens and the lines get 10s to settle after one closes — road-bump
  transients no longer trigger the valves while driving. Status
  is published on the mode characteristic (`D:<OK|FILL|DEFL|LOWTANK|LOWBAGS>:<target>`);
  the app shows warnings and raises a system notification when the tank
  is too low to fill (compressor off) or bags drop under 5 PSI unfillable.

### BLE command reference

| Command | Effect |
|---|---|
| `SET:<left>:<right>` | Set target PSI and start the control loop; `-` for either side leaves it untouched (per-side set, fw ≥ 2.0.1) |
| `DUMP:1` / `DUMP:0` | Open/close the tank dump relay (no dump valve is currently plumbed — command kept for future hardware; not exposed in the app) |
| `WIFI:<ssid>\n<pass>` | Save Wi-Fi credentials to flash (rescue mode only) |
| `FWBEGIN:<size>:<md5>` / chunks / `FWEND` / `FWABORT` | BLE firmware update |
| `OTA:1` | Rescue mode: join Wi-Fi, open ArduinoOTA IDE port for 5 min |
| `MODE:TOW` / `MODE:DAILY` | Switch drive mode (persisted) |
| `DTGT:<psi>` | Set the DAILY hold target, 5–50 (persisted) |
| `STATS` | Reply with lifetime valve actuation counters (NVS-persisted) |
| `DRAIN:1` / `DRAIN:0` | Full air-down: vent both bags, then bleed the tank through one bag circuit (in+out open) alternating sides every 30s — no dump valve exists; staggered switching, ≤2 valves energized, hard time caps; `DRAIN:0` aborts |
| `GET` / `GET:<epoch>` | (graph char) Stream history CSV; with epoch, only newer rows |
| `GETEV` / `GETEV:<epoch>` | (graph char) Stream the event log |

## Two clients + status broadcast (fw ≥ 2.4.0)

Built for the truck's dash screen (an ESP32-S3 touch panel in the cab, set up from
the house repo `Paulofthepark1/homeassistant`, `esphome/truck-led-display.yaml`).

- **Up to 3 clients at once.** Advertising restarts after each connect, so the
  phone app and the screen can both be connected; neither locks the other out.
  With one client, behaviour is unchanged. Either client dropping still stops a
  TOW adjustment in progress (fail safe — re-send SET). A firmware transfer is
  aborted at once only when no client is left; otherwise the 30 s stall
  watchdog ends a transfer whose sender disconnected.
- **Readings broadcast without a connection.** The scan response carries
  manufacturer data (company id `0xFFFF`, private use), updated on change at most
  every 2 s and refreshed every 30 s. Active scanners only. **Actually sent from fw 2.4.1**
  (2.4.0 compiled it out: it used the Bluedroid API, and the ESP32-S3 core is built with
  NimBLE). 14 bytes after the AD header:

  | Byte | Meaning |
  |---|---|
  | 0–1 | `FF FF` company id |
  | 2–3 | `'A' 'B'` magic |
  | 4 | layout version (`1`) |
  | 5, 6, 7 | left, right, tank PSI (0–150; `255` = no sensor) |
  | 8 | mode: `0` TOW, `1` DAILY |
  | 9 | DAILY status: `0` OK, `1` FILL, `2` DEFL, `3` LOWTANK, `4` LOWBAGS (`0` in TOW) |
  | 10 | DAILY target PSI |
  | 11 | flags: bit0 air-down running, bit1 TOW adjustment running, bit2 firmware transfer, bit3 a client is connected |
  | 12, 13 | TOW target left, right |

- **From fw 2.4.3 the essentials are in the main advertisement too.** A scan response
  is a request/reply exchange, and a screen at the edge of range loses most of them:
  from the truck's own dash (−88 to −97 dBm to the under-bed box) the screen heard the
  controller's name every few seconds and its readings every few minutes. The main advert is now flags + the service UUID +
  this 10-byte AD (31 bytes exactly), so every advert that arrives carries the numbers:

  | Byte | Meaning |
  |---|---|
  | 0 | AD length (`9`) |
  | 1 | `FF` manufacturer specific |
  | 2–3 | `FF FF` company id |
  | 4 | `'a'` short layout |
  | 5, 6, 7 | left, right, tank PSI (`255` = no sensor) |
  | 8 | packed: bit7 DAILY, bits4–6 DAILY status, bits0–3 flags (as above) |
  | 9 | DAILY target PSI |

  The device name moves to the scan response to make room. The app is unaffected: its
  picker also matches the service UUID, which stays in the main advert, and a saved
  device reconnects by its stored name.
- **From fw 2.4.4 BLE transmits at +20 dBm** (the S3's maximum; the default was +9).
  From the truck's dash the screen heard the controller in the under-bed box at only
  −91 to −97 dBm, so every advert, notification and connection gets 11 dB more.

## Event log (fw ≥ 2.2.0)

`/events.csv` records reboots (with `esp_reset_reason` — poweron / crash /
brownout / watchdog), mode changes, every fill/deflate with duration and
from→to PSI (daily and tow), capped fill attempts, LOWTANK/LOWBAGS
warnings, and tank dumps. From fw 2.3.3 the clock survives software
reboots (firmware updates, crashes) via the ESP32's RTC, so logging
continues with real timestamps immediately; only a power cut clears it.
Events that occur before the clock is known are buffered and written with
corrected epochs afterward. The app
syncs events incrementally after the history sync, keeps ~6 weeks, and
shows them in the **EVENT LOG** modal with a 24h summary; the valve
counters button queries `STATS`.

## Pressure history

The controller logs one CSV row per minute to LittleFS and streams it over
the graph characteristic on connect. Rows logged before the clock is known
(i.e. after a power cut, before a phone connects) are held in a 24h RAM
ring and back-stamped when the time syncs. From fw 2.1.1 the app syncs
incrementally (`GET:<last epoch>`) and keeps ~6 weeks of merged history in
localStorage as the archive; the on-device file is a rolling buffer wiped
past ~300KB. The in-app graph is a dependency-free canvas renderer:
drag to pan, pinch/scroll to zoom the time axis (the PSI axis auto-fits
the visible window), quick ranges (1H/6H/24H/7D/ALL), tap for a crosshair
readout, and legend chips to toggle series.
