const VERSION = "0.5.2";
const YOUTUBE_WATCH_RE = /^https:\/\/(www\.)?youtube\.com\/watch\b|^https:\/\/youtube\.com\/watch\b/;

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  els.status = document.querySelector("[data-status]");
  els.details = document.querySelector("[data-details]");
  els.open = document.querySelector("[data-open]");
  els.close = document.querySelector("[data-close]");
  els.toggle = document.querySelector("[data-toggle]");

  els.open.addEventListener("click", () => runCommand("YLD_PANEL_SHOW"));
  els.close.addEventListener("click", () => runCommand("YLD_PANEL_HIDE"));
  els.toggle.addEventListener("click", () => runCommand("YLD_PANEL_TOGGLE"));

  refreshStatus();
});

async function refreshStatus() {
  try {
    const tab = await getActiveTab();
    if (!isYouTubeWatchTab(tab)) {
      setUnavailable("Open a YouTube watch page first.");
      return;
    }

    const response = await sendPanelMessage(tab.id, "YLD_PANEL_STATUS", true);
    renderStatus(response.payload);
  } catch (error) {
    setError(error.message || String(error));
  }
}

async function runCommand(type) {
  setBusy("working");
  try {
    const tab = await getActiveTab();
    if (!isYouTubeWatchTab(tab)) {
      setUnavailable("Open a YouTube watch page first.");
      return;
    }

    const response = await sendPanelMessage(tab.id, type, true);
    renderStatus(response.payload);
  } catch (error) {
    setError(error.message || String(error));
  }
}

async function sendPanelMessage(tabId, type, allowInject) {
  try {
    const response = await tabsSendMessage(tabId, { type });
    if (!response || !response.ok) {
      throw new Error(response?.error || "Panel did not respond.");
    }
    return response;
  } catch (error) {
    if (!allowInject || !String(error.message || "").includes("Receiving end does not exist")) {
      throw error;
    }
    await injectContent(tabId);
    await delay(250);
    return sendPanelMessage(tabId, type, false);
  }
}

async function injectContent(tabId) {
  await scriptingInsertCSS(tabId, "content.css").catch(() => {});
  await scriptingExecuteScript(tabId, "content.js");
}

function renderStatus(payload = {}) {
  setButtonsEnabled(true);
  els.status.classList.remove("error");
  els.status.textContent = payload.visible ? "visible" : "hidden";
  els.details.innerHTML = [
    `<strong>Panel:</strong> ${escapeHtml(payload.visible ? "open" : "closed")}`,
    `<strong>Dub:</strong> ${escapeHtml(payload.status || "idle")}`,
    `<strong>Video:</strong> ${escapeHtml(payload.videoId || "unknown")}`,
    `<strong>Version:</strong> ${escapeHtml(payload.version || VERSION)}`,
  ].map((line) => `<div>${line}</div>`).join("");
}

function setUnavailable(message) {
  setButtonsEnabled(false);
  els.status.classList.remove("error");
  els.status.textContent = "no tab";
  els.details.textContent = message;
}

function setBusy(label) {
  setButtonsEnabled(false);
  els.status.classList.remove("error");
  els.status.textContent = label;
}

function setError(message) {
  setButtonsEnabled(true);
  els.status.classList.add("error");
  els.status.textContent = "error";
  els.details.textContent = message;
}

function setButtonsEnabled(enabled) {
  els.open.disabled = !enabled;
  els.close.disabled = !enabled;
  els.toggle.disabled = !enabled;
}

async function getActiveTab() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    throw new Error("Active tab was not found.");
  }
  return tab;
}

function isYouTubeWatchTab(tab) {
  return YOUTUBE_WATCH_RE.test(String(tab?.url || ""));
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function scriptingInsertCSS(tabId, file) {
  return new Promise((resolve, reject) => {
    chrome.scripting.insertCSS({ target: { tabId }, files: [file] }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function scriptingExecuteScript(tabId, file) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: [file] }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
