#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
scratch=$(mktemp -d /tmp/ezil-mum-tests.XXXXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
passed=0 failed=0

fixture() {
    case_dir=$scratch/$1
    python3 "$here/fixture.py" "$case_dir" "$2"
}
run() {
    local expected=$1 script=$2; shift 2
    local actual=0
    PATH="$case_dir/bin:$PATH" bash "$here/../$script" "$@" --release-dir "$case_dir/release" > "$case_dir/output" 2>&1 || actual=$?
    if [[ "$expected" == pass ]]; then [[ "$actual" == 0 ]]; else [[ "$actual" != 0 ]]; fi
}
check() { python3 "$here/assert.py" "$case_dir" "$1"; }
test_case() {
    local label=$1; shift
    # Each case is a fresh Bash process: set -e is not disabled by a surrounding
    # conditional in the parent test runner.
    if bash "$here/run.sh" --case "$@"; then
        printf 'PASS %s\n' "$label"; passed=$((passed + 1))
    else
        printf 'FAIL %s\n' "$label"; failed=$((failed + 1))
    fi
}

if [[ "${1:-}" == --case ]]; then
    name=$2; scenario=$3; mode=$4
    fixture "$name" "$scenario"
    case "$name" in
        recipe-*)
            version=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("version", "1.0.2"))' "$scenario")
            flags=(--desktop-image desktop:test --source-sha aaaaaaaa --recipe-version "$version" --config "$case_dir/ami-config.json")
            if [[ "$name" == recipe-dry ]]; then
                run pass rebuild-ami.sh "${flags[@]}"
                check recipe-dry
            elif [[ "$mode" == pass ]]; then
                run pass rebuild-ami.sh "${flags[@]}" --apply
                check recipe-applied
            else
                run fail rebuild-ami.sh "${flags[@]}" --apply
                check "$mode"
                if [[ "$name" != recipe-config-race && "$name" != recipe-build-fail ]]; then
                    cmp "$case_dir/ami-config.json" "$case_dir/original-ami-config.json"
                fi
                if [[ "$name" != recipe-build-fail ]]; then check recipe-no-bake; fi
            fi ;;
        dry-rebuild)
            run pass rebuild-ami.sh --desktop-image desktop:test --source-sha aaaaaaaa
            check dry-rebuild ;;
        dry-promote)
            run pass promote-ami.sh --ami ami-22222222222222222 --config "$case_dir/config.json"
            check dry-promote ;;
        promote|object-secret|rollback|dry-rollback|noop-rollback)
            run pass promote-ami.sh --ami ami-22222222222222222 --config "$case_dir/config.json" --apply
            check promote
            if [[ "$name" == rollback || "$name" == noop-rollback ]]; then
                run pass promote-ami.sh --rollback --config "$case_dir/config.json" --apply
                check rollback
            elif [[ "$name" == dry-rollback ]]; then
                cp "$case_dir/config.json" "$case_dir/pre-dry.json"
                cp "$case_dir/secret.json" "$case_dir/pre-dry-secret.json"
                run pass promote-ami.sh --rollback --config "$case_dir/config.json"
                cmp "$case_dir/config.json" "$case_dir/pre-dry.json"
                cmp "$case_dir/secret.json" "$case_dir/pre-dry-secret.json"
            fi ;;
        partial-rollback)
            run fail promote-ami.sh --ami ami-22222222222222222 --config "$case_dir/config.json" --apply
            check no-secret-write
            printf '%s\n' '{"noop_rollback":true}' > "$case_dir/scenario.json"
            run pass promote-ami.sh --rollback --config "$case_dir/config.json" --apply
            check rollback ;;
        durable|version-race|wrong-output|secret-race|secret-drift|synth-fail|stack-fail)
            run fail promote-ami.sh --ami ami-22222222222222222 --config "$case_dir/config.json" --apply
            check no-secret-write
            if [[ "$name" == durable ]]; then check 'refuse-durable lifecycle'; fi
            if [[ "$name" == version-race ]]; then check 'refuse-published versions changed'; fi ;;
        region)
            AWS_REGION=us-east-1 run fail rebuild-ami.sh --desktop-image desktop:test --source-sha aaaaaaaa --apply
            check 'refuse-region must' ;;
        available)
            run pass rebuild-ami.sh --desktop-image desktop:test --source-sha aaaaaaaa --apply
            check available ;;
        *)
            run fail rebuild-ami.sh --desktop-image desktop:test --source-sha aaaaaaaa --apply
            check "$mode" ;;
    esac
    exit 0
fi

