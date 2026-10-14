#!/usr/bin/env bash
# Streamed-desktop WebRTC relay (iceMode relay, worker/src/aws-ice.ts) with the REAL desktop
# image under the production agent, on the relay boot order (desktop LAST):
#   relay applied: the desktop step finds the stored per-epoch config, the REAL neko starts
#   with Cloudflare's ICE env (TURN-only backend, ICE-lite off, NAT1TO1 = container address)
#   and the DERIVED neko credentials; the derived admin logs in to neko's own admin API, and
#   /api/relay reports the pushed expiry and renews it IN PLACE (the Worker's renewal path).
#   Credentials: in neko's env, never in any argv, the step output or on the data volume.
#   relay missing: no config within iceWaitSeconds -> the desktop starts anyway, ice_missing.
# No network: the container has loopback only and the TURN servers are fake (no peer
# connects, so neko never dials them). Real media needs a live canary.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"
IMG="$(vol_new relay 6G)"
cleanup() { host_down r; vol_detach "$IMG"; apparmor_down; }
trap cleanup EXIT
export -f ctr_sh runc_h; export TAG T
apparmor_up || { fail "AppArmor profile load"; summary relay; exit 1; }

TURN_USER="ezil-turn-user-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
TURN_PASS="ezil-turn-pass-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
NEKO_USER="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
NEKO_ADMIN="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"

H="$(host_new r "$(shared_lower)")"
jq '.iceMode = "relay" | .iceWaitSeconds = 4' "$H/etc/agent.json" > "$H/etc/agent.json.n" && mv "$H/etc/agent.json.n" "$H/etc/agent.json"
DEV="$(vol_attach r "$IMG")"; stubs_up r; userdata r 1 1 true
out="$(agent r boot-chain overlay 2>&1)"; echo "$out" | sed 's/^/[relay] boot: /' >&2
check "relay boot order puts the desktop last (lease guard clean overlay enroll desktop)" bash -c "
PYTHONPATH='$HA/lib' python3 -c 'from ezil_host import cli, config; c=config.load(\"$H/etc/agent.json\"); assert cli.boot_order(c)==[\"lease\",\"guard\",\"clean\",\"overlay\",\"enroll\",\"desktop\"]'"

# The agent's `ice` op stores exactly this (validated) in runDir; the edge/agent socket path
# is covered by test_edge. Here: what the desktop step and the REAL neko do with it.
store_config() {
    EZIL_HOST_CONFIG="$H/etc/agent.json" PYTHONPATH="$HA/lib" python3 - "$TURN_USER" "$TURN_PASS" "$NEKO_USER" "$NEKO_ADMIN" <<'PY'
import os, sys, time
from ezil_host import config, desktop
u, p, nu, na = sys.argv[1:5]
cfg = config.load(os.environ["EZIL_HOST_CONFIG"])
now = int(time.time() * 1000)
c = {"v": 1, "expiresAt": now + 1_200_000,
     "frontend": [{"urls": ["stun:stun.cloudflare.com:3478"]},
                  {"urls": ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], "username": u, "credential": p}],
     "backend": [{"urls": ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], "username": u, "credential": p}],
     "neko": {"user": nu, "admin": na}}
desktop.write_desktop_config(cfg, desktop.validate_desktop_config(c, now))
print(c["expiresAt"])
PY
}
EXP="$(store_config)"
step_out="$(agent r desktop --detach 2>&1)"; echo "$step_out" | sed 's/^/[relay] desktop: /' >&2
check "desktop step: relay applied, desktop started" bash -c "grep -q '^\[desktop\] relay applied' <<<'$step_out' && grep -q 'desktop started' <<<'$step_out'"
serving() { local i; for i in $(seq 1 180); do ctr_sh r 'grep -qE "neko is serving on|did not become ready" /tmp/neko.log' 2>/dev/null && break; sleep 1; done
    ctr_sh r 'grep -q "neko is serving on" /tmp/neko.log' 2>/dev/null; }
check "the REAL neko is serving with the relay env" serving
check "start-neko saw the TURN relay (credentials redacted in its log)" ctr_sh r "grep -q 'ICE: TURN relay configured via NEKO_WEBRTC_ICESERVERS_' /tmp/neko.log"
NEKO_PID="$(ctr_sh r "ps -eo pid,args --no-headers | awk '/[n]eko serve/ {print \$1; exit}'" 2>/dev/null | tr -d ' \r')"
NENV="$(ctr_sh r "tr '\\0' '\\n' < /proc/$NEKO_PID/environ" 2>/dev/null)"
check "neko env: ICE-lite off, trickle on, NAT1TO1 = container address, initial relay expiry" bash -c "
grep -qx 'NEKO_WEBRTC_ICELITE=false' <<<'$NENV' && grep -qx 'NEKO_WEBRTC_ICETRICKLE=true' <<<'$NENV' &&
grep -qx 'NEKO_WEBRTC_NAT1TO1=10.200.0.2' <<<'$NENV' && grep -qx 'EZIL_RELAY_EXPIRES_AT=$EXP' <<<'$NENV' &&
! grep -q 'NEKO_WEBRTC_NAT1TO1=127.0.0.1' <<<'$NENV'"
check "neko env: backend ICE servers are TURN-only (no STUN: no server-reflexive gathering)" python3 -c "
import json,sys
env=dict(l.split('=',1) for l in sys.stdin.read().splitlines() if '=' in l)
b=json.loads(env['NEKO_WEBRTC_ICESERVERS_BACKEND']); f=json.loads(env['NEKO_WEBRTC_ICESERVERS_FRONTEND'])
assert all(u.startswith(('turn:','turns:')) for s in b for u in s['urls']) and any(u.startswith('turns:') for s in f for u in s['urls'])
" <<<"$NENV"
check "neko runs with the DERIVED credentials, not per-boot random ones" bash -c "grep -qx 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=$NEKO_ADMIN' <<<'$NENV' && grep -qx 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD=$NEKO_USER' <<<'$NENV'"

