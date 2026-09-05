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
# Every suite that needs a real browser (currently every `*-browser-test.mjs`,
# plus `resize-test.mjs` — see "SUITE DISCOVERY" below for how that is decided)
# needs `playwright`, which is deliberately NOT a project dependency and
# appears in no lockfile. Every one of them exits **2** when playwright (or the
# built bundle) cannot be resolved. A runner that treats "not 1" as "pass"
# would report a fully green run on a machine where every real-browser suite
# never started a browser — which is exactly the false-green this repository
# has already been bitten by more than once.
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
#   Playwright is NOT a dependency of this repository. Point
#   $PLAYWRIGHT_REQUIRE_DIR at any directory whose `node_modules` carries a
#   playwright with a working Chromium; CI installs one into
#   /opt/ezil-testkit for exactly this purpose (see
#   .github/workflows/ci.yml). $EZIL_PLAYWRIGHT_DIR, if set, is used as the
#   fallback when $PLAYWRIGHT_REQUIRE_DIR is unset — useful when a
#   neighbouring checkout on your machine already has one.
#
#   If neither resolves, the browser suites SKIP. They do not silently pass.
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
# By default: `build-shell.sh --check` (fail-fast on bundle drift), then every
# node-only shell suite, then every real-browser suite. That is the whole of
# `shell/` except the cost probes, which are behind `--cost` and are NOT tests
# — see that block for why, and for the known-red state of the one that exists.
#
# 🔴 THE SUITE LIST IS DISCOVERED, NOT HAND-MAINTAINED. Earlier versions of
# this file called `run_suite` once per suite from a hand-typed list below, and
# that list silently fell behind the tree: `shell/responsiveness-browser-test.mjs`
# existed and CI ran it (in `ci.yml`'s "geometry" step, 20/20 on `main`), while
# this script never had a line for it — so `./tools/test.sh shell` ran a
# strictly smaller set than CI did, and nobody could tell just by reading this
# file. Now: every `shell/**/*-test.mjs` (excluding `node_modules`) is found on
# disk and classified as node-only or real-browser — see "SUITE DISCOVERY"
# below — so a new suite file is picked up the moment it lands, with no edit to
# this script required. `--list` prints exactly what was discovered, one per
# line, and exits 0, for exactly this reason: "is my new suite actually going
# to run" is answerable without reading this file at all.
#
# `--family portable|geometry|all` (default `all`) mirrors the OS split
# `.github/workflows/ci.yml`'s `shell` job uses for its real-browser suites —
# see "CI FAMILY SPLIT" below. `all` runs every discovered suite regardless of
# family, same as this script has always defaulted to.
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
# The node-only shell suites need `shell/node_modules` for `jsdom`:
# `cd shell && bun install`. This script does not do that either, for the same
# reason; without it those suites fail on the import rather than skipping,
# because jsdom is a declared dependency and its absence is a broken checkout,
# not an optional extra.
#
# `shell/ezil/ui/Settings/computers-drift.test.tsx` is a vitest file, not a
# `.mjs` suite, and is part of the `app` vitest project; it runs under `--app`.
#
# ═══════════════════════════════════════════════════════════════════════════
# SUITE-SPECIFIC HISTORY (kept for context — these notes used to sit right
# above each suite's own `run_suite` line; now that the list is generated,
# they live here instead)
# ═══════════════════════════════════════════════════════════════════════════
# `shell/ezil/boot-test.mjs` needs MORE THAN 120s. At 120s it is killed
#   mid-run and looks like a hang; MEASURED green well inside 300s (177s here).
#   Its 420s budget below must not be lowered.
# `shell/ezil/apps/desktop-close-test.mjs` is the close/release suite (28
#   checks, node-only, drives the built bundle). It landed from a sibling
#   worktree; this file used to skip it cleanly while it existed only there.
# `shell/ezil/apps/mobile-browser-test.mjs` is the only suite in this tree
#   that runs with hasTouch/isMobile and a phone UA; see its own header for
#   why that matters.
#
# ✅ THE W5/W7 INTENT CONFLICT RECORDED HERE IS RESOLVED (V1, Phase 2).
# The block that used to sit here described a suite that was 26/26 on W5's own
# branch and 9/24-plus-an-uncaught-timeout after the merge, and escalated the
# choice rather than making it. The coordinator's decision, now implemented:
#
#   • W7's behaviour STANDS. A phone window has no live resize handles and
#     an app-bearing phone window is full-bleed. Nothing in `.device-*` or in
#     `set_device_class` was weakened to make W5's suite pass.
#   • W5's HARNESS adapted. `touch-focus-browser-test.mjs` now pins
#     `device-desktop` — 1024x844 plus one narrowly-scoped `(pointer: coarse)`
#     override — while keeping `hasTouch: true`, so every tap is still real
#     Chromium touch input. See that file's own header for exactly what is and
#     is not pinned. 28/28 (its original 26 plus two setup checks that assert
#     the pin, so it cannot silently drift back to the wrong device class).
#
# WHO OWNS WHAT NOW, so the split is not rediscovered the hard way:
#   • `shell/touch-focus-browser-test.mjs`      — the BINDING MECHANICS of
#     §7.1 at desktop-class layout: one tap reaches a defocused iframe,
#     pointerdown + mousedown = ONE focus, the titlebar / resize-handle /
#     app-drawer bindings, and the `UIContextMenu` pointer-events restore path.
#   • `shell/ezil/apps/mobile-browser-test.mjs`  — the PHONE-LAYOUT
#     ACCEPTANCE: one tap reaches the stream at a real phone viewport with a
#     real phone UA, under W7's full-bleed layout. Nothing was lost by moving
#     the suite above to desktop class; this is where that claim lives.
#   • `shell/phone-stacking-browser-test.mjs`   — STACKING at the touch
#     device classes.
# Window stacking at `device-phone` / `device-tablet` — the classes W7's
# widened detection made reachable from an ordinary desktop session, and the
# only ones `ezil/ui/Settings/stacking-browser-test.mjs` (five DESKTOP
# viewports, no touch) has never covered. Added with the fix to the flat
# `.device-* .window { z-index: 9999999 !important }` band; red on the pre-fix
# sheet (25/38, exit 1), green on this one (38/38).

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
FAMILY="all"
LIST_ONLY=0

