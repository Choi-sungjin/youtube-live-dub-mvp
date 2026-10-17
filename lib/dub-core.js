import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const ZAI_CHAT_COMPLETIONS_URL = 'https://api.z.ai/api/paas/v4/chat/completions';
const SUPERTONE_TTS_URL = 'https://supertoneapi.com/v1/text-to-speech';
const MAX_TTS_CHARS = 300;
const MAX_CLOUD_SEGMENTS = 24;
const TRANSLATION_CACHE = new Map();
const MAX_TRANSLATION_CACHE_ITEMS = 5000;
const ZAI_RETRY_DELAYS_MS = [1500, 3500];
const ZAI_RATE_LIMIT_COOLDOWN_MS = 60_000;
const YOUTUBE_HEADERS = {
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36'
};

export const SUPERTONE_VOICES = {
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

let runtimeEnvLoaded = false;
let zaiRateLimitUntil = 0;

export async function ensureRuntimeEnv() {
  if (runtimeEnvLoaded) {
    return;
  }

  await loadEnvFile(new URL('../backend/.env', import.meta.url));
  await loadEnvFile(new URL('../backend/.env.local', import.meta.url));
  await loadEnvFile(new URL('../.env.local', import.meta.url));
  runtimeEnvLoaded = true;
}

export function providerInfo() {
  const translationProvider = normalizeProvider(
    process.env.TRANSLATION_PROVIDER || 'zai',
    ['zai', 'openai', 'mock'],
    'zai'
  );
  const ttsProvider = normalizeProvider(
    process.env.TTS_PROVIDER || 'supertone',
    ['supertone', 'mock-wav'],
    'supertone'
  );

  return {
    script: translationProvider,
    translation: translationProvider,
    tts: ttsProvider,
    openaiModel: process.env.OPENAI_MODEL || 'gpt-5.2',
    zaiModel: process.env.ZAI_MODEL || 'glm-4.7',
    zaiConfigured: Boolean(process.env.ZAI_API_KEY),
    supertoneModel: process.env.SUPERTONE_MODEL || 'sona_speech_2_flash',
    supertoneOutputFormat: normalizeAudioFormat(process.env.SUPERTONE_OUTPUT_FORMAT || 'mp3'),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    supertoneConfigured: Boolean(process.env.SUPERTONE_API_KEY),
    defaultVoiceId: process.env.SUPERTONE_DEFAULT_VOICE_ID || SUPERTONE_VOICES.lowMale.id,
    voiceSettings: {
      pitch_shift: Number(process.env.SUPERTONE_PITCH_SHIFT ?? 0),
      pitch_variance: Number(process.env.SUPERTONE_PITCH_VARIANCE ?? 1.5),
      speed: Number(process.env.SUPERTONE_SPEED ?? 1.29)
    }
  };
}

export async function prepareDub(body) {
  if (body?.settings?.ttsProvider === 'windows-sapi') throw httpError(400, 'Windows speech requires the Windows local backend.');
  const videoId = String(body?.videoId || '').trim();
  const settings = normalizeSettings(body?.settings);
  const inputSegments = Array.isArray(body?.segments) ? body.segments : [];
  const segments = inputSegments.map((segment, index) => normalizeSegment(segment, index)).filter(Boolean);

  if (!videoId) {
    throw httpError(400, 'videoId is required.');
  }
  if (segments.length === 0) {
    throw httpError(400, 'segments must contain at least one timed text segment.');
  }

  const maxSegments = clamp(
    Number(process.env.MAX_DUB_SEGMENTS || MAX_CLOUD_SEGMENTS),
    1,
    80
  );
  const limitedSegments = segments.slice(0, maxSegments);
  const translated = await translateSegments(limitedSegments, settings);
  const prepared = await mapLimit(limitedSegments, 3, async (segment) => {
    const translation = translated.get(segment.index);
    if (!translation) throw httpError(502, `Translation missing for segment ${segment.index}.`);
    const spokenText = clampTextForTts(translation);
    const sourceDuration = Math.max(0.55, Math.min(12, segment.end - segment.start));
    const id = hashValue({
      schemaVersion: 2,
      videoId,
      segment,
      settings: cacheableSettings(settings),
      translatedText: spokenText,
      providers: {
        translation: activeTranslationProvider(),
        tts: activeTtsProvider(settings)
      }
    });
    const result = await synthesizeSpeech({
      text: spokenText,
      duration: sourceDuration,
      settings
    });

    return {
      id,
      index: segment.index,
      start: segment.start,
      end: segment.end,
      startMs: Math.round(segment.start * 1000),
      endMs: Math.round(segment.end * 1000),
      sourceText: segment.text,
      translatedText: spokenText,
      audioDataUrl: toDataUrl(result.data, result.contentType),
      contentType: result.contentType,
      bytes: result.data.length,
      duration: roundTime(result.duration || sourceDuration),
      durationMs: Math.round((result.duration || sourceDuration) * 1000),
      voiceId: settings.voice,
      ttsModel: result.ttsModel || settings.ttsModel
    };
  });

  return {
    videoId,
    provider: providerInfo(),
    requestProvider: {
      translation: activeTranslationProvider(),
      tts: settings.ttsProvider,
      ttsModel: settings.ttsModel
    },
    warnings: buildWarnings(segments.length, limitedSegments.length),
    cache: {
      mode: 'inline-audio',
      hit: false,
      hits: 0,
      misses: prepared.length
    },
    segments: prepared
  };
}

export async function fetchYouTubeCaptions(videoId) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
    throw httpError(400, 'A valid YouTube videoId is required.');
  }

  const { html, playerResponse } = await fetchYouTubeWatch(videoId);
  const tracks = getCaptionTracks(playerResponse);

  if (!tracks.length) {
    throw httpError(404, `No caption tracks found by backend for YouTube video ${videoId}.`);
  }

  for (const track of prioritizeBackendCaptionTracks(tracks)) {
    const captionSegments = await fetchBackendCaptionTrackSegments(track, videoId);
    if (!captionSegments.length) {
      continue;
    }

    return {
      videoId,
      source: 'backend-youtube-watch',
      track: {
        languageCode: track.languageCode || '',
        kind: track.kind || '',
        name: track.name?.simpleText || track.name?.runs?.map((run) => run.text).join('') || ''
      },
      segments: captionSegments
    };
  }

  throw httpError(404, `Caption tracks were fetched, but no timed text segments were parsed for ${videoId}.`);
}

