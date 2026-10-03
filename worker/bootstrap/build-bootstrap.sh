#!/usr/bin/env bash
# Wave 4B2A — build the in-container workspace bootstrap bundle.
#
# Bundles the TypeScript readiness entry and its local checkpoint validator
# into a single self-contained ESM module the sandbox image runs with
# `bun`. Deterministic + committed: the produced `dist/workspace-bootstrap.mjs`
# is checked in so the image build (which has no repo-wide toolchain) can simply
# COPY it in.
#
# Run from anywhere; paths are resolved relative to this script.
#
# Modes:
#   (no args)   Build and write dist/workspace-bootstrap.mjs.
#   --check     CI drift-guard: rebuild into a temp file and fail (exit 1) if the
#               committed dist/workspace-bootstrap.mjs differs from source. Does
#               NOT modify the committed artifact.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
entry="$here/workspace-bootstrap-entry.ts"
out="$here/dist/workspace-bootstrap.mjs"

# Bun emits source comments relative to cwd; pin it for reproducible output.
cd "$here"

mode="${1:-build}"
if [[ "$mode" != "build" && "$mode" != "--check" ]] || [[ $# -gt 1 ]]; then
  echo "usage: build-bootstrap.sh [--check]" >&2
  exit 2
fi

if [[ "$mode" == "--check" ]]; then
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  echo "[build-bootstrap] drift-check: rebuilding $entry -> (temp)"
  bun build "$entry" \
    --target=bun \
    --format=esm \
    --outfile "$tmp"
  if [[ ! -f "$out" ]]; then
    echo "[build-bootstrap] FAIL: committed bundle missing at $out" >&2
    exit 1
  fi
  if diff -q "$out" "$tmp" >/dev/null; then
    echo "[build-bootstrap] OK: committed bundle matches source"
    exit 0
  fi
  echo "[build-bootstrap] FAIL: committed bundle is stale — run bootstrap/build-bootstrap.sh and commit dist/workspace-bootstrap.mjs" >&2
  exit 1
fi

mkdir -p "$here/dist"

echo "[build-bootstrap] bundling $entry -> $out"
bun build "$entry" \
  --target=bun \
  --format=esm \
  --outfile "$out"

echo "[build-bootstrap] done ($(wc -c <"$out") bytes)"
