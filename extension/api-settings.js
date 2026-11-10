const backendUrl = new URL(location.href).searchParams.get('backend') || 'http://127.0.0.1:18789';
const input = document.querySelector('#api-key');
const status = document.querySelector('#key-status');
const result = document.querySelector('#result');
const audio = document.querySelector('#audio');
let busy = false;
async function request(action, key) {
  const response = await chrome.runtime.sendMessage({ type: 'YLD_API_SETTINGS', payload: { backendUrl, action, ...(key === undefined ? {} : { key }) } });
  if (!response?.ok) throw new Error(response?.error || '로컬 서버에 연결하지 못했습니다.');
  return response.payload;
}
function showStatus(data) { status.textContent = data.configured ? 'OpenAI 키 등록됨 · 연결 테스트 가능' : 'OpenAI 키 미등록'; }
async function perform(work) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button:not(#close)').forEach(button => { button.disabled = true; });
  result.className = '';
  try { await work(); } catch (error) { result.className = 'error'; result.textContent = error.message; }
  finally { busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
}
document.querySelector('#close').addEventListener('click', () => window.close());
document.querySelector('#key-form').addEventListener('submit', event => {
  event.preventDefault();
  const key = input.value.trim(); input.value = '';
  void perform(async () => { audio.pause(); audio.hidden = true; showStatus(await request('save', key)); result.textContent = '저장했습니다. 서버 재시작 없이 적용됐습니다.'; });
});
document.querySelector('#delete').addEventListener('click', () => {
  input.value = '';
  void perform(async () => { audio.pause(); audio.removeAttribute('src'); audio.hidden = true; showStatus(await request('delete')); result.textContent = '키를 삭제했습니다.'; });
});
document.querySelector('#test').addEventListener('click', () => {
  void perform(async () => {
    if (input.value.trim()) throw new Error('입력한 키를 먼저 저장해 주세요.');
    audio.pause(); audio.hidden = true;
    result.textContent = 'OpenAI 번역·음성을 확인하고 있습니다…';
    const data = await request('test');
    result.textContent = `번역·음성 연결 성공 · ${(data.elapsedMs / 1000).toFixed(1)}초\n${data.translatedText}`;
    audio.src = data.audioUrl; audio.hidden = false;
    await audio.play().catch(() => {});
  });
});
void perform(async () => { showStatus(await request('status')); });
// Clear the next-click popup assignment; the current popup stays open. No tab is created.
void chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
  if (tabs[0]?.id) return chrome.action.setPopup({ tabId: tabs[0].id, popup: '' });
});
