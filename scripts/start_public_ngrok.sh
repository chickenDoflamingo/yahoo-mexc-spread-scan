#!/usr/bin/env bash
set -euo pipefail

APP_PORT="${APP_PORT:-8000}"
APP_HOST="${APP_HOST:-0.0.0.0}"
APP_RELOAD="${APP_RELOAD:-0}"
NGROK_AUTHTOKEN="${NGROK_AUTHTOKEN:-}"
PUBLIC_BASIC_AUTH_USER="${PUBLIC_BASIC_AUTH_USER:-}"
PUBLIC_BASIC_AUTH_PASSWORD="${PUBLIC_BASIC_AUTH_PASSWORD:-}"

if [[ -z "${NGROK_AUTHTOKEN}" ]]; then
  echo "NGROK_AUTHTOKEN is required"
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

if ! command -v ngrok >/dev/null 2>&1; then
  echo "ngrok is not installed"
  exit 1
fi

POLICY_FILE="$(mktemp /tmp/ngrok-policy.XXXXXX.yml)"
cleanup() {
  local exit_code=$?
  if [[ -n "${UVICORN_PID:-}" ]]; then
    kill "${UVICORN_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${POLICY_FILE}"
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

cat > "${POLICY_FILE}" <<EOF
on_http_request:
  - actions:
      - type: basic-auth
        config:
          realm: spread-monitor
          credentials:
            - "${PUBLIC_BASIC_AUTH_USER}:${PUBLIC_BASIC_AUTH_PASSWORD}"
EOF

UVICORN_ARGS=(backend.main:app --host "${APP_HOST}" --port "${APP_PORT}")
if [[ "${APP_RELOAD}" == "1" ]]; then
  UVICORN_ARGS+=(--reload)
fi

python3 -m uvicorn "${UVICORN_ARGS[@]}" &
UVICORN_PID=$!

echo "Local app: http://127.0.0.1:${APP_PORT}"
echo "Starting ngrok tunnel with basic auth..."
ngrok http "${APP_PORT}" \
  --authtoken "${NGROK_AUTHTOKEN}" \
  --traffic-policy-file "${POLICY_FILE}"
