#!/usr/bin/env bash
set -euo pipefail

APP_PORT="${APP_PORT:-8000}"
APP_HOST="${APP_HOST:-0.0.0.0}"
APP_RELOAD="${APP_RELOAD:-0}"
CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"
PUBLIC_BASIC_AUTH_USER="${PUBLIC_BASIC_AUTH_USER:-}"
PUBLIC_BASIC_AUTH_PASSWORD="${PUBLIC_BASIC_AUTH_PASSWORD:-}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed"
  exit 1
fi

if [[ -z "${PUBLIC_BASIC_AUTH_USER}" ]]; then
  echo "PUBLIC_BASIC_AUTH_USER is required"
  exit 1
fi

if [[ -z "${PUBLIC_BASIC_AUTH_PASSWORD}" ]]; then
  echo "PUBLIC_BASIC_AUTH_PASSWORD is required"
  exit 1
fi

if [[ "${#PUBLIC_BASIC_AUTH_PASSWORD}" -lt 8 ]]; then
  echo "PUBLIC_BASIC_AUTH_PASSWORD must be at least 8 characters"
  exit 1
fi

cleanup() {
  local exit_code=$?
  if [[ -n "${UVICORN_PID:-}" ]]; then
    kill "${UVICORN_PID}" >/dev/null 2>&1 || true
  fi
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

UVICORN_ARGS=(backend.main:app --host "${APP_HOST}" --port "${APP_PORT}")
if [[ "${APP_RELOAD}" == "1" ]]; then
  UVICORN_ARGS+=(--reload)
fi

python3 -m uvicorn "${UVICORN_ARGS[@]}" &
UVICORN_PID=$!

echo "Local app: http://127.0.0.1:${APP_PORT}"
echo "Cloudflare Quick Tunnel is starting..."
cloudflared tunnel --protocol "${CLOUDFLARED_PROTOCOL}" --url "http://127.0.0.1:${APP_PORT}"
