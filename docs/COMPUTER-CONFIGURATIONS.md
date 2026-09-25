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
explicit enable switch; no HTTP handler, cron, provider call or public feature
flag invokes it yet. Apply migration 0006 before deploying a caller. Disabled
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
