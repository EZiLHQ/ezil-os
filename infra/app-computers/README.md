# Application computer foundation

This CDK stack defines shared pilot resources for future AWS-backed EZiL-OS computers. It synthesizes one VPC/public subnet, an inbound-closed security group, an immutable ECR image repository, a host-only instance role/profile, and a launch template. It creates **no computer, data volume, snapshot, tunnel, or public application service**. Existing Cloudflare computers are unaffected.

The public subnet provides outbound HTTPS for the Cloudflare Tunnel, ECR, and SSM without a NAT gateway that bills while all computers are stopped. The security group has no inbound rules. It permits outbound TCP 443 and candidate TURN port 3478 over UDP/TCP; actual Cloudflare Realtime TURN connectivity, eight-hour media sessions, and the host firewall must pass the pilot before deployment. Application containers need their own approved egress controls. The host role can pull approved images and use SSM; it has no EC2/EBS lifecycle permission. IMDSv2 is required with hop limit 1 because only host processes should use instance credentials. Container networks must additionally block the metadata endpoint.

The approved Linux/amd64 supervisor AMI ID is a required deployment parameter. Verify its root device name is `/dev/xvda` and that it starts the authenticated supervisor with a fail-closed mount dependency. The launch template makes the 30 GiB root gp3 volume encrypted and disposable. The lifecycle controller must separately create a 50 GiB encrypted gp3 **data volume per computer**, set `DeleteOnTermination=false`, tag and record its exact ID/AZ, fence the old writer, observe detach, and mount it before Browser, Code, or apps start. It must also provide daily encrypted snapshots with seven recovery points and an application-consistent hook for database state. Neither the template nor a successful synth proves that lifecycle behavior.

Run locally:

```sh
cd infra/app-computers
npm ci
npm run typecheck
npm test
npm run synth
```

Do not deploy this stack until the controller, supervisor AMI, scoped deployment identity, approved region/account, TURN path, and spending ceiling have been reviewed. A production CDK change requires a synth and `cdk diff` against the actual account; no hotswap or express deployment. ECR images, retained EBS capacity, snapshots, public IPv4 while instances run, and logs can incur charges even when computer compute is stopped. The shared VPC has no NAT gateway charge.