usage () {
    cat <<'EOF'
shell/run-tests.sh — run every EZiL-OS shell suite and print one honest verdict.

  --all           also run `worker/` (bun test) and `app/` (bun run test)
  --worker        also run `worker/` bun test
  --app           also run `app/` vitest
  --no-check      skip the `build-shell.sh --check` bundle-drift gate
  --cost          also run the cost probes (display-gate-cost.mjs). A benchmark,
                  not a suite: read its medians, it has no threshold.
  --strict        exit non-zero if ANY suite SKIPPED (use this in CI)
  --only <sub>    run only suites whose path contains <sub>
  --family <f>    all (default) | portable | geometry — restrict this run to
                  the real-browser suites in the named OS family
                  `.github/workflows/ci.yml`'s `shell` job runs them under.
                  `portable`/`geometry` run ONLY that family's real-browser
                  suites (node-only suites are skipped entirely, not run);
                  `all` runs everything, same as always. A suite `ci.yml`
                  classifies into neither family is an ERROR under
                  `--family portable`/`--family geometry` (not a silent skip)
                  — see "CI FAMILY SPLIT" in this file.
  --list          print the suites this invocation would run, one per line
                  (honouring --only and --family), and exit 0. Does not run
                  anything, including the bundle-drift gate.
  -h, --help      this text

Exit codes: 0 = no failures. 1 = at least one failure (or, with --strict, at
least one skip). Individual suites: 0 PASS, 1 FAIL, 2 SKIP.

Environment:
  PLAYWRIGHT_REQUIRE_DIR   directory from which the browser suites resolve
                           `playwright`. Falls back to $EZIL_PLAYWRIGHT_DIR.
                           If neither resolves, the browser suites SKIP.
  EZIL_PLAYWRIGHT_DIR      optional fallback for the above.
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
        --family)   shift; FAMILY="${1:-all}" ;;
        --list)     LIST_ONLY=1 ;;
        -h|--help)  usage; exit 0 ;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 64 ;;
    esac
    shift
done

case "$FAMILY" in
    all|portable|geometry) ;;
    *)
        echo "unknown --family: $FAMILY (expected: all, portable, geometry)" >&2
        exit 64
        ;;
esac

