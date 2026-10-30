#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

usage() {
    say 'Usage: promote-ami.sh (--ami <ami-id> | --manifest <release.json> | --rollback) [--apply] [--config <path>] [--release-dir <path>] [--namespace mum|prd]'
}
ami= manifest= rollback=false namespace_arg=mum
config=
while (($#)); do
    case "$1" in
        --manifest) (($# >= 2)) || die 'missing release manifest'; manifest=$2; shift 2 ;;
        --ami) (($# >= 2)) || die 'missing AMI'; ami=$2; shift 2 ;;
        --config) (($# >= 2)) || die 'missing config path'; config=$2; shift 2 ;;
        --release-dir) (($# >= 2)) || die 'missing release directory'; release_dir=$2; shift 2 ;;
        --namespace) (($# >= 2)) || die 'missing namespace'; namespace_arg=$2; shift 2 ;;
        --rollback) rollback=true; shift ;;
        --apply) apply=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage; die "unknown argument: $1" ;;
    esac
done
use_namespace "$namespace_arg"
config=${config:-$config_dir/lifecycle.$namespace.json}
if [[ "$namespace" != mum ]]; then
    # No release tuple: manifest promotion and its rollback (rebase-release.sh) are mum-only.
    [[ -z "$manifest" && ! -e "$release_dir/rebase-promotion.json" ]] || die "$namespace has no rebase tuple; manifest promotion is mum-only"
    [[ "$config" != /root/ezil-aws-mum/* ]] || die "$namespace never reads mum operator configs"
fi
if [[ -n "$manifest" || "$rollback" == true && -f "$release_dir/rebase-promotion.json" ]]; then
    [[ -z "$ami" ]] || die 'manifest promotion cannot use --ami'
    manifest=${manifest:-$release_dir/rebase-release.json}
    operation=promote-canary
    if "$rollback"; then operation=rollback; fi
    options=()
    if "$apply"; then options=(--apply); fi
    exec bash "$script_dir/rebase-release.sh" "$operation" --manifest "$manifest" "${options[@]}"
fi
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
aws_read cloudformation describe-stacks --stack-name "$foundation_stack" --output json > "$work/foundation-before.json"
aws_read cloudformation describe-stack-resource --stack-name "$foundation_stack" --logical-resource-id ComputerLaunchTemplate --output json > "$work/foundation-resource.json"
json foundation-check "$work/foundation-before.json" "$work/foundation-resource.json"
aws_read stepfunctions list-state-machine-versions --state-machine-arn "$machine" --output json > "$work/versions.json"
if "$rollback"; then
    [[ -f "$release_dir/promotion.json" ]] || die 'rollback journal missing'
    json rollback "$release_dir/promotion.json" "$config" "$work/versions.json" "$work/target.json" "$work/before.json"
else
    [[ ! -e "$release_dir/promotion.json" ]] || die 'promotion journal exists; rollback or archive the prior release directory'
    json copy-config "$config" "$work/before.json"
    read -r previous_ami previous_version previous_template_version <<< "$(json pair "$config")"
    aws_read ec2 describe-launch-template-versions --launch-template-id "$launch_template" --versions "$previous_template_version" --output json > "$work/configured-template.json"
    json launch-template-version "$config" "$work/configured-template.json"
    aws_read ec2 describe-launch-template-versions --launch-template-id "$launch_template" --versions '$Latest' --output json > "$work/latest-template-before.json"
    template_version=$(json foundation-plan "$work/foundation-before.json" "$work/latest-template-before.json" "$ami" "$work/foundation-parameters.json")
    json plan-promotion "$config" "$work/versions.json" "$ami" "$template_version" "$work/target.json"
fi
deployment_pair=$(json pair "$work/target.json")
read -r ami version template_version <<< "$deployment_pair"
if "$rollback"; then
    # Rollback pins the retained version; it never modifies/deletes template versions.
    aws_read ec2 describe-launch-template-versions --launch-template-id "$launch_template" --versions "$template_version" --output json > "$work/rollback-template.json"
    json launch-template-version "$work/target.json" "$work/rollback-template.json"
fi
aws_read ec2 describe-images --image-ids "$ami" --owners "$account" --output json > "$work/image.json"
json image "$work/image.json" "$ami"
stamp=$(date -u +%Y%m%d%H%M%S)
foundation_change=foundation-ami-$stamp
change=lifecycle-$stamp
if "$rollback"; then change=rollback-$stamp; fi
template_uri=s3://$bucket/templates/ezil-$namespace-$change.json
say "Plan $config: settings.deployment.amiId=$ami; settings.deployment.launchTemplateVersion=$template_version; settings.deployment.stateMachineVersionArn=$version"
say 'Check app secret deployment alignment in memory; no secret keys or values are displayed.'
if "$apply"; then
    json secret-check "$work/before.json" "$work/target.json"
    if ! "$rollback"; then json journal "$work/before.json" "$work/target.json" "$release_dir/promotion.json"; fi
    say "Rollback journal: $release_dir/promotion.json (keep until rollout verification finishes)"
fi
# Use the repository's documented synth + publish-assets + S3 + CFN mechanism.
# Baseline and candidate run in separate private copies, including in dry-run.
aws_read cloudformation describe-stacks --stack-name "$lifecycle_stack" --output json > "$work/lifecycle-before-stack.json"
aws_read cloudformation get-template --stack-name "$lifecycle_stack" --template-stage Original --output json > "$work/lifecycle-live.json"
json lifecycle-parameters "$work/lifecycle-before-stack.json" "$work/lifecycle-parameters.json"
for phase in before target; do
    prepare_synth "$phase"
    show env "EZIL_LIFECYCLE_CONFIG=$work/$phase.json" npm --prefix "$synth_project" run synth:lifecycle
    EZIL_LIFECYCLE_CONFIG="$work/$phase.json" npm --prefix "$synth_project" run synth:lifecycle
done
baseline_template=$work/before/app-computers/cdk.out/lifecycle/$lifecycle_stack.template.json
candidate_template=$synth_project/cdk.out/lifecycle/$lifecycle_stack.template.json
# The live stack was deployed with CDK version reporting (an AWS::CDK::Metadata resource);
# the repo's synth disables it. Carry the live metadata resource into both syntheses so
# drift checks compare like with like and the change set does not remove it.
json carry-cdk-metadata "$work/lifecycle-live.json" "$baseline_template" "$candidate_template"
validation_args=("$work/lifecycle-live.json" "$baseline_template" "$candidate_template" "$work/before.json" "$work/target.json" "$rollback")
json lifecycle-template "${validation_args[@]}"
if ! "$rollback"; then
    # CloudFormation's change set is the server-side dry run. Validate its entire
    # resource/parameter diff before executing it, even when --apply was requested.
    aws_act cloudformation create-change-set --stack-name "$foundation_stack" --change-set-name "$foundation_change" --change-set-type UPDATE \
        --use-previous-template --role-arn "$exec_role" --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
        --parameters "file://$work/foundation-parameters.json"
    if "$apply"; then
        printf '%s\n' "$foundation_change" > "$release_dir/foundation-cs.txt"
        cp "$work/foundation-before.json" "$release_dir/previous-foundation-stack.json"
        cp "$work/latest-template-before.json" "$release_dir/previous-latest-launch-template.json"
        wait_changeset "$foundation_stack" "$foundation_change" || die 'foundation change-set creation failed; inspect the journal'
        cp "$work/changeset.json" "$release_dir/$foundation_change.json"
        json foundation-changeset "$work/changeset.json" "$work/foundation-before.json" "$work/foundation-parameters.json"
        aws_read cloudformation describe-stacks --stack-name "$foundation_stack" --output json > "$work/foundation-recheck.json"
        aws_read ec2 describe-launch-template-versions --launch-template-id "$launch_template" --versions '$Latest' --output json > "$work/latest-template-recheck.json"
        json foundation-unchanged "$work/foundation-before.json" "$work/foundation-recheck.json" "$work/latest-template-before.json" "$work/latest-template-recheck.json"
        cmp -s "$config" "$work/original-config.json" || die 'lifecycle config changed before foundation execution'
        execute_changeset "$foundation_stack" "$foundation_change"
        aws_read cloudformation describe-stacks --stack-name "$foundation_stack" --output json > "$work/foundation-after.json"
        aws_read cloudformation describe-stack-resource --stack-name "$foundation_stack" --logical-resource-id ComputerLaunchTemplate --output json > "$work/foundation-resource-after.json"
        aws_read ec2 describe-launch-template-versions --launch-template-id "$launch_template" --versions '$Latest' --output json > "$work/latest-template-after.json"
        json foundation-readback "$work/foundation-before.json" "$work/foundation-after.json" "$work/foundation-resource-after.json" \
            "$work/latest-template-before.json" "$work/latest-template-after.json" "$work/target.json"
        cp "$work/foundation-after.json" "$release_dir/promoted-foundation-stack.json"
        cp "$work/latest-template-after.json" "$release_dir/promoted-launch-template.json"
        say "Foundation launch-template version $template_version read back and verified for $ami."
    else
        show aws --profile "$profile" --region "$region" cloudformation wait change-set-create-complete --stack-name "$foundation_stack" --change-set-name "$foundation_change"
        show aws --profile "$profile" --region "$region" cloudformation describe-change-set --stack-name "$foundation_stack" --change-set-name "$foundation_change" --include-property-values --output json
        say 'Require only ComputerLaunchTemplate / LaunchTemplateData and HostAmiId to change, with the existing execution role.'
        aws_act cloudformation execute-change-set --stack-name "$foundation_stack" --change-set-name "$foundation_change"
        show aws --profile "$profile" --region "$region" cloudformation wait stack-update-complete --stack-name "$foundation_stack"
        show aws --profile "$profile" --region "$region" ec2 describe-launch-template-versions --launch-template-id "$launch_template" --versions '$Latest' --output json
        say "Require read-back version $template_version, ImageId=$ami and all other launch data unchanged before lifecycle publication."
    fi
fi
say "Edit $config: AMI=$ami; launchTemplateVersion=$template_version; workflow=$version"
if "$apply"; then
    cp "$work/lifecycle-live.json" "$release_dir/previous-lifecycle-template.json"
    cp "$baseline_template" "$release_dir/baseline-lifecycle-template.json"
    cp "$candidate_template" "$release_dir/candidate-lifecycle-template.json"
    cmp -s "$config" "$work/original-config.json" || die 'lifecycle config changed since planning'
    json copy-config "$work/target.json" "$config"
fi
(
    cd "$synth_project"
    act npx --no-install cdk publish-assets --unstable=publish-assets "$lifecycle_stack" --app cdk.out/lifecycle --no-lookups --no-notices --profile "$profile"
    aws_act s3 cp "cdk.out/lifecycle/$lifecycle_stack.template.json" "$template_uri"
)
aws_act cloudformation create-change-set --stack-name "$lifecycle_stack" --change-set-name "$change" --change-set-type UPDATE \
    --template-url "https://$bucket.s3.$region.amazonaws.com/templates/ezil-$namespace-$change.json" \
    --role-arn "$exec_role" --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM --parameters "file://$work/lifecycle-parameters.json"
if ! "$apply"; then
    show aws --profile "$profile" --region "$region" cloudformation wait change-set-create-complete --stack-name "$lifecycle_stack" --change-set-name "$change"
    show aws --profile "$profile" --region "$region" cloudformation describe-change-set --stack-name "$lifecycle_stack" --change-set-name "$change" --include-property-values --output json
    say 'Require exact AMI/launch-template/workflow substitutions and matching change-set details; allow only the validated Lambda Version Add/Remove pair.'
    aws_act cloudformation execute-change-set --stack-name "$lifecycle_stack" --change-set-name "$change"
    show aws --profile "$profile" --region "$region" cloudformation wait stack-update-complete --stack-name "$lifecycle_stack"
    show aws --profile "$profile" --region "$region" stepfunctions list-state-machine-versions --state-machine-arn "$machine" --output json
    say "Verify published $version (promotion also requires matching stack WorkflowVersionArn)."
    say 'Under the common app-secret flock: read and edit in memory, re-read VersionId immediately before put-secret-value via a private temporary request file, then verify returned VersionId and payload.'
    say 'DRY RUN complete: no config, stack, release record or secret changed.'
    exit 0
fi
printf '%s\n' "$change" > "$release_dir/lifecycle-cs.txt"
has_changes=true
if ! wait_changeset "$lifecycle_stack" "$change"; then
    "$rollback" || die 'lifecycle change-set creation failed; inspect the journal'
    json lifecycle-noop "$work/changeset.json"
    json lifecycle-equal "$work/lifecycle-live.json" "$candidate_template"
    has_changes=false
fi
cp "$work/changeset.json" "$release_dir/$change.json"
if "$has_changes"; then
    # Verify CloudFormation received this exact candidate, not another template.
    aws_read cloudformation get-template --stack-name "$lifecycle_stack" --change-set-name "$change" --template-stage Original --output json > "$work/submitted-lifecycle.json"
    json lifecycle-equal "$work/submitted-lifecycle.json" "$candidate_template"
    json lifecycle-changeset "$work/changeset.json" "$work/lifecycle-before-stack.json" "${validation_args[@]}"
fi
# Prevent another publisher from silently taking the predicted version number.
aws_read stepfunctions list-state-machine-versions --state-machine-arn "$machine" --output json > "$work/pre-execute-versions.json"
if ! "$rollback"; then
    json plan-promotion "$work/before.json" "$work/pre-execute-versions.json" "$ami" "$template_version" "$work/rechecked.json" >/dev/null
    cmp -s "$work/rechecked.json" "$work/target.json" || die 'published versions changed; refuse execution and review journal'
fi
cmp -s "$config" "$work/target.json" || die 'lifecycle config changed before execution'
# Check the exact retained/published version again before enabling lifecycle use.
aws_read ec2 describe-launch-template-versions --launch-template-id "$launch_template" --versions "$template_version" --output json > "$work/target-template-recheck.json"
json launch-template-version "$work/target.json" "$work/target-template-recheck.json"
if "$has_changes"; then execute_changeset "$lifecycle_stack" "$change"; fi
aws_read stepfunctions list-state-machine-versions --state-machine-arn "$machine" --output json > "$work/published.json"
json published "$work/published.json" "$version"
if ! "$rollback"; then
    aws_read cloudformation describe-stacks --stack-name "$lifecycle_stack" --output json > "$work/lifecycle-stack.json"
    [[ "$(json output "$work/lifecycle-stack.json" WorkflowVersionArn)" == "$version" ]] || die 'published version differs from prediction; app secret unchanged; inspect journal'
fi
json secret-update "$work/before.json" "$work/target.json"
json copy-config "$work/target.json" "$release_dir/promoted-config.json"
say "Deployment configured: $ami, launch-template version $template_version, workflow $version. Refresh the $app_environment app from its secret, then run the host canary described in README.md."
