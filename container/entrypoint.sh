#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# If docker run supplies a command, execute it directly. This keeps image
# surface smokes such as `docker run IMAGE sh -lc ...` from requiring the
# runtime-only /app/src bind mount.
#
# Without command arguments, capture stdin to a file first so /tmp/input.json is
# available for post-mortem inspection if the container exits unexpectedly, then
# exec bun so that bun becomes PID 1's direct child (under tini) and receives
# signals.

set -e

if [[ "$#" -gt 0 ]]; then
  exec "$@"
fi

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
