# AWS persistent computers: infrastructure

This package holds the AWS side of [docs/AWS-COMPUTERS.md](../../docs/AWS-COMPUTERS.md).
It is **off by default**: nothing here creates a computer, and nothing here is deployed by CI.

It contains two CDK stacks.

- **Foundation** (`lib/foundation.ts`, `bin/main.ts`):
  - a VPC with one public subnet per configured ZoneId
  - an inbound-closed security group
  - an immutable ECR repository
  - a launch template
- **Lifecycle** (`lib/computer-lifecycle.ts`, `lib/lifecycle/*`, `bin/lifecycle.ts`):
  - the Step Functions Standard workflow that owns every EC2/EBS mutation (R7)
  - an optional, default-off recovery workflow that fences interrupted executions

[LIFECYCLE.md](LIFECYCLE.md) describes the workflow's behaviour.

Provenance: ported from draft PRs #99 (foundation) and #123 (lifecycle and recovery), then
hardened for R1, R5–R7 and R10–R12. The #120 configuration-delivery payload was dropped.

## Configuration

Region, ZoneId, instance types and sizes are all configuration. Nothing is pinned in code.
The example files in `config/` hold public placeholders only.

- `123456789012` is AWS's documentation account.
- All-zero IDs stand in for real resources.

### Foundation: `EZIL_FOUNDATION_CONFIG`

| Field | Type | Rule |
|---|---|---|
| `stage` | `pilot` \| `production` | |
| `region` | string | commercial region, e.g. `ap-south-1` |
| `zoneIds` | string[1..3] | each matches `^[a-z]{2,4}\d-az\d+$` and belongs to `region` (e.g. `aps1-az1`). One subnet per ZoneId. |
| `instanceType` | `m6i.large` \| `c6i.xlarge` | launch-template default; the workflow sets the per-computer type |
| `rootVolumeGiB` | int 8..64 | default 20 |

```json
{ "stage": "pilot", "region": "ap-south-1", "zoneIds": ["aps1-az1"],
  "instanceType": "m6i.large", "rootVolumeGiB": 20 }
```

### Lifecycle: `EZIL_LIFECYCLE_CONFIG`

The file is `{ settings, authorityKeyArn, notificationsEnabled?, recoveryVersionArn?, recoveryEnabled? }`.
`settings.deployment` is `LifecycleDeploymentSchema` (`lib/lifecycle/deployment.ts`). For the
full shape, see `config/lifecycle.example.json`.

| Field | Rule |
|---|---|
| `region`, `zoneId` | same rules as the foundation; one ZoneId per lifecycle deployment |
| `subnetId` | the foundation subnet for that ZoneId |
| `instanceTypes` | a non-empty subset of the closed allowlist `{m6i.large, c6i.xlarge}`. A deployment can narrow it, never extend it. |
| `storage.rootGiB` | root disk size (default 20) |
| `storage.dataMinGiB`, `storage.dataMaxGiB` | allowed data-volume range (defaults 20 and 100) |
| ARNs | must name the configured region and account |

The data-volume size is chosen **per computer** in the intent (`dataVolumeGiB`, provision only):
- 20 GiB on the free tier
- 50 GiB on the premium tier

Existing volumes are accepted anywhere in `[dataMinGiB, dataMaxGiB]`, so a volume grown online
still validates. The intent also carries `instanceType`, which must be in the deployment
allowlist. The file holds **no secret values**: the authority secret is referenced by ARN only.

The intent also carries two contract fields:
- **`leaseEpoch` (C-2/C-3).** It rises on every lease. `generation` stays the *writer*
  generation and is the only value retagged on AWS resources. The epoch travels in the
  receipt (`validateLifecycleReceipt` checks it) and in the signed authority body.
- **`userData` (C-6).** Base64, at most 4096 characters, carrying the one-time enrollment
  nonce. It is required on provision and replace, optional on start, and absent on stop
  and retire.

`settings.features` holds two flags, both default off:

| Flag | Effect |
|---|---|
| `userDataNonce` | Adds the start-in-place step `ModifyInstanceAttribute(InstanceId, UserData)`, used only while the instance is stopped and before `StartInstances`. With the flag off, a start that carries `userData` is refused (`lifecycle_userdata_disabled`). |
| `userDataAttributeKeyVerified` | Only together with `userDataNonce`, it replaces the unconditional `ModifyInstanceAttribute` Deny with three statements: Allow when `ec2:Attribute` = `userData`, Deny when `ec2:Attribute` is anything else, and Deny when `ec2:Attribute` is Null. |

