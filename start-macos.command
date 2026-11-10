#!/bin/bash
source "$(dirname "$0")/scripts/macos-common.sh"
node scripts/macos-local.mjs start
if [[ "${YLD_OPEN_DIAGNOSTICS:-0}" == 1 ]]; then open 'http://127.0.0.1:18789/diagnostics'; fi
