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

#define FW_VERSION "2.0.1"

BLEServer* pServer = NULL;
BLECharacteristic* pCharLeft = NULL;
BLECharacteristic* pCharRight = NULL;
BLECharacteristic* pCharTank = NULL;
BLECharacteristic* pCharCmd = NULL;
BLECharacteristic* pCharGraph = NULL;
BLECharacteristic* pCharOtaStatus = NULL;
BLECharacteristic* pCharVersion = NULL;
BLECharacteristic* pCharFwData = NULL;

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

// Graph Logging Variables
unsigned long bootTimestamp = 0;
bool timeSet = false;
bool isStreamingGraph = false;
File streamingFile;
unsigned long lastLogUpdate = 0;

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

void stopAllSolenoids() {
  digitalWrite(LEFT_AIR_IN_PIN, RELAY_OFF);
  digitalWrite(LEFT_AIR_OUT_PIN, RELAY_OFF);
  digitalWrite(RIGHT_AIR_IN_PIN, RELAY_OFF);
  digitalWrite(RIGHT_AIR_OUT_PIN, RELAY_OFF);
  digitalWrite(TANK_DUMP_PIN, RELAY_OFF);
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
  prefs.end();
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
      commandReceived = false; // Stop control loop
      stopAllSolenoids(); // Safety stop on disconnect
      targetLeftPsi = 0;
      targetRightPsi = 0;
      leftState = IDLE;
      rightState = IDLE;
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
      } else if (rxValue == "DUMP:1") {
        digitalWrite(TANK_DUMP_PIN, RELAY_ON);
        Serial.println("Dumping tank...");
      } else if (rxValue == "DUMP:0") {
        digitalWrite(TANK_DUMP_PIN, RELAY_OFF);
        Serial.println("Stopped dumping tank.");
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
        stopAllSolenoids();
        leftState = IDLE;
        rightState = IDLE;
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
         Serial.print("Time set! Boot epoch: ");
         Serial.println(bootTimestamp);
      }
      else if (rxValue.startsWith("GET")) {
         Serial.println("App requested graph data.");
         isStreamingGraph = true;
         streamingFile = LittleFS.open("/history.csv", FILE_READ);
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
  digitalWrite(LEFT_AIR_IN_PIN, RELAY_OFF);
  digitalWrite(LEFT_AIR_OUT_PIN, RELAY_OFF);
  digitalWrite(RIGHT_AIR_IN_PIN, RELAY_OFF);
  digitalWrite(RIGHT_AIR_OUT_PIN, RELAY_OFF);
  digitalWrite(TANK_DUMP_PIN, RELAY_OFF);

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

  if (deviceConnected && !fwReceiving) {

    // --- 1. SENSOR READING & NOTIFICATION ---
    if (millis() - lastSensorUpdate > 500) {
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
      pCharLeft->notify();

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
      pCharRight->notify();

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
      pCharTank->notify();
    }

    // --- 2. CONTROL LOOP (50ms interval) - ONLY after user sends SET ---
    if (commandReceived && millis() - lastControlUpdate > 50) {
      lastControlUpdate = millis();

      // LEFT SIDE LOGIC (only if sensor is connected)
      if (leftPsi >= 0 && leftState != IDLE) {
        if (leftState == FILLING) {
          if (leftPsi >= targetLeftPsi) {
            leftState = IDLE;
            digitalWrite(LEFT_AIR_IN_PIN, RELAY_OFF);
            digitalWrite(LEFT_AIR_OUT_PIN, RELAY_OFF);
          } else {
            digitalWrite(LEFT_AIR_IN_PIN, RELAY_ON);
            digitalWrite(LEFT_AIR_OUT_PIN, RELAY_OFF);
          }
        } else if (leftState == DEFLATING) {
          if (leftPsi <= targetLeftPsi) {
            leftState = IDLE;
            digitalWrite(LEFT_AIR_IN_PIN, RELAY_OFF);
            digitalWrite(LEFT_AIR_OUT_PIN, RELAY_OFF);
          } else {
            digitalWrite(LEFT_AIR_IN_PIN, RELAY_OFF);
            digitalWrite(LEFT_AIR_OUT_PIN, RELAY_ON);
          }
        }
      } else {
        // No sensor or target reached - ensure solenoids are off
        digitalWrite(LEFT_AIR_IN_PIN, RELAY_OFF);
        digitalWrite(LEFT_AIR_OUT_PIN, RELAY_OFF);
      }

      // RIGHT SIDE LOGIC (only if sensor is connected)
      if (rightPsi >= 0 && rightState != IDLE) {
        if (rightState == FILLING) {
          if (rightPsi >= targetRightPsi) {
            rightState = IDLE;
            digitalWrite(RIGHT_AIR_IN_PIN, RELAY_OFF);
            digitalWrite(RIGHT_AIR_OUT_PIN, RELAY_OFF);
          } else {
            digitalWrite(RIGHT_AIR_IN_PIN, RELAY_ON);
            digitalWrite(RIGHT_AIR_OUT_PIN, RELAY_OFF);
          }
        } else if (rightState == DEFLATING) {
          if (rightPsi <= targetRightPsi) {
            rightState = IDLE;
            digitalWrite(RIGHT_AIR_IN_PIN, RELAY_OFF);
            digitalWrite(RIGHT_AIR_OUT_PIN, RELAY_OFF);
          } else {
            digitalWrite(RIGHT_AIR_IN_PIN, RELAY_OFF);
            digitalWrite(RIGHT_AIR_OUT_PIN, RELAY_ON);
          }
        }
      } else {
        // No sensor or target reached - ensure solenoids are off
        digitalWrite(RIGHT_AIR_IN_PIN, RELAY_OFF);
        digitalWrite(RIGHT_AIR_OUT_PIN, RELAY_OFF);
      }
    }
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

  // --- 3. GRAPH STREAMING ---
  if (isStreamingGraph && !fwReceiving) {
    if (streamingFile && streamingFile.available()) {
        char chunk[200];
        int bytesRead = streamingFile.readBytes(chunk, 199);
        chunk[bytesRead] = 0;
        pCharGraph->setValue((uint8_t*)chunk, bytesRead);
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

  // --- 4. DATA LOGGING (Every 60s) ---
  if (timeSet && !fwReceiving && millis() - lastLogUpdate > 60000) {
    lastLogUpdate = millis();
    unsigned long currentEpoch = bootTimestamp + (millis() / 1000);
    File file = LittleFS.open("/history.csv", FILE_APPEND);
    if (file) {
        char logStr[80];
        sprintf(logStr, "%lu,%d,%d,%d,%d,%d\n", currentEpoch,
                leftPsi >= 0 ? leftPsi : 0,
                rightPsi >= 0 ? rightPsi : 0,
                tankPsi >= 0 ? tankPsi : 0,
                targetLeftPsi,
                targetRightPsi);
        file.print(logStr);
        file.close();
        Serial.print("Logged: ");
        Serial.print(logStr);
    }
  }
}
