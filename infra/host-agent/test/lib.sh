#!/usr/bin/env bash
# Shared helpers for the I4 host-agent tests. Real loop-device ext4 data volumes, real
# runc, real desktop image; IMDS and the app are stubs on UNIX sockets; cloudflared and
# `shutdown` are stubs. Network: the container gets a netns with loopback only.
# Everything lives under $T and is prefixed ezil-host-fb25d9f4. Root required.
set -uo pipefail
HA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG=ezil-host-fb25d9f4
T="${EZIL_HOST_TEST_DIR:-/var/tmp/${TAG}}"
IMAGE="${EZIL_HOST_TEST_IMAGE:-ezil-final:82b0f33-local}"
AGENT="$HA/bin/ezil-host-agent"
AA_PROFILE="${TAG}-desktop"
CID_COMPUTER=11111111-2222-3333-4444-555555555555
VOL_ID=vol-0123456789abcdef0
FS_UUID=6b1f0c9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f
mkdir -p "$T"; chmod 700 "$T"

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$*"; }
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$d"; else fail "$d"; fi; }
expect_refuse() { # expect_refuse <desc> <code> <cmd...>
    local d="$1" code="$2"; shift 2; local out; out="$("$@" 2>&1)"; local rc=$?
    if [ $rc -eq 2 ] && grep -q "REFUSE $code" <<<"$out"; then pass "$d ($code)"; else fail "$d (rc=$rc want REFUSE $code; got: $(tail -n 2 <<<"$out" | tr '\n' ' ' | cut -c1-220))"; fi
}
summary() { printf -- '---- %s: %d PASS, %d FAIL\n' "$1" "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }
log() { printf '[i4] %s\n' "$*" >&2; }

image_digest() { docker image inspect --format '{{.Id}}' "$IMAGE"; }
DIGEST="$(image_digest)"; DHEX="${DIGEST#sha256:}"

# ------------------------------------------------------------------ lowers
extract_lower() { # extract_lower <dir>
    local dir="$1" c="${TAG}-export-$$"
    rm -rf "$dir"; mkdir -p "$dir"
    docker create --name "$c" "$IMAGE" /bin/true >/dev/null
    docker export "$c" | tar -C "$dir" --numeric-owner --xattrs --xattrs-include='*' -xpf -
    docker rm "$c" >/dev/null
}
shared_lower() { # one extraction reused by tests that are not about host replacement
    [ -d "$T/shared-lowers/$DHEX/usr" ] || { log "extracting shared lower"; extract_lower "$T/shared-lowers/$DHEX"; }
    echo "$T/shared-lowers"
}

# ------------------------------------------------------------------- hosts
# host_new <name> [lowersDir]  — a simulated host: its own root-volume dirs and config.
host_new() {
    local h="$1" lowers="${2:-}" H="$T/hosts/$1"
    if findmnt -rn -o TARGET | grep -q "^$H/"; then log "host $h still has mounts; refusing to reset"; return 1; fi
    rm -rf "$H"
    mkdir -p "$H"/{etc,state,run,byid,stub,srv,cloud}
    chmod 700 "$H/state"
    [ -n "$lowers" ] || lowers="$H/lowers"
    echo "$DIGEST" > "$H/etc/lower-image-digest"
    docker image inspect "$IMAGE" | jq '{Env: .[0].Config.Env, WorkingDir: .[0].Config.WorkingDir}' > "$H/etc/image-config.json"
    cat > "$H/etc/agent.json" <<EOF
{"dataMount": "$H/srv/ezil-data", "stateDir": "$H/state", "runDir": "$H/run", "lowersDir": "$lowers",
 "lowerDigestFile": "$H/etc/lower-image-digest", "imageConfigFile": "$H/etc/image-config.json",
 "seccompProfile": "$HA/security/seccomp.json", "apparmorProfile": "$AA_PROFILE",
 "deviceByIdDir": "$H/byid", "imdsUrl": "unix://$H/stub/imds.sock",
 "enrollUrl": "https+unix://$H/stub/app.sock/api/internal/computers/enroll",
 "caFile": "$T/pki/ca.pem", "tlsServerName": "app.ezil.test",
 "cloudflaredBin": "$H/stub/cloudflared", "containerId": "${TAG}-$h", "netnsName": "${TAG}-$h",
 "cgroupsPath": "system.slice:${TAG}:$h", "networkMode": "none",
 "idle": {"inactivitySeconds": 3, "load1Busy": 1000, "intervalSeconds": 1, "flushTimeoutSeconds": 20},
 "shutdownCmd": ["$HA/test/stub-shutdown", "$H/run/shutdown-called"], "stopWarnSeconds": 1,
 "userDataCopies": ["$H/cloud/user-data.txt", "$H/cloud/instances/*/user-data.txt", "$H/cloud/instances/*/user-data.txt.i",
                    "$H/cloud/instances/*/obj.pkl", "$H/cloud/run/instance-data-sensitive.json"]}
EOF
    printf '#!/bin/sh\nSTUB_CF_DIR=%s exec %s "$@"\n' "$H/stub" "$HA/test/stub-cloudflared" > "$H/stub/cloudflared"
    chmod 755 "$H/stub/cloudflared"
    echo "$H"
}
host_env() { echo "EZIL_HOST_CONFIG=$T/hosts/$1/etc/agent.json"; }
agent() { local h="$1"; shift; env "EZIL_HOST_CONFIG=$T/hosts/$h/etc/agent.json" PATH="$PATH" "$AGENT" "$@"; }
runc_h() { local h="$1"; shift; runc --root "$T/hosts/$h/run/runc" --systemd-cgroup "$@"; }
ctr_sh() { local h="$1"; shift; runc_h "$h" exec "${TAG}-$h" /bin/bash -c "$1"; }

# ------------------------------------------------------------- data volume
vol_new() { # vol_new <name> [size] -> image path (unformatted: provisioning formats it)
    local img="$T/vol-$1.img"; rm -f "$img"; truncate -s "${2:-6G}" "$img"; echo "$img"
}
vol_attach() { # vol_attach <host> <img> [volume-id]: loop + by-id link like Nitro's
    local h="$1" img="$2" vid="${3:-$VOL_ID}" dev
    dev="$(losetup -j "$img" | cut -d: -f1 | head -n1)"
    [ -n "$dev" ] || dev="$(losetup --find --show "$img")"
    ln -sfn "$dev" "$T/hosts/$h/byid/nvme-Amazon_Elastic_Block_Store_${vid//-/}"
    echo "$dev"
}
vol_detach() { # vol_detach <img>
    local d; for d in $(losetup -j "$1" | cut -d: -f1); do losetup -d "$d"; done
    local i; for i in $(seq 1 50); do [ -z "$(losetup -j "$1")" ] && return 0; sleep 0.1; done; return 1
}

# ------------------------------------------------------------------ stubs
pki() {
    [ -f "$T/pki/server.pem" ] && return 0
    mkdir -p "$T/pki"
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/pki/ca.key" -out "$T/pki/ca.pem" -days 2 -subj "/CN=ezil-test-ca" 2>/dev/null
    openssl req -newkey rsa:2048 -nodes -keyout "$T/pki/server.key" -out "$T/pki/server.csr" -subj "/CN=app.ezil.test" 2>/dev/null
    printf 'subjectAltName=DNS:app.ezil.test\n' > "$T/pki/ext"
    openssl x509 -req -in "$T/pki/server.csr" -CA "$T/pki/ca.pem" -CAkey "$T/pki/ca.key" -CAcreateserial \
        -out "$T/pki/server.pem" -days 2 -extfile "$T/pki/ext" 2>/dev/null
}
nonce_new() { head -c 33 /dev/urandom | base64 | tr '+/' '-_' | tr -d '='; }
# userdata <host> <generation> <epoch> <provision:true|false> [rebase-json]
userdata() {
    local h="$1" g="$2" e="$3" p="$4" rb="${5:-null}" H="$T/hosts/$1" n; n="$(nonce_new)"
    jq -nc --arg c "$CID_COMPUTER" --arg v "$VOL_ID" --arg u "$FS_UUID" --argjson g "$g" --argjson e "$e" \
        --argjson p "$p" --arg n "$n" --argjson rb "$rb" \
        '{v:1, computerId:$c, volumeId:$v, fsUuid:$u, generation:$g, leaseEpoch:$e, nonce:$n, provision:$p}
         + (if $rb == null then {} else {rebase:$rb} end)' > "$H/stub/user-data"
    printf '%s' "$n" > "$H/stub/nonce"
    jq -nc --arg c "$CID_COMPUTER" --argjson g "$g" --argjson e "$e" '{computerId:$c, generation:$g, leaseEpoch:$e}' > "$H/stub/expect.json"
    jq -nc --arg t "tunnel-token-$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" --arg k "$(head -c 32 /dev/urandom | base64)" \
        '{tunnelToken:$t, controlKey:$k, sandboxId:"guac-a-b", zone:"preview.example.org"}' > "$H/stub/issue.json"
    printf '{"instanceId":"i-0abc","availabilityZone":"ap-south-1a","region":"ap-south-1","accountId":"000000000000"}' > "$H/stub/identity.json"
    printf 'MIAGCSqGSIb3DQEHAqCAMIACAQExDzANBglghkgBZQMEAgEFADCABgkqhkiG9w0BBwGggCSABIIB' > "$H/stub/pkcs7"
}
stubs_up() { # stubs_up <host>
    local H="$T/hosts/$1"; pki
    python3 "$HA/test/stub_servers.py" imds "$H/stub/imds.sock" "$H/stub" & echo $! > "$H/stub/imds.pid"
    python3 "$HA/test/stub_servers.py" app "$H/stub/app.sock" "$H/stub" "$T/pki/server.pem" "$T/pki/server.key" & echo $! > "$H/stub/app.pid"
    local i; for i in $(seq 1 50); do [ -S "$H/stub/imds.sock" ] && [ -S "$H/stub/app.sock" ] && return 0; sleep 0.1; done
}
stubs_down() { local H="$T/hosts/$1" p; for p in imds app; do [ -f "$H/stub/$p.pid" ] && kill "$(cat "$H/stub/$p.pid")" 2>/dev/null; rm -f "$H/stub/$p.pid"; done; }

apparmor_up() {
    sed "s/^profile ezil-desktop /profile ${AA_PROFILE} /; s/peer=ezil-desktop/peer=${AA_PROFILE}/g" \
        "$HA/security/apparmor-ezil-desktop" > "$T/apparmor-profile"
    apparmor_parser -r -W "$T/apparmor-profile"
}
apparmor_down() { [ -f "$T/apparmor-profile" ] && apparmor_parser -R "$T/apparmor-profile" 2>/dev/null; true; }

host_down() { # stop everything a host started; leaves its volume image
    local h="$1" H="$T/hosts/$1"
    [ -f "$H/run/cf.pid" ] && kill "$(cat "$H/run/cf.pid")" 2>/dev/null
    [ -f "$H/run/agent.pid" ] && kill "$(cat "$H/run/agent.pid")" 2>/dev/null
    agent "$h" teardown --kill >/dev/null 2>&1
    stubs_down "$h"
}
