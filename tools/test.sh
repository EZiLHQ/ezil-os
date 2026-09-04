#!/usr/bin/env bash
#
# The only sanctioned way to run this repository's suites.
#
#   tools/test.sh <app|worker|shell|sdk|mcp|tools|local|all> [extra args...]
#
# ═══════════════════════════════════════════════════════════════════════════
# WHY A WRAPPER EXISTS AT ALL
# ═══════════════════════════════════════════════════════════════════════════
# EZiL-OS has no root package.json and no workspace. Six independent projects
# have six different real commands, and every one of them has at least one way
# of reporting "nothing went wrong" that is not the same as "it was checked":
#
#   * `worker` boots a REAL container for `*.container.test.ts`. Every one of
#     those suites gates on `docker image inspect` and SKIPS when the image is
#     absent. CI's own comment calls that green-by-absence. `bun test` then
#     prints `0 fail` and exits 0, and a skipped container suite has proved
#     exactly nothing about the container.
#   * `shell` runs twelve real-browser suites that exit 2 -- SKIPPED -- when
#     playwright is unresolvable. `shell/run-tests.sh` already refuses to call
#     that a pass, but only with `--strict`; without it the process exits 0.
#   * `tools` has no node_modules, so its `typecheck` cannot find a `tsc`
#     unless something puts one on PATH. It did not, until this file.
#
# So this wrapper has exactly two jobs: run the RIGHT command per package, and
# refuse to let an unrun test look like a passed one.
#
# ═══════════════════════════════════════════════════════════════════════════
# THE THREE RULES (ported verbatim from EZiL-Works/tools/test.sh)
# ═══════════════════════════════════════════════════════════════════════════
# Overriding a non-zero exit is normally how a real failure gets buried. This
# one is written to fail closed, and each rule exists because of a specific way
# the naive version would lie:
#
#   1. The summary line must be PRESENT. If Bun crashes, is killed, or the
#      runtime dies mid-run, there is no summary -- and "no failures reported"
#      is not the same as "no failures". Absent summary is a failure here.
#   2. The failure count must be exactly 0. Not "not matched", not "empty" --
#      a parse that finds nothing is treated as a failure, not a pass.
#   3. Any exit code other than 0 is passed through untouched. This wrapper
#      knows about no benign exit codes at all and refuses to invent one.
#
# The EZiL-Works original carried a fourth thing here: a `BENIGN_PGLITE_EXIT=99`
# escape for a PGlite/Bun teardown quirk, and the 60-second default `--timeout`
# that PGlite's boot needed. Neither is ported. There is no PGlite in EZiL-OS,
# and a wrapper that knows about a quirk nobody here has is a wrapper that will
# one day swallow a real 99. Rule 3 therefore has no exception, which is also
# why rules 1 and 2 only ever run on an exit of 0: they exist for the case
# where bun exits 0 and the summary is missing or unreadable anyway.
#
# `--timeout` is likewise NOT set by default, and that is a measurement rather
# than an omission. The real worker suite on this machine is 1061 tests over 39
# files in 245 s under Bun's 5000 ms default; two of the three container suites
# boot a real container and PASS under it (they boot at module scope, not in a
# lifecycle hook). The third, `scripts/mobile-keyboard.container.test.ts`, fails
# 8 of 8 -- and that is NOT a timeout artifact: re-run with
# `EZIL_TEST_TIMEOUT_MS=600000`, the same 8 fail in 9.6 s, so raising the budget
# changes nothing and the timeout is not the variable. A default copied from the
# sibling project would have looked like a fix for a problem it does not touch.
# `EZIL_TEST_TIMEOUT_MS` is still there for a slow machine.
#
# ═══════════════════════════════════════════════════════════════════════════
# 🔴 THE SKIP HAZARD, WHICH IS THE REASON THIS FILE IS AN OPUS ROW
# ═══════════════════════════════════════════════════════════════════════════
# A skipped test is never a pass. Two gates, both of which announce themselves
# when they are switched off, because a check that can be silently skipped is a
# check that will be:
#
#   * `worker`: every skipped test is NAMED BY SUITE. If any of them is in a
#     `*.container.test.ts`, this exits non-zero unless
#     `EZIL_ALLOW_SKIPPED_CONTAINER_TESTS=1` -- which prints a line saying so.
#     That gate covers TWO of this repository's three container suites, because
#     it can only see a skip bun recorded. The third,
#     `worker/scripts/mobile-keyboard.container.test.ts`, returns early from
#     inside its test bodies and is counted as PASSING with no image at all
#     (measured: `8 pass, 0 skip`). `gate_vacuous_container_passes` below is the
#     positive assertion that catches that shape; see its comment.
#   * `shell`: `shell/run-tests.sh` is invoked with `--strict`, which is how
#     that runner turns a suite that did not run into a failure. Drop the
#     strictness with `EZIL_ALLOW_SKIPPED_BROWSER_SUITES=1` -- which prints a
#     line saying so.
#
# ── Why the worker gate is on CONTAINER skips and not on every skip ─────────
# Because it was measured, not assumed. `bun test` in `worker/` on a green tree
# reports ELEVEN skips that have nothing to do with Docker:
#
#     10  src/browser-sidecar-contract.test.ts   the pinned wire contract lives
#                                                in the EZiL-Works checkout;
#                                                absent -> the suite skips (and
#                                                it is ALWAYS absent from a
#                                                worktree, whose ../../.. is the
#                                                worktree, not the projects dir)
#      1  src/preview-timeouts.test.ts           documented in that file as the
#                                                project's one PERMANENT skip
#
# A gate on "any skip at all" would therefore be red on every green tree, which
# is how a gate gets turned off in a shell profile and never turned back on.
# Those skips are still PRINTED, every run, by name and count -- naming is the
# rule (`_MANDATORY` §7); failing the build is the gate the brief asks for, and
# it belongs on the suites that are green-by-absence.
#
# ── Why the skip count comes from the junit report ──────────────────────────
# `bun test` prints a `N skip` line and nothing about WHICH tests, and it omits
# the line entirely when nothing skipped. Reading the count out of the text
# would make "the line is missing" indistinguishable from "zero skipped".
# `--reporter=junit` emits one `<testcase file="...">` per test with a
# `<skipped />` child and a total on the root element, so the names are real
# and the total is checkable against them. A junit file that is missing, or
# whose per-file counts do not add up to the total it declares, is a FAILURE --
# an unreadable skip count is not zero skips.

