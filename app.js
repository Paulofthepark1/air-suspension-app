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
const CHAR_MODE_UUID = "beb5483e-36e9-4688-b7f5-ea07361b26a8";

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
let modeCharacteristic = null;
let modeInfo = null;          // {daily, status, target} — null = mode-less firmware
let lastWarnedStatus = null;  // for system-notification transitions

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
  btnLogs: document.getElementById('btn-logs'),
  logsModal: document.getElementById('logs-modal'),
  btnCloseLogs: document.getElementById('btn-close-logs'),
  btnStats: document.getElementById('btn-stats'),
  connectHint: document.getElementById('connect-hint'),
  fwInfo: document.getElementById('fw-info'),
  btnWifi: document.getElementById('btn-wifi'),
  wifiModal: document.getElementById('wifi-modal'),
  btnCloseWifi: document.getElementById('btn-close-wifi'),
  btnWifiSave: document.getElementById('btn-wifi-save'),
  wifiSsidInput: document.getElementById('wifi-ssid'),
  wifiPassInput: document.getElementById('wifi-pass'),
  btnRescue: document.getElementById('btn-rescue'),
  btnDrain: document.getElementById('btn-drain'),
  btnMode: document.getElementById('btn-mode'),
  modeBanner: document.getElementById('mode-banner'),
  dailyPanel: document.getElementById('daily-panel'),
  dailyTarget: document.getElementById('daily-target'),
  btnDailyMinus: document.getElementById('btn-daily-minus'),
  btnDailyPlus: document.getElementById('btn-daily-plus'),
  dailyStatus: document.getElementById('daily-status')
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

  // Drive mode characteristic (fw >= 2.1.0)
  modeCharacteristic = null;
  modeInfo = null;
  try {
    modeCharacteristic = await service.getCharacteristic(CHAR_MODE_UUID);
    const modeVal = await modeCharacteristic.readValue();
    handleModeValue(new TextDecoder('utf-8').decode(modeVal));
    await modeCharacteristic.startNotifications();
    modeCharacteristic.addEventListener('characteristicvaluechanged', (evt) => {
      handleModeValue(new TextDecoder('utf-8').decode(evt.target.value));
    });
  } catch(e) {
    console.log("No mode characteristic — firmware without drive modes.");
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

let autoFailStreak = 0;
let lastSavedDeviceCount = null;   // devices getDevices() returned on the last attempt
let lastAutoResult = 'not run';    // outcome of the last auto-connect attempt, for diagnostics

function showConnectHint(noSavedDevice) {
  const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  if (standalone) return;
  if (noSavedDevice || autoFailStreak >= 2) {
    ui.connectHint.innerText = noSavedDevice
      ? "Chrome isn't remembering the pairing. Chrome menu → Add to Home screen makes it permanent."
      : "Tip: installing via Chrome menu → Add to Home screen makes auto-connect more reliable.";
    ui.connectHint.style.display = 'block';
  }
}

async function autoReconnect() {
  if (!navigator.bluetooth || !navigator.bluetooth.getDevices) {
    console.log('Auto-reconnect not supported in this browser.');
    lastAutoResult = 'getDevices unsupported';
    // Chrome on Android only exposes getDevices() behind a flag — without
    // it auto-connect is impossible, so say exactly how to turn it on.
    ui.status.innerText = 'Tap CONNECT to pair';
    ui.connectHint.innerText = 'Auto-connect needs a one-time Chrome setting: ' +
      'open chrome://flags in Chrome, search "Web Bluetooth new permissions", ' +
      'set it to Enabled, and restart Chrome.';
    ui.connectHint.style.display = 'block';
    return;
  }
  if (isAutoReconnecting || (bleDevice && bleDevice.gatt.connected)) return;

  try {
    const devices = await navigator.bluetooth.getDevices();
    lastSavedDeviceCount = devices.length;
    const esp32 = devices.find(d => d.name && d.name === 'Air Bags');
    if (!esp32) {
      console.log('No previously paired ESP32 found.');
      lastAutoResult = 'no saved device';
      ui.status.innerText = 'Tap CONNECT to pair';
      showConnectHint(true); // permission not persisting — the auto-connect blocker
      return;
    }

    console.log('Found previously paired device:', esp32.name);
    isAutoReconnecting = true;
    ui.status.innerText = 'Connecting to Air Bags...';
    ui.btnConnect.innerText = 'CONNECTING...';
    ui.btnConnect.classList.add('reconnecting');

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await withTimeout(connectToDevice(esp32), 8000);
        isAutoReconnecting = false;
        lastAutoResult = 'connected';
        return; // onConnected() has taken over the UI
      } catch (err) {
        console.warn(`Auto-connect attempt ${attempt} failed:`, err);
        lastAutoResult = `connect failed: ${err && err.message ? err.message : err}`;
        try { esp32.gatt.disconnect(); } catch(_) {}
        if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
      }
    }
  } catch (err) {
    console.warn('Auto-reconnect error:', err);
  }
  isAutoReconnecting = false;
  // The retry timer below keeps searching — walking into range is enough
  autoFailStreak++;
  showConnectHint(false);
  ui.status.innerText = 'Searching for Air Bags...';
  ui.btnConnect.innerText = 'CONNECT';
  ui.btnConnect.classList.remove('reconnecting');
}

// Keep trying for as long as the app is open and disconnected: on load,
// whenever the app returns to the foreground, and every 15s in between.
autoReconnect();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!bleDevice || !bleDevice.gatt.connected)) {
    autoReconnect();
  }
});
setInterval(() => {
  if (!document.hidden && !isAutoReconnecting && (!bleDevice || !bleDevice.gatt.connected)) {
    autoReconnect();
  }
}, 15000);

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
  document.body.classList.remove('disconnected');
  ui.status.innerText = 'Connected';
  ui.btnConnect.classList.remove('reconnecting');
  ui.btnConnect.classList.add('connected');
  ui.btnConnect.innerText = 'DISCONNECT';
  ui.btnStart.classList.remove('disabled');
  ui.btnSetLeft.classList.remove('disabled');
  ui.btnSetRight.classList.remove('disabled');
  ui.btnGraph.style.display = 'inline-block';
  ui.btnLogs.style.display = supportsEvents() ? 'inline-block' : 'none';
  ui.btnOta.style.display = 'inline-block';
  ui.btnWifi.style.display = 'inline-block';
  ui.btnMode.style.display = modeCharacteristic ? 'inline-block' : 'none';
  ui.btnDrain.style.display = supportsDrain() ? 'inline-block' : 'none';
  setDrainActive(false);
  ui.connectHint.style.display = 'none';
  autoFailStreak = 0;
  updateInProgress = false;

  applyModeUI();
  updateSetButtonsLayout();
  updateFirmwareUI();
  checkLatestFirmware();
  sendTimeAndRequestSync();
}

let syncPhase = null; // 'hist' → 'ev' → null
let syncPhaseAt = 0;

