#!/usr/bin/env bash
# Build the EZiL Chat VSIX the desktop image bakes in as a built-in extension.
#
# The extension's source lives in `extensions/ezil-chat/` — OUTSIDE the
# `worker/` Docker build context (`.github/workflows/image.yml` builds with
# `context: worker`), so the Dockerfile cannot compile it. Same shape as
# `worker/bootstrap/build-bootstrap.sh`: build here, commit the artifact
# (`dist/ezil-chat-<version>.vsix`, ~50 KB), and let the Dockerfile simply COPY
# it. The Dockerfile unpacks it into code-server's system extensions directory
# (`/usr/lib/code-server/lib/vscode/extensions/ezil-chat`), which is what makes
# it a built-in the user cannot uninstall and that no `.ezil/extensions.txt`
# restore can lose.
#
# Run from anywhere; paths are resolved relative to this script. Needs `bun`.
#
# Modes:
#   (no args)   Build extensions/ezil-chat and write dist/ezil-chat-<version>.vsix.
#   --check     Drift-guard: rebuild into a temp dir and fail (exit 1) if the
#               committed VSIX's CONTENTS differ from source. Compares the
#               unpacked files, not the zip bytes — zip entries carry
#               timestamps. Does NOT modify the committed artifact.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$(cd "$here/../../extensions/ezil-chat" && pwd)"
version="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$src/package.json" | head -1)"
[[ -n "$version" ]] || { echo "[build-vsix] FAIL: no version in $src/package.json" >&2; exit 1; }
out="$here/dist/ezil-chat-${version}.vsix"

mode="${1:-build}"

build_vsix() {
  # `package:vsix` runs typecheck-free `bun run build` (dist/extension.js,
  # dist/webview.js, dist/webview.css) then vsce with --no-dependencies, and
  # writes ezil-chat-<version>.vsix next to package.json.
  (cd "$src" && bun install --frozen-lockfile >/dev/null && bun run package:vsix >/dev/null)
  echo "$src/ezil-chat-${version}.vsix"
}

if [[ "$mode" == "--check" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "[build-vsix] drift-check: rebuilding $src -> (temp)"
  built="$(build_vsix)"
  if [[ ! -f "$out" ]]; then
    echo "[build-vsix] FAIL: committed VSIX missing at $out" >&2
    exit 1
  fi
  mkdir -p "$tmp/committed" "$tmp/fresh"
  unzip -q "$out" -d "$tmp/committed"
  unzip -q "$built" -d "$tmp/fresh"
  if diff -r "$tmp/committed" "$tmp/fresh" >/dev/null; then
    echo "[build-vsix] OK: committed VSIX matches source"
    exit 0
  fi
  echo "[build-vsix] FAIL: committed VSIX is stale — run worker/ezil-chat/build-vsix.sh and commit dist/ezil-chat-${version}.vsix" >&2
  diff -r "$tmp/committed" "$tmp/fresh" | head -20 >&2 || true
  exit 1
fi

mkdir -p "$here/dist"
echo "[build-vsix] packaging $src -> $out"
built="$(build_vsix)"
cp -f "$built" "$out"
echo "[build-vsix] done ($(wc -c <"$out") bytes)"
