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
import { createLocalTranslator } from '../backend/local-translation.js';
import { timedClauses } from '../lib/timed-transcript.js';
import { speechText, normalizeDubbingTranslation } from '../backend/speech-text.js';
import { normalizeTechnicalTranscript } from '../lib/transcript-terms.js';

test('AI glossary corrections are scoped and preserve the raw transcript', () => {
  const general=[{text:'Cloud Quotes and anti-gravity are unrelated.'}];
  assert.deepEqual(normalizeTechnicalTranscript(general),general);
  const raw='Gemini 4 and Cloud Opus 5.5, which is our guess today. Hicksfield and Cloud Quotes.';
  const result=normalizeTechnicalTranscript([{text:raw}])[0];
  assert.equal(result.rawText,raw);
  assert.equal(result.text,'Gemini 4 and Claude Opus 5.5, which is our guest today. Higgsfield and Claude Code.');
});

test('word-aligned captions preserve actual silence and sentence boundaries', () => {
  const words=[{start:0,end:1,word:' Hello.'},{start:1,end:2,word:' Welcome.'},{start:12,end:13,word:' Again.'}];
  const result=timedClauses([{start:0,end:13,text:'Hello. Welcome. Again.',words}]);
  assert.equal(result.length,2);assert.equal(result[0].end,2);assert.equal(result[1].start,12);
  assert.equal(result.map(s=>s.text).join(' '),'Hello. Welcome. Again.');
  const legacy=[{start:0,end:2,text:'Legacy caption'}];assert.deepEqual(timedClauses(legacy),legacy);
});

