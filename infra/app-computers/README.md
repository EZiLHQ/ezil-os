# AWS persistent computers: infrastructure

This package holds the AWS side of [docs/AWS-COMPUTERS.md](../../docs/AWS-COMPUTERS.md).
It is **off by default**: nothing here creates a computer, and nothing here is deployed by CI.

It contains four CDK stacks. Every stack is named `ezil-<namespace>-<kind>`, except the
identity stack, which is `ezil-identity-<namespace>`.

- **Foundation** (`lib/foundation.ts`, `bin/main.ts`):
  - a VPC with one public subnet per configured ZoneId
  - an inbound-closed security group
  - an immutable ECR repository
  - a launch template
- **Lifecycle** (`lib/computer-lifecycle.ts`, `lib/lifecycle/*`, `bin/lifecycle.ts`):
  - the Step Functions Standard workflow that owns every EC2/EBS mutation (R7)
  - an optional, default-off recovery workflow that fences interrupted executions

- **Deploy identity (I5)** (`lib/identity.ts`, `bin/identity.ts`): the permission boundary,
  the CloudFormation execution role, the GitHub OIDC deploy role and the asset bucket. The
  founder creates it once (see "Founder bootstrap"). CI never deploys it.
- **Ops guardrails (I6)** (`lib/ops.ts`, `bin/ops.ts`): DLM snapshots, the egress alarm,
  budget alerts, the alert topic and the kill-switch policy.

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
| `instanceType` | `t3a.medium` \| `t3.medium` \| `m6i.large` \| `c6i.xlarge` | launch-template default; the workflow sets the per-computer type (and, for T types, the credit option) |
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
| `instanceTypes` | a non-empty subset of the closed allowlist `{t3a.medium, t3.medium, m6i.large, c6i.xlarge}`. A deployment can narrow it, never extend it. To serve the free tier it must list `t3a.medium` (and `t3.medium` as the fallback). |
| `storage.rootGiB` | root disk size (default 20) |
| `storage.dataMinGiB`, `storage.dataMaxGiB` | allowed data-volume range (defaults 20 and 100) |
| ARNs | must name the configured region and account |

The data-volume size is chosen **per computer** in the intent (`dataVolumeGiB`, provision only):
- 20 GiB on the free tier
- 50 GiB on the premium tier

**Computer tiers (founder decision 2026-10-14).** `TIER_INSTANCE_TYPES` in `lib/lifecycle/deployment.ts`:

| Tier | Size | Types, in preference order | Credits |
|---|---|---|---|
| `free` | 2 vCPU / 4 GiB | `t3a.medium`, then `t3.medium` | standard: throttled to the T3 baseline (20% per vCPU) once earned credits run out; never billed for surplus |
| `plus` (upgraded) | 2 vCPU / 8 GiB | `m6i.large` | not burstable |

`c6i.xlarge` stays allowlisted for benchmarks only. This reverses the earlier R10 note "no burstable
types": free computers must be cheap. The cost of that choice is the T3 baseline: a long Chrome or
build session on a free computer slows down when its credits are spent, and it stays slow rather
than adding to the bill.

**Changing tier (upgrade or downgrade).** A stopped computer changes tier through the existing
`replace` intent, carrying the new tier's `instanceType`:
- stop, then terminate the disposable root;
- run a new instance of the new type (T types with standard credits);
- retag and re-attach the **same** retained data volume, at generation + 1.

It is never a `ModifyInstanceAttribute` instance-type change; the boundary denies that outright.
`lifecycle.test.ts` ("tier change") proves t3a.medium → m6i.large and m6i.large → t3a.medium on
the same volume.

Not built yet:
- **App.** The app must issue that `replace` with the new type, record it on the placement, and
  mint the new generation's enrollment `userData` (A1/A3).
- **Volume growth.** `dataVolumeGiB` applies at provision only, and there is no capped
  `ModifyVolume` step and no host filesystem grow. An upgraded computer keeps its free-tier
  data-volume size until that step exists.
- **No shrink.** A downgrade cannot shrink a volume; a grown volume stays inside
  `[dataMinGiB, dataMaxGiB]` and keeps costing its size.
