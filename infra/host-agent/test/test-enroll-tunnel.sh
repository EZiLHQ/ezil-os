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
mkdir -p "$H/cloud/instances/i-0abc/sem" "$H/cloud/run"
for f in user-data.txt user-data.txt.i obj.pkl; do cp "$H/stub/user-data" "$H/cloud/instances/i-0abc/$f"; done
cp "$H/stub/user-data" "$H/cloud/run/instance-data-sensitive.json"; echo keep > "$H/cloud/instances/i-0abc/sem/config_x"; echo keep > "$H/cloud/instances/i-0abc/datasource"
touch "$H/stub/retry-once" "$H/stub/platform-502-once"   # 'retryable' 503, then a platform 502 page, then 200
check "enroll succeeds over verified TLS (test CA, SNI app.ezil.test)" agent e enroll
check "...after re-sending the same nonce through a 'retryable' 503 and a platform 502" \
    bash -c "[ \$(wc -l < '$H/stub/enroll-requests.jsonl') -eq 3 ] && [ \$(jq -r .nonce '$H/stub/enroll-requests.jsonl' | sort -u | wc -l) -eq 1 ]"
REQ="$(tail -n 1 "$H/stub/enroll-requests.jsonl")"
check "request = {computerId, generation, leaseEpoch, nonce, identityDocument, signature, lowerImageDigest}" \
    jq -e --arg c "$CID_COMPUTER" '(keys == ["computerId","generation","identityDocument","leaseEpoch","lowerImageDigest","nonce","signature"]) and .computerId==$c and .generation==1 and .leaseEpoch==2 and (.identityDocument|fromjson|.instanceId=="i-0abc") and (.signature|startswith("MIAG")) and (.lowerImageDigest|test("^sha256:[0-9a-f]{64}$"))' <<<"$REQ"
TOKEN="$(jq -r .tunnelToken "$H/stub/issue.json")"
check "token stored host-only: state dir 0700, file 0600, bound to (gen 1, epoch 2)" bash -c "[ \$(stat -c %a '$H/state') = 700 ] && [ \$(stat -c %a '$H/state/tunnel.json') = 600 ] && jq -e '.generation==1 and .leaseEpoch==2' '$H/state/tunnel.json'"
check "token appears nowhere on the data volume" bash -c "! grep -rqs -- '$TOKEN' '$D'"
check "cloud-init's cached user-data copy (holds the nonce) wiped" test ! -e "$H/cloud/user-data.txt"
check "cloud-init per-instance copies wiped (user-data.txt, .i, obj.pkl, instance-data-sensitive.json)" bash -c "[ -z \"\$(ls '$H/cloud/instances/i-0abc' | grep -E 'user-data|obj.pkl')\" ] && [ ! -e '$H/cloud/run/instance-data-sensitive.json' ]"
check "cloud-init's other state untouched (sem/, datasource)" bash -c "[ -e '$H/cloud/instances/i-0abc/sem/config_x' ] && [ -e '$H/cloud/instances/i-0abc/datasource' ]"
check "no copy of the nonce left anywhere on the host test tree" bash -c "! grep -rqs -- \"\$(jq -r .nonce '$H/stub/user-data')\" '$H/cloud' '$H/run' '$H/state'"
check "nonce wiped from local lease state after use" jq -e '(has("nonce")|not) and .nonceConsumed' "$H/run/lease.json"
check "the edge's browser-host binding (sandboxId, zone) recorded in the lease, still 0600" \
    bash -c "jq -e '.sandboxId==\"guac-a-b\" and .zone==\"preview.example.org\" and .nonceConsumed' '$H/run/lease.json' && [ \$(stat -c %a '$H/run/lease.json') = 600 ]"
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
agent_ctl() { python3 "$HA/test/ctl.py" "$H" "$1"; }   # signs, fills ts and seq
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
env "$(host_env e)" "$AGENT" agent > "$H/run/agent.out" 2>&1 & echo $! > "$H/run/agent.pid"   # $! must be the agent itself, not a subshell
for i in $(seq 1 40); do [ -S "$H/run/control.sock" ] && break; sleep 0.1; done
check "control socket is root-only (0600)" test "$(stat -c %a "$H/run/control.sock")" = 600
check "valid presence accepted" bash -c "agent_ctl '{\"op\":\"presence\",\"leaseEpoch\":2}' | jq -e .ok"
check "wrong epoch refused" bash -c "agent_ctl '{\"op\":\"presence\",\"leaseEpoch\":1}' | jq -e '.error==\"wrong_epoch\"'"
check "stale timestamp refused" bash -c "agent_ctl '{\"op\":\"presence\",\"leaseEpoch\":2,\"ts\":1}' | jq -e '.error==\"stale_request\"'"
check "bad MAC refused" bash -c "python3 '$HA/test/ctl.py' '$H' '{\"raw\":\"{\\\"op\\\":\\\"stop\\\",\\\"leaseEpoch\\\":2,\\\"ts\\\":1,\\\"seq\\\":99,\\\"mac\\\":\\\"00\\\"}\"}' | jq -e '.error==\"bad_mac\"'"
ctl_err() { agent_ctl "$1" | jq -r '.error // "ok"'; }
check "non-finite ts (NaN) refused" test "$(ctl_err '{"op":"presence","leaseEpoch":2,"ts_raw":"nan"}')" = bad_ts
check "non-finite ts (inf) refused" test "$(ctl_err '{"op":"presence","leaseEpoch":2,"ts_raw":"inf"}')" = bad_ts
check "ts 60 s in the future refused (skew bound 5 s)" test "$(ctl_err '{"op":"presence","leaseEpoch":2,"ts_offset":60}')" = stale_request
check "ts 3 s in the future accepted" test "$(ctl_err '{"op":"presence","leaseEpoch":2,"ts_offset":3}')" = ok
check "zero seq refused" test "$(ctl_err '{"op":"presence","leaseEpoch":2,"seq":0}')" = bad_seq
check "boolean seq refused" test "$(ctl_err '{"op":"presence","leaseEpoch":2,"seq":true}')" = bad_seq
SEQ=$(( $(cat "$H/run/test-seq") + 1 )); echo $SEQ > "$H/run/test-seq"
check "fresh seq accepted" test "$(ctl_err "{\"op\":\"presence\",\"leaseEpoch\":2,\"seq\":$SEQ}")" = ok
check "exact replay (same seq) refused" test "$(ctl_err "{\"op\":\"presence\",\"leaseEpoch\":2,\"seq\":$SEQ}")" = replayed
check "lower seq refused" test "$(ctl_err "{\"op\":\"presence\",\"leaseEpoch\":2,\"seq\":$((SEQ-1))}")" = replayed
check "seq high-water mark persisted host-only (0600)" bash -c "jq -e '.leaseEpoch==2 and .seq==$SEQ' '$H/state/control-seq.json' && [ \$(stat -c %a '$H/state/control-seq.json') = 600 ]"
kill "$(cat "$H/run/agent.pid")"; sleep 1
env "$(host_env e)" "$AGENT" agent >> "$H/run/agent.out" 2>&1 & echo $! > "$H/run/agent.pid"
for i in $(seq 1 40); do [ -S "$H/run/control.sock" ] && break; sleep 0.1; done; sleep 0.3
check "replay refused across an agent restart" test "$(ctl_err "{\"op\":\"presence\",\"leaseEpoch\":2,\"seq\":$SEQ}")" = replayed
for w in -1 901 '"5"' true 1.5; do
    check "stop with warnSeconds=$w refused (bounds 0..900, integer)" test "$(ctl_err "{\"op\":\"stop\",\"leaseEpoch\":2,\"warnSeconds\":$w}")" = bad_warn
