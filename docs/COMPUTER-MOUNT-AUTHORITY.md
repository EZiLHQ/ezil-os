# Durable computer mount authority

Migration `0011_computer_data_mount_authority.sql` adds service-only mount
authorizations and a transactional delivery queue. It does not enable an issuer,
send SSM commands, format disks or mark applications ready.

An authorization freezes the completed lifecycle job, current computer writer,
instance/volume IDs, filesystem UUID, mode, provider observation time and plan
digest. PostgreSQL computes canonical plan bytes and the SHA-256 digest, and
sets an integer-second issuance time with a 900-second lifetime. The only
mutable authorization field is an irreversible revocation timestamp.

Provisioning may receive one initialization grant per computer. Start,
replacement and retained recovery can receive only mount grants. A grant cannot
be renewed, deleted, truncated or moved to another job to clear its history.
An expired, uncertain initialization requires explicit recovery/inspection;
it never becomes an automatic second formatting attempt. The host still checks
blank media and keeps its durable attempt journal.

The SQL checks require a successful immutable lifecycle source, the current
unfenced running writer, the recorded filesystem UUID, the owner's request and
running desired state. A later lifecycle job prevents use of the old grant.
Creating a grant atomically creates its delivery row. A mounted receipt needs
an unexpired lease, unrevoked authority, current writer and exact host receipt
identity; accepted receipts cannot be overwritten or removed.

These records do not establish provider truth or user entitlement. A trusted
issuer must check OS access and the approved deployment, independently observe
the actual provider resources, then recheck database authority before issuance.
The delivery workflow must reauthorize before dispatch and handle revocation
during host work. A stored receipt is historical mount evidence, not current
application readiness. Status reads do not start compute.

## Issuer

`issueComputerDataMount` is an internal control-plane producer accepting only
`computerId` and a completed `jobId`. It is not exposed as a browser endpoint.
Callers supply the database, a disabled-by-default enable decision, OS-access
policy, approved deployments and the real AWS lifecycle transport's `advance`
method. The issuer always passes `allowStart=false`: a missing execution cannot
start compute. The existing transport's cleanup observation path is also
read-only. No provider resource IDs, filesystem paths or format mode are accepted
from the request.

The producer checks current ownership, OS access, deployment and writer state,
releases SQL locks for bounded provider observation, then repeats authorization
before committing the grant/outbox. Provisioning/replacement instances must
match the immutable allocation token; a new volume must match the provision
allocation tag. Retained recovery rechecks its historical fenced writers while
excluding only the exact successfully committed current writer. Active recovery
consumers retain their original no-current-writer requirement.

Concurrent requests return the same grant and original deadline. Revoked or
expired grants are not renewed. Missing, stale, mismatched or failed provider
observations leave issuance unconfirmed. A stop, fence, access revocation or
disabled producer during observation denies commit. Output contains only the
host's strict v1 authorization and canonical plan records, with no credentials.

The producer is still not scheduled or connected to SSM delivery. The next
integration must store the exact versioned S3 object,
provision independent root authority, invoke the host receiver, and record its
verified mounted receipt before configuration delivery. Those calls require
current authority checks and cancellation; invoking this function alone does
not initialize an EC2 disk or make Reticle installable.

Apply this additive migration before shipping consumers, after reviewing the
live hosted schema and obtaining migration authorization. Do not replay old
migrations or run an unreviewed schema push. Disabling consumers is the rollback;
retain authorization, attempt and receipt history. No hosted migration was
performed while authoring this change.

Local validation uses `bash tools/test.sh app`, the production app build, and
`bun run test:db:data-mounts` with `EZIL_TEST_DATABASE_URL` set to an isolated
loopback PostgreSQL database. The database suite creates/drops its own database
and exercises constraints, concurrent issuance, rollback, leases, revocation,
RLS and unchanged historical lifecycle documents. Provider lifecycle regression
suites also run with this migration. These tests simulate provider observations;
actual AWS and host-delivery acceptance remain separate.

`bun run test:db:mount-issuer` adds actual PostgreSQL issuer concurrency and
authorization races with simulated provider observations. SDK wire tests cover
the real adapter's immutable allocation checks. Local cross-worktree validation
also checks issuer output against the strict host contract in PR #137.

## Delivery consumer