test('Korean speech normalizes technical names without altering display translations', () => {
  const text='Gemini 4와 Opus 5.5, GPT-6의 API로 Blender 3D를 만듭니다.';
  assert.equal(speechText(text,'ko'),'제미나이 사와 오퍼스 오점오, 지피티 육의 에이피아이로 블렌더 쓰리디를 만듭니다.');
  assert.equal(speechText(text,'en'),text);
  assert.equal(speechText('21.35달러, API로 UI 변경','ko'),'21점삼오달러, 에이피아이로 유아이 변경');
  assert.equal(speechText('Rapid example','ko'),'Rapid example');
});

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
  const runtime = { id: "fixture", ...(overrides.runtimeSend ? { sendMessage: overrides.runtimeSend } : {}) };
  const context = vm.createContext({ chrome: { runtime }, window: {}, console: { error() {}, warn() {} }, URL, AbortController, AbortSignal, fetch: overrides.fetch, setTimeout, clearTimeout, setInterval, clearInterval, overrides, video });
  const injection = `
    globalThis.fixture = { state, els, startDub, stopDub, prepareAndAppendChunks, maybePrepareMoreAudio, getBufferInfo, syncAudioToVideo, applyDubSpeed, normalizeDubSpeed, dubbingSettingsFromControls, collectCaptionSegments, collectCaptionTracksWithBudget, maybeExpandTranscriptCoverage, maybeInstallExpandedSegments, computePlaybackUiState, computeActionIconState, renderPlaybackStateUi, requestDubPrepare, handleVideoInteractionEvents, cancelPlaybackHoldToUserPause, resumeFromUserPause, pauseFromUserControl, setAutoContinue, toggleAutoContinue, handleVideoTransition, maybeRunAutoContinue };
    state.videoId = 'abcdefghijk'; state.lastKnownVideoId = 'abcdefghijk'; state.video = video;
    if (overrides.videoIdFn) getVideoId = overrides.videoIdFn;
    for (const key of ['start','stop','test','volume','volumeLabel','backend','voice','lang','model','ttsProvider','pitch','variance','speed']) els[key] = {value:'1',disabled:false};
    els.panel = {dataset:{mode:'local'}};
    els.volume.value='35'; els.ttsProvider.value='windows-sapi';
    refreshPageState=()=>{}; setStatus=value=>{state.status=value}; updateMeta=()=>{};
    ensureBackendReady=overrides.health || (async()=>({ok:true}));
    collectCaptionSegments=overrides.captions || (async()=>[{start:0,end:10,text:'A sentence'}]);
    applyOriginalVolume=()=>{state.video.volume=0.35};
    alignVideoToAvailableCaptions=()=>{}; maybeExpandTranscriptCoverage=()=>{};
    if (overrides.expand) { expandTranscriptCoverage=overrides.expand; cleanCaptionText=text=>String(text).trim(); }
    maybePrepareMoreAudio=()=>{};
    requestDubPrepare=overrides.prepare || (async()=>({segments:[]}));
    bufferPreparedAudio=async items=>{ if(overrides.audio) items.forEach(item=>{item.audio=overrides.audio}); };
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

test('first preparation requests one clip so later sentences cannot delay first playback', async () => {
  let count = 0;
  const chunks = Array.from({ length: 20 }, (_, index) => ({ index, start: index * 5, end: index * 5 + 5, text: 'caption' }));
  const f = await contentFixture({ chunks, prepare: async payload => { count = payload.segments.length; return {segments:[]}; } });
  await f.startDub(); assert.equal(count, 1);
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

test('early-started audio cannot replay its first syllable when it ends before the video offset', async () => {
  const f=await contentFixture();let plays=0;
  const audio={...fakeSpeech(2),play(){plays++;if(this.ended)this.currentTime=0;this.ended=false;this.paused=false;return Promise.resolve();}};
  f.state.running=true;f.state.chunks=[{index:0,start:10,end:15}];
  f.state.prepared=[{chunkIndex:0,start:10,end:15,ttsModel:'supertonic-3',audio}];
  f.video.currentTime=9.9;f.syncAudioToVideo();assert.equal(plays,1);
  audio.currentTime=2;audio.ended=true;audio.paused=true;
  f.state.lastSyncVideoTime=11.75;f.video.currentTime=11.85;f.syncAudioToVideo();
  f.video.currentTime=11.95;f.syncAudioToVideo();assert.equal(plays,1);
  f.video.currentTime=12.1;f.syncAudioToVideo();
  f.video.currentTime=10.3;f.syncAudioToVideo();assert.equal(plays,2);
});

test('pending audio play is deduplicated; Pause abort and late Stop rejection cannot become panel errors',async()=>{
  for(const action of ['pause','stop']) {
    const f=await contentFixture();let rejectPlay,calls=0;
    const audio={...fakeSpeech(4),play(){calls++;this.paused=false;return new Promise((_,reject)=>{rejectPlay=reject;});}};
    f.state.running=true;f.state.chunks=[{index:0,start:0,end:4}];
    f.state.prepared=[{chunkIndex:0,start:0,end:4,audio,ttsModel:'supertonic-3'}];
    f.video.currentTime=0.1;f.syncAudioToVideo();audio.paused=true;f.syncAudioToVideo();assert.equal(calls,1);
    if(action==='stop') f.stopDub(); else {f.video.paused=true;f.syncAudioToVideo();}
    rejectPlay(Object.assign(Error('play interrupted'),{name:'AbortError'}));
    await new Promise(resolve=>setImmediate(resolve));assert.equal(f.state.lastError,'');
  }
});

test('real media permission failure still appears instead of being swallowed as a pause',async()=>{
  for(const synchronous of [false,true]) {
  const f=await contentFixture();
  const audio={...fakeSpeech(4),play(){const error=Object.assign(Error('Permission denied'),{name:'NotAllowedError'});if(synchronous)throw error;return Promise.reject(error);}};
  f.state.running=true;f.state.chunks=[{index:0,start:0,end:4}];f.state.prepared=[{chunkIndex:0,start:0,end:4,audio}];
  f.video.currentTime=0.1;f.syncAudioToVideo();await new Promise(resolve=>setImmediate(resolve));
  assert.match(f.state.lastError,/Permission denied/);assert.equal(f.state.status,'error');
  }
});

test('the final spoken sentence can finish after video end, while Stop still cuts it immediately', async () => {
  const f=await contentFixture();const audio=fakeSpeech(4);audio.paused=false;audio.currentTime=2;
  f.state.running=true;f.state.currentAudio=audio;f.state.currentChunkIndex=0;
  f.state.chunks=[{index:0,start:8,end:10}];f.state.prepared=[{chunkIndex:0,start:8,end:10,audio,ttsModel:'supertonic-3'}];
  f.video.currentTime=10;f.video.duration=10;f.video.ended=true;f.video.paused=true;
  f.syncAudioToVideo();assert.equal(audio.paused,false);
  f.stopDub();assert.equal(audio.paused,true);
});

test('a malformed closing particle gets its source-supported verb restored', () => {
  assert.equal(normalizeDubbingTranslation('스테프였습니다. 다음 영상에서 요.','That was Steph. See you in the next one.','ko'),'스테프였습니다. 다음 영상에서 봐요.');
  assert.equal(normalizeDubbingTranslation('서울에서요.','In Seoul.','ko'),'서울에서요.');
  assert.equal(normalizeDubbingTranslation('제미나이 5 나올 때 요.','So see you guys when Gemini 5 is out.','ko'),'제미나이 5 나올 때 봐요.');
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
  assert.deepEqual(Array.from(requests[0]), [4]);
  assert.equal(f.getBufferInfo(42).preparedEnd, 50);
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

function localResponse(translations) {
  return new Response(JSON.stringify({message:{content:JSON.stringify({translations})},done_reason:'stop',load_duration:1e6}),{headers:{'content-type':'application/json'}});
}

test('local translator preloads once, keeps the model warm and uses only loopback', async () => {
  const requests=[];
  const translator=createLocalTranslator({fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);requests.push({url,options,body});
    return localResponse(JSON.parse(body.messages[1].content).segments.map(segment=>({index:segment.index,text:'준비'})));
  }});
  await Promise.all([translator.warm(),translator.warm()]);
  assert.equal(requests.length,1);assert.equal(translator.status().warming,false);
  await translator.translate([{index:5,start:0,end:3,text:'Hello.'}]);
  assert.equal(requests.length,2);
  assert.ok(requests.every(r=>new URL(r.url).hostname==='127.0.0.1'&&r.options.redirect==='error'&&r.body.think===false&&r.body.keep_alive==='30m'));
  assert.equal(requests[1].body.format.properties.translations.minItems,1);
  assert.deepEqual(requests[1].body.format.properties.translations.items.properties.index.enum,[5]);
  assert.throws(()=>createLocalTranslator({baseUrl:'https://example.com'}),/loopback/);
  assert.throws(()=>createLocalTranslator({model:'gemma-cloud'}),/cloud model/);
});

test('a shortening attempt cannot discard version numbers or truncate the original translation', async () => {
  let calls=0;
  const original='3.1 버전은 저장하기 전에 절대로 전원을 끄면 안 됩니다.';
  const translator=createLocalTranslator({fetchImpl:async()=>localResponse([{index:0,text:++calls===1?'준비':calls===2?original:'전원은 끄지 마세요.'}])});
  const metrics={};const result=await translator.translate([{index:0,start:0,end:2,text:'Do not switch off before saving version 3.1.'}],{targetLang:'ko'},metrics);
  assert.equal(result.get(0),original);assert.equal(metrics.lengthRepairSegments,1);assert.equal(metrics.overBudgetSegments,1);
});

test('missing version numbers are repaired or fail explicitly', async () => {
  for(const repaired of [true,false]){
    let calls=0;const translator=createLocalTranslator({fetchImpl:async()=>localResponse([{index:0,text:++calls===1?'준비':calls===2?'프로 버전입니다.':repaired?'3.1 프로입니다.':'프로예요.'}])});
    const request=translator.translate([{index:0,start:0,end:5,text:'This is Pro 3. 1.'}]);
    if(repaired)assert.equal((await request).get(0),'3.1 프로입니다.');else await assert.rejects(request,/lost a number/);
  }
});

test('product names must survive shortening even when version numbers are retained', async () => {
  for (const repaired of [true,false]) {
    let calls=0;
    const translator=createLocalTranslator({fetchImpl:async()=>localResponse([{index:0,text:++calls===1?'준비':calls===2?'4.1 말고 4.2를 쓰세요. 인터넷은 필요 없어요.':repaired?'블렌더 4.1 말고 4.2를 쓰세요. 인터넷은 필요 없어요.':'4.2를 쓰세요. 4.1은 쓰지 마세요.'}])});
    const result=translator.translate([{index:0,start:0,end:6,text:'Use Blender 4.2, not 4.1. This does not require an internet connection.'}]);
    if(repaired)assert.match((await result).get(0),/블렌더 4.1 말고 4.2/);else await assert.rejects(result,/lost a required name/);
  }
});

test('a live-caption numeric omission gets an isolated faithful retry before failing', async () => {
  const requests=[];
  const translator=createLocalTranslator({fetchImpl:async(url,options)=>{
    const payload=JSON.parse(JSON.parse(options.body).messages[1].content);requests.push(payload);
    return localResponse([{index:requests.length===1?0:56,text:requests.length===1?'준비':requests.length<4?'100달러예요. 200달러였어요.':'100달러예요. X20은 200달러였어요. 왜인지 모르겠지만 태국에서는요.'}]);
  }});
  const metrics={};
  const result=await translator.translate([{index:56,start:214.806,end:220.806,text:"100 bucks. X20 cost 200 bucks. I don't know for what reason, but for me, in Thailand, it cost"}],{},metrics);
  assert.match(result.get(56),/X20은 200/);assert.equal(metrics.factRepairSegments,1);
  assert.equal(requests.at(-1).segments.length,1);assert.equal(metrics.localRequests,3);
});

test('large-number conversion preserves quantity instead of literal coefficients', async () => {
  for(const [source,text] of [
    ['He used over 30 billion tokens.','300억 토큰 넘게 썼어요.'],
    ['He used 1.5 million tokens.','150만 토큰을 썼어요.'],
    ['He used 150 million tokens.','1.5억 토큰을 썼어요.'],
    ['He used 30 billion tokens.','30000000000 토큰을 썼어요.'],
    ['He used 30 billion.','300억을 썼어요.'],
  ]) {
    // Warm-up has a fixed index, unlike the original failing live segment.
    const real=createLocalTranslator({fetchImpl:async(_url,options)=>{
      const payload=JSON.parse(JSON.parse(options.body).messages[1].content);
      return localResponse(payload.segments.map(s=>({index:s.index,text:s.text==='Ready.'?'준비':text})));
    }});
    assert.equal((await real.translate([{index:75,start:262.298,end:271.378,text:source}])).get(75),text);
  }
});

test('wrong large-number scaling cannot pass by retaining the source digits', async () => {
  for(const text of ['30억 토큰을 썼어요.','30 토큰을 썼어요.','3억 토큰을 썼어요.']) {
    const translator=createLocalTranslator({fetchImpl:async(_url,options)=>{
      const payload=JSON.parse(JSON.parse(options.body).messages[1].content);
      return localResponse(payload.segments.map(s=>({index:s.index,text:s.text==='Ready.'?'준비':text})));
    }});
    await assert.rejects(translator.translate([{index:75,start:0,end:9,text:'He used 30 billion tokens.'}]),/lost a number/);
  }
});

test('non-Korean translation and repair prompts respect the requested language', async () => {
  const messages=[];
  const translator=createLocalTranslator({fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);messages.push(body.messages);
    return localResponse([{index:0,text:messages.length===1?'준비':messages.length===2?'Do not turn off the power before saving version 3.1.':'Save 3.1 before turning off.'}]);
  }});
  const result=await translator.translate([{index:0,start:0,end:2,text:'버전 3.1 저장 전에 전원을 끄지 마세요.'}],{targetLang:'en'});
  assert.equal(result.get(0),'Save 3.1 before turning off.');
  assert.equal(messages.length,3);
  for(const pair of messages.slice(1)){
    assert.equal(JSON.parse(pair[1].content).target_language,'en');
    assert.doesNotMatch(pair[0].content,/한국어|Korean/);
  }
});

test('local provider failures and malformed output do not invoke an external provider', async () => {
  const calls=[];const offline=createLocalTranslator({fetchImpl:async url=>{calls.push(url);throw new Error('connection refused');}});
  await assert.rejects(offline.translate([{index:0,start:0,end:3,text:'Hello'}]),/Local Gemma translation unavailable/);
  assert.equal(calls.length,1);assert.ok(calls.every(url=>url.startsWith('http://127.0.0.1:11434/')));
  for(const content of ['not json','{"translations":[]}','{"translations":[{"index":0,"text":"A"},{"index":0,"text":"B"}]}']){
    let count=0;const translator=createLocalTranslator({fetchImpl:async()=>++count===1?localResponse([{index:0,text:'준비'}]):new Response(JSON.stringify({message:{content}}))});
    await assert.rejects(translator.translate([{index:0,start:0,end:3,text:'Hello'}]),/invalid|omitted/);
  }
});

test('a stray unsupported script is retranslated before it can stop Supertonic', async () => {
  let calls=0;
  const translator=createLocalTranslator({fetchImpl:async()=>localResponse([{index:0,text:++calls===1?'준비':calls===2?'좋아요. ქ':'좋아요.'}])});
  const metrics={};
  assert.equal((await translator.translate([{index:0,start:0,end:4,text:'Okay.'}],{},metrics)).get(0),'좋아요.');
  assert.equal(metrics.lengthRepairSegments,1);assert.equal(calls,3);
});

test('neighboring versions and achieved outcomes cannot replace a short caption or expectation', async () => {
  for(const [source,bad,good] of [
    ['Okay. Here we go.','Opus 5.5가 블렌더 파일을 만들었어요.','자, 시작하죠.'],
    ['I thought all tests would be ready.','테스트가 모두 준비됐어요.','테스트가 준비될 줄 알았어요.'],
  ]){
    let count=0;
    const translator=createLocalTranslator({fetchImpl:async()=>localResponse([{index:0,text:++count===1?'준비':count===2?bad:good}])});
    assert.equal((await translator.translate([{index:0,start:0,end:5,text:source,contextAfter:'Opus 5.5 created a Blender file.'}])).get(0),good);
  }
});

test('an audience choice question stays a question instead of becoming a recommendation', async () => {
  let count=0;
  const translator=createLocalTranslator({fetchImpl:async()=>localResponse([{index:0,text:++count===1?'준비':count===2?'A 또는 B가 낫습니다.':'A와 B 중 뭐가 나을까요?'}])});
  const output=await translator.translate([{index:0,start:0,end:7,text:'It is better to use A or rely on B.',contextBefore:'Let me know in the comments what you think.'}]);
  assert.match(output.get(0),/\?$/);
});

test('serverless routes refuse local provider selection instead of reverting to Z.ai', async () => {
  const saved=process.env.TRANSLATION_PROVIDER;
  try{process.env.TRANSLATION_PROVIDER='ollama';const {prepareDub}=await import('../lib/dub-core.js');
    await assert.rejects(prepareDub({videoId:'local-route-fixture',segments:[{index:0,start:0,end:4,text:'No cloud fallback'}],settings:{ttsProvider:'mock-wav'}}),/requires the local backend/);
  }finally{if(saved===undefined)delete process.env.TRANSLATION_PROVIDER;else process.env.TRANSLATION_PROVIDER=saved;}
});

test('Start from a paused video resumes after first prepared clip; subsequent user pause stays paused', async () => {
  const ready = deferred();
  const f = await contentFixture({ chunks:[{index:0,start:0,end:4,text:'Hello'}], audio:fakeSpeech(2), prepare:()=>ready.promise });
  f.video.paused = true;
  const run = f.startDub();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.video.paused,true);
  ready.resolve({segments:[{index:0,start:0,end:4,audioDataUrl:'data:audio/wav;base64,AA=='}]});
  try {
    await run;
    assert.equal(f.state.status,'ready',f.state.lastError);
    assert.equal(f.video.paused,false,'Start must start video once dubbing is ready');
    f.video.paused=true;f.syncAudioToVideo();assert.equal(f.video.paused,true);
  } finally { f.stopDub({resumeVideo:false}); }
});

test('cancel or failure during startup preserves an originally paused video', async () => {
  const captions=deferred(); const f=await contentFixture({captions:()=>captions.promise});
  f.video.paused=true;const run=f.startDub();await new Promise(resolve=>setTimeout(resolve,0));
  f.stopDub();captions.resolve([{start:0,end:4,text:'Late'}]);await run;
  assert.equal(f.video.paused,true);assert.equal(f.state.running,false);
  const failed=await contentFixture({health:async()=>{throw new Error('offline')}});
  failed.video.paused=true;await failed.startDub();assert.equal(failed.video.paused,true);
});

test('user speed changes audio immediately without resetting its position or changing synthesis settings',async()=>{
 const f=await contentFixture();let plays=0;
 const audio={duration:10,currentTime:0,paused:true,playbackRate:1,pause(){this.paused=true;},play(){plays++;this.paused=false;return Promise.resolve();}};
 f.state.running=true;f.els.ttsProvider.value='supertonic3';
 f.state.chunks=[{index:0,start:10,end:20}];
 f.state.prepared=[{chunkIndex:0,start:10,end:20,ttsModel:'supertonic-3',audio}];
 f.video.currentTime=11;f.syncAudioToVideo();assert.equal(audio.currentTime,1);
 f.els.speed.value='1.5';f.applyDubSpeed();assert.equal(audio.playbackRate,1.5);assert.equal(audio.currentTime,1);
 f.video.currentTime=12;f.syncAudioToVideo();assert.equal(audio.currentTime,2.5);assert.equal(audio.playbackRate,1.5);
 assert.equal(f.dubbingSettingsFromControls().speed,1.15);
 f.els.speed.value='0.5';f.applyDubSpeed();assert.equal(audio.playbackRate,0.5);
 f.video.currentTime=13;f.syncAudioToVideo();assert.equal(audio.currentTime,3);assert.equal(plays,1);
 f.state.playbackHold={reason:'tail'};f.els.speed.value='2';f.applyDubSpeed();assert.equal(audio.playbackRate,2);
});
test('playback speed validates invalid values and leaves GPT synthesis speed fixed',async()=>{
 const f=await contentFixture();for(const x of ['',null,'not-a-number',Infinity])assert.equal(f.normalizeDubSpeed(x),1);
 assert.equal(f.normalizeDubSpeed(-4),0.5);assert.equal(f.normalizeDubSpeed(8),2);
 f.els.ttsProvider.value='openai-realtime';f.els.speed.value='1.8';assert.equal(f.dubbingSettingsFromControls().speed,1);
 const testAudio={playbackRate:1};f.state.testAudio=testAudio;f.applyDubSpeed();assert.equal(testAudio.playbackRate,1.8);
});

test('slowing a nearly finished clip never replays its tail when media clock trails prediction',async()=>{
 const f=await contentFixture();let plays=0;const seeks=[];let position=0;
 const audio={duration:10,paused:true,ended:false,playbackRate:1,get currentTime(){return position;},set currentTime(value){position=value;seeks.push(value);},pause(){this.paused=true;},play(){plays++;this.paused=false;return Promise.resolve();}};
 f.state.running=true;f.els.speed.value='2';f.state.chunks=[{index:0,start:10,end:30}];
 f.state.prepared=[{chunkIndex:0,start:10,end:30,ttsModel:'supertonic-3',audio}];
 f.video.currentTime=12;f.syncAudioToVideo();assert.equal(position,4);
 f.els.speed.value='0.5';f.applyDubSpeed();
 for(let i=1;i<=75;i++){
  f.video.currentTime=12+i*0.16;position=4+i*0.08-0.05;f.syncAudioToVideo();
 }
 assert.equal(f.state.currentChunkIndex,0);assert.equal(plays,1);assert.equal(position,9.95);
 f.video.currentTime=24.16;position=10;audio.ended=true;audio.paused=true;f.syncAudioToVideo();
 assert.equal(plays,1);assert.deepEqual(seeks,[4]);assert.equal(f.state.currentAudio,audio);
});

test('buffered source batches future voices while still prioritizing missing current audio', async () => {
  const requests=[];
  const f=await contentFixture({prepare:async payload=>{
    requests.push(payload.segments.map(chunk=>chunk.index));
    return {segments:payload.segments.map(chunk=>({...chunk,audioUrl:'fixture.wav'}))};
  }});
  f.state.running=true;f.state.bufferedAudioSource=true;f.state.bufferedRetryAt=Infinity;
  f.video.currentTime=42;
  f.state.chunks=Array.from({length:10},(_,index)=>({index,start:index*10,end:index*10+10,text:'caption'}));
  f.maybePrepareMoreAudio(42,'seek');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(Array.from(requests[0]),[4,5]);
  f.stopDub();
});

test('completed streamed audio is playable before its batch finishes and final response cannot duplicate it', async () => {
  const done=deferred();let progress;
  const audio={pause(){},currentTime:0};
  const first={index:0,start:0,end:4,text:'first',audioUrl:'first.wav'};
  const second={index:1,start:4,end:8,text:'second',audioUrl:'second.wav'};
  const f=await contentFixture({audio,prepare:async (_payload,onSegment)=>{progress=onSegment;return done.promise;}});
  f.state.running=true;f.state.bufferedAudioSource=true;f.state.chunks=[first,second];
  const pending=f.prepareAndAppendChunks([first,second]);
  await progress(first);
  assert.equal(f.state.preparingChunks,true);assert.deepEqual(Array.from(f.state.preparedChunkIndexes),[0]);
  assert.equal(f.state.prepared[0].audio,audio);
  done.resolve({segments:[first,second]});await pending;
  assert.deepEqual(Array.from(f.state.preparedChunkIndexes),[0,1]);assert.equal(f.state.prepared.length,2);
  f.stopDub();await progress(second);assert.equal(f.state.prepared.length,0);
});

test('local translator resolves an installed local Gemma 4 tag when configured model returns 404', async () => {
  const calls = [];
  const translator = createLocalTranslator({
    baseUrl: 'http://127.0.0.1:11435',
    model: 'gemma4:e4b-it-q4_K_M',
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/tags')) {
        return { ok: true, status: 200, json: async () => ({ models: [{ name: 'bge-m3:latest' }, { name: 'gemma4:e2b' }] }) };
      }
      const body = JSON.parse(init.body);
      calls.push(body.model);
      if (body.model === 'gemma4:e4b-it-q4_K_M') return { ok: false, status: 404, body: { cancel: async () => {} } };
      return { ok: true, status: 200, json: async () => ({ message: { content: '{"translations":[{"index":0,"text":"준비 완료."}]}' } }) };
    }
  });
  const status = await translator.warm();
  assert.equal(status.ready, true);
  assert.equal(status.model, 'gemma4:e2b');
  assert.deepEqual(calls, ['gemma4:e4b-it-q4_K_M', 'gemma4:e2b']);
});

test('dubbing sync keeps natural 1.0x-1.18x pace, uses silent gaps, and avoids mid-clip micro-seek crackles', async () => {
  const f = await contentFixture();
  const makeTrackedAudio = (duration) => {
    const seeks = [];
    let pos = 0;
    return {
      duration,
      paused: true,
      ended: false,
      playbackRate: 1,
      preservesPitch: false,
      seeks,
      advance(dt) { pos += dt; },
      get currentTime() { return pos; },
      set currentTime(value) { pos = value; seeks.push(value); },
      pause() { this.paused = true; },
      play() { this.paused = false; return Promise.resolve(); },
    };
  };
  const shortClip = makeTrackedAudio(3.2);
  const gapClip = makeTrackedAudio(3.5);
  const longClip = makeTrackedAudio(7.5);
  f.state.running = true;
  f.state.chunks = [
    { index: 0, start: 0, end: 5, text: 'short' },
    { index: 1, start: 10, end: 12, text: 'has pause after' },
    { index: 2, start: 14, end: 18, text: 'long translation' },
  ];
  f.state.prepared = [
    { chunkIndex: 0, start: 0, end: 5, ttsModel: 'gpt-realtime-2.1-mini', audio: shortClip },
    { chunkIndex: 1, start: 10, end: 12, ttsModel: 'gpt-realtime-2.1-mini', audio: gapClip },
    { chunkIndex: 2, start: 14, end: 18, ttsModel: 'gpt-realtime-2.1-mini', audio: longClip },
  ];

  // 1) Shorter translation never slows down to 0.85x; natural entry near start never chops onset or seeks.
  f.video.currentTime = 0.12;
  f.syncAudioToVideo();
  assert.equal(shortClip.playbackRate, 1);
  assert.equal(shortClip.preservesPitch, true);
  assert.deepEqual(shortClip.seeks, []);

  // Pipeline startup jitter of ~250ms while playing must NOT trigger mid-vowel seekAudio crackles.
  f.video.currentTime = 0.62;
  shortClip.advance(0.25); // 250ms behind predicted 0.50s -> |0.25 - 0.50| = 0.25s <= 0.45s tolerance
  f.syncAudioToVideo();
  assert.deepEqual(shortClip.seeks, []);

  // 2) Silent pause before next caption (12..14s) lets a 3.5s clip play at natural 1.0x instead of rushing.
  f.video.currentTime = 10.05;
  f.syncAudioToVideo();
  assert.equal(gapClip.playbackRate, 1);
  assert.deepEqual(gapClip.seeks, []);

  // 3) Very long translation caps catch-up speed at 1.18x instead of WSOLA-crushing at 1.75x.
  f.video.currentTime = 14.05;
  f.syncAudioToVideo();
  assert.equal(longClip.playbackRate, 1.18);
  assert.equal(longClip.preservesPitch, true);
  f.stopDub();
});

test('expanded STT windows trim cross-boundary overlap instead of colliding mid-sentence', async () => {
  const f = await contentFixture({ expand: async () => true });
  f.state.sourceSegments = [{ start: 164.4, end: 168.3, text: 'When scoring we use both models.' }];
  f.state.chunks = [{ index: 0, start: 164.4, end: 168.3, text: 'When scoring we use both models.', segments: f.state.sourceSegments }];
  const installed = f.maybeInstallExpandedSegments([
    { start: 164.4, end: 168.2, text: 'duplicate overlap fragment' },
    { start: 166.3, end: 169.5, text: 'to score the available options.' },
  ]);
  assert.equal(installed, true);
  assert.equal(f.state.sourceSegments.length, 2);
  assert.equal(f.state.sourceSegments[1].start, 168.3);
  assert.equal(f.state.sourceSegments[1].end, 169.5);
});

test('playback state UI distinguishes user pause, seek-while-paused, auto-resume countdown, and extra Play clicks', async () => {
  const f = await contentFixture();
  const firstAudio = fakeSpeech(4);
  f.state.running = true;
  f.state.chunks = [
    { index: 0, start: 0, end: 5, text: 'first' },
    { index: 1, start: 60, end: 65, text: 'after seek' },
  ];
  f.state.sourceSegments = f.state.chunks;
  f.state.prepared = [{ chunkIndex: 0, start: 0, end: 5, ttsModel: 'supertonic-3', audio: firstAudio }];
  f.state.preparedChunkIndexes = new Set([0]);

  // 1) Normal playback shows playing state; after 2.5s settles into compact pill.
  f.video.currentTime = 1;
  f.state.lastResumedAt = 1000;
  f.syncAudioToVideo();
  assert.equal(f.computePlaybackUiState(1500).tone, 'playing');
  assert.match(f.computePlaybackUiState(1500).title, /더빙 재생 시작됨/);
  assert.equal(f.computePlaybackUiState(5000).compact, true);
  assert.match(f.computePlaybackUiState(5000).title, /더빙 재생 중/);

  // 2) User pauses video -> immediately shows paused state with resume guidance.
  f.video.paused = true;
  f.handleVideoInteractionEvents('pause');
  let ui = f.computePlaybackUiState();
  assert.equal(ui.tone, 'paused');
  assert.match(ui.title, /일시정지됨/);
  assert.equal(ui.actionKind, 'resume');

  // 3) User seeks forward to 01:01 while paused -> stays paused and indicates background preparation.
  f.video.currentTime = 61;
  f.state.preparingChunks = true;
  f.handleVideoInteractionEvents('seeked');
  ui = f.computePlaybackUiState();
  assert.equal(f.video.paused, true);
  assert.equal(ui.tone, 'paused');
  assert.match(ui.detail, /1:01.*미리 준비 중/);

  // 4) User clicks Play ONCE before 1:01 finishes preparing -> immediately shows countdown & auto-play confirmation.
  f.video.paused = false;
  f.state.prepareBatchStartedAt = Date.now() - 600;
  f.handleVideoInteractionEvents('play');
  assert.equal(f.video.paused, true);
  assert.equal(f.state.playbackHold.reason, 'buffer');
  ui = f.computePlaybackUiState();
  assert.equal(ui.tone, 'preparing');
  assert.match(ui.title, /1:01.*약 \d+초 후 자동 재생/);
  assert.match(ui.detail, /재생 입력 확인됨/);

  // 5) Clicking Play a second time during buffer hold keeps auto-resume intact and reassures user.
  f.video.paused = false;
  f.handleVideoInteractionEvents('play');
  assert.equal(f.video.paused, true);
  assert.equal(f.state.resumeVideoAfterPrepare, true);
  assert.match(f.computePlaybackUiState().detail, /이미 자동 재생이 예약/);

  // 6) Explicit '일시정지 유지' cancels auto-resume cleanly so user stays paused even after audio arrives.
  f.cancelPlaybackHoldToUserPause();
  assert.equal(f.state.playbackHold, null);
  assert.equal(f.state.resumeVideoAfterPrepare, false);
  assert.equal(f.computePlaybackUiState().tone, 'paused');
  f.state.preparingChunks = false;
  const secondAudio = fakeSpeech(4);
  f.state.prepared.push({ chunkIndex: 1, start: 60, end: 65, ttsModel: 'supertonic-3', audio: secondAudio });
  f.state.preparedChunkIndexes.add(1);
  f.syncAudioToVideo();
  assert.equal(f.video.paused, true);
  assert.match(f.computePlaybackUiState().detail, /준비 완료 ✓/);

  // 7) Clicking '이어서 재생' now starts immediately.
  f.resumeFromUserPause();
  assert.equal(f.video.paused, false);
  assert.equal(f.computePlaybackUiState().tone, 'playing');

  // 8) Sentence tail hold shows exact remaining seconds.
  secondAudio.currentTime = 3.1;
  f.state.playbackHold = { reason: 'tail', startedAt: Date.now() };
  ui = f.computePlaybackUiState();
  assert.equal(ui.tone, 'tail');
  assert.match(ui.title, /0\.9초 후 자동 진행/);
  f.stopDub();
});

test('continuous next-video toggle starts current dub, auto-continues after pre-roll ads on next video, and stops auto-starting when toggled off', async () => {
  let currentId = 'video111111';
  let adActive = false;
  const startedVideos = [];
  const f = await contentFixture({
    videoIdFn: () => currentId,
    audio: fakeSpeech(3),
    prepare: async (payload) => {
      startedVideos.push(payload.videoId);
      return { segments: [{ index: 0, start: 0, end: 4, audioDataUrl: 'data:audio/wav;base64,AA==' }] };
    },
  });
  f.video.readyState = 2;
  f.video.duration = 120;
  f.video.closest = (sel) => (sel === '.ad-showing' && adActive ? {} : null);
  f.state.videoId = currentId;
  f.state.lastKnownVideoId = currentId;

  // 1) Toggling continuous mode ON while idle on a watch page starts dubbing immediately.
  f.toggleAutoContinue();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.state.autoContinue, true);
  assert.equal(f.state.running, true);
  assert.deepEqual(startedVideos, ['video111111']);
  assert.equal(f.els.start.textContent, 'Start · 연속');

  // 2) Navigating to next video while ad is showing waits cleanly, then auto-starts once ad ends.
  currentId = 'video222222';
  f.state.videoId = currentId;
  adActive = true;
  f.handleVideoTransition('video222222', { fromNavigationEvent: true });
  assert.equal(f.state.running, false);
  assert.ok(f.state.pendingAutoContinue);
  assert.match(f.computePlaybackUiState().title, /광고 종료 후 자동으로 더빙 시작/);
  assert.equal(f.maybeRunAutoContinue(Date.now() + 1000), false);
  assert.deepEqual(startedVideos, ['video111111']);

  // Ad finishes -> next video starts dubbing automatically!
  adActive = false;
  assert.equal(f.maybeRunAutoContinue(Date.now() + 1000), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.state.running, true);
  assert.deepEqual(startedVideos, ['video111111', 'video222222']);

  // 3) Toggling continuous mode OFF keeps current video playing, but next video requires manual Start.
  f.toggleAutoContinue();
  assert.equal(f.state.autoContinue, false);
  assert.equal(f.state.running, true);
  assert.equal(f.els.start.textContent, 'Start');

  currentId = 'video333333';
  f.state.videoId = currentId;
  f.handleVideoTransition('video333333', { fromNavigationEvent: true });
  assert.equal(f.state.running, false);
  assert.equal(f.state.pendingAutoContinue, null);
  assert.equal(f.maybeRunAutoContinue(Date.now() + 2000), false);
  assert.deepEqual(startedVideos, ['video111111', 'video222222']);
  f.stopDub();
});

test('rolling lookahead batches up to 4 future clips with streaming and preserves playing chunks across window expansions', async () => {
  const requests = [];
  let streamedCallback = null;
  const f = await contentFixture({
    expand: async () => true,
    prepare: async (payload, onSegment) => {
      requests.push(payload.segments.map(c => c.index));
      streamedCallback = onSegment;
      return { segments: payload.segments.map(c => ({ ...c, audioUrl: 'fixture.wav' })) };
    },
  });
  f.state.running = true;
  f.video.currentTime = 1.0;
  f.state.chunks = Array.from({ length: 8 }, (_, index) => ({ index, start: index * 3, end: index * 3 + 2.8, text: `s${index}` }));
  const playingAudio = { paused: false, currentTime: 1.0, duration: 2.5, pause() { this.paused = true; } };
  f.state.prepared = [{ chunkIndex: 0, start: 0, end: 2.8, audio: playingAudio }];
  f.state.preparedChunkIndexes = new Set([0]);
  f.state.currentChunkIndex = 0;
  f.state.currentAudio = playingAudio;

  // Current clip (0) is already covered -> rolling lookahead batches 4 future clips (1..4) with NDJSON streaming
  f.maybePrepareMoreAudio(1.0, 'timer');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(Array.from(requests[0]), [1, 2, 3, 4]);
  assert.equal(typeof streamedCallback, 'function');

  // Window seam expansion: a short prepared/playing tail chunk [22.8..24.0] must NOT merge with [24.0..25.2] and cut off audio
  f.state.sourceSegments = [{ start: 22.8, end: 24.0, text: 'Then the robot' }];
  f.state.chunks = [{ index: 6, start: 22.8, end: 24.0, text: 'Then the robot', segments: f.state.sourceSegments }];
  f.state.prepared = [{ chunkIndex: 6, start: 22.8, end: 24.0, audio: playingAudio }];
  f.state.preparedChunkIndexes = new Set([6]);
  f.state.currentChunkIndex = 6;
  f.state.currentAudio = playingAudio;
  f.video.currentTime = 23.2;

  const expanded = f.maybeInstallExpandedSegments([{ start: 24.0, end: 25.2, text: 'picks it up.' }]);
  assert.equal(expanded, true);
  assert.equal(playingAudio.paused, false);
  assert.equal(f.state.currentAudio, playingAudio);
  assert.equal(f.state.prepared.length, 1);
  assert.equal(f.state.chunks.length, 2);
  assert.equal(f.state.chunks[0].index, 6);
  assert.equal(f.state.chunks[1].start, 24.0);
  f.stopDub();
});

test('prepare requests report live bufferAhead queue depth and HUD marks HQ 2.1 clips', async () => {
  let capturedBufferAhead = null;
  const f = await contentFixture({
    prepare: async payload => {
      capturedBufferAhead = payload.bufferAhead;
      return { segments: payload.segments.map(c => ({ ...c, ttsModel: 'gpt-realtime-2.1', audioUrl: 'hq.wav' })) };
    },
  });
  f.state.running = true;
  f.video.currentTime = 2;
  f.video.paused = false;
  f.state.chunks = Array.from({ length: 6 }, (_, i) => ({ index: i, start: i * 6, end: i * 6 + 5.5, text: `c${i}` }));
  const a0 = { paused: false, currentTime: 2, duration: 5, pause() {} };
  f.state.prepared = [
    { chunkIndex: 0, start: 0, end: 5.5, ttsModel: 'gpt-realtime-2.1', audio: a0 },
    { chunkIndex: 1, start: 6, end: 11.5, ttsModel: 'gpt-realtime-2.1-mini', audio: a0 },
    { chunkIndex: 2, start: 12, end: 17.5, ttsModel: 'gpt-realtime-2.1-mini', audio: a0 },
  ];
  f.state.preparedChunkIndexes = new Set([0, 1, 2]);
  f.state.currentChunkIndex = 0;
  f.state.currentAudio = a0;

  await f.prepareAndAppendChunks([f.state.chunks[3]]);
  assert.deepEqual({ ...capturedBufferAhead }, { seconds: 15.5, clips: 3 });

  const ui = f.computePlaybackUiState(Date.now());
  assert.equal(ui.tone, 'playing');
  assert.match(ui.title, /HQ 2\.1/);
  assert.match(ui.detail, /HQ 2\.1/);
  f.stopDub();
});

test('paused state stays completely stable without status/detail oscillation when background rolling prefetch runs or seek timer ages', async () => {
  const f = await contentFixture({
    prepare: async payload => ({ segments: payload.segments.map(c => ({ ...c, audioUrl: 'future.wav' })) }),
  });
  f.state.running = true;
  f.state.chunks = [
    { index: 0, start: 0, end: 4, text: 'intro' },
    { index: 1, start: 10, end: 14, text: 'later' },
  ];
  f.state.sourceSegments = f.state.chunks;
  const a0 = { paused: false, currentTime: 4, duration: 4, pause() { this.paused = true; } };
  f.state.prepared = [{ chunkIndex: 0, start: 0, end: 4, ttsModel: 'supertonic-3', audio: a0 }];
  f.state.preparedChunkIndexes = new Set([0]);

  // User pauses on a silent gap (t = 6s, between chunk 0 [0..4] and chunk 1 [10..14])
  f.video.currentTime = 6;
  f.video.paused = true;
  f.handleVideoInteractionEvents('pause');
  assert.equal(f.state.status, 'paused');
  const baselineDetail = f.computePlaybackUiState().detail;
  assert.match(baselineDetail, /정지 상태/);

  // Background rolling lookahead starts and finishes for future chunk 1: paused status & banner detail must NOT flicker!
  f.state.preparingChunks = true;
  assert.equal(f.computePlaybackUiState().detail, baselineDetail);
  await f.prepareAndAppendChunks([f.state.chunks[1]]);
  assert.equal(f.state.status, 'paused');
  assert.equal(f.computePlaybackUiState().detail, baselineDetail);

  // Seek while paused: ready message stays latched even after >10s (no 6-second box resize jump)
  f.video.currentTime = 11;
  f.handleVideoInteractionEvents('seeked');
  const seekReadyDetail = f.computePlaybackUiState(Date.now()).detail;
  assert.match(seekReadyDetail, /준비 완료 ✓/);
  assert.equal(f.computePlaybackUiState(Date.now() + 20000).detail, seekReadyDetail);
  f.stopDub();
});

test('idle/paused/ended states spend zero rolling lookahead tokens and Stop aborts in-flight prepare requests', async () => {
  const prepareCalls = [];
  let expandCalls = 0;
  const runtimeMessages = [];
  let pendingDubGate = null;

  const f = await contentFixture({
    expand: async () => { expandCalls++; return true; },
    runtimeSend: async msg => {
      runtimeMessages.push(msg);
      if (msg.type === 'YLD_PREPARE_DUB' && pendingDubGate) {
        return pendingDubGate.promise;
      }
      return { ok: true, payload: { segments: [] } };
    },
    prepare: async payload => {
      prepareCalls.push({
        indexes: payload.segments.map(s => s.index),
        bufferAhead: { ...payload.bufferAhead },
      });
      return { segments: payload.segments.map(s => ({ ...s, audioUrl: 'paused-test.wav' })) };
    },
  });

  f.state.running = true;
  f.state.sourceSegments = Array.from({ length: 8 }, (_, i) => ({ start: i * 5, end: i * 5 + 4, text: `line ${i}` }));
  f.state.chunks = f.state.sourceSegments.map((s, index) => ({ index, ...s, segments: [s] }));
  const readyAudio = { paused: true, ended: false, currentTime: 1, duration: 4, pause() { this.paused = true; } };
  f.state.prepared = [{ chunkIndex: 0, start: 0, end: 4, ttsModel: 'gpt-realtime-2.1-mini', audio: readyAudio }];
  f.state.preparedChunkIndexes = new Set([0]);

  // 1) Paused on an already-prepared clip (t = 1s): 0 rolling lookahead clips, 0 transcript expansions.
  f.video.currentTime = 1;
  f.video.paused = true;
  f.maybePrepareMoreAudio(1, 'timer');
  f.maybeExpandTranscriptCoverage(1);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(prepareCalls.length, 0);
  assert.equal(expandCalls, 0);

  // 2) Paused on a silent gap (t = 4.5s, between [0..4] and [5..9]): 0 requests.
  f.video.currentTime = 4.5;
  f.maybePrepareMoreAudio(4.5, 'timer');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(prepareCalls.length, 0);

  // 3) Seeking while paused onto an uncovered clip (chunk 3 at t = 16s): prepares ONLY that 1 clip with zeroed bufferAhead (no HQ 2.1), then stops!
  f.video.currentTime = 16;
  f.maybePrepareMoreAudio(16, 'seek');
  await new Promise(r => setTimeout(r, 15));
  assert.equal(prepareCalls.length, 1);
  assert.deepEqual(prepareCalls[0].indexes, [3]);
  assert.deepEqual(prepareCalls[0].bufferAhead, { seconds: 0, clips: 0 });

  // 4) Ended video: 0 prepare or expansion calls.
  f.video.ended = true;
  f.video.paused = true;
  f.maybePrepareMoreAudio(16, 'timer');
  f.maybeExpandTranscriptCoverage(16);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(prepareCalls.length, 1);
  assert.equal(expandCalls, 0);

  // 5) Action icon state deduplicates per-second ticks and Stop aborts in-flight YLD_PREPARE_DUB immediately.
  f.video.ended = false;
  f.video.paused = false;
  f.state.currentChunkIndex = 0;
  f.state.currentAudio = { ...readyAudio, paused: false };
  f.state.prepared[0].ttsModel = 'gpt-realtime-2.1';
  runtimeMessages.length = 0;
  f.renderPlaybackStateUi();
  f.video.currentTime = 2.5;
  f.renderPlaybackStateUi();
  const actionUpdates = runtimeMessages.filter(m => m.type === 'YLD_ACTION_STATE');
  assert.equal(actionUpdates.length, 1);
  assert.equal(actionUpdates[0].payload.state, 'playing');
  assert.equal(actionUpdates[0].payload.hq, true);

  pendingDubGate = deferred();
  const inFlight = f.requestDubPrepare({ videoId: 'abcdefghijk', segments: [{ index: 5, start: 25, end: 29, text: 'later' }] });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(f.state.activePrepareIds.size, 1);
  f.stopDub();
  const aborts = runtimeMessages.filter(m => m.type === 'YLD_ABORT_PREPARE');
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0].payload.requestIds.length, 1);
  assert.equal(runtimeMessages.filter(m => m.type === 'YLD_ACTION_STATE').at(-1).payload.state, 'idle');
  pendingDubGate.resolve({ ok: false, error: 'Audio preparation cancelled.', retryable: false });
  await assert.rejects(inFlight, /cancelled/);
});
