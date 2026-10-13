#!/usr/bin/env bash
# Warm the npm cache that the persistence suite's real Next.js case installs from offline
# (worker/src/workspace-checkpoint.container.test.ts, EZIL_NEXT_NPM_CACHE).
#
# It runs in jobs that may already hold registry credentials: image.yml logs in to GHCR with
# packages: write before test-desktop.sh runs. So no third-party code may run here:
#   - the tree is the reviewed lockfile beside this script (next-warm/): every entry pinned
#     with an integrity hash, none with an install script; npm ci refuses anything else;
#   - --ignore-scripts: no package lifecycle script runs;
#   - a scrubbed environment: nothing inherited (no tokens), an empty HOME and DOCKER_CONFIG,
#     no user or global npmrc.
set -euo pipefail
cache="${1:?usage: warm-next-cache.sh <cache-dir>}"
mkdir -p "$cache"
cache="$(cd "$cache" && pwd)"
src="$(cd "$(dirname "${BASH_SOURCE[0]}")/next-warm" && pwd)"
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/ezil-next-warm.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/home" "$work/docker" "$work/project"
# Two distinct empty npmrc files: npm refuses one path as both user and global config.
: > "$work/user.npmrc"
: > "$work/global.npmrc"
cp "$src/package.json" "$src/package-lock.json" "$work/project/"
(
  cd "$work/project"
  env -i PATH="$PATH" HOME="$work/home" DOCKER_CONFIG="$work/docker" \
    npm_config_userconfig="$work/user.npmrc" npm_config_globalconfig="$work/global.npmrc" \
    npm ci --ignore-scripts --no-audit --no-fund --cache "$cache"
)