# ═══════════════════════════════════════════════════════════════════════════
# SUITE DISCOVERY
# ═══════════════════════════════════════════════════════════════════════════
# Every `*-test.mjs` under `shell/` (excluding anything under a `node_modules`
# directory) is a suite. Classified as real-browser or node-only by WHAT IT
# REQUIRES, not by its name: `*-browser-test.mjs` is the naming convention
# every suite so far has followed, but `resize-test.mjs` needs playwright too
# without following it, so the real test is whether the file itself resolves
# `$PLAYWRIGHT_REQUIRE_DIR` (every real-browser suite in this tree does,
# MEASURED by grep across all of them — see the mutation proof in this row's
# report for the check). A suite matching neither test is node-only.
#
# bash 3.2 (this script also runs on macOS in CI) has no `mapfile`; a plain
# `while read` loop over `find` is the portable substitute.
is_browser_suite () {
    local rel="$1"
    case "$rel" in
        *-browser-test.mjs) return 0 ;;
    esac
    grep -q 'PLAYWRIGHT_REQUIRE_DIR' "$ROOT/$rel" 2>/dev/null
}

NODE_SUITES=()
BROWSER_SUITES=()
while IFS= read -r abs; do
    [ -n "$abs" ] || continue
    rel="${abs#$ROOT/}"
    if is_browser_suite "$rel"; then
        BROWSER_SUITES+=("$rel")
    else
        NODE_SUITES+=("$rel")
    fi
done < <(find "$HERE" \( -name node_modules -type d \) -prune -o -type f -name '*-test.mjs' -print | sort)

# ── per-suite time budgets ──────────────────────────────────────────────────
# bash 3.2 has no `declare -A` (this script runs on macOS too), so a `case` on
# the suite's basename is the associative-map substitute. Anything not listed
# gets the family default: 120s for a node/jsdom suite, 300s for a
# real-browser one. Every override below is MEASURED, not a guess — see
# "SUITE-SPECIFIC HISTORY" above and each suite's own header comment.
default_budget () {
    if is_browser_suite "$1"; then echo 300; else echo 120; fi
}

suite_budget () {
    local base
    base="$(basename "$1")"
    case "$base" in
        boot-test.mjs)                    echo 420 ;;
        desktop-close-test.mjs)           echo 300 ;;
        settings-test.mjs)                echo 180 ;;
        code-test.mjs)                     echo 180 ;;
        preview-focus-test.mjs)            echo 180 ;;
        registry-trace-test.mjs)           echo 180 ;;
        os-chrome-browser-test.mjs)        echo 420 ;;
        stacking-browser-test.mjs)         echo 600 ;;
        resize-test.mjs)                   echo 420 ;;
        mobile-browser-test.mjs)           echo 420 ;;
        touch-focus-browser-test.mjs)      echo 420 ;;
        phone-stacking-browser-test.mjs)   echo 420 ;;
        *) default_budget "$1" ;;
    esac
}

# ═══════════════════════════════════════════════════════════════════════════
# CI FAMILY SPLIT
# ═══════════════════════════════════════════════════════════════════════════
# `.github/workflows/ci.yml`'s `shell` job splits real-browser suites into two
# per-OS legs: PORTABLE (behaviour — focus, stacking, paint order, a mobile
# keyboard — every OS) and GEOMETRY (pixel deltas and settle times of a real
# Chromium, designed and measured on Linux; on macOS Chromium the same shell
# settles at 1919px instead of 1920 and a minimise/restore cycle differs by
# 5-6px — rendering-platform noise, not a product defect — so GEOMETRY runs on
# the Linux leg only). The two arrays below are a literal copy of ci.yml's two
# `for t in ...` lists ("Shell real-browser suites (portable)" and "... —
# Linux only)", currently ci.yml:387-391 and :400-405 — match by step name if
# the line numbers have drifted since.
#
# 🔴 THESE MUST AGREE WITH `ci.yml` BY HAND. There is no automated check that
# diffs this copy against the workflow file — a test doing that belongs beside
# whoever owns `.github/workflows/ci.yml`, and is out of this file's
# `owns_files`; HAND-OFF. If ci.yml's two lists change, update these two
# arrays in the same PR.
#
# 🔴 A `*-browser-test.mjs` IN NEITHER LIST IS AN ERROR, NOT A SILENT SKIP.
# MEASURED: `shell/ezil/display-notice-browser-test.mjs`,
# `shell/ezil/launcher-toggle-browser-test.mjs` and
# `shell/ezil/context-menu-stack-browser-test.mjs` are real suites in this tree
# that `ci.yml` does not name in EITHER list — so neither OS family in CI runs
# them today. `--family all` (the default) still runs them, unfiltered, same
# as always. `--family portable` / `--family geometry` refuse to guess which
# family such a suite belongs to: each one is reported as a FAILURE naming the
# gap, never silently dropped and never silently included. HAND-OFF: `ci.yml`
# needs to add these three suites to one of its two `for` loops.
GEOMETRY_SUITES=(
    "shell/responsiveness-browser-test.mjs"
    "shell/seam-minimise-browser-test.mjs"
    "shell/window-chrome-browser-test.mjs"
    "shell/phone-stacking-browser-test.mjs"
    "shell/ezil/apps/overlay-paint-browser-test.mjs"
    "shell/ezil/apps/resize-test.mjs"
)
PORTABLE_SUITES=(
    "shell/touch-focus-browser-test.mjs"
    "shell/ezil/apps/os-chrome-browser-test.mjs"
    "shell/ezil/apps/mobile-browser-test.mjs"
    "shell/ezil/ui/Settings/stacking-browser-test.mjs"
    "shell/ezil/ui/Settings/late-focus-browser-test.mjs"
)