set -uo pipefail

# ── The tree this copy of the script lives in ───────────────────────────────
# Deliberately NOT the main checkout (which is what `tools/worktree.sh` needs).
# A worktree carries its own copy of this file, and it must test THAT tree:
# resolving to main would run a task's verification against sources the task
# has not edited, which is the same class of bug as the whole-directory
# node_modules symlink `worktree.sh` exists to avoid.
TREE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# ── tsc for tools/ (O2 hand-off) ────────────────────────────────────────────
# `tools/` has no node_modules and installs nothing, so `bun run typecheck`
# there has no `tsc` on PATH. Its tsconfig already reaches the types
# (`typeRoots: ["../sdk/node_modules/@types"]`); only the binary was missing.
# A hydrated worktree also gets `tools/node_modules/.bin` from `worktree.sh`;
# this line is what makes the MAIN tree work too, and what makes the invariant
# hold no matter which of the two you are standing in.
PATH="$TREE/sdk/node_modules/.bin:$PATH"
export PATH

TIMEOUT_ARGS=()
if [ -n "${EZIL_TEST_TIMEOUT_MS:-}" ]; then
    TIMEOUT_ARGS=("--timeout=${EZIL_TEST_TIMEOUT_MS}")
fi

TMPFILES=()
cleanup () { [ "${#TMPFILES[@]}" -eq 0 ] || rm -f -- "${TMPFILES[@]}"; }
trap cleanup EXIT

say  () { printf '%s\n' "==> $*" >&2; }
line () { printf '%s\n' "$*" >&2; }

