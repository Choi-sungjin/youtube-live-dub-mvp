#!/bin/bash
# Shared by the Finder launchers; never source .env as shell code.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'This launcher is for macOS. See docs/install-windows.md or docs/install-linux.md.' >&2
  exit 1
fi
DUB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DUB_ROOT"
trap 'code=$?; if [[ $code != 0 ]]; then echo "Setup failed. Review the error above." >&2; if [[ -t 0 ]]; then read -r -p "Press Return to close." _; fi; fi' EXIT
