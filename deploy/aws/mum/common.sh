#!/usr/bin/env bash
# Shared by the operator scripts; no credentials are read from files.
set -euo pipefail
set +x
umask 077

account=452630323510
region=ap-south-1
profile=ezil-admin
bucket=ezil-mum-deploy-assets-452630323510
repository=452630323510.dkr.ecr.ap-south-1.amazonaws.com/ezil-mum-foundation-applicationimages439f25f1-milwdio3nbs6
# identityNames(), infra/app-computers/lib/identity.ts: identity path + role name.
exec_role=arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec
machine=arn:aws:states:ap-south-1:452630323510:stateMachine:ezil-mum-lifecycle
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../../.." && pwd)
release_dir=/root/ezil-aws-mum/release/next
lock_dir=/root/ezil-aws-mum/locks
apply=false

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
show() { printf '+' >&2; printf ' %q' "$@" >&2; printf '\n' >&2; }
aws_read() {
    show aws --profile "$profile" --region "$region" --no-cli-pager "$@"
    aws --profile "$profile" --region "$region" --no-cli-pager "$@"
}
act() { show "$@"; if "$apply"; then "$@"; fi; }
aws_act() { act aws --profile "$profile" --region "$region" --no-cli-pager "$@"; }
json() { python3 "$script_dir/json-tool.py" "$@"; }
require_tools() { local tool; for tool in "$@"; do command -v "$tool" >/dev/null || die "missing tool: $tool"; done; }
require_absolute_release() {
    [[ "$release_dir" == /* && "$release_dir" != / && ! -L "$release_dir" ]] || die 'release directory must be an absolute non-symlink path'
}
assert_identity() {
    [[ "${AWS_REGION:-ap-south-1}" == "$region" && "${AWS_DEFAULT_REGION:-ap-south-1}" == "$region" ]] || die 'region must be ap-south-1'
    local caller
    caller=$(aws_read sts get-caller-identity --query Account --output text)
    [[ "$caller" == "$account" ]] || die "wrong AWS account (expected $account)"
}
init_work() {
    work=$(mktemp -d /tmp/ezil-mum.XXXXXXXX)
    trap 'rm -rf -- "$work"' EXIT
}
lock_operator() {
    require_tools flock
    mkdir -p -- "$lock_dir"
    exec 9>"$lock_dir/operator.lock"
    flock -n 9 || die 'another AMI/lifecycle operator holds the common lock'
}
prepare_synth() {
    # Copy only code and package metadata; never config/ or credential files.
    # npm scripts pin relative cdk.out paths, so give each synth its own cwd.
    synth_project="$work/$1/app-computers"
    mkdir -p -- "$synth_project"
    local item
    for item in package.json package-lock.json cdk.json tsconfig.json bin lib; do
        cp -R -- "$repo_root/infra/app-computers/$item" "$synth_project/"
    done
    ln -s -- "$repo_root/infra/app-computers/node_modules" "$synth_project/node_modules"
}
wait_changeset() {
    local stack=$1 change=$2 result=0
    aws_read cloudformation wait change-set-create-complete --stack-name "$stack" --change-set-name "$change" || result=$?
    aws_read cloudformation describe-change-set --stack-name "$stack" --change-set-name "$change" --include-property-values --output json > "$work/changeset.json"
    return "$result"
}
execute_changeset() {
    aws_act cloudformation execute-change-set --stack-name "$1" --change-set-name "$2"
    aws_read cloudformation wait stack-update-complete --stack-name "$1"
}
