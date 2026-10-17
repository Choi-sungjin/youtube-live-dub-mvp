# Local YouTube Dubbing MVP Plan

## Scope

Build a personal Chrome developer-mode extension that overlays Korean dubbed
audio on YouTube videos with available captions.

## Architecture

```text
YouTube watch page
  -> Chrome extension content script
  -> local backend /api/dub/prepare
  -> translated timed segments + audio URLs
  -> extension audio scheduler
```

## API Contract

Request:

```json
{
  "videoId": "kBXQZMmiA4s",
  "segments": [
    { "start": 0.2, "end": 3.8, "text": "We hear about calories all the time." }
  ],
  "settings": {
    "voice": "mock-ko-1",
    "tone": "neutral",
    "speed": 1
  }
}
```

Response:

```json
{
  "videoId": "VEQaH4LruUo",
  "cache": { "hit": false },
  "segments": [
    {
      "id": "segment-id",
      "start": 0.2,
      "end": 3.8,
      "sourceText": "We hear about calories all the time.",
      "translatedText": "한국어 번역: We hear about calories all the time.",
      "audioUrl": "http://127.0.0.1:8787/audio/segment-id.wav",
      "duration": 3.6
    }
  ]
}
```

## Verification

1. Backend health responds at `GET /health`.
2. `POST /api/dub/prepare` returns playable audio URLs without API keys.
3. Extension loads unpacked in Chrome developer mode.
4. Extension detects YouTube video id and current time.
5. Caption segments are collected or pasted fallback demo segments are used.
6. Audio starts, pauses, and seeks with the YouTube player.

## Sample

Primary:

- https://www.youtube.com/watch?v=kBXQZMmiA4s

Fallback:

- https://www.youtube.com/watch?v=Dxcc6ycZ73M

