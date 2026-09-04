# The confidence map — what round ANYWHERE proved, who proved it, and to which rung

**Measured 2026-09-04 (12:30–xx:xxZ) by the `O5` verifier, from worktree
`.claude/worktrees/O5` on branch `task/O5`, base `4b05869` (`origin/main` at the
time of the fetch). The verifier wrote none of the code below.**

Every number in the table came out of a command run in **this** session and
recorded verbatim in [§3, Commands run](#3-commands-run). Nothing is copied from
`docs/ORCHESTRATION-LOG.md` or from a worker's own `artifacts/runs/*.json`: a log
entry is a claim about a tree and a deployment that have both moved since, and
this document exists because that keeps being true.

The vocabulary is the nine-rung ladder inlined as `DONE_LADDER` in
[`../tools/waves.ts`](../tools/waves.ts) — `DESIGNED`, `CODE_PRESENT`,
`COMMITTED`, `STATIC_CHECKS_PASS`, `WORKER_RUNTIME_EVIDENCE`,
`INDEPENDENT_TEST_PASS`, `DEPLOYED`, `TARGET_ENVIRONMENT_CONFIRMED`,
`USER_OUTCOME_CONFIRMED` — because that is what the ladder is for.

---

## 0. Read this first, or the table will mislead you

### 0.1 This is an INTERIM pass, and it says so on purpose

Row `O5` is scheduled to run again after row `R2` — the founder-present release
(secrets, `EZIL_OS_ACCESS_MODE` on Vercel, the `v0.2.0` tag, the watched deploy).
**None of that has happened.** So every rung below that mentions a deployment is
a rung about an *image registry* or a *GitHub Actions run*, never about
`os.ezil.work`. Read §2 before quoting any row of §1 outside this document.

### 0.2 The deployed host predates this round entirely

`N1` — the row that would create `os.ezil.work` (Vercel project domain, the
unproxied DNS record, the Supabase redirect allowlist, a real sign-in) — is
`pending`, blocked at this session's permission boundary and gated on the
founder. `bun tools/waves.ts docs/TASKS.csv` prints it `[ ]` in wave 0 today.
The round's start state recorded a Worker uploaded by hand on **2026-08-26**,
before any commit in this round.

Therefore: **the invite gate that rows `A1` and `A2` built is not running
anywhere a user can reach.** It is proven in code and by test (§3.4) and by
nothing else. The same applies to the invited-user landing: `A2` shipped a
client-side fragment reader, so the design objection `A1` raised is answered *in
code*, but no real Supabase invite has been followed through a real browser to a
real session by anyone, in this session or any other.

### 0.3 `main` moved under this pass, and one row changed meaning while it ran

This pass measured `4b05869`, which was `origin/main` when the worktree was cut
at 12:31Z. By 12:54Z `origin/main` was `e1bd1c0`, four commits ahead:

| landed after this pass's base | what |
|---|---|
| `2a5007d` (#23) | `R1` — `deploy.yml`, `release.yml` changes, `CHANGELOG` 0.2.0, `docs/RELEASE.md` |
| `f15787a` (#24) | `M1` — the mobile-keyboard container suite |
| `995a61b` (#20), `e1bd1c0` (#25) | supervisor log/ledger folds |

Every count in §1 and §3 is a measurement of `4b05869` unless the row says
otherwise. §3.7 re-measures the one thing that changed materially — `M1`'s eight
failures — against `e1bd1c0` in a second, throwaway worktree, because a row whose
entire claim is "these eight tests now pass" cannot be verified at a base that
predates it.

### 0.4 What "proven" means here, and where the round's real gaps are

Three gaps, in descending order of how badly they would mislead someone reading
`docs/ORCHESTRATION-LOG.md` alone:

1. **`main`'s CI is red, and has been for every completed run of this round's
   last four pushes.** The `container (real image)` job — the one row `T8` wired
   to pull the GHCR desktop image and run the container suites for real — failed
   on `4b05869` with `23 pass / 8 fail`, and the two runs after it were
   `cancelled` by the next push before finishing. See §3.6.
2. **`container` and `local` are still not required contexts.** `G4`'s ruleset
   `22265548` requires fifteen; the log says those two "join after T8", `T8` has
   merged, and they have not joined. A red `container` job therefore does not
   block a merge.
3. **The desktop image tag is still the placeholder.** `deploy/images.env` reads
   `EZIL_DESKTOP_TAG=<to be pinned by CI>`; `T7`'s write-back publishes it as a
   CI *artifact* and nothing commits it. Local mode only starts because the
   doctor falls back — it says so out loud (§3.5). A value that looks like
   configuration and is not one is the failure mode this project has already
   paid for.

---

## 1. The table

*(filled in below as the measurements land)*

---

## 2. What remains unmeasured

*(filled in below as the measurements land)*

---

## 3. Commands run

Every command below was run in this session, in this worktree, in this order.
The result line is the real tail of what it printed.

### 3.1 The kit (`tools/`)

```
$ bun tools/waves.ts docs/TASKS.csv
```
Exit **0**. `29 tasks in docs/TASKS.csv`, waves 0–6; last line
`no ownership overlaps, no cycles, every dependency resolves.` Twelve advisory
`wave`-column disagreements printed (`N1 X1 M1 M2 A1 T7 M3 T6 R1 N2 R2 O5`) —
one more than `docs/ORCHESTRATION.md` records, because `M3` was added after that
document was written.

```
$ bun tools/ledger.ts
```
Exit **0**.
```
21 artifact(s) across 1 run(s) (21 from main, 0 from 0 sibling worktree(s), 0 checkout duplicate(s) of main skipped)
stall check: 29 row(s) inspected, 4 in flight (3 by row, 1 by artifact — 21 from main, 0 from worktrees)
STALLED  M1  row says running and no artifact was ever written; this is what a workflow that died with the session looks like
20 row(s) would change. Re-run with `apply` to write them.
```

```
$ ./tools/test.sh tools
```
Exit **0**. `tsc --noEmit -p tsconfig.json` clean, then
`76 pass / 0 fail / 134 expect() calls, 76 tests across 2 files [231.00ms]`.

```
$ tools/worktree.sh add smoke
$ readlink -f .claude/worktrees/smoke/mcp/node_modules/@ezil-os/sdk
$ du -sh .claude/worktrees/smoke
$ tools/worktree.sh remove smoke
```
`add` printed the path; `readlink -f` printed
`/data/openclaw/projects/ezil/EZiL-OS/.claude/worktrees/smoke/sdk` — **inside**
the smoke worktree, not the main tree; `du -sh` = **13M**; `remove` printed
`removed smoke` and the directory is gone (`ls .claude/worktrees` → `M4 N2 O5`,
three live sibling worktrees, none of them `smoke`).

### 3.2 The worker package, image present and image absent

```
$ EZIL_VALIDATE_IMAGE=ezil-os-worker-sandbox:ff199202 ./tools/test.sh worker
```
Exit **1**.
```
 1054 pass
 1 skip
 8 fail
 3046 expect() calls
Ran 1063 tests across 39 files. [240.11s]
==> 24 test(s) were SKIPPED. A skip is not a pass. By suite:   [1: src/preview-timeouts.test.ts]
```
All **8** failures are in `worker/scripts/mobile-keyboard.container.test.ts`,
every one of them `(fail) the soft keyboard types each character exactly once >
…`, `Expected: "abc" / Received: ""` — i.e. **the eight failures row `M1` was
opened to fix are still on `main`**. The one skip is named:
`src/preview-timeouts.test.ts`. The image
`ezil-os-worker-sandbox:ff199202` and `ezil-integrated:local` are both present
on this box (`docker images`), so the container suites really ran.

```
$ EZIL_VALIDATE_IMAGE=absent:x EZIL_NEKO_IMAGE=absent:x ./tools/test.sh worker
```
```
 1039 pass / 24 skip / 0 fail — Ran 1063 tests across 39 files. [199.42s]
==> 24 test(s) were SKIPPED. A skip is not a pass. By suite:
        15  src/browser-sidecar.container.test.ts   [CONTAINER — green-by-absence]
         1  src/preview-timeouts.test.ts
         8  src/neko-browser-window.container.test.ts   [CONTAINER — green-by-absence]
==> 23 container test(s) SKIPPED, and not one of them is a pass.
==> scripts/mobile-keyboard.container.test.ts reported 8 test(s) as run while every image those suites use is absent
==>   (absent:x absent:x). … bun records an early return inside an it body as a PASS …
```
`0 fail` from bun and yet the run is refused: **both** gates fire, and every
skip is named. The exit code was captured on the scoped re-run of the same three
files:

```
$ EZIL_SKIP_TYPECHECK=1 EZIL_VALIDATE_IMAGE=absent:x EZIL_NEKO_IMAGE=absent:x ./tools/test.sh worker container.test
```
Exit **1**. `8 pass / 23 skip / 0 fail, 31 tests across 3 files [109.00ms]`, with
`23 container test(s) SKIPPED, and not one of them is a pass.` and the
vacuous-pass message naming `scripts/mobile-keyboard.container.test.ts`.

```
$ EZIL_SKIP_TYPECHECK=1 EZIL_ALLOW_SKIPPED_CONTAINER_TESTS=1 \
  EZIL_VALIDATE_IMAGE=absent:x EZIL_NEKO_IMAGE=absent:x ./tools/test.sh worker container.test
```
Exit **1** — the positive control for the gate the opt-out cannot reach. The
opt-out announces itself (`23 skipped container test(s) ALLOWED. Nothing above
has verified any container behaviour.`) and the run still fails, on the
vacuous-pass gate alone.

### 3.3 sdk, mcp

```
$ ./tools/test.sh sdk    # exit 0 — 20 pass / 0 fail, 20 tests across 2 files [76.00ms]
$ ./tools/test.sh mcp    # exit 0 — 33 pass / 0 fail, 33 tests across 3 files [492.00ms]
```

### 3.4 app, and the invite gate specifically

```
$ ./tools/test.sh app
```
Exit **0**. `npx tsc --noEmit` clean, `bun run lint` clean, then
`Test Files 44 passed (44) / Tests 817 passed (817)`, duration 6.95 s.

```
$ cd app && npx vitest run src/server/api/trpc-access.test.ts
```
Exit **0** — `1 passed (1) / 20 passed (20)`. This is the file that carries the
row `A2` claim. Its cases include *"🔴 an authenticated bearer that is not on the
allow-list gets FORBIDDEN"*, its positive control *"and an invited bearer is let
through"*, and *"a caller with no user is still UNAUTHORIZED, not FORBIDDEN — the
positive control"*, so the two refusal codes are distinguished rather than
conflated.

**Mutation (gate, not in the brief's list — done because the row's whole claim
rests on this one file).** `app/src/server/api/trpc.ts:172`
`if (!access.allowed)` → `if (false && !access.allowed)`:

```
before  1 passed (1) / 20 passed (20)
mutant  1 failed (1) / 6 failed | 14 passed (20)
after   1 passed (1) / 20 passed (20)      (git checkout -- app/src/server/api/trpc.ts; git status clean)
```

### 3.5 The two guards the brief named, mutation-proved

**(a) The pixel oracle, `local/src/pixels.ts`.** A scratch probe
(`pixel-oracle-probe.ts`, outside the repository) imports the **shipped**
`luminanceStats` / `isNonUniform` / `describeStats` and hands them four 64×64
RGBA frames:

```
UNIFORM   samples=4096 min=128 max=128 mean=128 stdDev=0    buckets=1/32  — UNIFORM (stdDev below 8)   isNonUniform = false
BLACK     samples=4096 min=0   max=0   mean=0   stdDev=0    buckets=1/32  — ALL BLACK                  isNonUniform = false
TWO-TONE  samples=4096 min=0   max=255 mean=0.06 stdDev=3.98 buckets=2/32 — UNIFORM (stdDev below 8)   isNonUniform = false
SPREAD    samples=4096 min=0   max=255 mean=127.5 stdDev=73.9 buckets=33/32 — non-uniform              isNonUniform = true
```

A uniform frame is RED (refused) and the spread is GREEN — and the refusal
message names *which* threshold rejected it. `local/tests/pixels.test.ts`:
`12 pass / 0 fail / 29 expect() calls`.

Then the thresholds themselves, mutated in place to prove they are load-bearing
rather than decorative — `MIN_STD_DEV = 8 → 0`, `MIN_BUCKETS = 3 → 0`:

```
mutant   pixels.test.ts  7 pass / 5 fail        probe: UNIFORM and TWO-TONE now isNonUniform = true
restore  pixels.test.ts 12 pass / 0 fail        probe: refuses all three degenerate frames again
```
(`git checkout -- local/src/pixels.ts`; `git status --short` empty.)

🔴 **Defect found by this probe, reported not fixed**: `describeStats` prints
`buckets=33/32` on a full-range frame. `luminanceStats` buckets by
`Math.round(l / 8)` over luminance `0…255`, which yields **33** distinct values
(`0…32`), not the 32 the field's own doc comment and the `/32` suffix claim.
Nothing depends on the count being ≤32 (`MIN_BUCKETS` is a floor), so this is
cosmetic — but the printed diagnostic is arithmetically impossible as written.
Hand-off: `local/src/pixels.ts:83` (`buckets.add(Math.round(l / 8))`) and
`:141` (the `/32` in `describeStats`).

**(b) The no-hostname scan, `local/src/server/no-hostname.test.ts`.** The
scanner walks `resolve(import.meta.dir, '..')` — the whole of `local/src` — so a
new file inside that tree is in scope. Scratch copy
`local/src/server/o5-scratch-copy.ts` (a copy of `local/src/config.ts`) with one
line appended in **code**, `export const O5_SCRATCH_ENDPOINT = 'https://os.ezil.work';`:

```
before  8 pass / 0 fail / 18 expect() calls
mutant  6 pass / 2 fail — "🔴 NO literal hostname appears in code. No exceptions, anywhere."
          + [ "server/o5-scratch-copy.ts:318 export const O5_SCRATCH_ENDPOINT = 'https://os.ezil.work';" ]
        and "no URL to a forbidden host appears in code, comment or not"
after   8 pass / 0 fail        (scratch file deleted; git status --short empty)
```

The failure names the file, the line and the offending text, so the assertion is
about the hit and not merely "something threw".