export async function diagnoseYouTubeCaptions(videoId) {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) {
    throw httpError(400, 'A valid YouTube videoId is required.');
  }

  const startedAt = Date.now();
  const { html, watchStatus, playerResponse } = await fetchYouTubeWatch(videoId);
  const tracks = prioritizeBackendCaptionTracks(getCaptionTracks(playerResponse));
  const trackDiagnostics = [];
  let firstSupportedTrack = null;

  for (const track of tracks.slice(0, 8)) {
    const diagnostic = await diagnoseCaptionTrack(track, videoId);
    trackDiagnostics.push(diagnostic);
    if (!firstSupportedTrack && diagnostic.segmentCount > 0) {
      firstSupportedTrack = diagnostic;
    }
  }

  const transcriptDiagnostic = await diagnoseTranscriptEndpoint(html, videoId);
  const supportedByTranscript = transcriptDiagnostic.segmentCount > 0;
  const supported = Boolean(firstSupportedTrack || supportedByTranscript);

  return {
    ok: true,
    videoId,
    checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    watch: {
      status: watchStatus,
      title: playerResponse?.videoDetails?.title || '',
      playabilityStatus: playerResponse?.playabilityStatus?.status || '',
      playabilityReason: playerResponse?.playabilityStatus?.reason || ''
    },
    supported,
    supportSource: firstSupportedTrack ? 'timedtext' : supportedByTranscript ? 'get_transcript' : '',
    reason: supported
      ? 'Timed transcript data is available.'
      : buildCaptionDiagnosisReason(tracks, trackDiagnostics, transcriptDiagnostic),
    tracks: trackDiagnostics,
    transcriptEndpoint: transcriptDiagnostic
  };
}

