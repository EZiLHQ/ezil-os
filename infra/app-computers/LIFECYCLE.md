# EC2 computer lifecycle workflow

This package contains the **actual Standard workflow** for provision, start,
stop, replacement, retirement and retained-disk recovery. It consumes immutable
v1 lifecycle intents and v2 recovery intents from the control plane. It is not deployed by the foundation entrypoint,
and it does not create an instance during synthesis. Reticle is not installed
by a successful lifecycle execution.

The trusted helper reads the original execution from Step Functions on every
step, verifies the exact numeric workflow version, job name, document digest,
account/network/image pins and original deadline, then checks current database
authority through `/api/internal/computers/lifecycle-authority`. The signed
request uses a separate Secrets Manager key; no user session is forwarded.
Authority is checked again after provider reads immediately before a mutation.

Only the Standard graph has EC2 mutation permissions. It uses fixed tasks with
server-derived parameters; caller-selected actions, scripts, instance IDs,
volume IDs and destinations are not accepted. All EC2 tasks have no automatic
retry. A lost response advances to observation. CreateVolume and RunInstances
may repeat only with the same SHA256 intent-derived ClientToken and exact
parameters. StartInstances has no ClientToken and is never blindly repeated.
Neither are stop, termination or attachment. Status reads cannot wake compute.

Provisioning creates a 50-GiB encrypted gp3 data disk in the approved AZ. It
starts one m7i.large using a numeric launch-template version, the approved
Linux/amd64 AMI and a 30-GiB encrypted disposable root disk. The AMI must have a
single `/dev/xvda` root device; additional implicit disks, user-data scripts,
network-interface overrides and unsupported launch-template fields fail.
Detailed monitoring is explicitly disabled. IMDSv2 is required with hop limit
one; app containers must not obtain the host role. Non-secret computer and
generation tags are available to the fixed host bootstrap.

An instance profile is derived as:

```
arn:aws:iam::<account>:instance-profile/ezil/<namespace>/computers/<computer UUID>/g<generation>
```

Its underlying role must use the corresponding role path. The controller can
pass only that namespace's writer roles to EC2. These profiles/roles must be
provisioned separately with narrow S3/KMS/Secrets Manager/ECR permissions. They
are not the workflow's control role. A new computer uses the shared workflow;
it does not require redeploying the graph.

The data disk attaches at the EC2 device mapping `/dev/sdf` and is explicitly
preserved with `DeleteOnTermination=false`. The host must resolve the real Nitro
NVMe device by volume identity, not assume the guest path is `/dev/sdf`. No app
is ready until the separate host mount guard confirms that disk.

Stop requests use normal OS shutdown (`Force=false`, `SkipOsShutdown=false`).
Replacement observes the old writer stopped, verifies preservation, terminates
it, waits for provider termination and disk detachment, and attaches the same
disk to the new generation. It never force-detaches or deletes a data volume.
Retirement terminates compute while retaining the detached volume. The database
writer is changed only by #122's independent provider-observation transaction.
A successful workflow output is a provider receipt, not a mounted-disk,
loaded-supervisor or installed-application receipt.

## Failure and activation boundary

The helper uses the original 15-minute execution deadline, with a final mutation
window and a 16-minute outer workflow timeout. Revocation, expired work,
unknown effects, failed observations and ambiguous allocation fail closed. The
control-plane consumer keeps the active reservation; it must not mark the job
terminal merely to allow another writer.

The optional recovery Standard workflow observes failed/timed-out/aborted
executions from the exact original numeric version. EventBridge notifications
and a five-minute backstop submit one deterministic cleanup execution per job.
Both paths default off. The helper verifies the original execution and its
complete terminal history before resolving exact historical resources. If an
allocation task was entered but its resource cannot yet be found, it waits;
it cannot infer that nothing was allocated. Truncated history fails closed.

Recovery preserves attached data disks, requests graceful stop, and observes
termination of each original writer. Termination positively fences a delayed
StartInstances request that could otherwise wake a supposedly stopped writer.
An interrupted replacement can have both an old and a newly allocated writer;
recovery handles only those identities and rejects newer generations. Missing
preservation evidence, unexpected attached disks, unknown effects and lost
mutation responses cannot produce a successful fencing receipt. Recovery never
launches, attaches, detaches, retags or deletes disks, and has no IAM permissions
for those actions. Its ten-minute deadline is fixed to its original execution.

