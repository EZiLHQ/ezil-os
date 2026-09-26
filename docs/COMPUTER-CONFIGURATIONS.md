# Computer configuration delivery records

Migration `0006_computer_configurations.sql` adds the durable record needed to
connect marketplace installation jobs to the computer supervisor's preparation
operation. It does not transfer files, contact a host, enable public APIs, mark
an installation complete, or start compute. The controller and delivery consumer
must be deployed separately after this additive schema is reviewed and applied.

The three tables are service-only:

- `ezil_computer_configurations` freezes a computer generation, provider instance,
  fence, data volume, consecutive configuration revision, and exact serialized
  configuration. The database computes the SHA-256 digest on insert, ignoring a
  supplied digest. Changes require a new revision; history cannot be overwritten.
- `ezil_computer_configuration_installations` binds every prepared member to its
  installation, app, release, and authorization generation. Pending install jobs
  reference their actual job/outbox. Execution is optional and references the
  exact immutable Start command. Prepared Reticle files need no selected project
  and grant no project access or execution authority.
- `ezil_computer_configuration_deliveries` provides an independent delivery lease,
  attempt count, retry time, redacted error code, preparation timestamp and loaded
  acknowledgement. A prepared file is not a loaded configuration. Completed or
  superseded delivery records cannot be rewritten.

A transaction locks the computer before allocating a revision and commits the
whole snapshot, member set and delivery event together. Revisions continue across
instance replacement. The provider association is captured, not caller-selected.
The database checks exact release bytes and optional execution-command membership;
extra, missing, duplicate and cross-computer members cannot commit.

The producer must use the supervisor's canonical JSON serialization, including
its defaults. The stored digest hashes UTF-8 bytes and is unprefixed hexadecimal,
matching `configurationDigest` from the host. PostgreSQL's `convert_to` is STABLE,
so the digest is computed in a trigger rather than a generated-column expression.
The full host schema and filesystem checks remain required: the SQL envelope
checks are not a substitute for them.

A future consumer must revalidate current ownership, active OS access, entitlements,
release approval, selected-project grants, resource policy and the active writer;
resolve a trusted endpoint/key; transfer protected files; run preparation; reload;
and authenticate the host's loaded descriptor. Only an exact generation, revision
and digest match may become a loaded acknowledgement. SQL rejects an acknowledgement
for an older revision, replaced/fenced writer, changed installation authorization,
revoked release, cancelled install job or superseded runtime command. Those checks
hold relevant rows through commit. A receipt remains historical evidence after a
later revocation; it never replaces authorization for the next request.

A suspended empty snapshot can remove authority even after a release is revoked.
Do not reuse an old snapshot to restore authority; compile a newly authorized
revision. A status query reads these records and never performs delivery or starts
resources. The consumer must fence callbacks with its delivery lease/attempt and
recheck the current snapshot when marking installation jobs complete.

Local verification uses `bun run test:db:computer-configurations` with
`EZIL_TEST_DATABASE_URL` pointing to loopback Postgres. It creates and removes a
unique database, applies the migration history transactionally, then exercises
real transactions, concurrent revision writers, authority locks and RLS roles.
The existing CI PostgreSQL job runs this suite. Fixtures do not establish cloud
file transfer, ECR access, EC2/EBS readiness, host identity or browser serving.

Before a hosted rollout, inspect the live schema and apply only reviewed new
migrations transactionally. Do not replay the old migration journal or enable
marketplace flags before their dependencies exist. Rollback leaves these additive
records intact and disables producers/delivery.

## Authorized snapshot producer

`produceComputerConfiguration` now compiles and persists a whole computer's
snapshot from current database records. It is an internal operation with an
explicit enable switch. The workflow authority endpoint below can refresh it;
no cron, provider call or public feature flag invokes it. Apply migration 0006
before enabling a caller. Disabled
calls do no database work, and ordinary browser status queries remain read-only.

The producer locks the computer to serialize revisions and reads its recorded
writer, fence, volume and region. The provisioning layout is fixed at
`/srv/ezil-data`, `/var/lib/ezil-supervisor`, `/run/ezil-supervisor/mounts`,
control port 8181 and a 3072 MiB app budget. No application or caller supplies
these paths or provider handles. Trusted provisioning must install this layout.

Pending installs need a current owner-requested install job and outbox. Retained
installed apps remain in the full snapshot. Each release passes the existing
manifest/policy/evidence compiler again under current user, OS access, publisher
and entitlement locks. Execution additionally requires an installed app, an
observed running writer and its latest matching Start command, service leases
and actual selected-project grants. Reticle preparation invents no project grant.
Invalid/revoked members are omitted; this operation does not itself fail or
complete their jobs. The delivery reconciler must report those outcomes.

