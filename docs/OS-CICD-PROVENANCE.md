# OS source provenance and staging handoff

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

## Reverified staging surfaces

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
claim of passing tests. Historical installers and rollback artifacts retain
their existing two-file checksum format; installation is not newly automated.
**The current installer does not fetch or verify `source.json`.** This patch
therefore does not establish runtime source-receipt enforcement. The release
owner must verify a candidate's source receipt before installing it. A future
installer change must fetch the receipt, validate the expected environment/tag
and full approved SHA, bind both archive hashes, check the loaded image's revision
and runtime SHA, and refuse mismatch before replacing the app. It must explicitly
retain or gate the independently identified legacy rollback format; that rollout
and its compatibility tests are separate work, not claimed by this patch.

`source-provenance.yml` runs on branch pushes and PRs, with read-only repository
permission. It records the checked-out SHA separately from PR head and base,
requires the PR checkout's two parents to match the event, and reports the
merge base, unique ancestry counts, feature delta and composed diff hash. Its
artifact name includes SHA, run ID and attempt. All events explicitly report
`deployment_authorized=false`. The workflow runs offline regressions; it has no
environment, cloud credentials, image build, account login or deployment step.
It is observation, **not an activated required merge/deploy gate**. This patch
does not complete the PR-to-AWS-staging delivery path.

## Safe pipeline and outstanding gates

1. **Source admission:** select a reviewed full SHA on a deliberate integration
   branch. cb1 owns integration with source S. Preserve main's newer deployment
   safeguards and reviewed feature bytes. Review the composed tree diff, not
   just the latest commit or branch name. Run source provenance and all affected
   checks against the exact candidate. Do not silently waive baseline failures.
2. **GitHub check policy:** ruleset `22265548` currently requires Windows/macOS
   contexts for worker/app/sdk/shell although CI now emits Ubuntu only, plus
   `Hosted continuity PR gate`, absent from current CI. It does not require the
   new `OS source provenance` check. Updating this ruleset is a **security setting
   change requiring separate user confirmation**: propose the exact desired
   required-check list after owner review; preserve DCO/CodeQL/PR restrictions.
   No ruleset change or bypass was made here. S's app/shell/infra/tools and DCO
   failures are baseline findings, not failures introduced by this patch.
3. **Build admission:** use a clean detached worktree and the snapshot builder;
   reserve any paid build window separately. Record app/runtime hashes, actual
   image ID/digest, Worker dry-run hash, config/binding identity, desktop digest
   and editor artifact identity separately. Reuse a desktop only after proving
   its inputs unchanged. A PR receipt alone is not image or canary acceptance.
4. **Target admission:** the future AWS app deploy job must pin
   `https://os-staging.ezil.work`, the verified staging host and artifact prefix;
   the Worker job must pin `ezil-os-worker-staging` and the retained desktop
   digest. Do not repoint the legacy Vercel alias and call that AWS deployment.
   A GitHub-to-AWS delivery identity is **not established by this investigation**.
   No missing credential is inferred from environment-level listings. First
   inventory the effective authorized identity path; return any exact proposed
   OIDC trust/IAM/secret/persistent-access change for per-action confirmation.
5. **Release admission:** cb1 ACK, required independent reviews, an explicit
   release window, fresh live component comparison and the existing shared
   staging lease; migration/backup/rollback checks where relevant. Serialise app,
   Worker and desktop changes according to that release plan. Existing locks,
   claims and prompt handlers remain authoritative. Do not activate automatic
   deployment merely by merging this source-only patch.
6. **Acceptance and receipt:** compare served app SHA/bundle hashes and Worker
   bytes/version with the candidate, verify retained or changed desktop/editor
   identity, then obtain separately authorized provider-specific canary checks.
   Old AWS users are not Cloudflare canaries. Record previous component versions
   as rollback targets, deployment/run IDs, test evidence and lease release.

This implementation starts from remote main `15c1ea68…` in isolated branch
`fix/os-cicd-provenance-20261105`. It changes no application feature, source-S
branch, existing deployment workflow/manual production safeguard, installer,
IAM policy, secret, account, computer or deployment. The shared build/upload
checks apply to both environments; the existing production and legacy install
compatibility tests still run with offline shims.
Execution receipt: [CI/CD task](https://app.notion.com/p/40f7021e76d7811b9892e448dced4ff7).
