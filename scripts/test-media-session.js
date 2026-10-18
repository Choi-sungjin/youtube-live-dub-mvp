import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaSession, selectDubbingMode } from '../lib/media-session.js';
const source={origin:'https://example.com/watch?tracking=private',platform:'fixture',mediaId:'video-A',revision:'r1'};
const clip=(id='a',start=0,duration=2)=>({id,start,duration});

test('live capture cannot promise aligned playback or pause capture to wait for its own input',()=>{
  assert.deepEqual(selectDubbingMode({kind:'live',canCapture:true,canPause:true,hasAheadTranscript:true}),{mode:'delayed-commentary',clock:'capture',mayHoldVideo:false});
  assert.equal(selectDubbingMode({kind:'vod',hasAheadTranscript:true,canPause:true}).mode,'aligned-vod');
  assert.equal(selectDubbingMode({kind:'vod',canCapture:true}).mode,'delayed-commentary');
  assert.equal(selectDubbingMode({kind:'text'}).mode,'read-aloud');
  assert.equal(selectDubbingMode({kind:'vod'}).mode,'unsupported');
});

test('seek, reused video elements, and Stop discard late work and release resources',()=>{
  const freed=[],s=createMediaSession({release:item=>freed.push(item.id)});
  const first=s.begin(source); s.accept(first,clip('queued'));
  const sought=s.seek(); assert.equal(first.signal.aborted,true);
  assert.equal(s.accept(first,clip('late')).reason,'stale');
  assert.equal(s.accept(sought,clip('new')).accepted,true);
  const switched=s.begin({...source,mediaId:'video-B'});
  assert.equal(s.take(sought),undefined); assert.equal(sought.signal.aborted,true);
  assert.equal(s.accept(switched,clip('current')).accepted,true);
  s.stop(); assert.equal(s.accept(switched,clip('after-stop')).reason,'stale');
  assert.deepEqual(freed,['queued','late','new','current','after-stop']);
  assert.equal(s.status().queued,0);
});

test('queue is finite and backpressure never evicts earlier ready speech',()=>{
  const s=createMediaSession({maxClips:2,maxSeconds:5}),t=s.begin(source);
  s.accept(t,clip('later',5,2)); s.accept(t,clip('earlier',0,2));
  assert.equal(s.accept(t,clip('overflow',8,1)).reason,'backpressure');
  assert.equal(s.take(t).id,'earlier');
  assert.equal(s.accept(t,clip('long',0,4)).reason,'backpressure');
  assert.equal(s.take(t).id,'later');
});

test('identity excludes tracking query and includes origin, content revision and session signal',()=>{
  const s=createMediaSession(),a=s.begin(source),b=s.begin({...source,revision:'r2'});
  assert.doesNotMatch(a.identity,/private|tracking/); assert.notEqual(a.identity,b.identity);
  assert.equal(s.accept({...b,signal:new AbortController().signal},clip()).reason,'stale');
  assert.throws(()=>s.begin({...source,origin:'http://example.com'}),/HTTPS/);
  assert.throws(()=>s.begin({...source,revision:''}),/identity/);
});

test('a duplicate reference cannot release an audio resource still in the queue',()=>{
  const freed=[],s=createMediaSession({release:item=>freed.push(item)}),t=s.begin(source),a=clip();
  s.accept(t,a); assert.equal(s.accept(t,a).reason,'duplicate'); assert.equal(freed.length,0);
  assert.equal(s.accept({...t,epoch:t.epoch-1},a).reason,'stale'); assert.equal(freed.length,0);
  assert.equal(s.take(t),a);
});

test('caller mutation cannot change queue limits, ordering or duplicate identity',()=>{
  const freed=[],s=createMediaSession({maxClips:3,maxSeconds:5,release:item=>freed.push(item)}),t=s.begin(source);
  const later=clip('later',5,4);
  s.accept(t,later);
  later.duration=0; later.start=-100; later.id='changed';
  assert.equal(s.status().seconds,4);
  assert.equal(s.accept(t,clip('overflow',8,4)).reason,'backpressure');
  assert.equal(s.accept(t,clip('later',8,1)).reason,'duplicate');
  const earlier=clip('earlier',0,1);
  assert.equal(s.accept(t,earlier).accepted,true);
  assert.equal(s.take(t),earlier);
  s.stop();
  assert.equal(freed.at(-1),later);
});
