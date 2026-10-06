async function getCredentials() {
  return chrome.storage.local.get(["username", "password"]);
}

function setInputValue(input, value) {
  const prototype = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

  if (descriptor?.set) descriptor.set.call(input, value);
  else input.value = value;

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function portalShowsSuccess() {
  const text = document.body?.innerText || "";
  return text.includes("You are signed in as") || text.includes("You are signed in");
}

function watchForSuccess() {
  const started = Date.now();
  const timer = setInterval(() => {
    if (portalShowsSuccess()) {
      clearInterval(timer);
      chrome.runtime.sendMessage({ type: "loginSuccess" });
      return;
    }

    if (Date.now() - started > 20000) clearInterval(timer);
  }, 300);
}

async function fillAndSubmit() {
  const usernameInput = document.getElementById("username");
  const passwordInput = document.getElementById("password");

  if (!usernameInput || !passwordInput) return;

  const { username, password } = await getCredentials();
  if (!username || !password) return;

  setInputValue(usernameInput, username);
  setInputValue(passwordInput, password);
  watchForSuccess();

  setTimeout(() => {
    chrome.runtime.sendMessage({ type: "submitLogin" });
  }, 500);
}

fillAndSubmit();
