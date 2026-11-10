// Observe the audio bytes already delivered to this page's MediaSource. Never
// fetch URLs, read cookies, alter the media data, or capture microphone/tab audio.
(() => {
  if (!window.MediaSource || window.__YLD_AUDIO_BUFFER_INSTALLED__) return;
  window.__YLD_AUDIO_BUFFER_INSTALLED__ = true;
  const LIMIT = 8 * 1024 * 1024;
  const sources = new WeakMap(), urls = new Map();
  const create = URL.createObjectURL;
  URL.createObjectURL = function (object) {
    const url = create.apply(this, arguments);
    if (object instanceof MediaSource) {
      urls.set(url, object);
      if (urls.size > 8) urls.delete(urls.keys().next().value);
    }
    return url;
  };
  const add = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const buffer = add.apply(this, arguments);
    if (!/^audio\/(webm|mp4)\b/i.test(mime)) return buffer;
    const record = { buffer, mime, parts: [], init: null, retainedStart: 0, size: 0, overflow: false, failed: false };
    const records = sources.get(this) || [];
    records.push(record); sources.set(this, records.slice(-2));
    const append = buffer.appendBuffer;
    buffer.appendBuffer = function (input) {
      // Copy before appendBuffer can detach the caller's input. Only retain it
      // after the native append succeeds; native return/exception is unchanged.
      let bytes;
      try {
        if (!record.overflow && input.byteLength <= LIMIT) bytes = new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength).slice();
      } catch {}
      let start = 0;
      try { if (buffer.buffered.length) start = buffer.buffered.end(buffer.buffered.length - 1); } catch {}
      const result = append.apply(this, arguments);
      if (input.byteLength > LIMIT) { record.parts=[]; record.init=null; record.size=0; record.overflow=true; }
      if (bytes) {
        record.parts.push({bytes,start}); record.size += bytes.length;
        if (!record.init) {
          const prefix = join(record.parts.map(part => part.bytes));
          const header = initializationLength(prefix);
          if (header > 0) {
            record.init = prefix.slice(0,header);
            record.parts = [{bytes:prefix.slice(header),start:0}];
          }
        }
        if (record.size > LIMIT && record.init) {
          let size = record.init.length;
          let keep = record.parts.length;
          for (let i=record.parts.length-1;i>=0;i--) {
            size += record.parts[i].bytes.length;
            if (size > LIMIT) break;
            if (isBoundary(record.parts[i].bytes)) keep = i;
          }
          if (keep < record.parts.length) {
            record.retainedStart = record.parts[keep].start;
            record.parts = record.parts.slice(keep);
            record.size = record.init.length + record.parts.reduce((sum,part)=>sum+part.bytes.length,0);
          }
        }
        if (record.size > LIMIT) { record.parts=[]; record.init=null; record.size=0; record.overflow=true; }
      }
      return result;
    };
    buffer.addEventListener('error', () => { record.failed = true; });
    return buffer;
  };
  function join(parts) {
    const result = new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0)); let offset=0;
    for (const part of parts) { result.set(part,offset); offset+=part.length; }
    return result;
  }
  function isBoundary(bytes) {
    return bytes.length >= 8 && ((bytes[0]===0x1f && bytes[1]===0x43 && bytes[2]===0xb6 && bytes[3]===0x75) ||
      String.fromCharCode(...bytes.subarray(4,8))==='moof');
  }
  function initializationLength(bytes) {
    if (bytes.length < 8) return 0;
    if (bytes[0]===0x1a && bytes[1]===0x45 && bytes[2]===0xdf && bytes[3]===0xa3) {
      for(let i=4;i<Math.min(bytes.length-4,262144);i++) {
        if(bytes[i]===0x1f && bytes[i+1]===0x43 && bytes[i+2]===0xb6 && bytes[i+3]===0x75) return i;
      }
    } else if (String.fromCharCode(...bytes.subarray(4,8))==='ftyp') {
      const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      for(let i=0;i+8<=bytes.length;) {
        if(String.fromCharCode(...bytes.subarray(i+4,i+8))==='moof') return i;
        const size=view.getUint32(i); if(size<8 || i+size>bytes.length) break; i+=size;
      }
    }
    return 0;
  }
  window.addEventListener('message', event => {
    const request = event.data;
    if (event.source !== window || request?.source !== 'YLD_BUFFER_REQUEST' ||
        typeof request.id !== 'string' || request.id.length > 100) return;
    const videoId = new URL(location.href).searchParams.get('v');
    const video = document.querySelector('video.html5-main-video');
    const response = { source: 'YLD_BUFFER_RESPONSE', id: request.id, videoId, available: false };
    if (request.videoId !== videoId || !video || video.closest('.ad-showing')) {
      window.postMessage(response, location.origin); return;
    }
    const source = urls.get(video.currentSrc || video.src);
    const record = (sources.get(source) || []).find(item => item.size && !item.overflow && !item.failed);
    if (record) {
      const ranges = [];
      try { for (let i=0; i<record.buffer.buffered.length; i++) ranges.push({start:Math.max(record.retainedStart,record.buffer.buffered.start(i)),end:record.buffer.buffered.end(i)}); } catch {}
      Object.assign(response, { available: true, ranges, bytes: record.size, mime: record.mime });
      if (request.read === true) {
        const audio = new Uint8Array(record.size); let offset = 0;
        if (record.init) { audio.set(record.init); offset = record.init.length; }
        for (const part of record.parts) { audio.set(part.bytes, offset); offset += part.bytes.length; }
        response.audio = audio.buffer;
      }
    }
    window.postMessage(response, location.origin, response.audio ? [response.audio] : []);
  });
})();
