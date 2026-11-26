# OS parity schema preflight

`deploy/aws/os-staging/parity-schema-preflight.mjs` is a standalone, read-only
catalog and migration-ledger observation payload. It does not apply migrations,
certify parity, adopt unreceipted objects, or generate a release manifest.
The coordinator owns transport, target selection and live execution. This worker
has performed local synthetic validation only, with no deployed database reads.

## Coordinator execution contract

Run **inside the selected actual web container**, working directory
`/workspace/app`, using its existing `node_modules/postgres` and existing
`SUPABASE_DATABASE_URL`. Feed the reviewed script bytes over stdin:

```sh
# Inside the independently selected production web container, cwd /workspace/app:
node --input-type=module - production < /path/to/reviewed/parity-schema-preflight.mjs
# Independently selected staging web container, same cwd:
node --input-type=module - staging < /path/to/reviewed/parity-schema-preflight.mjs
```

The paths above illustrate stdin delivery; the transport wrapper can supply stdin
without writing a payload inside the container. The companion `parity-schema-preflight.py` implements the pinned host transport without remote file writes.
Do not replace or manufacture `EZIL_GIT_SHA` to satisfy the guard. It must already
match the actual container source:

| Mode | Required existing `EZIL_GIT_SHA` |
| --- | --- |
| production | `86a6e55dd33275098f62a829e4d9493184cbdd9a` |
| staging | `308447f793384e100efc87ec35739304327a48dc` |

An unknown mode, missing SHA, or different SHA refuses before driver loading or
connection-value access. The source pin is an environment assertion, not a
cryptographic attestation of the image or database identity. The coordinator
must independently select the right container and verify its deployment.
Staging evidence must never substitute for production evidence.

The driver is resolved with `createRequire` anchored in the working directory,
so stdin module location cannot redirect package resolution. No application
modules, credential files, environment files, CLI programs or provider APIs are
used. Importing the module does not connect or run `main`. It exports source and
SQL pins, SQL contracts, `collectEvidence`, `runPreflight`, and error sanitization
for local tests and wrapper integration. Callers of these functions must use
`sanitizedError` rather than log thrown driver errors. Direct mode does this.

## Read and output bounds

- One reserved connection; startup `default_transaction_read_only=on`,
  `statement_timeout=3000`, `lock_timeout=1000`,
  `idle_in_transaction_session_timeout=5000`, `search_path=pg_catalog`.
- Explicit `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`; verifies effective
  startup and transaction settings. Sets transaction-local `row_security=off`
  so a ledger query subject to RLS fails rather than reporting hidden rows as
  an empty ledger. This does not grant privileges or bypass RLS.
- Only catalog SELECTs, allowlisted ledger SELECTs and transaction/session
  controls. No DDL, DML, temporary objects, `DO`, application functions, or commit.
  Savepoints recover individual ledger read failures; final cleanup is rollback.
- Five-second connection timeout, 45-second total deadline, at most 80 probe
  statements plus unconditional rollback, 1,024 rows per catalog result and 256
  returned rows per ledger. A sentinel row detects overflow. Ledger `count(*)`
  is exact within the snapshot when accessible and is bounded by statement and
  wall timeouts. The connection closes with a one-second shutdown allowance.
- Output is one JSON document; no notices, driver errors, URLs, credential values,
  role/user identities, customer rows, application row counts, SQL definitions,
  default expressions, policy expressions or repository/project values.
  Raw definitions are used in memory only for SHA-256. Unrecognized identifier
  and checksum values are represented by hashes; known reserved migration names
  and numeric ledger ordinals/versions are retained. Catalog identifiers use a
  restricted identifier alphabet; unfamiliar type/name spellings are hashed.

Exit 0 means bounded observations were collected without an evidence gate. It
**does not mean parity or a migration is installed**. Exit 2 returns partial
observations with explicit gates. Exit 1 is refusal or probe failure and returns
only a sanitized error code, never driver message/detail/stack. A fatal catalog
failure discards partial observations. An inaccessible private ledger remains an
unresolved gate even if another ledger is readable.

## Catalog scope