// A lost END must not wedge the phase machine forever
setInterval(() => {
  if (syncPhase && Date.now() - syncPhaseAt > 60000) {
    console.warn('Sync phase timed out, resetting');
    syncPhase = null;
    graphBuffer = "";
  }
}, 20000);

async function sendTimeAndRequestSync() {
  if (!graphCharacteristic) return;
  const currentEpoch = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder('utf-8');
  try {
    await graphCharacteristic.writeValue(encoder.encode("TIME:" + currentEpoch));
    setTimeout(async () => {
      // Incremental sync from the newest DEVICE-sourced row (not live app
      // rows — those would make us skip the device's own log), with a 10
      // minute overlap margin; duplicates dedupe by timestamp.
      let since = 0;
      try { since = parseInt(localStorage.getItem('lastDeviceEpoch')) || 0; } catch(_) {}
      if (!since && historyData.length) since = Math.floor(historyData[historyData.length - 1].t / 1000);
      syncPhase = 'hist';
      syncPhaseAt = Date.now();
      const cmd = supportsIncrementalSync() && since ? "GET:" + Math.max(0, since - 600) : "GET";
      await graphCharacteristic.writeValue(encoder.encode(cmd));
    }, 500); // Give ESP32 a moment to process the time setting
  } catch(e) {
    console.error("Time sync failed", e);
  }
}

async function requestEventSync() {
  if (!graphCharacteristic || !supportsEvents()) { syncPhase = null; return; }
  let since = 0;
  try { since = parseInt(localStorage.getItem('lastEventEpoch')) || 0; } catch(_) {}
  syncPhase = 'ev';
  syncPhaseAt = Date.now();
  try {
    const encoder = new TextEncoder('utf-8');
    await graphCharacteristic.writeValue(encoder.encode(since ? "GETEV:" + Math.max(0, since - 600) : "GETEV"));
  } catch(e) {
    console.error("Event sync failed", e);
    syncPhase = null;
  }
}

function supportsIncrementalSync() {
  return !!deviceFwVersion && !isNewerVersion('2.1.1', deviceFwVersion);
}

function supportsEvents() {
  return !!deviceFwVersion && !isNewerVersion('2.2.0', deviceFwVersion);
}

function supportsDrain() {
  // 2.3.0's drain assumed a tank dump valve that doesn't exist; the
  // pass-through drain needs 2.3.1
  return !!deviceFwVersion && !isNewerVersion('2.3.1', deviceFwVersion);
}

function onDisconnected() {
  document.body.classList.add('disconnected');
  if (updateInProgress) {
    ui.status.innerText = 'Installing update — reconnecting shortly...';
  } else {
    ui.status.innerText = 'Disconnected';
  }
  // Don't show stale readings on the next connect
  ui.valLeft.innerText = '---';
  ui.valRight.innerText = '---';
  if (ui.valTank) ui.valTank.innerText = '---';
  ui.btnConnect.classList.remove('connected');
  ui.btnConnect.innerText = 'CONNECT';
  ui.btnStart.classList.add('disabled');
  ui.btnSetLeft.classList.add('disabled');
  ui.btnSetRight.classList.add('disabled');
  ui.btnGraph.style.display = 'none';
  ui.btnLogs.style.display = 'none';
  ui.btnOta.style.display = 'none';
  ui.btnWifi.style.display = 'none';
  ui.btnMode.style.display = 'none';
  ui.btnDrain.style.display = 'none';
  ui.modeBanner.style.display = 'none';
  ui.dailyPanel.style.display = 'none';
  document.body.classList.remove('daily-mode');
  cmdCharacteristic = null;
  graphCharacteristic = null;
  otaStatusCharacteristic = null;
  modeCharacteristic = null;
  // A sync interrupted mid-stream must not bleed into the next connect's
  // streams (history rows were ending up parsed as events)
  graphBuffer = "";
  syncPhase = null;
  updateSetButtonsLayout();
  // Make targets modified again so user knows to hit SET
  appliedLeft = -1;
  appliedRight = -1;
  updateDisplay();

  // Try to auto-reconnect after a disconnect (e.g. ESP32 rebooted)
  setTimeout(() => autoReconnect(), 1500);
}

// -- SENSOR HANDLING --
// Latest live readings also feed the graph (see the live-append timer)
let liveL = null, liveR = null, liveTk = null;

function psiOrNull(str) {
  const v = parseInt(str);
  return isFinite(v) && v >= 0 && v <= 250 ? v : null;
}

function handleLeftPsi(event) {
  const decoder = new TextDecoder('utf-8');
  let value = decoder.decode(event.target.value);
  ui.valLeft.innerText = value;
  liveL = psiOrNull(value);
}

function handleRightPsi(event) {
  const decoder = new TextDecoder('utf-8');
  let value = decoder.decode(event.target.value);
  ui.valRight.innerText = value;
  liveR = psiOrNull(value);
}