- **Capacity fallback within a tier.** The workflow ends a capacity refusal with its code. The
  app must retry with the tier's next type (for example t3a.medium → t3.medium) as a new intent.

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
| `userDataAttributeKeyVerified` | Only together with `userDataNonce`, it replaces the unconditional `ModifyInstanceAttribute` Deny with three statements: Allow when `ec2:Attribute` = `userData`, Deny when any `ec2:Attribute` value is not `userData` (`ForAnyValue:StringNotEquals`), and Deny when `ec2:Attribute` is Null. |

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
| Burstable launches never bill surplus credits | T3/T3a default to `unlimited`. Every T-type launch takes the `runBurstableInstances` graph state, which forwards `CreditSpecification {CpuCredits: standard}`; non-T launches take `runInstances`, which cannot forward it. The launch template may not carry a credit option (validator allow-list). | `lifecycle.test.ts` (free-tier tests, graph test), `lifecycle-aws.test.ts` (SDK wire form) |
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
| C-3: errors | EC2 errors are recorded at `$.ctl.lastError`, observation errors at `$.ctl.observeError` (neither overwrites the other); terminals record both. Capacity and quota errors go to `LifecycleRefused` with the code. Throttling backs off and retries (max 5). These are observed: timeouts, 5xx and InternalError/ServiceUnavailable, transport failures (no HTTP response, connection reset), and a generic `States.TaskFailed` without a status code. Any other EC2 error fails fast to `Rejected` (`LifecycleUnconfirmed`) with the code. | `lifecycle.test.ts` |
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

**UNVERIFIED:** the npm dataset `@cloud-copilot/iam-data` (0.21.202610131), built from the
IAM service reference, lists `ec2:KmsKeyId` for `CreateVolume` but not for the `volume`
resource of `RunInstances`. A reviewer recalls it may be listed there. Staging must settle it. A condition on a key that is never present would deny every
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
npm run synth:identity   # I5 deploy identity, config/identity.example.json
npm run synth:ops        # I6 ops guardrails, config/ops.example.json
npm run synth:all        # all four
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
- **`ec2:KmsKeyId` on the RunInstances volume resource.** Check whether this key is
  evaluated for a launch. If it is, add `ArnEquals ec2:KmsKeyId` = the data key to the root-volume
  statement and close the `aws/ebs` gap described above.
- **Tag on create.** CloudFormation must create the VPC, subnet, IGW, route table, security
  group and launch template with tags in the create call, so that `aws:RequestTag` and
  `ec2:CreateAction` are present. Otherwise the scoped boundary denies the create; the fix
  would be explicit `TagSpecifications`, never a wider grant.
- **CMK-encrypted state machine.** `CreateStateMachine` with a CMK needs `kms:GenerateDataKey`
  and `Decrypt` on the namespace-tagged history key, both for the execution role and for the
  state machine role.
- **External keys.** The data and authority keys must carry `ezil:namespace=<ns>`; check that
  `CreateGrant`, `Decrypt` through Secrets Manager, and EBS encryption then succeed.
- **Alarm-action key.** Confirm that `cloudwatch:AlarmActions` also covers the OK and
  INSUFFICIENT_DATA action lists. Otherwise, add explicit denies for those lists once the
  matching keys are confirmed.
- **Unscopable reads.** Confirm no further read action turns out unscopable. Add any that do to
  `UNSCOPABLE` with a reason.
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

## CI

`.github/workflows/ci.yml` job `computer-infrastructure` runs `bash tools/test.sh infra`. Its check
name is `computer infrastructure (typecheck + test + synth)`.
- **When:** on every pull request and on every push to main.
- **Node:** pinned to `24.15.0`, the Lambda runtime. Main's other jobs pin `22.16.0`; this
  suite has not been run on 22.
- **Credentials:** none. The job has no secrets, no environment and no AWS credentials.
- **Required check:** making it required is a ruleset change, which is founder-only.

## Deploy identity (I5): no CDK bootstrap (decision)

**Decision.** No `cdk bootstrap`. The identity stack carries its own pieces:
- an encrypted, versioned, private asset bucket
- one execution role for CloudFormation
- one GitHub OIDC deploy role
- the permission boundary

