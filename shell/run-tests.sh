#!/usr/bin/env bash
# run-tests.sh — EZiL-authored. THE runner for the EZiL-OS shell suites.
#
# Run:  shell/run-tests.sh            (from anywhere; it locates its own tree)
#       shell/run-tests.sh --help
#
# ═══════════════════════════════════════════════════════════════════════════
# WHY THIS FILE EXISTS
# ═══════════════════════════════════════════════════════════════════════════
# Before this file there was no runner. `shell/package.json`'s "test" script
# ran exactly ONE of the twenty suites (`node load-test.mjs`); the commands for
# the other nineteen existed only as prose in each file's own header comment,
# and `.github/workflows/` was empty, so nothing ran any of them automatically.
# "The suites are green" was, in practice, a claim nobody could reproduce in
# one command.
#
# ═══════════════════════════════════════════════════════════════════════════
# 🔴 THE ONE RULE THIS FILE EXISTS TO ENFORCE: EXIT 2 IS *SKIPPED*, NOT PASSED
# ═══════════════════════════════════════════════════════════════════════════
# Eleven of these suites are REAL-BROWSER tests that need `playwright`, which
# is deliberately NOT a project dependency and appears in no lockfile. Every
# one of them exits **2** when playwright (or the built bundle) cannot be
# resolved. A runner that treats "not 1" as "pass" would report a fully green
# run on a machine where ELEVEN suites never started a browser — which is
# exactly the false-green this repository has already been bitten by more than
# once.
#
# So: exit 0 = PASS, exit 1 = FAIL, exit 2 = SKIP, anything else = FAIL.
# A suite file that is not in this worktree yet is ALSO a skip, for the same
# reason — see `run_suite`.
# SKIPs are counted, listed by name, printed in the final verdict, and the
# verdict line says SKIPS PRESENT loudly. The process exit code is 0 only when
# there are no failures; use `--strict` to also make any skip a failure (that
# is the flag CI should use once playwright is pinned).
#
# ═══════════════════════════════════════════════════════════════════════════
# PLAYWRIGHT
# ═══════════════════════════════════════════════════════════════════════════
# Each browser suite resolves playwright from its own location first, then from
# a directory named by $PLAYWRIGHT_REQUIRE_DIR. This runner just passes that
# variable through; it does not install anything.
#
#   In THIS environment (2026-08-19) there are TWO neighbouring repositories
#   that resolve a playwright with a working Chromium, at DIFFERENT versions:
#
#       <path-redacted>/EZiL-Universe/node_modules   playwright 1.61.1
#       <path-redacted>/EBuilder/node_modules        playwright 1.59.1
#
#   Both are NEIGHBOURING REPOSITORIES, not dependencies of this one, and either
#   can disappear without warning. If both do, the browser suites skip; they do
#   not silently pass. If $PLAYWRIGHT_REQUIRE_DIR is unset this runner defaults
#   to the first when it exists, and says so, so that a bare
#   `shell/run-tests.sh` does the useful thing rather than skipping eleven
#   suites by default.
#
#   🔴 Having two versions to hand is worth keeping. Running the same suite
#   against both is the cheapest available discriminator between "this test is
#   sensitive to the playwright build" and "this is a real defect in the
#   bundle" — it is exactly what settled `resize-test.mjs`'s long-standing
#   16/18 (identical failure under both, so not a version artifact; see that
#   file's header for what it actually was).
#
# ═══════════════════════════════════════════════════════════════════════════
# TIMEOUTS
# ═══════════════════════════════════════════════════════════════════════════
# `shell/ezil/boot-test.mjs` is 1814 lines of jsdom and legitimately needs more
# than 120s; MEASURED it completes in roughly 150-200s and passes comfortably
# inside 300s. It gets its own budget below. A suite killed by its timeout is
# reported as TIMEOUT and counted as a FAILURE, never as a skip — a hang is a
# result, not an absence of one.
#
# ═══════════════════════════════════════════════════════════════════════════
# WHAT IS AND IS NOT RUN
# ═══════════════════════════════════════════════════════════════════════════
# By default: `build-shell.sh --check` (fail-fast on bundle drift), then the
# 12 node-only shell suites, then the 11 browser suites. That is the whole of
# `shell/` except the cost probes, which are behind `--cost` and are NOT tests
# — see that block for why, and for the known-red state of the one that exists.
#
# The `worker/` (bun test) and `app/` (vitest) suites are NOT run by default,
# behind `--all`. That is a deliberate decision, not an oversight:
#   - this is `shell/run-tests.sh`, and a shell change cannot break them;
#   - they need their own `node_modules`/bun installs which this script must
#     not perform silently;
#   - they are ~1380 tests and roughly double the wall time of a shell run.
# Use `--all` (or `--worker` / `--app`) before claiming the contract's
# "worker 790 pass / 1 skip, app 586 pass" baseline is still true — and note
# that this script does NOT install their dependencies. If `worker/node_modules`
# or `app/node_modules` is missing (it is, in a fresh git worktree) the run is
# reported as a SKIP naming the `bun install` to run, never as a failure.
#
# The 11 node-only shell suites need `shell/node_modules` for `jsdom`:
# `cd shell && bun install`. This script does not do that either, for the same
# reason; without it those suites fail on the import rather than skipping,
# because jsdom is a declared dependency and its absence is a broken checkout,
# not an optional extra.
#
# `shell/ezil/ui/Settings/computers-drift.test.tsx` is a vitest file, not a
# `.mjs` suite, and is part of the `app` vitest project; it runs under `--app`.

