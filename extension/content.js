(() => {
  if (window.__YLD_CONTENT_SCRIPT_READY__) {
    return;
  }
  window.__YLD_CONTENT_SCRIPT_READY__ = true;

  const PANEL_ID = "yld-panel";
  const BUILD_VERSION = "0.5.0";
  const DEFAULT_BACKEND_URL = "http://127.0.0.1:18789";
  const BACKEND_STORAGE_KEY = "yld-backend-url";
  const PANEL_VISIBLE_STORAGE_KEY = "yld-panel-visible";
  const DEFAULT_ORIGINAL_VOLUME = 35;
  const PREPARE_LEAD_SECONDS = 0.18;
  const BUFFER_WINDOW_SECONDS = 180;
  const NEXT_BUFFER_THRESHOLD_SECONDS = 110;
  const MAX_PREPARE_CHUNKS = 20;
  const BUFFER_CHECK_INTERVAL_MS = 1000;
  const MIN_START_BUFFER_SECONDS = 8;
  const MIN_START_BUFFER_CLIPS = 2;
  const TEXT_TRACK_WAIT_MS = 4500;
  const PAGE_CAPTION_PRIME_WAIT_MS = 7500;
  const PREPROCESS_WAIT_MS = 8 * 60 * 1000;
  const PREPROCESS_POLL_MS = 5000;
  const INITIAL_STT_DURATION_SECONDS = 240;
  const STT_MODEL = "tiny";
  const STT_EXTENSION_SECONDS = 240;
  const STT_EXTENSION_THRESHOLD_SECONDS = 300;
  const STT_EXTENSION_OVERLAP_SECONDS = 2;
  const STT_MAX_DURATION_SECONDS = 2 * 60 * 60;
  const ENABLE_VISIBLE_CAPTION_FALLBACK = false;
  const VISIBLE_CAPTION_COLLECT_MS = 12000;
  const SYNC_TOLERANCE_SECONDS = 0.18;
  const MAX_SYNC_PLAYBACK_RATE = 1.75;

  const state = {
    running: false,
    sessionId: 0,
    status: "idle",
    lastError: "",
    videoId: "",
    video: null,
    originalVideoVolume: null,
    originalMuted: null,
    resumeVideoAfterPrepare: false,
    sourceSegments: [],
    chunks: [],
    prepared: [],
    preparedChunkIndexes: new Set(),
    preparingChunks: false,
    currentAudio: null,
    testAudio: null,
    currentChunkIndex: -1,
    syncTimer: null,
    bufferTimer: null,
    transcriptExpanding: false,
    transcriptTargetDuration: 0,
    objectUrls: [],
    pagePlayerResponse: null,
    pagePlayerResponseVideoId: "",
    pageTranscriptEndpoint: null,
    pageYoutubeConfig: null,
    pageTranscriptSegments: [],
    pageTranscriptVideoId: "",
  };

  const els = {};

  init();

  function init() {
    ensurePanel();
    bindPanelEvents();
    refreshPageState();
    installPageProbe();
    setStatus("idle");

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    window.addEventListener("message", handlePageMessage);
    document.addEventListener("yt-navigate-finish", handleNavigation);
    window.addEventListener("popstate", handleNavigation);
    setInterval(refreshPageState, 1500);
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = injectPanel();
    } else if (els.panel !== panel) {
      cachePanelElements(panel);
    }
    return panel;
  }

  function injectPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.hidden = !getSavedPanelVisible();
    panel.innerHTML = `
      <div class="yld-header">
        <div class="yld-title">Live Dub MVP <span class="yld-version">v${BUILD_VERSION}</span></div>
        <div class="yld-header-actions">
          <div class="yld-status" data-yld-status>idle</div>
          <button class="yld-icon-button" type="button" title="Hide panel" aria-label="Hide panel" data-yld-hide>×</button>
        </div>
      </div>
      <div class="yld-body">
        <div class="yld-alert" data-yld-alert hidden></div>

        <div class="yld-row-inline">
          <button class="yld-panel-button yld-primary" type="button" data-yld-start>Start</button>
          <button class="yld-panel-button" type="button" data-yld-stop disabled>Stop</button>
        </div>

        <div class="yld-row">
          <label class="yld-label" for="yld-backend">
            Backend
          </label>
          <div class="yld-row-inline yld-backend-grid">
            <input id="yld-backend" class="yld-panel-input" type="text" value="${DEFAULT_BACKEND_URL}" data-yld-backend>
            <button class="yld-panel-button" type="button" data-yld-test>Test</button>
          </div>
        </div>

        <div class="yld-row">
          <label class="yld-label" for="yld-volume">
            Original volume
            <span data-yld-volume-label>${DEFAULT_ORIGINAL_VOLUME}%</span>
          </label>
          <input id="yld-volume" class="yld-panel-range" type="range" min="0" max="100" step="1" value="${DEFAULT_ORIGINAL_VOLUME}" data-yld-volume>
        </div>

        <div class="yld-row-inline">
          <label class="yld-row">
            <span class="yld-label">Voice</span>
            <select class="yld-panel-select" data-yld-voice>
              <option value="763d5f200a9f5808056733">Low male</option>
              <option value="8590d2b8884926372c6b4f">High male</option>
              <option value="2c5f135cb33f49a2c8882d">Female</option>
              <option value="d39f0ea3c259e885e69a3c">Low female</option>
            </select>
          </label>
          <label class="yld-row">
            <span class="yld-label">Target</span>
            <select class="yld-panel-select" data-yld-lang>
              <option value="ko">Korean</option>
              <option value="en">English</option>
              <option value="ja">Japanese</option>
            </select>
          </label>
        </div>

        <div class="yld-row">
          <label class="yld-label" for="yld-tts-provider">음성 엔진</label>
          <select id="yld-tts-provider" class="yld-panel-select" data-yld-tts-provider>
            <option value="windows-sapi">Windows 로컬 음성 (설치된 한국어 음성)</option>
            <option value="supertone">Supertone API</option>
          </select>
        </div>
        <div class="yld-row">
          <label class="yld-label">Supertone model</label>
          <select class="yld-panel-select" data-yld-model>
            <option value="sona_speech_2">Sona speech 2</option>
            <option value="sona_speech_2_flash">Sona speech 2 flash</option>
            <option value="sona_speech_1">Sona speech 1</option>
            <option value="supertonic_api_1">Supertonic API 1</option>
          </select>
        </div>

        <div class="yld-row-inline">
          <label class="yld-row">
            <span class="yld-label">Pitch</span>
            <input class="yld-panel-input" type="number" min="-24" max="24" step="1" value="0" data-yld-pitch>
          </label>
          <label class="yld-row">
            <span class="yld-label">Variance</span>
            <input class="yld-panel-input" type="number" min="0" max="2" step="0.1" value="1.5" data-yld-variance>
          </label>
        </div>

        <div class="yld-row">
          <label class="yld-label">Speed</label>
          <input class="yld-panel-input" type="number" min="0.5" max="2" step="0.01" value="1.29" data-yld-speed>
        </div>

        <div class="yld-meta" data-yld-meta>
          <div><strong>Video:</strong> waiting for watch page</div>
          <div><strong>Captions:</strong> not loaded</div>
          <div><strong>Audio:</strong> none</div>
          <div class="yld-error" data-yld-error hidden></div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(panel);
    cachePanelElements(panel);
    return panel;
  }

  function cachePanelElements(panel) {
    els.panel = panel;
    els.status = panel.querySelector("[data-yld-status]");
    els.alert = panel.querySelector("[data-yld-alert]");
    els.start = panel.querySelector("[data-yld-start]");
    els.stop = panel.querySelector("[data-yld-stop]");
    els.test = panel.querySelector("[data-yld-test]");
    els.hide = panel.querySelector("[data-yld-hide]");
    els.backend = panel.querySelector("[data-yld-backend]");
    els.backend.value = getSavedBackendUrl();
    els.volume = panel.querySelector("[data-yld-volume]");
    els.volumeLabel = panel.querySelector("[data-yld-volume-label]");
    els.voice = panel.querySelector("[data-yld-voice]");
    els.lang = panel.querySelector("[data-yld-lang]");
    els.model = panel.querySelector("[data-yld-model]");
    els.ttsProvider = panel.querySelector("[data-yld-tts-provider]");
    els.pitch = panel.querySelector("[data-yld-pitch]");
    els.variance = panel.querySelector("[data-yld-variance]");
    els.speed = panel.querySelector("[data-yld-speed]");
    els.meta = panel.querySelector("[data-yld-meta]");
    els.error = panel.querySelector("[data-yld-error]");
  }

  function bindPanelEvents() {
    ensurePanel();
    if (els.panel.dataset.yldBound === "1") {
      return;
    }
    els.panel.dataset.yldBound = "1";
    const updateSpeechControls = () => {
      const local = els.ttsProvider.value === "windows-sapi";
      [els.voice, els.model, els.pitch, els.variance].forEach(control => { control.disabled = local; });
    };
    els.ttsProvider.addEventListener("change", updateSpeechControls);
    updateSpeechControls();
    els.start.addEventListener("click", startDub);
    els.stop.addEventListener("click", stopDub);
    els.test.addEventListener("click", testBackend);
    els.hide.addEventListener("click", () => setPanelVisible(false));
    els.backend.addEventListener("change", () => saveBackendUrl(els.backend.value));
    els.backend.addEventListener("blur", () => saveBackendUrl(els.backend.value));
    els.volume.addEventListener("input", () => {
      els.volumeLabel.textContent = `${els.volume.value}%`;
      applyOriginalVolume();
    });
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (!message || ![
      "YLD_PANEL_STATUS",
      "YLD_PANEL_SHOW",
      "YLD_PANEL_HIDE",
      "YLD_PANEL_TOGGLE",
    ].includes(message.type)) {
      return false;
    }

    try {
      if (message.type === "YLD_PANEL_SHOW") {
        setPanelVisible(true);
      } else if (message.type === "YLD_PANEL_HIDE") {
        setPanelVisible(false);
      } else if (message.type === "YLD_PANEL_TOGGLE") {
        setPanelVisible(!isPanelVisible());
      } else {
        ensurePanel();
      }

      sendResponse({
        ok: true,
        payload: panelStatusPayload(),
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error.message || String(error),
      });
    }
    return false;
  }

  function setPanelVisible(visible) {
    const panel = ensurePanel();
    bindPanelEvents();
    panel.hidden = !visible;
    savePanelVisible(visible);
    if (visible) {
      refreshPageState();
      setStatus(state.status || "idle");
    }
  }

  function isPanelVisible() {
    const panel = ensurePanel();
    return !panel.hidden;
  }

  function panelStatusPayload() {
    return {
      version: BUILD_VERSION,
      visible: isPanelVisible(),
      running: state.running,
      status: state.status,
      videoId: state.videoId || getVideoId() || "",
      backendUrl: els.backend?.value || DEFAULT_BACKEND_URL,
    };
  }

  async function startDub() {
    if (state.running) {
      return;
    }

    refreshPageState();
    if (!state.videoId || !state.video) {
      setStatus("no video");
      updateMeta("Open a YouTube watch page first.", "not loaded", "none");
      return;
    }

    const sessionId = ++state.sessionId;
    state.running = true;
    stopTestAudio();
    state.lastError = "";
    els.start.disabled = true;
    els.stop.disabled = false;
    state.originalVideoVolume = state.video.volume;
    state.originalMuted = state.video.muted;
    state.resumeVideoAfterPrepare = !state.video.paused && !state.video.ended;
    pauseVideoForPrepareIfNeeded();
    applyOriginalVolume();
    setStatus("captions");

    try {
      await ensureBackendReady(els.backend.value);
      if (!isActiveSession(sessionId)) return;
      const segments = await collectCaptionSegments(state.videoId);
      if (!isActiveSession(sessionId)) return;
      state.sourceSegments = segments;

      if (!segments.length) {
        throw new Error("No timed text captions were found for this video.");
      }

      alignVideoToAvailableCaptions(segments);
      state.chunks = chunkSegments(segments);
      state.prepared = [];
      state.preparedChunkIndexes = new Set();
      updateMeta(
        state.videoId,
        `${segments.length} segments, ${state.chunks.length} chunks`,
        "paused while preparing first dub buffer"
      );

      const initialChunks = selectChunksForWindow(state.chunks, getVideoTime()).slice(0, MIN_START_BUFFER_CLIPS);
      maybeExpandTranscriptCoverage(getVideoTime());
      const preparedCount = await prepareAndAppendChunks(initialChunks);
      if (!isActiveSession(sessionId)) return;
      if (!preparedCount) {
        throw new Error("Backend did not return any playable audio data.");
      }

      setStatus("ready");
      updateMeta(
        state.videoId,
        `${segments.length} segments, ${state.chunks.length} chunks`,
        formatAudioState("buffered", getVideoTime())
      );
      beginSyncLoop();
      resumeVideoIfNeeded();
    } catch (error) {
      if (!isActiveSession(sessionId)) return;
      console.error("[YouTube Live Dub MVP]", error);
      state.lastError = error.message || String(error);
      setStatus("error");
      updateMeta(
        state.videoId || "unknown",
        state.sourceSegments.length ? `${state.sourceSegments.length} segments` : "not loaded",
        error.message || String(error)
      );
      stopDub({ keepStatus: true, resumeVideo: true });
    }
  }

  function pauseVideoForPrepareIfNeeded() {
    if (!state.video || state.video.paused || state.video.ended) {
      state.resumeVideoAfterPrepare = false;
      return;
    }

    state.resumeVideoAfterPrepare = true;
    state.video.pause();
    updateMeta(
      state.videoId || getVideoId() || "unknown",
      "not loaded",
      "paused until first dub buffer is ready"
    );
  }

  async function testBackend() {
    if (state.running) return;
    const sessionId = ++state.sessionId;
    els.test.disabled = true;
    state.lastError = "";
    setStatus("testing");
    updateMeta(state.videoId || getVideoId() || "unknown", "not loaded", "checking backend");

    try {
      const backendUrl = normalizeBackendUrl(els.backend.value);
      const body = await ensureBackendReady(backendUrl);
      if (sessionId !== state.sessionId) return;

      const prepare = await requestDubPrepare({
        backendUrl,
        videoId: getVideoId() || "self-test",
        currentTime: getVideoTime(),
        source: "self-test",
        settings: {
          voice: els.voice.value,
          tone: "neutral",
          targetLang: els.lang.value,
          ttsModel: els.model.value,
          ttsProvider: els.ttsProvider.value,
          pitchShift: Number(els.pitch.value),
          pitchVariance: Number(els.variance.value),
          speed: Number(els.speed.value),
        },
        segments: [
          {
            index: 0,
            start: 0,
            end: 2.2,
            text: "This is a backend test.",
          },
        ],
      });

      if (!prepare?.segments?.[0]?.audioDataUrl && !prepare?.segments?.[0]?.audioUrl) {
        throw new Error("Backend prepare test did not return audio data.");
      }

      if (sessionId !== state.sessionId) return;
      await playBackendTestAudio(prepare.segments[0], sessionId);
      if (sessionId !== state.sessionId) return;

      setStatus("backend ok");
      updateMeta(
        state.videoId || getVideoId() || "unknown",
        "not loaded",
        `번역·음성 재생 확인 / 음성: ${prepare.requestProvider?.tts || "unknown"}`
      );
    } catch (error) {
      if (sessionId !== state.sessionId) return;
      state.lastError = error.message || String(error);
      setStatus("error");
      updateMeta(state.videoId || getVideoId() || "unknown", "not loaded", "backend check failed");
    } finally {
      els.test.disabled = false;
    }
  }

  function stopDub(options = {}) {
    const shouldResume = options.resumeVideo !== false && state.resumeVideoAfterPrepare;
    state.sessionId += 1;
    state.running = false;
    els.start.disabled = false;
    els.stop.disabled = true;

    if (state.syncTimer) {
      clearInterval(state.syncTimer);
      state.syncTimer = null;
    }
    if (state.bufferTimer) {
      clearInterval(state.bufferTimer);
      state.bufferTimer = null;
    }

    stopCurrentAudio();
    stopTestAudio();

    if (state.video) {
      if (options.preserveDubVolume) {
        applyOriginalVolume({ force: true });
      } else if (state.originalVideoVolume !== null) {
        state.video.volume = state.originalVideoVolume;
      }
      if (!options.preserveDubVolume && state.originalMuted !== null) {
        state.video.muted = state.originalMuted;
      }
    }

    if (shouldResume && state.video) state.video.play().catch(() => {});
    state.prepared = [];
    state.preparedChunkIndexes = new Set();
    state.preparingChunks = false;
    state.currentChunkIndex = -1;
    revokeObjectUrls();
    state.originalVideoVolume = null;
    state.originalMuted = null;
    state.resumeVideoAfterPrepare = false;
    state.transcriptExpanding = false;
    state.transcriptTargetDuration = 0;

    if (!options.keepStatus) {
      setStatus("stopped");
      updateMeta(state.videoId || "unknown", "not loaded", "none");
    }
  }

  function beginSyncLoop() {
    if (state.syncTimer) {
      clearInterval(state.syncTimer);
    }
    if (state.bufferTimer) {
      clearInterval(state.bufferTimer);
    }

    syncAudioToVideo();
    maybePrepareMoreAudio(getVideoTime(), "start");
    state.syncTimer = setInterval(syncAudioToVideo, 160);
    state.bufferTimer = setInterval(() => {
      maybePrepareMoreAudio(getVideoTime(), "timer");
    }, BUFFER_CHECK_INTERVAL_MS);
  }

  function syncAudioToVideo() {
    if (!state.running || !state.video) {
      return;
    }

    applyOriginalVolume();

    if (state.video.paused || state.video.ended) {
      if (state.currentAudio && !state.currentAudio.paused) {
        state.currentAudio.pause();
      }
      return;
    }

    const videoTime = getVideoTime();
    maybePrepareMoreAudio(videoTime, "sync");

    const chunkIndex = state.prepared.findIndex((item) => {
      return videoTime >= item.start - PREPARE_LEAD_SECONDS && videoTime < item.end;
    });

    if (chunkIndex === -1) {
      updateMeta(
        state.videoId,
        `${state.sourceSegments.length} segments, ${state.chunks.length} chunks`,
        formatAudioState(state.preparingChunks ? "buffering" : "waiting", videoTime)
      );
      stopCurrentAudio();
      return;
    }

    const item = state.prepared[chunkIndex];
    const audioDuration = item.audio?.duration || item.duration || Math.max(0, item.end - item.start);
    const segmentDuration = Math.max(0.35, item.end - item.start);
    const syncRate = clampPlaybackRate(audioDuration / segmentDuration);
    const offset = Math.max(0, Math.min(audioDuration - 0.05, (videoTime - item.start) * syncRate));

    if (item.chunkIndex !== state.currentChunkIndex) {
      stopCurrentAudio();
      state.currentChunkIndex = item.chunkIndex;
      state.currentAudio = item.audio;
      state.currentAudio.volume = 1;
      state.currentAudio.playbackRate = syncRate * (state.video.playbackRate || 1);
      seekAudio(state.currentAudio, offset);
      playAudio(state.currentAudio);
      updateMeta(
        state.videoId,
        `${state.sourceSegments.length} segments, ${state.chunks.length} chunks`,
        formatAudioState(`playing clip ${item.chunkIndex + 1}/${state.chunks.length} @${state.currentAudio.playbackRate.toFixed(2)}x`, videoTime)
      );
      return;
    }

    if (!state.currentAudio) {
      return;
    }

    state.currentAudio.playbackRate = syncRate * (state.video.playbackRate || 1);

    if (Math.abs(state.currentAudio.currentTime - offset) > SYNC_TOLERANCE_SECONDS) {
      seekAudio(state.currentAudio, offset);
    }

    if (state.currentAudio.paused) {
      playAudio(state.currentAudio);
    }
  }

  function stopCurrentAudio() {
    if (!state.currentAudio) {
      return;
    }

    state.currentAudio.pause();
    seekAudio(state.currentAudio, 0);
    state.currentAudio = null;
    state.currentChunkIndex = -1;
  }

  function maybePrepareMoreAudio(videoTime, reason = "auto") {
    if (!state.running || !state.chunks.length) {
      return;
    }

    maybeExpandTranscriptCoverage(videoTime);

    if (state.preparingChunks) {
      return;
    }

    const bufferInfo = getBufferInfo(videoTime);

    if (bufferInfo.readyAhead > NEXT_BUFFER_THRESHOLD_SECONDS && bufferInfo.readyClipsAhead >= 4) {
      return;
    }

    const nextChunks = selectUnpreparedChunksForWindow(state.chunks, videoTime);
    if (!nextChunks.length) {
      return;
    }

    const sessionId = state.sessionId;
    prepareAndAppendChunks(nextChunks).catch((error) => {
      if (!isActiveSession(sessionId)) return;
      console.error("[YouTube Live Dub MVP] Rolling buffer failed.", error);
      state.lastError = error.message || String(error);
      setStatus("error");
      updateMeta(
        state.videoId || "unknown",
        `${state.sourceSegments.length} segments, ${state.chunks.length} chunks`,
        formatAudioState(`rolling buffer failed (${reason})`, videoTime)
      );
      stopDub({ keepStatus: true, resumeVideo: true });
    });
  }

  function isActiveSession(sessionId) {
    return state.running && state.sessionId === sessionId;
  }

  async function prepareAndAppendChunks(chunks) {
    const sessionId = state.sessionId;
    const pending = chunks
      .filter((chunk) => !state.preparedChunkIndexes.has(chunk.index))
      .slice(0, MAX_PREPARE_CHUNKS);

    if (!pending.length) {
      return 0;
    }

    state.preparingChunks = true;
    setStatus(state.prepared.length ? "buffering" : "backend");
    updateMeta(
      state.videoId,
      `${state.sourceSegments.length} segments, ${state.chunks.length} chunks`,
      formatAudioState(`preparing ${pending.length} clips`, getVideoTime())
    );

    try {
      const response = await requestDubPrepare({
        backendUrl: els.backend.value,
        videoId: state.videoId,
        currentTime: getVideoTime(),
        source: "youtube-timedtext",
        settings: dubbingSettingsFromControls(),
        segments: pending,
      });
      if (!isActiveSession(sessionId)) return 0;
      const prepared = normalizePreparedAudio(response, pending);

      if (!prepared.length) {
        return 0;
      }

      await bufferPreparedAudio(prepared);
      if (!isActiveSession(sessionId)) {
        prepared.forEach(item => item.audio?.pause());
        return 0;
      }

      prepared.forEach((item) => {
        state.preparedChunkIndexes.add(item.chunkIndex);
      });
      state.prepared = state.prepared
        .concat(prepared)
        .sort((a, b) => a.start - b.start);

      if (hasStartBufferReady(getVideoTime())) {
        resumeVideoIfNeeded();
      }

      setStatus("ready");
      updateMeta(
        state.videoId,
        `${state.sourceSegments.length} segments, ${state.chunks.length} chunks`,
        formatAudioState(`${state.prepared.length}/${state.chunks.length} clips buffered`, getVideoTime())
      );
      return prepared.length;
    } finally {
      if (state.sessionId === sessionId) state.preparingChunks = false;
      if (isActiveSession(sessionId)) {
        setTimeout(() => { if (isActiveSession(sessionId)) maybePrepareMoreAudio(getVideoTime(), "after-prepare"); }, 0);
      }
    }
  }

  function resumeVideoIfNeeded() {
    if (!state.video || !state.resumeVideoAfterPrepare) {
      return;
    }
    state.resumeVideoAfterPrepare = false;
    applyOriginalVolume();
    const playPromise = state.video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((error) => {
        console.warn("[YouTube Live Dub MVP] Could not resume YouTube playback.", error);
      });
    }
  }

  function hasStartBufferReady(videoTime) {
    const bufferInfo = getBufferInfo(videoTime);
    return bufferInfo.readyAhead >= MIN_START_BUFFER_SECONDS ||
      bufferInfo.readyClipsAhead >= MIN_START_BUFFER_CLIPS;
  }

  function stopTestAudio() {
    if (!state.testAudio) {
      return;
    }

    state.testAudio.pause();
    seekAudio(state.testAudio, 0);
    state.testAudio = null;
  }

  async function playBackendTestAudio(segment, sessionId) {
    stopTestAudio();

    const fetched = segment.audioDataUrl
      ? {
        dataUrl: segment.audioDataUrl,
        contentType: segment.contentType || parseDataUrlContentType(segment.audioDataUrl),
        bytes: segment.bytes || 0,
      }
      : await fetchAudioDataUrl(segment.audioUrl);
    if (sessionId !== state.sessionId) return;
    const audio = new Audio(fetched.dataUrl);
    audio.volume = 1;
    state.testAudio = audio;

    await waitForAudioReady(audio);

    if (sessionId !== state.sessionId) return;
    try {
      await audio.play();
    } catch (error) {
      throw new Error(`Test audio play failed: ${error.message || String(error)}. Click the YouTube video once, then press Test again.`);
    }
  }

  function playAudio(audio) {
    const promise = audio.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch((error) => {
        state.lastError = `Audio play failed: ${error.message || String(error)}. Click the YouTube video once, then press Start again.`;
        setStatus("error");
        updateMeta(state.videoId || "unknown", `${state.sourceSegments.length} segments`, state.lastError);
        console.warn("[YouTube Live Dub MVP] Audio play was blocked or failed.", error);
      });
    }
  }

  function seekAudio(audio, seconds) {
    try {
      audio.currentTime = Number.isFinite(seconds) ? seconds : 0;
    } catch (_error) {
      // Some audio URLs may not be seekable until metadata has loaded.
    }
  }

  async function bufferPreparedAudio(items) {
    revokeObjectUrls();

    await Promise.all(
      items.map(async (item) => {
        const fetched = item.audioDataUrl
          ? {
            dataUrl: item.audioDataUrl,
            contentType: item.contentType || parseDataUrlContentType(item.audioDataUrl),
            bytes: item.bytes || 0,
          }
          : await fetchAudioDataUrl(item.audioUrl);

        const audio = new Audio(fetched.dataUrl);
        audio.preload = "auto";
        item.audio = audio;
        await waitForAudioReady(audio);
      })
    );
  }

  function waitForAudioReady(audio) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        audio.removeEventListener("loadeddata", onReady);
        audio.removeEventListener("canplaythrough", onReady);
        audio.removeEventListener("error", onError);
      };
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("Audio decoding failed.")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Audio did not decode within 10 seconds.")); }, 10000);
      audio.addEventListener("loadeddata", onReady, { once: true });
      audio.addEventListener("canplaythrough", onReady, { once: true });
      audio.addEventListener("error", onError, { once: true });
      audio.load();
    });
  }

  async function fetchAudioDataUrl(audioUrl) {
    const response = await chrome.runtime.sendMessage({
      type: "YLD_FETCH_AUDIO",
      payload: { audioUrl },
    });

    if (!response || !response.ok || !response.payload?.dataUrl) {
      throw new Error(response && response.error ? response.error : `Audio fetch failed for ${audioUrl}`);
    }

    return response.payload;
  }

  function revokeObjectUrls() {
    state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    state.objectUrls = [];
  }

  async function requestDubPrepare(payload) {
    const response = await chrome.runtime.sendMessage({
      type: "YLD_PREPARE_DUB",
      payload,
    });

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Backend request failed.");
    }

    return response.payload || {};
  }

  async function ensureBackendReady(backendUrl) {
    const response = await chrome.runtime.sendMessage({ type: "YLD_BACKEND_HEALTH", payload: { backendUrl } });
    if (!response?.ok || !response.payload?.ok) throw new Error(response?.error || "Backend is unavailable.");
    return response.payload;
  }

  async function startBackendViaNativeHost(backendUrl) {
    const response = await chrome.runtime.sendMessage({
      type: "YLD_BACKEND_START",
      payload: { backendUrl },
    });

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Failed to start backend via native host.");
    }
    return response.payload || {};
  }

  async function collectCaptionSegments(videoId) {
    const sessionId = state.sessionId;
    let playerResponse = findPlayerResponse(videoId) || null;
    let tracks = getPlayerCaptionTracks(playerResponse);

    if (!tracks.length) {
      const pagePlayerResponse = await requestPagePlayerResponse(videoId);
      if (!isActiveSession(sessionId)) return [];
      const pageTracks = getPlayerCaptionTracks(pagePlayerResponse);
      if (pageTracks.length || !playerResponse) {
        playerResponse = pagePlayerResponse;
        tracks = pageTracks;
      }
    }

    const fallbackReason = tracks.length
      ? "No timed transcript segments were available for this video"
      : "No YouTube caption tracks were found";

    if (tracks.length) {
      for (const track of prioritizeCaptionTracks(tracks)) {
        const parsed = await fetchCaptionTrackSegments(track, videoId);
      if (!isActiveSession(sessionId)) return [];
        if (parsed.length) {
          return parsed;
        }
      }
    }

    const primedSegments = await requestPageCaptionPrime(videoId);
      if (!isActiveSession(sessionId)) return [];
    if (primedSegments.length) {
      return primedSegments;
    }

    const textTrackSegments = await collectVideoTextTrackSegments();
      if (!isActiveSession(sessionId)) return [];
    if (textTrackSegments.length) {
      return textTrackSegments;
    }

    const transcriptSegments = await fetchPageTranscriptSegments(videoId);
      if (!isActiveSession(sessionId)) return [];
    if (transcriptSegments.length) {
      return transcriptSegments;
    }

    if (ENABLE_VISIBLE_CAPTION_FALLBACK) {
      const visibleCaptionSegments = await collectVisibleCaptionSegments();
      if (!isActiveSession(sessionId)) return [];
      if (visibleCaptionSegments.length) {
        return visibleCaptionSegments;
      }
    }

    return fetchFallbackCaptionSegments(videoId, fallbackReason);
  }

  function getPlayerCaptionTracks(playerResponse) {
    return playerResponse &&
      playerResponse.captions &&
      playerResponse.captions.playerCaptionsTracklistRenderer &&
      playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
        ? playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
        : [];
  }

  function requestPageCaptionPrime(videoId) {
    return new Promise((resolve) => {
      const requestId = `yld-prime-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let settled = false;

      const finish = (segments) => {
        if (settled) {
          return;
        }
        settled = true;
        window.removeEventListener("message", onMessage);
        resolve(Array.isArray(segments) ? normalizeTranscriptSegments(segments) : []);
      };

      const onMessage = (event) => {
        if (event.source !== window || event.data?.source !== "YLD_PAGE") {
          return;
        }

        const sameRequest = event.data.requestId === requestId;
        const sameVideo = !event.data.videoId || event.data.videoId === videoId;
        if (!sameVideo || (!sameRequest && event.data.type !== "TRANSCRIPT_OBSERVED")) {
          return;
        }

        if (
          event.data.type === "PLAYER_RESPONSE" ||
          event.data.type === "TRANSCRIPT_OBSERVED" ||
          event.data.type === "TRANSCRIPT_RESPONSE" ||
          event.data.type === "CAPTIONS_PRIMED"
        ) {
          storePageTranscriptData(event.data);
        }

        const segments = Array.isArray(event.data.segments) && event.data.segments.length
          ? event.data.segments
          : state.pageTranscriptVideoId === videoId && state.pageTranscriptSegments.length
            ? state.pageTranscriptSegments
            : [];
        if (segments.length) {
          finish(segments);
        }
      };

      setStatus("page captions");
      updateMeta(
        videoId,
        "asking YouTube player for captions",
        "waiting for browser caption data"
      );

      window.addEventListener("message", onMessage);
      injectPageProbe(requestId, "prime-captions", { targetLang: els.lang.value });
      setTimeout(() => {
        const cached = state.pageTranscriptVideoId === videoId ? state.pageTranscriptSegments : [];
        finish(cached);
      }, PAGE_CAPTION_PRIME_WAIT_MS);
    });
  }

  async function collectVideoTextTrackSegments() {
    if (!state.video) {
      return [];
    }

    setStatus("text tracks");
    updateMeta(
      state.videoId || getVideoId() || "unknown",
      "reading player text tracks",
      "checking timed cues"
    );

    const immediate = readVideoTextTrackSegments();
    if (immediate.length) {
      return immediate;
    }

    tryEnableYouTubeCaptions();
    primeVideoTextTracks();

    const startedAt = performance.now();
    let best = [];

    while (state.running && performance.now() - startedAt < TEXT_TRACK_WAIT_MS) {
      const segments = readVideoTextTrackSegments();
      if (segments.length > best.length) {
        best = segments;
      }
      if (segments.length >= 2) {
        return segments;
      }
      await delay(180);
    }

    return best;
  }

  function primeVideoTextTracks() {
    const tracks = Array.from(state.video?.textTracks || []);
    tracks.forEach((track) => {
      if (!isUsableTextTrack(track)) {
        return;
      }
      try {
        if (track.mode === "disabled") {
          track.mode = "hidden";
        }
      } catch (_error) {}
    });
  }

  function readVideoTextTrackSegments() {
    const tracks = Array.from(state.video?.textTracks || [])
      .filter(isUsableTextTrack)
      .sort((a, b) => textTrackScore(a) - textTrackScore(b));

    for (const track of tracks) {
      const segments = readSegmentsFromTextTrack(track);
      if (segments.length) {
        console.info("[YouTube Live Dub MVP] Captions loaded from video textTrack.", {
          label: track.label,
          language: track.language,
          count: segments.length,
        });
        return segments;
      }
    }

    return [];
  }

  function isUsableTextTrack(track) {
    const kind = String(track?.kind || "").toLowerCase();
    return kind === "captions" || kind === "subtitles" || kind === "metadata";
  }

  function textTrackScore(track) {
    const language = String(track.language || "").toLowerCase();
    const label = String(track.label || "").toLowerCase();
    const target = String(els.lang.value || "").toLowerCase();
    const isTarget = target && (language === target || language.startsWith(`${target}-`) || label.includes(languageNameForTarget(target)));
    const isShowing = track.mode === "showing";
    const isHidden = track.mode === "hidden";

    if (!isTarget && isShowing) {
      return 0;
    }
    if (!isTarget && isHidden) {
      return 1;
    }
    if (!isTarget) {
      return 2;
    }
    if (isShowing || isHidden) {
      return 3;
    }
    return 4;
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

  function readSegmentsFromTextTrack(track) {
    let cues = [];
    try {
      cues = Array.from(track.cues || []);
    } catch (_error) {
      return [];
    }

    return normalizeTimedSegments(cues
      .map((cue) => {
        const lines = dedupeCaptionLines(String(cue.text || "").split(/\r?\n/));
        const sourceLines = filterSourceCaptionLines(lines, els.lang.value);
        return {
          start: Number(cue.startTime),
          end: Number(cue.endTime),
          text: sourceLines.join(" "),
        };
      })
      .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text));
  }

  function normalizeTimedSegments(segments) {
    const normalized = [];
    const sorted = segments
      .map((segment) => ({
        start: roundTime(segment.start),
        end: roundTime(segment.end),
        text: cleanCaptionText(stripCueMarkup(segment.text)),
      }))
      .filter((segment) => segment.text)
      .sort((a, b) => a.start - b.start);

    sorted.forEach((segment) => {
      const previous = normalized[normalized.length - 1];
      const previousKey = previous ? normalizeVisibleCaptionText(previous.text) : "";
      const currentKey = normalizeVisibleCaptionText(segment.text);

      if (previous && previousKey === currentKey && segment.start - previous.end <= 0.5) {
        previous.end = Math.max(previous.end, segment.end);
        return;
      }

      normalized.push(segment);
    });

    return normalized;
  }

  function stripCueMarkup(text) {
    return String(text || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\{\\[^}]+\}/g, " ");
  }

  async function collectVisibleCaptionSegments() {
    if (!state.video) {
      return [];
    }

    setStatus("read captions");
    updateMeta(
      state.videoId || getVideoId() || "unknown",
      "reading visible captions",
      "turn on YouTube captions with C"
    );

    tryEnableYouTubeCaptions();

    const observed = [];
    let lastKey = "";
    let lastSegment = null;
    const startedAt = performance.now();

    while (state.running && performance.now() - startedAt < VISIBLE_CAPTION_COLLECT_MS) {
      const text = readVisibleCaptionText();
      const videoTime = getVideoTime();
      const key = normalizeVisibleCaptionText(text);

      if (key && key !== lastKey) {
        if (lastSegment) {
          lastSegment.end = Math.max(lastSegment.start + 0.6, videoTime);
        }
        lastSegment = {
          start: roundTime(videoTime),
          end: roundTime(videoTime + 2),
          text: text,
        };
        observed.push(lastSegment);
        lastKey = key;
      } else if (key && lastSegment) {
        lastSegment.end = roundTime(Math.max(lastSegment.end, videoTime + 0.4));
      }

      if (observed.length >= 4) {
        break;
      }

      await delay(180);
    }

    if (lastSegment) {
      lastSegment.end = roundTime(Math.max(lastSegment.end, getVideoTime() + 0.4));
    }

    return observed
      .filter((segment) => segment.text && segment.end > segment.start)
      .map((segment, index, segments) => ({
        start: segment.start,
        end: segments[index + 1]
          ? Math.min(segment.end, segments[index + 1].start)
          : segment.end,
        text: segment.text,
      }))
      .filter((segment) => segment.end > segment.start);
  }

  function tryEnableYouTubeCaptions() {
    const player = document.querySelector("#movie_player");
    try {
      if (player?.isSubtitlesOn?.()) {
        return;
      }
      if (player?.toggleSubtitles) {
        player.toggleSubtitles();
        return;
      }
    } catch (_error) {}

    const button = document.querySelector(".ytp-subtitles-button");
    if (button && button.getAttribute("aria-pressed") !== "true") {
      button.click();
    }
  }

  function readVisibleCaptionText() {
    const selectors = [
      ".ytp-caption-segment",
      ".caption-window .captions-text",
      ".ytp-caption-window-container",
      ".ytp-caption-window-bottom",
    ];
    const parts = [];

    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const text = cleanCaptionText(node.textContent || "");
        if (
          text &&
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        ) {
          parts.push(text);
        }
      });
    });

    return filterSourceCaptionLines(dedupeCaptionLines(parts), els.lang.value).join(" ");
  }

  function normalizeVisibleCaptionText(text) {
    return cleanCaptionText(text)
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function dedupeCaptionLines(lines) {
    const seen = new Set();
    const result = [];
    lines.forEach((line) => {
      const clean = cleanCaptionText(line);
      const key = clean.replace(/\s+/g, "");
      if (clean && !seen.has(key)) {
        seen.add(key);
        result.push(clean);
      }
    });
    return result;
  }

  function filterSourceCaptionLines(lines, targetLang) {
    const filtered = lines.filter((line) => !isTargetLanguageCaption(line, targetLang));
    return filtered.length ? filtered : lines;
  }

  function isTargetLanguageCaption(line, targetLang) {
    const text = cleanCaptionText(line);
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

  async function fetchPageTranscriptSegments(videoId) {
    try {
      if (state.pageTranscriptVideoId === videoId && state.pageTranscriptSegments.length) {
        return state.pageTranscriptSegments;
      }

      const pageFetched = await requestPageTranscriptFetch(videoId);
      if (pageFetched.length) {
        return pageFetched;
      }

      if (state.pageTranscriptVideoId !== videoId || !state.pageTranscriptEndpoint || !state.pageYoutubeConfig) {
        await requestPagePlayerResponse(videoId);
      }

      const endpoint =
        state.pageTranscriptVideoId === videoId && state.pageTranscriptEndpoint
          ? state.pageTranscriptEndpoint
          : findTranscriptEndpoint();
      const config =
        state.pageTranscriptVideoId === videoId && state.pageYoutubeConfig
          ? state.pageYoutubeConfig
          : findYouTubeConfig();

      if (!endpoint?.params || !config?.INNERTUBE_API_KEY || !config?.INNERTUBE_CONTEXT) {
        console.warn("[YouTube Live Dub MVP] Transcript endpoint context was not found.", {
          endpoint: Boolean(endpoint?.params),
          config: Boolean(config?.INNERTUBE_API_KEY && config?.INNERTUBE_CONTEXT),
        });
        return [];
      }

      const context = config.INNERTUBE_CONTEXT;
      const visitorData = context.client?.visitorData || config.VISITOR_DATA || "";
      const headers = {
        "content-type": "application/json",
        "x-youtube-client-name": String(config.INNERTUBE_CONTEXT_CLIENT_NAME || "1"),
        "x-youtube-client-version": String(context.client?.clientVersion || ""),
      };
      if (visitorData) {
        headers["x-goog-visitor-id"] = String(visitorData);
      }

      const response = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(config.INNERTUBE_API_KEY)}`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          context,
          params: endpoint.params,
        }),
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        console.warn("[YouTube Live Dub MVP] Transcript endpoint failed.", response.status, payload);
        return [];
      }

      const segments = parseTranscriptEndpointSegments(payload);
      if (segments.length) {
        storePageTranscriptData({
          videoId,
          segments,
          transcriptEndpoint: endpoint,
          youtubeConfig: config,
        });
        console.info("[YouTube Live Dub MVP] Captions loaded through transcript endpoint.", videoId, segments.length);
      }
      return segments;
    } catch (error) {
      console.warn("[YouTube Live Dub MVP] Transcript endpoint fallback failed.", error);
      return [];
    }
  }

  function requestPageTranscriptFetch(videoId) {
    return new Promise((resolve) => {
      const requestId = `yld-transcript-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let settled = false;

      const finish = (segments) => {
        if (settled) {
          return;
        }
        settled = true;
        window.removeEventListener("message", onMessage);
        resolve(Array.isArray(segments) ? segments : []);
      };

      const onMessage = (event) => {
        if (event.source !== window || event.data?.source !== "YLD_PAGE" || event.data?.requestId !== requestId) {
          return;
        }

        if (event.data.type === "PLAYER_RESPONSE") {
          storePageTranscriptData(event.data);
          return;
        }

        if (event.data.type === "TRANSCRIPT_RESPONSE") {
          storePageTranscriptData(event.data);
          finish(event.data.segments || []);
        }
      };

      window.addEventListener("message", onMessage);
      injectPageProbe(requestId, "fetch-transcript");
      setTimeout(() => finish([]), 5500);
    });
  }

  function findTranscriptEndpoint() {
    for (const script of document.scripts) {
      const text = script.textContent || "";
      const endpoint = parseJsonObjectAfterPattern(text, "\"getTranscriptEndpoint\"");
      if (endpoint?.params) {
        return endpoint;
      }
    }
    return null;
  }

  function findYouTubeConfig() {
    for (const script of document.scripts) {
      const text = script.textContent || "";
      let searchIndex = 0;

      while (searchIndex < text.length) {
        const index = text.indexOf("ytcfg.set", searchIndex);
        if (index === -1) {
          break;
        }

        const braceStart = text.indexOf("{", index);
        if (braceStart === -1) {
          break;
        }

        const parsed = safeJsonParse(extractBalancedObject(text, braceStart));
        if (parsed?.INNERTUBE_API_KEY && parsed?.INNERTUBE_CONTEXT) {
          return parsed;
        }
        searchIndex = index + 9;
      }
    }
    return null;
  }

  function parseJsonObjectAfterPattern(text, pattern) {
    const index = text.indexOf(pattern);
    if (index === -1) {
      return null;
    }

    const braceStart = text.indexOf("{", index);
    if (braceStart === -1) {
      return null;
    }

    return safeJsonParse(extractBalancedObject(text, braceStart));
  }

  function parseTranscriptEndpointSegments(payload) {
    const renderers = [];
    collectTranscriptRenderers(payload, renderers);

    const rawSegments = renderers
      .map((renderer) => ({
        start: Number(renderer.startMs || 0) / 1000,
        end: Number(renderer.endMs || 0) / 1000,
        text: cleanCaptionText(readText(renderer.snippet)),
      }))
      .filter((segment) => Number.isFinite(segment.start) && segment.text)
      .sort((a, b) => a.start - b.start);

    return rawSegments
      .map((segment, index) => ({
        start: segment.start,
        end: segment.end > segment.start
          ? segment.end
          : rawSegments[index + 1]?.start || segment.start + 2,
        text: segment.text,
      }))
      .filter((segment) => segment.end > segment.start);
  }

  function collectTranscriptRenderers(value, output) {
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectTranscriptRenderers(item, output));
      return;
    }
    if (value.transcriptSegmentRenderer) {
      output.push(value.transcriptSegmentRenderer);
    }
    Object.values(value).forEach((item) => collectTranscriptRenderers(item, output));
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

  async function fetchFallbackCaptionSegments(videoId, reason) {
    const sessionId = state.sessionId;
    if (!isActiveSession(sessionId)) return [];
    const backendSegments = await fetchBackendCaptionSegments(videoId);
    if (!isActiveSession(sessionId)) return [];
    if (segmentsCoverPlaybackStart(backendSegments, getVideoTime())) {
      return backendSegments;
    }

    const preprocessedSegments = await preprocessCaptionSegments(videoId, backendSegments);
    if (preprocessedSegments.length) {
      return preprocessedSegments;
    }

    throw new Error(`${reason} for video ${videoId}. Try the sample: https://www.youtube.com/watch?v=kBXQZMmiA4s`);
  }

  function segmentsCoverPlaybackStart(segments, videoTime) {
    if (!Array.isArray(segments) || !segments.length) {
      return false;
    }

    const safeTime = Number.isFinite(videoTime) ? videoTime : 0;
    const firstStart = Number(segments[0]?.start) || 0;
    const lastEnd = getLastSegmentEnd(segments);
    if (safeTime < firstStart - 2) {
      return false;
    }
    return lastEnd >= safeTime + MIN_START_BUFFER_SECONDS;
  }

  async function fetchBackendCaptionSegments(videoId) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "YLD_FETCH_CAPTIONS",
        payload: {
          backendUrl: els.backend.value,
          videoId,
        },
      });

      if (!response || !response.ok) {
        return [];
      }

      return Array.isArray(response.payload?.segments)
        ? response.payload.segments.map((segment) => ({
          start: Number(segment.start),
          end: Number(segment.end),
          text: cleanCaptionText(segment.text || ""),
        })).filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.text)
        : [];
    } catch (error) {
      console.warn("[YouTube Live Dub MVP] Backend caption fallback failed.", error);
      return [];
    }
  }

  async function preprocessCaptionSegments(videoId, seedSegments = []) {
    const sessionId = state.sessionId;
    try {
      const videoTime = getVideoTime();
      const cachedLastEnd = getLastSegmentEnd(seedSegments);
      const needsCurrentWindow = videoTime > 20 && cachedLastEnd < videoTime + MIN_START_BUFFER_SECONDS;
      const startTime = needsCurrentWindow
        ? Math.max(0, videoTime - STT_EXTENSION_OVERLAP_SECONDS)
        : 0;
      const windowDuration = needsCurrentWindow ? INITIAL_STT_DURATION_SECONDS : 0;
      const maxDuration = needsCurrentWindow
        ? startTime + windowDuration
        : Math.max(INITIAL_STT_DURATION_SECONDS, videoTime + INITIAL_STT_DURATION_SECONDS);
      setStatus("stt");
      updateMeta(
        videoId,
        needsCurrentWindow
          ? `starting local STT ${formatTime(startTime)}-${formatTime(startTime + windowDuration)}`
          : "starting local STT fallback",
        "downloading original audio"
      );

      const payload = {
        backendUrl: els.backend.value,
        videoId,
        videoUrl: window.location.href,
        language: "auto",
        sttModel: STT_MODEL,
        maxDuration,
        prewarmSegments: 0,
        settings: dubbingSettingsFromControls(),
      };
      if (needsCurrentWindow) {
        payload.startTime = startTime;
        payload.windowDuration = windowDuration;
        payload.force = true;
      }

      const startResponse = await chrome.runtime.sendMessage({
        type: "YLD_PREPROCESS_CAPTIONS",
        payload,
      });

      if (!startResponse || !startResponse.ok) {
        return [];
      }

      if (!isActiveSession(sessionId)) return [];
      const immediateSegments = normalizePreprocessSegments(startResponse.payload?.segments);
      if (immediateSegments.length) {
        return immediateSegments;
      }

      const startedAt = Date.now();
      let lastStatus = startResponse.payload?.status || "running";

      while (isActiveSession(sessionId) && Date.now() - startedAt < PREPROCESS_WAIT_MS) {
        const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
        updateMeta(
          videoId,
          `local STT ${lastStatus} (${elapsedSeconds}s)`,
          "waiting for generated captions"
        );
        await delay(PREPROCESS_POLL_MS);
        if (!isActiveSession(sessionId)) return [];

        const cachedSegments = await fetchBackendCaptionSegments(videoId);
        if (!isActiveSession(sessionId)) return [];
        if (cachedSegments.length) {
          state.transcriptTargetDuration = Math.max(state.transcriptTargetDuration, getLastSegmentEnd(cachedSegments));
          return cachedSegments;
        }

        const statusResponse = await chrome.runtime.sendMessage({
          type: "YLD_PREPROCESS_STATUS",
          payload: {
            backendUrl: els.backend.value,
            videoId,
          },
        });

        if (!statusResponse || !statusResponse.ok) {
          return [];
        }

        lastStatus = statusResponse.payload?.status || lastStatus;
        if (!isActiveSession(sessionId)) return [];
        const segments = normalizePreprocessSegments(statusResponse.payload?.segments);
        if (segments.length) {
          state.transcriptTargetDuration = Math.max(state.transcriptTargetDuration, getLastSegmentEnd(segments));
          return segments;
        }

        if (lastStatus === "done") {
          const fallbackSegments = await fetchBackendCaptionSegments(videoId);
          if (fallbackSegments.length) {
            return fallbackSegments;
          }
          console.warn("[YouTube Live Dub MVP] Local STT status is done, but no segments were returned.", statusResponse.payload);
          return [];
        }

        if (lastStatus === "failed") {
          console.warn("[YouTube Live Dub MVP] Local STT preprocessing failed.", statusResponse.payload);
          return [];
        }
      }
    } catch (error) {
      console.warn("[YouTube Live Dub MVP] Local STT preprocessing fallback failed.", error);
    }

    return [];
  }

  function maybeExpandTranscriptCoverage(videoTime) {
    if (!state.running || state.transcriptExpanding || !state.sourceSegments.length) {
      return;
    }

    const lastEnd = getLastSegmentEnd(state.sourceSegments);
    const remainingTranscript = lastEnd - videoTime;
    const lastChunk = state.chunks[state.chunks.length - 1];
    const currentChunkIndex = state.chunks.findIndex((chunk) => {
      return videoTime >= chunk.start - PREPARE_LEAD_SECONDS && videoTime < chunk.end;
    });
    const chunksRemaining = currentChunkIndex === -1
      ? state.chunks.filter((chunk) => chunk.end >= videoTime).length
      : state.chunks.length - currentChunkIndex - 1;

    if (
      lastEnd >= STT_MAX_DURATION_SECONDS ||
      (remainingTranscript > STT_EXTENSION_THRESHOLD_SECONDS && chunksRemaining > 10)
    ) {
      return;
    }

    const currentTarget = Math.max(
      state.transcriptTargetDuration || 0,
      lastChunk?.end || 0,
      lastEnd
    );
    const nextTarget = Math.min(
      STT_MAX_DURATION_SECONDS,
      Math.max(currentTarget + STT_EXTENSION_SECONDS, videoTime + BUFFER_WINDOW_SECONDS)
    );

    if (nextTarget <= currentTarget + 5) {
      return;
    }

    const windowStart = Math.max(0, Math.min(lastEnd, currentTarget) - STT_EXTENSION_OVERLAP_SECONDS);
    const windowDuration = Math.max(15, nextTarget - windowStart);
    state.transcriptExpanding = true;
    state.transcriptTargetDuration = nextTarget;
    const sessionId = state.sessionId;
    expandTranscriptCoverage({
      windowStart,
      windowDuration,
      targetDuration: nextTarget,
    }).then((installed) => {
      if (!isActiveSession(sessionId)) return;
      if (!installed && getLastSegmentEnd(state.sourceSegments) < nextTarget - 5) {
        state.transcriptTargetDuration = getLastSegmentEnd(state.sourceSegments);
      }
    }).finally(() => {
      if (!isActiveSession(sessionId)) return;
      state.transcriptExpanding = false;
      if (state.running) {
        maybePrepareMoreAudio(getVideoTime(), "after-transcript-expand");
      }
    });
  }

  async function expandTranscriptCoverage(request) {
    const sessionId = state.sessionId;
    const targetDuration = Number(request?.targetDuration || 0);
    const windowStart = Math.max(0, Number(request?.windowStart || 0));
    const windowDuration = Math.max(15, Number(request?.windowDuration || STT_EXTENSION_SECONDS));
    const videoId = state.videoId || getVideoId();
    if (!videoId) {
      return false;
    }

    try {
      updateMeta(
        videoId,
        `${state.sourceSegments.length} segments, ${state.chunks.length} chunks`,
        formatAudioState(`extending transcript ${formatTime(windowStart)}-${formatTime(windowStart + windowDuration)}`, getVideoTime())
      );

      const startResponse = await chrome.runtime.sendMessage({
        type: "YLD_PREPROCESS_CAPTIONS",
        payload: {
          backendUrl: els.backend.value,
          videoId,
          videoUrl: window.location.href,
          language: "auto",
          sttModel: STT_MODEL,
          startTime: windowStart,
          windowDuration,
          maxDuration: targetDuration,
          prewarmSegments: 0,
          force: true,
          settings: dubbingSettingsFromControls(),
        },
      });

      if (!startResponse || !startResponse.ok) {
        return false;
      }

      if (!isActiveSession(sessionId)) return [];
      const immediateSegments = normalizePreprocessSegments(startResponse.payload?.segments);
      if (maybeInstallExpandedSegments(immediateSegments)) {
        return true;
      }

      const startedAt = Date.now();
      while (isActiveSession(sessionId) && Date.now() - startedAt < PREPROCESS_WAIT_MS) {
        await delay(PREPROCESS_POLL_MS);
        if (!isActiveSession(sessionId)) return [];
        const statusResponse = await chrome.runtime.sendMessage({
          type: "YLD_PREPROCESS_STATUS",
          payload: {
            backendUrl: els.backend.value,
            videoId,
          },
        });

        if (!statusResponse || !statusResponse.ok) {
          return false;
        }

        if (!isActiveSession(sessionId)) return [];
        const segments = normalizePreprocessSegments(statusResponse.payload?.segments);
        if (maybeInstallExpandedSegments(segments)) {
          return true;
        }

        if (statusResponse.payload?.status === "failed") {
          console.warn("[YouTube Live Dub MVP] Transcript expansion failed.", statusResponse.payload);
          return false;
        }
      }
    } catch (error) {
      console.warn("[YouTube Live Dub MVP] Transcript expansion failed.", error);
    }

    return false;
  }

  function maybeInstallExpandedSegments(segments) {
    if (!Array.isArray(segments) || !segments.length) {
      return false;
    }

    const currentLastEnd = getLastSegmentEnd(state.sourceSegments);
    const nextLastEnd = getLastSegmentEnd(segments);
    if (nextLastEnd <= currentLastEnd + 2 || segments.length <= state.sourceSegments.length) {
      return false;
    }

    state.sourceSegments = mergeTimedSegments(state.sourceSegments, segments, currentLastEnd);
    state.chunks = chunkSegments(state.sourceSegments);
    state.transcriptTargetDuration = Math.max(state.transcriptTargetDuration, nextLastEnd);
    updateMeta(
      state.videoId,
      `${state.sourceSegments.length} segments, ${state.chunks.length} chunks`,
      formatAudioState(`transcript extended to ${formatTime(nextLastEnd)}`, getVideoTime())
    );
    return true;
  }

  function mergeTimedSegments(current, incoming, currentLastEnd = 0) {
    const extensionSegments = incoming.filter((segment) => {
      return Number(segment.end) > currentLastEnd - 1;
    });
    const merged = [...current, ...extensionSegments]
      .map((segment) => ({
        start: Number(segment.start),
        end: Number(segment.end),
        text: cleanCaptionText(segment.text || ""),
      }))
      .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text)
      .sort((a, b) => a.start - b.start);
    const result = [];
    const seen = new Set();

    merged.forEach((segment) => {
      const key = `${Math.round(segment.start * 10)}:${Math.round(segment.end * 10)}:${segment.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(segment);
      }
    });

    return result;
  }

  function normalizePreprocessSegments(segments) {
    return Array.isArray(segments)
      ? segments.map((segment) => ({
        start: Number(segment.start),
        end: Number(segment.end),
        text: cleanCaptionText(segment.text || ""),
      })).filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text)
      : [];
  }

  function pickCaptionTrack(tracks) {
    const preferredLang = "en";
    return (
      tracks.find((track) => track.languageCode === preferredLang && track.kind !== "asr") ||
      tracks.find((track) => track.languageCode === preferredLang) ||
      tracks.find((track) => track.kind !== "asr") ||
      tracks[0]
    );
  }

  function prioritizeCaptionTracks(tracks) {
    return [...tracks]
      .filter((track) => track && track.baseUrl)
      .sort((a, b) => captionTrackScore(a) - captionTrackScore(b));
  }

  function captionTrackScore(track) {
    const language = String(track.languageCode || "").toLowerCase();
    const name = getCaptionTrackName(track).toLowerCase();
    const isAuto = track.kind === "asr" || name.includes("auto");
    const isEnglish = language === "en" || language.startsWith("en-");

    if (isEnglish && !isAuto) {
      return 0;
    }
    if (isEnglish) {
      return 1;
    }
    if (!isAuto) {
      return 2;
    }
    return 3;
  }

  function getCaptionTrackName(track) {
    return track?.name?.simpleText || track?.name?.runs?.map((run) => run.text || "").join("") || "";
  }

  async function fetchCaptionTrackSegments(track, videoId) {
    const urls = buildCaptionUrls(track.baseUrl, videoId);

    for (const item of urls) {
      try {
        const response = await fetch(item.url, {
          credentials: "include",
          headers: buildYouTubeClientHeaders(),
        });
        const text = await response.text();

        if (!response.ok) {
          console.warn("[YouTube Live Dub MVP] Timedtext request failed.", response.status, item.url);
          continue;
        }

        const parsed = parseCaptionResponse(text, item.format);
        if (parsed.length) {
          return parsed;
        }
      } catch (error) {
        console.warn("[YouTube Live Dub MVP] Timedtext format failed.", item.format, error);
      }
    }

    return [];
  }

  function buildCaptionUrls(baseUrl, videoId) {
    const formats = ["json3", "vtt", "srv3", ""];
    const seen = new Set();
    const urls = [];

    formats.forEach((format) => {
      addCaptionUrlVariant(urls, seen, baseUrl, videoId, format, false);
      addCaptionUrlVariant(urls, seen, baseUrl, videoId, format, true);
    });

    return urls;
  }

  function addCaptionUrlVariant(urls, seen, baseUrl, videoId, format, withBrowserClientParams) {
    const url = new URL(baseUrl);
    if (format) {
      url.searchParams.set("fmt", format);
    } else {
      url.searchParams.delete("fmt");
    }
    if (!url.searchParams.get("v")) {
      url.searchParams.set("v", videoId);
    }
    if (withBrowserClientParams) {
      addBrowserClientCaptionParams(url);
    }

    const href = url.toString();
    if (!seen.has(href)) {
      seen.add(href);
      urls.push({ url: href, format });
    }
  }

  function addBrowserClientCaptionParams(url) {
    const context = state.pageYoutubeConfig?.INNERTUBE_CONTEXT?.client || findYouTubeConfig()?.INNERTUBE_CONTEXT?.client || {};
    const browser = parseBrowserVersion();

    if (!url.searchParams.get("c")) {
      url.searchParams.set("c", "WEB");
    }
    if (!url.searchParams.get("cver") && context.clientVersion) {
      url.searchParams.set("cver", context.clientVersion);
    }
    if (!url.searchParams.get("cbr")) {
      url.searchParams.set("cbr", browser.name);
    }
    if (!url.searchParams.get("cbrver") && browser.version) {
      url.searchParams.set("cbrver", browser.version);
    }
    if (!url.searchParams.get("cos")) {
      url.searchParams.set("cos", "Windows");
    }
    if (!url.searchParams.get("cosver")) {
      url.searchParams.set("cosver", "10.0");
    }
    if (!url.searchParams.get("cplatform")) {
      url.searchParams.set("cplatform", "DESKTOP");
    }
    if (!url.searchParams.get("cplayer")) {
      url.searchParams.set("cplayer", "UNIPLAYER");
    }
    if (!url.searchParams.get("xorb")) {
      url.searchParams.set("xorb", "2");
    }
    if (!url.searchParams.get("xobt")) {
      url.searchParams.set("xobt", "3");
    }
    if (!url.searchParams.get("xovt")) {
      url.searchParams.set("xovt", "3");
    }
  }

  function buildYouTubeClientHeaders() {
    const config = state.pageYoutubeConfig || findYouTubeConfig();
    const context = config?.INNERTUBE_CONTEXT || {};
    const headers = {};

    if (config?.INNERTUBE_CONTEXT_CLIENT_NAME) {
      headers["x-youtube-client-name"] = String(config.INNERTUBE_CONTEXT_CLIENT_NAME);
    }
    if (context.client?.clientVersion) {
      headers["x-youtube-client-version"] = String(context.client.clientVersion);
    }
    if (context.client?.visitorData || config?.VISITOR_DATA) {
      headers["x-goog-visitor-id"] = String(context.client?.visitorData || config.VISITOR_DATA);
    }

    return headers;
  }

  function parseBrowserVersion() {
    const userAgent = navigator.userAgent || "";
    const chrome = userAgent.match(/(?:Chrome|CriOS)\/([0-9.]+)/);
    const firefox = userAgent.match(/Firefox\/([0-9.]+)/);
    const edge = userAgent.match(/Edg\/([0-9.]+)/);

    if (edge) {
      return { name: "Edge", version: edge[1] };
    }
    if (firefox) {
      return { name: "Firefox", version: firefox[1] };
    }
    return { name: "Chrome", version: chrome?.[1] || "" };
  }

  function parseCaptionResponse(text, format) {
    if (format === "vtt" || /^\s*WEBVTT\b/i.test(text || "")) {
      return parseVttCaptions(text);
    }
    if (looksLikeJson(text)) {
      try {
        return parseJson3Captions(JSON.parse(text));
      } catch (_error) {
        return [];
      }
    }
    return parseXmlCaptions(text);
  }

  function parseJson3Captions(payload) {
    const events = Array.isArray(payload.events) ? payload.events : [];
    return events
      .map((event) => {
        const text = Array.isArray(event.segs)
          ? event.segs.map((seg) => seg.utf8 || "").join("")
          : "";
        const cleanText = cleanCaptionText(text);
        const start = Number(event.tStartMs || 0) / 1000;
        const duration = Number(event.dDurationMs || 0) / 1000;
        return {
          start,
          end: start + Math.max(duration, 0.6),
          text: cleanText,
        };
      })
      .filter((segment) => segment.text);
  }

  function parseXmlCaptions(text) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    const textSegments = Array.from(doc.querySelectorAll("text"))
      .map((node) => {
        const start = Number(node.getAttribute("start") || 0);
        const duration = Number(node.getAttribute("dur") || 0);
        return {
          start,
          end: start + Math.max(duration, 0.6),
          text: cleanCaptionText(node.textContent || ""),
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
          text: cleanCaptionText(node.textContent || ""),
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

        const caption = lines
          .slice(timingIndex + 1)
          .filter((line) => !/^(NOTE|STYLE|REGION)\b/.test(line))
          .join(" ");
        const textValue = cleanCaptionText(caption);

        if (!textValue) {
          return null;
        }

        return {
          start: parseVttTime(match[1]),
          end: parseVttTime(match[2]),
          text: textValue,
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

  function chunkSegments(segments) {
    const chunks = [];
    let current = null;

    segments.forEach((segment) => {
      if (!current) {
        current = newChunk(segment);
        return;
      }

      const candidateText = `${current.text} ${segment.text}`.trim();
      const candidateDuration = segment.end - current.start;

      if (candidateDuration > 3.8 || candidateText.length > 120) {
        chunks.push(current);
        current = newChunk(segment);
        return;
      }

      current.end = segment.end;
      current.text = candidateText;
      current.segments.push(segment);
    });

    if (current) {
      chunks.push(current);
    }

    return chunks.map((chunk, index) => ({
      id: `${state.videoId || "video"}-${index}`,
      index,
      start: roundTime(chunk.start),
      end: roundTime(chunk.end),
      text: chunk.text,
      segments: chunk.segments.map((segment) => ({
        start: roundTime(segment.start),
        end: roundTime(segment.end),
        text: segment.text,
      })),
    }));
  }

  function newChunk(segment) {
    return {
      start: segment.start,
      end: segment.end,
      text: segment.text,
      segments: [segment],
    };
  }

  function selectChunksForWindow(chunks, currentTime) {
    const safeTime = Number.isFinite(currentTime) ? currentTime : 0;
    const windowEnd = safeTime + BUFFER_WINDOW_SECONDS;
    const preparedEnd = getPreparedEndAfter(safeTime);
    const startAt = Math.max(safeTime, preparedEnd - PREPARE_LEAD_SECONDS);
    const windowed = chunks.filter((chunk) => {
      return chunk.end >= startAt && chunk.start <= windowEnd;
    });

    if (windowed.length) {
      return windowed;
    }

    return chunks.filter((chunk) => chunk.end >= safeTime);
  }

  function selectUnpreparedChunksForWindow(chunks, currentTime) {
    return selectChunksForWindow(chunks, currentTime)
      .filter((chunk) => !state.preparedChunkIndexes.has(chunk.index))
      .slice(0, MAX_PREPARE_CHUNKS);
  }

  function formatAudioState(label, videoTime) {
    const safeTime = Number.isFinite(videoTime) ? videoTime : getVideoTime();
    const bufferInfo = getBufferInfo(safeTime);
    const nextChunk = state.chunks.find((chunk) => {
      return !state.preparedChunkIndexes.has(chunk.index) && chunk.end >= safeTime;
    });
    const nextText = nextChunk
      ? `next ${nextChunk.index + 1}@${formatTime(nextChunk.start)}`
      : "next none";

    return `${label} | video ${formatTime(safeTime)} | ready ${bufferInfo.readyClipsAhead} clips to ${formatTime(bufferInfo.preparedEnd)} (+${Math.round(bufferInfo.readyAhead)}s) | ${nextText}`;
  }

  function getBufferInfo(videoTime) {
    const safeTime = Number.isFinite(videoTime) ? videoTime : getVideoTime();
    const preparedEnd = getPreparedEndAfter(safeTime);
    const readyClipsAhead = state.prepared.filter((item) => {
      return item.end >= safeTime - PREPARE_LEAD_SECONDS;
    }).length;
    return {
      preparedEnd,
      readyAhead: Math.max(0, preparedEnd - safeTime),
      readyClipsAhead,
    };
  }

  function getPreparedEndAfter(videoTime) {
    return state.prepared.reduce((max, item) => {
      if (item.end >= videoTime - PREPARE_LEAD_SECONDS) {
        return Math.max(max, item.end);
      }
      return max;
    }, videoTime);
  }

  function getLastSegmentEnd(segments) {
    return Array.isArray(segments) && segments.length
      ? segments.reduce((max, segment) => Math.max(max, Number(segment.end) || 0), 0)
      : 0;
  }

  function alignVideoToAvailableCaptions(segments) {
    if (!state.video || !segments.length) {
      return;
    }

    const currentTime = getVideoTime();
    const firstStart = segments[0].start;
    const lastEnd = segments[segments.length - 1].end;

    if (currentTime < firstStart || currentTime > lastEnd) {
      seekVideo(firstStart);
    }
  }

  function seekVideo(seconds) {
    try {
      state.video.currentTime = Math.max(0, Number(seconds) || 0);
    } catch (_error) {
      // Ignore seek failures from the YouTube player.
    }
  }

  function normalizePreparedAudio(response, chunks) {
    const rawItems = Array.isArray(response.audioUrls)
      ? response.audioUrls.map((audioUrl, index) => ({ audioUrl, index }))
      : Array.isArray(response.segments)
        ? response.segments
      : Array.isArray(response.chunks)
        ? response.chunks
        : Array.isArray(response.items)
          ? response.items
          : [];

    return rawItems
      .map((item, fallbackIndex) => {
        const index = Number.isInteger(item.index) ? item.index : fallbackIndex;
        const sourceChunk = chunks.find((chunk) => chunk.index === index) || chunks[fallbackIndex] || {};
        const audioUrl = item.audioUrl || item.url || item.audio_url;
        const audioDataUrl = item.audioDataUrl || item.dataUrl || item.audio_data_url;

        if (!audioUrl && !audioDataUrl) {
          return null;
        }

        return {
          index,
          chunkIndex: index,
          start: Number(item.start ?? sourceChunk.start ?? 0),
          end: Number(item.end ?? sourceChunk.end ?? sourceChunk.start ?? 0),
          audioUrl,
          audioDataUrl,
          contentType: item.contentType || item.content_type || "",
          bytes: Number(item.bytes || 0),
          audio: null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
  }

  function findPlayerResponse(videoId = getVideoId()) {
    if (state.pagePlayerResponse && state.pagePlayerResponseVideoId === getVideoId()) {
      return state.pagePlayerResponse;
    }

    const fromWindow = readPlayerResponseFromScriptText("ytInitialPlayerResponse");
    if (isPlayerResponseForVideo(fromWindow, videoId)) {
      return fromWindow;
    }

    for (const script of document.scripts) {
      const text = script.textContent || "";
      const parsed =
        parseAssignedJson(text, "ytInitialPlayerResponse") ||
        parseAssignedJson(text, "playerResponse");
      if (isPlayerResponseForVideo(parsed, videoId)) {
        return parsed;
      }
    }

    return null;
  }

  function isPlayerResponseForVideo(response, videoId) {
    if (!response) {
      return false;
    }
    const responseVideoId = response.videoDetails?.videoId || "";
    return !videoId || !responseVideoId || responseVideoId === videoId;
  }

  function requestPagePlayerResponse(videoId) {
    return new Promise((resolve) => {
      const requestId = `yld-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let settled = false;

      const finish = (response) => {
        if (settled) {
          return;
        }
        settled = true;
        window.removeEventListener("message", onMessage);
        resolve(response || null);
      };

      const onMessage = (event) => {
        if (event.source !== window || event.data?.source !== "YLD_PAGE" || event.data?.requestId !== requestId) {
          return;
        }

        if (event.data.type === "PLAYER_RESPONSE") {
          const response = event.data.response || null;
          if (response) {
            state.pagePlayerResponse = response;
            state.pagePlayerResponseVideoId = event.data.videoId || videoId || "";
          }
          storePageTranscriptData(event.data);
          finish(response);
        }
      };

      window.addEventListener("message", onMessage);
      injectPageProbe(requestId, "snapshot");
      setTimeout(() => finish(null), 1800);
    });
  }

  function installPageProbe() {
    injectPageProbe(`yld-install-${Date.now()}`, "install");
  }

  function injectPageProbe(requestId, mode, options = {}) {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-probe.js");
    script.dataset.yldRequestId = requestId;
    script.dataset.yldMode = mode || "snapshot";
    script.dataset.yldTargetLang = options.targetLang || els.lang?.value || "";
    (document.head || document.documentElement).appendChild(script);
    script.addEventListener("load", () => script.remove(), { once: true });
    script.addEventListener("error", () => script.remove(), { once: true });
  }

  function handlePageMessage(event) {
    if (event.source !== window || event.data?.source !== "YLD_PAGE") {
      return;
    }

    if (event.data.type === "PLAYER_RESPONSE" && event.data.response) {
      state.pagePlayerResponse = event.data.response;
      state.pagePlayerResponseVideoId = event.data.videoId || getVideoId();
    }
    if (event.data.type === "PLAYER_RESPONSE" || event.data.type === "TRANSCRIPT_OBSERVED" || event.data.type === "TRANSCRIPT_RESPONSE") {
      storePageTranscriptData(event.data);
    }
  }

  function storePageTranscriptData(data) {
    if (!data) {
      return;
    }

    const incomingVideoId = data.videoId || getVideoId();
    if (incomingVideoId && incomingVideoId !== getVideoId()) {
      return;
    }

    if (data.transcriptEndpoint || data.youtubeConfig || Array.isArray(data.segments) || Array.isArray(data.cachedTranscriptSegments)) {
      state.pageTranscriptVideoId = incomingVideoId || getVideoId();
    }
    if (data.transcriptEndpoint) {
      state.pageTranscriptEndpoint = data.transcriptEndpoint;
    }
    if (data.youtubeConfig) {
      state.pageYoutubeConfig = data.youtubeConfig;
    }

    const segments = Array.isArray(data.segments) && data.segments.length
      ? data.segments
      : Array.isArray(data.cachedTranscriptSegments) && data.cachedTranscriptSegments.length
        ? data.cachedTranscriptSegments
        : [];
    if (segments.length) {
      state.pageTranscriptSegments = normalizeTranscriptSegments(segments);
    }
  }

  function normalizeTranscriptSegments(segments) {
    return segments
      .map((segment) => ({
        start: Number(segment.start),
        end: Number(segment.end),
        text: cleanCaptionText(segment.text || ""),
      }))
      .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text)
      .sort((a, b) => a.start - b.start);
  }

  function readPlayerResponseFromScriptText(name) {
    const scripts = Array.from(document.scripts).map((script) => script.textContent || "");
    for (const text of scripts) {
      const parsed = parseAssignedJson(text, name);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  function parseAssignedJson(text, name) {
    const assignmentIndex = text.indexOf(name);
    if (assignmentIndex === -1) {
      return null;
    }

    const braceStart = text.indexOf("{", assignmentIndex);
    if (braceStart === -1) {
      return null;
    }

    const jsonText = extractBalancedObject(text, braceStart);
    if (!jsonText) {
      return null;
    }

    try {
      return JSON.parse(jsonText);
    } catch (_error) {
      return null;
    }
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  function extractBalancedObject(text, startIndex) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let quote = "";

    for (let index = startIndex; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          inString = false;
        }
        continue;
      }

      if (char === "\"" || char === "'") {
        inString = true;
        quote = char;
        continue;
      }

      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return text.slice(startIndex, index + 1);
        }
      }
    }

    return "";
  }

  function refreshPageState() {
    state.videoId = getVideoId();
    state.video = document.querySelector("video.html5-main-video") || document.querySelector("video");

    if (!state.running) {
      updateMeta(state.videoId || "unknown", "not loaded", "none");
    }
  }

  function demoSegmentsFor(videoId) {
    const samples = {
      kBXQZMmiA4s: [
        {
          start: 0,
          end: 3.2,
          text: "I'm Jasmine Lawrence and I'm a program manager on the Xbox One engineering team.",
        },
        {
          start: 3.2,
          end: 7.2,
          text: "One of our biggest features is called Xbox Live.",
        },
        {
          start: 7.2,
          end: 11.5,
          text: "It's an online service that connects gamers from all around the world.",
        },
        {
          start: 11.5,
          end: 16,
          text: "We rely on the internet to make that happen.",
        },
      ],
      Dxcc6ycZ73M: [
        {
          start: 0,
          end: 3,
          text: "What is the internet?",
        },
        {
          start: 3,
          end: 7,
          text: "The internet is a lot like plumbing. It's always moving.",
        },
        {
          start: 7,
          end: 11,
          text: "Most people don't have any idea where the internet came from.",
        },
      ],
    };

    return samples[videoId] || [];
  }

  function handleNavigation() {
    if (state.running) {
      stopDub({ resumeVideo: false });
    }
    state.pagePlayerResponse = null;
    state.pagePlayerResponseVideoId = "";
    state.pageTranscriptEndpoint = null;
    state.pageYoutubeConfig = null;
    state.pageTranscriptSegments = [];
    state.pageTranscriptVideoId = "";
    installPageProbe();
    setTimeout(refreshPageState, 750);
  }

  function getVideoId() {
    const url = new URL(window.location.href);
    return url.searchParams.get("v") || "";
  }

  function getVideoTime() {
    return state.video && Number.isFinite(state.video.currentTime) ? state.video.currentTime : 0;
  }

  function normalizeBackendUrl(value) {
    const raw = String(value || DEFAULT_BACKEND_URL).trim().replace(/\/+$/, "");
    return raw || DEFAULT_BACKEND_URL;
  }

  function dubbingSettingsFromControls() {
    return {
      voice: els.voice.value,
      tone: "neutral",
      targetLang: els.lang.value,
      ttsModel: els.model.value,
      ttsProvider: els.ttsProvider.value,
      pitchShift: Number(els.pitch.value),
      pitchVariance: Number(els.variance.value),
      speed: Number(els.speed.value),
    };
  }

  function getSavedBackendUrl() {
    try {
      const saved = window.localStorage.getItem(BACKEND_STORAGE_KEY) || "";
      if (!saved) {
        window.localStorage.setItem(BACKEND_STORAGE_KEY, DEFAULT_BACKEND_URL);
        return DEFAULT_BACKEND_URL;
      }
      return saved;
    } catch (_error) {
      return DEFAULT_BACKEND_URL;
    }
  }

  function getSavedPanelVisible() {
    try {
      return window.localStorage.getItem(PANEL_VISIBLE_STORAGE_KEY) !== "false";
    } catch (_error) {
      return true;
    }
  }

  function savePanelVisible(visible) {
    try {
      window.localStorage.setItem(PANEL_VISIBLE_STORAGE_KEY, visible ? "true" : "false");
    } catch (_error) {
      // Ignore storage failures on restricted pages.
    }
  }

  function saveBackendUrl(value) {
    try {
      window.localStorage.setItem(BACKEND_STORAGE_KEY, normalizeBackendUrl(value));
    } catch (_error) {
      // Ignore storage failures on restricted pages.
    }
  }

  function parseDataUrlContentType(dataUrl) {
    const match = String(dataUrl || "").match(/^data:([^;,]+)[;,]/);
    return match ? match[1] : "application/octet-stream";
  }

  function applyOriginalVolume(options = {}) {
    if (!state.video || (!state.running && !options.force)) {
      return;
    }

    const volumePercent = Math.max(0, Math.min(100, Number(els.volume.value) || 0));
    const muted = volumePercent === 0;

    state.video.volume = volumePercent / 100;
    state.video.muted = muted;

    const player = document.querySelector("#movie_player");
    try {
      if (typeof player?.setVolume === "function") {
        player.setVolume(volumePercent);
      }
      if (muted && typeof player?.mute === "function") {
        player.mute();
      } else if (!muted && typeof player?.unMute === "function") {
        player.unMute();
      }
    } catch (_error) {}
  }

  function setStatus(status) {
    state.status = status;
    els.status.textContent = status;
    renderAlert();
  }

  function updateMeta(video, captions, audio) {
    els.meta.innerHTML = `
      <div><strong>Video:</strong> ${escapeHtml(video || "unknown")}</div>
      <div><strong>Captions:</strong> ${escapeHtml(captions || "not loaded")}</div>
      <div><strong>Audio:</strong> ${escapeHtml(audio || "none")}</div>
      ${
        state.lastError
          ? `<div class="yld-error"><strong>Error:</strong> ${escapeHtml(state.lastError)}</div>`
          : ""
      }
    `;
    renderAlert();
  }

  function renderAlert() {
    if (!els.alert) {
      return;
    }

    if (!state.lastError) {
      els.alert.hidden = true;
      els.alert.textContent = "";
      return;
    }

    els.alert.hidden = false;
    els.alert.textContent = `Error: ${state.lastError}`;
  }

  function cleanCaptionText(text) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = String(text || "").replace(/<[^>]+>/g, " ");
    return textarea.value.replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function looksLikeJson(text) {
    return /^\s*[\[{]/.test(text || "");
  }

  function roundTime(value) {
    return Math.round(Number(value) * 1000) / 1000;
  }

  function clampPlaybackRate(value) {
    const rate = Number.isFinite(value) && value > 0 ? value : 1;
    return Math.min(MAX_SYNC_PLAYBACK_RATE, Math.max(0.85, rate));
  }

  function formatTime(value) {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const minutes = Math.floor(total / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
