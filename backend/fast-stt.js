import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

let runtime;
export function fastSttStatus() {
  return { engine: runtime?.engine || `faster-whisper-${process.env.YLD_STT_DEVICE || 'cpu'}-${process.env.YLD_STT_COMPUTE || 'int8'}`, model: runtime?.model || process.env.YLD_STT_MODEL || 'tiny', ready: Boolean(runtime?.ready), loadMs: runtime?.loadMs ?? null, queued: runtime?.pending.size || 0 };
}
export async function warmFastStt() { await start().readyPromise; return fastSttStatus(); }
export function closeFastStt() {
  const record = runtime;
  if (!record) return;
  record.fail(new Error('STT worker is shutting down'));
  record.child.stdin.end();
}

function start() {
  if (runtime) return runtime;
  const localPython = fileURLToPath(new URL(process.platform === 'win32' ? '../.venv-win/Scripts/python.exe' : '../.venv/bin/python', import.meta.url));
  const child = spawn(process.env.YLD_STT_PYTHON || (existsSync(localPython) ? localPython : 'python'),
    ['-u', fileURLToPath(new URL('./stt-worker.py', import.meta.url))],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  let resolveReady, rejectReady;
  const record = { child, ready: false, pending: new Map(), errors: '', readyPromise: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }) };
  runtime = record;
  const fail = error => {
    clearTimeout(timer); rejectReady(error);
    for (const request of record.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    record.pending.clear(); if (runtime === record) runtime = undefined;
  };
  const timer = setTimeout(() => { fail(new Error('STT model loading timed out')); child.kill(); }, 60000);
  record.fail = fail;
  child.stderr.on('data', chunk => { record.errors = (record.errors + chunk.toString('utf8')).slice(-2000); });
  child.on('error', fail); child.stdin.on('error', fail);
  child.on('close', code => fail(new Error(`STT worker stopped (${code}): ${record.errors.slice(-500)}`)));
  createInterface({ input: child.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if ('ready' in message) {
      clearTimeout(timer);
      if (!message.ready) { fail(new Error(message.error)); child.kill(); return; }
      record.ready = true; record.loadMs = message.loadMs; record.engine = message.engine; record.model = message.model; resolveReady(record); return;
    }
    const pending = record.pending.get(message.id); if (!pending) return;
    clearTimeout(pending.timer); record.pending.delete(message.id);
    if (message.ok) pending.resolve(message); else pending.reject(new Error(message.error));
  });
  return record;
}

export async function transcribeFast({ inputPath, model = 'tiny', language = 'auto', lowLatency = false }) {
  const record = await start().readyPromise;
  if (record.pending.size >= 4) throw new Error('STT queue is full');
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      record.fail(new Error('STT transcription timed out'));
      record.child.kill();
    }, 180000);
    record.pending.set(id, { resolve, reject, timer });
    record.child.stdin.write(`${JSON.stringify({ id, inputPath, model, language, lowLatency })}\n`);
  });
}
