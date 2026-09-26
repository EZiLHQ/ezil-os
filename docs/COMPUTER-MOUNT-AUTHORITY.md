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
unsettled delivery. It is not yet an HTTP endpoint. A transport must independently
verify provider identity and current authority before host effects and during
cancellation. Supplying work to a function never grants those permissions.

Only an exact host mounted receipt can settle an active attempt, after a second
authority check under SQL locks. Expiry, revocation, stop, fencing, disablement
or lease takeover rejects late results. Receipts are immutable historical mount
evidence; the consumer does not mark apps installed/ready or invoke configuration
delivery. Provider failures leave bounded error codes, without raw messages.

`bun run test:db:mount-delivery` exercises real PostgreSQL concurrency, takeover,
rollback and authorization races with a simulated transport. The protocol is
strictly validated in the app suite. No scheduler, S3/SSM adapter, independently
provisioned root authority, AWS resource or hosted database is enabled here.
