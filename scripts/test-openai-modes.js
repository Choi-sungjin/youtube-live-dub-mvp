import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { resolveDubbingMode } from '../backend/dubbing-modes.js';
import { readResponseStream, translateOpenAI, synthesizeOpenAISpeech, pcmWave } from '../backend/openai-audio.js';

function stream(events, fragment = 7) {
  const data = Buffer.from(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  return (async function* () { for (let i = 0; i < data.length; i += fragment) yield data.subarray(i, i + fragment); })();
}
test('four choices select independent providers; unknown names cannot silently select local', () => {
  assert.deepEqual(['local','gemma-gpt','gpt-local','gpt'].map(resolveDubbingMode), [
    {translationProvider:'ollama',ttsProvider:'supertonic3'}, {translationProvider:'ollama',ttsProvider:'openai-realtime'},
    {translationProvider:'openai',ttsProvider:'supertonic3'}, {translationProvider:'openai',ttsProvider:'openai-realtime'},
  ]);
  for (const bad of ['', 'typo', '__proto__', 'constructor']) assert.throws(() => resolveDubbingMode(bad), /Unknown/);
});
test('fragmented UTF-8/SSE text arrives before the terminal completion event', async () => {
  const deltas = [];
  const result = await readResponseStream(stream([
    {type:'response.output_text.delta',delta:'로봇이 '}, {type:'response.output_text.delta',delta:'움직여요.'},
    {type:'response.completed',response:{status:'completed'}},
  ],1), text => deltas.push(text));
  assert.equal(result, '로봇이 움직여요.'); assert.deepEqual(deltas, ['로봇이 ','움직여요.']);
});
test('partial translations, refusal without text, and provider errors cannot become valid captions', async () => {
  for (const events of [
    [{type:'response.output_text.delta',delta:'partial'}],
    [{type:'response.completed',response:{status:'completed'}}],
    [{type:'response.output_text.delta',delta:'partial'},{type:'response.failed'}],
    [{type:'response.incomplete'}],
  ]) await assert.rejects(readResponseStream(stream(events)), /complete/);
});
test('GPT text uses the Responses stream and makes no request when a key is missing', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++; assert.equal(url,'https://api.openai.com/v1/responses');
    const input = JSON.parse(init.body); assert.equal(input.stream,true); assert.equal(input.store,false); assert.equal(input.reasoning.effort,'none');
    return {ok:true,body:stream([{type:'response.output_text.delta',delta:'로봇이 왼쪽으로 돌아요.'},{type:'response.completed'}])};
  };
  const segments=[{index:4,text:'The robot turns left.'}]; const settings={targetLang:'ko'};
  await assert.rejects(translateOpenAI(segments,settings,{}, {fetchImpl,apiKey:''}), /OPENAI_API_KEY/); assert.equal(calls,0);
  const metrics={}; const result=await translateOpenAI(segments,settings,metrics,{fetchImpl,apiKey:'test-only'});
  assert.equal(result.get(4),'로봇이 왼쪽으로 돌아요.'); assert.equal(calls,1); assert.ok(metrics.firstTextDeltaMs>=0);
});
test('HTTP authentication failure is explicit and never echoes provider bodies or keys', async () => {
  await assert.rejects(translateOpenAI([{index:0,text:'hello'}],{targetLang:'ko'},{},{apiKey:'test-secret', fetchImpl: async()=>({ok:false,status:401,body:{cancel:async()=>{}}})}), error => error.message.includes('401') && !error.message.includes('test-secret'));
});
function socketFixture(kind) {
  return class extends EventEmitter {
    readyState=1;
    constructor(url,opts) { super(); assert.match(url,/^wss:\/\/api.openai.com\/v1\/realtime\?model=/); assert.equal(opts.headers.Authorization,'Bearer test-only'); queueMicrotask(()=>this.emit('open')); }
    send(raw) {
      const value=JSON.parse(raw);
      if(value.type==='session.update') { assert.equal(value.session.audio.output.format.rate,24000); assert.equal(value.session.audio.output.voice,'marin'); queueMicrotask(()=>this.emit('message',Buffer.from('{"type":"session.updated"}'))); }
      if(value.type==='response.create') queueMicrotask(()=>{
        this.emit('message',Buffer.from(JSON.stringify({type:'response.output_audio.delta',delta:Buffer.alloc(4800,1).toString('base64')})));
        if(kind==='disconnect') return this.emit('close');
        if(kind==='error') return this.emit('message',Buffer.from('{"type":"error","error":{"code":"invalid_api_key","message":"secret must never leak"}}'));
        this.emit('message',Buffer.from('{"type":"response.output_audio_transcript.delta","delta":"안녕하세요."}'));
        this.emit('message',Buffer.from(JSON.stringify({type:'response.done',response:{status:kind==='incomplete'?'incomplete':'completed'}})));
      });
    }
    close() {this.readyState=3;this.emit('close');}
    terminate() {this.close();}
  };
}
test('Realtime audio writes a valid 24 kHz WAV only after response completion', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'yld-openai-'));
  try {
    const outputPath=path.join(dir,'voice.wav');
    const result=await synthesizeOpenAISpeech({text:'안녕하세요.',settings:{voice:'marin'},outputPath},{apiKey:'test-only',Socket:socketFixture('complete')});
    const wav=await readFile(outputPath); assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),24000);assert.equal(wav.length,4844);
    assert.equal(result.duration,0.1);assert.equal(result.transcript,'안녕하세요.');assert.ok(result.firstAudioMs>=0);assert.deepEqual(await readdir(dir),['voice.wav']);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('disconnected, incomplete or errored Realtime streams leave no playable partial cache',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'yld-openai-failure-'));
  try {
    for(const kind of ['disconnect','incomplete','error']) await assert.rejects(synthesizeOpenAISpeech({text:'안녕하세요.',settings:{voice:'marin'},outputPath:path.join(dir,'partial.wav')},{apiKey:'test-only',Socket:socketFixture(kind),retryDelaysMs:[0,0]}), e=>!e.message.includes('secret must never leak'));
    assert.deepEqual(await readdir(dir),[]);
  } finally {await rm(dir,{recursive:true,force:true});}
});
function failingSocket(kind) {
  return class extends EventEmitter {
    readyState=0;
    constructor() {
      super();
      queueMicrotask(()=>{
        if(kind==='reset') return this.emit('error',Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'}));
        const [status,code]={http401:[401,'invalid_api_key'],http404:[404,'model_not_found'],quota:[429,'insufficient_quota'],rate:[429,'rate_limit_exceeded'],http503:[503,'']}[kind];
        const res=Object.assign(Readable.from([Buffer.from(JSON.stringify({error:{code,message:'Incorrect API key provided: test-only'}}))]),{statusCode:status});
        this.emit('unexpected-response',{},res);
      });
    }
    close() {this.readyState=3;}
    terminate() {this.readyState=3;}
  };
}
function socketSequence(kinds) {
  const state={calls:0};
  state.Socket=function(url,opts) { const kind=kinds[Math.min(state.calls++,kinds.length-1)]; return new (kind==='complete'?socketFixture('complete'):failingSocket(kind))(url,opts); };
  return state;
}
test('Realtime voice retries a transient connection failure and still writes one WAV', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'yld-openai-retry-'));
  try {
    for(const first of ['reset','rate','http503']) {
      const seq=socketSequence([first,'complete']); const outputPath=path.join(dir,`${first}.wav`);
      const result=await synthesizeOpenAISpeech({text:'안녕하세요.',settings:{voice:'marin'},outputPath},{apiKey:'test-only',Socket:seq.Socket,retryDelaysMs:[0,0]});
      assert.equal(seq.calls,2); assert.equal(result.duration,0.1);
    }
    assert.deepEqual((await readdir(dir)).sort(),['http503.wav','rate.wav','reset.wav']);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('Realtime voice names the real cause, fails fast on key/access/quota and never echoes provider text', async () => {
  const run=kinds=>{ const seq=socketSequence(kinds); return {seq,promise:synthesizeOpenAISpeech({text:'안녕하세요.',settings:{voice:'marin'},outputPath:path.join(tmpdir(),'never-written.wav')},{apiKey:'test-only',Socket:seq.Socket,retryDelaysMs:[0,0]})}; };
  for(const [kind,pattern] of [['http401',/HTTP 401.*OPENAI_API_KEY/],['http404',/HTTP 404.*model access/],['quota',/insufficient_quota.*billing/]]) {
    const {seq,promise}=run([kind]);
    await assert.rejects(promise,e=>pattern.test(e.message)&&!e.message.includes('Incorrect API key')&&!e.message.includes('test-only'));
    assert.equal(seq.calls,1);
  }
  const {seq,promise}=run(['reset']);
  await assert.rejects(promise,/ECONNRESET.*\(3 attempts\)/);
  assert.equal(seq.calls,3);
  // The live API upgrades first and reports a bad key as an error event; it must get the same guidance.
  await assert.rejects(synthesizeOpenAISpeech({text:'안녕하세요.',settings:{voice:'marin'},outputPath:path.join(tmpdir(),'never-written.wav')},{apiKey:'test-only',Socket:socketFixture('error'),retryDelaysMs:[0,0]}),
    e=>/invalid_api_key.*OPENAI_API_KEY/.test(e.message)&&!/attempts/.test(e.message)&&!e.message.includes('secret must never leak'));
});
test('empty and odd-length PCM are rejected instead of producing corrupt WAV files',()=>{
  assert.throws(()=>pcmWave(Buffer.alloc(0)),/invalid/);assert.throws(()=>pcmWave(Buffer.alloc(3)),/invalid/);
});


test('GPT translation cache separates identical captions with different preceding context', async () => {
  const {readFile} = await import('node:fs/promises');
  const {runInNewContext} = await import('node:vm');
  const source = await readFile(new URL('../backend/server.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function translationCacheKey('), source.indexOf('function isRateLimitError('));
  const key = runInNewContext(code+'; translationCacheKey', {hashValue:JSON.stringify, roundTime:Number, process:{env:{}}, OPENAI_TEXT_MODEL:'fixture'});
  const base = {text:'It is a crane.',start:10,end:12};
  const bird = key({...base,contextBefore:'We are watching birds.'},{targetLang:'ko'},'openai');
  const machine = key({...base,contextBefore:'This construction site is busy.'},{targetLang:'ko'},'openai');
  assert.notEqual(bird,machine);
  assert.equal(bird,key({...base,contextBefore:'We are watching birds.'},{targetLang:'ko'},'openai'));
});
test('GPT translation retries dropped connections and cut-off streams, then names the cause', async () => {
  const ok=()=>({ok:true,body:stream([{type:'response.output_text.delta',delta:'다시 연결됐어요.'},{type:'response.completed'}])});
  const reset=()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'})});};
  const cut=()=>({ok:true,body:stream([{type:'response.output_text.delta',delta:'다시'}])});
  for(const first of [reset,cut]) {
    let calls=0; const fetchImpl=async()=>(++calls===1?first():ok());
    const result=await translateOpenAI([{index:0,text:'Reconnected.'}],{targetLang:'ko'},{},{fetchImpl,apiKey:'test-only',retryDelaysMs:[0,0]});
    assert.equal(result.get(0),'다시 연결됐어요.'); assert.equal(calls,2);
  }
  let calls=0;
  await assert.rejects(translateOpenAI([{index:0,text:'x'}],{targetLang:'ko'},{},{fetchImpl:async()=>{calls++;reset();},apiKey:'test-only',retryDelaysMs:[0,0]}),
    e=>/translation connection failed \(ECONNRESET\).*\(3 attempts\)/.test(e.message)&&e.retryable===true);
  assert.equal(calls,3);
});
test('GPT translation fails fast on quota and key errors without echoing the provider message', async () => {
  for(const [status,code,pattern] of [[429,'insufficient_quota',/insufficient_quota.*billing/],[401,'invalid_api_key',/HTTP 401.*OPENAI_API_KEY/]]) {
    let calls=0;
    const fetchImpl=async()=>{calls++;return {ok:false,status,json:async()=>({error:{code,message:'Incorrect API key provided: test-only'}})};};
    await assert.rejects(translateOpenAI([{index:0,text:'x'}],{targetLang:'ko'},{},{fetchImpl,apiKey:'test-only',retryDelaysMs:[0,0]}),
      e=>pattern.test(e.message)&&e.retryable===false&&!e.message.includes('test-only'));
    assert.equal(calls,1);
  }
});
async function serverFallbackHelpers() {
  const {readFile} = await import('node:fs/promises');
  const {runInNewContext} = await import('node:vm');
  const source = await readFile(new URL('../backend/server.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const LOCAL_VOICE_FOR_OPENAI'), source.indexOf('async function translateSegments('));
  const warnings = [];
  return {warnings, ...runInNewContext(code+'; ({preferOpenAI, localVoiceSettings})', {Date, console:{warn:m=>warnings.push(m)}})};
}
test('OpenAI outage falls back to the local engine, then skips OpenAI briefly', async () => {
  const {preferOpenAI, warnings} = await serverFallbackHelpers();
  const outage = Object.assign(new Error('OpenAI voice connection failed (ETIMEDOUT).'), {retryable:true});
  let openai = 0;
  const first = await preferOpenAI(async()=>{openai++;throw outage;}, async()=>'local clip');
  assert.equal(first.value,'local clip'); assert.match(first.fallback,/ETIMEDOUT/); assert.equal(warnings.length,1);
  const second = await preferOpenAI(async()=>{openai++;return 'gpt clip';}, async()=>'local clip');
  assert.equal(second.value,'local clip'); assert.match(second.fallback,/moments ago/); assert.equal(openai,1);
});
test('OpenAI key errors are not hidden by the fallback, and a failed fallback keeps the real cause', async () => {
  const {preferOpenAI} = await serverFallbackHelpers();
  let local = 0;
  await assert.rejects(preferOpenAI(async()=>{throw Object.assign(new Error('OpenAI voice rejected the API key'),{retryable:false});}, async()=>{local++;}), /rejected the API key/);
  assert.equal(local,0);
  await assert.rejects(preferOpenAI(async()=>{throw Object.assign(new Error('OpenAI translation connection failed (ECONNRESET).'),{retryable:true});}, async()=>{throw new Error('Ollama is not running');}),
    e=>/ECONNRESET.*Local fallback failed: Ollama is not running/.test(e.message)&&e.retryable===true);
});
test('local fallback voice keeps the selected speaker gender and Supertonic speed', async () => {
  const {localVoiceSettings} = await serverFallbackHelpers();
  const male = localVoiceSettings({voice:'cedar',ttsProvider:'openai-realtime',speed:1,targetLang:'ko'});
  assert.equal(male.voice,'M1'); assert.equal(male.ttsProvider,'supertonic3'); assert.equal(male.ttsModel,'supertonic-3'); assert.equal(male.speed,1.15); assert.equal(male.targetLang,'ko');
  assert.equal(localVoiceSettings({voice:'marin'}).voice,'F1');
});
