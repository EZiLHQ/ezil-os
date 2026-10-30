#!/usr/bin/env bash
# Docker + Compose for the os-staging host without dnf: the preview VPC's S3
# endpoint only allows the preview buckets, so the Amazon Linux mirrors (served
# from S3) return 403. Static Docker comes from download.docker.com (no published
# checksum: the sha256 below was recorded on 2026-10-21) and Compose is verified
# against its release checksums.
set -euo pipefail
umask 022
[[ $(uname -m) == x86_64 ]]
docker_version=29.9.2
docker_sha256=9ac225999fd5e863f7694c728ef23d480616b1e5639328fa309befd4243d69eb
compose_version=v2.39.4
compose_asset=docker-compose-linux-x86_64

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
if ! command -v dockerd >/dev/null; then
    for attempt in $(seq 1 30); do
        curl --fail --location --silent --show-error --retry 5 \
            "https://download.docker.com/linux/static/stable/x86_64/docker-$docker_version.tgz" -o "$temporary/docker.tgz" && break
        sleep 10
    done
    echo "$docker_sha256  $temporary/docker.tgz" | sha256sum --check --quiet
    tar -xzf "$temporary/docker.tgz" -C "$temporary"
    install -m 0755 "$temporary"/docker/* /usr/local/bin/
fi
cat > /etc/systemd/system/docker.service <<'UNIT'
[Unit]
Description=Docker (static binaries)
After=network-online.target
Wants=network-online.target

[Service]
# No iptables/nft on the host: no bridge, host-networked containers only.
ExecStart=/usr/local/bin/dockerd --host=unix:///run/docker.sock --bridge=none --iptables=false --ip6tables=false
Restart=always
LimitNOFILE=1048576
Delegate=yes
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable docker
systemctl reset-failed docker 2>/dev/null || true
systemctl restart docker
for attempt in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done

if ! docker compose version >/dev/null 2>&1; then
    base="https://github.com/docker/compose/releases/download/$compose_version"
    curl --fail --location --silent --show-error --retry 5 "$base/$compose_asset" -o "$temporary/$compose_asset"
    curl --fail --location --silent --show-error --retry 5 "$base/checksums.txt" -o "$temporary/checksums.txt"
    (cd "$temporary" && sha256sum --check --ignore-missing --quiet checksums.txt)
    install -D -m 0755 "$temporary/$compose_asset" /usr/local/lib/docker/cli-plugins/docker-compose
fi
docker compose version --short | python3 -c 'import re,sys; v=re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)",sys.stdin.read().strip()); assert v and tuple(map(int,v.groups())) >= (2,30,0)'
systemctl enable --now amazon-ssm-agent
install -d -m 0755 /var/lib/ezil-os-staging
touch /var/lib/ezil-os-staging/bootstrap.done
echo "docker $(docker version --format '{{.Server.Version}}') compose $(docker compose version --short)"
