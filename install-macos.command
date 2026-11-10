#!/bin/bash
source "$(dirname "$0")/scripts/macos-common.sh"
if ! command -v brew >/dev/null; then
  echo 'Install Homebrew from https://brew.sh, then run this installer again.' >&2
  exit 1
fi
for formula in node python@3.12 ffmpeg ollama; do
  case "$formula" in
    python@3.12) executable=python3.12 ;;
    *) executable="$formula" ;;
  esac
  if ! command -v "$executable" >/dev/null; then brew install "$formula"; fi
done
node -e 'if (+process.versions.node.split(".")[0] < 22) { console.error("Node 22+ required; upgrade Node and retry."); process.exit(1); }'
npm ci
if [[ ! -x .venv/bin/python ]]; then python3.12 -m venv .venv; fi
.venv/bin/python -c 'import sys; assert sys.version_info[:2] == (3, 12), "Use a Python 3.12 .venv; preserve/move the existing environment first."'
.venv/bin/python -m ensurepip --upgrade
.venv/bin/python -m pip install -r requirements-tools.txt -r requirements-supertonic.txt -r requirements-stt-fast.txt
node scripts/macos-local.mjs configure
node scripts/macos-local.mjs ollama
node scripts/macos-local.mjs install-model
.venv/bin/python scripts/setup-models.py supertonic
.venv/bin/python scripts/setup-models.py stt --device cpu
if [[ "${YLD_INSTALL_SPEAKER:-0}" == 1 ]]; then
  .venv/bin/python scripts/setup-speaker-model.py
fi
./start-macos.command
echo 'Setup complete. In Chrome, open chrome://extensions, enable Developer mode, and load this project’s extension folder.'
