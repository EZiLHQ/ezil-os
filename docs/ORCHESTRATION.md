# How work is dispatched, tracked, and recovered

[`TASKS.csv`](TASKS.csv) is the plan. [`../artifacts/runs/`](../artifacts/runs/) is what happened.
This file is the contract between them.

It exists because of a specific, repeated failure on the sibling project this
repository borrows its tooling from (EZiL-Works): **background workflows die
when the session exits, and leave no completion marker.** Work that had
actually finished sat uncommitted in a worktree for a day because nothing said
so. The plan cannot live in the session that is executing it, so it is written
down twice, in two files with different owners.

---

## The two files

| | |
|---|---|
| [`docs/TASKS.csv`](TASKS.csv) | The plan. Written by a person. 17 columns, order is load-bearing (`tools/waves.ts` rejects a reordered header rather than silently misreading it). |
| [`artifacts/runs/<run_id>/<task_id>.json`](../artifacts/runs/) | One file per task per attempt. Written by the agent that ran it, and by nothing else. |

**No agent ever writes the CSV.** Six agents finishing within a second of each
other produce one surviving row and five that read as never having run.
[`../tools/ledger.ts`](../tools/ledger.ts)'s `reconcile()` folds artifacts into
the CSV afterwards and touches exactly three columns: `status`, `run_id`,
`evidence`. It cannot rewrite `owns_files`, because an agent that could enlarge
its own ownership could quietly take a file another agent in its wave holds,
and the overlap check would then pass against a plan it had just edited.

### The 17 columns (`REQUIRED_COLUMNS` in [`../tools/waves.ts`](../tools/waves.ts))

