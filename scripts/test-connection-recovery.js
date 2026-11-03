import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  function hasRuntimeConnection()'),source.indexOf('  async function fetchAudioDataUrl('));
function fixture(send=async()=>({ok:true})) {
 const calls={send:0,stop:0,reload:0,start:0,seek:[],timers:[]};const storage=new Map();
 const state={connectionLost:false,recoveryReloading:false,recoveryResume:null,videoId:'abcdefghijk',video:{readyState:1,duration:600,pause(){this.paused=true;}},running:true};
 const els={panel:{dataset:{mode:'local'}},start:{},test:{},voice:{value:'cedar',options:[{value:'auto'},{value:'cedar'}]},lang:{value:'ko'},volume:{value:'7'},volumeLabel:{}};
 const runtime={id:'extension',sendMessage:async message=>{calls.send++;return send(message);}};
 const context=vm.createContext({chrome:{runtime},state,els,Date,console,document:{querySelector:()=>state.video},
  stopDub:()=>{calls.stop++;state.running=false;},setStatus:s=>{state.status=s;},updateMeta(){},renderPlaybackDiagnostics(){},
  getVideoId:()=> 'abcdefghijk',getVideoTime:()=>123.45,savePanelVisible(){},
  window:{location:{reload(){calls.reload++;}}},sessionStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k),removeItem:k=>storage.delete(k)},
  seekVideo:x=>calls.seek.push(x),startDub:()=>calls.start++,setTimeout:fn=>calls.timers.push(fn),
 });vm.runInContext(code,context);return {context,calls,state,els,runtime,storage};
}
test('invalid context blocks all further messages and retires playback exactly once',async()=>{
 const f=fixture();f.runtime.id=undefined;
 await assert.rejects(f.context.sendRuntimeMessage({type:'YLD_PREPARE_DUB'}),/연결 복구/);
 await assert.rejects(f.context.sendRuntimeMessage({type:'YLD_PREPARE_DUB'}),/연결 복구/);
 assert.equal(f.calls.send,0);assert.equal(f.calls.stop,1);assert.equal(f.els.start.textContent,'연결 복구');assert.equal(f.els.test.disabled,true);
});
test('closed channel does not retry a potentially paid request',async()=>{
 const f=fixture(async()=>{throw Error('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received');});
 await assert.rejects(f.context.sendRuntimeMessage({type:'YLD_PREPARE_DUB'}),/연결 복구/);
 assert.equal(f.calls.send,1);assert.equal(f.calls.stop,1);assert.equal(f.calls.reload,0);
});
test('normal API errors stay visible and do not trigger page recovery',async()=>{
 const f=fixture(async()=>({ok:false,error:'OpenAI text API returned HTTP 429'}));
 assert.match((await f.context.sendRuntimeMessage({})).error,/429/);assert.equal(f.calls.stop,0);
 const g=fixture(async()=>{throw Error('ordinary failure');});await assert.rejects(g.context.sendRuntimeMessage({}),/ordinary failure/);assert.equal(g.calls.stop,0);
});
test('explicit recovery saves position/settings and reloads only once even on double click',()=>{
 const f=fixture();f.context.recoverConnection();f.context.recoverConnection();assert.equal(f.calls.reload,1);
 const saved=JSON.parse(f.storage.get('yld-connection-recovery'));assert.equal(saved.time,123.45);assert.equal(saved.mode,'local');assert.equal(saved.voice,'cedar');assert.equal(saved.volume,7);
});
test('recovery record is one-shot, bounded in time and scoped to the current video',()=>{
 const f=fixture();f.context.recoverConnection();const record=f.storage.get('yld-connection-recovery');
 assert.equal(f.context.consumeRecovery().time,123.45);assert.equal(f.context.consumeRecovery(),null);
 for(const changes of [{videoId:'other-video'},{savedAt:Date.now()-31000},{savedAt:Date.now()+3000},{time:-1}]){
  f.storage.set('yld-connection-recovery',JSON.stringify({...JSON.parse(record),...changes}));assert.equal(f.context.consumeRecovery(),null);assert.equal(f.storage.size,0);
 }
});
test('metadata wait preserves position and voice, starts once and never reloads automatically',()=>{
 const f=fixture();f.state.recoveryResume={videoId:'abcdefghijk',savedAt:Date.now(),time:123.45,voice:'auto',lang:'ja',volume:7};
 f.state.video.readyState=0;f.context.resumeAfterRecovery();assert.equal(f.calls.timers.length,0);
 f.state.video.readyState=1;f.context.resumeAfterRecovery();f.context.resumeAfterRecovery();
 assert.deepEqual(f.calls.seek,[123.45]);assert.equal(f.els.voice.value,'auto');assert.equal(f.els.lang.value,'ja');assert.equal(f.els.volume.value,'7');
 f.calls.timers.forEach(fn=>fn());assert.equal(f.calls.start,1);assert.equal(f.calls.reload,0);assert.equal(f.state.recoveryResume,null);
});
test('disconnect while waiting for recovery metadata cancels pending resume',()=>{
 const f=fixture();f.state.recoveryResume={};f.context.markConnectionLost();assert.equal(f.state.recoveryResume,null);
});

test('automatic recovery resume cannot reload again if the runtime disappears before Start',async()=>{
 const f=fixture();
 const start=source.slice(source.indexOf('  async function startDub('),source.indexOf('  function pauseVideoForPrepareIfNeeded('));
 vm.runInContext(start,f.context);
 f.runtime.id=undefined;
 await f.context.startDub({recover:false});
 assert.equal(f.calls.reload,0);assert.equal(f.state.connectionLost,true);
});

test('opening a stale panel restores position but does not start paid dubbing',()=>{
 const f=fixture();f.state.recoveryResume={videoId:'abcdefghijk',savedAt:Date.now(),time:20,autoStart:false};
 f.context.resumeAfterRecovery();assert.deepEqual(f.calls.seek,[20]);assert.equal(f.calls.timers.length,0);assert.equal(f.calls.start,0);
});

test('Stop retires a scheduled recovery start before its callback runs',()=>{
 const f=fixture();f.state.sessionId=12;
 f.state.recoveryResume={videoId:'abcdefghijk',savedAt:Date.now(),time:123.45,voice:'auto',lang:'ko',volume:7};
 f.context.resumeAfterRecovery();assert.equal(f.calls.timers.length,1);
 f.state.sessionId++; // stopDub retires this exact session before deferred callback
 f.calls.timers.forEach(fn=>fn());assert.equal(f.calls.start,0);
});
