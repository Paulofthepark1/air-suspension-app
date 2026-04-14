# Air Suspension Controller Built

I have fully rebuilt your Air Suspension application as a localized Web App using Javascript and the **Web Bluetooth API**, and generated a polished `C++` code block for your ESP32. I also incorporated your 10k/22k voltage divider math!

> [!CAUTION]  
> **Major Hardware Pin Conflicts Solved!** 
> 
> 1. **Relays on Pin 34/35:** As mentioned earlier, ESP32 pins 34, 35, 36, and 39 are **INPUT ONLY**. They literally lack the internal silicon circuitry to be driven `HIGH/LOW` as outputs and therefore can never trigger a relay module. 
> 2. **Sensor on Pin 4:** Pin 4 is tied to `ADC2`. On the ESP32, **`ADC2` is completely disabled at the hardware level whenever Wi-Fi or Bluetooth is active!** Trying to use `analogRead(4)` while running a BLE server will crash or return random noise.
>
> **The Solution:** We simply swapped them! 
> I moved your **Pressure Sensor to Pin 34** (which is on `ADC1` and works perfectly with BLE), and I moved your **Relay to Pin 4** (which is a standard GPIO that supports outputting `HIGH/LOW`).

## Changes Made
1. **Frontend App:** We utilized raw HTML, JS, and CSS so you don't even need a build system like Node.js. 
   - [index.html](file:///c:/Users/pauls/.gemini/antigravity/playground/static-kuiper/index.html) - Setup of the Document structure mirroring your App Inventor layout.
   - [style.css](file:///c:/Users/pauls/.gemini/antigravity/playground/static-kuiper/style.css) - Premium CSS styling featuring the dynamic dark-red interactive arrows and scaling animations that give tactile feedback when held.
   - [app.js](file:///c:/Users/pauls/.gemini/antigravity/playground/static-kuiper/app.js) - Contains all Web Bluetooth connections to connect directly to the ESP32 server from Chrome without any native app installations. It securely broadcasts commands (`L+1` for Left Up pressed, `L+0` for released) to trigger relays.
2. **ESP32 Core:**
   - [ESP32_Air_Suspension.ino](file:///c:/Users/pauls/.gemini/antigravity/playground/static-kuiper/ESP32_Air_Suspension.ino) - Handles BLE connections, advertises your specific Service/Characteristics, and reacts to the text commands. Crucially, it now dynamically reads the **`ADC1`** pin, converts it to voltage, and maps the `0.34V - 3.09V` span exactly to `0 - 150 PSI` using the math from your 10k/22k divider screenshot before broadcasting it straight to your web app!

## Testing and Execution (Wireless Android Setup)

Since this relies on the Web Bluetooth API, the easiest way to test it on your Android Phone is:
1. Open the project folder (`c:\Users\pauls\.gemini\antigravity\playground\static-kuiper`) in VS Code.
2. Install the **Live Server** extension, and click "Go Live" at the bottom right.
3. *(Alternative)* Upload the `index.html`, `style.css`, and `app.js` files directly to a free GitHub Pages repository online to use anywhere. 
4. Navigate to the generated URL on your **Android Chrome Browser**, verify Bluetooth is enabled on the device, and hit the bottom left connect button to pair the `ESP32_Air_Suspension`.
5. Flash the `.ino` code to your ESP32 through the Arduino IDE. 

Once connected, holding down an Up arrow will trigger `HIGH` on the corresponding IN pin, and the PSI on the screen will dynamically mirror your real sensor!
