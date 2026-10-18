import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { publicIPv4, resolvePublicMediaUrl, extractVideoUrls, byteRange } from '../backend/public-media.js';
import { createMediaRouter } from '../backend/media-router.js';
import { LocalDubPlayer } from '../backend/player-engine.js';

test('remote imports reject private/reserved destinations, credentials, ports and mixed DNS', async()=>{
  for(const ip of ['0.0.0.0','10.2.3.4','127.0.0.1','169.254.169.254','172.31.0.1','192.168.1.1','100.64.1.1','198.18.0.1','224.0.0.1','::1']) assert.equal(publicIPv4(ip),false,ip);
  assert.equal(publicIPv4('93.184.216.34'),true);
  for(const url of ['http://example.org/a.mp4','https://127.1/a.mp4','https://[::1]/x','https://name:secret@example.org/a.mp4','https://example.org:444/a.mp4']) await assert.rejects(resolvePublicMediaUrl(url));
  await assert.rejects(resolvePublicMediaUrl('https://example.org/a.mp4',async()=>[{address:'93.184.216.34'},{address:'10.0.0.1'}]));
  assert.equal((await resolvePublicMediaUrl('https://example.org/a.mp4',async()=>[{address:'93.184.216.34'}])).address,'93.184.216.34');
});
test('HTML video discovery resolves sources and rejects blob/non-MP4; range supports seeking',()=>{
  assert.deepEqual(extractVideoUrls('<video src="/one.mp4"></video><video><source src="https://cdn.example/two.mp4?a=1&amp;b=2"></video><video src="blob:xyz">','https://example.org/page'),['https://example.org/one.mp4','https://cdn.example/two.mp4?a=1&b=2']);
  assert.deepEqual(byteRange('bytes=10-19',100),{start:10,end:19,partial:true});
  assert.deepEqual(byteRange('bytes=-10',100),{start:90,end:99,partial:true});
  assert.deepEqual(byteRange('bytes=90-',100),{start:90,end:99,partial:true});
  for(const range of ['bytes=100-','bytes=30-20','bytes=-0','bytes=0-1,4-5','bad']) assert.equal(byteRange(range,100),null);
});
test('media HTTP contract: upload, range, public HTML import, cancellation and same-origin authorization',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'dub-media-fixture-'));
  let calls=0,transcriptions=0,remote=[];
  const route=createMediaRouter({root,
    command:async exe=>exe==='ffprobe'?JSON.stringify({format:{format_name:'mov,mp4',duration:65},streams:[{codec_type:'video'},{codec_type:'audio'}]}):'',
    transcribe:async()=>{transcriptions++;return{segments:[{start:1,end:5,text:'First.'},{start:32,end:36,text:'Second.'}]};},
    prepare:async body=>{calls++;assert.equal(body.settings.speed,1.15);return{segments:body.segments.map(s=>({...s,audioUrl:'http://127.0.0.1/audio/abc.wav',speechSpeed:1.15}))};},
    openRemote:async value=>{remote.push(value);const html=value.endsWith('/page') || value.endsWith('/multi');const response=Readable.from(value.endsWith('/multi')?'<video src="/one.mp4"></video><source src="/two.mp4">':html?'<video src="/clip.mp4"></video>':'FAKE_MP4');response.headers={'content-type':html?'text/html':'video/mp4'};return{response,url:new URL(value)};}
  });
  const server=createServer(async(req,res)=>{try{if(!await route(req,res,new URL(req.url,`http://${req.headers.host}`))){res.writeHead(404);res.end();}}catch(e){res.writeHead(e.statusCode||500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(base+'/api/media/session',{headers:{origin:'https://evil.test'}})).status,403);
    const badHostStatus=await new Promise((resolve,reject)=>{get(base+'/api/media/session',{headers:{host:'evil.test'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);});
    assert.equal(badHostStatus,403);
    const {token}=await(await fetch(base+'/api/media/session')).json();
    const headers={authorization:`Bearer ${token}`};
    assert.equal((await fetch(base+'/api/media/upload',{method:'POST',body:'bad'})).status,401);
    const media=await(await fetch(base+'/api/media/upload?name=own.mp4',{method:'POST',headers,body:'FAKE_MP4'})).json();
    assert.equal(media.source,'file');
    const range=await fetch(`${base}/api/media/${media.id}/file`,{headers:{...headers,range:'bytes=2-5'}});
    assert.equal(range.status,206);assert.equal(await range.text(),'KE_M');assert.equal(range.headers.get('content-range'),'bytes 2-5/8');
    const prepare=async(start,runId='fixture-run-123')=>fetch(`${base}/api/media/${media.id}/prepare`,{method:'POST',headers,body:JSON.stringify({start,runId})});
    assert.equal((await(await prepare(0)).json()).segments[0].speechSpeed,1.15);
    await prepare(0);assert.equal(calls,1);assert.equal(transcriptions,1);
    await fetch(base+'/api/media/cancel',{method:'POST',headers,body:JSON.stringify({runId:'cancelled-run'})});
    assert.equal((await prepare(30,'cancelled-run')).status,409);assert.equal(calls,1);
    assert.equal((await(await prepare(30)).json()).segments[0].index,1);
    const web=await(await fetch(base+'/api/media/import',{method:'POST',headers,body:JSON.stringify({url:'https://example.org/page'})})).json();
    assert.equal(web.source,'web');assert.deepEqual(remote,['https://example.org/page','https://example.org/clip.mp4']);
    const choices=await(await fetch(base+'/api/media/import',{method:'POST',headers,body:JSON.stringify({url:'https://example.org/multi'})})).json();
    assert.deepEqual(choices.candidates,['https://example.org/one.mp4','https://example.org/two.mp4']);
    assert.equal(remote.at(-1),'https://example.org/multi');
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
});

class Media extends EventTarget {
  constructor(){super();this.paused=true;this.currentTime=0;this.volume=.8;this.muted=false;this.ended=false;this.playbackRate=1;}
  play(){this.paused=false;this.dispatchEvent(new Event('play'));return Promise.resolve();}
  pause(){if(!this.paused){this.paused=true;this.dispatchEvent(new Event('pause'));}}
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
const clip=(index,start,end,duration=end-start)=>({index,start,end,duration,audioUrl:'local',sourceText:'Original',translatedText:'한국어',speechSpeed:1.15});
function fixture(prepare){
  const video=new Media(),audios=[],states=[];
  const engine=new LocalDubPlayer(video,{prepare,audio:async()=>new Blob(['wav']),cancel:async()=>{}},s=>states.push(s),()=>{const audio=new Media();audios.push(audio);return audio;});
  clearInterval(engine.timer);engine.setMedia({id:'fixture',duration:90});
  return{engine,video,audios,states};
}
test('cold start holds video until real window audio arrives; 1.15 is not applied twice',async()=>{
  let resolve;const f=fixture(()=>new Promise(r=>{resolve=r;}));
  try{f.engine.start();assert.equal(f.video.paused,true);resolve({start:0,end:30,segments:[clip(0,0,5)]});await settle();assert.equal(f.video.paused,false);assert.equal(f.audios.length,1);assert.equal(f.audios[0].playbackRate,1);assert.equal(f.states.at(-1).speechSpeed,1.15);}finally{f.engine.dispose();}
});
test('stop during prepare ignores late result and restores original volume',async()=>{
  let resolve;const f=fixture(()=>new Promise(r=>{resolve=r;}));
  try{f.engine.start();assert.ok(Math.abs(f.video.volume-.16)<1e-10);f.engine.stop();resolve({start:0,end:30,segments:[clip(0,0,5)]});await settle();assert.equal(f.audios.length,0);assert.equal(f.video.volume,.8);assert.equal(f.engine.active,false);assert.equal(f.engine.windows.size,0);}finally{f.engine.dispose();}
});
test('seek cancels old playback and rejects old prepare while new position resumes',async()=>{
  const pending=[];const f=fixture((_id,start)=>new Promise(resolve=>pending.push({start,resolve})));
  try{f.engine.start();f.video.currentTime=32;f.video.dispatchEvent(new Event('seeking'));assert.deepEqual(pending.map(p=>p.start),[0,30]);pending[0].resolve({start:0,end:30,segments:[clip(0,0,5)]});await settle();assert.equal(f.audios.length,0);pending[1].resolve({start:30,end:60,segments:[clip(1,32,38)]});await settle();assert.equal(f.audios.length,1);assert.equal(f.engine.voice.clip.index,1);assert.equal(f.video.paused,false);}finally{f.engine.dispose();}
});
test('pause stops both clocks; resume and tail hold finish the last syllable',async()=>{
  const f=fixture(async()=>({start:0,end:30,segments:[clip(0,0,5,7)]}));
  try{f.engine.start();await settle();f.engine.pause();assert.equal(f.video.paused,true);assert.equal(f.audios[0].paused,true);f.engine.start();assert.equal(f.video.paused,false);assert.equal(f.audios[0].paused,false);f.video.currentTime=5;f.engine.tick();assert.equal(f.video.paused,true);assert.equal(f.audios[0].paused,false);assert.equal(f.engine.status,'tail');f.audios[0].onended();assert.equal(f.video.paused,false);assert.equal(f.engine.completed.has(0),true);}finally{f.engine.dispose();}
});
test('missing next buffer holds once and resumes; seek back after restart replays speech',async()=>{
  let next;const f=fixture(async(_id,start)=>start===0?{start:0,end:30,segments:[clip(0,0,5)]}:new Promise(resolve=>{next=resolve;}));
  try{f.engine.start();await settle();f.audios[0].onended();f.video.currentTime=30;f.engine.tick();assert.equal(f.video.paused,true);assert.equal(f.engine.stats.bufferWaits,1);f.engine.tick();assert.equal(f.engine.stats.bufferWaits,1);next({start:30,end:60,segments:[clip(1,30,35)]});await settle();assert.equal(f.video.paused,false);f.engine.stop();f.engine.start();f.video.currentTime=0;f.video.dispatchEvent(new Event('seeking'));assert.equal(f.engine.voice.clip.index,0);assert.equal(f.engine.stats.seeks,1);}finally{f.engine.dispose();}
});

test('source buffering pauses speech and cannot override a user pause',async()=>{
  const f=fixture(async()=>({start:0,end:30,segments:[clip(0,0,5)]}));
  try{f.engine.start();await settle();f.video.readyState=2;f.video.dispatchEvent(new Event('waiting'));assert.equal(f.audios[0].paused,true);assert.equal(f.engine.status,'source-buffering');f.engine.pause();f.video.readyState=4;f.video.dispatchEvent(new Event('canplay'));assert.equal(f.audios[0].paused,true);assert.equal(f.video.paused,true);f.engine.start();assert.equal(f.audios[0].paused,false);}finally{f.engine.dispose();}
});
test('video end waits for remaining speech, then ends without replaying it',async()=>{
  const f=fixture(async()=>({start:0,end:30,segments:[clip(0,0,5,7)]}));
  try{f.engine.start();await settle();f.video.ended=true;f.engine.tick();assert.equal(f.engine.status,'tail');assert.equal(f.audios[0].paused,false);f.audios[0].onended();assert.equal(f.engine.status,'ended');assert.equal(f.engine.active,false);assert.equal(f.audios.length,1);}finally{f.engine.dispose();}
});

test('late play rejection from a resumed old voice cannot stop a new seek',async()=>{
  const f=fixture(async()=>({start:0,end:30,segments:[clip(0,0,5),clip(1,10,15)]}));
  try{f.engine.start();await settle();f.engine.pause();let rejectOld;f.audios[0].play=()=>new Promise((_resolve,reject)=>{rejectOld=reject;});f.engine.start();f.video.currentTime=10;f.video.dispatchEvent(new Event('seeking'));rejectOld(new Error('old playback was interrupted'));await settle();assert.equal(f.engine.active,true);assert.equal(f.engine.voice.clip.index,1);assert.equal(f.engine.status,'playing');}finally{f.engine.dispose();}
});
test('media play AbortError during pause is expected and preserves resumable playback',async()=>{
  const f=fixture(async()=>({start:0,end:30,segments:[clip(0,0,5)]}));
  try{f.engine.start();await settle();f.engine.pause();f.audios[0].play=()=>Promise.reject(Object.assign(new Error('interrupted'),{name:'AbortError'}));f.engine.start();f.engine.pause();await settle();assert.equal(f.engine.active,true);assert.equal(f.engine.status,'paused');assert.equal(f.engine.lastError,'');}finally{f.engine.dispose();}
});
