#!/usr/bin/env bash
# R4 + §3a.8 rebase job through the guard: snapshot receipt required, failure ->
# rebase_failed and nothing starts, restore + rebase succeeds, every rule mutation-
# proven, planted preserve dir and a 5000-level tree handled. No container needed: the
# result is inspected through a read-only overlay view (upper:new:old), kernel semantics.
# The shared lower is extracted from the reviewed local Docker image.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"
OLDL="$(shared_lower)/$DHEX"
LW="$T/rlowers"; rm -rf "$LW"; mkdir -p "$LW"; ln -s "$OLDL" "$LW/$DHEX"
NEWL="$T/newlayer"; rm -rf "$NEWL"
H="$(host_new r "$LW")"; IMG="$(vol_new r 1G)"; DEV="$(vol_attach r "$IMG")"; stubs_up r
VIEW="$T/rview"; mkdir -p "$VIEW"
cleanup() { mountpoint -q "$VIEW" && umount "$VIEW"; for m in "$LW"/*; do mountpoint -q "$m" && umount "$m"; done
            agent r teardown >/dev/null 2>&1; stubs_down r; vol_detach "$IMG"
            [ -z "${FAILED_IMG:-}" ] || vol_detach "$FAILED_IMG"
            rm -f "$T/snap-r.img" "$T/snap-rebound-r.img"; }
trap cleanup EXIT
D="$H/srv/ezil-data"; U="$D/root/upper"

# ---- the new image = old lower + a layer
mkdir -p "$NEWL"/{usr/bin,usr/local/bin,usr/share/doc/dpkg,etc,opt/ezil-collide,var/lib/dpkg/info}
printf '#!/bin/sh\necho v2\n' > "$NEWL/usr/bin/ezil-spike-hello"; chmod 755 "$NEWL/usr/bin/ezil-spike-hello"
{ cat "$OLDL/etc/ezil-image-id"; echo v2; } > "$NEWL/etc/ezil-image-id"
echo 'image v2' > "$NEWL/usr/local/bin/ezil-collide"; echo 'image v2' > "$NEWL/opt/ezil-collide/tool"
echo 'new in v2' > "$NEWL/usr/share/doc/dpkg/ezil-v2-note"
{ cat "$OLDL/var/lib/dpkg/info/dpkg.list"; echo /usr/share/doc/dpkg/ezil-v2-note; } > "$NEWL/var/lib/dpkg/info/dpkg.list"
printf '/.\n/usr\n/usr/bin\n/usr/bin/ezil-spike-hello\n' > "$NEWL/var/lib/dpkg/info/ezil-spike-pkg.list"
echo 'v2sums' > "$NEWL/var/lib/dpkg/info/ezil-spike-pkg.md5sums"
{ cat "$OLDL/var/lib/dpkg/status"; printf '\nPackage: ezil-spike-pkg\nStatus: install ok installed\nArchitecture: all\nVersion: 2.0\nDescription: v2\n'; } > "$NEWL/var/lib/dpkg/status"
NEWD="sha256:$(tar -C "$NEWL" --sort=name --mtime=@0 --owner=0 --group=0 -cf - . | sha256sum | cut -d' ' -f1)"
mkdir -p "$LW/${NEWD#sha256:}"; mount -t overlay "${TAG}-newlower" -o "ro,lowerdir=$NEWL:$OLDL" "$LW/${NEWD#sha256:}"
NEWV="$LW/${NEWD#sha256:}"

# ---- provision on the OLD image and seed user state into the upper
userdata r 1 1 true; agent r lease >/dev/null; agent r guard >/dev/null || fail "provision guard"
mkdir -p "$U"/{usr/bin,usr/local/bin,usr/share/doc/bash,usr/share/doc/dpkg,var/lib/dpkg/info,var/lib/svc,etc,opt/ezil-collide}
printf '#!/bin/sh\necho v1\n' > "$U/usr/bin/ezil-spike-hello"; chmod 755 "$U/usr/bin/ezil-spike-hello"
echo 'v1sums' > "$U/var/lib/dpkg/info/ezil-spike-pkg.md5sums"; echo '/usr/bin/ezil-spike-hello' > "$U/var/lib/dpkg/info/ezil-spike-pkg.list"
{ cat "$OLDL/var/lib/dpkg/status"; printf '\nPackage: ezil-spike-pkg\nStatus: install ok installed\nArchitecture: all\nVersion: 1.0\nDescription: v1\n\nPackage: ezil-user-only\nStatus: install ok installed\nArchitecture: all\nVersion: 1.0\nDescription: user\n'; } > "$U/var/lib/dpkg/status"
mknod "$U/usr/share/doc/bash/copyright" c 0 0                             # whiteout of an image file
cp -p "$OLDL/etc/ezil-image-id" "$U/etc/ezil-image-id"; touch "$U/etc/ezil-image-id"   # mtime-only copy-up
python3 -c "import os; os.setxattr('$U/usr/share/doc/dpkg', 'trusted.overlay.opaque', b'y')"; echo mine > "$U/usr/share/doc/dpkg/user-note"
echo "user $RANDOM" > "$U/usr/local/bin/ezil-collide"; echo "user opt $RANDOM" > "$U/opt/ezil-collide/tool"
echo user-tool > "$U/usr/local/bin/user-tool"; head -c 65536 /dev/urandom > "$U/var/lib/svc/data"
{ cat "$OLDL/etc/bash.bashrc"; echo '# user edit'; } > "$U/etc/bash.bashrc"
COLL="$(sha256sum "$U/usr/local/bin/ezil-collide" | cut -d' ' -f1)"; COLLO="$(sha256sum "$U/opt/ezil-collide/tool" | cut -d' ' -f1)"
KEEP="$( cd "$U" && sha256sum usr/local/bin/user-tool var/lib/svc/data etc/bash.bashrc usr/share/doc/dpkg/user-note )"
agent r data-down >/dev/null
cp --sparse=always "$IMG" "$T/snap-r.img"                                    # the "pre-rebase snapshot"
echo "$NEWD" > "$H/etc/lower-image-digest"                                  # host now runs the NEW image
RB="$(jq -nc --arg v "$VOL_ID" --arg f "$DIGEST" --arg t "$NEWD" '{snapshotId:"snap-0123456789abcdef0", volumeId:$v, fromDigest:$f, toDigest:$t}')"

# ---- 1. no receipt / bad receipt: refused, volume untouched
userdata r 1 2 false; agent r lease >/dev/null
expect_refuse "new image without a snapshot receipt" lower_digest_mismatch agent r guard
check "volume untouched by the refusal (byte-identical to the snapshot)" cmp "$IMG" "$T/snap-r.img"
userdata r 1 2 false "$(jq -c '.toDigest="sha256:'"$(printf 'c%.0s' $(seq 64))"'"' <<<"$RB")"; agent r lease >/dev/null
expect_refuse "receipt for another target image" rebase_receipt_mismatch agent r guard
userdata r 1 2 false "$(jq -c '.volumeId="vol-0fffffffffffffff0"' <<<"$RB")"
check "receipt for another volume is rejected by the lease parser" bash -c "! EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' lease >/dev/null 2>&1"

# ---- 2. failure part way: rebase_failed, nothing downstream, sticky until restore
userdata r 1 2 false "$RB"; agent r lease >/dev/null
EZIL_REBASE_FAULT_AFTER=5 expect_refuse "rebase fault after 5 entries -> rebase_failed" rebase_failed agent r guard
check "volume unmounted after the failure" bash -c "! mountpoint -q '$D'"
out="$(EZIL_REBASE_FAULT_AFTER=5 agent r boot-chain desktop 2>&1)"
check "boot-chain stops at the guard: no clean/overlay/desktop" bash -c "! grep -qE '^\[(clean|overlay|desktop)\]' <<<'$out' && ! mountpoint -q '$H/run/rootfs'"
userdata r 1 3 false "$RB"; agent r lease >/dev/null
expect_refuse "next epoch, valid receipt: still refused until the snapshot is restored" rebase_failed agent r guard
check "state file records rebase_failed + exit code + snapshot" bash -c "mount -o ro,nosuid,nodev '$DEV' '$D' && jq -e '.state==\"rebase_failed\" and .exitCode!=0 and .receipt.snapshotId==\"snap-0123456789abcdef0\"' '$D/.ezil-rebase-state.json'; rc=\$?; umount '$D'; exit \$rc"
# Restore to a DIFFERENT provider volume identity; retain the failed source untouched.
FAILED_IMG="$IMG"; FAILED_HASH="$(sha256sum "$FAILED_IMG" | cut -d' ' -f1)"
ORIGINAL_VOL="$VOL_ID"; vol_detach "$IMG"
IMG="$T/vol-restored-r.img"; cp --sparse=always "$T/snap-r.img" "$IMG"
rm -f "$H/byid/nvme-Amazon_Elastic_Block_Store_${ORIGINAL_VOL//-/}"
VOL_ID=vol-22222222222222222; DEV="$(vol_attach r "$IMG")"
echo "$DIGEST" > "$H/etc/lower-image-digest"
userdata r 2 4 false; agent r lease >/dev/null
expect_refuse "ordinary lease cannot rebind a snapshot's old volume ID" volume_id_mismatch agent r guard
userdata r 2 4 false
python3 "$HA/test/rebase-fixture.py" rebind "$H/stub/user-data" "$ORIGINAL_VOL" "$DIGEST" 1 1
jq '.instanceId="i-11111111111111111"' "$H/stub/identity.json" > "$T/rebind-identity.json"
cp "$T/rebind-identity.json" "$H/stub/identity.json"
printf '%s' '{"maintenance":true,"accepted":true}' > "$H/stub/issue.json"
agent r lease >/dev/null
check "maintenance rebind succeeds on the different volume" agent r guard
check "rebind changes only identity, retaining the source lower" jq -e --arg v "$VOL_ID" --arg d "$DIGEST" '.volumeId==$v and .lowerImageDigest==$d and .generation==2 and .leaseEpoch==4' "$D/.ezil-marker.json"
check "maintenance report accepted without desktop credentials" agent r maintenance-enroll
check "maintenance has its own receipt and never guard-ok or tunnel credentials" bash -c "[ -f '$H/state/maintenance-enrolled.json' ] && [ ! -e '$H/run/guard-ok' ] && [ ! -e '$H/state/tunnel.json' ] && [ ! -e '$H/state/control.key' ]"
for downstream in clean overlay desktop edge cloudflared agent; do
    expect_refuse "maintenance blocks direct $downstream" maintenance_only agent r "$downstream"
done
agent r data-down >/dev/null; agent r lease >/dev/null
check "same authorized rebind repeats after completion" agent r guard
check "maintenance receipt reuses after same-instance reboot" agent r maintenance-enroll
check "failed source volume retained byte-for-byte" bash -c "[ \$(sha256sum '$FAILED_IMG' | cut -d' ' -f1) = '$FAILED_HASH' ]"
agent r data-down >/dev/null
# A NEW preparation checkpoint/receipt names the rebound volume before retry.
cp --sparse=always "$IMG" "$T/snap-rebound-r.img"
RB="$(jq -nc --arg v "$VOL_ID" --arg f "$DIGEST" --arg t "$NEWD" '{snapshotId:"snap-22222222222222222", volumeId:$v, fromDigest:$f, toDigest:$t}')"
echo "$NEWD" > "$H/etc/lower-image-digest"

# ---- 3. every rule must matter (copies of the seeded upper, rebased with one rule off)
mount -o ro,nosuid,nodev "$DEV" "$D"; rm -rf "$T/seed-upper"; cp -a "$U" "$T/seed-upper"; umount "$D"
nsha() { sha256sum "$NEWV$1" 2>/dev/null | cut -d' ' -f1; }; vsha() { sha256sum "$VIEW$1" 2>/dev/null | cut -d' ' -f1; }
view_checks() {
    awk '/^Package: ezil-spike-pkg$/{p=1} p&&/^Version:/{print $2; exit}' "$VIEW/var/lib/dpkg/status" | grep -qx 2.0 && grep -qx 'Package: ezil-user-only' "$VIEW/var/lib/dpkg/status" || echo "rule1"
    [ "$(vsha /var/lib/dpkg/info/ezil-spike-pkg.md5sums)" = "$(nsha /var/lib/dpkg/info/ezil-spike-pkg.md5sums)" ] || echo "rule2"
    [ "$(vsha /usr/bin/ezil-spike-hello)" = "$(nsha /usr/bin/ezil-spike-hello)" ] || echo "rule3"
    [ "$(vsha /usr/share/doc/bash/copyright)" = "$(nsha /usr/share/doc/bash/copyright)" ] || echo "rule3w"
    [ "$(vsha /etc/ezil-image-id)" = "$(nsha /etc/ezil-image-id)" ] || echo "rule4"
    [ -e "$VIEW/usr/share/doc/dpkg/ezil-v2-note" ] || echo "rule5"
    local pd; pd="$(jq -r '.preserved_dir // empty' "$T/mut.report" 2>/dev/null)"
    [ -n "$pd" ] && [ "$(sha256sum "$T/mut$pd/usr/local/bin/ezil-collide" 2>/dev/null | cut -d' ' -f1)" = "$COLL" ] || echo "ruleP"
}
for rule in none 1 2 3 3w 4 5 P; do
    rm -rf "$T/mut"; cp -a "$T/seed-upper" "$T/mut"
    EZIL_REBASE_DISABLE="$([ "$rule" = none ] || echo "$rule")" PYTHONPATH="$HA/lib" python3 -m ezil_host.rebase "$T/mut" "$OLDL" "$NEWV" > "$T/mut.report" 2>"$T/mut.err" \
        || { fail "rebase (rule $rule off) crashed: $(tail -c 200 "$T/mut.err")"; continue; }
    mount -t overlay "${TAG}-rview" -o "ro,lowerdir=$T/mut:$NEWL:$OLDL" "$VIEW"; red="$(view_checks)"; umount "$VIEW"
    if [ "$rule" = none ]; then [ -z "$red" ] && pass "[mutation] all rules on: all view checks green" || fail "[mutation] all on but red: $red"
    else grep -qx "rule$rule" <<<"$red" && pass "[mutation] rule $rule off -> its own check goes red" || fail "[mutation] rule $rule off and its check stayed green (red: $red)"; fi
done

# ---- crash, permit and capacity boundaries on disposable clones of the rebound checkpoint
reset_rebound() {
    agent r data-down >/dev/null 2>&1
    vol_detach "$IMG"; cp --sparse=always "$T/snap-rebound-r.img" "$IMG"
    DEV="$(vol_attach r "$IMG")"
}
userdata r 3 6 false "$RB"
python3 "$HA/test/rebase-fixture.py" permit "$H/stub/user-data" -601
agent r lease >/dev/null
expect_refuse "expired permit refuses before upper mutation" permit_expired agent r guard
check "expired permit left no rebase state" bash -c "mount -o ro,noload '$DEV' '$D' && [ ! -e '$D/.ezil-rebase-state.json' ]; rc=\$?; umount '$D'; exit \$rc"
for point in before-marker after-marker; do
    reset_rebound
    userdata r 3 6 false "$RB"; agent r lease >/dev/null
    EZIL_REBASE_FAULT_AFTER="$point" agent r guard >/dev/null 2>&1; rc=$?
    check "crash $point exits at the injected commit boundary" test "$rc" -eq 99
    expected="$DIGEST"; [ "$point" != after-marker ] || expected="$NEWD"
    check "crash $point retains state and expected marker" bash -c "[ -f '$D/.ezil-rebase-state.json' ] && [ ! -e '$H/run/guard-ok' ] && jq -e --arg d '$expected' '.lowerImageDigest==\$d' '$D/.ezil-marker.json'"
    agent r data-down >/dev/null
    expect_refuse "crash $point stays blocked on next boot" rebase_failed agent r guard
done
for resource in blocks inodes; do
    reset_rebound
    mount -o rw,nosuid,nodev "$DEV" "$D"
    python3 - "$D" "$resource" <<'FILL'
import errno, os, sys
root, resource = sys.argv[1:]
try:
    if resource == 'blocks':
        with open(root + '/.fill-blocks', 'wb', buffering=0) as f:
            block = b'\0' * (1024 * 1024)
            while True: f.write(block)
    else:
        path = root + '/.fill-inodes'
        os.mkdir(path)
        i = 0
        while True:
            fd = os.open(path + '/' + str(i), os.O_CREAT | os.O_WRONLY, 0o600)
            os.close(fd); i += 1
except OSError as e:
    if e.errno != errno.ENOSPC: raise
os.sync()
v = os.statvfs(root)
assert (v.f_bavail == 0 if resource == 'blocks' else v.f_favail == 0), 'wrong resource exhausted'
FILL
    check "fixture exhausted real filesystem $resource" test "$?" -eq 0
    umount "$D"
    userdata r 3 6 false "$RB"; agent r lease >/dev/null
    expect_refuse "full $resource refuses before rebase" rebase_failed agent r guard
    expect_refuse "full $resource leaves downstream blocked" guard_not_passed agent r overlay
done
reset_rebound

# ---- 4. restored volume + valid receipt: rebase through the guard
userdata r 3 6 false "$RB"; agent r lease >/dev/null
gout="$(agent r guard 2>&1)"
check "guard with snapshot receipt rebases and accepts" grep -q 'guard rebase_needed' <<<"$gout"
grep -q 'guard rebase_needed' <<<"$gout" || log "guard said: $(tail -c 600 <<<"$gout")"
check "marker carries the NEW digest, epoch 6; no state file left" bash -c "jq -e --arg d '$NEWD' '.lowerImageDigest==\$d and .leaseEpoch==6' '$D/.ezil-marker.json' && [ ! -e '$D/.ezil-rebase-state.json' ]"
PD="$(jq -r .preserved_dir "$H/run/rebase-report.json")"
check "colliding /usr/local and /opt user files moved aside intact" bash -c "[ \$(sha256sum '$U$PD/usr/local/bin/ezil-collide' | cut -d' ' -f1) = $COLL ] && [ \$(sha256sum '$U$PD/opt/ezil-collide/tool' | cut -d' ' -f1) = $COLLO ]"
check "kept user files byte-identical (/usr/local, /var/lib, /etc edit, file in opaque dir)" bash -c "cd '$U' && [ \"\$(sha256sum usr/local/bin/user-tool var/lib/svc/data etc/bash.bashrc usr/share/doc/dpkg/user-note)\" = \"$KEEP\" ]"
agent r data-down >/dev/null

# ---- 5. planted /.ezil-rebase-preserved and a 5000-level tree
mk_hostile() {
    rm -rf "$1"; mkdir -p "$1/usr/local/bin"; echo "user $RANDOM" > "$1/usr/local/bin/ezil-collide"
    ln -s /etc "$1/.ezil-rebase-preserved"
    python3 - "$1" <<'EOF'
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
for i in range(5000):
    os.mkdir("d", dir_fd=fd); n = os.open("d", os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd); os.close(fd); fd = n
os.close(os.open("bottom", os.O_WRONLY | os.O_CREAT, 0o644, dir_fd=fd))
EOF
}
mk_hostile "$T/hz"
PYTHONPATH="$HA/lib" python3 -m ezil_host.rebase "$T/hz" "$OLDL" "$NEWV" > "$T/hz.report" 2>"$T/hz.err"; rc=$?
check "rebase completes on a planted preserve symlink + 5000-deep tree (rc 0)" test $rc -eq 0
check "planted /.ezil-rebase-preserved renamed aside, /etc untouched" bash -c "jq -e '.planted_preserve_renamed|startswith(\"/.ezil-rebase-preserved.planted-\")' '$T/hz.report' && [ -L \$(ls -d '$T'/hz/.ezil-rebase-preserved.planted-*) ] && [ -e /etc/hostname ]"
check "collision still preserved into a real preserve dir" bash -c "pd=\$(jq -r .preserved_dir '$T/hz.report'); [ -f '$T/hz'\$pd/usr/local/bin/ezil-collide ] && [ ! -L '$T/hz/.ezil-rebase-preserved' ]"
check "whole deep tree walked (max_depth >= 5000) and the bottom file kept" bash -c "jq -e '.max_depth >= 5000 and .long_paths_kept >= 1' '$T/hz.report'"
mk_hostile "$T/hz2"
git -C "${EZIL_HOST_REPO:-$HA}" show fb6e296:infra/host-agent/spike/rebase-upper.py > "$T/spike-rebase.py" 2>/dev/null
python3 "$T/spike-rebase.py" "$T/hz2" "$OLDL" "$NEWV" > /dev/null 2>"$T/hz2.err"; rc=$?
check "(evidence) the recursive S1 spike rebase aborts on the same input (rc != 0)" test $rc -ne 0
rm -rf "$T/hz" "$T/hz2" "$T/mut" "$T/seed-upper"
summary "rebase job (R4, §3a.8)"