set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/.." && pwd)"

# ── options ────────────────────────────────────────────────────────────────
RUN_WORKER=0
RUN_APP=0
RUN_CHECK=1
RUN_COST=0
STRICT=0
ONLY=""

usage () {
    cat <<'EOF'
shell/run-tests.sh — run every EZiL-OS shell suite and print one honest verdict.

  --all           also run `worker/` (bun test) and `app/` (bun run test)
  --worker        also run `worker/` bun test
  --app           also run `app/` vitest
  --no-check      skip the `build-shell.sh --check` bundle-drift gate
  --cost          also run the cost probes (display-gate-cost.mjs). KNOWN RED —
                  a stale harness, not a regression; see the comment on that block.
  --strict        exit non-zero if ANY suite SKIPPED (use this in CI)
  --only <sub>    run only suites whose path contains <sub>
  -h, --help      this text

Exit codes: 0 = no failures. 1 = at least one failure (or, with --strict, at
least one skip). Individual suites: 0 PASS, 1 FAIL, 2 SKIP.

Environment:
  PLAYWRIGHT_REQUIRE_DIR   directory from which the browser suites resolve
                           `playwright`. Defaults (when it exists) to
                           <path-redacted>/EZiL-Universe/node_modules
                           which currently carries playwright 1.61.1.
  EZIL_OS_DIR              override the built-bundle directory under test.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --all)      RUN_WORKER=1; RUN_APP=1 ;;
        --worker)   RUN_WORKER=1 ;;
        --app)      RUN_APP=1 ;;
        --no-check) RUN_CHECK=0 ;;
        --cost)     RUN_COST=1 ;;
        --strict)   STRICT=1 ;;
        --only)     shift; ONLY="${1:-}" ;;
        -h|--help)  usage; exit 0 ;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 64 ;;
    esac
    shift
done

# ── playwright resolution ──────────────────────────────────────────────────
DEFAULT_PW_DIR="<path-redacted>/EZiL-Universe/node_modules"
if [ -z "${PLAYWRIGHT_REQUIRE_DIR:-}" ] && [ -d "$DEFAULT_PW_DIR/playwright" ]; then
    export PLAYWRIGHT_REQUIRE_DIR="$DEFAULT_PW_DIR"
    PW_NOTE="defaulted to $DEFAULT_PW_DIR"
elif [ -n "${PLAYWRIGHT_REQUIRE_DIR:-}" ]; then
    export PLAYWRIGHT_REQUIRE_DIR
    PW_NOTE="from the environment: $PLAYWRIGHT_REQUIRE_DIR"
else
    PW_NOTE="UNSET and the default path does not exist — every browser suite will SKIP"
fi

# ── colours, only on a tty ─────────────────────────────────────────────────
if [ -t 1 ]; then
    C_PASS=$'\033[32m'; C_FAIL=$'\033[31m'; C_SKIP=$'\033[33m'
    C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
    C_PASS=''; C_FAIL=''; C_SKIP=''; C_DIM=''; C_B=''; C_0=''
