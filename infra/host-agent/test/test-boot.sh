#!/usr/bin/env bash
# Full chain on this host with the REAL desktop image under the production agent:
#   host A: provision boot (lease -> guard -> clean -> overlay -> desktop) -> hardening
#   checks -> user state -> enroll -> cloudflared -> agent: presence keeps it up, a held
#   dpkg lock blocks the idle stop, then idle -> flush -> ordered unmount -> shutdown;
#   host B (fresh root volume: fresh lower, nothing else kept): same volume, next epoch
#   -> everything the user did is there.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"
IMG="$(vol_new boot 6G)"
cleanup() { host_down a; host_down b; vol_detach "$IMG"; apparmor_down; }
trap cleanup EXIT
export -f ctr_sh runc_h; export TAG T
apparmor_up || { fail "AppArmor profile load"; summary boot; exit 1; }

patch_lower() { # the image rebuilt from this branch: apply the start-neko.sh change to the lower
    python3 - "$1/usr/local/bin/start-neko.sh" "$HA/../../worker/scripts/start-neko.sh" <<'EOF'
import sys
img, repo = open(sys.argv[1]).read(), open(sys.argv[2]).read()
old = 'rm -rf "$CHROME_PROFILE_DIR" 2>/dev/null || true\n'
start = repo.index('if [ "${EZIL_PERSISTENT_PROFILES:-0}" = 1 ]; then')
end = repo.index('fi\n', start) + 3
assert img.count(old) == 1
open(sys.argv[1], 'w').write(img.replace(old, repo[start:end]))
EOF
}
wait_ready() { # wait_ready <host>: start-neko's gate line, read inside the container (tmpfs /tmp)
    local i; for i in $(seq 1 180); do
        ctr_sh "$1" 'grep -qE "starting neko on|did not become ready" /tmp/neko.log' 2>/dev/null && break; sleep 1; done
    ctr_sh "$1" 'grep -q "starting neko on" /tmp/neko.log' 2>/dev/null
}
has_proc() { ctr_sh "$1" "ps -eo args --no-headers | grep -E -q -- '$2'"; }
FIX_PATHS="/usr/local/bin/ezil-i4-tool /usr/bin/ezil-i4-hello /usr/lib/ezil-i4 /var/lib/ezil-i4-svc /etc/ezil-i4.conf /etc/environment /var/lib/dpkg/info/ezil-i4-pkg.list /workspace/proj /root/.ezil-i4-home"
manifest() { ctr_sh "$1" "for p in $FIX_PATHS; do if [ -d \$p ]; then find \$p -type f -print0 | sort -z | xargs -0 -r sha256sum; elif [ -e \$p ]; then sha256sum \$p; else echo MISSING \$p; fi; done"; }

# ================================================================ host A
H="$(host_new a)"; t0=$(date +%s); extract_lower "$H/lowers/$DHEX"; patch_lower "$H/lowers/$DHEX"
log "host A lower extracted in $(( $(date +%s) - t0 )) s ($(du -sh "$H/lowers/$DHEX" | cut -f1))"
DEV="$(vol_attach a "$IMG")"; stubs_up a; userdata a 1 1 true
out="$(agent a boot-chain desktop 2>&1)"; echo "$out" | sed 's/^/[i4] boot: /' >&2
check "boot order: lease -> guard -> clean -> overlay -> desktop" bash -c "[ \"\$(grep -o '^\[[a-z]*\]' <<<'$out' | tr -d '[]' | tr '\n' ' ')\" = 'lease guard clean overlay desktop ' ]"
check "desktop reached start-neko's readiness gate (all mandatory apps)" wait_ready a
for p in Xvfb openbox 'neko +serve|/neko ' 'chrome.*--user-data-dir=/var/lib/ezil-profiles/chrome' code-server; do
    check "process running: $p" has_proc a "$p"
