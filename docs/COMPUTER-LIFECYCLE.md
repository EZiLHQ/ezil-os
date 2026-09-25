# Computer lifecycle intent

`0007_computer_lifecycle_intents.sql` adds an immutable record for each approved
EC2 lifecycle job. It is the input to the future lifecycle controller, not a
provider observation or a permission grant. Existing Cloudflare computers are
unchanged; no producer or cloud workflow is enabled by this migration.

A trusted producer creates the job and its existing outbox event, then the
intent in one transaction. The database checks computer/job identity, serializes
revisions per computer, requires the exact current writer and disk for
start/stop/retire, and binds the previous writer for replacement. Provision and
replacement reserve a fresh generation. Reservation does not fence the previous
writer, create an instance or claim that a volume is detached. The existing
single-writer index still prevents a replacement writer until the controller has
recorded fencing from real provider evidence.

The intent freezes the deployment account, region/AZ, subnet/security group,
pinned launch-template version and AMI, host instance-profile ARN, data KMS ARN,
pinned Standard workflow version, and namespace. It stores references only.
Unknown fields, mutable versions, nested values and credential fields fail.
The database normalizes the deployment JSON and computes the digest from the
PostgreSQL JSONB representation of the row excluding `digest` and `created_at`.
The controller must fetch the immutable record and verify that digest; it must
not substitute a publisher manifest or reconstruct it from mutable runtime data.

One queued/running intent may exist per computer when another is admitted.
A terminal job permits the next revision, so the controller must only record
terminal status after reconciling its actual outcome. An ambiguous AWS response
must retain the active job/admission. A cancellation request alone cannot release
the writer slot, resolve uncertain commands, or prove that compute stopped.
The migration is not a replacement for current OS access/ownership checks,
platform admission quotas, provider observation, revocation, backup or migration.

Intent content cannot be updated, deleted or truncated. Bound job identity cannot
be rewritten, while status/timestamps remain available for the controller.
Running jobs cannot return to queued, and terminal jobs cannot be reopened.
The required outbox event cannot be deleted from under a retained intent. RLS is
service-only; APIs must separately enforce ownership because their connection is
privileged. Provider/resource IDs are never public API input.

Run `bash tools/test.sh app`, then `bun run test:db:lifecycle-intents` with
`EZIL_TEST_DATABASE_URL` pointing to a disposable loopback Postgres server.
The database test creates a unique database, applies the migration journal there,
tests real concurrency and constraints, then drops that test database. It does
not alter the local OS's database or a hosted project.

Before a hosted rollout, inspect the actual schema and review/apply only the new
migration transactionally. Do not replay the historical journal or run `push`.
The controller/consumer is a separate change and must remain disabled until its
schema is applied. Rollback keeps additive history and disables the producer.
