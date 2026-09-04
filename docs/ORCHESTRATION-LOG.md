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
- 2026-09-04 11:40Z — **T2 merged — the desktop runs locally.** Supervisor re-ran the full `local/` suite including the
  real boot: 124 pass / 0 fail. Measured on this box: cold boot 5.7 s to an authenticated neko login, warm reuse 75 ms,
  restart 7.6 s, 591 MiB resident; UDP mux bound on 127.0.0.1; `/tmp/neko.log` shows `nat1to1=127.0.0.1` and zero
  `checkip`/`amazonaws` lines. Seven mutations RED→GREEN, plus a container-level control: the same image with no
  password env accepts `admin`/`neko` — so the 401s are this host's minting, not neko's. Brief clauses refuted with
  measurement: neko has `/health` (body `true`), not `/api/health`; screen read/set are HTTP (`/api/room/screen`),
  not exec; the credential rides in the desktop URL (`?usr=…&pwd=…`) exactly as the app composes it, never in a
  response field; restart is stop+start because PID 1 is the launcher. Findings for later rows: host port 8443 is held
  by `supabase-kong` on this machine → `hostPortOffset` (both sides of the mux move together, or the browser gets a
  candidate pointing at nothing while every HTTP check stays green); neko advertises its compiled-in
  `stun:stun.l.google.com:19302` and the env spelling to clear it does nothing (T5's doctor prints it as a caveat;
  fixing it is an image change). T4 dispatched (CI matrix). Running: O3, T1, T4. Queued: T3, O4.
- 2026-09-04 12:30Z — **O3 merged** (e6c21b6): `tools/worktree.sh` (12 MB per worktree vs 1.1 GB of stores; `@ezil-os/sdk`
  relinked into the worktree — mutation-proved: a type error in the worktree's sdk reddens the worktree's mcp, and the
  old whole-directory symlink stayed GREEN on the same injection) and `tools/test.sh` (three fail-closed rules; every
  container skip named; a third gate for *vacuous passes* — `mobile-keyboard.container.test.ts` returns early from
  five bodies and bun counts them as PASS). Supervisor verified add/readlink/remove of a smoke worktree and the
  tools/sdk suites. **Finding: with the image present, `main`'s worker suite has 8 pre-existing failures** in
  `worker/scripts/mobile-keyboard.container.test.ts` (remote receives nothing) — CI is green only by absence of the
  image; rows M1 and M2 added (M2: `browser-sidecar-contract.test.ts` skips all 10 tests inside any worktree because
  it resolves the contract path to the worktree root). Supervisor fixes from O3's hand-offs: `.gitignore` now ignores
  `.dev.vars*`; the parse test scans `tools/`; `shell/run-tests.sh:161` no longer aborts under `set -u` when no
  Playwright variable is set (an unescaped `$EZIL_PLAYWRIGHT_DIR` inside a message). Row O3's own `verify_cmd` was a
  coincidence (exit 1 came from the 8 failures, not the guard) — CSV row corrected to the inducing command.
  T3 dispatched (GHCR image chain). Running: T1, T4, T3. Queued: O4.
- 2026-09-04 13:15Z — **T3 merged**: `docker/neko/{pins.env,build.sh}` (ported from EBuilder; `--dry-run`), `worker/Dockerfile`
  `ARG NEKO_IMAGE` → `ghcr.io/ezilhq/ezil-neko-vscode:d74052bb-049931d7-ezil-brand8` (the OVERLAY, per T0) and
  `EXPOSE 8443`; `.github/workflows/image.yml` (neko base + overlay only when the immutable tag is absent from the
  registry or `rebuild_base` is explicit; desktop image on every main push/tag; cosign keyless; provenance
  attestations; `cancel-in-progress: false` so a cancel cannot land between push and sign). Local build against the
  overlay: exit 0 (cache-warm, 4 s), `ExposedPorts` gains `8443/tcp`. Worker found `deploy/images.env` is not
  shell-sourceable by design (`<to be pinned by CI>`) — the workflow greps it like `parseImagesEnv` does. Row T7 added
  for the three hand-offs (overlay tag key in images.env; `ghcr.io/m1k1o/neko/base:latest` is a floating base —
  pin by digest; nothing writes the desktop tag back). The push of this merge triggers image.yml for the first time:
  its GHCR pushes and signatures are the proof, watched below. O4 dispatched. Running: T1, T4, O4.