`claimComputerMount` and `dispatchComputerMountClaim` consume the existing queue.
They lock computers before grants/deliveries, lease one attempt for 45 seconds,
and bound each transport call to 20 seconds outside SQL locks. Retry/takeover
uses the same authorization ID, canonical plan, deployment and deadline.
Unavailable work backs off without renewing authority or blocking other computers.

`authorizeComputerMount` rechecks exact current work for a trusted workflow
caller. It is independent of the short delivery lease; it checks unexpired,
unrevoked authority, owner OS access, approved deployment, current writer and
unsettled delivery. A transport must independently
verify provider identity and current authority before host effects and during
cancellation. Supplying work to a function never grants those permissions.

Only an exact host mounted receipt can settle an active attempt, after a second
authority check under SQL locks. Expiry, revocation, stop, fencing, disablement
or lease takeover rejects late results. Receipts are immutable historical mount
evidence; the consumer does not mark apps installed/ready or invoke configuration
delivery. Provider failures leave bounded error codes, without raw messages.

`bun run test:db:mount-delivery` exercises real PostgreSQL concurrency, takeover,
rollback and authorization races with a simulated transport. The protocol is
strictly validated in the app suite. No scheduler, independently provisioned
root authority, AWS resource or hosted database is enabled here.

## AWS transport

`createAwsComputerMountTransport` implements the consumer's `advanceMount` using
the pinned AWS SDK. Operator settings must name the exact account, namespace,
bucket, KMS key and numbered Standard workflow version. Only explicit temporary
federated credentials are accepted; regional endpoints are fixed and automatic
SDK retries are disabled.

The transport conditionally creates the canonical plan at
`<namespace>/computers/<computer>/generations/<generation>/data-mounts/<authorization>.json`.
It verifies the bucket owner, encryption key, checksum, length, content and
non-null object version on readback. Lost PUT responses and concurrent writers
reuse that path without overwriting it. The host receives this exact version.

The immutable workflow input is `{ schemaVersion: 1, work, object }`: `work` is
the strictly validated grant, plan and approved lifecycle deployment;
`object` contains bucket, key, version ID, digest and byte length. There are no
credentials in this envelope. It uses execution name `mount-<authorizationId>`.
The workflow must independently authorize `work`, verify provider ownership and
attachment, provision the protected root records, and return only the exact host
mounted receipt. The envelope is not its own source of authority.

Every poll checks the pinned workflow version, exact input, execution identity,
start time and zero redrives. A StartExecution reply only means pending. Failure,
changed object version, altered receipt or expired authority cannot become
success or cause a replacement execution. The original 900-second deadline also
prevents reuse after AWS's Standard execution-name retention window.

Calls have an eight-second deadline. Caller timeout stops local I/O; it does not
claim that a remote SSM command was cancelled. The still-required trusted
workflow must implement cancellation and expiry during host work. No workflow,
SSM document or dispatcher scheduler is created or
enabled by this adapter, and it has no EC2 start operation. Configuration delivery
must still wait for independently verified mounted evidence.

The app suite exercises actual SDK serialization/signing and response parsing
against a local wire handler, including lost replies, concurrent staging,
version/content mismatches, altered executions, redaction and timeouts. This is
not evidence of real S3/Step Functions/SSM, IAM or disk acceptance.

## Signed current-authority callback

`POST /api/internal/computers/mount-authority` accepts the exact work object.
It requires its own HMAC key/realm, a fresh timestamp and a signature over the
method, fixed path and body hash. Signed replays repeat current database checks;
the response `{ authorized: true, work }` is a point-in-time answer, not a grant.
Browser cookies and user bearers provide no access. The handler bounds body
size/read time and authorization time, rejects changed work and emits only
redacted errors. It cannot issue grants, call AWS or claim a mounted result.

`EZIL_MOUNT_AUTHORITY_ENABLED` defaults to `false`. Activation requires migration
0011, nonempty `EZIL_LIFECYCLE_DEPLOYMENTS`, and an independently generated
`EZIL_MOUNT_AUTHORITY_SECRET` (64 lowercase hexadecimal characters, distinct
from lifecycle/configuration keys). Store the same dedicated key in the approved
workflow secret; never send it in workflow input or browser data. The provider
writer/attachment check remains a separate mandatory workflow step. Disable the
flag to deny checks; no scheduler or cloud resource is enabled by this route.

HTTP unit tests exercise authentication, input limits, timeout/abort, redaction,
cross-realm denial and response binding. The PostgreSQL delivery suite sends
signed requests through the actual handler and rejects replay after revocation.
