#!/usr/bin/env bash
# Embedded by deploy.sh into a staging-guarded SSM command; not a CLI entrypoint.
set -euo pipefail
set +x
umask 077
tag=$1
bucket=$2
[[ $EUID == 0 && $(uname -m) == x86_64 ]]
# S9b installs Docker, Compose >=2.30, AWS CLI v2, Python, curl, SSM and flock.
compose_version=$(docker compose version --short)
python3 - "$compose_version" <<'PY'
import re, sys
m = re.match(r"v?(\d+)\.(\d+)\.(\d+)", sys.argv[1])
if not m or tuple(map(int, m.groups())) < (2, 30, 0):
    raise SystemExit("Docker Compose >=2.30.0 required for raw env_file")
PY
install -d -m 0700 /opt/ezil-os-staging /etc/ezil-os-staging
cd /opt/ezil-os-staging
exec 9>deploy.lock
flock -x 9
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
# Downloads use only the instance role, never local profiles/static credentials.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_DEFAULT_PROFILE
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=false
for suffix in sha256 tar.gz runtime.tar.gz; do
    aws --region ap-south-1 --no-cli-pager s3 cp \
        "s3://$bucket/os-staging/images/$tag.$suffix" "$temporary/$tag.$suffix" --only-show-errors
done
python3 - "$temporary" "$tag" <<'PY'
import hashlib, pathlib, re, sys
directory, tag = pathlib.Path(sys.argv[1]), sys.argv[2]
lines = (directory / (tag + ".sha256")).read_text().splitlines()
expected = [tag + ".tar.gz", tag + ".runtime.tar.gz"]
if len(lines) != len(expected):
    raise SystemExit("Invalid checksum manifest")
for line, name in zip(lines, expected):
    if not re.fullmatch(r"[0-9a-f]{64}  " + re.escape(name), line):
        raise SystemExit("Invalid checksum entry")
    digest = hashlib.sha256()
    with (directory / name).open("rb") as archive:
        for chunk in iter(lambda: archive.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != line[:64]:
        raise SystemExit("Checksum mismatch")
PY
gzip -dc "$temporary/$tag.tar.gz" | docker load >/dev/null
docker image inspect "ezil-os-staging:$tag" --format '{{.Architecture}}' | \
    python3 -c 'import sys; sys.exit(0 if sys.stdin.read().strip() == "amd64" else 1)'
# Extract only known ordinary files; reject links, traversal and extra members.
python3 - "$temporary/$tag.runtime.tar.gz" <<'PY'
import pathlib, tarfile, sys
names = {"compose.yaml", "Caddyfile", "render-env.py"}
names |= {f"cron/ezil-os-staging-{job}.{kind}" for job in
          ("telemetry-maintenance", "sandbox-reap", "billing-session-sweep")
          for kind in ("service", "timer")}
with tarfile.open(sys.argv[1]) as bundle:
    members = [m for m in bundle.getmembers() if not (m.name == "cron" and m.isdir())]
    if len(members) != len(names) or {m.name for m in members} != names or any(not m.isfile() for m in members):
        raise SystemExit("Invalid runtime bundle")
    for member in members:
        path = pathlib.Path(member.name)
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(bundle.extractfile(member).read())
PY
# Stop cron clients before rotating their environment; server work may continue.
jobs=(telemetry-maintenance sandbox-reap billing-session-sweep)
for job in "${jobs[@]}"; do
    if [[ -f /etc/systemd/system/ezil-os-staging-$job.timer ]]; then
        systemctl stop "ezil-os-staging-$job.timer" "ezil-os-staging-$job.service"
    fi
done
python3 render-env.py
printf 'OS_STAGING_TAG=%s\n' "$tag" >compose.env
docker compose --env-file compose.env up -d --force-recreate --wait --wait-timeout 120
for job in "${jobs[@]}"; do
    install -m 0644 "cron/ezil-os-staging-$job.service" "cron/ezil-os-staging-$job.timer" /etc/systemd/system/
done
systemctl daemon-reload
for job in "${jobs[@]}"; do
    systemctl enable --now "ezil-os-staging-$job.timer"
done
printf 'Installed TAG: %s\n' "$tag"
docker compose --env-file compose.env exec -T web node -e 'console.log("Deployed SHA: " + process.env.EZIL_GIT_SHA)'