test_case 'rebuild dry-run sequence and zero mutations' dry-rebuild '{}' dry-rebuild
test_case 'all previous parameters and archive root preserved' parameters '{}' parameters
test_case 'wrong AWS account refused' account '{"wrong_account":true}' 'refuse-wrong AWS account'
test_case 'wrong AWS region refused' region '{}' region
test_case 'non-amd64 image refused' arm '{"arm":true}' 'refuse-linux/amd64'
test_case 'ECR image ID mismatch refused' mismatch '{"image_mismatch":true}' 'refuse-image ID mismatch'
test_case 'index not matching the local image refused' index '{"image_index":true}' 'refuse-image ID mismatch'
test_case 'containerd index pins its single amd64 child' index-ok '{"image_index_ok":true}' index-child
test_case 'multi-platform index refused' index-two '{"image_index_two":true}' 'refuse-linux/amd64'
test_case 'stack without RoleARN gets no --role-arn' no-role '{"no_stack_role":true}' no-stack-role
test_case 'extra parameter change refused' extra '{"extra_parameter":true}' 'refuse-extra parameter'
test_case 'SSM resolved parent drift refused' ssm '{"ssm_drift":true}' 'refuse-resolved SSM'
test_case 'unexpected resource change refused' resource '{"extra_resource":true}' 'refuse-unexpected resource'
test_case 'immutable recipe replacement refused' immutable '{}' 'refuse-immutable Image Builder'
test_case 'polling/AVAILABLE path (non-replacing test double only)' available '{"non_replacing_double":true}' available
test_case 'FAILED build persists ARN and no AMI' build-fail '{"non_replacing_double":true,"build_fail":true}' failed-build
test_case 'poll request bounded by remaining 90-minute deadline' poll-timeout '{"non_replacing_double":true,"poll_timeout":true}' poll-timeout
test_case 'promotion dry-run and latest published N+1' dry-promote '{}' dry-promote
test_case 'promotion preserves string-encoded deployment and all other secret keys' promote '{}' promote
test_case 'promotion preserves object-encoded deployment and all other secret keys' object-secret '{"object_secret":true}' promote
test_case 'rollback restores previous AMI/version and preserves unrelated values' rollback '{}' rollback
test_case 'rollback dry-run leaves config and secret unchanged' dry-rollback '{}' dry-rollback
test_case 'rollback accepts verified CloudFormation no-op' noop-rollback '{"noop_rollback":true}' rollback
test_case 'rollback recovers promotion that failed at synth' partial-rollback '{"synth_fail":true}' rollback
test_case 'durable resource replacement refused' durable '{"durable":true}' no-secret-write
test_case 'concurrent lifecycle publication refused' version-race '{"version_race":true}' no-secret-write
test_case 'unexpected deployed version leaves secret unchanged' wrong-output '{"wrong_output":true}' no-secret-write
test_case 'concurrent secret edit refused' secret-race '{"secret_race":true}' no-secret-write
test_case 'preexisting secret deployment drift refused' secret-drift '{"secret_drift":true}' no-secret-write
test_case 'synth failure leaves app secret unchanged' synth-fail '{"synth_fail":true}' no-secret-write
test_case 'stack failure leaves app secret unchanged' stack-fail '{"stack_fail":true}' no-secret-write
test_case 'version dry-run synthesizes candidate and leaves real config byte-identical' recipe-dry '{}' pass
test_case 'allowed component/recipe replacements and pipeline reference proceed' recipe-allowed '{}' pass
test_case 'version comparison is numeric' recipe-numeric '{"version":"1.0.10"}' pass
test_case 'equal version refused before synth or writes' recipe-equal '{"version":"1.0.1"}' 'refuse-recipe version must be greater'
test_case 'lower version refused before synth or writes' recipe-lower '{"version":"0.9.9"}' 'refuse-recipe version must be greater'
test_case 'non-semantic version refused' recipe-invalid '{"version":"1.0.02"}' 'refuse-recipe version must be x.y.z'
test_case 'out-of-range Image Builder version refused' recipe-range '{"version":"1073741824.0.0"}' 'refuse-recipe version exceeds'
test_case 'IAM change in change-set description refused' recipe-iam '{"iam_change":true}' 'refuse-unexpected resource change'
test_case 'IAM template drift refused before uploads' recipe-template-iam '{"template_iam":true}' 'refuse-unexpected template resource change'
test_case 'parameter definition drift in synthesized template refused' recipe-template-param '{"template_parameter":true}' 'refuse-unexpected template parameter'
test_case 'oversize inline template uploaded to pinned S3 prefix' recipe-large '{"large_template":52000}' pass
test_case 'template exceeding S3 limit refused' recipe-too-large '{"large_template":1048576}' 'refuse-synthesized template exceeds'
test_case 'configuration changes forced only by version string proceed' recipe-forced '{"forced_config_version":true}' pass
test_case 'unrelated infrastructure configuration change refused' recipe-unforced '{"unforced_config":true}' 'refuse-configuration change is not forced'
test_case 'unexplained infrastructure change-set entry refused' recipe-unexplained '{"unexplained_config":true}' 'refuse-unexpected versioned Image Builder'
test_case 'recipe removal refused' recipe-delete '{"delete_recipe":true}' 'refuse-unexpected resource change'
test_case 'missing component replacement refused' recipe-missing '{"missing_component":true}' 'refuse-change set omits component/recipe'
test_case 'pipeline replacement without template cause refused' recipe-pipeline '{"pipeline_replacement":true}' 'refuse-unexpected dependent resource replacement'
test_case 'synth version mismatch refused' recipe-mismatch '{"synth_version_mismatch":true}' 'refuse-synthesized recipe/component version mismatch'
test_case 'live template version drift from local config refused' recipe-live-drift '{"live_version_drift":true}' 'refuse-live recipe/component version differs'
test_case 'incomplete change-set page refused' recipe-page '{"pagination":true}' 'refuse-incomplete change set'
test_case 'version path preserves SSM drift guard' recipe-ssm '{"ssm_drift":true}' 'refuse-resolved SSM'
test_case 'version path preserves nonallowed parameter guard' recipe-param '{"extra_parameter":true}' 'refuse-extra parameter'
test_case 'AMI synth failure leaves original config unchanged' recipe-synth-fail '{"synth_fail":true}' recipe-no-bake
test_case 'change-set execute failure leaves original config unchanged' recipe-execute-fail '{"execute_fail":true}' recipe-update-failed
test_case 'stack update failure leaves original config unchanged' recipe-stack-fail '{"stack_fail":true}' recipe-update-failed
test_case 'concurrent config edit after stack update prevents overwrite and bake' recipe-config-race '{"config_race":true}' recipe-config-race
test_case 'failed bake retains successfully deployed config version and old backup' recipe-build-fail '{"build_fail":true}' recipe-build-fail
printf 'RESULT: %d passed, %d failed\n' "$passed" "$failed"
((failed == 0))