# suite_family <relpath> -> "portable", "geometry", or "" (unclassified)
suite_family () {
    local rel="$1" x
    for x in "${GEOMETRY_SUITES[@]}"; do
        [ "$x" = "$rel" ] && { echo geometry; return; }
    done
    for x in "${PORTABLE_SUITES[@]}"; do
        [ "$x" = "$rel" ] && { echo portable; return; }
    done
    echo ""
}

# suite matches --only, or --only was not given
matches_only () {
    [ -z "$ONLY" ] && return 0
    case "$1" in
        *"$ONLY"*) return 0 ;;
        *) return 1 ;;
    esac
}

# ── --list: print and exit before touching playwright or the bundle ────────
if [ "$LIST_ONLY" = 1 ]; then
    if [ "$FAMILY" = "all" ]; then
        for f in ${NODE_SUITES[@]+"${NODE_SUITES[@]}"}; do
            matches_only "$f" && echo "$f"
        done
    fi
    for f in ${BROWSER_SUITES[@]+"${BROWSER_SUITES[@]}"}; do
        matches_only "$f" || continue
        if [ "$FAMILY" = "all" ]; then
            echo "$f"
        else
            [ "$(suite_family "$f")" = "$FAMILY" ] && echo "$f"
        fi
    done
    exit 0
fi

# ── playwright resolution ──────────────────────────────────────────────────
DEFAULT_PW_DIR="${EZIL_PLAYWRIGHT_DIR:-}"
if [ -z "${PLAYWRIGHT_REQUIRE_DIR:-}" ] && [ -n "$DEFAULT_PW_DIR" ] && [ -d "$DEFAULT_PW_DIR/playwright" ]; then
    export PLAYWRIGHT_REQUIRE_DIR="$DEFAULT_PW_DIR"
    PW_NOTE="defaulted to $DEFAULT_PW_DIR"
elif [ -n "${PLAYWRIGHT_REQUIRE_DIR:-}" ]; then
    export PLAYWRIGHT_REQUIRE_DIR
    PW_NOTE="from the environment: $PLAYWRIGHT_REQUIRE_DIR"
else
    PW_NOTE="UNSET (and no \$EZIL_PLAYWRIGHT_DIR fallback) — every browser suite will SKIP"
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
echo "  family:     $FAMILY"
echo "  logs:       $LOGDIR"
echo

# ── gate 0: bundle drift ───────────────────────────────────────────────────
# Every `*-test.mjs` this script discovers under shell/ tests the COMMITTED
# bundle in `app/public/os`, not the sources. If the bundle has drifted from
# source, every result below is about code that is not the code in the tree,
# so this is fail-fast rather than just another suite.
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

# ── the ci.yml drift warning, printed once, for a real run only ────────────
ORPHAN_SUITES=()
for f in ${BROWSER_SUITES[@]+"${BROWSER_SUITES[@]}"}; do
    [ -z "$(suite_family "$f")" ] && ORPHAN_SUITES+=("$f")
done
if [ "${#ORPHAN_SUITES[@]}" -gt 0 ]; then
    echo "${C_FAIL}${C_B}  DRIFT: ${#ORPHAN_SUITES[@]} real-browser suite(s) are in NEITHER of ci.yml's${C_0}"
    echo "${C_FAIL}${C_B}  'portable'/'geometry' lists (see CI FAMILY SPLIT above):${C_0}"
    for o in "${ORPHAN_SUITES[@]}"; do echo "${C_FAIL}    - $o${C_0}"; done
    echo "${C_FAIL}  --family all still runs them, unfiltered. --family portable/geometry cannot${C_0}"
    echo "${C_FAIL}  select a suite this script cannot place, and will FAIL rather than guess.${C_0}"
    echo
