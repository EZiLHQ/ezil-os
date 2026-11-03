# OS ↔ Universe ↔ Works: opening an ordinary Builder-created project — v1 (proposed)

Status: **proposed** 2026-11-03 by e1cd418a (request `journey-32d-20261103-repo-open-resolver-v1`). Local only; nothing staged or deployed.
Vectors: `os-builder-project-open-v1.vectors.json` (the exact cases; this text explains them).

| Section | Owner | State |
|---|---|---|
| §1 Link on the Builder board | Universe slot4 | proposal |
| §2 Universe open: the builder branch | Universe slot4 | proposal |
| §3 Works clone-token fields | Works slot5 | ask (W-1..W-3) |
| §4 OS app accepts git-qa on staging | OS app (open-project; cb1d14e6 integrates) | patch proposal |
| §5 OS Worker accepts git-qa on os-staging | e1cd418a | implemented on `feat/repo-open-resolver-20261103` |
| §6 Per-tab restore and the reveal path | editor lead f179c8a4 (shell/app), e1cd418a (Worker walk), cb1d14e6 (AWS host op bake) | Worker walk implemented |
| §7 Renewable push grant (two pushes) | e1cd418a (Worker), OS app/shell owner (refresh loop), Universe (unchanged open), Works (W-3) | **gap**; design below |

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
- **Grant.** Universe calls Works `clone-token` for `works_repository_ref` and checks the answer exactly (vectors `universeOpen.grant`).
  - It never substitutes a ref. The OS opens a repository whose binding branch is missing upstream as an empty clone, so a guessed `refs/heads/main` would hide an existing repository's code without any error.
  - A Works answer without `defaultRef` or `scope`, or for another `cloneUrl`, is 502 `project_repo_upstream_unavailable`.

## 3. Works (asks)
- **W-1.** The `clone-token` answer adds `scope` and `defaultRef`. Works already knows both: `authority.scope`, and the default ref recorded at provisioning from Artifacts' `default_branch`.
- **W-2 (slot5 decides).** Accept the OS EZiL ID audience on `clone-token`, so Universe forwards the person's own verified token and Works binds the grant to that same issuer and subject. The alternative is a Universe service credential plus an asserted subject. Either way, the grant is refused for any other account.
- **W-3.** The grant stays route-scoped and at most 5 minutes, as today.

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

## 7. Renewable push grant (gap found 2026-11-03)
**Today.** The live open-project flow uses Universe's grant for the clone or fetch only.
- The token reaches git through one command's environment, and nothing is left on the computer. That is deliberate: no `.git/config` credential, no helper.
- So a `git push` from Code after the open has no credential, and the acceptance case "edit, then two pushes" cannot pass on this path.

**Proposed (reuse what already proves two pushes).** The u2 kernel's grant machinery (OS `84e4b686`) does this, with the test "class assessment … two pushes through the helper":
- a grant file at `/run/ezil/git/grants/<handle>__<name>.json` (root-only `0600`, outside `/workspace`, never checkpointed);
- the fixed wrapper `/run/ezil/bin/ezil-git-grant`, which serves it only for its own protocol, host and path, and only while it is more than 30 s from expiry;
- in the clone's `.git/config`, only `credential.helper` naming that fixed wrapper path, never a token;
- a `refresh` op that rewrites the `/run` files only;
- once a grant has lapsed, the helper refuses with the fixed hint "EZiL: Git access for `<handle>/<name>` expired. Reopen it from EZiL OS (Code renews it while open)."

For ordinary Builder projects (Basic auth on `git-qa`/`github.ezil.work`):

| Owner | Part |
|---|---|
| e1 (Worker `repo-open.ts`) | after a successful open, install the wrapper and grant and set the helper; add a `refresh` exec that installs a fresh grant and touches nothing else |
| OS app/shell owner | while a Code window shows the project, refresh every ≤ 4 min (the grant lives at most 5 min), and on reopen or remint |
| Universe | none: each refresh is an ordinary `open` call (rate limit 60/min) |
| Works | W-3 (route-scoped, ≤ 5 min, `write` for the owner) |

Hired projects on Cloudflare Artifacts are out of this section: git 2.34.1 cannot take a Bearer token from a credential helper.

**Two-push proof (local first).**
1. Open, edit, push #1.
2. Advance past the grant's expiry; the push is refused with the hint.
3. Refresh, push #2 succeeds.
4. A refresh for another repository or user is refused.
5. The grant never appears in argv, environ, `.git/config`, the folder or the output (strace, as the u2 kernel tests do).

Then the staging run with the founder's test identities, after release approval.