# ── Stage 1: types ──────────────────────────────────────────────────────────
# It runs BEFORE the tests, not after, because a type error is usually the
# explanation for whatever the tests are about to do -- and reading it first
# saves the test output in between. This stage did not exist on the sibling
# project, and its absence had already been paid for: a run reporting
# "1175 pass, 0 fail" sat on top of a package that did not compile. `bun test`
# strips types rather than checking them, so every assertion was real and every
# one of them was made against code `tsc` refuses.
#
# EZIL_SKIP_TYPECHECK=1 exists for a tight edit loop on a single test file. It
# announces itself.
typecheck () {
    local dir="$1"; shift
    local rc
    if [ "${EZIL_SKIP_TYPECHECK:-0}" = "1" ]; then
        say "EZIL_SKIP_TYPECHECK=1: types NOT checked in this run."
        return 0
    fi
    ( cd "$dir" && "$@" )
    rc=$?
    if [ "$rc" -ne 0 ]; then
        say "typecheck failed. Not running the tests: they would assert against code that does not compile."
        return 1
    fi
    return 0
}

# ── The junit skip table ────────────────────────────────────────────────────
# Emits, on stdout, tab-separated rows:
#   TOTAL <n>          the count the report declares on its root element
#   SEEN  <n>          the count actually attributed to a file below
#   FILE  <n> <path>   skipped tests in that file (only when there are some)
#   TESTS <n> <path>   ALL tests in that file, skipped or not. This is what
#                      `gate_vacuous_container_passes` needs: a container suite
#                      with tests and NO skips is the shape it looks for.
skip_table () {
    awk '
        /<testsuites / {
            if (match($0, /skipped="[0-9]+"/)) total = substr($0, RSTART + 9, RLENGTH - 10)
        }
        /<testcase / {
            if (match($0, /file="[^"]*"/)) f = substr($0, RSTART + 6, RLENGTH - 7)
            t[f]++
        }
        /<skipped/ { c[f]++; seen++ }
        END {
            printf "TOTAL\t%s\n", (total == "" ? "?" : total)
            printf "SEEN\t%d\n", seen + 0
            for (k in c) printf "FILE\t%d\t%s\n", c[k], k
            for (k in t) printf "TESTS\t%d\t%s\n", t[k], k
        }
    ' "$1"
}

CONTAINER_SKIPS=0
OTHER_SKIPS=0
SKIP_TABLE=""

# 0 = report read and printed. 1 = the report could not be read or does not add
# up, which is a failure, never zero skips.
report_skips () {
    local xml="$1"
    CONTAINER_SKIPS=0
    OTHER_SKIPS=0

    if [ ! -s "$xml" ]; then
        say "no junit report was written, so this wrapper cannot tell which tests were skipped."
        say "  An unreadable skip count is not zero skips. Treating as a failure."
        return 1
    fi

    local table total seen count file kind
    table="$(skip_table "$xml")"
    SKIP_TABLE="$table"
    total="$(printf '%s\n' "$table" | awk -F'\t' '$1 == "TOTAL" { print $2 }')"
    seen="$(printf '%s\n' "$table"  | awk -F'\t' '$1 == "SEEN"  { print $2 }')"

    case "$total" in
        ''|*[!0-9]*)
            say "the junit report declares no readable skip count. Treating as a failure."
            return 1
            ;;
    esac
    if [ "$total" -ne "$seen" ]; then
        say "the junit report declares ${total} skipped test(s) but only ${seen} could be attributed"
        say "  to a file. Refusing to guess which suites did not run. Treating as a failure."
        return 1
    fi
    [ "$total" -eq 0 ] && return 0

    say "${total} test(s) were SKIPPED. A skip is not a pass. By suite:"
    while IFS=$'\t' read -r _ count file; do
        case "$file" in
            *.container.test.ts)
                kind="   [CONTAINER — green-by-absence]"
                CONTAINER_SKIPS=$(( CONTAINER_SKIPS + count ))
                ;;
            *)
                kind=""
                OTHER_SKIPS=$(( OTHER_SKIPS + count ))
                ;;
        esac
        line "$(printf '      %4d  %s%s' "$count" "$file" "$kind")"
    done < <(printf '%s\n' "$table" | awk -F'\t' '$1 == "FILE"')
    return 0
}

