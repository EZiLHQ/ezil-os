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
