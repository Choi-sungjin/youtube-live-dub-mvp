import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../extension/audio-buffer.js',import.meta.url),'utf8');
function fixture() {
  let listener,reply;
  const video={currentSrc:'',closest:()=>null};
  class Buffer {
    buffered={length:1,start:()=>0,end:()=>120};
    appendBuffer(data) {if(this.fail)throw new Error('native failure'); this.last=data;return 42;}
    addEventListener() {}
  }
  class MediaSource {addSourceBuffer(){return new Buffer();}}
  class FakeURL extends URL {static createObjectURL(){return 'blob:fixture';}}
  const window={MediaSource,addEventListener(name,fn){listener=fn;},postMessage(value){reply=value;}};
  const ctx=vm.createContext({window,MediaSource,URL:FakeURL,Uint8Array,DataView,
    location:{href:'https://www.youtube.com/watch?v=NL65Awuv8gU',origin:'https://www.youtube.com'},
    document:{querySelector:()=>video}});
  vm.runInContext(source,ctx);
  const media=new MediaSource();video.currentSrc=FakeURL.createObjectURL(media);
  return {audio:media.addSourceBuffer('audio/webm;codecs=opus'),other:media.addSourceBuffer('video/webm'),video,
    request(overrides={}){reply=null;listener({source:window,data:{source:'YLD_BUFFER_REQUEST',id:'test',videoId:'NL65Awuv8gU',read:true,...overrides}});return reply;}};
}
const init=new Uint8Array([0x1a,0x45,0xdf,0xa3,0x81,0x00,0x00,0x00]);
function cluster(size=16){const data=new Uint8Array(size);data.set([0x1f,0x43,0xb6,0x75,0xff]);return data;}
test('buffer observer preserves native calls, copies audio only, and binds snapshot to current media',()=>{
  const f=fixture();assert.equal(f.audio.appendBuffer(init),42);f.audio.appendBuffer(cluster());
  f.other.appendBuffer(new Uint8Array([9,9,9]));
  const result=f.request();assert.equal(result.available,true);assert.equal(result.audio.byteLength,24);
  assert.equal(new Uint8Array(result.audio)[0],0x1a);
  f.audio.fail=true;assert.throws(()=>f.audio.appendBuffer(cluster()),/native failure/);
  assert.equal(f.request().audio.byteLength,24);
  assert.equal(f.request({videoId:'different'}).available,false);
  f.video.closest=()=>({});assert.equal(f.request().available,false);
});
test('rolling audio retention keeps initialization and a recent decodable cluster under 8 MiB',()=>{
  const f=fixture();f.audio.appendBuffer(init);
  for(let i=0;i<12;i++)f.audio.appendBuffer(cluster(1024*1024));
  const result=f.request();assert.equal(result.available,true);assert.ok(result.audio.byteLength<=8*1024*1024);
  assert.deepEqual(Array.from(new Uint8Array(result.audio).subarray(0,8)),Array.from(init));
  assert.equal(new Uint8Array(result.audio)[8],0x1f);
  assert.equal(result.ranges[0].start,120);
});
test('oversized append preserves playback while disabling unsupported buffer capture',()=>{
  const f=fixture();assert.equal(f.audio.appendBuffer(new Uint8Array(9*1024*1024)),42);
  assert.equal(f.request().available,false);
});

const content=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
test('buffer prefetch runs ahead without pausing video and ignores results after Stop',async()=>{
  let resolveCapture, installed=0, prepare=0;
  const state={running:true,sessionId:1,transcriptExpanding:false,sourceSegments:[{start:50,end:62,text:'current'}],
    bufferedAudioSource:true,bufferedRetryAt:0,bufferedFailures:0,browserAudioSource:false,
    transcriptWindows:[{start:50,end:62}],video:{duration:170,paused:false},chunks:[{start:50,end:62}]};
  const ctx=vm.createContext({state,Date,Math,STT_MAX_DURATION_SECONDS:7200,PREPARE_LEAD_SECONDS:0.18,
    STT_EXTENSION_THRESHOLD_SECONDS:90,isTranscriptKnownAt:()=>true,getKnownTranscriptEndAt:()=>62,
    getLastSegmentEnd:()=>62,isActiveSession:id=>state.running&&id===state.sessionId,
    transcribeBufferedWindow:(_id,start,duration)=>{assert.equal(start,62);assert.equal(duration,24);return new Promise(resolve=>{resolveCapture=resolve;});},
    maybeInstallExpandedSegments:()=>{installed++;},maybePrepareMoreAudio:()=>{prepare++;},getVideoTime:()=>50});
  const start=content.indexOf('  function maybeExpandTranscriptCoverage('),end=content.indexOf('  async function expandTranscriptCoverage(',start);
  vm.runInContext(content.slice(start,end),ctx);
  ctx.maybeExpandTranscriptCoverage(50);
  assert.equal(state.transcriptExpanding,true);assert.equal(state.video.paused,false);
  state.running=false;state.sessionId++;
  resolveCapture([{start:62,end:68,text:'late'}]);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(installed,0);assert.equal(prepare,0);
});
