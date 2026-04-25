#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "$name is required"
  fi
}

wait_for_tcp() {
  local host="$1"
  local port="$2"
  local attempts="${3:-50}"
  local delay="${4:-0.2}"
  local i

  for ((i = 0; i < attempts; i++)); do
    if bash -lc ">/dev/tcp/$host/$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done

  return 1
}

cleanup() {
  local status=$?

  agent-browser --session "$SESSION_NAME" close >/dev/null 2>&1 || true

  for pid_var in AGENT_BROWSER_PID WEBSOCKIFY_PID X11VNC_PID XVFB_PID; do
    local pid="${!pid_var:-}"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" 2>/dev/null || true
    fi
  done

  exit "$status"
}

trap cleanup EXIT SIGTERM SIGINT

require_env URL
require_env PROFILE_DIR
require_env SESSION_NAME

mkdir -p "$PROFILE_DIR"

export DISPLAY=:99

Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp &
XVFB_PID=$!

wait_for_tcp 127.0.0.1 6000 5 0.1 || true
sleep 0.5

x11vnc -display "$DISPLAY" -rfbport 5900 -forever -shared -nopw >/tmp/browser-auth-session-x11vnc.log 2>&1 &
X11VNC_PID=$!

if ! wait_for_tcp 127.0.0.1 5900; then
  fail "x11vnc did not start listening on port 5900"
fi

websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/browser-auth-session-websockify.log 2>&1 &
WEBSOCKIFY_PID=$!

if ! wait_for_tcp 127.0.0.1 6080; then
  fail "websockify did not start listening on port 6080"
fi

agent-browser --session "$SESSION_NAME" --headed --profile "$PROFILE_DIR" open "$URL" &
AGENT_BROWSER_PID=$!

sleep 1
if ! kill -0 "$AGENT_BROWSER_PID" >/dev/null 2>&1; then
  wait "$AGENT_BROWSER_PID"
  AGENT_BROWSER_PID=""
fi

echo "BROWSER_AUTH_SESSION_READY"

while true; do
  if [[ -n "${XVFB_PID:-}" ]] && ! kill -0 "$XVFB_PID" >/dev/null 2>&1; then
    fail "Xvfb exited unexpectedly"
  fi
  if [[ -n "${X11VNC_PID:-}" ]] && ! kill -0 "$X11VNC_PID" >/dev/null 2>&1; then
    fail "x11vnc exited unexpectedly"
  fi
  if [[ -n "${WEBSOCKIFY_PID:-}" ]] && ! kill -0 "$WEBSOCKIFY_PID" >/dev/null 2>&1; then
    fail "websockify exited unexpectedly"
  fi
  sleep 5
done
