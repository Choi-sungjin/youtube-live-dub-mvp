import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
const start=source.indexOf('async function prepareDub('),end=source.indexOf('async function fetchAudio(',start);
function fixture(events) {
 const sent=[];
 const wire=new TextEncoder().encode(events.map(event=>JSON.stringify(event)+'\n').join(''));
 const body=new ReadableStream({start(controller){for(let i=0;i<wire.length;i+=7)controller.enqueue(wire.slice(i,i+7));controller.close();}});
 const ctx=vm.createContext({AbortSignal,TextDecoder,Uint8Array,
   normalizeBackendUrl:()=> 'http://127.0.0.1:18789',
   fetch:async()=>({ok:true,headers:new Headers({'content-type':'application/x-ndjson'}),body}),
   chrome:{runtime:{id:'extension'},tabs:{sendMessage:async(tab,message,options)=>{sent.push({tab,message,options});}}}});
 vm.runInContext(source.slice(start,end),ctx);
 return {sent,run:()=>ctx.prepareDub({stream:true,requestId:'request'}, {id:'extension',tab:{id:42},frameId:0,documentId:'original-document'})};
}
test('fragmented prepared segments reach only their requesting document before the final result',async()=>{
 const f=fixture([{type:'segment',item:{index:1,translatedText:'한국어'}},{type:'done',result:{segments:[{index:1}]}}]);
 const result=await f.run();assert.equal(result.segments.length,1);assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].tab,42);assert.equal(f.sent[0].options.documentId,'original-document');
 assert.equal(f.sent[0].message.requestId,'request');assert.equal(f.sent[0].message.item.translatedText,'한국어');
});
test('unfinished or failed preparation streams cannot report success',async()=>{
 await assert.rejects(fixture([{type:'segment',item:{index:0}}]).run(),/Incomplete/);
 await assert.rejects(fixture([{type:'error',error:'provider failure'}]).run(),/provider failure/);
});
