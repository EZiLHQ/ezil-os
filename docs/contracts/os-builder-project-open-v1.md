# OS ↔ Universe ↔ Works: opening an ordinary Builder-created project — v1 (proposed)

Status: **proposed** 2026-11-03 by e1cd418a (request `journey-32d-20261103-repo-open-resolver-v1`). Local only; nothing staged or deployed.
**1.1.0-proposed** (2026-11-03, request `88e642df-project-grant-contract-closure-v1`, with universe-repo-open-v1 1.0.5): the Builder open's grant now comes from Works **os-grant with class `project`** (≤ 300 s issued, ≤ 330 s accepted), not clone-token. The open body adds `computerLabel`, and §3 W-2(a) is withdrawn.
Vectors: `os-builder-project-open-v1.vectors.json` (the exact cases; this text explains them).

| Section | Owner | State |
|---|---|---|
| §1 Link on the Builder board | Universe slot4 | proposal |
| §2 Universe open: the builder branch | Universe slot4 | proposal |
| §3 Works grant (1.1.0: os-grant class project; W-1 on clone-token unchanged) | Works slot5 | ask (W-1; W-2/W-3 = universe-repo-open-v1 1.0.5 §6.2 QA + §6.5) |
| §4 OS app accepts git-qa on staging | OS app (open-project; cb1d14e6 integrates) | patch proposal |
| §5 OS Worker accepts git-qa on os-staging | e1cd418a | implemented on `feat/repo-open-resolver-20261103` |
| §6 Per-tab restore and the reveal path | editor lead f179c8a4 (shell/app), e1cd418a (Worker walk), cb1d14e6 (AWS host op bake) | Worker walk implemented |
| §7 Renewable push grant (two pushes) | e1cd418a (Worker), OS app/shell owner (refresh loop), Universe (unchanged open), Works (W-3) | Worker **implemented** (28339390); app/shell refresh loop pending |
| §8 AWS ordinary project open | cb1d14e6 (host/AMI), e1cd418a (contract + Worker relay), app owner | **blocked**: no host op on AMI 1.0.30 |

Why: Universe REG-1 provisions a Builder-created project's repository in Works (staging host `git-qa.ezil.work`), but the project cannot be opened in OS. `POST /internal/project-repositories/open` resolves only hired projects, so a builder project gets 403. The board's `launchUrl` is always null, and OS refused the staging Git host on the personal route.

## 1. Link (Universe)
`<app origin>/app/code?project=<builder_projects.public_id>&repo=<builder_projects.repository_id>`. The repository id is Works' repository UUID, so the OS folder `projects/<repositoryId>` follows the repository's identity, and a re-provisioned repository never collides with an old folder. The link is shown to the owner only, and only when all of these hold (vectors `link.rule`):
- the repository is `ready`;
- both ids are lowercase canonical UUIDs;
- `clone_url` is exactly the paired host plus `route_name`;
- Universe's Works client gets `scope` and `defaultRef` from Works (§3).

The URL carries the two UUIDs only. Universe writes a project's link once: a replay that returns another ref marks the project failed, it does not relink.

## 2. Universe open: the builder branch
The route, the body `{userIdToken, projectId, repositoryId}`, identity verification and the response shape are unchanged.
- **Resolution.** The hired lookup runs first, as today. Only when no hired project has that `public_id`, the builder lookup runs: `public_id = projectId AND repository_id = repositoryId`. A `projectId` that is both a hired and a builder `public_id` is refused, never guessed.
- **Authorization.**
  - Owner only: role `builder` for `builder_projects.user_id`.
  - Every other case is 403 `project_repo_not_authorized`, the same answer as a project that does not exist, so the answer reveals nothing about existence. That covers a wrong user, an unknown id, a mismatched repository, a project not ready, and an inactive account.
  - The rate limit and the append-only open audit apply as for hired projects.
- **Grant (1.1.0).** Universe calls Works `POST /v1/builder/selfserve-repositories/<repository_id>/os-grant` on api-staging, with the person's own OS-audience token it already verified as bearer (never logged or kept) and body `{computerLabel, class:'project'}`. It checks the answer exactly (vectors `universeOpen.grant`, universe-repo-open-v1 `works.osGrantProjectResponse`): `class` is `'project'` and `expiresAt` is at most `min(now + 300 s, token exp) + 30 s`. `binding.ref` is `'refs/heads/' + defaultBranch`. The OS app sends `computerLabel` (COMPUTER_LABEL of the computer being opened, computed on the server) in the open body; the hired branch ignores it. A builder open without a valid label is the uniform 403 `project_repo_not_authorized`, before Works is called (12th `universeOpen` case).
  - **The label is not authorization.** It only partitions the Works session. Account authority is the bearer's sub (Works ownership); computer authority is the OS Worker's v2 claims plus the `.bind` check at install.
  - **Revocation limit (1.1.0).** `os-sessions/revoke` needs the OS-audience bearer at api-staging, and nothing on this path calls it: the OS never calls api-staging, and Universe has no revoke relay. So after sign-out or an account switch, a project grant already installed stays usable until its own expiry, at most 300 s, and only on the owner's own computer. The next renewal fails, because the OS session and its retained token are gone. Closing it would need a Universe revoke relay (owner decision); it is not in 1.1.0.
  - It never substitutes a ref. The OS opens a repository whose binding branch is missing upstream as an empty clone, so a guessed `refs/heads/main` would hide an existing repository's code without any error.
  - A Works answer without `defaultRef` or `scope`, or for another `cloneUrl`, is 502 `project_repo_upstream_unavailable`.

