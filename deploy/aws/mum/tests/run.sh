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
test_case 'multi-platform manifest refused' index '{"image_index":true}' 'refuse-schema-2'
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
printf 'RESULT: %d passed, %d failed\n' "$passed" "$failed"
((failed == 0))
