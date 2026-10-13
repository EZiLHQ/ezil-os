#!/usr/bin/env bash
# Mutation proof for the key guards. Each mutation is applied to a THROWAWAY COPY of
# infra/host-agent (never the worktree), the named test runs from that copy, and the
# mutation counts as KILLED only if the specific check named here goes FAIL.
# usage: mutate.sh [--quick]   (--quick skips the ~4 min full-chain mutation)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; HA="$(cd "$HERE/.." && pwd)"
T=/var/tmp/ezil-host-fb25d9f4; M="$T/mut-ha"; REPO="$(git -C "$HA" rev-parse --show-toplevel)"
KILLED=0; SURVIVED=0
mutate() { # mutate <id> <file> <old> <new> <test> <expected FAIL substring>
    local id="$1" file="$2" old="$3" new="$4" test="$5" want="$6"
    if [ -n "${MUT_ONLY:-}" ] && [[ " $MUT_ONLY " != *" $id "* ]]; then return; fi
    rm -rf "$M"; cp -a "$HA" "$M"; find "$M" -name __pycache__ -prune -exec rm -rf {} \; 2>/dev/null
    python3 - "$M/$file" "$old" "$new" <<'PY' || { echo "ERROR $id: anchor not found exactly once"; SURVIVED=$((SURVIVED+1)); return; }
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
if s.count(old) != 1: sys.exit(1)
open(p, "w").write(s.replace(old, new))
PY
    # a mutated guard can let a long-running step start: bound every run, then clean up
    local out; out="$(EZIL_HOST_REPO="$REPO" timeout -k 10 900 "$M/test/$test" 2>&1)"
    "$HERE/cleanup.sh" --keep-scratch >/dev/null 2>&1
    if grep -F "FAIL" <<<"$out" | grep -qF -- "$want"; then
        KILLED=$((KILLED+1)); printf 'KILLED    %-4s %-55s by %s: "%s"\n' "$id" "$(cut -c1-55 <<<"$4")" "$test" "$want"
    else
        SURVIVED=$((SURVIVED+1)); printf 'SURVIVED  %-4s %s (%s)\n' "$id" "$test" "$(grep -c '^FAIL' <<<"$out") FAIL lines"
    fi
}
mutate M1 lib/ezil_host/guard.py 'if m["leaseEpoch"] >= lease["leaseEpoch"]:' 'if False:' test-guard.sh "same epoch replayed"
mutate M2 lib/ezil_host/guard.py 'if uuid != lease["fsUuid"]:' 'if False:' test-guard.sh "device fs UUID != lease even when the marker agrees"
mutate M3 lib/ezil_host/guard.py 'if m["generation"] > lease["generation"]:' 'if False:' test-guard.sh "writer generation above the lease"
mutate M4 lib/ezil_host/guard.py 'if rebase_runner is None or not lease.get("rebase"):' 'if False:' test-guard.sh "lowerImageDigest mismatch, no receipt"
mutate M5 lib/ezil_host/guard.py 'raise Refused("guard_not_passed")' 'return' test-guard.sh "refuses without a guard stamp"
mutate M6 lib/ezil_host/fsops.py '        os.write(fd, data)
        os.fsync(fd)' '        os.write(fd, data)' test-guard.sh "marker write order"
mutate M7 lib/ezil_host/fsops.py 'DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC' 'DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC' test-hostile.sh "singleton cleanup: profiles/chrome -> host dir"
mutate M8 lib/ezil_host/rebase.py 'if not on("P"):' 'if True:' test-rebase.sh "colliding /usr/local and /opt user files moved aside intact"
mutate M9 lib/ezil_host/rebase.py 'body = read_regular_at(dfd, name, st) if stat.S_ISREG(st.st_mode) else None' 'body = open(os.path.join("/proc/self/fd", str(dfd), name), "rb").read() if not stat.S_ISDIR(st.st_mode) else None' test-hostile.sh "rebase: dpkg/status = FIFO"
mutate M10 lib/ezil_host/rebase.py 'raise RuntimeError("injected rebase fault (EZIL_REBASE_FAULT_AFTER)")' 'pass' test-rebase.sh "rebase fault after 5 entries"
mutate M11 lib/ezil_host/desktop.py '"nodev,lowerdir=' '"lowerdir=' test-hostile.sh "production overlay_mount passes nodev"
mutate M12 lib/ezil_host/tunnel.py 'wiped = wipe(tok_path)' 'wiped = False' test-enroll-tunnel.sh "fence: local token wiped"
mutate M13 lib/ezil_host/enroll.py '    wipe_nonce(cfg, lease)
    if status != 200:' '    if status != 200:' test-enroll-tunnel.sh "nonce is wiped from local state"
