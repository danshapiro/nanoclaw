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

# --- begin onecli-ca-bundle ---
# The OneCLI provisioner points SSL_CERT_FILE / CODEX_CA_CERTIFICATE at a pem
# containing ONLY the gateway CA. rustls-native-certs treats SSL_CERT_FILE as
# the EXCLUSIVE root store, so the codex websocket client would trust only the
# gateway CA and fail with UnknownIssuer on tunneled (non-MITM'd) hosts such
# as chatgpt.com. Prepend the system roots so both the gateway CA and public
# chains verify. NODE_EXTRA_CA_CERTS is additive and left alone.
ca_pem="${CODEX_CA_CERTIFICATE:-${SSL_CERT_FILE:-}}"
if [ -n "$ca_pem" ] && [ -f "$ca_pem" ] && [ -r "$ca_pem" ]; then
  system_bundle="${NANOCLAW_SYSTEM_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
  bundle_out="${NANOCLAW_CA_BUNDLE_OUT:-/tmp/onecli-ca-bundle.pem}"
  if [ -f "$system_bundle" ] && [ -r "$system_bundle" ]; then
    if cat "$system_bundle" "$ca_pem" > "$bundle_out"; then
      export SSL_CERT_FILE="$bundle_out"
      export CODEX_CA_CERTIFICATE="$bundle_out"
    else
      echo "entrypoint: failed to write $bundle_out; leaving SSL_CERT_FILE/CODEX_CA_CERTIFICATE unchanged" >&2
    fi
  else
    echo "entrypoint: system CA bundle $system_bundle missing; leaving SSL_CERT_FILE/CODEX_CA_CERTIFICATE unchanged" >&2
  fi
fi
# --- end onecli-ca-bundle ---

exec bun run /app/src/index.ts < /tmp/input.json
