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
ip netns exec "$INET" python3 "$HA/test/stub_tcp.py" 8080 "$T/inet-peers.log" & PIDS+=($!)
for ns in "$RFC" "$META"; do ip netns exec "$ns" python3 "$HA/test/stub_tcp.py" 8080 & PIDS+=($!); done
ip netns exec "$FH" python3 "$HA/test/stub_tcp.py" 9999 - v6 & PIDS+=($!)
# the "internet" routes 10.200.0.0/24 back, so a packet with a spoofed (un-NATed) source
# WOULD get an answer if the host let it out: the anti-spoof check is then not vacuous
ip -n "$INET" route add 192.0.2.7/32 via 203.0.113.1
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
# ---- review round 3: CAP_NET_RAW, IPv6 on the host end, anti-spoof
CTNS="${TAG}-n"
check "container has no CAP_NET_RAW (CapEff bit 13 clear)" ctr_sh n 'c=$((16#$(awk "/^CapEff/{print \$2}" /proc/self/status))); [ $((c & 0x2000)) -eq 0 ]'
check "ezh0: IPv6 disabled and no IPv6 address (not even link-local)" bash -c "[ \"\$(ip netns exec '$FH' sysctl -n net.ipv6.conf.ezh0.disable_ipv6)\" = 1 ] && [ -z \"\$(ip -n '$FH' -6 addr show dev ezh0)\" ]"
src_try() { ctr_sh n "python3 -c \"import socket;s=socket.socket();s.settimeout(3);s.bind(('$1',0));s.connect(('203.0.113.2',8080));print(s.recv(3))\"" >/dev/null 2>&1; }
ip -n "$CTNS" addr add 192.0.2.7/32 dev ezc0           # test-only forged source (the container has no NET_ADMIN)
ip -n "$FH" route add 192.0.2.7/32 dev ezh0             # ... and a return path, so only the anti-spoof rule can stop it
: > "$T/inet-peers.log"
check "(control) the container's own source 10.200.0.2 reaches the internet peer" src_try 10.200.0.2
src_blocked() { ! src_try "$1"; }
check "spoofed source 192.0.2.7 is dropped (no connection)" src_blocked 192.0.2.7
check "the internet peer saw the NATed control and never the spoofed source" bash -c "grep -qx 203.0.113.1 '$T/inet-peers.log' && ! grep -q 192.0.2.7 '$T/inet-peers.log'"
ip -n "$CTNS" addr del 192.0.2.7/32 dev ezc0; ip -n "$FH" route del 192.0.2.7/32 dev ezh0
# belt-and-braces: re-enable IPv6 on BOTH veth ends (test only) and prove ip6tables still drops
ip netns exec "$FH" sysctl -q -w net.ipv6.conf.ezh0.disable_ipv6=0
for k in all default ezc0; do ip netns exec "$CTNS" sysctl -q -w "net.ipv6.conf.$k.disable_ipv6=0"; done
ip -n "$FH" -6 addr add fd00:e21::1/64 dev ezh0 nodad; ip -n "$CTNS" -6 addr add fd00:e21::2/64 dev ezc0 nodad; sleep 1
check "IPv6 re-enabled on ezh0 is reported as drift" bash -c "! EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-check >/dev/null"
check "(control) the host's v6 listener answers locally on [fd00:e21::1]:9999" ip netns exec "$FH" python3 -c "import socket;s=socket.socket(socket.AF_INET6);s.settimeout(3);s.connect(('fd00:e21::1',9999))"
check "(control) the container can send IPv6 to the host at L3 (neighbour resolved)" bash -c "ip netns exec '$CTNS' ping -6 -c1 -W2 fd00:e21::1 >/dev/null 2>&1 || ip -n '$CTNS' -6 neigh show | grep -q fd00:e21::1"
check "v6 to the host on ezh0 unreachable from the container (ip6tables INPUT drop)" bash -c "! ip netns exec '$CTNS' python3 -c \"import socket;s=socket.socket(socket.AF_INET6);s.settimeout(3);s.connect(('fd00:e21::1',9999))\" 2>/dev/null"
check "net-ensure repairs: IPv6 off again on ezh0, addresses gone" bash -c "EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-ensure | grep -q 'ezh0.disable_ipv6' && [ -z \"\$(ip -n '$FH' -6 addr show dev ezh0)\" ] && EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-check >/dev/null"
for k in all default ezc0; do ip netns exec "$CTNS" sysctl -q -w "net.ipv6.conf.$k.disable_ipv6=1"; done

