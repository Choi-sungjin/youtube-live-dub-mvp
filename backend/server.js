import { classifySpeaker, selectSpeakerVoice, speakerStatus, closeSpeaker, analyzeCapturedSpeakers } from './speaker-voices.js';
import { resolveDubbingMode, DUBBING_MODES } from './dubbing-modes.js';
import { translateOpenAI, synthesizeOpenAISpeech, OPENAI_TEXT_MODEL, OPENAI_VOICE_MODEL, OPENAI_VOICES } from './openai-audio.js';
import { synthesizeWindowsSpeech, wavDuration } from './windows-speech.js';
import { synthesizeSupertonicSpeech, warmSupertonic, supertonicStatus, closeSupertonic } from './supertonic-speech.js';
import { createDiskTextCache } from './disk-text-cache.js';
import { warmFastStt, fastSttStatus, transcribeFast, closeFastStt } from './fast-stt.js';
import { createLocalTranslator, LOCAL_TRANSLATION_REVISION, DEFAULT_LOCAL_MODEL } from './local-translation.js';
import { translationContext } from './caption-context.js';
import { applyVerifiedCaptionTerms } from './verified-caption-terms.js';
import { speechText, SPEECH_TEXT_REVISION, normalizeDubbingTranslation } from './speech-text.js';
import { createApiSettingsHandler, loadPanelApiKey, testOpenAiConnection } from './api-settings.js';
import { createCaptureHandler } from './capture-stt.js';
import { createMediaRouter } from './media-router.js';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const APP_VERSION = JSON.parse(await readFile(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;

// Explicit process environment wins; local overrides win over the template defaults.
await loadEnvFile(path.join(ROOT_DIR, '.env.local'));
await loadEnvFile(path.join(__dirname, '.env.local'));
await loadEnvFile(path.join(__dirname, '.env'));
const PANEL_API_FILE = path.join(__dirname, '.env.panel.local');
await loadPanelApiKey(PANEL_API_FILE);

const PORT = Number(process.env.PORT || 18789);
const HOST = process.env.HOST || '127.0.0.1';
const CACHE_DIR = path.join(__dirname, '.cache');
const AUDIO_DIR = path.join(CACHE_DIR, 'audio');
const STT_DIR = path.join(CACHE_DIR, 'stt');
const AUDIT_DIR = path.join(CACHE_DIR, 'audit');
const ZAI_CHAT_COMPLETIONS_URL = 'https://api.z.ai/api/paas/v4/chat/completions';
const SUPERTONE_TTS_URL = 'https://supertoneapi.com/v1/text-to-speech';
const MAX_TTS_CHARS = 300;
const PREPROCESS_JOBS = new Map();
const TRANSLATION_CACHE = new Map();
const TRANSLATION_DISK_CACHE = createDiskTextCache(path.join(CACHE_DIR, 'translations'));
const MAX_TRANSLATION_CACHE_ITEMS = 5000;
const ZAI_RETRY_DELAYS_MS = [1500, 3500];
const ZAI_RATE_LIMIT_COOLDOWN_MS = 60_000;
let zaiRateLimitUntil = 0;
const LOCAL_TRANSLATOR = createLocalTranslator({ baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434', model: process.env.OLLAMA_MODEL || DEFAULT_LOCAL_MODEL });
let localTranslationWarmTimer;

const SUPERTONE_VOICES = {
  lowMale: {
    id: '763d5f200a9f5808056733',
    label: 'Low male'
  },
  highMale: {
    id: '8590d2b8884926372c6b4f',
    label: 'High male'
  },
  female: {
    id: '2c5f135cb33f49a2c8882d',
    label: 'Female'
  },
  lowFemale: {
    id: 'd39f0ea3c259e885e69a3c',
    label: 'Low female'
  }
};

await mkdir(AUDIO_DIR, { recursive: true });
await mkdir(STT_DIR, { recursive: true });
await mkdir(AUDIT_DIR, { recursive: true });
const apiSettingsHandler = createApiSettingsHandler({ filename: PANEL_API_FILE, testConnection: () => testOpenAiConnection({
  translate: translateOpenAI, synthesize: synthesizeOpenAISpeech,
  audioDir: AUDIO_DIR, audioBaseUrl: `http://${HOST}:${PORT}/audio`,
}) });
const captureHandler = createCaptureHandler({ cacheDir: CACHE_DIR, transcribe: transcribeFast, analyzeSpeakers: analyzeCapturedSpeakers });
const mediaRoute = createMediaRouter({ root: ROOT_DIR, transcribe: transcribeFast, prepare: prepareDub });

const server = createServer(async (req, res) => {
  try {
    setCors(res);

    const mediaUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    if (await mediaRoute(req, res, mediaUrl)) return;

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/diagnostics')) {
      const html = await readFile(path.join(__dirname, 'diagnostics.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      json(res, 200, {
        ok: true,
        version: APP_VERSION,
        // Installer ownership marker, not an authentication credential.
        installationId: process.env.YLD_INSTALLATION_ID || null,
        platform: process.platform,
        ttsProviders: process.platform === 'win32' ? ['supertonic3', 'windows-sapi', 'supertone', 'openai-realtime'] : ['supertonic3', 'supertone', 'openai-realtime'],
        dubbingModes: DUBBING_MODES,
        supertonic: supertonicStatus(),
        speaker: speakerStatus(),
        stt: fastSttStatus(),
        localTranslation: LOCAL_TRANSLATOR.status(),
        provider: providerInfo(),
        voices: Object.values(SUPERTONE_VOICES),
        port: PORT
      });
      return;
    }

    if (url.pathname === '/api/settings/openai') {
      res.setHeader('Cache-Control', 'no-store');
      json(res, 200, await apiSettingsHandler(req));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/dub/prepare') {
      const body = await readJson(req);
      if (body.stream === true) {
        res.writeHead(200, {'Content-Type':'application/x-ndjson', 'Cache-Control':'no-store'});
        try {
          const result = await prepareDub(body, undefined, item => {
            if (!res.destroyed) res.write(JSON.stringify({type:'segment',item})+'\n');
          });
          if (!res.destroyed) res.end(JSON.stringify({type:'done',result})+'\n');
        } catch (error) {
          if (!res.destroyed) res.end(JSON.stringify({type:'error',error:error.message})+'\n');
        }
        return;
      }
      const result = await prepareDub(body);
      if (process.env.YLD_AUDIT === '1') await appendFile(path.join(AUDIT_DIR, `${hashValue(result.videoId)}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...result }) + '\n');
      json(res, 200, result);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/server/shutdown') {
      json(res, 200, { ok: true, shuttingDown: true });
      setTimeout(() => {
        server.close(() => process.exit(0));
      }, 120);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/captions') {
      const videoId = String(url.searchParams.get('videoId') || '').trim();
      const result = url.searchParams.get('cacheOnly') === '1'
        ? await readCachedSttCaptions(videoId)
        : await fetchCaptionsWithLocalFallback(videoId);
      json(res, 200, result);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/captions/capture') {
      json(res, 200, await captureHandler(req));
      return;
    }

    if (url.pathname === '/api/captions/preprocess') {
      if (req.method === 'GET') {
        const videoId = String(url.searchParams.get('videoId') || '').trim();
        json(res, 200, await readPreprocessStatus(videoId));
        return;
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        json(res, 202, await startCaptionPreprocess(body));
        return;
      }

      json(res, 405, { error: 'Method not allowed.' });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
      const fileName = path.basename(decodeURIComponent(url.pathname.slice('/audio/'.length)));
      if (!fileName.endsWith('.wav')) {
        json(res, 400, { error: 'Only .wav audio is currently served.' });
        return;
      }
      const filePath = path.join(AUDIO_DIR, fileName);
      await stat(filePath);
      const data = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
      return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (error) {
    const status = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
    if (status >= 500) console.warn(`${req.method} ${String(req.url || '').split('?')[0]} failed (${status}): ${error.message}`);
    json(res, status, {
      error: error.message || 'Unexpected server error'
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`YouTube Live Dub backend listening at http://${HOST}:${PORT}`);
  if (activeTtsProvider() === 'supertonic3') warmSupertonic().catch(error => console.warn(error.message));
  if (process.env.YLD_FAST_STT !== '0') warmFastStt().catch(error => console.warn(`Fast STT: ${error.message}`));
  if (activeTranslationProvider() === 'ollama') {
    LOCAL_TRANSLATOR.warm().catch(error => console.warn(error.message));
    localTranslationWarmTimer = setInterval(() => LOCAL_TRANSLATOR.warm({ refresh: true }).catch(error => console.warn(error.message)), 10 * 60 * 1000);
    localTranslationWarmTimer.unref();
  }
});

function closeWorkers() { clearInterval(localTranslationWarmTimer); closeFastStt(); closeSupertonic(); closeSpeaker(); }
server.on('close', closeWorkers);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  closeWorkers();
  server.close(() => process.exit(0));
});

function providerInfo() {
  const translationProvider = normalizeProvider(
    process.env.TRANSLATION_PROVIDER || 'ollama',
    ['ollama', 'zai', 'openai', 'mock'],
    'ollama'
  );
  const ttsProvider = normalizeProvider(
    process.env.TTS_PROVIDER || 'supertonic3',
    ['supertonic3', 'supertone', 'windows-sapi', 'openai-realtime', 'mock-wav'],
    'supertonic3'
  );

  return {
    script: translationProvider,
    translation: translationProvider,
    translationModel: translationProvider === 'ollama' ? LOCAL_TRANSLATOR.status().model : translationProvider === 'zai' ? process.env.ZAI_MODEL || 'glm-4.7' : process.env.OPENAI_MODEL || OPENAI_TEXT_MODEL,
    translationLocation: translationProvider === 'ollama' ? 'local' : translationProvider === 'mock' ? 'test' : 'external',
    tts: ttsProvider,
    openaiModel: process.env.OPENAI_MODEL || OPENAI_TEXT_MODEL,
    zaiModel: process.env.ZAI_MODEL || 'glm-4.7',
    zaiConfigured: Boolean(process.env.ZAI_API_KEY),
    supertoneModel: process.env.SUPERTONE_MODEL || 'sona_speech_2_flash',
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    openaiVoiceModel: process.env.OPENAI_VOICE_MODEL || OPENAI_VOICE_MODEL,
    supertoneConfigured: Boolean(process.env.SUPERTONE_API_KEY),
    defaultVoiceId: process.env.SUPERTONE_DEFAULT_VOICE_ID || SUPERTONE_VOICES.lowMale.id,
    voiceSettings: {
      pitch_shift: Number(process.env.SUPERTONE_PITCH_SHIFT ?? 0),
      pitch_variance: Number(process.env.SUPERTONE_PITCH_VARIANCE ?? 1.5),
      speed: Number(process.env.SUPERTONE_SPEED ?? 1.29)
    }
  };
}

async function prepareDub(body, mediaTranscript, onPrepared) {
  const requestStarted = performance.now();
  const timings = {};
  const videoId = String(body?.videoId || '').trim();
  const settings = normalizeSettings(body?.settings);
  settings.speechSteps = body?.source === "youtube-buffered" ? 5 : 8;
  const inputSegments = Array.isArray(body?.segments) ? body.segments : [];
  const segments = applyVerifiedCaptionTerms(videoId, inputSegments.map((segment, index) => normalizeSegment(segment, index)).filter(Boolean));

  if (!videoId) {
    throw httpError(400, 'videoId is required.');
  }
  if (segments.length === 0) {
    throw httpError(400, 'segments must contain at least one timed text segment.');
  }

  if ((settings.translationProvider === 'openai' || settings.ttsProvider === 'openai-realtime') && !process.env.OPENAI_API_KEY) {
    throw httpError(503, 'OpenAI API 키가 없습니다. 패널 설정 → API 키 설정에서 등록해 주세요.');
  }

  const transcript = Array.isArray(mediaTranscript) ? {segments:mediaTranscript} : ['ollama', 'openai'].includes(activeTranslationProvider(settings)) ? await readCachedSttCaptions(videoId).catch(() => ({segments:[]})) : {segments:[]};
  const limitedSegments = segments.slice(0, 80).map(segment => ({...segment,
    contextBefore: transcript.segments.filter(s=>s.end<=segment.start).slice(-2).map(s=>s.text).join(' ').slice(-240),
    contextAfter: transcript.segments.filter(s=>s.start>=segment.end).slice(0,2).map(s=>s.text).join(' ').slice(0,240),
    contextTopic: transcript.segments.filter(s=>s.end>=segment.start-45 && s.start<=segment.end+20).map(s=>s.text).join(' ').slice(-2200),
  }));
  const speakerResults = settings.autoSpeaker && ['openai-realtime', 'supertonic3'].includes(settings.ttsProvider) && !mediaTranscript && body?.source !== 'self-test'
    ? mapLimit(limitedSegments, 3, segment => classifySpeaker({videoId, start: segment.start, end: segment.end, speakerKey:segment.speakerKey,
      allowDownload: !['youtube-buffered', 'youtube-captured'].includes(body?.source)}))
    : Promise.resolve(limitedSegments.map(() => null));
  const translationStarted = performance.now();
  const translated = await translateSegments(limitedSegments, settings, timings);
  timings.translationMs = Math.round(performance.now() - translationStarted);
  const speakers = await speakerResults;
  const speechStarted = performance.now();
  const ttsConcurrency = clamp(Number(process.env.LOCAL_TTS_CONCURRENCY || 3), 1, 6);

  const preparedItems = await mapLimit(limitedSegments, ttsConcurrency, async (segment) => {
    const speaker = speakers[limitedSegments.indexOf(segment)];
    const speechSettings = {...settings, voice: selectSpeakerVoice(settings, speaker)};
    const translation = translated.get(segment.index);
    if (!translation) throw httpError(502, `Translation missing for segment ${segment.index}.`);
    // Local translation has already shortened and checked required facts. Do not
    // silently remove the end of a complete sentence after that validation.
    const spokenText = normalizeDubbingTranslation(cleanText(translation), segment.text, settings.targetLang);
    const synthesisText = settings.ttsProvider === 'supertonic3' ? speechText(spokenText, settings.targetLang) : spokenText;
    const cacheKey = {
      schemaVersion: 2,
      videoId,
      segment: { index: segment.index, start: segment.start, end: segment.end, text: segment.text },
      settings: cacheableSettings(speechSettings),
      translatedText: spokenText,
      speechText: synthesisText,
      speechTextRevision: SPEECH_TEXT_REVISION,
      providers: {
        translation: activeTranslationProvider(settings),
        tts: activeTtsProvider(settings)
      }
    };
    const id = hashValue(cacheKey);
    const audioPath = path.join(AUDIO_DIR, `${id}.wav`);
    const exists = await fileExists(audioPath);
    const sourceDuration = Math.max(0.55, Math.min(12, segment.end - segment.start));
    let audioDuration = sourceDuration;
    let actualTtsModel = settings.ttsModel;
    let synthesisMs = 0;
    let firstAudioMs = null;
    let audioTranscript = null;
    if (exists) audioDuration = wavDuration(await readFile(audioPath));

    if (!exists) {
      const result = await synthesizeSpeech({
        text: synthesisText,
        duration: sourceDuration,
        settings: speechSettings,
        outputPath: audioPath
      });
      audioDuration = result.duration || audioDuration;
      actualTtsModel = result.ttsModel || actualTtsModel;
      synthesisMs = result.synthesisMs || 0;
      firstAudioMs = result.firstAudioMs ?? null;
      audioTranscript = result.transcript ?? null;
    }

    const completed = {
      hit: exists,
      item: {
        id,
        index: segment.index,
        start: segment.start,
        end: segment.end,
        startMs: Math.round(segment.start * 1000),
        endMs: Math.round(segment.end * 1000),
        sourceText: segment.text,
        translatedText: spokenText,
        speechText: synthesisText,
        audioUrl: `http://${HOST}:${PORT}/audio/${id}.wav`,
        duration: roundTime(audioDuration),
        durationMs: Math.round(audioDuration * 1000),
        synthesisMs,
        firstAudioMs,
        audioTranscript,
        speechSpeed: settings.speed,
        voiceId: settings.ttsProvider === 'windows-sapi' ? `windows:${settings.targetLang}` : speechSettings.voice,
        speaker,
        ttsModel: actualTtsModel
      }
    };
    onPrepared?.(completed.item);
    return completed;
  });

  const hits = preparedItems.filter((result) => result.hit).length;
  const prepared = preparedItems.map((result) => result.item);
  timings.speechMs = Math.round(performance.now() - speechStarted);
  timings.totalMs = Math.round(performance.now() - requestStarted);

  return {
    videoId,
    timings,
    provider: providerInfo(),
    requestProvider: {
      translation: activeTranslationProvider(settings),
      tts: settings.ttsProvider,
      ttsModel: settings.ttsProvider === 'windows-sapi' ? 'windows-sapi' : settings.ttsModel
    },
    warnings: buildWarnings(),
    cache: {
      hit: hits === prepared.length,
      hits,
      misses: prepared.length - hits
    },
    segments: prepared
  };
}

async function fetchYouTubeCaptions(videoId) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
    throw httpError(400, 'A valid YouTube videoId is required.');
  }

  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`;
  const watchResponse = await fetch(watchUrl, {
    signal: AbortSignal.timeout(8000),
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36'
    }
  });
  const html = await watchResponse.text();

  if (!watchResponse.ok) {
    throw httpError(watchResponse.status, `YouTube watch page fetch failed: HTTP ${watchResponse.status}`);
  }

  const playerResponse =
    parseAssignedJson(html, 'ytInitialPlayerResponse') ||
    parsePlayerResponseFromHtml(html);
  const tracks = getCaptionTracks(playerResponse);

  if (!tracks.length) {
    throw httpError(404, `No caption tracks found by backend for YouTube video ${videoId}.`);
  }

  const track = pickBackendCaptionTrack(tracks);
  if (!track?.baseUrl) {
    throw httpError(404, `Caption track exists, but no timedtext URL was available for ${videoId}.`);
  }

  const captionUrl = new URL(track.baseUrl);
  captionUrl.searchParams.set('fmt', 'json3');
  const captionResponse = await fetch(captionUrl.toString(), {
    signal: AbortSignal.timeout(8000),
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36'
    }
  });
  const captionText = await captionResponse.text();

  if (!captionResponse.ok) {
    throw httpError(captionResponse.status, `YouTube timedtext fetch failed: HTTP ${captionResponse.status}`);
  }

  const segments = looksLikeJson(captionText)
    ? parseJson3CaptionSegments(safeJsonParse(captionText))
    : parseXmlCaptionSegments(captionText);

  if (!segments.length) {
    throw httpError(404, `Caption track was fetched, but no timed text segments were parsed for ${videoId}.`);
  }

  return {
    videoId,
    source: 'backend-youtube-watch',
    track: {
      languageCode: track.languageCode || '',
      kind: track.kind || '',
      name: track.name?.simpleText || track.name?.runs?.map((run) => run.text).join('') || ''
    },
    segments
  };
}

async function fetchCaptionsWithLocalFallback(videoId) {
  try {
    return await fetchYouTubeCaptions(videoId);
  } catch (error) {
    const cached = await readCachedSttCaptions(videoId);
    if (cached.segments.length) {
      return cached;
    }
    throw error;
  }
}

async function readCachedSttCaptions(videoId) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
    throw httpError(400, 'A valid YouTube videoId is required.');
  }

  const filePath = path.join(STT_DIR, `${videoId}.segments.json`);
  let payload = null;
  try {
    payload = safeJsonParse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { videoId, source: 'local-stt-cache', segments: [] };
    }
    throw error;
  }

  const rawSegments = Array.isArray(payload) ? payload : payload?.segments;
  if (process.env.YLD_STT_MODEL && payload?.sttModel !== process.env.YLD_STT_MODEL) {
    return { videoId, source: 'local-stt-cache-model-mismatch', segments: [], windows: [] };
  }
  const segments = Array.isArray(rawSegments)
    ? applyVerifiedCaptionTerms(videoId, rawSegments.map((segment, index) => normalizeSegment(segment, index)).filter(Boolean))
    : [];

  return {
    videoId,
    source: 'local-stt-cache',
    generatedAt: payload?.generatedAt || '',
    language: payload?.language || '',
    windows: Array.isArray(payload?.windows) ? payload.windows : [],
    segments
  };
}

async function startCaptionPreprocess(body) {
  const videoId = String(body?.videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
    throw httpError(400, 'A valid YouTube videoId is required.');
  }

  const force = Boolean(body?.force);
  const cached = force ? { segments: [] } : await readCachedSttCaptions(videoId);
  if (cached.segments.length || cached.windows?.length) {
    return {
      ok: true,
      videoId,
      status: 'done',
      source: cached.source,
      windows: cached.windows || [],
      segments: cached.segments
    };
  }

  const existing = PREPROCESS_JOBS.get(videoId);
  if (existing && existing.status === 'running') {
    return serializePreprocessJob(existing);
  }

  const videoUrl = normalizeYouTubeUrl(body?.videoUrl || '', videoId);
  const hardMaxDuration = clamp(Number(process.env.YLD_STT_HARD_MAX_DURATION || 7200), 60, 21600);
  const startTime = clamp(Number(body?.startTime || 0), 0, hardMaxDuration);
  const requestedMaxDuration = Number(body?.maxDuration ?? process.env.YLD_STT_MAX_DURATION ?? 90);
  const requestedWindowDuration = Number(body?.windowDuration || 0);
  const targetDuration = startTime > 0
    ? clamp(
      startTime + Math.max(15, requestedWindowDuration || Math.max(15, requestedMaxDuration - startTime)),
      startTime + 15,
      hardMaxDuration
    )
    : clamp(requestedMaxDuration, 15, hardMaxDuration);
  const windowDuration = startTime > 0 ? clamp(targetDuration - startTime, 15, 900) : 0;
  const prewarmSegments = clamp(Number(body?.prewarmSegments ?? process.env.YLD_PREWARM_SEGMENTS ?? 8), 0, 40);
  const job = {
    ok: true,
    videoId,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    sourceUrl: videoUrl,
    startTime,
    targetDuration,
    windowDuration,
    error: '',
    exitCode: null,
    output: ''
  };
  PREPROCESS_JOBS.set(videoId, job);

  const scriptPath = path.join(ROOT_DIR, 'scripts', 'preprocess-dub.js');
  const args = [
    scriptPath,
    videoUrl,
    '--language',
    String(body?.language || 'auto'),
    '--stt-model',
    String(process.env.YLD_STT_MODEL || body?.sttModel || 'tiny'),
    '--prewarm-segments',
    String(prewarmSegments),
    '--backend',
    `http://${HOST}:${PORT}`
  ];
  if (startTime > 0) {
    args.push(
      '--start-time',
      String(startTime),
      '--window-duration',
      String(windowDuration),
      '--max-duration',
      String(targetDuration)
    );
  } else {
    args.push('--max-duration', String(targetDuration));
  }
  if (force) {
    args.push('--force');
  }

  const child = spawn(process.execPath, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      SUPERTONE_DEFAULT_VOICE_ID: String(body?.settings?.voice || process.env.SUPERTONE_DEFAULT_VOICE_ID || SUPERTONE_VOICES.lowMale.id),
      TTS_PROVIDER: activeTtsProvider(body?.settings),
      SUPERTONE_MODEL: String(body?.settings?.ttsModel || process.env.SUPERTONE_MODEL || 'sona_speech_2_flash'),
      SUPERTONE_PITCH_SHIFT: String(body?.settings?.pitchShift ?? process.env.SUPERTONE_PITCH_SHIFT ?? 0),
      SUPERTONE_PITCH_VARIANCE: String(body?.settings?.pitchVariance ?? process.env.SUPERTONE_PITCH_VARIANCE ?? 1.5),
      SUPERTONE_SPEED: String(body?.settings?.speed ?? process.env.SUPERTONE_SPEED ?? 1.29)
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });

  child.on('message', async message => {
    if (message?.type !== 'YLD_STT_REQUEST') return;
    try {
      const result = await transcribeFast(message);
      if (child.connected) child.send({ type: 'YLD_STT_RESULT', id: message.id, result });
    } catch (error) {
      if (child.connected) child.send({ type: 'YLD_STT_RESULT', id: message.id, error: error.message });
    }
  });
  child.stdout.on('data', (chunk) => appendPreprocessOutput(job, chunk));
  child.stderr.on('data', (chunk) => appendPreprocessOutput(job, chunk));
  child.on('error', (error) => {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.error = error.message || String(error);
  });
  child.on('exit', async (code) => {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    if (code === 0) {
      const cachedResult = await readCachedSttCaptions(videoId).catch(() => ({ segments: [] }));
      const inspected = cachedResult.segments.length || cachedResult.windows?.length;
      job.status = inspected ? 'done' : 'failed';
      job.error = inspected ? '' : 'Preprocess exited successfully, but no cached STT coverage was found.';
    } else {
      job.status = 'failed';
      job.error = `Preprocess exited with code ${code}.`;
    }
  });

  return serializePreprocessJob(job);
}

async function readPreprocessStatus(videoId) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
    throw httpError(400, 'A valid YouTube videoId is required.');
  }

  const existing = PREPROCESS_JOBS.get(videoId);
  if (existing && existing.status === 'running') {
    return serializePreprocessJob(existing);
  }

  const cached = await readCachedSttCaptions(videoId);
  if (cached.segments.length || cached.windows?.length) {
    return {
      ok: true,
      videoId,
      status: 'done',
      source: cached.source,
      generatedAt: cached.generatedAt,
      windows: cached.windows || [],
      language: cached.language,
      segments: cached.segments
    };
  }

  return serializePreprocessJob(existing || {
    ok: true,
    videoId,
    status: 'idle',
    startedAt: '',
    finishedAt: '',
    sourceUrl: '',
    error: '',
    output: ''
  });
}