The second flag exists because the IAM service reference lists `ec2:Attribute` for
`ModifyInstanceAttribute`, but no AWS document confirms the value it takes for a UserData
change. Until staging proves it, the fence stays closed: with only the first flag on, the step
is denied and the run fails closed.

**Nonce exposure.** The plaintext nonce sits in the intent and therefore in the Step Functions
execution history. That history is encrypted with the history key. In this stack, only the
control-plane roles can read it: the observer, the controller and the recovery reader. Account
administrators can too, through the key's account-root statement and IAM. The nonce is
single-use, expires after 10 minutes, and is bound to the live instance and the epoch (C-6),
so a copy read later is useless.

`appCaller` (default `{ enabled: false }`) creates the app's federated role (I5, partial). It
takes one trust statement per configured OIDC provider, with exact `aud` and `sub`
(`StringEquals`; wildcards are rejected):
- **GitHub.** Uses the immutable-ID subject, for example
  `repo:<org>@<orgId>/<repo>@<repoId>:environment:<env>`.
- **Vercel.** A separate provider slot. TODO: confirm the team's audience and subject format
  before enabling it.

The role's policy allows only:
- `states:StartExecution` on the exact lifecycle version ARN
- `ec2:Describe*` on `*`, conditioned on `aws:RequestedRegion`

## Security posture (what the tests prove)

**IAM is tested by exact equality, not by "contains" checks.**
- `test/iam-exact.test.ts` writes out the controller policy as the reviewed specification:
  every action, resource, condition and effect, with the userData fence both closed and
  open. It does the same for the app-caller policy and trust.
- It also compares every IAM role and policy, KMS key policy, SQS queue policy and Lambda
  invoke permission in the synthesized stacks against
  `test/__snapshots__/iam-policies.json`.
- Regenerate the snapshot only on purpose, with `UPDATE_IAM_SNAPSHOT=1 npm test`, then review
  the diff.
- The first round's "contains" assertions let 10 of 12 reviewer mutants survive. The
  exact-equality tests replace them.

| Rule | Where | Proven by |
|---|---|---|
| R1: ZoneId only; no zone names, no `Fn::GetAZs` | L1 `CfnSubnet({availabilityZoneId})`; `CreateVolume.AvailabilityZoneId`; IAM `ec2:AvailabilityZoneId` on CreateVolume, RunInstances and AttachVolume | `foundation.test.ts`; exact IAM spec |
| R10: closed type allowlist | IAM `StringEquals ec2:InstanceType` (no `IfExists`); the helper rejects other types | exact IAM spec; `lifecycle.test.ts` |
| No type, disk-flag or metadata change after launch | `ModifyInstanceAttribute` and `ModifyInstanceMetadataOptions` under an unconditional Deny (see the userData flags above) | exact IAM spec, both flag states |
| R5: no host credentials | no instance role or profile and no `iam:PassRole`; `RunInstances` requires `Null ec2:InstanceProfile` | exact IAM spec; the snapshot has no `InstanceProfile` |
| R5: IMDS | `HttpTokens=required`, hop limit ≤ 1 and `InstanceMetadataTags=disabled`, in the template, the launch call and IAM | `foundation.test.ts`; exact IAM spec; `lifecycle.test.ts` |
| R6: network | no ingress, all egress, no NAT, no load balancer | `foundation.test.ts` |
| Launch scope | RunInstances requires the exact launch template (`ec2:LaunchTemplate`) on every resource statement, plus the request tags on the instance and root volume | exact IAM spec |
| Managed-resource scope | Start, Stop, Terminate and AttachVolume require the `managed-by` and `stage` resource tags | exact IAM spec |
| Data key | data-key use only `kms:ViaService` EC2 in the region; `CreateVolume` requires `ec2:KmsKeyId` = the data key | exact IAM spec |
| R3/R12: storage | every EBS volume is encrypted; the data disk's `DeleteOnTermination=false` and single-attach (`MultiAttachEnabled=false`) are verified and fail closed; hibernation off | `lifecycle.test.ts`, `lifecycle-recovery.test.ts` |
| R11: sizes and deletion | size range in IAM and in both helpers; explicit Deny of `DeleteVolume`, `DeleteSnapshot`, `DetachVolume` and `DeleteTags` on both workflow roles | exact IAM spec and snapshot |
| Tag integrity | identity tags only with `ec2:CreateAction`; retag limited to `ezil:generation` and `ezil:fence-token` | exact IAM spec; `lifecycle.test.ts` |
| Second-writer guard | no `RunInstances` while the data volume has any attachment | `lifecycle.test.ts` |
| Confused deputy | every `events.amazonaws.com` grant carries `aws:SourceArn` (the exact rule) and `aws:SourceAccount`. This covers both history key policies, every queue policy and the Lambda invoke permissions. | snapshot plus an explicit check that no grant is unconditioned |
| C-3: errors | EC2 errors are recorded at `$.ctl.lastError`, observation errors at `$.ctl.observeError` (neither overwrites the other); terminals record both. Capacity and quota errors go to `LifecycleRefused` with the code. Throttling backs off and retries (max 5). Timeouts and 5xx are observed. Any other EC2 error fails fast to `Rejected` (`LifecycleUnconfirmed`) with the code. | `lifecycle.test.ts` |
| Recovery settle | recovery waits 60 s after the source stops before trusting its history | `lifecycle-recovery.test.ts` |
| Terminate guard | any disk beyond the root and this computer's data disk blocks `TerminateInstances` | `lifecycle.test.ts`, `lifecycle-recovery.test.ts` |

