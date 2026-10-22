#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

usage() {
    say 'Usage: rebuild-ami.sh --desktop-image <local-ref> --source-sha <sha> [--recipe-version <x.y.z>] [--apply] [--config <path>] [--release-dir <path>]'
}
desktop_image= source_sha= recipe_version=
config=/root/ezil-aws-mum/config/ami.mum.json
while (($#)); do
    case "$1" in
        --desktop-image) (($# >= 2)) || die 'missing desktop image'; desktop_image=$2; shift 2 ;;
        --source-sha) (($# >= 2)) || die 'missing source SHA'; source_sha=$2; shift 2 ;;
        --recipe-version) (($# >= 2)) && [[ -n "$2" ]] || die 'missing recipe version'; recipe_version=$2; shift 2 ;;
        --config) (($# >= 2)) || die 'missing config path'; config=$2; shift 2 ;;
        --release-dir) (($# >= 2)) || die 'missing release directory'; release_dir=$2; shift 2 ;;
        --apply) apply=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage; die "unknown argument: $1" ;;
    esac
done
[[ -n "$desktop_image" && "$desktop_image" != -* && "$source_sha" =~ ^[0-9a-f]{7,40}$ ]] || { usage; die 'local image and hexadecimal commit SHA are required'; }
require_tools aws docker git python3 mktemp date timeout
require_absolute_release
init_work
if [[ -n "$recipe_version" ]]; then
    require_tools npm realpath cmp wc
    [[ -f "$config" && ! -L "$config" ]] || die 'AMI config must be a regular non-symlink file'
    config=$(realpath -- "$config")
    cp -- "$config" "$work/previous-ami-config.json"
    json plan-ami "$work/previous-ami-config.json" "$recipe_version" "$work/ami.mum.json"
fi
assert_identity
show git -C "$repo_root" rev-parse --verify "$source_sha^{commit}"
full_sha=$(git -C "$repo_root" rev-parse --verify "$source_sha^{commit}")
[[ "$full_sha" =~ ^[0-9a-f]{40}$ ]] || die 'source SHA did not resolve to a full commit'
show git -C "$repo_root" cat-file -t "$full_sha:infra/host-agent"
[[ "$(git -C "$repo_root" cat-file -t "$full_sha:infra/host-agent")" == tree ]] || die 'host-agent tree missing at source SHA'
show docker image inspect --format '{{.Os}}/{{.Architecture}}' "$desktop_image"
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$desktop_image")" == linux/amd64 ]] || die 'desktop image must be linux/amd64'
show docker image inspect --format '{{.Id}}' "$desktop_image"
image_id=$(docker image inspect --format '{{.Id}}' "$desktop_image")
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'invalid local Docker image ID'
stamp=$(date -u +%Y%m%d%H%M%S)
tag=host-${full_sha:0:12}-$stamp
change=ami-${full_sha:0:12}-$stamp
archive=host-agent-$full_sha.tgz
source_uri=s3://$bucket/ami/$archive
aws_read cloudformation describe-stacks --stack-name ezil-mum-ami --output json > "$work/stack.json"
aws_read cloudformation get-template --stack-name ezil-mum-ami --template-stage Original --output json > "$work/template.json"
# A placeholder is used only in the printed dry-run plan. Apply always reads ECR.
digest='<ECR-manifest-digest>'
json parameters "$work/stack.json" "$digest" "$image_id" "$source_uri" "$work/parameters.json"
template_args=(--use-previous-template)
template_uri=
validation_args=()
if [[ -n "$recipe_version" ]]; then
    # README host-AMI step (d), package.json synth:ami, and bin/ami.ts.
    # synth:ami already pins -o cdk.out/ami (CDK rejects a second --output), so synth
    # there and copy the template out. That script disables AWS credentials, lookups
    # and telemetry. It runs in dry-run too, using only this temporary nonsecret config.
    synth_out="$repo_root/infra/app-computers/cdk.out/ami"
    rm -f "$synth_out/ezil-mum-ami.template.json"
    show env "EZIL_AMI_CONFIG=$work/ami.mum.json" npm --prefix "$repo_root/infra/app-computers" run synth:ami -- ezil-mum-ami
    EZIL_AMI_CONFIG="$work/ami.mum.json" npm --prefix "$repo_root/infra/app-computers" run synth:ami -- ezil-mum-ami
    mkdir -p "$work/cdk.out"
    cp "$synth_out/ezil-mum-ami.template.json" "$work/cdk.out/ezil-mum-ami.template.json"
    candidate_template=$work/cdk.out/ezil-mum-ami.template.json
    validation_args=("$candidate_template" "$work/previous-ami-config.json" "$work/ami.mum.json")
    json ami-template "$work/template.json" "${validation_args[@]}"
    template_bytes=$(wc -c < "$candidate_template")
    ((template_bytes <= 1048576)) || die 'synthesized template exceeds the 1048576-byte S3 limit'
    say "Synthesized template: $template_bytes bytes; live template response: $(wc -c < "$work/template.json") bytes"
    if ((template_bytes > 51200)); then
        template_uri=s3://$bucket/ami/templates/$stamp.json
        template_args=(--template-url "https://$bucket.s3.$region.amazonaws.com/ami/templates/$stamp.json")
    else
        template_args=(--template-body "file://$candidate_template")
    fi
fi

say "Desktop tag: $repository:$tag"
if "$apply"; then
    require_tools flock
    lock_release
    [[ ! -e "$release_dir/build-arn.txt" && ! -e "$release_dir/ami-id.txt" ]] || die 'release already contains a build; inspect/resume it or archive this release directory'
    [[ ! -e "$release_dir/ami-update-complete.txt" ]] || die 'release already contains a successful AMI stack update; inspect evidence before another bake'
    if [[ -n "$recipe_version" ]]; then
        cmp -s "$config" "$work/previous-ami-config.json" || die 'AMI config changed since planning'
        cp "$work/previous-ami-config.json" "$release_dir/previous-ami-config.json"
        cp "$work/ami.mum.json" "$release_dir/candidate-ami-config.json"
        cp "$candidate_template" "$release_dir/candidate-ami-template.json"
    fi
    # Docker credentials are temporary; no existing Docker credential file is read.
    mkdir "$work/docker"
    show aws --profile "$profile" --region "$region" ecr get-login-password
    show docker --config "$work/docker" login --username AWS --password-stdin "${repository%%/*}"
    aws --profile "$profile" --region "$region" --no-cli-pager ecr get-login-password |
        docker --config "$work/docker" login --username AWS --password-stdin "${repository%%/*}"
else
    say 'DRY RUN: reads identity, stack and local image; an explicit recipe version also synthesizes a temporary candidate. Remaining commands are printed.'
    say 'aws --profile ezil-admin --region ap-south-1 ecr get-login-password | docker --config <temporary-directory> login --username AWS --password-stdin 452630323510.dkr.ecr.ap-south-1.amazonaws.com'
fi
# Tag the inspected immutable local ID, so a concurrent local retag cannot change it.
act docker tag "$image_id" "$repository:$tag"
act docker --config "$work/docker" push "$repository:$tag"
if "$apply"; then
    aws_read ecr batch-get-image --repository-name "${repository#*/}" --image-ids "imageTag=$tag" --output json > "$work/manifest.json"
    digest=$(json manifest "$work/manifest.json" "$image_id")
    json parameters "$work/stack.json" "$digest" "$image_id" "$source_uri" "$work/parameters.json"
else
    show aws --profile "$profile" --region "$region" ecr batch-get-image --repository-name "${repository#*/}" --image-ids "imageTag=$tag" --output json
    say 'Assert ECR manifest config.digest equals the inspected local Docker image ID; reject image indexes.'
fi
act git -C "$repo_root" archive --format=tar.gz --output "$work/$archive" "$full_sha:infra/host-agent"
aws_act s3 cp "$work/$archive" "$source_uri"
say 'Exact parameter request (only the three allowed values change):'
cat "$work/parameters.json"
if [[ -n "${template_uri:-}" ]]; then aws_act s3 cp "$candidate_template" "$template_uri"; fi
aws_act cloudformation create-change-set --stack-name ezil-mum-ami --change-set-name "$change" --change-set-type UPDATE \
    "${template_args[@]}" --role-arn "$exec_role" --capabilities CAPABILITY_NAMED_IAM --parameters "file://$work/parameters.json"
if ! "$apply"; then
    show aws --profile "$profile" --region "$region" cloudformation wait change-set-create-complete --stack-name ezil-mum-ami --change-set-name "$change"
    show aws --profile "$profile" --region "$region" cloudformation describe-change-set --stack-name ezil-mum-ami --change-set-name "$change" --include-property-values --output json
    say 'Validate every parameter, resolved SSM value and resource change before execution.'
    if [[ -n "$recipe_version" ]]; then
        say 'Permit only Component/Recipe version replacement, dependent Pipeline changes and configurations forced by the version string; refuse all other resources.'
    else
        say 'BLOCKER in current template: Components require replacing an immutable recipe without a version bump. Apply refuses this change set. Supply --recipe-version.'
    fi
    aws_act cloudformation execute-change-set --stack-name ezil-mum-ami --change-set-name "$change"
    show aws --profile "$profile" --region "$region" cloudformation wait stack-update-complete --stack-name ezil-mum-ami
    if [[ -n "$recipe_version" ]]; then say "After successful stack update only: persist version $recipe_version to $config; retain previous-ami-config.json in $release_dir."; fi
    show aws --profile "$profile" --region "$region" cloudformation describe-stacks --stack-name ezil-mum-ami --output json
    aws_act imagebuilder start-image-pipeline-execution --image-pipeline-arn '<stack PipelineArn>' --query imageBuildVersionArn --output text
    show aws --profile "$profile" --region "$region" imagebuilder get-image --image-build-version-arn '<build ARN>' --output json
    say "Poll every 30 seconds, at most 90 minutes; persist build ARN immediately, then AVAILABLE AMI and inputs in $release_dir. Never remove an AMI."
    exit 0
fi
cp "$work/stack.json" "$release_dir/previous-ami-stack.json"
cp "$work/template.json" "$release_dir/ami-template.json"
cp "$work/parameters.json" "$release_dir/ami-parameters.json"
printf '%s\n' "$change" > "$release_dir/ami-changeset.txt"
printf 'ApplicationImageRepositoryUri=%s\nDesktopImageDigest=%s\nDesktopImageId=%s\nDesktopTag=%s\nSourceImage=%s\nSourceSha=%s\nAgentSrcS3Uri=%s\n' \
    "$repository" "$digest" "$image_id" "$tag" "$desktop_image" "$full_sha" "$source_uri" > "$release_dir/desktop.txt"
wait_changeset ezil-mum-ami "$change"
cp "$work/changeset.json" "$release_dir/ami-changeset.json"
json ami-changeset "$work/stack.json" "$work/parameters.json" "$work/changeset.json" "$work/template.json" "${validation_args[@]}"
if [[ -n "$recipe_version" ]]; then
    cmp -s "$config" "$work/previous-ami-config.json" || die 'AMI config changed before execution'
fi
execute_changeset ezil-mum-ami "$change"
if [[ -n "$recipe_version" ]]; then
    printf '%s\n' "$change" > "$release_dir/ami-update-complete.txt"
    json persist-ami "$config" "$release_dir/previous-ami-config.json" "$release_dir/candidate-ami-config.json"
    say "AMI config now uses $recipe_version; previous version saved in $release_dir/previous-ami-config.json"
fi
aws_read cloudformation describe-stacks --stack-name ezil-mum-ami --output json > "$work/updated-stack.json"
pipeline=$(json output "$work/updated-stack.json" PipelineArn)
[[ "$pipeline" == arn:aws:imagebuilder:ap-south-1:452630323510:image-pipeline/* ]] || die 'invalid stack PipelineArn'
build=$(aws_read imagebuilder start-image-pipeline-execution --image-pipeline-arn "$pipeline" --query imageBuildVersionArn --output text)
[[ "$build" == arn:aws:imagebuilder:ap-south-1:452630323510:image/* ]] || die 'invalid Image Builder execution ARN'
printf '%s\n' "$build" > "$release_dir/build-arn.txt"
deadline=$((SECONDS + 5400))
while ((SECONDS < deadline)); do
    remaining=$((deadline - SECONDS))
    show timeout "${remaining}s" aws --profile "$profile" --region "$region" --no-cli-pager imagebuilder get-image --image-build-version-arn "$build" --output json
    timeout "${remaining}s" aws --profile "$profile" --region "$region" --no-cli-pager imagebuilder get-image --image-build-version-arn "$build" --output json > "$work/build.json" || die "Image Builder poll failed/timed out; resume $build; remote execution may still be running"
    cp "$work/build.json" "$release_dir/build.json"
    build_state=$(json build "$release_dir/build.json")
    read -r status ami <<< "$build_state"
    say "Image Builder: $status"
    case "$status" in
        AVAILABLE)
            remaining=$((deadline - SECONDS))
            ((remaining > 0)) || break
            show timeout "${remaining}s" aws --profile "$profile" --region "$region" --no-cli-pager ec2 describe-images --image-ids "$ami" --owners "$account" --output json
            timeout "${remaining}s" aws --profile "$profile" --region "$region" --no-cli-pager ec2 describe-images --image-ids "$ami" --owners "$account" --output json > "$release_dir/image.json"
            json image "$release_dir/image.json" "$ami"
            printf '%s\n' "$ami" > "$release_dir/ami-id.txt"
            say "AMI available: $ami; evidence: $release_dir"
            exit 0 ;;
        FAILED|CANCELLED|DELETED|DEPRECATED|DISABLED) die "Image Builder $status; inspect $release_dir/build.json. No promotion performed." ;;
        PENDING|CREATING|BUILDING|TESTING|DISTRIBUTING|INTEGRATING) ;;
        *) die "unrecognized Image Builder state: $status" ;;
    esac
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || break
    if ((remaining > 30)); then sleep 30; else sleep "$remaining"; fi
done
die "90-minute poll limit reached; remote build continues. Resume get-image with ARN in $release_dir/build-arn.txt; do not start another bake."
