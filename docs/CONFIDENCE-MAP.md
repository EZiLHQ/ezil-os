# The confidence map — what round ANYWHERE proved, who proved it, and to which rung

**INTERIM. Measured 2026-09-04, 12:30–13:40Z, by the `O5` verifier, from worktree
`.claude/worktrees/O5` on branch `task/O5`. The worktree was cut at
`4b05869` and rebased onto `3c76d43` mid-pass, because `main` moved eight PRs
while the pass ran; the rows that changed were re-measured at `3c76d43` and every
count below says which base it belongs to. The verifier wrote none of the code
below. This pass runs again after row `R2`.**

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

### 0.3 `main` moved eight PRs under this pass — and the headline changed with it

The worktree was cut at `4b05869` at 12:31Z. By 13:20Z `origin/main` was
`3c76d43`, six commits ahead:

| landed after this pass's first base | what |
|---|---|
| `2a5007d` (#23) | `R1` — `deploy.yml` waits for the tag's image, `release.yml`, `CHANGELOG` 0.2.0, `docs/RELEASE.md` |
| `f15787a` (#24) | `M1` — the mobile-keyboard container suite: honest skips, no vacuous passes |
| `d9d70f4` (#26) | a second `win32` announced skip in `app` |
| `3c76d43` (#27) | `M4` — the "macOS import" failure was a missing `cloudflare:workers` stub plus directory order; worker unit steps un-gated on all three OSes |
| `995a61b` (#20), `e1bd1c0` (#25) | supervisor log/ledger folds |

(And it kept moving: by the time this branch was pushed, `origin/main` was
`63eec2e` — a **new round**, `INTAKE`, with rows `I0a`–`I6b` dispatched. Nothing
below was measured at that commit. Read every figure against the sha attached to
it.)

**The first draft of this document said `main`'s CI was red. That is no longer
true and the correction is the most important line in this file.** At `3c76d43`,
CI run `33876458190` is **green on all fifteen jobs**, `container (real image)`
and `local (typecheck + unit + smoke)` included — the first fully green CI run on
`main` in this round (§3.7).

### 0.4 What "proven" means here, and where the round's real gaps are

1. **Nothing is deployed, and the thing that is built is not reachable.** No tag
   exists, `deploy.yml` and `release.yml` have **zero runs**, and
   `docker manifest inspect ghcr.io/ezilhq/ezil-os-desktop:latest` from an empty
   Docker config answers `unauthorized` (§3.8, with a public-image positive
   control). The images are built, pushed and cosign-signed; no member of the
   public can pull one. Making the packages public is a founder step.
2. **`container` and `local` are not required contexts, and that is correct
   today, not a gap.** Both jobs authenticate to GHCR with
   `secrets.GITHUB_TOKEN` (`ci.yml:498`, `:581`) to pull a **private** package. A
   pull request from a fork is not expected to be able to do that, so requiring
   those contexts would block every outside contribution for a reason that has
   nothing to do with the contribution. They become requirable the day the
   packages go public — which is the same founder step as (1). Until then `G4`'s
   fifteen are the right fifteen. *(The package's privacy is measured. The fork
   half is **inferred** from GitHub's fork-PR token restrictions and from those
   two `ci.yml` lines — no fork pull request exists against this repository, so
   `_MANDATORY` §13 says to label it an untested hypothesis rather than assert
   it.)*
3. **The desktop image tag is still a placeholder.** `deploy/images.env` reads
   `EZIL_DESKTOP_TAG=<to be pinned by CI>`; `T7`'s write-back publishes the real
   tag as a CI **artifact** and nothing commits it. Local mode starts here only
   because the doctor falls back to a locally-built image — and says so out loud
   (§3.6). A value that looks like configuration and is not one is a failure mode
   this project has already paid for.
4. **CI does not use `tools/test.sh`, and the two harnesses run different test
   sets.** Not one job in `ci.yml` invokes it; every leg calls `bun test` /
   `bun run test` / `npx vitest` directly, and the `container` and `local` jobs
   re-implement their own skip detection inline (`ci.yml:550`, `:695`). So
   `O3`'s three fail-closed rules and its vacuous-pass gate — the guards
   `_MANDATORY` §7 obliges every agent to run behind — protect a developer's
   machine and not the merge gate. Two measurements show the drift is not
   theoretical:
   - the worker unit legs on the green run report `1025 / 1003 / 995 pass` with
     `43 / 65 / 73 skip` on ubuntu / macos / windows, all green, **no skip named
     anywhere in the job output** (§3.7);
   - `shell/responsiveness-browser-test.mjs` **exists and CI runs it**
     (`ci.yml:382`, 20/20 on `main`), while `shell/run-tests.sh`'s hand-maintained
     `run_suite` list omits it — so `./tools/test.sh shell` runs 24 suites where
     CI's ubuntu leg runs 25 (§3.6).

---

## 1. The table

One row per plan row that has landed, plus the three that have not. "Who
verified" is the `O5` verifier throughout — that is the point of the row — and
the named worker is whose claim was re-run. Rungs are the nine in
`tools/waves.ts`; where the evidence buys a *different* rung from the one the
`done_rung` column targets, the difference is stated rather than rounded away.

| stage | who verified | the test | rung the evidence honestly buys | confidence | why not more |
|---|---|---|---|---|---|
| **O1** agent definitions committed, `.gitignore` rewritten | O5, re-running the supervisor's row | `git check-ignore -v .claude/agents/verifier.md` → exit 1, prints nothing (not ignored); `.claude/worktrees/x` → ignored at `.gitignore:52`; `git ls-files .claude/agents/` → 6 files | `COMMITTED` (target `COMMITTED`) | High | Tracked files are the whole claim. It does **not** prove the harness loads them: the round log's 07:30Z entry records that `subagent_type: worker-sonnet` returns "Agent type not found" mid-session, so the roles bind by being read, not by being resolved. |
| **O2** `waves.ts` + `ledger.ts` ported | O5, re-running the `worker-sonnet` row | `./tools/test.sh tools` → **76 pass / 0 fail / 134 expect()**, `tsc --noEmit` clean, exit 0 (twice: both bases); `bun tools/waves.ts docs/TASKS.csv` exit 0 over 30 rows; `bun tools/ledger.ts` exit 0 **and it caught a real stall** (`N2`: row running, no artifact ever written) | `INDEPENDENT_TEST_PASS` (target `INDEPENDENT_TEST_PASS`) | High | The stall detector was exercised by an actual stall, not a fixture. But only the *report* form was run — `bun tools/ledger.ts apply`, the path that writes `docs/TASKS.csv`, is untouched by this pass. |
| **O3** `tools/worktree.sh` + `tools/test.sh` | O5, re-running the `worker-opus` row | `worktree.sh add smoke` → `readlink -f smoke/mcp/node_modules/@ezil-os/sdk` = `<smoke>/sdk` (inside the worktree), 13M, `remove smoke` clean. Both fail-closed gates mutation-proved: `EZIL_VALIDATE_IMAGE=absent:x EZIL_NEKO_IMAGE=absent:x` → **exit 1**, 23 skips named per suite **and** the vacuous-pass message naming `mobile-keyboard`; adding `EZIL_ALLOW_SKIPPED_CONTAINER_TESTS=1` → **still exit 1** | `INDEPENDENT_TEST_PASS` | High | Proved on ext4, on Linux, on this box. And **no CI job calls it** (§0.4 item 4), so these gates protect a developer's terminal and not the merge gate. |
| **O4** `docs/ORCHESTRATION.md` | O5, re-running the `worker-sonnet` row | 16 relative links, **0 dead**; all nine `DONE_LADDER` rung names present in both the doc and `tools/waves.ts` | `COMMITTED` (target `COMMITTED`) | High | It is prose about a moving plan, and part of it is already stale: it quotes eleven `wave`-column notes, `waves.ts` printed twelve at the first base and a different set at the tip. |
| **T0** local-mode contracts pinned | O5, re-running the `worker-opus` row | inside `./tools/test.sh local` → **307 pass / 0 fail across 14 files**, exit 0 (contract suites `run-spec`, `shell-api` included) | `INDEPENDENT_TEST_PASS` | High | The contract is pinned between `local/` and `worker/`. Nothing here checks that the **app** serialises the same shapes at runtime; that seam is asserted by a fixture, not by the app. |
| **T1** local host server (`/os`, bundle, nine `/api/shell/*`) | O5, re-running the `worker-opus` row | within the 307; plus the launcher for real: `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:7080/os` → **200**, bound on `127.0.0.1` only | `INDEPENDENT_TEST_PASS` | High | One document fetched by `curl`, no browser. The nine shell routes are covered by tests against an injected host, not by a real session driving them. |
| **T2** Docker adapter over `docker run/exec` | O5, re-running the `worker-opus` row | `local/src/host/docker-host.container.test.ts` booted the real pinned image — printed `cold boot (docker run -> authenticated neko login): 5.6s` | `INDEPENDENT_TEST_PASS` (target `WORKER_RUNTIME_EVIDENCE` — the evidence exceeds the target) | High | amd64 Linux, Docker 29.1.3, one image tag. Nothing about arm64, Docker Desktop's VM, rootless, or Podman. |
| **T3** neko build inputs + `image.yml` (cosign, provenance) | O5, re-running the `worker-sonnet` row | `gh run list --workflow image.yml` → **three** completed `success` runs (`33858675382`, `33865834089`, `33872022290`); `worker/Dockerfile` pins the GHCR overlay; `DOCKER_CONFIG=$(mktemp -d) docker manifest inspect ghcr.io/ezilhq/ezil-os-desktop:latest` → `unauthorized` | `DEPLOYED` (target `DEPLOYED`) | Medium | Built, pushed, signed — and unreachable. Anonymous pull is refused, so nobody outside can verify the attestation either. `TARGET_ENVIRONMENT_CONFIRMED` needs the packages made public (founder step). |
| **T4** three-OS CI matrix | O5, re-running the `worker-sonnet` row | CI run `33876458190` on `main`: the twelve matrix legs **all green** on ubuntu-, windows- and macos-latest; per-leg counts read from the job logs, not the badge | `INDEPENDENT_TEST_PASS` | High | Green proves the same tree passes on three OSes. It does **not** cover geometry off Linux: `ci.yml:377` runs the geometry family under `if: runner.os == 'Linux'`, so every pixel claim is a Linux claim. |
| **T5** doctor + real-browser smoke | O5, re-running the `worker-opus` row | doctor at offset 10000 → **12 pass / 2 warn / 0 fail**, exit 0. Smoke: cold boot **6.3 s**, first non-uniform pixels **2546 ms** after the window opened, `stdDev 58.8 / 29 of 32 buckets`, `/api/room/control` `has_host false → true`, `xdotool` pointer `960,960 → 383,268` against an expected `384,270` | `INDEPENDENT_TEST_PASS` (target `WORKER_RUNTIME_EVIDENCE`) | High | Pixels arrived and a click moved the X pointer. **Nothing proves an application reacted to the input.** One viewport, one browser (Chromium), audio untouched, one machine. |
| **T6** `release.yml` + the launcher pair | O5, re-running the `worker-sonnet` row | `deploy/launcher/ezil-os.sh` run end to end on Linux: doctor, host up, `/os` → 200, `SIGINT` → `Stopping the local host…`, port released, **no container left**. `gh run list --workflow release.yml` → **(no runs)** | `INDEPENDENT_TEST_PASS` for the **bash launcher on Linux**; `STATIC_CHECKS_PASS` for `release.yml` (target `STATIC_CHECKS_PASS`) | Medium | The workflow has never executed — there is no tag. `deploy/launcher/ezil-os.ps1` was **not run at all**: no Windows host was available to this pass, and a PowerShell launcher that has never been executed is untested code. |
| **T7** overlay tag in `images.env`, base pinned by digest, tag write-back | O5, re-running the `worker-sonnet` row | `image.yml` succeeded again on the merge that carried it; `deploy/images.env` carries `EZIL_NEKO_OVERLAY_TAG=d74052bb-049931d7-ezil-brand8`; the doctor read the file and reported `images_env_bad_tag: '<to be pinned by CI>'` | `DEPLOYED` for the workflow half; `STATIC_CHECKS_PASS` for the write-back | Low–Medium | `EZIL_DESKTOP_TAG` is still the literal placeholder. The write-back exists only as a CI artifact nothing consumes, so the one pin a fresh machine would obey is not a value. Local mode starts here only via the doctor's fallback. |
| **T8** CI pulls the GHCR image and runs the real container suites | O5, re-running the `worker-sonnet` row | job `101034493104` on `main`@`3c76d43`: **32 pass / 0 fail, 135.41 s**; job `101034493205`: doctor `12 pass, 2 warn, 0 fail` then **307 pass / 0 fail** — the same numbers this box produced | `INDEPENDENT_TEST_PASS` | High | It works, on a runner, on the real image. It is not a required context — correctly, while the package is private (§0.4 item 2) — and its no-silent-skip guard is hand-rolled in `ci.yml`, not `tools/test.sh`. |
| **G1** CODEOWNERS login, CodeQL, labeler, stale | O5, re-running the `worker-sonnet` row | `gh api …/codeowners/errors` → `{"errors":[]}`; `CodeQL (javascript-typescript)` green on `main`; `labeler` green on `task/R1`; all ten `.github/labeler.yml` keys exist as real labels | `INDEPENDENT_TEST_PASS` for CODEOWNERS + CodeQL + labeler; `STATIC_CHECKS_PASS` for `stale.yml` (target `STATIC_CHECKS_PASS`) | Medium–High | `stale.yml` has **no runs at all** — its schedule has never fired, so nothing has ever been staled, exempted, or wrongly closed by it. |
| **G2** `GOVERNANCE.md`, `ROADMAP.md` | O5, re-running the `worker-opus` row | 22 + 23 relative links resolved, **0 dead** | `COMMITTED` (target `COMMITTED`) | High | A governance document is true only when it is followed. This pass measured that the links resolve, not that the practice matches — though `G4`'s ruleset and the squash-only history are at least consistent with it. |
| **G3** DCO check workflow | O5, re-running the `worker-opus` row | `gh api …/commits/6ebf612/check-runs` → **`DCO failure`**; `…/commits/e246de5/check-runs` → **`DCO success`** — the same tree, unsigned then amended with `-s` | `INDEPENDENT_TEST_PASS` | High | Proved both directions on real GitHub check runs. The **bot-allowlist** branch (dependabot's `Signed-off-by` email not matching its author) has never produced a check run of its own, so that half is code-reviewed, not exercised. Note also that `G3`'s own artifact records a rung that is not on the ladder. |
| **G4** Discussions + branch ruleset | O5, re-running the supervisor's row | ruleset `22265548` `enforcement: active` on `~DEFAULT_BRANCH`: deletion + force-push refused, linear history, PR required (0 approvals), `allowed_merge_methods: ["squash"]`, **15** required contexts, admin bypass in `pull_request` mode only; `has_discussions: true`; PRs #18 and #20 observed `BLOCKED` until their contexts reported | `TARGET_ENVIRONMENT_CONFIRMED` (target `TARGET_ENVIRONMENT_CONFIRMED`) | High | Configured on the real GitHub and observed refusing a merge. `strict` (up-to-date-before-merge) is deliberately off, so a PR can merge green against a base it never tested against — a real, accepted trade for concurrency. |
| **D1** Dependabot policy | O5, re-running the `worker-sonnet` row | `gh pr list --state all --author app/dependabot -L 20` → **12 PRs, 11 CLOSED** (every major bump: checkout 4→7, setup-node 4→7, typescript 5.9→7.0, zod 3→4, eslint 9→10, motion 11→13, sonner 1→2, codeql-action 3→4, labeler 5→7, stale 9→11, workers-types), **1 OPEN** (the grouped patch/minor #5) | `COMMITTED` (target `COMMITTED`), with a measured real-world effect | High | The policy's effect is observed. Nothing here says the one remaining grouped PR is safe to merge, and nothing tests what happens when a *security* advisory arrives against a pinned major. |
| **A1** `ezil_os_access`, `EZIL_OS_ACCESS_MODE`, `assertOsAccess`, `tools/invite.ts` | O5, re-running the `worker-opus` row | `./tools/test.sh app` → **44 files / 817 pass / 0 fail**, `npx tsc --noEmit` and `bun run lint` clean, exit 0 | `INDEPENDENT_TEST_PASS` (target `INDEPENDENT_TEST_PASS`) | Medium | Migration `0002_os_access.sql` was applied to a throwaway Postgres 17; **the hosted database has never seen it**. `tools/invite.ts` was not run against a real Supabase project by this pass, so its three exit codes are tested, not exercised. |
| **A2** the gate in `protectedProcedure`, page gates, no sign-up | O5, re-running the `worker-opus` row | `npx vitest run app/src/server/api/trpc-access.test.ts` → **20/20**, including *"an authenticated bearer that is not on the allow-list gets FORBIDDEN"*, its invited positive control, and *"a caller with no user is still UNAUTHORIZED, not FORBIDDEN"*. Mutation `if (false && !access.allowed)` at `trpc.ts:172` → **6 failed / 14 passed**; restored → 20/20 | `INDEPENDENT_TEST_PASS` (target `INDEPENDENT_TEST_PASS`) | Medium | Code-level only, and that ceiling is `N1`'s, not `A2`'s: **nothing is deployed, so no real caller has ever been refused.** The invited landing reads the implicit-grant fragment client-side (`app/src/app/auth/invited/fragment.ts`) — a genuine answer to `A1`'s objection — and has never been walked end to end with a real invite email. |
| **M1** mobile-keyboard container suite | O5, re-running the `worker-sonnet` row | at the tip with the image: **32 pass / 0 fail / 0 skip**; with both images absent: **0 pass / 32 skip**, `mobile-keyboard` contributing **9 honest skips** where it previously contributed 8 vacuous passes; and CI's own `container` job on `main` **32 / 0** | `INDEPENDENT_TEST_PASS` | High | Fixed, not silenced — proved in both directions and corroborated on a GitHub runner. Still one image tag, one Linux kernel, one Chromium. |
| **M2** sidecar contract path | O5, re-running the `worker-sonnet` row | `bun test worker/src/browser-sidecar-contract.test.ts` **inside a worktree** → **10 pass / 0 fail / 61 expect(), 0 skip** | `INDEPENDENT_TEST_PASS` | High | Verified in exactly the place it used to fail (all ten skipped in any worktree before). Not verified in a bare clone, a submodule, or a detached `GIT_DIR`. |
| **M3** Linux-only script suites self-skip off Linux | O5, re-running the `worker-sonnet` row | control on Linux → **5 pass / 0 fail / 41 expect()**; with `process.platform` forced to `darwin` by a `--preload` → **0 pass / 5 skip / 0 fail**, and the reason printed in full | `INDEPENDENT_TEST_PASS` for the branch; `STATIC_CHECKS_PASS` for the claim about macOS | Medium–High | The platform was **simulated**, not real. This proves the branch exists and produces *recorded skips* rather than vacuous passes; it does not prove behaviour on a Mac. CI cannot corroborate it either: the macOS leg reports 65 skips in total and names none. |
| **M4** the "macOS import" failure, worker steps un-gated | O5, re-running the `worker-opus` row | CI run `33876458190`: `worker` green on **all three** OSes, the same **1068** tests collected on each leg (`1025 / 1003 / 995 pass`, `43 / 65 / 73 skip`, `0 fail`) | `INDEPENDENT_TEST_PASS` | High | Three green legs on the real matrix. This pass did not independently reproduce the `cloudflare:workers` stub diagnosis; it took the three green legs as the evidence, which is a weaker thing than re-deriving the cause. |
| **X1** local-agents survey | O5, re-running the `worker-sonnet` row | `docs/research/local-agents.md` present at 550 lines, links resolve | `COMMITTED` (target `COMMITTED`) | High | A survey is `COMMITTED` by construction. Nine of its own claims are labelled `NOT MEASURED` by its author and remain unmeasured here. |
| **R1** `deploy.yml` waits for the tag's image; `CHANGELOG` 0.2.0; `docs/RELEASE.md` | O5 | merged as `2a5007d` (landed **after** this pass's first base); `gh run list --workflow deploy.yml` → **(no runs)**; `--workflow release.yml` → **(no runs)** | `COMMITTED` (target `STATIC_CHECKS_PASS`, and this pass did not re-run its static checks) | Low | Neither workflow has ever executed and there is no tag in the repository. Every claim about the release path is unexercised YAML. This row's own suites were not re-run here — it merged mid-pass and its evidence is `R1.json`, not this document. |
| **N1** `os.ezil.work` | — | **NOT DONE.** `pending`, `gate: founder`; `bun tools/waves.ts` prints it `[ ]` in wave 0 | — | — | What would prove it: the Vercel project domain added; an **unproxied** A record that actually resolves; the Supabase redirect allowlist carrying `/auth/invited`; and one real sign-in by an allow-listed address landing on `/os` served by a post-gate build. |
| **N2** canonical host in docs + e2e default | — | **NOT DONE.** `bun tools/ledger.ts` reports it `STALLED` — *"row says running and no artifact was ever written"* | — | — | Its docs half is described as landed in the round log; no artifact exists for it, which is precisely the state the ledger is built to name. The e2e default flip waits on `N1`. |
| **R2** secrets, `EZIL_OS_ACCESS_MODE` on Vercel, tag `v0.2.0`, watched deploy | — | **NOT DONE.** `pending`, `gate: founder` | — | — | What would prove it: a `v0.2.0` tag; one successful `release.yml` run and one successful `deploy.yml` run; a published Release carrying the tarball, `SHA256SUMS` and an attestation that `gh attestation verify` accepts **anonymously**; and the deployed host answering with the post-gate build rather than the 2026-08-26 hand-upload. |

---

## 2. What remains unmeasured

Not "what failed" — what nothing in this session, or in any run it could read,
has ever observed. Each entry names the test that would close it.

### 2.1 The invited user, end to end — the biggest hole

`A1` raised it, `A2` answered it in code, and **nobody has walked it**. Supabase
invites are not PKCE (`@supabase/auth-js`, `GoTrueAdminApi.js:95`, quoted in
`app/src/app/auth/invited/fragment.ts`), so `/auth/v1/verify` completes as an
implicit grant and hands the session back in the URL **fragment** — which no
server route can read, and which `@supabase/ssr`'s browser client refuses
because it hard-codes `flowType: "pkce"`. `A2` therefore parses the fragment
itself and calls `setSession` explicitly. That reasoning is sound and cited at
file:line; it is also **entirely unexecuted**. What would close it: an allow-list
row seeded in a real project, `tools/invite.ts add` sending a real invite,
clicking the link in a real browser, and landing signed-in on `/os`. Nothing
short of that is evidence, because every failure mode here is in the parts a unit
test replaces.

### 2.2 The deployed host predates the entire round

`N1` never ran. The Worker that answers today was uploaded **by hand on
2026-08-26**, before the first commit of this round. So the invite gate, the page
gates, the removal of sign-up, the access mode defaulting to `invite` — none of it
is running anywhere a person can reach. Any sentence of the form "EZiL OS is now
invite-only" is, today, a statement about the repository and not about the
product.

### 2.3 Nobody outside can pull the image, so the supply chain is unverified from outside

`docker manifest inspect ghcr.io/ezilhq/ezil-os-desktop:latest` from an empty
Docker config → `unauthorized`, while the same command against
`ghcr.io/m1k1o/neko/base:latest` succeeds — so the refusal is package privacy,
not a broken anonymous path. The consequence is not only "no pulls": cosign
signatures and provenance attestations exist (`image.yml` recorded Rekor entries)
and **no outsider can verify them**, because verification needs the manifest.
What would close it: packages set Public, then an anonymous
`docker manifest inspect` and `gh attestation verify` that both succeed.

### 2.4 The release pipeline is unexercised YAML

`release.yml` (`T6`) and `deploy.yml` (`R1`) have **zero runs each**; `stale.yml`
has zero runs; there are no tags in the repository. The tarball, the
`SHA256SUMS`, the provenance attestation, the draft-then-publish ordering, the
"deploy waits for the tag's image" gate — every one of those is a claim about a
workflow that has never started. What would close it: `R2`.

### 2.5 One browser, one viewport, no audio, no arm64

The real-browser evidence (`T5`, and the `shell` suites) is **Chromium, one
viewport, on amd64 Linux with Docker 29.1.3**. Nothing measures Firefox or
WebKit; nothing measures a phone-sized viewport against a real container (the
phone suites drive a simulated shell); **audio is untouched end to end** — no
test asserts a sound reaches the browser; and no run has ever happened on
**arm64**, where the desktop image would need a different build entirely. The
geometry family runs on the Linux leg only, so every pixel figure in this
document is a Linux figure.

### 2.6 `deploy/launcher/ezil-os.ps1` has never been executed

The bash launcher was run end to end here. Its PowerShell twin was read and not
run — there is no Windows host in this pass and `release.yml`, which would
exercise it, has never fired. A launcher is the first thing a new user touches;
half of that surface is untested code.

### 2.7 The wall-clock long-poll tests are flaky on Linux too, not only on Windows

Measured on **this document's own pull request**, #29, whose entire diff is one
Markdown file and one JSON artifact. `app (typecheck + unit) (ubuntu-latest)`
went **red**:

```
FAIL src/server/lib/desktop-display-honesty.test.ts
  > probeDesktopDisplayLongPoll — z1: catch the peer connecting WHILE we ask, honestly
  > a stable blank is held for the WHOLE budget, then answered honestly — never fabricated as a timeout
AssertionError: expected { display: 'unknown', …(1) } to deeply equal { display: 'blank', sessions: 1 }
Test Files  1 failed | 43 passed (44)      Tests  1 failed | 816 passed (817)
```
The same file passed here (`29 tests, 5069 ms`) and passed on `main`'s green run
minutes earlier. This is the **exact test class** the round already skipped on
Windows at 19:10Z for being wall-clock sensitive — and the class the second
`win32` skip (`d9d70f4`, merged today) was added for. It is now demonstrably
flaky on a Linux runner as well, which means the merge gate can refuse a
documentation-only change. Nothing measures its flake rate. What would close it:
either a fake clock, or a recorded pass rate over N runs rather than one.

### 2.8 Two `win32` blocks and the geometry family are green by not running

Honest, announced skips — but skips. `app/src/server/lib/desktop-display-honesty.test.ts:508`
and `desktop-frame-reprobe.test.ts:135` are `describe.skipIf(process.platform === 'win32')`,
the second of them titled *"the honesty contract is not weakened"*. Both are
wall-clock timing blocks that were flaky on the slower Windows runner. So the
Windows `app` leg is green **partly because those blocks do not run there**, and
no timing claim in that file is measured on Windows. Likewise the geometry
browser suites (`ci.yml:377`) and the container-script worker suites (`M3`) do not
run off Linux.

### 2.9 `.gitattributes` still leaves the bundle-drift gate off Windows

`*.mjs` is pinned to `eol=lf`; `*.css`, `*.svg` and the non-`.mjs` shell JS are
not, so a Windows checkout gets CRLF for them and `ci.yml:320` gates the
bundle-diff step with `if: runner.os != 'Windows'`. The one check that stops a
stale committed `app/public/os/bundle.min.js` from shipping is therefore never
exercised on Windows. `T4` handed this off; nothing has taken it.
Hand-off: `.gitattributes:19-26`, `.github/workflows/ci.yml:320`.

### 2.10 A cancelled container run orphans a container

Measured, twice, deliberately (§3.9): `worker/src/neko-browser-window.container.test.ts:191`
cleans up in `afterAll` and installs **no signal trap**, so `SIGTERM` mid-run
leaves a container from a 4.57 GB image resident — this pass produced one that
held **456.2 MiB for eight minutes** after its owning process was gone. On a
GitHub runner the VM is discarded and it costs nothing; on a contributor's
machine it is invisible and permanent. Two of `main`'s CI runs today were
`cancelled` mid-flight. Nothing measures how many such containers a week of local
development leaves behind.

### 2.11 The cloud cost/residency oracle is unchanged, and deliberately not re-derived

No deploy happened this round: `deploy.yml` has never run, there is no tag,
`os.ezil.work` does not resolve. The hosted product's residency and cost picture
is therefore exactly what `docs/RUNBOOK.md` already records, and this pass adds
nothing to it. Writing a number here would be invention.

### 2.12 Three rows have no run artifact at all

`G4` (a supervisor row), `M2` (folded into `M3`'s PR) and `T8` have no
`artifacts/runs/wf-os-2026-09-04/<id>.json` in `main` — `T8`'s existed as an
untracked file in the main checkout earlier in this pass and is not there now.
Their work is real and verified above; the record `_MANDATORY` §2 requires is
missing, which is the exact condition the ledger cannot distinguish from "the
agent died". `bun tools/ledger.ts` currently names `N2` stalled for that reason.

### 2.13 What this document itself is blind to

Every figure here comes from one machine (amd64 Linux, 8 cores, Docker 29.1.3,
bun 1.3.14) plus GitHub-hosted runners, on one day, with three sibling worktrees
running concurrently — so every timing number carries contention this pass did not
control for. `main` moved eight PRs during the pass; the counts are pinned to two
named commits and nothing guarantees the tip is still either of them by the time
you read this. And the deepest blind spot is structural: a verifier can prove that
a test fails when the code is broken, which is what mutation-proving buys, but it
cannot prove that the test asks the right question. Rows `T5` and `M1` are the
sharpest examples — pixels arrived and keystrokes reached the remote, and **no
assertion anywhere establishes that an application on the desktop reacted**.

---

## 3. Commands run

Every command below was run in this session, in this worktree, in this order.
The result line is the real tail of what it printed.

One command is missing from the list on purpose: `gh pr checks 29`, run against
this document's **own** pull request, because a verifier who certifies a merge
gate and does not then watch it judge their own change has certified a badge.
What it found is §2.7.

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

**At the rebased tip `3c76d43`, with the image present — this is the current
number:**
```
$ PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules \
  EZIL_VALIDATE_IMAGE=ezil-os-worker-sandbox:ff199202 ./tools/test.sh worker
```
Exit **0**.
```
 1067 pass
 1 skip
 0 fail
Ran 1068 tests across 39 files. [320.89s]
==> 1 test(s) were SKIPPED. A skip is not a pass. By suite:
         1  src/preview-timeouts.test.ts
```
One named skip, nothing else — the eight failures below are gone, and the
container suites really ran (`docker ps -a` after: nothing named `ezil-os-*` or
`ezil-w9-*`). Compare CI's own ubuntu worker leg on the same commit:
`1025 pass / 43 skip / 0 fail` — same 1068 tests, 42 more skipped, because that
leg has no image and calls `bun test` directly rather than through
`tools/test.sh` (§0.4 item 4).

**The rest of this section is the measurement at the first base, `4b05869`, and
is kept because it is what the gates were proved against.**

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

### 3.6 shell, and the local-mode doctor

```
$ PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules ./tools/test.sh shell
```
Exit **0**. `[gate] shell/build-shell.sh --check → PASS bundle matches source`
first (so the committed `app/public/os/bundle.min.js` really is the current
source), then twelve node-only suites and twelve real-browser suites:

```
24 passed   0 failed   0 skipped        (1495 individual checks)
```
Longest legs: `shell/ezil/boot-test.mjs` 179 s / 173 checks,
`ui/Settings/stacking-browser-test.mjs` 48 s / 578 checks.

**Which of these are Linux-measured geometry.** `.github/workflows/ci.yml:377`
runs a named list — `responsiveness`, `seam-minimise`, `window-chrome`,
`phone-stacking`, `overlay-paint`, `resize` — under `if: runner.os == 'Linux'`,
because macOS Chromium settles a 1920px shell at 1919px and a minimise/restore
cycle lands 5–6px off. Everything in that list that this run executed
(`window-chrome` 21, `seam-minimise` 30, `overlay-paint` 30, `resize` 20,
`phone-stacking` 38) is therefore **a Linux measurement and evidence about Linux
only** — a geometry claim about macOS or Windows needs a suite measured there,
and none exists.

🔴 **`responsiveness-browser-test.mjs` did not appear in this run's 24 — and the
reason is a defect, not a skip.** The file exists (`shell/responsiveness-browser-test.mjs`,
39,948 bytes) and `ci.yml:382` runs it by name in the Linux-only geometry step —
where it passed on `main`'s green run, `20/20 checks`, job `101034493057`. But
`shell/run-tests.sh` selects suites from a **hand-maintained list of `run_suite`
lines** (`:273` onwards) and that file is not on it, while the comment above the
list at `:251` claims *"Every `*-test.mjs` under `shell/` tests the COMMITTED
bundle"*. So `./tools/test.sh shell` — the runner `_MANDATORY` §7 obliges every
agent to use — runs a **strictly smaller set** than CI does, and a new
`*-test.mjs` dropped into `shell/` is silently not run locally at all. This is
§0.4 item 4 in its sharpest form: not two runners, two different **test sets**.
Hand-off: `shell/run-tests.sh:251-273`.

The
behaviour family (`touch-focus` 28, `os-chrome` 62, `mobile` 39, `stacking` 578,
late-focus) runs on every OS in CI and did run here.

```
$ EZIL_LOCAL_PORT_OFFSET=10000 bun run --cwd local doctor
```
Exit **0** — `12 pass, 2 warn, 0 fail` / *"Nothing blocks a desktop from starting
on this machine."* The two warnings are honest and unchanged: neko advertises its
compiled-in `stun.l.google.com` and the env spelling does not override it; the
mux is published on loopback only, so a LAN browser gets HTTP but never media.

🔴 **Third line of that output is the finding**:
```
PASS  desktop image  ezil-os-worker-sandbox:ff199202
      (fallback: images_env_bad_tag: '<to be pinned by CI>' is not [A-Za-z0-9_][A-Za-z0-9._-]{0,127})
      present as sha256:14ae1a93998f…
```
`deploy/images.env` still carries `EZIL_DESKTOP_TAG=<to be pinned by CI>`. Local
mode starts only because the doctor falls back to a locally-built tag and says so.
On a machine that has never built the image, this is the pin that would decide
what gets pulled — and it is a placeholder. `T7` publishes the real tag as a CI
**artifact** (`published-images.env`) and nothing writes it back to the file.

### 3.7 `main`'s CI, live — red at the first base, green at the tip

```
$ gh run list --workflow ci.yml --branch main -L 3
33876458190  3c76d43  completed  success      ← the tip
33875344505  d9d70f4  completed  success
33874673503  e1bd1c0  completed  failure
```

```
$ gh run view 33876458190 --json jobs        # 15 jobs, sha 3c76d43
success  container (real image)
success  local (typecheck + unit + smoke)
success  tools (typecheck + unit)
success  worker / app / sdk + mcp / shell  ×  ubuntu-latest, windows-latest, macos-latest   (12)
```
**Fifteen for fifteen** — the first fully green run on `main` in this round, and
the two jobs `T8` wired are in it. Their real counts, read out of the job logs
rather than the badge:

```
$ gh api repos/EZiLHQ/ezil-os/actions/jobs/101034493104/logs   # container (real image)
 32 pass / 0 fail — Ran 32 tests across 3 files. [135.41s]

$ gh api repos/EZiLHQ/ezil-os/actions/jobs/101034493205/logs   # local (… + smoke)
 12 pass, 2 warn, 0 fail                      ← the doctor
 307 pass / 0 fail — Ran 307 tests across 14 files. [35.44s]
```
Those are **the same numbers this session measured on this box** (§3.2, §3.9):
32/0 for the container suites, 307/0 and 12-pass-2-warn for local. Two
independent environments, the same result — which is what makes it evidence and
not a local accident.

The worker unit legs on that run, per OS, also read out of the logs:

| leg | pass | skip | fail |
|---|---|---|---|
| `worker … (ubuntu-latest)` | 1025 | 43 | 0 |
| `worker … (macos-latest)` | 1003 | 65 | 0 |
| `worker … (windows-latest)` | 995 | 73 | 0 |

Same 1068 tests everywhere — which is `M4`'s achievement (before it, 205 of them
could not even load on macOS) — and the skip count is the platform difference,
declared per suite. Nothing in the job's own output names those skips, because
that leg does not go through `tools/test.sh`.

**At the first base `4b05869` the same workflow was red**, and the previous
edition of this file led with that:
```
$ gh run view 33872022280 --json jobs      # sha 4b05869
failure  container (real image)             ← 23 pass / 8 fail, Ran 31 tests across 3 files [52.47s]
success  the other 14
```
The eight failures were `M1`'s, they are fixed, and `main` went green two pushes
later. Recorded because a confidence map that only ever shows the good state is
not a measurement of anything.

**Row `M1` re-measured directly, before it reached `main`'s CI green.**

`M1` merged as `f15787a` at 12:41Z, after this worktree's base. Re-measured in a
second, throwaway worktree at `e1bd1c0` (created and removed with
`tools/worktree.sh`):

```
$ EZIL_VALIDATE_IMAGE=ezil-os-worker-sandbox:ff199202 ./tools/test.sh worker container.test
exit 0 — 32 pass / 0 fail / 0 skip, 32 tests across 3 files [146.50s]

$ EZIL_VALIDATE_IMAGE=absent:x EZIL_NEKO_IMAGE=absent:x ./tools/test.sh worker container.test
exit 1 — 0 pass / 32 skip / 0 fail; by suite:
        15  src/browser-sidecar.container.test.ts   [CONTAINER — green-by-absence]
         9  scripts/mobile-keyboard.container.test.ts   [CONTAINER — green-by-absence]
         8  src/neko-browser-window.container.test.ts   [CONTAINER — green-by-absence]
```
Both halves matter. With the image, the eight failures are gone and **nothing is
skipped** — the suite was fixed, not silenced. Without it, `mobile-keyboard` now
records **9 honest skips where it used to record 8 vacuous passes**, so the
vacuous-pass gate has nothing left to catch there and the skip gate names them.
That is `M1`'s whole claim, measured by someone who did not write it.

### 3.8 CI and governance, live on GitHub

```
$ gh api repos/EZiLHQ/ezil-os/rulesets                  → one ruleset, id 22265548, enforcement "active"
$ gh api repos/EZiLHQ/ezil-os/rulesets/22265548
```
Target `~DEFAULT_BRANCH`. Rules: `deletion`, `non_fast_forward`,
`required_linear_history`, `pull_request` (0 approvals,
`allowed_merge_methods: ["squash"]`, dismiss-stale-on-push,
`require_extra_approval_for_unattributed_changes: true`), and
`required_status_checks` with `strict: false` and **15** contexts: the twelve
matrix legs (`worker` / `app` / `sdk + mcp` / `shell` × ubuntu-, windows-,
macos-latest), `tools (typecheck + unit)`, `DCO`,
`CodeQL (javascript-typescript)`. Bypass: `RepositoryRole` id 5 in
`pull_request` mode only. Re-read at the tip: **still exactly these fifteen.**

`container (real image)` and `local (typecheck + unit + smoke)` are **not**
among them, and on today's evidence that is the right call rather than an
oversight: both jobs log in to GHCR with `secrets.GITHUB_TOKEN`
(`.github/workflows/ci.yml:498` and `:581`) to pull a package that
`docker manifest inspect` proves is **private**. A pull request from a fork is
not expected to be able to authenticate to it (inferred, not measured — see §0.4
item 2), so making those contexts required would refuse every outside
contribution for a reason unrelated to the contribution — in a repository
whose whole `GOVERNANCE.md` premise is outside contributors. The day the packages
go public, both should be added; that is the same founder step as the anonymous
pull below.

```
$ gh pr list --state open        # 12:44Z
#20  auto-merge: SQUASH  BLOCKED  sup/log-3    docs: A2, M1, T6 landings; …
#18  auto-merge: SQUASH  BLOCKED  task/M1      test(worker): mobile-keyboard container suite …
#5   auto-merge: no      UNKNOWN  dependabot/…/patch-and-minor-…
```
`#18` and `#20` have since landed as `f15787a` / `995a61b`. The `BLOCKED` state
on both is itself the evidence that the ruleset bites: neither could merge until
its fifteen contexts reported.

```
$ gh api repos/EZiLHQ/ezil-os/codeowners/errors        → {"errors":[]}
$ gh api repos/EZiLHQ/ezil-os --jq '{has_discussions,allow_auto_merge,delete_branch_on_merge,visibility}'
  {"has_discussions":true,"allow_auto_merge":true,"delete_branch_on_merge":true,"visibility":"public"}
$ gh api repos/EZiLHQ/ezil-os/labels --paginate --jq '.[].name'
  app bug ci docs documentation duplicate e2e enhancement good-first-issue help-wanted
  invalid local mcp question sdk shell tools wontfix worker
```
All ten `.github/labeler.yml` keys (`app worker shell sdk mcp e2e docs ci local
tools`) exist as real labels. `allow_merge_commit` is still `true` at the
repository level; the ruleset's `allowed_merge_methods: ["squash"]` is what
actually constrains `main`.

**The DCO proof, read back from the API rather than from the log** (PR #10 is
closed and its branch deleted, so the check runs are addressed by commit):
```
$ gh api repos/EZiLHQ/ezil-os/commits/6ebf612/check-runs   # the UNSIGNED commit
  DCO  failure  2026-09-04T08:16:07Z      label success; app, sdk+mcp success; the rest cancelled
$ gh api repos/EZiLHQ/ezil-os/commits/e246de5/check-runs   # the same commit, amended with -s
  DCO  success  2026-09-04T08:17:06Z      all eight contexts success
```
Both directions on real GitHub check runs, on the same tree — the negative and
its positive control.

```
$ gh run list --workflow image.yml -L 5
33872022290  4b05869  push  success   2026-09-04T12:17:23Z
33865834089  84a965c  push  success   2026-09-04T10:59:49Z
33858675382  06fc4eb  push  success   2026-09-04T09:30:22Z
```
**Three** successful runs, not the two the round log records — a third fired on
`T8`/`M3`'s merge. `release.yml`, `deploy.yml` and `stale.yml` have **no runs at
all** (`gh run list --workflow <f> -L 1` → `(no runs)`): nothing tag-shaped has
ever happened in this repository.

```
$ DOCKER_CONFIG=$(mktemp -d) docker manifest inspect ghcr.io/ezilhq/ezil-os-desktop:latest
Get "https://ghcr.io/v2/ezilhq/ezil-os-desktop/manifests/latest": unauthorized     (exit 1)
$ DOCKER_CONFIG=$(mktemp -d) docker manifest inspect ghcr.io/ezilhq/ezil-neko-vscode:d74052bb-049931d7-ezil-brand8
… unauthorized
$ DOCKER_CONFIG=$(mktemp -d) docker manifest inspect ghcr.io/m1k1o/neko/base:latest     # positive control
{ "schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", … }   (exit 0)
```
The empty `DOCKER_CONFIG` makes "anonymous" true rather than assumed — a stale
credential in `~/.docker/config.json` would otherwise make this test meaningless
in either direction. The public upstream image answers; **both EZiL packages
refuse**. The images exist and are signed (`image.yml` ran three times) and *no
member of the public can pull them*. Making the packages public is a founder
step, and until it happens `gh attestation verify` cannot be run by an outsider
either.

### 3.9 Local mode for real: the package suite, the launcher, the residency oracle

```
$ PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules EZIL_LOCAL_PORT_OFFSET=10000 ./tools/test.sh local
```
Exit **0** — `307 pass / 0 fail, 307 tests across 14 files [35.46s]`, and the
container suites really booted (no skip was recorded, and `tools/test.sh` would
have refused the run if one had been):

```
tests/local-smoke.container.test.ts
[T5 measured] cold boot through POST /api/shell/desktop: 6.3s (offset 10000, image ezil-os-worker-sandbox:ff199202)
[T5 measured] time to non-uniform pixels after the window opened: 2546ms
[T5 measured] samples=16000 min=11.3 max=254.3 mean=36.4 stdDev=58.8 buckets=29/32 — non-uniform
[T5 measured] the shell REVEALED the desktop: [ezil-os:desktop] full-bleed (the display was observed streaming)
[T5 measured] input oracle (a) /api/room/control: has_host false -> true, host_id EZiL-eXYs3
[T5 measured] input oracle (b) xdotool: pointer 960,960 -> 383,268 (expected 384,270 …)
[T5 measured] input oracle (c) /tmp/neko.log: "session host changed"
src/host/docker-host.container.test.ts
[T2 measured] cold boot (docker run -> authenticated neko login): 5.6s
```
Those `[T5 measured]` / `[T2 measured]` lines are this session's own numbers —
the suites print with that prefix; they are not quotations from `T5`'s report.
`stdDev 58.8` against `MIN_STD_DEV = 8` is the seven-fold margin the oracle's
comment claims, re-observed.

**The launcher, run for real.**
```
$ EZIL_LAUNCHER_IMAGE=ezil-os-worker-sandbox:ff199202 EZIL_LOCAL_PORT_OFFSET=10000 \
  ./deploy/launcher/ezil-os.sh --no-browser        # backgrounded
[ezil-os] EZiL OS is up: http://127.0.0.1:7080/os
$ curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:7080/os      → 200
$ kill -INT <launcher>
[ezil-os] Stopping the local host...               # process exited; ss: 127.0.0.1:7080 released
$ docker ps -a --format '{{.Names}}' | grep '^ezil-os-'   → (none)
$ ss -lun | grep 62100                                    → (none)
```
Note the port arithmetic, because the brief's two port numbers come from
different maps: `EZIL_LOCAL_PORT_OFFSET` moves the container's **published**
ports (`WEBRTC_MUX_PORT = 52100` → `62100`) and does **not** move the host's own
HTTP port (`EZIL_LOCAL_PORT`, default `7080`), so `127.0.0.1:7080/os` is right
and `62100` is right. The launcher's own cleanup is careful in a way worth
recording: it diffs `docker ps -aq --filter name=^ezil-os-` from before its own
start, so it destroys only containers **it** created — on this machine, where
three sibling worktrees are live, that is the difference between a clean exit and
eating another agent's work.

**The residency oracle, measured three ways.**

| what | container after | verdict |
|---|---|---|
| launcher SIGINT'd after `/os` answered | none named `ezil-os-*`; `7080` released; no UDP 62100 | clean |
| `bun test src/neko-browser-window.container.test.ts` run to completion (8 pass / 0 fail) | its `ezil-w9-validate-1052319-…` gone | clean — `afterAll` `docker rm -f` fires |
| the **same** run SIGTERM'd mid-flight | `ezil-w9-validate-1062672-ednauc  Up` — still running | 🔴 **orphan** |

🔴 **Finding, measured not inferred.** This pass's own first attempt at the
container suites was killed by a two-minute command timeout, and left
`ezil-w9-validate-952616-srjpt3` **resident for eight minutes holding 456.2 MiB**
(`docker stats --no-stream`) after its owning process was gone. The hypothesis
was then confirmed deliberately: start the suite, wait for the container, send
`SIGTERM`, and the container survives. `worker/src/neko-browser-window.container.test.ts:191`
cleans up in `afterAll` and has **no signal trap**, so any cancellation —
Ctrl-C, a CI job cancellation, a harness timeout — orphans a container built from
a 4.57 GB image. On a GitHub runner the VM is discarded so it costs nothing; on a
contributor's machine it is invisible and permanent. Two of `main`'s CI runs today
(`33874099090`, `33874063339`) were in fact `cancelled` mid-flight. Both orphans
this pass created were removed before it finished
(`docker ps -a | grep ezil-os` → nothing).

**Cloud residency: unchanged, and deliberately not re-measured.** No deploy
happened this round — `deploy.yml` has never run, there is no tag, `os.ezil.work`
does not exist — so the cost/residency picture for the hosted product is exactly
what `docs/RUNBOOK.md` already records, and this pass adds nothing to it. Saying
anything else here would be invention.

### 3.10 The remaining row-level checks

```
$ git check-ignore -v .claude/agents/verifier.md     → exit 1 (prints nothing: NOT ignored) ✔
$ git check-ignore -v .claude/worktrees/x            → .gitignore:52 (ignored) ✔
$ git ls-files .claude/agents/                       → 6 files (_MANDATORY + 5 roles) ✔
```

```
$ bun test worker/src/browser-sidecar-contract.test.ts   (inside this worktree)
10 pass / 0 fail / 61 expect() calls, 0 skip
```
Row `M2`'s claim, verified where it actually failed: **inside a worktree**. Before
`M2` this file skipped all ten because it resolved the contract path to the
worktree root.

**Row `M3`, mutation-proved by faking the platform** — the only way to exercise an
off-Linux branch from Linux. A `--preload` that does
`Object.defineProperty(process, 'platform', { value: 'darwin' })`:

```
control (real linux)  bun test worker/src/neko-teardown-orphans.test.ts   → 5 pass / 0 fail / 41 expect() [46.11s]
mutant  (platform=darwin)                                                 → 0 pass / 5 skip / 0 fail [40.00ms]
    "SKIPPING the teardown-orphans suite: executes scripts/start-neko.sh's teardown for real,
     reading /proc/<pid>/stat … neither exists on darwin; not meaningful there.
     Nothing about whether teardown kills the applications … has been verified by this run"
```
Five **recorded skips**, not five early returns counted as passes — which is the
exact difference `tools/test.sh`'s vacuous-pass gate exists to police, and the
difference `M1` had to fix in the other file.

```
$ bun -e '<relative-link resolver over the four docs>'
GOVERNANCE.md: 22 relative links, 0 dead
ROADMAP.md: 23 relative links, 0 dead
docs/ORCHESTRATION.md: 16 relative links, 0 dead
docs/CONFIDENCE-MAP.md: 1 relative links, 0 dead
```

```
$ gh pr list --state all --author app/dependabot -L 20
12 dependabot PRs: 11 CLOSED, 1 OPEN (#5, the grouped patch-and-minor)
```
Row `D1`'s policy has a measurable outcome, not just a committed file: every
major-version bump (`actions/checkout` 4→7, `setup-node` 4→7, `typescript`
5.9→7.0, `zod` 3→4, `eslint` 9→10, `motion` 11→13, `sonner` 1→2,
`codeql-action` 3→4, `labeler` 5→7, `stale` 9→11, `@cloudflare/workers-types`)
is closed; the grouped patch/minor PR is the only one still open.

🔴 **One weakening that is still in force**, found while checking whether any
harness had been softened for green: `.gitattributes` pins `*.mjs` to `eol=lf`
but leaves `*.css`, `*.svg` and the non-`.mjs` shell JS under bare
`* text=auto`, so a Windows checkout gets CRLF for them — and `ci.yml:320`
therefore runs the **bundle-diff step** under `if: runner.os != 'Windows'`. The
gate that stops a stale committed `app/public/os/bundle.min.js` from shipping is
consequently never exercised on Windows. `T4` recorded this as a hand-off for
`.gitattributes`; nothing has taken it. Hand-off: `.gitattributes:19-26` and
`.github/workflows/ci.yml:320`.
