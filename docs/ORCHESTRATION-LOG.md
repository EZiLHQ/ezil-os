# Orchestration log

The supervisor's append-only record of each round: what was dispatched, what landed, what was refused, and what the
evidence actually showed. Newest entries are appended at the END of a round's block, before the next `## ` header.
`docs/TASKS.csv` is the plan; `artifacts/runs/<run_id>/` is what happened; this file is the narrative between them.

Rules: a row is "done" only when its artifact says so with counts behind it; a merge is recorded with the merge commit;
a deploy is recorded with the deployment id and the check that proved it took effect; a refusal by a worker is quoted,
not paraphrased.

## Round ANYWHERE — `wf-os-2026-09-04`

**Goal.** One system that runs anywhere: a native local mode (Docker on the user's machine, no Cloudflare), a
three-OS CI matrix, GHCR images and a signed download, an invite-only `os.ezil.work`, and the public-repo governance
a project with outside contributors needs. Plan of record: the founder-approved plan of 2026-09-04 (24 rows, five
waves). Orchestrator: Claude Fable 5.1 as advisor; workers are the committed `.claude/agents/*` definitions.

**Start state (measured 2026-09-04).** `main` @ `6495628`; no tags, so `deploy.yml` has never run; no branch
protection, no Actions secrets; `os.ezil.work` does not resolve; the deployed Worker predates `main` (uploaded by
hand 2026-08-26); CODEOWNERS names a GitHub user that does not exist.

- 2026-09-04 07:20Z — **O1 done by the supervisor** (kit bootstrap): `.gitignore` now `.claude/*` + `!.claude/agents/`
  + `.claude/worktrees/`; six agent definitions committed with full model ids and effort levels. `git check-ignore`
  on an agent file prints nothing; a worktree path is still ignored. `docs/TASKS.csv` seeded with the 24 rows. Wave 0
  dispatch order: O2 (sonnet), T0 (opus), G1 (sonnet); then D1, G2 as slots free.
- 2026-09-04 07:30Z — **Harness limit recorded.** Agent definitions under `.claude/agents/` are loaded at session start,
  not mid-session: dispatching `subagent_type: worker-sonnet` returned "Agent type not found". This round's workers
  therefore run as `general-purpose` agents with the `sonnet` / `opus` aliases and read their role file
  (`.claude/agents/worker-*.md`) as the first instruction of the brief. Per-agent `effort` and the exact Opus 4.8 pin
  take effect from the next session; noted so the confidence map does not overstate which model produced what.
- 2026-09-04 07:45Z — **N1 blocked at the permission boundary.** The three cutover writes (Vercel `domains add`,
  Cloudflare DNS POST, Supabase `uri_allow_list` PATCH) were refused by the session's auto-mode classifier. Not
  retried and not worked around: they are outward-facing changes to shared infrastructure and belong to the founder.
  The exact commands are in the supervisor's scratchpad as `n1-cutover.sh` and are repeated in the round report.
  Rows that depend on N1 (N2, R2) wait; everything else proceeds. Worktrees D1 and G2 prepared @ 2a3c5bf.
- 2026-09-04 08:05Z — **G1 merged** (aaf158a). Worker refuted two brief clauses with citations and was right both times:
  no `autobuild` step for javascript-typescript (build-mode `none`), and the action pins kept at the specified majors
  (v5/v9) because the newer majors change only the Node runtime. Hand-offs recorded: the ten labels in
  `.github/labeler.yml` do not exist in the repo yet (labeler runs with least privilege and cannot create them) —
  create them in G4; `codeowners/errors` to be checked on the default branch after push. Slot reused for D1.
- 2026-09-04 08:40Z — **D1 merged** (8099059) and **O2 merged** (7d288c4). O2: 76 pass / 0 fail; `bun tools/waves.ts
  docs/TASKS.csv` on main reports no ownership overlaps, no cycles, every dependency resolves; eight advisory `wave`
  column disagreements (computed waves run 0–6) — the column stays as written, the graph is the truth. O2 dropped one
  ported test ("records that the net is live") because it pins a global fact that differs per worktree; the
  state-independent invariant next to it stays. Supervisor fix from O2's hand-off: `.gitignore` `node_modules/` →
  `node_modules` so worktree symlinks are ignored. Hand-off to O3: `tools/package.json`'s `typecheck` needs
  `sdk/node_modules/.bin` on PATH until `tools/test.sh` wires it. Running: T0, G2, G3. Ready when a slot frees: O3, O4.
- 2026-09-04 09:20Z — **T0 merged** (3b05d3e): 49 pass / 0 fail re-run by the supervisor; eight mutations RED→GREEN in
  the worker's report, including both sides of the port import (a change in `worker/src/desktop-mode.ts` reddens
  `local/`). Measured on the pinned image, not assumed: the four neko ICE env names exist; `--webrtc.ip_retrieval_url`
  defaults to `checkip.amazonaws.com` only when `nat1to1` is absent; **`/etc/neko/neko.yaml` inside the image ships
  default passwords (`admin`/`neko`)** — `buildContainerEnv` fails closed on an empty password, and T2 must mint
  per-boot passwords. Hand-offs carried into briefs: T3 must publish the `-ezil-brand<N>` OVERLAY to GHCR (the bare
  neko tag lacks the mobile keyboard and the black-picture detector) and `EXPOSE` lacks 8443; T0's `verify_cmd` needs
  `bun install --cwd local` and an installed `app/` (typecheck reaches `drizzle-orm` through the app import).
  `local/node_modules` installed on main (its own lockfile; nothing shared). Running: G2, G3, O3.
