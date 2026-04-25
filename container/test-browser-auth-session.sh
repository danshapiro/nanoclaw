#!/usr/bin/env bash
set -euo pipefail

IMAGE_TAG="nanoclaw-agent:browser-auth-test"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

docker build -t "$IMAGE_TAG" "$SCRIPT_DIR"
docker run --rm --entrypoint bash "$IMAGE_TAG" -lc '
  command -v Xvfb
  command -v x11vnc
  command -v websockify
  test -d /usr/share/novnc
  test -x /app/browser-auth-session.sh
'
