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
const CHAR_OTA_STATUS_UUID = "beb5483e-36e6-4688-b7f5-ea07361b26a8";
const CHAR_VERSION_UUID = "beb5483e-36e7-4688-b7f5-ea07361b26a8";
const CHAR_FW_DATA_UUID = "beb5483e-36e8-4688-b7f5-ea07361b26a8";

// Firmware binaries are auto-built from this repo by GitHub Actions and
// published to the "firmware" branch (raw.githubusercontent serves CORS)
const GITHUB_REPO = "Paulofthepark1/air-suspension-app";
const FW_BASE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/firmware`;
const FW_CHUNK_SIZE = 200;  // bytes per BLE write
const FW_ACK_EVERY = 64;    // chunks per FWACK (must match the firmware)

let bleDevice = null;
let cmdCharacteristic = null;
let graphCharacteristic = null;
let otaStatusCharacteristic = null;
let fwDataCharacteristic = null;
let isAutoReconnecting = false;
let deviceFwVersion = null;   // null = legacy firmware without version characteristic
let latestFwVersion = null;   // latest published firmware version, e.g. "2.1.0"
let latestFwMeta = null;      // {version, size, md5} from version.json
let updateInProgress = false;
let fwTransfer = null;        // active transfer's notify router

// Target state
let targetLeft = parseInt(localStorage.getItem('targetLeft')) || 0;
let targetRight = parseInt(localStorage.getItem('targetRight')) || 0;
let appliedLeft = -1; // -1 so it shows as modified (red) until SET is pressed
let appliedRight = -1;

const ui = {
  status: document.getElementById('ble-status'),
  btnConnect: document.getElementById('btn-connect'),
  btnStart: document.getElementById('btn-start'),
  btnSetLeft: document.getElementById('btn-set-left'),
  btnSetRight: document.getElementById('btn-set-right'),
  btnSync: document.getElementById('btn-sync'),
  
  targetLeft: document.getElementById('target-left'),
  targetRight: document.getElementById('target-right'),
  valLeft: document.getElementById('val-left'),
  valRight: document.getElementById('val-right'),
  valTank: document.getElementById('val-tank'),
  btnGraph: document.getElementById('btn-graph'),
  btnOta: document.getElementById('btn-ota'),
  graphModal: document.getElementById('graph-modal'),
  btnCloseGraph: document.getElementById('btn-close-graph'),
  btnDump: document.getElementById('btn-dump'),
  fwInfo: document.getElementById('fw-info'),
  btnWifi: document.getElementById('btn-wifi'),
  wifiModal: document.getElementById('wifi-modal'),
  btnCloseWifi: document.getElementById('btn-close-wifi'),
  btnWifiSave: document.getElementById('btn-wifi-save'),
  wifiSsidInput: document.getElementById('wifi-ssid'),
  wifiPassInput: document.getElementById('wifi-pass'),
  btnRescue: document.getElementById('btn-rescue')
};

// -- SHARED CONNECTION LOGIC --
async function connectToDevice(device) {
  bleDevice = device;
  // remove-then-add so retry attempts don't stack duplicate listeners
  bleDevice.removeEventListener('gattserverdisconnected', onDisconnected);
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
  otaStatusCharacteristic = await service.getCharacteristic(CHAR_OTA_STATUS_UUID);

  // Firmware version + data characteristics only exist on v2+ firmware
  deviceFwVersion = null;
  fwDataCharacteristic = null;
  try {
    const versionChar = await service.getCharacteristic(CHAR_VERSION_UUID);
    const verVal = await versionChar.readValue();
    deviceFwVersion = new TextDecoder('utf-8').decode(verVal).trim();
    fwDataCharacteristic = await service.getCharacteristic(CHAR_FW_DATA_UUID);
  } catch(e) {
    console.log("No version/fw-data characteristic — legacy firmware.");
  }

  // Check for status left over from the last update attempt
  ui.status.innerText = 'Checking OTA Status...';
  try {
    const otaStatusVal = await otaStatusCharacteristic.readValue();
    const decoder = new TextDecoder('utf-8');
    const otaMessage = decoder.decode(otaStatusVal);
    if (otaMessage && otaMessage.trim() !== "" && !otaMessage.startsWith("UPDATING:") && !otaMessage.startsWith("Wi-Fi saved")) {
      alert("Firmware Update Info: " + otaMessage);
      const encoder = new TextEncoder('utf-8');
      await otaStatusCharacteristic.writeValue(encoder.encode("CLEAR"));
    }
  } catch(e) {
    console.warn("Could not read OTA status", e);
  }

  // v2+ firmware notifies live update progress on the status characteristic
  try {
    await otaStatusCharacteristic.startNotifications();
    otaStatusCharacteristic.addEventListener('characteristicvaluechanged', handleOtaStatusNotify);
  } catch(e) {
    console.log("OTA status notifications not supported (legacy firmware).");
  }

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
// Uses getDevices() (persistent device permission) + direct gatt.connect()
// attempts. watchAdvertisements() is not reliable on Android Chrome, so a
// plain connect-with-retries is the compatible approach.
const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))
]);

async function autoReconnect() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) {
    console.log('Auto-reconnect not supported in this browser.');
    return;
  }
  if (isAutoReconnecting || (bleDevice && bleDevice.gatt.connected)) return;

  try {
    const devices = await navigator.bluetooth.getDevices();
    const esp32 = devices.find(d => d.name && d.name === 'Air Bags');
    if (!esp32) {
      console.log('No previously paired ESP32 found.');
      return;
    }

    console.log('Found previously paired device:', esp32.name);
    isAutoReconnecting = true;
    ui.status.innerText = 'Connecting to Air Bags...';
    ui.btnConnect.innerText = 'CONNECTING...';
    ui.btnConnect.classList.add('reconnecting');

    // ~4 attempts x (10s cap + 2s pause) also covers the reboot after a
    // firmware update
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await withTimeout(connectToDevice(esp32), 10000);
        isAutoReconnecting = false;
        return; // onConnected() has taken over the UI
      } catch (err) {
        console.warn(`Auto-connect attempt ${attempt} failed:`, err);
        try { esp32.gatt.disconnect(); } catch(_) {}
        if (attempt < 4) await new Promise(r => setTimeout(r, 2000));
      }
    }
  } catch (err) {
    console.warn('Auto-reconnect error:', err);
  }
  isAutoReconnecting = false;
  ui.status.innerText = 'Tap CONNECT to pair';
  ui.btnConnect.innerText = 'CONNECT';
  ui.btnConnect.classList.remove('reconnecting');
}

// Kick off auto-reconnect when the page loads, and again whenever the app
// comes back to the foreground without a live connection
autoReconnect();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!bleDevice || !bleDevice.gatt.connected)) {
    autoReconnect();
  }
});

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
  ui.btnSetLeft.classList.remove('disabled');
  ui.btnSetRight.classList.remove('disabled');
  ui.btnGraph.style.display = 'inline-block';
  ui.btnOta.style.display = 'inline-block';
  ui.btnWifi.style.display = 'inline-block';
  updateInProgress = false;

  updateSetButtonsLayout();
  updateFirmwareUI();
  checkLatestFirmware();
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
  if (updateInProgress) {
    ui.status.innerText = 'Installing update — reconnecting shortly...';
  } else {
    ui.status.innerText = 'Disconnected';
  }
  ui.btnConnect.classList.remove('connected');
  ui.btnConnect.innerText = 'CONNECT';
  ui.btnStart.classList.add('disabled');
  ui.btnSetLeft.classList.add('disabled');
  ui.btnSetRight.classList.add('disabled');
  ui.btnGraph.style.display = 'none';
  ui.btnOta.style.display = 'none';
  ui.btnWifi.style.display = 'none';
  cmdCharacteristic = null;
  graphCharacteristic = null;
  otaStatusCharacteristic = null;
  updateSetButtonsLayout();
  // Make targets modified again so user knows to hit SET
  appliedLeft = -1;
  appliedRight = -1;
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
let isSyncOn = localStorage.getItem('isSyncOn') !== 'false'; // default true

// Initialize sync UI on load
ui.btnSync.innerText = isSyncOn ? "SYNC: ON" : "SYNC: OFF";
ui.btnSync.classList.toggle('active', isSyncOn);

ui.btnSync.addEventListener('click', () => {
  isSyncOn = !isSyncOn;
  localStorage.setItem('isSyncOn', isSyncOn);
  ui.btnSync.innerText = isSyncOn ? "SYNC: ON" : "SYNC: OFF";
  ui.btnSync.classList.toggle('active', isSyncOn);

  if (isSyncOn) {
    // When sync turns on, match right to left by default
    targetRight = targetLeft;
    localStorage.setItem('targetRight', targetRight);
  }
  updateSetButtonsLayout();
  updateDisplay();
});

// Per-side SET needs firmware ≥ 2.0.1 (the "-" placeholder in SET:L:R);
// on older firmware "-" would parse as 0 and dump that side
function supportsPerSideSet() {
  return !!deviceFwVersion && !isNewerVersion('2.0.1', deviceFwVersion);
}

// Sync ON (or firmware without per-side support): one central SET.
// Sync OFF on v2.0.1+: a SET under each side instead.
function updateSetButtonsLayout() {
  const perSide = !isSyncOn && supportsPerSideSet() && cmdCharacteristic;
  ui.btnStart.style.display = perSide ? 'none' : 'inline-block';
  ui.btnSetLeft.style.display = perSide ? 'inline-block' : 'none';
  ui.btnSetRight.style.display = perSide ? 'inline-block' : 'none';
}

// Run once on load to show saved values
updateDisplay();

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

  ui.btnSetLeft.classList.toggle('modified', targetLeft !== appliedLeft);
  ui.btnSetRight.classList.toggle('modified', targetRight !== appliedRight);
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
  localStorage.setItem('targetLeft', targetLeft);
  localStorage.setItem('targetRight', targetRight);
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
async function sendSetCommand(cmdStr, btn) {
  console.log("Sending command:", cmdStr);
  try {
    const encoder = new TextEncoder('utf-8');
    await cmdCharacteristic.writeValue(encoder.encode(cmdStr));
    btn.innerText = "DONE!";
    setTimeout(() => { btn.innerText = "SET"; }, 1500);
    return true;
  } catch(e) {
    console.error("Write error", e);
    return false;
  }
}

ui.btnStart.addEventListener('click', async () => {
  if (!cmdCharacteristic) return;
  if (await sendSetCommand(`SET:${targetLeft}:${targetRight}`, ui.btnStart)) {
    appliedLeft = targetLeft;
    appliedRight = targetRight;
    updateDisplay();
  }
});

// Per-side SET (sync off, firmware ≥ 2.0.1): "-" leaves the other side alone
ui.btnSetLeft.addEventListener('click', async () => {
  if (!cmdCharacteristic || !supportsPerSideSet()) return;
  if (await sendSetCommand(`SET:${targetLeft}:-`, ui.btnSetLeft)) {
    appliedLeft = targetLeft;
    updateDisplay();
  }
});

ui.btnSetRight.addEventListener('click', async () => {
  if (!cmdCharacteristic || !supportsPerSideSet()) return;
  if (await sendSetCommand(`SET:-:${targetRight}`, ui.btnSetRight)) {
    appliedRight = targetRight;
    updateDisplay();
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

// -- FIRMWARE UPDATE LOGIC --

// Compare "2.1.0"-style versions; true if a is newer than b
function isNewerVersion(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function checkLatestFirmware() {
  try {
    const res = await fetch(`${FW_BASE_URL}/version.json?t=${Date.now()}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const meta = await res.json();
    latestFwVersion = (meta.version || "").replace(/^v/, '');
    latestFwMeta = meta;
  } catch(e) {
    console.warn("Could not check GitHub for latest firmware", e);
    latestFwVersion = null;
    latestFwMeta = null;
  }
  updateFirmwareUI();
}

