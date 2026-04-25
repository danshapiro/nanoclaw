#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

DOCKER_LOG="$TMPDIR/docker.log"

cat >"$TMPDIR/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$DOCKER_LOG"
EOF
chmod +x "$TMPDIR/docker"

PATH="$TMPDIR:$PATH" DOCKER_LOG="$DOCKER_LOG" bash "$SCRIPT_DIR/build.sh" browser-auth-host-profile >/dev/null

mapfile -t docker_args <"$DOCKER_LOG"

expected=(
  build
  --provenance=false
  -t
  nanoclaw-agent:browser-auth-host-profile
  .
)

if [[ "${#docker_args[@]}" -ne "${#expected[@]}" ]]; then
  echo "expected ${#expected[@]} docker args, got ${#docker_args[@]}" >&2
  printf 'actual args:\n' >&2
  printf '  %s\n' "${docker_args[@]}" >&2
  exit 1
fi

for i in "${!expected[@]}"; do
  if [[ "${docker_args[$i]}" != "${expected[$i]}" ]]; then
    echo "docker arg $i mismatch: expected '${expected[$i]}', got '${docker_args[$i]}'" >&2
    exit 1
  fi
done
