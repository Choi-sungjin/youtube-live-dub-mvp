importScripts("page-probe.js", "panel-action.js");

const DEFAULT_BACKEND_URL = "http://127.0.0.1:18789";
const NATIVE_HOST_NAME = "com.youtube_live_dub.backend";

const MESSAGE_HANDLERS = {
  YLD_SHORTCUTS_GET: async () => chrome.commands.getAll(),
  YLD_SHORTCUTS_OPEN: async () => { await chrome.tabs.create({url: "chrome://extensions/shortcuts"}); return {opened:true}; },
  YLD_API_SETTINGS_OPEN: openApiSettings,
  YLD_API_SETTINGS: apiSettingsRequest,
  YLD_PAGE_PROBE: executePageProbe,
  YLD_TRANSCRIBE_CAPTURE: transcribeCapture,
  YLD_BACKEND_HEALTH: ensureBackendHealth,
  YLD_PREPARE_DUB: prepareDub,
  YLD_FETCH_CAPTIONS: fetchCaptions,
  YLD_FETCH_AUDIO: fetchAudio,
  YLD_PREPROCESS_CAPTIONS: preprocessCaptions,
  YLD_PREPROCESS_STATUS: fetchPreprocessStatus,
  YLD_BACKEND_START: (payload) => callNativeHost("start", payload),
  YLD_BACKEND_STOP: (payload) => callNativeHost("stop", payload),
  YLD_BACKEND_STATUS: (payload) => callNativeHost("status", payload),
};

async function executePageProbe(payload, sender) {
  // Bind execution to the sender's document, never a caller-selected tab or code.
  const url = new URL(sender?.url || "about:blank");
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id) ||
      sender.frameId !== 0 || typeof sender.documentId !== "string" || !sender.documentId || url.protocol !== "https:" ||
      !["www.youtube.com", "youtube.com"].includes(url.hostname) || url.port) {
    throw new Error("Page probe requires a YouTube top-level content script.");
  }
  if (!payload || !["install", "snapshot", "fetch-transcript", "prime-captions"].includes(payload.mode) ||
      typeof payload.requestId !== "string" || !payload.requestId || payload.requestId.length > 200 ||
      !["ko", "en", "ja"].includes(payload.targetLang)) {
    throw new Error("Invalid page probe request.");
  }
  const target = { tabId: sender.tab.id, documentIds: [sender.documentId] };
  const results = await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    func: runPageProbe,
    args: [{ requestId: payload.requestId, mode: payload.mode, targetLang: payload.targetLang }],
  });
  const result = results?.[0]?.result;
  if (result?.requestId !== payload.requestId || result?.mode !== payload.mode) {
    throw new Error("Page probe did not acknowledge the request.");
  }
  return result;
}

