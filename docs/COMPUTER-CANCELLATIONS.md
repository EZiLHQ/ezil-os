# Explicit computer cancellation

Migration `0009_computer_cancellations.sql` records cancellation of a queued or
running provision, start, replacement or retained-disk recovery. It adds no
producer, route, scheduler or AWS mutation. Keep activation off until the
separate cancellation consumer and provider workflow are validated.

A trusted producer locks the computer, runtime and source job in that order,
authenticates an owner/admin stop request or verifies current access revocation,
then inserts the cancellation and its outbox in one transaction. The database
binds the original computer/job/version/digest, derives the source state and
creation time, and computes the cancellation digest from
`ezil_computer_cancellation_document`. A numeric workflow version in the same
account/region must name a different state machine from the source workflow.
The future consumer must also enforce an operator-approved workflow mapping.
Publisher/browser input cannot select provider resources or workflow authority.

`parseComputerCancellation` verifies both original immutable documents, hashes,
versions and scope. Parsing does not authenticate a caller or establish provider
state. In particular, **`authority=false` is never cancellation authority**:
healthy finalized lifecycle work also returns false. Already terminal jobs
cannot receive a cancellation record.

While cancellation is pending, the source keeps its original queued/running
state, immutable intent, generation and resource association. Queued work cannot
advance to running. Running work remains in admission across retries and lease
expiry. Neither delivery may be acknowledged separately. Settlement must
atomically mark the source `cancelled`, set its completion time and acknowledge
both outboxes with cleared leases. The two outcomes are:

- `lifecycle_cancelled`: only an unclaimed queued provision with no recorded
  disk/instances, start time or source-delivery attempts. It cannot erase an
  existing computer's resources by treating queued start/recovery as empty.
- `lifecycle_recovered`: independently reconciled provider effects. SQL requires
  all recorded writers fenced with a stopped observation and preserves the
  source disk and declared historical writer. The consumer must verify exact
  terminated writers, detached retained storage, execution history and absent
  effects before making these writes. A successful workflow or `StopExecution`
  response alone cannot establish stopped compute.

Terminal cancellation content and delivery acknowledgments cannot be rewritten,
reopened or deleted. Attempt counters cannot decrease. A reconciled source can
later authorize an explicit v2 recovery with a new generation on the same disk.
No cancellation deletes application data or publishes a release.

All new tables have service-only RLS. The privileged producer/consumer must still
enforce owner/admin authorization and provider evidence. Database fixtures that
write stopped/fenced rows are tests of constraints, not evidence of AWS behavior.

Run `bash tools/test.sh app`, `bun run test:db:computer-cancellations` and the v1/v2
lifecycle/recovery database suites with `EZIL_TEST_DATABASE_URL` set to a loopback
Postgres server. The tests use unique disposable databases and cover populated
migration, digest agreement, RLS, concurrent claims/success/cancellation,
partial settlement, retention and recovery after cancellation.

Apply the reviewed additive migration only after inspecting the hosted schema;
do not replay the historical migration journal. Rollback disables producers and
retains cancellation records, admission holds and persistent storage until
provider reconciliation completes. This schema does not establish Reticle
installation, host readiness, phone typing, cloud stop or billing acceptance.

## Stop and revocation producers

`requestComputerStopCancellation` takes a verified server-session user ID and
only a computer ID in request data. It checks current OS access and either
computer ownership or an active platform administrator grant. The separate
internal `requestRevokedComputerCancellation` verifies deleted/changed ownership,
desired stop/retirement, or current OS-access revocation. A lookup error rolls
back; a healthy finalized job returns inactive even though its old lifecycle
authority is false. Completed healthy computers require the normal stop lifecycle
path, not retroactive cancellation of their completed start job.

Both producers require approved historical deployment pins and an exact
operator-configured cancellation workflow mapping. One transaction creates the
immutable record, delivery and redacted audit event and changes desired state
to stopped (preserving retirement). Repeated/concurrent requests return the same
pending cancellation. A request cannot select an EC2 ID, volume, source job,
digest or workflow ARN. No provider call, source settlement or resource deletion
occurs here; running admission remains reserved.

Lifecycle claims skip cancelled sources. Existing claims and v1/v2 launch
authority recheck cancellation under the computer lock, including after provider
observation. A result racing cancellation cannot acknowledge success or failure.
Restoring desired running state does not rescind an immutable cancellation.

These are internal functions with an explicit disabled option, not activated
routes or scheduled producers. Apply migration 0009 before deploying consumers
that read it. Wiring remains off until the cancellation workflow, independent
provider observer, delivery consumer and approved pilot are complete. Run
`bun run test:db:cancellation-producer` alongside the existing schema and lifecycle
consumer suites. Its provider responses are fixtures, not live AWS receipts.
