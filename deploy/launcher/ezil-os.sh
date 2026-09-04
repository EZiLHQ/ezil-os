#!/usr/bin/env bash
#
# EZiL OS — local mode launcher (macOS/Linux).
#
# Checks Docker and Bun, pulls the pinned desktop image, runs the doctor,
# starts the local host, opens the browser once it answers, and cleans up
# on Ctrl-C. Nothing here is installed for you: a missing prerequisite is
# printed with the one command that fixes it, and the script exits 2.
#
# 🔴 BASH 3.2 COMPATIBLE, ON PURPOSE — this is what macOS ships and PR #14 on
# this repo found bash-4-only builtins (mapfile, an associative array, BSD
# `base64` without `-i`) break silently on it. Nothing below uses an
# associative array, a C-style array reader, or `${var,,}`/`${var^^}` case
# conversion — release.yml greps for exactly those.
#
# 🔴 EVERY OUTBOUND HOST THIS SCRIPT CAN REACH: the container registry
# (`docker pull`), the Docker install page (`docs.docker.com`, printed only,
# never fetched), the Bun installer (`bun.sh`, printed only, never fetched by
# this script), and its own loopback host (`127.0.0.1`). release.yml's static
# check enforces that this list does not grow silently.
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: ezil-os.sh [--no-browser]

  --no-browser   Do not open a browser once the local host answers.

Environment (all optional):
  EZIL_LAUNCHER_IMAGE   Use this image reference instead of deploy/images.env
                         (skips deploy/images.env entirely; the image must
                         already be present locally, or be a real registry ref).
  EZIL_LOCAL_PORT_OFFSET / EZIL_LOCAL_PORT / EZIL_LOCAL_WORKSPACE / etc.
                         Passed through unchanged to `bun run --cwd local
                         doctor` and `start` — see local/src/config.ts.
EOF
}

info() { printf '[ezil-os] %s\n' "$*"; }
err()  { printf '[ezil-os] ERROR: %s\n' "$*" >&2; }

NO_BROWSER=0
for arg in "$@"; do
    case "$arg" in
        --no-browser) NO_BROWSER=1 ;;
        -h|--help) usage; exit 0 ;;
        *) err "unknown argument '$arg'"; usage >&2; exit 2 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCAL_DIR="$REPO_ROOT/local"
IMAGES_ENV="$REPO_ROOT/deploy/images.env"

# ── 1. Docker ─────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
    err "docker was not found on PATH."
    echo "Install Docker Desktop (macOS/Windows) or Docker Engine (Linux): https://docs.docker.com/get-docker/" >&2
    exit 2
fi
if ! DOCKER_VERSION_OUT="$(docker version 2>&1)"; then
    err "docker is on PATH but the daemon did not answer 'docker version':"
    echo "$DOCKER_VERSION_OUT" >&2
    echo "Start Docker Desktop, or 'sudo systemctl start docker' on Linux, then re-run this script." >&2
    exit 2
fi

# ── 2. Bun ────────────────────────────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
    err "bun was not found on PATH. The local host runs on Bun, and this script will not install it for you."
    echo "Install it: curl -fsSL https://bun.sh/install | bash" >&2
    exit 2
fi

# ── 3. Resolve the image reference ───────────────────────────────────────
# `|| true` at the end, not inside: under `set -o pipefail` a key that is
# simply ABSENT (grep matches nothing, exit 1) would otherwise abort this
# whole script via `set -e` on the `X="$(read_env_key ...)"` assignment —
# reproduced locally before this fix landed. EZIL_DESKTOP_DIGEST is absent
# from deploy/images.env today and must resolve to "", not kill the launcher.
read_env_key() { grep -E "^[[:space:]]*${1}[[:space:]]*=" "$2" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true; }

EXPECT_DIGEST=""
if [ -n "${EZIL_LAUNCHER_IMAGE:-}" ]; then
    IMAGE_REF="$EZIL_LAUNCHER_IMAGE"
    IMAGE_SOURCE="EZIL_LAUNCHER_IMAGE override"
