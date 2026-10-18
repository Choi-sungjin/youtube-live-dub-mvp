// Shared MP4 / public-web VOD scheduler. TTS is generated at 1.15; playback follows the video only.
export class LocalDubPlayer {
  constructor(video, api, report = () => {}, audioFactory = url => new Audio(url)) {
    this.video = video; this.api = api; this.report = report; this.audioFactory = audioFactory;
    this.windows = new Map(); this.pending = new Map(); this.completed = new Set();
    this.epoch = 0; this.active = false; this.intent = false; this.ignorePause = 0; this.ignorePlay = 0;
    this.stats = { bufferWaits:0,bufferMs:0,tailWaits:0,seeks:0,audioStarts:0,firstAudioMs:null };
    video.addEventListener('pause',()=>{
      if (this.ignorePause) { this.ignorePause--; return; }
      if (video.ended) return;
      if (this.active) this.pause();
    });
    video.addEventListener('play',()=>{
      if (this.ignorePlay) { this.ignorePlay--; return; }
      if (this.active) { this.intent=true; this.resumeVoice(); this.tick(); }
    });
    video.addEventListener('seeking',()=>this.seek());
    video.addEventListener('ended',()=>this.tick());
    video.addEventListener('waiting',()=>{ if(this.active && video.readyState<3) { this.sourceWaiting=true;this.voice?.audio.pause();this.show('source-buffering'); } });
    video.addEventListener('canplay',()=>{ if(this.sourceWaiting) { this.sourceWaiting=false;if(this.active && this.intent){this.resumeVoice();this.tick();} } });
    video.addEventListener('error',()=>{if(this.active)this.fail(new Error('이 MP4의 영상·음성 코덱을 Chrome에서 재생할 수 없습니다. H.264/AAC MP4를 사용하세요.'));});
    video.addEventListener('ratechange',()=>{ if(this.voice) this.voice.audio.playbackRate=video.playbackRate; });
    this.timer=setInterval(()=>this.tick(),80);
  }
  show(status=this.status, error='') {
    this.status=status;
    this.report({ status,error:error || this.lastError || '',active:this.active,currentTime:this.video.currentTime,videoPaused:this.video.paused,
      audioPaused:this.voice?.audio.paused ?? true,audioTime:this.voice?.audio.currentTime ?? 0,
      audioRate:this.voice?.audio.playbackRate ?? 1,speechSpeed:1.15,
      videoVolume:this.video.volume,
      sourceText:this.voice?.clip.sourceText || '',translatedText:this.voice?.clip.translatedText || '',
      bufferedUntil:Math.max(0,...[...this.windows.values()].map(w=>w.end)), ...this.stats });
  }
  pauseVideo() { if(!this.video.paused) { this.ignorePause++; this.video.pause(); } }
  playVideo() {
    if(this.video.paused && !this.video.ended && this.intent) {
      const epoch=this.epoch;
      this.ignorePlay++;
      this.video.play().catch(e=>{if(epoch!==this.epoch || e.name==='AbortError')return;this.ignorePlay=Math.max(0,this.ignorePlay-1);this.fail(e);});
    }
  }
  resumeVoice() {
    if(!this.voice || this.sourceWaiting || !this.intent) return;
    const voice=this.voice,epoch=this.epoch;
    voice.audio.play().catch(error=>{if(epoch===this.epoch && this.voice===voice && error.name!=='AbortError')this.fail(error);});
  }
  clearVoice() {
    if(this.voice) { this.voice.audio.onended=null; this.voice.audio.onerror=null; this.voice.audio.pause(); this.voice.audio.src=''; this.voice=null; }
  }
  resetRun() {
    const old=this.runId;
    this.controller?.abort(); this.controller=new AbortController(); this.epoch++;
    this.sourceWaiting=false;
    this.pending.clear(); this.clearVoice(); this.completed.clear();
    if(old) this.api.cancel(old).catch(()=>{});
    this.runId=globalThis.crypto.randomUUID();
  }
  setMedia(media) {
    this.stop();
    for(const window of this.windows.values()) for(const clip of window.segments) if(clip.objectUrl) URL.revokeObjectURL(clip.objectUrl);
    this.windows.clear(); this.media=media; this.lastError=''; this.show('ready');
  }
  start() {
    if(!this.media) return;
    if(this.active) { this.intent=true; this.resumeVoice(); this.tick(); return; }
    if(this.video.ended) this.video.currentTime=0;
    this.saved={volume:this.video.volume,muted:this.video.muted};
    this.video.volume=this.saved.volume*0.2;
    this.resetRun(); this.active=true; this.intent=true; this.lastError=''; this.startedAt=performance.now();
    this.stats={bufferWaits:0,bufferMs:0,tailWaits:0,seeks:0,audioStarts:0,firstAudioMs:null};
    this.pauseVideo(); this.show('preparing'); this.tick();
  }
  pause() { this.intent=false; this.pauseVideo(); this.voice?.audio.pause(); this.show(this.active?'paused':this.status); }
  stop() {
    this.active=false; this.intent=false; this.resetRun(); this.pauseVideo(); this.finishHold();
    if(this.saved) { this.video.volume=this.saved.volume; this.video.muted=this.saved.muted; this.saved=null; }
    this.show('stopped');
  }
  seek() {
    if(!this.active) return;
    this.resetRun(); this.finishHold(); this.stats.seeks++;
    this.pauseVideo(); this.show(this.intent?'preparing':'paused'); this.tick();
  }
  fail(error) { this.stop(); this.lastError=error.message || String(error); this.show('error',this.lastError); }
  finishHold() {
    if(this.hold?.kind==='buffer') this.stats.bufferMs+=performance.now()-this.hold.at;
    this.hold=null;
  }
  holdVideo(kind) {
    if(this.hold?.kind!==kind) {
      this.finishHold(); this.hold={kind,at:performance.now()};
      if(kind==='buffer' && this.status!=='preparing') this.stats.bufferWaits++;
      if(kind==='tail') this.stats.tailWaits++;
    }
    this.pauseVideo(); this.show(kind==='tail'?'tail':'buffering');
  }
  async ensure(index) {
    if(this.windows.has(index)) return this.windows.get(index);
    if(this.pending.has(index)) return this.pending.get(index);
    const epoch=this.epoch, signal=this.controller.signal, runId=this.runId;
    const promise=(async()=>{
      let window;
      for(let attempt=0;attempt<20;attempt++) {
        try { window=await this.api.prepare(this.media.id,index*30,runId,signal); break; }
        catch(error) {
          if(error.status!==429 || signal.aborted) throw error;
          await new Promise(resolve=>setTimeout(resolve,500));
        }
      }
      if(!window) throw new Error('준비 작업이 오래 걸립니다. 잠시 후 시작을 다시 눌러주세요.');
      if(epoch!==this.epoch || !this.active) return;
      const clips=[];
      try {
        for(const clip of window.segments) {
          const blob=await this.api.audio(clip.audioUrl,signal);
          if(epoch!==this.epoch || !this.active) return;
          clips.push({...clip,objectUrl:URL.createObjectURL(blob)});
        }
        if(epoch!==this.epoch || !this.active) return;
        this.windows.set(index,{...window,segments:clips});
        this.prune(index); return this.windows.get(index);
      } finally {
        if(!this.windows.has(index) || epoch!==this.epoch) for(const clip of clips) URL.revokeObjectURL(clip.objectUrl);
      }
    })();
    this.pending.set(index,promise);
    try { return await promise; } finally { if(this.pending.get(index)===promise) this.pending.delete(index); }
  }
  prune(center) {
    while(this.windows.size>6) {
      const index=[...this.windows.keys()].sort((a,b)=>Math.abs(b-center)-Math.abs(a-center)).find(i=>!this.windows.get(i).segments.some(c=>c===this.voice?.clip));
      if(index===undefined) return;
      for(const clip of this.windows.get(index).segments) URL.revokeObjectURL(clip.objectUrl);
      this.windows.delete(index);
    }
  }
  tick() {
    if(!this.active || !this.intent || !this.media) return;
    if(this.sourceWaiting) {this.show('source-buffering');return;}
    const t=this.video.currentTime, epoch=this.epoch;
    if(this.voice) {
      if(t>=this.voice.clip.end-0.04 || this.video.ended) { this.holdVideo('tail'); return; }
    }
    if(this.video.ended && !this.voice) { this.stop(); this.show('ended'); return; }
    const index=Math.floor(Math.min(t,this.media.duration-0.01)/30);
    const window=this.windows.get(index);
    if(!window) {
      this.holdVideo('buffer');
      if(!this.pending.has(index)) this.ensure(index).then(()=>{ if(epoch===this.epoch)this.tick(); }).catch(e=>{if(epoch===this.epoch && e.name!=='AbortError')this.fail(e);});
      return;
    }
    if(this.hold) this.finishHold();
    if(!this.voice) {
      const clips=[...this.windows.values()].flatMap(w=>w.segments).sort((a,b)=>a.start-b.start);
      const clip=clips.find(c=>c.start<=t+0.08 && c.end>t && !this.completed.has(c.index));
      if(clip) {
        const offset=Math.max(0,t-clip.start);
        if(offset>=clip.duration) { this.completed.add(clip.index); }
        else {
          const audio=this.audioFactory(clip.objectUrl);
          this.voice={clip,audio}; audio.playbackRate=this.video.playbackRate; audio.currentTime=offset;
          audio.onended=()=>{
            if(epoch!==this.epoch)return;
            this.completed.add(clip.index); this.clearVoice(); this.finishHold(); this.tick();
          };
          audio.onerror=()=>{if(epoch===this.epoch)this.fail(new Error('더빙 음성을 재생할 수 없습니다.'));};
          audio.play().then(()=>{
            if(epoch!==this.epoch) { audio.pause(); return; }
            this.stats.audioStarts++; this.stats.firstAudioMs??=performance.now()-this.startedAt;
          }).catch(e=>{if(epoch===this.epoch && e.name!=='AbortError')this.fail(e);});
        }
      }
    }
    this.playVideo(); this.show('playing');
    if(window.end-t<20 && window.end<this.media.duration && !this.pending.has(index+1) && !this.windows.has(index+1)) {
      this.ensure(index+1).catch(e=>{if(epoch===this.epoch && e.name!=='AbortError')this.show('playing',`다음 구간 준비 재시도: ${e.message}`);});
    }
  }
  dispose() { this.stop(); clearInterval(this.timer); this.setMedia(null); }
}
