let activeLoginTabId = null;
const loginTabIds = new Set();
let nativePort = null;
let nativeReconnectTimer = null;
const pendingWifiRequests = [];

const ALARM_NAME = "abes-wifi-reconnect";
const NATIVE_HOST = "com.abes.wifi.autologin";
const DEFAULT_TARGET_SSID = "ABESEC";
const DEFAULT_INTERVAL_MINUTES = 120;
const DEFAULT_MODE = "battery";

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await configureDetectionMode();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await configureDetectionMode();
  await requestFreshWifiStatus();
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderUrl = sender.url || "";
  const isPortalSender = senderUrl.startsWith("https://192.168.1.254:8090/");

  if ((message.type === "submitLogin" || message.type === "loginSuccess") && !isPortalSender) {
    sendResponse({ ok: false, message: "Untrusted message source." });
    return false;
  }
  if (message.type === "connectNow") {
    connectNow().then(sendResponse);
    return true;
  }

  if (message.type === "settingsChanged") {
    handleSettingsChanged().then(sendResponse);
    return true;
  }

  if (message.type === "setDetectionMode") {
    setDetectionMode(message.mode).then(sendResponse);
    return true;
  }

  if (message.type === "requestWifiStatus") {
    getExtensionState().then(sendResponse);
    return true;
  }

  if (message.type === "loginSuccess" && sender.tab?.id) {
    closeLoginTabs(sender.tab.id);
    resetNextAlarm().then(sendResponse);
    return true;
  }

  if (message.type === "submitLogin" && sender.tab?.id) {
    submitPortalLogin(sender.tab.id).then(sendResponse);
    return true;
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const state = await requestFreshWifiStatus();
  if (state.wifiActive) {
    await startLogin(false);
  } else {
    await chrome.alarms.clear(ALARM_NAME);
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId !== undefined && loginTabIds.has(tab.openerTabId) && tab.id !== undefined) {
    loginTabIds.add(tab.id);

    if (isAbesWebsite(tab.url || "")) {
      closeLoginTabs(tab.id);
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!loginTabIds.has(tabId)) return;
  if (isAbesWebsite(tab.url || "")) closeLoginTabs(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  loginTabIds.delete(tabId);
  if (tabId === activeLoginTabId) activeLoginTabId = null;
});

async function ensureDefaults() {
  const data = await chrome.storage.local.get([
    "targetSSID",
    "username",
    "password",
    "autoReconnect",
    "intervalMinutes",
    "detectionMode"
  ]);

  await chrome.storage.local.set({
    targetSSID: data.targetSSID || DEFAULT_TARGET_SSID,
    username: data.username || "",
    password: data.password || "",
    autoReconnect: Boolean(data.autoReconnect),
    intervalMinutes:
      Number(data.intervalMinutes) > 0 ? Number(data.intervalMinutes) : DEFAULT_INTERVAL_MINUTES,
    detectionMode:
      data.detectionMode === "realtime" || data.detectionMode === "battery"
        ? data.detectionMode
        : DEFAULT_MODE
  });
}

async function configureDetectionMode() {
  const { detectionMode = DEFAULT_MODE } =
    await chrome.storage.local.get(["detectionMode"]);

  if (detectionMode === "realtime") {
    await ensurePersistentNativeConnection();
  } else {
    disconnectPersistentNative();
  }

  return requestFreshWifiStatus();
}

async function ensurePersistentNativeConnection() {
  if (nativePort) return true;
  if (nativeReconnectTimer) return false;

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);

    nativePort.onMessage.addListener((message) => {
      if (message?.type === "wifiStatus") processWifiStatus(message);
    });

    nativePort.onDisconnect.addListener(async () => {
      nativePort = null;

      // Fail safe: never keep an old ACTIVE state after the native helper dies.
      await setWifiState(false, "");

      while (pendingWifiRequests.length) {
        pendingWifiRequests.shift().resolve({
          wifiActive: false,
          wifiSSID: "",
          error: "Wi-Fi helper disconnected"
        });
      }

      const { detectionMode = DEFAULT_MODE } =
        await chrome.storage.local.get(["detectionMode"]);

      if (detectionMode === "realtime") scheduleNativeReconnect();
    });

    const { targetSSID = DEFAULT_TARGET_SSID } =
      await chrome.storage.local.get(["targetSSID"]);

    nativePort.postMessage({
      command: "startWatch",
      targetSSID
    });

    return true;
  } catch (error) {
    console.error("ABES Auto Login: Native connection failed", error);
    nativePort = null;
    scheduleNativeReconnect();
    return false;
  }
}

