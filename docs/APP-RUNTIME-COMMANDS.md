# Durable application commands

Migration `0005_app_runtime_commands.sql` adds the immutable intent needed to
deliver application start/stop jobs to the computer supervisor. It is additive:
existing installations, install jobs, and browser authorization generations do
not change. This migration alone does not launch an application.

Each command freezes its installation, computer, computer writer generation,
release, authorization snapshot, operation, and execution plan. Its `generation`
is a consecutive revision for that installation, starting at 1. It continues
across host replacement and is separate from `auth_generation`. Updating a
browser session or opening another window must not manufacture a new revision.

An immutable request receipt binds each accepted client request UUID to its
command. Several Open requests can reference the same running intent. Replaying
any of those UUIDs after Stop must return the original receipt, never enqueue a
fresh start. Receipts are scoped to the installation and cannot be retargeted.

The producer must, in one transaction:

1. Lock the owned live computer, then the installation. For a start, recheck OS
   access, entitlement, release approval, current writer, configuration and
   folder grants. Revocation must still allow a stop of already owned resources
   using their recorded scope; never treat a stopped command as image approval.
2. Read the latest command and reuse identical current intent when eligible.
   Otherwise allocate the next revision from the ledger, never from the clock.
3. Insert the start/stop job, its outbox event, then its immutable command.
   Record the request receipt in that transaction, including when reusing intent.

Composite foreign keys reject mixed installations/computers, cross-app releases,
missing writer generations and mismatched job operations. A deferred trigger
rejects a new start/stop job that commits without its command. Command mutation,
deletion and truncation are rejected; a referenced outbox event is retained even
after delivery. Mutable job status is separate from immutable intent. Ledger
retention/archival needs an explicit future migration that preserves revisions.

The SQL plan check only binds the release envelope and bounds the stored size.
It does not validate or authorize the full supervisor protocol. The producer and
dispatcher must validate the complete plan against maintainer approval and
server-owned port/folder records. Do not store credentials, arbitrary filesystem
roots, or client-provided infrastructure identifiers. Delivery must revalidate
current authority and discard obsolete commands before signing a request.
An HTTP acceptance receipt is not evidence that an application is running.

The gated producer is available as `apps.launch`, `apps.stop`, and
`apps.jobStatus`. Apply the reviewed migration before deploying dependent code.
Inspect the hosted schema first;
do not replay the migration journal against the hosted database. Feature flags
remain off, and rollback leaves additive data in place.

## Producer and activation

`EZIL_APP_RUNTIME_COMMANDS_ENABLED` defaults to `false`, separately from catalog
and install flags. Keep it off until computer lifecycle and application command
consumers, exact host approval provisioning, image preparation, quotas and
accounting, and authenticated application routing are deployed. This API does
not enable marketplace installation or claim that Reticle is live.

Launch accepts `computerId`, `installationId`, `clientRequestId`, and an optional
`projectId`. Stop accepts the same identity fields without a project selector.
The producer uses the authenticated OS user, locks the computer and installation,
and compiles the immutable release, active grant, persisted services/leases, and
approved selected-project grant. It accepts no image, host port, filesystem root,
EC2 ID, control credential, or arbitrary execution plan from the browser.

Reticle requires a selected project with explicit approved write consent. Launch
does not create a project grant or instrument source. The initial compiler matches
the real host's single-service Node/Reticle adapter. Unsupported companions,
configuration/secrets, outbound rules, whole-folder mounts and database adapters
fail explicitly. Additional adapters must be implemented and validated before
their releases can be admitted.

The connection adapter must still register the selected project and bind its
actual target application's authorized HTTP/WSS origin. The current plan includes
the approved OS origins and Reticle's installation origin; it does not authorize
an arbitrary target origin or browser localhost. Folder consent alone is not a
completed Reticle pairing. Application sessions must follow command/project
generation changes so an old connection cannot attach to a newly selected project.

