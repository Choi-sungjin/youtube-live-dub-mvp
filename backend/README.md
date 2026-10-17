# Backend

Local Node.js server for the YouTube Live Dub MVP.

The server keeps API keys out of the Chrome extension. Put provider keys in
`.env` or set them as environment variables before starting the server.

## Run

```bash
npm start
```

The server listens at:

```text
http://127.0.0.1:8787
```

Use another port if needed:

```bash
PORT=18787 node server.js
```

## Endpoints

- `GET /health`
- `POST /api/dub/prepare`
- `GET /audio/:id.wav`

The default provider is `mock-wav`, so no API key is required. This verifies the
extension, buffering, and audio sync path without exposing a key in Chrome.

The real-provider path supports Z.ai for translation and Supertone for TTS:

- `TRANSLATION_PROVIDER=zai`
- `ZAI_API_KEY=...`
- `ZAI_MODEL=glm-4.7`
- `TRANSLATION_PROVIDER=openai` is still available as an alternate path.
- `OPENAI_API_KEY=...`
- `OPENAI_MODEL=gpt-5.2`
- `TTS_PROVIDER=supertone`
- `SUPERTONE_API_KEY=...`
- `SUPERTONE_MODEL=sona_speech_2_flash`

Supertone voice settings:

- `SUPERTONE_PITCH_SHIFT=0`
- `SUPERTONE_PITCH_VARIANCE=1.5`
- `SUPERTONE_SPEED=1.29`

Voice IDs:

- Low male: `763d5f200a9f5808056733`
- High male: `8590d2b8884926372c6b4f`
- Female: `2c5f135cb33f49a2c8882d`
- Low female: `d39f0ea3c259e885e69a3c`

If the configured translation provider key is missing, the server returns a
warning and falls back to the local mock Korean script. Browser login sessions
are not used as API authentication.

## Smoke Test

With the server running:

```bash
npm run test:prepare
```

With a non-default port:

```bash
BACKEND_URL=http://127.0.0.1:18787 npm run test:prepare
```

The smoke test uses local mock audio unless the request explicitly uses the
Supertone provider.