export async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      return req.body;
    }
    const bodyText = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    if (!bodyText.trim()) {
      return {};
    }
    try {
      return JSON.parse(bodyText);
    } catch {
      throw httpError(400, 'Request body must be valid JSON.');
    }
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function normalizeSettings(settings = {}) {
  const voice = String(settings.voice || process.env.SUPERTONE_DEFAULT_VOICE_ID || SUPERTONE_VOICES.lowMale.id);
  return {
    voice,
    tone: String(settings.tone || process.env.SUPERTONE_STYLE || 'neutral'),
    pitchShift: clamp(Number(settings.pitchShift ?? process.env.SUPERTONE_PITCH_SHIFT ?? 0), -24, 24),
    pitchVariance: clamp(Number(settings.pitchVariance ?? process.env.SUPERTONE_PITCH_VARIANCE ?? 1.5), 0, 2),
    speed: clamp(Number(settings.speed ?? process.env.SUPERTONE_SPEED ?? 1.29), 0.5, 2),
    targetLang: String(settings.targetLang || 'ko'),
    ttsModel: String(settings.ttsModel || process.env.SUPERTONE_MODEL || 'sona_speech_2_flash'),
    outputFormat: normalizeAudioFormat(settings.outputFormat || process.env.SUPERTONE_OUTPUT_FORMAT || 'mp3'),
    ttsProvider: normalizeProvider(
      settings.ttsProvider || process.env.TTS_PROVIDER || 'supertone',
      ['supertone', 'mock-wav'],
      'supertone'
    )
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
    text
  };
}

async function translateSegments(segments, settings) {
  const provider = activeTranslationProvider();
  const translated = new Map();
  const missing = [];

  for (const segment of segments) {
    const cached = getCachedTranslation(segment, settings, provider);
    if (cached) {
      translated.set(segment.index, cached);
    } else {
      missing.push(segment);
    }
  }

  if (!missing.length) {
    return translated;
  }

  let providerTranslations = new Map();
  try {
    if (provider === 'zai' && process.env.ZAI_API_KEY) {
      if (Date.now() < zaiRateLimitUntil) {
        throw httpError(429, 'Z.ai rate limit cooldown is active.');
      }
      providerTranslations = await translateSegmentsWithZai(missing, settings);
    } else if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      providerTranslations = await translateSegmentsWithOpenAI(missing, settings);
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
      setCachedTranslation(segment, settings, provider, providerText);
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

async function translateSegmentsWithOpenAI(segments, settings) {
  const translated = new Map();
  const batches = batchArray(segments, 20);

  for (const batch of batches) {
    const promptPayload = {
      target_language: settings.targetLang,
      max_tts_chars: 260,
      segments: batch.map((segment) => ({
        index: segment.index,
        start: segment.start,
        end: segment.end,
        text: segment.text
      }))
    };
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5.2',
        reasoning: { effort: 'low' },
        input: [
          {
            role: 'developer',
            content: [
              'Translate caption chunks into the requested target_language for dubbing. Never replace their meaning with generic filler.',
              'Keep each translated text natural to hear, concise enough for text-to-speech, and under 260 characters.',
              'Preserve every input index. Return JSON only: {"translations":[{"index":0,"text":"..."}]}.'
            ].join(' ')
          },
          {
            role: 'user',
            content: JSON.stringify(promptPayload)
          }
        ]
      })
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw httpError(response.status, `OpenAI Responses API failed: ${trimForError(bodyText)}`);
    }

    const body = safeJsonParse(bodyText);
    const outputText = extractResponseText(body);
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

async function synthesizeSpeech({ text, duration, settings }) {
  if (settings.ttsProvider === 'supertone' && !process.env.SUPERTONE_API_KEY) {
    throw httpError(503, 'Supertone API key is not configured. Select an available speech provider.');
  }
  if (settings.ttsProvider === 'supertone' && process.env.SUPERTONE_API_KEY) {
    return synthesizeWithSupertone({ text, duration, settings });
  }

  const wav = createMockSpeechWav({
    text,
    duration,
    voice: settings.voice,
    tone: settings.tone,
    speed: settings.speed
  });
  return {
    data: wav,
    contentType: 'audio/wav',
    duration
  };
}

async function synthesizeWithSupertone({ text, duration, settings }) {
  let usedSettings = settings;
  let requestText = text;
  let response = await requestSupertoneSpeech({ text: requestText, duration, settings: usedSettings });
  let data = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    throw httpError(response.status, `Supertone TTS failed (HTTP ${response.status}): ${trimForError(data.toString('utf8')) || response.statusText || 'empty response'}. Check the provider service/voice, or select Windows speech on the local backend.`);
  }

  const audioLength = Number(response.headers.get('x-audio-length'));
  const contentType = response.headers.get('content-type') || contentTypeForFormat(usedSettings.outputFormat);
  return {
    data,
    contentType: normalizeContentType(contentType),
    duration: Number.isFinite(audioLength) && audioLength > 0 ? audioLength : duration,
    ttsModel: usedSettings.ttsModel
  };
}

