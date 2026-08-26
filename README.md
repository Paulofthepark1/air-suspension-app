# Air Suspension Controller

ESP32-S3 air suspension controller with a Web Bluetooth PWA frontend.

- **`index.html` / `app.js` / `style.css`** — the phone app (Chrome, Web Bluetooth)
- **`ESP32_Air_Suspension.ino`** — the controller firmware
- **`Hardware_Specs.md`** — wiring and pinout reference

## How firmware updates work

Every merge to `main` that touches the sketch triggers the **Build Firmware**
GitHub Action, which compiles it with `arduino-cli` for the ESP32-S3 and
publishes `firmware.bin` to a GitHub Release tagged with the sketch's
`FW_VERSION`.

The app reads the installed firmware version over BLE and checks GitHub for
the latest release. When a newer version exists, the **UPDATE FIRMWARE**
button lights up. Tapping it sends `OTA:1`; the ESP32 joins Wi-Fi, downloads
the latest `firmware.bin` from GitHub Releases over HTTPS, flashes itself,
and reboots. Progress streams back over the BLE status characteristic.

If the download fails, the device keeps an ArduinoOTA (IDE network port)
rescue window open for 5 minutes before rebooting back to normal mode, and
the error message is shown in the app on the next connect.

### Wi-Fi credentials

Credentials are **not** stored in this repo. Use the **WI-FI SETUP** button
in the app (while connected over Bluetooth) to save them into the ESP32's
flash. They're only used during firmware updates.

### Releasing a new firmware version

1. Edit `ESP32_Air_Suspension.ino` and bump `FW_VERSION`.
2. Merge to `main`.
3. CI builds and publishes the release; the app offers the update on the
   next connect.

### BLE command reference

| Command | Effect |
|---|---|
| `SET:<left>:<right>` | Set target PSI and start the control loop |
| `DUMP:1` / `DUMP:0` | Open/close the tank dump valve |
| `WIFI:<ssid>\n<pass>` | Save Wi-Fi credentials to flash |
| `OTA:1` | Join Wi-Fi and self-update from GitHub Releases |
