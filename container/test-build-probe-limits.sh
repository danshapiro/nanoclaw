#!/usr/bin/env bash
# Execute the actual build driver without starting Docker or sending traffic.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export DOCKER_TRACE="$tmp/trace"
cat > "$tmp/fake-runtime" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  build) echo build >> "$DOCKER_TRACE" ;;
  run)
    shift
    # Each cap must appear once and before the image/entrypoint arguments.
    expected=(--memory=2g --memory-swap=2g --pids-limit=512)
    seen=()
    while [[ "$1" != --entrypoint ]]; do
      case "$1" in --memory=*|--memory-swap=*|--pids-limit=*) seen+=("$1");; esac
      shift
    done
    [[ "${seen[*]}" == "${expected[*]}" ]]
    [[ "$2" == sh && "$3" == *:fixture ]]
    echo probe >> "$DOCKER_TRACE"
    ;;
  *) exit 99 ;;
esac
FAKE
chmod +x "$tmp/fake-runtime"
CONTAINER_RUNTIME="$tmp/fake-runtime" INSTALL_CJK_FONTS=false bash "$here/build.sh" fixture
diff -u <(printf 'build\nprobe\nprobe\nprobe\nprobe\n') "$DOCKER_TRACE"
