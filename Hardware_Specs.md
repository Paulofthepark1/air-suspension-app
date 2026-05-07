# Air Suspension & LED Lighting Hardware Specs

This document serves as the master reference for the hardware, wiring, and pinouts for the ESP32-S3 Air Suspension project and the Dig-Uno lighting controller.

## 1. ESP32-S3 Pin Assignments (Air Suspension & Relay Control)
Using an AYWHP ESP32-S3 DevKitC Module. 
**Safe GPIOs Used:**
- `GPIO 38`: Tank Dump Solenoid
- `GPIO 39`: Right Air Out Solenoid
- `GPIO 40`: Right Air In Solenoid
- `GPIO 41`: Left Air Out Solenoid
- `GPIO 42`: Left Air In Solenoid (or LED JD1912 Relay Coil)

**Other Safe GPIOs Available:**
- Right Header: `GPIO 1`, `GPIO 2`
- Left Header: `GPIO 4`, `GPIO 5`, `GPIO 6`, `GPIO 7`

**DANGEROUS PINS (Do Not Use):**
- `GPIO 20`, `21`: Hardwired to USB D+/D-.
- `GPIO 45`: Boot strapping pin (will crash boot if altered).
- `GPIO 35`, `36`, `37`: Hardwired to PSRAM memory bus (will corrupt memory).

## 2. Dig-Uno v3.1 Pinout (LED Controller)
The Dig-Uno v3.1 handles the addressable LEDs and related triggers. 

**Current Loadout (4 Pins Used):**
- **Data 1:** LED Data out to under-glow.
- **Q1:** LED Relay Trigger (JD1912 Automotive Relay).
- **Q2:** Reverse Light Sensor.
- **Q3:** Brake/Parking Light Sensor.

**Available "Free" Pins:**
- **Q4:** Standard 3.3V GPIO (input or output).
- **Data 2 (LED 2):** Can be reassigned as general-purpose I/O in WLED.
- **Audio Header (I2S):** 3 capable GPIO pins (since microphone is not used).
- **I2C Header (SDA / SCL):** 2 GPIO pins (if no OLED screen is used).
- **A0 (Analog Pin):** Input-only (good for photoresistors or temperature sensors).
- **Button Pin (BTN):** Tied to GPIO 0 (ready for physical switch input).

## 3. Solid-State MOSFET Wiring Guide (12V Solenoids)
The air suspension valves are low-side switched using an **IRLZ44N Logic-Level N-Channel MOSFET**.

### MOSFET Pinout (Left to Right, text facing you):
1. **Gate (Left):** Trigger from ESP32.
2. **Drain (Middle):** Ground switch for load.
3. **Source (Right):** System Ground.

### Circuit Wiring (Per Valve):
- **Source (Right Pin):** Connect to Common System Ground (-).
- **Gate (Left Pin):** Connect to ESP32 Safe GPIO Pin.
- **Pull-Down Resistor (10kΩ):** Solder between Gate and Common Ground (keeps valve shut on boot).
- **Drain (Middle Pin):** Connect to Negative (-) wire of the 12V Solenoid.
- **Main Power:** Connect Positive (+) wire of Solenoid to constant 12V (+).

### Flyback Diode (1N4007) Placement:
*Critical to absorb high-voltage magnetic spikes.*
- Splice/solder the diode across the positive and negative wires ~6 inches from the solenoid using XT30/XT60 connectors and marine heat shrink.
- **Silver Stripe Side (Cathode):** Connect to 12V (+) side of the solenoid.
- **Solid Black Side (Anode):** Connect to Negative (-) side (running back to MOSFET Drain).

## 4. Grounding Rules
- **Star Grounding:** Both the 12V power supply ground and the ESP32 3.3V logic ground MUST be connected together to a single "Master Ground Hub" on the perfboard.
- The 12V positive must remain isolated.
