#!/usr/bin/env bash
# PR preview slots on the pinned OS staging host (see README.md). The os-pr-preview
# workflow calls this after `deploy.sh build|upload` of a pr<N>-<sha12> tag. It never
# installs os-staging, takes the staging lease or touches the ezil-os-staging project.
set -euo pipefail
set +x
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
command_name=${1:-}
[[ ${OS_ENV:-staging} == staging ]] || fail 'Preview slots exist only on the staging host.'
case "$command_name" in
    deploy)
        [[ $# == 6 || $# == 7 ]] || fail 'Expected deploy PR SHA TAG IMAGE_ID RECEIPT_SHA256 [RUN]'
        host_args=(deploy --pr "$2" --sha "$3" --tag "$4" --image-id "$5" --receipt-sha256 "$6"
                   --bucket "${OS_STAGING_ARTIFACT_BUCKET:-}" --run "${7:-}"
                   --ttl-hours "${OS_PREVIEW_TTL_HOURS:-48}" --computers "${OS_PREVIEW_COMPUTERS:-off}");;
    publish) [[ $# == 2 && $2 =~ ^pr[0-9]{1,6}-[0-9a-f]{12}$ ]] || fail 'Expected publish TAG (pr<N>-<sha12>)';;
    teardown) [[ $# == 2 ]] || fail 'Expected teardown PR'; host_args=(teardown --pr "$2");;
    status|reap|install-reaper) [[ $# == 1 ]] || fail "$command_name takes no argument"; host_args=("$command_name");;
    *) fail 'Usage: preview.sh publish TAG | deploy PR SHA TAG IMAGE_ID RECEIPT_SHA256 [RUN] | teardown PR | status | reap | install-reaper';;
esac

aws_call() { aws --region ap-south-1 --no-cli-pager "$@"; }
# Same pins as deploy.sh install-verified: the staging host and its artifact bucket only.
[[ ${OS_STAGING_INSTANCE_ID:-} == i-014810524754b9ed0 ]] || fail 'Preview slots require the pinned OS staging host.'
if [[ $command_name == deploy || $command_name == publish ]]; then
    [[ ${OS_STAGING_ARTIFACT_BUCKET:-} == ezil-main-preview-artifacts-452630323510-aps1 ]] \
        || fail 'Preview deploy requires the pinned OS staging artifact bucket.'
fi
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT

if [[ $command_name == publish ]]; then
    tag=$2 artifacts="$here/../artifacts"
    s3_etag() {
        aws_call s3api head-object --bucket "$OS_STAGING_ARTIFACT_BUCKET" --key "os-staging/images/$1" \
            --query ETag --output text 2>/dev/null | tr -d '"' || true
    }
    if [[ -n $(s3_etag "$tag.sha256") ]]; then
        # The checksum marker is written last, so the tag is complete and immutable: the first published
        # build of this head wins and a rebuild (never byte-identical) is discarded.
        aws_call s3 cp "s3://$OS_STAGING_ARTIFACT_BUCKET/os-staging/images/$tag.source.json" \
            "$temporary/published.json" --only-show-errors
        receipt=$(sha256sum "$temporary/published.json" | cut -d' ' -f1)
        printf 'PUBLISHED mode=reuse receipt_sha256=%s\n' "$receipt"
        exit 0
    fi
    (cd "$artifacts" && sha256sum --check --quiet "$tag.sha256")
    for suffix in tar.gz runtime.tar.gz source.json sha256; do
        etag=$(s3_etag "$tag.$suffix")
        if [[ -n $etag ]]; then
            # Left by an interrupted upload: keep it only if it is these exact bytes (single-part SSE-S3 ETag = MD5).
            [[ $etag == $(md5sum "$artifacts/$tag.$suffix" | cut -d' ' -f1) ]] \
                || fail "Partial upload of $tag holds different bytes; the release owner removes os-staging/images/$tag.* before a retry."
        else
            aws_call s3api put-object --bucket "$OS_STAGING_ARTIFACT_BUCKET" --key "os-staging/images/$tag.$suffix" \
                --body "$artifacts/$tag.$suffix" --server-side-encryption AES256 --if-none-match '*' >/dev/null
        fi
    done
    receipt=$(sha256sum "$artifacts/$tag.source.json" | cut -d' ' -f1)
    printf 'PUBLISHED mode=fresh receipt_sha256=%s\n' "$receipt"
    exit 0
fi
pin=$(aws_call ec2 describe-instances --instance-ids "$OS_STAGING_INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].[VpcId, Tags[?Key==`Name`].Value | [0], Tags[?Key==`ezil:env`].Value | [0]]' --output text)
[[ $pin == $'vpc-0f6bc19fdfd4209aa\tezil-os-billing-staging-host\tbilling-staging' ]] \
    || fail 'Staging host identity/VPC mismatch.'

# The payload carries only checked-in code and nonsecret identifiers; the host renders
# the slot env from its own staging env file.
python3 - "$here/preview_host.py" "$here/../install_receipt.py" "$temporary/ssm.json" "${host_args[@]}" <<'PY'
import json, pathlib, shlex, sys
host, receipt, out, *args = sys.argv[1:]
body = "\n".join([
    "set -euo pipefail", "set +x", "umask 077",
    "[[ $EUID == 0 && $(uname -m) == x86_64 ]]",
    "install -d -m 0700 /opt/ezil-os-preview /etc/ezil-os-preview",
    "cat > /opt/ezil-os-preview/install_receipt.py <<'OS_PREVIEW_RECEIPT_PY'",
    pathlib.Path(receipt).read_text().rstrip("\n"), "OS_PREVIEW_RECEIPT_PY",
    "cat > /opt/ezil-os-preview/preview_host.py <<'OS_PREVIEW_HOST_PY'",
    pathlib.Path(host).read_text().rstrip("\n"), "OS_PREVIEW_HOST_PY",
    "exec python3 /opt/ezil-os-preview/preview_host.py " + shlex.join(args),
])
payload = {"commands": ["bash <<'OS_PREVIEW_SSM'\n" + body + "\nOS_PREVIEW_SSM"], "executionTimeout": ["900"]}
encoded = json.dumps(payload)
if len(encoded.encode()) > 60000:
    raise SystemExit("SSM payload too large")
pathlib.Path(out).write_text(encoded)
PY

command_id=$(aws_call ssm send-command --instance-ids "$OS_STAGING_INSTANCE_ID" \
    --document-name AWS-RunShellScript --comment "OS PR preview $command_name" \
    --parameters "file://$temporary/ssm.json" --timeout-seconds 120 \
    --query Command.CommandId --output text)
printf 'SSM command: %s\n' "$command_id"
for ((attempt=0; attempt<210; attempt++)); do
    if ! status=$(aws_call ssm get-command-invocation --command-id "$command_id" \
        --instance-id "$OS_STAGING_INSTANCE_ID" --query Status --output text 2>"$temporary/ssm-error"); then
        grep -q InvocationDoesNotExist "$temporary/ssm-error" || fail 'Cannot poll SSM; inspect the command ID before retrying.'
        status=Pending
    fi
    case "$status" in
        Success|Failed)
            aws_call ssm get-command-invocation --command-id "$command_id" --instance-id "$OS_STAGING_INSTANCE_ID" \
                --query '[StandardOutputContent, StandardErrorContent]' --output text >"$temporary/output"
            # Only the host's one-line result and refusal reach the log, never the full output.
            grep -E '^(PREVIEW_RESULT |Preview refused: )' "$temporary/output" || true
            [[ $status == Success ]] || fail "Preview $command_name failed on the host; inspect SSM command $command_id privately."
            exit 0;;
        Pending|InProgress|Delayed) sleep 5;;
        *) fail "SSM ended with $status; inspect the command ID privately.";;
    esac
done
fail 'SSM wait expired; the remote command may still be running. Inspect its ID.'
