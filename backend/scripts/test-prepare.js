const backendUrl = String(process.env.BACKEND_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');

const response = await fetch(`${backendUrl}/api/dub/prepare`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    videoId: 'kBXQZMmiA4s',
    segments: [
      {
        start: 0,
        end: 3.2,
        text: "I'm Jasmine Lawrence and I'm a program manager on the Xbox One engineering team."
      },
      {
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
  })
});

const body = await response.json();
console.log(JSON.stringify(body, null, 2));

if (!response.ok || !Array.isArray(body.segments) || !body.segments[0]?.audioUrl) {
  process.exitCode = 1;
}