- 2026-09-04 09:50Z — **G3 merged**. The brief said Dependabot commits carry no sign-off; measured on all seven open
  PRs: they DO (`Signed-off-by: dependabot[bot] <support@github.com>`) with an email that does not match the author,
  so the bot gate runs before any trailer is read — a harness built from the brief alone stayed green on the wrong
  design (worker's mutation M2). Third bot found in history (`copilot-swe-agent[bot]`) and allowlisted; merge commits
  are skipped and printed, because `git rebase --signoff` drops them and `main`'s own merges are unsigned. The check
  has never run on GitHub: the throwaway-PR proof (red, not pending) is a supervisor step after the first push.
  T2 dispatched (Docker adapter; must boot the real image on this box). Running: G2, O3, T2.
- 2026-09-04 10:10Z — **First push of the round** (`6495628..2bcf12f`), after a secret-shaped-string scan of the delta
  (only a lockfile sha512 matched). `codeowners/errors` on the default branch → 0 (was silently unresolvable).
  Ten path labels created for the labeler. Probe PR #10 opened from `probe/dco` with one UNSIGNED commit: all seven
  contexts appeared (the six the ruleset will require, plus `label`), the labeler applied `docs`. Waiting for the
  DCO check to report failure (a pending context would mean the display name is wrong).
- 2026-09-04 10:25Z — **DCO check proven on GitHub, both directions.** PR #10: unsigned commit `6ebf612` → `DCO: fail`;
  amended with `-s` (`e246de5`) → `DCO: pass`. Labeler applied `docs`; CodeQL and the four CI contexts all appeared
  as check runs on the PR, so every name the ruleset will require has now produced at least one run. PR closed
  without merging, branch deleted. **Dependabot auto-closed #3, #4, #6, #7, #8, #9** on its first run under the new
  policy — as D1 predicted; only the grouped patch PR #5 remains (merge after CI on it is green and read).
- 2026-09-04 10:45Z — **G2 merged** (GOVERNANCE.md, ROADMAP.md; 26 links checked, 0 dead; every roadmap status keyed
  to a TASKS.csv row). Worker refused three claims the brief made without evidence and it was right each time (worker
  commits carry only the DCO trailer; the workflows had already produced check runs; the release-waits-on-verify
  arrangement is row R1, not present). Supervisor fixes from its hand-offs: `github-actions` Dependabot entry now
  ignores majors too (#11 codeql-action 4, #12 labeler 7, #13 stale 11 opened within the hour against deliberate
  pins — closed); `CONTRIBUTORS.md` linked a non-existent login; `CODEOWNERS` header claimed approval is required.
  Noted for A2: `app/signup.mjs` is gitignored, never tracked — "delete" is a no-op; the argument stands. Wave 0
  complete. T1 dispatched (local host server). Running: O3, T2, T1.
- 2026-09-04 11:05Z — **CI green on `main` @ 89c9037** (worker, app, sdk+mcp, shell — all four jobs), CodeQL green.
  The run on the previous push (2bcf12f) shows `cancelled`: the workflow's per-ref concurrency group cancelled it
  when the next push arrived, which is the configured behaviour, not a failure.
