import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcribeWithFallback } from '../lib/stt-fallback.js';
import { timedClauses } from '../lib/timed-transcript.js';
import { normalizeTechnicalTranscript } from '../lib/transcript-terms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const CACHE_DIR = path.join(BACKEND_DIR, '.cache');
const SOURCE_DIR = path.join(CACHE_DIR, 'source');
const STT_DIR = path.join(CACHE_DIR, 'stt');
const STT_INPUT_DIR = path.join(STT_DIR, 'input');
const RAW_STT_DIR = path.join(STT_DIR, 'raw');
const AUDIO_DIR = path.join(CACHE_DIR, 'audio');
const DEFAULT_BACKEND_URL = 'http://127.0.0.1:18789';

bootstrapWindowsPythonScriptsPath();

const args = parseArgs(process.argv.slice(2));
if (Number(args.prewarmSegments) <= 0) {
  args.noPrewarm = true;
}

if (!args.input) {
  fail('Usage: npm run dub:preprocess -- <youtube-url-or-video-id> [--language ja] [--stt-model small] [--backend http://127.0.0.1:18789]');
}

const videoId = extractVideoId(args.input);
if (!videoId) {
  fail(`Could not parse a YouTube video id from: ${args.input}`);
}

await mkdir(SOURCE_DIR, { recursive: true });
await mkdir(STT_DIR, { recursive: true });
await mkdir(STT_INPUT_DIR, { recursive: true });
await mkdir(RAW_STT_DIR, { recursive: true });

const sourceUrl = normalizeYouTubeUrl(args.input, videoId);
const audioPath = path.join(SOURCE_DIR, `${videoId}.wav`);
const rawWhisperJson = await preprocess();
const sttWindow = sttWindowFromOptions(args);
const segments = normalizeWhisperSegments(rawWhisperJson, args)
  .flatMap((segment) => rawWhisperJson.segments.some(item => item.words?.length) ? [segment] : splitLongSegment(segment, {
    maxDuration: Number(args.maxSegmentDuration || 3.8),
    maxChars: Number(args.maxChars || 120)
  }))
  .map((segment, index) => ({
    index,
    start: roundTime(segment.start),
    end: roundTime(segment.end),
    text: cleanText(segment.text)
  }))
  .filter((segment) => segment.end > segment.start && segment.text);

if (!segments.length) {
  console.log('STT completed: no speech in this window; recording inspected coverage.');
}

const segmentPath = path.join(STT_DIR, `${videoId}.segments.json`);
const previousPayload = await readExistingSegmentPayload(segmentPath);
const modelMatches = previousPayload?.sttModel === args.sttModel;
if (previousPayload && !modelMatches) {
  await writeFile(`${segmentPath}.${Date.now()}.previous.json`, JSON.stringify(previousPayload, null, 2));
}
const previousSegments = normalizeStoredSegments(modelMatches ? previousPayload?.segments : [])
  .filter(segment => sttWindow.endTime && (segment.end <= sttWindow.startTime || segment.start >= sttWindow.endTime));
const mergedSegments = mergeTimedSegments(previousSegments, segments);
await writeFile(segmentPath, JSON.stringify({
  videoId,
  sourceUrl,
  source: 'local-whisper-stt',
  generatedAt: new Date().toISOString(),
  language: args.language || rawWhisperJson.language || 'auto',
  sttModel: args.sttModel || 'small',
  windowStart: roundTime(sttWindow.startTime),
  windowDuration: sttWindow.duration ? roundTime(sttWindow.duration) : 0,
  windowEnd: sttWindow.endTime ? roundTime(sttWindow.endTime) : 0,
  coverageEnd: getLastSegmentEnd(mergedSegments),
  windows: appendSttWindow(modelMatches ? previousPayload?.windows : [], {
    start: roundTime(sttWindow.startTime),
    end: sttWindow.endTime ? roundTime(sttWindow.endTime) : getLastSegmentEnd(segments),
    duration: sttWindow.duration ? roundTime(sttWindow.duration) : 0,
    generatedAt: new Date().toISOString(),
    segments: segments.length
  }),
  sourceAudio: path.relative(ROOT_DIR, audioPath).replace(/\\/g, '/'),
  sourceAudioSha1: await sha1File(audioPath),
  segments: mergedSegments
}, null, 2));

