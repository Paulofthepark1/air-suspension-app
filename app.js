// Register Service Worker for Offline PWA Support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js')
    .then(reg => console.log('Service Worker Registered!', reg))
    .catch(err => console.error('Service Worker Registration Failed!', err));
}

const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHAR_LEFT_PSI_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
const CHAR_RIGHT_PSI_UUID = "beb5483e-36e2-4688-b7f5-ea07361b26a8";
const CHAR_TANK_PSI_UUID = "beb5483e-36e4-4688-b7f5-ea07361b26a8";
const CHAR_CMD_UUID = "beb5483e-36e3-4688-b7f5-ea07361b26a8";

let bleDevice = null;
let cmdCharacteristic = null;
let isAutoReconnecting = false;

// Target state
let targetLeft = 0;
let targetRight = 0;
let appliedLeft = 0;
let appliedRight = 0;

const ui = {
  status: document.getElementById('ble-status'),
  btnConnect: document.getElementById('btn-connect'),
  btnStart: document.getElementById('btn-start'),
  btnSync: document.getElementById('btn-sync'),
  
  targetLeft: document.getElementById('target-left'),
  targetRight: document.getElementById('target-right'),
  valLeft: document.getElementById('val-left'),
  valRight: document.getElementById('val-right'),
  valTank: document.getElementById('val-tank')
};

// -- SHARED CONNECTION LOGIC --
async function connectToDevice(device) {
  bleDevice = device;
  bleDevice.addEventListener('gattserverdisconnected', onDisconnected);
  
  ui.status.innerText = 'Connecting...';
  const server = await bleDevice.gatt.connect();
  
  ui.status.innerText = 'Getting Service...';
  const service = await server.getPrimaryService(SERVICE_UUID);
  
  ui.status.innerText = 'Getting Characteristics...';
  const charLeft = await service.getCharacteristic(CHAR_LEFT_PSI_UUID);
  const charRight = await service.getCharacteristic(CHAR_RIGHT_PSI_UUID);
  const charTank = await service.getCharacteristic(CHAR_TANK_PSI_UUID);
  cmdCharacteristic = await service.getCharacteristic(CHAR_CMD_UUID);

  // Setup Notifications
  await charLeft.startNotifications();
  charLeft.addEventListener('characteristicvaluechanged', handleLeftPsi);
  
  await charRight.startNotifications();
  charRight.addEventListener('characteristicvaluechanged', handleRightPsi);

  await charTank.startNotifications();
  charTank.addEventListener('characteristicvaluechanged', handleTankPsi);

  onConnected();
}

// -- AUTO-RECONNECT ON APP OPEN --
async function autoReconnect() {
  // Check if the browser supports getDevices (Chrome 85+, Edge)
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) {
    console.log('Auto-reconnect not supported in this browser.');
    return;
  }

  try {
    const devices = await navigator.bluetooth.getDevices();
    // Find a previously paired ESP32
    const esp32 = devices.find(d => d.name && d.name === 'Air Bags');
    
    if (!esp32) {
      console.log('No previously paired ESP32 found.');
      return;
    }

    console.log('Found previously paired device:', esp32.name);
    isAutoReconnecting = true;
    ui.status.innerText = 'Reconnecting...';
    ui.btnConnect.innerText = 'CONNECTING...';
    ui.btnConnect.classList.add('reconnecting');

    // Listen for the device's advertisement to know it's in range
    const abortController = new AbortController();
    
    // Set a timeout — give up after 5 seconds
    const timeout = setTimeout(() => {
      abortController.abort();
      if (!bleDevice || !bleDevice.gatt.connected) {
        isAutoReconnecting = false;
        ui.status.innerText = 'Tap CONNECT to pair';
        ui.btnConnect.innerText = 'CONNECT';
        ui.btnConnect.classList.remove('reconnecting');
        console.log('Auto-reconnect timed out.');
      }
    }, 5000);

    esp32.addEventListener('advertisementreceived', async (evt) => {
      console.log('Advertisement received, connecting...');
      clearTimeout(timeout);
      abortController.abort(); // Stop watching
      try {
        await connectToDevice(esp32);
        isAutoReconnecting = false;
      } catch (err) {
        console.warn('Auto-reconnect failed:', err);
        isAutoReconnecting = false;
        ui.status.innerText = 'Tap CONNECT to pair';
        ui.btnConnect.innerText = 'CONNECT';
        ui.btnConnect.classList.remove('reconnecting');
      }
    }, { once: true });

    await esp32.watchAdvertisements({ signal: abortController.signal });
  } catch (err) {
    console.warn('Auto-reconnect error:', err);
    isAutoReconnecting = false;
    ui.status.innerText = 'Tap CONNECT to pair';
    ui.btnConnect.innerText = 'CONNECT';
    ui.btnConnect.classList.remove('reconnecting');
  }
}

// Kick off auto-reconnect when the page loads
autoReconnect();

