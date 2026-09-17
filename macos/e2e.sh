#!/usr/bin/env bash
set -euo pipefail

# Legacy migration/VM maintenance only. Active native packaging lives in macos-electron.
if [ "${EZIL_LEGACY_VM_MAINTENANCE:-0}" != 1 ]; then
    echo "Legacy VM tooling is inactive. See docs/NATIVE-MAC.md for the Electron host." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="${1:-}"
if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
    echo "e2e: requires a physical Apple Silicon Mac" >&2
    exit 2
fi
if [ -z "$RUNTIME_DIR" ]; then
    echo "Usage: $0 <runtime-directory>" >&2
    exit 2
fi

WORK_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$WORK_ROOT"; }
trap cleanup EXIT INT TERM

SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
swiftc \
    -O \
    -target arm64-apple-macos14.0 \
    -sdk "$SDK_PATH" \
    -framework Virtualization \
    "$SCRIPT_DIR/e2e/VMRuntimeSmoke.swift" \
    -o "$WORK_ROOT/vm-runtime-smoke"
"$WORK_ROOT/vm-runtime-smoke" "$RUNTIME_DIR" "$WORK_ROOT/session"

# Cleanup is a tested behavior, not only a trap declaration.
cleanup
if [ -e "$WORK_ROOT" ]; then
    echo "e2e: temporary VM data survived cleanup" >&2
    exit 1
fi
trap - EXIT INT TERM
echo "physical Mac end-to-end test passed"
