# universe-repo-open 1.0.4, class `project`: integration handoff

Journey `journey-9aae-20261103-repo-aws-local-v1` (founder request 9aae). This is local work only: no AWS or host call, no image bake, deploy, remote push, shared DB, or paid run. AWS class `project` stays `workspace_unsupported` until every dependency below has landed.

## What this branch contains (owner e1cd418a)

| Piece | File | Pin |
|---|---|---|
| Contract 1.0.4, now 1.0.5 (project grant, branch `feat/u2-project-grant-20261103`) | `docs/contracts/universe-repo-open-v1.{md,vectors.json,check.mjs}`, README | 1.0.5: vectors `c48c3f18…`, gateway extract `34e6d5b2…` (1.0.4 was `4ede80c6…` / `4920f98d…`) |
| Kernel, class `project` | `worker/src/repo-open-assets/ezil-repo-open.mjs` and the byte-identical host copy `infra/host-agent/lib/ezil_host/repo_open_assets/ezil-repo-open.mjs` | kernel `1362a691…` (pinned in `repo_open.py` REPO_OPEN_ASSETS, the only line changed in that file) |
| Worker relay gate | `worker/src/aws-repo-open.ts`, `worker/src/repo-open-u2.ts` | both inert; nothing imports them |
| Tests | `ezil-repo-open-test.mjs` (T-2PUSH-K, reopen including a switched branch, crossovers, request rules, grant cleanup), `aws-repo-open.test.ts`, `repo-open-u2.test.ts` | |

## H1. Host-op patch for cb1d14e6 (not applied here)

- **File:** `docs/contracts/handoffs/universe-repo-open-1.0.4-host-op.patch`. Apply it on this branch's head with `git apply`.
- **Hard merge constraint:** this branch must merge together with H1. Without H1, cb1's `test_repo_open_op` is red here by design: its version pin reads 1.0.3, and `parse_relay` refuses the vectors' valid class `project` body. The only line this branch changes in `repo_open.py` is the kernel sha256 in REPO_OPEN_ASSETS, because the request asked to keep both kernel copies and their hash pins consistent.
- **Production change (`repo_open.py`):**
  - `REPO_OPEN_CLASSES` gains `project`, with `REPO_OPEN_PROJECT_GIT_HOSTS = (github.ezil.work, git-qa.ezil.work)`. The host cannot know the deployment, so it accepts either host. The route binding belongs to the Worker.
  - The project grant window is at most 330 s, and `path` must be null.
  - `open_answer` checks the 7-key shape at W, with `pathNotFound` false. A fresh placement must name exactly `defaultBranch`; an `existing` reopen may name any valid current branch.
  - The job folder is W; the commit timeout stays `workspace_busy`, because the reopen is idempotent.