function serializePreprocessJob(job) {
  return {
    ok: Boolean(job?.ok ?? true),
    videoId: job?.videoId || '',
    status: job?.status || 'idle',
    startedAt: job?.startedAt || '',
    finishedAt: job?.finishedAt || '',
    sourceUrl: job?.sourceUrl || '',
    startTime: job?.startTime || 0,
    targetDuration: job?.targetDuration || 0,
    windowDuration: job?.windowDuration || 0,
    error: job?.error || '',
    exitCode: job?.exitCode ?? null,
    outputTail: String(job?.output || '').slice(-2000),
    segments: []
  };
}

function appendPreprocessOutput(job, chunk) {
  job.output = `${job.output || ''}${chunk.toString('utf8')}`;
  if (job.output.length > 10000) {
    job.output = job.output.slice(-10000);
  }
}

function normalizeYouTubeUrl(input, videoId) {
  const value = String(input || '').trim();
  if (/^https:\/\/(www\.)?youtube\.com\/watch\?/.test(value) || /^https:\/\/youtu\.be\//.test(value)) {
    return value;
  }
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function normalizeSettings(settings = {}) {
  const mode = settings.mode == null ? null : resolveDubbingMode(settings.mode);
  const ttsProvider = normalizeProvider(mode?.ttsProvider || settings.ttsProvider || process.env.TTS_PROVIDER || 'supertonic3',
    ['supertonic3', 'supertone', 'windows-sapi', 'openai-realtime', 'mock-wav'], 'supertonic3');
  const voice = ttsProvider === 'supertonic3'
    ? (/^[MF][1-5]$/.test(settings.voice) ? settings.voice : 'M1')
    : ttsProvider === 'openai-realtime' ? (OPENAI_VOICES.includes(settings.voice) ? settings.voice : 'marin')
    : String(settings.voice || process.env.SUPERTONE_DEFAULT_VOICE_ID || SUPERTONE_VOICES.lowMale.id);
  return {
    mode: settings.mode,
    autoSpeaker: ['openai-realtime', 'supertonic3'].includes(ttsProvider) && (settings.voice === 'auto' || settings.autoSpeaker === true),
    translationProvider: mode?.translationProvider || activeTranslationProvider(),
    voice,
    tone: String(settings.tone || process.env.SUPERTONE_STYLE || 'neutral'),
    pitchShift: clamp(Number(settings.pitchShift ?? process.env.SUPERTONE_PITCH_SHIFT ?? 0), -24, 24),
    pitchVariance: clamp(Number(settings.pitchVariance ?? process.env.SUPERTONE_PITCH_VARIANCE ?? 1.5), 0, 2),
    speed: ttsProvider === 'openai-realtime' ? 1.0 : ttsProvider === 'supertonic3' ? 1.15 : clamp(Number(settings.speed ?? process.env.SUPERTONE_SPEED ?? 1.29), 0.5, 2),
    targetLang: String(settings.targetLang || 'ko'),
    ttsModel: ttsProvider === 'openai-realtime' ? process.env.OPENAI_VOICE_MODEL || OPENAI_VOICE_MODEL : ttsProvider === 'supertonic3' ? 'supertonic-3' : ttsProvider === 'windows-sapi' ? 'windows-sapi' : String(settings.ttsModel || process.env.SUPERTONE_MODEL || 'sona_speech_2_flash'),
    ttsProvider
  };
}

function normalizeSegment(segment, fallbackIndex) {
  const rawStart = segment?.start ?? (Number(segment?.startMs) / 1000);
  const rawEnd = segment?.end ?? (Number(segment?.endMs) / 1000);
  const start = Number(rawStart);
  const inferredEnd = Number.isFinite(start) ? start + 3 : fallbackIndex + 3;
  const end = Number.isFinite(Number(rawEnd)) ? Number(rawEnd) : inferredEnd;
  const text = cleanText(segment?.text || '');
  const index = Number.isInteger(segment?.index) ? segment.index : fallbackIndex;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) {
    return null;
  }

  return {
    index,
    start: Math.max(0, roundTime(start)),
    end: Math.max(0.25, roundTime(end)),
    text,
    ...(typeof segment.speakerKey === 'string' && /^[a-f0-9-]{36}$/.test(segment.speakerKey) ? {speakerKey:segment.speakerKey} : {})
  };
}

