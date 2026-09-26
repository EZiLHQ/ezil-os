# Durable computer filesystem identity

Migration `0010_computer_filesystem_identity.sql` adds a nullable, unique
`data_filesystem_uuid` to `ezil_computer_runtimes`. The controller needs this
identity across instance replacement because the mount helper compares the
actual filesystem UUID as well as the full EBS volume serial and computer
marker. An EC2 instance ID or an empty mount directory cannot supply it.

New runtime rows without a data volume reserve a random UUID in the database
before volume allocation. Once set, it cannot be changed or cleared. Changing
writer generations, stopping compute and attaching the retained disk preserve
the same UUID. Runtime identity cannot be moved to another computer, and two
computers cannot register the same UUID. Existing service-only RLS continues
to prevent direct user reads and writes.

Existing rows are deliberately not backfilled. A runtime inserted with an
already assigned volume also receives no generated UUID: inventing one would
not identify that volume's filesystem. A trusted operator must inspect the
actual disk and explicitly register its verified UUID. Concurrent registrations
serialize; only one value can commit. Registration does not authorize launch,
attachment, formatting, adoption of an unmarked disk or access to user data.
The database cannot prove that an operator supplied the actual on-disk UUID.

This is the schema prerequisite for controller delivery of the mount plan in
`supervisor/DATA-VOLUME.md`. That consumer is not implemented in this change.
It must authenticate controller authority, require a known UUID, verify the
current computer/writer/volume association and preserve it in a protected host
plan. Only an explicitly authorized newly allocated blank disk can receive
`initialize`; retained disks and replacements receive `mount`. Never infer
format authority from a NULL UUID or a failed mount. Existing immutable v1/v2
lifecycle documents and their allocation tokens are unchanged.

Before applying to a hosted database, inspect the live schema and migration
history, review the new transaction and identify any existing unknown disks.
Apply only this reviewed migration after its predecessors; do not replay old
migrations or use schema push. This PR does not apply a hosted migration or
enable any feature flag. Rollback disables dependent consumers and retains
the additive column and registered identities.

Local verification uses an isolated PostgreSQL database. The test helper
refuses non-loopback URLs and creates/drops only its randomly named fixture
database:

```sh
bash tools/test.sh app
cd app
# Supply EZIL_TEST_DATABASE_URL for the dedicated local test server.
bun run test:db:filesystem-identity
```

The suite tests migration over existing disk/writer rows, pre-allocation UUID
reservation, instance-generation replacement, retained imports, immutable and
unique identity, concurrent registration, transaction rollback and actual RLS
denial. These database checks do not establish filesystem persistence, EBS
encryption/attachment, provider fencing or an installed Reticle application.
