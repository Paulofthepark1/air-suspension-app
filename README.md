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
  at 30s with a 45s cooldown so a burst line can't drain the tank. Status
  is published on the mode characteristic (`D:<OK|FILL|DEFL|LOWTANK|LOWBAGS>:<target>`);
  the app shows warnings and raises a system notification when the tank
  is too low to fill (compressor off) or bags drop under 5 PSI unfillable.

### BLE command reference

| Command | Effect |
|---|---|
| `SET:<left>:<right>` | Set target PSI and start the control loop; `-` for either side leaves it untouched (per-side set, fw ≥ 2.0.1) |
| `DUMP:1` / `DUMP:0` | Open/close the tank dump valve |
| `WIFI:<ssid>\n<pass>` | Save Wi-Fi credentials to flash (rescue mode only) |
| `FWBEGIN:<size>:<md5>` / chunks / `FWEND` / `FWABORT` | BLE firmware update |
| `OTA:1` | Rescue mode: join Wi-Fi, open ArduinoOTA IDE port for 5 min |
| `MODE:TOW` / `MODE:DAILY` | Switch drive mode (persisted) |
| `DTGT:<psi>` | Set the DAILY hold target, 5–50 (persisted) |