function handleTankPsi(event) {
  const decoder = new TextDecoder('utf-8');
  let value = decoder.decode(event.target.value);
  if (ui.valTank) {
    ui.valTank.innerText = value;
  }
  liveTk = psiOrNull(value);
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

// -- FULL AIR-DOWN --
// No tank dump valve exists: the controller vents the bags, then bleeds
// the tank through one bag circuit at a time (in+out open), alternating
// sides every 30s. Never more than two valves energized.
let drainActive = false;

function setDrainActive(active) {
  drainActive = active;
  ui.btnDrain.innerText = active ? 'STOP AIR DOWN' : 'AIR DOWN ALL (BAGS + TANK)';
  ui.btnDrain.style.background = active ? '#ff3b30' : '#4a1512';
}

ui.btnDrain.addEventListener('click', async () => {
  if (!cmdCharacteristic) return;
  const encoder = new TextEncoder('utf-8');
  try {
    if (drainActive) {
      await cmdCharacteristic.writeValue(encoder.encode("DRAIN:0"));
      return;
    }
    if (!confirm("Air down EVERYTHING? Vents both bags to 0, then bleeds the tank out through the bag valves one side at a time (there's no dump valve on the tank). Never more than two valves open at once. Takes several minutes; tap STOP anytime.")) return;
    await cmdCharacteristic.writeValue(encoder.encode("DRAIN:1"));
  } catch(e) {
    console.error("Drain error", e);
  }
});

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
  ui.btnOta.style.backgroundColor = '#555'; // orange only when action needed

  if (!deviceFwVersion) {
    // Legacy firmware: OTA:1 opens the Arduino IDE network port only
    ui.btnOta.innerText = 'ENABLE OTA UPDATE (IDE)';
    ui.btnOta.style.backgroundColor = '#ff9800';
    if (latestFwVersion) info += ` — v${latestFwVersion} available via IDE`;
  } else if (latestFwVersion && isNewerVersion(latestFwVersion, deviceFwVersion)) {
    ui.btnOta.innerText = `INSTALL UPDATE v${latestFwVersion}`;
    ui.btnOta.classList.add('update-available');
    ui.btnOta.style.backgroundColor = '#ff9800';
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
  if (msg === "DRAIN:BAGS") {
    setDrainActive(true);
    ui.status.innerText = 'Airing down bags...';
    return;
  }
  if (msg === "DRAIN:TANK") {
    setDrainActive(true);
    ui.status.innerText = 'Bags empty — dumping tank...';
    return;
  }
  if (msg.startsWith("Drain ")) {
    setDrainActive(false);
    ui.status.innerText = msg;
    return;
  }
  if (msg.startsWith("INFO:")) {
    // Device internals (fw >= 2.3.4) — captured silently for the report
    try {
      localStorage.setItem('lastInfo', msg.substring(5));
      localStorage.setItem('lastInfoAt', String(Date.now()));
    } catch(_) {}
    return;
  }
  if (msg.startsWith("STATS:")) {
    try { localStorage.setItem('lastStats', msg.substring(6)); } catch(_) {}
    if (statsForReport) {
      statsForReport = false; // silent capture for the diagnostics report
      return;
    }
    const pairs = msg.substring(6).split(',').map(kv => kv.split('='));
    const names = { Lin: 'Left fill', Lout: 'Left release', Rin: 'Right fill', Rout: 'Right release', Dump: 'Tank dump' };
    alert("Lifetime valve actuations:\n" +
      pairs.map(([k, v]) => `${names[k] || k}: ${v}`).join('\n'));
    return;
  }
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

// -- DRIVE MODES (fw >= 2.1.0) --
// Mode characteristic value: "T" (tow) or "D:<status>:<target>" where
// status is OK | FILL | DEFL | LOWTANK | LOWBAGS

const DAILY_STATUS_TEXT = {
  OK: "Holding — bags OK",
  FILL: "Topping up...",
  DEFL: "Releasing down to target...",
  LOWTANK: "Waiting on tank pressure",
  LOWBAGS: "BAGS LOW — need air now!"
};

function handleModeValue(val) {
  val = (val || "").trim();
  if (val === "T") {
    modeInfo = { daily: false };
  } else if (val.startsWith("D:")) {
    const parts = val.split(":");
    modeInfo = { daily: true, status: parts[1] || "OK", target: parseInt(parts[2]) || 10 };
  } else {
    return;
  }
  applyModeUI();

  // Escalate warnings to a system notification on transition
  const status = modeInfo.daily ? modeInfo.status : null;
  if ((status === "LOWTANK" || status === "LOWBAGS") && status !== lastWarnedStatus) {
    systemNotify(
      status === "LOWBAGS" ? "Air bags critically low!" : "Air tank too low",
      status === "LOWBAGS"
        ? "Bags are under 5 PSI and the tank can't fill them. Turn the compressor on now."
        : "Tank pressure is too low to top up the bags. Turn the compressor on."
    );
  }
  lastWarnedStatus = status;
}

function applyModeUI() {
  const daily = !!(modeInfo && modeInfo.daily);
  document.body.classList.toggle('daily-mode', daily);
  ui.btnMode.innerText = daily ? "MODE: DAILY" : "MODE: TOW";
  ui.btnMode.classList.toggle('active', daily);
  ui.dailyPanel.style.display = daily && cmdCharacteristic ? 'block' : 'none';

  if (daily) {
    ui.dailyTarget.innerText = modeInfo.target;
    ui.dailyStatus.innerText = DAILY_STATUS_TEXT[modeInfo.status] || "—";

    if (modeInfo.status === "LOWBAGS") {
      ui.modeBanner.innerText = "⚠ BAGS UNDER 5 PSI — tank can't fill them. Turn the compressor ON!";
      ui.modeBanner.style.display = 'block';
    } else if (modeInfo.status === "LOWTANK") {
      ui.modeBanner.innerText = "Tank too low to top up the bags — turn the compressor on.";
      ui.modeBanner.style.display = 'block';
    } else {
      ui.modeBanner.style.display = 'none';
    }
  } else {
    ui.modeBanner.style.display = 'none';
  }
}

function systemNotify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  navigator.serviceWorker.getRegistration().then(reg => {
    if (reg && reg.showNotification) {
      reg.showNotification(title, { body, icon: './icon-192.png', badge: './icon-192.png' });
    } else {
      new Notification(title, { body });
    }
  }).catch(() => {
    try { new Notification(title, { body }); } catch(_) {}
  });
}

ui.btnMode.addEventListener('click', async () => {
  if (!cmdCharacteristic || !modeCharacteristic) return;
  const goingDaily = !(modeInfo && modeInfo.daily);
  const target = (modeInfo && modeInfo.target) || 10;
  const prompt = goingDaily
    ? `Switch to DAILY mode? The controller will adjust the bags to ${target} PSI and hold them there automatically — even with the app closed.`
    : "Switch to TOW mode? Automatic pressure holding stops; you control the bags with SET.";
  if (!confirm(prompt)) return;

  if (goingDaily && "Notification" in window && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch(_) {}
  }
  try {
    const encoder = new TextEncoder('utf-8');
    await cmdCharacteristic.writeValue(encoder.encode(goingDaily ? "MODE:DAILY" : "MODE:TOW"));
  } catch(e) {
    console.error("Mode switch error", e);
  }
});

async function adjustDailyTarget(delta) {
  if (!cmdCharacteristic || !modeInfo || !modeInfo.daily) return;
  const t = Math.max(5, Math.min(30, modeInfo.target + delta));
  if (t === modeInfo.target) return;
  try {
    const encoder = new TextEncoder('utf-8');
    await cmdCharacteristic.writeValue(encoder.encode("DTGT:" + t));
    modeInfo.target = t;      // optimistic; firmware republishes the real value
    ui.dailyTarget.innerText = t;
  } catch(e) {
    console.error("Daily target error", e);
  }
}

ui.btnDailyMinus.addEventListener('click', () => adjustDailyTarget(-1));
ui.btnDailyPlus.addEventListener('click', () => adjustDailyTarget(1));

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

// -- GRAPH DATA --
// The phone is the long-term archive: synced rows merge into localStorage
// (deduped by timestamp) and the device only streams what's new.
let graphBuffer = "";
let historyData = []; // [{t(ms), l, r, tk, sl, sr}] sorted by t
const HISTORY_KEEP_MS = 45 * 24 * 3600 * 1000; // ~6 weeks fits localStorage

// A power cut mid-write can glue two log lines together on the device,
// producing absurd timestamps/values — reject anything implausible.
const HISTORY_T_MIN = Date.parse('2020-01-01');

function parseCsvRows(csvStr) {
  const rows = [];
  const tMax = Date.now() + 48 * 3600 * 1000;
  const cleanPsi = (s) => {
    const v = parseInt(s);
    return isFinite(v) && v >= 0 && v <= 250 ? v : null;
  };
  for (const line of (csvStr || "").split('\n')) {
    const parts = line.trim().split(',');
    if (parts.length < 4) continue;
    const t = parseInt(parts[0]) * 1000;
    if (!isFinite(t) || t < HISTORY_T_MIN || t > tMax) continue;
    rows.push({
      t,
      l: cleanPsi(parts[1]),
      r: cleanPsi(parts[2]),
      tk: cleanPsi(parts[3]),
      sl: parts.length >= 6 ? cleanPsi(parts[4]) : null,
      sr: parts.length >= 6 ? cleanPsi(parts[5]) : null
    });
  }
  return rows;
}

function loadHistory() {
  try {
    historyData = parseCsvRows(localStorage.getItem('pressureHistory'));
    historyData.sort((a, b) => a.t - b.t);
  } catch(e) {
    historyData = [];
  }
}
loadHistory();

function handleGraphData(event) {
  const decoder = new TextDecoder('utf-8');
  let chunk = decoder.decode(event.target.value);

  if (chunk === "END") {
    if (syncPhase === 'ev') {
      console.log("Event sync complete");
      parseAndSaveEvents(graphBuffer);
      syncPhase = null;
    } else {
      console.log("Graph sync complete");
      parseAndSaveGraphData(graphBuffer);
      if (syncPhase === 'hist') requestEventSync();
      else syncPhase = null;
    }
    graphBuffer = ""; // reset
  } else {
    graphBuffer += chunk;
  }
}

function parseAndSaveGraphData(csvStr) {
  const incoming = parseCsvRows(csvStr);
  if (!incoming.length) return;

  // Remember the newest device-sourced timestamp for the next incremental sync
  const maxIncoming = Math.floor(Math.max(...incoming.map(p => p.t)) / 1000);
  try {
    const prev = parseInt(localStorage.getItem('lastDeviceEpoch')) || 0;
    if (maxIncoming > prev) localStorage.setItem('lastDeviceEpoch', String(maxIncoming));
  } catch(_) {}

  const byTime = new Map(historyData.map(p => [p.t, p]));
  incoming.forEach(p => byTime.set(p.t, p));
  historyData = [...byTime.values()].sort((a, b) => a.t - b.t);

  saveHistory();

  if (ui.graphModal.style.display === "block") {
    graphScheduleDraw();
  }
}

let lastHistorySave = 0;

function saveHistory() {
  const cutoff = Date.now() - HISTORY_KEEP_MS;
  if (historyData.length && historyData[0].t < cutoff) {
    historyData = historyData.filter(p => p.t >= cutoff);
  }
  try {
    localStorage.setItem('pressureHistory', historyData.map(p => {
      const cols = [Math.floor(p.t / 1000), p.l ?? '', p.r ?? '', p.tk ?? ''];
      if (p.sl != null || p.sr != null) cols.push(p.sl ?? '', p.sr ?? '');
      return cols.join(',');
    }).join('\n'));
    lastHistorySave = Date.now();
  } catch(e) {
    console.warn("Could not persist history", e);
  }
}

// While connected, feed live readings into the graph every 30s so it
// tracks "now" instead of freezing at the connect-time sync. The device's
// own 1-minute log still covers time spent with the app closed.
setInterval(() => {
  if (!cmdCharacteristic || updateInProgress) return;
  if (liveL == null && liveR == null && liveTk == null) return;

  const t = Date.now();
  const prevLast = historyData.length ? historyData[historyData.length - 1].t : 0;
  // Live rows carry the meaningful "set" values too: the daily hold target,
  // or the applied tow targets once SET has been pressed
  const liveSl = (modeInfo && modeInfo.daily) ? modeInfo.target : (appliedLeft >= 0 ? appliedLeft : null);
  const liveSr = (modeInfo && modeInfo.daily) ? modeInfo.target : (appliedRight >= 0 ? appliedRight : null);
  historyData.push({ t, l: liveL, r: liveR, tk: liveTk, sl: liveSl, sr: liveSr });

  // Persist occasionally — a lost tail is re-covered by the next device sync
  if (t - lastHistorySave > 300000) saveHistory();

  if (ui.graphModal.style.display === "block") {
    // Follow mode: if the view was pinned at the newest data, slide along
    if (graph.view.end >= prevLast - 60000) {
      const span = graph.view.end - graph.view.start;
      graph.view.end = t;
      graph.view.start = t - span;
    }
    graphScheduleDraw();
  }
}, 30000);

// -- EVENT LOG --
// Rows: epochSec,CODE[:detail...] — reboots (with reason), mode changes,
// fills/deflates with durations, warnings, dumps. Same merge/prune model
// as the pressure history.
let eventData = []; // [{t(ms), code}] sorted by t

function parseEventRows(str) {
  const rows = [];
  const tMax = Date.now() + 48 * 3600 * 1000;
  for (const line of (str || "").split('\n')) {
    const trimmed = line.trim();
    const comma = trimmed.indexOf(',');
    if (comma < 1) continue;
    const t = parseInt(trimmed.substring(0, comma)) * 1000;
    const code = trimmed.substring(comma + 1);
    if (!isFinite(t) || t < HISTORY_T_MIN || t > tMax || !code) continue;
    // Real event codes start with a letter — a leading digit means a
    // history row that leaked into the event stream; drop it
    if (!/^[A-Z]/.test(code)) continue;
    rows.push({ t, code });
  }
  return rows;
}

function loadEvents() {
  try {
    eventData = parseEventRows(localStorage.getItem('eventLog'));
    eventData.sort((a, b) => a.t - b.t);
  } catch(e) {
    eventData = [];
  }
}
loadEvents();

function parseAndSaveEvents(csvStr) {
  const incoming = parseEventRows(csvStr);
  if (!incoming.length) return;

  const byKey = new Map(eventData.map(e => [e.t + '|' + e.code, e]));
  incoming.forEach(e => byKey.set(e.t + '|' + e.code, e));
  eventData = [...byKey.values()].sort((a, b) => a.t - b.t);

  const cutoff = Date.now() - HISTORY_KEEP_MS;
  eventData = eventData.filter(e => e.t >= cutoff);

  try {
    localStorage.setItem('eventLog', eventData.map(e => `${Math.floor(e.t / 1000)},${e.code}`).join('\n'));
    localStorage.setItem('lastEventEpoch', String(eventData.length ? Math.floor(eventData[eventData.length - 1].t / 1000) : 0));
  } catch(e) {
    console.warn("Could not persist event log", e);
  }
}

const RESET_WARN = { crash: true, brownout: true, watchdog: true };

function humanizeEvent(code) {
  const p = code.split(':');
  const side = (k) => k.endsWith('L') ? 'left' : 'right';
  switch (true) {
    case p[0] === 'BOOT':
      return { text: `Rebooted (${p[1] || 'unknown'})${p[2] ? ' → ' + p[2] : ''}`, warn: !!RESET_WARN[p[1]] };
    case p[0] === 'MODE':
      return { text: `Mode switched to ${p[1]}` };
    case p[0] === 'WARN':
      return { text: p[1] === 'LOWBAGS' ? 'BAGS LOW and tank can\'t fill them' : 'Tank too low to top up bags', warn: true };
    case p[0].startsWith('DFILLCAP'):
      return { text: `Daily fill ${side(p[0])} hit the 30s cap (${p[1]} PSI) — possible leak or low tank`, warn: true };
    case p[0].startsWith('DFILL'):
      return { text: `Daily fill ${side(p[0])}: ${p[1] || ''} ${p[2] || ''} PSI` };
    case p[0].startsWith('DDEFL'):
      return { text: `Daily release ${side(p[0])}: ${p[1] || ''} PSI` };
    case p[0].startsWith('TFILL'):
      return { text: `Tow fill ${side(p[0])}: ${p[1] || ''} ${p[2] || ''} PSI` };
    case p[0].startsWith('TDEFL'):
      return { text: `Tow release ${side(p[0])}: ${p[1] || ''} ${p[2] || ''} PSI` };
    case p[0] === 'DUMP':
      return { text: `Tank dumped for ${p[1]}s` };
    case p[0] === 'DRAINSTART':
      return { text: 'Full air-down started' };
    case p[0] === 'DRAINEND':
      return { text: `Full air-down ${p[2] || 'ended'} (${p[1] || ''})` };
    default:
      return { text: code };
  }
}

function renderEventLog() {
  const list = document.getElementById('logs-list');
  const summary = document.getElementById('logs-summary');
  if (!eventData.length) {
    summary.innerText = 'No events yet — they sync from the controller on each connect.';
    list.innerHTML = '';
    return;
  }

  const dayAgo = Date.now() - 86400000;
  let fills = 0, reboots = 0, warns = 0;
  for (const e of eventData) {
    if (e.t < dayAgo) continue;
    if (e.code.startsWith('DFILL') || e.code.startsWith('TFILL')) fills++;
    if (e.code.startsWith('BOOT')) reboots++;
    if (e.code.startsWith('WARN') || e.code.startsWith('DFILLCAP')) warns++;
  }
  summary.innerText = `Last 24h: ${fills} fills · ${reboots} reboots · ${warns} warnings`;

  const rows = eventData.slice(-300).reverse();
  list.innerHTML = rows.map(e => {
    const h = humanizeEvent(e.code);
    return `<div class="log-row${h.warn ? ' log-warn' : ''}"><span class="log-time">${fmtTipTime(e.t)}</span>${h.text}</div>`;
  }).join('');
}

// -- GRAPH RENDERER --
// Custom canvas chart: drag to pan, pinch/scroll to zoom (time axis),
// pressure axis auto-fits the visible window, tap for a value readout.
const GRAPH_SERIES = [
  { key: 'l',  label: 'Left',  color: '#2fa84f', dash: [] },
  { key: 'r',  label: 'Right', color: '#dc55a8', dash: [] },
  { key: 'tk', label: 'Tank',  color: '#3b82f6', dash: [] },
  { key: 'sl', label: 'Set L', color: '#2fa84f', dash: [6, 4] },
  { key: 'sr', label: 'Set R', color: '#dc55a8', dash: [6, 4] }
];
const GRAPH_GAP_MS = 5 * 60 * 1000;   // break the line across logging gaps
const GRAPH_MIN_SPAN = 30 * 1000;     // max zoom-in: 30s (individual samples)
const GRAPH_MARGIN = { l: 38, r: 14, t: 10, b: 26 };

const graph = {
  canvas: null, ctx: null,
  view: { start: 0, end: 0 },
  hidden: {},
  cursorT: null,
  pointers: new Map(),
  pinchStart: null,
  dragMoved: false,
  raf: 0,
  legendBuilt: false
};

function graphExtent() {
  if (!historyData.length) return null;
  return { start: historyData[0].t, end: historyData[historyData.length - 1].t };
}

function graphClampView() {
  const ext = graphExtent();
  if (!ext) return;
  const extSpan = Math.max(ext.end - ext.start, GRAPH_MIN_SPAN);
  const pad = extSpan * 0.02;
  let span = graph.view.end - graph.view.start;
  span = Math.max(GRAPH_MIN_SPAN, Math.min(span, extSpan + 2 * pad));
  if (graph.view.start < ext.start - pad) graph.view.start = ext.start - pad;
  if (graph.view.start + span > ext.end + pad) graph.view.start = ext.end + pad - span;
  graph.view.end = graph.view.start + span;
}

function graphSetRange(rangeSeconds) {
  const ext = graphExtent();
  if (!ext) return;
  if (rangeSeconds === "all") {
    graph.view.start = ext.start;
    graph.view.end = Math.max(ext.end, ext.start + GRAPH_MIN_SPAN);
  } else {
    graph.view.end = ext.end;
    graph.view.start = ext.end - rangeSeconds * 1000;
  }
  graphClampView();
  graphScheduleDraw();
}

function graphScheduleDraw() {
  if (graph.raf) return;
  graph.raf = requestAnimationFrame(() => {
    graph.raf = 0;
    drawGraph();
  });
}

function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].t < t) lo = m + 1; else hi = m;
  }
  return lo;
}

