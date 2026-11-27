importScripts("page-probe.js", "panel-action.js");

const DEFAULT_BACKEND_URL = "http://127.0.0.1:18789";
const NATIVE_HOST_NAME = "com.youtube_live_dub.backend";
const activePrepares = new Map();

const MESSAGE_HANDLERS = {
  YLD_SHORTCUTS_GET: async () => chrome.commands.getAll(),
  YLD_SHORTCUTS_OPEN: async () => { await chrome.tabs.create({url: "chrome://extensions/shortcuts"}); return {opened:true}; },
  YLD_ACTION_STATE: updateActionState,
  YLD_ABORT_PREPARE: abortPrepare,
  YLD_SYNC_MODE: syncRuntimeMode,
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

chrome.tabs?.onRemoved?.addListener?.((tabId) => {
  for (const [requestId, entry] of activePrepares) {
    if (entry.tabId === tabId) {
      entry.controller.abort();
      activePrepares.delete(requestId);
    }
  }
});

async function updateActionState(payload, sender) {
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id) || sender.frameId !== 0) {
    return { updated: false };
  }
  await applyTabActionState(sender.tab.id, payload || {});
  return { updated: true };
}

async function abortPrepare(payload, sender) {
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id)) {
    return { aborted: 0 };
  }
  const ids = Array.isArray(payload?.requestIds) ? payload.requestIds.slice(0, 24) : [];
  let aborted = 0;
  for (const id of ids) {
    if (typeof id !== "string" || !id) continue;
    const entry = activePrepares.get(id);
    if (entry && entry.tabId === sender.tab.id) {
      entry.controller.abort();
      activePrepares.delete(id);
      aborted += 1;
    }
  }
  return { aborted };
}

async function syncRuntimeMode(payload, sender) {
  if (sender?.id !== chrome.runtime.id) return { ok: false };
  const mode = String(payload?.mode || "").trim();
  if (!["local", "gemma-gpt", "gpt-local", "gpt"].includes(mode)) return { ok: false };
  const backendUrl = normalizeBackendUrl(payload?.backendUrl);
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(backendUrl)) return { ok: false };
  try {
    const response = await fetch(`${backendUrl}/api/runtime/mode`, {
      method: "POST",
      signal: AbortSignal.timeout(4000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, active: Boolean(payload?.active) }),
    });
    return await readJsonResponse(response, "Runtime mode sync");
  } catch {
    return { ok: false, offline: true };
  }
}

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
        retryable: typeof error?.retryable === "boolean" ? error.retryable : undefined,
      });
    });

  return true;
});

