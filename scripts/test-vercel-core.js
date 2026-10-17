process.env.TRANSLATION_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock-wav';
process.env.MAX_DUB_SEGMENTS = '2';

const { ensureRuntimeEnv, prepareDub } = await import('../lib/dub-core.js');

await ensureRuntimeEnv();

const result = await prepareDub({
  videoId: 'kBXQZMmiA4s',
  segments: [
    {
      index: 0,
      start: 0,
      end: 3.2,
      text: "I'm Jasmine Lawrence and I'm a program manager on the Xbox One engineering team."
    },
    {
      index: 1,
      start: 3.2,
      end: 7.2,
      text: 'One of our biggest features is called Xbox Live.'
    }
  ],
  settings: {
    voice: '763d5f200a9f5808056733',
    tone: 'neutral',
    targetLang: 'ko',
    ttsModel: 'sona_speech_2_flash',
    pitchShift: 0,
    pitchVariance: 1.5,
    speed: 1.29,
    ttsProvider: 'mock-wav'
  }
});

if (!Array.isArray(result.segments) || result.segments.length !== 2) {
  throw new Error('Expected two prepared segments.');
}

for (const segment of result.segments) {
  if (!segment.audioDataUrl?.startsWith('data:audio/wav;base64,')) {
    throw new Error('Expected inline WAV audio data.');
  }
}

console.log(JSON.stringify({
  ok: true,
  segments: result.segments.length,
  firstBytes: result.segments[0].bytes,
  provider: result.provider
}, null, 2));
