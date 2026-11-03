import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../extension/panel-action.js',import.meta.url),'utf8');
function fixture(replies=[{ok:true,payload:{version:'0.8.4'}}]){
 const calls={messages:[],scripts:[],css:0,reloads:[],created:[],badge:[]};let handler;
 const c=vm.createContext({URL,chrome:{
  commands:{onCommand:{addListener:()=>{}}},
  runtime:{getManifest:()=>({version:'0.8.4'}),getURL:p=>'chrome-extension://fixture/'+p},
  action:{onClicked:{addListener:f=>handler=f},setBadgeText:async x=>calls.badge.push(x),setTitle:async()=>{}},
  tabs:{sendMessage:async(id,message)=>{calls.messages.push(message);const r=replies[Math.min(calls.messages.length-1,replies.length-1)];if(r instanceof Error)throw r;return r;},reload:async id=>calls.reloads.push(id),create:async x=>calls.created.push(x)},
  scripting:{insertCSS:async()=>calls.css++,executeScript:async x=>calls.scripts.push(x)},
 }});vm.runInContext(code,c);return{c,calls,handler};
}
const tab={id:7,url:'https://www.youtube.com/watch?v=abcdefghijk'};
test('toolbar action shows and focuses the existing panel with no popup or page reload',async()=>{
 const f=fixture();await f.c.openPanelFromAction(tab);assert.equal(f.calls.messages[0].type,'YLD_PANEL_SHOW');assert.equal(f.calls.messages.length,1);assert.equal(f.calls.scripts.length,0);assert.equal(f.calls.created.length,0);assert.equal(f.calls.reloads.length,0);
});
test('missing content script is injected once then shown',async()=>{
 const f=fixture([Error('Receiving end does not exist'),{ok:true,payload:{version:'0.8.4'}}]);await f.c.openPanelFromAction(tab);assert.equal(f.calls.css,1);assert.equal(f.calls.scripts[0].files[0],'content.js');assert.equal(f.calls.messages.length,2);assert.equal(f.calls.reloads.length,0);
});
test('stale context recovers once through the explicit action and never requests dubbing',async()=>{
 const f=fixture([Error('no receiver')]);await Promise.all([f.c.openPanelFromAction(tab),f.c.openPanelFromAction(tab)]);assert.equal(f.calls.reloads.length,1);assert.equal(f.calls.scripts.length,2);assert.equal(f.calls.scripts[1].func.name,'savePanelReloadPosition');assert.ok(f.calls.messages.every(x=>x.type==='YLD_PANEL_SHOW'));
});
test('non-YouTube pages keep the existing tools and their source tab',async()=>{
 const f=fixture();await f.c.openPanelFromAction({id:8,url:'https://example.com/video'});assert.match(f.calls.created[0].url,/popup.html\?sourceTab=8$/);assert.equal(f.calls.scripts.length,0);
});
test('manifest panel shortcut is separate from toolbar action and remappable',()=>{
 const m=JSON.parse(readFileSync(new URL('../extension/manifest.json',import.meta.url)));assert.equal(m.action.default_popup,undefined);assert.equal(m.commands['yld-panel'].suggested_key.default,'Alt+Shift+Y');
});

test('start/stop commands target only current YouTube video with a matching version', async()=>{
 for (const [command,type] of [['yld-start','YLD_DUB_START'],['yld-stop','YLD_DUB_STOP']]) {
  const f=fixture(); await f.c.runDubbingCommand(command,tab);
  assert.deepEqual(f.calls.messages.map(m=>m.type),['YLD_PANEL_STATUS',type]);
 }
 const f=fixture(); await f.c.runDubbingCommand('yld-start',{id:8,url:'https://example.com/watch'});
 await f.c.runDubbingCommand('unknown',tab);assert.equal(f.calls.messages.length,0);
});
test('stale stop never reloads; failed start is never retried as a dubbing command',async()=>{
 const f=fixture([Error('no receiver')]);await f.c.runDubbingCommand('yld-stop',tab);assert.equal(f.calls.reloads.length,0);
 const g=fixture([{ok:true,payload:{version:'0.8.4'}},Error('reply lost')]);await g.c.runDubbingCommand('yld-start',tab);
 assert.equal(g.calls.messages.filter(m=>m.type==='YLD_DUB_START').length,1);
 assert.ok(g.calls.messages.slice(2).every(m=>m.type==='YLD_PANEL_SHOW'));
});
test('start/stop defaults are separate, valid, and available for Chrome remapping',()=>{
 const m=JSON.parse(readFileSync(new URL('../extension/manifest.json',import.meta.url)));
 assert.equal(m.commands['yld-start'].suggested_key.default,'Alt+Shift+S');
 assert.equal(m.commands['yld-stop'].suggested_key.default,'Alt+Shift+D');
});
const content=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
test('content command ignores repeated start, handles repeated stop without starting work',()=>{
 let starts=0,stops=0;const state={running:false};const c=vm.createContext({state,els:{start:{disabled:false}},
 setPanelVisible(){},startDub(){starts++;state.running=true;},stopDub(){stops++;state.running=false;},panelStatusPayload:()=>({}),ensurePanel(){}});
 vm.runInContext(content.slice(content.indexOf('  function handleRuntimeMessage('),content.indexOf('  function setPanelVisible(')),c);
 const send=type=>c.handleRuntimeMessage({type},null,r=>assert.equal(r.ok,true));
 send('YLD_DUB_START');send('YLD_DUB_START');assert.equal(starts,1);
 send('YLD_DUB_STOP');send('YLD_DUB_STOP');assert.equal(stops,2);
 send('YLD_DUB_START');assert.equal(starts,2);
});
test('shortcut labels use current assignments including unassigned commands',async()=>{
 const display={};const c=vm.createContext({els:{panel:{querySelector:()=>display}},sendRuntimeMessage:async()=>({ok:true,payload:[{name:'yld-start',shortcut:'Ctrl+Shift+S'},{name:'yld-stop',shortcut:''}]})});
 vm.runInContext(content.slice(content.indexOf('  async function refreshShortcuts('),content.indexOf('  function handleRuntimeMessage(')),c);
 await c.refreshShortcuts();assert.equal(display.textContent,'패널: 미지정 · 시작: Ctrl+Shift+S · 정지: 미지정');
});

test('Stop supersedes an earlier Start whose status reply arrives late',async()=>{
 const f=fixture();let resolveStart;const delivered=[];let statusCount=0;
 f.c.chrome.tabs.sendMessage=async(id,message)=>{
  if(message.type==='YLD_PANEL_STATUS'){
   if(++statusCount===1) return new Promise(resolve=>{resolveStart=resolve;});
   return {ok:true,payload:{version:'0.8.4'}};
  }
  delivered.push(message.type);return {ok:true};
 };
 const pending=f.c.runDubbingCommand('yld-start',tab);
 await f.c.runDubbingCommand('yld-stop',tab);
 resolveStart({ok:true,payload:{version:'0.8.4'}});await pending;
 assert.deepEqual(delivered,['YLD_DUB_STOP']);
});

test('panel shortcut toggles twice in order without starting or stopping dubbing',async()=>{
 const f=fixture();await Promise.all([f.c.runDubbingCommand('yld-panel',tab),f.c.runDubbingCommand('yld-panel',tab)]);
 assert.deepEqual(f.calls.messages.map(m=>m.type),['YLD_PANEL_STATUS','YLD_PANEL_TOGGLE','YLD_PANEL_STATUS','YLD_PANEL_TOGGLE']);
 assert.equal(f.calls.reloads.length,0);
});
