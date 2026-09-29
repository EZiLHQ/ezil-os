# Shared production migration protocol v1

The portable, dependency-free Node engine is `.github/scripts/production-migrations.mjs`.
Copy it unchanged into Gateway, Works and OS; each repository supplies its own
`.github/production-migrations.json`. Node 20+ and Git are required. The CI workflows run validation before deployment and apply only on an
authorized production release. Application SQL is unchanged by this setup.

```sh
node .github/scripts/production-migrations.mjs validate
node .github/scripts/production-migrations.mjs plan
node .github/scripts/production-migrations.mjs apply
```

`validate` reads local files and Git's tracked/unignored SQL inventory, checks
every registered byte-level SHA-256, rejects missing/extra SQL, symlinks, malformed
manifests, duplicate IDs/paths and broken catalog chains, and parses every
executable migration. It never uses the network or needs a token. An unset initial
catalog is an explicit valid preparation state, reported as **apply disabled**.

`plan` uses the Supabase Management API with `SUPABASE_ACCESS_TOKEN` supplied by
the caller. It sends `read_only: true` and runs a repeatable-read, read-only
transaction. It reports only the catalog digest, catalog entry count, observation
time, historical/current snapshot digests and pending IDs. If a baseline is present in the manifest, it checks that
the current catalog matches that baseline or the journal's applied prefix and
refuses drift. It creates no schema, tables, baseline or migration records. A
transaction-local PostgreSQL setting carries the pending-count result; this is
not an application feature flag. Plan does not prove apply authorization or
absence of event triggers; apply makes those checks separately.

`apply` is enabled only with a reviewed initial catalog and all of:

- `GITHUB_ACTIONS=true`, matching repository, and an exact, clean tracked HEAD.
  Untracked non-SQL runtime artifacts, such as OS's `tested-images.json` and
  `previous-release.json`, are accepted. Untracked SQL is still inventoried by
  `validate` and refused by `apply`; tracked changes, additions and deletions fail.
- A main `push`, main `workflow_dispatch`, or a completed successful `workflow_run`
  whose numeric `workflow_id` appears in `trustedWorkflowRuns`. The upstream run
  must itself be a main push/manual run in the same repository. PR-origin and
  fork-origin runs are refused. These paths require `GITHUB_REF=refs/heads/main`.
- A version-tag `push` may also apply, retaining its actual `refs/tags/v...` ref.
  The local tag peeled to a commit, checkout HEAD, event SHA and freshly fetched
  current-main SHA must all agree. The GitHub API must confirm that the latest
  main push run at an allowlisted numeric workflow ID completed successfully for
  that exact SHA in this repository. A newer failed or in-progress run cannot be
  hidden by an older success. OS can allow CI ID `343124584` in
  `trustedWorkflowRuns`; the same allowlist governs both tag and workflow-run
  authorization. An empty allowlist disables both. Missing tags, stale tags,
  ordinary branches, PRs and unverified CI are refused.
- `GITHUB_TOKEN`, `GITHUB_EVENT_PATH`, and a fresh authenticated GitHub
  `GET /repos/{repository}/commits/main` response. Its SHA must match both the
  checked-out HEAD and the event SHA (upstream head SHA for workflow-run).
- `SUPABASE_ACCESS_TOKEN` for the manifest's explicitly pinned project. No token
  files are loaded by the engine, and neither tokens nor API error bodies are
  printed. Workflow owners must grant only the required permissions and scope
  production secrets to trusted runs.

The tag path preserves OS's gated reusable preview and signed native-release
flow; it does not rewrite `GITHUB_REF` or publish anything. Workflows must fetch
the tag locally and grant `actions: read` and `contents: read`. Version tags use
`vMAJOR.MINOR.PATCH` with the optional dot/hyphen suffix accepted by OS deploy.
For this path, main-only means the source is exact tested current main.

The current-main check occurs immediately before the database request. GitHub
and PostgreSQL cannot share a transaction: a later push can advance main after
that check. Workflows should serialize production deployment and recheck main
before any subsequent deployment. This engine cannot enforce branch protection,
review requirements, workflow permissions or prevent callers bypassing it with
another SQL client. Do not run production apply from PR workflows.

## Captured production baseline

The manifest pins repository `EZiLHQ/ezil-os`, shared project
`btgqfmnzycdecmeyqubx`, and catalog schemas `public`.
On 2026-09-29T15:45:14.939Z, a read-only query observed
1794 catalog entries. The manifest records the observed
digest and historical source digest. All 3 current SQL files are
inventory snapshots; there are zero pending migrations. No historical SQL was
replayed and no application schema was changed during capture.