function niceStep(rough, steps) {
  for (const s of steps) if (s >= rough) return s;
  return steps[steps.length - 1];
}

function fmtTick(t, stepMs) {
  const d = new Date(t);
  const hm = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  if (stepMs >= 86400000) return (d.getMonth() + 1) + '/' + d.getDate();
  if (stepMs < 60000) return hm + ':' + d.getSeconds().toString().padStart(2, '0');
  return hm;
}

function fmtTipTime(t) {
  const d = new Date(t);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ` +
    d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

// Classify an event code as a valve-marker: direction (in=fill / out=release),
// side (L/R/T), and whether it was a capped fill attempt
const GRAPH_SIDE_COLORS = { L: '#2fa84f', R: '#dc55a8', T: '#3b82f6' };
const GRAPH_CAP_COLOR = '#ff9800';

function eventMarkerInfo(code) {
  const p0 = code.split(':')[0];
  if (p0.startsWith('DFILLCAP')) return { dir: 'in', side: p0.slice(-1), cap: true };
  if (p0.startsWith('DFILL') || p0.startsWith('TFILL')) return { dir: 'in', side: p0.slice(-1) };
  if (p0.startsWith('DDEFL') || p0.startsWith('TDEFL')) return { dir: 'out', side: p0.slice(-1) };
  if (p0 === 'DUMP') return { dir: 'out', side: 'T' };
  return null;
}

function drawTriangle(ctx, x, y, up, color, size) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (up) {
    ctx.moveTo(x, y - size);
    ctx.lineTo(x - size, y + size);
    ctx.lineTo(x + size, y + size);
  } else {
    ctx.moveTo(x, y + size);
    ctx.lineTo(x - size, y - size);
    ctx.lineTo(x + size, y - size);
  }
  ctx.closePath();
  ctx.fill();
}

function drawGraph() {
  const canvas = graph.canvas, ctx = graph.ctx;
  if (!canvas) return;
  const wrap = document.getElementById('graph-wrap');
  const dpr = window.devicePixelRatio || 1;
  const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.font = '10px Roboto, sans-serif';

  if (!historyData.length) {
    ctx.fillStyle = '#888';
    ctx.textAlign = 'center';
    ctx.fillText('No history yet — connect to the truck to sync.', cssW / 2, cssH / 2);
    return;
  }

  graphClampView();
  const { start, end } = graph.view;
  const plotX = GRAPH_MARGIN.l, plotY = GRAPH_MARGIN.t;
  const plotW = cssW - GRAPH_MARGIN.l - GRAPH_MARGIN.r;
  const plotH = cssH - GRAPH_MARGIN.t - GRAPH_MARGIN.b;
  const xOf = t => plotX + ((t - start) / (end - start)) * plotW;

  // Visible slice (one point of margin each side so lines run off-screen)
  const i0 = Math.max(0, lowerBound(historyData, start) - 1);
  const i1 = Math.min(historyData.length, lowerBound(historyData, end) + 1);

  // Y range from the visible, non-hidden series
  let yMin = Infinity, yMax = -Infinity;
  for (let i = i0; i < i1; i++) {
    const p = historyData[i];
    for (const s of GRAPH_SERIES) {
      if (graph.hidden[s.key]) continue;
      const v = p[s.key];
      if (v == null || !isFinite(v)) continue;
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  if (!isFinite(yMin)) { yMin = 0; yMax = 100; }
  if (yMax - yMin < 4) { yMax += 2; yMin = Math.max(0, yMin - 2); }
  const yPad = (yMax - yMin) * 0.1;
  yMin = Math.max(0, yMin - yPad);
  yMax = yMax + yPad;
  const yOf = v => plotY + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // Y grid + labels (recessive)
  const yStep = niceStep((yMax - yMin) / 4, [1, 2, 5, 10, 20, 25, 50, 100]);
  ctx.strokeStyle = '#2a2a2a';
  ctx.fillStyle = '#888';
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) {
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(plotX, y);
    ctx.lineTo(plotX + plotW, y);
    ctx.stroke();
    ctx.fillText(String(v), plotX - 5, y);
  }

  // X ticks: pick a step giving ~4-6 labels
  const spanS = (end - start) / 1000;
  const xStepS = niceStep(spanS / 5,
    [10, 30, 60, 300, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 2592000, 7776000, 31536000]);
  const xStepMs = xStepS * 1000;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let t = Math.ceil(start / xStepMs) * xStepMs; t <= end; t += xStepMs) {
    const x = xOf(t);
    ctx.strokeStyle = '#242424';
    ctx.beginPath();
    ctx.moveTo(x, plotY);
    ctx.lineTo(x, plotY + plotH);
    ctx.stroke();
    ctx.fillStyle = '#888';
    ctx.fillText(fmtTick(t, xStepMs), x, plotY + plotH + 6);
  }

  // Series lines, decimated to ~2 points per pixel, broken at gaps
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotX, plotY, plotW, plotH);
  ctx.clip();
  const maxPts = plotW * 2;
  const labelSpots = [];
  for (const s of GRAPH_SERIES) {
    if (graph.hidden[s.key]) continue;
    const pts = [];
    for (let i = i0; i < i1; i++) {
      const v = historyData[i][s.key];
      if (v == null || !isFinite(v)) { pts.push(null); continue; }
      pts.push({ t: historyData[i].t, v });
    }
    // decimate by stride-averaging
    let drawPts = pts;
    const realCount = pts.filter(Boolean).length;
    if (realCount > maxPts) {
      const stride = Math.ceil(realCount / maxPts);
      drawPts = [];
      let bucket = [];
      for (const p of pts) {
        if (!p) {
          if (bucket.length) { drawPts.push(avgPoint(bucket)); bucket = []; }
          drawPts.push(null);
          continue;
        }
        bucket.push(p);
        if (bucket.length >= stride) { drawPts.push(avgPoint(bucket)); bucket = []; }
      }
      if (bucket.length) drawPts.push(avgPoint(bucket));
    }

    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.setLineDash(s.dash);
    // Offset Set R's dashes so two coincident set-lines are both visible
    ctx.lineDashOffset = s.key === 'sr' ? 5 : 0;
    ctx.beginPath();
    let pen = false, lastT = 0, lastPt = null;
    for (const p of drawPts) {
      if (!p) { pen = false; continue; }
      if (pen && p.t - lastT > GRAPH_GAP_MS) pen = false;
      const x = xOf(p.t), y = yOf(p.v);
      if (!pen) { ctx.moveTo(x, y); pen = true; } else { ctx.lineTo(x, y); }
      lastT = p.t;
      lastPt = p;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (lastPt && !s.dash.length) labelSpots.push({ label: s.label, y: yOf(lastPt.v) });
  }
  ctx.restore();

  // Valve-event markers: bottom lane, ▲ = fill (air in), ▼ = release (air
  // out); green=left, magenta=right, blue=tank dump, orange=capped fill.
  // Left/right sit on separate sub-rows so simultaneous events stay visible.
  if (!graph.hidden.ev && eventData.length) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotX, plotY, plotW, plotH);
    ctx.clip();
    const laneL = plotY + plotH - 24;
    const laneT = plotY + plotH - 16;
    const laneR = plotY + plotH - 8;
    const e0 = lowerBound(eventData, start);
    for (let i = e0; i < eventData.length && eventData[i].t <= end; i++) {
      const m = eventMarkerInfo(eventData[i].code);
      if (!m) continue;
      const x = xOf(eventData[i].t);
      const y = m.side === 'L' ? laneL : (m.side === 'T' ? laneT : laneR);
      const color = m.cap ? GRAPH_CAP_COLOR : (GRAPH_SIDE_COLORS[m.side] || '#888');
      drawTriangle(ctx, x, y, m.dir === 'in', color, 4.5);
    }
    ctx.restore();
  }

  // Direct labels for the solid series at the right edge (ink text, nudged apart)
  labelSpots.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labelSpots.length; i++) {
    if (labelSpots[i].y - labelSpots[i - 1].y < 12) labelSpots[i].y = labelSpots[i - 1].y + 12;
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = '#ddd';
  for (const spot of labelSpots) {
    ctx.fillText(spot.label, plotX + plotW - 3, Math.max(plotY + 10, Math.min(spot.y - 3, plotY + plotH - 2)));
  }

  drawGraphCursor(xOf, yOf, plotX, plotY, plotW, plotH);
}

function avgPoint(bucket) {
  let st = 0, sv = 0;
  for (const p of bucket) { st += p.t; sv += p.v; }
  return { t: st / bucket.length, v: sv / bucket.length };
}

function drawGraphCursor(xOf, yOf, plotX, plotY, plotW, plotH) {
  const tip = document.getElementById('graph-tip');
  if (graph.cursorT == null || !historyData.length) { tip.style.display = 'none'; return; }
  const { start, end } = graph.view;
  if (graph.cursorT < start || graph.cursorT > end) { tip.style.display = 'none'; return; }

  // nearest sample
  let idx = lowerBound(historyData, graph.cursorT);
  if (idx > 0 && (idx >= historyData.length ||
      graph.cursorT - historyData[idx - 1].t < historyData[idx].t - graph.cursorT)) idx--;
  const p = historyData[idx];
  const ctx = graph.ctx;
  const x = xOf(p.t);
  if (x < plotX || x > plotX + plotW) { tip.style.display = 'none'; return; }

  ctx.strokeStyle = '#666';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, plotY);
  ctx.lineTo(x, plotY + plotH);
  ctx.stroke();

  let html = `<div class="tip-time">${fmtTipTime(p.t)}</div>`;
  for (const s of GRAPH_SERIES) {
    if (graph.hidden[s.key]) continue;
    const v = p[s.key];
    if (v == null || !isFinite(v)) continue;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(x, yOf(v), 3.5, 0, Math.PI * 2);
    ctx.fill();
    html += `<div class="tip-row"><span class="tip-dot" style="background:${s.color}"></span>${s.label}: ${v} PSI</div>`;
  }

  // Valve events near the crosshair, spelled out
  if (!graph.hidden.ev && eventData.length) {
    const tol = Math.max(45000, (end - start) * 0.01);
    let shown = 0;
    for (const e of eventData) {
      if (e.t < p.t - tol || e.t > p.t + tol) continue;
      const m = eventMarkerInfo(e.code);
      if (!m) continue;
      if (++shown > 4) break;
      const color = m.cap ? GRAPH_CAP_COLOR : (GRAPH_SIDE_COLORS[m.side] || '#888');
      html += `<div class="tip-row"><span style="color:${color}">${m.dir === 'in' ? '&#9650;' : '&#9660;'}</span>${humanizeEvent(e.code).text}</div>`;
    }
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  const wrapW = document.getElementById('graph-wrap').clientWidth;
  const tipW = tip.offsetWidth;
  let left = x + 12;
  if (left + tipW > wrapW - 4) left = x - tipW - 12;
  tip.style.left = Math.max(4, left) + 'px';
}

function graphClearActiveRange() {
  document.querySelectorAll('#graph-ranges .range-btn').forEach(b => b.classList.remove('active'));
}

function graphXToTime(clientX) {
  const rect = graph.canvas.getBoundingClientRect();
  const frac = (clientX - rect.left - GRAPH_MARGIN.l) / (rect.width - GRAPH_MARGIN.l - GRAPH_MARGIN.r);
  return graph.view.start + frac * (graph.view.end - graph.view.start);
}

function graphZoomAt(t, factor) {
  const span = (graph.view.end - graph.view.start) * factor;
  const frac = (t - graph.view.start) / (graph.view.end - graph.view.start);
  graph.view.start = t - span * frac;
  graph.view.end = graph.view.start + span;
  graphClearActiveRange();
  graphClampView();
  graphScheduleDraw();
}

function initGraph() {
  if (graph.canvas) return;
  graph.canvas = document.getElementById('pressureChart');
  graph.ctx = graph.canvas.getContext('2d');
  const canvas = graph.canvas;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    graph.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX });
    graph.dragMoved = false;
    if (graph.pointers.size === 2) {
      const [a, b] = [...graph.pointers.values()];
      graph.pinchStart = {
        dist: Math.abs(a.x - b.x) || 1,
        span: graph.view.end - graph.view.start,
        midT: graphXToTime((a.x + b.x) / 2)
      };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const ptr = graph.pointers.get(e.pointerId);
    if (!ptr) return;
    const dx = e.clientX - ptr.x;
    ptr.x = e.clientX; ptr.y = e.clientY;
    if (Math.abs(e.clientX - ptr.startX) > 6) graph.dragMoved = true;

    if (graph.pointers.size === 2 && graph.pinchStart) {
      graph.dragMoved = true;
      const [a, b] = [...graph.pointers.values()];
      const dist = Math.abs(a.x - b.x) || 1;
      const span = Math.max(GRAPH_MIN_SPAN, graph.pinchStart.span * graph.pinchStart.dist / dist);
      const rect = canvas.getBoundingClientRect();
      const midFrac = ((a.x + b.x) / 2 - rect.left - GRAPH_MARGIN.l) /
                      (rect.width - GRAPH_MARGIN.l - GRAPH_MARGIN.r);
      graph.view.start = graph.pinchStart.midT - span * midFrac;
      graph.view.end = graph.view.start + span;
      graphClearActiveRange();
      graphClampView();
      graphScheduleDraw();
    } else if (graph.pointers.size === 1 && dx !== 0) {
      const rect = canvas.getBoundingClientRect();
      const dt = dx / (rect.width - GRAPH_MARGIN.l - GRAPH_MARGIN.r) * (graph.view.end - graph.view.start);
      graph.view.start -= dt;
      graph.view.end -= dt;
      if (graph.dragMoved) graphClearActiveRange();
      graphClampView();
      graphScheduleDraw();
    }
  });

  const endPointer = (e) => {
    const wasTap = graph.pointers.size === 1 && !graph.dragMoved && graph.pinchStart == null;
    graph.pointers.delete(e.pointerId);
    if (graph.pointers.size < 2) graph.pinchStart = null;
    if (wasTap) {
      const t = graphXToTime(e.clientX);
      graph.cursorT = (graph.cursorT != null && Math.abs(t - graph.cursorT) < (graph.view.end - graph.view.start) * 0.02)
        ? null : t;
      graphScheduleDraw();
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', (e) => { graph.pointers.delete(e.pointerId); graph.pinchStart = null; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    graphZoomAt(graphXToTime(e.clientX), e.deltaY > 0 ? 1.25 : 0.8);
  }, { passive: false });

  document.querySelectorAll('#graph-ranges .range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      graphClearActiveRange();
      btn.classList.add('active');
      graph.cursorT = null;
      graphSetRange(btn.dataset.range === 'all' ? 'all' : parseInt(btn.dataset.range));
    });
  });

  // Legend chips toggle series visibility
  graph.chipEls = {};
  const legend = document.getElementById('graph-legend');
  for (const s of GRAPH_SERIES) {
    const chip = document.createElement('button');
    chip.className = 'legend-chip';
    chip.innerHTML = `<span class="legend-swatch${s.dash.length ? ' dashed' : ''}" style="border-top-color:${s.color}"></span>${s.label}`;
    chip.addEventListener('click', () => {
      graph.hidden[s.key] = !graph.hidden[s.key];
      chip.classList.toggle('off', !!graph.hidden[s.key]);
      graphScheduleDraw();
    });
    legend.appendChild(chip);
    graph.chipEls[s.key] = chip;
  }

  // Valve-event marker toggle (▲ fill / ▼ release, colored by side)
  const evChip = document.createElement('button');
  evChip.className = 'legend-chip';
  evChip.innerHTML = `<span style="color:#2fa84f">&#9650;</span><span style="color:#dc55a8">&#9660;</span>Valves`;
  evChip.addEventListener('click', () => {
    graph.hidden.ev = !graph.hidden.ev;
    evChip.classList.toggle('off', !!graph.hidden.ev);
    graphScheduleDraw();
  });
  legend.appendChild(evChip);
  graph.chipEls.ev = evChip;

  window.addEventListener('resize', () => {
    if (ui.graphModal.style.display === "block") graphScheduleDraw();
  });
}

