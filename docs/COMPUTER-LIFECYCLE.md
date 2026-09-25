# Computer lifecycle intent

`0007_computer_lifecycle_intents.sql` adds an immutable record for each approved
EC2 lifecycle job. It is the input to the lifecycle controller, not a
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
explicit v1 document returned by `ezil_lifecycle_intent_document`. That function
returns the exact bytes to hash and does not implicitly include future columns.
The controller must fetch that immutable document and verify its digest; it must
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

## Consumer and authority endpoint

`lifecycle-consumer.ts` claims only jobs which already have an immutable intent.
It reads the exact SQL v1 document and digest, checks the approved deployment,
current owner/OS access, desired state and writer/disk association, and reserves
one of two pilot computer slots before submitting work. The running job holds
that reservation across delivery lease expiry and ambiguous AWS responses.
Computer locks serialize acknowledgments; attempt numbers reject stale workers.
Network requests execute outside database transactions.

`aws-lifecycle-transport.ts` submits a deterministic `computer-<job UUID>` execution
of the intent's numeric Standard workflow version. It verifies execution input,
version, name and absence of redrive before accepting any output. It does not
restart an absent historical execution after seven days. Submission, RUNNING,
FAILED, ABORTED, TIMED_OUT and missing history never count as provider completion.
There are no automatic SDK retries and no direct EC2 mutations in this transport.
`StartInstances` has no ClientToken; the workflow must own that non-idempotent
step and reconcile uncertainty without retrying it or releasing admission.

On successful workflow output, the transport independently describes EC2 and
EBS. It checks the exact account, ownership/generation tags, region/AZ, instance
identity, effective launch properties, preserved encrypted 50-GiB gp3 volume,
and exclusive attachment. Replacement requires the old instance to be observed
**terminated**; stopped alone could be undone by a delayed start. Retirement
requires termination and a detached, available data volume. These are provider
receipts, not mounted-disk, loaded-supervisor or installed-application receipts.
`DescribeInstances` does not expose a LaunchTemplate field: template selection
is the pinned workflow's responsibility; the observer checks effective properties.

After fresh provider observation the consumer atomically updates the runtime,
writer, job and outbox. Replacement fences the previous database writer in that
same transaction. A revoked in-flight start remains unresolved for cancellation
reconciliation; it is never marked failed merely to admit replacement work.
Stop/retire cleanup can proceed after owner access revocation. No operation
permanently deletes the retained data volume.

When the trusted transport factory receives a `recoveryDeployments` mapping
from original numeric workflow versions to approved recovery versions, it can
observe the separate cleanup workflow from PR #123. The mapping defaults to
absent; an unconfigured, missing, running or failed recovery keeps admission
reserved. No browser input selects this mapping and the web transport cannot
start recovery, stop instances or delete volumes.

For a failed/aborted/timed-out original execution, the adapter verifies the
recovery execution's exact name, input, version and receipt, then independently
reads complete original history and EC2/EBS state. An entered allocation task
cannot disappear from the receipt. Existing writers must be present, new writers
must match their original allocation token, every writer must be terminated,
and the encrypted data disk must be detached and available. An empty resource
list never causes an unscoped account-wide describe request. Successful original
workflows are not eligible for this automatic recovery path.

Only after this independent observation does the consumer atomically fence the
recorded writers, retain the disk/AZ association, mark the original job failed
with `lifecycle_recovered`, and acknowledge its outbox event. It performs no
installation and does not claim that the original operation succeeded. A stale
lease, stale observation, forged scope or storage conflict rolls back the
acknowledgment. Historical cleanup remains valid after owner access revocation.
These writes use existing schema; no migration is added by this consumer change.

Activation still requires durable cancellation for revocation racing successful
completion, and an explicit recovery intent that starts a new generation on a
retained disk after its old writers are fenced. The current v1 provision contract
cannot silently treat an existing retained disk as an empty new computer. A
data-only interrupted allocation remains associated with its owner even if it
never received an instance. Keep producers disabled until that recovery path,
host bootstrap, scheduling and approved cloud acceptance are complete.

