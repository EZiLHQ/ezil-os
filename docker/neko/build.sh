#!/usr/bin/env bash
# Builds the pinned Neko + VS Code BASE image from docker/neko/pins.env.
#
# Ported from EBuilder's infra/neko-standalone/scripts/build.sh (same repo,
# same pinned SHAs, same validated `neko-apps ./build --application vscode`
# invocation): clones both upstream repos at their pinned commits, verifies
# host architecture matches the pin, and builds a project-owned image tag.
# NEVER pushes to any registry — a caller (CI, or a developer) does that
# explicitly after this exits 0. See worker/assets/neko-branding/Dockerfile
# for the EZiL-branding overlay that is layered on top of THIS image's output
# before worker/Dockerfile ever FROMs it.
#
# Usage:
#   docker/neko/build.sh                        # build, tag with the default output tag
#   NEKO_IMAGE_TAG=<ref> docker/neko/build.sh    # tag the output as <ref> instead (e.g. a
#                                                  # pushable ghcr.io/... reference)
#   docker/neko/build.sh --dry-run               # validate pins.env + print the build plan;
#                                                  # touches no docker/git/network command
#   docker/neko/build.sh --help
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINS_FILE="${HERE}/pins.env"

usage() {
  cat <<'EOF'
docker/neko/build.sh — build the pinned Neko + VS Code base image.

  --dry-run   validate docker/neko/pins.env and print the build plan
              (output tag, clone targets, base image, target arch) without
              touching docker, git, or the network. Exits 0 on a valid plan,
              nonzero if a pin is missing/malformed or the host architecture
              does not match.
  --help      show this message and exit 0.

Env overrides:
  NEKO_IMAGE_TAG   final tag the built image is `docker tag`ed as.
                   Default: ezil-neko-vscode:<neko-sha8>-<neko-apps-sha8>
                   Set this to a full ghcr.io/... reference to build straight
                   into a pushable tag instead of retagging afterward.
  NEKO_BUILD_ROOT  scratch dir the pinned repos are cloned into.
                   Default: /tmp/ezil-neko-build
EOF
}

DRY_RUN=0
for arg in "$@"; do
  case "${arg}" in
    --help) usage; exit 0 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "[build] ERROR: unknown argument '${arg}' (see --help)" >&2; exit 1 ;;
  esac
done

if [[ ! -f "${PINS_FILE}" ]]; then
  echo "[build] ERROR: ${PINS_FILE} not found" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "${PINS_FILE}"; set +a

: "${NEKO_REPO:?missing NEKO_REPO in ${PINS_FILE}}"
: "${NEKO_SHA:?missing NEKO_SHA in ${PINS_FILE}}"
: "${NEKO_APPS_REPO:?missing NEKO_APPS_REPO in ${PINS_FILE}}"
: "${NEKO_APPS_SHA:?missing NEKO_APPS_SHA in ${PINS_FILE}}"
: "${NEKO_BASE_IMAGE:?missing NEKO_BASE_IMAGE in ${PINS_FILE}}"
: "${NEKO_TARGET_ARCH:?missing NEKO_TARGET_ARCH in ${PINS_FILE}}"

