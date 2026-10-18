#!/usr/bin/env bash
# Static + pure-function checks: systemd ordering (fail closed), unit syntax, lease
# parser, idle predicate, load parser, seccomp/AppArmor artefacts, AMI recipe hygiene.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"
S="$HA/systemd"
dep() { grep -E "^$2=" "$S/$1" | sed "s/^$2=//" | tr ' ' '\n'; }
export S; export -f dep
chain="ezil-lease ezil-guard ezil-host-clean ezil-overlay ezil-enroll"
prev=""
for u in $chain; do
    if [ -n "$prev" ]; then
        check "$u: Requires=$prev.service and After=$prev.service (a failed upstream stops it)" \
            bash -c "grep -qx '$prev.service' <(dep $u.service Requires) && grep -qx '$prev.service' <(dep $u.service After)"
    fi
    prev="$u"
done
for u in ezil-cloudflared ezil-agent; do
    check "$u: requires and is ordered after ezil-enroll" bash -c "grep -qx ezil-enroll.service <(dep $u.service Requires) && grep -qx ezil-enroll.service <(dep $u.service After)"
done
check "edge: requires and is ordered after enroll and agent (gateway contract GW-2/GW-3)" bash -c "for d in ezil-enroll ezil-agent; do grep -qx \$d.service <(dep ezil-edge.service Requires) && grep -qx \$d.service <(dep ezil-edge.service After) || exit 1; done"
check "desktop: requires the overlay; ordered LAST, after agent, edge and cloudflared (the relay config arrives through them)" bash -c "grep -qx ezil-overlay.service <(dep ezil-desktop.service Requires) && for d in ezil-overlay ezil-agent ezil-edge ezil-cloudflared; do grep -qx \$d.service <(dep ezil-desktop.service After) || exit 1; done"
check "nothing Requires= the desktop: an agent-driven desktop restart never cascades into enrollment or the tunnel" bash -c "! grep -l '^Requires=.*ezil-desktop' '$S'/*.service"
check "the desktop is not bound to the agent: an agent restart never restarts the desktop" bash -c "! grep -qx ezil-agent.service <(dep ezil-desktop.service Requires)"
check "the target pulls the desktop in" grep -q "^Wants=.*ezil-desktop.service" "$S/ezil-host.target"
check "the AMI runs the desktop in relay mode (no inbound rule: TURN only)" grep -q 'iceMode: "relay"' "$HA/ami/build-host-ami.sh"
check "cloudflared requires the edge: no verifier, no tunnel (fail closed)" bash -c "grep -qx ezil-edge.service <(dep ezil-cloudflared.service Requires) && grep -qx ezil-edge.service <(dep ezil-cloudflared.service After)"
check "AMI: enabling the host target really connects it to boot (static is refused)" bash -c "
root='$T/ami-enable'
rm -rf \"\$root\"
mkdir -p \"\$root/etc/systemd/system\"
cp '$S'/* \"\$root/etc/systemd/system/\"
systemctl --root=\"\$root\" enable ezil-host.target &&
[ \"\$(systemctl --root=\"\$root\" is-enabled ezil-host.target)\" = enabled ]
"
check "no unit uses Wants= for the boot chain (Wants would not fail closed)" bash -c "! grep -l '^Wants=ezil-' '$S'/*.service"
check "every service runs the agent with the baked config" bash -c "for f in '$S'/*.service; do grep -q '^Environment=EZIL_HOST_CONFIG=/etc/ezil-host/agent.json' \$f || exit 1; done"
mkdir -p "$T/units/opt/ezil-host/bin"; cp "$S"/* "$T/units/"
out="$(cd "$T/units" && SYSTEMD_UNIT_PATH="$T/units:" systemd-analyze verify --man=no ./ezil-*.service ./ezil-host.target 2>&1 | grep -v -E 'is not executable|No such file|ezil-host-agent' )"
check "systemd-analyze verify: no unit errors (missing agent binary on this host ignored)" test -z "$out"
[ -n "$out" ] && log "verify: $out"
py() { PYTHONPATH="$HA/lib" python3 -c "$1"; }
check "lease parser: valid lease accepted" py "
from ezil_host import lease; import json
lease.parse(json.dumps({'v':1,'computerId':'$CID_COMPUTER','volumeId':'$VOL_ID','fsUuid':'$FS_UUID','generation':1,'leaseEpoch':1,'nonce':'a'*43}))"
for bad in "'leaseEpoch':0" "'generation':-1" "'generation':True" "'volumeId':'vol-XYZ'" "'fsUuid':'nope'" "'nonce':'short'" "'v':2" "'rebase':{'snapshotId':'snap-0123456789abcdef0'}"; do
    check "lease parser refuses {$bad}" py "
from ezil_host import lease; import json
d={'v':1,'computerId':'$CID_COMPUTER','volumeId':'$VOL_ID','fsUuid':'$FS_UUID','generation':1,'leaseEpoch':1,'nonce':'a'*43}
d.update({$bad})
try: lease.parse(json.dumps(d))
except lease.LeaseError: raise SystemExit(0)
raise SystemExit(1)"
done
check "load parser is strict (5e-3, 0x0, -1, garbage -> unknown)" py "
from ezil_host.agent import parse_load1 as p
assert p('0.25 0.1 0.1 1/2 3')==0.25 and p('5e-3 1')is None and p('0x0')is None and p('-1.0')is None and p('')is None and p('cat:')is None"
check "idle predicate: due exactly at the window, not before" py "
from ezil_host.agent import idle_due as d
assert not d(1000, 1599, 600) and d(1000, 1600, 600)"
check "unknown load blocks the idle stop (fail safe)" grep -q 'if load1 is None or load1 >= self.cfg.idle\["load1Busy"\]' "$HA/lib/ezil_host/agent.py"
check "seccomp: allowlist mechanism, CLONE_NEWUSER and mount APIs not allowed" py "
import json; d=json.load(open('$HA/security/seccomp.json'))
assert d['defaultAction']=='SCMP_ACT_ERRNO'
allow=set(d['syscalls'][0]['names'])
assert not allow & {'mount','umount2','fsopen','fsmount','move_mount','open_tree','pivot_root','setns','unshare','clone','clone3','bpf','keyctl'}
c=[r for r in d['syscalls'] if 'clone' in r['names']][0]
assert c['args'][0]=={'index':0,'value':0x10000000,'valueTwo':0,'op':'SCMP_CMP_MASKED_EQ'}"
check "seccomp.json is reproducible from gen-seccomp.py" bash -c "python3 '$HA/security/gen-seccomp.py' | diff -q - '$HA/security/seccomp.json'"
check "AppArmor profile parses" apparmor_parser -Q -K "$HA/security/apparmor-ezil-desktop"
check "AMI recipe: no secrets, no AWS CLI calls, pinned cloudflared checksum" bash -c "
f='$HA/ami/build-host-ami.sh'; [ -f \$f ] && ! grep -nE '(^|[^-])aws [a-z]|AKIA|SECRET|PASSWORD=' \$f && grep -q "CLOUDFLARED_SHA256:?" \$f && grep -q 'sha256sum -c' \$f"
AMI="$HA/ami/build-host-ami.sh"
check "AMI: every apt install is version-pinned" bash -c "! grep -E '^ *apt-get install' '$AMI' | grep -vE '\"\\\$\{PINS\[@\]\}\"|docker.io=' | grep -q ."
check "AMI: each pin names an exact version" bash -c "grep -cE '^  \"[a-z0-9.-]+=\\\$\{PIN_[A-Z0-9_]+:-[^}]+\}\"$' '$AMI' | grep -qx 9"
check "AMI: pinned packages held; refuses a non-noble base" bash -c "grep -q 'apt-mark hold' '$AMI' && grep -q 'VERSION_CODENAME:-}\" = noble' '$AMI'"
check "AMI: cloud-init seed/cache from the build instance cleaned; user data not acted on" bash -c "grep -q 'cloud-init clean --logs --seed' '$AMI' && grep -q 'allow_userdata: false' '$AMI'"
check "AMI: container DNS listener configured on the veth host address" grep -q 'DNSStubListenerExtra=10.200.0.1' "$AMI"
check "agent default scrubs every cloud-init user-data copy (incl. obj.pkl)" py "
from ezil_host import config
c=config.DEFAULTS['userDataCopies']
assert '/var/lib/cloud/instances/*/obj.pkl' in c and '/run/cloud-init/instance-data-sensitive.json' in c and '/var/lib/cloud/instances/*/user-data.txt.i' in c"
pyunit() { (cd "$HA/test" && python3 -m unittest -q "$@"); }
check "canary: default off, public console schema, persistence and lifecycle ordering" pyunit test_canary
check "enroll: the app's browser-host binding (sandboxId, zone) lands in the lease; a malformed one stores nothing" pyunit test_enroll_routing
check "enroll: the nonce is re-sent only after an answer that consumed nothing; bounded; kept when retrying ends" pyunit test_boot_retries.EnrollRetry
check "enroll: a 200 retires the nonce only after its credentials are durable; malformed/write error/crash keep it and the replay converges" pyunit test_enroll_durability
check "guard: waits, bounded, for the late-attached data volume (wake link, provision disk)" pyunit test_boot_retries.VolumeWait
check "lease: IMDS transport errors retried, bounded; HTTP refusals final" pyunit test_boot_retries.ImdsRetry
check "history: env + read-only profile.d make an open terminal append each command (real pty bash)" pyunit test_history_stop.HistoryInjection
check "history: a still-running command is saved when the terminal shell is hung up before the stop" pyunit test_history_stop.HangupBeforeStop
check "hangup: a shell outside the container pid namespace is never signalled; membership read after the pidfd pin" pyunit test_history_stop.HangupScope
check "stop outcome: absent/clean/killed from desktop.stop" pyunit test_history_stop.StopOutcome
check "provision: exactly one non-root EBS data volume by NVMe identity; host-sized container limits" pyunit test_provision_resources
check "AMI component: every Image Builder command is a YAML string (a bare ': ' parses as a map; live create failed)" python3 -c "import yaml,sys; d=yaml.safe_load(open('$HA/ami/imagebuilder-component.yaml')); sys.exit(any(not isinstance(c,str) for ph in d['phases'] for st in ph['steps'] if isinstance(st.get('inputs'),dict) for c in st['inputs'].get('commands',[])))"
check "stop outcome: a killed desktop is never flush=ok; durable record written and reported at boot" pyunit test_history_stop.AgentStopRecord
check "drift: same rules in another order is drift; netns delete failure is reported" pyunit test_history_stop.DriftOrder
check "edge: gw1 verifier matches the Worker's shared vectors (valid, invalid, skew, framing)" pyunit test_edge.GwVectors
check "relay config: TURN-only backend, authenticated TURN, neko /api/relay lifetime, derived neko values only" pyunit test_ice.RelayConfig
check "relay env: Cloudflare's neko ICE env + derived credentials replace local mode's direct-connect settings" pyunit test_ice.RelayEnv
check "relay store: runDir tmpfs 0600 only (refused on the data volume), expiry-aware, bounded wait" pyunit test_ice.RelayStore
check "agent ice/desktop_status: accepted, refused before seq, kept while running, ice_missing desktop restarted once; no credential echoed or logged" pyunit test_ice.AgentIce
check "poweroff: a failed shutdown is retried (backoff, capped, forced fallback) until accepted; a restarted agent resumes it" pyunit test_host_resilience.PowerOff
check "desktop crash: unit exited/failed -> reset + restart on the next push, bounded per window, then reported; refused while stopping" pyunit test_host_resilience.DesktopRestart
check "guard: same instance + same epoch = reboot; another instance replaying the epoch is refused" pyunit test_host_resilience.GuardReboot
check "enroll: a same-instance reboot reuses its own epoch's credentials; any other case enrolls" pyunit test_host_resilience.EnrollReuse
check "host units: every long-lived unit restarts after a crash (bounded); edge/cloudflared/desktop refuse while stopping and exit 2 is never restarted" pyunit test_unit_restart_policy
check "units: the desktop restarts on exit except on a refusal (exit 2); the agent restarts on failure" bash -c "grep -qx 'Restart=always' '$S/ezil-desktop.service' && grep -qx 'RestartPreventExitStatus=2' '$S/ezil-desktop.service' && grep -qx 'StartLimitBurst=5' '$S/ezil-desktop.service' && grep -qx 'Restart=on-failure' '$S/ezil-agent.service'"
check "desktop step (relay mode): applied or ice_missing, desktop last in the relay boot order, no credential printed" pyunit test_ice.DesktopStep
check "edge: real edge + real agent socket (ephemeral ports): 401 forwards nothing, strip, no smuggling, framing, WS, presence, control" pyunit test_edge.EdgeE2E
summary "units + pure functions"