async function ensureBackendHealth(payload) {
  const backendUrl = normalizeBackendUrl(payload?.backendUrl);
  try {
    const response = await fetch(`${backendUrl}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    const health = await readJsonResponse(response, "Backend health");
    if (!health.ok) throw new Error("Backend health check failed.");
    return health;
  } catch (error) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(backendUrl)) throw error;
    const started = await callNativeHost("start", { backendUrl });
    if (!started?.health?.ok) throw new Error("Local backend did not become ready.");
    return started.health;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = message && MESSAGE_HANDLERS[message.type];
  if (!handler) {
    return false;
  }

  Promise.resolve()
    .then(() => handler(message.payload, _sender))
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error),
      });
    });

  return true;
});

function callNativeHost(action, payload) {
  return new Promise((resolve, reject) => {
    const port = portFromBackendUrl(payload && payload.backendUrl);

    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action, port }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(formatNativeHostError(lastError.message)));
          return;
        }
        if (!response) {
          reject(new Error("Native host returned no response. Reinstall via native-host\\install-native-host.ps1."));
          return;
        }
        if (response.ok === false) {
          reject(new Error(response.error || "Native host reported an error."));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(new Error(formatNativeHostError(error && error.message)));
    }
  });
}

function portFromBackendUrl(value) {
  const raw = String(value || DEFAULT_BACKEND_URL).trim();
  const match = raw.match(/^https?:\/\/[^/:]+(?::(\d+))?/);
  if (match && match[1]) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0) {
      return port;
    }
  }
  return 18789;
}

function formatNativeHostError(message) {
  const text = String(message || "Native messaging failed.");
  const id = chrome.runtime.id || "<extension-id>";
  if (/Specified native messaging host not found|not registered|host not found/i.test(text)) {
    return `Native host "${NATIVE_HOST_NAME}" is not installed. From PowerShell run: cd "$env:USERPROFILE\\youtube-live-dub-mvp\\native-host"; .\\install-native-host.ps1 -ExtensionId "${id}"; then restart Chrome.`;
  }
  if (/Access to the specified native messaging host is forbidden|forbidden/i.test(text)) {
    return `Native host installed but does not allow this extension. Re-run install-native-host.ps1 -ExtensionId "${id}" then restart Chrome.`;
  }
  return text;
}

async function prepareDub(payload, sender) {
  const backendUrl = normalizeBackendUrl(payload && payload.backendUrl);
  const cleanPayload = { ...payload };
  delete cleanPayload.backendUrl;

  const response = await fetch(`${backendUrl}/api/dub/prepare`, {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(cleanPayload),
  });

  if (payload?.stream === true && response.ok && response.headers.get('content-type')?.includes('application/x-ndjson')) {
    if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id) || sender.frameId !== 0 || !sender.documentId) throw new Error('Invalid streaming recipient.');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', result;
    while (true) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value || new Uint8Array(), {stream:!chunk.done});
      if (pending.length > 2000000) throw new Error('Audio preparation response too large.');
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0,newline); pending=pending.slice(newline+1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === 'error') throw new Error(event.error || 'Speech preparation failed.');
        if (event.type === 'done') result=event.result;
        if (event.type === 'segment') await chrome.tabs.sendMessage(sender.tab.id, {
          type:'YLD_PREPARE_PROGRESS', requestId:payload.requestId, item:event.item,
        }, {documentId:sender.documentId}).catch(()=>{});
      }
      if (chunk.done) break;
    }
    if (!result) throw new Error('Incomplete audio preparation stream.');
    return result;
  }
  const text = await response.text();
  let json = null;

  if (text) {
    try {
      json = JSON.parse(text);
    } catch (_error) {
      throw new Error(`Backend returned non-JSON response (${response.status})`);
    }
  }

  if (!response.ok) {
    const message =
      json && (json.error || json.message)
        ? json.error || json.message
        : `Backend request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return json || {};
}

async function fetchAudio(payload) {
  const audioUrl = String(payload?.audioUrl || "");
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/audio\/[A-Za-z0-9._-]+\.wav$/.test(audioUrl)) {
    throw new Error("Refusing to fetch non-local audio URL.");
  }

  const response = await fetch(audioUrl, {
    method: "GET",
    signal: AbortSignal.timeout(30000),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Audio fetch failed: HTTP ${response.status} for ${audioUrl}`);
  }

  const contentType = response.headers.get("content-type") || "audio/wav";
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) {
    throw new Error(`Audio fetch returned an empty file for ${audioUrl}`);
  }

  return {
    audioUrl,
    contentType,
    bytes: buffer.byteLength,
    dataUrl: `data:${contentType};base64,${arrayBufferToBase64(buffer)}`,
  };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

async function fetchCaptions(payload) {
  const backendUrl = normalizeBackendUrl(payload && payload.backendUrl);
  const videoId = encodeURIComponent(String(payload?.videoId || ""));
  const response = await fetch(`${backendUrl}/api/captions?videoId=${videoId}${payload?.cacheOnly ? "&cacheOnly=1" : ""}`, {
    method: "GET",
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();
  let json = null;

  if (text) {
    try {
      json = JSON.parse(text);
    } catch (_error) {
      throw new Error(`Backend captions returned non-JSON response (${response.status})`);
    }
  }

  if (!response.ok) {
    const message =
      json && (json.error || json.message)
        ? json.error || json.message
        : `Backend captions failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return json || {};
}

async function preprocessCaptions(payload) {
  const backendUrl = normalizeBackendUrl(payload && payload.backendUrl);
  const response = await fetch(`${backendUrl}/api/captions/preprocess`, {
    method: "POST",
    signal: AbortSignal.timeout(90000),
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      videoId: String(payload?.videoId || ""),
      videoUrl: String(payload?.videoUrl || ""),
      language: payload?.language || "auto",
      sttModel: payload?.sttModel || "base",
      startTime: Number(payload?.startTime || 0),
      windowDuration: Number(payload?.windowDuration || 0),
      maxDuration: Number(payload?.maxDuration || 180),
      prewarmSegments: Number(payload?.prewarmSegments || 8),
      force: Boolean(payload?.force),
      settings: payload?.settings || {},
    }),
  });

  return readJsonResponse(response, "Caption preprocessing");
}

async function fetchPreprocessStatus(payload) {
  const backendUrl = normalizeBackendUrl(payload && payload.backendUrl);
  const videoId = encodeURIComponent(String(payload?.videoId || ""));
  const response = await fetch(`${backendUrl}/api/captions/preprocess?videoId=${videoId}`, {
    method: "GET",
    signal: AbortSignal.timeout(30000),
    cache: "no-store",
  });

  return readJsonResponse(response, "Caption preprocessing status");
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  let json = null;

  if (text) {
    try {
      json = JSON.parse(text);
    } catch (_error) {
      throw new Error(`${label} returned non-JSON response (${response.status})`);
    }
  }

  if (!response.ok) {
    const message =
      json && (json.error || json.message)
        ? json.error || json.message
        : `${label} failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return json || {};
}

function normalizeBackendUrl(value) {
  const raw = String(value || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, "");
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(raw)) {
    return raw;
  }
  if (/^https:\/\/[A-Za-z0-9.-]+\.vercel\.app$/.test(raw)) {
    return raw;
  }
  return DEFAULT_BACKEND_URL;
}

async function transcribeCapture(payload, sender) {
  const url = new URL(sender?.url || "about:blank");
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id) || sender.frameId !== 0 ||
      url.protocol !== "https:" || !["www.youtube.com", "youtube.com"].includes(url.hostname) || url.port ||
      url.searchParams.get("v") !== payload?.videoId) throw new Error("Invalid capture sender.");
  const backendUrl = normalizeBackendUrl(payload.backendUrl);
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(backendUrl)) throw new Error("Capture requires a local backend.");
  if (typeof payload.audio !== "string" || payload.audio.length > (payload.buffered === true ? 11184812 : 1400000)) throw new Error("Invalid capture size.");
  const response = await fetch(`${backendUrl}/api/captions/capture`, {
    method: "POST", credentials: "omit", signal: AbortSignal.timeout(180000),
    headers: { "content-type": "application/json", "x-yld-capture": "1" },
    body: JSON.stringify({ videoId: payload.videoId, start: payload.start, end: payload.end, audio: payload.audio, buffered: payload.buffered === true }),
  });
  return readJsonResponse(response, "Original audio transcription");
}

function localSettingsBackend(value) {
  const url = normalizeBackendUrl(value);
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error("API 키 설정은 로컬 백엔드에서만 사용할 수 있습니다.");
  return url;
}
async function openApiSettings(payload, sender) {
  const url = new URL(sender?.url || "about:blank");
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id) || sender.frameId !== 0 ||
      url.protocol !== "https:" || !["youtube.com", "www.youtube.com"].includes(url.hostname)) throw new Error("유튜브 패널에서 실행해 주세요.");
  const backend = localSettingsBackend(payload?.backendUrl);
  if (!chrome.action.openPopup) throw new Error("API 설정 팝업에는 Chrome 127 이상이 필요합니다.");
  await chrome.action.setPopup({ tabId: sender.tab.id, popup: `api-settings.html?backend=${encodeURIComponent(backend)}` });
  try { await chrome.action.openPopup({ windowId: sender.tab.windowId }); }
  catch { await chrome.action.setPopup({ tabId: sender.tab.id, popup: "" }); throw new Error("API 설정 팝업을 열지 못했습니다. 패널에서 다시 눌러 주세요."); }
  return { opened: true };
}
async function apiSettingsRequest(payload, sender) {
  const url = new URL(sender?.url || "about:blank");
  // Content scripts and web pages can open the popup, but cannot read/write keys.
  if (sender?.id !== chrome.runtime.id || url.hostname !== chrome.runtime.id ||
      url.protocol !== 'chrome-extension:' || url.pathname !== '/api-settings.html') throw new Error("API 설정 팝업에서 실행해 주세요.");
  if (!['status', 'save', 'delete', 'test'].includes(payload?.action)) throw new Error("Invalid API settings action.");
  const backendUrl = localSettingsBackend(payload.backendUrl);
  const response = await fetch(`${backendUrl}/api/settings/openai`, {
    method: 'POST', credentials: 'omit', signal: AbortSignal.timeout(180000),
    headers: { 'content-type': 'application/json', 'x-yld-settings': '1' },
    body: JSON.stringify({ action: payload.action, ...(payload.action === 'save' ? { key: payload.key } : {}) }),
  });
  return readJsonResponse(response, "API settings");
}