done
check "non-object JSON refused, channel stays up" bash -c "[ \"\$(python3 '$HA/test/ctl.py' '$H' '{\"raw\":\"[1,2]\"}' | jq -r .error)\" = bad_json ] && [ \"\$(agent_ctl '{\"op\":\"presence\",\"leaseEpoch\":2}' | jq -r .ok)\" = true ]"
check "no stop was triggered by any refused request" test ! -e "$H/run/shutdown-called"
check "agent never calls out: no http/enroll import in agent.py" bash -c "! grep -qE '^from \. import .*\b(http|enroll)\b|^import .*http' '$HA/lib/ezil_host/agent.py'"
# control-plane stop: warn -> flush -> stop (ordered unmount, then shutdown)
agent e overlay >/dev/null 2>&1   # overlay + netns so the ordered unmount has work to do (no container)
check "control-plane stop accepted" bash -c "agent_ctl '{\"op\":\"stop\",\"leaseEpoch\":2,\"warnSeconds\":1,\"reason\":\"cap\"}' | jq -e .ok"
for i in $(seq 1 60); do [ -e "$H/run/shutdown-called" ] && break; sleep 0.25; done
check "stop: shutdown -h called" test -e "$H/run/shutdown-called"
check "stop: overlay and data volume were unmounted BEFORE shutdown" test "$(sed -n 2p "$H/run/shutdown-called" 2>/dev/null)" = 0
check "stop: warn logged, flush not blockable" bash -c "grep -q 'warn: stopping in 1s (cap)' '$H/run/agent.out' && grep -q 'shutdown: stop:cap flush=' '$H/run/agent.out'"
check "stop: fence file written (cloudflared would stop and wipe)" test -e "$H/run/fence"
cp "$H/run/agent.out" "$T/agent-e.out" 2>/dev/null
# --- an answer that consumed nothing: the nonce is kept and re-sent, bounded (Codex PR #200)
agent e data-down >/dev/null 2>&1   # a fresh epoch (3): the marker is at epoch 2 now
userdata e 1 3 false; agent e lease >/dev/null; agent e guard >/dev/null; : > "$H/stub/enroll-requests.jsonl"
touch "$H/stub/retry-always"
t0=$(date +%s); expect_refuse "always 'retryable': refused once the bounded retry ends" enroll_retry_exhausted agent e enroll; t1=$(date +%s)
check "...within the bound (enrollRetrySeconds=3)" test $((t1 - t0)) -le 10
check "...the nonce is KEPT in local state (nothing was consumed)" jq -e 'has("nonce") and (.nonceConsumed|not)' "$H/run/lease.json"
check "...re-sent several times, always the same nonce" bash -c "[ \$(wc -l < '$H/stub/enroll-requests.jsonl') -ge 3 ] && [ \$(jq -r .nonce '$H/stub/enroll-requests.jsonl' | sort -u | wc -l) -eq 1 ]"
rm -f "$H/stub/retry-always"; agent e data-down >/dev/null
summary "enrollment + tunnel + control channel"