mutate M14 lib/ezil_host/agent.py 'if not isinstance(mac, str) or not hmac.compare_digest(mac, sign(self.key, msg)):' 'if False:' test-enroll-tunnel.sh "bad MAC refused"
mutate M15 lib/ezil_host/agent.py 'if msg.get("leaseEpoch") != self.lease["leaseEpoch"]:' 'if False:' test-enroll-tunnel.sh "wrong epoch refused"
mutate M16 systemd/ezil-host-clean.service 'Requires=ezil-guard.service' 'Wants=ezil-guard.service' test-units.sh "ezil-host-clean: Requires=ezil-guard.service"
mutate M19 lib/ezil_host/cli.py '            guard.clear_stamp(cfg)            # nothing may start on this host until the guard runs again' '            pass' test-guard.sh "after data-down, 'overlay' refuses"
mutate M20 lib/ezil_host/guard.py '    assert_data_mounted(cfg, lease)
' '' test-guard.sh "volume unmounted behind the agent's back: 'overlay' refuses"
mutate M21 lib/ezil_host/guard.py '    if os.path.realpath(usrc) != dev:' '    if False:' test-guard.sh "upper redirected onto the host disk"
mutate M22 lib/ezil_host/agent.py 'if not _is_number(ts) or not math.isfinite(ts):' 'if not _is_number(ts):' test-enroll-tunnel.sh "non-finite ts (NaN) refused"
mutate M23 lib/ezil_host/agent.py '            if seq <= self.last_seq:' '            if False:' test-enroll-tunnel.sh "exact replay (same seq) refused"
mutate M24 lib/ezil_host/agent.py '        self.last_seq = self._load_seq()' '        self.last_seq = 0' test-enroll-tunnel.sh "replay refused across an agent restart"
mutate M25 lib/ezil_host/agent.py 'not 0 <= warn <= MAX_WARN' 'False' test-enroll-tunnel.sh "stop with warnSeconds=901 refused"
mutate M26 lib/ezil_host/agent.py 'MAX_FUTURE = 5 ' 'MAX_FUTURE = 120 ' test-enroll-tunnel.sh "ts 60 s in the future refused"
mutate M27 lib/ezil_host/desktop.py 'BLOCKED = ["169.254.0.0/16", ' 'BLOCKED = [' test-network.sh "169.254.10.10 (other link-local) unreachable"
mutate M28 lib/ezil_host/desktop.py '"10.0.0.0/8", "172.16.0.0/12"' '"172.16.0.0/12"' test-network.sh "RFC1918 peer 10.0.0.2 unreachable"
mutate M29 lib/ezil_host/desktop.py '"-p", "udp", "--dport", "53", "-j", "ACCEPT"]' '"-p", "udp", "--dport", "53", "-j", "DROP"]' test-network.sh "DNS works through the host resolver"
mutate M30 lib/ezil_host/desktop.py '        if _chain_ok(cfg, table, chain, rules):
            continue' '' test-network.sh "net-ensure again changes nothing"
mutate M31 lib/ezil_host/desktop.py '           ["-i", HOST_IF, "-j", "DROP"]]' '           ]' test-network.sh "host's own non-DNS port unreachable"
if [ "${1:-}" != --quick ]; then
mutate M17 lib/ezil_host/agent.py '        if blockable and dpkg_lock_held(self.cfg):
            return "busy"' '' test-boot.sh "a held dpkg lock (install in progress) blocks the idle stop"
mutate M18 lib/ezil_host/desktop.py '"noNewPrivileges": True,' '"noNewPrivileges": False,' test-boot.sh "no_new_privs set"
fi
rm -rf "$M"
printf -- '---- mutations: %d KILLED, %d SURVIVED\n' "$KILLED" "$SURVIVED"
[ "$SURVIVED" -eq 0 ]
