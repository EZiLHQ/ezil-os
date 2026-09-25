# Trusted computer configuration delivery

The host configuration source implements the AWS side of the control plane's
immutable configuration-reference contract. It is not enabled by a public API
or a login. A controller must first authorize the current computer, writer,
release, installation, selected folders and requested operation.

The root-owned provisioning record contains `schemaVersion: 1`, the complete
writer `scope` (computer UUID, generation, EC2 instance ID, data-volume ID and
fence UUID), account ID, `us-east-1`, namespace, private bucket and KMS key ARN.
This record is independent of SSM input and publisher manifests. Provisioning
must bind it to the observed instance and fenced data volume; this module does
not create the record or allocate its identities.

The delivery reference matches the control-plane AWS transport: version 1,
`prepare` or `reload`, immutable configuration UUID, scope, revision, digest,
and an object reference with bucket, key, S3 version ID, SHA-256 and byte count.
Only the exact provisioned namespace/computer/generation key is accepted.
Mutable/null versions, cross-computer/fence references and arbitrary commands
are rejected. Configuration parsing requires canonical bytes and explicit host
defaults, matching scope/revision/digest, the fixed production directory/port/
memory layout and images in the provisioned account's ECR registry.

The host obtains an IMDSv2 token from the fixed `169.254.169.254` endpoint,
verifies account, region and instance ID, and retrieves only that instance's
temporary role credentials. A dedicated HTTP agent ignores proxy, profile and
metadata endpoint environment overrides. Responses have deadlines and size
limits. Redirects, v1 fallback, stale credential extension and stored keys are
not supported. Installed app networks must independently block metadata access.

The S3 SDK request names the exact object version and expected account owner.
Reads require the approved KMS key, SHA-256, exact length and bounded streamed
bytes. Registry authentication calls ECR for the same account and accepts only
its HTTPS endpoint and a token valid for the preparation deadline. The caller
must keep the password in protected host memory/files, remove it after use,
and never put it in workflow input, command-line arguments or logs.

The scoped host role must permit only its configuration versions/prefix,
required KMS decrypt context and approved ECR repository pulls. The existing
shared foundation role alone does not provide those restrictions. Host
credentials and signing keys must not enter application containers.

Tests use actual local HTTP for the metadata exchange and the real AWS SDK
serializer, signer and response decoder with a local request handler. They
verify malformed references, identity mismatches, redirects, expiration,
cancellation, wrong versions/encryption/bytes and cross-registry rejection.
These fixtures do not establish AWS identity, IAM enforcement, EBS readiness,
SSM dispatch, actual ECR authorization or production application availability.

Run `bash tools/test.sh supervisor` for typecheck, tests and the production
Node build. The Standard/SSM controller workflow remains a separate integration.

## Root receiver and supervisor service

`dist/configuration-receiver.js` accepts one bounded JSON delivery reference on
stdin. The production executable accepts no path, command, credential, endpoint,
PID or private-validation argument. It reads
`/etc/ezil-supervisor/provisioning.json` using the same protected-file checks as
the host: root-owned ancestors, a private single-link regular file and no symlink.
The active configuration is fixed at `/etc/ezil-supervisor/config.json`.

The receiver holds the kernel `delivery.lock` throughout the operation.
Provisioning replacement and retirement **must acquire the same lock**, after
cancelling outstanding deliveries; do not replace the lock file. It rechecks the
provisioning bytes after download, immediately before preparation's atomic
rename, and before returning/reloading. The existing preparation lock still
serializes approval-file writers, and existing host revisions reject stale or
conflicting snapshots. These local fences do not substitute for the controller's
current authorization checks or provider-observed EBS writer fencing.

For `prepare`, exact verified bytes and optional ECR credentials are placed in
unique 0600 files under `/run/ezil-supervisor`. The existing preparation operation
admits the data mount, inspects/pulls approved images, creates private directories,
and atomically installs the approved configuration. Every temporary file is
tracked before writing and removed on completion or failure; cleanup failure
returns an unconfirmed result. Process death may leave a private file in `/run`
until reboot. A future reaper must take the delivery lock before removing stale
delivery files; it must not remove active credentials, lock files or user data.

For `reload`, the receiver verifies actual instance identity and the existing
prepared file, then runs only `systemctl reload ezil-supervisor.service`.
It does not download, pull, restart, start an inactive service or wake compute.
Both operations return the scoped descriptor expected by the workflow. The
control plane still needs a separate authenticated `configuration()` observation
and current database authority before it can mark an installation complete.
Exit errors and stdin failures emit a fixed code, without raw provider details.

`deploy/ezil-supervisor.service` defines the fixed root executable and SIGHUP
reload, a 75-second stop allowance for the host's 60-second drain deadline,
bounded restart attempts, and a mountpoint dependency. Runtime lock files are
preserved across service restart. Do not add systemd options that put this
process in a private mount namespace: Docker must see its stable bind mounts.
The host's actual ext4/XFS/volume-marker admission remains necessary; a systemd
mountpoint check alone is not EBS proof. Provision root-owned code, Node 24,
Docker, data volume, provisioning/configuration and control.key before activation.
This change does not install or enable the service on any computer.