fi

LOGDIR="$(mktemp -d -t ezil-run-tests-XXXXXX)"
PASSED=(); FAILED=(); SKIPPED=(); TIMEDOUT=(); NOTYET=()
SUMMARY=()

# run_suite <label> <timeout-seconds> <cmd...>
run_suite () {
    local label="$1"; shift
    local budget="$1"; shift
    if [ -n "$ONLY" ] && [[ "$label" != *"$ONLY"* ]]; then
        return 0
    fi
    local log="$LOGDIR/$(echo "$label" | tr '/ ' '__').log"

    # 🔴 A SUITE FILE THAT IS NOT HERE IS A SKIP, NOT A FAILURE. Twelve agents
    # are working in separate git worktrees, so this runner routinely names a
    # suite that exists in someone else's tree and not yet in this one. `node
    # missing.mjs` exits 1 with MODULE_NOT_FOUND, which reads exactly like a
    # broken test and is not one — and, worse, it would train whoever runs this
    # to ignore a red line. Same principle as exit 2: "did not run" is its own
    # answer and must never be dressed up as either of the other two.
    if [ "$1" = "node" ] && [ ! -f "${2:-}" ]; then
        NOTYET+=("$label"); SKIPPED+=("$label")
        SUMMARY+=("${C_SKIP}SKIP${C_0}    $label -> file not present in this worktree")
        printf '%s\n' "${C_SKIP}SKIPPED${C_0}  $label  ${C_DIM}(file not in this worktree yet — DID NOT RUN)${C_0}"
        return 0
    fi

    printf '%s\n' "${C_DIM}── $label ${C_0}"
    local start rc elapsed
    start=$SECONDS
    timeout --signal=TERM --kill-after=15s "${budget}s" "$@" >"$log" 2>&1
    rc=$?
    elapsed=$(( SECONDS - start ))

    # `timeout` reports 124 (TERM) or 137 (KILL). Both are hangs, both are
    # FAILURES — never skips. A suite that never finished told us nothing, and
    # "told us nothing" must not read as "fine".
    if [ $rc -eq 124 ] || [ $rc -eq 137 ]; then
        TIMEDOUT+=("$label"); FAILED+=("$label")
        SUMMARY+=("${C_FAIL}TIMEOUT${C_0} $label (${budget}s budget) -> $log")
        printf '%s\n' "${C_FAIL}TIMEOUT${C_0}  $label  after ${budget}s"
        tail -n 20 "$log" | sed 's/^/    /'
        return 0
    fi

    case $rc in
        0)
            PASSED+=("$label")
            SUMMARY+=("${C_PASS}PASS${C_0}    $label (${elapsed}s)")
            printf '%s\n' "${C_PASS}PASS${C_0}     $label  ${C_DIM}${elapsed}s${C_0}  $(grep -Eo '[0-9]+/[0-9]+ checks passed' "$log" | tail -1)"
            ;;
        2)
            # 🔴 THE WHOLE POINT. Exit 2 is the suites' agreed "I did not run".
            SKIPPED+=("$label")
            SUMMARY+=("${C_SKIP}SKIP${C_0}    $label -> $(tail -n 3 "$log" | tr '\n' ' ' | cut -c1-160)")
            printf '%s\n' "${C_SKIP}SKIPPED${C_0}  $label  ${C_DIM}(exit 2 — DID NOT RUN, not a pass)${C_0}"
            tail -n 3 "$log" | sed 's/^/    /'
            ;;
        *)
            FAILED+=("$label")
            SUMMARY+=("${C_FAIL}FAIL${C_0}    $label (exit $rc) -> $log")
            printf '%s\n' "${C_FAIL}FAIL${C_0}     $label  ${C_DIM}exit $rc, ${elapsed}s${C_0}"
            # Show the suites' own failure block if they printed one, else the tail.
            if grep -q '^FAILURES:' "$log"; then
                sed -n '/^FAILURES:/,$p' "$log" | head -n 25 | sed 's/^/    /'
            else
                tail -n 25 "$log" | sed 's/^/    /'
            fi
            ;;
    esac
}

