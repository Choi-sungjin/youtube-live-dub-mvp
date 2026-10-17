import {
  ensureRuntimeEnv,
  fetchYouTubeCaptions,
  json,
  setCors
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

  try {
    await ensureRuntimeEnv();
    const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
    const videoId = String(url.searchParams.get('videoId') || '').trim();
    const result = await fetchYouTubeCaptions(videoId);
    json(res, 200, result);
  } catch (error) {
    json(res, error.statusCode || 500, {
      error: error.message || 'Unexpected captions error.'
    });
  }
}