Workload stacks are deployed with `aws cloudformation deploy --role-arn <exec role>`.

**Why this is smaller and safer:**
- **Fewer, unreviewed resources with bootstrap.** A custom bootstrap creates five roles
  (deploy, file publishing, image publishing, lookup, CFN execution), an ECR repository, an
  SSM version parameter and a bucket. They come from a CDK-owned template we do not review
  line by line. The deploy role trusts the account root and is broad by default. Its CFN
  execution role defaults to `AdministratorAccess` unless every bootstrap is run with the
  right flags.
- **Every grant is tested here.** Without bootstrap there are 3 IAM objects and 1 bucket,
  all in our template, all checked by exact-equality tests.
- **Small asset need.** Only the lifecycle stack has assets: two Lambda zips. It uses
  `CliCredentialsStackSynthesizer`, which writes to `s3://<asset bucket>/assets/` with the
  caller's own credentials. There are no publishing roles and no bootstrap version rule; a
  test asserts no `BootstrapVersion`.
- **Other stacks have no assets.** Foundation, ops and identity use `BootstraplessSynthesizer`.

**Namespaces.** A namespace is lowercase letters and digits only, with no `-`, so
`ezil-<ns>-*` can never match another namespace's names. Reserved names are refused:
`identity`, `operators`, `ops` and the other names in `RESERVED_NAMESPACES`. Without that rule,
a namespace called `identity` would make the workload path equal `/ezil/identity/`. State
machines must be named `ezil-<ns>-*`.

**Boundary: a resource-scoped allowlist.** It is attached to:
- the deploy role
- the execution role
- every workload role (an aspect puts them under `/ezil/<ns>/` with the boundary and tags every
  resource `ezil:namespace=<ns>`)

A role CI plants under `/ezil/<ns>/` inherits exactly this ceiling, so every allow is scoped:
- **By name.** `states`, `lambda`, `logs`, `sqs`, `events`, `cloudwatch`, ECR and CloudFormation
  apply only to `ezil-<ns>-*` resources. `CreateChangeSet` additionally requires
  `cloudformation:RoleArn` = the execution role.
- **By name, for secrets.** `secretsmanager` reads cover only `secret:ezil/<ns>/*`; the
  lifecycle schema enforces that the authority secret is named that way. There is no `sns`.
- **By tag, for KMS.** `CreateKey` needs `aws:RequestTag/ezil:namespace=<ns>`. Every other key
  action, including `PutKeyPolicy`, `CreateGrant`, `Decrypt` and `TagResource`, needs the key to
  already carry that tag. **The data key and the authority key, which are created outside
  these stacks, must be tagged `ezil:namespace=<ns>`.**
- **By tag, for EC2 networks.**
  - A top-level create needs the request tag.
  - A subnet, route table or security group create needs the request tag *and* a parent VPC
    already tagged for the namespace.
  - A mutation needs the resource tag.
- **By tag, for EC2 compute.**
  - A launch or `CreateVolume` needs the compute request tags (`ezil:managed-by` and
    `ezil:stage=<ns>`).
  - A launch may go only into namespace-tagged subnets, security groups and launch templates.
    AMIs are not tag-scoped; the controller pins the AMI ID.
  - A volume can be restored only from a snapshot tagged `ezil:backup=<ns>`.
  - Start, stop, terminate and attach need the compute resource tags.
  - **No attribute change after launch.** `ec2:ModifyInstanceAttribute` is denied outright
    (`NoModifyInstanceAttribute`), so no bounded role can stop a computer, change its instance
    type and start it past the launch-time type cap. With `userDataAttributeKeyVerified: true`
    in the identity config (set it only together with the lifecycle's `userDataNonce` and
    `userDataAttributeKeyVerified`, after the staging proof below), the only carve-out is
    `ec2:Attribute` = `userData` on compute-tagged instances (`AllowUserDataOnlyOnManaged`);
    any other or missing attribute is denied (`ModifyAttributeOnlyUserData`,
    `ModifyAttributeKeyRequired`).
  - **Cost caps**, duplicated from the controller so a planted role is bounded too:
    - launches only with `ec2:InstanceType` in {t3a.medium, t3.medium, m6i.large, c6i.xlarge}
    - volumes only gp3, encrypted, and at most `maxVolumeGiB` (identity config, default 100)
