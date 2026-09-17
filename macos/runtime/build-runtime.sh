#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${1:-}"
CODE_SERVER_VERSION="${CODE_SERVER_VERSION:-4.104.2}"
CODE_SERVER_SHA256="${CODE_SERVER_SHA256:-618cb27960e5500a21cc1cd7c9d7b396222c6fe5242e01340312da18cea9945c}"

if [ -z "$OUTPUT_DIR" ]; then
    echo "Usage: $0 <empty-output-directory>" >&2
    exit 2
fi
if [ "$(uname -m)" != "aarch64" ] && [ "$(uname -m)" != "arm64" ]; then
    echo "build-runtime: run on a native ARM64 Linux builder" >&2
    exit 2
fi
if [ -e "$OUTPUT_DIR" ] && [ -n "$(ls -A "$OUTPUT_DIR" 2>/dev/null)" ]; then
    echo "build-runtime: output directory must be empty" >&2
    exit 2
fi
for tool in docker mkfs.ext4 sha256sum tar; do
    command -v "$tool" >/dev/null || { echo "build-runtime: missing $tool" >&2; exit 2; }
done

mkdir -p "$OUTPUT_DIR"
WORK_DIR="$(mktemp -d)"
IMAGE="ezil-os-vm-runtime:${GITHUB_SHA:-local}"
CONTAINER=""
cleanup() {
    if [ -n "$CONTAINER" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

docker build \
    --platform linux/arm64 \
    --build-arg "CODE_SERVER_VERSION=$CODE_SERVER_VERSION" \
    --build-arg "CODE_SERVER_SHA256=$CODE_SERVER_SHA256" \
    --tag "$IMAGE" \
    "$SCRIPT_DIR"
CONTAINER="$(docker create --platform linux/arm64 "$IMAGE")"
docker export "$CONTAINER" --output "$WORK_DIR/rootfs.tar"
mkdir -p "$WORK_DIR/rootfs"
tar -xpf "$WORK_DIR/rootfs.tar" -C "$WORK_DIR/rootfs"

kernel="$(find -L "$WORK_DIR/rootfs/boot" -maxdepth 1 -type f -name 'vmlinuz-*' | sort | tail -1)"
initrd="$(find -L "$WORK_DIR/rootfs/boot" -maxdepth 1 -type f -name 'initrd.img-*' | sort | tail -1)"
test -n "$kernel" && test -n "$initrd"
cp "$kernel" "$OUTPUT_DIR/vmlinuz"
cp "$initrd" "$OUTPUT_DIR/initrd.img"

# A sparse writable disk gives package managers room without making the DMG
# carry zero-filled gigabytes. hdiutil compresses the unused ext4 blocks.
truncate -s 2G "$OUTPUT_DIR/rootfs.img"
mkfs.ext4 -q -F -m 0 -L ezil-root -d "$WORK_DIR/rootfs" "$OUTPUT_DIR/rootfs.img"

docker run --rm --platform linux/arm64 "$IMAGE" \
    dpkg-query -W -f='${Package}\t${Version}\n' > "$OUTPUT_DIR/packages.txt"
cp "$SCRIPT_DIR/Dockerfile" "$SCRIPT_DIR/ezil-init" "$OUTPUT_DIR/"

kernel_sha="$(sha256sum "$OUTPUT_DIR/vmlinuz" | cut -d' ' -f1)"
initrd_sha="$(sha256sum "$OUTPUT_DIR/initrd.img" | cut -d' ' -f1)"
disk_sha="$(sha256sum "$OUTPUT_DIR/rootfs.img" | cut -d' ' -f1)"
cat > "$OUTPUT_DIR/manifest.json" <<EOF
{
  "formatVersion": 1,
  "architecture": "arm64",
  "minimumMacOS": "14.0",
  "kernelSHA256": "$kernel_sha",
  "initrdSHA256": "$initrd_sha",
  "diskSHA256": "$disk_sha",
  "codeServerVersion": "$CODE_SERVER_VERSION"
}
EOF
(cd "$OUTPUT_DIR" && sha256sum Dockerfile ezil-init initrd.img manifest.json packages.txt rootfs.img vmlinuz) \
    > "$OUTPUT_DIR/SHA256SUMS"
echo "build-runtime: created ARM64 runtime in $OUTPUT_DIR"