// onlyKeys: array of series keys (+ 'ev') to show, or null for everything
function openGraph(onlyKeys) {
  initGraph();
  loadHistory();
  loadEvents();
  const allKeys = GRAPH_SERIES.map(s => s.key).concat('ev');
  graph.hidden = {};
  if (onlyKeys) {
    for (const k of allKeys) graph.hidden[k] = !onlyKeys.includes(k);
  }
  for (const k of allKeys) {
    if (graph.chipEls[k]) graph.chipEls[k].classList.toggle('off', !!graph.hidden[k]);
  }
  ui.graphModal.style.display = "block";
  graph.cursorT = null;
  const ext = graphExtent();
  graphClearActiveRange();
  if (ext && ext.end - ext.start > 86400000) {
    document.querySelector('#graph-ranges .range-btn[data-range="86400"]').classList.add('active');
    graphSetRange(86400);
  } else {
    document.querySelector('#graph-ranges .range-btn[data-range="all"]').classList.add('active');
    graphSetRange('all');
  }
}

ui.btnGraph.addEventListener('click', () => openGraph(null));

// Tapping the tank card opens a tank-only graph
document.querySelector('.tank-container').addEventListener('click', () => {
  if (document.body.classList.contains('disconnected')) return;
  openGraph(['tk']);
});

