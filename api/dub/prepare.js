import {
  ensureRuntimeEnv,
  json,
  prepareDub,
  readJson,
  setCors
} from '../../lib/dub-core.js';

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed.' });
    return;
  }

  try {
    await ensureRuntimeEnv();
    const body = await readJson(req);
    const result = await prepareDub(body);
    json(res, 200, result);
  } catch (error) {
    json(res, error.statusCode || 500, {
      error: error.message || 'Unexpected prepare error.'
    });
  }
}