- **No alarm actions (alarm-action list only, verified in code; OK and INSUFFICIENT_DATA
  lists UNVERIFIED).** `NoAlarmAutomation` denies `PutMetricAlarm` and `PutCompositeAlarm`
  when `cloudwatch:AlarmActions` names `arn:aws:automate:*` or `arn:aws:ssm*`, and
  `NoAlarmActions` denies any request that carries `cloudwatch:AlarmActions`. Both key only on
  `cloudwatch:AlarmActions`. Whether AWS also populates that key for `OKActions` and
  `InsufficientDataActions` is not yet proven: an alarm whose only actions are OK or
  INSUFFICIENT_DATA actions may not be denied. That is the "Alarm-action key" staging proof
  below; until it passes, do not rely on these denies for those two lists. Alarms with actions
  live only in the founder-deployed ops stack.
- **No adoption.** `CreateTags` is allowed only on create (`ec2:CreateAction`) or on resources
  that already carry the namespace or compute tags, so a foreign resource can never be tagged
  into the namespace.
- **The asset bucket**, role writes under `/ezil/<ns>/`, and `PassRole` on workload roles and
  the execution role.

**`*` allows.**
- **Read-only wildcards.** `ec2:Describe*`, `iam:Get*` and `iam:List*`. Some of the actions they
  match are resource-typed; listing them one by one buys nothing for reads.
- **The one secret-bearing read is excluded.** `ec2:DescribeInstanceAttribute` exposes
  `userData`, which carries the enrollment nonce. It is denied on every instance whose
  `ezil:stage` is not this namespace (`NoForeignInstanceAttributes`).
- **No resource type at all** (IAM service reference), so these cannot be scoped:
  - `kms:ListAliases`
- `logs:DescribeLogGroups` and the log-delivery and Logs resource-policy actions: Step Functions
  execution logging needs them. Their blast radius is CloudWatch Logs delivery.
- `cloudformation:ValidateTemplate`: no side effects.

It **denies**, explicitly:
- any region but the configured one (`iam:*` is the only exemption)
- users, groups, MFA devices, login profiles, access keys and other credentials
- boundary removal
- role writes whose role lacks this boundary
- attaching any managed policy except `AWSLambdaBasicExecutionRole`
- every IAM policy write
- `PassRole` and `sts:AssumeRole` outside the namespace
- OIDC and SAML provider writes
- volume or snapshot deletion, detach and `DeleteTags`
- the `ezil:backup` tag except at creation
- `organizations:*`, and account and billing writes
- route53, cloudfront and budgets writes
- purchases and reservations
- **the kill switch**, when the founder sets it

A role **trust policy naming an external principal** cannot be blocked by a condition key: IAM
exposes no key for the principals in `CreateRole` or `UpdateAssumeRolePolicy`. What contains
it:
- only the execution role can write roles, and only through reviewed templates
- every such role is bounded, so the boundary still caps an outside principal that assumes it
- the IAM snapshot test would show any new trust statement

**Deploy role.** Its trust is `token.actions.githubusercontent.com` with
`aud=sts.amazonaws.com` and the immutable-ID subject `...:environment:aws-pilot`. Sessions last
at most 1 h. It can only:
- create, describe and execute change sets on `ezil-<ns>-*` stacks, and only with
  `cloudformation:RoleArn` = the execution role
- pass that one role to CloudFormation
- read and write `assets/` and `templates/` in the bucket

**Execution role.** It covers exactly the foundation, lifecycle and app-caller stacks; a test
fails on any unmapped resource type.
- EC2 network and launch-template creates need `aws:RequestTag/ezil:namespace=<ns>`.
- Mutations of existing EC2 resources need the same `aws:ResourceTag`.
- `CreateTags` is allowed only on create.
- KMS `CreateKey` needs the namespace tag on the request, and the other key writes (including
  `PutKeyPolicy`) need it on the key.