The fixed public relation list covers all tables created or altered by the
reviewed migrations and the two assignment-clock trigger hosts:

- `ezil_assignment_migration_clock`, `ezil_compute_migrations`,
  `ezil_computer_placements`;
- `ezil_editor_bridge_owner`, `ezil_agent_sessions`, `ezil_agent_operations`,
  `ezil_agent_events`, `ezil_control_operations`;
- `ezil_operator_entitlements`, `ezil_named_computer_creations`.

`pg_class`, `pg_attribute`, `pg_type`, `pg_attrdef`, `pg_constraint`, `pg_index`,
`pg_trigger`, `pg_policy`, `pg_namespace`, and `pg_proc` supply column names,
types, nullability, default hashes, RLS flags, object counts and definition
hashes. Constraint validation/deferrability, index validity/readiness/uniqueness,
and trigger enabled/internal state are included. Policy definitions and role
sets are hashed together without emitting roles. No application table is queried.

Only the two fixed function names
`ezil_record_assignment_migration_clock` and
`ezil_record_assignment_migration_ready` are inspected. Function signatures and
`pg_get_functiondef` results are hashed, never printed. Overloads are counted.
A missing object is explicitly `absent`; a wrong relation kind is a gate.
Structural hashes cover this bounded scope, not the full database, privileges,
extensions, dependencies or the production migration engine's catalog digest.
They can differ across PostgreSQL versions due to definition rendering.

## Ledger scope and gates

The following exact shapes are recognized. Additional columns, different types,
views, foreign tables or generated columns refuse row reads as `unknown_shape`.
Unknown shape is distinct from `absent` and `inaccessible`.

| Candidate | Only selected data columns |
| --- | --- |
| `ezil_ci.baselines` | `initial_catalog`, `snapshots` (hashes) |
| `ezil_ci.journal` | `id`, `checksum`, `ordinal`, `before_catalog`, `after_catalog` |
| `drizzle.__drizzle_migrations` | integer `id`, `hash`; bigint `created_at` recognized but not read |
| `public.__drizzle_migrations` | same as Drizzle above |
| `public.schema_migrations` | `version` for bigint+boolean `dirty`, or single text/varchar version shape |
| `public.ezil_staging_schema_log` | `file`, `sha256`; `mode`/`applied_at` recognized but not read |

The private ledger shape comes from `.github/scripts/production-migrations.mjs`.
The staging ledger is independently grounded in
`app/scripts/billing-staging-schema.mjs` and
`app/scripts/billing-editor-staging.mjs` at the pinned staging commit. Its presence
on production is possible; its name does not establish environment or authority.

`schema_usage_denied` or `table_select_denied`, with SQLSTATE `42501`, records the
exact app-role privilege gate before data reads. Query-time `42501` is a separate
`permission_denied` gate (including RLS). Timeouts, unknown shapes, and row bounds
remain explicit. An absent candidate requires a successful catalog lookup; an
error is never converted to absence. No readable nonempty ledger produces the
`ledger_receipts_unavailable` gate. There is no fallback to an elevated identity.

Counts are all ledger rows, but selected data uses `ONLY` to avoid inherited child
relations. No arbitrary `SELECT *`, JSON conversion of full rows, SQL text,
repository, project, actor, timestamp or URL field is read. Unknown historical
migration names are hashed rather than printed. This observer does not verify
receipt authenticity or `mode='apply'`, scope private receipts by repository,
assert contiguity, or resolve conflicting receipts. Those are coordinator review
requirements; a hash match alone is insufficient authorization to apply SQL.

## SQL-file pins and provenance

These are expected file byte hashes only. A matching catalog/function definition
**cannot prove the installed SQL file checksum**. A receipt is separate evidence,
and missing/refused receipts leave historical installation unproven.

Production 0034 is read from the pinned production commit. Reserved 0035, 0036,
0037 and 0039 are the reviewed `app/drizzle` candidate files at
`b0bcca97c9d81c06432450bf421077476f601c42`. Production 0038 is read from Git
`b543803e5948621ce864debccbef6b0c8423f9f9:app/drizzle/0038_operator_access_overrides.sql`.
The production source pin contains 0034; the remaining entries are reservations,
not claims that those migrations exist in that deployed image or database.

