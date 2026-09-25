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
Systemd operation, SSM dispatch and actual EC2/EBS behavior still require the
approved Linux VM/cloud pilot; this suite is not evidence of a deployed app.