function updateFirmwareUI() {
  const current = deviceFwVersion ? `v${deviceFwVersion}` : 'v1 (legacy)';
  let info = `Firmware ${current}`;
  ui.btnOta.classList.remove('update-available');

  if (!deviceFwVersion) {
    // Legacy firmware: OTA:1 opens the Arduino IDE network port only
    ui.btnOta.innerText = 'ENABLE OTA UPDATE (IDE)';
    if (latestFwVersion) info += ` — v${latestFwVersion} available via IDE`;
  } else if (latestFwVersion && isNewerVersion(latestFwVersion, deviceFwVersion)) {
    ui.btnOta.innerText = `INSTALL UPDATE v${latestFwVersion}`;
    ui.btnOta.classList.add('update-available');
    info += ` — update available!`;
  } else if (latestFwVersion) {
    ui.btnOta.innerText = 'FIRMWARE UP TO DATE';
    info += ` — up to date`;
  } else {
    ui.btnOta.innerText = 'UPDATE FIRMWARE';
    info += ` — couldn't reach GitHub`;
  }
  if (ui.fwInfo) ui.fwInfo.innerText = info;
}

function handleOtaStatusNotify(event) {
  const msg = new TextDecoder('utf-8').decode(event.target.value);
  if (msg.trim() === "") return;
  // Let an active transfer consume its protocol messages first
  if (fwTransfer && fwTransfer.onMessage(msg)) return;
  ui.status.innerText = msg;
  if (msg.startsWith("Update failed") || msg.startsWith("FWERR:")) updateInProgress = false;
}