- 2026-09-04 14:20Z — **T1 merged** (d0bc646): the local host serves `/os` as a plain document with the inlined boot
  payload, the three bundle files by path with mtime ETags, and all nine `/api/shell/*` routes over an injected
  `SandboxHost`; 127.0.0.1 only (a wide bind was mutation-proved reachable on 10.60.1.4 and is refused); a fake host
  claiming `desktopReady: true` was overridden live by a real reachability check (`desktop_unreachable`). Two defects
  the worker's own positive controls caught: a status poll burned the `isNew` latch; the no-hostname scanner treated
  `https://` as a comment. Union of T1+T2 verified on main by the supervisor: typecheck clean, **210 pass / 0 fail**
  including the real boot. Integration seam handed to T5 (measured by T1 on the image): `/etc/neko/neko.yaml` ships
  `session.implicit_hosting: false`, so a browser session renders the desktop but every click is ignored unless the
  adapter sets `NEKO_SESSION_IMPLICIT_HOSTING=true` (env binds on this binary — proven with `NEKO_SESSION_FILE`).
  T5 now owns all of `local/` (T0–T2 are done and nobody else is in it). Running: T4, O4, T5.
- 2026-09-04 14:50Z — **image.yml's first run succeeded end to end** (run 33858675382; neko-base 09:30→09:33, desktop
  09:33→09:39). The gate reported `base_exists=false overlay_exists=false → building`; the base really was built in
  CI from the pinned recipes on upstream `neko/base` (67 s, 2.2 GB, image id `e4b90aeb…`), the overlay and the desktop
  image were pushed, and cosign recorded Rekor entries 2709596886 and 2709598082 for the base and overlay. **Not yet
  usable by the public:** `docker manifest inspect ghcr.io/ezilhq/ezil-os-desktop:latest` → `unauthorized`, i.e. the
  new packages are private (GHCR default) and this session's token has no packages scope — visibility to Public is a
  founder step (added to the founder-run script). T3 recorded at DEPLOYED; TARGET_ENVIRONMENT_CONFIRMED needs the
  anonymous pull and `gh attestation verify` to pass.
- 2026-09-04 15:40Z — **T4 returned; its proof is PR #14** (`task/T4` → main): 4 jobs × 3 OS + `tools`, `container`,
  `local`. Measured by the worker: under Git for Windows' default `autocrlf`, `shell/src/**/*.css`, `*.svg` and the
  non-`.mjs` shell JS check out CRLF because T0's `.gitattributes` does not pin them, so the bundle-diff step (only
  that step) is gated off Windows with the measurement in its comment — hand-off for `.gitattributes`. The `local`
  job's skip detector originally failed OPEN on reporter drift (advisor-caught; now a positive control). Row T8 added:
  wire `container`/`local` to pull the GHCR image with the workflow's own token and retire the placeholder. The
  15 matrix display names for G4 are in T4's report and PR #14's check list. A1 dispatched (allowlist schema +
  invite CLI). Running: O4, T5, A1.
- 2026-09-04 16:20Z — **O4 merged** (`docs/ORCHESTRATION.md`, 12/12 links, rungs byte-identical to `tools/waves.ts`).
  **PR #14 first run:** `sdk + mcp` GREEN on ubuntu, windows AND macos; `app` green on ubuntu and macos; `tools`
  green; DCO and CodeQL green; `container` and `local` red by design (row T8). `shell` red on all three OSes with the
  same cause — the composite action used `${{ runner.temp }}` in a `with:` position, which a composite action may not
  ("Unrecognized named-value: 'runner'"), so the action failed to load. Supervisor patch on `task/T4` (48bdec1):
  paths and cache key computed once in bash from `$RUNNER_TEMP`/`$RUNNER_OS` and passed as step outputs. PR re-running.
  X1 dispatched (local-agents research). Running: T5, A1, X1.
