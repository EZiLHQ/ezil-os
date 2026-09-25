# Host control protocol

The `createControlService` factory supplies the authenticated HTTP boundary and
durable intent queue. The [Docker driver](DRIVER.md) now implements real local
execution. The [Linux host executable](HOST.md) connects protected configuration,
locking and process recovery. A control-plane client and provider controller must
still be connected. No
production endpoint or cloud resource is created by this package.

## Authority and wire format

The host listens on loopback behind its computer-scoped Cloudflare Tunnel.
`POST /v1/control` accepts JSON up to 64 KiB. HMAC authentication binds the
method, exact path, exact body digest, timestamp, and nonce. The signing secret
belongs only to that computer generation. Browser/Supabase credentials are not
accepted or forwarded.

Every command contains schema version 1, a request UUID, computer UUID,
computer generation, and installation UUID. A `reconcile` command additionally
contains an installation command generation, desired `running`/`stopped`
state, and an immutable execution plan. The plan contains approved image,
services, host-port leases, private directory names, selected project UUIDs,
mount destinations, origins, and resource limits. Host filesystem roots and
provider IDs are absent. `observe` accepts only the identity envelope.

The controller must compile plans from the approved manifest/policy and current
database records after checking user/OS access, computer ownership, grant,
installation, release, and project consent. The host's plan-approval callback
must check configured image repositories/digests and supported runtime
requirements. A digest by itself does not prove approval. Direct local image
IDs and loopback origins exist for private validation; a production bootstrap
must refuse them. Signing requests is deployment authority and must never be
made available to publishers or application containers.

The installation command generation is a monotonically increasing controller
revision, distinct from the browser authorization generation. The future
producer must persist/increment it transactionally with the job/outbox before
sending it; it must not invent a revision from wall time or request arrival
order. No existing Postgres producer uses this protocol yet.

## Receipts and recovery

After validation, the host commits intent and returns HTTP 202 with a queued
receipt. It then schedules reconciliation. A receipt does not mean a container
exists or is healthy. Observation calls only the driver's observation method;
it neither enqueues work nor starts a service.

`ControlStore` uses Node 24's built-in `node:sqlite`, WAL mode, synchronous FULL
transactions, and a private directory/database. Node still labels this API
experimental: validate the host Node version when changing the pinned runtime.
The database is host-private recovery state, never an application database or
the primary control-plane record. It must be outside every application mount.

Nonce reservations survive process restart. Request IDs cannot be reused for
different intent. Conflicting plans at the same generation and older commands
are rejected. Observations update only their matching generation; a delayed
start result cannot overwrite a newer stop. HTTP observations also return the
computer UUID/generation, installation UUID, command generation, desired state,
canonical intent digest, observed state, `settled`, and `runtimeDeadlineMs`.
The digest uses `intentDigest` (canonical JSON excluding requestId). A command
change during the driver's read returns `409 observation_superseded` instead of
labelling an older result with the new revision. `settled` is true only when no
reconciliation is pending and the actual state matches its committed result.
A running health check during startup therefore cannot complete a job. A
controller must match all identity/digest fields and the expected desired state,
and recheck its own current command and delivery lease before recording success.

The deadline is the original durable host reservation, or null when none exists.
Reading it never renews runtime. Expiry may produce an observed stopped state
that differs from the last committed running result; the controller must record
a new Stop intent rather than replay the expired Start for a fresh allowance.
Observation is a point-in-time check, not a guarantee of future health or billing.
A revoked plan can still be
stopped. The database's computer identity/generation cannot silently change.
For that reason, a stopped command may only stop/observe already owned
resources; it must never pull its supplied image or prepare new mounts. Image
preparation for installation needs a separately approved operation.

Runtime deadline reservations are keyed to the installation command generation
and exact intent digest, committed before Docker creation, and never extended
by retries or deleted containers. They do not implement daily user accounting.

The store bounds live nonces to 10,000 and retained request IDs to 100,000;
capacity/database failures fail closed. A retention/compaction policy must be
established before unattended long-term operation. A service restart does not
automatically start persisted plans: the control plane must revalidate authority
and retry the durable job with a fresh signed request. Replacing an instance
requires controller-side writer fencing, a new computer generation/secret, and
recovery from authoritative records.

## Execution driver requirements

The HTTP unit tests use an instrumented driver to verify the boundary. The
separate Linux driver suite sends signed HTTP requests to actual Docker
containers. Before enabling production launches, driver/bootstrap integration
must prove:

- Actual data-mount/marker admission before creating or starting services.
- Host paths and container names derived from server identities; no caller
  filesystem roots, shell commands, Docker socket mounts, host networking, or
  cloud credentials inside applications.
- Safe directory binding that withstands symlink/rename races in user-writable
  projects. The [Linux mount primitive](MOUNTS.md) has real Docker race coverage;
  the driver owns staging and cleanup, including recovery from earlier driver
  objects. A full host restart still needs bootstrap acceptance.
- Immutable image verification, approved per-container options, private
  networks, memory/concurrency admission, and stable non-conflicting host ports.
- Generation checks before and after asynchronous work; stop obsolete
  generations and confirm provider state before reporting completion.
- Idempotent reconciliation against observed containers so retried requests
  neither allocate duplicates nor rebuild an existing release.
- Authenticated service health checks, bounded operations, cancellation,
  lifecycle deadlines, and cleanup restricted to this computer's resources.

The existing Reticle adapter/container tests establish its own behavior. They
do not establish these host-driver properties, EBS fencing, Cloudflare launch
sessions, or production readiness.
