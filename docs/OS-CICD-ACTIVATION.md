# AWS OS staging CI/CD activation proposal

Read-only evidence collected 2026-11-05 by Codex session
`01a1ac8e-1555-7752-9cd7-e075a07c92c8`, [task](https://app.notion.com/p/40f7021e76d7811b9892e448dced4ff7),
[preserved initial PR267](https://github.com/EZiLHQ/ezil-os/pull/267).
The operational source-only successor is `fix/os-staging-cicd-provenance-20261105`
on exact S `7fcc76d4efdbf0c400039640cdee13974b727b4d`, as requested by cb1 and the user.
This is a proposal for specific approvals, not permission to apply policy,
assume a delivery role, dispatch a workflow, build or deploy.

## Exact-head CI diagnosis

Initial PR head `93ce62bfebcf6aa27f8610224f435b4b88969621` is one commit on
`15c1ea68b7e8d6a8d467149b9545f637128b5d6a`.
[CI 42068040675](https://github.com/EZiLHQ/ezil-os/actions/runs/42068040675)
is terminal: nine jobs PASS including shell; only infrastructure FAILS.
Its host-unit check has 69 passes and two failures:
`systemd-analyze verify` and seccomp reproduction. Infrastructure source and
`ci.yml` were byte-identical to the base, whose
[CI 41229866015](https://github.com/EZiLHQ/ezil-os/actions/runs/41229866015) passed.

| Evidence | Base | Initial PR head |
| --- | --- | --- |
| Infrastructure job | 124621653211 | 127387638228 |
| OS image | Ubuntu 24.04 | Ubuntu 26.04 |
| Runner image version | 20261025.353.1 | 20261101.186.1 |
| systemd | Existing check passes | Removed `CPUAccounting` options in host xfs/walinuxagent units fail verification |
| seccomp | Generated profile matches committed profile | Host syscall headers generate a different profile |

`infra/host-agent/test/test-units.sh` uses the host unit search path and the host
`/usr/include/x86_64-linux-gnu/asm/unistd_64.h` (see the actual source paths in
the run log). The smallest recovery pins **only** `computer-infrastructure`
to `ubuntu-24.04`. No security profile, assertion, infrastructure owner code or
check is weakened. This controls the OS family, not every runner-image package;
a future image drift still needs diagnosis. The follow-up CI must confirm the
recovery. Exact S baseline CI [42062700378](https://github.com/EZiLHQ/ezil-os/actions/runs/42062700378),
infra job `127368417652`, independently shows the same two failures on image
`ubuntu-26.04` / `20261101.186.1` (70 passes, two failures). The port changes no
infra source. PR266's pool-demand fixtures, stale CI-comment citation and DCO belong
to that separate source/base; they did not fail PR267's app/tools/DCO checks.

## Scoped baseline recovery and independent inputs

After a fresh ownership check and the user's 17:22Z instruction, this lane owns
one additional CI-only fix: `tools/triage.ts` now cites lines 370–380, the complete
current private-package paragraph, instead of stale 364–374. All semantic tests
remain unchanged, including exact paragraph boundaries and required phrases.
The tools suite improves from 227/1 to **228/0**; focused triage improves from
63/1 to 64/0. No classifier, permission or triage-publishing behavior changes.

The first S-based implementation `df1fe821` passed infrastructure CI job
`127406783028` in run `42073317530`: **72 host checks passed, zero failed** on
Ubuntu 24.04. App results match S exactly: 69 failures, 9,938 passes, 568 skips;
the complete set of failing names is identical. The separate, reviewed pool
fix is [PR268](https://github.com/EZiLHQ/ezil-os/pull/268), exact head
`44e88480ea2cf53ea2fea4a11a1333515fb487d7` on S. Its GitHub app job
`127404321776` / run `42072619942` passes. This lane does not copy or integrate
that file; cb1 owns composition of the two independent inputs.

S shell job `127368417500` fails overlay-paint 42/43: the Code iframe contains
`about:blank?code-frame=1&ezil_mint=…`, versus the test's expected URL. Main-based
PR267 shell job `127387638939` passes that suite 43/43 on the **same Ubuntu
26.04 family**. Their application/shell sources differ; this is not evidence of
a runner-only defect. No shell runner pin or UI/feature patch is made. cb1 and
the existing folder/editor owner must reconcile the test with the reviewed
minting behavior and then provide exact-source browser acceptance.

## Required-check proposal versus ruleset 22265548

The active [ruleset](https://github.com/EZiLHQ/ezil-os/rules/22265548) applies to
the default branch and requires 16 contexts. Nine are not emitted by current PR
CI: Windows/macOS variants of worker, app, sdk+mcp and shell (eight), plus
`Hosted continuity PR gate`. The existing workflow contract deliberately keeps
public web CI on Ubuntu; native packaging/testing is separately opt-in.

Proposed exact source-check list (13), **subject to per-action user approval**:

```text
worker (typecheck + unit) (ubuntu-latest)
app (typecheck + unit) (ubuntu-latest)
sdk + mcp (typecheck + unit) (ubuntu-latest)
shell (bundle check + browser suites) (ubuntu-latest)
tools (typecheck + unit)
DCO
CodeQL (javascript-typescript)
computer infrastructure (typecheck + test + synth)
ezil-models (EZiL Chat provider + committed VSIX)
container (real image)
local (typecheck + unit + smoke)
OS cloud release contracts
OS source provenance
```

The first seven retain meaningful currently required coverage; the last six
add emitted checks that are currently optional. Removing the eight nonexistent
OS contexts does not claim cross-platform acceptance. Removing or relocating
`Hosted continuity PR gate` needs explicit approval and a real replacement
release-admission design. Offline contracts/provenance are not hosted continuity.
Before automatic delivery, implement genuine AWS app and separately pinned CF
Worker/desktop acceptance, give their jobs stable names, verify emitted contexts
on exact candidates, and propose those release gates for approval. Do not invent
a green compatibility job to satisfy a missing context.

Apply nothing now. A later approved update must alter only the reviewed
required-check list, preserving all other ruleset fields: deletion/force-push
protection, linear history, PR/squash restrictions, DCO and CodeQL, review fields,
bypass actors and strictness. This draft adds no bypass and changes no policy.

## Existing identity and actual target

Metadata reads used the already authenticated `ezil-admin` profile in account
`452630323510` (SSO AdministratorAccess). No role was assumed, secret value read,
credential created or permission changed by this investigation.

GitHub OIDC already exists in AWS for `token.actions.githubusercontent.com`,
audience `sts.amazonaws.com`. GitHub uses its default **immutable repository
subject** prefix `repo:EZiLHQ@315435740/ezil-os@1339112799`.
Historical preview job `118929573380` proves successful OIDC assumption of
`ezil-os-staging-lease`. A new OIDC provider or static AWS secret is not indicated.

| Existing identity | Effective inspected authority | Delivery implication |
| --- | --- | --- |
| `arn:aws:iam::452630323510:role/ezil-os-staging-lease` | Trusts immutable repo subjects for staging/production/Production; DynamoDB PutItem/DeleteItem/GetItem on `arn:aws:dynamodb:us-east-1:452630323510:table/ezil-ci-staging` | Lease only, no app artifact or SSM delivery |
| `ezil-mum-deploy`, `ezil-pilot-deploy`, `ezil-prd-deploy` | aws-pilot/aws-prd subjects; scoped infrastructure stacks/assets | Not the OS app bucket/install path; those GitHub environments are absent |
| `ezil/mum/ezil-mum-lifecycle-AppCallerRoleEA1CB1F0-J7TJ1Dtg4yGL` | App-host/GitHub aws-mum-staging trust; lifecycle/rebase/recovery, decrypt and describe | AppCaller is not a delivery role |
| `ezil-ci-runner` | EC2 trust, lease and SSM managed-instance core | No registered repository Actions runners; not an existing GitHub delivery path |
| `ezil-os-billing-staging-host-InstanceRole-rNWO46WOExww` | Existing GetObject on OS staging prefix, runtime secret access and AppCaller assumption | Can already fetch `.source.json`; no host grant expansion needed |

Repo secret **names** include CF/Vercel/acceptance credentials; accessible org
Actions secret listing is empty. Repo variables are empty. GitHub environments
are `Preview`, `Production`, `staging`; staging currently has no protection rules
or deployment branch policy. Environment-only secret names are not evidence of
missing repo/org credentials. No inspected identity provides both OS artifact
upload and installation. AWS has no self-owned SSM documents in the inspected
region. The bucket policy denies insecure transport; it does not grant GitHub
delivery access. This is a scoped inventory, not proof that no other authorized
path could exist outside the inspected repository/roles.

Actual app delivery target, reverified from AWS and owner DNS receipts:

```text
origin:        https://os-staging.ezil.work
account:       452630323510
region:        ap-south-1
instance:      i-014810524754b9ed0
Name:          ezil-os-billing-staging-host
ezil:env:      billing-staging
VPC:           vpc-0f6bc19fdfd4209aa
subnet:        subnet-0dd4cf8f7d3d92e20
public IP:     43.205.36.201
stack:         ezil-os-billing-staging-host
bucket:        ezil-main-preview-artifacts-452630323510-aps1
object prefix: os-staging/images/
Worker:        ezil-os-worker-staging (separately pinned version/source/bundle)
```

The legacy Vercel alias is not this target. CF desktop digest/editor provenance
must be pinned independently. Existing AWS users and AMI artifacts do not prove
CF canary acceptance.

## Prepared source graph — still disabled

The source-only implementation is in PR269 on frozen S. PR267 remains a draft
historical main-based proof; it does not repair the operational release branch.
No current app, Worker, image or host install is changed by either PR.

`staging-release.yml` and `staging-delivery.yml` are reusable-only workflows.
`pipeline.json` is disabled. Release ref, delivery role, required-check approval,
environment reviewers, public browser-auth config, and document name/version/hash
are null. Merely enabling the boolean cannot pass admission. There is no active
entry caller, no new AWS document, and no delivery-role grant in this patch.

The prepared path is: exact branch source admission → independent staging
build-window approval → immutable Git archive app/runtime build → sealed GitHub
artifact → independent installation approval → existing shared lease → exact
fixed SSM document → installed image/runtime and public health SHA receipt.
Worker action is retain; it remains independently pinned in the candidate.

`release_admission.py` maps all 13 proposed contexts above to specific jobs:
worker/app/connectors/shell/tools/computer-infrastructure/ezil-models/container/
local/cloud-release-contract in `ci.yml`, dco in `dco.yml`, codeql in `codeql.yml`,
and provenance in `source-provenance.yml`. It verifies the Actions job/check ID,
repository, workflow path, branch, source SHA, **push event**, successful latest
run attempt and that job's digest-verified checkout artifact. The artifact must
match the candidate source/tree, workflow ref, job and run/attempt. A PR synthetic
merge, a duplicate check name from another workflow, or old-attempt evidence
cannot stand in for merged branch-SHA CI. This is source admission code, not an
activated branch-protection gate.

`staging_delivery.py` accepts only the admitted current release entry run/attempt
and its successful `release / Build approved staging artifact` job. Artifact
ID/digest, exact name, repository, workflow path, event, source and branch must
match. The four downloaded files have a strict member set; the real image and
runtime archives are verified, copied into a private snapshot, and uploaded with
conditional writes. The checksum completion marker is last. No same-SHA artifact
from another workflow/run/attempt is accepted and no submitted install is retried.

`public_config.py` requires an explicitly approved Supabase URL/project identity
and SHA256 of the public anon key before the graph can build. The key itself is
never written to a receipt. The source receipt carries that identity; a Docker
label binds its canonical fingerprint to the image config and therefore image
ID. Delivery compares the receipt against the approved staging config, and the
installer checks its image-label binding before loading. Legacy receipts without
this extension remain usable only through the existing operator path; automatic
delivery requires the new identity. This prevents a correctly sourced staging
host from silently shipping browser auth aimed at another backend. The Stripe
publishable build input is retained; this does not establish live Stripe use,
which follows the separately configured runtime contract.

`fixed_document.py` deterministically renders the audited installer and verifier.
Its only parameters are tag, full source SHA and receipt SHA256, passed through
SSM Agent ENV_VAR interpolation with strict patterns. It pins the bucket and
checks nonsecret IMDSv2 instance/account/region against the exact target above
before installer mutation. Older agents without ENV_VAR support fail closed.
Adapter STS/EC2/document checks and IAM restrictions remain separate guards.
The observation workflow uploads the rendered document plus canonical hash for
review, and **does not create it in AWS**.

`delivery_permissions.py DOCUMENT_NAME` renders one proposed policy; it never
creates or attaches it, and has no default approved name. Its statements are:

- S3 PutObject only in the staging image prefix, ap-south-1. No GetObject grant
  is needed by this delivery adapter; the host already fetches artifacts.
- EC2 DescribeInstances for target validation; resource `*` as required by AWS.
- SSM GetDocument/DescribeDocument for the chosen exact document ARN.
- SSM SendCommand for that exact document and staging instance ARN only.
- SSM GetCommandInvocation for outcome reads, resource `*` as required by AWS.
- DynamoDB **GetItem only** on existing
  `arn:aws:dynamodb:us-east-1:452630323510:table/ezil-ci-staging`, with
  `dynamodb:LeadingKeys=[shared-staging]`, a matching Null=false condition, and
  us-east-1 restriction. No PutItem/DeleteItem is added to the delivery role.

The existing lease role acquires/releases separately. Public AWS Service
Authorization Reference mappings were checked for these named operations and
array-valued LeadingKeys. Offline tests evaluate the proposed Allow/action/
resource/condition subset before mocked requests; removing GetItem causes the
positive path to fail before upload. Tests deny other keys/tables/regions, lease
writes, other buckets/hosts and AWS-RunShellScript. This is not a live IAM policy
simulation. No service role is passed to SSM, no replication/ACL/tagging API is
used, and no extra permission for those variants is proposed.

## Failure state and owner recovery

The adapter records lease expiry and marks cleanup unsafe **before** SendCommand.
Any submitted-install failure, cancellation, timeout, unknown outcome or health
SHA mismatch retains the lease without DeleteItem. Automatic cleanup is permitted
only after verified successful public health/source, or a known pre-submission
failure. The lease is bounded by its original 2100-second TTL; this is **not an
indefinite recovery hold**. The >1020-second remaining-time guard covers the
120-second SSM delivery timeout plus 900-second execution limit. The release
owner must inspect/recover before normal leasing can resume after expiry.

Runtime-SHA verification runs after Docker Compose replacement and timer stops.
Failure is mutating: it prints no install success, reports candidate and observed
previous recovery pins, and leaves the stopped timer set stopped. Inspect the
recorded SSM command, actual container/image/source and candidate/previous archive
receipts. The owner must explicitly restore the reviewed app/runtime pair or
repair the candidate, verify health/source, then restore the reviewed timer set:
telemetry-maintenance, sandbox-reap, billing-session-sweep, aws-stop-settle,
pool-replenish and aws-reconcile. Later public-health failure may occur after the
installer restarted timers; inspect their actual state. Legacy rollback remains
an explicit owner operation with exact prior hashes/source, never an automatic
fallback. A lost SendCommand response has uncertain execution; do not retry it.

## Remaining source activation and per-action gates

1. **Owner composition/branch:** cb1 reviews the exact PR269 head and composes
   the separate pool and shell inputs. S/PR262–266 remain frozen. Prefer one
   durable `os-staging` or `release/staging` branch from that reviewed candidate.
   No plain `staging` exists, but `staging/os-core-20261026` occupies its Git ref
   namespace; preserve it. The question about a staging branch is not permission
   to create/point one. Main production promotion remains separate.
2. **Exact-SHA check source path:** current CI and CodeQL push only on main;
   DCO is PR-only. `activation_source.py --release-ref CHOSEN_FULL_REF --output
   NEW_EXTERNAL_DIRECTORY` prepares an offline review bundle, without applying
   it. It adds the chosen branch to CI/CodeQL and DCO push triggers, checkout
   evidence to every mapped job, and a manual approved release-entry caller.
   The original DCO script remains byte-exact; only its event SHA inputs extend
   to push before/after, with an extra nonzero ancestral range guard. Initial
   branch-creation events fail DCO rather than inventing an approval baseline;
   a reviewed subsequent merge/push produces genuine branch-SHA evidence. No
   producer history is rewritten or signed for others. The generator also moves
   the exact triage paragraph citation to match the expanded workflow, preserving
   its semantic tests. This closes the source-path deadlock without choosing or
   activating a ref now. Apply/review the generated source patch only after the
   branch decision; allow all checks to finish before requesting release.
3. **Check policy:** approve the exact 13-context proposal and disposition of
   the nonexistent Hosted continuity gate separately. Preserve all other
   ruleset22265548 settings and require real release/provider acceptance; offline
   provenance is not hosted continuity. No ruleset change has been made.
4. **Delivery identity:** select an actual dedicated delivery-role ARN and
   approve its creation/trust, then the precise rendered policy attachment as
   separate persistent-access actions. Trust the existing provider, audience
   sts.amazonaws.com and immutable subject
   `repo:EZiLHQ@315435740/ezil-os@1339112799:environment:staging`.
   Existing provider/lease role/CF credentials are retained. No new static secret,
   broad shell grant, IAM PassRole or host access expansion is proposed.
5. **Fixed document:** approve creation of the exact rendered content under a
   chosen name, then pin numeric version, canonical source hash and service
   hash readback. Document creation is a separate persistent-access action;
   it has not happened. Verify target SSM Agent interpolation support read-only
   before any approved install.
6. **Environment/public configuration:** approve the chosen staging environment
   branch policy and exact independent reviewers, then the known public build
   settings and URL/key fingerprint. The generated caller's variable names are
   proposed inputs, not existing credential findings. Do not fetch or print key
   values. Current staging has no reviewer/branch policy, so admission refuses.
7. **Release/build/acceptance:** obtain cb1's concrete release/schema/backup/
   recovery plan, finite build window and live component pins. Review artifact
   IDs/hashes/image/public-config identity before installation approval. Only a
   separately approved invocation may build/upload/install. Follow with actual
   AWS app and separately pinned CF Worker/desktop acceptance. AMI artifacts and
   old AWS users cannot stand in for CF canary acceptance. Record all results and
   the lease readback. None of these live actions was exercised by this patch.

All preparations remain source-only. The task stays **In progress, Ready=false**
until the full approved pipeline is connected and its live acceptance is proven.