async function translateSegments(segments, settings, metrics = {}) {
  const provider = activeTranslationProvider(settings);
  const translated = new Map();
  const missing = [];

  for (const segment of segments) {
    const cached = await getCachedTranslation(segment, settings, provider);
    if (cached) {
      translated.set(segment.index, cached);
    } else {
      missing.push(segment);
    }
  }

  metrics.translationCacheHits = segments.length - missing.length;
  if (!missing.length) {
    return translated;
  }

  let providerTranslations = new Map();
  try {
    if (provider === 'ollama') {
      providerTranslations = await LOCAL_TRANSLATOR.translate(missing, settings, metrics);
    } else if (provider === 'zai' && process.env.ZAI_API_KEY) {
      if (Date.now() < zaiRateLimitUntil) {
        throw httpError(429, 'Z.ai rate limit cooldown is active.');
      }
      providerTranslations = await translateSegmentsWithZai(missing, settings);
    } else if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      providerTranslations = await translateOpenAI(missing, settings, metrics);
    } else if (provider === 'mock') {
      providerTranslations = new Map(missing.map(segment => [segment.index, translateMock(segment.text, settings)]));
    } else {
      throw httpError(503, `${provider} translation API key is not configured.`);
    }
  } catch (error) {
    if (isRateLimitError(error)) {
      zaiRateLimitUntil = Date.now() + ZAI_RATE_LIMIT_COOLDOWN_MS;
    }
    throw error;
  }

  for (const segment of missing) {
    const providerText = providerTranslations.get(segment.index);
    if (providerText) {
      translated.set(segment.index, providerText);
      await setCachedTranslation(segment, settings, provider, providerText);
    } else {
      throw httpError(502, `Translation provider omitted segment ${segment.index}; no substitute text was generated.`);
    }
  }

  return translated;
}

