import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { timedClauses } from '../lib/timed-transcript.js';
import { openPublicMedia, extractVideoUrls, byteRange } from './public-media.js';

const MAX_BYTES = 512 * 1024 * 1024;
const send = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const fail = (code, message) => Object.assign(new Error(message), { statusCode: code });
export async function runMediaCommand(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${exe} 처리 시간이 초과되었습니다.`)); }, 180000);
    child.stdout.on('data', data => { if (stdout.length < 2e6) stdout += data; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-3000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`${exe} 실패: ${stderr.slice(-800)}`)); });
  });
}

async function limitedCopy(input, output, limit) {
  let size = 0;
  const limiter = new Transform({ transform(chunk, _encoding, cb) { size += chunk.length; cb(size > limit ? fail(413, 'MP4 크기는 512 MB 이하여야 합니다.') : null, chunk); } });
  await pipeline(input, limiter, output);
  return size;
}
async function bodyJson(req) {
  let text = '';
  for await (const data of req) { text += data; if (Buffer.byteLength(text) > 16384) throw fail(413, '요청이 너무 큽니다.'); }
  try { return JSON.parse(text || '{}'); } catch { throw fail(400, '잘못된 JSON 요청입니다.'); }
}

export function createMediaRouter({ root, transcribe, prepare, command = runMediaCommand, openRemote = openPublicMedia }) {
  const token = randomBytes(32).toString('hex');
  const folder = path.join(root, 'backend/.cache/media');
  const records = new Map(), cancelled = new Set();
  let jobs = 0, imports = 0;
  const pageOrigin = req => `http://${req.headers.host}`;
  const originAllowed = req => !req.headers.origin || req.headers.origin === pageOrigin(req);
  async function addFile(input, name, source) {
    const id = randomBytes(16).toString('hex');
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, `${id}.mp4`);
    await limitedCopy(input, createWriteStream(file, { flags: 'wx' }), MAX_BYTES);
    const probe = JSON.parse(await command('ffprobe', ['-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json',file]));
    const duration = Number(probe.format?.duration);
    if (!probe.format?.format_name?.split(',').includes('mp4') || !probe.streams?.some(s=>s.codec_type === 'video') || !probe.streams.some(s=>s.codec_type === 'audio')) throw fail(415, '음성 트랙이 있는 MP4 파일만 지원합니다.');
    if (!(duration > 0 && duration <= 1800)) throw fail(415, '30분 이하의 MP4 파일을 선택하세요.');
    const record = { id, name: String(name || '영상').slice(0,120), source, duration, file, transcript: null, transcriptPromise: null, prepared: new Map() };
    records.set(id, record);
    return record;
  }
  const info = record => ({ id: record.id, name: record.name, duration: record.duration, source: record.source });
  async function ensureTranscript(record) {
    if (record.transcript) return record.transcript;
    if (!record.transcriptPromise) record.transcriptPromise = (async () => {
      const wav = path.join(folder, `${record.id}.wav`);
      await command('ffmpeg', ['-v','error','-nostdin','-y','-protocol_whitelist','file,pipe','-i',record.file,'-vn','-ac','1','-ar','16000',wav]);
      const result = await transcribe({ inputPath: wav, model: process.env.YLD_STT_MODEL || 'small', language: 'auto' });
      record.transcript = timedClauses(result.segments).filter(s=>s.text?.trim() && s.end>s.start).map((s,index)=>({ ...s, index }));
      await writeFile(path.join(folder, `${record.id}.transcript.json`), JSON.stringify(record.transcript));
      return record.transcript;
    })().catch(error=>{ record.transcriptPromise = null; throw error; });
    return record.transcriptPromise;
  }
  return async function route(req, res, url) {
    const assets = { '/player': ['player.html','text/html'], '/player.js': ['player.js','text/javascript'], '/player.css': ['player.css','text/css'], '/player-engine.js': ['player-engine.js','text/javascript'] };
    if (!assets[url.pathname] && !url.pathname.startsWith('/api/media/')) return false;
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(req.headers.host || '')) throw fail(403, '로컬 주소로 플레이어를 열어주세요.');
    if (req.method === 'GET' && assets[url.pathname]) {
      const [file,type] = assets[url.pathname];
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'" });
      res.end(await readFile(path.join(root, 'backend', file))); return true;
    }
    if (!url.pathname.startsWith('/api/media/')) return false;
    // This API belongs to the same-origin local player, never arbitrary websites.
    if (!originAllowed(req) || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '이 요청은 로컬 플레이어에서만 실행할 수 있습니다.');
    if (req.method === 'GET' && url.pathname === '/api/media/session') {
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '외부 사이트 요청은 허용하지 않습니다.');
      send(res, 200, { token, maxBytes: MAX_BYTES, maxDuration: 1800 }); return true;
    }
    if (req.headers.authorization !== `Bearer ${token}` && url.searchParams.get('token') !== token) throw fail(401, '플레이어를 새로고침해 연결을 갱신하세요.');
    if (req.method === 'POST' && ['/api/media/upload','/api/media/import'].includes(url.pathname)) {
      if (imports >= 1 || records.size >= 24) throw fail(429, '다른 영상 가져오기가 진행 중이거나 세션 영상 수가 많습니다. 서버를 다시 시작하세요.');
      imports++;
      try {
        let record;
        if (url.pathname.endsWith('/upload')) {
          if (Number(req.headers['content-length']) > MAX_BYTES) throw fail(413, 'MP4 크기는 512 MB 이하여야 합니다.');
          record = await addFile(req, url.searchParams.get('name'), 'file');
        } else {
          const body = await bodyJson(req);
          let { response, url: finalUrl } = await openRemote(String(body.url || ''));
          if ((response.headers['content-type'] || '').includes('text/html')) {
            let html = '';
            for await (const chunk of response) { html += chunk; if (Buffer.byteLength(html) > 1024*1024) { response.destroy(); throw fail(415, '페이지가 너무 큽니다. 직접 MP4 주소를 입력하세요.'); } }
            const candidates = extractVideoUrls(html, finalUrl.href);
            if (!candidates.length) throw fail(415, '공개 MP4 주소를 찾지 못했습니다. blob·HLS·로그인·DRM 영상은 현재 지원하지 않습니다.');
            if (candidates.length > 1) { send(res,200,{candidates:candidates.slice(0,20)});return true; }
            ({ response, url: finalUrl } = await openRemote(candidates[0]));
          }
          if (Number(response.headers['content-length']) > MAX_BYTES) { response.destroy(); throw fail(413, 'MP4 크기는 512 MB 이하여야 합니다.'); }
          record = await addFile(response, decodeURIComponent(finalUrl.pathname.split('/').pop() || '웹영상'), 'web');
        }
        send(res,200,info(record)); return true;
      } finally { imports--; }
    }
    if (req.method === 'POST' && url.pathname === '/api/media/cancel') {
      const { runId } = await bodyJson(req);
      if (typeof runId === 'string') cancelled.add(runId);
      if (cancelled.size > 256) cancelled.delete(cancelled.values().next().value);
      send(res,200,{ok:true}); return true;
    }
    const match = /^\/api\/media\/([a-f0-9]{32})\/(file|prepare)$/.exec(url.pathname);
    const record = match && records.get(match[1]);
    if (!record) throw fail(404, '영상을 다시 선택하세요. 서버가 재시작되면 파일을 다시 열어야 합니다.');
    if (req.method === 'GET' && match[2] === 'file') {
      const size = (await stat(record.file)).size;
      const range = byteRange(req.headers.range, size);
      if (!range) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return true; }
      const headers = { 'content-type': 'video/mp4', 'content-length': range.end-range.start+1, 'accept-ranges': 'bytes', 'cache-control': 'private, no-store' };
      if (range.partial) headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
      res.writeHead(range.partial ? 206 : 200, headers);
      const stream = createReadStream(record.file, { start:range.start, end:range.end });
      res.on('close',()=>stream.destroy()); stream.pipe(res); return true;
    }
    if (req.method === 'POST' && match[2] === 'prepare') {
      const body = await bodyJson(req);
      const start = Number(body.start), runId = String(body.runId || '');
      if (!Number.isFinite(start) || start < 0 || start >= record.duration || !/^[\w-]{8,80}$/.test(runId)) throw fail(400, '잘못된 재생 구간입니다.');
      if (jobs >= 2) throw fail(429, '준비 작업이 진행 중입니다. 잠시 후 다시 시도하세요.');
      jobs++;
      const check = () => { if (cancelled.has(runId)) throw fail(409, '취소한 재생 요청입니다.'); };
      try {
        check();
        const transcript = await ensureTranscript(record);
        check();
        const windowStart = Math.floor(start/30)*30, windowEnd = Math.min(record.duration, windowStart+30);
        const selected = transcript.filter(s=>s.end>windowStart && s.start<windowEnd);
        const missing = selected.filter(s=>!record.prepared.has(s.index));
        // Bounded batches and cancellation checks between batches. In-flight model calls may finish.
        for (let i=0;i<missing.length;i+=4) {
          check();
          const result = await prepare({ videoId: `media_${record.id}`, segments: missing.slice(i,i+4), settings: { targetLang:'ko', ttsProvider:'supertonic3', voice:'M1', speed:1.15 } }, transcript);
          for (const clip of result.segments) record.prepared.set(clip.index, clip);
        }
        check();
        send(res,200,{ start:windowStart,end:windowEnd,segments:selected.map(s=>record.prepared.get(s.index)), transcriptCount:transcript.length, complete:windowEnd>=record.duration });
        return true;
      } finally { jobs--; }
    }
    throw fail(405, '지원하지 않는 요청입니다.');
  };
}
