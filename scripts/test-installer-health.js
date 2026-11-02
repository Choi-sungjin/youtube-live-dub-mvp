import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('isolated backend exposes installer ownership without claiming unloaded models are ready', { timeout: 15000 }, async () => {
  const source = fileURLToPath(new URL('../', import.meta.url));
  const fixture = await mkdtemp(path.join(tmpdir(), 'dub-health-fixture-'));
  // Copy code only: no personal .env, model, cache or running-server files.
  await copyFile(path.join(source, 'package.json'), path.join(fixture, 'package.json'));
  for (const dir of ['backend', 'lib']) {
    await mkdir(path.join(fixture, dir));
    for (const entry of await readdir(path.join(source, dir), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        await copyFile(path.join(source, dir, entry.name), path.join(fixture, dir, entry.name));
      }
    }
  }
  await writeFile(path.join(fixture, 'backend/.env'), 'OPENAI_MODEL=template-model\nOPENAI_API_KEY=template-placeholder\n');
  await writeFile(path.join(fixture, 'backend/.env.local'), 'OPENAI_MODEL=local-override-model\n');
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const fixtureEnv = { ...process.env };
  delete fixtureEnv.OPENAI_MODEL;
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...fixtureEnv, PORT: String(port), HOST: '127.0.0.1', YLD_FAST_STT: '0',
      TRANSLATION_PROVIDER: 'mock', TTS_PROVIDER: 'mock-wav',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434', OLLAMA_MODEL: 'gemma4:e4b-it-q4_K_M',
      YLD_INSTALLATION_ID: 'owned-fixture-123', OPENAI_API_KEY: '', ZAI_API_KEY: '', SUPERTONE_API_KEY: '' }
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.resume();
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const health = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      const poll = async () => {
        if (child.exitCode !== null) return reject(new Error(`Fixture backend exited: ${errors}`));
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
          return resolve(await response.json());
        } catch (error) {
          if (Date.now() >= deadline) return reject(error);
          setTimeout(poll, 100);
        }
      };
      child.once('error', reject);
      poll();
    });
    assert.equal(health.installationId, 'owned-fixture-123');
    assert.equal(health.ok, true);
    assert.equal(health.localTranslation.ready, false);
    assert.equal(health.supertonic.ready, false);
    assert.equal(health.stt.ready, false);
    assert.equal(health.provider.translation, 'mock');
    assert.equal(health.provider.tts, 'mock-wav');
    assert.equal(health.provider.openaiModel, 'local-override-model');
    assert.equal(health.provider.openaiConfigured, false); // Explicit environment wins, even empty.
    for (const mode of ['gemma-gpt', 'gpt-local', 'gpt', '__proto__']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/dub/prepare`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({videoId:'fixture',segments:[{start:0,end:3,text:'Hello.'}],settings:{mode}})});
      assert.equal(response.status, mode === '__proto__' ? 400 : 503);
      assert.equal((await response.json()).segments, undefined);
    }
    await fetch(`http://127.0.0.1:${port}/api/server/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1000) });
    await closed;
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
  }
});