// -- MANUAL BLUETOOTH CONNECTION --
ui.btnConnect.addEventListener('click', async () => {
  // Don't interfere if auto-reconnect is in progress
  if (isAutoReconnecting) return;

  if (bleDevice && bleDevice.gatt.connected) {
    bleDevice.gatt.disconnect();
    return;
  }
  
  try {
    ui.status.innerText = 'Requesting Bluetooth Device...';
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ name: 'Air Bags' }, { services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID]
    });

    await connectToDevice(device);
  } catch (error) {
    console.warn(error);
    ui.status.innerText = 'Connection Failed: ' + error.message;
  }
});

function onConnected() {
  ui.status.innerText = 'Connected';
  ui.btnConnect.classList.remove('reconnecting');
  ui.btnConnect.classList.add('connected');
  ui.btnConnect.innerText = 'DISCONNECT';
  ui.btnStart.classList.remove('disabled');
}

function onDisconnected() {
  ui.status.innerText = 'Disconnected';
  ui.btnConnect.classList.remove('connected');
  ui.btnConnect.innerText = 'CONNECT';
  ui.btnStart.classList.add('disabled');
  cmdCharacteristic = null;
  // Reset targets to 0 for next session
  targetLeft = 0;
  targetRight = 0;
  appliedLeft = 0;
  appliedRight = 0;
  updateDisplay();

  // Try to auto-reconnect after a disconnect (e.g. ESP32 rebooted)
  setTimeout(() => autoReconnect(), 1500);
}

// -- SENSOR HANDLING --
function handleLeftPsi(event) {
  const decoder = new TextDecoder('utf-8');
  let value = decoder.decode(event.target.value);
  ui.valLeft.innerText = value;
}

function handleRightPsi(event) {
  const decoder = new TextDecoder('utf-8');
  let value = decoder.decode(event.target.value);
  ui.valRight.innerText = value;
}

function handleTankPsi(event) {
  const decoder = new TextDecoder('utf-8');
  let value = decoder.decode(event.target.value);
  if (ui.valTank) {
    ui.valTank.innerText = value;
  }
}

// -- TARGET CONTROLS LOGIC --
let isSyncOn = true;

ui.btnSync.addEventListener('click', () => {
  isSyncOn = !isSyncOn;
  ui.btnSync.innerText = isSyncOn ? "SYNC: ON" : "SYNC: OFF";
  ui.btnSync.classList.toggle('active', isSyncOn);
  
  if (isSyncOn) {
    // When sync turns on, match right to left by default
    targetRight = targetLeft;
    updateDisplay();
  }
});

function updateDisplay() {
  ui.targetLeft.innerText = targetLeft;
  ui.targetRight.innerText = targetRight;

  if (targetLeft === appliedLeft) {
    ui.targetLeft.classList.remove('modified');
  } else {
    ui.targetLeft.classList.add('modified');
  }

  if (targetRight === appliedRight) {
    ui.targetRight.classList.remove('modified');
  } else {
    ui.targetRight.classList.add('modified');
  }

  if (targetLeft === appliedLeft && targetRight === appliedRight) {
    ui.btnStart.classList.remove('modified');
  } else {
    ui.btnStart.classList.add('modified');
  }
}

function adjustTarget(side, amount) {
  if (isSyncOn) {
    targetLeft = Math.max(0, Math.min(150, targetLeft + amount));
    targetRight = targetLeft; 
  } else {
    if (side === 'left') {
      targetLeft = Math.max(0, Math.min(150, targetLeft + amount));
    }
    if (side === 'right') {
      targetRight = Math.max(0, Math.min(150, targetRight + amount));
    }
  }
  updateDisplay();
}

// Attach listeners to arrow buttons
const btnMap = {
  'btn-left-up': { side: 'left', amt: 5 },
  'btn-left-down': { side: 'left', amt: -5 },
  'btn-right-up': { side: 'right', amt: 5 },
  'btn-right-down': { side: 'right', amt: -5 }
};

Object.keys(btnMap).forEach(id => {
  const btn = document.getElementById(id);
  const cfg = btnMap[id];
  
  const triggerClick = (e) => {
    e.preventDefault();
    adjustTarget(cfg.side, cfg.amt);
  };
  
  btn.addEventListener('mousedown', triggerClick);
  btn.addEventListener('touchstart', triggerClick, {passive: false});
});

// -- SEND COMMAND --
ui.btnStart.addEventListener('click', async () => {
  if (!cmdCharacteristic) return;
  
  // Example "SET:80:85"
  const cmdStr = `SET:${targetLeft}:${targetRight}`;
  console.log("Sending command:", cmdStr);
  
  try {
    const encoder = new TextEncoder('utf-8');
    await cmdCharacteristic.writeValue(encoder.encode(cmdStr));
    
    // Re-sync applied targets
    appliedLeft = targetLeft;
    appliedRight = targetRight;
    updateDisplay();
    
    // Add visual feedback to button
    ui.btnStart.innerText = "DONE!";
    setTimeout(() => { ui.btnStart.innerText = "SET"; }, 1500);
  } catch(e) {
    console.error("Write error", e);
  }
});
