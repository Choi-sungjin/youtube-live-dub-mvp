const VERSION = chrome.runtime.getManifest().version;
const YOUTUBE_WATCH_RE = /^https:\/\/(www\.)?youtube\.com\/watch\b|^https:\/\/youtube\.com\/watch\b/;

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  document.querySelector("[data-version]").textContent = `v${VERSION}`;
  els.status = document.querySelector("[data-status]");
  els.details = document.querySelector("[data-details]");
  els.open = document.querySelector("[data-open]");
  els.close = document.querySelector("[data-close]");
  els.toggle = document.querySelector("[data-toggle]");

  els.open.addEventListener("click", () => runCommand("YLD_PANEL_SHOW"));
  els.close.addEventListener("click", () => runCommand("YLD_PANEL_HIDE"));
  els.toggle.addEventListener("click", () => runCommand("YLD_PANEL_TOGGLE"));
  document.querySelector('[data-player]').onclick = () => openLocalPlayer();
  document.querySelector('[data-find-video]').onclick = findPageVideos;

  refreshStatus();
});

async function openLocalPlayer(url = '') {
  const target = `http://127.0.0.1:18789/player${url ? '#url=' + encodeURIComponent(url) : ''}`;
  await chrome.tabs.create({ url: target });
}

async function findPageVideos() {
  const output = document.querySelector('[data-videos]');
  output.textContent = '영상 주소를 확인하고 있습니다…';
  try {
    const tab = await getActiveTab();
    if (!/^https?:\/\//.test(tab.url || '')) throw new Error('일반 웹페이지에서 사용하세요.');
    const results = await chrome.scripting.executeScript({ target:{tabId:tab.id}, func:() =>
      [...document.querySelectorAll('video')].map(video => ({
        url: video.currentSrc || video.src || video.querySelector('source')?.src || '',
        duration: Number.isFinite(video.duration) ? Math.round(video.duration) : null
      }))
    });
    const videos = results.flatMap(result => result.result || []);
    const unique = [...new Map(videos.filter(v => /^https:\/\//i.test(v.url)).map(v => [v.url,v])).values()];
    output.textContent = '';
    if (!unique.length) {
      output.textContent = videos.some(v => v.url.startsWith('blob:'))
        ? 'blob/HLS/DRM 스트림은 아직 지원하지 않습니다. 내려받을 수 있는 MP4 파일을 선택하세요.'
        : '이 페이지에서 공개 영상 주소를 찾지 못했습니다. 직접 MP4 주소나 파일을 플레이어에서 열어주세요. iframe 안의 영상은 해당 영상 페이지를 직접 여세요.';
      return;
    }
    unique.forEach((video,index) => {
      const button = document.createElement('button');
      button.textContent = `영상 ${index+1}${video.duration ? ' · '+video.duration+'초' : ''} 가져오기`;
      button.title = video.url;
      button.onclick = async () => {
        await chrome.scripting.executeScript({target:{tabId:tab.id},func:(url)=>{
          for (const video of document.querySelectorAll('video')) if ((video.currentSrc || video.src || video.querySelector('source')?.src)===url) video.pause();
        },args:[video.url]});
        await openLocalPlayer(video.url);
      };
      output.append(button);
    });
    const note=document.createElement('small');note.textContent='로컬 플레이어에서 불러오기를 누르세요. 공개 MP4인지 서버에서 확인합니다.';output.append(note);
  } catch(error) { output.textContent=error.message || String(error); }
}

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
    if (response.payload?.version !== VERSION) {
      throw new Error(`확장 v${VERSION} · 페이지 v${response.payload?.version || "확인 불가"}. 유튜브 페이지를 새로고침(F5)한 뒤 다시 열어주세요.`);
    }
    return response;
  } catch (error) {
    const disconnected = /Receiving end does not exist|Extension context invalidated|message (?:port|channel) closed/i.test(error.message || "");
    if (!disconnected) throw error;
    if (!allowInject) {
      throw new Error(`확장 v${VERSION}와 페이지 연결이 끊겼습니다. 유튜브 페이지를 새로고침(F5)한 뒤 다시 열어주세요.`);
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
    `<strong>설치 버전:</strong> ${escapeHtml(VERSION)}`,
    `<strong>페이지 버전:</strong> ${escapeHtml(payload.version || "확인 불가")}`,
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
  if (typeof location !== "undefined" && location.search) {
    const sourceTab = Number(new URLSearchParams(location.search).get("sourceTab"));
    if (Number.isInteger(sourceTab) && sourceTab > 0) return chrome.tabs.get(sourceTab);
  }
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
