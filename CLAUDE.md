# YouTube Live Dub MVP

Reply in Korean. This repository contains a personal Chrome Manifest V3 extension
and a Node.js backend that prepares Korean dubbing for YouTube videos.

## Start here

- Node.js >=20 is required; prefer Node.js 22. The root and backend packages have
  no external npm dependencies. No npm install, Python model download, or API key
  is needed for the standard cloud development checks.
- Run `npm run test:cloud` before changing code and after relevant changes.
  It checks JavaScript syntax/version consistency, seven existing regression
  cases, and a mock translation/WAV contract. It uses loopback networking only.
- `.claude/settings.json` runs a lightweight SessionStart hook in cloud sessions.
- Follow `docs/claude-cloud.md` for cloud/local verification boundaries.

## Project map

- `extension/`: injected panel, popup, background worker, caption collection and
  playback scheduling against the YouTube video clock.
- `backend/server.js`: local HTTP API and diagnostics UI; default 127.0.0.1:18789.
- `backend/windows-speech.*`: Windows SAPI speech implementation.
- `native-host/`: Chrome native messaging and Windows installer scripts.
- `lib/dub-core.js`, `api/`: shared/serverless translation and TTS path.
- `scripts/`: checks, preprocessing and local verification tools.

## Verification rules

- Clearly separate executed checks, mocks, real-provider checks, and unknowns.
- Cloud Linux tests cannot prove Windows SAPI output, Windows native-host
  installation, the user's Chrome extension load state, or real YouTube
  Start/Stop/Seek/audio synchronization. Supply local verification steps when
  a change touches those behaviors.
- Do not silently replace provider failures with fake Korean text or mock audio.
  Mock providers are for explicitly selected test modes only.
- Keep package.json and extension/manifest.json versions consistent.
- Preserve loopback binding, late-response/session guards, and restoration of
  original video playback/volume when stopping or failing.
- Historical documents under docs/ describe earlier versions. They are not
  proof of current behavior; current source and fresh results take precedence.

## Credentials and changes

- Do not request or upload the user's .env files, tokens, browser data, audio
  caches, virtual environments, or machine-generated native-host manifest.
- Standard cloud work needs no API secrets. Real paid API use, deployment,
  browser/device integration, and model downloads require a separate user task.
- Work on a task branch and provide a reviewable diff/PR. Do not push changes
  directly to main or merge a PR unless the user asks.
- Finish with changes, exact commands/results, and remaining local checks.