References: [EBS volumes](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volumes.html), [preserving volumes on termination](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/preserving-volumes-on-termination.html), [EBS encryption](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-encryption.html), and [EBS pricing](https://aws.amazon.com/ebs/pricing/).

## Configuration delivery

`lib/configuration-delivery.ts` defines a separate Standard workflow, trusted
Lambda reader, pinned custom SSM document, and cancellation workflow. It accepts
the immutable S3 reference produced by the app's configuration transport. It
reconstructs the original reference and deadline from version-pinned Standard
execution history, calls the current database-authority endpoint with its
dedicated 30-second HMAC, and observes the exact tagged EC2 writer and encrypted
EBS attachment. Status checks have no EC2 start/stop/attach permissions.

The Standard state machine calls `SendCommand` directly, once for `start`, with
no automatic send retry. SSM has no `ClientToken`. A lost response produces a
new **observe** command for the same persisted host delivery identity. The host
allowances and cancellation tombstone prevent duplicate or late execution;
AWS command submission itself is not treated as idempotent. Every observation
is bound to the exact document version, instance, complete command parameters,
time window and host result. Revocation or deadline expiry selects `cancel`.
Only a host cancellation fence plus observed process quiescence counts as
cancelled; unavailable, stopped or replaced writers remain unconfirmed.

The original 15-minute deadline cannot be extended. Five additional minutes
allow bounded cancellation; an interrupted workflow is recovered via EventBridge
and a five-minute scheduled backstop. Recovery reads the original Standard
history and may only observe/cancel that historical writer, even if current
grants have been revoked. It never redirects cleanup to a replacement instance.
Recovery execution names are stable. A failed recovery requires operator
inspection; it is not automatically restarted or reported as stopped. Event
delivery failures and Lambda failures go to an encrypted DLQ; failure and DLQ
alarms are defined but need an operator notification destination before rollout.

Workflow success returns the exact **preparation** result expected by the app
transport. It is not installation completion. The app coordinator must separately
observe the authenticated supervisor's loaded configuration and commit its
database receipt. Cancellation cannot undo configuration already committed;
revocation still requires delivery of the new suspended snapshot.

Run `bash tools/test.sh infra` from the repository root. This typechecks, tests
the real SDK request serialization, executes the shipped ASL graph against
simulated AWS/host responses, bundles both Lambda handlers and synthesizes both
the delivery construct and the existing foundation. It does not contact AWS.
The actual host receiver/systemd suite lives in `supervisor/` (PR #119); the
copied SSM source in `documents/configuration.json` must remain byte-identical
to `supervisor/deploy/configuration-document.json` when the branches integrate.
Neither these fixtures nor a synth proves actual AWS cancellation or disk safety.

For a separate delivery stack, set `EZIL_DELIVERY_CONFIG` to a reviewed JSON file
and run `npm run synth:delivery`. Its shape is `{ machineName, authorityKeyArn,
reconciliationEnabled: false, settings }`; `settings` is `SettingsSchema` in
`lib/delivery/contract.ts`. It contains account/region, stage, namespace, bucket,
EBS KMS ARN, machine ARN and numeric workflow version, the HTTPS control-plane
origin, a Secrets Manager ARN, and numeric SSM version/hash. It contains **no
secret values**. The authority secret contains only the 64-character hex HMAC
key, encrypted under `authorityKeyArn`. The computed document name is
`ezil-configuration-<stage>-<first 16 hex characters of the source file SHA256>`.
The required SSM `documentHash` is the hash AWS reports for the registered numeric
version; do not assume that the source file's byte hash is AWS's document hash.

The document and workflow must first be registered with reconciliation disabled
and without granting any caller permission to start the workflow. Read back the
numeric document version/hash and workflow version; configure the exact pins,
synthesize/diff and inspect again before granting scoped access. Updating helper
settings creates a new workflow version: the configured version must match the
version published by that deployment. Retain the old stack/version until its
active deliveries and recovery complete. Do not mutate a running deployment's
settings or redrive failed executions.

Activation remains gated on PRs #115, #118 and #119, the current hosted schema,
scoped Vercel federation, a provisioned supervisor AMI with the exact root
receiver, per-writer S3/KMS/host-control access, and the capped AWS pilot. The
future EC2 lifecycle controller must set the matching computer/generation/fence
tags on **both** instance and data volume and preserve `DeleteOnTermination=false`.
This stack does not enable the app scheduler, create computers, install Reticle,
change routing, migrate user data or deploy the frontend. Reconciliation rules
default off. No cloud resources are created by the local checks.

The separate [EC2 lifecycle workflow](LIFECYCLE.md) implements actual provider
operations and documents the remaining activation gates. Use its explicit
`synth:lifecycle` entrypoint; the foundation does not automatically deploy it.

## Separate computer mount workflow

`lib/computer-mount-delivery.ts` adds a Standard mount workflow and a separate
cancel-only recovery workflow. They consume the exact app transport input
`{ schemaVersion: 1, work: { authorization, plan, deployment }, object }`, use
`mount-<authorizationId>` execution names and return only the raw mounted
receipt. They neither allocate computers nor prepare application configuration.

The helper reconstructs the original numbered execution, checks current DB
authority through `/api/internal/computers/mount-authority`, and independently
observes the approved EC2 image/network/role, writer generation, and preserved,
encrypted EBS attachment. Original grant expiry is never extended. Lost SSM
replies lead to observation/cancellation, with no second start. Recovery can
only address the original verified writer. Uncertain/stopped/replaced writers
require lifecycle reconciliation; no command is redirected to another instance.

Run `bash tools/test.sh infra` from the repository root. For a separate stack,
provide `EZIL_MOUNT_CONFIG` and run `npm run synth:mount`. It has the same outer
shape as the delivery config, with `settings` validated by `lib/mount/contract.ts`:
approved lifecycle infrastructure pins, a per-writer role path prefix, bucket,
mount workflow/document pins, and the dedicated mount-authority secret reference.
No secret value belongs in that file. The computed document name uses the source
hash; its `documentHash` must separately match AWS's reported numeric-version
hash, as described above. Register with reconciliation disabled, inspect the
actual pins, then deploy reviewed settings before enabling any caller.

The SSM document in `documents/mount.json` is copied exactly from the host mount
operation in PR #143. The reviewed AMI must install that manager, executor,
`ezil-mount@.service` and `/opt/ezil-supervisor/current` before activation.
Its original configuration document remains unchanged. Reconciliation rules
default off, logs omit execution data, and the helper has read-only AWS APIs.
The Step Functions role alone may invoke the fixed document on platform-tagged
instances. Mount/database scheduling, configuration gating and AWS pilot
acceptance remain separate integration work. Local ASL/SDK/CDK fixtures are
not evidence of AWS mounts, application readiness or Reticle installation.