function disconnectPersistentNative() {
  if (nativeReconnectTimer) {
    clearTimeout(nativeReconnectTimer);
    nativeReconnectTimer = null;
  }

  if (nativePort) {
    try {
      nativePort.disconnect();
    } catch {
      // Already disconnected.
    }
    nativePort = null;
  }

  while (pendingWifiRequests.length) {
    pendingWifiRequests.shift().resolve(getStoredWifiState());
  }
}

function scheduleNativeReconnect() {
  if (nativeReconnectTimer) return;

  nativeReconnectTimer = setTimeout(async () => {
    nativeReconnectTimer = null;
    const { detectionMode = DEFAULT_MODE } =
      await chrome.storage.local.get(["detectionMode"]);
    if (detectionMode === "realtime") await ensurePersistentNativeConnection();
  }, 3000);
}

async function getExtensionState() {
  const settings = await chrome.storage.local.get([
    "targetSSID",
    "username",
    "password",
    "detectionMode",
    "autoReconnect",
    "intervalMinutes"
  ]);

  const fresh = await requestFreshWifiStatus();

  return {
    ...settings,
    detectionMode: settings.detectionMode === "realtime" ? "realtime" : "battery",
    wifiActive: Boolean(fresh.wifiActive),
    wifiSSID: fresh.wifiSSID || ""
  };
}

async function requestFreshWifiStatus() {
  const {
    detectionMode = DEFAULT_MODE,
    targetSSID = DEFAULT_TARGET_SSID
  } = await chrome.storage.local.get(["detectionMode", "targetSSID"]);

  if (detectionMode === "realtime") {
    const connected = await ensurePersistentNativeConnection();
    if (!connected || !nativePort) {
      return { wifiActive: false, wifiSSID: "", error: "Wi-Fi helper unavailable" };
    }

    return new Promise((resolve) => {
      const pending = { resolve };
      pendingWifiRequests.push(pending);

      try {
        nativePort.postMessage({
          command: "getStatus",
          targetSSID
        });
      } catch {
        const index = pendingWifiRequests.indexOf(pending);
        if (index >= 0) pendingWifiRequests.splice(index, 1);
        resolve({ wifiActive: false, wifiSSID: "", error: "Wi-Fi helper unavailable" });
        return;
      }

      setTimeout(async () => {
        const index = pendingWifiRequests.indexOf(pending);
        if (index >= 0) {
          pendingWifiRequests.splice(index, 1);
          resolve({ wifiActive: false, wifiSSID: "", error: "Wi-Fi status request timed out" });
        }
      }, 2500);
    });
  }

  try {
    const message = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      command: "getStatusOnce",
      targetSSID
    });

    if (message?.type === "wifiStatus") {
      await processWifiStatus(message);
      return {
        wifiActive: Boolean(message.active),
        wifiSSID: message.ssid || ""
      };
    }
  } catch (error) {
    console.error("ABES Auto Login: One-shot Wi-Fi check failed", error);
    return { wifiActive: false, wifiSSID: "", error: "Wi-Fi helper unavailable" };
  }

  return { wifiActive: false, wifiSSID: "", error: "Wi-Fi status unavailable" };
}

async function setWifiState(wifiActive, wifiSSID) {
  const previous = await chrome.storage.local.get(["wifiActive"]);
  await chrome.storage.local.set({
    wifiActive: Boolean(wifiActive),
    wifiSSID: wifiSSID || ""
  });
  await syncSchedule(Boolean(wifiActive), Boolean(previous.wifiActive));
}

async function processWifiStatus(message) {
  const wifiActive = Boolean(message.active);
  const wifiSSID = message.ssid || "";

  await setWifiState(wifiActive, wifiSSID);

  while (pendingWifiRequests.length) {
    pendingWifiRequests.shift().resolve({
      wifiActive,
      wifiSSID
    });
  }
}