async function requestSupertoneSpeech({ text, duration, settings }) {
  const url = new URL(`${SUPERTONE_TTS_URL}/${encodeURIComponent(settings.voice)}`);
  url.searchParams.set('output_format', settings.outputFormat);
  return fetch(url.toString(), {
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
      output_format: settings.outputFormat,
      voice_settings: {
        pitch_shift: settings.pitchShift,
        pitch_variance: settings.pitchVariance,
        speed: settings.speed,
        duration: Math.max(0, Math.min(60, roundTime(duration || 0)))
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

function getCachedTranslation(segment, settings, provider) {
  return TRANSLATION_CACHE.get(translationCacheKey(segment, settings, provider)) || '';
}

function setCachedTranslation(segment, settings, provider, text) {
  if (!text) {
    return;
  }
  if (TRANSLATION_CACHE.size >= MAX_TRANSLATION_CACHE_ITEMS) {
    const oldestKey = TRANSLATION_CACHE.keys().next().value;
    if (oldestKey) {
      TRANSLATION_CACHE.delete(oldestKey);
    }
  }
  TRANSLATION_CACHE.set(translationCacheKey(segment, settings, provider), text);
}

function translationCacheKey(segment, settings, provider) {
  return hashValue({
    provider,
    model: provider === 'zai' ? process.env.ZAI_MODEL || 'glm-4.7' : process.env.OPENAI_MODEL || 'gpt-5.2',
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

async function loadEnvFile(fileUrl) {
  let raw = '';
  try {
    raw = await readFile(fileUrl, 'utf8');
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

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function activeTranslationProvider() {
  return normalizeProvider(process.env.TRANSLATION_PROVIDER || 'zai', ['zai', 'openai', 'mock'], 'zai');
}

function activeTtsProvider(settings) {
  return normalizeProvider(settings?.ttsProvider || process.env.TTS_PROVIDER || 'supertone', ['supertone', 'mock-wav'], 'supertone');
}

function buildWarnings(inputCount, preparedCount) {
  const warnings = [];
  if (activeTranslationProvider() === 'zai' && !process.env.ZAI_API_KEY) {
    warnings.push('ZAI_API_KEY is not configured; translation requests will fail.');
  }
  if (activeTranslationProvider() === 'openai' && !process.env.OPENAI_API_KEY) {
    warnings.push('OPENAI_API_KEY is not configured; translation requests will fail.');
  }
  if (normalizeProvider(process.env.TTS_PROVIDER || 'supertone', ['supertone', 'mock-wav'], 'supertone') === 'supertone' && !process.env.SUPERTONE_API_KEY) {
    warnings.push('SUPERTONE_API_KEY is not configured; Supertone requests will fail.');
  }
  if (preparedCount < inputCount) {
    warnings.push(`Prepared ${preparedCount} of ${inputCount} requested segments to keep the Vercel response bounded.`);
  }
  return warnings;
}

function normalizeProvider(value, allowed, fallback) {
  const normalized = String(value || fallback).toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeAudioFormat(value) {
  const normalized = String(value || 'mp3').toLowerCase();
  return ['mp3', 'wav'].includes(normalized) ? normalized : 'mp3';
}

function contentTypeForFormat(format) {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
}

function normalizeContentType(value) {
  const contentType = String(value || '').split(';')[0].trim().toLowerCase();
  if (contentType === 'audio/mp3') {
    return 'audio/mpeg';
  }
  return contentType || 'application/octet-stream';
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
    outputFormat: settings.outputFormat,
    ttsProvider: settings.ttsProvider
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

async function fetchYouTubeWatch(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`;
  const watchResponse = await fetch(watchUrl, {
    headers: YOUTUBE_HEADERS
  });
  const html = await watchResponse.text();

  if (!watchResponse.ok) {
    throw httpError(watchResponse.status, `YouTube watch page fetch failed: HTTP ${watchResponse.status}`);
  }

  return {
    html,
    watchStatus: watchResponse.status,
    playerResponse:
      parseAssignedJson(html, 'ytInitialPlayerResponse') ||
      parsePlayerResponseFromHtml(html) ||
      {}
  };
}

function pickBackendCaptionTrack(tracks) {
  return (
    tracks.find((track) => track.languageCode === 'en' && track.kind !== 'asr') ||
    tracks.find((track) => track.languageCode === 'en') ||
    tracks.find((track) => track.kind !== 'asr') ||
    tracks[0]
  );
}

function prioritizeBackendCaptionTracks(tracks) {
  return [...tracks]
    .filter((track) => track?.baseUrl)
    .sort((a, b) => backendCaptionTrackScore(a) - backendCaptionTrackScore(b));
}

function backendCaptionTrackScore(track) {
  const language = String(track.languageCode || '').toLowerCase();
  const name = String(track.name?.simpleText || track.name?.runs?.map((run) => run.text || '').join('') || '').toLowerCase();
  const isAuto = track.kind === 'asr' || name.includes('auto');
  const isEnglish = language === 'en' || language.startsWith('en-');

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

async function fetchBackendCaptionTrackSegments(track, videoId) {
  for (const item of buildBackendCaptionUrls(track.baseUrl, videoId)) {
    const captionResponse = await fetch(item.url, {
      headers: YOUTUBE_HEADERS
    });
    const captionText = await captionResponse.text();

    if (!captionResponse.ok) {
      continue;
    }

    const segments = parseBackendCaptionResponse(captionText, item.format);
    if (segments.length) {
      return segments;
    }
  }

  return [];
}

async function diagnoseCaptionTrack(track, videoId) {
  const attempts = [];
  let bestSegmentCount = 0;
  let firstSegment = null;

  for (const item of buildBackendCaptionUrls(track.baseUrl, videoId)) {
    let status = 0;
    let contentType = '';
    let text = '';
    let error = '';

    try {
      const captionResponse = await fetch(item.url, {
        headers: YOUTUBE_HEADERS
      });
      status = captionResponse.status;
      contentType = captionResponse.headers.get('content-type') || '';
      text = await captionResponse.text();
    } catch (fetchError) {
      error = fetchError?.message || String(fetchError);
    }

    const segments = text ? parseBackendCaptionResponse(text, item.format) : [];
    if (segments.length > bestSegmentCount) {
      bestSegmentCount = segments.length;
      firstSegment = segments[0] || null;
    }

    attempts.push({
      format: item.format || 'default',
      status,
      contentType,
      bytes: Buffer.byteLength(text || '', 'utf8'),
      segmentCount: segments.length,
      firstText: segments[0]?.text || '',
      error
    });
  }

  return {
    languageCode: track.languageCode || '',
    kind: track.kind || '',
    name: readCaptionTrackName(track),
    isAutoGenerated: track.kind === 'asr' || /auto/i.test(readCaptionTrackName(track)),
    hasBaseUrl: Boolean(track.baseUrl),
    segmentCount: bestSegmentCount,
    firstSegment,
    attempts
  };
}

async function diagnoseTranscriptEndpoint(html, videoId) {
  const endpoint = findTranscriptEndpointFromHtml(html);
  const config = findYouTubeConfigFromHtml(html);

  if (!endpoint?.params) {
    return {
      present: false,
      attempted: false,
      status: 0,
      segmentCount: 0,
      error: 'No getTranscriptEndpoint params were found in the watch page.'
    };
  }

  if (!config?.INNERTUBE_API_KEY || !config?.INNERTUBE_CONTEXT) {
    return {
      present: true,
      attempted: false,
      status: 0,
      segmentCount: 0,
      error: 'getTranscriptEndpoint exists, but INNERTUBE config was not found.'
    };
  }

  const response = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(config.INNERTUBE_API_KEY)}`, {
    method: 'POST',
    headers: {
      ...YOUTUBE_HEADERS,
      'Content-Type': 'application/json',
      'x-youtube-client-name': String(config.INNERTUBE_CONTEXT_CLIENT_NAME || '1'),
      'x-youtube-client-version': String(config.INNERTUBE_CONTEXT?.client?.clientVersion || '')
    },
    body: JSON.stringify({
      context: config.INNERTUBE_CONTEXT,
      params: endpoint.params
    })
  });
  const text = await response.text();
  const payload = safeJsonParse(text);
  const segments = parseTranscriptEndpointSegments(payload);

  return {
    present: true,
    attempted: true,
    status: response.status,
    bytes: Buffer.byteLength(text || '', 'utf8'),
    segmentCount: segments.length,
    firstText: segments[0]?.text || '',
    error: response.ok ? '' : payload?.error?.message || trimForError(text)
  };
}

function buildCaptionDiagnosisReason(tracks, trackDiagnostics, transcriptDiagnostic) {
  if (!tracks.length) {
    return 'No caption tracks were exposed by YouTube for this video.';
  }

  const hasOnlyEmptyTimedText = trackDiagnostics.length > 0 && trackDiagnostics.every((track) => {
    return track.attempts.length > 0 && track.attempts.every((attempt) => attempt.status === 200 && attempt.bytes === 0);
  });

  if (hasOnlyEmptyTimedText) {
    return 'YouTube exposes caption track metadata, but every timedtext format returned an empty body.';
  }

  if (transcriptDiagnostic.present && transcriptDiagnostic.attempted && transcriptDiagnostic.status >= 400) {
    return `Timedtext did not return segments, and get_transcript failed with HTTP ${transcriptDiagnostic.status}.`;
  }

  return 'Caption tracks were found, but no timed transcript segments could be parsed.';
}

function findTranscriptEndpointFromHtml(html) {
  const match = html.match(/"getTranscriptEndpoint"\s*:\s*\{"params":"([^"]+)"/);
  return match ? { params: match[1] } : null;
}

function findYouTubeConfigFromHtml(html) {
  let searchIndex = 0;
  while (searchIndex < html.length) {
    const index = html.indexOf('ytcfg.set', searchIndex);
    if (index === -1) {
      break;
    }

    const braceStart = html.indexOf('{', index);
    if (braceStart === -1) {
      break;
    }

    const parsed = safeJsonParse(extractBalancedObject(html, braceStart));
    if (parsed?.INNERTUBE_API_KEY && parsed?.INNERTUBE_CONTEXT) {
      return parsed;
    }
    searchIndex = index + 9;
  }

  return null;
}

function readCaptionTrackName(track) {
  return track?.name?.simpleText || track?.name?.runs?.map((run) => run.text || '').join('') || '';
}

function buildBackendCaptionUrls(baseUrl, videoId) {
  const formats = ['json3', 'vtt', 'srv3', ''];
  const seen = new Set();
  const urls = [];

  for (const format of formats) {
    const url = new URL(baseUrl);
    if (format) {
      url.searchParams.set('fmt', format);
    } else {
      url.searchParams.delete('fmt');
    }
    if (!url.searchParams.get('v')) {
      url.searchParams.set('v', videoId);
    }

    const href = url.toString();
    if (!seen.has(href)) {
      seen.add(href);
      urls.push({ url: href, format });
    }
  }

  return urls;
}

function parseBackendCaptionResponse(text, format) {
  if (format === 'vtt' || /^\s*WEBVTT\b/i.test(text || '')) {
    return parseVttCaptionSegments(text);
  }
  if (looksLikeJson(text)) {
    return parseJson3CaptionSegments(safeJsonParse(text));
  }
  return parseXmlCaptionSegments(text);
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

  if (segments.length) {
    return segments;
  }

  const srv3Pattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  match = srv3Pattern.exec(text);

  while (match) {
    const attrs = match[1] || '';
    const start = Number((attrs.match(/\bt="([^"]+)"/) || [])[1] || 0) / 1000;
    const duration = Number((attrs.match(/\bd="([^"]+)"/) || [])[1] || 0) / 1000;
    const caption = cleanText(decodeEntities(match[2] || '').replace(/<[^>]+>/g, ''));
    if (caption) {
      segments.push({
        start: roundTime(start),
        end: roundTime(start + Math.max(duration, 0.6)),
        text: caption
      });
    }
    match = srv3Pattern.exec(text);
  }

  return segments;
}

function parseVttCaptionSegments(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes('-->'));

      if (timingIndex === -1) {
        return null;
      }

      const match = lines[timingIndex].match(/([\d:.]+)\s+-->\s+([\d:.]+)/);
      if (!match) {
        return null;
      }

      const caption = cleanText(lines
        .slice(timingIndex + 1)
        .filter((line) => !/^(NOTE|STYLE|REGION)\b/.test(line))
        .join(' '));

      if (!caption) {
        return null;
      }

      return {
        start: roundTime(parseVttTime(match[1])),
        end: roundTime(parseVttTime(match[2])),
        text: caption
      };
    })
    .filter((segment) => segment && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start);
}

function parseVttTime(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.length === 3) {
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  }
  if (parts.length === 2) {
    return (parts[0] * 60) + parts[1];
  }
  return Number(value) || 0;
}

function parseTranscriptEndpointSegments(payload) {
  const renderers = [];
  collectTranscriptSegmentRenderers(payload, renderers);
  const rawSegments = renderers
    .map((renderer) => ({
      start: Number(renderer.startMs || 0) / 1000,
      end: Number(renderer.endMs || 0) / 1000,
      text: cleanText(readRichText(renderer.snippet))
    }))
    .filter((segment) => Number.isFinite(segment.start) && segment.text)
    .sort((a, b) => a.start - b.start);

  return rawSegments
    .map((segment, index) => ({
      start: roundTime(segment.start),
      end: roundTime(segment.end > segment.start
        ? segment.end
        : rawSegments[index + 1]?.start || segment.start + 2),
      text: segment.text
    }))
    .filter((segment) => segment.end > segment.start);
}

function collectTranscriptSegmentRenderers(value, output, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectTranscriptSegmentRenderers(item, output, seen));
    return;
  }
  if (value.transcriptSegmentRenderer) {
    output.push(value.transcriptSegmentRenderer);
  }
  Object.values(value).forEach((item) => collectTranscriptSegmentRenderers(item, output, seen));
}

function readRichText(value) {
  if (!value) {
    return '';
  }
  if (typeof value.simpleText === 'string') {
    return value.simpleText;
  }
  if (Array.isArray(value.runs)) {
    return value.runs.map((run) => run.text || '').join('');
  }
  return '';
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

function toDataUrl(buffer, contentType) {
  return `data:${contentType || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
}

function roundTime(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