- Logs, states, lambda, events, alarms, SQS and ECR are scoped to `ezil-<ns>-*` names.
- Every role write that can carry `iam:PermissionsBoundary` requires this boundary.
- It may attach, detach and list exactly `AWSLambdaBasicExecutionRole`, which CDK puts on
  Lambda roles; a test resolves the managed ARNs in the template.
- It holds **no** `dlm`, `budgets` or `sns` rights and no IAM policy writes.

The exact action lists are a best effort; the first staging deploy will show any missing read
action. Add each one deliberately, and never widen to a service `*`.

### Escalation paths

Each row gives the ceiling of two principals:
- **exec:** the execution role
- **planted:** a role CI creates under `/ezil/<ns>/` with any inline policy, passed to a
  namespace Lambda or state machine

Both are capped by the boundary. Today the account is empty in the pilot region, so the
"planted" rows matter once another workload shares the region.

| Path | exec | planted role |
|---|---|---|
| A namespace named `identity` aliases `/ezil/identity/` | BLOCKED (`NamespaceSchema` reserved names) | n/a |
| `ezil-pilot-*` matches another namespace | BLOCKED (no `-` in namespaces) | BLOCKED (same) |
| Edit the boundary or the deploy/exec roles | BLOCKED (`IamWritesOnlyUnderWorkloadPath`; no policy writes) | BLOCKED (same) |
| Create or edit a role without the boundary, or attach Administrator | BLOCKED (`RolesCarryThisBoundary`, `OnlyLambdaBasicManagedPolicy`) | BLOCKED (same) |
| Pass or assume a role outside the namespace | BLOCKED (`PassOnlyWorkloadAndExecRoles`, `AssumeOnlyWorkloadRoles`) | BLOCKED (same) |
| Users, keys, OIDC/SAML providers | BLOCKED (explicit denies) | BLOCKED (same) |
| Read another workload's secret | BLOCKED (exec has no secrets) | Only `secret:ezil/<ns>/*` (`AllowNamespaceSecrets`) |
| Use, re-policy or grant on a foreign KMS key | BLOCKED (tag-conditioned) | Only keys tagged `ezil:namespace=<ns>` (`AllowKmsOnNamespaceKeys`) |
| Change foreign Lambda code, state machines, queues, rules, alarms | BLOCKED (`ezil-<ns>-*` names) | Only `ezil-<ns>-*` (`AllowNamespacedWorkloadResources`) |
| Change sets on a foreign stack, or with another role | BLOCKED (deploy-role conditions) | Only `ezil-<ns>-*` stacks, only with the exec role (`AllowChangeSetsOnlyViaExec`) |
| Terminate or start a foreign instance | n/a (exec has no compute) | Only `managed-by` + `stage=<ns>` (`AllowComputeOnManaged`) |
| Stop a managed instance, change its type (or any attribute) and start it | n/a | BLOCKED (`NoModifyInstanceAttribute`; with the userData flag on, only `ec2:Attribute=userData` is allowed) |
| Mutate a foreign VPC, or create inside it | BLOCKED (tag conditions) | Only namespace-tagged network (`AllowEc2NetworkMutateTagged`, `AllowEc2CreateOnlyInNamespaceVpc`) |
| Restore a volume from a foreign snapshot | n/a | Only `ezil:backup=<ns>` snapshots (`AllowRestoreNamespaceSnapshots`) |
| Adopt a foreign resource by tagging it | BLOCKED (tag on create only) | BLOCKED (`AllowTagOnCreate`, retag only already-tagged; `BackupTagOnlyAtCreation`) |
| Attach EC2 terminate/stop automation to an alarm on any instance | n/a (lifecycle alarms carry no actions) | BLOCKED for the alarm-action list (`NoAlarmAutomation`, `NoAlarmActions`); OK / INSUFFICIENT_DATA lists unverified (staging proof) |
| Launch large instances or huge volumes | n/a | BLOCKED (`AllowLaunchAllowlistedTypes`, `AllowCappedEncryptedGp3Volumes`) |
| Read a foreign instance's userData | BLOCKED (`NoForeignInstanceAttributes`) | BLOCKED (same) |
| Launch inside the namespace with any AMI | n/a | **Residual:** AMIs are not tag-scoped. The instance is still namespace-tagged, namespace-networked and bounded. |
| Change DLM, budgets, or the boundary kill switch | BLOCKED (founder-only ops and identity; no `dlm`, `budgets` or policy writes) | BLOCKED (same) |
| Account-wide CloudWatch Logs resource policy | `logs:PutResourcePolicy` on `*` (unscopable; Step Functions logging) | **Residual:** same; it only affects Logs delivery |
| Trust policy naming an outside principal | **Residual:** not expressible as a condition. Contained by exec-only role writes, the boundary, and the snapshot test. | Same |

