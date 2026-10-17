import {
  ensureRuntimeEnv,
  json,
  providerInfo,
  setCors,
  SUPERTONE_VOICES
} from '../lib/dub-core.js';

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method not allowed.' });
    return;
  }

  await ensureRuntimeEnv();
  json(res, 200, {
    ok: true,
    runtime: 'vercel-functions',
    provider: providerInfo(),
    voices: Object.values(SUPERTONE_VOICES)
  });
}