console.log(JSON.stringify({
  ok: true,
  videoId,
  sourceUrl,
  segmentPath,
  windowStart: roundTime(sttWindow.startTime),
  windowDuration: sttWindow.duration ? roundTime(sttWindow.duration) : 0,
  windowSegments: segments.length,
  segments: mergedSegments.length,
  first: mergedSegments[0],
  last: mergedSegments[mergedSegments.length - 1]
}, null, 2));

if (!args.noPrewarm) {
  await prewarmDubAudio(videoId, segments, args);
}

async function preprocess() {
  if (!args.noDownload) {
    await requireCommand('yt-dlp', 'Install yt-dlp before running the STT fallback.');
    await downloadOriginalAudio(sourceUrl, audioPath, args);
  } else if (!(await fileExists(audioPath))) {
    fail(`--no-download was set, but source audio does not exist: ${audioPath}`);
  }

  rejectGeneratedAudioInput(audioPath);
  const sttInputPath = await prepareSttInputAudio(audioPath, videoId, args);
  const rawOutputDir = rawSttOutputDir(videoId, args);
  await mkdir(rawOutputDir, { recursive: true });

  if (!args.noStt) {
    const legacy = async () => {
      const whisperCommand = resolveWhisperCommand();
      if (!whisperCommand) {
        fail('Install openai-whisper before running STT. Expected either `whisper` or `python3 -m whisper`.');
      }
      await runWhisper(whisperCommand, sttInputPath, rawOutputDir, args);
    };
    if (process.send && process.env.YLD_FAST_STT !== '0') {
      if ((args.sttModel || 'tiny') === 'tiny') await transcribeWithFallback(() => runFastWhisper(sttInputPath, rawOutputDir, args), legacy);
      else await runFastWhisper(sttInputPath, rawOutputDir, args);
    } else {
      await legacy();
    }
  }

  return readWhisperJson(videoId, rawOutputDir);
}

async function runFastWhisper(inputPath, outputDir, options) {
  const existing = await findWhisperJson(videoId, outputDir);
  if (!options.force && existing) return;
  const id = `${Date.now()}-${videoId}`;
  const result = await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); process.off('message', receive); };
    const receive = message => {
      if (message?.type !== 'YLD_STT_RESULT' || message.id !== id) return;
      cleanup(); if (message.error) reject(new Error(message.error)); else resolve(message.result);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Fast STT response timed out')); }, 240000);
    process.on('message', receive);
    process.send({ type: 'YLD_STT_REQUEST', id, inputPath, model: options.sttModel || 'tiny', language: options.language || 'auto' });
  });
  await writeFile(path.join(outputDir, `${videoId}.json`), JSON.stringify(result));
  console.log(`Fast STT: ${result.inferenceMs}ms, ${result.segments.length} segments`);
}

async function downloadOriginalAudio(url, outputPath, options) {
  if (await fileExists(outputPath) && !options.forceDownload) {
    console.log(`Using cached source audio: ${outputPath}`);
    return;
  }

  const ytDlpCommand = await requireCommand('yt-dlp', 'Install yt-dlp before running the STT fallback.');
  const ffmpegLocation = await resolveFfmpegLocation(options);
  const commandArgs = [
    '--no-playlist',
    '--js-runtimes', `node:${process.execPath}`,
    '-f',
    'ba/bestaudio',
    '--extract-audio',
    '--audio-format',
    'wav',
    '--audio-quality',
    '0',
    '-o',
    path.join(SOURCE_DIR, `${videoId}.%(ext)s`),
  ];

  if (ffmpegLocation) {
    commandArgs.push('--ffmpeg-location', ffmpegLocation);
  }
  commandArgs.push(url);

  await run(ytDlpCommand, commandArgs, { ffmpegLocation });

  if (!await fileExists(outputPath)) {
    fail(`yt-dlp finished, but WAV output was not found: ${outputPath}`);
  }
}

