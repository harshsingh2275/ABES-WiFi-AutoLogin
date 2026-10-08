const targetSSIDInput = document.getElementById("targetSSID");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const autoReconnect = document.getElementById("autoReconnect");
const intervalValue = document.getElementById("intervalValue");
const intervalUnit = document.getElementById("intervalUnit");
const networkStatus = document.getElementById("networkStatus");
const saveButton = document.getElementById("save");
const connectButton = document.getElementById("connect");
const status = document.getElementById("status");
const nextRun = document.getElementById("nextRun");

const ALARM_NAME = "abes-wifi-reconnect";

async function loadSettings() {
  // Settings are read straight from storage, so the form fills instantly
  // even if the college portal check takes a while to finish.
  const data = await chrome.storage.local.get([
    "targetSSID",
    "username",
    "password",
    "autoReconnect",
    "intervalMinutes"
  ]);

  targetSSIDInput.value = data.targetSSID || "ABESEC";
  usernameInput.value = data.username || "";
  passwordInput.value = data.password || "";
  autoReconnect.checked = Boolean(data.autoReconnect);

  const minutes = Number(data.intervalMinutes) || 120;
  if (minutes % 60 === 0) {
    intervalUnit.value = "hours";
    intervalValue.value = minutes / 60;
  } else {
    intervalUnit.value = "minutes";
    intervalValue.value = minutes;
  }

  await refreshNextRun();

  showChecking();
  await refreshWifiStatus("requestWifiStatus");
  await refreshNextRun();
}

async function refreshWifiStatus(messageType) {
  try {
    const state = await chrome.runtime.sendMessage({ type: messageType });
    updateNetworkStatus(Boolean(state?.wifiActive), state?.wifiSSID || "", state?.error || "");
  } catch (error) {
    console.error("ABES Auto Login: Wi-Fi status request failed", error);
    updateNetworkStatus(false, "", "unavailable");
  }
}

function showChecking() {
  networkStatus.textContent = "Checking college network...";
  networkStatus.className = "network-status checking";
}

function updateNetworkStatus(active, ssid, error = "") {
  const target = targetSSIDInput.value.trim() || "ABESEC";

  if (active) {
    networkStatus.textContent = `${ssid || target} detected • ACTIVE`;
    networkStatus.className = "network-status active";
  } else if (ssid) {
    networkStatus.textContent = `${ssid} • SLEEP MODE`;
    networkStatus.className = "network-status sleeping";
  } else if (error) {
    networkStatus.textContent = "Wi-Fi status unavailable • SLEEP MODE";
    networkStatus.className = "network-status sleeping";
  } else {
    networkStatus.textContent = "College Wi-Fi not detected • SLEEP MODE";
    networkStatus.className = "network-status sleeping";
  }
}

function getIntervalMinutes() {
  const value = Number(intervalValue.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const minutes = intervalUnit.value === "hours" ? value * 60 : value;
  return minutes >= 1 ? minutes : null;
}

async function saveSettings(showMessage = true, message = "Settings saved.") {
  const targetSSID = targetSSIDInput.value.trim();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const intervalMinutes = getIntervalMinutes();

  if (!targetSSID) {
    showStatus("Enter the college Wi-Fi SSID.", true);
    return false;
  }
  if (!username || !password) {
    showStatus("Enter both username and password.", true);
    return false;
  }
  if (!intervalMinutes) {
    showStatus("Enter a valid reconnect interval.", true);
    return false;
  }

  await chrome.storage.local.set({
    targetSSID,
    username,
    password,
    autoReconnect: autoReconnect.checked,
    intervalMinutes
  });

  // Confirm right away; the network re-check below can take a few seconds.
  if (showMessage) showStatus(message);

  showChecking();
  await refreshWifiStatus("settingsChanged");
  await refreshNextRun();

  return true;
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.className = isError ? "error" : "success";
}

async function refreshNextRun() {
  const alarm = await chrome.alarms.get(ALARM_NAME);

  if (!autoReconnect.checked || !alarm?.scheduledTime) {
    nextRun.textContent = "Auto reconnect is off or sleeping";
    return;
  }

  nextRun.textContent = `Next login check: ${new Date(alarm.scheduledTime).toLocaleString()}`;
}

saveButton.addEventListener("click", () => saveSettings(true));

autoReconnect.addEventListener("change", () => {
  saveSettings(true, "Auto reconnect updated.");
});

targetSSIDInput.addEventListener("change", () => {
  saveSettings(true, "SSID updated.");
});

connectButton.addEventListener("click", async () => {
  const ok = await saveSettings(false);
  if (!ok) return;

  const result = await chrome.runtime.sendMessage({ type: "connectNow" });
  if (result?.ok) {
    showStatus("Login started in the background.");
  } else {
    showStatus(result?.message || "College Wi-Fi is not active.", true);
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.wifiActive || changes.wifiSSID) {
    chrome.storage.local.get(["wifiActive", "wifiSSID"]).then((state) => {
      updateNetworkStatus(Boolean(state.wifiActive), state.wifiSSID || "");
      refreshNextRun();
    });
  }
});

// While the popup is open, re-check the network by itself so switching Wi-Fi
// updates the status without reopening the popup. Nothing runs once it closes.
let statusRefreshing = false;

async function silentStatusRefresh() {
  if (statusRefreshing) return;
  statusRefreshing = true;
  try {
    await refreshWifiStatus("requestWifiStatus");
  } finally {
    statusRefreshing = false;
  }
}

window.addEventListener("online", silentStatusRefresh);
window.addEventListener("offline", silentStatusRefresh);
setInterval(silentStatusRefresh, 10000);

loadSettings();
setInterval(refreshNextRun, 1000);
