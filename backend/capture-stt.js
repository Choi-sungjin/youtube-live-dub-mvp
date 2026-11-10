import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { timedClauses } from '../lib/timed-transcript.js';

const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export function validateCapture(body) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(body?.videoId || '') ||
      !Number.isFinite(body.start) || !Number.isFinite(body.end) || body.start < 0 ||
      body.end <= body.start || body.end - body.start > 26 || body.end > 86400) {
    throw error(400, 'Invalid original audio window.');
  }
  if (typeof body.audio !== 'string' || body.audio.length > 1400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)) {
    throw error(400, 'Invalid original audio data.');
  }
  const audio = Buffer.from(body.audio, 'base64');
  if (audio.length < 100 || audio.length > 1024 * 1024 || audio.readUInt32BE(0) !== 0x1a45dfa3) {
    throw error(400, 'Expected bounded WebM original audio.');
  }
  return audio;
}

export function createCaptureHandler({ cacheDir, transcribe }) {
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
        if (size > 1450000) throw error(413, 'Original audio buffer is too large.');
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw error(400, 'Invalid capture JSON.'); }
      const audio = validateCapture(body);
      directory = await mkdtemp(path.join(cacheDir, 'capture-'));
      const inputPath = path.join(directory, 'source.webm');
      await writeFile(inputPath, audio, { mode: 0o600 });
      const result = await transcribe({ inputPath, model: process.env.YLD_STT_MODEL || 'small', language: 'auto' });
      const duration = body.end - body.start;
      const segments = timedClauses(result.segments || []).map(segment => ({
        start: body.start + Math.max(0, Math.min(duration, Number(segment.start))),
        end: body.start + Math.max(0, Math.min(duration, Number(segment.end))),
        text: String(segment.text || '').trim(),
      })).filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text);
      return { ok: true, source: 'browser-original-audio', videoId: body.videoId, segments,
        windows: [{ start: body.start, end: body.end }], inferenceMs: result.inferenceMs };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      active--;
    }
  };
}
