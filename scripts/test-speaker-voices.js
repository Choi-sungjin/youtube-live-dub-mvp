import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { classifySpeaker, selectSpeakerVoice, createAudioSourceLoader } from '../backend/speaker-voices.js';
import { resolveDubbingMode } from '../backend/dubbing-modes.js';

test('all four mode requests enable auto voice; explicit local voices remain manual', async () => {
  const source=await readFile(new URL('../backend/server.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function normalizeSettings('),source.indexOf('function normalizeSegment('));
  const normalize=runInNewContext(code+';normalizeSettings',{
    resolveDubbingMode,process:{env:{}},activeTranslationProvider:()=> 'ollama',
    normalizeProvider:(value,allowed,fallback)=>allowed.includes(value)?value:fallback,
    OPENAI_VOICES:['cedar','marin','coral','alloy'],OPENAI_VOICE_MODEL:'fixture',
    SUPERTONE_VOICES:{lowMale:{id:'fixture'}},clamp:(v,min,max)=>Math.min(max,Math.max(min,v)),
  });
  for(const mode of ['local','gemma-gpt','gpt-local','gpt']) {
    const result=normalize({mode,voice:'auto'});
    assert.equal(result.autoSpeaker,true);
    assert.equal(result.voice,result.ttsProvider==='supertonic3'?'M1':'marin');
  }
  const manual=normalize({mode:'local',voice:'F4'});
  assert.equal(manual.autoSpeaker,false);assert.equal(manual.voice,'F4');
  assert.equal(normalize({ttsProvider:'windows-sapi',voice:'auto'}).autoSpeaker,false);
});

test('source acquisition caps distinct videos at two and failed video intervals share a cooldown', async () => {
  let calls=0, release, clock=1000;
  const held=new Promise(resolve=>{release=resolve;});
  const source=createAudioSourceLoader({exists:()=>false,mkdirImpl:async()=>{},now:()=>clock,
    executeImpl:async()=>{calls++;await held;throw Error('unavailable');}});
  const pending=Array.from({length:12},(_,i)=>source(String(i).padStart(11,'0')).catch(()=>null));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
  release();await Promise.all(pending);
  for(let i=0;i<80;i++)await assert.rejects(source('00000000000'));
  assert.equal(calls,2);
  clock+=300001;await assert.rejects(source('00000000000'));assert.equal(calls,3);
});

test('automatic GPT and local voices follow audio presentation; manual choices stay selected', () => {
  const settings={ttsProvider:'openai-realtime',autoSpeaker:true,voice:'coral'};
  assert.equal(selectSpeakerVoice(settings,{label:'male'}),'cedar');
  assert.equal(selectSpeakerVoice(settings,{label:'female'}),'marin');
  assert.equal(selectSpeakerVoice(settings,{label:'unknown'}),'coral');
  assert.equal(selectSpeakerVoice(settings,null),'coral');
  assert.equal(selectSpeakerVoice({...settings,autoSpeaker:false},{label:'male'}),'coral');
  const local={...settings,ttsProvider:'supertonic3',voice:'M1'};
  assert.deepEqual(['male','female','male','unknown'].map(label=>selectSpeakerVoice(local,{label})),['M1','F1','M1','M1']);
  assert.equal(selectSpeakerVoice({...local,voice:'F2',autoSpeaker:false},{label:'male'}),'F2');
  assert.equal(selectSpeakerVoice({...local,voice:'F2'},{label:'unknown'}),'F2');
});

test('invalid source ids and intervals cannot reach download or local file access', async () => {
  let calls=0;
  const dependencies={source:()=>{calls++;throw Error('must not execute');},analyze:()=>{calls++;}};
  for(const request of [
    {videoId:'../../secret',start:0,end:4},{videoId:'https://evil.test',start:0,end:4},
    {videoId:'abcdefghijk',start:-1,end:4},{videoId:'abcdefghijk',start:0,end:NaN},
    {videoId:'abcdefghijk',start:2,end:2},
  ]) assert.equal((await classifySpeaker(request,dependencies)).reason,'invalid-source');
  assert.equal(calls,0);
});

