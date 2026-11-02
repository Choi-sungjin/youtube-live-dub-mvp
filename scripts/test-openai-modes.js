import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    for(const kind of ['disconnect','incomplete','error']) await assert.rejects(synthesizeOpenAISpeech({text:'안녕하세요.',settings:{voice:'marin'},outputPath:path.join(dir,'partial.wav')},{apiKey:'test-only',Socket:socketFixture(kind)}), e=>!e.message.includes('secret must never leak'));
    assert.deepEqual(await readdir(dir),[]);
  } finally {await rm(dir,{recursive:true,force:true});}
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