// Stream the firmware image to the ESP32 over BLE.
// Protocol: FWBEGIN:<size>:<md5> → FWREADY → 200B chunks with an FWACK
// every 64 chunks → FWEND → FWOK + reboot. Any FWERR aborts.
async function installFirmware(meta) {
  const encoder = new TextEncoder('utf-8');

  ui.status.innerText = 'Downloading firmware...';
  const res = await fetch(`${FW_BASE_URL}/firmware.bin?t=${Date.now()}`);
  if (!res.ok) throw new Error("Download failed (HTTP " + res.status + ")");
  const buf = await res.arrayBuffer();
  if (buf.byteLength !== meta.size) {
    throw new Error(`Downloaded size ${buf.byteLength} doesn't match expected ${meta.size}`);
  }

  updateInProgress = true;
  let waiter = null;
  const waitFor = (test, timeoutMs, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiter = null; reject(new Error(label + " timed out")); }, timeoutMs);
    waiter = {
      test,
      resolve: (m) => { clearTimeout(timer); waiter = null; resolve(m); },
      reject: (m) => { clearTimeout(timer); waiter = null; reject(new Error(m)); }
    };
  });
  fwTransfer = {
    onMessage(msg) {
      if (msg.startsWith("FWERR:")) {
        if (waiter) waiter.reject(msg);
        return true;
      }
      if (waiter && waiter.test(msg)) {
        waiter.resolve(msg);
        return true;
      }
      // Swallow stray protocol messages so they don't clobber the status line
      return msg === "FWREADY" || msg === "FWOK" || msg.startsWith("FWACK:");
    }
  };

  try {
    const readyPromise = waitFor(m => m === "FWREADY", 10000, "Update start");
    await cmdCharacteristic.writeValue(encoder.encode(`FWBEGIN:${buf.byteLength}:${meta.md5}`));
    await readyPromise;

    const canWriteNR = typeof fwDataCharacteristic.writeValueWithoutResponse === 'function';
    let sent = 0;
    let chunkIdx = 0;
    while (sent < buf.byteLength) {
      const chunk = new Uint8Array(buf, sent, Math.min(FW_CHUNK_SIZE, buf.byteLength - sent));
      chunkIdx++;
      // Register the ack waiter before sending the chunk that triggers it
      const ackPromise = (chunkIdx % FW_ACK_EVERY === 0)
        ? waitFor(m => m.startsWith("FWACK:"), 15000, "Transfer ack")
        : null;
      if (canWriteNR) {
        await fwDataCharacteristic.writeValueWithoutResponse(chunk);
      } else {
        await fwDataCharacteristic.writeValue(chunk);
      }
      sent += chunk.length;
      if (ackPromise) {
        const ack = await ackPromise;
        const acked = parseInt(ack.substring(6));
        if (acked !== sent) throw new Error(`Transfer out of sync (device got ${acked}, sent ${sent})`);
        ui.status.innerText = `Installing firmware... ${Math.round(sent * 100 / buf.byteLength)}%`;
      }
    }

    ui.status.innerText = 'Verifying and flashing...';
    const okPromise = waitFor(m => m === "FWOK" || m.startsWith("Firmware update installed"), 30000, "Finalize");
    await cmdCharacteristic.writeValue(encoder.encode("FWEND"));
    await okPromise;
    ui.status.innerText = 'Update installed — device rebooting...';
  } catch (e) {
    try { await cmdCharacteristic.writeValue(encoder.encode("FWABORT")); } catch(_) {}
    updateInProgress = false;
    throw e;
  } finally {
    fwTransfer = null;
  }
}