The response contains `jobId`, command `generation`, `operation`, job `status`,
`reused`, and `isLatestCommand`. These describe durable intent/history, not serving
readiness or a bootstrap credential. A client reuses its request UUID on a network
retry and generates a new UUID for a new user action. An older receipt may return
`isLatestCommand: false`; it never re-enqueues its old command. Even when several
fresh Open requests share one job, every accepted request retains its own receipt.

A prepared stopped computer gets one durable computer-start job, outbox event,
and immutable lifecycle intent for its existing writer generation. All three
commit with the application command, request receipt and audit. The producer
uses the last canonical v1 lifecycle or v2 recovery instruction to retain the
existing writer's deployment, checks it against `EZIL_LIFECYCLE_DEPLOYMENTS`, and
freezes the recorded instance ID, disk ID and fence token. Empty or revoked
deployment approval denies new requests. No browser input selects these values.
V1 and v2 use one consecutive lifecycle revision ledger.

Concurrent Opens share the same pending computer start. A pending job without
an immutable instruction requires explicit recovery; it is never silently
backfilled. Failed, cancelled, unacknowledged or spent work is not revived by a
new Open. Replaying an accepted request returns its historical receipt without
changing desired state. A running approved writer adds no computer start job.

This path reads the schema through migration `0008`; apply reviewed additive
migrations before enabling the runtime API. It does not enable any flag,
scheduler or cloud transport. Provisioning and replacement must establish the
runtime/disk/writer association first. The producer does not allocate resources
or fence a writer. Pending stop/replacement/migration work blocks a new Open.
Stop records the last owned plan without requiring a still-approved release or
grant, and never queues a computer start. Status queries read the database only.

The dispatcher must validate current authority and the latest command again,
deliver signed requests with lease/attempt fencing, and observe the actual host.
A returned 202 is not completion. Reusing a completed start reuses its desired
intent; it does not assert health or renew a lease. The controller must reconcile
automatic runtime expiry to a durable Stop command, and invalidate launch sessions.
Do not infer expiry from command creation time: a queued build or startup delay
is not measured runtime. Never retry an expired generation to obtain a new host
deadline. A fresh Open after an observed computer stop or fenced replacement gets
a new command revision; concurrent Opens still deduplicate.

## Local verification

Run `bash tools/test.sh app` from the repository root. The dedicated PostgreSQL
check is:

```sh
cd app
EZIL_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres \
  bun --no-env-file run test:db:runtime-commands
```

The URL must be loopback and the test role must have `CREATEDB`. The suite creates
a uniquely named database, applies the local migration files, exercises actual
commits/rollbacks and independent concurrent connections, then drops only that
database. It never migrates the supplied database or loads `app/.env`. CI runs
the same suite on its disposable PostgreSQL service. These checks do not prove
supervisor delivery, EC2/EBS behavior, or a functional marketplace application.

Run `bun --no-env-file run test:db:runtime-api` with the same loopback variable
for actual producer transactions and tRPC method/serialization checks. That suite
uses independent database connections rather than a mocked transaction callback.
`EZIL_TEST_COMPILED_PLANS=/absolute/output.json` optionally writes the test-generated
Node and Reticle plans for checking against the supervisor's v1 protocol. These
are synthetic release fixtures, not real runtime or public-release acceptance.

`bun --no-env-file run test:db:application-computer-start` exercises actual
PostgreSQL authority checks, concurrent starts, immutable deployment reuse and
recovery refusals. The runtime API suite also passes its produced instruction
through the existing lifecycle consumer. The recovery consumer suite verifies
that a later application Open retains a recovered writer's per-writer profile
and disk. Provider responses in these suites are fixtures; a settled computer
job leaves the application job pending until separate host readiness checks pass.

## Dispatcher and host observations

