#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
require_tools python3 aws flock
init_work
lock_operator
assert_identity
python3 "$script_dir/rebase_release.py" "$@"
