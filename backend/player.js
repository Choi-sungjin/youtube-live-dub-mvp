import { LocalDubPlayer } from './player-engine.js';
const $=id=>document.getElementById(id), video=$('video');
let token,media,loading=false;
const labels={ready:'준비됨',stopped:'정지',preparing:'음성 준비 중',buffering:'버퍼 준비 중 · 영상 대기','source-buffering':'원본 영상 버퍼 대기',playing:'더빙 재생',paused:'일시정지',tail:'문장 끝까지 재생 중',ended:'끝까지 재생 완료',error:'오류'};
async function request(url,options={}) {
  const response=await fetch(url,{...options,headers:{authorization:`Bearer ${token}`,...options.headers}});
  const value=await response.json();
  if(!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`),{status:response.status});
  return value;
}
const post=(url,body,signal)=>request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
const engine=new LocalDubPlayer(video,{
  prepare:(id,start,runId,signal)=>post(`/api/media/${id}/prepare`,{start,runId},signal),
  cancel:runId=>post('/api/media/cancel',{runId}),
  audio:async(url,signal)=>{
    const parsed=new URL(url); if(parsed.origin!==location.origin || !/^\/audio\/[a-f0-9]+\.wav$/.test(parsed.pathname))throw new Error('잘못된 음성 주소입니다.');
    const response=await fetch(parsed.pathname,{signal});if(!response.ok)throw new Error('음성 다운로드 실패');return response.blob();
  }
},state=>{
  $('status').textContent=labels[state.status]||state.status;
  if(state.translatedText)$('translation').textContent=state.translatedText;
  $('original').textContent=state.sourceText;
  $('error').textContent=state.error;
  $('metrics').textContent=JSON.stringify({...state,currentTime:Number(state.currentTime.toFixed(2)),bufferMs:Math.round(state.bufferMs),firstAudioMs:state.firstAudioMs===null?null:Math.round(state.firstAudioMs)},null,2);
});
function controls(enabled){for(const id of ['start','pause','stop','back','forward','go'])$(id).disabled=!enabled;}
async function load(getMedia){
  if(loading)return;loading=true;engine.stop();controls(false);$('file').disabled=true;$('load-web').disabled=true;
  $('source-status').textContent='영상을 가져오는 중…';$('error').textContent='';$('choices').replaceChildren();
  try{
    const result=await getMedia();
    if(result.candidates){
      media=null;engine.setMedia(null);video.removeAttribute('src');video.load();
      $('source-status').textContent='영상이 여러 개입니다. 가져올 MP4를 선택하세요.';
      result.candidates.forEach((url,index)=>{const button=document.createElement('button'),address=new URL(url);button.textContent=`영상 ${index+1} · ${address.hostname} · ${address.pathname.split('/').pop()}`;button.title=url;button.onclick=()=>{$('url').value=url;load(()=>post('/api/media/import',{url}));};$('choices').append(button);});
      return;
    }
    media=result;engine.setMedia(media);
    video.src=`/api/media/${media.id}/file?token=${encodeURIComponent(token)}`;video.load();
    $('source-status').textContent=`${media.source==='file'?'MP4 파일':'웹영상'} · ${media.name} · ${Math.round(media.duration)}초`;
    controls(true);$('seek').max=String(Math.max(0,media.duration-0.1));
  }catch(error){$('error').textContent=error.message;$('source-status').textContent='영상을 열지 못했습니다. 다른 파일이나 직접 MP4 주소를 선택하세요.';}
  finally{loading=false;$('file').disabled=false;$('load-web').disabled=false;}
}
$('file').addEventListener('change',()=>{const file=$('file').files[0];$('file').value='';if(file)load(()=>{if(file.size>512*1024*1024)throw new Error('512 MB 이하 파일을 선택하세요.');return request(`/api/media/upload?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'content-type':'video/mp4'},body:file});});});
$('web-form').addEventListener('submit',event=>{event.preventDefault();load(()=>post('/api/media/import',{url:$('url').value}));});
$('start').onclick=()=>engine.start();$('pause').onclick=()=>engine.pause();$('stop').onclick=()=>engine.stop();
function seek(value){if(media)video.currentTime=Math.max(0,Math.min(media.duration-0.05,value));}
$('back').onclick=()=>seek(video.currentTime-10);$('forward').onclick=()=>seek(video.currentTime+10);$('go').onclick=()=>seek(Number($('seek').value)||0);
window.addEventListener('pagehide',()=>engine.dispose());
try{({token}=await request('/api/media/session'));const params=new URLSearchParams(location.hash.slice(1));if(params.get('url'))$('url').value=params.get('url');}
catch(error){$('error').textContent=error.message;}
