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
