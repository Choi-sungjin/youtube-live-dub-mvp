import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDiskTextCache } from '../backend/disk-text-cache.js';
import { transcribeWithFallback } from '../lib/stt-fallback.js';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

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
  const context = vm.createContext({ window: {}, console: { error() {}, warn() {} }, URL, AbortController, AbortSignal, fetch: overrides.fetch, setTimeout, clearTimeout, setInterval, clearInterval, overrides, video });
  const injection = `
    globalThis.fixture = { state, els, startDub, stopDub, prepareAndAppendChunks, maybePrepareMoreAudio, getBufferInfo, syncAudioToVideo, collectCaptionSegments, collectCaptionTracksWithBudget, maybeExpandTranscriptCoverage, maybeInstallExpandedSegments };
    state.videoId = 'abcdefghijk'; state.video = video;
    for (const key of ['start','stop','test','volume','volumeLabel','backend','voice','lang','model','ttsProvider','pitch','variance','speed']) els[key] = {value:'1',disabled:false};
    els.volume.value='35'; els.ttsProvider.value='windows-sapi';
    refreshPageState=()=>{}; setStatus=value=>{state.status=value}; updateMeta=()=>{};
    ensureBackendReady=overrides.health || (async()=>({ok:true}));
    collectCaptionSegments=overrides.captions || (async()=>[{start:0,end:10,text:'A sentence'}]);
    applyOriginalVolume=()=>{state.video.volume=0.35};
    alignVideoToAvailableCaptions=()=>{}; maybeExpandTranscriptCoverage=()=>{};
    if (overrides.expand) { expandTranscriptCoverage=overrides.expand; cleanCaptionText=text=>String(text).trim(); }
    maybePrepareMoreAudio=()=>{};
    requestDubPrepare=overrides.prepare || (async()=>({segments:[]}));
    bufferPreparedAudio=async()=>{};
    buildCaptionUrls=url=>[{url,format:'json3'}]; buildYouTubeClientHeaders=()=>({});
    if (overrides.backendCaptions) fetchBackendCaptionSegments=overrides.backendCaptions;
    if (overrides.chunks) chunkSegments=()=>overrides.chunks;
    return;
  `;
  vm.runInContext(source.replace('  init();', injection).replace('const CAPTION_FETCH_BUDGET_MS = 3500;', 'const CAPTION_FETCH_BUDGET_MS = 30;'), context);
  return { ...context.fixture, video };
}

test('Stop during caption collection does not start audio preparation', async () => {
  const captions = deferred(); let requests = 0;
  const f = await contentFixture({ captions: () => captions.promise, prepare: async () => { requests++; return {}; } });
  const run = f.startDub(); await new Promise(r => setTimeout(r, 0)); f.stopDub();
  captions.resolve([{ start: 0, end: 4, text: 'Late caption' }]); await run;
  assert.equal(requests, 0); assert.equal(f.state.running, false); assert.equal(f.state.status, 'stopped'); assert.equal(f.video.volume, 0.8);
});

function stalledCaptionFetch(counter) {
  return (_url, { signal }) => new Promise((_resolve, reject) => {
    counter.requests++;
    signal.addEventListener('abort', () => { counter.aborted++; reject(new Error('aborted')); }, { once: true });
  });
}

test('caption collection leaves stalled requests when its shared budget expires', async () => {
  const counter = { requests: 0, aborted: 0 };
  const f = await contentFixture({ fetch: stalledCaptionFetch(counter) });
  f.state.running = true; f.state.sessionId = 1;
  const result = await f.collectCaptionTracksWithBudget([{baseUrl:'https://example.invalid/caption',languageCode:'en'}], 'abcdefghijk', 1);
  assert.equal(result.length, 0); assert.equal(counter.requests, 1); assert.equal(counter.aborted, 1);
  assert.equal(f.state.captionAbortController, null);
});

test('Stop aborts a live caption request and does not try another track', async () => {
  const counter = { requests: 0, aborted: 0 };
  const f = await contentFixture({ fetch: stalledCaptionFetch(counter) });
  f.state.running = true; f.state.sessionId = 1;
  const pending = f.collectCaptionTracksWithBudget([{baseUrl:'https://example.invalid/one'},{baseUrl:'https://example.invalid/two'}], 'abcdefghijk', 1);
  f.stopDub(); await pending;
  assert.equal(counter.aborted, 1); assert.equal(counter.requests, 1); assert.equal(f.state.running, false);
});