# neko's own admin API, from inside the container (exactly what the Worker reaches via /__p/8181)
api() { ctr_sh r "$1" 2>/dev/null; }
TOKEN="$(api "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"username\":\"ezil-relay-refresh\",\"password\":\"$NEKO_ADMIN\"}' http://127.0.0.1:8181/api/login" | jq -r '.token // empty')"
check "the derived admin logs in to the REAL neko admin API" test -n "$TOKEN"
# /api/relay is EZiL's neko patch (#186, worker/neko/relay.go). An image whose neko lacks it
# (the pinned upstream build) cannot renew in place: say so, never pass silently.
RELAY_HTTP="$(api "curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer $TOKEN' http://127.0.0.1:8181/api/relay")"
if [ "$RELAY_HTTP" = 404 ]; then
    log "SKIP /api/relay checks: this image's neko has no relay route (built without worker/neko/relay.go, #186)"
    SKIPPED="relay-route"
else
    RELAY="$(api "curl -fsS -H 'Authorization: Bearer $TOKEN' http://127.0.0.1:8181/api/relay")"
    check "GET /api/relay: a runtime id and the pushed expiry" bash -c "jq -e '.runtimeId|test(\"^[a-f0-9]{32}\$\")' <<<'$RELAY' >/dev/null && jq -e --argjson x $EXP '.expiresAt==\$x' <<<'$RELAY' >/dev/null"
    RID="$(jq -r .runtimeId <<<"$RELAY")"; NEW_EXP=$(( $(date +%s%3N) + 1500000 ))
    BODY="$(jq -nc --arg r "$RID" --argjson e "$NEW_EXP" --arg u "$TURN_USER" --arg p "$TURN_PASS" \
      '{runtimeId:$r, expiresAt:$e, frontend:[{urls:["turns:turn.cloudflare.com:443?transport=tcp"],username:$u,credential:$p}],
        backend:[{urls:["turns:turn.cloudflare.com:443?transport=tcp"],username:$u,credential:$p}]}')"
    RENEW="$(api "curl -fsS -X POST -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '$BODY' http://127.0.0.1:8181/api/relay")"
    check "POST /api/relay renews IN PLACE on the real neko (same runtime, new expiry)" bash -c "jq -e --arg r '$RID' --argjson e $NEW_EXP '.runtimeId==\$r and .expiresAt==\$e' <<<'$RENEW' >/dev/null"
    UT="$(api "curl -fsS -X POST -H 'Content-Type: application/json' -d '{\"username\":\"u\",\"password\":\"$NEKO_USER\"}' http://127.0.0.1:8181/api/login" | jq -r '.token // empty')"
    check "a non-admin (the derived user) cannot touch /api/relay" bash -c "[ -n '$UT' ] && ! ctr_sh r \"curl -fsS -H 'Authorization: Bearer $UT' http://127.0.0.1:8181/api/relay\""
fi
# where the credentials are NOT (patterns are bracketed so a check never matches its own argv)
pat() { printf '%s[%s]%s' "${1:0:1}" "${1:1:1}" "${1:2}"; }
PT="$(pat "$TURN_PASS")"; PN="$(pat "$NEKO_ADMIN")"
check "(control) the patterns DO find both values where they legitimately are: the runDir bundle" bash -c "grep -qsa -e '$PT' '$H/run/bundle/config.json' && grep -qsa -e '$PN' '$H/run/bundle/config.json'"
check "no TURN credential or neko value in any container process argv" ctr_sh r "! grep -qsa -e '$PT' -e '$PN' /proc/[0-9]*/cmdline"
check "no TURN credential or neko value in any host process argv" bash -c "! grep -qsa -e '$PT' -e '$PN' /proc/[0-9]*/cmdline"
check "no TURN credential or neko value on the data volume" bash -c "! grep -rqsa -e '$PT' -e '$PN' '$H/srv/ezil-data'"
check "no TURN credential or neko value in the step output" bash -c "! grep -q -e '$TURN_PASS' -e '$NEKO_ADMIN' <<<'$out$step_out'"
check "the stored config is 0600 in runDir" bash -c "[ \"\$(stat -c %a '$H/run/desktop-config.json')\" = 600 ]"

# relay missing: no config within iceWaitSeconds -> the desktop starts anyway, ice_missing
agent r desktop-stop >/dev/null 2>&1
rm -f "$H/run/desktop-config.json"
t0=$(date +%s); miss_out="$(agent r desktop --detach 2>&1)"; waited=$(( $(date +%s) - t0 ))
echo "$miss_out" | sed 's/^/[relay] missing: /' >&2
check "no config: bounded wait (iceWaitSeconds=4), then started anyway with ice_missing" bash -c "
grep -q 'relay missing (ice_missing)' <<<'$miss_out' && grep -q 'desktop started' <<<'$miss_out' && [ $waited -ge 4 ] && [ $waited -lt 30 ]"
check "the agent's status source says missing (the next push restarts it)" bash -c "jq -e '.ice==\"missing\"' '$H/run/desktop-ice.json'"
[ -n "${SKIPPED:-}" ] && log "skipped: ${SKIPPED}"
summary "desktop WebRTC relay (real neko)"
