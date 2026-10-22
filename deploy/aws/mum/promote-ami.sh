#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

usage() {
    say 'Usage: promote-ami.sh (--ami <ami-id> | --rollback) [--apply] [--config <path>] [--release-dir <path>]'
}
ami= rollback=false
config=/root/ezil-aws-mum/config/lifecycle.mum.json
while (($#)); do
    case "$1" in
        --ami) (($# >= 2)) || die 'missing AMI'; ami=$2; shift 2 ;;
        --config) (($# >= 2)) || die 'missing config path'; config=$2; shift 2 ;;
        --release-dir) (($# >= 2)) || die 'missing release directory'; release_dir=$2; shift 2 ;;
        --rollback) rollback=true; shift ;;
        --apply) apply=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage; die "unknown argument: $1" ;;
    esac
done
if "$rollback"; then [[ -z "$ami" ]] || die '--rollback uses the journal AMI, omit --ami'
else [[ "$ami" =~ ^ami-[0-9a-f]{17}$ ]] || { usage; die 'valid AMI required'; }; fi
require_tools aws python3 mktemp date realpath npm npx cmp
require_absolute_release
init_work
lock_operator
[[ -f "$config" && ! -L "$config" ]] || die 'lifecycle config must be a regular non-symlink file'
config=$(realpath -- "$config")
release_dir=$(realpath -m -- "$release_dir")
assert_identity
if "$apply"; then mkdir -p -- "$release_dir"; fi
cp -- "$config" "$work/original-config.json"
aws_read stepfunctions list-state-machine-versions --state-machine-arn "$machine" --output json > "$work/versions.json"
if "$rollback"; then
    [[ -f "$release_dir/promotion.json" ]] || die 'rollback journal missing'
    json rollback "$release_dir/promotion.json" "$config" "$work/versions.json" "$work/target.json" "$work/before.json"
else
    [[ ! -e "$release_dir/promotion.json" ]] || die 'promotion journal exists; rollback or archive the prior release directory'
    json copy-config "$config" "$work/before.json"
    json plan-promotion "$config" "$work/versions.json" "$ami" "$work/target.json"
fi
deployment_pair=$(json pair "$work/target.json")
read -r ami version <<< "$deployment_pair"
aws_read ec2 describe-images --image-ids "$ami" --owners "$account" --output json > "$work/image.json"
json image "$work/image.json" "$ami"
stamp=$(date -u +%Y%m%d%H%M%S)
change=lifecycle-$stamp
if "$rollback"; then change=rollback-$stamp; fi
template_uri=s3://$bucket/templates/ezil-mum-$change.json
say "Edit $config: settings.deployment.amiId=$ami; settings.deployment.stateMachineVersionArn=$version"
say 'Check app secret deployment alignment in memory; no secret keys or values are displayed.'
if "$apply"; then
    json secret-check "$work/before.json" "$work/target.json"
    if ! "$rollback"; then json journal "$work/before.json" "$work/target.json" "$release_dir/promotion.json"; fi
    say "Rollback journal: $release_dir/promotion.json (keep until rollout verification finishes)"
fi
# Use the repository's documented synth + publish-assets + S3 + CFN mechanism.
# Baseline and candidate run in separate private copies, including in dry-run.
aws_read cloudformation describe-stacks --stack-name ezil-mum-lifecycle --output json > "$work/lifecycle-before-stack.json"
aws_read cloudformation get-template --stack-name ezil-mum-lifecycle --template-stage Original --output json > "$work/lifecycle-live.json"
json lifecycle-parameters "$work/lifecycle-before-stack.json" "$work/lifecycle-parameters.json"
for phase in before target; do
    prepare_synth "$phase"
    show env "EZIL_LIFECYCLE_CONFIG=$work/$phase.json" npm --prefix "$synth_project" run synth:lifecycle
    EZIL_LIFECYCLE_CONFIG="$work/$phase.json" npm --prefix "$synth_project" run synth:lifecycle
done
baseline_template=$work/before/app-computers/cdk.out/lifecycle/ezil-mum-lifecycle.template.json
candidate_template=$synth_project/cdk.out/lifecycle/ezil-mum-lifecycle.template.json
validation_args=("$work/lifecycle-live.json" "$baseline_template" "$candidate_template" "$work/before.json" "$work/target.json" "$rollback")
json lifecycle-template "${validation_args[@]}"
if "$apply"; then
    cp "$work/lifecycle-live.json" "$release_dir/previous-lifecycle-template.json"
    cp "$baseline_template" "$release_dir/baseline-lifecycle-template.json"
    cp "$candidate_template" "$release_dir/candidate-lifecycle-template.json"
    cmp -s "$config" "$work/original-config.json" || die 'lifecycle config changed since planning'
    json copy-config "$work/target.json" "$config"
fi
(
    cd "$synth_project"
    act npx --no-install cdk publish-assets ezil-mum-lifecycle --app cdk.out/lifecycle --no-lookups --no-notices --profile "$profile"
    aws_act s3 cp cdk.out/lifecycle/ezil-mum-lifecycle.template.json "$template_uri"
)
aws_act cloudformation create-change-set --stack-name ezil-mum-lifecycle --change-set-name "$change" --change-set-type UPDATE \
    --template-url "https://$bucket.s3.$region.amazonaws.com/templates/ezil-mum-$change.json" \
    --role-arn "$exec_role" --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM --parameters "file://$work/lifecycle-parameters.json"
if ! "$apply"; then
    show aws --profile "$profile" --region "$region" cloudformation wait change-set-create-complete --stack-name ezil-mum-lifecycle --change-set-name "$change"
    show aws --profile "$profile" --region "$region" cloudformation describe-change-set --stack-name ezil-mum-lifecycle --change-set-name "$change" --include-property-values --output json
    say 'Allow only synthesized AMI/version property differences; refuse IAM, other resources, deletions and replacements.'
    aws_act cloudformation execute-change-set --stack-name ezil-mum-lifecycle --change-set-name "$change"
    show aws --profile "$profile" --region "$region" cloudformation wait stack-update-complete --stack-name ezil-mum-lifecycle
    show aws --profile "$profile" --region "$region" stepfunctions list-state-machine-versions --state-machine-arn "$machine" --output json
    say "Verify published $version (promotion also requires matching stack WorkflowVersionArn)."
    say 'Under the common app-secret flock: read and edit in memory, re-read VersionId immediately before put-secret-value via stdin, then verify returned VersionId and payload.'
    say 'DRY RUN complete: no config, stack, release record or secret changed.'
    exit 0
fi
printf '%s\n' "$change" > "$release_dir/lifecycle-cs.txt"
has_changes=true
if ! wait_changeset ezil-mum-lifecycle "$change"; then
    "$rollback" || die 'lifecycle change-set creation failed; inspect the journal'
    json lifecycle-noop "$work/changeset.json"
    json lifecycle-equal "$work/lifecycle-live.json" "$candidate_template"
    has_changes=false
fi
cp "$work/changeset.json" "$release_dir/$change.json"
if "$has_changes"; then
    # Verify CloudFormation received this exact candidate, not another template.
    aws_read cloudformation get-template --stack-name ezil-mum-lifecycle --change-set-name "$change" --template-stage Original --output json > "$work/submitted-lifecycle.json"
    json lifecycle-equal "$work/submitted-lifecycle.json" "$candidate_template"
    json lifecycle-changeset "$work/changeset.json" "$work/lifecycle-before-stack.json" "${validation_args[@]}"
fi
# Prevent another publisher from silently taking the predicted version number.
aws_read stepfunctions list-state-machine-versions --state-machine-arn "$machine" --output json > "$work/pre-execute-versions.json"
if ! "$rollback"; then
    json plan-promotion "$work/before.json" "$work/pre-execute-versions.json" "$ami" "$work/rechecked.json" >/dev/null
    cmp -s "$work/rechecked.json" "$work/target.json" || die 'published versions changed; refuse execution and review journal'
fi
cmp -s "$config" "$work/target.json" || die 'lifecycle config changed before execution'
if "$has_changes"; then execute_changeset ezil-mum-lifecycle "$change"; fi
aws_read stepfunctions list-state-machine-versions --state-machine-arn "$machine" --output json > "$work/published.json"
json published "$work/published.json" "$version"
if ! "$rollback"; then
    aws_read cloudformation describe-stacks --stack-name ezil-mum-lifecycle --output json > "$work/lifecycle-stack.json"
    [[ "$(json output "$work/lifecycle-stack.json" WorkflowVersionArn)" == "$version" ]] || die 'published version differs from prediction; app secret unchanged; inspect journal'
fi
json secret-update "$work/before.json" "$work/target.json"
json copy-config "$work/target.json" "$release_dir/promoted-config.json"
say "Deployment configured: $ami at $version. Refresh the staging app from its secret, then run the host canary described in README.md."
