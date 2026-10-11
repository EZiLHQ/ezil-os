#!/usr/bin/env bash
# Preserve command and tee exit codes and reject contradictory Bun summaries.
set -uo pipefail
if [ "$#" -lt 2 ]; then echo "usage: run-checked-tests.sh LOG COMMAND [ARGS...]" >&2; exit 2; fi
log=$1; shift
"$@" 2>&1 | tee "$log"
statuses=("${PIPESTATUS[@]}")
if [ "${statuses[0]}" -ne 0 ]; then exit "${statuses[0]}"; fi
if [ "${statuses[1]}" -ne 0 ]; then exit "${statuses[1]}"; fi
if grep -Eq '^[[:space:]]*[1-9][0-9]* (fail|skip)$|^\(fail\)' "$log"; then
  echo "Test output contains failure/skip despite successful command exit" >&2; exit 1
fi
if ! grep -Eq '^[[:space:]]*[1-9][0-9]* pass$' "$log"; then
  echo "Missing nonzero Bun test pass summary" >&2; exit 1
fi
if [ -n "${EZIL_TEST_JUNIT:-}${EZIL_TEST_REQUIRED:-}" ]; then
  if [ -z "${EZIL_TEST_JUNIT:-}" ] || [ -z "${EZIL_TEST_REQUIRED:-}" ]; then
    echo "JUnit report and required-case inventory must both be configured" >&2; exit 1
  fi
  python3 "$(dirname "$0")/validate-test-junit.py" "$EZIL_TEST_JUNIT" "$EZIL_TEST_REQUIRED" || exit $?
fi