## Founder bootstrap (run once, not by CI)

**Identity.** The founder runs this once, with **their own administrator session**: an IAM
Identity Center `AdministratorAccess` permission-set session with MFA, in the target account.
Never the root user, and never a CI role. The same applies to the **ops stack**: DLM, budgets
and the kill switch are founder change sets only, because they sit outside the boundary.

**No prior deployment.** The foundation stack is now `ezil-<ns>-foundation` (it was
`EzilAppComputers-<stage>`). The lead verified on 2026-10-13 that ap-south-1 is empty and that
us-east-1 holds only the CI runner, so no deployed stack has the old name.

```sh
aws sts get-caller-identity              # must NOT end in :root
cd infra/app-computers && npm ci
cp config/identity.example.json config/identity.pilot.json   # gitignored; never committed
#   set accountId, deploySubject (repo:<org>@<orgId>/<repo>@<repoId>:environment:aws-pilot),
#   assetBucketName, and the existing GitHub OIDC provider ARN
# 1. Offline synth: the script unsets AWS_* credentials and blanks the config files
EZIL_IDENTITY_CONFIG=config/identity.pilot.json npm run synth:identity
# 2. Create the change set, review it, then execute it
aws cloudformation create-change-set --region ap-south-1 --stack-name ezil-identity-pilot \
  --change-set-name identity-1 --change-set-type CREATE --capabilities CAPABILITY_NAMED_IAM \
  --template-body file://cdk.out/identity/ezil-identity-pilot.template.json
aws cloudformation wait change-set-create-complete --region ap-south-1 \
  --stack-name ezil-identity-pilot --change-set-name identity-1
aws cloudformation describe-change-set --region ap-south-1 \
  --stack-name ezil-identity-pilot --change-set-name identity-1     # review every resource
aws cloudformation execute-change-set --region ap-south-1 \
  --stack-name ezil-identity-pilot --change-set-name identity-1
aws cloudformation update-termination-protection --region ap-south-1 \
  --stack-name ezil-identity-pilot --enable-termination-protection
aws cloudformation describe-stacks --region ap-south-1 --stack-name ezil-identity-pilot \
  --query 'Stacks[0].Outputs'
# 3. Ops (founder only): the AWS-managed DLM role if absent, then a reviewed change set
aws iam get-role --role-name AWSDataLifecycleManagerDefaultRole >/dev/null 2>&1 \
  || aws dlm create-default-role --resource-type snapshot --region ap-south-1
cp config/ops.example.json config/ops.pilot.json && EZIL_OPS_CONFIG=config/ops.pilot.json npm run synth:ops
#   then create-change-set / wait / describe / execute exactly as above, with
#   stack ezil-pilot-ops, template cdk.out/ops/ezil-pilot-ops.template.json, CAPABILITY_NAMED_IAM
```

**GitHub.** Create environment `aws-pilot` with required reviewers. Store the `DeployRoleArn`,
`ExecRoleArn` and `AssetBucketName` outputs as environment *variables*; none of them is secret.

**Required check.** Making the CI check required is a GitHub ruleset change, which is
founder-only. `tools/triage.ts` `REQUIRED_CONTEXTS` mirrors the *live* ruleset and is compared
with it, so it is updated only after the ruleset changes.

**Workload deploys** (foundation, then lifecycle; a future gated workflow or the founder, not
this round). They run as the deploy role, through a reviewed change set. Paths match the npm
synth scripts:

```sh
EZIL_LIFECYCLE_CONFIG=config/lifecycle.pilot.json npm run synth:lifecycle
EZIL_LIFECYCLE_CONFIG=config/lifecycle.pilot.json npx cdk publish-assets ezil-pilot-lifecycle \
  --app cdk.out/lifecycle --no-lookups --no-notices          # Lambda zips -> s3://<bucket>/assets/
aws s3 cp cdk.out/lifecycle/ezil-pilot-lifecycle.template.json \
  s3://<AssetBucketName>/templates/ezil-pilot-lifecycle-<git-sha>.json
aws cloudformation create-change-set --region ap-south-1 --stack-name ezil-pilot-lifecycle \
  --change-set-name lifecycle-<git-sha> --change-set-type CREATE \
  --template-url https://<AssetBucketName>.s3.ap-south-1.amazonaws.com/templates/ezil-pilot-lifecycle-<git-sha>.json \
  --role-arn <ExecRoleArn> --capabilities CAPABILITY_IAM
aws cloudformation wait change-set-create-complete --region ap-south-1 \
  --stack-name ezil-pilot-lifecycle --change-set-name lifecycle-<git-sha>
aws cloudformation describe-change-set --region ap-south-1 \
  --stack-name ezil-pilot-lifecycle --change-set-name lifecycle-<git-sha>    # review
aws cloudformation execute-change-set --region ap-south-1 \
  --stack-name ezil-pilot-lifecycle --change-set-name lifecycle-<git-sha>
```

- Use `--change-set-type UPDATE` for later changes.
- The lifecycle template is over 51 kB, so it goes through S3.
- The foundation stack has no assets: it follows the same steps without `publish-assets`, with
  `cdk.out/foundation/ezil-pilot-foundation.template.json`.

## Ops guardrails (I6)

- **Snapshots.**
  - **Schedule.** DLM takes a snapshot every 12 hours and keeps 14 (7 days rolling).
  - **Targets.** Volumes tagged `ezil:backup=<namespace>`. The lifecycle sets that tag only
    when it creates a data volume, so root disks are never snapshotted.
  - **Role.** It runs as the AWS-managed `AWSDataLifecycleManagerDefaultRole`. That role is
    deliberately outside the boundary, because DLM must delete the snapshots it rotates and the
    boundary denies `DeleteSnapshot`. It acts only on snapshots its own policies created.
- **Egress backstop.**
  - **Alarm.** One alarm on `MAX(NetworkOut)` over every instance in the region, per 5 minutes.
    It fires when any single instance exceeds `egressBytesPer5Min`.
  - **Delivery.** Alerts go to the SNS topic `ezil-<ns>-ops-alerts`, which the app can
    subscribe to. Publishers are conditioned on `aws:SourceAccount` and `aws:SourceArn`. The
    topic is unencrypted on purpose: CloudWatch and Budgets cannot publish to an
    `aws/sns`-encrypted topic, and alerts carry no user data.
  - **Not done this round:** no automatic stop.
- **Budget.** Alerts at 50, 80 and 100 % of `monthlyBudgetUsd`, on actual spend, to the topic
  and optional emails. Alerts only.
- **Retention (§6).**
  - Automation never deletes a volume.
  - A RETIRED computer keeps its retained data volume, and with it the rolling 7-day DLM
    snapshots, until an operator purges it.
  - Purge must wait 14 days after RETIRED.
  - Snapshot retention therefore follows the volume. A separate retired-only, age-based
    policy (`ezil:retired=<ns>`, 14 days) needs a retire-time tag, and the lifecycle IAM cannot
    set one today (retag is limited to generation and fence). That is an open item.

### Kill-switch drill (§4)

**Authoritative switch.** It lives in the boundary. Set `"killSwitch": true` in the identity
config and update the identity stack through a founder change set. The boundary then denies
these to **every bounded role, including roles created later**:
- `RunInstances`, `StartInstances`, `AttachVolume`, `CreateVolume`, `CreateFleet` and
  `RequestSpot*`
- `states:StartExecution`, `StartSyncExecution` and `RedriveExecution`
- `lambda:InvokeFunction` and `events:PutTargets`

Workload deploys that touch rule targets fail while it is set. The attachable ops policy below
is an extra.


