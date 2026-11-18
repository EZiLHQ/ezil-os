# Native SQL admission on AWS production

The existing production schema runner has a separate `--native-production`
mode for the four reviewed native migrations. It uses the existing
localhost:5432 route inside the DB network namespace and rechecks the supplied
PostgreSQL system ID, database, and maintenance role within the operation.

The placement and image-rebase prerequisites and `0030` delegation replay
must already be in the production ledger. The runner verifies their source
hashes and catalog. It admits the exact previously logged `0023` apply receipt
without making that migration executable from this mode. Ordinary
`--only app/drizzle/0030_delegation_replay.sql` remains available.

Take a read-only preflight with independently trusted database identity pins.

```sh
node app/scripts/billing-staging-schema.mjs plan --native-production \
  --target aws-production --expect-system-id VERIFIED_DIGITS \
  --expect-role postgres --expect-database postgres
```

Review the enabled event-trigger inventory against the previously approved
production inventory and use the matching preflight fingerprint. Under the
standard production maintenance lock, run the exact candidate.

```sh
node app/scripts/billing-staging-schema.mjs apply --yes --native-production \
  --target aws-production --expect-system-id VERIFIED_DIGITS \
  --expect-role postgres --expect-database postgres \
  --expect-event-trigger-sha256 REVIEWED_DIGEST
```

The apply transaction serializes with the receipt table, verifies the exact
production preconditions, and installs `0029`, `0031`, `0032`, and `0033` in
order with their receipts. A full exact prior batch is a no-op. A partial,
unknown, or conflicting batch requires operator reconciliation. If the
response is lost, rerun only the read-only plan first to verify whether all
four receipts committed. The runner never retries automatically.

The focused real PostgreSQL test accepts only an operator-created
network-disabled disposable container labelled
`ezil.purpose=native-production-sql-disposable`.

```sh
NATIVE_PRODUCTION_SQL_TEST_CONTAINER=DISPOSABLE_CONTAINER node --test \
  app/scripts/billing-production-native.test.mjs \
  app/scripts/billing-staging-schema.test.mjs
```
