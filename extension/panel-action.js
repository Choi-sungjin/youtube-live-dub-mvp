// Toolbar always shows the panel; the separate panel shortcut toggles it.
const panelActions = new Map();
chrome.action.onClicked.addListener(tab => {
  openPanelFromAction(tab).catch(async () => {
    await chrome.action.setBadgeText({tabId:tab.id,text:'!'}).catch(()=>{});
    await chrome.action.setTitle({tabId:tab.id,title:'Live Dub: 페이지를 새로고침한 뒤 다시 열어주세요.'}).catch(()=>{});
  });
});

function openPanelFromAction(tab) {
  if (!Number.isInteger(tab?.id)) return Promise.resolve();
  if (panelActions.has(tab.id)) return panelActions.get(tab.id);
  const task = showPanelForTab(tab).finally(() => panelActions.delete(tab.id));
  panelActions.set(tab.id,task);
  return task;
}

async function showPanelForTab(tab) {
  let url;
  try {url=new URL(tab.url);} catch {return;}
  if (url.protocol !== 'https:' || !['youtube.com','www.youtube.com'].includes(url.hostname) || url.pathname !== '/watch') {
    // Keep the existing MP4 / generic-page tools accessible on other pages.
    await chrome.tabs.create({url:chrome.runtime.getURL('popup.html')+`?sourceTab=${tab.id}`});
    return;
  }
  const show = async () => {
    const result=await chrome.tabs.sendMessage(tab.id,{type:'YLD_PANEL_SHOW'});
    if (!result?.ok || result.payload?.version !== chrome.runtime.getManifest().version) throw new Error('Panel needs a fresh page connection');
  };
  try {await show();}
  catch {
    await chrome.scripting.insertCSS({target:{tabId:tab.id},files:['content.css']});
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});
    try {await show();}
    catch {
      // Explicit toolbar action only. Do not resume paid dubbing just to open a panel.
      await chrome.scripting.executeScript({target:{tabId:tab.id},func:savePanelReloadPosition});
      await chrome.tabs.reload(tab.id);
    }
  }
  await chrome.action.setBadgeText({tabId:tab.id,text:''});
  await chrome.action.setTitle({tabId:tab.id,title:'Live Dub 패널 열기'});
}

function savePanelReloadPosition() {
  const panel=document.getElementById('yld-panel');
  const video=document.querySelector('video.html5-main-video') || document.querySelector('video');
  try {
    sessionStorage.setItem('yld-connection-recovery',JSON.stringify({
      videoId:new URL(location.href).searchParams.get('v'),time:Number(video?.currentTime)||0,savedAt:Date.now(),
      mode:panel?.dataset.mode || 'local',voice:panel?.querySelector('[data-yld-voice]')?.value || 'auto',
      playbackSpeed:Number(panel?.querySelector('[data-yld-speed]')?.value)||1,
      lang:panel?.querySelector('[data-yld-lang]')?.value || 'ko',volume:Number(panel?.querySelector('[data-yld-volume]')?.value ?? 35),autoStart:false,
    }));
    localStorage.setItem('yld-panel-visible','true');
  } catch { /* The explicit reload still removes stale content scripts. */ }
}

const panelToggleActions = new Map();
const commandGenerations = new Map();
chrome.commands.onCommand.addListener((command, tab) => {
  runDubbingCommand(command, tab).catch(() => {});
});

async function runDubbingCommand(command, tab) {
  if (!['yld-panel', 'yld-start', 'yld-stop'].includes(command)) return;
  if (!tab) [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  if (!Number.isInteger(tab?.id)) return;
  let url;
  try { url = new URL(tab.url); } catch { return; }
  if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com'].includes(url.hostname) || url.pathname !== '/watch') return;
  if (command === 'yld-panel') {
    const previous = panelToggleActions.get(tab.id) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      try {
        const status = await chrome.tabs.sendMessage(tab.id, {type:'YLD_PANEL_STATUS'});
        if (!status?.ok || status.payload?.version !== chrome.runtime.getManifest().version) throw new Error('Stale panel');
        await chrome.tabs.sendMessage(tab.id, {type:'YLD_PANEL_TOGGLE'});
      } catch { await openPanelFromAction(tab); }
    });
    panelToggleActions.set(tab.id, task);
    try { await task; } finally { if (panelToggleActions.get(tab.id) === task) panelToggleActions.delete(tab.id); }
    return;
  }
  const generation = (commandGenerations.get(tab.id) || 0) + 1;
  commandGenerations.set(tab.id, generation);
  try {
    const status = await chrome.tabs.sendMessage(tab.id, {type:'YLD_PANEL_STATUS'});
    if (commandGenerations.get(tab.id) !== generation) return;
    if (!status?.ok || status.payload?.version !== chrome.runtime.getManifest().version) throw new Error('Stale panel');
    await chrome.tabs.sendMessage(tab.id, {type:command === 'yld-start' ? 'YLD_DUB_START' : 'YLD_DUB_STOP'});
  } catch {
    // A failed command is never replayed: a lost reply may already have started work.
    // Opening/reconnecting only is safe and leaves the next Start to the user.
    if (command === 'yld-start' && commandGenerations.get(tab.id) === generation) await openPanelFromAction(tab);
  }
}