async function translateSegmentsWithZai(segments, settings) {
  const translated = new Map();
  const batches = batchArray(segments, 20);

  for (const batch of batches) {
    const promptPayload = {
      target_language: settings.targetLang,
      max_tts_chars: 160,
      segments: batch.map((segment) => ({
        index: segment.index,
        start: segment.start,
        end: segment.end,
        duration: roundTime(segment.end - segment.start),
        max_korean_chars: maxKoreanCharsForDuration(segment.end - segment.start),
        text: segment.text
      }))
    };
    const bodyText = await requestZaiTranslation(promptPayload);

    const body = safeJsonParse(bodyText);
    const outputText = body?.choices?.[0]?.message?.content || '';
    const parsed = parseJsonObject(outputText);
    const items = Array.isArray(parsed?.translations) ? parsed.translations : [];

    for (const item of items) {
      const index = Number(item?.index);
      const text = cleanText(item?.text || '');
      if (Number.isInteger(index) && text) {
        translated.set(index, text);
      }
    }

    for (const segment of batch) {
      if (!translated.has(segment.index)) {
        throw httpError(502, `Translation provider omitted segment ${segment.index}; no substitute text was generated.`);
      }
    }
  }

  return translated;
}

async function requestZaiTranslation(promptPayload) {
  const requestBody = JSON.stringify({
    model: process.env.ZAI_MODEL || 'glm-4.7',
    messages: [
      {
        role: 'system',
        content: [
          'Translate caption chunks into the requested target_language for dubbing. Never replace their meaning with generic filler.',
          'Preserve the meaning while keeping speech concise enough for the segment duration.',
          'Each Korean line must be short enough to finish inside its start/end duration.',
          'Use the max_korean_chars value for every segment. Shorter is better.',
          'Omit filler and repeated phrasing only when the original meaning remains clear.',
          'Do not add explanations. Do not exceed 160 Korean characters.',
          'Preserve every input index. Return JSON only: {"translations":[{"index":0,"text":"..."}]}.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify(promptPayload)
      }
    ],
    thinking: { type: 'disabled' },
    temperature: 0.2,
    max_tokens: 2048,
    stream: false
  });

  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 0; attempt <= ZAI_RETRY_DELAYS_MS.length; attempt += 1) {
    const response = await fetch(ZAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.ZAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: requestBody,
      signal: AbortSignal.timeout(45000)
    });
    const bodyText = await response.text();
    if (response.ok) {
      return bodyText;
    }

    lastStatus = response.status;
    lastBody = bodyText;
    if (!isZaiRateLimitResponse(response, bodyText) || attempt >= ZAI_RETRY_DELAYS_MS.length) {
      break;
    }
    await delay(ZAI_RETRY_DELAYS_MS[attempt]);
  }

  throw httpError(lastStatus || 500, `Z.ai Chat Completions API failed: ${trimForError(lastBody)}`);
}

