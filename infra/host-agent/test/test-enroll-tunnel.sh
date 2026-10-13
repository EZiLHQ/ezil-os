#!/usr/bin/env bash
# C-6 enrollment against stub IMDSv2 + stub HTTPS app (unix sockets), host-only token
# storage, nonce wipe, cloudflared supervision and fencing, control-channel auth, and a
# control-plane stop -> ordered unmount -> shutdown (stub). No desktop container.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"
H="$(host_new e "$(shared_lower)")"; IMG="$(vol_new e 1G)"; DEV="$(vol_attach e "$IMG")"
stubs_up e
trap 'host_down e; vol_detach "$IMG"' EXIT
D="$H/srv/ezil-data"

userdata e 1 1 true
check "lease step reads user data + identity via IMDSv2 (token required)" agent e lease
check "lease cache is 0600 on the host run dir" test "$(stat -c %a "$H/run/lease.json")" = 600
agent e guard >/dev/null

# --- refused enrollment: the nonce is still never re-sent
jq '.leaseEpoch=99' "$H/stub/expect.json" > "$T/x" && cp "$T/x" "$H/stub/expect.json"
expect_refuse "app refuses (epoch mismatch) -> enroll_refused" enroll_refused agent e enroll
check "after any HTTP answer the nonce is wiped from local state" jq -e 'has("nonce")|not' "$H/run/lease.json"
expect_refuse "no second attempt with a used nonce" enroll_nonce_absent agent e enroll
check "the app saw exactly one request" test "$(wc -l < "$H/stub/enroll-requests.jsonl")" = 1
check "no token stored after a refusal" test ! -e "$H/state/tunnel.json"
agent e data-down >/dev/null

# --- successful enrollment (new epoch, new nonce)
userdata e 1 2 false; agent e lease >/dev/null; agent e guard >/dev/null; : > "$H/stub/enroll-requests.jsonl"
cp "$H/stub/user-data" "$H/cloud/user-data.txt"      # what cloud-init would have cached
check "enroll succeeds over verified TLS (test CA, SNI app.ezil.test)" agent e enroll
REQ="$(tail -n 1 "$H/stub/enroll-requests.jsonl")"
check "request = {computerId, generation, leaseEpoch, nonce, identityDocument, signature}" \
    jq -e --arg c "$CID_COMPUTER" '(keys == ["computerId","generation","identityDocument","leaseEpoch","nonce","signature"]) and .computerId==$c and .generation==1 and .leaseEpoch==2 and (.identityDocument|fromjson|.instanceId=="i-0abc") and (.signature|startswith("MIAG"))' <<<"$REQ"
