// Platform-independent prototype. It is deliberately not wired into the current
// YouTube extension until adapters and real capture tests pass the ADR gates.
export function selectDubbingMode(capabilities) {
  if (capabilities.kind === 'text') return { mode: 'read-aloud', clock: 'speech', mayHoldVideo: false };
  if (capabilities.kind === 'vod' && capabilities.hasAheadTranscript && capabilities.canPause) {
    return { mode: 'aligned-vod', clock: 'media', mayHoldVideo: true };
  }
  if (capabilities.canCapture) return { mode: 'delayed-commentary', clock: 'capture', mayHoldVideo: false };
  return { mode: 'unsupported', clock: null, mayHoldVideo: false };
}

export function createMediaSession({ maxClips = 24, maxSeconds = 90, release = () => {} } = {}) {
  if (!Number.isInteger(maxClips) || maxClips < 1 || !Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new TypeError('Invalid queue limits');
  let epoch = 0, identity = null, controller = new AbortController(), queue = [], active = false;
  const clear = () => {
    controller.abort();
    // Remove references before releasing resources, even if a release fails.
    const old = queue; queue = [];
    for (const item of old) { try { release(item.clip); } catch {} }
  };
  const valid = token => active && token?.epoch === epoch && token?.identity === identity && token?.signal === controller.signal && !controller.signal.aborted;
  function begin(source) {
    if (!source || !['platform','mediaId','revision'].every(key => typeof source[key] === 'string' && source[key].trim())) throw new TypeError('Stable media identity and content revision required');
    const origin = new URL(source.origin);
    if (origin.protocol !== 'https:' || origin.username || origin.password) throw new TypeError('HTTPS source origin required');
    clear(); epoch++;
    identity = JSON.stringify([origin.origin, source.platform, source.mediaId, source.revision]);
    controller = new AbortController(); active = true;
    return token();
  }
  function token() { return Object.freeze({ epoch, identity, signal: controller.signal }); }
  function seek() {
    if (!active) throw new Error('No active media');
    clear(); epoch++; controller = new AbortController(); return token();
  }
  function accept(job, clip) {
    const discard = reason => {
      // A rejected callback may reuse a reference already owned by this queue.
      // Reject its token without destroying the current session's resource.
      if (!queue.some(item => item.clip === clip)) { try { release(clip); } catch {} }
      return { accepted: false, reason };
    };
    if (!valid(job)) return discard('stale');
    if (!clip?.id || !Number.isFinite(clip.start) || clip.start < 0 || !Number.isFinite(clip.duration) || clip.duration <= 0) return discard('invalid');
    if (queue.some(item => item.clip === clip)) return { accepted: false, reason: 'duplicate' };
    if (queue.some(item => item.id === clip.id)) return discard('duplicate');
    if (queue.length >= maxClips || queue.reduce((sum, item) => sum + item.duration, 0) + clip.duration > maxSeconds) return discard('backpressure');
    // Scheduling/accounting belongs to the queue, even if a caller later
    // changes its object. Keep the original reference for resource ownership.
    queue.push({ clip, id: clip.id, start: clip.start, duration: clip.duration });
    queue.sort((a,b) => a.start-b.start);
    return { accepted: true };
  }
  function take(job) { return valid(job) ? queue.shift()?.clip : undefined; }
  function stop() { clear(); active = false; epoch++; identity = null; }
  return { begin, seek, stop, token, valid, accept, take, status: () => ({ active, epoch, queued: queue.length, seconds: queue.reduce((sum,item)=>sum+item.duration,0) }) };
}
