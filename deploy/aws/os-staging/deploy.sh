#!/usr/bin/env bash
# Author workstation only. Never run from CI.
set -euo pipefail
set +x
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../../.." && pwd)
command_name=${1:-}
tag=${2:-}
approved_sha= receipt_sha256=
[[ ${OS_ENV:-staging} == staging ]] || fail 'This tooling targets staging only.'
case "$command_name" in
    build|upload|install)
        [[ $# == 2 && $tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail 'Expected build|upload|install TAG (a Docker tag).';;
    install-verified)
        [[ $# == 4 && $tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ &&
           $3 =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ && $4 =~ ^[0-9a-f]{64}$ ]] \
            || fail 'Expected staging install-verified TAG APPROVED_SHA RECEIPT_SHA256.'
        approved_sha=$3 receipt_sha256=$4;;
    smoke) [[ $# == 1 ]] || fail 'smoke takes no argument.';;
    *) fail 'Usage: deploy.sh build TAG | upload TAG | install TAG | smoke';;
esac
if [[ $command_name == install || $command_name == install-verified ]]; then
    # Cooperative only: a raw AWS-RunShellScript or an older checkout bypasses this.
    ledger=${OS_STAGING_PROMOTION_LEDGER:-/root/ezil-aws-mum/releases/promotion-ledger.json}
    if [[ -e $ledger || -L $ledger ]]; then
        python3 - "$ledger" <<'PY' || fail 'Promotion ledger is unreadable or has a pending operation; reconcile it before any install.'
import json, sys
entries = json.load(open(sys.argv[1]))["entries"]
sys.exit(1 if entries[-1].get("state") == "pending" else 0)
PY
    fi
fi
aws_call() { aws --region ap-south-1 --no-cli-pager "$@"; }
guard_instance() {
    local instance_name
    if [[ $command_name == install-verified ]]; then
        [[ ${OS_STAGING_INSTANCE_ID:-} == i-014810524754b9ed0 ]] || fail 'Verified install requires the pinned OS staging host.'
        local staging_pin
        staging_pin=$(aws_call ec2 describe-instances --instance-ids "$OS_STAGING_INSTANCE_ID" \
            --query 'Reservations[0].Instances[0].[VpcId, Tags[?Key==`Name`].Value | [0], Tags[?Key==`ezil:env`].Value | [0]]' --output text)
        [[ $staging_pin == $'vpc-0f6bc19fdfd4209aa\tezil-os-billing-staging-host\tbilling-staging' ]] \
            || fail 'Verified staging host identity/VPC mismatch.'
        return
    fi
    [[ ${OS_STAGING_INSTANCE_ID:-} =~ ^i-[0-9a-f]{8,17}$ ]] || fail 'Set OS_STAGING_INSTANCE_ID.'
    instance_name=$(aws_call ec2 describe-instances --instance-ids "$OS_STAGING_INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].Tags[?Key==`Name`].Value | [0]' --output text)
    [[ -n $instance_name && $instance_name != None && ${instance_name,,} != *prod* ]] \
        || fail 'Refusing instance: missing Name tag or Name contains prod.'
}
if [[ -n ${OS_STAGING_INSTANCE_ID:-} || $command_name == install || $command_name == install-verified || $command_name == smoke ]]; then
    guard_instance
fi
if [[ $command_name == upload || $command_name == install || $command_name == install-verified ]]; then
    [[ ${OS_STAGING_ARTIFACT_BUCKET:-} =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] \
        || fail 'Set OS_STAGING_ARTIFACT_BUCKET to the staging artifact bucket.'
    if [[ $command_name == install-verified ]]; then
        [[ $OS_STAGING_ARTIFACT_BUCKET == ezil-main-preview-artifacts-452630323510-aps1 ]] \
            || fail 'Verified install requires the pinned OS staging artifact bucket.'
    fi
fi
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
artifacts="$script_dir/artifacts"

ssm_run() {
    local body=$1 command_id status attempt
    # The payload contains only checked-in scripts and nonsecret identifiers.
    python3 - "$body" "$temporary/ssm.json" <<'PY'
import json, pathlib, sys
body = pathlib.Path(sys.argv[1]).read_text()
payload = {"commands": ["bash <<'OS_STAGING_SSM'\n" + body + "\nOS_STAGING_SSM"],
           "executionTimeout": ["900"]}
encoded = json.dumps(payload)
if len(encoded.encode()) > 60000:
    raise SystemExit("SSM payload too large")
pathlib.Path(sys.argv[2]).write_text(encoded)
PY
    guard_instance
    command_id=$(aws_call ssm send-command --instance-ids "$OS_STAGING_INSTANCE_ID" \
        --document-name AWS-RunShellScript --comment "OS staging $command_name" \
        --parameters "file://$temporary/ssm.json" --timeout-seconds 120 \
        --query Command.CommandId --output text)
    printf 'SSM command: %s\n' "$command_id"
    for ((attempt=0; attempt<210; attempt++)); do
        if ! status=$(aws_call ssm get-command-invocation --command-id "$command_id" \
            --instance-id "$OS_STAGING_INSTANCE_ID" --query Status --output text 2>"$temporary/ssm-error"); then
            if ! python3 - "$temporary/ssm-error" <<'PY'
import pathlib, sys
sys.exit(0 if "InvocationDoesNotExist" in pathlib.Path(sys.argv[1]).read_text() else 1)
PY
            then fail 'Cannot poll SSM; inspect the command ID before retrying.'; fi
            status=Pending
        fi
        case "$status" in
            Success)
                aws_call ssm get-command-invocation --command-id "$command_id" \
                    --instance-id "$OS_STAGING_INSTANCE_ID" --query StandardOutputContent --output text
                return;;
            Pending|InProgress|Delayed) sleep 5;;
            *) fail "SSM ended with $status; inspect the command ID privately.";;
        esac
    done
    fail 'SSM wait expired; the remote command may still be running. Inspect its ID.'
}