ui.btnOta.addEventListener('click', async () => {
  if (!cmdCharacteristic) return;
  if (updateInProgress) return;

  // Legacy v1 firmware: only the Wi-Fi + Arduino IDE path exists
  if (!deviceFwVersion || !fwDataCharacteristic) {
    if (confirm("This will connect the ESP32 to Wi-Fi and open the Arduino IDE network port for a one-time manual update. Proceed?")) {
      try {
        const encoder = new TextEncoder('utf-8');
        await cmdCharacteristic.writeValue(encoder.encode("OTA:1"));
        ui.status.innerText = "Switching to OTA mode...";
      } catch(e) {
        console.error("Write error", e);
      }
    }
    return;
  }

  if (!latestFwMeta) {
    alert("Couldn't reach GitHub to check for firmware. Check your internet connection.");
    return;
  }

  const isUpdate = latestFwVersion && isNewerVersion(latestFwVersion, deviceFwVersion);
  const sizeMb = (latestFwMeta.size / 1048576).toFixed(1);
  const prompt = isUpdate
    ? `Install firmware v${latestFwVersion}? Your phone downloads it (~${sizeMb} MB) and sends it over Bluetooth — takes a few minutes. Keep the app open and stay near the truck.`
    : "Firmware already looks up to date. Reinstall the latest version anyway?";

  if (!confirm(prompt)) return;
  try {
    await installFirmware(latestFwMeta);
  } catch (e) {
    console.error("Firmware install failed", e);
    ui.status.innerText = 'Update failed: ' + e.message;
    alert("Firmware update failed: " + e.message + "\n\nThe controller is still running its current firmware — you can retry.");
  }
});

