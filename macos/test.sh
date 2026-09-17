#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT INT TERM

for script in \
    "$SCRIPT_DIR/build-dmg.sh" \
    "$SCRIPT_DIR/runtime/build-runtime.sh" \
    "$SCRIPT_DIR/runtime/make-fixture.sh" \
    "$SCRIPT_DIR/runtime/ezil-init"; do
    bash -n "$script"
done

fixture="$TEMP_ROOT/runtime-fixture"
"$SCRIPT_DIR/runtime/make-fixture.sh" "$fixture"
for file in vmlinuz initrd.img rootfs.img manifest.json CI_FIXTURE_DO_NOT_DISTRIBUTE; do
    test -f "$fixture/$file" || { echo "macos test: fixture missing $file" >&2; exit 1; }
done

# The default package path must reject a fixture, and the opt-in is limited to
# the compile/package smoke job. This prevents a tiny non-bootable DMG from
# being uploaded by the internal or release workflows.
grep -q 'CI_FIXTURE_DO_NOT_DISTRIBUTE' "$SCRIPT_DIR/build-dmg.sh"
grep -q 'EZIL_ALLOW_FIXTURE_RUNTIME' "$SCRIPT_DIR/build-dmg.sh"

grep -q 'arm64-apple-macos14.0' "$SCRIPT_DIR/build-dmg.sh"
grep -q 'Virtualization' "$SCRIPT_DIR/build-dmg.sh"
grep -q 'com.apple.security.virtualization' "$SCRIPT_DIR/EZiLOS.entitlements"
grep -q 'Continue as Guest' "$SCRIPT_DIR/EZiLOSApp.swift"
grep -q 'WKWebsiteDataStore(forIdentifier:' "$SCRIPT_DIR/EZiLOSApp.swift"
grep -q 'VZNATNetworkDeviceAttachment' "$SCRIPT_DIR/VirtualMachineRuntime.swift"
grep -q 'VZSingleDirectoryShare' "$SCRIPT_DIR/VirtualMachineRuntime.swift"
grep -q 'EZIL_READY' "$SCRIPT_DIR/runtime/ezil-init"
grep -q -- '--auth password' "$SCRIPT_DIR/runtime/ezil-init"
grep -q -- '--uid 10001' "$SCRIPT_DIR/runtime/Dockerfile"
grep -q 'initramfs-tools' "$SCRIPT_DIR/runtime/Dockerfile"
grep -q 'resize2fs /dev/vda' "$SCRIPT_DIR/runtime/ezil-init"
grep -q -- 'setpriv --reuid=10001 --regid=10001' "$SCRIPT_DIR/runtime/ezil-init"
if grep -q -- '--auth none' "$SCRIPT_DIR/runtime/ezil-init"; then
    echo "macos test: code-server must not expose an unauthenticated endpoint" >&2
    exit 1
fi

if grep -En 'ghcr\.io|Docker Desktop|EZIL_LOCAL_WORKSPACE|/home/neko|com\.microsoft\.VSCode' \
    "$SCRIPT_DIR/EZiLOSApp.swift" "$SCRIPT_DIR/VirtualMachineRuntime.swift"; then
    echo "macos test: native local app still references the legacy Docker launcher" >&2
    exit 1
fi

if [ "$(uname -s)" = "Darwin" ]; then
    (cd "$SCRIPT_DIR" && swift test --parallel)
    SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
    swiftc \
        -parse-as-library \
        -typecheck \
        -target arm64-apple-macos14.0 \
        -sdk "$SDK_PATH" \
        -framework AppKit \
        -framework CryptoKit \
        -framework SwiftUI \
        -framework Virtualization \
        -framework WebKit \
        "$SCRIPT_DIR"/Sources/EZiLOSCore/*.swift \
        "$SCRIPT_DIR/VirtualMachineRuntime.swift" \
        "$SCRIPT_DIR/EZiLOSApp.swift"
fi

grep -q 'macos/runtime/build-runtime.sh' "$REPO_ROOT/.github/workflows/macos-internal.yml"
grep -q 'self-hosted' "$REPO_ROOT/.github/workflows/macos-e2e.yml"
grep -q -- '--runtime' "$REPO_ROOT/.github/workflows/release.yml"

echo "macOS local-first contract tests passed"