async function prepareSttInputAudio(inputPath, videoId, options) {
  const sttWindow = sttWindowFromOptions(options);
  if (!sttWindow.startTime && !sttWindow.duration) {
    return inputPath;
  }

  const inputDir = path.join(STT_INPUT_DIR, `${videoId}.${sttWindowKey(sttWindow)}`);
  await mkdir(inputDir, { recursive: true });
  const outputPath = path.join(inputDir, `${videoId}.wav`);
  if (!options.force && await fileExists(outputPath)) {
    return outputPath;
  }

  const ffmpegLocation = await resolveFfmpegLocation(options);
  const commandArgs = [
    '-y',
  ];
  if (sttWindow.startTime > 0) {
    commandArgs.push('-ss', String(sttWindow.startTime));
  }
  commandArgs.push(
    '-i',
    inputPath
  );
  if (sttWindow.duration > 0) {
    commandArgs.push('-t', String(sttWindow.duration));
  }
  commandArgs.push(
    '-ac',
    '1',
    '-ar',
    '16000',
    outputPath
  );
  await run('ffmpeg', commandArgs, { ffmpegLocation });

  return outputPath;
}

function resolveWhisperCommand() {
  const whisperCommand = resolveExecutable('whisper', ['--help']);
  if (whisperCommand) {
    return { command: whisperCommand, baseArgs: [] };
  }
  const probe = spawnSync('python3', ['-m', 'whisper', '--help'], { stdio: 'ignore' });
  if (probe.status === 0) {
    return { command: 'python3', baseArgs: ['-m', 'whisper'] };
  }
  return null;
}

async function runWhisper(whisperCommand, inputPath, outputDir, options) {
  const existing = await findWhisperJson(videoId, outputDir);
  if (!options.force && existing) {
    console.log(`Using cached Whisper JSON: ${existing}`);
    return;
  }

  const commandArgs = [
    ...whisperCommand.baseArgs,
    inputPath,
    '--model',
    options.sttModel || 'small',
    '--task',
    'transcribe',
    '--output_format',
    'json',
    '--output_dir',
    outputDir
  ];
  if (options.language && options.language !== 'auto') {
    commandArgs.push('--language', options.language);
  }

  await run(whisperCommand.command, commandArgs, {
    ffmpegLocation: await resolveFfmpegLocation(options)
  });
}

function rawSttOutputDir(videoId, options) {
  const durationKey = sttWindowKey(sttWindowFromOptions(options));
  const modelKey = String(options.sttModel || 'small').replace(/[^A-Za-z0-9._-]/g, '_');
  const languageKey = String(options.language || 'auto').replace(/[^A-Za-z0-9._-]/g, '_');
  const engineKey = process.send && process.env.YLD_FAST_STT !== '0' ? '-fast-v1' : '';
  return path.join(RAW_STT_DIR, `${videoId}-${durationKey}-${modelKey}-${languageKey}${engineKey}`);
}

async function readWhisperJson(videoId, outputDir) {
  const jsonPath = await findWhisperJson(videoId, outputDir);
  if (!jsonPath) {
    fail(`Whisper JSON was not found in ${outputDir}`);
  }

  const parsed = JSON.parse(await readFile(jsonPath, 'utf8'));
  if (!Array.isArray(parsed.segments)) {
    fail(`Whisper JSON has no segments array: ${jsonPath}`);
  }
  return parsed;
}

async function findWhisperJson(videoId, outputDir) {
  const expected = path.join(outputDir, `${videoId}.json`);
  if (await fileExists(expected)) {
    return expected;
  }
  return '';
}

