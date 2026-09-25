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