| Production identifier | Expected SHA-256 |
| --- | --- |
| `0034_assignment_migration_clock` | `20d13abe691864be55aa7ee7732a3f5da723f3586c1741770c5d5c2a743accd1` |
| `0035_editor_agent_sessions` | `1ae73e8865f488b2736608a88dd0767aebd04dfe49c43db69751db78dc8cc80d` |
| `0036_editor_control_operations` | `0ab5ff43439b281ea6ff8eaa56efb7b166e0cdcb6e283029c2a216baf7c8da59` |
| `0037_editor_protocol_2` | `134e14daa769de62f5ac25298569fd7b5e0a26697cf7e98963c650cd28f08c16` |
| `0038_operator_access_overrides` | `04ae74d9fe1b34cd26a72bec5d85ee5213cfcfc7389c3560268acab06901d0d0` |
| `0039_named_computer_creation` | `5203f0603cda73801f16784ecbf745a32772bce700f00c8cf708caaad78299aa` |

Staging files were independently read and hashed from exact Git objects at
`308447f793384e100efc87ec35739304327a48dc`, not inferred by renumbering production.
The same content happens to hash identically under conflicting identifiers:

| Staging identifier | Expected SHA-256 |
| --- | --- |
| `0034_editor_agent_sessions` | `1ae73e8865f488b2736608a88dd0767aebd04dfe49c43db69751db78dc8cc80d` |
| `0035_editor_control_operations` | `0ab5ff43439b281ea6ff8eaa56efb7b166e0cdcb6e283029c2a216baf7c8da59` |
| `0036_editor_protocol_2` | `134e14daa769de62f5ac25298569fd7b5e0a26697cf7e98963c650cd28f08c16` |
| `0037_named_computer_creation` | `5203f0603cda73801f16784ecbf745a32772bce700f00c8cf708caaad78299aa` |
| `0038_operator_access_overrides` | `04ae74d9fe1b34cd26a72bec5d85ee5213cfcfc7389c3560268acab06901d0d0` |

## Local validation

```sh
node --check deploy/aws/os-staging/parity-schema-preflight.mjs
node --test e2e/parity-schema-preflight.test.mjs
```

Tests use local PGlite (with a fallback to the explicitly supplied
`/data/openclaw/projects/ezil/EZiL-Works/node_modules/@electric-sql/pglite/dist/index.js`),
synthetic schemas/rows/roles, and local Git objects. They inspect generated SQL,
pins, source refusal, safe import/stdin execution, rollback, presence/absence,
structural drift, ledger shape/privilege/RLS gates, sanitization and bounds.
Synthetic fixture writes occur only in disposable local in-memory databases.
No live transport, existing database, provider, network or application rows are
used for validation.

## Pinned host transport

The companion Python wrapper pins account `452630323510`, region `ap-south-1`, the existing `ezil-admin` profile, exact production/staging instance IDs, and Amazon `AWS-RunShellScript` document version 1 plus its SHA-256. It identifies exactly one running web container by the established Compose labels and checks its source before any timer or DB probe. All twelve timer/service fragments must be the expected `/etc/systemd/system/` paths. It reads SHA-256, active/enabled booleans and presence of drop-ins; it never starts a service. The database uses the existing app connection, with no credential extraction. Compressed sanitized stdout avoids SSM output truncation. Remote stderr is never copied.

Run only the committed, reviewed companion pair; preserve the resulting immutable receipt:

```sh
python3 deploy/aws/os-staging/parity-schema-preflight.py run production /absolute/new-production-receipt.json
python3 deploy/aws/os-staging/parity-schema-preflight.py run staging /absolute/new-staging-receipt.json
```

If transport is refused, the sole host/DB owner can emit and review the same self-contained host command with `emit production` (or independently `emit staging`), then execute it through the normal authorized host channel. The command writes no remote files. Do not substitute an unversioned deployment, change the source assertion, grant access, or treat refused/private ledger reads as zero. A DB owner may use this same MJS with an already-authorized read-only connection in the verified container, without exporting its value. The app-role refusal remains recorded.
