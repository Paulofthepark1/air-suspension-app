/*
  ESP32 BLE Air Suspension Controller - TARGET MODE
*/
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Arduino.h>
#include <LittleFS.h>

BLEServer* pServer = NULL;
BLECharacteristic* pCharLeft = NULL;
BLECharacteristic* pCharRight = NULL;
BLECharacteristic* pCharTank = NULL;
BLECharacteristic* pCharCmd = NULL;
BLECharacteristic* pCharGraph = NULL;

bool deviceConnected = false;
bool oldDeviceConnected = false;

// State Tracking (-1 means no sensor / no reading)
int leftPsi = -1;
int rightPsi = -1;
int tankPsi = -1;
int targetLeftPsi = 0;
int targetRightPsi = 0;

const int HYSTERESIS = 2; // +/- 2 PSI tolerance to prevent rapid valve clicking
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

void stopAllSolenoids() {
  digitalWrite(LEFT_AIR_IN_PIN, RELAY_OFF);
  digitalWrite(LEFT_AIR_OUT_PIN, RELAY_OFF);
  digitalWrite(RIGHT_AIR_IN_PIN, RELAY_OFF);
  digitalWrite(RIGHT_AIR_OUT_PIN, RELAY_OFF);
  digitalWrite(TANK_DUMP_PIN, RELAY_OFF);
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
    }
};

class MyCmdCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      String rxValue = pCharacteristic->getValue(); // Now officially String for > 3.0.0
      
      // Expected format: SET:80:85  (Left:Right) or DUMP:1 / DUMP:0
      if (rxValue.startsWith("SET:")) {
        int firstColon = rxValue.indexOf(':');
        int secondColon = rxValue.indexOf(':', firstColon + 1);

        if (firstColon != -1 && secondColon != -1) {
          String leftStr = rxValue.substring(firstColon + 1, secondColon);
          String rightStr = rxValue.substring(secondColon + 1);

          targetLeftPsi = leftStr.toInt();
          targetRightPsi = rightStr.toInt();
          commandReceived = true; // NOW activate the control loop
          
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

  BLEDevice::init("Air Bags");

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

  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(false);
  pAdvertising->setMinPreferred(0x0);  
  BLEDevice::startAdvertising();
  Serial.println("Waiting for a client connection...");
}

unsigned long lastSensorUpdate = 0;
unsigned long lastControlUpdate = 0;

void loop() {
  if (deviceConnected) {
    
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
      if (leftPsi >= 0) {
        if (leftPsi < targetLeftPsi - HYSTERESIS) {
          digitalWrite(LEFT_AIR_IN_PIN, RELAY_ON);
          digitalWrite(LEFT_AIR_OUT_PIN, RELAY_OFF);
        } else if (leftPsi > targetLeftPsi + HYSTERESIS) {
          digitalWrite(LEFT_AIR_IN_PIN, RELAY_OFF);
          digitalWrite(LEFT_AIR_OUT_PIN, RELAY_ON);
        } else {
          digitalWrite(LEFT_AIR_IN_PIN, RELAY_OFF);
          digitalWrite(LEFT_AIR_OUT_PIN, RELAY_OFF);
        }
      } else {
        // No sensor - ensure solenoids are off
        digitalWrite(LEFT_AIR_IN_PIN, RELAY_OFF);
        digitalWrite(LEFT_AIR_OUT_PIN, RELAY_OFF);
      }

      // RIGHT SIDE LOGIC (only if sensor is connected)
      if (rightPsi >= 0) {
        if (rightPsi < targetRightPsi - HYSTERESIS) {
          digitalWrite(RIGHT_AIR_IN_PIN, RELAY_ON);
          digitalWrite(RIGHT_AIR_OUT_PIN, RELAY_OFF);
        } else if (rightPsi > targetRightPsi + HYSTERESIS) {
          digitalWrite(RIGHT_AIR_IN_PIN, RELAY_OFF);
          digitalWrite(RIGHT_AIR_OUT_PIN, RELAY_ON);
        } else {
          digitalWrite(RIGHT_AIR_IN_PIN, RELAY_OFF);
          digitalWrite(RIGHT_AIR_OUT_PIN, RELAY_OFF);
        }
      } else {
        // No sensor - ensure solenoids are off
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
  }

  // --- 3. GRAPH STREAMING ---
  if (isStreamingGraph) {
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
  if (timeSet && millis() - lastLogUpdate > 60000) {
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