ui.btnCloseGraph.addEventListener('click', () => {
   ui.graphModal.style.display = "none";
});

// -- EVENT LOG UI --
ui.btnLogs.addEventListener('click', () => {
  loadEvents();
  renderEventLog();
  ui.logsModal.style.display = "block";
});

ui.btnCloseLogs.addEventListener('click', () => {
  ui.logsModal.style.display = "none";
});

ui.btnStats.addEventListener('click', async () => {
  if (!cmdCharacteristic) return;
  try {
    await cmdCharacteristic.writeValue(new TextEncoder('utf-8').encode("STATS"));
  } catch(e) {
    console.error("Stats request failed", e);
  }
});

// -- SEND LOGS TO CLAUDE --
// Compiles a diagnostic report and opens it as a pre-filled GitHub issue
// on the repo. One tap + Submit; Claude reads and analyzes it from there.
let statsForReport = false;

function buildDiagnosticsReport() {
  const lines = [];
  lines.push(`Generated: ${new Date().toString()}`);
  lines.push(`Firmware: ${deviceFwVersion ? 'v' + deviceFwVersion : 'unknown'} | Mode: ${modeInfo ? (modeInfo.daily ? 'DAILY (target ' + modeInfo.target + ' PSI, ' + modeInfo.status + ')' : 'TOW') : 'unknown'} | Connected: ${!!cmdCharacteristic}`);
  lines.push(`Live PSI: L=${liveL ?? '-'} R=${liveR ?? '-'} Tank=${liveTk ?? '-'}`);
  let stats = null;
  try { stats = localStorage.getItem('lastStats'); } catch(_) {}
  lines.push(`Valve counters (lifetime): ${stats || 'not captured yet'}`);
  const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  lines.push(`AutoConnect: api=${!!(navigator.bluetooth && navigator.bluetooth.getDevices)} savedDevices=${lastSavedDeviceCount ?? '?'} standalone=${standalone} failStreak=${autoFailStreak} last="${lastAutoResult}"`);
  let info = null, infoAge = '';
  try {
    info = localStorage.getItem('lastInfo');
    const at = parseInt(localStorage.getItem('lastInfoAt')) || 0;
    if (at) infoAge = ` (captured ${Math.round((Date.now() - at) / 60000)}min ago)`;
  } catch(_) {}
  lines.push(`Device: ${info ? info + infoAge : 'not captured (fw < 2.3.4 or not connected)'}`);
  const newestRow = historyData.length ? new Date(historyData[historyData.length - 1].t).toISOString() : 'none';
  let lastDev = 0;
  try { lastDev = parseInt(localStorage.getItem('lastDeviceEpoch')) || 0; } catch(_) {}
  lines.push(`Sync: newestRow=${newestRow} lastDeviceSync=${lastDev ? new Date(lastDev * 1000).toISOString() : 'never'} phase=${syncPhase || 'idle'}`);

  const wk = Date.now() - 7 * 86400000;
  const ev7 = eventData.filter(e => e.t >= wk);
  const count = pfx => ev7.filter(e => e.code.startsWith(pfx)).length;
  const reboots = {};
  ev7.filter(e => e.code.startsWith('BOOT')).forEach(e => {
    const r = e.code.split(':')[1] || '?';
    reboots[r] = (reboots[r] || 0) + 1;
  });
  lines.push(`Last 7d: fillsL=${count('DFILLL') + count('TFILLL')} fillsR=${count('DFILLR') + count('TFILLR')} deflates=${count('DDEFL') + count('TDEFL')} cappedFills=${count('DFILLCAP')} warnings=${count('WARN')} dumps=${count('DUMP')}`);
  lines.push(`Reboots last 7d by reason: ${Object.keys(reboots).length ? Object.entries(reboots).map(([k, v]) => `${k}=${v}`).join(' ') : 'none'}`);

  const day = Date.now() - 86400000;
  const rows24 = historyData.filter(p => p.t >= day).length;
  lines.push(`History rows last 24h: ${rows24} (~1440 = continuous logging)`);
  lines.push('');
  lines.push('Recent events (newest first):');
  lines.push('```');
  const ev = eventData.slice(-150).reverse();
  for (const e of ev) lines.push(`${new Date(e.t).toISOString()} ${e.code}`);
  lines.push('```');

  // Fit within GitHub's URL limits by trimming the oldest events
  let body = lines.join('\n');
  while (encodeURIComponent(body).length > 5800 && lines.length > 12) {
    lines.splice(lines.length - 2, 1); // keep the closing ```
    body = lines.join('\n');
  }
  return body;
}

