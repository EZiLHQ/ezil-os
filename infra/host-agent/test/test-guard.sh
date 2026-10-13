#!/usr/bin/env bash
# C-4 guard + boot-order fail-closed, on a real loop-device ext4 volume. No container.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"
H="$(host_new g "$(shared_lower)")"; IMG="$(vol_new g 1G)"; DEV="$(vol_attach g "$IMG")"
stubs_up g
trap 'agent g teardown >/dev/null 2>&1; stubs_down g; vol_detach "$IMG"' EXIT
M="$H/srv/ezil-data/.ezil-marker.json"
lease() { userdata g "$@"; agent g lease >/dev/null; }
mnt_rw() { mount -o nosuid,nodev "$DEV" "$H/srv/ezil-data"; }
unmnt() { umount "$H/srv/ezil-data" 2>/dev/null; true; }

# --- provisioning
lease 1 1 false
expect_refuse "unformatted volume without provision is refused" volume_has_no_filesystem agent g guard
lease 1 1 true
check "provision: guard formats the empty volume with the lease fsUuid and inits" agent g guard
check "device UUID == lease fsUuid" test "$(blkid -s UUID -o value "$DEV")" = "$FS_UUID"
check "marker written: generation 1, leaseEpoch 1, host digest" jq -e --arg d "$DIGEST" '.generation==1 and .leaseEpoch==1 and .lowerImageDigest==$d' "$M"
check "data volume mounted rw,nosuid,nodev after the guard" bash -c "findmnt -n -o OPTIONS '$H/srv/ezil-data' | grep -q '^rw' && findmnt -n -o OPTIONS '$H/srv/ezil-data' | grep -q nosuid && findmnt -n -o OPTIONS '$H/srv/ezil-data' | grep -q nodev"
check "guard stamp bound to (generation 1, epoch 1)" jq -e '.generation==1 and .leaseEpoch==1' "$H/run/guard-ok"
agent g data-down >/dev/null

# --- C-4 refusals (each on a fresh lease; marker is gen 1 / epoch 1)
lease 1 1 false; expect_refuse "same epoch replayed" epoch_not_increasing agent g guard
check "a refusal leaves the volume unmounted" bash -c "! mountpoint -q '$H/srv/ezil-data'"
check "a refusal leaves no guard stamp" test ! -e "$H/run/guard-ok"
lease 1 2 false; check "same writer generation, next epoch: accepted (start-in-place)" agent g guard; agent g data-down >/dev/null
check "marker follows the lease: generation 1, epoch 2" jq -e '.generation==1 and .leaseEpoch==2' <(mount -o ro "$DEV" "$H/srv/ezil-data" && cat "$M"; umount "$H/srv/ezil-data")
lease 2 3 false; check "next writer generation + epoch: accepted (replacement)" agent g guard; agent g data-down >/dev/null
lease 2 2 false; expect_refuse "lower epoch than the marker" epoch_not_increasing agent g guard
lease 1 4 false; expect_refuse "writer generation above the lease" generation_ahead agent g guard
for f in computerId volumeId fsUuid; do
    mnt_rw; cp "$M" "$T/m.bak"; jq --arg f "$f" '.[$f] = (if $f=="volumeId" then "vol-0fffffffffffffff0" else "99999999-2222-3333-4444-555555555555" end)' "$T/m.bak" > "$M"; unmnt
    lease 2 4 false
    code="$(echo "$f" | sed 's/computerId/computer_id_mismatch/;s/volumeId/volume_id_mismatch/;s/fsUuid/fs_uuid_mismatch/')"
    expect_refuse "marker $f mismatch" "$code" agent g guard
    mnt_rw; cp "$T/m.bak" "$M"; unmnt
