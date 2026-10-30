#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"

usage() {
    say 'Usage: rebuild-ami.sh --desktop-image <local-ref> --source-sha <sha> [--recipe-version <x.y.z>] [--reviewed-base-ami <ami-id>] [--previous-desktop-image-ref <immutable-ref> --previous-desktop-image-id <id> --previous-release <manifest>] [--maintenance-release <source-manifest>] [--deployed-release <manifest>] [--apply] [--config <path>] [--release-dir <path>] [--namespace mum|prd]'
}
desktop_image= source_sha= recipe_version= previous_ref= previous_id= previous_release= maintenance_release= deployed_release=
reviewed_base_ami= namespace_arg=mum
config=
while (($#)); do
    case "$1" in
        --desktop-image) (($# >= 2)) || die 'missing desktop image'; desktop_image=$2; shift 2 ;;
        --source-sha) (($# >= 2)) || die 'missing source SHA'; source_sha=$2; shift 2 ;;
        --recipe-version) (($# >= 2)) && [[ -n "$2" ]] || die 'missing recipe version'; recipe_version=$2; shift 2 ;;
        --reviewed-base-ami) (($# >= 2)) && [[ "$2" =~ ^ami-[0-9a-f]{17}$ ]] || die 'reviewed base AMI must be an AMI ID'; reviewed_base_ami=$2; shift 2 ;;
        --previous-desktop-image-ref) (($# >= 2)) && [[ -n "$2" ]] || die 'missing previous image reference'; previous_ref=$2; shift 2 ;;
        --previous-desktop-image-id) (($# >= 2)) && [[ -n "$2" ]] || die 'missing previous image ID'; previous_id=$2; shift 2 ;;
        --maintenance-release) (($# >= 2)) || die 'missing maintenance source release'; maintenance_release=$2; shift 2 ;;
        --previous-release) (($# >= 2)) || die 'missing previous release manifest'; previous_release=$2; shift 2 ;;
        --deployed-release) (($# >= 2)) || die 'missing deployed release manifest'; deployed_release=$2; shift 2 ;;
        --config) (($# >= 2)) || die 'missing config path'; config=$2; shift 2 ;;
        --release-dir) (($# >= 2)) || die 'missing release directory'; release_dir=$2; shift 2 ;;
        --namespace) (($# >= 2)) || die 'missing namespace'; namespace_arg=$2; shift 2 ;;
        --apply) apply=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage; die "unknown argument: $1" ;;
    esac
done
[[ -n "$desktop_image" && "$desktop_image" != -* && "$source_sha" =~ ^[0-9a-f]{7,40}$ ]] || { usage; die 'local image and hexadecimal commit SHA are required'; }
[[ -n "$previous_ref" && -n "$previous_id" || -z "$previous_ref" && -z "$previous_id" ]] || die 'previous reference and ID must be supplied together'
[[ -z "$previous_release" || -n "$previous_ref" ]] || die 'previous release requires previous image pair'
[[ -z "$maintenance_release" || -z "$previous_ref$previous_id$previous_release" ]] || die 'maintenance bake cannot include a previous lower'
use_namespace "$namespace_arg"
config=${config:-$config_dir/ami.$namespace.json}
if [[ "$namespace" != mum ]]; then
    [[ -z "$previous_ref$previous_id$previous_release$maintenance_release$deployed_release" ]] || die "$namespace has no rebase tuple; previous/maintenance/deployed release bakes are mum-only"
    [[ "$config" != /root/ezil-aws-mum/* ]] || die "$namespace never reads mum operator configs"
fi
require_tools aws docker git python3 mktemp date timeout
require_absolute_release
init_work
lock_operator
if [[ -n "$recipe_version" ]]; then
    require_tools npm realpath cmp wc
    [[ -f "$config" && ! -L "$config" ]] || die 'AMI config must be a regular non-symlink file'
    config=$(realpath -- "$config")
    cp -- "$config" "$work/previous-ami-config.json"
    json plan-ami "$work/previous-ami-config.json" "$recipe_version" "$work/ami.$namespace.json"
fi
assert_identity
if [[ -n "$previous_ref$maintenance_release$deployed_release" ]]; then
    [[ -n "$deployed_release" && -f "$deployed_release" && ! -L "$deployed_release" ]] || die 'deployed release manifest required (--deployed-release)'
    cp -- "$deployed_release" "$work/deployed-release.json"
    json secret-predecessor "$work/deployed-release.json"
fi
previous_args=()
if [[ -n "$recipe_version" ]]; then previous_args=("" ""); fi
if [[ -n "$previous_ref" ]]; then
    previous_release=${previous_release:-$release_dir/previous-rebase-release.json}
    [[ -f "$previous_release" && ! -L "$previous_release" ]] || die 'retained image predecessor required (--previous-release)'
    json previous-release "$previous_release" "$previous_ref" "$previous_id"
    cp -- "$previous_release" "$work/previous-rebase-release.json"
    json secret-retained "$work/previous-rebase-release.json"
    previous_args=("$previous_ref" "$previous_id")
fi
if [[ -n "$maintenance_release" ]]; then
    [[ -f "$maintenance_release" && ! -L "$maintenance_release" && -n "$recipe_version" ]] || die 'maintenance source and new recipe version required'
    cp -- "$maintenance_release" "$work/maintenance-source-release.json"
    previous_args=("" "")
fi
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
if [[ -n "$maintenance_release" ]]; then
    json maintenance-agent "$work/maintenance-source-release.json" "$full_sha"
    [[ "$(git -C "$repo_root" cat-file -t "$full_sha:infra/host-agent/lib/ezil_host/maintenance.py")" == blob ]] || die 'reviewed agent lacks maintenance rebind support'
fi
stamp=$(date -u +%Y%m%d%H%M%S)
tag=host-${full_sha:0:12}-$stamp
change=ami-${full_sha:0:12}-$stamp
archive=host-agent-$full_sha.tgz
source_uri=s3://$bucket/ami/$archive
aws_read cloudformation describe-stacks --stack-name "$ami_stack" --output json > "$work/stack.json"
aws_read cloudformation get-template --stack-name "$ami_stack" --template-stage Original --output json > "$work/template.json"
if [[ -n "$previous_ref" && -z "$recipe_version" ]]; then
    json previous-parameters "$work/stack.json"
fi
# A placeholder is used only in the printed dry-run plan. Apply always reads ECR.
digest='<ECR-manifest-digest>'
json parameters "$work/stack.json" "$digest" "$image_id" "$source_uri" "$work/parameters.json" "${previous_args[@]}"
template_args=(--use-previous-template)
template_uri=
# Follow the stack's own deployment role: ezil-<ns>-ami is created with caller
# credentials (no RoleARN); passing the exec role would re-associate it with a role
# that cannot resolve the public Ubuntu SSM parameter.
stack_role=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["Stacks"][0].get("RoleARN") or "")' "$work/stack.json")
role_args=()
if [[ -n "$stack_role" ]]; then
    [[ "$stack_role" == "$exec_role" ]] || die "$ami_stack is bound to an unexpected role: $stack_role"
    role_args=(--role-arn "$exec_role")
fi
validation_args=()
if [[ -n "$recipe_version" ]]; then
    # README host-AMI step (d), package.json synth:ami, and bin/ami.ts.
    # synth:ami already pins -o cdk.out/ami; do not pass a second --output.
    prepare_synth ami
    show env "EZIL_AMI_CONFIG=$work/ami.$namespace.json" npm --prefix "$synth_project" run synth:ami -- "$ami_stack"
    EZIL_AMI_CONFIG="$work/ami.$namespace.json" npm --prefix "$synth_project" run synth:ami -- "$ami_stack"
    candidate_template=$synth_project/cdk.out/ami/$ami_stack.template.json
    validation_args=("$candidate_template" "$work/previous-ami-config.json" "$work/ami.$namespace.json")
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
    mkdir -p -- "$release_dir"
    [[ ! -e "$release_dir/build-arn.txt" && ! -e "$release_dir/ami-id.txt" ]] || die 'release already contains a build; inspect/resume it or archive this release directory'
    [[ ! -e "$release_dir/ami-update-complete.txt" ]] || die 'release already contains a successful AMI stack update; inspect evidence before another bake'
    if [[ -n "$recipe_version" ]]; then
        cmp -s "$config" "$work/previous-ami-config.json" || die 'AMI config changed since planning'
        cp "$work/previous-ami-config.json" "$release_dir/previous-ami-config.json"
        cp "$work/ami.$namespace.json" "$release_dir/candidate-ami-config.json"
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
    read -r digest pinned_id < <(json manifest "$work/manifest.json" "$image_id")
    [[ -n "$digest" && -n "$pinned_id" ]] || die 'could not resolve the pushed image digest'
    if [[ -n "$maintenance_release" ]]; then
        json maintenance-lower "$work/maintenance-source-release.json" "$pinned_id"
    fi
    json parameters "$work/stack.json" "$digest" "$pinned_id" "$source_uri" "$work/parameters.json" "${previous_args[@]}"
else
    show aws --profile "$profile" --region "$region" ecr batch-get-image --repository-name "${repository#*/}" --image-ids "imageTag=$tag" --output json
    say 'Resolve the pushed digest: classic store (config digest == local ID) or containerd store (manifest/index digest == local ID; an index must hold one linux/amd64 image plus attestations).'
fi
act git -C "$repo_root" archive --format=tar.gz --output "$work/$archive" "$full_sha:infra/host-agent"
aws_act s3 cp "$work/$archive" "$source_uri"
say 'Exact parameter request (only approved current/previous image and source values change):'
cat "$work/parameters.json"
if [[ -n "${template_uri:-}" ]]; then aws_act s3 cp "$candidate_template" "$template_uri"; fi
aws_act cloudformation create-change-set --stack-name "$ami_stack" --change-set-name "$change" --change-set-type UPDATE \
    "${template_args[@]}" "${role_args[@]}" --capabilities CAPABILITY_NAMED_IAM --parameters "file://$work/parameters.json"
if ! "$apply"; then
    show aws --profile "$profile" --region "$region" cloudformation wait change-set-create-complete --stack-name "$ami_stack" --change-set-name "$change"
    show aws --profile "$profile" --region "$region" cloudformation describe-change-set --stack-name "$ami_stack" --change-set-name "$change" --include-property-values --output json
    say 'Validate every parameter, resolved SSM value and resource change before execution.'
    if [[ -n "$reviewed_base_ami" ]]; then
        say "Accept Ubuntu parent drift only to $reviewed_base_ami after describe-images verifies Canonical ownership, Noble amd64 name, available state and a newer creation date; save base-image-review.json."
    fi
    if [[ -n "$recipe_version" ]]; then
        say 'Permit only Component/Recipe version replacement, dependent Pipeline changes and configurations forced by the version string; refuse all other resources.'
    else
        say 'BLOCKER in current template: Components require replacing an immutable recipe without a version bump. Apply refuses this change set. Supply --recipe-version.'
    fi
    aws_act cloudformation execute-change-set --stack-name "$ami_stack" --change-set-name "$change"
    show aws --profile "$profile" --region "$region" cloudformation wait stack-update-complete --stack-name "$ami_stack"
    if [[ -n "$recipe_version" ]]; then say "After successful stack update only: persist version $recipe_version to $config; retain previous-ami-config.json in $release_dir."; fi
    show aws --profile "$profile" --region "$region" cloudformation describe-stacks --stack-name "$ami_stack" --output json
    aws_act imagebuilder start-image-pipeline-execution --image-pipeline-arn '<stack PipelineArn>' --query imageBuildVersionArn --output text
    show aws --profile "$profile" --region "$region" imagebuilder get-image --image-build-version-arn '<build ARN>' --output json
    say "Poll every 30 seconds, at most 90 minutes; persist build ARN immediately, then AVAILABLE AMI and inputs in $release_dir. Never remove an AMI."
    exit 0
fi
cp "$work/stack.json" "$release_dir/previous-ami-stack.json"
cp "$work/template.json" "$release_dir/ami-template.json"
cp "$work/parameters.json" "$release_dir/ami-parameters.json"
if [[ -n "$deployed_release" ]]; then
    cp "$work/deployed-release.json" "$release_dir/deployed-release.json"
fi
if [[ -n "$previous_ref" ]]; then
    cp "$work/previous-rebase-release.json" "$release_dir/previous-rebase-release.json"
fi
if [[ -n "$maintenance_release" ]]; then
    cp "$work/maintenance-source-release.json" "$release_dir/maintenance-source-release.json"
fi
json bake-inputs "$work/parameters.json" "$full_sha" "$recipe_version" "$work/template.json" "$release_dir/bake-inputs.json"

printf '%s\n' "$change" > "$release_dir/ami-changeset.txt"
printf 'ApplicationImageRepositoryUri=%s\nDesktopImageDigest=%s\nDesktopImageId=%s\nPreviousDesktopImageRef=%s\nPreviousDesktopImageId=%s\nDesktopTag=%s\nSourceImage=%s\nSourceSha=%s\nAgentSrcS3Uri=%s\n' \
    "$repository" "$digest" "$pinned_id" "$previous_ref" "$previous_id" "$tag" "$desktop_image" "$full_sha" "$source_uri" > "$release_dir/desktop.txt"
wait_changeset "$ami_stack" "$change"
cp "$work/changeset.json" "$release_dir/ami-changeset.json"
rm -f -- "$release_dir/base-image-review.json"
base_review_args=()
if [[ -n "$reviewed_base_ami" ]]; then
    old_base_ami=$(json base-ami-id "$work/stack.json")
    aws_read ec2 describe-images --image-ids "$old_base_ami" "$reviewed_base_ami" --output json > "$work/base-images.json"
    base_review_args=(--reviewed-base-ami "$reviewed_base_ami" --base-images "$work/base-images.json" --base-review-output "$work/base-image-review.json")
fi
json ami-changeset "$work/stack.json" "$work/parameters.json" "$work/changeset.json" "$work/template.json" "${validation_args[@]}" "${base_review_args[@]}"
if [[ -f "$work/base-image-review.json" ]]; then
    cp "$work/base-image-review.json" "$release_dir/base-image-review.json"
fi
if [[ -n "$recipe_version" ]]; then
    cmp -s "$config" "$work/previous-ami-config.json" || die 'AMI config changed before execution'
fi
execute_changeset "$ami_stack" "$change"
if [[ -n "$recipe_version" ]]; then
    printf '%s\n' "$change" > "$release_dir/ami-update-complete.txt"
    json persist-ami "$config" "$release_dir/previous-ami-config.json" "$release_dir/candidate-ami-config.json"
    say "AMI config now uses $recipe_version; previous version saved in $release_dir/previous-ami-config.json"
fi
aws_read cloudformation describe-stacks --stack-name "$ami_stack" --output json > "$work/updated-stack.json"
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