fi

# ═══════════════════════════════════════════════════════════════════════════
# The node-only suites (jsdom / pure function). No browser, no playwright.
# ═══════════════════════════════════════════════════════════════════════════
echo "${C_B}[1/2] node-only suites (${#NODE_SUITES[@]})${C_0}"
if [ "$FAMILY" = "all" ]; then
    for f in ${NODE_SUITES[@]+"${NODE_SUITES[@]}"}; do
        run_suite "$f" "$(suite_budget "$f")" node "$ROOT/$f"
    done
else
    echo "  (skipped: --family $FAMILY restricts this run to real-browser suites)"
fi
echo

# ═══════════════════════════════════════════════════════════════════════════
# The browser suites. Every one of these exits 2 when playwright or the built
# bundle is unresolvable, and that 2 is a SKIP above. So is a suite whose file
# is not in this worktree yet — several are owned by sibling agents.
# ═══════════════════════════════════════════════════════════════════════════
echo "${C_B}[2/2] real-browser suites (${#BROWSER_SUITES[@]})${C_0}"
for f in ${BROWSER_SUITES[@]+"${BROWSER_SUITES[@]}"}; do
    if [ "$FAMILY" != "all" ]; then
        if [ -n "$ONLY" ] && [[ "$f" != *"$ONLY"* ]]; then
            continue
        fi
        fam="$(suite_family "$f")"
        if [ -z "$fam" ]; then
            FAILED+=("$f")
            SUMMARY+=("${C_FAIL}FAIL${C_0}    $f -> unclassified: not in ci.yml's portable or geometry list; --family $FAMILY cannot select it (see DRIFT above)")
            printf '%s\n' "${C_FAIL}FAIL${C_0}     $f  ${C_DIM}(unclassified — an error, not a skip; see DRIFT above)${C_0}"
            continue
        fi
        [ "$fam" = "$FAMILY" ] || continue
    fi
    run_suite "$f" "$(suite_budget "$f")" node "$ROOT/$f"
done
echo

# ═══════════════════════════════════════════════════════════════════════════
# COST PROBES — off by default, behind --cost. NOT test suites.
# ═══════════════════════════════════════════════════════════════════════════
# 🔴 `shell/ezil/display-gate-cost.mjs` is a BENCHMARK, not a suite: its own
# header calls it a cost probe for PLATFORM-NOTES §16c, it takes `SAMPLES`, and
# it reports medians rather than checks. It is deliberately not one of the
# discovered `*-test.mjs` suites above, and running it by default would be
# wrong twice over — it would add wall time nobody asked for, and its number is
# a measurement to be read, not a threshold to be passed.
#
# It WAS red — and it is not any more. MEASURED red on the unmodified bundle
# under playwright 1.61.1: an uncaught
#   `page.waitForSelector: Timeout 15000ms exceeded` waiting for
#   `.window[data-app="desktop"] .window-app-iframe`
# so it exited 1 with a stack instead of a result. W8 diagnosed it as a stale
# harness rather than a shell regression: the file injected the bundle and then
# waited for the desktop window WITHOUT ever calling `window.ezil.boot()` or
# activating the dock item, having been written against a base where `boot.js`
# auto-launched `apps[0]`. Login now opens NOTHING.
#
# FIXED by integration, 2026-08-19, in `display-gate-cost.mjs` itself — the same
# `boot()` + dock-click pair `apps/os-chrome-browser-test.mjs` already uses, and
# `t_boot` moved to after the click so `settle_ms` still measures the gate and
# not script evaluation. It stays behind `--cost` because it is still a
# benchmark and not a suite; it is no longer advertised as KNOWN RED, so a red
# here now means something.
if [ "$RUN_COST" = "1" ]; then
    echo "${C_B}[opt] cost probes${C_0}"
    echo "${C_SKIP}  note: this is a BENCHMARK. Read its medians; it has no threshold.${C_0}"
    run_suite "shell/ezil/display-gate-cost.mjs (cost probe)" 600 node "$HERE/ezil/display-gate-cost.mjs"
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