test('usable cached captions bypass slow remote caption lookup', async () => {
  let cacheOnly = false;
  const f = await contentFixture({ backendCaptions: async (_id, options) => {
    cacheOnly = options.cacheOnly;
    return [{start:0,end:12,text:'Cached original speech'}];
  } });
  f.state.running = true;
  const result = await f.collectCaptionSegments('abcdefghijk');
  assert.equal(cacheOnly, true); assert.equal(result[0].text, 'Cached original speech');
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

test('first preparation requests a bounded four-clip buffer', async () => {
  let count = 0;
  const chunks = Array.from({ length: 20 }, (_, index) => ({ index, start: index * 5, end: index * 5 + 5, text: 'caption' }));
  const f = await contentFixture({ chunks, prepare: async payload => { count = payload.segments.length; return {segments:[]}; } });
  await f.startDub(); assert.equal(count, 4);
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

test('Supertonic files keep their baked-in 1.15x speed without adaptive stretching', async () => {
  const f = await contentFixture();
  const audio = { duration: 4, currentTime: 0, paused: true, playbackRate: 1, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } };
  f.state.running = true;
  f.state.chunks = [{index:0,start:10,end:18}];
  f.state.prepared = [{chunkIndex:0,start:10,end:18,ttsModel:'supertonic-3',speechSpeed:1.15,audio}];
  f.video.currentTime = 11; f.syncAudioToVideo();
  assert.equal(audio.playbackRate, 1); assert.equal(audio.currentTime, 1); assert.equal(audio.paused, false);
  f.video.currentTime = 15; f.syncAudioToVideo();
  assert.equal(audio.paused, true); assert.equal(f.state.currentAudio, null);
  f.video.currentTime = 11.5; f.syncAudioToVideo();
  assert.equal(audio.currentTime, 1.5); assert.equal(audio.paused, false);
});

test('a short completed voice is not repeatedly replayed at the end of its caption', async () => {
  const f = await contentFixture(); let plays = 0;
  const audio = { duration: 2, currentTime: 0, paused: true, playbackRate: 1, pause() { this.paused = true; }, play() { plays++; this.paused = false; return Promise.resolve(); } };
  f.state.running = true; f.state.chunks = [{index:0,start:0,end:10}];
  f.state.prepared = [{chunkIndex:0,start:0,end:10,audio}];
  f.video.currentTime = 0.2; f.syncAudioToVideo(); assert.equal(plays, 1);
  f.video.currentTime = 4; f.syncAudioToVideo();
  f.video.currentTime = 5; f.syncAudioToVideo();
  assert.equal(plays, 1); assert.equal(audio.paused, true);
});

test('seeking behind a distant prepared block requests the missing current audio first', async () => {
  const requests = [];
  const f = await contentFixture({ prepare: async payload => {
    requests.push(payload.segments.map(chunk => chunk.index));
    return { segments: payload.segments.map(chunk => ({ ...chunk, audioUrl: 'fixture.wav' })) };
  } });
  f.state.running = true; f.video.currentTime = 42;
  f.state.chunks = Array.from({ length: 30 }, (_, index) => ({ index, start: index * 10, end: index * 10 + 10, text: 'caption' }));
  f.state.prepared = f.state.chunks.slice(9, 23).map(chunk => ({ ...chunk, chunkIndex: chunk.index }));
  f.state.preparedChunkIndexes = new Set(f.state.prepared.map(chunk => chunk.chunkIndex));
  assert.equal(f.getBufferInfo(42).readyAhead, 0);
  assert.equal(f.getBufferInfo(42).readyClipsAhead, 0);
  f.maybePrepareMoreAudio(42, 'seek');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(Array.from(requests[0]), [4, 5]);
  assert.equal(f.getBufferInfo(42).preparedEnd, 60);
  f.stopDub();
});

test('rolling buffer fills missing captions while allowing natural silent gaps', async () => {
  const requests = [];
  const f = await contentFixture({ prepare: async payload => { requests.push(payload.segments.map(chunk => chunk.index)); return { segments: [] }; } });
  f.state.running = true; f.video.currentTime = 2;
  f.state.chunks = Array.from({ length: 30 }, (_, index) => ({ index, start: index * 10, end: index * 10 + 5, text: 'caption' }));
  f.state.prepared = f.state.chunks.filter(chunk => chunk.index !== 2).map(chunk => ({ ...chunk, chunkIndex: chunk.index }));
  f.state.preparedChunkIndexes = new Set(f.state.prepared.map(chunk => chunk.chunkIndex));
  assert.equal(f.getBufferInfo(2).preparedEnd, 15);
  f.maybePrepareMoreAudio(2, 'timer');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(Array.from(requests[0]), [2]);
  f.stopDub();
});

test('translation cache survives recreation and treats corrupt or null records as misses', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yld-translation-test-'));
  const key = '0123456789abcdef0123';
  await createDiskTextCache(directory).set(key, '실제 번역 캐시');
  assert.equal(await createDiskTextCache(directory).get(key), '실제 번역 캐시');
  for (const text of ['null', '{broken', '{"text":42}', '{"key":"other","text":"wrong"}']) {
    await writeFile(path.join(directory, `${key}.json`), text);
    assert.equal(await createDiskTextCache(directory).get(key), '');
  }
  const nonDirectory = path.join(directory, 'not-a-directory');
  await writeFile(nonDirectory, 'fixture');
  await createDiskTextCache(nonDirectory).set(key, 'still translated');
  assert.equal(await createDiskTextCache(nonDirectory).get(key), '');
});

test('missing fast STT dependency or model retains the existing Whisper path', async () => {
  for (const message of ["No module named 'faster_whisper'", 'Cannot find cached model in local_files_only mode']) {
    let legacyCalls = 0;
    const result = await transcribeWithFallback(async () => { throw new Error(message); }, async () => { legacyCalls++; return {segments:[{text:'Original speech'}]}; }, () => {});
    assert.equal(legacyCalls, 1); assert.equal(result.segments[0].text, 'Original speech');
  }
  await assert.rejects(transcribeWithFallback(async () => { throw new Error('model missing'); }, async () => { throw new Error('legacy unavailable'); }, () => {}), /legacy unavailable/);
});

function fakeSpeech(duration) {
  return {duration,currentTime:0,paused:true,ended:false,playbackRate:1,pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();}};
}

test('missing current audio holds the video and resumes after a playable buffer arrives', async () => {
  const f=await contentFixture(); f.state.running=true;
  f.state.chunks=[{index:0,start:0,end:8},{index:1,start:8,end:16}]; f.state.sourceSegments=f.state.chunks;
  f.video.currentTime=1; f.syncAudioToVideo();
  assert.equal(f.video.paused,true); assert.equal(f.state.playbackHold.reason,'buffer');
  f.video.currentTime=1; f.syncAudioToVideo(); assert.equal(f.video.paused,true);
  const audio=fakeSpeech(7);
  f.state.prepared=[{chunkIndex:0,start:0,end:8,audio,ttsModel:'supertonic-3'},{chunkIndex:1,start:8,end:16,audio:fakeSpeech(7)}];
  f.state.preparedChunkIndexes=new Set([0,1]);
  f.syncAudioToVideo(); assert.equal(f.video.paused,false); assert.equal(audio.paused,false); assert.equal(f.state.playbackHold,null);
  f.video.paused=true; f.syncAudioToVideo(); f.syncAudioToVideo(); assert.equal(f.video.paused,true);
  f.stopDub();
});

test('a Supertonic sentence finishes without extra speed or a cut at the next caption', async () => {
  const f=await contentFixture(); f.state.running=true;
  f.state.chunks=[{index:0,start:0,end:2},{index:1,start:2,end:5}]; f.state.sourceSegments=f.state.chunks;
  const first=fakeSpeech(3), second=fakeSpeech(2);
  f.state.prepared=[{chunkIndex:0,start:0,end:2,audio:first,ttsModel:'supertonic-3'},{chunkIndex:1,start:2,end:5,audio:second,ttsModel:'supertonic-3'}];
  f.state.preparedChunkIndexes=new Set([0,1]);
  f.video.currentTime=1; f.syncAudioToVideo(); first.currentTime=2.02; f.video.currentTime=2.02; f.syncAudioToVideo();
  assert.equal(f.video.paused,true); assert.equal(first.paused,false); assert.equal(first.playbackRate,1); assert.equal(f.state.playbackHold.reason,'tail');
  f.syncAudioToVideo(); assert.equal(first.paused,false);
  first.currentTime=3; first.ended=true; first.paused=true; f.syncAudioToVideo();
  assert.equal(f.video.paused,false); assert.equal(second.paused,false); assert.equal(second.playbackRate,1);
  f.stopDub();
});

test('Stop during automatic buffering prevents a later resume', async () => {
  const f=await contentFixture(); f.state.running=true;
  f.state.originalVideoVolume=0.8;
  f.state.chunks=[{index:0,start:0,end:10}]; f.state.sourceSegments=f.state.chunks;
  f.video.currentTime=1; f.syncAudioToVideo(); assert.equal(f.video.paused,true);
  f.stopDub(); f.video.paused=true; f.syncAudioToVideo();
  assert.equal(f.state.playbackHold,null); assert.equal(f.video.paused,true); assert.equal(f.video.volume,0.8);
});

test('inspected silence and a completed transcript cannot strand an automatic hold', async () => {
  for (const expanding of [false, true]) {
    const f=await contentFixture(); f.state.running=true;
    f.state.chunks=[{index:0,start:0,end:4}]; f.state.sourceSegments=f.state.chunks;
    f.state.transcriptWindows=[{start:0,end:30}]; f.state.transcriptExpanding=expanding;
    f.state.playbackHold={reason:'buffer',startedAt:Date.now()}; f.state.resumeVideoAfterPrepare=true;
    f.video.currentTime=20; f.video.paused=true; f.syncAudioToVideo();
    assert.equal(f.video.paused,false); assert.equal(f.state.playbackHold,null);
    f.stopDub();
  }
});

test('a stuck STT worker rejects its queue, terminates, and is recreated for recovery', async () => {
  const children=[];
  const fakeSpawn=()=>{
    const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.stdin=new PassThrough();
    child.kill=()=>{child.killed=true;child.stdout.end();child.emit('close',1);};
    const generation=children.length; children.push(child);
    child.stdin.on('data', buffer=>{
      if (generation===0) return;
      const request=JSON.parse(buffer.toString());
      setTimeout(()=>child.stdout.write(JSON.stringify({id:request.id,ok:true,segments:[{text:'recovered'}]})+'\n'),0);
    });
    setTimeout(()=>child.stdout.write('{"ready":true,"loadMs":1}\n'),0);
    return child;
  };
  const source=(await readFile('backend/fast-stt.js','utf8'))
    .replace(/^import .*;\r?\n/gm,'').replaceAll('export ','').replaceAll('import.meta.url',JSON.stringify('file:///fixture/backend/fast-stt.js')).replace('180000','30');
  const context=vm.createContext({spawn:fakeSpawn,existsSync:()=>false,fileURLToPath:()=>'/fixture/python',createInterface,randomUUID,URL,process:{platform:'linux',env:{}},setTimeout,clearTimeout});
  vm.runInContext(source+'\nglobalThis.fixture={transcribeFast,closeFastStt,fastSttStatus};',context);
  const {transcribeFast,closeFastStt,fastSttStatus}=context.fixture;
  const failures=await Promise.allSettled([transcribeFast({inputPath:'first.wav'}),transcribeFast({inputPath:'second.wav'})]);
  assert.ok(failures.every(result=>result.status==='rejected' && /timed out/.test(result.reason.message)));
  assert.equal(children[0].killed,true); assert.equal(fastSttStatus().queued,0);
  const recovered=await transcribeFast({inputPath:'third.wav'});
  assert.equal(children.length,2); assert.equal(recovered.segments[0].text,'recovered');
  closeFastStt(); assert.equal(fastSttStatus().ready,false); assert.equal(children[1].stdin.writableEnded,true);
});

test('seeking into a hole between inspected windows prepares that position before resuming', async () => {
  const requests=[];
  const pending=deferred();
  const f=await contentFixture({expand:request=>{requests.push(request);return pending.promise;}});
  f.state.running=true; f.video.currentTime=50; f.video.duration=300;
  f.state.transcriptWindows=[{start:0,end:35},{start:198,end:233}];
  f.state.sourceSegments=[{start:0,end:10,text:'first'},{start:198,end:220,text:'later'}];
  f.state.chunks=f.state.sourceSegments.map((item,index)=>({...item,index}));
  const later=fakeSpeech(15);
  f.state.prepared=[{chunkIndex:1,start:198,end:220,audio:later}]; f.state.preparedChunkIndexes=new Set([1]);
  assert.equal(f.getBufferInfo(50).readyAhead,0);
  f.maybeExpandTranscriptCoverage(50); f.syncAudioToVideo();
  assert.equal(requests[0].windowStart,48); assert.equal(requests[0].targetDuration,85);
  assert.equal(f.video.paused,true); assert.equal(f.state.playbackHold.reason,'buffer');
  f.maybeInstallExpandedSegments([{start:48,end:65,text:'new missing speech'}]);
  assert.equal(f.state.chunks.find(chunk=>chunk.start===198).index,1);
  assert.equal(f.state.prepared[0].audio,later);
  assert.ok(f.state.chunks.some(chunk=>chunk.start===48));
  f.stopDub(); pending.resolve(true);
});