## 3. Works (asks)
- **W-1.** The `clone-token` answer adds `scope` and `defaultRef`. Works already knows both: `authority.scope`, and the default ref recorded at provisioning from Artifacts' `default_branch`. (1.1.0: still read by Universe's link rule; no longer the open's grant.)
- **W-2 (1.1.0, decided).** ~~Accept the OS EZiL ID audience on `clone-token`~~ is WITHDRAWN: universe-repo-open-v1 §6.4 step 2 refuses an OS-client token on every non-os route, and allowing it would make that token usable for the 60-minute web clone. Instead, the existing os-grant route on api-staging (universe-repo-open-v1 1.0.5: the §6.2 QA row, whose osClient is the effective OS pin) issues class `project` grants, bound to the token's account (ownership), the computerLabel (session) and the repository (route path).
- **W-3 (1.1.0).** The open grant is route-scoped and issued for at most 300 s (`min(now + 300 s, bearer exp)`), accepted up to 330 s. clone-token's web-clone grant stays 60 minutes and is never an open grant.

## 4. OS app (patch proposal)
`app/src/server/works/project-repo.ts` also accepts `https://git-qa.ezil.work/<ns>/<name>.git`, only under the app's existing staging gate (the billing funding origin is exactly `https://ai-staging.ezil.work`, as `aiEnrollmentConfigured`). Nothing else changes. AWS computers are still refused with `repo_open_unsupported_provider`; that is an external blocker for founder step 5 if the test computer is on AWS.

## 5. OS Worker (implemented)
`handleRepoOpen` passes `repoOpenRemotesFor(env)`. It accepts `git-qa.ezil.work` only when the existing `EZIL_AI_GATEWAY_URL` is exactly `https://ai-staging.ezil.work` (optionally with a bare `/`). This is the u2 contract's route-gate coupling; no env var is added, and it fails closed. Path, ref, token and key rules are unchanged. Basic auth goes through the one-shot credential helper, as for `github.ezil.work`. A re-open of the same origin fetches in place; any other origin is `repo_open_folder_conflict`. The live os-staging value of `EZIL_AI_GATEWAY_URL` has not been read (no Cloudflare access in this lane): **unverified**.

