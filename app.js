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
const CHAR_GRAPH_UUID = "beb5483e-36e5-4688-b7f5-ea07361b26a8";

let bleDevice = null;
let cmdCharacteristic = null;
let graphCharacteristic = null;
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
  valTank: document.getElementById('val-tank'),
  btnGraph: document.getElementById('btn-graph'),
  graphModal: document.getElementById('graph-modal'),
  btnCloseGraph: document.getElementById('btn-close-graph'),
  btnDump: document.getElementById('btn-dump')
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
  graphCharacteristic = await service.getCharacteristic(CHAR_GRAPH_UUID);

  // Setup Notifications
  await charLeft.startNotifications();
  charLeft.addEventListener('characteristicvaluechanged', handleLeftPsi);
  
  await charRight.startNotifications();
  charRight.addEventListener('characteristicvaluechanged', handleRightPsi);

  await charTank.startNotifications();
  charTank.addEventListener('characteristicvaluechanged', handleTankPsi);

  await graphCharacteristic.startNotifications();
  graphCharacteristic.addEventListener('characteristicvaluechanged', handleGraphData);

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
  ui.btnGraph.style.display = 'inline-block';
  
  sendTimeAndRequestSync();
}

async function sendTimeAndRequestSync() {
  if (!graphCharacteristic) return;
  const currentEpoch = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder('utf-8');
  try {
    await graphCharacteristic.writeValue(encoder.encode("TIME:" + currentEpoch));
    setTimeout(async () => {
      await graphCharacteristic.writeValue(encoder.encode("GET"));
    }, 500); // Give ESP32 a moment to process the time setting
  } catch(e) {
    console.error("Time sync failed", e);
  }
}

function onDisconnected() {
  ui.status.innerText = 'Disconnected';
  ui.btnConnect.classList.remove('connected');
  ui.btnConnect.innerText = 'CONNECT';
  ui.btnStart.classList.add('disabled');
  ui.btnGraph.style.display = 'none';
  cmdCharacteristic = null;
  graphCharacteristic = null;
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

// -- EMPTY AIR TANK LOGIC --
const startDump = async (e) => {
  e.preventDefault();
  if (!cmdCharacteristic) return;
  try {
    const encoder = new TextEncoder('utf-8');
    await cmdCharacteristic.writeValue(encoder.encode("DUMP:1"));
    ui.btnDump.style.backgroundColor = "#d32f2f";
  } catch (err) {
    console.error("Dump error", err);
  }
};

const stopDump = async (e) => {
  e.preventDefault();
  if (!cmdCharacteristic) return;
  try {
    const encoder = new TextEncoder('utf-8');
    await cmdCharacteristic.writeValue(encoder.encode("DUMP:0"));
    ui.btnDump.style.backgroundColor = "#ff3b30";
  } catch (err) {
    console.error("Stop Dump error", err);
  }
};

ui.btnDump.addEventListener('mousedown', startDump);
ui.btnDump.addEventListener('touchstart', startDump, {passive: false});
ui.btnDump.addEventListener('mouseup', stopDump);
ui.btnDump.addEventListener('touchend', stopDump);
ui.btnDump.addEventListener('mouseleave', stopDump);

// -- GRAPH LOGIC --
let graphBuffer = "";
let chartInstance = null;

function handleGraphData(event) {
  const decoder = new TextDecoder('utf-8');
  let chunk = decoder.decode(event.target.value);
  
  if (chunk === "END") {
    console.log("Graph sync complete");
    parseAndSaveGraphData(graphBuffer);
    graphBuffer = ""; // reset
  } else {
    graphBuffer += chunk;
  }
}

function parseAndSaveGraphData(csvStr) {
  if (!csvStr) return;
  localStorage.setItem('pressureHistory', csvStr);
}

function renderChart() {
  const csvStr = localStorage.getItem('pressureHistory');
  if (!csvStr) {
     alert("No graph data available yet. Please wait for a sync.");
     return;
  }
  
  const lines = csvStr.trim().split('\n');
  const labels = [];
  const leftData = [];
  const rightData = [];
  const tankData = [];
  const targetLeftData = [];
  const targetRightData = [];
  
  lines.forEach(line => {
     const parts = line.split(',');
     if(parts.length >= 4) {
        const date = new Date(parseInt(parts[0]) * 1000);
        const timeStr = date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
        labels.push(timeStr);
        leftData.push(parseInt(parts[1]));
        rightData.push(parseInt(parts[2]));
        tankData.push(parseInt(parts[3]));
        if (parts.length >= 6) {
           targetLeftData.push(parseInt(parts[4]));
           targetRightData.push(parseInt(parts[5]));
        } else {
           targetLeftData.push(null);
           targetRightData.push(null);
        }
     }
  });

  const ctx = document.getElementById('pressureChart').getContext('2d');
  if (chartInstance) {
     chartInstance.destroy();
  }
  
  chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
          labels: labels,
          datasets: [
              { label: 'Left', data: leftData, borderColor: '#34c759', backgroundColor: 'rgba(52, 199, 89, 0.1)', tension: 0.2, fill: true },
              { label: 'Right', data: rightData, borderColor: '#ff3b30', backgroundColor: 'rgba(255, 59, 48, 0.1)', tension: 0.2, fill: true },
              { label: 'Tank', data: tankData, borderColor: '#007aff', backgroundColor: 'rgba(0, 122, 255, 0.1)', tension: 0.2, fill: true },
              { label: 'Set Left', data: targetLeftData, borderColor: '#34c759', borderDash: [5, 5], backgroundColor: 'transparent', tension: 0.2, fill: false },
              { label: 'Set Right', data: targetRightData, borderColor: '#ff3b30', borderDash: [5, 5], backgroundColor: 'transparent', tension: 0.2, fill: false }
          ]
      },
      options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
              y: { beginAtZero: true, suggestedMax: 150 }
          }
      }
  });
}

ui.btnGraph.addEventListener('click', () => {
   renderChart();
   ui.graphModal.style.display = "block";
});

ui.btnCloseGraph.addEventListener('click', () => {
   ui.graphModal.style.display = "none";
});

window.addEventListener('click', (event) => {
  if (event.target == ui.graphModal) {
    ui.graphModal.style.display = "none";
  }
});