case "$command_name" in
    build)
        : "${NEXT_PUBLIC_SUPABASE_URL:?Set the PREVIEW public URL}"
        : "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?Set the PREVIEW public anon key}"
        : "${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:?Set the Stripe test publishable key}"
        GIT_SHA=${GIT_SHA:-$(git -C "$repo_root" rev-parse HEAD)}
        [[ $GIT_SHA =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || fail 'GIT_SHA must be a full commit SHA.'
        python3 "$script_dir/source_provenance.py" snapshot "$repo_root" "$GIT_SHA" "$temporary/source"
        build_root=$temporary/source/context
        export GIT_SHA NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
        mkdir -p "$artifacts"
        for suffix in tar.gz runtime.tar.gz source.json sha256; do
            [[ ! -e $artifacts/$tag.$suffix ]] || fail 'Local tag already exists; use a new tag.'
        done
        # Docker ignores app/.dockerignore for a root context. A temporary
        # Dockerfile-specific ignore applies the allowlist without editing root.
        cp "$build_root/app/Dockerfile" "$temporary/Dockerfile"
        cp "$build_root/app/.dockerignore" "$temporary/Dockerfile.dockerignore"
        public_config_sha=$(python3 -B -c 'import os,sys; sys.path.insert(0,sys.argv[1]); from public_config import identity,fingerprint; print(fingerprint(identity(os.environ["NEXT_PUBLIC_SUPABASE_URL"],os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"])))' "$build_root/deploy/aws/os-staging")
        docker build --platform linux/amd64 --file "$temporary/Dockerfile" \
            --label "work.ezil.public-config-sha256=$public_config_sha" \
            --build-arg NEXT_PUBLIC_SUPABASE_URL --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY \
            --build-arg NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY --build-arg GIT_SHA \
            --tag "ezil-os-staging:$tag" "$build_root"
        docker save "ezil-os-staging:$tag" | gzip -1 >"$temporary/$tag.tar.gz"
        tar -czf "$temporary/$tag.runtime.tar.gz" -C "$build_root/deploy/aws/os-staging" \
            compose.yaml Caddyfile render-env.py cron
        (cd "$temporary" && sha256sum "$tag.tar.gz" "$tag.runtime.tar.gz" >"$tag.sha256")
        python3 "$build_root/deploy/aws/os-staging/source_provenance.py" artifact "$temporary/source" "$temporary" "$tag" staging
        for suffix in tar.gz runtime.tar.gz source.json sha256; do
            mv "$temporary/$tag.$suffix" "$artifacts/$tag.$suffix"
        done
        printf 'Built %s at %s; artifacts: %s\n' "$tag" "$GIT_SHA" "$artifacts";;
    upload)
        [[ -f $artifacts/$tag.sha256 ]] || fail 'Run build TAG first.'
        (cd "$artifacts" && sha256sum --check "$tag.sha256")
        python3 "$script_dir/source_provenance.py" verify "$artifacts" "$tag" staging
        # Conditional writes preserve tags; publish the checksum marker LAST.
        for suffix in tar.gz runtime.tar.gz source.json sha256; do
            aws_call s3api put-object --bucket "$OS_STAGING_ARTIFACT_BUCKET" \
                --key "os-staging/images/$tag.$suffix" --body "$artifacts/$tag.$suffix" \
                --server-side-encryption AES256 --if-none-match '*' >/dev/null
        done
        printf 'Uploaded %s\n' "$tag";;
    install|install-verified)
        python3 - "$script_dir/install-host.sh" "$temporary/host.sh" "$tag" "$OS_STAGING_ARTIFACT_BUCKET" \
            "$approved_sha" "$receipt_sha256" <<'PY_EMBED'
import pathlib, shlex, sys
source, destination, tag, bucket, approved, receipt = sys.argv[1:]
prefix = ''
args = [tag, bucket]
if approved:
    verifier = pathlib.Path(source).with_name('install_receipt.py').read_text()
    prefix = "verify_install_source() {\npython3 - \"$@\" <<'OS_SOURCE_RECEIPT_PY'\n" + verifier + "\nOS_SOURCE_RECEIPT_PY\n}\n"
    args += [approved, receipt]
pathlib.Path(destination).write_text(
    prefix + "set -- " + shlex.join(args) + "\n" + pathlib.Path(source).read_text())
PY_EMBED
        ssm_run "$temporary/host.sh";;
    smoke)
        result=0
        status=$(curl -fsS --connect-timeout 10 --max-time 50 \
            --output "$temporary/health" --write-out '%{http_code}' \
            https://os-staging.ezil.work/api/health) || result=1
        [[ $status == 200 ]] || result=1
        printf 'HTTPS /api/health: %s\n' "$status"
        # No health/version route exists in this checkout. Report the running
        # image's SHA through SSM even when the requested HTTP probe fails.
        cat >"$temporary/host.sh" <<'HOST'
set -euo pipefail
set +x
cd /opt/ezil-os-staging
exec 9>deploy.lock
flock -x 9
docker compose --env-file compose.env exec -T web node -e \
    'const s=process.env.EZIL_GIT_SHA; if(!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s||"")) process.exit(1); console.log("Deployed SHA: "+s)'
HOST
        ssm_run "$temporary/host.sh"
        if [[ $result != 0 ]]; then
            fail 'Health check failed. This checkout has no /api/health or version route; app-owner follow-up required.'
        fi;;
esac
