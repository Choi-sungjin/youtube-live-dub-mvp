import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('native host answers a fragmented frame while stdin remains open', async () => {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['native-host/yld-native-host.cjs'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const body = Buffer.from(JSON.stringify({ action: 'status', port: server.address().port }));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    const packet = Buffer.concat([header, body]);
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Host waited for EOF.')), 4000);
      let data = Buffer.alloc(0);
      child.stdout.on('data', chunk => {
        data = Buffer.concat([data, chunk]);
        if (data.length >= 4 && data.length >= 4 + data.readUInt32LE(0)) { clearTimeout(timer); resolve(JSON.parse(data.subarray(4, 4 + data.readUInt32LE(0)))); }
      });
      child.on('error', error => { clearTimeout(timer); reject(error); });
    });
    child.stdin.write(packet.subarray(0, 2));
    await new Promise(resolve => setTimeout(resolve, 25));
    child.stdin.write(packet.subarray(2, 7));
    child.stdin.write(packet.subarray(7));
    const result = await reply;
    assert.equal(result.running, true);
    assert.equal(result.health.ok, true);
  } finally {
    child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('real-provider failures never become fake Korean speech', async () => {
  const savedFetch = globalThis.fetch;
  const env = { ...process.env };
  try {
    process.env.TRANSLATION_PROVIDER = 'zai';
    process.env.ZAI_API_KEY = 'test-only-never-sent';
    const { prepareDub } = await import('../lib/dub-core.js');
    const input = text => ({ videoId: 'regression', segments: [{ index: 0, start: 0, end: 4, text }], settings: { ttsProvider: 'mock-wav', targetLang: 'ko' } });
    globalThis.fetch = async () => new Response('{"error":"unavailable"}', { status: 503 });
    await assert.rejects(prepareDub(input('Provider failure probe')), /Z.ai.*failed/);
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"translations":[]}' } }] }));
    await assert.rejects(prepareDub(input('Missing translation probe')), /omitted segment/);
    delete process.env.ZAI_API_KEY;
    await assert.rejects(prepareDub(input('Missing key probe')), /key is not configured/);
    process.env.TRANSLATION_PROVIDER = 'mock';
    delete process.env.SUPERTONE_API_KEY;
    await assert.rejects(prepareDub({ ...input('Missing speech key'), settings: { ttsProvider: 'supertone' } }), /Supertone API key/);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
});

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function contentFixture(overrides = {}) {
  const source = await readFile('extension/content.js', 'utf8');
  const video = { currentTime: 0, volume: 0.8, muted: false, paused: false, ended: false, playbackRate: 1, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  const context = vm.createContext({ window: {}, console: { error() {}, warn() {} }, URL, setTimeout, clearTimeout, setInterval, clearInterval, overrides, video });
  const injection = `
    globalThis.fixture = { state, els, startDub, stopDub, prepareAndAppendChunks, syncAudioToVideo };
    state.videoId = 'abcdefghijk'; state.video = video;
    for (const key of ['start','stop','test','volume','volumeLabel','backend','voice','lang','model','ttsProvider','pitch','variance','speed']) els[key] = {value:'1',disabled:false};
    els.volume.value='35'; els.ttsProvider.value='windows-sapi';
    refreshPageState=()=>{}; setStatus=value=>{state.status=value}; updateMeta=()=>{};
    ensureBackendReady=overrides.health || (async()=>({ok:true}));
    collectCaptionSegments=overrides.captions || (async()=>[{start:0,end:10,text:'A sentence'}]);
    applyOriginalVolume=()=>{state.video.volume=0.35};
    alignVideoToAvailableCaptions=()=>{}; maybeExpandTranscriptCoverage=()=>{};
    maybePrepareMoreAudio=()=>{};
    requestDubPrepare=overrides.prepare || (async()=>({segments:[]}));
    bufferPreparedAudio=async()=>{};
    if (overrides.chunks) chunkSegments=()=>overrides.chunks;
    return;
  `;
  vm.runInContext(source.replace('  init();', injection), context);
  return { ...context.fixture, video };
}

test('Stop during caption collection does not start audio preparation', async () => {
  const captions = deferred(); let requests = 0;
  const f = await contentFixture({ captions: () => captions.promise, prepare: async () => { requests++; return {}; } });
  const run = f.startDub(); await new Promise(r => setTimeout(r, 0)); f.stopDub();
  captions.resolve([{ start: 0, end: 4, text: 'Late caption' }]); await run;
  assert.equal(requests, 0); assert.equal(f.state.running, false); assert.equal(f.state.status, 'stopped'); assert.equal(f.video.volume, 0.8);
});

test('late audio from an old session cannot change the new session', async () => {
  const pending = deferred(); const f = await contentFixture({ prepare: () => pending.promise });
  f.state.running = true; f.state.sessionId = 1;
  const run = f.prepareAndAppendChunks([{ index: 0, start: 0, end: 4, text: 'Old video' }]);
  f.stopDub(); f.state.running = true; f.state.sessionId++; f.state.preparingChunks = true;
  pending.resolve({ segments: [{ index: 0, start: 0, end: 4, audioDataUrl: 'data:audio/wav;base64,AA==' }] });
  assert.equal(await run, 0); assert.equal(f.state.prepared.length, 0); assert.equal(f.state.preparingChunks, true);
});

test('startup failure restores volume, mute and prior video playback', async () => {
  const f = await contentFixture({ health: async () => { throw new Error('offline'); } });
  await f.startDub(); assert.equal(f.state.status, 'error'); assert.equal(f.state.running, false); assert.equal(f.video.volume, 0.8); assert.equal(f.video.muted, false); assert.equal(f.video.paused, false);
});

test('first preparation requests only two chunks', async () => {
  let count = 0;
  const chunks = Array.from({ length: 20 }, (_, index) => ({ index, start: index * 5, end: index * 5 + 5, text: 'caption' }));
  const f = await contentFixture({ chunks, prepare: async payload => { count = payload.segments.length; return {segments:[]}; } });
  await f.startDub(); assert.equal(count, 2);
});

test('audio follows video pause, seek and playback rate', async () => {
  const f = await contentFixture();
  const audio = { duration: 4, currentTime: 0, paused: true, playbackRate: 1, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  f.state.running = true;
  f.state.chunks = [{ index: 7, start: 10, end: 14 }];
  f.state.prepared = [{ chunkIndex: 7, start: 10, end: 14, duration: 4, audio }];
  f.video.currentTime = 11;
  f.syncAudioToVideo();
  assert.equal(audio.currentTime, 1); assert.equal(audio.paused, false);
  f.video.paused = true; f.syncAudioToVideo(); assert.equal(audio.paused, true);
  f.video.paused = false; f.video.currentTime = 12; f.video.playbackRate = 1.5;
  f.syncAudioToVideo(); assert.equal(audio.currentTime, 2); assert.equal(audio.playbackRate, 1.5); assert.equal(audio.paused, false);
  f.video.currentTime = 20; f.syncAudioToVideo(); assert.equal(audio.paused, true); assert.equal(f.state.currentAudio, null);
});
