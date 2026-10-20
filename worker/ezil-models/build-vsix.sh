#!/usr/bin/env bash
# Build the built-in EZiL language-model provider without registry access.
# The extension has no runtime dependencies: Bun bundles TypeScript, and the
# standard-library packager writes a deterministic VSIX from an explicit file list.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$(cd "$here/../../extensions/ezil-models" && pwd)"
mode="${1:-build}"
[[ "$mode" == build || "$mode" == --check ]] || { echo 'Usage: build-vsix.sh [--check]' >&2; exit 2; }
# Bundle bytes depend on the Bun version, so build and check with CI's pinned Bun
# (.github/workflows/ci.yml, ezil-models job).
BUN_PINNED=1.3.14
[[ "$(bun --version)" == "$BUN_PINNED" ]] || { echo "[build-vsix] FAIL: needs bun $BUN_PINNED (found $(bun --version)); the VSIX bytes depend on it" >&2; exit 2; }
version="$(bun -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$src/package.json")"
out="$here/dist/ezil-models-${version}.vsix"
tmp="$(mktemp -d "$here/.build-XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
bun build "$src/src/extension.ts" --target=node --format=cjs --external=vscode --outfile="$tmp/extension.js"
python3 "$here/package-vsix.py" "$src" "$tmp/extension.js" "$tmp/extension.vsix"
if [[ "$mode" == --check ]]; then
  if [[ -f "$out" ]] && cmp -s "$out" "$tmp/extension.vsix"; then
    echo '[build-vsix] OK: committed VSIX matches source'
  else
    echo '[build-vsix] FAIL: VSIX is missing or stale; run worker/ezil-models/build-vsix.sh' >&2
    exit 1
  fi
else
  mkdir -p "$here/dist"
  cp "$tmp/extension.vsix" "$out"
  echo "[build-vsix] wrote $out ($(wc -c <"$out") bytes)"
fi
