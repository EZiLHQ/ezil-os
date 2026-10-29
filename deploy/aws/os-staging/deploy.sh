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
# OS_ENV selects the target. Unset (or staging) is the original staging flow;
# production never reads the OS_STAGING_* variables and has its own pins.
environment=${OS_ENV:-staging}
case "$environment" in
    staging)
        image=ezil-os-staging prefix=os-staging/images artifacts="$script_dir/artifacts"
        instance_id=${OS_STAGING_INSTANCE_ID:-} smoke_host=os-staging.ezil.work;;
    production)
        image=ezil-os-production prefix=os/images artifacts="$script_dir/artifacts/production"
        instance_id=${OS_PRODUCTION_INSTANCE_ID:-} smoke_host=os-prod.ezil.work
        # The only artifacts bucket the prod VPC's S3 endpoint allows.
        bucket=ezil-main-prod-artifacts-452630323510-aps1;;
    *) fail 'OS_ENV must be staging (the default) or production.';;
esac
case "$command_name" in
    build|upload|install)
        [[ $# == 2 && $tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || fail 'Expected build|upload|install TAG (a Docker tag).';;
    smoke)
        if [[ $environment == production && $# == 2 && $tag == public ]]; then
            smoke_host=os.ezil.work  # After cutover only; before it this name is still Vercel.
        else
            [[ $# == 1 ]] || fail 'smoke takes no argument.'
        fi;;
    *) fail 'Usage: [OS_ENV=production] deploy.sh build TAG | upload TAG | install TAG | smoke (production: smoke [public])';;
esac
aws_call() { aws --region ap-south-1 --no-cli-pager "$@"; }
guard_instance() {
    local instance_name
    if [[ $environment == production ]]; then
        guard_production_instance
        return
    fi
    [[ ${OS_STAGING_INSTANCE_ID:-} =~ ^i-[0-9a-f]{8,17}$ ]] || fail 'Set OS_STAGING_INSTANCE_ID.'
    instance_name=$(aws_call ec2 describe-instances --instance-ids "$OS_STAGING_INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].Tags[?Key==`Name`].Value | [0]' --output text)
    [[ -n $instance_name && $instance_name != None && ${instance_name,,} != *prod* ]] \
        || fail 'Refusing instance: missing Name tag or Name contains prod.'
}
guard_production_instance() {
    local pinned
    [[ $instance_id =~ ^i-[0-9a-f]{8,17}$ ]] || fail 'Set OS_PRODUCTION_INSTANCE_ID.'
    [[ $instance_id != i-09012068d96166828 ]] || fail 'Refusing the production database host.'
    # Pin: exact Name, environment tag and the prod VPC (tab-separated text output);
    # the public IP is kept so smoke can prove which host answered.
    pinned=$(aws_call ec2 describe-instances --instance-ids "$instance_id" \
        --query 'Reservations[0].Instances[0].[VpcId, Tags[?Key==`Name`].Value | [0], Tags[?Key==`ezil:env`].Value | [0], PublicIpAddress]' \
        --output text)
    [[ ${pinned%$'\t'*} == $'vpc-040bdd6e09e35425f\tezil-os-prod-host\tproduction' ]] \
        || fail 'Refusing instance: production needs Name ezil-os-prod-host, tag ezil:env=production and VPC vpc-040bdd6e09e35425f.'
    public_ip=${pinned##*$'\t'}
}
if [[ -n $instance_id || $command_name == install || $command_name == smoke ]]; then
    guard_instance
fi
if [[ $environment == staging && ( $command_name == upload || $command_name == install ) ]]; then
    [[ ${OS_STAGING_ARTIFACT_BUCKET:-} =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] \
        || fail 'Set OS_STAGING_ARTIFACT_BUCKET to the staging artifact bucket.'
    [[ $OS_STAGING_ARTIFACT_BUCKET != ezil-main-prod-* ]] || fail 'Refusing a production bucket for staging.'
    bucket=$OS_STAGING_ARTIFACT_BUCKET
fi
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

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
    command_id=$(aws_call ssm send-command --instance-ids "$instance_id" \
        --document-name AWS-RunShellScript --comment "OS $environment $command_name" \
        --parameters "file://$temporary/ssm.json" --timeout-seconds 120 \
        --query Command.CommandId --output text)
    printf 'SSM command: %s\n' "$command_id"
    for ((attempt=0; attempt<210; attempt++)); do
        if ! status=$(aws_call ssm get-command-invocation --command-id "$command_id" \
            --instance-id "$instance_id" --query Status --output text 2>"$temporary/ssm-error"); then
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
                    --instance-id "$instance_id" --query StandardOutputContent --output text
                return;;
            Pending|InProgress|Delayed) sleep 5;;
            *) fail "SSM ended with $status; inspect the command ID privately.";;
        esac
    done
    fail 'SSM wait expired; the remote command may still be running. Inspect its ID.'
}

case "$command_name" in
    build)
        if [[ $environment == production ]]; then
            # Baked into the client bundle; changing it later needs a rebuild.
            [[ ${NEXT_PUBLIC_SUPABASE_URL:-} == https://db.ezil.work ]] \
                || fail 'Production bakes NEXT_PUBLIC_SUPABASE_URL=https://db.ezil.work.'
            : "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?Set the production public anon key}"
            [[ ${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:-} == pk_live_* ]] \
                || fail 'Production needs the Stripe live publishable key (pk_live_).'
        fi
        : "${NEXT_PUBLIC_SUPABASE_URL:?Set the PREVIEW public URL}"
        : "${NEXT_PUBLIC_SUPABASE_ANON_KEY:?Set the PREVIEW public anon key}"
        : "${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:?Set the Stripe test publishable key}"
        if [[ $environment == staging ]]; then
            [[ $NEXT_PUBLIC_SUPABASE_URL != *db.ezil.work* && $NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY != pk_live_* ]] \
                || fail 'Staging refuses the production API URL and Stripe live keys.'
        fi
        GIT_SHA=${GIT_SHA:-$(git -C "$repo_root" rev-parse HEAD)}
        [[ $GIT_SHA =~ ^[0-9a-f]{40}$|^[0-9a-f]{64}$ ]] || fail 'GIT_SHA must be a full commit SHA.'
        export GIT_SHA NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
        mkdir -p "$artifacts"
        for suffix in tar.gz runtime.tar.gz sha256; do
            [[ ! -e $artifacts/$tag.$suffix ]] || fail 'Local tag already exists; use a new tag.'
        done
        # Docker ignores app/.dockerignore for a root context. A temporary
        # Dockerfile-specific ignore applies the allowlist without editing root.
        cp "$repo_root/app/Dockerfile" "$temporary/Dockerfile"
        cp "$repo_root/app/.dockerignore" "$temporary/Dockerfile.dockerignore"
        docker build --platform linux/amd64 --file "$temporary/Dockerfile" \
            --build-arg NEXT_PUBLIC_SUPABASE_URL --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY \
            --build-arg NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY --build-arg GIT_SHA \
            --tag "$image:$tag" "$repo_root"
        docker save "$image:$tag" | gzip -1 >"$temporary/$tag.tar.gz"
        runtime=$script_dir
        if [[ $environment == production ]]; then
            runtime=$temporary/runtime
            python3 "$script_dir/render-runtime.py" "$script_dir" "$runtime"
        fi
        tar -czf "$temporary/$tag.runtime.tar.gz" -C "$runtime" \
            compose.yaml Caddyfile render-env.py cron
        (cd "$temporary" && sha256sum "$tag.tar.gz" "$tag.runtime.tar.gz" >"$tag.sha256")
        for suffix in tar.gz runtime.tar.gz sha256; do
            mv "$temporary/$tag.$suffix" "$artifacts/$tag.$suffix"
        done
        printf 'Built %s at %s; artifacts: %s\n' "$tag" "$GIT_SHA" "$artifacts";;
    upload)
        [[ -f $artifacts/$tag.sha256 ]] || fail 'Run build TAG first.'
        (cd "$artifacts" && sha256sum --check "$tag.sha256")
        # Conditional writes preserve tags; publish the checksum marker LAST.
        for suffix in tar.gz runtime.tar.gz sha256; do
            aws_call s3api put-object --bucket "$bucket" \
                --key "$prefix/$tag.$suffix" --body "$artifacts/$tag.$suffix" \
                --server-side-encryption AES256 --if-none-match '*' >/dev/null
        done
        printf 'Uploaded %s\n' "$tag";;
    install)
        python3 - "$script_dir/install-host.sh" "$temporary/host.sh" "$tag" "$bucket" "$environment" <<'PY'
import pathlib, shlex, sys
source, destination, tag, bucket, environment = sys.argv[1:]
pathlib.Path(destination).write_text(
    "set -- " + shlex.join([tag, bucket, environment]) + "\n" + pathlib.Path(source).read_text())
PY
        ssm_run "$temporary/host.sh";;
    smoke)
        result=0
        write_out='%{http_code}'
        if [[ $environment == production ]]; then
            write_out='%{http_code} %{remote_ip}'  # Run without an HTTP(S) proxy.
        fi
        status=$(curl -fsS --connect-timeout 10 --max-time 50 \
            --output "$temporary/health" --write-out "$write_out" \
            "https://$smoke_host/api/health") || result=1
        [[ ${status%% *} == 200 ]] || result=1
        printf 'HTTPS /api/health: %s\n' "$status"
        # Report the running image's SHA through SSM even when the HTTP probe fails.
        { printf 'set -euo pipefail\nset +x\ncd /opt/%s\n' "$image"; cat <<'HOST'; } >"$temporary/host.sh"
exec 9>deploy.lock
flock -x 9
docker compose --env-file compose.env exec -T web node -e \
    'const s=process.env.EZIL_GIT_SHA; if(!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s||"")) process.exit(1); console.log("Deployed SHA: "+s)'
HOST
        if [[ $environment == staging ]]; then
            ssm_run "$temporary/host.sh"
            if [[ $result != 0 ]]; then
                fail 'Health check failed. This checkout has no /api/health or version route; app-owner follow-up required.'
            fi
        else
            ssm_run "$temporary/host.sh" | tee "$temporary/deployed"
            # This host must answer (Vercel may serve the same SHA) with the SHA it runs.
            python3 - "$temporary/health" "$temporary/deployed" "${status#* }" "$public_ip" <<'PY' || result=1
import json, pathlib, re, sys
try:
    served = json.loads(pathlib.Path(sys.argv[1]).read_text()).get("sha")
except (OSError, ValueError, AttributeError):
    served = None
deployed = re.findall(r"^Deployed SHA: ([0-9a-f]{40}|[0-9a-f]{64})$", pathlib.Path(sys.argv[2]).read_text(), re.M)
print(f"Served SHA: {served}; answered by {sys.argv[3] or 'nobody'}; instance public IP {sys.argv[4]}")
sys.exit(0 if deployed and served == deployed[-1] and sys.argv[3] == sys.argv[4] else 1)
PY
            [[ $result == 0 ]] || fail "Smoke failed: https://$smoke_host/api/health must return 200 from this instance's public IP with its deployed SHA."
        fi;;
esac
