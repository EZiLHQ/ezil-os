#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

bash -n "$REPO_ROOT/deploy/stage-local-runtime.sh"
bash -n "$SCRIPT_DIR/build-dmg.sh"

RUNTIME="$TMP_ROOT/runtime"
"$REPO_ROOT/deploy/stage-local-runtime.sh" "$RUNTIME"
if "$REPO_ROOT/deploy/stage-local-runtime.sh" "$RUNTIME" >/dev/null 2>&1; then
    echo "runtime staging accepted a non-empty destination" >&2
    exit 1
fi

for path in \
    local/src/server/main.ts \
    local/package.json \
    local/bun.lock \
    worker/src/desktop-mode.ts \
    worker/src/screen-modes.ts \
    app/public/os/bundle.min.js \
    app/public/os/bundle.min.css \
    app/public/os/icons.js \
    deploy/images.env \
    deploy/launcher/ezil-os.sh \
    LICENSE NOTICE ATTRIBUTIONS.md; do
    test -f "$RUNTIME/$path" || { echo "missing staged runtime file: $path" >&2; exit 1; }
done

if find "$RUNTIME" -name '*.test.ts' -print -quit | grep -q .; then
    echo "staged runtime contains test sources" >&2
    exit 1
fi

# Resolve every runtime import from the exact staged tree the app bundles.
bun build --target=bun "$RUNTIME/local/src/server/main.ts" --outfile "$TMP_ROOT/local-host.mjs" >/dev/null

# The wrapper must keep the desktop private to this Mac and must use the
# existing launcher rather than grow a second Docker implementation.
grep -Eq 'http://127\.0\.0\.1:7080/os' "$SCRIPT_DIR/EZiLOSApp.swift"
grep -Eq 'deploy/launcher/ezil-os\.sh' "$SCRIPT_DIR/EZiLOSApp.swift"
grep -Eq 'EZIL_LOCAL_WORKSPACE' "$SCRIPT_DIR/EZiLOSApp.swift"
grep -Eq '/home/neko/project' "$SCRIPT_DIR/EZiLOSApp.swift"
grep -Eq 'com\.microsoft\.VSCode' "$SCRIPT_DIR/EZiLOSApp.swift"
grep -Eq 'Everything runs on this Mac' "$SCRIPT_DIR/EZiLOSApp.swift"
if grep -Eq '0\.0\.0\.0|--publish' "$SCRIPT_DIR/EZiLOSApp.swift"; then
    echo "macOS wrapper must not implement or widen Docker networking" >&2
    exit 1
fi
grep -Eq -- '--require-signing' "$REPO_ROOT/.github/workflows/release.yml"
grep -Eq 'Wait for the signed macOS installer' "$REPO_ROOT/.github/workflows/deploy.yml"
grep -Eq 'Upload internal-test DMG' "$REPO_ROOT/.github/workflows/ci.yml"

echo "macos wrapper tests passed"
