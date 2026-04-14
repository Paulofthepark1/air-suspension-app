/*
  ESP32 BLE Air Suspension Controller - TARGET MODE
*/
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Arduino.h>

BLEServer* pServer = NULL;
BLECharacteristic* pCharLeft = NULL;
BLECharacteristic* pCharRight = NULL;
BLECharacteristic* pCharCmd = NULL;

bool deviceConnected = false;
bool oldDeviceConnected = false;

// State Tracking
int leftPsi = 65;
int rightPsi = 65;
int targetLeftPsi = 65;
int targetRightPsi = 65;

const int HYSTERESIS = 2; // +/- 2 PSI tolerance to prevent rapid valve clicking

// ---- PIN DEFINITIONS ----
const int LEFT_AIR_IN_PIN  = 4;  
const int LEFT_AIR_OUT_PIN = 5;  
const int RIGHT_AIR_IN_PIN = 18; 
const int RIGHT_AIR_OUT_PIN = 19; 
const int SENSOR_PIN = 34; // Simulation analog pin

// Service and Characteristics
#define SERVICE_UUID           "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHAR_LEFT_PSI_UUID     "beb5483e-36e1-4688-b7f5-ea07361b26a8"
#define CHAR_RIGHT_PSI_UUID    "beb5483e-36e2-4688-b7f5-ea07361b26a8"
#define CHAR_CMD_UUID          "beb5483e-36e3-4688-b7f5-ea07361b26a8"

void stopAllSolenoids() {
  digitalWrite(LEFT_AIR_IN_PIN, LOW);
  digitalWrite(LEFT_AIR_OUT_PIN, LOW);
  digitalWrite(RIGHT_AIR_IN_PIN, LOW);
  digitalWrite(RIGHT_AIR_OUT_PIN, LOW);
}

class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
      deviceConnected = true;
    };
    void onDisconnect(BLEServer* pServer) {
      deviceConnected = false;
      stopAllSolenoids(); // Safety stop on disconnect
      // Reset targets to current so it doesn't move when reconnected
      targetLeftPsi = leftPsi;
      targetRightPsi = rightPsi;
    }
};

class MyCmdCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
      String rxValue = pCharacteristic->getValue(); // Now officially String for > 3.0.0
      
      // Expected format: SET:80:85  (Left:Right)
      if (rxValue.startsWith("SET:")) {
        int firstColon = rxValue.indexOf(':');
        int secondColon = rxValue.indexOf(':', firstColon + 1);

        if (firstColon != -1 && secondColon != -1) {
          String leftStr = rxValue.substring(firstColon + 1, secondColon);
          String rightStr = rxValue.substring(secondColon + 1);

          targetLeftPsi = leftStr.toInt();
          targetRightPsi = rightStr.toInt();
          
          Serial.print("New target targets - Left: ");
          Serial.print(targetLeftPsi);
          Serial.print(" Right: ");
          Serial.println(targetRightPsi);
        }
      }
    }
};

void setup() {
  Serial.begin(115200);

  // Initialize Pins
  pinMode(LEFT_AIR_IN_PIN, OUTPUT);
  pinMode(LEFT_AIR_OUT_PIN, OUTPUT);
  pinMode(RIGHT_AIR_IN_PIN, OUTPUT);
  pinMode(RIGHT_AIR_OUT_PIN, OUTPUT);

  stopAllSolenoids();

  BLEDevice::init("ESP32_Air_Suspension");

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());
  BLEService *pService = pServer->createService(SERVICE_UUID);

  // Left PSI TX
  pCharLeft = pService->createCharacteristic(CHAR_LEFT_PSI_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);                   
  pCharLeft->addDescriptor(new BLE2902());

  // Right PSI TX
  pCharRight = pService->createCharacteristic(CHAR_RIGHT_PSI_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);                   
  pCharRight->addDescriptor(new BLE2902());

  // Command RX
  pCharCmd = pService->createCharacteristic(CHAR_CMD_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  pCharCmd->setCallbacks(new MyCmdCallbacks());

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
    
    // --- 1. SENSOR NOTIFICATION (Simulated) ---
    if (millis() - lastSensorUpdate > 1000) {
      lastSensorUpdate = millis();

      char lStr[10]; sprintf(lStr, "%d", leftPsi);
      pCharLeft->setValue((uint8_t*)lStr, strlen(lStr));
      pCharLeft->notify();

      char rStr[10]; sprintf(rStr, "%d", rightPsi);
      pCharRight->setValue((uint8_t*)rStr, strlen(rStr));
      pCharRight->notify();
    }

    // --- 2. CONTROL LOOP (50ms interval) ---
    if (millis() - lastControlUpdate > 50) {
      lastControlUpdate = millis();

      // LEFT SIDE LOGIC
      if (leftPsi < targetLeftPsi - HYSTERESIS) {
        digitalWrite(LEFT_AIR_IN_PIN, HIGH);
        digitalWrite(LEFT_AIR_OUT_PIN, LOW);
      } else if (leftPsi > targetLeftPsi + HYSTERESIS) {
        digitalWrite(LEFT_AIR_IN_PIN, LOW);
        digitalWrite(LEFT_AIR_OUT_PIN, HIGH);
      } else {
        digitalWrite(LEFT_AIR_IN_PIN, LOW);
        digitalWrite(LEFT_AIR_OUT_PIN, LOW);
      }

      // RIGHT SIDE LOGIC
      if (rightPsi < targetRightPsi - HYSTERESIS) {
        digitalWrite(RIGHT_AIR_IN_PIN, HIGH);
        digitalWrite(RIGHT_AIR_OUT_PIN, LOW);
      } else if (rightPsi > targetRightPsi + HYSTERESIS) {
        digitalWrite(RIGHT_AIR_IN_PIN, LOW);
        digitalWrite(RIGHT_AIR_OUT_PIN, HIGH);
      } else {
        digitalWrite(RIGHT_AIR_IN_PIN, LOW);
        digitalWrite(RIGHT_AIR_OUT_PIN, LOW);
      }

      // -- SIMULATION DRIFT --
      // This fakes the pressure changing so you can see it working without real sensors right now!
      if (leftPsi < targetLeftPsi - HYSTERESIS) leftPsi++;
      else if (leftPsi > targetLeftPsi + HYSTERESIS) leftPsi--;
      
      if (rightPsi < targetRightPsi - HYSTERESIS) rightPsi++;
      else if (rightPsi > targetRightPsi + HYSTERESIS) rightPsi--;
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
      // Initialize targets to current pressure when newly connected
      targetLeftPsi = leftPsi;
      targetRightPsi = rightPsi;
  }
}
