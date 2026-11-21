#!/usr/bin/env bash
# Embedded by deploy.sh into an environment-guarded SSM command; not a CLI entrypoint.
set -euo pipefail
set +x
umask 077
tag=$1
bucket=$2
# Two invocation shapes reach this installer. deploy.sh passes the environment positionally
# (tag bucket ENVIRONMENT [approved receipt]); the reviewed staging SSM document (fixed_document.py) passes
# only tag bucket APPROVED_SHA RECEIPT, with the environment always staging. An environment is the word
# staging|production; an approved source is a 40/64-hex SHA, so a 4-argument call whose $3 is a SHA is the
# fixed-document path. Every other call keeps main's positional contract (and its environment check below).
if [[ $# == 4 && ${3:-} =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    environment=staging approved_source=$3 receipt_hash=${4:-} provenance_args=4
else
    environment=${3:-staging} approved_source=${4:-} receipt_hash=${5:-} provenance_args=5
fi
# Staging keeps its original names; production has its own paths, units, image and S3 prefix.
case $environment in
    staging) slug=ezil-os-staging prefix=os-staging/images other=ezil-os-production;;
    production) slug=ezil-os-production prefix=os/images other=ezil-os-staging;;
    *) echo 'Unknown environment.' >&2; exit 1;;
esac
# Source-provenance (staging install-verified only): an approved source SHA and receipt gate the install.
if [[ -n $approved_source || -n $receipt_hash ]]; then
    [[ $environment == staging && $# == $provenance_args && $approved_source =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ &&
       $receipt_hash =~ ^[0-9a-f]{64}$ ]] && declare -F verify_install_source >/dev/null || exit 1
fi
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
if [[ -n $approved_source ]]; then
    aws --region ap-south-1 --no-cli-pager s3 cp \
        "s3://$bucket/os-staging/images/$tag.source.json" "$temporary/$tag.source.json" --only-show-errors
    verified_image_identities=$(verify_install_source archive-load-identities "$temporary" "$tag" staging "$approved_source" "$receipt_hash")
fi
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
# Release registry: past the environment's frozen legacy limit (staging/mum 32, production/prd 26, as
# json-tool.py legacy_registry_capacity()), install only an image whose build-time
# work.ezil.registry-capacity label (deploy.sh build, from the exact source constant) reads the live
# registry. The label is read from the checksum-verified archive's own image config, BEFORE load, retag,
# runtime extraction or any timer change; an unlabelled image is a legacy-limit reader. After the
# recreate the running app's own /api/health capacity (sha-bound, bounded) must prove the same before timers
# return. At or below the legacy limit nothing is read or required. Prints no secret value.
running_capacity_probe='const s=process.env.EZIL_GIT_SHA;fetch("http://127.0.0.1:3000/api/health",{signal:AbortSignal.timeout(5000),redirect:"error"}).then(r=>r.status===200?r.json():null).then(h=>process.stdout.write(h&&h.ok===true&&typeof s==="string"&&h.sha===s&&Number.isSafeInteger(h.registryCapacity)&&h.registryCapacity>0?String(h.registryCapacity):"unavailable")).catch(()=>process.stdout.write("unavailable"))'
case $environment in
    staging) registry_secret=ezil-os/billing-staging/app registry_legacy=32;;
    production) registry_secret=ezil-os/production/app registry_legacy=26;;