done
D="$H/srv/ezil-data"
check "upper's filesystem source == the data volume's device" test "$(findmnt -n -o SOURCE -T "$D/root/upper")" = "$DEV"
check "merged overlay is nodev (§3a.7)" bash -c "findmnt -n -o OPTIONS '$H/run/rootfs' | tr , '\n' | grep -qx nodev"
check "data volume nosuid,nodev; profiles bind noexec" bash -c "findmnt -n -o OPTIONS '$D' | grep -q nosuid,nodev && ctr_sh a 'grep \" /var/lib/ezil-profiles \" /proc/mounts | grep -q noexec'"
check "seccomp filter active, defaultAction ERRNO (allowlist mechanism)" bash -c "ctr_sh a 'grep -q \"^Seccomp:[[:space:]]*2\" /proc/self/status' && jq -e '.defaultAction==\"SCMP_ACT_ERRNO\"' '$HA/security/seccomp.json'"
check "no_new_privs set" ctr_sh a 'grep -q "^NoNewPrivs:[[:space:]]*1" /proc/self/status'
check "desktop runs WITHOUT CAP_NET_RAW (CapEff bit 13 clear)" ctr_sh a 'c=$((16#$(awk "/^CapEff/{print \$2}" /proc/self/status))); [ $((c & 0x2000)) -eq 0 ]'
check "AppArmor: dedicated profile enforced" ctr_sh a "grep -q '${AA_PROFILE} (enforce)' /proc/self/attr/current"
check "nested user namespace refused" ctr_sh a '! unshare -U true'
check "mount refused" ctr_sh a '! mount -t tmpfs none /mnt'
check "/tmp and /run are tmpfs; hosts/hostname/resolv read-only" ctr_sh a 'grep -q " /tmp tmpfs " /proc/mounts && grep -q " /run tmpfs " /proc/mounts && ! sh -c "echo x >> /etc/hosts" 2>/dev/null && ! sh -c "echo x >> /etc/resolv.conf" 2>/dev/null'
check "pids limit applied" ctr_sh a '[ "$(cat /sys/fs/cgroup/pids.max)" = 4096 ]'
check "only loopback; IMDS unreachable from the container" ctr_sh a '[ "$(ls /sys/class/net)" = lo ] && ! timeout 3 bash -c "echo > /dev/tcp/169.254.169.254/80" 2>/dev/null'
check "hostname carries generation and epoch" ctr_sh a '[ "$(hostname)" = ezil-gen-1-e1 ]'
check "Chrome profile on the data volume (Local State)" test -e "$D/profiles/chrome/Local State"

# user state, written inside the container
ctr_sh a '
set -e
cp /usr/bin/true /usr/local/bin/ezil-i4-tool
B=/root/b/ezil-i4-pkg; mkdir -p $B/DEBIAN $B/usr/bin $B/usr/lib/ezil-i4 $B/etc
printf "Package: ezil-i4-pkg\nVersion: 1.0\nArchitecture: all\nMaintainer: t <t@invalid>\nDescription: i4\n" > $B/DEBIAN/control
echo /etc/ezil-i4.conf > $B/DEBIAN/conffiles
printf "#!/bin/sh\nmkdir -p /var/lib/ezil-i4-svc; head -c 1048576 /dev/urandom > /var/lib/ezil-i4-svc/data; chown 65534:65534 /var/lib/ezil-i4-svc/data\n" > $B/DEBIAN/postinst; chmod 755 $B/DEBIAN/postinst
printf "#!/bin/sh\necho hello-i4\n" > $B/usr/bin/ezil-i4-hello; chmod 755 $B/usr/bin/ezil-i4-hello
head -c 65536 /dev/urandom > $B/usr/lib/ezil-i4/lib.so; echo v1 > $B/etc/ezil-i4.conf
dpkg-deb --build $B /root/b/p.deb >/dev/null; dpkg -i /root/b/p.deb >/dev/null; rm -rf /root/b
echo user-edit > /etc/ezil-i4.conf; echo EZIL_I4=1 >> /etc/environment
mkdir -p /workspace/proj && head -c 262144 /dev/urandom > /workspace/proj/data && echo i4-home > /root/.ezil-i4-home
rm -f /usr/share/doc/bash/copyright
echo sentinel > /var/lib/ezil-profiles/chrome/EZIL_SENTINEL
mkdir -p /var/lib/ezil-profiles/code-server-extensions/ezil.i4-ext-1.0.0 && echo "{}" > /var/lib/ezil-profiles/code-server-extensions/ezil.i4-ext-1.0.0/package.json
sync' && pass "user state written inside the container (dpkg -i, /usr/local, /etc, /var/lib, whiteout, profiles)" || fail "user state"
manifest a > "$T/ref.manifest"
check "reference manifest complete" bash -c "! grep -q MISSING '$T/ref.manifest'"
check "profile sentinel survives a persistent-profile boot (start-neko change in effect)" test -e "$D/profiles/chrome/EZIL_SENTINEL"

