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

## Specific dependent actions and gates

1. **Source/integration:** cb1 must ACK the exact patch and choose the deliberate
   release branch/full candidate SHA. No branch has been authorized here.
   Preserve production safeguards from main and reviewed S bytes across their
   divergent histories. Re-run exact composed-source checks; review baseline
   failures without waiving them. Keep DCO authentic.
2. **Check policy:** obtain approval for the precise ruleset change above and
   the hosted-continuity replacement/relocation. No policy change is needed to
   review this source-only PR.
3. **Delivery authorization proposal:** if no further existing path is found,
   propose a dedicated role, for example `ezil-os-staging-app-delivery` (a
   **proposed name, not an existing/approved role**). Trust only the immutable
   repo subject `repo:EZiLHQ@315435740/ezil-os@1339112799:environment:staging`
   with audience `sts.amazonaws.com`. Its scoped actions
   would be S3 PutObject/GetObject on
   `arn:aws:s3:::ezil-main-preview-artifacts-452630323510-aps1/os-staging/images/*`,
   EC2 DescribeInstances for target validation (AWS requires resource `*`),
   SSM SendCommand on the exact staging instance ARN and one approved fixed
   document ARN, and GetCommandInvocation for command readback (resource `*`
   where AWS requires it). Region conditions must match ap-south-1. No IAM,
   SecretsManager, production bucket, lifecycle/rebase or user-computer access.
   Keep the existing lease role unchanged. Role creation/trust and permission
   attachment are separate persistent-access actions requiring approval.
4. **Fixed installer document proposal:** create a reviewed version of an
   `EZiL-OS-Staging-InstallVerified-v1` SSM document (proposed name) that embeds
   the audited installer/verifier and pins the host/bucket. Accept only tag,
   full source SHA and receipt SHA256 with validation; never arbitrary shell
   or caller-supplied script URLs. Record document version/hash and pin them in
   the future GitHub job. This is a separate persistent-access action. The
   current workstation command still uses existing `AWS-RunShellScript`;
   **do not grant a new GitHub role that general shell authority by default**.
   The corresponding source adapter and its mocked permission/parameter tests
   are needed before activation. No document or IAM policy is created here.
5. **Environment admission:** the staging subject alone does not restrict a
   source branch. After branch selection, propose an explicit staging GitHub
   environment branch policy and reviewer gate (including exact authorized
   reviewer selection). This is another security-setting approval. Do not
   alter the OIDC subject template: that could break the proven lease path.
   Existing OIDC provider, CF credentials and host receipt-read permission can
   be retained; no secret rotation/new static secret is currently indicated.
6. **Build/delivery source wiring:** add a reviewed caller only after the above
   values are known. It must verify PR/merge checks and branch head, reserve
   the authorized build window, build one clean immutable source snapshot,
   record app/runtime/receipt hashes and image identity, publish with immutable
   tags, then use the fixed document under the existing shared staging lease.
   Fail closed on source, target, identity or lease drift. Do not run checkout
   code with delivery credentials before admission. A finite build window and
   owner release ACK remain required; none is exercised by this patch.
7. **Release and acceptance:** obtain cb1's release plan/lease and schema,
   backup and rollback review. `install-verified` enforces the approved receipt;
   follow with public app SHA/bundle checks and separately authorized provider
   acceptance. Keep Worker action `retain` unless separately reviewed. Legacy
   rollback has no source-receipt enforcement: verify its exact two archive
   hashes and prior source before using `install PREVIOUS_TAG`. Store exact
   command/run IDs and all component pins in the receipt; release/read back
   the lease. Runtime-SHA failure is after app replacement and timer stops. Inspect the SSM
   command/current container and recorded candidate/previous identities; restore
   the reviewed app/runtime pair or repair the candidate, verify health/source,
   then restore the reviewed timer set. No automatic legacy fallback occurs.

The checked-in handoff produces review-only argv/environment and requires these
gates; it never executes them. Setting `enabled=true` alone does not connect a
pipeline. Until the source caller, delivery document/authorization and live
acceptance are approved and verified, the task remains **In progress, Ready=false**.
