let activeLoginTabId = null;
let activeLoginStartedAt = 0;
const loginTabIds = new Set();

const ALARM_NAME = "abes-wifi-reconnect";
const DEFAULT_TARGET_SSID = "ABESEC";
const DEFAULT_INTERVAL_MINUTES = 120;

// The login page itself is opened over HTTPS (as in v4.2).
const PORTAL_LOGIN_URL = "https://192.168.1.254:8090/";

// Network detection uses plain HTTP: it needs no certificate, so a reply from
// the portal is enough to know we are on the college network.
const PORTAL_PROBE_URL = "http://192.168.1.254:8090/";
const PROBE_TIMEOUT_MS = 12000; // the portal can be slow, so wait long
const PROBE_ATTEMPTS = 2;       // "not on college Wi-Fi" only after every attempt fails
const PROBE_RETRY_DELAY_MS = 2000;
const STATUS_CACHE_MS = 5000;   // reuse a fresh result (popup + Connect Now back to back)
const STALE_LOGIN_TAB_MS = 90000;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await chrome.storage.local.remove("detectionMode"); // old v4.2 setting
  await applySchedule(false);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await applySchedule(false);
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

  if (message.type === "requestWifiStatus") {
    checkCollegeNetwork().then(sendResponse);
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

  // The timer keeps running everywhere. Away from college Wi-Fi this tick is
  // simply skipped, and login resumes by itself once the portal is reachable.
  const state = await checkCollegeNetwork();
  if (state.wifiActive) await startLogin(false);
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
    "intervalMinutes"
  ]);

  await chrome.storage.local.set({
    targetSSID: data.targetSSID || DEFAULT_TARGET_SSID,
    username: data.username || "",
    password: data.password || "",
    autoReconnect: Boolean(data.autoReconnect),
    intervalMinutes:
      Number(data.intervalMinutes) > 0 ? Number(data.intervalMinutes) : DEFAULT_INTERVAL_MINUTES
  });
}

/* ---------- College network detection ---------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probePortalOnce() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    // no-cors: we only care that the portal answered, not about its content.
    // (Do not add redirect: "manual" here, browsers reject it with no-cors.)
    await fetch(PORTAL_PROBE_URL, {
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let statusInFlight = null;
let statusCache = null;

function checkCollegeNetwork() {
  if (statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) {
    return Promise.resolve(statusCache.state);
  }
  if (statusInFlight) return statusInFlight;

  statusInFlight = (async () => {
    let active = false;

    for (let attempt = 0; attempt < PROBE_ATTEMPTS && !active; attempt++) {
      if (attempt > 0) await sleep(PROBE_RETRY_DELAY_MS);
      active = await probePortalOnce();
    }

    // wifiSSID stays empty: the popup then shows the SSID typed in settings.
    const state = { wifiActive: active, wifiSSID: "" };
    await chrome.storage.local.set(state);
    statusCache = { at: Date.now(), state };
    return state;
  })().finally(() => {
    statusInFlight = null;
  });

  return statusInFlight;
}

/* ---------- Schedule ---------- */

async function applySchedule(resetTimer) {
  const { autoReconnect, intervalMinutes } =
    await chrome.storage.local.get(["autoReconnect", "intervalMinutes"]);
  const mins = Number(intervalMinutes);

  if (!autoReconnect || !Number.isFinite(mins) || mins <= 0) {
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
  await applySchedule(true);
  return true;
}

async function handleSettingsChanged() {
  await ensureDefaults();
  await applySchedule(true); // quick, so the popup can show the next run right away
  return checkCollegeNetwork();
}

/* ---------- Login ---------- */

async function connectNow() {
  const state = await checkCollegeNetwork();

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

      // A recent login tab is still working: do not open a second one.
      if (Date.now() - activeLoginStartedAt < STALE_LOGIN_TAB_MS) return;

      // An old login tab never finished (for example a certificate warning
      // page). Close it so it cannot block every later login.
      try {
        await chrome.tabs.remove(activeLoginTabId);
      } catch {
        // Already closed.
      }
    } catch {
      // Tab no longer exists.
    }

    loginTabIds.delete(activeLoginTabId);
    activeLoginTabId = null;
  }

  const tab = await chrome.tabs.create({
    url: PORTAL_LOGIN_URL,
    active: false
  });
  activeLoginTabId = tab.id;
  activeLoginStartedAt = Date.now();
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