- **Test changes (`test_repo_open_op.py`):**
  - The version pin moves to 1.0.5 (it read 1.0.4 before the 1.0.5 project-grant change; the patch's only other lines are unchanged).
  - The stale "single-host table = all classes" assertion is corrected.
  - New tests cover the class rules, `ProjectAnswer` and `ProjectJob`.
  - A real-kernel test checks that a bound and marked W reopens `existing` with no network, that an unmarked or symlink-marked W is `folder_conflict` and left untouched, and that a fresh open offline is `network_unavailable`.
- **Host suite evidence:**
  - With H1 applied: 111/111 passed (15:46:16–15:47:26Z).
  - Earlier runs at higher host load also missed TimingChain bounds. Those same misses occur at the pin-only base, and TimingChain passes 7/7 when rerun alone. The `RepoOpenEdge` start test is also flaky at the pin-only base.

## H2. Worker activation sketch for the `index.ts` owner (not applied here)

`handleRepoOpen` (open-project) refuses every provider except `cloudflare`. Activation dispatches an AWS ordinary project open to the relay, and only for a parsed open-project request whose host this deployment serves:

```ts
if (v2.provider === 'aws-ec2') {
  const target = await awsControlTarget(env, request, sandboxName, 'repo_open');
  if (!target) return json({ ok: false, error: 'repo_open_unsupported_provider' }, 409);
  const projectGitHost = /* repo-open.ts repoOpenRemotesFor(env) host: git-qa on os-staging, github.ezil.work in production */;
  const [, handle, name] = /^https:\/\/[^/]+\/([^/]+)\/([^/]+)\.git$/.exec(parsed.request.canonicalURL) ?? [];
  const input: RepoOpenInput = { v: 1, op: 'open', repositoryId: parsed.request.repositoryId, handle, name,
    gitHost: projectGitHost, defaultBranch: parsed.request.branch, path: null,
    grant: { username: 'ezil', token: parsed.request.token, expiresAt: parsed.request.expiresAt, scope },
    class: 'project', receivedAt: Date.now() };
  const answer = await handleAwsRepoOpen(input, sandboxName, target, {
    fetch, now: Date.now, sleep: (ms) => scheduler.wait(ms),
    projectCapable: (record) => /* D1: the host advertises repo-open class project for THIS record */,
    computerFree: (record) => /* D2: the assessment policy says this computer is not attempt-bound */,
  }, 'project', { projectGitHost });
  // map answer → open-project RepoOpenAnswer (below)
}
```

- **Answer mapping (decision for the app owner).**
  - The u2 project answer is `{ok, state, folder: W, openFolder: W, pathNotFound: false, branch, empty}`.
  - The open-project answer is `{ok, folder: W, head?, status}`.
  - Proposed status mapping: `cloned` → `cloned`, `initialized_empty` → `created`, `existing` → `fetched`. Note that `existing` does not fetch.
  - `head` stays absent; it is optional in open-project.
- **Refusals.** u2 codes map to the open-project codes the app already shows, or the app learns the u2 codes. Either way, `workspace_unsupported` must stay a non-retryable "not available on this computer".
- **Grant.** The grant passes the relay only when it lasts at most 330 s, so the Works 60-minute web-clone grant (0da777dc, `cli-auth.issueGrant(webClone: true)`) is refused as `invalid_request` (D3).

## Versioned dependencies (each must land before the `isAws` lift)

| ID | Owner | Needed | Status |
|---|---|---|---|
| D1 | cb1d14e6 | H1 applied, and an AMI after 1.0.30 whose host agent carries H1 and kernel `1362a691…`. The host must also advertise a capability for `projectCapable`; no such field exists on `AwsTunnelRecord` today, so the gate answers false and the relay sends nothing. | open |
| D2 | f6a67dd0 | The `computerFree` source: the assessment policy DO answers "not bound to an assessment attempt" for this computer. Absent means unsupported. | open |
| D3 | Works (slot5) | W2/W3, now exact (1.0.5 §6.2 QA row and §6.5 class `project`): os-grant on api-staging, body `{computerLabel, class:'project'}`, `expiresAt = min(now + 300 s, bearer exp)`, answer + `class:'project'`; the same session, ownership and scope as the legacy grant. W1 (`scope`, `defaultRef` on clone-token) is 2469e704, reviewed separately. | W2/W3 T1–T5 open with Works |
| D4 | cb1d14e6 (app) | Lift the open-project `isAws` refusal only after D1–D3 and H2, sending the class `project` body. | blocked on D1–D3 |
| D5 | Universe, Works, EZiL CLI | Re-seed the vectors copy (1.0.5, `c48c3f18…`) and the CLI gateway extract (`34e6d5b2…`) as a consumer step. The earlier `092d76d1…`/`085a783a…` here were stale. | open |

## Owner, attempt and subject fences (where each lives)

- **No subject field.** There is none in the class `project` body, the kernel request or the persisted job, so a caller cannot name a subject at all.
- **Owner fence:** `awsControlTarget` matches the v2 claims (computerId, sandboxId, generation, leaseEpoch) against the live tunnel record, and anything else is a Response. The relay answers `workspace_unsupported` for that before asking any gate (tested).
- **Assessment fence:** `computerFree` (D2), which fails closed.
- **Grant↔subject binding:** Works W2/W3 (D3) binds the OS-scoped grant to the Creator's `sub` and computer, and the route mints it for the signed-in owner only. EZiL ID alone is never checkout proof.

## Residuals

- **No adoption from open-project.** A W placed by the Cloudflare open-project flow carries no project marker, so if that workspace is restored onto an AWS computer, its class `project` reopen is `folder_conflict`, never adopted. Supporting that migration needs a separate decision.
- **Gates must be bounded.** `projectCapable` and `computerFree` should be bounded local reads. The relay awaits them before its first edge call and does not wrap them in a timeout.
- **Local evidence only.** The kernel was proven in the git 2.34.1 image and on the host with a local git server and proxy. Nothing here validates AWS: no AMI, host or live Works call was made.
