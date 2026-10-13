#!/usr/bin/env bash
# Small, offline regression tests for the acceptance-command wrapper.
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
count=0
check() {
  local name=$1 expected=$2 log=$3 command=$4 actual=0
  bash "$root/run-checked-tests.sh" "$log" bash -c "$command" >"$tmp/output" 2>&1 || actual=$?
  if [ "$actual" -ne "$expected" ]; then
    echo "FAIL $name: expected $expected, got $actual"; cat "$tmp/output"; exit 1
  fi
  count=$((count + 1)); echo "PASS $name"
}
check 'clean pass' 0 "$tmp/clean.log" "printf ' 16 pass\n 0 fail\n'"
check 'preserves executor failure' 7 "$tmp/exit.log" "printf ' 16 pass\n'; exit 7"
check 'false-green fail summary' 1 "$tmp/fail.log" "printf ' 16 pass\n 1 fail\n'"
check 'false-green hook failure' 1 "$tmp/hook.log" "printf '(fail) beforeAll [5000.14ms]\n 16 pass\n'"
check 'rejects skipped acceptance' 1 "$tmp/skip.log" "printf ' 16 pass\n 1 skip\n'"
check 'rejects missing summary' 1 "$tmp/empty.log" "printf 'process completed\n'"
check 'rejects zero tests' 1 "$tmp/zero.log" "printf ' 0 pass\n 0 fail\n'"
check 'propagates tee failure' 1 "$tmp/no-parent/log" "printf ' 16 pass\n'"
echo "$count wrapper regression tests passed"