# ── Stage 2: a bun suite, with all three rules ──────────────────────────────
# $1 = directory to run in; the rest are passed to `bun test`.
run_bun () {
    local dir="$1"; shift
    local out xml bun_exit failed rc=0

    out="$(mktemp)"; xml="$(mktemp)"
    TMPFILES+=("$out" "$xml")

    (
        cd "$dir" || exit 127
        bun test ${TIMEOUT_ARGS[@]+"${TIMEOUT_ARGS[@]}"} \
            --reporter=junit --reporter-outfile="$xml" "$@"
    ) 2>&1 | tee "$out"
    bun_exit="${PIPESTATUS[0]}"

    # The skip report is printed whatever the outcome: a run that both failed
    # and skipped has two things wrong with it, and hiding the second behind
    # the first is how the second one survives.
    report_skips "$xml" || rc=1

    # Rule 3: a non-zero exit is reported as itself, with no interpretation
    # laid over it. Deliberately NOT worded as "unrecognised": bun exits 1 for
    # an ordinary failing test, and a wrapper that calls its most common exit
    # code a mystery is a wrapper people stop reading.
    if [ "$bun_exit" -ne 0 ]; then
        say "bun test exited ${bun_exit}. This wrapper adds no interpretation to a non-zero exit"
        say "  and knows no benign ones; reporting it as-is. The summary above is what happened."
        return "$bun_exit"
    fi

    # Rule 1: no summary means we do not know what happened, which is a failure.
    if ! grep -qE '^[[:space:]]*[0-9]+ (pass|fail)' "$out"; then
        say "No test summary was printed. The run did not complete; treating as failure."
        return 1
    fi

    # Rule 2: a count we cannot read is a failure, not a pass.
    failed="$(grep -oE '^[[:space:]]*[0-9]+ fail' "$out" | grep -oE '[0-9]+' | head -1)"
    if [ -z "$failed" ]; then
        say "Could not read the failure count from the summary; treating as failure."
        return 1
    fi
    [ "$failed" -eq 0 ] || rc=1

    return "$rc"
}

# ── The container-skip gate ─────────────────────────────────────────────────
# Call after run_bun. Returns non-zero when a container suite did not run and
# the run has not been explicitly told to accept that.
gate_container_skips () {
    [ "$CONTAINER_SKIPS" -gt 0 ] || return 0
    if [ "${EZIL_ALLOW_SKIPPED_CONTAINER_TESTS:-0}" = "1" ]; then
        say "EZIL_ALLOW_SKIPPED_CONTAINER_TESTS=1: ${CONTAINER_SKIPS} skipped container test(s) ALLOWED."
        say "  Nothing above has verified any container behaviour. This run is not evidence"
        say "  that the image works, and must not be reported as if it were."
        return 0
    fi
    say "${CONTAINER_SKIPS} container test(s) SKIPPED, and not one of them is a pass."
    say "  Build the image first:  cd worker && docker build -t ezil-integrated:local ."
    say "  Or set EZIL_ALLOW_SKIPPED_CONTAINER_TESTS=1 to accept a run that proves nothing"
    say "  about the container. That flag prints a line every time it is used."
    return 1
}