TOKEN="$(jq -r .tunnelToken "$H/stub/issue.json")"
check "token stored host-only: state dir 0700, file 0600, bound to (gen 1, epoch 2)" bash -c "[ \$(stat -c %a '$H/state') = 700 ] && [ \$(stat -c %a '$H/state/tunnel.json') = 600 ] && jq -e '.generation==1 and .leaseEpoch==2' '$H/state/tunnel.json'"
check "token appears nowhere on the data volume" bash -c "! grep -rqs -- '$TOKEN' '$D'"
check "cloud-init's cached user-data copy (holds the nonce) wiped" test ! -e "$H/cloud/user-data.txt"
check "nonce wiped from local lease state after use" jq -e '(has("nonce")|not) and .nonceConsumed' "$H/run/lease.json"
tls_probe() { python3 -c "
import sys; sys.path.insert(0, '$HA/lib')
from ezil_host import http
try:
    st, _ = http.request('POST', 'https+unix://$H/stub/app.sock/x', body=b'{}', ca_file='$T/pki/ca.pem', server_name='$1')
    print('answered', st)
except Exception as e:
    print('error', type(e).__name__)"; }
check "TLS verified: right name + test CA gets an HTTP answer" bash -c "[ \"\$(echo '$(tls_probe app.ezil.test)')\" = 'answered 400' ]"
check "TLS verified: a certificate for another name is refused" bash -c "[ \"\$(echo '$(tls_probe evil.example)')\" = 'error SSLCertVerificationError' ]"
# restore epoch-2 lease cache for the rest (the bad-config run rewrote it)
userdata e 1 2 false; agent e lease >/dev/null; jq '.nonceConsumed=true | del(.nonce)' "$H/run/lease.json" > "$T/l" && cp "$T/l" "$H/run/lease.json"
cp "$H/state/tunnel.json" "$T/tunnel.bak"

# --- cloudflared supervision
touch "$H/stub/crash-once"; : > "$H/stub/cf.log"
agent e cloudflared > "$H/run/cf.out" 2>&1 & echo $! > "$H/run/cf.pid"
for i in $(seq 1 40); do [ "$(grep -c '^start' "$H/stub/cf.log")" -ge 2 ] && break; sleep 0.25; done
check "cloudflared restarted after a crash" test "$(grep -c '^start' "$H/stub/cf.log")" -ge 2
check "token passed in the environment, not argv" bash -c "grep -q 'token_env=yes token_in_argv=no' '$H/stub/cf.log' && ! grep -q 'token_env=no' '$H/stub/cf.log'"
check "argv is 'tunnel --no-autoupdate run'" grep -q 'argv=\[tunnel --no-autoupdate run\]' "$H/stub/cf.log"
CHILD="$(cat "$H/stub/cf.child.pid")"
agent_ctl() { # agent_ctl <op-json>  (signs with the stored control key)
    python3 - "$H" "$1" <<'EOF'
import json, os, sys, time
sys.path.insert(0, os.path.join(os.environ["HA"], "lib"))
from ezil_host import agent, config
cfg = config.load(os.path.join(sys.argv[1], "etc/agent.json"))
key = open(os.path.join(cfg.stateDir, "control.key"), "rb").read()
msg = json.loads(sys.argv[2]); msg.setdefault("ts", time.time())
print(json.dumps(agent.client(cfg, key, msg)))
EOF
}
export HA H
export -f agent_ctl
# fence via the file the control channel writes
python3 -c "
import sys,os; sys.path.insert(0,'$HA/lib')
from ezil_host import config, tunnel; tunnel.fence(config.load('$H/etc/agent.json'),'test-epoch-change')"
for i in $(seq 1 40); do kill -0 "$(cat "$H/run/cf.pid")" 2>/dev/null || break; sleep 0.25; done
check "fence: supervisor exited" bash -c "! kill -0 $(cat "$H/run/cf.pid") 2>/dev/null"
check "fence: cloudflared child terminated" bash -c "! kill -0 $CHILD 2>/dev/null"
check "fence: local token wiped" test ! -e "$H/state/tunnel.json"
check "fence: reason recorded" grep -q 'stopped (fence); token wiped=True' "$H/run/cf.out"
rm -f "$H/run/fence"
# token from another epoch is never used
jq '.leaseEpoch=1' "$T/tunnel.bak" > "$H/state/tunnel.json"; chmod 600 "$H/state/tunnel.json"; : > "$H/stub/cf.log"
agent e cloudflared > "$H/run/cf2.out" 2>&1
check "token bound to another epoch: cloudflared never started, token wiped" bash -c "[ ! -s '$H/stub/cf.log' ] && [ ! -e '$H/state/tunnel.json' ] && grep -q token_epoch_mismatch '$H/run/cf2.out'"
# SIGTERM (unit stop / shutdown) also wipes
cp "$T/tunnel.bak" "$H/state/tunnel.json"; chmod 600 "$H/state/tunnel.json"
env "$(host_env e)" "$AGENT" cloudflared > "$H/run/cf3.out" 2>&1 & CFP=$!
sleep 1.5; kill -TERM $CFP; wait $CFP
check "SIGTERM: cloudflared stopped and token wiped" bash -c "[ ! -e '$H/state/tunnel.json' ] && grep -q 'stopped (sigterm)' '$H/run/cf3.out'"

# --- control channel: authentication
agent e agent > "$H/run/agent.out" 2>&1 & echo $! > "$H/run/agent.pid"
for i in $(seq 1 40); do [ -S "$H/run/control.sock" ] && break; sleep 0.1; done
check "control socket is root-only (0600)" test "$(stat -c %a "$H/run/control.sock")" = 600
check "valid presence accepted" bash -c "agent_ctl '{\"op\":\"presence\",\"leaseEpoch\":2}' | jq -e .ok"
check "wrong epoch refused" bash -c "agent_ctl '{\"op\":\"presence\",\"leaseEpoch\":1}' | jq -e '.error==\"wrong_epoch\"'"
check "stale timestamp refused" bash -c "agent_ctl '{\"op\":\"presence\",\"leaseEpoch\":2,\"ts\":1}' | jq -e '.error==\"stale_request\"'"
check "bad MAC refused" bash -c "python3 -c \"
import json,socket; s=socket.socket(socket.AF_UNIX); s.connect('$H/run/control.sock')
s.sendall(json.dumps({'op':'stop','leaseEpoch':2,'ts':__import__('time').time(),'mac':'00'}).encode()+b'\n'); print(s.recv(999).decode())\" | jq -e '.error==\"bad_mac\"'"
check "agent never calls out: no http/enroll import in agent.py" bash -c "! grep -qE '^from \. import .*\b(http|enroll)\b|^import .*http' '$HA/lib/ezil_host/agent.py'"
# control-plane stop: warn -> flush -> stop (ordered unmount, then shutdown)
agent e overlay >/dev/null 2>&1   # overlay + netns so the ordered unmount has work to do (no container)
check "control-plane stop accepted" bash -c "agent_ctl '{\"op\":\"stop\",\"leaseEpoch\":2,\"warnSeconds\":1,\"reason\":\"cap\"}' | jq -e .ok"
for i in $(seq 1 60); do [ -e "$H/run/shutdown-called" ] && break; sleep 0.25; done
check "stop: shutdown -h called" test -e "$H/run/shutdown-called"
check "stop: overlay and data volume were unmounted BEFORE shutdown" test "$(sed -n 2p "$H/run/shutdown-called" 2>/dev/null)" = 0
check "stop: warn logged, flush not blockable" bash -c "grep -q 'warn: stopping in 1s (cap)' '$H/run/agent.out' && grep -q 'shutdown: stop:cap flush=' '$H/run/agent.out'"
check "stop: fence file written (cloudflared would stop and wipe)" test -e "$H/run/fence"
summary "enrollment + tunnel + control channel"
