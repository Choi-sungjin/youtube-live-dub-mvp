import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { wavDuration } from './windows-speech.js';

let runtime = null;

function startWorker() {
  if (runtime) return runtime;
  const localPython = fileURLToPath(new URL(process.platform === 'win32' ? '../.venv-win/Scripts/python.exe' : '../.venv/bin/python', import.meta.url));
  const python = process.env.SUPERTONIC_PYTHON || (existsSync(localPython) ? localPython : 'python');
  const child = spawn(python, ['-u', fileURLToPath(new URL('./supertonic-worker.py', import.meta.url))], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', OMP_NUM_THREADS: '4' },
  });
  let resolveReady, rejectReady;
  const record = { child, pending: new Map(), ready: false, loadMs: null, errorText: '',
    readyPromise: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }) };
  runtime = record;
  const fail = error => {
    clearTimeout(startupTimer);
    rejectReady(error);
    for (const request of record.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    record.pending.clear();
    if (runtime === record) runtime = null;
  };
  const startupTimer = setTimeout(() => { fail(new Error('Supertonic 3 model loading timed out.')); child.kill(); }, 60000);
  child.stderr.on('data', chunk => { record.errorText = (record.errorText + chunk.toString('utf8')).slice(-2000); });
  child.on('error', error => fail(new Error(`Cannot start Supertonic 3: ${error.message}`)));
  child.stdin.on('error', error => fail(error));
  child.on('close', code => fail(new Error(`Supertonic 3 worker stopped (${code}): ${record.errorText.slice(-500)}`)));
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if ('ready' in message) {
      clearTimeout(startupTimer);
      if (!message.ready) { fail(new Error(`Supertonic 3 unavailable: ${message.error}`)); child.kill(); return; }
      record.ready = true; record.loadMs = message.loadMs; resolveReady(record); return;
    }
    const request = record.pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); record.pending.delete(message.id);
    if (message.ok) request.resolve(message);
    else request.reject(new Error(`Supertonic 3 synthesis failed: ${message.error}`));
  });
  return record;
}

export async function warmSupertonic() { await startWorker().readyPromise; return supertonicStatus(); }
export function supertonicStatus() {
  return { model: 'supertonic-3', ready: Boolean(runtime?.ready), loadMs: runtime?.loadMs ?? null, queued: runtime?.pending.size || 0 };
}
export function closeSupertonic() { runtime?.child.stdin.end(); }

export async function synthesizeSupertonicSpeech({ text, settings, outputPath }) {
  const record = await startWorker().readyPromise;
  if (record.pending.size >= 80) throw new Error('Supertonic 3 speech queue is full.');
  const id = randomUUID();
  const voice = /^[MF][1-5]$/.test(settings.voice) ? settings.voice : 'M1';
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      record.pending.delete(id);
      reject(new Error('Supertonic 3 synthesis timed out.'));
    }, 60000);
    record.pending.set(id, { resolve, reject, timer });
    record.child.stdin.write(`${JSON.stringify({ id, text, voice, language: settings.targetLang,
      speed: 1.15, outputPath })}\n`);
  });
  const duration = wavDuration(await readFile(outputPath));
  return { duration, ttsModel: 'supertonic-3', voiceId: voice, speechSpeed: 1.15, synthesisMs: result.synthesisMs };
}
