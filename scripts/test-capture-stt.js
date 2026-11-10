import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCaptureHandler, validateCapture } from '../backend/capture-stt.js';
const audio = Buffer.alloc(200); audio.writeUInt32BE(0x1a45dfa3);
const body = { videoId: 'NL65Awuv8gU', start: 50, end: 75, audio: audio.toString('base64') };
const request = (data = body, headers = {}) => Object.assign(Readable.from([Buffer.from(JSON.stringify(data))]), {
  headers: { 'x-yld-capture': '1', 'content-type': 'application/json', ...headers }
});

test('captured audio is bounded and never accepts paths, URLs or invalid intervals', () => {
  assert.deepEqual(validateCapture(body), audio);
  for (const invalid of [{ videoId: '../private' }, { start: -1 }, { end: 80 }, { end: 49 },
    { start: NaN }, { audio: 'https://example.com' }, { audio: 'a'.repeat(1400001) }, { audio: Buffer.alloc(200).toString('base64') }]) {
    assert.throws(() => validateCapture({ ...body, ...invalid }));
  }
});

test('capture STT offsets real word times, preserves silent coverage and removes temporary audio', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'yld-capture-test-'));
  try {
    let seen = 0;
    const handler = createCaptureHandler({ cacheDir, transcribe: async ({ inputPath }) => {
      assert.deepEqual(await readFile(inputPath), audio); seen++;
      return { segments: seen === 1 ? [{ words: [{ start: 2, end: 4, word: ' Hello.' }] }] : [], inferenceMs: 10 };
    }});
    const result = await handler(request());
    assert.deepEqual(result.segments, [{ start: 52, end: 54, text: 'Hello.' }]);
    assert.deepEqual(result.windows, [{ start: 50, end: 75 }]);
    assert.deepEqual((await handler(request())).segments, []);
    assert.deepEqual(await readdir(cacheDir), []);
    for (const headers of [{ origin: 'https://evil.example' }, { 'x-yld-capture': '' }, { 'content-type': 'text/plain' }]) {
      await assert.rejects(handler(request(body, headers)), /Extension capture required/);
    }
    assert.equal(seen, 2);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('failed capture STT deletes input and releases admission limit', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'yld-capture-test-'));
  try {
    const handler = createCaptureHandler({ cacheDir, transcribe: async () => { throw new Error('worker failed'); }});
    for (let i = 0; i < 3; i++) await assert.rejects(handler(request()), /worker failed/);
    assert.deepEqual(await readdir(cacheDir), []);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

// Exercise the production recorder state machine without a real browser/microphone.
import vm from 'node:vm';
const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
function recorderFixture() {
  let tick, stopped = 0;
  const listeners = new Map();
  const video = { currentTime: 50, playbackRate: 1.5, muted: false, paused: true, isConnected: true,
    play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, closest() { return null; },
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); },
    captureStream() { return { getAudioTracks: () => [{}], getTracks: () => [{ stop() { stopped++; } }] }; }
  };
  class Recorder {
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['source audio']) }); this.onstop(); }
  }
  const state = { videoId: body.videoId };
  const ctx = vm.createContext({ state, MediaRecorder: Recorder, MediaStream: class {}, Blob,
    isInterruptedPlay:error=>error?.name==='AbortError',
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {}, setTimeout() { return 2; }, clearTimeout() {},
    getVideoId: () => body.videoId });
  const start = content.indexOf('  function recordOriginalAudio('), end = content.indexOf('  async function preprocessCaptionSegments(', start);
  vm.runInContext(content.slice(start, end), ctx);
  return { state, video, listeners, record: () => ctx.recordOriginalAudio(video, 25, () => {}), tick: () => tick(), stopped: () => stopped };
}

test('original element capture restores position, rate and mute; releases all tracks', async () => {
  const fixture = recorderFixture(); const pending = fixture.record();
  assert.equal(fixture.video.muted, true); assert.equal(fixture.video.playbackRate, 1);
  fixture.video.currentTime = 75; fixture.tick();
  const result = await pending;
  assert.equal(result.start, 50); assert.equal(result.end, 75);
  assert.equal(fixture.video.currentTime, 50); assert.equal(fixture.video.playbackRate, 1.5);
  assert.equal(fixture.video.muted, false); assert.equal(fixture.video.paused, true);
  assert.equal(fixture.stopped(), 1); assert.equal(fixture.state.sourceCapture, null);
});

test('Stop cancels capture immediately; seek cancellation preserves the new user position', async () => {
  for (const seek of [false, true]) {
    const fixture = recorderFixture(); const pending = fixture.record();
    fixture.video.currentTime = 65;
    if (seek) fixture.listeners.get('seeking')(); else fixture.state.sourceCapture.cancel();
    await assert.rejects(pending);
    assert.equal(fixture.video.currentTime, seek ? 65 : 50);
    assert.equal(fixture.video.muted, false); assert.equal(fixture.video.playbackRate, 1.5);
    assert.equal(fixture.stopped(), 1); assert.equal(fixture.state.sourceCapture, null);
  }
});

