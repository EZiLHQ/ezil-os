#!/usr/bin/env bash
# veth-nat EXERCISED without touching the shared machine's networking. A disposable
# network namespace plays the "host" (cfg.hostNetns); peers in their own namespaces play
# the internet (203.0.113.2, TEST-NET-3), an RFC1918 VPC peer (10.0.0.2) and link-local
# metadata (169.254.169.254 and 169.254.10.10). The agent builds the veth pair, NAT and
# rules inside the fake host; a probe container runs in its namespace.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"
FH="${TAG}-fh"; INET="${TAG}-inet"; RFC="${TAG}-rfc"; META="${TAG}-meta"
PIDS=()
real_host_state() { echo "ezh0=$(ip link show ezh0 >/dev/null 2>&1 && echo present || echo absent) ezil_rules=$(iptables-save 2>/dev/null | grep -c 'EZIL-CT') ip_forward=$(sysctl -n net.ipv4.ip_forward) testlinks=$(ip -o link | grep -cE ' (up0|rf0|md0|in0|rf1|md1)[@:]')"; }
BEFORE="$(real_host_state)"
cleanup() {
    for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
    host_down n; vol_detach "$IMG"; apparmor_down
    for ns in "$FH" "$INET" "$RFC" "$META"; do ip netns delete "$ns" 2>/dev/null; done
}
trap cleanup EXIT
for ns in "$FH" "$INET" "$RFC" "$META"; do ip netns add "$ns"; ip -n "$ns" link set lo up; done
# links are created INSIDE the fake host (-n), both ends in test namespaces
ip -n "$FH" link add up0 type veth peer name in0 netns "$INET"
ip -n "$FH" link add rf0 type veth peer name rf1 netns "$RFC"
ip -n "$FH" link add md0 type veth peer name md1 netns "$META"
ip -n "$FH" addr add 203.0.113.1/24 dev up0; ip -n "$INET" addr add 203.0.113.2/24 dev in0
ip -n "$FH" addr add 10.0.0.1/24 dev rf0;     ip -n "$RFC" addr add 10.0.0.2/24 dev rf1
ip -n "$FH" addr add 169.254.0.1/16 dev md0;  ip -n "$META" addr add 169.254.169.254/16 dev md1; ip -n "$META" addr add 169.254.10.10/16 dev md1
for l in "$FH up0" "$INET in0" "$FH rf0" "$RFC rf1" "$FH md0" "$META md1"; do set -- $l; ip -n "$1" link set "$2" up; done
for ns in "$INET" "$RFC" "$META"; do ip netns exec "$ns" python3 "$HA/test/stub_tcp.py" 8080 & PIDS+=($!); done
ip netns exec "$FH" python3 "$HA/test/stub_tcp.py" 9999 & PIDS+=($!)
ip netns exec "$FH" python3 "$HA/test/stub_dns.py" 203.0.113.2 & PIDS+=($!)
for i in $(seq 1 50); do ip netns exec "$FH" ss -ltn | grep -q ':9999 ' && ip netns exec "$INET" ss -ltn | grep -q ':8080 ' && break; sleep 0.2; done
fh_can() { ip netns exec "$FH" timeout 3 bash -c "echo > /dev/tcp/$1/$2" 2>/dev/null; }
check "(control) the fake host itself reaches the internet peer" fh_can 203.0.113.2 8080
check "(control) the fake host itself reaches the RFC1918 peer" fh_can 10.0.0.2 8080
check "(control) the fake host itself reaches 169.254.169.254" fh_can 169.254.169.254 8080
check "(control) the fake host itself reaches 169.254.10.10" fh_can 169.254.10.10 8080
check "(control) the fake host's own port 9999 is listening" fh_can 127.0.0.1 9999

