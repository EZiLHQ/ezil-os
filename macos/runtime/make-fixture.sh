#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR="${1:-}"
if [ -z "$OUTPUT_DIR" ]; then
    echo "Usage: $0 <empty-output-directory>" >&2
    exit 2
fi
mkdir -p "$OUTPUT_DIR"
if [ -n "$(ls -A "$OUTPUT_DIR")" ]; then
    echo "make-fixture: output directory must be empty" >&2
    exit 2
fi
printf 'NOT-BOOTABLE-CI-FIXTURE\n' > "$OUTPUT_DIR/vmlinuz"
printf 'NOT-BOOTABLE-CI-FIXTURE\n' > "$OUTPUT_DIR/initrd.img"
printf 'NOT-BOOTABLE-CI-FIXTURE\n' > "$OUTPUT_DIR/rootfs.img"
kernel_sha="$(shasum -a 256 "$OUTPUT_DIR/vmlinuz" | cut -d' ' -f1)"
initrd_sha="$(shasum -a 256 "$OUTPUT_DIR/initrd.img" | cut -d' ' -f1)"
disk_sha="$(shasum -a 256 "$OUTPUT_DIR/rootfs.img" | cut -d' ' -f1)"
cat > "$OUTPUT_DIR/manifest.json" <<EOF
{
  "formatVersion": 1,
  "architecture": "arm64",
  "minimumMacOS": "14.0",
  "kernelSHA256": "$kernel_sha",
  "initrdSHA256": "$initrd_sha",
  "diskSHA256": "$disk_sha",
  "codeServerVersion": "fixture-only"
}
EOF
touch "$OUTPUT_DIR/CI_FIXTURE_DO_NOT_DISTRIBUTE"
