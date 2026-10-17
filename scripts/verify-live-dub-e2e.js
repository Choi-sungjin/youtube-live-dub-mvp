const DEFAULT_BACKEND_URL = 'http://127.0.0.1:18789';
const DEFAULT_VIDEO_URL = 'https://www.youtube.com/watch?v=T-HZHO_PQPY';

const options = parseArgs(process.argv.slice(2));
const backendUrl = String(options.backend || process.env.BACKEND_URL || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
const videoUrl = String(options.url || DEFAULT_VIDEO_URL);
const videoId = extractVideoId(videoUrl);

if (!videoId) {
  fail(`Could not parse video id from ${videoUrl}`);
}

const settings = {
  ttsProvider: options.ttsProvider || 'supertone',
  voice: options.voice || process.env.SUPERTONE_DEFAULT_VOICE_ID || '763d5f200a9f5808056733',
  tone: 'neutral',
  targetLang: options.targetLang || 'ko',
  ttsModel: options.ttsModel || process.env.SUPERTONE_MODEL || 'sona_speech_2_flash',
  pitchShift: Number(options.pitch ?? 0),
  pitchVariance: Number(options.variance ?? 1.5),
  speed: Number(options.speed ?? 1.29)
};

const report = {
  ok: false,
  backendUrl,
  videoId,
  videoUrl,
  checks: []
};

await checkHealth();
const preprocess = await checkPreprocess();
const captions = await checkCaptions(preprocess);
const prepared = await checkPrepare(captions.segments.slice(0, Number(options.prepareSegments || 2)));
await checkAudio(prepared.segments[0]);

report.ok = true;
console.log(JSON.stringify(report, null, 2));

async function checkHealth() {
  const body = await fetchJson(`${backendUrl}/api/health`);
  assert(body.ok, 'Backend health did not return ok=true.');
  assert(body.provider?.zaiConfigured, 'Z.ai is not configured.');
  if (settings.ttsProvider === 'supertone') assert(body.provider?.supertoneConfigured, 'Supertone is not configured.');
  if (settings.ttsProvider === 'windows-sapi') assert(body.ttsProviders?.includes('windows-sapi'), 'Windows speech is unavailable.');
  addCheck('health', {
    provider: {
      translation: body.provider.translation,
      tts: body.provider.tts,
      zaiConfigured: body.provider.zaiConfigured,
      supertoneConfigured: body.provider.supertoneConfigured
    }
  });
}

async function checkPreprocess() {
  const start = await fetchJson(`${backendUrl}/api/captions/preprocess`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      videoId,
      videoUrl,
      language: options.language || 'en',
      sttModel: options.sttModel || 'tiny',
      maxDuration: Number(options.maxDuration || 20),
      prewarmSegments: Number(options.prewarmSegments || 0),
      force: options.force !== 'false',
      settings
    })
  });
  assert(start.status === 'running' || start.status === 'done', `Unexpected preprocess start status: ${start.status}`);

  const deadline = Date.now() + Number(options.timeoutMs || 240000);
  let status = start;
  while (Date.now() < deadline) {
    if (status.status === 'done' && Array.isArray(status.segments) && status.segments.length) {
      addCheck('preprocess', {
        status: status.status,
        segments: status.segments.length,
        firstText: status.segments[0]?.text || ''
      });
      return status;
    }
    if (status.status === 'failed') {
      fail(`Preprocess failed: ${status.error || status.outputTail || 'unknown error'}`);
    }
    await delay(Number(options.pollMs || 5000));
    status = await fetchJson(`${backendUrl}/api/captions/preprocess?videoId=${encodeURIComponent(videoId)}`);
  }

  fail(`Preprocess timed out for ${videoId}. Last status: ${JSON.stringify(status)}`);
}

async function checkCaptions(preprocess) {
  const body = await fetchJson(`${backendUrl}/api/captions?videoId=${encodeURIComponent(videoId)}`);
  assert(Array.isArray(body.segments) && body.segments.length, 'Captions endpoint returned no segments.');
  assert(body.segments[0].text === preprocess.segments[0].text, 'Captions endpoint is not returning the latest preprocessed segments.');
  addCheck('captions', {
    source: body.source,
    segments: body.segments.length,
    first: body.segments[0]
  });
  return body;
}

async function checkPrepare(segments) {
  assert(segments.length, 'No segments available for prepare.');
  const body = await fetchJson(`${backendUrl}/api/dub/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      videoId,
      source: 'e2e-verify',
      currentTime: 0,
      settings,
      segments
    })
  });
  assert(Array.isArray(body.segments) && body.segments.length === segments.length, 'Prepare did not return the expected number of segments.');
  for (const segment of body.segments) {
    assert(segment.audioUrl || segment.audioDataUrl, `Prepared segment ${segment.index} has no audio URL/data.`);
  }
  addCheck('prepare', {
    requested: segments.length,
    prepared: body.segments.length,
    firstTranslatedText: body.segments[0]?.translatedText || '',
    provider: body.requestProvider,
    firstAudioUrl: body.segments[0]?.audioUrl || ''
  });
  return body;
}

async function checkAudio(segment) {
  if (segment.audioDataUrl) {
    assert(segment.audioDataUrl.startsWith('data:audio/'), 'Inline audio data URL has an unexpected format.');
    addCheck('audio', {
      mode: 'inline',
      bytes: segment.bytes || 0,
      contentType: segment.contentType || ''
    });
    return;
  }

  const response = await fetch(segment.audioUrl, { cache: 'no-store' });
  assert(response.ok, `Audio URL failed with HTTP ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  assert(buffer.length > 1000, `Audio file is too small: ${buffer.length} bytes.`);
  const riff = buffer.slice(0, 4).toString('ascii');
  assert(riff === 'RIFF' || segment.audioUrl.endsWith('.mp3'), `Unexpected audio header: ${riff}`);
  addCheck('audio', {
    mode: 'url',
    bytes: buffer.length,
    contentType: response.headers.get('content-type') || '',
    header: riff
  });
}

async function fetchJson(url, init) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(90000) });
  } catch (error) {
    fail(`Fetch failed for ${url}: ${error.message || String(error)}`);
  }
  const text = await response.text();
  const body = text ? safeJsonParse(text) : {};
  if (!response.ok) {
    fail(`HTTP ${response.status} for ${url}: ${body?.error || text}`);
  }
  if (!body) {
    fail(`Non-JSON response from ${url}: ${text.slice(0, 300)}`);
  }
  return body;
}

function addCheck(name, detail) {
  report.checks.push({ name, ok: true, ...detail });
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function fail(message) {
  report.ok = false;
  report.error = message;
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

function extractVideoId(input) {
  const raw = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) {
    return raw;
  }
  try {
    const url = new URL(raw);
    if (url.hostname.includes('youtu.be')) {
      return url.pathname.split('/').filter(Boolean)[0] || '';
    }
    return url.searchParams.get('v') || '';
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      parsed.url = parsed.url || token;
      continue;
    }
    const key = token.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