else
    if [ ! -f "$IMAGES_ENV" ]; then
        err "deploy/images.env not found at $IMAGES_ENV"
        exit 2
    fi
    DESKTOP_IMAGE="$(read_env_key EZIL_DESKTOP_IMAGE "$IMAGES_ENV")"
    DESKTOP_TAG="$(read_env_key EZIL_DESKTOP_TAG "$IMAGES_ENV")"
    EXPECT_DIGEST="$(read_env_key EZIL_DESKTOP_DIGEST "$IMAGES_ENV")"
    if [ -z "$DESKTOP_IMAGE" ] || [ -z "$DESKTOP_TAG" ]; then
        err "deploy/images.env is missing EZIL_DESKTOP_IMAGE or EZIL_DESKTOP_TAG."
        exit 2
    fi
    # Docker's tag grammar (local/src/container/run-spec.ts's isDockerTag).
    # deploy/images.env ships a placeholder ('<to be pinned by CI>') until a
    # release actually pins a tag (docs/TASKS.csv row T7) — refuse to compose
    # a reference from it rather than let `docker pull` fail with a confusing
    # error three steps later.
    if ! [[ "$DESKTOP_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]]; then
        err "EZIL_DESKTOP_TAG in deploy/images.env ('$DESKTOP_TAG') is not a valid Docker tag — this checkout has no image pinned yet."
        echo "Set EZIL_LAUNCHER_IMAGE=<image:tag> to point at an image you already have, or use a published release tarball." >&2
        exit 2
    fi
    IMAGE_REF="${DESKTOP_IMAGE}:${DESKTOP_TAG}"
    IMAGE_SOURCE="deploy/images.env"
fi

# ── 4. Pull it ────────────────────────────────────────────────────────────
case "$(uname -m)" in
    arm64|aarch64)
        info "Host architecture is $(uname -m); the desktop image is amd64 and will run under emulation (qemu/Rosetta) — expect a slower boot." ;;
esac

if docker image inspect "$IMAGE_REF" >/dev/null 2>&1; then
    info "Image $IMAGE_REF already present locally ($IMAGE_SOURCE) — skipping pull."
else
    info "Pulling $IMAGE_REF from the registry ($IMAGE_SOURCE)."
    info "Expect roughly 1.4 GB to transfer and about 4.6 GB on disk (amd64)."
    docker pull "$IMAGE_REF"
fi

if [ -n "$EXPECT_DIGEST" ]; then
    ACTUAL_DIGESTS="$(docker image inspect "$IMAGE_REF" --format '{{join .RepoDigests ","}}' 2>/dev/null || true)"
    if [[ "$ACTUAL_DIGESTS" == *"$EXPECT_DIGEST"* ]]; then
        info "Digest pin verified: $EXPECT_DIGEST"
    else
        err "EZIL_DESKTOP_DIGEST=$EXPECT_DIGEST in deploy/images.env does not match the pulled image's digest(s): ${ACTUAL_DIGESTS:-none reported}"
        exit 2
    fi
fi

# ── 5. The doctor ─────────────────────────────────────────────────────────
# Any EZIL_* the caller already exported (EZIL_LOCAL_PORT_OFFSET included) is
# already in this shell's environment and reaches `bun run` unchanged — bun
# is a direct child process, nothing here needs to re-forward it by name.
info "Running the doctor..."
if ! bun run --cwd "$LOCAL_DIR" doctor; then
    err "The doctor found something that will stop a desktop from starting (see above)."
    exit 1
fi

# ── 6. Start, wait for /os, open the browser, clean up on Ctrl-C ─────────
PORT="${EZIL_LOCAL_PORT:-7080}"
if [ "$PORT" = "0" ]; then
    err "EZIL_LOCAL_PORT=0 means 'the OS picks a free port', which this launcher cannot poll a fixed URL for. Unset it or set a specific port."
    exit 2
fi
OS_URL="http://127.0.0.1:${PORT}/os"

LOGFILE="$(mktemp 2>/dev/null || echo "/tmp/ezil-os-launcher.$$.log")"
PRE_CONTAINERS="$(docker ps -aq --filter 'name=^ezil-os-' 2>/dev/null || true)"

bun run --cwd "$LOCAL_DIR" start >"$LOGFILE" 2>&1 &
HOST_PID=$!

CLEANED=0
cleanup() {
    [ "$CLEANED" = "1" ] && return
    CLEANED=1
    info "Stopping the local host..."
    if kill -0 "$HOST_PID" 2>/dev/null; then
        kill -TERM "$HOST_PID" 2>/dev/null || true
        wait "$HOST_PID" 2>/dev/null || true
    fi
    # Only remove containers this run created — a container matching the
    # ezil-os- prefix that was already here (another run, another worktree)
    # is not this script's to destroy.
    NOW_CONTAINERS="$(docker ps -aq --filter 'name=^ezil-os-' 2>/dev/null || true)"
    for id in $NOW_CONTAINERS; do
        case " $PRE_CONTAINERS " in
            *" $id "*) ;;
            *) info "Removing container $id"; docker rm -f "$id" >/dev/null 2>&1 || true ;;
        esac
    done
}
on_signal() { cleanup; exit 0; }
trap on_signal INT TERM
trap cleanup EXIT

info "Waiting for $OS_URL to answer..."
READY=0
i=0
while [ "$i" -lt 60 ]; do
    if ! kill -0 "$HOST_PID" 2>/dev/null; then
        err "The local host exited before it answered. Log:"
        cat "$LOGFILE" >&2
        exit 1
    fi
    CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$OS_URL" 2>/dev/null || true)"
    [ "$CODE" = "200" ] && { READY=1; break; }
    sleep 0.5
    i=$((i + 1))
done

if [ "$READY" != "1" ]; then
    err "$OS_URL did not answer 200 within 30s. Log:"
    cat "$LOGFILE" >&2
    exit 1
fi

info "EZiL OS is up: $OS_URL"
if [ "$NO_BROWSER" != "1" ]; then
    if command -v open >/dev/null 2>&1; then
        open "$OS_URL"
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$OS_URL" >/dev/null 2>&1 &
    else
        info "Open $OS_URL in your browser."
    fi
fi

info "Press Ctrl-C to stop."
wait "$HOST_PID"