| column | carries |
|---|---|
| `id` | the row's id, unique within the file (`tools/waves.ts` flags a repeat as `duplicate-id`) |
| `track` | a grouping label for humans (`kit`, `local`, `oss`, `image`, `cloud`, `release`, `access`, `ci`, `worker`, `research`, …) — not read by any tool |
| `wave` | the human's guess at scheduling order. **Advisory** — see below |
| `title` | one line, for a person scanning the file |
| `owns_files` | `;`-separated paths this row alone may write. **Disjoint within a computed wave** — see below |
| `depends_on` | `;`-separated ids. **This computes the wave, not the `wave` column** |
| `agent_type` | which role dispatches the row — a filename under [`../.claude/agents/`](../.claude/agents/), or `supervisor` for a row the orchestrating session performs directly |
| `model` | the dispatch alias used at launch (`sonnet`, `opus`, `opus5`, `fable`) — see "Harness limit" below for why this is an alias and not the pinned model id |
| `effort` | the reasoning effort passed at dispatch (`high`, `max`, `xhigh`, …) |
| `isolation` | `worktree` (the row runs in its own `.claude/worktrees/<id>` checkout) or `none` (the row is a supervisor action against the shared main tree — a cutover, a GitHub API call, a log entry) |
| `contract_artifact` | the file(s) or plan section that must be pinned and read *before* the row starts — an interface described in two briefs is two interfaces, and this project has paid for that already (see "What a report must contain" below) |
| `verify_cmd` | the command whose exit code is the row's evidence |
| `gate` | who, beyond the assigned agent, must additionally act before the row counts done. The only value in use today is `founder`, on rows that write to real outward-facing infrastructure or a hosted database (`N1`'s Vercel/DNS/Supabase writes, `A1`'s hand-applied hosted migration, `R2`'s secrets and tag) |
| `done_rung` | the target on the nine-rung ladder below |
| `status` | one of the six in `TASK_STATUSES` (`../tools/ledger.ts`): `pending`, `blocked`, `running`, `stalled`, `done`, `failed`. An agent's own artifact may claim `running`, `done`, `failed` or `blocked`; **`stalled` is written by the supervisor only** |
| `run_id` | which run's artifact last folded into this row (empty until one does) |
| `evidence` | real counts, quoted from the folded artifact — never a summary a person typed by hand |

## `owns_files`: disjoint within a computed wave

`tools/waves.ts` refuses a wave whose rows overlap on `owns_files`, including
the nesting case — `src/host` and `src/host/sandbox-host.ts` are the same
conflict as two identical paths, and string equality would call the pair safe
(`overlaps()` in `../tools/waves.ts` checks `startsWith(shorter + "/")` for
exactly this reason). This is the repository's stated rule made mechanical: *a
task that adds a constraint must own the writers of the data it constrains.*
A `done` row's claim is spent — the check only compares rows still dispatched
in that wave, so a task that already merged does not block a later one from
touching the same directory.

## `depends_on` computes the wave; `wave` is advisory

Waves are **computed** from `depends_on` by `computeWaves()` (Kahn's
algorithm), not read from the `wave` column. `checkWaveColumn()` then reports
every row where the written column and the computed wave disagree, rather than
silently preferring one — a stale `wave` value means the plan moved and the
column did not. Run against this repository's own file today, that check
prints eleven such notes (`N1`, `X1`, `M1`, `M2`, `A1`, `T7`, `T6`, `R1`, `N2`,
`R2`, `O5` — see "Commands" below for the exact output); none of them block a
dispatch, because the graph, not the column, is what a dispatcher reads.

## The nine rungs

"Done" is the single most expensive ambiguity in this business: a worker says
a feature is built, an operator reads that as working for the people it was
built for, and the two are separated by several rungs of this ladder. Each
row's `done_rung` names which one it must reach, so the disagreement happens
when the row is written, not after the work is.

EZiL-Works keeps this ladder in `packages/contracts/src/ladder.ts`; EZiL-OS has
no `packages/contracts` for it to live in, so `DONE_LADDER` is inlined directly
in [`../tools/waves.ts`](../tools/waves.ts) instead, comments included below
verbatim:

1. **`DESIGNED`** — a plan exists and is agreed. Nothing has been written.
2. **`CODE_PRESENT`** — code exists in the working tree. It may not run.
3. **`COMMITTED`** — it is committed to the named branch, so it can be looked
   at.
4. **`STATIC_CHECKS_PASS`** — types, lints and builds pass. Still no evidence
   it does anything.
5. **`WORKER_RUNTIME_EVIDENCE`** — the worker ran it and captured output.
   Their own machine, their own claim.
6. **`INDEPENDENT_TEST_PASS`** — a test that the worker did not write, or a
   run they did not perform, passes.
7. **`DEPLOYED`** — it is deployed somewhere reachable.
8. **`TARGET_ENVIRONMENT_CONFIRMED`** — it works in the environment it was
   built for, checked there.
9. **`USER_OUTCOME_CONFIRMED`** — a real user achieved the outcome. The only
   rung that is evidence of value.

Higher entails lower (`rungHeight` / `rungSatisfies` in `../tools/waves.ts`),
which is what lets a verdict say "reached `STATIC_CHECKS_PASS`, required
`DEPLOYED`" instead of a bare no.

**Which rung a kind of row targets, by example already in `TASKS.csv`:**

- A tool port is done at `INDEPENDENT_TEST_PASS` — `O2` (this repository's own
  `waves.ts`/`ledger.ts` port) targets it and its evidence is a real,
  independently re-run test count, not the porting worker's own claim.
- A workflow file is done at `STATIC_CHECKS_PASS` until its first real run —
  `T3` (`image.yml`) targets `STATIC_CHECKS_PASS`; the round log records the
  merge that first triggers it on GitHub as a separate, later, watched event,
  because parsing clean and lint-passing is not evidence a GitHub Actions
  workflow executes correctly. A workflow whose row later gets a real
  green-on-a-PR proof can be re-targeted higher, as `T4` (the CI matrix) was,
  to `INDEPENDENT_TEST_PASS`.
- A cutover to real, outward-facing infrastructure is done at
  `TARGET_ENVIRONMENT_CONFIRMED` — `N1` (`os.ezil.work`: the Vercel domain, the
  unproxied DNS record, the Supabase redirect allowlist, a real sign-in)
  targets it, and carries `gate: founder` because those writes are outward
  facing and were refused by this round's own permission boundary (see the
  round log's 07:45Z entry).
- A documentation row like this one is done at `COMMITTED` — matching `G2`,
  `D1` and `X1` in this file: a doc is evidence-bearing prose, not something
  with its own runtime to independently test.

## The artifact an agent writes

```json
{
  "taskId":    "O4",
  "runId":     "wf-os-2026-09-04",
  "status":    "running",
  "doneRung":  "CODE_PRESENT",
  "evidence":  "started: reading tools/waves.ts, tools/ledger.ts, ...",
  "startedAt": "2026-09-04T09:35:04Z",
  "updatedAt": "2026-09-04T09:35:04Z",
  "notes":     "optional"
}
```

Every field but `notes` is required and must be a non-empty string
(`parseArtifact` in `../tools/ledger.ts` throws `MalformedArtifact` on a blank
one); `evidence` especially — *"it worked"* with no observation behind it is
the failure mode this repository keeps having, so the parser refuses it rather
than accepting a placeholder.

`status` is drawn from `TASK_STATUSES`, and only `running`, `done`, `failed`
and `blocked` are an agent's own to write — `stalled` is the supervisor's word
for a row an agent stopped updating, and a hung agent cannot report that it is
hung.

**Write it when the work lands, not when the agent exits.** A worker that
commits and then throws in a reporting step otherwise produces a summary
saying nothing changed — the artifact's own doc comment in `../tools/ledger.ts`
calls this out directly: *"A late failure must not erase a landed result."*

### The supervisor's stamping rule, learned this round

`reconcile()` only folds an artifact into a CSV row when the row's own
`run_id` cell is either empty or already equal to the artifact's `run_id`
(`../tools/ledger.ts`, the "Two guards" comment on `reconcile`). A `pending`
row is never folded at all — nothing can be its artifact yet. So a row that
was dispatched but never had its CSV cells touched folds nothing when its
worker finishes: the join key does not match, the fold is silently a no-op,
and `detectStalls` — seeing a row still reading `pending` with no `running`
signal anywhere — has no way to tell "never dispatched" from "dispatched and
died" apart.

The fix in force this round: **the supervisor stamps `status=running` and
`run_id=<this round's id>` onto the CSV row at dispatch time**, before the
worker's own artifact exists. This was directly observable working: this very
row, `O4`, carried `status: running, run_id: wf-os-2026-09-04` in `TASKS.csv`
*before* this worker had written anything at all.

This is a stamp on the **CSV row**, not a pre-written **artifact file** — the
two must not be confused. EZiL-Works learned the second one the hard way (see
`../tools/ledger.ts`'s module doc comment): a supervisor that pre-writes a
task's `artifacts/runs/<run_id>/<task_id>.json` collides add/add with the
worker's own first write to that same path. The row-stamp and the
artifact-file are different objects with different owners for exactly this
reason — the CSV has one writer (the supervisor, by convention) and the
artifact has one writer (the dispatched agent), and neither may write the
other's object.

## Commands

Every command below was run from this worktree while writing this file; the
output quoted is the real tail of what it printed, not a paraphrase.

```
bun tools/waves.ts docs/TASKS.csv   # the wave plan; exits 1 on overlap or cycle
```
Exit 0. Last lines:
```
note:  R2 is written as wave 4 but its dependencies put it in wave 5.
note:  O5 is written as wave 4 but its dependencies put it in wave 6.
no ownership overlaps, no cycles, every dependency resolves.
```

```
bun tools/ledger.ts                 # what the ledger would change, and any stalls
```
Exit 0. First two lines (run from inside this worktree, so it sees only this
worktree's own `artifacts/runs/` — `worktreesBaseDir()` resolves relative to
`import.meta.dir/..`, and a worktree has no `.claude/worktrees` of its own):
```
11 artifact(s) across 1 run(s) (11 from main, 0 from 0 sibling worktree(s), 0 checkout duplicate(s) of main skipped)
stall check: 27 row(s) inspected, 1 in flight (1 by row, 0 by artifact — 11 from main, 0 from worktrees)
```
`bun tools/ledger.ts apply` is the write form — it folds the ledger straight
into `docs/TASKS.csv`. It is the supervisor's call on the merged main tree,
not something a row's own worker runs against its own worktree copy (this row
does not own `docs/TASKS.csv` and did not run `apply`).

```
tools/worktree.sh add|remove|list <id>   # one checkout per mutating agent
```
`list`, run here (never `add`/`remove` — other workers' worktrees are live):
```
/data/openclaw/projects/ezil/EZiL-OS                       f43c961 [main]
/data/openclaw/projects/ezil/EZiL-OS/.claude/worktrees/O4  339e947 [task/O4]
/data/openclaw/projects/ezil/EZiL-OS/.claude/worktrees/T4  819eb7b [task/T4]
/data/openclaw/projects/ezil/EZiL-OS/.claude/worktrees/T5  f43c961 [task/T5]
```

```
./tools/test.sh <app|worker|shell|sdk|mcp|tools|local|all> [extra args...]
```
`./tools/test.sh tools`, run here, exit 0:
```
$ tsc --noEmit -p tsconfig.json
bun test v1.3.14 (0d9b296a)

 76 pass
 0 fail
 134 expect() calls
Ran 76 tests across 2 files. [53.00ms]
```
(`worker` and `shell` were not run for this row — `worker` has 8 pre-existing
container-suite failures recorded by `O3` and is not this row's evidence to
carry.)

Three opt-outs, each announcing itself when used (usage block at
`../tools/test.sh:474-482`):

- `EZIL_SKIP_TYPECHECK=1` — skips the typecheck stage. For a tight edit loop
  on one test file; prints that it skipped.
- `EZIL_ALLOW_SKIPPED_CONTAINER_TESTS=1` — accepts a run where a
  `*.container.test.ts` suite skipped for lack of the Docker image, instead of
  the default exit 1 that names every skip.
- `EZIL_ALLOW_SKIPPED_BROWSER_SUITES=1` — the same, for a Playwright-backed
  `shell` suite that could not resolve a browser.

And one gate neither opt-out reaches: `gate_vacuous_container_passes()`
(`../tools/test.sh:334`) fails the run — **even with
`EZIL_ALLOW_SKIPPED_CONTAINER_TESTS=1` set** — when a container test file
reports passes with zero skips recorded, because at least one of them
(`worker/scripts/mobile-keyboard.container.test.ts`, per row `M1`) is known to
return early from inside its own test bodies without touching the Docker
image at all: `bun test` then counts an early return as a pass, and the file
looks green while proving nothing. A skipped test is never reported as a
pass; a vacuously-passing one is treated the same way.

## The worker roster

`.claude/agents/` holds five dispatchable role definitions plus
[`_MANDATORY.md`](../.claude/agents/_MANDATORY.md), the rules block pasted
verbatim into every worker's and verifier's brief — six files, matching what
row `O1` committed. `_MANDATORY.md` is not itself a role.

| file | model id | effort | for |
|---|---|---|---|
| [`worker-sonnet.md`](../.claude/agents/worker-sonnet.md) | `claude-sonnet-5` | high | mechanical rows: a workflow that mirrors an existing one, a port of a tool from the sibling repo, a docs sync, a default flipped across files |
| [`worker-opus.md`](../.claude/agents/worker-opus.md) | `claude-opus-4-8` | max | rows with invariants: auth and gating, contract pins, adapters over Docker, signing and release plumbing, worktree and test-runner semantics |
| [`worker-opus5.md`](../.claude/agents/worker-opus5.md) | `claude-opus-5` | xhigh | escalation, for a genuinely open design problem or a second opinion on an Opus 4.8 deliverable |
| [`verifier.md`](../.claude/agents/verifier.md) | `claude-opus-5` | high | independent verification — enumerates entry points, runs the real thing, mutation-proves every new guard, never fixes product code, only reports |
| [`reader-haiku.md`](../.claude/agents/reader-haiku.md) | `claude-haiku-4-5` | low | read-only digesting of large volumes of files, logs or search results into a citation-bearing summary; never edits |

`agent_type=supervisor` in the CSV names no file — it is the orchestrating
session itself, run at the `fable` alias, for rows that are direct actions
(a founder-gated cutover, a GitHub API call, a log entry) rather than a
dispatched worker's deliverable. `verifier.md` and `worker-opus5.md` share a
model id (`claude-opus-5`); the CSV's `effort` column, not `model`, is what
tells them apart at dispatch (`high` versus `xhigh`).

### Harness limit: agent definitions load at session start

Dispatching `subagent_type: worker-sonnet` mid-session returned "Agent type
not found" (round log, 07:30Z). This round's workers therefore run as
general-purpose agents launched at the plain model alias (`sonnet`, `opus`,
`opus5`), with their role file (`.claude/agents/worker-*.md`) read as the
first instruction of the brief rather than resolved by the harness. The exact
model id, the pinned effort level, and the mandatory-rules block still bind —
they are just read out of the file by the agent instead of enforced by the
dispatcher. This is why the CSV's `model` column carries an alias and not a
pinned id: the alias is what a dispatch call actually takes.

### Concurrency

**≤3 concurrent subagents** is the measured ceiling — measured on the sibling
project, not on EZiL-OS itself: `EZiL-Works/docs/ORCHESTRATION-LOG.md:22`,
*"Dispatch | by readiness, ≤3 concurrent Claude subagents (measured ceiling),
each in `tools/worktree.sh` worktree on `task/<id>`."* This round has run at
or under that width throughout (the log's running-tasks lines never name more
than three).

**One worktree per mutating agent.** Every row with `isolation: worktree`
gets its own `.claude/worktrees/<id>` checkout via `tools/worktree.sh add`,
so two agents editing at once never share a working tree — `isolation: none`
is reserved for supervisor rows that touch nothing but the CSV, the log, or
real outward infrastructure directly.

**A finished row lands with `git merge --no-ff` into `main`, done by the
supervisor only when `main` is clean and no suite is running against it.**
Every merge this round carries the same message shape and a two-parent commit
— confirmed directly (`git log --format='%P' <sha>` on `7d288c4`, the `O2`
merge, prints two parent hashes) — for example:

```
Merge task/O2: tools/waves.ts and tools/ledger.ts ported from EZiL-Works (round wf-os-2026-09-04)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

## Recovery

Agents die mid-stream; the artifact is what survives them.

1. **Read [`docs/ORCHESTRATION-LOG.md`](ORCHESTRATION-LOG.md) first.** It is
   the supervisor's append-only narrative of what was dispatched and what
   landed, written before and during dispatch, not reconstructed after.
2. **Check `.claude/worktrees/<id>`.** A dead agent's actual work — commits,
   an in-progress artifact — is there, on branch `task/<id>`, whether or not
   the session that produced it is still running.
3. **Re-dispatch with a changed hypothesis, never the same brief twice.** One
   attempt plus fixes, then escalate; two repeats of one diagnosed failure
   class is a signal to rethink, because the brief that produced a stall will
   produce another.
4. **Never `git stash`.** `_MANDATORY.md` §11: a stash captures every
   uncommitted file in the checkout, including a sibling agent's work, and a
   later pop can conflict against it — measured on the sibling project as a
   real incident, not a hypothetical.
5. **`git -C <path>` and absolute paths, never `cd` in a command chain**
   (`_MANDATORY.md` §12) — the shell's working directory persists across
   calls in a way that makes a `cd` silently apply to the next unrelated
   command.
6. **Secrets by presence check only** (`_MANDATORY.md` §12): `[ -n
   "${VAR:-}" ] && echo set || echo unset`, never an expansion into output.

This repository's round has no scripted `Workflow` runtime behind it — no
`journal.jsonl`, no `resumeFromRunId` to resume from. EZiL-Works' version of
this document describes recovering a dead *scripted* workflow round; this
round dispatches subagents directly by alias (see "Harness limit" above), so
recovery here is the four items above: the log, the worktree, the artifact,
and a changed hypothesis on re-dispatch.

## Stalls

`bun tools/ledger.ts` reports a task as stalled
(`detectStalls`/`stallCoverage`/`coverageReport` in `../tools/ledger.ts`) when
it looks in flight — its CSV row says `running`, or its latest artifact does —
and either no artifact was ever written for it, or none has been written for
longer than `DEFAULT_IDLE_THRESHOLD_MS` (15 minutes). The no-artifact case is
what a workflow that died with the session looks like from outside, so its
absence is treated as a signal rather than as "not started yet" — but only for
a row already marked in flight; a `pending` row with no artifact is just the
resting state of most of the backlog, and treating that as a signal would name
the whole file stalled.

Staleness is judged on the artifact **file's mtime**, never the agent's own
`updatedAt` field: a hung worker stops updating that field too, so trusting it
would make a stalled agent look healthy for exactly as long as it has been
stalled.

`bun tools/ledger.ts` prints its coverage line unconditionally, before any
stall it finds — `detectStalls` returning nothing has two different meanings
(nothing is stalled, or nothing could have been) and the coverage line is the
only way the two are told apart. Run in this worktree just now it reported
`1 in flight (1 by row, ...)` — this row's own `running` stamp — with zero
stalls, because it had just been written.

## What a report must contain

Per [`_MANDATORY.md`](../.claude/agents/_MANDATORY.md) §9: what landed (files,
commits), the real test counts, what the agent was blind to, what it refused
or deferred and why, and any hand-off named by file and line. No summary that
claims more than the evidence sitting behind it.

**§3: if a clause of the contract or brief is wrong, the report says so and
the agent stops — it does not work around it.** Three clauses were refuted
this round, each with a citation:

- **`G1`** — the brief assumed a CodeQL `autobuild` step for
  javascript-typescript; the worker found build-mode `none` applies and left
  the action pins at the specified majors (`v5`/`v9`), because the newer
  majors change only the Node runtime the action itself uses.
- **`G3`** — the brief said Dependabot commits carry no `Signed-off-by`
  trailer. Measured on all seven open PRs, they do —
  `Signed-off-by: dependabot[bot] <support@github.com>`, against an author
  identity of `dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>`:
  the name matches, the email does not. The allowlist the brief asked for was
  still right; the reason, and the required ordering (the bot gate must run
  *before* any trailer is read), were not what the brief said.
- **`T2`** — the brief assumed an `/api/health` endpoint and an exec-based
  screen read/set. Measured against the pinned image: neko exposes `/health`
  (body `true`), not `/api/health`, and screen read/set are HTTP
  (`/api/room/screen`), not `docker exec`.
