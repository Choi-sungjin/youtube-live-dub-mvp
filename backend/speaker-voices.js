import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const model = path.join(root, 'backend/.cache/speaker-model/model.onnx');
const execute = promisify(execFile);
const classifications = new Map();
let runtime;
let retryAfter = 0;
const unknown = reason => ({ label: 'unknown', reason });

export function speakerStatus() {
  return { installed: existsSync(model), ready: Boolean(runtime?.ready), engine: 'audeering-onnx-cpu', apiRequests: 0 };
}

export function selectSpeakerVoice(settings, classification) {
  if (!settings.autoSpeaker) return settings.voice;
  const voices = settings.ttsProvider === 'openai-realtime' ? {male:'cedar',female:'marin'}
    : settings.ttsProvider === 'supertonic3' ? {male:'M1',female:'F1'} : null;
  const label = classification?.label;
  return voices && (label === 'male' || label === 'female') ? voices[label] : settings.voice;
}

function start() {
  if (runtime) return runtime;
  const python = path.join(root, process.platform === 'win32' ? '.venv-win/Scripts/python.exe' : '.venv/bin/python');
  const child = spawn(python, ['-u', path.join(root, 'backend/speaker-worker.py')], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  let resolveReady, rejectReady;
  const record = { child, ready: false, pending: new Map(), readyPromise: new Promise((resolve,reject) => {resolveReady=resolve;rejectReady=reject;}) };
  runtime = record;
  record.fail = error => {
    clearTimeout(timer); rejectReady(error);
    for (const pending of record.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    record.pending.clear();
    if (runtime === record) { runtime = undefined; retryAfter = Date.now()+30000; }
    child.kill();
  };
  const timer = setTimeout(() => record.fail(new Error('Speaker loading timeout')), 30000);
  child.on('error', record.fail); child.stdin.on('error', record.fail);
  child.on('close', () => record.fail(new Error('Speaker worker closed')));
  child.stderr.on('data', () => {}); // Do not expose local paths or audio metadata.
  createInterface({input:child.stdout}).on('line', line => {
    let message; try {message=JSON.parse(line);} catch {return;}
    if ('ready' in message) {
      if (!message.ready) return record.fail(new Error('Speaker model unavailable'));
      clearTimeout(timer);record.ready=true;resolveReady(record);return;
    }
    const pending = record.pending.get(message.id);if(!pending)return;
    record.pending.delete(message.id);clearTimeout(pending.timer);
    if (message.ok) pending.resolve({label:message.label,confidence:message.confidence,reason:message.reason});
    else pending.reject(new Error('Speaker classification failed'));
  });
  return record;
}

export function closeSpeaker() {
  runtime?.fail(new Error('Speaker worker shutting down'));
}

export function createAudioSourceLoader({executeImpl=execute, exists=existsSync, mkdirImpl=mkdir, now=Date.now} = {}) {
  const sources = new Map(), failedUntil = new Map();
  let acquiring = 0;
  return async function load(videoId) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('Invalid source');
    const existing = path.join(root, 'backend/.cache/source', `${videoId}.wav`);
    if (exists(existing)) return existing;
    const dir = path.join(root, 'backend/.cache/speaker-source');
    const output = path.join(dir, `${videoId}.audio`);
    if (exists(output)) return output;
    if (sources.has(videoId)) return sources.get(videoId);
    if (acquiring >= 2 || (failedUntil.get(videoId) || 0) > now()) throw new Error('Source temporarily unavailable');
    acquiring++;
    const promise = (async () => {
      await mkdirImpl(dir,{recursive:true});
      const executable = path.join(root, process.platform === 'win32' ? '.venv-win/Scripts/yt-dlp.exe' : '.venv/bin/yt-dlp');
      // Keep the original compressed container. No unbounded WAV expansion or ffmpeg child download.
      await executeImpl(executable, ['--no-playlist','--no-progress','--max-filesize','100M','--js-runtimes',`node:${process.execPath}`,
        '-f','ba/bestaudio','-o',output,`https://www.youtube.com/watch?v=${videoId}`],
        {timeout:60000,maxBuffer:1024*1024,windowsHide:true});
      if (!exists(output)) throw new Error('Source unavailable');
      return output;
    })();
    sources.set(videoId,promise);
    try {return await promise;} catch(error) {
      failedUntil.set(videoId,now()+300000);
      if(failedUntil.size>1000)failedUntil.delete(failedUntil.keys().next().value);
      throw error;
    } finally {sources.delete(videoId);acquiring--;}
  };
}
const audioSource = createAudioSourceLoader();

// Only validated YouTube ids can reach the download/path layer; never accept a client path.
export async function classifySpeaker({videoId,start,end}, dependencies = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return unknown('invalid-source');
  if (!existsSync(model) && !dependencies.analyze) return unknown('model-unavailable');
  if (Date.now() < retryAfter && !dependencies.analyze) return unknown('worker-unavailable');
  try {
    const inputPath = await (dependencies.source || audioSource)(videoId);
    const file = await (dependencies.stat || stat)(inputPath);
    const key = `${videoId}:${file.size}:${file.mtimeMs}:${start}:${end}`;
    if (classifications.has(key)) return await classifications.get(key);
    const promise = (async () => {
      const duration = Math.min(12,end-start);
      if (dependencies.analyze) return dependencies.analyze({inputPath,start,duration});
      const record = await startWorker();
      if(record.pending.size >= 6) return unknown('queue-full');
      const id=randomUUID();
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>record.fail(new Error('Speaker analysis timeout')),60000);
        record.pending.set(id,{resolve,reject,timer});
        record.child.stdin.write(JSON.stringify({id,inputPath,start,duration})+'\n');
      });
    })();
    classifications.set(key,promise);
    if(classifications.size > 1000) classifications.delete(classifications.keys().next().value);
    try {return await promise;} catch(error) {classifications.delete(key);throw error;}
  } catch {return unknown('audio-unavailable');}
}

async function startWorker() {return start().readyPromise;}