async function synthesizeSpeech({ text, duration, settings, outputPath }) {
  if (settings.ttsProvider === 'openai-realtime') return synthesizeOpenAISpeech({ text, settings, outputPath });
  if (settings.ttsProvider === 'supertonic3') return synthesizeSupertonicSpeech({ text, settings, outputPath });
  if (settings.ttsProvider === 'windows-sapi') return synthesizeWindowsSpeech({ text, settings, outputPath });
  if (settings.ttsProvider === 'supertone' && !process.env.SUPERTONE_API_KEY) {
    throw httpError(503, 'Supertone API key is not configured. Select an available speech provider.');
  }
  if (settings.ttsProvider === 'supertone' && process.env.SUPERTONE_API_KEY) {
    return synthesizeWithSupertone({ text, duration, settings, outputPath });
  }

  const wav = createMockSpeechWav({
    text,
    duration,
    voice: settings.voice,
    tone: settings.tone,
    speed: settings.speed
  });
  await writeFile(outputPath, wav);
  return { duration };
}

async function synthesizeWithSupertone({ text, duration, settings, outputPath }) {
  let usedSettings = settings;
  let requestText = text;
  let response = await requestSupertoneSpeech({ text: requestText, settings: usedSettings });
  let arrayBuffer = await response.arrayBuffer();
  let data = Buffer.from(arrayBuffer);

  if (!response.ok) {
    throw httpError(response.status, `Supertone TTS failed (HTTP ${response.status}): ${trimForError(data.toString('utf8')) || response.statusText || 'empty response'}. Check the provider service/voice, or select Windows speech on the local backend.`);
  }

  await writeFile(outputPath, data);
  const audioLength = Number(response.headers.get('x-audio-length'));
  return {
    duration: Number.isFinite(audioLength) && audioLength > 0 ? audioLength : duration,
    ttsModel: usedSettings.ttsModel
  };
}

