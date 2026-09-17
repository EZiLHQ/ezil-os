#!/usr/bin/env bash
#
# Build the native EZiL OS macOS wrapper and a drag-to-Applications DMG.
# Run this on macOS. A local build may be unsigned; CI passes
# --require-signing so a distributable release can never silently degrade to
# an unsigned, Gatekeeper-blocked artifact.
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: macos/build-dmg.sh --version <semver> [options]

Options:
  --output <directory>  Output directory (default: macos/dist)
  --build <directory>   Working directory (default: macos/build)
  --require-signing     Fail unless signing and notarization credentials exist
  --no-notarize         Sign, but do not submit to Apple (local diagnostics only)

Signing environment:
  APPLE_SIGNING_IDENTITY
  APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
EOF
}

VERSION=""
OUTPUT_DIR=""
BUILD_DIR=""
REQUIRE_SIGNING=0
NOTARIZE=1

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version) VERSION="${2:-}"; shift 2 ;;
        --output) OUTPUT_DIR="${2:-}"; shift 2 ;;
        --build) BUILD_DIR="${2:-}"; shift 2 ;;
        --require-signing) REQUIRE_SIGNING=1; shift ;;
        --no-notarize) NOTARIZE=0; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "build-dmg: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
    esac
done

if ! [[ "$VERSION" =~ ^[0-9]+(\.[0-9]+){0,2}(-[A-Za-z0-9.]+)?(\+[A-Za-z0-9.]+)?$ ]]; then
    echo "build-dmg: --version must be a release version such as 0.2.0 or 0.2.0-rc.1" >&2
    exit 2
fi
if [ "$(uname -s)" != "Darwin" ]; then
    echo "build-dmg: a DMG must be built on macOS (this host is $(uname -s))" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$SCRIPT_DIR/dist}"
BUILD_DIR="${BUILD_DIR:-$SCRIPT_DIR/build}"
APP_NAME="EZiL OS"
APP="$BUILD_DIR/$APP_NAME.app"
DMG_ROOT="$BUILD_DIR/dmg"
DMG="$OUTPUT_DIR/EZiL-OS-${VERSION}-macOS.dmg"
PLIST_VERSION="${VERSION%%[-+]*}"
case "$PLIST_VERSION" in
    *.*.*) ;;
    *.*) PLIST_VERSION="${PLIST_VERSION}.0" ;;
    *) PLIST_VERSION="${PLIST_VERSION}.0.0" ;;
esac

for tool in swiftc hdiutil sips iconutil codesign lipo spctl xcrun; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "build-dmg: required macOS tool is missing: $tool" >&2
        exit 2
    fi
done

# The two paths are fixed beneath macos/. Resolve them before deleting and
# refuse anything else, so an environment typo cannot turn cleanup into a
# broad recursive removal.
case "$BUILD_DIR" in
    "$SCRIPT_DIR"/build|"$SCRIPT_DIR"/build/*) ;;
    /tmp/*|"${RUNNER_TEMP:-/path-that-cannot-match}"/*) ;;
    *) echo "build-dmg: --build must be under macos/build, /tmp, or RUNNER_TEMP" >&2; exit 2 ;;
esac
mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"
rm -rf "$APP" "$DMG_ROOT"
rm -f "$DMG"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/runtime" "$DMG_ROOT"
cp "$SCRIPT_DIR/Info.plist" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $PLIST_VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${GITHUB_RUN_NUMBER:-1}" "$APP/Contents/Info.plist"

"$REPO_ROOT/deploy/stage-local-runtime.sh" "$APP/Contents/Resources/runtime"

SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
for arch in arm64 x86_64; do
    swiftc \
        -parse-as-library \
        -O \
        -target "${arch}-apple-macos13.0" \
        -sdk "$SDK_PATH" \
        -framework AppKit \
        -framework SwiftUI \
        -framework WebKit \
        "$SCRIPT_DIR/EZiLOSApp.swift" \
        -o "$BUILD_DIR/EZiL-OS-$arch"
done
lipo -create \
    "$BUILD_DIR/EZiL-OS-arm64" \
    "$BUILD_DIR/EZiL-OS-x86_64" \
    -output "$APP/Contents/MacOS/$APP_NAME"
lipo -info "$APP/Contents/MacOS/$APP_NAME"

# Build an ICNS from the checked-in favicon. The source includes a 256px PNG
# frame; sips scales it for the larger Retina slots without adding another
# hand-maintained copy of the brand asset.
ICONSET="$BUILD_DIR/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
sips -s format png "$REPO_ROOT/app/src/app/favicon.ico" --out "$BUILD_DIR/icon-source.png" >/dev/null
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
    size="${spec%% *}"
    name="${spec#* }"
    sips -z "$size" "$size" "$BUILD_DIR/icon-source.png" --out "$ICONSET/$name.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

SIGNED=0
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
    codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$APP"
    codesign --verify --deep --strict --verbose=2 "$APP"
    SIGNED=1
elif [ "$REQUIRE_SIGNING" -eq 1 ]; then
    echo "build-dmg: APPLE_SIGNING_IDENTITY is required for a distributable DMG" >&2
    exit 2
else
    echo "build-dmg: WARNING: producing an unsigned local-test DMG" >&2
    codesign --force --sign - "$APP"
fi

cp -R "$APP" "$DMG_ROOT/"
ln -s /Applications "$DMG_ROOT/Applications"
hdiutil create \
    -volname "$APP_NAME" \
    -srcfolder "$DMG_ROOT" \
    -ov \
    -format UDZO \
    "$DMG" >/dev/null

if [ "$SIGNED" -eq 1 ]; then
    codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"
fi

if [ "$NOTARIZE" -eq 1 ] && [ "$SIGNED" -eq 1 ]; then
    if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
        echo "build-dmg: APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID are required for notarization" >&2
        exit 2
    fi
    xcrun notarytool submit "$DMG" \
        --apple-id "$APPLE_ID" \
        --password "$APPLE_PASSWORD" \
        --team-id "$APPLE_TEAM_ID" \
        --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
elif [ "$REQUIRE_SIGNING" -eq 1 ]; then
    echo "build-dmg: a release build must be notarized" >&2
    exit 2
fi

hdiutil verify "$DMG" >/dev/null
echo "build-dmg: created $DMG"
