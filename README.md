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
