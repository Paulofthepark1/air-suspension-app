# Air Bag Controller App and ESP32 Logic

We will build an Air Suspension controller frontend taking advantage of the **Web Bluetooth API** and build robust C++ code for your **ESP32 BLE Server**.

Since you want to easily load this wirelessly on your Android phone, Web Bluetooth makes it incredibly easy. You can run the app locally on your computer, navigate to the local IP on your phone's Chrome browser, and control the ESP32 without needing to compile or install any APKs. 

## Proposed Architecture

1. **Frontend (Vite + Web Bluetooth API)**: 
   - A responsive web app tailored for mobile screens using pure HTML/JS/CSS to mimic the premium UI from your screenshot.
   - We will use `@vitejs/plugin-basic-ssl` so you can connect to your local development server from your phone over `https://` (which is strictly required by the Web Bluetooth API).
   - This prevents you from having to mess with Expo custom dev clients or Android Studio setups.

2. **Backend (ESP32 C++)**:
   - We will update your ESP32 Arduino sketch. I noticed a bug in your provided code (`message` was commented out but still referenced, which breaks compilation).
   - We'll restructure the BLE setup to fit dual air suspensions.
   
### BLE Service Map
- **Air Suspension Service UUID**: `4fafc201-1fb5-459e-8fcc-c5c9c331914b`
  - **Left PSI Characteristic (Notify/Read)**: Real-time PSI telemetry for the left side.
  - **Right PSI Characteristic (Notify/Read)**: Real-time PSI telemetry for the right side.
  - **Command Characteristic (Write)**: Accepts string/byte commands like `L+`, `L-`, `R+`, `R-` for Up/Down, and `L0`/`R0` for Stop.

## UI / Web App Design
- **Premium Aesthetics**: We will use a sleek, dynamic dark-mode user interface.
- Red directional up/down arrows that trigger `mousedown`/`touchstart` (start command) and `mouseup`/`touchend` (stop command) to safely adjust the air pressure.
- We will include a central connection/status button and a gear icon for future settings exactly like your screenshot.

## Proposed Changes

### Frontend Code (Static Kuiper Playground)

#### [NEW] `index.html`
- The main mobile-responsive layout.

#### [NEW] `index.css`
- Modern, glassmorphism-styled CSS with vibrant red interactive arrows. 

#### [NEW] `main.js`
- Handles the Web Bluetooth API connection (`navigator.bluetooth.requestDevice`).
- Handles the `touchstart` and `touchend` events to send control signals to the Command Characteristic.
- Subscribes to Notify events to update the Left and Right PSI readings dynamically on screen.

#### [NEW] `package.json` / `vite.config.js`
- Setup for Vite dev server with explicit basic-ssl plugin to ensure Web Bluetooth permissions work seamlessly over local wifi.

---
### ESP32 Target Update

#### [NEW] `ESP32_Air_Suspension.ino` (or `.cpp`)
- A completely revised and bug-free version of your snippet.
- Includes dummy simulation for PSI reading logic so you can immediately see numbers fluctuate in the app during your test.
- Includes control logic to listen for the Up/Down commands from the mobile app and change state.

## Open Questions
> [!IMPORTANT]
> 1. **Framework Confirmation:** Are you okay with using a pure Web App (HTML, JS, CSS served via Vite) instead of MIT App Inventor/Android Studio? It is the fastest way to get wireless deployment on an Android device!
> 2. **Controls Execution:** Typically, for air suspensions, you press and hold the UP arrow to open the air valve, and release to close it. Is that how you want the controls to behave?
> 3. Do you have actual PSI sensors already integrated with the ESP32 (e.g., analog sensors on specific pins), or should I leave placeholders for you to drop your analog read code into?

## Verification Plan

### Automated Tests
- Run `npm run dev --host`, ensuring it broadcasts the local IP securely with SSL.

### Manual Verification
- You will open the resulting URL on your Android phone's Google Chrome browser.
- Run the provided ESP32 sketch on your dev board.
- Tap the "Connect" button in the web app, pair the "AIR-SUSPENSION" device on your phone, and test the hold-to-adjust arrows.