`bash tools/test.sh supervisor --linux-host` tests the real receiver with root
files, a mounted ext4 loop disk, actual Docker preparation and a running Node
supervisor. It proves preparation does not change the loaded receipt, then sends
a real SIGHUP and observes the new signed descriptor. Failure tests cover
corruption, changed provisioning during actual Docker inspection, cancellation,
missing disk marker, concurrent delivery locks, protected paths and cleanup.
Metadata/S3 are local fixtures, and the test directly signals the process.
This receiver suite does not exercise systemd or SSM dispatch. The separate
process-management suite below covers actual systemd units; neither suite is
evidence of a deployed app or actual EC2/EBS behavior.

## Bounded systemd delivery operations

`deploy/ezil-configuration@.service` runs the receiver executor as a root-owned
service with `KillMode=control-group`, SIGTERM followed by SIGKILL after ten
seconds, no restart policy, and an independent fifteen-minute runtime ceiling.
Its instance key is `prepare-<configuration-uuid>` or `reload-<configuration-uuid>`.
No caller chooses a unit, executable, PID, root path, environment or shell.
The unit does not start on boot. It is separate from the computer supervisor
service and from application containers, so cancelling configuration work does
not issue a computer stop or application stop.

`dist/delivery-operation.js` is the fixed SSM-facing executable. It accepts no
arguments; `SSM_Operation` contains canonical base64 for at most 8192 JSON bytes:

```text
{ schemaVersion: 1, action: "start", delivery: <immutable reference>, deadline: <Unix milliseconds> }
{ schemaVersion: 1, action: "observe" | "cancel", delivery: <immutable reference> }
```

`delivery` is the existing strict S3-version/writer reference, never configuration
bytes or credentials. Start requires an unexpired deadline at most fifteen
minutes ahead. `deploy/configuration-document.json` supplies that data using SSM
`ENV_VAR` interpolation and invokes only the fixed Node executable. Missing
environment interpolation on an older SSM agent fails closed. No parameter is
inserted into shell text. The document's own command timeout is 45 seconds;
long receiver work belongs to systemd, not the SSM agent's command process.

The existing host-private `control.sqlite` gains an additive `deliveries` table.
It records the immutable reference, original deadline, separate one-time dispatch
and execution allowances, cancellation fence and result. It is a local recovery
record, not a second cloud authority or new Postgres migration. Both allowances
commit before their external operation; a lost response or process death never
refunds either one. The executor checks the saved cancellation fence and deadline
again before entering the receiver. A duplicate activation cannot rerun it.
Records are capped at 100,000 per host generation and must not be pruned while
that generation can still receive commands. Retire/fence the writer before
removing its recovery history.

Start queues the exact unit without waiting for image work. Observe opens no
new process and never calls start. Cancel first commits its fence, including
when start has not arrived, then stops only that unit. A successful stop request
is insufficient: the driver reads systemd state, pending job, main PID and
cgroup-v2 population before reporting quiescence. A queued activation arriving
after cancellation sees the persisted fence and cannot enter the receiver.
Provisioning must coordinate the short `delivery-management.lock` as well as
the receiver's long `delivery.lock` when cancelling and replacing host identity.
Do not call the manager while holding its management lock.

Results contain configuration identity, scope, operation and one of `absent`,
`unknown`, `running`, `succeeded`, `failed`, `cancelling` or `cancelled`.
`succeeded` requires both an exact receiver result committed locally and an
observed quiescent, nonfailed unit. Its nested `result` matches the control-plane
workflow output contract. A saved dispatch with no process/result remains
`unknown`; the manager never starts it again. Recovery requires controller
reconciliation and, where necessary, a newly authorized configuration, not
deleting the local record or extending the old deadline. Cancellation does not
undo configuration bytes already committed before the cancellation, nor does it
revoke loaded application authority by itself; deliver the new control-plane
revocation snapshot. A forced kill can leave private scratch files as described
above. Never delete user data as cancellation compensation.

All CLI failures emit fixed codes. The systemd unit discards stdout/stderr;
only the bounded, scoped result is recorded. It cannot certify loaded supervisor
state or complete installation. The control plane still needs its signed host
observation and current database transaction before acknowledging installation.

Run `bash tools/test.sh supervisor --linux-systemd` on a disposable Linux VM
with Node 24, systemd and cgroup v2. It uses root (or noninteractive sudo), creates
a unique test unit and private directory, and removes them after observing stop.
The production systemd driver, manager, executor and SQLite store run for real;
the receiver callback is an instrumented fixture, not AWS or Docker preparation.
Tests cover successful/failed work, a child ignoring SIGTERM, cancellation before
activation, deadlines, abrupt process loss, duplicate unit activation, missing
dispatch outcomes, observation without wake and forged scope. CI runs this on
its Linux VM alongside the separate real Docker/receiver acceptance suite.

Do not run privileged systemd containers inside a shared Docker VM. Local testing
observed `systemd-binfmt` unregistering OrbStack's amd64 interpreter that way;
an isolated Linux machine avoids that shared-host side effect. Local acceptance
also restarted such a machine with active delivery, confirming that dispatch,
execution, cancellation and the original deadline survived. This is host-process
recovery evidence, not an EC2 replacement or persistent app-data acceptance test.

Before activation, provision the approved Node/code/unit files, root configuration
and scoped host IAM role; validate the pinned SSM agent and custom document;
pin the document version/hash and restrict SendCommand to that document and
platform-owned instances. The Standard workflow must check current database
authority and actual EC2/EBS writer state before dispatch and throughout slow
work, reconcile ambiguous commands and execution interruption, and verify these
results. No workflow, IAM policy, AMI, SSM document or service is deployed by this
change, and production installation remains disabled.
