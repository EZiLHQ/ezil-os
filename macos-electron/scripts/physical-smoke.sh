#!/bin/bash
set -euo pipefail
# The calling workflow has already authenticated the originating build run.
# This script installs the exact verified DMG bytes. It never builds source.
artifact_dir="${1:?artifact directory required}"
evidence_dir="${2:?evidence directory required}"
test "$(uname -m)" = arm64
test "$(uname -s)" = Darwin
test "$(stat -f %Su /dev/console)" = "$(id -un)"
test "$(id -u)" != 0
mkdir -p "$evidence_dir"
artifact_dir="$(cd "$artifact_dir" && pwd -P)"
evidence_dir="$(cd "$evidence_dir" && pwd -P)"
shopt -s nullglob
dmgs=("$artifact_dir"/*.dmg)
test "${#dmgs[@]}" = 1
dmg="${dmgs[0]}"
test -f "$dmg.sha256"
expected="$(awk '{print $1}' "$dmg.sha256")"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]]
actual="$(shasum -a 256 "$dmg" | awk '{print $1}')"
test "$expected" = "$actual"
printf '%s\n' "$actual" > "$evidence_dir/ARTIFACT-SHA256"
cp "$dmg.sha256" "$evidence_dir/"
sw_vers > "$evidence_dir/macos.txt"
uname -a > "$evidence_dir/architecture.txt"
xcodebuild -version > "$evidence_dir/xcode.txt"
scratch="$(mktemp -d)"
scratch="$(cd "$scratch" && pwd -P)"
mountpoint="$scratch/image"
mkdir "$mountpoint"
cleanup() {
  hdiutil detach "$mountpoint" -quiet || true
  if [ -d "$scratch/data/evidence" ]; then ditto "$scratch/data/evidence" "$evidence_dir/gui"; fi
  # Keep app/data on failures for local inspection; no wildcard cleanup of user data.
}
trap cleanup EXIT
hdiutil verify "$dmg"
hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$mountpoint" -quiet
test -d "$mountpoint/EZiL OS.app"
ditto "$mountpoint/EZiL OS.app" "$scratch/EZiL OS.app"
codesign --verify --deep --strict "$scratch/EZiL OS.app"
codesign -dv --verbose=4 "$scratch/EZiL OS.app" 2> "$evidence_dir/codesign.txt"
cp "$scratch/EZiL OS.app/Contents/Resources/INVENTORY.json" "$evidence_dir/INVENTORY.json"
# No Gatekeeper bypass or quarantine removal. This is an internal ad-hoc test,
# not evidence of public Developer ID/notarization/Gatekeeper acceptance.
EZIL_NATIVE_APP_DATA="$scratch/data" EZIL_ARTIFACT_SHA256="$actual" \
  "$scratch/EZiL OS.app/Contents/MacOS/Electron" --native-smoke \
  > "$evidence_dir/gui-stdout.log" 2> "$evidence_dir/gui-stderr.log"
test -f "$scratch/data/evidence/result.json"
/usr/bin/plutil -extract success raw -o - "$scratch/data/evidence/result.json" | /usr/bin/grep -qx true
