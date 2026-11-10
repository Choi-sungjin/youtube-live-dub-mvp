import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {splitSpeakerSegments, createSpeakerEvidenceStore, capturedSpeakerEvidence} from '../backend/speaker-segments.js';
import {classifySpeaker} from '../backend/speaker-voices.js';

test('mixed voices inside one caption split at word boundaries without dropping or repeating words', () => {
  const words = [' Hello', ' there', ' welcome', ' back.'].map((word,i)=>({start:i,end:i+0.8,word}));
  const result = splitSpeakerSegments([{words}], [{start:0,end:2,label:'male'},{start:2,end:4,label:'female'}]);
  assert.deepEqual(result.map(s=>[s.start,s.end,s.text,s.speaker.label]),[[0,1.8,'Hello there','male'],[2,3.8,'welcome back.','female']]);
  assert.equal(splitSpeakerSegments([{words}],[])[0].speaker.label,'unknown');
  assert.equal(splitSpeakerSegments([{start:0,end:4,text:'No word times'}],[{start:0,end:2,label:'male'},{start:2,end:4,label:'female'}])[0].speaker.label,'unknown');
});

test('speaker evidence binds video and interval, expires, and stays bounded', () => {
  let clock=0; const store=createSpeakerEvidenceStore({now:()=>clock,limit:2,ttl:10});
  const seg={start:1.123,end:3,text:'hello',speaker:{label:'female'}};
  const [entry]=store.register('abcdefghijk',[seg]);
  assert.equal(store.resolve({...entry,videoId:'abcdefghijk',start:1.12}).label,'female');
  assert.equal(store.resolve({...entry,videoId:'other-video'}),null);
  assert.equal(store.resolve({...entry,videoId:'abcdefghijk',end:4}),null);
  clock=11;assert.equal(store.resolve({...entry,videoId:'abcdefghijk'}),null);
  const [next]=store.register('abcdefghijk',[seg]);store.register('abcdefghijk',[seg,seg]);
  assert.equal(store.resolve({...next,videoId:'abcdefghijk'}),null);
});

test('captured evidence selects a voice without downloading, and invalid keys cannot force a label', async () => {
  const videoId='abcdefghijk';
  const [segment]=capturedSpeakerEvidence.register(videoId,[{start:1,end:3,speaker:{label:'female'}}]);
  const deps={source:()=>{throw Error('must never download');},analyze:()=>{throw Error('must not analyze twice');}};
  assert.equal((await classifySpeaker({...segment,videoId},deps)).label,'female');
  assert.equal((await classifySpeaker({...segment,videoId,start:0},deps)).label,'unknown');
  assert.equal((await classifySpeaker({videoId,start:0,end:3,allowDownload:false,label:'female'},deps)).label,'unknown');
});

test('caption normalization, expansion and chunking retain speaker keys and never join turns', async () => {
  const source=await readFile('extension/content.js','utf8');
  const context=vm.createContext({state:{videoId:'abcdefghijk'},cleanCaptionText:x=>x,roundTime:x=>x});
  vm.runInContext(source.slice(source.indexOf('  function mergeTimedSegments('),source.indexOf('  function pickCaptionTrack(')),context);
  vm.runInContext(source.slice(source.indexOf('  function chunkSegments('),source.indexOf('  function selectChunksForWindow(')),context);
  const input=[{start:0,end:1,text:'Male',speakerKey:'key-one'},{start:1,end:2,text:'Female',speakerKey:'key-two'}];
  const normalized=context.normalizePreprocessSegments(input);
  const merged=context.mergeTimedSegments(normalized.slice(0,1),normalized.slice(1));
  const chunks=context.chunkSegments(merged);
  assert.equal(chunks.length,2);assert.equal(chunks[0].speakerKey,'key-one');assert.equal(chunks[1].speakerKey,'key-two');
});