async function requestSupertoneSpeech({ text, settings }) {
  return fetch(`${SUPERTONE_TTS_URL}/${encodeURIComponent(settings.voice)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sup-api-key': process.env.SUPERTONE_API_KEY
    },
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      text,
      language: settings.targetLang,
      style: settings.tone,
      model: settings.ttsModel,
      output_format: 'wav',
      voice_settings: {
        pitch_shift: settings.pitchShift,
        pitch_variance: settings.pitchVariance,
        speed: settings.speed,
        duration: 0
      },
      include_phonemes: false
    })
  });
}

function translateMock(text, settings) {
  const normalized = cleanText(text);
  const tonePrefix = settings.tone === 'calm' ? '차분하게: ' : settings.tone === 'bright' ? '밝게: ' : '';

  if (settings.targetLang === 'ko') {
    return `${tonePrefix}${koreanFallbackScript(normalized)}`;
  }

  return `${tonePrefix}${normalized}`;
}

async function getCachedTranslation(segment, settings, provider) {
  const key = translationCacheKey(segment, settings, provider);
  const cached = TRANSLATION_CACHE.get(key) || await TRANSLATION_DISK_CACHE.get(key);
  if (cached) rememberTranslation(key, cached);
  return cached;
}

async function setCachedTranslation(segment, settings, provider, text) {
  const key = translationCacheKey(segment, settings, provider);
  rememberTranslation(key, text);
  await TRANSLATION_DISK_CACHE.set(key, text);
}

function rememberTranslation(key, text) {
  if (!text) {
    return;
  }
  if (TRANSLATION_CACHE.size >= MAX_TRANSLATION_CACHE_ITEMS) {
    const oldestKey = TRANSLATION_CACHE.keys().next().value;
    if (oldestKey) {
      TRANSLATION_CACHE.delete(oldestKey);
    }
  }
  TRANSLATION_CACHE.set(key, text);
}

function translationCacheKey(segment, settings, provider) {
  return hashValue({
    schemaVersion: 2,
    provider,
    model: provider === 'ollama' ? LOCAL_TRANSLATOR.status().model : provider === 'zai' ? process.env.ZAI_MODEL || 'glm-4.7' : process.env.OPENAI_MODEL || OPENAI_TEXT_MODEL,
    localRevision: provider === 'ollama' ? LOCAL_TRANSLATION_REVISION : undefined,
    context: provider === 'ollama' ? translationContext(segment) : provider === 'openai' ? segment.contextBefore || '' : undefined,
    targetLang: settings.targetLang,
    start: roundTime(segment.start),
    end: roundTime(segment.end),
    text: segment.text
  });
}

function isRateLimitError(error) {
  const message = String(error?.message || error || '');
  return error?.statusCode === 429 ||
    message.includes('Rate limit') ||
    message.includes('"1302"') ||
    message.includes('rate limit cooldown');
}

function isZaiRateLimitResponse(response, bodyText) {
  return response.status === 429 ||
    String(bodyText || '').includes('"1302"') ||
    String(bodyText || '').includes('Rate limit');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMockSpeechWav({ text, duration, voice, tone, speed }) {
  const sampleRate = 24000;
  const seconds = duration / speed;
  const sampleCount = Math.max(1, Math.floor(sampleRate * seconds));
  const data = Buffer.alloc(sampleCount * 2);
  const seed = stableNumber(`${text}:${voice}:${tone}`);
  const baseFreq = 180 + (seed % 110);
  const secondFreq = baseFreq * 1.5;

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.min(1, i / 1200, (sampleCount - i) / 1200);
    const syllableGate = 0.35 + 0.65 * Number(Math.sin(2 * Math.PI * 5.5 * t) > -0.25);
    const wave = (
      Math.sin(2 * Math.PI * baseFreq * t) * 0.24 +
      Math.sin(2 * Math.PI * secondFreq * t) * 0.08
    ) * envelope * syllableGate;
    data.writeInt16LE(Math.round(clamp(wave, -1, 1) * 32767), i * 2);
  }

  return addWavHeader(data, sampleRate, 1, 16);
}

function addWavHeader(pcmData, sampleRate, channels, bitDepth) {
  const blockAlign = channels * bitDepth / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, 'Request body must be valid JSON.');
  }
}

async function loadEnvFile(filePath) {
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = unquoteEnvValue(trimmed.slice(separator + 1).trim());
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function activeTranslationProvider(settings) {
  return normalizeProvider(settings?.translationProvider || process.env.TRANSLATION_PROVIDER || 'ollama', ['ollama', 'zai', 'openai', 'mock'], 'ollama');
}

function activeTtsProvider(settings) {
  return normalizeProvider(settings?.ttsProvider || process.env.TTS_PROVIDER || 'supertonic3', ['supertonic3', 'supertone', 'windows-sapi', 'openai-realtime', 'mock-wav'], 'supertonic3');
}

function buildWarnings() {
  const warnings = [];
  if (activeTranslationProvider() === 'zai' && !process.env.ZAI_API_KEY) {
    warnings.push('ZAI_API_KEY is not configured; translation requests will fail.');
  }
  if (activeTranslationProvider() === 'openai' && !process.env.OPENAI_API_KEY) {
    warnings.push('OPENAI_API_KEY is not configured; translation requests will fail.');
  }
  if (activeTtsProvider() === 'supertone' && !process.env.SUPERTONE_API_KEY) {
    warnings.push('SUPERTONE_API_KEY is not configured; Supertone requests will fail.');
  }
  return warnings;
}

function normalizeProvider(value, allowed, fallback) {
  const normalized = String(value || fallback).toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function cacheableSettings(settings) {
  return {
    voice: settings.voice,
    tone: settings.tone,
    pitchShift: settings.pitchShift,
    pitchVariance: settings.pitchVariance,
    speed: settings.speed,
    targetLang: settings.targetLang,
    ttsModel: settings.ttsModel,
    ttsProvider: settings.ttsProvider,
    speechSteps: settings.ttsProvider === "supertonic3" ? settings.speechSteps : undefined,
    translationProvider: settings.translationProvider
  };
}

function hashValue(value) {
  return createHash('sha1')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 20);
}

function stableNumber(value) {
  return createHash('sha1').update(value).digest().readUInt32LE(0);
}

function cleanText(text) {
  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampTextForTts(text) {
  const cleaned = cleanText(text);
  if (cleaned.length <= MAX_TTS_CHARS) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_TTS_CHARS - 3).trim()}...`;
}

function maxKoreanCharsForDuration(duration) {
  const safeDuration = Math.max(0.6, Number(duration) || 0.6);
  return Math.max(10, Math.min(160, Math.floor(safeDuration * 8)));
}

function koreanFallbackScript(text) {
  const lower = cleanText(text).toLowerCase();
  const topics = [];

  if (/\binternet\b|인터넷/.test(lower)) {
    topics.push('인터넷');
  }
  if (/\bbrowser\b|브라우저/.test(lower)) {
    topics.push('브라우저');
  }
  if (/\bserver\b|서버/.test(lower)) {
    topics.push('서버');
  }
  if (/\bhttp\b/.test(lower)) {
    topics.push('에이치티티피');
  }
  if (/\bhtml\b/.test(lower)) {
    topics.push('에이치티엠엘');
  }
  if (/\bxbox\b/.test(lower)) {
    topics.push('엑스박스');
  }
  if (/\bprogram manager\b|\bengineering\b|\bteam\b/.test(lower)) {
    return '화자가 자신의 역할과 개발 팀을 소개하는 내용입니다.';
  }
  if (/\bbiggest features\b|\bfeature\b/.test(lower)) {
    return '가장 중요한 온라인 기능을 소개하는 내용입니다.';
  }
  if (/\bconnect\b|\bonline\b|\bworld\b/.test(lower)) {
    return '온라인 서비스가 전 세계 사람들을 연결한다는 내용입니다.';
  }
  if (topics.length) {
    return `이 구간에서는 ${topics.slice(0, 4).join(', ')}의 작동 방식을 설명합니다.`;
  }

  return '이 구간의 내용을 한국어 더빙으로 전달합니다.';
}

function containsLatinText(text) {
  return /[A-Za-z]{3,}/.test(text);
}

function extractResponseText(body) {
  if (typeof body?.output_text === 'string') {
    return body.output_text;
  }
  if (!Array.isArray(body?.output)) {
    return '';
  }
  return body.output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((content) => content?.text || '')
    .join('\n')
    .trim();
}

function parseJsonObject(text) {
  const parsed = safeJsonParse(text);
  if (parsed) {
    return parsed;
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return safeJsonParse(text.slice(start, end + 1));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseAssignedJson(text, name) {
  const assignmentIndex = text.indexOf(name);
  if (assignmentIndex === -1) {
    return null;
  }

  const braceStart = text.indexOf('{', assignmentIndex);
  if (braceStart === -1) {
    return null;
  }

  const jsonText = extractBalancedObject(text, braceStart);
  return jsonText ? safeJsonParse(jsonText) : null;
}

function parsePlayerResponseFromHtml(html) {
  const match = html.match(/"playerResponse"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match) {
    return null;
  }

  try {
    return JSON.parse(JSON.parse(`"${match[1]}"`));
  } catch {
    return null;
  }
}

function extractBalancedObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let quote = '';

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return '';
}

function getCaptionTracks(playerResponse) {
  return playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
}

function pickBackendCaptionTrack(tracks) {
  return (
    tracks.find((track) => track.languageCode === 'en' && track.kind !== 'asr') ||
    tracks.find((track) => track.languageCode === 'en') ||
    tracks.find((track) => track.kind !== 'asr') ||
    tracks[0]
  );
}

function parseJson3CaptionSegments(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return events
    .map((event) => {
      const text = Array.isArray(event.segs)
        ? event.segs.map((seg) => seg.utf8 || '').join('')
        : '';
      const clean = cleanText(text);
      const start = Number(event.tStartMs || 0) / 1000;
      const duration = Number(event.dDurationMs || 0) / 1000;
      return {
        start: roundTime(start),
        end: roundTime(start + Math.max(duration, 0.6)),
        text: clean
      };
    })
    .filter((segment) => segment.text);
}

function parseXmlCaptionSegments(text) {
  const segments = [];
  const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let match = pattern.exec(text);

  while (match) {
    const attrs = match[1] || '';
    const start = Number((attrs.match(/\bstart="([^"]+)"/) || [])[1] || 0);
    const duration = Number((attrs.match(/\bdur="([^"]+)"/) || [])[1] || 0);
    const caption = cleanText(decodeEntities(match[2] || ''));
    if (caption) {
      segments.push({
        start: roundTime(start),
        end: roundTime(start + Math.max(duration, 0.6)),
        text: caption
      });
    }
    match = pattern.exec(text);
  }

  return segments;
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function looksLikeJson(text) {
  return /^\s*[\[{]/.test(text || '');
}

function trimForError(text) {
  return cleanText(text).slice(0, 500);
}

function batchArray(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function roundTime(value) {
  return Math.round(value * 1000) / 1000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