function normalizeWhisperSegments(payload, options) {
  const sttWindow = sttWindowFromOptions(options);
  const startOffset = sttWindow.startTime || 0;
  const clipEnd = sttWindow.endTime || 0;
  return normalizeTechnicalTranscript(timedClauses(payload.segments))
    .map((segment) => ({
      start: Number(segment.start) + startOffset,
      end: Number(segment.end) + startOffset,
      text: cleanText(segment.text || '')
    }))
    .filter((segment) => {
      if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start || !segment.text) {
        return false;
      }
      return !clipEnd || segment.start < clipEnd;
    })
    .map((segment) => ({
      ...segment,
      end: clipEnd ? Math.min(segment.end, clipEnd) : segment.end
    }))
    .filter((segment) => segment.end > segment.start);
}

async function readExistingSegmentPayload(segmentPath) {
  if (!await fileExists(segmentPath)) {
    return null;
  }

  try {
    return JSON.parse(await readFile(segmentPath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeStoredSegments(segments) {
  return Array.isArray(segments)
    ? segments.map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      text: cleanText(segment.text || '')
    })).filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text)
    : [];
}

function mergeTimedSegments(existing, incoming) {
  const sorted = [...existing, ...incoming]
    .map((segment) => ({
      start: roundTime(segment.start),
      end: roundTime(segment.end),
      text: cleanText(segment.text || '')
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result = [];

  for (const segment of sorted) {
    if (result.some((candidate) => isDuplicateSegment(candidate, segment))) {
      continue;
    }
    result.push(segment);
  }

  return result.map((segment, index) => ({
    index,
    ...segment
  }));
}

function isDuplicateSegment(a, b) {
  if (a.text !== b.text) {
    return false;
  }
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap <= 0) {
    return false;
  }
  const shortest = Math.min(a.end - a.start, b.end - b.start);
  return overlap >= Math.min(1.2, shortest * 0.7);
}

function appendSttWindow(windows, nextWindow) {
  const current = Array.isArray(windows) ? windows.slice(-40) : [];
  current.push(nextWindow);
  return current;
}

function sttWindowFromOptions(options) {
  const startTime = Math.max(0, Number(options.startTime || 0));
  const maxDuration = Math.max(0, Number(options.maxDuration || 0));
  const windowDuration = Math.max(0, Number(options.windowDuration || 0));
  const duration = windowDuration || (startTime > 0 && maxDuration > startTime ? maxDuration - startTime : maxDuration);
  return {
    startTime,
    duration,
    endTime: duration ? startTime + duration : 0
  };
}

function sttWindowKey(sttWindow) {
  if (!sttWindow.startTime && !sttWindow.duration) {
    return 'full';
  }
  if (sttWindow.startTime > 0) {
    return `start-${Math.round(sttWindow.startTime)}-dur-${Math.round(sttWindow.duration || 0)}`;
  }
  return `max-${Math.round(sttWindow.duration || 0)}`;
}

function splitLongSegment(segment, options) {
  const duration = segment.end - segment.start;
  const requiredParts = Math.max(
    1,
    Math.ceil(duration / options.maxDuration),
    Math.ceil(segment.text.length / options.maxChars)
  );

  if (requiredParts <= 1) {
    return [segment];
  }

  const parts = splitTextIntoParts(segment.text, requiredParts, options.maxChars);
  const totalChars = parts.reduce((sum, part) => sum + Math.max(1, part.length), 0);
  let cursor = segment.start;

  return parts.map((part, index) => {
    const isLast = index === parts.length - 1;
    const share = Math.max(1, part.length) / totalChars;
    const end = isLast ? segment.end : Math.min(segment.end, cursor + duration * share);
    const item = {
      start: cursor,
      end,
      text: part
    };
    cursor = end;
    return item;
  });
}

function splitTextIntoParts(text, desiredParts, maxChars) {
  const sentenceParts = cleanText(text)
    .split(/(?<=[。！？.!?])\s*|\s+/u)
    .map((part) => cleanText(part))
    .filter(Boolean);

  if (sentenceParts.length >= desiredParts) {
    const result = [];
    let current = '';
    for (const part of sentenceParts) {
      const candidate = `${current} ${part}`.trim();
      if (current && candidate.length > maxChars) {
        result.push(current);
        current = part;
      } else {
        current = candidate;
      }
    }
    if (current) {
      result.push(current);
    }
    return result;
  }

  const result = [];
  const chunkSize = Math.ceil(cleanText(text).length / desiredParts);
  for (let index = 0; index < text.length; index += chunkSize) {
    result.push(cleanText(text.slice(index, index + chunkSize)));
  }
  return result.filter(Boolean);
}

async function prewarmDubAudio(videoId, segments, options) {
  const backendUrl = String(options.backend || process.env.BACKEND_URL || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
  const limit = Math.min(
    segments.length,
    Math.max(1, Number(options.prewarmSegments || 16))
  );
  const selected = segments.slice(0, limit);
  const batchSize = Math.max(1, Math.min(20, Number(options.batchSize || 8)));
  let prepared = 0;

  for (let index = 0; index < selected.length; index += batchSize) {
    const batch = selected.slice(index, index + batchSize);
    const response = await fetch(`${backendUrl}/api/dub/prepare`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        videoId,
        source: 'local-whisper-stt',
        currentTime: batch[0]?.start || 0,
        settings: {
          voice: options.voice || process.env.SUPERTONE_DEFAULT_VOICE_ID || '763d5f200a9f5808056733',
          tone: options.tone || 'neutral',
          targetLang: options.targetLang || 'ko',
          ttsModel: options.ttsModel || process.env.SUPERTONE_MODEL || 'sona_speech_2_flash',
          pitchShift: Number(options.pitch ?? 0),
          pitchVariance: Number(options.variance ?? 1.5),
          speed: Number(options.speed ?? 1.29)
        },
        segments: batch
      })
    });
    const text = await response.text();
    const body = safeJsonParse(text);

    if (!response.ok) {
      fail(`Prewarm failed with HTTP ${response.status}: ${body?.error || text}`);
    }

    const returned = Array.isArray(body?.segments) ? body.segments : [];
    const playable = returned.filter((item) => item.audioUrl || item.audioDataUrl);
    if (playable.length !== batch.length) {
      fail(`Prewarm returned ${playable.length}/${batch.length} playable audio items.`);
    }
    prepared += playable.length;
  }

  console.log(JSON.stringify({
    ok: true,
    prewarm: true,
    backendUrl,
    prepared,
    requested: limit,
    audioDir: AUDIO_DIR
  }, null, 2));
}