done
# device UUID != lease fsUuid (wrong disk attached)
jq '.fsUuid="7c2f1d0e-2e3b-4d4c-8f9a-1b2c3d4e5f60"' "$H/stub/user-data" > "$T/ud" && cp "$T/ud" "$H/stub/user-data"; agent g lease >/dev/null
expect_refuse "device fs UUID != lease fsUuid" fs_uuid_mismatch agent g guard
# lease names a volume whose device is not attached
jq '.volumeId="vol-0aaaaaaaaaaaaaaa0"' "$H/stub/user-data" > "$T/ud" && cp "$T/ud" "$H/stub/user-data"; agent g lease >/dev/null
expect_refuse "lease volume not attached" volume_device_missing agent g guard
# lower digest mismatch without a snapshot receipt
mnt_rw; cp "$M" "$T/m.bak"; jq '.lowerImageDigest="sha256:'"$(printf 'a%.0s' $(seq 64))"'"' "$T/m.bak" > "$M"; unmnt
lease 2 5 false; expect_refuse "lowerImageDigest mismatch, no receipt" lower_digest_mismatch agent g guard
RB='{"snapshotId":"snap-0123456789abcdef0","volumeId":"'"$VOL_ID"'","fromDigest":"sha256:'"$(printf 'b%.0s' $(seq 64))"'","toDigest":"'"$DIGEST"'"}'
lease 2 5 false "$RB"; expect_refuse "receipt whose fromDigest != marker" rebase_receipt_mismatch agent g guard
RB2="$(jq -c '.fromDigest="sha256:'"$(printf 'a%.0s' $(seq 64))"'"' <<<"$RB")"
lease 2 5 false "$RB2"; expect_refuse "receipt valid but old lower absent on this host" rebase_old_lower_missing agent g guard
mnt_rw; cp "$T/m.bak" "$M"; unmnt
# malformed markers, symlinked marker
for bad in '{not json' '{"computerId":"x"}' '[]'; do
    mnt_rw; printf '%s' "$bad" > "$M"; unmnt
    lease 2 6 false; expect_refuse "malformed marker ${bad:0:12}" marker_malformed agent g guard
done
mnt_rw; rm -f "$M"; ln -s /etc/hostname "$M"; unmnt
lease 2 6 false; expect_refuse "marker is a symlink (never followed)" marker_malformed agent g guard
mnt_rw; rm -f "$M"; unmnt
lease 2 6 false; expect_refuse "marker deleted on a used volume" marker_missing agent g guard
lease 2 6 true; expect_refuse "provision lease cannot re-init a non-empty volume" marker_missing agent g guard
mnt_rw; cp "$T/m.bak" "$M"; printf '{"state":"rebase_failed"}' > "$H/srv/ezil-data/.ezil-rebase-state.json"; unmnt
lease 2 6 false; expect_refuse "rebase_failed state blocks the boot" rebase_failed agent g guard
mnt_rw; rm -f "$H/srv/ezil-data/.ezil-rebase-state.json"; mv "$H/srv/ezil-data/profiles" "$T/profiles.bak" 2>/dev/null; ln -s /etc "$H/srv/ezil-data/profiles"; unmnt
lease 2 6 false; expect_refuse "planted symlink in the volume layout" layout_not_a_real_directory agent g guard
mnt_rw; rm -f "$H/srv/ezil-data/profiles"; mv "$T/profiles.bak" "$H/srv/ezil-data/profiles"; unmnt

# --- nothing downstream starts if the guard refused
lease 2 2 false
out="$(agent g boot-chain enroll 2>&1)"; rc=$?
check "boot-chain stops at the guard (rc 2)" test $rc -eq 2
check "boot-chain printed no step after the guard" bash -c "! grep -qE '^\[(clean|overlay|desktop|enroll)\]' <<<'$out'"
for s in clean overlay desktop enroll cloudflared agent; do
    expect_refuse "downstream step '$s' refuses without a guard stamp" guard_not_passed agent g "$s"
done
check "no overlay mounted, no container created" bash -c "! mountpoint -q '$H/run/rootfs' && ! runc --root '$H/run/runc' state ${TAG}-g >/dev/null 2>&1"
# a stamp from an older lease does not satisfy a newer one
lease 2 7 false; agent g guard >/dev/null; agent g data-down >/dev/null
lease 2 8 false
expect_refuse "stale stamp (epoch 7) does not satisfy lease epoch 8" guard_stamp_stale agent g clean

# --- durability: fsync(tmp) -> rename -> fsync(dir), observed
lease 2 9 false
strace -f -y -qq -e trace=fsync,rename,renameat,renameat2 -o "$T/strace.out" env "$(host_env g)" "$AGENT" guard >/dev/null 2>&1
check "marker write order: fsync(tmp) -> rename(tmp, marker) -> fsync(data root)" awk -v mp="$H/srv/ezil-data" '
    /fsync\(/ && /\.ezil-marker\.json\.tmp\./ && st==0 {st=1; next}
    /rename/ && /\.ezil-marker\.json\.tmp\./ && /\.ezil-marker\.json"/ && st==1 {st=2; next}
    /fsync\(/ && index($0, "<" mp ">") && st==2 {st=3}
    END {exit st==3 ? 0 : 1}' "$T/strace.out"
agent g data-down >/dev/null
summary "C-4 guard + fail-closed boot order"
