# OS source provenance and staging handoff

Operational patch: `fix/os-staging-cicd-provenance-20261105`, based exactly on
canonical S `7fcc76d4efdbf0c400039640cdee13974b727b4d`, per cb1's 17:10Z reply and
the user's explicit port instruction. Main-based PR267 remains a preserved draft
at `93ce62bf`; it is superseded for staging integration, not installed or connected.
Its unpublished continuation is retained locally as `1434e64a` on
`archive/os-cicd-main-continuation-01a1ac8e`.

## Findings verified 2026-11-05

The evidence does **not** establish accidental mixing of old code into a build.
It establishes separate source histories and deployment paths, plus a reproducible
hole in the AWS app builder's source labelling.

* Remote `main` is `15c1ea68b7e8d6a8d467149b9545f637128b5d6a`; live app source is
  `293ac34d116ce50473c8464663b8786ef39f46f1`. Their merge base is
  `93a5b5e0eb8c44b2fa819e409cf07ee373c04db8`. Unique ancestry counts are 10/1139;
  the **net tree diff** is 446 files, +37,361/-11,284. Commit counts are not
  duplicated changes. The app's final parents are the reviewed folder composition
  `ed973ca1` and Free receipt work `53e0af51` (owner's union receipt).
* Remote `preview` is `167974774d38c1b805c02181a0816da0e8a01ced`. Its last
  `preview.yml` run, [39509151648](https://github.com/EZiLHQ/ezil-os/actions/runs/39509151648),
  succeeded on October 20. Its `live-evidence-preview-39509151648-1` artifact
  (ID 12305398130, ZIP digest
  `sha256:8c31ae617fe95419429155410971575b11b3d7c2ca3ec5c060aa73857f039b93`)
  binds source/image source to that SHA, Worker `cfcb211c-e66f-418d-9103-004886444217`
  and Vercel deployment `dpl_8Nh2LTbKLXeNwwCpzr14v6xMYnNx`.
* `preview.yml` deploys its staging app to **`ezil-os-staging.vercel.app`** and
  Worker `ezil-os-worker-staging`. The actual app **`os-staging.ezil.work`** is
  the AWS/Compose path in `deploy/aws/os-staging`. No GitHub workflow currently
  connects a feature PR or source S to that AWS app installer. A green legacy
  Vercel check cannot establish AWS app deployment. In particular, main run
  [41229866095](https://github.com/EZiLHQ/ezil-os/actions/runs/41229866095) built
  images but **skipped both deploy jobs**; it is not a deployment receipt.
* The live branch lacks ten main commits, including main's manual-only production
  deployment safeguard and newer deployment-evidence lookup. Do not replace main
  with the live tree or merge a feature stack just to align branch names.
* Before this fix, `deploy.sh build TAG` accepted any syntactically valid
  `GIT_SHA` and passed its mutable checkout to Docker. An offline reproduction
  supplied a different SHA and uncommitted Dockerfile bytes; Docker was invoked
  and the script reported success. There was no source receipt binding the app
  and runtime archives. This is a proven tooling defect, **not proof that a
  historical release was contaminated**. No evidence found implicates Docker's
  content cache; disabling it would not fix false SHA labels.

## Staging surfaces observed at 16:40–16:49Z

These are separate components, not one interchangeable "build version".

| Surface | Evidence |
| --- | --- |
| AWS app | Public `/api/health` returns `293ac34d116ce50473c8464663b8786ef39f46f1`. Owner receipt records tag `293ac34d116c`, app archive SHA256 `3dd751323da6d26070b1715d4619e37363636b46bbc803dc55e8a438839d0fbc`, runtime archive `b14f519364b49d3ce17a2ea2d31b3f33fa3cd0deb9c93c3eded662d8f6bf3fd2`. These archive hashes are receipt evidence; this lane did not fetch or install the app image. |
| Served app shell | Independently fetched JS `f43671dff1883c737a2ec5f898d7be0ca6fcf9d813b5f6c5007ba45fd4b27286`, CSS `ac2888fb45a9f143141e3dfc42fb7438be379c3c71b1a02702565018dbc0d76c`. |
| Cloudflare Worker | API shows 100% version `53323001-25fa-417f-9212-0293297759d4` since 16:24:13Z, source `410dbe66e2222cfac149dba02b9d00ff1564731e`. Independently fetched `index.js`: 1,153,831 bytes, SHA256 `e0ee68d56420ada1ca3baa1daa3b47306c559b0dc9d97b0018b35f76439fbaab`, equal to owner's dry-run receipt. |
| Cloudflare desktop/editor | API: container application `a032aac9-7e86-44ac-9073-6b8a324acf94`, v123, registry tag `2031b2c1`, updated 10:59:50Z. Owner receipt binds reviewed editor source `15072bbd`, image config `8c38a433`, extension `f86391a4`. This lane did not open a computer; image internals and editor acceptance are owner/reviewer evidence. |
| AWS computers | Older AMI 1.0.30 users do not run the Cloudflare image. AMI 1.0.31 is artifact-only. Neither is upgraded by a Worker or app deploy. No AMI adoption, boot or user restart occurred here. |

Owner [task](https://app.notion.com/p/40b7021e76d7813c84eef550a6ebf642) records the
released `cb1-worker-410dbe66` lease at 16:28:23Z. Re-read current receipts and
leases before any future action. Source S `7fcc76d4efdbf0c400039640cdee13974b727b4d`
is [draft PR266](https://github.com/EZiLHQ/ezil-os/pull/266), base
`85270caa88d72eeb17a938d3110ec6fcfeb76ec2`, exclusively owned by cb1. This lane
does not recompose or review its components.

## Implemented safeguards

`deploy.sh build` requires the declared SHA to equal HEAD and refuses staged,
unstaged or untracked dirt. It exports the committed tree to a private temporary
context, then builds the app and runtime bundle from that same snapshot. Ignored
files, cached output in the checkout and subsequent checkout edits cannot enter
the context. No shared checkout is cleaned or reset.

`TAG.source.json` records the source SHA, tree, parents, source archive hash,
environment, component and the hashes of both output archives. Upload verifies
the receipt and publishes it before the existing checksum completion marker.
This is an integrity/traceability receipt, not a cryptographic attestation or a
claim of passing tests.

The opt-in **staging-only** command `install-verified TAG APPROVED_SHA
RECEIPT_SHA256` now downloads that receipt and verifies its approved hash,
source, environment, tag and both archive hashes **before Docker load**. It
reads the saved Docker image config without extracting it, verifies its config
digest, linux/amd64 platform, exact tag, OCI revision and baked `EZIL_GIT_SHA`,
then verifies the loaded image ID/metadata before replacing the app. After
Compose starts it compares the container's runtime SHA. A mismatch is **after app
replacement and after timers stop**, not a nonmutating refusal. It exits without
printing success, records the candidate tag/source/image ID/receipt hash and
observed previous image/source/ID (or `unavailable`), and leaves stopped timers
stopped. Prior metadata is not proof that rollback archives are available. The
release owner must inspect the SSM command/current container, select and verify
the reviewed app/runtime recovery pair or repair the candidate, verify health and
source, then restore the reviewed six-timer set. There is no automatic rollback,
legacy fallback, timer restart or claim of safe recovery.
The command pins the observed staging instance, Name, environment, VPC and bucket.
A malformed or missing receipt never falls back to legacy mode.

The existing staging `install TAG` path keeps S's two-argument host call and
original two-archive checksum format, including legacy rollback. **That legacy path
does not validate a source receipt.** Legacy rollback therefore needs separately
reviewed archive hashes, source and compatibility evidence. The strict path is
source-tested with local shims; it has not been installed or exercised on a live
host. It does not authenticate public health responses or prove editor/canary
acceptance. S's existing workflows, runtime renderer, Compose, Caddy and cron files remain
byte-preserved; only staging tooling is extended. No main production implementation
is imported. This staging tool explicitly refuses `OS_ENV=production`.

`source-provenance.yml` runs on branch pushes and PRs, with read-only repository
permission. It records the checked-out SHA separately from PR head and base,
requires the PR checkout's two parents to match the event, and reports the
merge base, unique ancestry counts, feature delta and composed diff hash. Its
artifact name includes SHA, run ID and attempt. All events explicitly report
`deployment_authorized=false`. The workflow runs offline regressions; it has no
environment, cloud credentials, image build, account login or deployment step.
It is observation, **not an activated required merge/deploy gate**. This patch
does not complete the PR-to-AWS-staging delivery path.

## Continuation findings and activation gates

The latest owner receipt (17:03:28Z) supersedes the Worker row above: f179 deployed
source S `7fcc76d4efdbf0c400039640cdee13974b727b4d` as Worker
`35603f0f-2111-4d12-9990-699be556dd89` at 100% since 16:58:48Z, with served bytes
matching its dry run. It records app `293ac34d`, bundles and desktop v123 unchanged,
and lease release/readback FREE at 17:01:35/40Z. These are **owner receipts**, not a
new deployment or signed-in acceptance check by this lane. Re-read them before
any future release; no static document establishes the current live version.

Read-only GitHub/AWS inspection proves an existing OIDC lease path, but the
inspected GitHub roles cannot deliver this AWS app. The detailed
[activation proposal](OS-CICD-ACTIVATION.md) records exact identities, targets,
CI failure evidence, the required-check proposal and per-action approval gates.
No missing credential is inferred from an environment-only secret listing.

`staging-candidate.yml` is a reusable **handoff-only** scaffold (`workflow_call`),
with no caller, push/dispatch trigger, cloud credentials, GitHub environment or
deployment. `pipeline.json` is disabled and deliberately leaves `release_ref`
and `delivery_role_arn` null. Its validator refuses unset or wrong targets,
unapproved branches, the lease role as deployer, missing app/Worker/desktop pins,
and unreviewed legacy rollback. It binds the candidate SHA/ref to the event,
requires a clean exact checkout and verifies base ancestry. Even a valid fixture
produces `deployment_authorized=false` and review-only commands. Changing a role
string does not verify or create IAM authorization. This scaffold is not an
activated build, merge, delivery or acceptance gate.

cb1's current integration/release ownership is respected. PR266's
`85270caa…` → `7fcc76d4…` delta has no `.github` or `deploy/aws/os-staging` changes,
and the S worktree had no dirt in those paths at port preparation. Main and S have
older shared-tooling differences; this patch was adapted to S's actual script
contracts, not copied over them. Existing product/infra/host code is untouched.
Any later main/staging reconciliation remains cb1-owned and must retain main's
production safeguards and all reviewed S bytes without merging unrelated stacks.

The new branch is isolated at `EZiL-OS.worktrees/staging-cicd-01a1ac8e`.
Tests execute real Git and generated SSM scripts under local Docker/AWS/systemd
shims: 17 provenance/installer/candidate tests and four S legacy compatibility
tests. Runtime mismatch proves one replacement, six preceding timer stops, no
timer re-enable, no success and explicit recovery identities. The initial
main-based six+11 test results belong to PR267, not to production support in S.
No live install, image build or signed-in acceptance check was performed here.

Execution receipt: [CI/CD task](https://app.notion.com/p/40f7021e76d7811b9892e448dced4ff7),
In progress, Ready for agent=false, direct Coder only. Full PR-to-AWS-staging
activation remains incomplete; ordered gates are in the activation proposal.