The graph tests run the shipped state machines through `test/asl.ts`. This is a strict ASL
interpreter: a missing reference path throws, as `States.Runtime` does in AWS.

### Host role: none (decision)

Hosts launch **without an instance role**, which is R5's preferred option.

Nothing on the host needs AWS credentials:
- **Image.** The desktop image is pre-pulled into the AMI (R3). The ECR repository is read by
  the AMI build, not by hosts.
- **Exports.** These use per-key presigned S3 URLs minted by the Worker (R3, R7).
- **Enrollment.** This uses the IMDSv2 identity document plus a one-time nonce (C-6). That
  needs IMDS, not a role.
- **Tunnel token.** This is delivered once, after enrollment (C-6).

A user who becomes root on their host therefore holds no AWS credential at all. This also
removes several problems the stale stack had:
- the per-generation instance profiles
- the `iam:PassRole` grant
- the IAM name collision of #123's `writerProfile`
- `AmazonSSMManagedInstanceCore` and its `ssm:GetParameter*` reach

The cost is that there is no Session Manager shell. Operators debug through the host agent's
own reporting (I4). If SSM is ever required, it must be one shared host role with a custom
minimal policy. It must not use the AWS-managed policy, and the change must update this
section, the `Null ec2:InstanceProfile` condition and the item 3 tests together.

### Root-volume KMS key: why there is no `ec2:KmsKeyId` condition

The IAM service reference lists `ec2:KmsKeyId` for `CreateVolume`, but not for the `volume`
resource of `RunInstances`. A condition on a key that is never present would deny every
launch. The root-volume statement therefore requires only:
- `ec2:Encrypted=true`
- gp3
- the size cap
- the request tags
- the exact launch template

The residual risk is narrow:
- The helper always sends `KmsKeyId` = the data key (tested).
- The role's KMS rights cover only the data key, through EC2. A request naming any other
  customer key fails at KMS.
- The one gap is the AWS-managed `aws/ebs` key, which EC2 may use for any principal in the
  account. A malformed request could therefore encrypt a **root** volume with `aws/ebs`.
  That volume holds only the OS and the pre-pulled image (R3), never user data.
- Data volumes are pinned to the data key by `CreateVolume`'s `ec2:KmsKeyId`.

Staging: confirm that a launch naming `aws/ebs` succeeds and that a launch naming another CMK is
denied.

### Why the root disk is `DeleteOnTermination=true`

The root disk holds only the OS and the pre-pulled image (R3). Stop and start keep it. Only
replace and retire terminate an instance, and they only ever discard the root disk:
- the data disk is attached after launch, so it defaults to `DeleteOnTermination=false`
- the helper refuses any other value
- the terminate guard refuses any extra disk

## Commands

All commands run offline.

- The synth scripts blank the AWS credential chain (`AWS_CONFIG_FILE=/dev/null`,
  `AWS_SHARED_CREDENTIALS_FILE=/dev/null`, `AWS_EC2_METADATA_DISABLED=true`).
- They disable CLI telemetry, and pass `--no-lookups --no-notices`.
- They were verified under `unshare -n`.