# ── The vacuous-container-pass gate ─────────────────────────────────────────
# The skip gate above can only see a test that bun RECORDED as skipped, and one
# of this repository three container suites does not produce one.
#
# MEASURED: with the image absent, `worker/scripts/mobile-keyboard.container.test.ts`
# reports `8 pass, 0 skip`. Five of its eight `it` bodies do
# `console.warn(...SKIPPING, not passing...); return;` -- an early return from
# inside a test body, which bun counts as a PASS. The warning says the right
# thing and the runner records the opposite, so `EZIL_ALLOW_SKIPPED_CONTAINER_TESTS`
# never sees it and the run reads green with a container nobody started. Handed
# off in the O3 report; until it is fixed, this is the positive assertion that
# catches it.
#
# The rule: when EVERY image the container suites could use is absent, a
# `*.container.test.ts` that reports a non-skipped test has reported a result it
# cannot have obtained. Requiring ALL of them absent (not any) is what keeps
# this from firing on a machine where one env override points somewhere real.
gate_vacuous_container_passes () {
    [ -n "$SKIP_TABLE" ] || return 0

    local images=("${EZIL_VALIDATE_IMAGE:-ezil-integrated:local}" "${EZIL_NEKO_IMAGE:-ezil-integrated:local}")
    local img
    for img in "${images[@]}"; do
        # A reachable image means the suites could really have run. Not our case.
        docker image inspect "$img" >/dev/null 2>&1 && return 0
    done

    local rc=0 count file skipped ran
    while IFS=$'\t' read -r _ count file; do
        case "$file" in
            *.container.test.ts) ;;
            *) continue ;;
        esac
        skipped="$(printf '%s\n' "$SKIP_TABLE" | awk -F'\t' -v f="$file" '$1 == "FILE" && $3 == f { print $2 }')"
        [ -n "$skipped" ] || skipped=0
        ran=$(( count - skipped ))
        [ "$ran" -gt 0 ] || continue
        say "$file reported ${ran} test(s) as run while every image those suites use is absent"
        say "  (${images[*]}). A container test that never reached a container did not pass, it did"
        say "  not run. bun records an early return inside an it body as a PASS, which is exactly"
        say "  how a suite like this reads green. This is not covered by"
        say "  EZIL_ALLOW_SKIPPED_CONTAINER_TESTS, because nothing was recorded as skipped."
        rc=1
    done < <(printf '%s\n' "$SKIP_TABLE" | awk -F'\t' '$1 == "TESTS"')
    return "$rc"
}

note_other_skips () {
    [ "$OTHER_SKIPS" -gt 0 ] || return 0
    say "${OTHER_SKIPS} further test(s) skipped for reasons outside this gate (named above)."
    say "  They are not failed here because they skip on a green tree too -- but they were"
    say "  NOT run, and nothing above is evidence about what they check."
}

# ── Packages ────────────────────────────────────────────────────────────────
run_app () {
    # `app` is the one project that is neither bun-tested nor typechecked by
    # `bun run typecheck`: it is Next.js, `npx tsc` and `npx vitest`, exactly as
    # `.github/workflows/ci.yml` runs it. The three rules above are bun summary
    # rules and do not apply; vitest's exit code is passed straight through.
    typecheck "$TREE/app" npx tsc --noEmit -p tsconfig.json || return 1
    # A configured linter nobody runs is a linter that is already failing.
    ( cd "$TREE/app" && bun run lint ) || return 1
    ( cd "$TREE/app" && npx vitest run )
}

run_worker () {
    local rc=0
    typecheck "$TREE/worker" bun run typecheck || return 1
    run_bun "$TREE/worker" "$@" || rc=1
    gate_container_skips || rc=1
    gate_vacuous_container_passes || rc=1
    note_other_skips
    return "$rc"
}

run_shell () {
    # `shell/run-tests.sh` runs `build-shell.sh --check` itself, fail-fast,
    # before any suite -- so this does not duplicate it. 🔴 That check is not
    # decoration: `app/public/os/bundle.min.js` is COMMITTED, and a source
    # change without a rebuild ships the old behaviour while everything else
    # passes against the new source.
    #
    # 🔴 MEASURED BLOCKER, in a file this row does not own: with neither
    # PLAYWRIGHT_REQUIRE_DIR nor EZIL_PLAYWRIGHT_DIR set -- the default state of
    # this machine and of a CI runner before the install step --
    # `shell/run-tests.sh` line 161 aborts with
    #
    #     shell/run-tests.sh: line 161: EZIL_PLAYWRIGHT_DIR: unbound variable
    #
    # because that line expands `$EZIL_PLAYWRIGHT_DIR` inside a message meant to
    # print the variable NAME, under its own `set -u`. It fails closed (exit 1),
    # so nothing is reported green that was not run, but the shell suites cannot
    # run at all until it reads `\$EZIL_PLAYWRIGHT_DIR`. Handed off in the O3
    # report. This wrapper deliberately does not work around it: setting the
    # variable here would hide a broken runner.
    local args=(--strict)
    if [ "${EZIL_ALLOW_SKIPPED_BROWSER_SUITES:-0}" = "1" ]; then
        say "EZIL_ALLOW_SKIPPED_BROWSER_SUITES=1: a browser suite that DID NOT RUN will not fail"
        say "  this run. run-tests.sh still lists every skip by name; read them."
        args=()
    fi
    bash "$TREE/shell/run-tests.sh" ${args[@]+"${args[@]}"} "$@"
}

