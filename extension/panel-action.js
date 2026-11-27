// Toolbar always shows the panel; the separate panel shortcut toggles it.
const panelActions = new Map();
const tabActionStates = new Map();
const renderedIconCache = new Map();
let baseIconBitmapsPromise = null;

const ACTION_MODE_LABELS = {
  local: '모두 로컬',
  'gemma-gpt': '로컬→GPT 음성',
  'gpt-local': 'GPT→로컬 음성',
  gpt: '모두 GPT',
};

function describeActionState(raw = {}) {
  const kind = String(raw?.state || 'idle');
  const hq = Boolean(raw?.hq);
  const modeLabel = ACTION_MODE_LABELS[raw?.mode] || '';
  const clipPart = raw?.clipLabel ? ` 클립 ${String(raw.clipLabel).slice(0, 24)}` : '';
  const detailText = String(raw?.detail || '').trim().slice(0, 100);

  if (kind === 'playing') {
    return {
      visualKey: hq ? 'hq' : 'playing',
      badgeText: hq ? 'HQ' : 'ON',
      badgeBg: hq ? '#7c3aed' : '#059669',
      accent: hq ? '#8b5cf6' : '#10b981',
      title: `Live Dub [재생 중${hq ? ' · HQ 2.1' : ''}]${clipPart}${modeLabel ? ` · ${modeLabel}` : ''}`,
    };
  }
  if (kind === 'tail') {
    return {
      visualKey: 'tail',
      badgeText: 'ON',
      badgeBg: '#0d9488',
      accent: '#14b8a6',
      title: 'Live Dub [마무리 중] 문장을 끝까지 읽은 뒤 자동 진행',
    };
  }
  if (kind === 'preparing') {
    return {
      visualKey: 'preparing',
      badgeText: '...',
      badgeBg: '#2563eb',
      accent: '#38bdf8',
      title: `Live Dub [준비 중] ${detailText || '자막 및 더빙 음성 준비 중'}`,
    };
  }
  if (kind === 'paused') {
    return {
      visualKey: 'paused',
      badgeText: 'II',
      badgeBg: '#d97706',
      accent: '#f59e0b',
      title: 'Live Dub [일시정지] 대기 중 추가 토큰 소모 없음 · 재생(▶) 시 이어집니다',
    };
  }
  if (kind === 'auto') {
    return {
      visualKey: 'auto',
      badgeText: 'AUTO',
      badgeBg: '#475569',
      accent: '#64748b',
      title: 'Live Dub [연속 대기] 다음 영상 자동 더빙 켜짐 · 대기 중 토큰 소모 없음',
    };
  }
  if (kind === 'error') {
    return {
      visualKey: 'error',
      badgeText: '!',
      badgeBg: '#dc2626',
      accent: '#ef4444',
      title: `Live Dub [확인 필요] ${detailText || '클릭하여 패널 열기'}`,
    };
  }
  return {
    visualKey: 'idle',
    badgeText: '',
    badgeBg: '#334155',
    accent: '',
    title: 'Live Dub 패널 열기',
  };
}

function loadBaseIconBitmaps() {
  if (baseIconBitmapsPromise) return baseIconBitmapsPromise;
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function' || typeof fetch !== 'function') {
    return Promise.resolve(null);
  }
  baseIconBitmapsPromise = Promise.all([16, 32].map(async size => {
    const res = await fetch(chrome.runtime.getURL(`icons/icon-${size}.png`));
    if (!res.ok) throw new Error('Icon fetch failed');
    const bitmap = await createImageBitmap(await res.blob());
    return [size, bitmap];
  })).then(entries => Object.fromEntries(entries)).catch(() => {
    baseIconBitmapsPromise = null;
    return null;
  });
  return baseIconBitmapsPromise;
}

async function getDynamicIconImageData(visualKey, accent) {
  if (!accent) return null;
  if (renderedIconCache.has(visualKey)) return renderedIconCache.get(visualKey);
  const bitmaps = await loadBaseIconBitmaps();
  if (!bitmaps) return null;
  const imageData = {};
  for (const size of [16, 32]) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmaps[size], 0, 0, size, size);
    const pad = size === 32 ? 1.5 : 1;
    const radius = size === 32 ? 7 : 3.5;
    ctx.strokeStyle = accent;
    ctx.lineWidth = size === 32 ? 2.5 : 1.5;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(pad, pad, size - pad * 2, size - pad * 2, radius);
    } else {
      ctx.rect(pad, pad, size - pad * 2, size - pad * 2);
    }
    ctx.stroke();

    // Top-left live status LED pip (keeps bottom-right clear for Chrome's badge text).
    const dotX = size === 32 ? 6.5 : 3.5;
    const dotY = size === 32 ? 6.5 : 3.5;
    const dotR = size === 32 ? 3.6 : 2.1;
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotR + (size === 32 ? 1.4 : 0.9), 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    imageData[size] = ctx.getImageData(0, 0, size, size);
  }
  renderedIconCache.set(visualKey, imageData);
  return imageData;
}

async function applyTabActionState(tabId, raw = {}) {
  if (!Number.isInteger(tabId)) return;
  const desc = describeActionState(raw);
  tabActionStates.set(tabId, desc);
  await chrome.action.setBadgeText({ tabId, text: desc.badgeText }).catch(() => {});
  if (desc.badgeText) {
    await chrome.action.setBadgeBackgroundColor?.({ tabId, color: desc.badgeBg })?.catch?.(() => {});
    await chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' })?.catch?.(() => {});
  }
  await chrome.action.setTitle({ tabId, title: desc.title }).catch(() => {});
  if (typeof chrome.action?.setIcon === 'function') {
    if (desc.accent) {
      const imageData = await getDynamicIconImageData(desc.visualKey, desc.accent);
      if (imageData && tabActionStates.get(tabId) === desc) {
        await chrome.action.setIcon({ tabId, imageData }).catch(() => {});
      }
    } else {
      await chrome.action.setIcon({
        tabId,
        path: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
      }).catch(() => {});
    }
  }
}

chrome.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
  if (changeInfo?.status === 'loading') {
    applyTabActionState(tabId, { state: 'idle' }).catch(() => {});
  }
});
chrome.tabs?.onRemoved?.addListener?.(tabId => {
  tabActionStates.delete(tabId);
});

chrome.action.onClicked.addListener(tab => {
  openPanelFromAction(tab).catch(async () => {
    await applyTabActionState(tab?.id, { state: 'error', detail: '페이지를 새로고침한 뒤 다시 열어주세요.' });
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
  let statusPayload = null;
  const show = async () => {
    const result=await chrome.tabs.sendMessage(tab.id,{type:'YLD_PANEL_SHOW'});
    if (!result?.ok || result.payload?.version !== chrome.runtime.getManifest().version) throw new Error('Panel needs a fresh page connection');
    statusPayload = result.payload;
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
  await applyTabActionState(tab.id, statusPayload?.actionState || { state: 'idle' });
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