The ops stack outputs a managed policy, `ezil-<ns>-kill-switch`, in `/ezil/operators/`.

It is **authoritative only because the founder deploys and attaches it**: no bounded principal
can create, change, attach or detach it. It denies:
- `RunInstances`, `StartInstances`, `AttachVolume` and `CreateVolume`
- `CreateFleet` and `RequestSpot*`
- `states:StartExecution`, `StartSyncExecution` and `RedriveExecution`

It never denies `StopInstances` and never touches storage. To run the drill:

1. **Admission off.** Set `EZIL_AWS_KILL_SWITCH=1` in the app environment.
2. **Disable recovery.**
   - `aws events disable-rule --name ezil-<ns>-recovery-interrupted`
   - `aws events disable-rule --name ezil-<ns>-recovery-backstop`
3. **Attach the policy** to the lifecycle controller role and the reconciler role (role names
   are in the lifecycle stack resources):
   ```sh
   aws iam attach-role-policy --role-name <ControllerRole> --policy-arn <KillSwitchPolicyArn>
   aws iam attach-role-policy --role-name <ReconcilerServiceRole> --policy-arn <KillSwitchPolicyArn>
   ```
4. **Graceful stop.** Issue a lifecycle `stop` intent for each running computer; the controller
   keeps `StopInstances`. Fallback: `aws ec2 stop-instances --instance-ids ...`, never with
   `--force`.
5. **Verify.**
   - The count from `aws ec2 describe-volumes --filters Name=tag:ezil:backup,Values=<ns>
     --query 'length(Volumes)'` is unchanged from before step 1.
   - Every instance is `stopped`.
   - A start attempt fails with AccessDenied.
6. **Lift.** Detach the policy, re-enable both rules, then unset the kill switch.

### Purge operator role (TODO design; not created this round)

Purge runs per computer from the M1 tooling, after the 14-day retention:
- **Who.** A human operator role with MFA, created by the founder outside the boundary (the
  boundary denies deletion).
- **Audit.** Every call is recorded by CloudTrail.

Proposed trust, conditioned on MFA, on an Identity Center admin session, and on a 1 h session:

```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": "sts:AssumeRole",
  "Principal": { "AWS": "arn:aws:iam::<account>:root" },
  "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" },
    "NumericLessThan": { "aws:MultiFactorAuthAge": "3600" },
    "ArnLike": { "aws:PrincipalArn": "arn:aws:iam::<account>:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_AdministratorAccess_*" } } }] }
```

Proposed policy (path `/ezil/operators/`, name `ezil-<ns>-purge`):

```json
{ "Version": "2012-10-17", "Statement": [
  { "Sid": "Read", "Effect": "Allow", "Action": ["ec2:DescribeVolumes", "ec2:DescribeSnapshots"], "Resource": "*",
    "Condition": { "StringEquals": { "aws:RequestedRegion": "<region>" } } },
  { "Sid": "PurgeManagedVolumes", "Effect": "Allow", "Action": "ec2:DeleteVolume",
    "Resource": "arn:aws:ec2:<region>:<account>:volume/*",
    "Condition": { "StringEquals": { "aws:RequestedRegion": "<region>",
      "ec2:ResourceTag/ezil:managed-by": "app-computer-platform", "ec2:ResourceTag/ezil:stage": "<ns>" } } },
  { "Sid": "PurgeManagedSnapshots", "Effect": "Allow", "Action": "ec2:DeleteSnapshot",
    "Resource": "arn:aws:ec2:<region>::snapshot/*",
    "Condition": { "StringEquals": { "aws:RequestedRegion": "<region>", "ec2:ResourceTag/ezil:backup": "<ns>" } } }
] }
```

Snapshots inherit `ezil:backup` because the DLM policy sets `copyTags`.

References:
- [Preserve data when an instance is terminated](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/preserving-volumes-on-termination.html):
  a data volume attached after launch is preserved by default.
- [EC2 condition keys](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonec2.html):
  `ec2:AvailabilityZoneId`, `ec2:MetadataHttpTokens`, `ec2:InstanceMetadataTags`,
  `ec2:InstanceProfile` and `ec2:CreateAction`.
