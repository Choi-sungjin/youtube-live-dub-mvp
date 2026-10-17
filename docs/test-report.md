# Test Report

Date: 2026-05-01

## Sample Video

Primary:

- Code.org, "The Internet: HTTP & HTML"
- https://www.youtube.com/watch?v=kBXQZMmiA4s

Fallback:

- Code.org, "What is the Internet?"
- https://www.youtube.com/watch?v=Dxcc6ycZ73M

## Local Checks

Passed:

- `node --check backend/server.js`
- `node --check backend/scripts/test-prepare.js`
- `node --check extension/background.js`
- `node --check extension/content.js`
- `GET /health` on `http://127.0.0.1:18787`
- `BACKEND_URL=http://127.0.0.1:18787 npm run test:prepare`
- Repeated prepare request returned cache hits.
- Generated audio URL returned `Content-Type: audio/wav`.
- Downloaded test audio was RIFF/WAVE PCM, mono, 24000 Hz.
- Provider health now reports OpenAI script mode, Supertone TTS mode, four
  configured Supertone voice IDs, pitch `0`, pitch variance `1.5`, and speed
  `1.29`.

## Notes

- Port `8787` was already in use in this environment, so live verification used `18787`.
- The extension includes a Backend URL field; set it to `http://127.0.0.1:18787` when testing with that port.
- The live Supertone request path is wired but was not exercised in the smoke
  test to avoid spending provider credits. The tested prepare request used
  `ttsProvider: "mock-wav"` and confirmed the response/audio contract.
- `OPENAI_API_KEY` is not configured in this workspace, so OpenAI script
  generation currently falls back to the local mock path with a warning.

## 2026-05-02 Local STT Fallback Check

Video:

- https://www.youtube.com/watch?v=aDrXG3OdKLw

Passed:

- Extension updated to `0.4.1`.
- Browser caption priming path added before backend fallback.
- Local `/api/captions` now falls back to `backend/.cache/stt/<videoId>.segments.json`.
- Windows `yt-dlp` downloaded original audio and converted it to WAV.
- Whisper STT generated `backend/.cache/stt/aDrXG3OdKLw.segments.json`.
- `GET http://127.0.0.1:18788/api/captions?videoId=aDrXG3OdKLw` returned `source: "local-stt-cache"` with 21 segments for the first 45 seconds.
- Z.ai translation and Supertone TTS prewarmed 8 audio clips through `http://127.0.0.1:18788/api/dub/prepare`.
- Syntax checks passed for `scripts/preprocess-dub.js`, `backend/server.js`, `extension/content.js`, and `extension/page-probe.js`.

Command used:

```bash
npm run dub:preprocess -- https://www.youtube.com/watch?v=aDrXG3OdKLw --language ja --stt-model base --max-duration 45 --prewarm-segments 8 --backend http://127.0.0.1:18788
```

## 2026-05-02 Dynamic New-Video STT Check

Video:

- https://www.youtube.com/watch?v=Ox4hzAo3MUU

Passed:

- Removed the `aDrXG3OdKLw` hardcoded extension fallback that made the test non-general.
- Added local backend `POST /api/captions/preprocess` and `GET /api/captions/preprocess?videoId=...`.
- Added extension-side STT fallback polling when YouTube/browser/backend captions all fail.
- Fixed a raw Whisper JSON cache bug that could reuse a previous video's transcript.
- Changed preprocessing to cut the requested audio window before Whisper, instead of transcribing the full video first.
- Verified dynamic preprocessing for `Ox4hzAo3MUU` with `maxDuration=15`; `/api/captions` returned `source: "local-stt-cache"` and 3 Japanese timed segments.

Backend endpoint check:

```powershell
$body = @{
  videoId = "Ox4hzAo3MUU"
  videoUrl = "https://www.youtube.com/watch?v=Ox4hzAo3MUU"
  language = "ja"
  sttModel = "tiny"
  maxDuration = 15
  prewarmSegments = 0
  force = $true
} | ConvertTo-Json -Compress

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:18789/api/captions/preprocess -ContentType application/json -Body $body
Invoke-RestMethod -Uri http://127.0.0.1:18789/api/captions?videoId=Ox4hzAo3MUU
```

## 2026-05-02 English Video E2E Check

Video:

- https://www.youtube.com/watch?v=T-HZHO_PQPY

Passed:

- Added `npm run verify:e2e`.
- Verified Windows local backend at `http://127.0.0.1:18789`.
- Verified health reports Z.ai and Supertone configured.
- Forced fresh STT preprocessing for the English video.
- Verified `/api/captions` returned `source: "local-stt-cache"`.
- Verified `/api/dub/prepare` returned 2 prepared Korean TTS clips.
- Downloaded the first generated audio URL and verified `Content-Type: audio/wav`, `RIFF` header, and `355490` bytes.

Command:

```powershell
cd "$env:USERPROFILE\youtube-live-dub-mvp"
npm.cmd run verify:e2e -- "https://www.youtube.com/watch?v=T-HZHO_PQPY" --backend http://127.0.0.1:18789 --language en --stt-model tiny --max-duration 20 --prepare-segments 2 --force true
```
