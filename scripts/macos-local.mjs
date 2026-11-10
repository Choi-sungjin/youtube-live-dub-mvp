import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, openSync, closeSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, 'backend/.cache');
const origin = 'http://127.0.0.1:18789';
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const defaults = {
  TRANSLATION_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'gemma4:e4b-it-q4_K_M',
  TTS_PROVIDER: 'supertonic3', YLD_STT_MODEL: 'small',
  YLD_STT_DEVICE: 'cpu', YLD_STT_COMPUTE: 'int8', HOST: '127.0.0.1', PORT: '18789'
};

export function addMissingSettings(text, settings) {
  const keys = new Set([...text.matchAll(/^\s*([A-Z_][A-Z_0-9]*)\s*=/gm)].map(match => match[1]));
  const additions = Object.entries(settings).filter(([key]) => !keys.has(key));
  if (!additions.length) return text;
  return text + (text && !text.endsWith('\n') ? '\n' : '') + additions.map(([key, value]) => `${key}=${value}\n`).join('');
}

function configure() {
  const filename = path.join(root, 'backend/.env');
  const current = existsSync(filename) ? readFileSync(filename, 'utf8') : '';
  const next = addMissingSettings(current, { ...defaults, YLD_INSTALLATION_ID: randomUUID() });
  if (current !== next) writeFileSync(filename, next, { mode: 0o600 });
  // Match server precedence without evaluating shell code or printing credentials.
  for (const file of ['.env.local', 'backend/.env.local', 'backend/.env']) {
    if (!existsSync(path.join(root, file))) continue;
    for (const line of readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  if (process.env.HOST !== '127.0.0.1' || process.env.PORT !== '18789') {
    throw new Error('Mac launcher requires HOST=127.0.0.1 and PORT=18789. Use node backend/server.js for a custom address.');
  }
  process.env.PATH = `${path.join(root, '.venv/bin')}:${process.env.PATH}`;
}

async function health(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

function background(command, args, name) {
  mkdirSync(cache, { recursive: true });
  const log = openSync(path.join(cache, `${name}.log`), 'a', 0o600);
  const child = spawn(command, args, { cwd: root, env: process.env, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.unref();
  return child;
}

async function ensureOllama() {
  const base = process.env.OLLAMA_BASE_URL.replace(/\/$/, '');
  if (await health(`${base}/api/tags`)) return;
  if (base !== 'http://127.0.0.1:11434') throw new Error('Configured Ollama is unavailable. Start it before continuing.');
  background('ollama', ['serve'], 'ollama');
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (await health(`${base}/api/tags`)) return;
  }
  throw new Error('Ollama did not start. See backend/.cache/ollama.log.');
}

function ownBackend(value) {
  return value?.ok && value.installationId === process.env.YLD_INSTALLATION_ID;
}

async function main(action) {
  if (process.platform !== 'darwin') throw new Error('Use the Windows or Linux installation guide on this system.');
  configure();
  if (action === 'configure') return console.log('Local settings ready; existing values and API keys preserved.');
  if (action === 'ollama') return ensureOllama();
  if (action === 'model') return console.log(process.env.OLLAMA_MODEL);
  if (action === 'install-model') {
    await ensureOllama();
    const tags = await health(`${process.env.OLLAMA_BASE_URL.replace(/\/$/, '')}/api/tags`);
    if (tags?.models?.some(model => model.name === process.env.OLLAMA_MODEL || model.model === process.env.OLLAMA_MODEL)) {
      return console.log(`Using installed Ollama model: ${process.env.OLLAMA_MODEL}`);
    }
    const child = spawn('ollama', ['pull', process.env.OLLAMA_MODEL], {
      stdio: 'inherit', env: { ...process.env, OLLAMA_HOST: process.env.OLLAMA_BASE_URL }
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Ollama model download failed (${code}).`)));
    });
    return;
  }
  const existing = await health(`${origin}/api/health`);
  if (action === 'stop') {
    if (!existing) return console.log('Backend is not running.');
    if (!ownBackend(existing)) throw new Error('Port 18789 belongs to another installation; it was not stopped.');
    const response = await fetch(`${origin}/api/server/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Backend rejected shutdown.');
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (!await health(`${origin}/api/health`)) return console.log('Backend stopped. Ollama remains available for other apps.');
    }
    throw new Error('Backend has not stopped yet.');
  }
  if (action !== 'start') throw new Error('Expected configure, ollama, model, install-model, start, or stop.');
  if (existing) {
    if (!ownBackend(existing) || existing.version !== version) throw new Error('Another/older backend is running on port 18789. Stop that installation first.');
    return console.log(`Live Dub v${version} is already running: ${origin}/diagnostics`);
  }
  if (!existsSync(path.join(root, '.venv/bin/python'))) throw new Error('Run install-macos.command first.');
  await ensureOllama();
  const child = background(process.execPath, ['backend/server.js'], 'local');
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await health(`${origin}/api/health`);
    if (ownBackend(result) && result.version === version) {
      writeFileSync(path.join(cache, 'backend.pid'), String(child.pid));
      return console.log(`Live Dub v${version} started: ${origin}/diagnostics\nModels may take a moment to warm up.`);
    }
  }
  throw new Error('Backend did not become healthy. See backend/.cache/local.log.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