## Retained-disk recovery intent (v2)

`0008_computer_recovery_intents.sql` adds a separate immutable recovery record.
It preserves the v1 table and `ezil_lifecycle_intent_document` bytes. An explicit
`recover` job binds its computer, last reconciled source job/version/digest,
retained volume and observed disk generation/fence, a fresh writer generation,
and approved deployment pins. `ezil_computer_recovery_document` produces the
strict v2 document consumed by `parseComputerRecoveryWork`. An old consumer
rejects this document; it cannot reinterpret it as a v1 provision or replacement.

The database requires a retained volume already associated with the computer,
all recorded prior writers fenced and stopped, and the immediately preceding
intent failed/cancelled with confirmed cleanup recorded as `lifecycle_recovered`.
A failure/cancellation request alone is insufficient. It checks the source
digest and permitted disk generation/fence, prohibits storage account/AZ/KMS or
namespace changes, and reserves a new generation without creating an instance,
changing disk ownership or clearing a fence. This supports interrupted
provisioning that retained a disk before allocating any instance, and a later
recovery attempt after an earlier v2 operation was itself reconciled.

V1 and v2 intents share one revision sequence and the same computer lock.
Competing work of either version blocks another intent; intent content and
bound job identities cannot be rewritten or removed. New records start with
service-only RLS. Current ownership, OS access, maintainer approval and quota
admission remain API/controller checks. The producer and workflow must
independently observe the retained disk's actual tags, ownership and exclusive
detachment, and confirm all historical instances are terminated before attaching
it. Database fields alone do not prove provider fencing.

This schema and contract do not enable a producer or implement the v2 workflow.
Apply the reviewed migration before those consumers. Before any hosted apply,
inspect the actual schema and apply only this additive migration transactionally;
do not replay the historical migration journal. Rollback disables recovery
producers and keeps the retained disk, intents and existing v1 history.

Run `bun run test:db:recovery-intents` against a loopback test database. The suite
applies 0008 over populated v1 data and checks preserved hashes, source/disk
ownership, shared revision ordering, concurrent generation reservation, recovery
after cancellation, immutability and authenticated-role denial. Also run the
existing lifecycle-intent and consumer database suites after the migration.

`POST /api/internal/computers/lifecycle-authority` checks the current immutable
job/digest under a dedicated 30-second HMAC. It accepts no caller-selected
provider IDs. Cookie/bearer authentication cannot substitute for the workflow
key. Replaying a signed check repeats current database validation. The result is
not a reusable capability and does not execute provider work.

The endpoint defaults off. Before enabling it, review/apply migration 0007 and
configure `EZIL_LIFECYCLE_AUTHORITY_ENABLED=true`, a separate 64-character hex
`EZIL_LIFECYCLE_AUTHORITY_SECRET`, and `EZIL_LIFECYCLE_DEPLOYMENTS` as a JSON array
of reviewed deployment records. Invalid or missing enabled configuration fails
at startup without printing values. Keep historical deployments available for
observation/cleanup; revocation must stop admission while reconciling running
resources. Do not reuse host, configuration-delivery, Supabase or cloud keys.

The lifecycle workflow, scoped OIDC credentials, intake/periodic consumer wiring,
per-writer host bootstrap/permissions and cancellation recovery must be deployed
and validated before any new-computer producer is enabled. This change does not
activate a cron or start AWS resources. In particular it does not yet install
Reticle or claim an AWS stop/start/replacement acceptance test.

Validation: `bash tools/test.sh app`, a production app build with local Supabase
configuration, and `bun run test:db:lifecycle-consumer` against a disposable
loopback Postgres server. SDK tests exercise actual request serialization,
signing and XML/JSON decoding with a local wire handler. Database tests exercise
real concurrent locks and commits. Neither test suite establishes cloud IAM,
disk mounting, physical-phone behavior, or stopped-compute billing.
