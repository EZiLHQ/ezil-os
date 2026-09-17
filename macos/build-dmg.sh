#!/usr/bin/env bash
# Build the Apple Silicon EZiL OS app and drag-to-Applications DMG.
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: macos/build-dmg.sh --version <semver> --runtime <runtime-directory> [options]

Options:
  --runtime <directory> Real ARM64 VM bundle (vmlinuz, initrd.img, rootfs.img, manifest.json)
  --output <directory>  Output directory (default: macos/dist)
  --build <directory>   Working directory (default: macos/build)
  --require-signing     Fail unless Developer ID signing and notarization succeed
  --no-notarize         Do not submit to Apple (internal testing only)

Signing environment:
  APPLE_SIGNING_IDENTITY
  APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
EOF
}

VERSION=""
RUNTIME_DIR=""
OUTPUT_DIR=""
BUILD_DIR=""
REQUIRE_SIGNING=0
NOTARIZE=1

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version) VERSION="${2:-}"; shift 2 ;;
        --runtime) RUNTIME_DIR="${2:-}"; shift 2 ;;
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
if [ -z "$RUNTIME_DIR" ]; then
    echo "build-dmg: --runtime is required; a shell-only DMG is never produced" >&2
    exit 2
fi
if [ "$(uname -s)" != "Darwin" ]; then
    echo "build-dmg: a DMG must be built on macOS" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$(cd "$RUNTIME_DIR" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$SCRIPT_DIR/dist}"
BUILD_DIR="${BUILD_DIR:-$SCRIPT_DIR/build}"
APP_NAME="EZiL OS"
DMG_ROOT="$BUILD_DIR/dmg"
APP="$DMG_ROOT/$APP_NAME.app"
DMG="$OUTPUT_DIR/EZiL-OS-${VERSION}-AppleSilicon.dmg"
PLIST_VERSION="${VERSION%%[-+]*}"
case "$PLIST_VERSION" in
    *.*.*) ;;
    *.*) PLIST_VERSION="${PLIST_VERSION}.0" ;;
    *) PLIST_VERSION="${PLIST_VERSION}.0.0" ;;
esac

for tool in swiftc hdiutil sips iconutil codesign spctl xcrun shasum; do
    command -v "$tool" >/dev/null 2>&1 || { echo "build-dmg: missing $tool" >&2; exit 2; }
done
for file in vmlinuz initrd.img rootfs.img manifest.json; do
    test -f "$RUNTIME_DIR/$file" || { echo "build-dmg: runtime is missing $file" >&2; exit 2; }
done
if [ -f "$RUNTIME_DIR/CI_FIXTURE_DO_NOT_DISTRIBUTE" ] && [ "${EZIL_ALLOW_FIXTURE_RUNTIME:-0}" != "1" ]; then
    echo "build-dmg: refusing to distribute the CI fixture runtime" >&2
    exit 2
fi

case "$BUILD_DIR" in
    "$SCRIPT_DIR"/build|"$SCRIPT_DIR"/build/*|/tmp/*|"${RUNNER_TEMP:-/path-that-cannot-match}"/*) ;;
    *) echo "build-dmg: --build must be under macos/build, /tmp, or RUNNER_TEMP" >&2; exit 2 ;;
esac
mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"
rm -rf "$DMG_ROOT"
rm -f "$DMG"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/runtime/vm" "$DMG_ROOT"
cp "$SCRIPT_DIR/Info.plist" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $PLIST_VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${GITHUB_RUN_NUMBER:-1}" "$APP/Contents/Info.plist"
cp "$RUNTIME_DIR/vmlinuz" "$RUNTIME_DIR/initrd.img" "$RUNTIME_DIR/manifest.json" "$APP/Contents/Resources/runtime/vm/"
# APFS clone-copy keeps the sparse VM disk from consuming another 8 GB while
# hdiutil prepares the image. Fall back for non-APFS build directories.
if ! cp -c "$RUNTIME_DIR/rootfs.img" "$APP/Contents/Resources/runtime/vm/rootfs.img" 2>/dev/null; then
    cp "$RUNTIME_DIR/rootfs.img" "$APP/Contents/Resources/runtime/vm/rootfs.img"
fi
for optional in SHA256SUMS packages.txt Dockerfile ezil-init; do
    [ ! -f "$RUNTIME_DIR/$optional" ] || cp "$RUNTIME_DIR/$optional" "$APP/Contents/Resources/runtime/vm/"
done
cp "$REPO_ROOT/LICENSE" "$REPO_ROOT/NOTICE" "$REPO_ROOT/ATTRIBUTIONS.md" "$APP/Contents/Resources/"

SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
swiftc \
    -parse-as-library \
    -O \
    -target arm64-apple-macos14.0 \
    -sdk "$SDK_PATH" \
    -framework AppKit \
    -framework CryptoKit \
    -framework SwiftUI \
    -framework Virtualization \
    -framework WebKit \
    "$SCRIPT_DIR"/Sources/EZiLOSCore/*.swift \
    "$SCRIPT_DIR/VirtualMachineRuntime.swift" \
    "$SCRIPT_DIR/EZiLOSApp.swift" \
    -o "$APP/Contents/MacOS/$APP_NAME"
file "$APP/Contents/MacOS/$APP_NAME" | grep -q 'arm64'

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
    codesign --force --options runtime --timestamp \
        --entitlements "$SCRIPT_DIR/EZiLOS.entitlements" \
        --sign "$APPLE_SIGNING_IDENTITY" "$APP"
    codesign --verify --deep --strict --verbose=2 "$APP"
    SIGNED=1
elif [ "$REQUIRE_SIGNING" -eq 1 ]; then
    echo "build-dmg: APPLE_SIGNING_IDENTITY is required" >&2
    exit 2
else
    echo "build-dmg: WARNING: producing an ad-hoc-signed internal-test DMG" >&2
    codesign --force --options runtime \
        --entitlements "$SCRIPT_DIR/EZiLOS.entitlements" \
        --sign - "$APP"
    codesign --verify --deep --strict --verbose=2 "$APP"
fi

ln -s /Applications "$DMG_ROOT/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$DMG_ROOT" -ov -format UDZO "$DMG" >/dev/null

if [ "$SIGNED" -eq 1 ]; then
    codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"
fi
if [ "$NOTARIZE" -eq 1 ] && [ "$SIGNED" -eq 1 ]; then
    for key in APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
        [ -n "$(printenv "$key" 2>/dev/null || true)" ] || { echo "build-dmg: $key is required" >&2; exit 2; }
    done
    xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
elif [ "$REQUIRE_SIGNING" -eq 1 ]; then
    echo "build-dmg: a release build must be notarized" >&2
    exit 2
fi

hdiutil verify "$DMG" >/dev/null
echo "build-dmg: created $DMG"