apparmor_up
H="$(host_new n "$(shared_lower)")"; IMG="$(vol_new n 1G)"; vol_attach n "$IMG" >/dev/null; stubs_up n; userdata n 1 1 true
jq --arg fh "$FH" '.networkMode="veth-nat" | .hostNetns=$fh | .vpcCidr="172.31.0.0/16"' "$H/etc/agent.json" > "$T/n.json" && cp "$T/n.json" "$H/etc/agent.json"
check "(safety) the test config names the disposable host namespace" bash -c "jq -e '.hostNetns==\"$FH\"' '$H/etc/agent.json' && ip netns list | grep -qw '$FH'"
out="$(EZIL_DESKTOP_MODE=probe agent n boot-chain desktop 2>&1)"; echo "$out" | sed 's/^/[i4] /' >&2
check "boot chain with veth-nat completed (probe container)" grep -q '^\[desktop\] desktop started' <<<"$out"
ct_can() { ctr_sh n "timeout 3 bash -c 'echo > /dev/tcp/$1/$2'" 2>/dev/null; }
ct_cannot() { ! ct_can "$@"; }        # a function, not `bash -c "! ..."`: an unexported helper would make the check vacuous
check "container has only lo + ezc0, default route via 10.200.0.1, IPv6 off" ctr_sh n '[ "$(ls /sys/class/net | sort | tr "\n" " ")" = "ezc0 lo " ] && awk '"'"'$2=="00000000" && $3=="0100C80A"{f=1} END{exit !f}'"'"' /proc/net/route && [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6)" = 1 ]'
check "DNS works through the host resolver (resolv.conf -> 10.200.0.1)" ctr_sh n '[ "$(getent ahostsv4 probe.ezil.test | head -n1 | cut -d" " -f1)" = 203.0.113.2 ]'
check "internet peer reachable (NAT out)" ct_can 203.0.113.2 8080
check "169.254.169.254 (instance metadata) unreachable" ct_cannot 169.254.169.254 8080
check "169.254.10.10 (other link-local) unreachable" ct_cannot 169.254.10.10 8080
check "RFC1918 peer 10.0.0.2 unreachable" ct_cannot 10.0.0.2 8080
check "(control) the fake host's port 9999 still listening on 10.200.0.1" fh_can 10.200.0.1 9999
check "host's own non-DNS port unreachable from the container" ct_cannot 10.200.0.1 9999
runc_h n exec -d "${TAG}-n" python3 -c "import socket;s=socket.socket();s.bind(('10.200.0.2',8081));s.listen(4)
while True: c,_=s.accept(); c.close()"
sleep 1
check "host -> container (the tunnel's path) works; replies pass" fh_can 10.200.0.2 8081
# idempotence and drift repair
S1="$(ip netns exec "$FH" iptables-save | grep -vE '^#|^:' )"
check "net-check ok after boot" agent n net-check
check "net-ensure again changes nothing" bash -c "EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-ensure | grep -q 'changed: nothing'"
EZIL_DESKTOP_MODE=probe agent n overlay >/dev/null 2>&1 || true      # whole step re-run (it is idempotent)
S2="$(ip netns exec "$FH" iptables-save | grep -vE '^#|^:' )"
check "re-applying the rules is idempotent (iptables-save identical)" test "$S1" = "$S2"
check "exactly one jump per chain" test "$(grep -c -- '-j EZIL-CT-' <<<"$S2")" = 3
ip netns exec "$FH" iptables -D EZIL-CT-FWD -i ezh0 -d 169.254.0.0/16 -j DROP
check "a deleted rule is detected as drift" bash -c "! EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-check >/dev/null"
check "(drift really opened the hole) metadata reachable while the rule is missing" ct_can 169.254.169.254 8080
check "net-ensure repairs the drift" bash -c "EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-ensure | grep -q 'EZIL-CT-FWD' && EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-check >/dev/null"
check "metadata unreachable again after the repair" ct_cannot 169.254.169.254 8080
check "repaired ruleset identical to the original" test "$(ip netns exec "$FH" iptables-save | grep -vE '^#|^:')" = "$S1"
ip netns exec "$FH" iptables-save > "$T/fh-iptables.txt"
check "the real host's networking was never touched (before == after)" test "$(real_host_state)" = "$BEFORE"
log "real host: $BEFORE"
summary "veth-nat in a disposable host namespace"
