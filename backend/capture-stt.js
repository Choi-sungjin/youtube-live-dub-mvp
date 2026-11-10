import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
import { timedClauses } from '../lib/timed-transcript.js';
import { capturedSpeakerEvidence, splitSpeakerSegments } from './speaker-segments.js';

const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export function validateCapture(body) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(body?.videoId || '') ||
      !Number.isFinite(body.start) || !Number.isFinite(body.end) || body.start < 0 ||
      body.end <= body.start || body.end - body.start > 26 || body.end > 86400) {
    throw error(400, 'Invalid original audio window.');
  }
  const limit = body.buffered === true ? 8 * 1024 * 1024 : 1024 * 1024;
  if (typeof body.audio !== 'string' || body.audio.length > Math.ceil(limit / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)) {
    throw error(400, 'Invalid original audio data.');
  }
  const audio = Buffer.from(body.audio, 'base64');
  if (audio.length < 100 || audio.length > limit || (audio.readUInt32BE(0) !== 0x1a45dfa3 && !(body.buffered === true && audio.toString('ascii', 4, 8) === 'ftyp'))) {
    throw error(400, 'Expected bounded WebM original audio.');
  }
  return audio;
}

export function createCaptureHandler({ cacheDir, transcribe, analyzeSpeakers, executeImpl = execute }) {
  let active = 0;
  return async (req) => {
    // Only extension requests with a non-simple header. Ordinary web origins and
    // form posts must never be able to enqueue local transcription work.
    if (req.headers['x-yld-capture'] !== '1' ||
        (req.headers.origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin)) ||
        !String(req.headers['content-type']).startsWith('application/json')) throw error(403, 'Extension capture required.');
    if (active >= 2) throw error(429, 'Original audio transcription is busy.');
    active++;
    let directory;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 11200000) throw error(413, 'Original audio buffer is too large.');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw error(400, 'Invalid capture JSON.'); }
      const audio = validateCapture(body);
      directory = await mkdtemp(path.join(cacheDir, 'capture-'));
      let inputPath = path.join(directory, 'source.media');
      await writeFile(inputPath, audio, { mode: 0o600 });
      if (body.buffered === true) {
        const output = path.join(directory, 'window.wav');
        // Preserve original MSE timestamps before trimming; no network protocol
        // or caller-selected path is permitted to reach ffmpeg.
        await executeImpl('ffmpeg', ['-v','error','-nostdin','-y','-protocol_whitelist','file,pipe',
          '-copyts','-i',inputPath,'-vn','-af',`atrim=start=${body.start}:end=${body.end},asetpts=PTS-STARTPTS`,
          '-ac','1','-ar','16000','-t',String(body.end-body.start),output], {timeout:15000,maxBuffer:1024*1024,windowsHide:true});
        const wav = await stat(output);
        if (wav.size < (body.end-body.start) * 16000 * 2 * 0.9) throw error(422, 'Buffered audio does not cover the requested window.');
        inputPath = output;
      }
      const duration = body.end - body.start;
      const [sttResult, speakerResult] = await Promise.allSettled([
        transcribe({ inputPath, model: process.env.YLD_STT_MODEL || 'small', language: 'auto', lowLatency: body.buffered === true }),
        body.autoSpeaker === true && analyzeSpeakers ? analyzeSpeakers({inputPath, duration}).catch(() => ({turns:[]})) : null,
      ]);
      if (sttResult.status === 'rejected') throw sttResult.reason;
      const result = sttResult.value;
      const analysis = speakerResult.status === 'fulfilled' ? speakerResult.value : {turns:[]};
      const clauses = analysis ? splitSpeakerSegments(result.segments || [], analysis.turns) : timedClauses(result.segments || []);
      let segments = clauses.map(segment => ({
        start: body.start + Math.max(0, Math.min(duration, Number(segment.start))),
        end: body.start + Math.max(0, Math.min(duration, Number(segment.end))),
        text: String(segment.text || '').trim(),
        ...(analysis ? {speaker:segment.speaker} : {}),
      })).filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text);
      if (analysis) segments = capturedSpeakerEvidence.register(body.videoId, segments);
      return { ok: true, source: 'browser-original-audio', videoId: body.videoId, segments,
        windows: [{ start: body.start, end: body.end }], inferenceMs: result.inferenceMs, speakerInferenceMs: analysis?.inferenceMs || 0 };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      active--;
    }
  };
}
