#!/usr/bin/env bash
# §3a.1 / §3a.7: host operations on a HOSTILE volume never touch a host file, and a
# device node the guest made in the upper is unusable through the merged overlay.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"
W="$T/hostile"; rm -rf "$W"; mkdir -p "$W"
HOST="$W/host-side"
truncate -s 1M "$W/dev.img"; DEVL="$(losetup --find --show "$W/dev.img")"
MAJ=$((16#$(stat -c '%t' "$DEVL"))); MIN=$((16#$(stat -c '%T' "$DEVL")))
trap 'mountpoint -q "$W/merged" && umount "$W/merged"; losetup -d "$DEVL" 2>/dev/null; rm -rf "$W"' EXIT
reset_host() {
    rm -rf "$HOST"; mkdir -p "$HOST"/{etc,dpkg,bin,chrome,rootdir/keep}
    for f in etc/passwd dpkg/status bin/start-neko.sh chrome/SingletonLock rootdir/keep/file; do echo "CANARY $f" > "$HOST/$f"; done
    dd if=/dev/zero of="$DEVL" bs=1M count=1 status=none; printf 'DEVICE-CANARY\n' | dd of="$DEVL" conv=notrunc status=none; sync
    ( cd "$HOST" && find . -type f -print0 | sort -z | xargs -0 sha256sum; head -c 1048576 "$DEVL" | sha256sum ) > "$W/sums"
}
intact() { ( cd "$HOST" && find . -type f -print0 | sort -z | xargs -0 sha256sum; sync; head -c 1048576 "$DEVL" | sha256sum ) | diff -q "$W/sums" - >/dev/null; }
for v in old new; do mkdir -p "$W/$v/var/lib/dpkg/info" "$W/$v/usr/local/bin"; done
printf 'Package: base\nStatus: install ok installed\nArchitecture: all\nVersion: 1\n' > "$W/old/var/lib/dpkg/status"
printf 'Package: base\nStatus: install ok installed\nArchitecture: all\nVersion: 2\n' > "$W/new/var/lib/dpkg/status"
printf '/.\n/usr/local/bin/start-neko.sh\n' > "$W/new/var/lib/dpkg/info/base.list"; echo v2 > "$W/new/usr/local/bin/start-neko.sh"
rb() { PYTHONPATH="$HA/lib" python3 -m ezil_host.rebase "$W/upper" "$W/old" "$W/new" >/dev/null 2>&1; }
up() { rm -rf "$W/upper"; mkdir -p "$W/upper/var/lib/dpkg" "$W/upper/usr/local"; }
py() { PYTHONPATH="$HA/lib" python3 -c "$1" >/dev/null 2>&1; }

reset_host; up; ln -s "$HOST/dpkg/status" "$W/upper/var/lib/dpkg/status"; rb
check "rebase: dpkg/status -> host file: host file untouched" intact
reset_host; up; mknod "$W/upper/var/lib/dpkg/status" b "$MAJ" "$MIN"; rb
check "rebase: dpkg/status = block device: device untouched" intact
reset_host; up; rmdir "$W/upper/var/lib/dpkg"; ln -s "$HOST/dpkg" "$W/upper/var/lib/dpkg"; ln -s "$HOST/bin" "$W/upper/usr/local/bin"; rb
check "rebase: symlinked parents leave host files alone" intact
reset_host; rm -rf "$W/upper"; ln -s "$HOST/rootdir" "$W/upper"; rb; rm -f "$W/upper"
check "rebase: symlinked upper root refused, host untouched" intact
D="$W/data"
reset_host; rm -rf "$D"; mkdir -p "$D/profiles"; ln -s "$HOST/chrome" "$D/profiles/chrome"
py "from ezil_host import fsops; fsops.remove_singletons('$D')"
check "singleton cleanup: profiles/chrome -> host dir: host file kept" intact
reset_host; rm -rf "$D"; mkdir -p "$D"; ln -s "$HOST" "$D/profiles"
py "from ezil_host import fsops; fsops.remove_singletons('$D')"
check "singleton cleanup: profiles -> host dir: refused" intact
reset_host; rm -rf "$D"; mkdir -p "$D/profiles/chrome"; ln -s ezil-gen-3-269 "$D/profiles/chrome/SingletonLock"; ln -s "$HOST/etc/passwd" "$D/profiles/chrome/SingletonCookie"
py "from ezil_host import fsops; fsops.remove_singletons('$D')"
check "singleton cleanup: real dir: stale entries removed, link target kept" bash -c "[ ! -L '$D/profiles/chrome/SingletonLock' ] && [ ! -L '$D/profiles/chrome/SingletonCookie' ]"
check "singleton cleanup: host canaries intact" intact
reset_host; rm -rf "$D"; mkdir -p "$D/root/upper/run/sub"; ln -s "$HOST/rootdir" "$D/root/upper/tmp"
ln -s "$HOST/etc/passwd" "$D/root/upper/run/l1"; ln -s "$HOST/rootdir" "$D/root/upper/run/l2"; echo x > "$D/root/upper/run/sub/f"
py "from ezil_host import fsops; fsops.clear_dir('$D', 'root/upper/tmp')"
check "clear: upper/tmp -> host dir refused" intact
py "from ezil_host import fsops; fsops.clear_dir('$D', 'root/upper/run')"
check "clear: upper/run emptied without following links" bash -c "[ -z \"\$(ls -A '$D/root/upper/run')\" ]"
check "clear: host canaries intact" intact

# §3a.7 the merged overlay is nodev: a guest-made device node is not usable on the host
reset_host; mkdir -p "$W/ovl/upper/dev2" "$W/ovl/work" "$W/ovl/lower" "$W/merged"
mknod "$W/ovl/upper/dev2/blk" b "$MAJ" "$MIN"
mount -t overlay "${TAG}-nodevtest" -o "nodev,lowerdir=$W/ovl/lower,upperdir=$W/ovl/upper,workdir=$W/ovl/work" "$W/merged"
check "nodev overlay: opening the guest's device node via the merged path is refused" bash -c "! head -c 16 '$W/merged/dev2/blk' >/dev/null 2>&1"
umount "$W/merged"
mount -t overlay "${TAG}-nodevtest" -o "lowerdir=$W/ovl/lower,upperdir=$W/ovl/upper,workdir=$W/ovl/work" "$W/merged"
check "(control) without nodev the same node opens and reads the device" bash -c "head -c 13 '$W/merged/dev2/blk' | grep -q DEVICE-CANARY"
umount "$W/merged"
check "production overlay_mount passes nodev" grep -q '"nodev,lowerdir=' "$HA/lib/ezil_host/desktop.py"
summary "hostile volume (§3a.1, §3a.7)"
