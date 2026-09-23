#!/usr/bin/env bash
# Build-on-deploy for Holocene.
#
#   deploy.sh api   build @holocene/api (+ the workspace libs its build script
#                   compiles), restart holocene-api.service, wait for /health
#   deploy.sh web   restart the holocene-web container; its command rebuilds
#                   org-model + the Next app on every start, so a restart IS the
#                   deploy. Waits for the container healthcheck.
#   deploy.sh all   api, then web (web SSR reads the API)
#
# Why: holocene-api runs apps/api/dist/server.js, and nothing rebuilt dist when
# source moved (it once sat 9 days stale, still serving retired bridge routes).
#
# Env knobs: HOLOCENE_API_URL (default http://127.0.0.1:4000),
#            HOLOCENE_WEB_CONTAINER (default holocene-web),
#            DEPLOY_WEB_TIMEOUT seconds (default 900; Next builds are slow on a loaded host),
#            DEPLOY_NO_WAIT=1 to skip the web health wait.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
api_url="${HOLOCENE_API_URL:-http://127.0.0.1:4000}"
web_container="${HOLOCENE_WEB_CONTAINER:-holocene-web}"
web_timeout="${DEPLOY_WEB_TIMEOUT:-900}"
unit="holocene-api.service"

log() { printf '[deploy] %s\n' "$*" >&2; }

deploy_api() {
  log "building @holocene/api"
  (cd "$root" && pnpm --filter @holocene/api build)

  local dist="$root/apps/api/dist/server.js"
  [[ -f "$dist" ]] || { log "build produced no $dist"; exit 1; }

  log "restarting $unit"
  systemctl --user daemon-reload
  systemctl --user restart "$unit"

  local i
  for ((i = 1; i <= 30; i++)); do
    if curl -fsS -m 3 "$api_url/health" >/dev/null 2>&1; then
      log "api healthy after ${i}s ($api_url/health); dist built $(date -r "$dist" '+%F %T')"
      return 0
    fi
    sleep 1
  done
  log "api did not answer $api_url/health within 30s"
  systemctl --user status "$unit" --no-pager -n 20 >&2 || true
  exit 1
}

deploy_web() {
  if ! docker inspect "$web_container" >/dev/null 2>&1; then
    log "container $web_container not found; bring it up from 33god-platform/compose.yaml first"
    exit 1
  fi
  log "restarting $web_container (rebuilds on start)"
  docker restart "$web_container" >/dev/null

  if [[ "${DEPLOY_NO_WAIT:-0}" == "1" ]]; then
    log "DEPLOY_NO_WAIT=1: not waiting for the web build"
    return 0
  fi

  local started status elapsed=0
  started="$(date +%s)"
  while ((elapsed < web_timeout)); do
    status="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$web_container")"
    case "$status" in
      "running healthy")
        log "web healthy after ${elapsed}s"
        return 0 ;;
      exited* | dead*)
        log "web container stopped: $status"
        docker logs --tail 40 "$web_container" >&2 || true
        exit 1 ;;
    esac
    sleep 5
    elapsed=$(($(date +%s) - started))
  done
  log "web not healthy after ${web_timeout}s (status: $status)"
  docker logs --tail 40 "$web_container" >&2 || true
  exit 1
}

case "${1:-all}" in
  api) deploy_api ;;
  web) deploy_web ;;
  all) deploy_api; deploy_web ;;
  *) echo "usage: $0 [api|web|all]" >&2; exit 2 ;;
esac
