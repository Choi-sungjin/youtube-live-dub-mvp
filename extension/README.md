# YouTube Live Dub MVP Extension

Chrome Manifest V3 extension for developer-mode testing on `youtube.com/watch` pages.

## What it does

- Injects a compact "Live Dub MVP" panel on YouTube watch pages.
- Reads the current `videoId` from the URL and playback time from the HTML5 video element.
- Attempts to find YouTube caption tracks from `ytInitialPlayerResponse` / player response script data.
- Fetches the selected timedtext track, parses `json3` captions, and chunks caption segments.
- Sends caption chunks to the Vercel backend at the panel's Backend URL.
- Buffers returned inline audio data and syncs each clip against the YouTube video clock.
- Provides Start/Stop, backend URL, status, original volume, Supertone voice,
  model, pitch, pitch variance, speed, and target language controls.

## Expected backend response

The extension posts JSON shaped like:

```json
{
  "videoId": "abc123",
  "currentTime": 12.34,
  "source": "youtube-timedtext",
  "settings": {
    "voice": "mock-neutral",
    "tone": "neutral",
    "targetLang": "ko",
    "ttsModel": "sona_speech_2_flash",
    "pitchShift": 0,
    "pitchVariance": 1.5,
    "speed": 1.29
  },
  "segments": [
    {
      "id": "abc123-0",
      "index": 0,
      "start": 0,
      "end": 7.5,
      "text": "caption text",
      "segments": []
    }
  ]
}
```

The Vercel backend returns inline audio data:

```json
{
  "segments": [
    {
      "index": 0,
      "start": 0,
      "end": 7.5,
      "audioDataUrl": "data:audio/mpeg;base64,..."
    }
  ]
}
```

It can also read legacy shapes such as `audioUrls`, `chunks`, or `items`.

```json
{
  "chunks": [
    {
      "index": 0,
      "start": 0,
      "end": 7.5,
      "audioUrl": "http://127.0.0.1:8787/audio/chunk-0.mp3"
    }
  ]
}
```

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `extension/` directory.
5. Open a YouTube watch page and set the panel's Backend field to your Vercel origin, for example `https://y-alpha-self-86.vercel.app`.
6. Click **Test**.
7. Click **Start** in the injected panel.

## Notes

- This is an MVP. It has no extension build step and uses plain JS/CSS/HTML.
- Some videos do not expose captions, timedtext URLs, or fetchable caption data. The two Code.org sample videos include a small built-in fallback segment list for smoke testing.
- Chrome autoplay policy can block synthetic audio until the page has received a user gesture. Clicking **Start** usually satisfies this during local testing.
- The extension lowers the original YouTube video volume while running and restores the previous volume/mute state on Stop.