test('late STT after Stop cannot install captions or clear a newer capture session', async () => {
  let reply, sent;
  const requested = new Promise(resolve => { sent = resolve; });
  const state = { sessionId: 1, running: true, video: { currentTime: 50, duration: 170, closest() { return null; } } };
  let installed = 0;
  const ctx = vm.createContext({ state, Uint8Array, Blob, btoa,
    els: { backend: { value: 'http://127.0.0.1:18789' } },
    isActiveSession: id => state.running && state.sessionId === id,
    stopCurrentAudio() {}, setStatus() {}, updateMeta() {},
    recordOriginalAudio: async () => ({ start: 50, end: 75, blob: new Blob(['original']) }),
    sendRuntimeMessage: () => { sent(); return new Promise(resolve => { reply = resolve; }); },
    updateTranscriptWindows() { installed++; }, normalizePreprocessSegments: value => value
  });
  const start = content.indexOf('  async function captureCaptionWindow('), end = content.indexOf('  function recordOriginalAudio(', start);
  vm.runInContext(content.slice(start, end), ctx);
  const pending = ctx.captureCaptionWindow(body.videoId);
  await requested;
  state.sessionId = 2; state.captureProcessing = true;
  reply({ ok: true, payload: { segments: [{ start: 50, end: 52, text: 'stale' }] } });
  assert.equal((await pending).length, 0);
  assert.equal(installed, 0); assert.equal(state.captureProcessing, true);
});


test('capture pause waits without failure, resumes, and Stop also releases a paused recorder', async () => {
  for (const cancel of [false, true]) {
    const fixture = recorderFixture();
    const pending = fixture.record();
    fixture.video.currentTime = 60;
    fixture.video.pause(); fixture.listeners.get('pause')();
    fixture.tick();
    assert.ok(fixture.state.sourceCapture);
    assert.equal(fixture.video.currentTime, 60);
    assert.equal(fixture.stopped(), 0);
    if (cancel) {
      fixture.state.sourceCapture.cancel();
      await assert.rejects(pending, /취소/);
    } else {
      await fixture.video.play(); fixture.listeners.get('play')();
      fixture.video.currentTime = 75; fixture.tick();
      assert.equal((await pending).end, 75);
    }
    assert.equal(fixture.video.currentTime, 50);
    assert.equal(fixture.video.muted, false);
    assert.equal(fixture.stopped(), 1);
    assert.equal(fixture.listeners.size, 0);
  }
});

test('queued pause event after playback resumes does not interrupt capture', async () => {
  const fixture = recorderFixture(); const pending = fixture.record();
  fixture.listeners.get('pause')();
  fixture.video.currentTime = 75; fixture.tick();
  assert.equal((await pending).end, 75);
});

test('a pending recorder play interrupted by Pause waits for resume instead of failing STT startup', async () => {
  const fixture=recorderFixture(); let rejectPlay;
  fixture.video.play=()=>new Promise((_,reject)=>{rejectPlay=reject;});
  const pending=fixture.record();
  rejectPlay(Object.assign(Error('The play() request was interrupted by a call to pause().'),{name:'AbortError'}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(fixture.state.sourceCapture);
  fixture.video.paused=false;fixture.listeners.get('play')();fixture.video.currentTime=75;fixture.tick();
  assert.equal((await pending).end,75);
});

test('captured source is analyzed alongside STT before deletion and turns reach prepare evidence', async () => {
  const cacheDir=await mkdtemp(path.join(tmpdir(),'yld-speaker-test-'));
  try {
    let analyzing=false;
    const handler=createCaptureHandler({cacheDir,
      analyzeSpeakers:async({inputPath,duration})=>{
        analyzing=true;assert.equal(duration,4);assert.deepEqual(await readFile(inputPath),audio);
        return {turns:[{start:0,end:2,label:'male'},{start:2,end:4,label:'female'}]};
      },
      transcribe:async()=>{
        await new Promise(resolve=>setImmediate(resolve));assert.equal(analyzing,true);
        return {segments:[{words:[{start:0,end:1.5,word:' First.'},{start:2,end:3.5,word:' Second.'}]}]};
      }
    });
    const result=await handler(request({...body,end:54,autoSpeaker:true}));
    assert.deepEqual(result.segments.map(s=>s.speaker.label),['male','female']);
    assert.equal(result.segments[1].start,52);assert.ok(result.segments[1].speakerKey);
    assert.deepEqual(await readdir(cacheDir),[]);
  } finally {await rm(cacheDir,{recursive:true,force:true});}
});

test('buffered media is trimmed with local-only ffmpeg and low-latency STT before timestamps are offset', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'yld-buffer-test-'));
  try {
    let called = false;
    const handler = createCaptureHandler({cacheDir,
      executeImpl: async (command,args,options) => {
        assert.equal(command,'ffmpeg'); assert.ok(args.includes('file,pipe'));
        assert.ok(args.includes('-copyts'));
        assert.ok(args.includes('atrim=start=50:end=62,asetpts=PTS-STARTPTS'));
        assert.equal(options.timeout,15000);
        await (await import('node:fs/promises')).writeFile(args.at(-1),Buffer.alloc(12*16000*2));
      },
      transcribe: async input => {
        called = true; assert.equal(input.lowLatency,true); assert.match(input.inputPath,/window.wav$/);
        return {segments:[{start:1,end:3,text:'Real window.'}],inferenceMs:10};
      }
    });
    const result = await handler(request({...body,end:62,buffered:true}));
    assert.equal(called,true); assert.equal(result.segments[0].start,51);
    assert.deepEqual(result.windows,[{start:50,end:62}]);
    assert.deepEqual(await readdir(cacheDir),[]);
    const short = createCaptureHandler({cacheDir, executeImpl:async (_cmd,args)=>{
      await (await import('node:fs/promises')).writeFile(args.at(-1),Buffer.alloc(100));
    },transcribe:async()=>{throw new Error('must not transcribe truncated audio');}});
    await assert.rejects(short(request({...body,end:62,buffered:true})),/does not cover/);
    assert.deepEqual(await readdir(cacheDir),[]);
  } finally {await rm(cacheDir,{recursive:true,force:true});}
});