// -- WI-FI SETUP LOGIC --
ui.btnWifi.addEventListener('click', () => {
  ui.wifiModal.style.display = "block";
});

ui.btnCloseWifi.addEventListener('click', () => {
  ui.wifiModal.style.display = "none";
});

ui.btnWifiSave.addEventListener('click', async () => {
  if (!cmdCharacteristic) return;
  const ssid = ui.wifiSsidInput.value.trim();
  const pass = ui.wifiPassInput.value;
  if (!ssid) {
    alert("Enter the Wi-Fi network name.");
    return;
  }
  try {
    const encoder = new TextEncoder('utf-8');
    await cmdCharacteristic.writeValue(encoder.encode(`WIFI:${ssid}\n${pass}`));
    // The firmware acknowledges on the status characteristic
    setTimeout(async () => {
      try {
        const val = await otaStatusCharacteristic.readValue();
        const msg = new TextDecoder('utf-8').decode(val);
        alert(msg || "Wi-Fi credentials sent.");
      } catch(e) {
        alert("Wi-Fi credentials sent.");
      }
    }, 800);
    ui.wifiModal.style.display = "none";
    ui.wifiPassInput.value = "";
  } catch(e) {
    console.error("Wi-Fi save error", e);
    alert("Failed to send Wi-Fi credentials: " + e.message);
  }
});

ui.btnRescue.addEventListener('click', async () => {
  if (!cmdCharacteristic) return;
  if (confirm("Rescue mode: the controller joins Wi-Fi and opens the Arduino IDE network port for 5 minutes, then reboots. Continue?")) {
    try {
      const encoder = new TextEncoder('utf-8');
      await cmdCharacteristic.writeValue(encoder.encode("OTA:1"));
      ui.wifiModal.style.display = "none";
      ui.status.innerText = "Opening IDE rescue port...";
    } catch(e) {
      console.error("Rescue error", e);
    }
  }
});

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
  if (event.target == ui.wifiModal) {
    ui.wifiModal.style.display = "none";
  }
});
