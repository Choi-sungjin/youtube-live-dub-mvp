import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { createApiSettingsHandler, loadPanelApiKey } from '../backend/api-settings.js';
const fixtureKey = 'sk-fixture-only-not-a-real-api-key';
const request = (body, headers = {}) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
  method: 'POST', headers: { host: '127.0.0.1:18789', 'content-type': 'application/json', 'x-yld-settings': '1', ...headers }
});

test('panel key save and deletion persist across restart without returning the secret', async () => {
 const dir=await mkdtemp(path.join(tmpdir(),'yld-keys-'));
 try {
  const filename=path.join(dir,'.env.panel.local'),env={}; let tests=0;
  const handler=createApiSettingsHandler({filename,env,testConnection:async()=>{tests++;return {ok:true};}});
  assert.deepEqual(await handler(request({action:'status'})),{configured:false});
  const saved=await handler(request({action:'save',key:fixtureKey}));
  assert.equal(saved.configured,true); assert.ok(!JSON.stringify(saved).includes(fixtureKey));
  assert.equal(env.OPENAI_API_KEY,fixtureKey);
  if(process.platform!=='win32') assert.equal((await stat(filename)).mode & 0o777,0o600);
  const restarted={OPENAI_API_KEY:'old-env-key'};await loadPanelApiKey(filename,restarted);
  assert.equal(restarted.OPENAI_API_KEY,fixtureKey);
  assert.deepEqual(await handler(request({action:'test'})),{ok:true});assert.equal(tests,1);
  await handler(request({action:'delete'}));await loadPanelApiKey(filename,restarted);
  assert.equal(restarted.OPENAI_API_KEY,'');assert.equal(env.OPENAI_API_KEY,'');
  assert.ok(!(await readFile(filename,'utf8')).includes(fixtureKey));
  await assert.rejects(handler(request({action:'test'})),/먼저 저장/);assert.equal(tests,1);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('web origins, rebinding hosts, invalid/oversized keys cannot change API settings',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'yld-keys-'));
 try {
  const env={},handler=createApiSettingsHandler({filename:path.join(dir,'.env.panel.local'),env,testConnection:async()=>{throw Error('must not run');}});
  for(const headers of [{origin:'https://www.youtube.com'},{origin:'null'},{host:'evil.example:18789'},{'x-yld-settings':''},{'content-type':'text/plain'}])
   await assert.rejects(handler(request({action:'save',key:fixtureKey},headers)),/API 설정/);
  for(const key of ['bad','sk-validbut\nOPENAI_MODEL=evil','sk-'+ 'a'.repeat(501)]) await assert.rejects(handler(request({action:'save',key})),/형식/);
  await assert.rejects(handler(request({action:'save',key:'a'.repeat(5000)})),/너무/);
  assert.equal(env.OPENAI_API_KEY,undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('in-flight API test prevents key rotation and releases lock after failure',async()=>{
 let rejectTest,started;const pending=new Promise(resolve=>{started=resolve;});
 const handler=createApiSettingsHandler({filename:'unused',env:{OPENAI_API_KEY:fixtureKey},testConnection:()=>{started();return new Promise((_,reject)=>{rejectTest=reject;});}});
 const running=handler(request({action:'test'}));await pending;
 await assert.rejects(handler(request({action:'delete'})),/진행 중/);
 rejectTest(new Error('fixture API rejected'));await assert.rejects(running,/fixture API rejected/);
 assert.equal((await handler(request({action:'status'}))).configured,true);
});

test('only the extension-owned key popup may forward key operations to loopback',async()=>{
 const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
 const id='abcdefghijklmnopabcdefghijklmnop';let calls=0;
 const context=vm.createContext({URL,AbortSignal,chrome:{runtime:{id,onMessage:{addListener(){}}}},importScripts(){},
  fetch:async()=>{calls++;return new Response('{"configured":true}',{headers:{'content-type':'application/json'}});}});
 vm.runInContext(source,context);
 const sender={id,url:`chrome-extension://${id}/api-settings.html`};
 const payload={action:'save',key:fixtureKey,backendUrl:'http://127.0.0.1:18789'};
 assert.equal((await context.apiSettingsRequest(payload,sender)).configured,true);
 for(const other of [{...sender,url:'https://www.youtube.com/watch?v=abc'},{...sender,id:'other'},{...sender,url:`chrome-extension://${id}/popup.html`},{...sender,url:'chrome-extension://other/api-settings.html'}])
  await assert.rejects(context.apiSettingsRequest(payload,other));
 await assert.rejects(context.apiSettingsRequest({...payload,backendUrl:'https://example.vercel.app'},sender));
 assert.equal(calls,1);
});