echo "${C_B}EZiL-OS shell test run${C_0}   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  root:       $ROOT"
echo "  playwright: $PW_NOTE"
echo "  logs:       $LOGDIR"
echo

# ── gate 0: bundle drift ───────────────────────────────────────────────────
# Every `*-test.mjs` under shell/ tests the COMMITTED bundle in
# `app/public/os`, not the sources. If the bundle has drifted from source,
# every result below is about code that is not the code in the tree, so this
# is fail-fast rather than just another suite.
if [ "$RUN_CHECK" = "1" ]; then
    echo "${C_B}[gate] shell/build-shell.sh --check${C_0}"
    if "$HERE/build-shell.sh" --check >"$LOGDIR/build-check.log" 2>&1; then
        echo "${C_PASS}PASS${C_0}     bundle matches source"
    else
        echo "${C_FAIL}FAIL${C_0}     BUNDLE DRIFT — app/public/os does not match shell/ sources."
        echo "         Every suite below tests the committed bundle, so their results"
        echo "         would be about code that is not in this tree. Run shell/build-shell.sh."
        tail -n 30 "$LOGDIR/build-check.log" | sed 's/^/    /'
        exit 1
    fi
    echo
fi

# ═══════════════════════════════════════════════════════════════════════════
# The node-only suites (jsdom / pure function). No browser, no playwright.
# ═══════════════════════════════════════════════════════════════════════════
echo "${C_B}[1/2] node-only suites (12)${C_0}"
run_suite "shell/load-test.mjs"                          120 node "$HERE/load-test.mjs"
run_suite "shell/ezil/trace-test.mjs"                    120 node "$HERE/ezil/trace-test.mjs"
run_suite "shell/ezil/log-test.mjs"                      120 node "$HERE/ezil/log-test.mjs"
run_suite "shell/ezil/telemetry-test.mjs"                120 node "$HERE/ezil/telemetry-test.mjs"
run_suite "shell/ezil/activity-heartbeat-test.mjs"       120 node "$HERE/ezil/activity-heartbeat-test.mjs"
run_suite "shell/ezil/ui/app-spinner-test.mjs"           120 node "$HERE/ezil/ui/app-spinner-test.mjs"
run_suite "shell/ezil/ui/Settings/settings-test.mjs"     180 node "$HERE/ezil/ui/Settings/settings-test.mjs"
run_suite "shell/ezil/apps/code-test.mjs"                180 node "$HERE/ezil/apps/code-test.mjs"
run_suite "shell/ezil/apps/preview-focus-test.mjs"       180 node "$HERE/ezil/apps/preview-focus-test.mjs"
run_suite "shell/ezil/apps/registry-trace-test.mjs"      180 node "$HERE/ezil/apps/registry-trace-test.mjs"
# 🔴 boot-test needs MORE THAN 120s. At 120s it is killed mid-run and looks
# like a hang; MEASURED green well inside 300s (177s here). Do not lower this.
run_suite "shell/ezil/boot-test.mjs"                     420 node "$HERE/ezil/boot-test.mjs"
# W4's close/release suite (28 checks, node-only, drives the built bundle).
# Registered here on W4's request; not this file's to edit. Skips cleanly while
# it is still only in W4's worktree.
run_suite "shell/ezil/apps/desktop-close-test.mjs"       300 node "$HERE/ezil/apps/desktop-close-test.mjs"
echo

