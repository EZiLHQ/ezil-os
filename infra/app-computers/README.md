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

**Boundary.** It is attached to:
- the deploy role
- the execution role
- every workload role (an aspect puts them under `/ezil/<ns>/` with the boundary)

It denies:
- any region but the configured one (global services exempt)
- creating users and access keys, and removing a boundary
- creating a role without this boundary
- IAM writes outside `/ezil/<ns>/` (the identity objects sit in `/ezil/identity/`, so CI
  cannot edit its own roles)
- `DeleteVolume`, `DeleteSnapshot`, `DetachVolume` and `DeleteTags`
- organizations, account and billing writes

**Deploy role.** Its trust is `token.actions.githubusercontent.com` with
`aud=sts.amazonaws.com` and the immutable-ID subject `...:environment:aws-pilot`. Sessions last
at most 1 h. It can only:
- create, describe and execute change sets on `ezil-<ns>-*` stacks, and only with
  `cloudformation:RoleArn` = the execution role
- pass that one role to CloudFormation
- read and write `assets/` and `templates/` in the bucket

**Execution role.** It is scoped to exactly the resource types the workload stacks create. A
test maps every type to its create action and fails on any unmapped type. It can create roles
only under `/ezil/<ns>/`, only with the boundary. The exact action lists are a best effort:
the first staging deploy will show any missing read action. Add each one deliberately; never
widen to a service `*`.

## Founder bootstrap (run once, not by CI)

**Identity.** The founder runs this once, with **their own administrator session**: an IAM
Identity Center `AdministratorAccess` permission-set session with MFA, in the target account.
Never the root user, and never a CI role. Every later deploy goes through the deploy role.

```sh
aws sts get-caller-identity              # must NOT end in :root
cd infra/app-computers && npm ci
cp config/identity.example.json config/identity.pilot.json
#   set accountId, deploySubject (repo:<org>@<orgId>/<repo>@<repoId>:environment:aws-pilot),
#   assetBucketName, and the existing GitHub OIDC provider ARN
# 1. The AWS-managed DLM role (once per account; used by the ops stack)
aws dlm create-default-role --resource-type snapshot --region ap-south-1
# 2. Synthesize offline and review the template
EZIL_IDENTITY_CONFIG=config/identity.pilot.json npx cdk synth --strict --no-lookups --no-notices -q \
  -o cdk.out/identity --app "npx tsx bin/identity.ts"
# 3. Create, review, then execute the change set
aws cloudformation deploy --region ap-south-1 --stack-name ezil-identity-pilot \
  --template-file cdk.out/identity/ezil-identity-pilot.template.json \
  --capabilities CAPABILITY_NAMED_IAM --no-execute-changeset
aws cloudformation describe-change-set --region ap-south-1 --stack-name ezil-identity-pilot \
  --change-set-name <name printed above>
aws cloudformation execute-change-set --region ap-south-1 --stack-name ezil-identity-pilot \
  --change-set-name <name printed above>
aws cloudformation update-termination-protection --region ap-south-1 \
  --stack-name ezil-identity-pilot --enable-termination-protection
aws cloudformation describe-stacks --region ap-south-1 --stack-name ezil-identity-pilot \
  --query 'Stacks[0].Outputs'
```

**GitHub.** Create environment `aws-pilot` with required reviewers. Store the `DeployRoleArn`,
`ExecRoleArn` and `AssetBucketName` outputs as environment *variables*; none of them is secret.

**Workload deploys** (a future gated workflow, or the founder; not this round). They run as the
deploy role, in order foundation → lifecycle → ops:

```sh
npx cdk publish-assets ezil-pilot-lifecycle --app "npx tsx bin/lifecycle.ts"   # EZIL_LIFECYCLE_CONFIG set
aws cloudformation deploy --region ap-south-1 --stack-name ezil-pilot-lifecycle \
  --template-file cdk.out/ezil-pilot-lifecycle.template.json --role-arn <ExecRoleArn> \
  --s3-bucket <AssetBucketName> --s3-prefix templates --capabilities CAPABILITY_IAM
```

The lifecycle template is over 51 kB, hence `--s3-bucket`. The foundation and ops stacks use the
same command without `publish-assets`. Ops needs `CAPABILITY_NAMED_IAM`, for the named
kill-switch policy.

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

The ops stack outputs a managed policy, `ezil-<ns>-kill-switch`. It denies:
- `RunInstances`
- `StartInstances`
- `AttachVolume`
- `states:StartExecution`

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
