# Lower-attestation maintenance host role and instance profile (R5 exception)

This document authorizes nothing. Root Native62 is the only writer: it runs every AWS command below, and only after a specific GO. Launching a profiled maintenance host stays **blocked** until the stack is read back and qualified under this contract.

## What it is
- A routine R5 exception, qualified by Root. It is not a general enablement of instance profiles.
  - Customer and pool hosts still launch with no instance role or profile.
  - The lifecycle's `RunInstances` still requires `Null ec2:InstanceProfile` (`infra/app-computers/lib/computer-lifecycle.ts:157`).
- The profile may be attached only by the operator's `RunInstances`, and only to a **fresh** maintenance host for one lower-attestation reservation (runbook step 4). That is allowed only after this role and profile pass read-back and the template and plan are qualified.
- The attestation CLI, the verifier and the host measurement are unchanged.
- **The verifier does not pin the IAM profile.**
  - `RunInstancesEventSchema` passes `requestParameters` through. `launchRecordOf` reads only `launchTemplate` and the presence of `userData` (`app/src/server/lib/compute/aws-lower-attestation.ts`, around line 250).
  - So a profile on the launch is neither required nor refused by the proof. This contract and Root's launch gate are the only control on which profile a maintenance host carries.

## Exactly two resources
`attest-maintenance-iam.template.json`, pinned by sha256 in `attest_maintenance_iam.py`:

| Logical id | Type | Physical |
|---|---|---|
| `MaintenanceRole` | `AWS::IAM::Role` | `arn:aws:iam::452630323510:role/ezil/r5-attestation/ezil-attest-maintenance-host` |
| `MaintenanceInstanceProfile` | `AWS::IAM::InstanceProfile` | `arn:aws:iam::452630323510:instance-profile/ezil/r5-attestation/ezil-attest-maintenance-host` |

- **Stack:** `attest-maintenance-iam-mum` in ap-south-1, account 452630323510.
  - It has no parameters, no stack role (`--role-arn`) and no stack tags.
  - It is created with `CAPABILITY_NAMED_IAM`.
- **Role.** Trust: `ec2.amazonaws.com`, `sts:AssumeRole`, with no condition.
  - EC2 does not supply `aws:SourceArn` or `aws:SourceAccount` for an instance role, so none is invented.
- **Role settings:**
  - No managed policy and no permissions boundary.
  - `MaxSessionDuration` 3600.
  - Tags `ezil:purpose=attest-maintenance-host`, `ezil:exception=r5-fresh-attestation-host-only`, `ezil:attestation-namespace=mum`.
- **Profile:** holds exactly this role. CloudFormation's `InstanceProfile` has no Tags property.

### Inline policy `ssm-agent-channels-only`
Every statement requires `aws:RequestedRegion = ap-south-1`.

| Sid | Actions | Resource |
|---|---|---|
| `AgentRegistration` | `ssm:UpdateInstanceInformation` | `arn:aws:ec2:ap-south-1:452630323510:instance/*` |
| `AgentChannels` | `ssmmessages:CreateControlChannel`, `CreateDataChannel`, `OpenControlChannel` | `*` |
| `AgentDataChannel` | `ssmmessages:OpenDataChannel` | `arn:aws:ssm:ap-south-1:452630323510:session/*` |

**Where the resource scoping comes from.** The AWS service reference (v1) JSON for `ssm` and `ssmmessages` gives each action's resource types:
- `UpdateInstanceInformation` names `instance` and `managed-instance`. Only the EC2 `instance` ARN applies; `managed-instance` is for hybrid nodes.
- `OpenDataChannel` names `session`.
- The other three name no resource type, so `*` is the only possible resource for them.

**What the role does not grant:**
- `AmazonSSMManagedInstanceCore`;
- `ec2messages:*`;
- `ssm:GetParameter*`, `ssm:SendCommand`, `ssm:StartSession`;
- Secrets Manager, S3, ECR, KMS, IAM, STS beyond the trust, and any EC2 write.

**Why the names sit outside existing grants.** The role path and stack name are chosen so that no existing grant pattern reaches them:
- **exec and deploy roles:** they may write and pass only `role/ezil/<ns>/*` and are denied everything else (`infra/app-computers/lib/identity.ts:71`, `:204`, `:205`). A namespace matches `^[a-z][a-z0-9]{0,20}$`, so it can never contain `r5-attestation`.
- **GitHub OIDC deploy role:** its change sets are scoped to `stack/ezil-<ns>-*` (`identity.ts:67`, `:335`). This stack name does not start with `ezil-`.
- **Tags:** no IAM grant is conditioned on the role's tag keys.

## Procedure (Root only)
Run from the repository root at the reviewed commit:

```
python3 deploy/aws/mum/attest_maintenance_iam.py plan
```

This prints `planSha256` and every argv:
- It pins `--profile ezil-admin --region ap-south-1`.
- Nothing is executed.
- The plan is deterministic: no clock, host path or credential goes into it.
- The change set is named `attest-maint-<first 16 hex of the template sha256>`.

1. **Preflight.**
   - `sts get-caller-identity` returns 452630323510.
   - `iam get-role` and `iam get-instance-profile` on the name both fail with `NoSuchEntity`.
   - `describe-stacks` reports that the stack does not exist.