function rejectGeneratedAudioInput(inputPath) {
  const relative = path.relative(AUDIO_DIR, inputPath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    fail(`Refusing to run STT on generated dub audio: ${inputPath}`);
  }
}

async function requireCommand(command, message) {
  const resolved = resolveExecutable(command);
  if (!resolved) {
    fail(message);
  }
  return resolved;
}

function commandExists(command) {
  return Boolean(resolveExecutable(command));
}

function resolveExecutable(command, probeArgs = ['--version']) {
  if (executableWorks(command, probeArgs)) {
    return command;
  }
  if (!/\.exe$/i.test(command) && executableWorks(`${command}.exe`, probeArgs)) {
    return `${command}.exe`;
  }
  return '';
}

function executableWorks(command, probeArgs) {
  const result = spawnSync(command, probeArgs, { stdio: 'ignore' });
  return result.status === 0 || result.status === 1;
}

async function resolveFfmpegLocation(options) {
  if (executableWorks('ffmpeg', ['-version'])) {
    return '';
  }

  const ffmpegExe = executableWorks('ffmpeg.exe', ['-version']) ? 'ffmpeg.exe' : '';
  if (ffmpegExe) {
    const ffmpegPath = whichCommand(ffmpegExe) || ffmpegExe;
    process.env.YLD_FFMPEG_SHIM_DIR = await ensureFfmpegShim(ffmpegPath);
    return ffmpegPath;
  }

  const configured = options.ffmpegLocation || process.env.FFMPEG_LOCATION || '';
  if (configured && await fileExists(configured)) {
    if (/\.exe$/i.test(configured)) {
      process.env.YLD_FFMPEG_SHIM_DIR = await ensureFfmpegShim(configured);
    }
    return configured;
  }

  fail('ffmpeg was not found. Pass --ffmpeg-location /path/to/ffmpeg or install ffmpeg in WSL.');
}