run_sdk () {
    typecheck "$TREE/sdk" bun run typecheck || return 1
    local rc=0
    run_bun "$TREE/sdk" "$@" || rc=1
    note_other_skips
    return "$rc"
}

run_mcp () {
    typecheck "$TREE/mcp" bun run typecheck || return 1
    local rc=0
    run_bun "$TREE/mcp" "$@" || rc=1
    note_other_skips
    return "$rc"
}

run_tools () {
    typecheck "$TREE/tools" bun run typecheck || return 1
    local rc=0
    run_bun "$TREE/tools" "$@" || rc=1
    note_other_skips
    return "$rc"
}

run_local () {
    typecheck "$TREE/local" bun run typecheck || return 1
    local rc=0
    run_bun "$TREE/local" "$@" || rc=1
    note_other_skips
    return "$rc"
}

# Order matters: sdk before mcp, because mcp depends on it by `file:../sdk` and
# a break in the SDK should be reported as an SDK failure, not as a confusing
# downstream one. Same reasoning as the `connectors` job in ci.yml.
ALL_PACKAGES=(sdk mcp worker app shell tools local)

run_one () {
    local pkg="$1"; shift
    say "── ${pkg} ─────────────────────────────────────────────────────────"
    case "$pkg" in
        app)    run_app    "$@" ;;
        worker) run_worker "$@" ;;
        shell)  run_shell  "$@" ;;
        sdk)    run_sdk    "$@" ;;
        mcp)    run_mcp    "$@" ;;
        tools)  run_tools  "$@" ;;
        local)  run_local  "$@" ;;
        *)      say "unknown package: $pkg"; return 64 ;;
    esac
}

usage () {
    sed -n '2,5p' "${BASH_SOURCE[0]}" >&2
    line ""
    line "  packages: ${ALL_PACKAGES[*]}  (or: all)"
    line ""
    line "  EZIL_SKIP_TYPECHECK=1                  skip stage 1 (announces itself)"
    line "  EZIL_ALLOW_SKIPPED_CONTAINER_TESTS=1   let a skipped container suite pass"
    line "  EZIL_ALLOW_SKIPPED_BROWSER_SUITES=1    let a skipped browser suite pass"
    line "  EZIL_TEST_TIMEOUT_MS=<n>               pass --timeout=<n> to bun test"
}

PKG="${1:-}"
[ $# -gt 0 ] && shift

case "$PKG" in
"" | -h | --help)
    usage
    exit 1
    ;;
all)
    # A package directory that does not exist in this tree is NOT a skipped
    # test -- it is a tree that does not have that package (`local/` predates
    # nothing on main but is absent from any branch based before row T0). It is
    # named in the verdict rather than counted as a pass or a failure.
    FAILED_PKGS=()
    ABSENT_PKGS=()
    RAN_PKGS=()
    for pkg in "${ALL_PACKAGES[@]}"; do
        if [ ! -d "$TREE/$pkg" ]; then
            ABSENT_PKGS+=("$pkg")
            continue
        fi
        RAN_PKGS+=("$pkg")
        run_one "$pkg" || FAILED_PKGS+=("$pkg")
    done
    line ""
    if [ "${#ABSENT_PKGS[@]}" -gt 0 ]; then
        say "NOT PRESENT in this tree, so nothing was run for: ${ABSENT_PKGS[*]}"
    fi
    if [ "${#FAILED_PKGS[@]}" -gt 0 ]; then
        say "FAILED: ${FAILED_PKGS[*]}"
        exit 1
    fi
    # Only the packages that RAN. Naming the absent ones here as if they had
    # passed is the same lie this whole file exists to refuse, and the first
    # draft of this line made it.
    say "passed: ${RAN_PKGS[*]:-<nothing ran>}"
    exit 0
    ;;
*)
    if [ ! -d "$TREE/$PKG" ]; then
        say "no such package in this tree: $TREE/$PKG"
        exit 1
    fi
    run_one "$PKG" "$@"
    exit $?
    ;;
esac