Source inventory is not proof that every fragment is installed. Works canonical
fragments and deliberately uninstalled paid-authorization SQL remain snapshots;
this pipeline preserves the existing hosted rollout ledger and feature flags.
OS fingerprints the whole shared `public` schema, including legacy tables.
Changes to that schema from another project will stop OS deployment as catalog
drift until reviewed; no unknown objects are dropped or automatically adopted.
Gateway fingerprints `ezil_ai`; Works fingerprints `ezil_universe` and
`ezil_works`. The journal is in the separate private `ezil_ci` schema.

A successful main apply rechecks the captured digest under the shared lock before
registering it. It never creates missing application objects. To capture a new
repository before its initial registration, run `plan` with the management token
supplied by the environment and copy the reviewed `observedCatalog` unchanged
into `initialCatalog`. Never derive a hosted baseline by replaying source SQL.

## Journal, catalog and retries

One transaction-scoped advisory lock, `(1702521196, 1835624306)`, serializes all
repositories using this protocol in the same database. One API request contains
the explicit transaction, journal setup, validation, all pending DDL and journal
writes. A failure rolls back all of them, including first-time journal setup.
Lock and statement timeouts are 30 and 120 seconds.

`ezil_ci.baselines` records repository, project, sorted owned schemas, observed
initial digest, historical snapshot-set checksum and registration time. The
existing `snapshots` column stores `initialCatalog.sourceDigest`, captured once
with the baseline. It is never recomputed from the current source inventory
during registration verification. No journal table shape or privacy change is
needed for this separation.

`ezil_ci.journal` records repository + migration ID, source checksum, explicit
ordinal, before/after catalog digests and application time. Baseline registration
adds **zero migration rows**. It records actual observed state, not which
historical file might have produced it.

The schema and tables are private, owner-controlled and RLS-enabled; PUBLIC,
anon, authenticated and service_role grants are revoked. Unexpected owners,
extra grants, table shape/constraints, routines, policies, rules and application
triggers in the journal are refused. All repositories must use the same database
owner identity. Active database event triggers must match the exact reviewed inventory described below.

Every apply verifies the registered baseline and historical source digest, all
applied IDs/checksums/order/catalog links, a contiguous applied prefix, current catalog,
and each pending migration's before and after digests. Unknown IDs, missing
objects, unregistered schema additions and checksum drift stop the transaction.
On timeout, disconnect or ambiguous HTTP result, rerun the same reviewed manifest
from an eligible current-main run. The committed journal determines whether to
skip or retry. There is no automatic blind HTTP retry and no resume marker
outside the transaction.

The catalog query hashes schema owners/ACLs; relations and columns; defaults,
constraints and indexes; routine definitions/configuration/ACLs; types and enums
(including defined base types and their input/output, receive/send,
typmod, analyze and subscript function identities, layout and related types);
RLS policies; triggers and rules; sequence definitions (never values); schema
default ACLs; inheritance/partition definitions; extensions; operators, operator
classes and families, their access-method
operator/support-function mappings (`pg_amop`/`pg_amproc`); symbolic dependencies
and extension membership; and schema-member identities. OIDs in the added
metadata resolve to symbolic identities; extension members are fully included.
It reads PostgreSQL catalogs only. The manifest stores a SHA-256 and
the number of fingerprint entries, not user rows or full SQL definitions.
Application data, sequence counters, comments and physical/statistical state
are outside the fingerprint. Dependencies include symbolic external references;
definitions of referenced objects outside owned schemas and global role
membership remain outside the fingerprint. Unsupported object classes,
foreign tables, aggregates, range/multirange/pseudo and undefined shell types
refuse baseline/apply rather than receiving an incomplete automatic baseline.

Catalog text is PostgreSQL-version-sensitive. Derive before/after digests with
this exact engine, matching PostgreSQL major version, roles, extensions and
schema metadata. A database major upgrade or broader catalog support needs
explicit review; do not replace an existing baseline to silence drift.

### Reviewed platform event triggers

The `reviewedEventTriggers` inventory was reviewed against live definitions on
2026-09-29. Each SHA-256 covers event, enabled mode, tag filters, trigger owner,
function body/identity/owner/ACL/configuration/security properties, containing
schema ownership/ACL and function extension membership. Both read-only plan and
apply require the exact active inventory. Apply checks before any DDL and again
before commit. An empty inventory permits no active triggers. No trigger is
disabled or changed by this protocol; added, removed, disabled or modified hooks
require a new review rather than automatic adoption.

The seven existing hooks have these reviewed effects:

- `ensure_rls`: enables RLS only for new tables in `public`; skips private
  `ezil_ci`. Future public migrations must account for the RLS change in their
  expected catalog.
- `issue_pg_cron_access`, `issue_pg_graphql_access`, `issue_pg_net_access`: only
  react to CREATE EXTENSION, which the additive grammar does not permit.