async function getStoredWifiState() {
  const data = await chrome.storage.local.get(["wifiActive", "wifiSSID"]);
  return {
    wifiActive: Boolean(data.wifiActive),
    wifiSSID: data.wifiSSID || ""
  };
}

async function setDetectionMode(mode) {
  const normalized = mode === "realtime" ? "realtime" : "battery";

  // Persist first. The storage change listener also reinforces this state
  // if the service worker is later restarted.
  await chrome.storage.local.set({ detectionMode: normalized });
  await configureDetectionMode();

  return requestFreshWifiStatus();
}

async function handleSettingsChanged() {
  await ensureDefaults();

  const { detectionMode = DEFAULT_MODE, targetSSID = DEFAULT_TARGET_SSID } =
    await chrome.storage.local.get(["detectionMode", "targetSSID"]);

  if (detectionMode === "realtime") {
    await ensurePersistentNativeConnection();
    if (nativePort) {
      try {
        nativePort.postMessage({
          command: "setTargetSSID",
          targetSSID
        });
      } catch {
        // Reconnect handler will repair the port if needed.
      }
    }
  } else {
    disconnectPersistentNative();
  }

  const state = await requestFreshWifiStatus();
  await applyScheduleFromCurrentState(true);
  return state;
}

async function syncSchedule(wifiActive, previousActive) {
  const { autoReconnect, intervalMinutes } =
    await chrome.storage.local.get(["autoReconnect", "intervalMinutes"]);
  const mins = Number(intervalMinutes);

  if (!autoReconnect || !Number.isFinite(mins) || mins <= 0 || !wifiActive) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  const existing = await chrome.alarms.get(ALARM_NAME);
  const connectionBecameActive = wifiActive && !previousActive;

  if (connectionBecameActive || !existing) {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: mins,
      periodInMinutes: mins,
      persistAcrossSessions: true
    });
  }
}

async function applyScheduleFromCurrentState(resetTimer) {
  const state = await getStoredWifiState();
  const { autoReconnect, intervalMinutes } =
    await chrome.storage.local.get(["autoReconnect", "intervalMinutes"]);
  const mins = Number(intervalMinutes);

  if (!autoReconnect || !state.wifiActive || !Number.isFinite(mins) || mins <= 0) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  if (resetTimer) await chrome.alarms.clear(ALARM_NAME);

  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: mins,
      periodInMinutes: mins,
      persistAcrossSessions: true
    });
  }
}

async function resetNextAlarm() {
  await applyScheduleFromCurrentState(true);
  return true;
}

async function connectNow() {
  const state = await requestFreshWifiStatus();

  if (!state.wifiActive) {
    return {
      ok: false,
      message: "College Wi-Fi is not active. Auto login is sleeping.",
      wifiSSID: state.wifiSSID
    };
  }

  await startLogin(true);
  return {
    ok: true,
    message: "Login started in the background.",
    wifiSSID: state.wifiSSID
  };
}

async function startLogin(manual) {
  if (activeLoginTabId !== null) {
    try {
      await chrome.tabs.get(activeLoginTabId);
      return;
    } catch {
      activeLoginTabId = null;
    }
  }

  const tab = await chrome.tabs.create({
    url: "https://192.168.1.254:8090/",
    active: false
  });
  activeLoginTabId = tab.id;
  loginTabIds.add(tab.id);

  if (manual) console.log("ABES Auto Login: manual login started");
}

async function submitPortalLogin(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        if (typeof window.submitRequest === "function") {
          window.submitRequest();
          return "submitted";
        }

        const button = document.getElementById("loginbutton");
        if (button) {
          button.click();
          return "clicked";
        }
        return "login-control-not-found";
      }
    });
    return true;
  } catch (error) {
    console.error("ABES Auto Login submit error:", error);
    return false;
  }
}

async function closeLoginTabs(successTabId) {
  if (successTabId !== undefined && successTabId !== null) {
    loginTabIds.add(successTabId);
  }

  const idsToClose = new Set(loginTabIds);

  setTimeout(async () => {
    for (const tabId of idsToClose) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // Already closed.
      }
      loginTabIds.delete(tabId);
    }

    activeLoginTabId = null;
  }, 800);
}

function isAbesWebsite(url) {
  return (
    url.startsWith("https://www.abes.ac.in/") ||
    url.startsWith("http://www.abes.ac.in/")
  );
}
