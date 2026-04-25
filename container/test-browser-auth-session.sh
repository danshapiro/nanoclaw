#!/usr/bin/env bash
set -euo pipefail

IMAGE_TAG="nanoclaw-agent:browser-auth-test"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

docker build -t "$IMAGE_TAG" "$SCRIPT_DIR"
docker run --rm --entrypoint bash "$IMAGE_TAG" -lc '
  set -euo pipefail
  command -v Xvfb
  command -v x11vnc
  if command -v websockify >/dev/null 2>&1; then
    echo "websockify should not be installed" >&2
    exit 1
  fi
  test ! -d /usr/share/novnc
  test -x /app/browser-auth-session.sh
'