test('concurrent matching audio intervals share analysis and changed audio invalidates cache', async () => {
  let calls=0,mtime=1;
  const dependencies={source:async()=>'/fixture.wav',stat:async()=>({size:123,mtimeMs:mtime}),analyze:async({duration})=>{calls++;assert.equal(duration,12);return {label:'female'};}};
  const request={videoId:'cachetest01',start:0,end:25};
  const results=await Promise.all([classifySpeaker(request,dependencies),classifySpeaker(request,dependencies)]);
  assert.deepEqual(results,[{label:'female'},{label:'female'}]);assert.equal(calls,1);
  mtime=2;await classifySpeaker(request,dependencies);assert.equal(calls,2);
});

test('unavailable source and classifier fail to a declared default without blocking speech', async () => {
  const request={videoId:'failure0001',start:0,end:4};
  for (const dependencies of [
    {source:async()=>{throw Error('private path');},analyze:()=>{}},
    {source:async()=>'/fixture.wav',stat:async()=>({size:123,mtimeMs:1}),analyze:async()=>{throw Error('private path');}},
  ]) assert.deepEqual(await classifySpeaker(request,dependencies),{label:'unknown',reason:'audio-unavailable'});
});

test('backend uses classified voice in both cache key and synthesis and returns the actual voice',async()=>{
  const source=await readFile(new URL('../backend/server.js',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('async function prepareDub('),source.indexOf('async function fetchYouTubeCaptions('));
  const keys=[],voices=[];let classifications=0;
  const settings={ttsProvider:'openai-realtime',autoSpeaker:true,voice:'marin',targetLang:'ko',translationProvider:'mock'};
  const prepare=runInNewContext(code+';prepareDub',{
    performance,process:{env:{OPENAI_API_KEY:'fixture'}},normalizeSettings:()=>settings,
    normalizeSegment:s=>s,applyVerifiedCaptionTerms:(_,s)=>s,activeTranslationProvider:()=> 'mock',
    translateSegments:async s=>new Map(s.map(x=>[x.index,'안녕하세요.'])),mapLimit:async(a,_,fn)=>Promise.all(a.map(fn)),
    classifySpeaker:async({start})=>{classifications++;return {label:start===0?'male':'female'};},selectSpeakerVoice,
    normalizeDubbingTranslation:x=>x,cleanText:x=>x,speechText:x=>x,cacheableSettings:x=>x,SPEECH_TEXT_REVISION:'fixture',
    activeTtsProvider:()=> 'openai-realtime',hashValue:x=>{keys.push(x);return String(keys.length);},
    path:{join:(...p)=>p.join('/')},AUDIO_DIR:'/fixture',fileExists:async()=>false,
    synthesizeSpeech:async({settings})=>{voices.push(settings.voice);return {duration:2};},
    clamp:x=>x,roundTime:x=>x,HOST:'localhost',PORT:1,providerInfo:()=>({}),buildWarnings:()=>[],
  });
  const segments=[{index:0,start:0,end:3,text:'First'},{index:1,start:3,end:6,text:'Second'}];
  const response=await prepare({videoId:'abcdefghijk',settings,segments});
  assert.deepEqual(voices,['cedar','marin']);
  assert.equal(keys[0].settings.voice,'cedar');assert.equal(keys[1].settings.voice,'marin');
  assert.equal(response.segments[0].voiceId,'cedar');assert.equal(response.segments[1].speaker.label,'female');
  settings.autoSpeaker=false;
  await prepare({videoId:'abcdefghijk',settings,segments});assert.equal(classifications,2);
  settings.autoSpeaker=true;settings.ttsProvider='supertonic3';settings.voice='M1';
  const localResponse=await prepare({videoId:'abcdefghijk',settings,segments});assert.equal(classifications,4);
  assert.deepEqual(voices.slice(-2),['M1','F1']);
  assert.equal(keys.at(-2).settings.voice,'M1');assert.equal(keys.at(-1).settings.voice,'F1');
  assert.equal(localResponse.segments[1].voiceId,'F1');
  settings.autoSpeaker=false;settings.voice='F3';
  await prepare({videoId:'abcdefghijk',settings,segments});assert.equal(classifications,4);
  assert.deepEqual(voices.slice(-2),['F3','F3']);
});