function callNativeHost(action, payload) {
  return new Promise((resolve, reject) => {
    const port = portFromBackendUrl(payload && payload.backendUrl);

    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action, port }, async (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(await formatNativeHostError(lastError.message)));
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
      Promise.resolve(formatNativeHostError(error && error.message)).then(msg => reject(new Error(msg)));
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

async function formatNativeHostError(message) {
  const text = String(message || "Native messaging failed.");
  const id = chrome.runtime.id || "<extension-id>";
  let os = "";
  try { ({ os } = await chrome.runtime.getPlatformInfo()); } catch {}
  if (/Specified native messaging host not found|not registered|host not found/i.test(text)) {
    if (os === "linux") {
      return "로컬 더빙 서버(127.0.0.1:18789)에 연결하지 못했습니다. 터미널에서 systemctl --user restart youtube-live-dub.service 를 실행해 주세요.";
    }
    if (os === "mac") {
      return "로컬 더빙 서버(127.0.0.1:18789)가 꺼져 있습니다. 프로젝트 폴더에서 start-macos.command 를 실행해 주세요.";
    }
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

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const registry = typeof activePrepares !== "undefined" ? activePrepares : null;
  const requestId = typeof payload?.requestId === "string" && payload.requestId.length <= 200 ? payload.requestId : "";
  if (requestId && controller && registry) {
    registry.set(requestId, { tabId: sender?.tab?.id ?? null, controller });
  }

  try {
    const response = await fetch(`${backendUrl}/api/dub/prepare`, {
      method: "POST",
      signal: controller ? AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(cleanPayload),
    });

    if (payload?.stream === true && response.ok && response.headers.get('content-type')?.includes('application/x-ndjson')) {
      if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id) || sender.frameId !== 0 || !sender.documentId) throw new Error('Invalid streaming recipient.');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      const cancelReader = () => { reader.cancel().catch(() => {}); };
      controller?.signal.addEventListener("abort", cancelReader, { once: true });
      let pending = '', result;
      try {
        while (true) {
          const chunk = await reader.read();
          if (controller?.signal.aborted) {
            const abortErr = new Error("Audio preparation cancelled.");
            abortErr.retryable = false;
            throw abortErr;
          }
          pending += decoder.decode(chunk.value || new Uint8Array(), {stream:!chunk.done});
          if (pending.length > 2000000) throw new Error('Audio preparation response too large.');
          let newline;
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0,newline); pending=pending.slice(newline+1);
            if (!line) continue;
            const event = JSON.parse(line);
            if (event.type === 'error') {
              const err = new Error(event.error || 'Speech preparation failed.');
              if (typeof event.retryable === 'boolean') err.retryable = event.retryable;
              throw err;
            }
            if (event.type === 'done') result=event.result;
            if (event.type === 'segment') await chrome.tabs.sendMessage(sender.tab.id, {
              type:'YLD_PREPARE_PROGRESS', requestId:payload.requestId, item:event.item,
            }, {documentId:sender.documentId}).catch(()=>{});
          }
          if (chunk.done) break;
        }
      } finally {
        controller?.signal.removeEventListener("abort", cancelReader);
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
      const error = new Error(message);
      if (typeof json?.retryable === "boolean") error.retryable = json.retryable;
      throw error;
    }

    return json || {};
  } catch (error) {
    if (controller?.signal.aborted) {
      const abortErr = new Error("Audio preparation cancelled.");
      abortErr.retryable = false;
      throw abortErr;
    }
    throw error;
  } finally {
    if (requestId && registry) registry.delete(requestId);
  }
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
      !sender.documentId || url.protocol !== "https:" || !["www.youtube.com", "youtube.com"].includes(url.hostname) || url.port) {
    throw new Error("현재 유튜브 탭의 더빙 패널에서 다시 시작해 주세요.");
  }
  // sender.url can retain the document's original URL after YouTube SPA
  // navigation. Read the live URL in that exact document, never a payload tab.
  const frames = await chrome.scripting.executeScript({target:{tabId:sender.tab.id,documentIds:[sender.documentId]},
    func:() => location.href});
  const frame = frames?.find(item => item.documentId === sender.documentId && item.frameId === 0);
  let current;
  try { current = new URL(frame?.result); } catch {}
  if (!current || current.protocol !== 'https:' || !['www.youtube.com','youtube.com'].includes(current.hostname) ||
      current.port || current.pathname !== '/watch' || current.searchParams.get('v') !== payload?.videoId ||
      !/^[A-Za-z0-9_-]{11}$/.test(payload?.videoId || '')) {
    throw new Error("영상이 변경되어 이전 원음 요청을 취소했습니다. 현재 영상에서 Start를 눌러 주세요.");
  }
  const backendUrl = normalizeBackendUrl(payload.backendUrl);
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(backendUrl)) throw new Error("Capture requires a local backend.");
  if (typeof payload.audio !== "string" || payload.audio.length > (payload.buffered === true ? 11184812 : 1400000)) throw new Error("Invalid capture size.");
  const response = await fetch(`${backendUrl}/api/captions/capture`, {
    method: "POST", credentials: "omit", signal: AbortSignal.timeout(180000),
    headers: { "content-type": "application/json", "x-yld-capture": "1" },
    body: JSON.stringify({ videoId: payload.videoId, start: payload.start, end: payload.end, audio: payload.audio, buffered: payload.buffered === true, autoSpeaker: payload.autoSpeaker === true }),
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