esac
registry_guard() {
EZIL_REGISTRY_SECRET_ID=$registry_secret EZIL_REGISTRY_LEGACY=$registry_legacy \
python3 - "$temporary/$tag.tar.gz" "$@" <<'OS_REGISTRY_CAPACITY_PY'
import json, os, re, subprocess, sys, tarfile
# Exactly the two reviewed environment pairs; anything else refuses before reading.
PAIRS = {("ezil-os/billing-staging/app", "32"), ("ezil-os/production/app", "26")}
SECRET_ID, LEGACY = os.environ.get("EZIL_REGISTRY_SECRET_ID"), os.environ.get("EZIL_REGISTRY_LEGACY")
if (SECRET_ID, LEGACY) not in PAIRS:
    raise SystemExit("Registry capacity guard environment is not a reviewed pair")
LEGACY = int(LEGACY)
archive, source = sys.argv[1], sys.argv[2]
running = sys.argv[3] if len(sys.argv) > 3 else None
if source == "secret":
    # Same instance-role-only environment this script exported for its S3 downloads above.
    if os.environ.get("AWS_SHARED_CREDENTIALS_FILE") != "/dev/null" or os.environ.get("AWS_CONFIG_FILE") != "/dev/null":
        raise SystemExit("Registry capacity guard requires the instance-role-only AWS environment")
    result = subprocess.run(["aws", "--region", "ap-south-1", "--no-cli-pager", "secretsmanager", "get-secret-value",
                             "--secret-id", SECRET_ID, "--output", "json"],
                            stdin=subprocess.DEVNULL, capture_output=True, text=True, check=False, timeout=60)
    if result.returncode:
        raise SystemExit("Registry capacity guard could not read the app secret")
    try:
        raw = json.loads(json.loads(result.stdout)["SecretString"]).get("EZIL_AWS_LIFECYCLE_DEPLOYMENTS")
    except (ValueError, KeyError, TypeError, AttributeError):
        raise SystemExit("Registry capacity guard could not read the app secret") from None
else:
    try:
        with open(source, encoding="utf-8") as rendered:
            lines = [line[len("EZIL_AWS_LIFECYCLE_DEPLOYMENTS="):].rstrip("\n") for line in rendered
                     if line.startswith("EZIL_AWS_LIFECYCLE_DEPLOYMENTS=")]
    except OSError:
        raise SystemExit("Invalid rendered environment") from None
    if len(lines) > 1:
        raise SystemExit("Invalid rendered environment")
    raw = lines[0] if lines else None
try:
    deployments = json.loads(raw) if isinstance(raw, str) else {}
except ValueError:
    raise SystemExit("Invalid release registry") from None
releases = (deployments.get("ap-south-1") or {}).get("releases", []) if isinstance(deployments, dict) else None
if not isinstance(releases, list):
    raise SystemExit("Invalid release registry")
if len(releases) <= LEGACY:
    sys.exit(0)  # every app reads up to the legacy limit
if running is not None:
    capacity = int(running) if re.fullmatch(r"[1-9][0-9]{0,3}", running) else LEGACY
    if capacity < len(releases):
        raise SystemExit("Running app cannot read the live release registry. App replacement already ran; "
                         "stopped timers remain stopped. No automatic rollback.")
    sys.exit(0)
# The checksum-verified archive's own image config (docker save: manifest.json -> Config), read before load.
try:
    small = {}
    with tarfile.open(archive, "r|gz") as bundle:
        for member in bundle:
            if member.isfile() and member.size <= 1 << 20:
                small[member.name] = bundle.extractfile(member).read()
    entries = json.loads(small["manifest.json"])
    if not isinstance(entries, list) or len(entries) != 1:
        raise ValueError("one image required")
    labels = (json.loads(small[entries[0]["Config"]]).get("config") or {}).get("Labels") or {}
except (OSError, EOFError, ValueError, KeyError, TypeError, AttributeError, tarfile.TarError):
    raise SystemExit("Registry capacity guard could not read the image labels") from None
label = labels.get("work.ezil.registry-capacity") if isinstance(labels, dict) else None
capacity = int(label) if isinstance(label, str) and re.fullmatch(r"[1-9][0-9]{0,3}", label) else LEGACY
if capacity < len(releases):
    raise SystemExit("Image cannot read the live release registry; refused before install")
OS_REGISTRY_CAPACITY_PY
}
registry_guard secret
gzip -dc "$temporary/$tag.tar.gz" | docker load >/dev/null
docker image inspect "$slug:$tag" --format '{{.Architecture}}' | \
    python3 -c 'import sys; sys.exit(0 if sys.stdin.read().strip() == "amd64" else 1)'
if [[ -n $approved_source ]]; then
    docker image inspect "$slug:$tag" --format '{{json .}}' > "$temporary/loaded-image.json"
    verified_image_id=$(verify_install_source loaded-identity "$temporary/loaded-image.json" "$approved_source" "$verified_image_identities")
    # Capture only nonsecret recovery identities before overwriting runtime files.
    # These observations do not substitute for the reviewed rollback archives.
    previous_image_ref=unavailable previous_image_id=unavailable previous_source=unavailable
    previous_identity=$(docker container inspect "$slug-web-1" --format '{{.Config.Image}} {{.Image}}' 2>/dev/null) || previous_identity=
    if [[ $previous_identity =~ ^([A-Za-z0-9_./:@-]+)\ (sha256:[0-9a-f]{64})$ ]]; then
        previous_image_ref=${BASH_REMATCH[1]} previous_image_id=${BASH_REMATCH[2]}
        previous_source=$(docker image inspect "$previous_image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null) || previous_source=unavailable
        [[ $previous_source =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || previous_source=unavailable
    fi
fi
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
# The script arrives on bash's stdin (SSM heredoc), so any child that reads stdin would swallow the
# unparsed rest of it (timer restore, footer) and still exit 0. Isolate stdin for every such child.
keys=$(python3 render-env.py "$environment" </dev/null)
# Recheck against exactly what the new container will read; refused here, the old container keeps running.
registry_guard "/etc/$slug/app.env"
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
if [[ -n $approved_source ]]; then
    observed_source=$(docker compose --env-file compose.env exec -T web node -e 'process.stdout.write(process.env.EZIL_GIT_SHA || "")') || observed_source=unavailable
    if [[ $observed_source != "$approved_source" ]]; then
        echo 'Runtime SHA mismatch; release owner must recover. App replacement already ran; stopped timers remain stopped. No automatic rollback.' >&2
        printf 'Candidate: image=%s:%s source=%s image_id=%s receipt_sha256=%s\n' "$slug" "$tag" "$approved_source" "$verified_image_id" "$receipt_hash" >&2
        printf 'Previous observed: image=%s source=%s image_id=%s (use separately reviewed rollback archives).\n' "$previous_image_ref" "$previous_source" "$previous_image_id" >&2
        printf 'Recovery: inspect the SSM command and current container; owner must restore the approved app/runtime pair or repair this candidate, verify health/source, then restore the reviewed timer set: %s\n' "${jobs[*]}" >&2
        exit 1
    fi
fi
# The running app's own sha-bound /api/health capacity must read the registry before any timer returns.
running_capacity=$(docker compose --env-file compose.env exec -T web node -e "$running_capacity_probe" </dev/null) || running_capacity=unavailable
registry_guard "/etc/$slug/app.env" "$running_capacity"
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
