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

## Security posture (what the tests prove)

| Rule | Where | Test |
|---|---|---|
| R1: ZoneId only; no zone names, no `Fn::GetAZs` | L1 `CfnSubnet({availabilityZoneId})`; `CreateVolume.AvailabilityZoneId`; IAM `ec2:AvailabilityZoneId` | `foundation.test.ts` item 1, `lifecycle-infra.test.ts` |
| R10: closed type allowlist | IAM `StringEquals ec2:InstanceType` (no `IfExists`); helper rejects other types | item 2 |
| No type change after launch | `ModifyInstanceAttribute` absent and explicitly denied | item 2 |
| R5: no host credentials | no instance role or profile, no `iam:PassRole`; `RunInstances` requires `Null ec2:InstanceProfile` | item 3 |
| R5: IMDS | `HttpTokens=required`, hop limit 1, `InstanceMetadataTags=disabled`, in the template, the launch call and IAM conditions | item 4 |
| R6: network | no ingress, all egress, no NAT, no load balancer | item 4 |
| R3/R12: storage | every EBS volume is encrypted; the data disk's `DeleteOnTermination=false` is verified and fails closed; hibernation off | items 4–5 |
| R11: sizes and deletion | size range in IAM and validation; no `DeleteVolume`, `DeleteSnapshot`, `DetachVolume` or `DeleteTags` (explicit deny) | items 5–6 |
| Tag integrity | identity tags only with `ec2:CreateAction`; retag limited to `ezil:generation` and `ezil:fence-token` | item 6 |
| C-3: errors | recorded at `$.ctl.lastError`; capacity and quota end in `LifecycleRefused` carrying the code; throttling backs off and retries (max 5) | item 7 |
| Terminate guard | any disk beyond root plus this computer's data disk blocks `TerminateInstances` | item 8 |

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
- **EC2 state-change EventBridge rule** to the app API destination (R7) is not built.
- **Capacity refusals and recovery.** A capacity refusal after `CreateVolume` leaves a retained
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
