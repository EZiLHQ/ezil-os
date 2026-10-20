#!/usr/bin/env bash
# Execute on the DB host as root through AWS-RunShellScript; never touches Compose.
set -euo pipefail
set +x

proxy_name=os-staging-db-proxy
proxy_network=ezil-main-preview_default
proxy_image_tag=haproxy:lts-alpine
proxy_dir=/opt/os-staging-db-proxy
proxy_label=workload.ezil=os-staging-db-proxy
proxy_bind=10.61.20.35:5432

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 1 && $1 =~ ^(start|status|refresh|remove|nft-plan)$ ]] || fail 'Usage: db-proxy.sh start|status|refresh|remove|nft-plan'
[[ $EUID == 0 ]] || fail 'Run as root through SSM.'
# Guard every operation, including status, removal and the printed firewall plan.
[[ -f /var/lib/ezil-main-preview/environment.json ]] || fail 'Preview environment marker missing; refusing.'
[[ ! -e /var/lib/ezil-main-prod && ! -L /var/lib/ezil-main-prod ]] || fail 'Production marker exists; refusing.'
command -v ip >/dev/null
command -v python3 >/dev/null
ip -j -4 addr show | python3 -c '
import json, sys
assert any(a["local"] == "10.61.20.35" for i in json.load(sys.stdin) for a in i["addr_info"]), "Wrong preview DB host"
'
if [[ $1 == nft-plan ]]; then
    cat <<'PLAN'
REVIEW ONLY: this script never runs nft or changes the network guard.
1. Verify the current preview-only guard and input drop rule handles:
   nft -a list table inet ezil_preview
2. Replace APP_PRIVATE_IP with the new app host's verified private IPv4, and
   PREVIEW_EC2_INTERFACE with this DB host's external EC2 interface name.
   Insert this narrowly scoped input allowance before any matching host DB drop:
   nft insert rule inet ezil_preview input iifname PREVIEW_EC2_INTERFACE ip saddr APP_PRIVATE_IP/32 ip daddr 10.61.20.35 tcp dport 5432 counter accept comment 'os-staging preview PostgreSQL'