# ═══════════════════════════════════════════════════════════════════════════
# The browser suites. Every one of these exits 2 when playwright or the built
# bundle is unresolvable, and that 2 is a SKIP above. So is a suite whose file
# is not in this worktree yet — several are owned by sibling agents.
# ═══════════════════════════════════════════════════════════════════════════
echo "${C_B}[2/2] real-browser suites (11)${C_0}"
run_suite "shell/window-chrome-browser-test.mjs"                   300 node "$HERE/window-chrome-browser-test.mjs"
run_suite "shell/seam-minimise-browser-test.mjs"                   300 node "$HERE/seam-minimise-browser-test.mjs"
run_suite "shell/ezil/display-notice-browser-test.mjs"             300 node "$HERE/ezil/display-notice-browser-test.mjs"
run_suite "shell/ezil/launcher-toggle-browser-test.mjs"            300 node "$HERE/ezil/launcher-toggle-browser-test.mjs"
run_suite "shell/ezil/context-menu-stack-browser-test.mjs"         300 node "$HERE/ezil/context-menu-stack-browser-test.mjs"
run_suite "shell/ezil/apps/overlay-paint-browser-test.mjs"         300 node "$HERE/ezil/apps/overlay-paint-browser-test.mjs"
run_suite "shell/ezil/apps/os-chrome-browser-test.mjs"             420 node "$HERE/ezil/apps/os-chrome-browser-test.mjs"
run_suite "shell/ezil/ui/Settings/stacking-browser-test.mjs"       600 node "$HERE/ezil/ui/Settings/stacking-browser-test.mjs"
run_suite "shell/ezil/apps/resize-test.mjs"                        420 node "$HERE/ezil/apps/resize-test.mjs"
# The phone-viewport suite. It is the only suite in this tree that runs with
# hasTouch/isMobile and a phone UA; see its own header for why that matters.
run_suite "shell/ezil/apps/mobile-browser-test.mjs"                420 node "$HERE/ezil/apps/mobile-browser-test.mjs"
# W5's touch-focus suite (26 checks, needs playwright, exits 2 on skip).
# Registered here on W5's request; not this file's to edit.
run_suite "shell/touch-focus-browser-test.mjs"                     420 node "$HERE/touch-focus-browser-test.mjs"
echo

# ═══════════════════════════════════════════════════════════════════════════
# COST PROBES — off by default, behind --cost. NOT test suites.
# ═══════════════════════════════════════════════════════════════════════════
# 🔴 `shell/ezil/display-gate-cost.mjs` is a BENCHMARK, not a suite: its own
# header calls it a cost probe for PLATFORM-NOTES §16c, it takes `SAMPLES`, and
# it reports medians rather than checks. It is deliberately not one of the 11
# node suites or the 10 browser suites, and running it by default would be
# wrong twice over — it would add wall time nobody asked for, and its number is
# a measurement to be read, not a threshold to be passed.
#
# It is ALSO red right now, and that is the second reason it must not run by
# default. MEASURED on the unmodified bundle in a clean worktree, under
# playwright 1.61.1: it dies with an uncaught
#   `page.waitForSelector: Timeout 15000ms exceeded` waiting for
#   `.window[data-app="desktop"] .window-app-iframe`   (line 218)
# — an uncaught exception, so it exits 1 and prints a stack rather than a
# result. DIAGNOSED, not guessed: the file injects the bundle and then waits
# for the desktop window WITHOUT ever calling `window.ezil.boot()` or
# activating the dock item. It was written against a base where `boot.js`
# auto-launched `apps[0]`; login now opens NOTHING (see `boot.js`'s header, and
# the same merge note in `os-chrome-browser-test.mjs`'s `boot()` helper), so
# nothing ever opens the Browser and the wait can only time out. It is a stale
# harness, not a shell regression, and it fails identically before and after
# every Phase 1 change. `display-gate-cost.mjs` is unowned in the Browser-fix
# contract's §9 table, so this is reported rather than fixed here.
if [ "$RUN_COST" = "1" ]; then
    echo "${C_B}[opt] cost probes${C_0}"
    echo "${C_SKIP}  note: display-gate-cost.mjs is KNOWN RED — a stale harness, see the"
    echo "        comment above this block. Its failure is not a regression.${C_0}"
    run_suite "shell/ezil/display-gate-cost.mjs (cost probe, KNOWN RED)" 600 node "$HERE/ezil/display-gate-cost.mjs"
    echo
fi

# ═══════════════════════════════════════════════════════════════════════════
# Optional: the other two projects. Off by default — see the header.
# ═══════════════════════════════════════════════════════════════════════════

# 🔴 Their dependencies are NOT installed by this script. A `bun test` in a
# project with no `node_modules` fails with a resolution error, which would be
# reported as a genuine test failure and send someone hunting a bug that is
# really a missing install. Detected and reported as a SKIP with the exact
# command to fix it — a skip being, per this file's whole premise, an honest
# "did not run" rather than either a pass or a fake failure.
need_install () {
    local dir="$1" label="$2"
    if [ ! -d "$dir/node_modules" ]; then
        SKIPPED+=("$label")
        SUMMARY+=("${C_SKIP}SKIP${C_0}    $label -> no $dir/node_modules; run: cd $dir && bun install")
        printf '%s\n' "${C_SKIP}SKIPPED${C_0}  $label  ${C_DIM}(no node_modules — DID NOT RUN, not a pass)${C_0}"
        printf '%s\n' "    fix: cd $dir && bun install"
        return 0
    fi
    return 1
}

