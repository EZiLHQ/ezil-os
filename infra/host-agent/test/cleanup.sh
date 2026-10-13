#!/usr/bin/env bash
# Remove everything the I4 tests create: containers (runc state + any leftover scope),
# test processes, mounts, loop devices, netns, the loaded test AppArmor profile, scratch.
# usage: cleanup.sh [--keep-scratch]
T=/var/tmp/ezil-host-fb25d9f4; TAG=ezil-host-fb25d9f4
ancestors() { local p=$$; while [ "$p" -gt 1 ]; do echo "$p"; p="$(awk '/^PPid:/{print $2}' "/proc/$p/status" 2>/dev/null)"; p="${p:-1}"; done; }
kill_matching() { # kill processes whose argv matches $1, never this script's own ancestry
    local skip; skip=" $(ancestors | tr '\n' ' ') "
    for pid in $(pgrep -f -- "$1"); do [[ "$skip" == *" $pid "* ]] || kill "$pid" 2>/dev/null; done
}
for r in "$T"/hosts/*/run/runc; do
    [ -d "$r" ] || continue
    for id in $(runc --root "$r" list -q 2>/dev/null); do
        runc --root "$r" --systemd-cgroup kill --all "$id" KILL 2>/dev/null; sleep 0.5
        runc --root "$r" --systemd-cgroup delete --force "$id" 2>/dev/null
    done
done
for s in /sys/fs/cgroup/system.slice/${TAG}-*.scope; do [ -d "$s" ] && echo 1 > "$s/cgroup.kill"; done
kill_matching "stub_servers.py (imds|app) $T/"
kill_matching "ezil-host-agent (cloudflared|agent)$"
kill_matching "$T/mut-ha/test/"
kill_matching "infra/host-agent/test/stub_(dns|tcp).py"
sleep 1
findmnt -rn -o TARGET | grep -F "$T/" | sort -r | while read -r m; do umount "$m" 2>/dev/null || umount -l "$m"; done
losetup -a | grep -F "$T/" | cut -d: -f1 | while read -r d; do losetup -d "$d"; done
ip netns list | awk '{print $1}' | grep "^${TAG}" | while read -r n; do ip netns delete "$n"; done
[ -f "$T/apparmor-profile" ] && apparmor_parser -R "$T/apparmor-profile" 2>/dev/null
docker ps -a --format '{{.Names}}' | grep "^${TAG}" | xargs -r docker rm -f >/dev/null
sleep 1
[ "${1:-}" = --keep-scratch ] || rm -rf "$T"
echo "scopes: $(ls /sys/fs/cgroup/system.slice | grep -c "^${TAG}")  mounts: $(findmnt -rn | grep -c "$TAG")  loops: $(losetup -a | grep -c "$TAG")  netns: $(ip netns list | grep -c "$TAG")  docker: $(docker ps -a --format '{{.Names}}' | grep -c "^${TAG}")  apparmor: $(grep -c "^${TAG}" /sys/kernel/security/apparmor/profiles 2>/dev/null)"