Stopped/retiring computers, revoked user access, excessive app count or memory,
and an oversized configuration produce an empty suspended snapshot. In particular,
it has no install-job bindings: a host skips preparation while suspended, so its
loaded receipt cannot establish installation success. The pilot allows at most
two execution approvals and honors any lower approved app quota. This is snapshot
admission, not the independent host or platform-wide compute quota/watchdog.

Reuse requires identical canonical bytes and installation/job/authorization
bindings, plus the same recorded writer and an unsuperseded delivery. A new Start
with identical plan bytes still produces a new revision because its immutable
command reference changed. Revisions continue across replacement. New snapshots
supersede pending old delivery attempts and preserve already-loaded history.

The host client now supports the signed `configuration` read operation and
strictly checks computer, generation, revision and the unprefixed digest in its
reply. It never transfers or reloads configuration. A future consumer must still
resolve the trusted endpoint/key, prepare protected files, reload, authenticate
this descriptor and recheck current authority/leases before completion. None of
these records enable production installation or demonstrate an EC2/EBS launch.

Run `bun run test:db:configuration-producer` against loopback Postgres for the
producer's transaction, concurrency, revocation and isolation tests. They use
disposable databases and simulated provider records, not actual cloud computers.

For the independent host contract check, set `EZIL_TEST_CONFIGURATION_OUTPUT`
to an absolute temporary JSON path when running the producer database suite. Then
set `EZIL_TEST_SUPERVISOR_ROOT` to the supervisor checkout with its preparation
support built, and run `bun run test:host:configuration`. This checks every emitted
snapshot against the actual Node host's production parser, explicit defaults and
canonical digest. `tests/host-control-acceptance.ts` separately exercises the signed
configuration read against the real control server; its driver is instrumented,
so neither check claims Docker, file transfer or EC2 acceptance.

## Delivery coordination and installation completion

`configuration-delivery.ts` now coordinates durable preparation, reload requests
and authenticated loaded observations. It remains an internal worker operation;
no route, cron or public feature flag activates it. Its trusted provisioning
adapter must implement protected transfer/preparation and host reload before it
can run against AWS. The SDK adapter below now implements submission and
observation; the actual workflow/host delivery and a scheduled caller remain absent.

Claims lock the computer before delivery rows and allocate a 45-second lease
with an increasing attempt. Every phase reuses the producer inside a transaction
to verify current owner access, publisher/grants, immutable release, commands,
project consent, quotas and writer/disk. Both pending preparation and retained
installations require their actual approved service records and active port
leases; a missing or released lease cannot be ignored at completion. Changed
authority produces a newer snapshot and fences the old result.

Apply migrations through `0011_computer_data_mount_authority.sql` before enabling
delivery or workflow configuration authority. `configuration-mount.ts` requires
a completed, unrevoked mount receipt for the exact computer, generation, fence,
instance, volume and filesystem, bound to the current successful lifecycle job.
A later lifecycle job invalidates old evidence, including stop/start that reuses
the same instance and generation. Missing evidence defers delivery with
`computer_data_mount_unconfirmed`, without preparation, reload or installation
completion. Desired snapshots may still be compiled before mounting.

The receipt must have been accepted within its original execution grant; expiry
does not invalidate a mount already completed in time. Every transport phase and
final acknowledgement rechecks evidence, holding authority locks only until the
database transaction commits. A suspension bypasses the mount gate only when
both installation arrays are empty, so revocation can remove authority even
after a mount grant is revoked. These records do not replace the host's mount
checks, independent provider observation or application readiness checks.

Provisioning calls run outside database transactions. `advancePreparation` is a
bounded submit/poll operation: it uses the immutable configuration UUID as its
stable provider-operation key across claims, and returns `pending` while a durable
transfer/image pull runs. A new lease attempt must never start a new provider job
merely because it is a later poll. The future Step Functions/SSM implementation
must persist and reconcile actual operation state, enforce protected paths and
monotonic host revisions, support cancellation, and never wake compute here.
The coordinator cannot establish those provider guarantees through its interface.

A matching preparation receipt sets only `prepared_at`. It requests a reload and
waits for a later poll. Only the host client's authenticated `configuration()`
response with the exact computer, generation, revision and digest can set the
loaded receipt. A response from an older loaded revision requests another reload;
an unexpected newer revision or conflicting digest is an error, not a rollback.
Preparation is not repeated solely because the reload response was lost.

