import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
const constants=source.match(/const (PREPARE_LEAD_SECONDS|PREPARE_RETRY_DELAY_MS|PREPARE_ATTEMPTS_PER_CLIP|MAX_CONSECUTIVE_PREPARE_FAILURES) = [^;]+;/g).join('\n');
const code=source.slice(source.indexOf('  function resetClipRecovery()'),source.indexOf('  async function prepareAndAppendChunks('))
  +source.slice(source.indexOf('  function degradedNotice()'),source.indexOf('  function cleanCaptionText('));
function fixture() {
  const state={running:true,metrics:{fallbackClips:0,skippedClips:0},preparedChunkIndexes:new Set([0]),
    chunks:[{index:0,start:0,end:3},{index:1,start:3,end:6},{index:2,start:6,end:9}]};
  const context=vm.createContext({state,Date});
  vm.runInContext(constants.replaceAll('const ','var ')+'\n'+code+'\nresetClipRecovery();',context);
  return {context,state};
}
const transient=Object.assign(new Error('OpenAI voice connection failed (ETIMEDOUT).'),{retryable:true});
test('a transient failure retries the clip once, then leaves it to the original audio', () => {
  const {context,state}=fixture();
  assert.equal(context.recoverFailedClip(state.chunks,transient),'retry');
  assert.ok(state.prepareRetryAt>Date.now()); assert.equal(state.skippedChunkIndexes.size,0);
  assert.equal(context.recoverFailedClip(state.chunks,transient),'skip');
  assert.deepEqual([...state.skippedChunkIndexes],[1]); assert.equal(state.metrics.skippedClips,1);
  assert.equal(context.isChunkCovered(1),true);
  // Playback treats the skipped clip as a caption gap instead of waiting for its audio.
  assert.equal(context.hasDubbedCaptionAt(4),false); assert.equal(context.isSkippedClipAt(4),true);
  assert.equal(context.hasDubbedCaptionAt(7),true);
});
test('key, quota or setup errors still stop the dub instead of skipping clips', () => {
  const {context,state}=fixture();
  assert.equal(context.recoverFailedClip(state.chunks,Object.assign(new Error('OpenAI voice rejected the API key'),{retryable:false})),'');
  assert.equal(state.skippedChunkIndexes.size,0);
});
test('a lasting outage stops after a bounded number of consecutive failures', () => {
  const {context,state}=fixture();
  state.chunks=Array.from({length:20},(_,index)=>({index,start:index*3,end:index*3+3}));
  const results=Array.from({length:7},()=>context.recoverFailedClip(state.chunks,new Error('Failed to fetch')));
  assert.deepEqual(results,['retry','skip','retry','skip','retry','skip','']);
});
test('fallback and skipped clips show a notice only while the dub is running', () => {
  const {context,state}=fixture();
  assert.equal(context.degradedNotice(),'');
  state.metrics.fallbackClips=2; state.metrics.skippedClips=1;
  assert.match(context.degradedNotice(),/로컬 엔진 2개 · 원음 1개/);
  state.running=false; assert.equal(context.degradedNotice(),'');
});
