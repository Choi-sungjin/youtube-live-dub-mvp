import { diagnoseYouTubeCaptions, ensureRuntimeEnv } from '../lib/dub-core.js';

await ensureRuntimeEnv();

const videoIds = process.argv.slice(2);
const targets = videoIds.length
  ? videoIds
  : [
    'kBXQZMmiA4s',
    'T-HZHO_PQPY',
    'Ox4hzAo3MUU'
  ];

for (const videoId of targets) {
  try {
    const result = await diagnoseYouTubeCaptions(videoId);
    console.log(JSON.stringify({
      videoId: result.videoId,
      title: result.watch.title,
      supported: result.supported,
      supportSource: result.supportSource,
      reason: result.reason,
      tracks: result.tracks.map((track) => ({
        languageCode: track.languageCode,
        kind: track.kind,
        name: track.name,
        segmentCount: track.segmentCount,
        attempts: track.attempts.map((attempt) => ({
          format: attempt.format,
          status: attempt.status,
          bytes: attempt.bytes,
          segmentCount: attempt.segmentCount,
          error: attempt.error
        }))
      })),
      transcriptEndpoint: {
        present: result.transcriptEndpoint.present,
        attempted: result.transcriptEndpoint.attempted,
        status: result.transcriptEndpoint.status,
        segmentCount: result.transcriptEndpoint.segmentCount,
        error: result.transcriptEndpoint.error
      }
    }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({
      videoId,
      supported: false,
      error: error.message || String(error)
    }, null, 2));
  }
}