Receipt, installation status, bound install jobs, their outbox events and redacted
`installation.installed` audits commit together after a final authorization check.
Any failure rolls the whole completion back. Prepared files, reload requests,
duplicate observations and expired/reclaimed attempts cannot manufacture success.
Suspended snapshots bind no install jobs and therefore complete none. Pending
provider work updates job progress; errors contain fixed codes only. A stopped
computer waits without contacting provisioning or waking its host.

The workflow/host delivery implementation, caller scheduling, service management,
resource accounting and user-facing terminal handling for omitted/revoked jobs
remain required. Existing installation records and the new completion code do
not demonstrate a real AWS disk mount, running application or browser window.

Run `bun run test:db:configuration-delivery` against loopback Postgres. The suite
uses real transactions and concurrent connections with instrumented provisioning
and host clients. It checks lease takeover, cancellation/revocation during remote
work, timeouts, stopped/replaced writers, atomic failure recovery, two computers
and multi-installation completion. It does not exercise SSM or Docker transfer.

## AWS SDK transport (not enabled)

`createAwsConfigurationTransport` implements the coordinator's three transport
methods using the pinned AWS SDK. It has no environment-based activation and
is not called by a route or cron. Trusted deployment settings supply an explicit
account, `us-east-1`, namespace, private bucket, same-account KMS key ARN,
**numeric version ARN** of a Step Functions Standard workflow, and the owned
control domain. A mandatory temporary-credential provider will come from scoped
Vercel OIDC federation; that federation/bootstrap is not implemented here.
There is no default credential chain or stored administrator key fallback.

The transport checks canonical bytes, digest and writer envelope before calling
AWS. It conditionally creates one object at
`<namespace>/computers/<computer-uuid>/generations/<generation>/configurations/<configuration-uuid>.json`
using `If-None-Match: *`, expected bucket owner, SHA-256 and SSE-KMS. A lost write
response or concurrent create recovers by reading and checking the same object.
Bounded reads require the original bytes, checksum, KMS key and a real S3 version
ID. The host later fetches that exact version. The complete configuration can
be 262144 bytes; it is never a Step Functions input or an SSM command argument.

Workflow input contains only `schemaVersion: 1`, `operation` (`prepare` or
`reload`), configuration UUID, exact `HostScope`, revision, digest, and an `object`
reference with bucket, key, version ID, SHA-256 and byte count. Execution names
are `configuration-<operation>-<configuration-uuid>`; database lease attempts
never enter their identity. Before starting a missing execution the adapter
checks the configured version is ACTIVE and STANDARD. It observes an existing
execution first and recovers ambiguous start responses using the same name.
Every observed execution must match the exact version, input and scope and have
zero redrives. Failed/timed-out/aborted executions do not create replacements.

Standard execution names become reusable after 90 days. A missing execution
can therefore start only within seven days of the immutable staging object's
creation. Old staging is rejected even if AWS has removed execution history.
Recovery then needs an explicitly superseded, newly authorized configuration,
not automatic redrive or reuse of the same UUID. Referenced objects must remain
available: this change adds no deletion or lifecycle-expiration rule.

Successful workflow output is exactly `{ schemaVersion: 1, operation,
configurationId, scope, descriptor }`, where `descriptor` contains `computerId`,
`computerGeneration`, `configurationRevision` and unprefixed
`configurationDigest`. `prepare` certifies preparation only; `reload` certifies
the request only. Neither output establishes a loaded receipt. The coordinator
still requires the separate signed supervisor observation and database recheck.

Host lookup reads AWSCURRENT at
`<namespace>/computers/<computer-uuid>/generations/<generation>/control`.
The Secrets Manager response must have the exact name, same-account/region ARN,
and JSON `{ schemaVersion: 1, scope, origin, keyHex }`. `scope` must match the
recorded writer, volume and fence; `keyHex` encodes a 32-byte HMAC key. The origin
is exactly `https://c-<computer-uuid>-g<generation>.<controlDomain>`. No caller
chooses an upstream URL, service port, bucket root or signing key. Keys never
enter workflow payloads or fixed-code errors. Each operation has an eight-second
deadline, streaming reads are bounded/closed, and SDK retries are disabled.
An aborted poll does not cancel a durable execution or start/stop compute.

