import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const validKey = key => typeof key === 'string' && /^sk-[A-Za-z0-9_-]{20,500}$/.test(key);

// Panel settings override legacy environment keys, including an explicit deletion.
// The file contains only this setting and is ignored by Git's .env.* rule.
export async function loadPanelApiKey(filename, env = process.env) {
  let text;
  try { text = await readFile(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const match = text.match(/^OPENAI_API_KEY=(.*)\n?$/);
  if (!match || (match[1] && !validKey(match[1]))) throw new Error('Invalid local API settings file.');
  env.OPENAI_API_KEY = match[1];
}

export function createApiSettingsHandler({ filename, testConnection, env = process.env }) {
  let busy = false;
  const status = () => ({ configured: Boolean(env.OPENAI_API_KEY) });
  return async req => {
    if (req.method !== 'POST' || req.headers['x-yld-settings'] !== '1' ||
        !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '') ||
        (req.headers.origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin)) ||
        !String(req.headers['content-type']).startsWith('application/json')) throw fail(403, '확장 프로그램의 API 설정에서 실행해 주세요.');
    let text = '';
    for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 4096) throw fail(413, '설정 요청이 너무 큽니다.'); }
    let body;
    try { body = JSON.parse(text); } catch { throw fail(400, '설정 요청 형식이 올바르지 않습니다.'); }
    if (body.action === 'status') return status();
    if (!['save', 'delete', 'test'].includes(body.action)) throw fail(400, '지원하지 않는 설정 작업입니다.');
    if (busy) throw fail(409, 'API 설정 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
    busy = true;
    try {
      if (body.action === 'test') {
        if (!env.OPENAI_API_KEY) throw fail(503, 'OpenAI API 키를 먼저 저장해 주세요.');
        return await testConnection();
      }
      const key = body.action === 'delete' ? '' : body.key;
      if (body.action === 'save' && !validKey(key)) throw fail(400, 'OpenAI API 키 형식을 확인해 주세요.');
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `OPENAI_API_KEY=${key}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, filename);
      } catch {
        throw fail(500, 'API 키를 저장하지 못했습니다. 로컬 설정 파일 권한을 확인해 주세요.');
      } finally { await rm(temporary, { force: true }); }
      env.OPENAI_API_KEY = key;
      return { ...status(), saved: true };
    } finally { busy = false; }
  };
}

// Connection checks always hit both providers; normal dubbing caches cannot
// prove that the current key still has text and voice model access.
export async function testOpenAiConnection({ translate, synthesize, audioDir, audioBaseUrl }) {
  const started = Date.now(), metrics = {};
  const settings = { targetLang: 'ko', voice: 'marin' };
  const translated = await translate([{ index: 0, text: 'The robot moves forward and turns left.' }], settings, metrics);
  const translatedText = translated.get(0);
  const filename = `api-test-${randomUUID()}.wav`;
  const voice = await synthesize({ text: translatedText, settings, outputPath: path.join(audioDir, filename) });
  return { ok: true, elapsedMs: Date.now() - started, translatedText, duration: voice.duration,
    audioUrl: `${audioBaseUrl}/${filename}`, textModel: metrics.openaiTextModel, voiceModel: voice.ttsModel };
}