async function sendLogsToClaude() {
  // If a history/event sync is mid-flight, give it up to 20s to land so the
  // report reflects synced data instead of a half-empty archive
  for (let i = 0; i < 20 && syncPhase; i++) {
    await new Promise(r => setTimeout(r, 1000));
  }
  // Grab fresh valve counters + device internals first if we're connected
  if (cmdCharacteristic) {
    try {
      statsForReport = true;
      await cmdCharacteristic.writeValue(new TextEncoder('utf-8').encode("STATS"));
      await new Promise(r => setTimeout(r, 1200));
      await cmdCharacteristic.writeValue(new TextEncoder('utf-8').encode("INFO"));
      await new Promise(r => setTimeout(r, 1200));
    } catch(_) {}
    statsForReport = false;
  }
  const title = `Diagnostics report ${new Date().toISOString().substring(0, 16).replace('T', ' ')}`;
  const url = `https://github.com/${GITHUB_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(buildDiagnosticsReport())}`;
  window.open(url, '_blank');
}

document.getElementById('btn-send-logs').addEventListener('click', sendLogsToClaude);

window.addEventListener('click', (event) => {
  if (event.target == ui.graphModal) {
    ui.graphModal.style.display = "none";
  }
  if (event.target == ui.wifiModal) {
    ui.wifiModal.style.display = "none";
  }
  if (event.target == ui.logsModal) {
    ui.logsModal.style.display = "none";
  }
});