```sh
cd infra/app-computers
npm ci
npm run typecheck
npm test                 # unit, graph and CDK assertion tests
npm run synth            # foundation, config/foundation.example.json
npm run synth:lifecycle  # lifecycle + recovery, config/lifecycle.example.json
# or, from the repository root:
bash tools/test.sh infra
```

Do not deploy before all of the following are reviewed:
- the host AMI
- the deploy identity (I5)
- the app federation
- DLM, budgets and the kill switch (I6)
- the staging evidence in AWS-COMPUTERS.md §7

A production change also needs a real `cdk diff` against the target account.

## Staging verification items

These cannot be proven offline:
- **Error naming.** The exact Step Functions error names for EC2 SDK errors. Classification
  matches both `Error` and `Cause` (codes and provider messages) on purpose.
- **ZoneId in describe output.** Whether `DescribeVolumes` reports `AvailabilityZoneId`. The
  helper fails closed when it is absent.
- **Cross-computer attach.** The fence is a workflow refusal plus the authority callback.
  The helper attaches only the volume named in, or created by, the signed intent, and only
  when its `computer-id`, `generation` and `fence-token` tags match. IAM cannot tie a volume's
  `computer-id` to an instance's `computer-id` for a shared role, so this is not an IAM
  access-denied proof.
- **`ec2:Attribute` for UserData.** Prove that `ModifyInstanceAttribute` with a UserData value
  presents `ec2:Attribute=userData`, and that other attributes are denied. Only then set
  `userDataAttributeKeyVerified`.
- **Live allow proofs.** `IfExists` was removed, so a key that is absent from a correct
  request now denies it. The canary must show that a correct provision, attach, retag,
  start, stop and terminate are *allowed*, not only that bad requests are denied. The
  riskiest key is `ec2:AvailabilityZoneId` on `RunInstances`: no `Placement` is sent, and
  the zone comes from the subnet. The same key on `AttachVolume` is also at risk, and so
  are the IMDS keys when they are evaluated from the launch template.
- **Capacity refusals alarm.** A refusal ends `FAILED`, so it lands in the
  `UnconfirmedExecutions` queue and fires its alarm. Admission (A2) must treat it as a
  refusal reason, not an incident.
- **Live access-denied proofs** for:
  - a disallowed type
  - an unencrypted or out-of-range volume
  - an identity retag
  - a profile on `RunInstances`
  - `ModifyInstanceAttribute`

## TODO (next waves)

- **Capped online growth (R11).** This is a `ModifyVolume` intent:
  - IAM: `NumericLessThanEquals ec2:VolumeSize` ≤ `dataMaxGiB`
  - observation of the modification state
  - EBS cooldown handling
  - guest filesystem grow (I4)

  It is not implemented. Today the range check simply accepts grown volumes.
- **Retained-computer recovery** from #127 (intent v2) is not ported.
- **EventBridge reconcile rule.** EC2 state-change events to the app's API destination (R7).
- **Capacity refusals and recovery** (stranded-volume path; needs #127's retained intent). A capacity refusal after `CreateVolume` leaves a retained
  volume and a `FAILED` execution. The recovery workflow then sees `runInstances` entered with
  no instance, and waits until its deadline. Teaching recovery that a recorded capacity code
  proves no launch is future work.

## Proposed CI job (not added this wave)

`ci.yml` does not run this package. To make it a required check:
1. add the job below to `.github/workflows/ci.yml`
2. add `computer infrastructure (typecheck + test + synth)` to the ruleset
3. extend `.github/scripts/check-os-workflows.py` if it should assert the job

The job contains no secrets and has no AWS access. Node 24 matches the Lambda runtime
(`NODEJS_24_X`) and the version the suite was verified on. Main's other jobs pin
`22.16.0`; this suite has not been run on 22.

```yaml
  computer-infrastructure:
    name: computer infrastructure (typecheck + test + synth)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '24.15.0'
      - name: Install
        working-directory: infra/app-computers
        run: npm ci --no-audit --no-fund
      - name: Typecheck, test, offline synth
        run: bash tools/test.sh infra
```

References:
- [Preserve data when an instance is terminated](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/preserving-volumes-on-termination.html):
  a data volume attached after launch is preserved by default.
- [EC2 condition keys](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonec2.html):
  `ec2:AvailabilityZoneId`, `ec2:MetadataHttpTokens`, `ec2:InstanceMetadataTags`,
  `ec2:InstanceProfile` and `ec2:CreateAction`.