## 6. Per-tab restore
- **Own files.**
  - A `{v:1, path}` record per tab lives in sessionStorage and travels only in the mint's POST body, never in a URL.
  - The server strips its root and refuses `.ezil/**` and `projects/<uuid>/**`.
  - The computer walks the rest with no symlink followed: in the container on Cloudflare, and on the host on AWS (the edge's `folder` op). On a host without that op the answer is 404, which the Worker reads as `unverified`: measured against the 7b95bcd9 edge.
  - The answer is a code, never a path.
- **Project tabs.**
  - The tab keeps only the two UUIDs.
  - Every restore re-runs the full open, with fresh authorization and a fresh grant.
  - `path` stays reveal-only.
- **Wrong user.** Walks and opens run only on the signed-in person's own computer.

### 6a. Relative path (reveal only)
`path` in `/app/code?project=&repo=&path=` is a hint, never an editor root and never authority.
- **Grammar.** The shared code-folder v1 grammar (`plainFolderPath`), relative, below `<root>/projects/<repositoryId>/repository`.
- **Server walk.** The server walks it there with the same no-follow walk (`cloudflareCodeFolderResolver(exec, '<root>/projects/<repositoryId>/repository')(rel)`), and reveals it only on `restored`.
- **Refusals.** A symlink at any component, `..`, an absolute path or a missing folder reveals nothing; the project still opens at its folder.
- **Owners.** Editor f179c8a4 (shell `code.js`) and the app route own the reveal. The walk is e1's and is already reusable with that root.

## 7. Renewable push grant (implemented in the Worker, 28339390)
**Before.** The open-project flow used Universe's grant for the clone or fetch only. Nothing was left on the computer, so a `git push` from Code had no credential.

**Now** (`worker/src/repo-grant.ts`). After an EZiL Git open (Basic auth), and on every refresh, the Worker runs one op in the computer. It installs the u2 kernel's fixed helper (`84e4b686` `ezil-git-grant.mjs`, sha256 `5de6b39a…`, pinned) and one grant per repository:
- **The grant.** `/run/ezil/git/grants/<handle>__<name>.json`, uid 0, mode 0600, with the helper's eight keys. It is outside `/workspace`, so it is never checkpointed.
- **The owner.** `<handle>__<name>.bind` reads `v1 <subject> <repositoryId> <url>`. Another subject, repository or URL is refused with `repo_grant_conflict`.
- **The repository's config.** It gains `credential.https://<host>.helper` set to `''` plus the fixed wrapper `/run/ezil/bin/ezil-git-grant`, and `credential.https://<host>.usehttppath=true`: a path, never a token.
- **Finding the repository.** It is located as the open placed it, through real directories only, with the binding's URL as its one origin. Otherwise the answer is `repo_grant_not_open`.
- **The token.** It arrives on fd 3, as an open's does. Every git in the person's repository runs before it is read and without fd 3; none runs after.
- **Never touched.** The working tree, the index and HEAD.
- **Out of scope.** Cloudflare Artifacts (Bearer), because git 2.34.1 cannot take a Bearer token from a credential helper.

**Refresh endpoint (for the app; 1.1.0: the app renews from the returned `expiresAt` while Code shows the project, and on reopen or remint, per universe-repo-open-v1 `works.projectGrantRenewal`: under 60 s left is not installed; at most 120 s left means reauthenticate once before the next ask; otherwise renew 120 s before expiry; one renewal in flight).** `POST {worker}/sandbox/<sandboxName>/repo-grant`, v2-signed like repo-open, Cloudflare computers only. A stopped computer is refused (`runtime_not_running`), never started.
- **Request** (exactly these keys; no ref or branch, so a refresh never chooses one): `{ "repositoryId": "<lowercase uuid>", "canonicalURL": "https://github.ezil.work/<h>/<n>.git" | (os-staging) "https://git-qa.ezil.work/<h>/<n>.git", "git": { "token": "egg_<64 hex>", "expiresAt": "<ISO, 60 s..330 s ahead>", "scope": "read"|"write", "username"?: "ezil" } }`. The `git` object is Universe's `open` answer's `git` as it is.
- **Answers:**

| Status | Body |
|---|---|
| 200 | `{ "ok": true, "expiresAt": "<normalised ISO>" }` |
| 400 | `repo_open_invalid_request` or `repo_grant_unsupported_remote` |
| 409 | `repo_open_token_expired`, `repo_grant_not_open`, `repo_grant_conflict`, `repo_open_busy` or `runtime_not_running` |
| 409 | `repo_open_unsupported_provider` (AWS) |
| 500 | `repo_open_git_missing` |
| 502 | `repo_grant_failed` |
| 401 | the v2 errors |

- **Open.** `repo-open` keeps `git.scope` when sent. The app should send Universe's `git.scope` too, so the open installs push access itself. Its answer is unchanged either way.

**Two-push proof (local, real git, the real helper; `worker/src/repo-grant.git.test.ts`, 7/7 on host git 2.43 and in the git 2.34.1 image).**
1. Edit, then push #1.
2. A grant with less than the helper's 30 s left is refused with the fixed hint, and no credential reaches the server.
3. The server rotates its grant; a refresh installs the new one, with uncommitted work, HEAD and the index untouched.
4. Push #2 succeeds.

The same suite covers:
- refusals for a wrong subject, repository, host and path;
- symlinks at the projects, folder, repository, `.git` and `.git/config` levels, plus a linked `/run` grants directory;
- four concurrent refreshes;
- a retried refresh and a retried open;
- the grant appearing in no config, folder file, output or command.

## 8. AWS ordinary project open (blocked; exact missing pieces)
**Today.** Every layer refuses an AWS computer:
- the app (`code-preview-url/route.ts` `isAws` → `repo_open_unsupported_provider`);
- the Worker (`handleRepoOpen` and `handleRepoGrant`: `v2.provider !== 'cloudflare'` → 409);
- AMI 1.0.30's host agent (= 7b95bcd9), which has no op that can write into the guest.

So no Worker-only change can open a repository on AWS. A Docker run proves nothing about AWS either.

**Minimal path (each part separately reviewed and released):**

| Owner | Part |
|---|---|
| e1 | u2 contract 1.0.4 adds a class `project`: git host = the deployment's paired Works host (github.ezil.work, or git-qa.ezil.work on staging); layout `projects/<repositoryId>/repository` under a fresh wrapper, as for class assessment; `path` reveal-only. Kernel and host class tables updated (both AMI inputs), with a slot1 review. |
| cb1 | Bake the A2h host op (`POST /__ezil/control/repo-open/<sha256(body)>` and `repo-open-status/<jobId>`, u2 `84e4b686` `repo_open.py`) and kernel `b7196b7d…` into an AMI after 1.0.30. |
| e1 | Port the Worker relay (`84e4b686` `aws-repo-open.ts`) onto this branch, and route AWS v2 claims of the open-project and repo-grant routes to it (the kernel's own `refresh` op installs the same helper and grant in the guest). |
| app owner | Lift `isAws` in `code-preview-url/route.ts` once the relay is live. |