if [ "$RUN_WORKER" = "1" ]; then
    echo "${C_B}[opt] worker (bun test)${C_0}"
    need_install "$ROOT/worker" "worker: bun test" \
        || run_suite "worker: bun test" 900 bash -c "cd '$ROOT/worker' && bun test"
    echo
fi
if [ "$RUN_APP" = "1" ]; then
    echo "${C_B}[opt] app (bun run test / vitest)${C_0}"
    need_install "$ROOT/app" "app: bun run test" \
        || run_suite "app: bun run test" 900 bash -c "cd '$ROOT/app' && bun run test"
    echo
fi

# ═══════════════════════════════════════════════════════════════════════════
# The verdict
# ═══════════════════════════════════════════════════════════════════════════
echo "${C_B}══════════════════════════════════════════════════════════════${C_0}"
for line in "${SUMMARY[@]}"; do echo "  $line"; done
echo "${C_B}══════════════════════════════════════════════════════════════${C_0}"
n_pass=${#PASSED[@]}; n_fail=${#FAILED[@]}; n_skip=${#SKIPPED[@]}
echo "  ${C_PASS}${n_pass} passed${C_0}   ${C_FAIL}${n_fail} failed${C_0}   ${C_SKIP}${n_skip} skipped${C_0}"

if [ "$n_skip" -gt 0 ]; then
    echo
    echo "${C_SKIP}${C_B}  ⚠  ${n_skip} SUITE(S) DID NOT RUN.${C_0}"
    echo "${C_SKIP}     A skip is NOT a pass and must not be reported as one.${C_0}"
    echo "${C_SKIP}     Why, per suite:${C_0}"
    for s in "${SKIPPED[@]}"; do
        why="exited 2 — playwright or the built bundle was unresolvable"
        for n in ${NOTYET[@]+"${NOTYET[@]}"}; do
            [ "$n" = "$s" ] && why="the file is not in this worktree yet (a sibling agent owns it)"
        done
        echo "${C_SKIP}       - $s: $why${C_0}"
    done
    if [ ${#SKIPPED[@]} -ne ${#NOTYET[@]} ]; then
        echo "${C_SKIP}     PLAYWRIGHT_REQUIRE_DIR was: ${PLAYWRIGHT_REQUIRE_DIR:-<unset>}${C_0}"
    fi
fi

if [ ${#TIMEDOUT[@]} -gt 0 ]; then
    echo
    echo "${C_FAIL}  ⏱  ${#TIMEDOUT[@]} suite(s) hit their time budget (counted as FAILURES):${C_0}"
    for s in "${TIMEDOUT[@]}"; do echo "${C_FAIL}       - $s${C_0}"; done
fi

echo
if [ "$n_fail" -gt 0 ]; then
    echo "${C_FAIL}${C_B}  VERDICT: FAILED${C_0} — ${n_fail} suite(s) failed, ${n_skip} skipped. Logs: $LOGDIR"
    exit 1
fi
if [ "$n_skip" -gt 0 ]; then
    if [ "$STRICT" = "1" ]; then
        echo "${C_FAIL}${C_B}  VERDICT: FAILED (--strict)${C_0} — 0 failed but ${n_skip} skipped, and --strict"
        echo "           treats an unrun suite as a failed one. Logs: $LOGDIR"
        exit 1
    fi
    echo "${C_SKIP}${C_B}  VERDICT: PASSED WITH SKIPS${C_0} — ${n_pass} passed, ${n_skip} DID NOT RUN."
    echo "           This is NOT a green run. Re-run with playwright resolvable"
    echo "           before reporting the suites as green. Logs: $LOGDIR"
    exit 0
fi
echo "${C_PASS}${C_B}  VERDICT: PASSED${C_0} — all ${n_pass} suites ran and passed. Logs: $LOGDIR"
exit 0