function whichCommand(command) {
  const result = spawnSync('which', [command], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : '';
}

async function ensureFfmpegShim(ffmpegLocation) {
  const binDir = path.join(CACHE_DIR, 'bin');
  const shimPath = path.join(binDir, 'ffmpeg');
  await mkdir(binDir, { recursive: true });
  await writeFile(shimPath, `#!/usr/bin/env sh\nexec ${JSON.stringify(ffmpegLocation)} "$@"\n`);
  await chmod(shimPath, 0o755);
  return binDir;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`$ ${[command, ...args].map(shellQuote).join(' ')}`);
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      windowsHide: true,
      stdio: 'inherit',
      env: buildChildEnv(options)
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

function buildChildEnv(options) {
  const env = { ...process.env };
  if (options.ffmpegLocation) {
    const ffmpegDir = path.dirname(options.ffmpegLocation);
    env.PATH = `${process.env.YLD_FFMPEG_SHIM_DIR || ''}:${ffmpegDir}:${env.PATH || ''}`;
  }
  return env;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      parsed.input = parsed.input || token;
      continue;
    }

    const key = token.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
    if (key.startsWith('no')) {
      parsed[key] = true;
      continue;
    }

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

function extractVideoId(input) {
  const raw = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) {
    return raw;
  }

  try {
    const url = new URL(raw);
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
    }
    const id = url.searchParams.get('v');
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : '';
  } catch {
    return '';
  }
}

function normalizeYouTubeUrl(input, videoId) {
  if (/^https?:\/\//i.test(input)) {
    return input;
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function sha1File(filePath) {
  return createHash('sha1').update(await readFile(filePath)).digest('hex');
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function roundTime(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function getLastSegmentEnd(segments) {
  return roundTime((segments || []).reduce((max, segment) => {
    return Math.max(max, Number(segment?.end) || 0);
  }, 0));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function shellQuote(value) {
  const raw = String(value);
  return /^[A-Za-z0-9_./:=@+-]+$/.test(raw) ? raw : JSON.stringify(raw);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function bootstrapWindowsPythonScriptsPath() {
  const normalizedRoot = ROOT_DIR.replace(/\\/g, '/');
  const wslMatch = normalizedRoot.match(/^\/mnt\/([a-z])\/Users\/([^/]+)/i);
  const winMatch = normalizedRoot.match(/^([a-z]):\/Users\/([^/]+)/i);
  let candidates = [];

  if (wslMatch) {
    const drive = wslMatch[1].toLowerCase();
    const user = wslMatch[2];
    candidates = [
      `/mnt/${drive}/Users/${user}/AppData/Roaming/Python/Python312/Scripts`,
      `/mnt/${drive}/Users/${user}/AppData/Local/Programs/Python/Python312/Scripts`
    ];
  } else if (winMatch) {
    const drive = winMatch[1].toUpperCase();
    const user = winMatch[2];
    candidates = [
      `${drive}:\\Users\\${user}\\AppData\\Roaming\\Python\\Python312\\Scripts`,
      `${drive}:\\Users\\${user}\\AppData\\Local\\Programs\\Python\\Python312\\Scripts`
    ];
  }

  if (process.platform === 'win32') candidates.unshift(path.join(ROOT_DIR, '.venv-win', 'Scripts'));
  if (candidates.length) {
    process.env.PATH = `${candidates.join(path.delimiter)}${path.delimiter}${process.env.PATH || ''}`;
  }
}
