import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile('extension/background.js','utf8');
const code=source.slice(source.indexOf('async function transcribeCapture('),source.indexOf('function localSettingsBackend('));
function fixture(live='https://www.youtube.com/watch?v=abcdefghijk', overrides={}) {
  let calls=0, target;
  const ctx=vm.createContext({URL,AbortSignal,chrome:{runtime:{id:'own'},scripting:{executeScript:async request=>{
    target=request.target;return [{documentId:'doc',frameId:0,result:live,...overrides}];
  }}},normalizeBackendUrl:x=>x,readJsonResponse:async()=>({ok:true}),fetch:async()=>{calls++;return {};}});
  vm.runInContext(code,ctx);
  return {run:ctx.transcribeCapture,calls:()=>calls,target:()=>target};
}
const payload={backendUrl:'http://127.0.0.1:18789',videoId:'abcdefghijk',audio:'AAAA'};
const sender={id:'own',tab:{id:42},frameId:0,documentId:'doc',url:'https://www.youtube.com/watch?v=oldvideo001'};
test('capture accepts the current document video after a YouTube SPA navigation',async()=>{
  const f=fixture();await f.run(payload,sender);assert.equal(f.calls(),1);
  assert.equal(f.target().tabId,42);assert.equal(f.target().documentIds[0],'doc');
});
test('capture still rejects foreign senders, child frames, stale documents and changed videos',async()=>{
  for(const patch of [{id:'other'},{frameId:1},{documentId:''},{url:'https://evil.test/watch?v=abcdefghijk'}]){
    const f=fixture();await assert.rejects(f.run(payload,{...sender,...patch}));assert.equal(f.calls(),0);
  }
  for(const [url,patch] of [['https://www.youtube.com/watch?v=newvideo001',{}],['https://evil.test/watch?v=abcdefghijk',{}],['https://www.youtube.com/watch?v=abcdefghijk',{documentId:'replaced'}]]){
    const f=fixture(url,patch);await assert.rejects(f.run(payload,sender));assert.equal(f.calls(),0);
  }
});