# idempotence and drift repair
S1="$(ip netns exec "$FH" sh -c 'iptables-save; ip6tables-save' | grep -vE '^#|^:' )"
check "net-check ok after boot" agent n net-check
check "net-ensure again changes nothing" bash -c "EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-ensure | grep -q 'changed: nothing'"
EZIL_DESKTOP_MODE=probe agent n overlay >/dev/null 2>&1 || true      # whole step re-run (it is idempotent)
S2="$(ip netns exec "$FH" sh -c 'iptables-save; ip6tables-save' | grep -vE '^#|^:' )"
check "re-applying the rules is idempotent (iptables-save identical)" test "$S1" = "$S2"
check "exactly one jump per chain (3 IPv4 + 2 IPv6)" test "$(grep -c -- '-j EZIL-CT-' <<<"$S2")" = 5
ip netns exec "$FH" iptables -D EZIL-CT-FWD -i ezh0 -d 169.254.0.0/16 -j DROP
check "a deleted rule is detected as drift" bash -c "! EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-check >/dev/null"
check "(drift really opened the hole) metadata reachable while the rule is missing" ct_can 169.254.169.254 8080
check "net-ensure repairs the drift" bash -c "EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-ensure | grep -q 'EZIL-CT-FWD' && EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-check >/dev/null"
check "metadata unreachable again after the repair" ct_cannot 169.254.169.254 8080
check "repaired ruleset identical to the original" test "$(ip netns exec "$FH" sh -c 'iptables-save; ip6tables-save' | grep -vE '^#|^:')" = "$S1"
# same rules, other ORDER: the ACCEPT moved ahead of the drops (count and membership unchanged)
N0="$(ip netns exec "$FH" iptables -S EZIL-CT-FWD | grep -c '^-A')"
ip netns exec "$FH" iptables -D EZIL-CT-FWD -i ezh0 -j ACCEPT
ip netns exec "$FH" iptables -I EZIL-CT-FWD 1 -i ezh0 -j ACCEPT
check "(reorder) same rule count, every desired rule still present" bash -c "[ \"\$(ip netns exec '$FH' iptables -S EZIL-CT-FWD | grep -c '^-A')\" = $N0 ] && ip netns exec '$FH' iptables -C EZIL-CT-FWD -i ezh0 -d 169.254.0.0/16 -j DROP"
check "a reordered chain (ACCEPT ahead of the drops) is detected as drift" bash -c "! EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-check >/dev/null"
check "(reorder really opened the hole) metadata reachable while reordered" ct_can 169.254.169.254 8080
check "net-ensure repairs the reorder" bash -c "EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-ensure | grep -q 'EZIL-CT-FWD' && EZIL_HOST_CONFIG='$H/etc/agent.json' '$AGENT' net-check >/dev/null"
check "metadata unreachable again after the reorder repair" ct_cannot 169.254.169.254 8080
check "no scratch chain left behind by the drift check" bash -c "! ip netns exec '$FH' sh -c 'iptables-save; iptables-save -t nat; ip6tables-save' | grep -qE 'EZIL-CT-[A-Z0-9]+-C'"
check "ruleset identical to the original after the reorder repair" test "$(ip netns exec "$FH" sh -c 'iptables-save; ip6tables-save' | grep -vE '^#|^:')" = "$S1"
ip netns exec "$FH" iptables-save > "$T/fh-iptables.txt"
check "the real host's networking was never touched (before == after)" test "$(real_host_state)" = "$BEFORE"
log "real host: $BEFORE"
summary "veth-nat in a disposable host namespace"
