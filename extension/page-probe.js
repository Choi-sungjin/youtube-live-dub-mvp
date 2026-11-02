// Self-contained: Chrome serializes this function into the requesting page.
function runPageProbe({ requestId = "", mode = "snapshot", targetLang = "ko" } = {}) {
  const videoId = getVideoId();

  installNetworkProbe();

  const snapshot = {
    source: "YLD_PAGE",
    type: "PLAYER_RESPONSE",
    requestId,
    videoId,
    response: compactPlayerResponse(readResponse()),
    transcriptEndpoint: readTranscriptEndpoint(),
    youtubeConfig: readConfig(),
    cachedTranscriptSegments: readCachedTranscriptSegments(videoId)
  };
  window.postMessage(snapshot, "*");

  if (mode === "fetch-transcript") {
    fetchTranscriptFromPage(videoId)
      .then((result) => {
        window.postMessage({
          ...result,
          captionSource: result.source || "",
          source: "YLD_PAGE",
          type: "TRANSCRIPT_RESPONSE",
          requestId,
          videoId
        }, "*");
      })
      .catch((error) => {
        window.postMessage({
          source: "YLD_PAGE",
          type: "TRANSCRIPT_RESPONSE",
          requestId,
          videoId,
          segments: [],
          error: error?.message || String(error)
        }, "*");
      });
  }

  if (mode === "prime-captions") {
    primeCaptionsFromPlayer(videoId, targetLang)
      .then((result) => {
        window.postMessage({
          ...result,
          captionSource: result.source || "",
          source: "YLD_PAGE",
          type: "CAPTIONS_PRIMED",
          requestId,
          videoId
        }, "*");
      })
      .catch((error) => {
        window.postMessage({
          source: "YLD_PAGE",
          type: "CAPTIONS_PRIMED",
          requestId,
          videoId,
          segments: [],
          error: error?.message || String(error)
        }, "*");
      });
  }

  return { requestId, videoId, mode };

  function compactPlayerResponse(response) {
    if (!response) {
      return null;
    }

    return {
      captions: response.captions || null,
      videoDetails: response.videoDetails || null
    };
  }

  function parseMaybeJson(value) {
    if (!value) {
      return null;
    }
    if (typeof value === "object") {
      return value;
    }
    try {
      return JSON.parse(String(value));
    } catch (_error) {
      return null;
    }
  }

  function readResponse() {
    const candidates = [];

    try {
      candidates.push(window.ytInitialPlayerResponse);
    } catch (_error) {}

    try {
      candidates.push(window.ytplayer?.config?.args?.player_response);
    } catch (_error) {}

    try {
      candidates.push(document.querySelector("ytd-watch-flexy")?.playerResponse);
    } catch (_error) {}

    try {
      candidates.push(document.querySelector("#movie_player")?.getPlayerResponse?.());
    } catch (_error) {}

    try {
      candidates.push(document.querySelector("video")?.closest("#movie_player")?.getPlayerResponse?.());
    } catch (_error) {}

    for (const candidate of candidates) {
      const parsed = parseMaybeJson(candidate);
      if (parsed?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) {
        return parsed;
      }
    }

    for (const candidate of candidates) {
      const parsed = parseMaybeJson(candidate);
      if (parsed) {
        return parsed;
      }
    }

    return null;
  }

  function readConfig() {
    const context = readYtcfg("INNERTUBE_CONTEXT");
    const apiKey = readYtcfg("INNERTUBE_API_KEY");

    if (!context || !apiKey) {
      return null;
    }

    return {
      INNERTUBE_API_KEY: apiKey,
      INNERTUBE_CONTEXT: context,
      INNERTUBE_CONTEXT_CLIENT_NAME: readYtcfg("INNERTUBE_CONTEXT_CLIENT_NAME") || "1",
      VISITOR_DATA: readYtcfg("VISITOR_DATA") || context?.client?.visitorData || "",
      SESSION_INDEX: readYtcfg("SESSION_INDEX") || ""
    };
  }

  function readYtcfg(key) {
    try {
      if (typeof window.ytcfg?.get === "function") {
        return window.ytcfg.get(key);
      }
    } catch (_error) {}

    try {
      return window.ytcfg?.data_?.[key];
    } catch (_error) {
      return null;
    }
  }

  function readTranscriptEndpoint() {
    const candidates = [];

    try {
      candidates.push(window.ytInitialData);
    } catch (_error) {}

    try {
      candidates.push(document.querySelector("ytd-watch-flexy")?.data);
    } catch (_error) {}

    try {
      candidates.push(document.querySelector("ytd-watch-flexy")?.__data);
    } catch (_error) {}

    try {
      candidates.push(document.querySelector("ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']")?.data);
    } catch (_error) {}

    for (const candidate of candidates) {
      const endpoint = findTranscriptEndpoint(candidate);
      if (endpoint?.params) {
        return endpoint;
      }
    }

    return null;
  }

  function findTranscriptEndpoint(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return null;
    }
    seen.add(value);

    if (value.getTranscriptEndpoint?.params) {
      return value.getTranscriptEndpoint;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findTranscriptEndpoint(item, seen);
        if (found) {
          return found;
        }
      }
      return null;
    }

    for (const item of Object.values(value)) {
      const found = findTranscriptEndpoint(item, seen);
      if (found) {
        return found;
      }
    }
    return null;
  }

  async function fetchTranscriptFromPage(videoId) {
    const endpoint = readTranscriptEndpoint();
    const config = readConfig();
    const attempts = buildTranscriptAttempts(videoId, endpoint);

    if (!attempts.length || !config?.INNERTUBE_API_KEY || !config?.INNERTUBE_CONTEXT) {
      return {
        segments: [],
        transcriptEndpoint: endpoint || null,
        youtubeConfig: config || null,
        error: "Transcript params or YouTube config was not found in page context."
      };
    }

    const headers = await buildInnerTubeHeaders(config);
    let lastError = "";
    let lastStatus = 0;

    for (const attempt of attempts) {
      const response = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(config.INNERTUBE_API_KEY)}`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          context: config.INNERTUBE_CONTEXT,
          params: attempt.params
        })
      });
      const text = await response.text();
      const payload = parseJson(text);
      const segments = parseCaptionPayload(payload) || parseCaptionText(text, "json");

      if (segments.length) {
        writeTranscriptCache(videoId, segments, attempt.endpoint || endpoint);
        return {
          status: response.status,
          ok: response.ok,
          segments,
          transcriptEndpoint: attempt.endpoint || endpoint,
          youtubeConfig: config,
          source: attempt.source,
          error: ""
        };
      }

      lastStatus = response.status;
      lastError = response.ok
        ? `Transcript attempt ${attempt.source} returned no segments.`
        : readErrorMessage(payload) || `Transcript endpoint failed with HTTP ${response.status}`;
    }

    return {
      status: lastStatus,
      ok: false,
      segments: [],
      transcriptEndpoint: endpoint,
      youtubeConfig: config,
      error: lastError
    };
  }

  async function primeCaptionsFromPlayer(videoId, targetLang) {
    const player = document.querySelector("#movie_player");
    const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
    const response = readResponse();
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const selectedTracks = prioritizeSourceCaptionTracks(tracks, targetLang).slice(0, 4);

    installNetworkProbe();

    for (const track of selectedTracks) {
      activateCaptionTrack(player, track);
      await delay(900);

      const cachedSegments = readCachedTranscriptSegments(videoId);
      if (cachedSegments.length) {
        return {
          segments: cachedSegments,
          source: "page-player-network",
          selectedTrack: describeCaptionTrack(track),
          transcriptEndpoint: window.__YLD_TRANSCRIPT_CACHE__?.[videoId]?.transcriptEndpoint || readTranscriptEndpoint(),
          youtubeConfig: readConfig(),
          error: ""
        };
      }

      const textTrackSegments = readVideoTextTrackSegments(video, targetLang);
      if (textTrackSegments.length) {
        writeTranscriptCache(videoId, textTrackSegments, readTranscriptEndpoint());
        return {
          segments: textTrackSegments,
          source: "page-video-texttrack",
          selectedTrack: describeCaptionTrack(track),
          transcriptEndpoint: readTranscriptEndpoint(),
          youtubeConfig: readConfig(),
          error: ""
        };
      }
    }

    tryEnableCaptions(player);

    const startedAt = Date.now();
    let bestSegments = [];
    while (Date.now() - startedAt < 4200) {
      const cachedSegments = readCachedTranscriptSegments(videoId);
      if (cachedSegments.length > bestSegments.length) {
        bestSegments = cachedSegments;
      }

      const textTrackSegments = readVideoTextTrackSegments(video, targetLang);
      if (textTrackSegments.length > bestSegments.length) {
        bestSegments = textTrackSegments;
      }

      if (bestSegments.length >= 2) {
        writeTranscriptCache(videoId, bestSegments, readTranscriptEndpoint());
        return {
          segments: bestSegments,
          source: "page-caption-prime",
          selectedTrack: selectedTracks[0] ? describeCaptionTrack(selectedTracks[0]) : null,
          transcriptEndpoint: readTranscriptEndpoint(),
          youtubeConfig: readConfig(),
          error: ""
        };
      }

      await delay(250);
    }

    if (bestSegments.length) {
      writeTranscriptCache(videoId, bestSegments, readTranscriptEndpoint());
    }

    return {
      segments: bestSegments,
      source: bestSegments.length ? "page-caption-prime-partial" : "page-caption-prime-empty",
      selectedTrack: selectedTracks[0] ? describeCaptionTrack(selectedTracks[0]) : null,
      transcriptEndpoint: readTranscriptEndpoint(),
      youtubeConfig: readConfig(),
      error: bestSegments.length ? "" : "YouTube player did not expose caption cues after priming."
    };
  }

  function activateCaptionTrack(player, track) {
    if (!player) {
      return;
    }

    const candidates = buildPlayerCaptionTrackCandidates(track);
    for (const candidate of candidates) {
      try {
        if (typeof player.setOption === "function") {
          player.setOption("captions", "track", candidate);
        }
      } catch (_error) {}
    }

    tryEnableCaptions(player);
  }

  function buildPlayerCaptionTrackCandidates(track) {
    const languageCode = String(track?.languageCode || "").trim();
    const candidates = [];

    if (track?.vssId) {
      candidates.push({ vssId: track.vssId });
      candidates.push({
        vssId: track.vssId,
        languageCode,
        kind: track.kind || ""
      });
    }
    if (languageCode) {
      candidates.push({ languageCode });
      candidates.push({
        languageCode,
        kind: track?.kind || ""
      });
    }
    if (track) {
      candidates.push(track);
    }

    return candidates.filter((candidate, index) => {
      const key = JSON.stringify(candidate);
      return key && candidates.findIndex((item) => JSON.stringify(item) === key) === index;
    });
  }

  function tryEnableCaptions(player) {
    try {
      if (player?.isSubtitlesOn?.()) {
        return;
      }
    } catch (_error) {}

    try {
      if (typeof player?.loadModule === "function") {
        player.loadModule("captions");
      }
    } catch (_error) {}

    try {
      if (typeof player?.toggleSubtitles === "function" && !player.isSubtitlesOn?.()) {
        player.toggleSubtitles();
        return;
      }
    } catch (_error) {}

    try {
      const button = document.querySelector(".ytp-subtitles-button");
      if (button && button.getAttribute("aria-pressed") !== "true") {
        button.click();
      }
    } catch (_error) {}
  }

  function prioritizeSourceCaptionTracks(tracks, targetLang) {
    return [...(tracks || [])]
      .filter((track) => track?.languageCode)
      .sort((a, b) => captionTrackScore(a, targetLang) - captionTrackScore(b, targetLang));
  }

  function captionTrackScore(track, targetLang) {
    const language = String(track.languageCode || "").toLowerCase();
    const name = String(readText(track.name) || "").toLowerCase();
    const target = String(targetLang || "").toLowerCase();
    const baseTarget = target.split("-")[0];
    const isTarget = target && (language === target || language.split("-")[0] === baseTarget);
    const isAuto = track.kind === "asr" || name.includes("auto");
    const isShowing = track.isTranslatable === false ? -0.1 : 0;

    if (!isTarget && !isAuto) {
      return 0 + isShowing;
    }
    if (!isTarget) {
      return 1 + isShowing;
    }
    if (!isAuto) {
      return 4;
    }
    return 5;
  }

  function describeCaptionTrack(track) {
    if (!track) {
      return null;
    }
    return {
      languageCode: track.languageCode || "",
      kind: track.kind || "",
      vssId: track.vssId || "",
      name: readText(track.name)
    };
  }

  function readVideoTextTrackSegments(video, targetLang) {
    if (!video?.textTracks?.length) {
      return [];
    }

    const tracks = Array.from(video.textTracks)
      .filter((track) => {
        const kind = String(track?.kind || "").toLowerCase();
        return kind === "captions" || kind === "subtitles" || kind === "metadata";
      })
      .sort((a, b) => textTrackScore(a, targetLang) - textTrackScore(b, targetLang));

    for (const track of tracks) {
      try {
        if (track.mode === "disabled") {
          track.mode = "hidden";
        }
      } catch (_error) {}

      const segments = readSegmentsFromTextTrack(track, targetLang);
      if (segments.length) {
        return segments;
      }
    }

    return [];
  }

  function textTrackScore(track, targetLang) {
    const language = String(track.language || "").toLowerCase();
    const label = String(track.label || "").toLowerCase();
    const target = String(targetLang || "").toLowerCase();
    const baseTarget = target.split("-")[0];
    const isTarget = target && (language === target || language.split("-")[0] === baseTarget || label.includes(languageNameForTarget(target)));

    if (!isTarget && track.mode === "showing") {
      return 0;
    }
    if (!isTarget && track.mode === "hidden") {
      return 1;
    }
    if (!isTarget) {
      return 2;
    }
    return 5;
  }

  function readSegmentsFromTextTrack(track, targetLang) {
    let cues = [];
    try {
      cues = Array.from(track.cues || []);
    } catch (_error) {
      return [];
    }

    return normalizeTimedSegments(cues
      .map((cue) => {
        const lines = dedupeCaptionLines(String(cue.text || "").split(/\r?\n/));
        const sourceLines = filterSourceCaptionLines(lines, targetLang);
        return {
          start: Number(cue.startTime),
          end: Number(cue.endTime),
          text: sourceLines.join(" ")
        };
      })
      .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text));
  }

  function normalizeTimedSegments(segments) {
    const normalized = [];
    const sorted = segments
      .map((segment) => ({
        start: Math.round(Number(segment.start) * 1000) / 1000,
        end: Math.round(Number(segment.end) * 1000) / 1000,
        text: cleanText(String(segment.text || "").replace(/<[^>]+>/g, " "))
      }))
      .filter((segment) => segment.text)
      .sort((a, b) => a.start - b.start);

    for (const segment of sorted) {
      const previous = normalized[normalized.length - 1];
      const previousKey = normalizeCaptionText(previous?.text || "");
      const currentKey = normalizeCaptionText(segment.text);
      if (previous && previousKey === currentKey && segment.start - previous.end <= 0.5) {
        previous.end = Math.max(previous.end, segment.end);
        continue;
      }
      normalized.push(segment);
    }

    return normalized;
  }

  function dedupeCaptionLines(lines) {
    const seen = new Set();
    const result = [];
    for (const line of lines) {
      const clean = cleanText(line);
      const key = normalizeCaptionText(clean);
      if (clean && !seen.has(key)) {
        seen.add(key);
        result.push(clean);
      }
    }
    return result;
  }

  function filterSourceCaptionLines(lines, targetLang) {
    const filtered = lines.filter((line) => !isTargetLanguageCaption(line, targetLang));
    return filtered.length ? filtered : lines;
  }

  function isTargetLanguageCaption(line, targetLang) {
    const text = cleanText(line);
    if (!text) {
      return false;
    }
    if (targetLang === "ko") {
      return scriptRatio(text, /[가-힣]/g) >= 0.35;
    }
    if (targetLang === "ja") {
      return scriptRatio(text, /[\u3040-\u30ff]/g) >= 0.25;
    }
    if (targetLang === "en") {
      return scriptRatio(text, /[A-Za-z]/g) >= 0.55 && scriptRatio(text, /[가-힣\u3040-\u30ff\u4e00-\u9fff]/g) < 0.15;
    }
    return false;
  }

  function scriptRatio(text, pattern) {
    const compact = String(text || "").replace(/\s+/g, "");
    if (!compact) {
      return 0;
    }
    const matches = compact.match(pattern);
    return (matches ? matches.length : 0) / compact.length;
  }

  function normalizeCaptionText(text) {
    return cleanText(text).replace(/\s+/g, "").toLowerCase();
  }

  function languageNameForTarget(target) {
    if (target === "ko") {
      return "korean";
    }
    if (target === "ja") {
      return "japanese";
    }
    if (target === "en") {
      return "english";
    }
    return target;
  }

  function buildTranscriptAttempts(videoId, endpoint) {
    const attempts = [];
    const seen = new Set();

    if (endpoint?.params) {
      addAttempt(attempts, seen, {
        source: "page-endpoint",
        params: endpoint.params,
        endpoint
      });
    }

    const response = readResponse();
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    for (const track of tracks) {
      for (const params of buildTranscriptParamsFromTrack(videoId, track)) {
        addAttempt(attempts, seen, {
          source: `track-${track.languageCode || "unknown"}-${track.kind || "manual"}`,
          params,
          endpoint: null
        });
      }
    }

    return attempts;
  }

  function addAttempt(attempts, seen, attempt) {
    if (!attempt.params || seen.has(attempt.params)) {
      return;
    }
    seen.add(attempt.params);
    attempts.push(attempt);
  }

  function buildTranscriptParamsFromTrack(videoId, track) {
    const language = String(track?.languageCode || "").trim();
    if (!videoId || !language) {
      return [];
    }

    const variants = [];
    if (track?.kind === "asr") {
      variants.push(encodeTranscriptParams(videoId, [
        [1, "asr"],
        [2, language]
      ]));
      variants.push(encodeTranscriptParams(videoId, [
        [1, "asr"],
        [2, language.split("-")[0]]
      ]));
    }

    variants.push(encodeTranscriptParams(videoId, [
      [1, language]
    ]));
    variants.push(encodeTranscriptParams(videoId, [
      [2, language]
    ]));

    return variants.filter(Boolean);
  }

  function encodeTranscriptParams(videoId, innerFields) {
    const inner = encodeProtoStringMessage(innerFields);
    return encodeProtoStringMessage([
      [1, videoId],
      [2, inner]
    ]);
  }

  function encodeProtoStringMessage(fields) {
    const bytes = [];
    for (const [field, value] of fields) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      const encoded = Array.from(new TextEncoder().encode(String(value)));
      bytes.push((Number(field) << 3) | 2, ...encodeVarint(encoded.length), ...encoded);
    }
    return bytesToBase64(bytes);
  }

  function encodeVarint(value) {
    let number = Number(value) >>> 0;
    const bytes = [];
    while (number > 127) {
      bytes.push((number & 127) | 128);
      number >>>= 7;
    }
    bytes.push(number);
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
    }
    return btoa(binary);
  }

  async function buildInnerTubeHeaders(config) {
    const context = config.INNERTUBE_CONTEXT || {};
    const headers = {
      "content-type": "application/json",
      "x-youtube-client-name": String(config.INNERTUBE_CONTEXT_CLIENT_NAME || "1"),
      "x-youtube-client-version": String(context.client?.clientVersion || ""),
      "x-origin": location.origin
    };

    const visitorData = context.client?.visitorData || config.VISITOR_DATA || "";
    if (visitorData) {
      headers["x-goog-visitor-id"] = String(visitorData);
    }
    if (config.SESSION_INDEX !== "" && config.SESSION_INDEX !== undefined && config.SESSION_INDEX !== null) {
      headers["x-goog-authuser"] = String(config.SESSION_INDEX);
    }

    const authorization = await createSapisidAuthHeader();
    if (authorization) {
      headers.authorization = authorization;
    }

    return headers;
  }

  async function createSapisidAuthHeader() {
    const sapisid =
      readCookie("__Secure-3PAPISID") ||
      readCookie("__Secure-1PAPISID") ||
      readCookie("SAPISID") ||
      readCookie("APISID");

    if (!sapisid || !crypto?.subtle) {
      return "";
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const input = `${timestamp} ${sapisid} ${location.origin}`;
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    const hash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `SAPISIDHASH ${timestamp}_${hash}`;
  }

  function readCookie(name) {
    const prefix = `${name}=`;
    return document.cookie
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix))
      ?.slice(prefix.length) || "";
  }

  function installNetworkProbe() {
    if (window.__YLD_NETWORK_PROBE_INSTALLED__) {
      return;
    }
    window.__YLD_NETWORK_PROBE_INSTALLED__ = true;
    window.__YLD_TRANSCRIPT_CACHE__ = window.__YLD_TRANSCRIPT_CACHE__ || {};

    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = async function yldFetch(input, init) {
        const response = await originalFetch.apply(this, arguments);
        const url = readRequestUrl(input);
        if (isTranscriptLikeUrl(url)) {
          response.clone().text()
            .then((text) => observeTranscriptPayload(url, text))
            .catch(() => {});
        }
        return response;
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function yldOpen(method, url) {
      this.__yldUrl = String(url || "");
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function yldSend() {
      if (isTranscriptLikeUrl(this.__yldUrl)) {
        this.addEventListener("loadend", () => {
          try {
            if (!this.responseType || this.responseType === "text") {
              observeTranscriptPayload(this.__yldUrl, this.responseText || "");
            }
          } catch (_error) {}
        });
      }
      return originalSend.apply(this, arguments);
    };
  }

  function readRequestUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input?.url) {
      return String(input.url);
    }
    return "";
  }

  function isTranscriptLikeUrl(url) {
    return /\/youtubei\/v1\/(get_transcript|next|player)\b/.test(url || "") ||
      /\/api\/timedtext\b/.test(url || "");
  }

  function observeTranscriptPayload(url, text) {
    if (!text) {
      return;
    }

    const payload = parseJson(text);
    const endpoint = payload ? findTranscriptEndpoint(payload) : null;
    const segments = payload
      ? parseCaptionPayload(payload)
      : parseCaptionText(text, inferCaptionFormat(url));

    if (!endpoint && !segments.length) {
      return;
    }

    if (segments.length) {
      writeTranscriptCache(getVideoId(), segments, endpoint);
    }

    window.postMessage({
      source: "YLD_PAGE",
      type: "TRANSCRIPT_OBSERVED",
      videoId: getVideoId(),
      url,
      segments,
      transcriptEndpoint: endpoint,
      youtubeConfig: readConfig()
    }, "*");
  }

  function parseCaptionPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return [];
    }

    if (Array.isArray(payload.events)) {
      return payload.events
        .map((event) => {
          const text = Array.isArray(event.segs)
            ? event.segs.map((segment) => segment.utf8 || "").join("")
            : "";
          const start = Number(event.tStartMs || 0) / 1000;
          const duration = Number(event.dDurationMs || 0) / 1000;
          return {
            start,
            end: start + Math.max(duration, 0.6),
            text: cleanText(text)
          };
        })
        .filter((segment) => segment.text);
    }

    const renderers = [];
    collectTranscriptRenderers(payload, renderers);
    const rawSegments = renderers
      .map((renderer) => ({
        start: Number(renderer.startMs || 0) / 1000,
        end: Number(renderer.endMs || 0) / 1000,
        text: cleanText(readText(renderer.snippet))
      }))
      .filter((segment) => Number.isFinite(segment.start) && segment.text)
      .sort((a, b) => a.start - b.start);

    return rawSegments
      .map((segment, index) => ({
        start: segment.start,
        end: segment.end > segment.start
          ? segment.end
          : rawSegments[index + 1]?.start || segment.start + 2,
        text: segment.text
      }))
      .filter((segment) => segment.end > segment.start);
  }

  function collectTranscriptRenderers(value, output, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => collectTranscriptRenderers(item, output, seen));
      return;
    }
    if (value.transcriptSegmentRenderer) {
      output.push(value.transcriptSegmentRenderer);
    }
    Object.values(value).forEach((item) => collectTranscriptRenderers(item, output, seen));
  }

  function parseCaptionText(text, format) {
    if (format === "vtt" || /^\s*WEBVTT\b/i.test(text || "")) {
      return parseVttCaptions(text);
    }
    if (format === "json" || /^\s*[\[{]/.test(text || "")) {
      return parseCaptionPayload(parseJson(text));
    }
    return parseXmlCaptions(text);
  }

  function parseXmlCaptions(text) {
    const doc = new DOMParser().parseFromString(text || "", "text/xml");
    const textSegments = Array.from(doc.querySelectorAll("text"))
      .map((node) => {
        const start = Number(node.getAttribute("start") || 0);
        const duration = Number(node.getAttribute("dur") || 0);
        return {
          start,
          end: start + Math.max(duration, 0.6),
          text: cleanText(node.textContent || "")
        };
      })
      .filter((segment) => segment.text);

    if (textSegments.length) {
      return textSegments;
    }

    return Array.from(doc.querySelectorAll("p"))
      .map((node) => {
        const start = Number(node.getAttribute("t") || 0) / 1000;
        const duration = Number(node.getAttribute("d") || 0) / 1000;
        return {
          start,
          end: start + Math.max(duration, 0.6),
          text: cleanText(node.textContent || "")
        };
      })
      .filter((segment) => segment.text);
  }

  function parseVttCaptions(text) {
    return String(text || "")
      .split(/\n{2,}/)
      .map((block) => {
        const lines = block
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const timingIndex = lines.findIndex((line) => line.includes("-->"));

        if (timingIndex === -1) {
          return null;
        }

        const match = lines[timingIndex].match(/([\d:.]+)\s+-->\s+([\d:.]+)/);
        if (!match) {
          return null;
        }

        const textValue = cleanText(lines.slice(timingIndex + 1).join(" "));
        if (!textValue) {
          return null;
        }

        return {
          start: parseVttTime(match[1]),
          end: parseVttTime(match[2]),
          text: textValue
        };
      })
      .filter((segment) => segment && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);
  }

  function parseVttTime(value) {
    const parts = String(value || "").split(":").map(Number);
    if (parts.length === 3) {
      return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
    }
    if (parts.length === 2) {
      return (parts[0] * 60) + parts[1];
    }
    return Number(value) || 0;
  }

  function inferCaptionFormat(url) {
    try {
      return new URL(url, location.href).searchParams.get("fmt") || "";
    } catch (_error) {
      return "";
    }
  }

  function writeTranscriptCache(videoId, segments, endpoint) {
    if (!videoId || !Array.isArray(segments) || !segments.length) {
      return;
    }
    window.__YLD_TRANSCRIPT_CACHE__ = window.__YLD_TRANSCRIPT_CACHE__ || {};
    window.__YLD_TRANSCRIPT_CACHE__[videoId] = {
      segments: segments.slice(0, 1000),
      transcriptEndpoint: endpoint || null,
      createdAt: Date.now()
    };
  }

  function readCachedTranscriptSegments(videoId) {
    const cached = window.__YLD_TRANSCRIPT_CACHE__?.[videoId];
    return Array.isArray(cached?.segments) ? cached.segments : [];
  }

  function readText(value) {
    if (!value) {
      return "";
    }
    if (typeof value.simpleText === "string") {
      return value.simpleText;
    }
    if (Array.isArray(value.runs)) {
      return value.runs.map((run) => run.text || "").join("");
    }
    return "";
  }

  function cleanText(text) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = String(text || "").replace(/<[^>]+>/g, " ");
    return textarea.value.replace(/\s+/g, " ").trim();
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  function readErrorMessage(payload) {
    return payload?.error?.message || "";
  }

  function getVideoId() {
    return new URL(location.href).searchParams.get("v") || "";
  }
}