2. **Create the change set:** `create-change-set --change-set-type CREATE`, then wait.
3. **Inspect.** Save `changeset.json`, `submitted.json` and `stack.json` from the plan's argv, then run `verify-changeset --dir D --plan-sha256 P`. It refuses unless all of these hold:
   - The stack, account and region are exact, and the change set name is exact.
   - Status is `CREATE_COMPLETE` / `AVAILABLE`.
   - Capabilities are exactly `CAPABILITY_NAMED_IAM`.
   - No parameters, tags, stack role, notifications, nested stacks or import-existing.
   - Exactly two changes, both `Add`, with no replacement, physical id, scope or details. They must be the two declared logical ids and types.
   - The submitted template equals the pinned template.
   - The stack is new (`REVIEW_IN_PROGRESS`, no outputs, no role).
   - The plan sha is current.
4. **Execute (Root's specific GO):** `execute-change-set`, then wait for `stack-create-complete`.
5. **Read back.**
   - Run `detect-stack-drift` and wait for `DETECTION_COMPLETE`.
   - Save the readback files from the plan's argv.
   - Run `verify-readback --dir D --plan-sha256 P`. It requires:
     - **Stack:** `CREATE_COMPLETE` with no role, no parameters and exactly the two outputs.
     - **Stack resources:** exactly the two resources.
     - **Role:**
       - path, name, ARN and a role id;
       - the trust and inline policy match the canonical sha256 pins (statement order and action case are ignored);
       - exactly one inline policy name;
       - **zero** attached managed policies;
       - **no** boundary;
       - the tags.
     - **Profile:**
       - It holds exactly one role, matched by **RoleId**. A same-name role that was deleted and recreated is refused.
       - The role is in exactly this one profile.
     - **Lists:** none is truncated.
     - **Drift:** the role must be `IN_SYNC`. The profile may be `IN_SYNC`, or `NOT_CHECKED` because its binding is read back directly.
   - The receipt carries the template, trust, policy and plan hashes plus the role and profile ids.

Rollback: delete the stack, but only once no instance carries the profile. Both resources use `DeletionPolicy: Delete`.

## Launch gates for each fresh maintenance host
These are additions to `docs/aws-computers/NULL-LOWER-ATTESTATION-RUNBOOK.md` step 4; everything in that step still applies.

1. **Before launch.** `ssm list-associations` in ap-south-1 must be empty.
   - Once the host registers, any State Manager association whose target matches would run userland on it before the proof. That includes Quick Setup, Inventory, patching, `AWS-UpdateSSMAgent`, and targets of `*` or a tag the host carries.
   - **The verifier does not see association executions.** It reads only `ListCommands` and `DescribeSessions`.
2. **The launching principal.**
   - It needs `iam:PassRole` on exactly the role ARN, with `iam:PassedToService = ec2.amazonaws.com`.
   - The exec, deploy and lifecycle roles cannot pass it, and must not be given that right.
3. **Launch.** Use the runbook's launch, adding only `--iam-instance-profile Arn=<profile ARN>`:
   - no user-data;
   - the registry launch template id and numeric version, and the pinned AMI;
   - IMDSv2;
   - the runbook tags.
4. **Ready, read-only only.** Save `associations.json`, `instance-information.json` and `effective-associations.json` from the plan's `host-ready` argv, then run `verify-host --dir D --instance-id I`. It requires:
   - account-wide associations empty;
   - exactly one registration, `EC2Instance`, `PingStatus` `Online`;
   - `AgentVersion` **at least 3.3.40.0**;
   - no effective association.
   AWS documents that SSM Agent 3.3.40.0 and later takes Run Command over `ssmmessages`. An older agent needs `ec2messages`, which is not granted: return that case to Root for a narrow decision, and never widen the policy in place.
5. **Fail closed.** If the agent does not register, is not Online, or is older than 3.3.40.0, abort the reservation and terminate the host, as the runbook's "Failure" section does. Never:
   - send a bootstrap or diagnostic command;
   - open a session;
   - add user-data;
   - reuse the host.
   Readiness comes from Describe and Ping only. The plan contains no `send-command`, `start-session`, `create-association` or `run-instances`.

## Known limits
- **AMI and agent.** The AMI's SSM Agent version and enablement are not baked into the AMI or asserted there. The parent image is Canonical Ubuntu 24.04, and the build never removes the agent, but that is not guest proof. Gate 4 is the only check.
- **Network path.** Registration needs network reachability to the `ssm` and `ssmmessages` endpoints from the launch template's subnet and security group. The profile cannot prove this. A host that never registers fails closed (gate 5).
- **Data-channel actions.** `CreateDataChannel` and `OpenDataChannel` are granted as briefed. Run Command does not need them. Removing them is Root's narrowing decision; it would change the template and policy pins.
- **No live validation.** The template was not checked by `cfn-lint` or `validate-template` (no linter is installed, and `validate-template` is a live call). The tests check its exact structure offline, and the change set is the first server-side validation.

## Offline tests
```
PYTHONDONTWRITEBYTECODE=1 python3 -B deploy/aws/mum/tests/attest_maintenance_iam.py -v
```
The tests use synthetic CLI JSON only: no AWS, credentials or network. Each refusal case starts from fixtures that pass, changes one field, and asserts its specific refusal.
