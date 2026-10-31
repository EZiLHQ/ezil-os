#!/usr/bin/env bash
# Embedded by deploy.sh into an environment-guarded SSM command; not a CLI entrypoint.
set -euo pipefail
set +x
umask 077
tag=$1
bucket=$2
environment=${3:-staging}
# Staging keeps its original names; production has its own paths, units, image and S3 prefix.
case $environment in
    staging) slug=ezil-os-staging prefix=os-staging/images other=ezil-os-production;;
    production) slug=ezil-os-production prefix=os/images other=ezil-os-staging;;
    *) echo 'Unknown environment.' >&2; exit 1;;
esac
[[ $EUID == 0 && $(uname -m) == x86_64 ]]
# A host bootstrapped for one environment never takes the other's release.
if [[ -e /var/lib/$other ]]; then
    echo "Refusing: this host carries /var/lib/$other." >&2; exit 1
fi
if [[ $environment == production && ! -f /var/lib/$slug/bootstrap.done ]]; then
    echo "Refusing: /var/lib/$slug/bootstrap.done is missing." >&2; exit 1
fi
# S9b installs Docker, Compose >=2.30, AWS CLI v2, Python, curl, SSM and flock.
compose_version=$(docker compose version --short)
python3 - "$compose_version" <<'PY'
import re, sys
m = re.match(r"v?(\d+)\.(\d+)\.(\d+)", sys.argv[1])
if not m or tuple(map(int, m.groups())) < (2, 30, 0):
    raise SystemExit("Docker Compose >=2.30.0 required for raw env_file")
PY
install -d -m 0700 "/opt/$slug" "/etc/$slug"
cd "/opt/$slug"
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
        "s3://$bucket/$prefix/$tag.$suffix" "$temporary/$tag.$suffix" --only-show-errors
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
docker image inspect "$slug:$tag" --format '{{.Architecture}}' | \
    python3 -c 'import sys; sys.exit(0 if sys.stdin.read().strip() == "amd64" else 1)'
# Extract only known ordinary files; reject links, traversal and extra members.
python3 - "$temporary/$tag.runtime.tar.gz" "$slug" <<'PY'
import pathlib, tarfile, sys
names = {"compose.yaml", "Caddyfile", "render-env.py"}
names |= {f"cron/{sys.argv[2]}-{job}.{kind}" for job in
          ("telemetry-maintenance", "sandbox-reap", "billing-session-sweep", "aws-stop-settle", "pool-replenish", "aws-reconcile")
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
jobs=(telemetry-maintenance sandbox-reap billing-session-sweep aws-stop-settle pool-replenish aws-reconcile)
for job in "${jobs[@]}"; do
    if [[ -f /etc/systemd/system/$slug-$job.timer ]]; then
        systemctl stop "$slug-$job.timer" "$slug-$job.service"
    fi
done
keys=$(python3 render-env.py "$environment")
printf '%s\n' "$keys"
enabled=("${jobs[@]}")
# Production runs the AWS computer timers only once its secret configures them.
if [[ $environment == production ]] && ! grep -qx EZIL_AWS_COMPUTERS_ENABLED <<<"$keys"; then
    enabled=(telemetry-maintenance sandbox-reap billing-session-sweep)
    echo 'AWS computer timers stay disabled: EZIL_AWS_COMPUTERS_ENABLED is not set.'
fi
printf 'OS_%s_TAG=%s\n' "${environment^^}" "$tag" >compose.env
# D4: --force-recreate deletes the outgoing web container's json-file log. Keep a gzip copy first
# (root-only, 7-day retention). Best effort: a snapshot problem never blocks the install.
snapshot_web_log() {
    local dir=/var/log/$slug container=$slug-web-1 file
    file="$dir/web-$(date -u +%Y%m%dT%H%M%SZ).log.gz"
    {
        install -d -m 0700 "$dir" &&
            if docker container inspect "$container" >/dev/null 2>&1; then
                timeout 180 docker logs --timestamps "$container" 2>&1 | gzip >"$file.partial" &&
                    mv "$file.partial" "$file" && printf 'Web log snapshot: %s\n' "$file"
            fi
    } || { rm -f "$file.partial"; printf 'Web log snapshot skipped; install continues\n' >&2; }
    find "$dir" -maxdepth 1 -type f -name 'web-*.log.gz*' -mmin +10080 -delete 2>/dev/null || true
}
snapshot_web_log
docker compose --env-file compose.env up -d --force-recreate --wait --wait-timeout 120
for job in "${jobs[@]}"; do
    install -m 0644 "cron/$slug-$job.service" "cron/$slug-$job.timer" /etc/systemd/system/
done
systemctl daemon-reload
for job in "${jobs[@]}"; do
    if [[ " ${enabled[*]} " == *" $job "* ]]; then
        systemctl enable --now "$slug-$job.timer"
    else
        systemctl disable --now "$slug-$job.timer"
    fi
done
printf 'Installed TAG: %s\n' "$tag"
docker compose --env-file compose.env exec -T web node -e 'console.log("Deployed SHA: " + process.env.EZIL_GIT_SHA)'
