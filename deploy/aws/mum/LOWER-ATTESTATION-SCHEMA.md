# Lower-attestation schema installer (SQL 0004)

`lower_attestation_schema.py` (wrapper: `lower-attestation-schema.sh`) installs
`docs/aws-computers/sql/0004_lower_attestations.sql.txt` as its own plan/apply/check/
reconcile flow. It is separate from the frozen staging-only 0002 installer
(`rebase_schema.py`), which it does not touch or relax. **Source only; Native62 alone
executes it, after independent DB review.**

Pinned SQL: commit `a5c6b7e6ca68`, SHA-256
`ab5fcfa6341fe89595b36591cded8ede1dea506ed84801cfafdc8701e179e313`. The golden catalog
`lower_attestation_catalog.json` is bound to that hash (31 columns, primary key plus
five CHECKs, 3 indexes, 2 triggers, guard function with its `sha256(prosrc)`).

## Fixed targets (no CLI overrides)

| | staging | production |
|---|---|---|
| AWS account / region | 452630323510 / ap-south-1 | same |
| database / role | `postgres` / `postgres` | same |
| `system_identifier` (string, beyond JS safe integer) | `7698279149046886433` | `7698288507300208674` |
| transport | normal SSM + S3 + env-file URL program (the 0002 installer's path) | approved selector: SSM host `i-09012068d96166828`, inline script, IMDSv2 instance-id and local IP `10.63.20.252` checks, `docker exec` into `supabase-db` over the local socket; no URL, password, tunnel or S3 |

The role must be `postgres`, `NOSUPERUSER`, `BYPASSRLS`, owner of the table and function.
**The backend owner role is not protected by RLS.** In production `postgres` is also a
member of `anon`, `authenticated` and `service_role` (never the reverse). Protection
therefore comes from the immutability trigger/function, operator authorization and the
exact catalog contract, not from RLS.

## What the catalog contract proves (before and after DDL)

Exact columns (order, type, nullability, defaults, column ACLs), constraints
(`pg_get_constraintdef`, validated), indexes (`pg_get_indexdef` plus `indisvalid`,
`indisready`, `indislive`, uniqueness, owner), non-internal triggers (definition and
enabled state), policies and rules (none), table owner, RLS enabled and not forced,
direct ACLs (owner only), **effective** client denial (`has_table_privilege` and
`has_function_privilege` for `anon`, `authenticated`, `service_role`, so role membership
and inherited privileges count) and the guard function (owner, language, search path,
not SECURITY DEFINER, `sha256(prosrc)`, owner-only EXECUTE). Relevant default-ACL rows
(global and `public`, tables and functions) are recorded as an input and proven unchanged
by the transaction; they are never modified, and unrelated rows are preserved.
`source_instance_id` stays historical NOT NULL; `current_instance_id` stays nullable.

## Operations

```
lower-attestation-schema.sh plan      --target T --release-dir D
lower-attestation-schema.sh apply     --target T --release-dir D --plan D/lower-attestation-schema-T-plan.json --plan-sha256 S --sql-sha256 H [--apply]
lower-attestation-schema.sh check     --target T --release-dir D
lower-attestation-schema.sh reconcile --target T --release-dir D
```

- **plan** is read-only (`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, plus
  `default_transaction_read_only=on` on production). It classifies the live catalog as
  `empty` or `exact`; anything else (partial or altered object) refuses. The plan pins the
  SQL hash, catalog hash, target facts, transport and the installer source and transport
  fingerprints, so changing the installer, scripts or selector invalidates it.
- **apply** without `--apply` is a dry run (account and host identity only). With it, apply
  needs the pinned SQL hash, the same hash as `--sql-sha256`, the exact `--plan-sha256`, the
  release-directory plan and the pinned target. It creates an exclusive intent file, then
  one transaction: identity and role guard, advisory lock, table lock, pre-state gate
  (`empty` runs the reviewed bytes; `exact` is a no-op; a pre-state different from the
  plan is a stale plan and refuses), post-DDL exact verification, one receipt row on stdout.
- **check** proves the exact catalog contract read-only.
- A rerun after a bound receipt is a **replay**: receipt, intent, plan and nonce must bind,
  then live state is re-proved read-only. An intent without a receipt (lost send, SSM
  failure, timeout, uncertain DB commit) refuses a blind retry; run **reconcile**.
- **reconcile** is read-only. It validates the whole intent (target, SQL hash, plan hash,
  nonce, state), the original plan bytes and pins, and that the SSM journal's hash, comment,
  host and command id bind to the exact command this installer would have built, and that
  command is terminal. Then `exact` writes a validated `reconciled` receipt (the fresh
  read-only evidence) and completes the intent so a normal `apply` replays; `empty` closes
  the intent and journal so a fresh apply is allowed; anything else refuses.

## Durability and evidence

Intent, journal, plan and receipt files are 0600 regardless of umask and durable
(file `fsync`, then parent-directory `fsync`) for exclusive create and atomic replace; the
`submitting` journal state is durable before any provider send, and a persistence failure
stops before the send. The raw provider invocation (status, stdout, stderr) is retained
privately (`*-apply-invocation.json`) before the journal state changes or stdout is parsed;
malformed or truncated output is retained, never printed, and leaves the outcome unknown.
A missing or lost apply journal is also unknown: reconcile refuses and no new send is made.
Production psql is bound to `/var/run/postgresql` port 5432 with
`PGSERVICE`/`PGHOSTADDR`/`PGOPTIONS` unset inside the exec (an empty value is not unset to
libpq), `PGSERVICEFILE`/`PGSYSCONFDIR`/`PGPASSFILE` neutralised, and the socket required.

## Tests (no cloud, no live database)

```
python3 -B deploy/aws/mum/tests/lower_attestation_schema.py      # fake AWS/SSM + modelled DB, both transports
python3 -B deploy/aws/mum/tests/lower_attestation_schema_pg.py   # one disposable postgres:17 container, 1 CPU / 512 MB
```

The PG proof mirrors production's role shape (non-superuser `postgres`, BYPASSRLS, member
of the client roles, Supabase-style default privileges and an unrelated global default-ACL
row). It covers the real read-only EMPTY plan, apply, exact check, stale/unknown/refusal
cases, sealed immutability, a genuinely read-only transaction, strict single-receipt stdout
and the production host script itself through `curl`/`ip`/`docker` shims.
`--write-catalog PATH` regenerates the golden file from the SQL bytes.

PostgreSQL 17's `MAINTAIN` privilege appears in the owner ACL; the golden file was measured
on PostgreSQL 17, matching production 17.11. A staging server on another major version can
format catalog evidence differently and would then refuse instead of being blessed.