# enroll, tunnel, agent
check "enroll" agent a enroll
env "$(host_env a)" "$AGENT" cloudflared > "$H/run/cf.out" 2>&1 & echo $! > "$H/run/cf.pid"
for i in $(seq 1 20); do grep -q '^start' "$H/stub/cf.log" 2>/dev/null && break; sleep 0.25; done
check "cloudflared running with the per-epoch token" grep -q 'token_env=yes' "$H/stub/cf.log"
TOKEN="$(jq -r .tunnelToken "$H/stub/issue.json")"
check "token not visible inside the container (/proc/*/environ, /tmp, /run, /root)" ctr_sh a "! grep -rqs -- '$TOKEN' /tmp /run /root /etc /proc/[0-9]*/environ"
check "token not on the data volume" bash -c "! grep -rqs -- '$TOKEN' '$D'"
env "$(host_env a)" "$AGENT" agent > "$H/run/agent.out" 2>&1 & echo $! > "$H/run/agent.pid"
for i in $(seq 1 40); do [ -S "$H/run/control.sock" ] && break; sleep 0.1; done
presence() { python3 "$HA/test/ctl.py" "$H" '{"op":"presence","leaseEpoch":1}' >/dev/null; }
for i in $(seq 1 6); do presence; sleep 1; done
check "presence within the inactivity window keeps the computer up" bash -c "[ ! -e '$H/run/shutdown-called' ] && runc --root '$H/run/runc' state ${TAG}-a | jq -e '.status==\"running\"'"
# apt/dpkg take POSIX (fcntl) locks: hold one the same way for 12 s
runc_h a exec -d "${TAG}-a" python3 -c "import fcntl,time; f=open('/var/lib/dpkg/lock-frontend','w'); fcntl.lockf(f, fcntl.LOCK_EX); time.sleep(12)"
sleep 7
check "a held dpkg lock (install in progress) blocks the idle stop: flush=busy" bash -c "grep -q 'idle stop blocked: flush=busy' '$H/run/agent.out' && [ ! -e '$H/run/shutdown-called' ]"
for i in $(seq 1 90); do [ -e "$H/run/shutdown-called" ] && break; sleep 0.5; done
check "idle (no presence, low load, flush ok) -> shutdown -h called" test -e "$H/run/shutdown-called"
check "everything unmounted BEFORE shutdown (overlay, data volume)" test "$(sed -n 2p "$H/run/shutdown-called")" = 0
for i in $(seq 1 40); do kill -0 "$(cat "$H/run/cf.pid")" 2>/dev/null || break; sleep 0.25; done
check "shutdown fenced cloudflared and wiped the token" bash -c "! kill -0 $(cat "$H/run/cf.pid") 2>/dev/null && [ ! -e '$H/state/tunnel.json' ]"
check "agent log: idle stop" grep -q 'shutdown: idle' "$H/run/agent.out"
check "the agent never renewed the lease (no outbound request after enrollment)" test "$(wc -l < "$H/stub/enroll-requests.jsonl")" = 1

# ================================================================ host B
cp "$H/run/agent.out" "$T/agent-a.out" 2>/dev/null
host_down a; vol_detach "$IMG"
if findmnt -rn -o TARGET | grep -q "^$T/hosts/a/"; then fail "host A still has mounts after teardown; aborting before deleting its root"; summary boot; exit 1; fi
rm -rf "$T/hosts/a"                       # the whole disposable root volume is gone
H="$(host_new b)"; extract_lower "$H/lowers/$DHEX"; patch_lower "$H/lowers/$DHEX"
DEV="$(vol_attach b "$IMG")"; stubs_up b; userdata b 1 2 false
out="$(agent b boot-chain desktop 2>&1)"; echo "$out" | sed 's/^/[i4] boot B: /' >&2
check "[host B] boot chain completed on the same volume, epoch 2" bash -c "grep -q '^\[desktop\] desktop started' <<<'$out'"
check "[host B] host-clean removed the stale Chrome Singleton* (after the guard)" bash -c "grep -q '\[clean\]' <<<'$out' && grep '\[clean\]' <<<'$out' | grep -q SingletonLock"
check "[host B] desktop ready" wait_ready b
D="$H/srv/ezil-data"
check "[host B] upper source == the (re-attached) data device" test "$(findmnt -n -o SOURCE -T "$D/root/upper")" = "$DEV"
manifest b > "$T/b.manifest"
if diff -q "$T/ref.manifest" "$T/b.manifest" >/dev/null; then pass "[host B] sha256 manifest of $(wc -l < "$T/ref.manifest") user files identical"; else fail "[host B] manifest differs: $(diff "$T/ref.manifest" "$T/b.manifest" | head -n 4 | tr '\n' ' ')"; fi
check "[host B] dpkg: package installed, binary runs" ctr_sh b '[ "$(dpkg-query -W -f="\${Status}" ezil-i4-pkg)" = "install ok installed" ] && [ "$(ezil-i4-hello)" = hello-i4 ]'
check "[host B] /var/lib service data owner kept" ctr_sh b '[ "$(stat -c %u /var/lib/ezil-i4-svc/data)" = 65534 ]'
check "[host B] deleted image file stays deleted" ctr_sh b '[ ! -e /usr/share/doc/bash/copyright ]'
check "[host B] profile sentinel + extension entry persisted" bash -c "[ -e '$D/profiles/chrome/EZIL_SENTINEL' ] && [ -e '$D/profiles/code-server-extensions/ezil.i4-ext-1.0.0/package.json' ]"
check "[host B] Chrome running on the persisted profile" has_proc b 'chrome.*--user-data-dir=/var/lib/ezil-profiles/chrome'
check "[host B] marker generation 1, epoch 2" jq -e '.generation==1 and .leaseEpoch==2' "$D/.ezil-marker.json"
check "[host B] hostname ezil-gen-1-e2" ctr_sh b '[ "$(hostname)" = ezil-gen-1-e2 ]'
summary "full chain (real desktop, host swap)"