3. Keep the existing bridge source checks and container-to-host denials. Do not
   add a bridge forwarding allowance: HAProxy uses host networking and its
   backend traffic is host-originated. The checked-in preview input chain has
   policy accept and bridge-only drops, so it may need no additional allowance;
   review ALL live input chains (accept cannot override another chain's drop).
4. Have the DB owner persist any needed rule in the preview guard's owning source
   and record its handle for removal. Never flush rulesets or edit prod tables.
5. The separate SG rule remains mandatory. Verify connectivity from the app and
   refusal from outside the app SG. Remove only the dedicated rule on teardown.
PLAN
    exit 0
fi
command -v docker >/dev/null
command -v python3 >/dev/null
# Serialize only this helper, never the Supabase project.
exec 9>/run/lock/os-staging-db-proxy.lock
flock -x 9

exists=false
if docker container inspect "$proxy_name" --format '{{.Id}}' >/dev/null 2>&1; then
    exists=true
    [[ $(docker inspect "$proxy_name" --format '{{index .Config.Labels "workload.ezil"}}') == os-staging-db-proxy ]] ||
        fail 'Container name is owned by another workload; refusing to change it.'
fi

if [[ $1 == remove ]]; then
    if $exists; then docker rm -f "$proxy_name" >/dev/null; fi
    printf '%s\n' 'Only the OS staging proxy removed; Supabase containers and network unchanged.'
    exit 0
fi

command -v ss >/dev/null || fail 'ss is required to verify the private listener.'
listener_present() {
    ss -H -ltn | awk -v endpoint="$proxy_bind" '$4 == endpoint { found=1 } END { exit !found }'
}
resolve_backend() {
    docker inspect supabase-db --format '{{json .NetworkSettings.Networks}}' | python3 -c '
import ipaddress, json, sys
networks = json.load(sys.stdin)
address = ipaddress.IPv4Address(networks[sys.argv[1]]["IPAddress"])
assert address in ipaddress.IPv4Network("172.30.60.0/24"), "Not the preview internal network"
print(address)
' "$proxy_network"
}
backend_ip=$(resolve_backend) || fail 'Cannot resolve supabase-db IPv4 on the expected Compose network.'

if [[ $1 == status ]]; then
    $exists || fail 'Proxy absent.'
    configured_backend=$(docker inspect "$proxy_name" --format '{{index .Config.Labels "workload.ezil.db-backend"}}')
    docker inspect "$proxy_name" --format 'status={{.State.Status}} image={{.Config.Image}} network={{.HostConfig.NetworkMode}}'
    printf 'Listener: %s; configured backend: %s:5432; current supabase-db: %s:5432\n' \
        "$proxy_bind" "$configured_backend" "$backend_ip"
    [[ $(docker inspect "$proxy_name" --format '{{.State.Running}} {{.HostConfig.NetworkMode}}') == 'true host' ]] ||
        fail 'Proxy is not running with host networking; run start.'
    listener_present || fail "Proxy has no listener at $proxy_bind."
    [[ $configured_backend == "$backend_ip" ]] || fail 'Backend IP changed; run refresh.'
    printf '%s\n' 'Private listener verified (backend connectivity not tested).'
    exit 0
fi

install -d -m 0755 "$proxy_dir"
# Resolve the upstream tag once, then retain and use only the immutable digest.
if [[ -f $proxy_dir/image.ref ]]; then
    proxy_image=$(cat "$proxy_dir/image.ref")
else
    docker pull "$proxy_image_tag" >/dev/null
    proxy_image=$(docker image inspect "$proxy_image_tag" --format '{{json .RepoDigests}}' | python3 -c '
import json, sys
refs = [r for r in json.load(sys.stdin) if r.startswith("haproxy@sha256:")]
assert len(refs) == 1, "Expected one HAProxy repository digest"
print(refs[0])
') || fail 'Could not resolve the HAProxy image digest.'
fi
[[ $proxy_image =~ ^haproxy@sha256:[a-f0-9]{64}$ ]] || fail 'Invalid HAProxy digest in image.ref.'
proxy_config=$(mktemp "$proxy_dir/.haproxy.XXXXXX")
trap 'rm -f "$proxy_config"' EXIT
cat >"$proxy_config" <<CONFIG
global
    maxconn 256
defaults
    mode tcp
    timeout connect 5s
    timeout client 1h
    timeout server 1h
frontend postgres_private
    bind $proxy_bind
    default_backend postgres
backend postgres
    server db $backend_ip:5432 check
CONFIG

matches=false
if $exists && cmp -s "$proxy_config" "$proxy_dir/haproxy.cfg"; then
    if docker inspect "$proxy_name" | python3 -c '
import json, sys
c = json.load(sys.stdin)[0]
h = c["HostConfig"]
assert c["Config"]["Image"] == sys.argv[1]
assert c["Config"]["Labels"].get("workload.ezil.db-backend") == sys.argv[2]
assert h["NetworkMode"] == "host" and not h.get("PortBindings")
assert h["RestartPolicy"]["Name"] == "unless-stopped"
assert h["Memory"] == 67108864 and h["NanoCpus"] == 250000000
assert h["PidsLimit"] == 64 and h["ReadonlyRootfs"]
assert c["Config"]["User"] == "65534:65534"
assert h["CapDrop"] == ["ALL"] and "no-new-privileges" in h["SecurityOpt"]
assert any(m["Source"] == "/opt/os-staging-db-proxy/haproxy.cfg" and m["Destination"] == "/usr/local/etc/haproxy/haproxy.cfg" and not m["RW"] for m in c["Mounts"])
' "$proxy_image" "$backend_ip" 2>/dev/null; then
        matches=true
    fi
fi

if $matches; then
    if [[ $(docker inspect "$proxy_name" --format '{{.State.Running}}') != true ]]; then
        docker start "$proxy_name" >/dev/null
    fi
else
    # Validate the replacement before stopping only the owned proxy. Recreate it
    # so the read-only file bind mount sees the new configuration inode.
    docker pull "$proxy_image" >/dev/null
    chmod 0444 "$proxy_config"
    docker run --rm --network none --read-only --user 65534:65534 \
        --cap-drop ALL --security-opt no-new-privileges \
        -v "$proxy_config:/usr/local/etc/haproxy/haproxy.cfg:ro" \
        "$proxy_image" haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg >/dev/null
    if [[ ! -f $proxy_dir/image.ref ]]; then
        printf '%s\n' "$proxy_image" >"$proxy_dir/image.ref"
        chmod 0444 "$proxy_dir/image.ref"
    fi
    if $exists; then docker rm -f "$proxy_name" >/dev/null; fi
    mv -f "$proxy_config" "$proxy_dir/haproxy.cfg"
    docker run -d --name "$proxy_name" --label "$proxy_label" \
        --label "workload.ezil.db-backend=$backend_ip" --network host \
        --restart unless-stopped --memory 64m --cpus 0.25 --pids-limit 64 \
        --read-only --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges \
        --log-opt max-size=5m --log-opt max-file=2 \
        -v "$proxy_dir/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro" \
        "$proxy_image" haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg >/dev/null
fi

for ((attempt=0; attempt<10; attempt++)); do
    if listener_present; then break; fi
    sleep 1
done
listener_present || fail "Proxy failed to listen on $proxy_bind within 10 seconds; inspect only its logs."
restart_count=$(docker inspect "$proxy_name" --format '{{.RestartCount}}')
sleep 2
[[ $(docker inspect "$proxy_name" --format '{{.State.Running}} {{.RestartCount}}') == "true $restart_count" ]] ||
    fail 'Proxy failed its initial process check; inspect only its logs.'
listener_present || fail "Proxy lost its listener on $proxy_bind."
printf 'Proxy running: %s -> %s:5432 (supabase-db, private VPC, no TLS).\n' "$proxy_bind" "$backend_ip"