**Control-plane recovery receipt consumption and explicit cancellation remain
required before activation.** The consumers in #124 and #126 independently
observe fencing and retained storage before settling the job. This cleanup only handles failed/timed-out/aborted
workflows. A revocation that races with successful workflow completion needs a
separate durable cancellation authorization; success must not itself trigger
historical cleanup. A failed recovery retains its reservation and raises an
alarm; failure does not mean compute has stopped. No data deletion is implemented.

Before activation also provide the reviewed supervisor AMI, per-writer host
profiles, scoped web OIDC federation, durable consumer scheduling and job intake.
Wire the existing configuration delivery workflow through actual loaded-host
observation. Validate IAM, same-AZ attachments, mount failures, stop/start,
replacement and stopped-compute evidence in the approved capped AWS pilot.

## Local validation and synthesis

From the repository root:

```
bash tools/test.sh infra
```

This runs TypeScript, the shipped graph against simulated provider effects,
actual SDK request serialization, authority signing, CDK assertions and the
existing foundation synth. It does not establish cloud permissions, isolation,
mounting, billing or an installed application.

To synthesize the lifecycle stack itself, supply a reviewed reference-only JSON
file to `EZIL_LIFECYCLE_CONFIG` and run `npm run synth:lifecycle` inside
`infra/app-computers`. Its fields are `settings`, `authorityKeyArn`, and optional
`notificationsEnabled` (default false). Supply `recoveryVersionArn` to synthesize
the recovery workflow and `recoveryEnabled: true` only after the required
control-plane integration and pilot review. Its default is false. `settings` contains shared `deployment`
pins from the intent **without** `instanceProfileArn`, `writerRolePathPrefix`,
`authorityOrigin` and `authoritySecretArn`. No credential values belong in it.
The emitted `WorkflowVersionArn` and `RecoveryVersionArn` must equal their
configured numeric versions before activation. Review a real CDK diff before rollout.

History/logs and failure queues use KMS encryption. Runtime logs default to seven
days; failure queues retain fourteen days. Preserve CloudTrail EC2/KMS events and
monitor the alarms during the pilot. The controller's IAM conditions use EC2
keys listed in AWS's policy catalog; actual account policy evaluation remains a
pilot check. Rollback denies new admission, reconciles original executions,
and retains volumes and immutable workflow versions.

## Retained-disk recovery (v2)

After confirmed failure cleanup, a v2 `recover` intent launches a new generation
against the computer's retained volume. It is not a provision request: a missing,
foreign, unencrypted or still-attached disk blocks launch. The original source
job/digest, retained disk scope and new generation are immutable control-plane
records. V1 document bytes and allocation tokens are unchanged.

Each helper invocation gets the historical writer list from the signed v2
authority response in #126 and independently checks those exact instance IDs.
Recorded old fences must precede the current work. Terminated IDs that AWS no
longer returns can remain fenced; stopped writers, uncertain new IDs, changed
tags, malformed evidence and a changed writer list before mutation are rejected.
The list is bounded to 128. No caller-supplied event can add an ID or clear a fence.

The fixed Standard graph uses the v2 SHA-256 allocation token
`ezil-lifecycle-v2\ninstance\n<digest>`, launches the approved per-writer profile,
retags the same detached volume to the new generation, attaches it at `/dev/sdf`,
sets `DeleteOnTermination=false` and verifies the observed attachment. A repeated
allocation uses the same token. V2 never returns a `createVolume` action. Its
receipt has `schemaVersion:2` and the original retained volume ID.

The existing failure cleanup graph handles v2 without obtaining current launch
authority. It resolves only the new allocation by the immutable token, preserves
its attached disk, stops/terminates it and returns a v2 fencing receipt. An
entered allocation task with no observed target remains uncertain. Data-only
failures retain their prior disk tags and owner. A `createVolume` step in v2
history is incompatible and fails closed. Cleanup never operates on another
historical writer, launches a replacement, or handles a SUCCEEDED source.

Deploy new pinned workflow/helper versions only after migration 0008 and the v2
consumer/authority implementation are ready. The existing v1 workflow versions
remain available for their original executions. The same reviewed shared pins
derive profiles for each computer/generation; no new IAM privilege or provider
is introduced here. All notification and recovery schedules remain disabled by
default. Local fixtures and synthesis do not prove live EC2 or Reticle acceptance.
