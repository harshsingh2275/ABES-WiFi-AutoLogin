const targetSSIDInput = document.getElementById("targetSSID");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const realtimeMode = document.getElementById("realtimeMode");
const batteryMode = document.getElementById("batteryMode");
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
  const data = await chrome.runtime.sendMessage({ type: "requestWifiStatus" });

  targetSSIDInput.value = data?.targetSSID || "ABESEC";
  usernameInput.value = data?.username || "";
  passwordInput.value = data?.password || "";
  autoReconnect.checked = Boolean(data?.autoReconnect);

  const mode = data?.detectionMode === "realtime" ? "realtime" : "battery";
  realtimeMode.checked = mode === "realtime";
  batteryMode.checked = mode === "battery";

  const minutes = Number(data?.intervalMinutes) || 120;
  if (minutes % 60 === 0) {
    intervalUnit.value = "hours";
    intervalValue.value = minutes / 60;
  } else {
    intervalUnit.value = "minutes";
    intervalValue.value = minutes;
  }

  updateNetworkStatus(Boolean(data?.wifiActive), data?.wifiSSID || "", data?.error || "");
  await refreshNextRun();
}

function selectedMode() {
  return realtimeMode.checked ? "realtime" : "battery";
}

function updateNetworkStatus(active, ssid, error = "") {
  const target = targetSSIDInput.value.trim() || "ABESEC";

  if (active) {
    networkStatus.textContent = `● ${ssid || target} detected • ACTIVE`;
    networkStatus.className = "network-status active";
  } else if (ssid) {
    networkStatus.textContent = `○ ${ssid} • SLEEP MODE`;
    networkStatus.className = "network-status sleeping";
  } else if (error) {
    networkStatus.textContent = "○ Wi-Fi status unavailable • SLEEP MODE";
    networkStatus.className = "network-status sleeping";
  } else {
    networkStatus.textContent = "○ College Wi-Fi not detected • SLEEP MODE";
    networkStatus.className = "network-status sleeping";
  }
}

function getIntervalMinutes() {
  const value = Number(intervalValue.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const minutes = intervalUnit.value === "hours" ? value * 60 : value;
  return minutes >= 1 ? minutes : null;
}

async function saveSettings(showMessage = true) {
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
    detectionMode: selectedMode(),
    autoReconnect: autoReconnect.checked,
    intervalMinutes
  });

  const state = await chrome.runtime.sendMessage({ type: "settingsChanged" });
  if (state) updateNetworkStatus(Boolean(state.wifiActive), state.wifiSSID || "", state.error || "");

  await refreshNextRun();

  if (showMessage) showStatus("Settings saved.");
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

[realtimeMode, batteryMode].forEach((element) => {
  element.addEventListener("change", async () => {
    const mode = selectedMode();

    try {
      const result = await chrome.runtime.sendMessage({
        type: "setDetectionMode",
        mode
      });

      if (result) {
        updateNetworkStatus(Boolean(result.wifiActive), result.wifiSSID || "", result.error || "");
      }

      showStatus(
        mode === "realtime"
          ? "Real-Time mode enabled."
          : "Battery Saver mode enabled."
      );
      await refreshNextRun();
    } catch (error) {
      console.error("ABES Auto Login: Mode update failed", error);
      showStatus("Could not change detection mode.", true);
    }
  });
});

autoReconnect.addEventListener("change", async () => {
  const ok = await saveSettings(false);
  if (ok) showStatus("Auto reconnect updated.");
});

targetSSIDInput.addEventListener("change", async () => {
  const ok = await saveSettings(false);
  if (ok) showStatus("SSID updated.");
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

loadSettings();
setInterval(refreshNextRun, 1000);
