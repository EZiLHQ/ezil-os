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