`runtime-dispatcher.ts` consumes immutable Start/Stop commands through an
explicitly enabled internal factory. No route, cron, or process entrypoint enables
it yet. A trusted resolver must return the provisioned computer generation's
exact HTTPS origin, signing key, instance ID, fence token, and data-volume ID.
Resolver lookup is bounded to five seconds. It must not provision, wake compute,
pull images, or use caller-selected upstream addresses. Provisioning and host
approval-file delivery remain separate work; leave the public feature flags off.

The consumer leases one due event with `FOR UPDATE SKIP LOCKED`. A 45-second
lease and monotonically increasing attempt fence delayed workers. It rechecks
computer ownership, Supabase user deletion/ban, OS access, entitlement, approved
release, current writer, installation authorization generation, port leases and
selected-project consent before delivery. Exact plans are recompiled and compared
with immutable intent. Computer, installation, outbox and authority locks remain
held through bounded delivery; expired/superseded attempts cannot commit a result.
The host's own monotonic command ledger fences already-sent older traffic.

Requests use the host v1 HMAC protocol over exact body bytes, method, path,
timestamp and fresh nonce. Reconcile keeps its job UUID on retry. The client
requires HTTPS outside explicit private loopback validation, rejects redirects,
bounds each request/body read to eight seconds and responses to 16 KiB, and emits
fixed error codes. Origins are trusted provisioning configuration; parsing an
HTTPS URL does not establish DNS/SSRF safety. Host credentials and provider handles
never appear in a browser descriptor or public job response.

This client requires the command-bound observation protocol introduced in #108
(supervisor `5f82a08`). A legacy `{ installationId, state }` response is rejected.
Success requires the matching computer/installation/command generations, canonical
intent digest, desired state and a settled driver result. A running Start also
requires its original durable deadline. A 202 receipt and health observed while
reconciliation is pending do not complete a job. Stop can complete from a recorded
provider observation that the VM is stopped; it never wakes a computer.

Successful Start delivery leaves its event scheduled for observation every 30
seconds. This is independent of browser polling and necessary to detect later
revocation, failure or expiry. A superseded event closes without rewriting a
previously successful job's history. A changed authority or observed expired
reservation atomically creates a new Stop command/outbox/audit event. Merely
cancelling Start delivery could leave an already accepted runtime running after a
lost response. Stop uses retained owned scope even after release/project revocation.
Failures remain retryable; logs and job errors contain codes rather than secrets
or raw SQL/transport exceptions. Job success remains historical, not a live-health
promise. Continuous monitoring requires a deployed consumer; this library does
not provide a scheduler, independent watchdog, daily accounting, session
revocation, or a strict billing cap.

Run the dedicated real PostgreSQL suite on a disposable loopback database:

```sh
cd app
EZIL_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres \
  bun --no-env-file run test:db:runtime-dispatcher
```

It uses actual independent transactions for claim races, lease takeover, Start/
Stop ordering, authority locking, rollback and project revocation. Its host driver
is instrumented. The cross-package check additionally sends producer-generated
plans through the actual built Node supervisor's signature/protocol/SQLite code:

```sh
# First build supervisor in its checkout with bash tools/test.sh supervisor.
cd app
EZIL_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres \
  EZIL_TEST_COMPILED_PLANS=/tmp/ezil-runtime-plans.json \
  bun --no-env-file run test:db:runtime-api
EZIL_TEST_SUPERVISOR_ROOT=/absolute/supervisor-checkout \
  EZIL_TEST_COMPILED_PLANS=/tmp/ezil-runtime-plans.json \
  bun --no-env-file tests/host-control-acceptance.ts
```

The cross-package check fails if its inputs or native Node supervisor are missing.
It verifies both Node and Reticle plans, signatures, generation-bound observations,
unchanged retry deadlines and rejection of old Start after Stop. Its instrumented
execution driver does not establish Docker or EC2 isolation, Cloudflare routing,
project pairing, an installed Reticle window, or either marketplace milestone.
The separate supervisor Linux container/host suites provide local execution
coverage; approved cloud and authenticated OS acceptance are still required.
