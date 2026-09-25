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

The producer must, in one transaction:

1. Lock the owned live computer, then the installation. Recheck OS access,
   entitlement, release approval, current writer, configuration and folder grants.
2. Read the latest command and reuse identical current intent when eligible.
   Otherwise allocate the next revision from the ledger, never from the clock.
3. Insert the start/stop job, its outbox event, then its immutable command.

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

No producer or consumer is enabled by this schema change. Apply the reviewed
migration before deploying dependent code. Inspect the hosted schema first;
do not replay the migration journal against the hosted database. Feature flags
remain off, and rollback leaves additive data in place.

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