if [[ ! "${NEKO_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[build] ERROR: NEKO_SHA '${NEKO_SHA}' is not a full 40-hex-char commit SHA" >&2
  exit 1
fi
if [[ ! "${NEKO_APPS_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[build] ERROR: NEKO_APPS_SHA '${NEKO_APPS_SHA}' is not a full 40-hex-char commit SHA" >&2
  exit 1
fi
NEKO_SHA8="${NEKO_SHA:0:8}"
NEKO_APPS_SHA8="${NEKO_APPS_SHA:0:8}"

# Parameterised output tag: the brief this script was ported for asks that
# the output tag be parameterised rather than hardcoded, so CI can build
# straight into a pushable ghcr.io/... reference (see image.yml) instead of
# this script always producing a local-only name.
NEKO_IMAGE_TAG="${NEKO_IMAGE_TAG:-ezil-neko-vscode:${NEKO_SHA8}-${NEKO_APPS_SHA8}}"
NEKO_BUILD_ROOT="${NEKO_BUILD_ROOT:-/tmp/ezil-neko-build}"

echo "[build] plan:"
echo "[build]   neko        ${NEKO_REPO} @ ${NEKO_SHA}"
echo "[build]   neko-apps   ${NEKO_APPS_REPO} @ ${NEKO_APPS_SHA}"
echo "[build]   base image  ${NEKO_BASE_IMAGE}"
echo "[build]   target arch ${NEKO_TARGET_ARCH}"
echo "[build]   output tag  ${NEKO_IMAGE_TAG}"
echo "[build]   build root  ${NEKO_BUILD_ROOT}"

HOST_ARCH="$(uname -m)"
case "${HOST_ARCH}" in
  x86_64) NORM_ARCH="amd64" ;;
  aarch64|arm64) NORM_ARCH="arm64" ;;
  *) NORM_ARCH="${HOST_ARCH}" ;;
esac
if [[ "${NORM_ARCH}" != "${NEKO_TARGET_ARCH}" ]]; then
  echo "[build] ERROR: host architecture '${NORM_ARCH}' does not match NEKO_TARGET_ARCH='${NEKO_TARGET_ARCH}'" >&2
  exit 1
fi
echo "[build] architecture OK: ${NORM_ARCH}"

if [[ ${DRY_RUN} -eq 1 ]]; then
  echo "[build] --dry-run: plan valid, stopping before any clone/docker command"
  exit 0
fi

echo "[build] checking tool availability..."
command -v docker >/dev/null || { echo "[build] ERROR: docker not found" >&2; exit 1; }
command -v git >/dev/null || { echo "[build] ERROR: git not found" >&2; exit 1; }

if ! docker info >/dev/null 2>&1; then
  echo "[build] ERROR: docker daemon not accessible" >&2
  exit 1
fi
echo "[build] docker daemon OK"

mkdir -p "${NEKO_BUILD_ROOT}"

clone_pinned() {
  local repo="$1" sha="$2" dest="$3"
  if [[ -d "${dest}/.git" ]]; then
    echo "[build] ${dest} already cloned, fetching pinned sha..."
    git -C "${dest}" fetch --quiet origin "${sha}" || true
  else
    echo "[build] cloning ${repo} -> ${dest}"
    git clone --quiet "${repo}" "${dest}"
  fi
  git -C "${dest}" checkout --quiet "${sha}"
  local actual
  actual="$(git -C "${dest}" rev-parse HEAD)"
  if [[ "${actual}" != "${sha}" ]]; then
    echo "[build] ERROR: checkout mismatch for ${dest}: expected ${sha}, got ${actual}" >&2
    exit 1
  fi
  echo "[build] pinned ${dest} @ ${actual}"
}

clone_pinned "${NEKO_REPO}" "${NEKO_SHA}" "${NEKO_BUILD_ROOT}/neko"
clone_pinned "${NEKO_APPS_REPO}" "${NEKO_APPS_SHA}" "${NEKO_BUILD_ROOT}/neko-apps"

echo "[build] pulling base image ${NEKO_BASE_IMAGE}..."
docker pull "${NEKO_BASE_IMAGE}"

echo "[build] building image via neko-apps/build (application=vscode)..."
BUILD_LOCAL_REPO="ezil-neko-vscode-build"
BUILD_LOCAL_SUFFIX="${NEKO_SHA8}-${NEKO_APPS_SHA8}"
pushd "${NEKO_BUILD_ROOT}/neko-apps" >/dev/null
YES=1 ./build --application vscode \
  --repository "${BUILD_LOCAL_REPO}" \
  --tag "${BUILD_LOCAL_SUFFIX}" \
  --base_image "${NEKO_BASE_IMAGE}"
popd >/dev/null

BUILT_LOCAL_TAG="${BUILD_LOCAL_REPO}/vscode:${BUILD_LOCAL_SUFFIX}"
echo "[build] retagging ${BUILT_LOCAL_TAG} -> ${NEKO_IMAGE_TAG} (project-owned; never pushed by this script)"
docker tag "${BUILT_LOCAL_TAG}" "${NEKO_IMAGE_TAG}"

echo "[build] done. Image available locally as: ${NEKO_IMAGE_TAG}"
echo "[build] NOTE: this script never pushes to any registry."
docker image inspect "${NEKO_IMAGE_TAG}" --format '[build] id={{.Id}} size={{.Size}} arch={{.Architecture}}'
