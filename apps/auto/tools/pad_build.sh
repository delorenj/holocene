#!/usr/bin/env bash
# Production Agent Pad build. nginx serves apps/agent-pad/dist, so this IS the deploy.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../agent-pad"
[[ -d node_modules ]] || npm ci
npx vite build
echo "deployed: https://agent-pad.delo.sh/ now serves apps/agent-pad/dist"
