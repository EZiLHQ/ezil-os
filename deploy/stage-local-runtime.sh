#!/usr/bin/env bash
#
# Stage the complete EZiL OS local runtime into an empty directory.
#
# Both the release tarball and the native macOS wrapper call this script. That
# keeps one authoritative file list: the .dmg cannot accidentally ship a
# different local host, desktop shell, image pin, or launcher from the tarball.
set -euo pipefail

usage() {
    echo "Usage: $0 <empty-destination-directory>" >&2
}

if [ "$#" -ne 1 ]; then
    usage
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$1"

if [ -e "$DEST" ] && [ ! -d "$DEST" ]; then
    echo "stage-local-runtime: destination exists and is not a directory: $DEST" >&2
    exit 2
fi
mkdir -p "$DEST"

# Refuse a non-empty target. Staging over an old runtime could leave a removed
# source file behind and silently ship code that no longer exists in the tag.
if [ -n "$(ls -A "$DEST")" ]; then
    echo "stage-local-runtime: destination must be empty: $DEST" >&2
    exit 2
fi

mkdir -p "$DEST/local"
cp -R "$REPO_ROOT/local/src" "$DEST/local/src"
# Tests are not runtime inputs. Some colocated tests import repository-only
# files that are intentionally absent from a release, so do not ship them as
# misleading, unresolvable source.
find "$DEST/local/src" -name '*.test.ts' -delete
cp "$REPO_ROOT/local/package.json" "$REPO_ROOT/local/bun.lock" "$DEST/local/"

# These are real value imports made by local/src; they are not type-only.
mkdir -p "$DEST/worker/src"
cp "$REPO_ROOT/worker/src/desktop-mode.ts" "$REPO_ROOT/worker/src/screen-modes.ts" "$DEST/worker/src/"

mkdir -p "$DEST/app/public/os"
cp \
    "$REPO_ROOT/app/public/os/bundle.min.js" \
    "$REPO_ROOT/app/public/os/bundle.min.css" \
    "$REPO_ROOT/app/public/os/icons.js" \
    "$DEST/app/public/os/"

mkdir -p "$DEST/deploy/launcher"
cp "$REPO_ROOT/deploy/images.env" "$DEST/deploy/"
cp \
    "$REPO_ROOT/deploy/launcher/ezil-os.sh" \
    "$REPO_ROOT/deploy/launcher/ezil-os.ps1" \
    "$REPO_ROOT/deploy/launcher/README.md" \
    "$DEST/deploy/launcher/"
chmod 755 "$DEST/deploy/launcher/ezil-os.sh"

cp "$REPO_ROOT/LICENSE" "$REPO_ROOT/NOTICE" "$REPO_ROOT/ATTRIBUTIONS.md" "$DEST/"

echo "stage-local-runtime: staged $DEST"
