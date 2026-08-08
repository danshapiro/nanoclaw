#!/bin/bash
# Build the NanoClaw agent container image.
#
# Reads one optional build flag from ../.env:
#   INSTALL_CJK_FONTS=true   — add Chinese/Japanese/Korean fonts (~200MB)
# setup/container.ts reads the same file, so both build paths stay in sync.
# Callers can also override by exporting INSTALL_CJK_FONTS directly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# Derive the image name from the project root so two NanoClaw installs on the
# same host don't overwrite each other's `nanoclaw-agent:latest` tag. Matches
# setup/lib/install-slug.sh + src/install-slug.ts.
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE_NAME="$(container_image_base)"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Caller's env takes precedence; fall back to .env.
if [ -z "${INSTALL_CJK_FONTS:-}" ] && [ -f "../.env" ]; then
    INSTALL_CJK_FONTS="$(grep '^INSTALL_CJK_FONTS=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi

BUILD_ARGS=()
if [ "${INSTALL_CJK_FONTS:-false}" = "true" ]; then
    echo "CJK fonts: enabled (adds ~200MB)"
    BUILD_ARGS+=(--build-arg INSTALL_CJK_FONTS=true)
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build "${BUILD_ARGS[@]}" -t "${IMAGE_NAME}:${TAG}" .

echo "Verifying yt-dlp and ffmpeg in the built image..."
# shellcheck disable=SC2016 # The quoted script expands inside the container.
${CONTAINER_RUNTIME} run --rm \
    --network none \
    --entrypoint sh \
    "${IMAGE_NAME}:${TAG}" \
    -lc 'set -eu
test -x /usr/local/bin/yt-dlp
yt-dlp --version
rm -f /tmp/yt-dlp-smoke.out
yt_dlp_status=0
yt-dlp --verbose --simulate "data:text/html,<title>yt-dlp-smoke</title>" >/tmp/yt-dlp-smoke.out 2>&1 || yt_dlp_status=$?
cat /tmp/yt-dlp-smoke.out
test "$yt_dlp_status" -ne 0
grep -Eq "JS runtimes: node(-[0-9.]+)?" /tmp/yt-dlp-smoke.out
grep -Eq "exe versions:.*ffmpeg .*ffprobe " /tmp/yt-dlp-smoke.out
grep -q "ERROR: Unsupported URL:" /tmp/yt-dlp-smoke.out'

echo "Verifying python3.12 (uv-managed) alongside distro python3 as a non-root uid..."
# Mirror production agent spawns: an arbitrary host uid with no /etc/passwd
# entry (src/container-runner.ts pushes --user <uid>:<gid> + HOME=/home/node).
# shellcheck disable=SC2016 # The quoted script expands inside the container.
${CONTAINER_RUNTIME} run --rm \
    --network none \
    --user 12345:12345 \
    -e HOME=/home/node \
    --entrypoint sh \
    "${IMAGE_NAME}:${TAG}" \
    -c 'set -eu
python3.12 --version
python3.12 -c "import sys; print(sys.version)"
case "$(python3.12 --version 2>&1)" in "Python 3.12."*) ;; *) echo "unexpected python3.12 version" >&2; exit 1 ;; esac
case "$(python3 --version 2>&1)" in "Python 3.11."*) ;; *) echo "distro python3 is no longer 3.11" >&2; exit 1 ;; esac'

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