Before activation, implement and review the Standard workflow, SSM document,
host download/verification, atomic protected-file installation and service
reload. The workflow must recheck current database authority and the observed
writer before each host mutation, reject stale revisions, and handle explicit
cancellation. Provision versioned private S3 with enforced KMS/TLS and no
overwrite/delete permission on referenced configurations. Give host delivery
only the authorized version/prefix, never all computers' objects or secrets.
Scope the control-plane role to the configured bucket/KMS key, exact state
machine version and executions, and host-binding namespace; deny redrive and
cloud administration. Protect state/history with KMS and omit payload logging.
The existing shared host role alone does not supply these controls.

The unit suite exercises actual SDK request signing and XML/JSON/stream
serialization through a local wire handler, including races, lost responses,
wrong bytes/versions/scope, Standard/Express distinctions, cancellation, maximum
payload and secret-safe errors. These tests do not establish IAM enforcement,
SSM transfer, disk attachment, cloud isolation, stopped billing or browser readiness.
Run `bash tools/test.sh app` and the local-config production build before shipping.

## Current workflow authority check (disabled by default)

`POST /api/internal/apps/configuration-authority` lets the trusted delivery
workflow check current database authority before a host operation. It performs
no provider calls, starts no resources, and cannot acknowledge installation or
loaded configuration. Refreshing authority can persist a new desired snapshot
and delivery event, so this is not a read-only status endpoint.

Enable only after migrations through 0011, reviewed workflow deployment and dedicated
credential provisioning. `EZIL_CONFIGURATION_AUTHORITY_ENABLED` defaults to
`false`; disabled requests return 404 without accessing the database. When
enabled, `EZIL_CONFIGURATION_AUTHORITY_SECRET` is required at boot: a separate
32-byte random key encoded as 64 lowercase hexadecimal characters. Do not reuse
Supabase, host-control or browser credentials. This key belongs only in the
control plane and trusted workflow signer, never workflow input/history, SSM
arguments, containers or client bundles. No cookie or bearer fallback exists;
the proxy bypasses Supabase session refresh for this exact route.

Each request supplies `x-ezil-workflow-timestamp` (ten-digit Unix seconds) and
`x-ezil-workflow-signature` (lowercase HMAC-SHA256 hex). Decode the key from hex
and sign this UTF-8 transcript, with newlines between lines and no final newline:

```text
ezil-configuration-authority-v1
POST
/api/internal/apps/configuration-authority
<timestamp>
<lowercase SHA-256 of exact raw request bytes>
```

The body is strict JSON `{ schemaVersion: 1, configurationId, operation,
revision, digest, scope }`. `operation` is `prepare` or `reload`; `revision`
and `scope.computerGeneration` are positive 32-bit integers. The unprefixed
`digest` is lowercase SHA-256. Scope contains the computer UUID, generation,
17-hex-digit EC2 instance and EBS volume IDs, and fence UUID. The request
contains no configuration body, secrets or storage paths. IDs must match
immutable server records; possession of an ID grants no authority.

Only JSON with optional UTF-8 charset is accepted, with no query string or
content encoding. The actual body is limited to 4096 bytes and five seconds,
regardless of Content-Length. Signatures have a 30-second clock tolerance,
checked before and after body reading and again after database work. Disconnects
and stalled/oversized bodies cancel the reader. All handler responses use fixed
codes and `Cache-Control: no-store`; validation and database errors omit inputs.

The transaction locks the computer before delivery records, reuses the producer
to check current ownership, OS access, grants, releases, jobs, services, leases,
project consent and quotas, and requires the exact unsuperseded snapshot. Reload
also requires a preparation receipt. The writer must be unfenced and recorded
running, with an observation no older than five minutes or over 30 seconds in
the future. Per-statement and lock timeouts are five and two seconds; these are
not a whole-transaction deadline. A freshly produced suspended snapshot remains
deliverable after OS access is revoked so the host can remove old authority.

Success is `{ authorized: true, ...validatedRequest }`. It is a point-in-time
check, not a reusable capability. An identical fresh signed request is permitted
to repeat only by rerunning all database checks; revocation invalidates it. The
future workflow must make fresh checks before dispatch and during long work,
observe actual EC2/EBS writer state, compensate known cancelled commands, and
authenticate the final loaded descriptor. This response and the recorded writer
observation do not prove provider state or eliminate a dispatch/revocation race.
Host fencing and ongoing reconciliation remain required.

Run `bun run test:db:configuration-authority` with loopback
`EZIL_TEST_DATABASE_URL` for real replay/revocation, scope, suspension,
replacement, concurrent delivery and lock-timeout tests. HTTP/unit tests cover
signature bytes, timeouts, cancellation, strict inputs and secret-safe errors.
No cloud, hosted migration or marketplace activation occurs in these tests.