- `issue_graphql_placeholder`: only reacts to DROP EXTENSION, also prohibited.
- `pgrst_ddl_watch`, `pgrst_drop_watch`: emit transactional schema-reload
  notifications; do not mutate application rows or schema objects.

Catalog checks still require the reviewed before/after application state. Global
role membership and arbitrary transitive callees are outside this fingerprint;
new hook bodies must be reviewed, not merely rehashed. Supabase platform upgrades
that change these definitions will stop releases until reviewed.

## Adding a reviewed migration

Keep the complete `initialCatalog` and all applied migration entries unchanged.
Snapshot SQL (canonical fragments, documentation, test fixtures and deliberately
uninstalled plan-only files) may change through review. Update each changed
`sources[].sha256`, register newly added SQL and remove deleted snapshot paths
so `sources` always describes the current checkout. `validate` still checks every
byte and the complete tracked/unignored SQL inventory. It does not compare the
current snapshot-set digest against the historical baseline digest.

Snapshot edits are never executed by the helper, even when they describe desired
DDL or contain plan-only SQL. A snapshot-only change needs no executable migration
if the database catalog should stay unchanged; plan/apply still check that catalog.
Any intended catalog change requires a separate reviewed forward migration.
Never label canonical fragments as migrations merely to replay them.

For that forward change, add a new SQL source with
`kind: "migration"` and its SHA-256, then append one explicit migration object
with exactly `id`, `path`, `sha256`, `before`, and `after`. Array order is execution
order. `before` equals the previous `after`, or the initial digest for the first
entry. Both digests must be observed, not guessed. Use a disposable database
containing reviewed schema metadata to rehearse the change and obtain its after
digest; do not replay Works' fragments to construct that database. No SQL for an
actual future change is included in this initial implementation.

`plan` returns the preserved historical `sourceDigest` inside `observedCatalog`
and separately reports `currentSourceDigest` for the current snapshots. Both
source digests use SHA-256 of the JSON array of `{path,sha256,kind}` snapshot
entries sorted by path. Once registered, an observation of current state must
not overwrite `initialCatalog` or any applied migration's before/after/checksum.

When upgrading a manifest that predates `sourceDigest`, recover the historical
value from its existing `ezil_ci.baselines.snapshots` record (read-only) or
reproduce it from the reviewed baseline commit, then add that exact field. Do
not substitute today's source inventory or update/delete journal records. An
unregistered baseline must instead be recaptured with the final engine. This
expanded catalog fingerprint is incompatible with previously registered older
fingerprints: such a database needs a separately reviewed protocol transition;
there is no automatic rebaseline or drift-bypass switch.

The automatic grammar intentionally supports only:

- `CREATE TABLE owned_schema.name (...)` with named columns and allowlisted
  built-in types, optionally `NULL` or `NOT NULL`.
- `ALTER TABLE owned_schema.name ADD COLUMN ...` using the same column grammar.
- Plain, nonunique `CREATE INDEX name ON owned_schema.table (column, ...)`.

Comments (including nested block comments) and quoted identifiers are tokenized;
statements are not split using a semicolon regex. Expressions, defaults, custom
types, routine bodies, DO/CALL, CREATE OR REPLACE, transaction control,
DROP/TRUNCATE/DML, SELECT/CTAS, concurrent indexes, and other syntax are refused.
Additional syntax requires a reviewed engine extension, not an override flag.
Migration SQL runs inside a DO block with escaped string literals, preventing
transaction escapes even if source text contains quotation delimiters. There
are no updates to application feature flags.

## Validation

```sh
node .github/scripts/production-migrations.mjs validate
node --test --test-isolation=none e2e/production-migrations.test.mjs
PRODUCTION_MIGRATIONS_DOCKER=1 node --test --test-isolation=none e2e/production-migrations.test.mjs
```

`--test-isolation=none` is useful with Node 24 in the restricted worker sandbox;
on Node 20, omit it. The default transaction tests use this repository's existing
PGlite dependency (PostgreSQL 18.3 here). Docker mode uses only the existing
`postgres:16-alpine` image (`--pull=never`), an isolated disposable container,
no host ports, and adds a concurrent-retry test. It removes the container on exit.
The extension regression runs `CREATE EXTENSION btree_gist SCHEMA ezil_universe`,
checks all six `gbtreekey` base types, baseline retry and OID-independent
recreation, and detects operator/class/family, amop/amproc, type I/O and
extension-membership changes. Catalog mutation probes roll back in the same
connection in both test modes.

The coordinator runs the native Docker mode as well as the focused helper
checks. All test SQL and records live in disposable databases, and are separate
from production migrations and baseline evidence. OS uses Docker mode without
adding a PGlite dependency. Docker mode needs the pinned image pulled first.
