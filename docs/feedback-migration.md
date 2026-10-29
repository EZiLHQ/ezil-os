# Feedback tables — os-staging apply (round 3)

The three tables (`ezil_feedback_reports`, `ezil_feedback_attachments`,
`ezil_feedback_access_log`) ship as **`app/drizzle/0011_feedback.sql`**. That file is
byte-for-byte `FEEDBACK_MIGRATION_SQL` in `app/src/server/feedback/migration-sql.ts`
(`migration-sql.test.ts` enforces it, runs both table blocks through the production
grammar `additiveSQL`, and checks every column against
`app/src/server/db/schema/feedback.ts`). No primary keys, defaults, constraints or
policies; RLS on and every client role revoked, so only the app's server role reads.

How it is wired:
- `app/scripts/billing-staging-schema.mjs` lists it in `EXPLICIT_FILES` right after
  `0010_migration_restore_progress.sql` — the staging tool reads **only** that list
  (top-level `app/drizzle/` files), never `app/drizzle/hardening/`.
- `.github/production-migrations.json` registers it in `sources` as `kind: "snapshot"`
  (so `production-migrations.mjs validate` accepts the `.sql` file), **not** in
  `migrations`: nothing applies it to production through the release gate.
- On `--target aws-production` the tool applies it with the full ordered list (it is inert
  until `EZIL_OS_FEEDBACK` is set) and refuses to baseline it, like 0003 pool v2 / 0008 /
  0009 / 0010.

## Apply on os-staging (release owner)

Preconditions: the DB tunnel and the recorded preview system ID from
`deploy/aws/os-staging/INFRASTRUCTURE.md` step 6 (`BILLING_STAGING_DATABASE_URL`
through approved secret handling; never paste it into a command line).

```bash
# 1. Read-only: 0011 must be the only `pending` row; every other file `applied (...)`.
node app/scripts/billing-staging-schema.mjs plan --target aws-preview --expect-system-id <digits>
# 2. Apply. Each file runs with its log row in ONE psql transaction (--single-transaction).
node app/scripts/billing-staging-schema.mjs apply --yes --target aws-preview --expect-system-id <digits>
# 3. Read-only again: 0011 now shows `applied (apply)` with the same sha256 as the manifest.
node app/scripts/billing-staging-schema.mjs plan --target aws-preview --expect-system-id <digits>
```

If `plan` shows any pending file other than 0011, stop: `apply` would run it too.
The tables are inert while `EZIL_OS_FEEDBACK` is unset: the route answers 404 and the
boot payload carries no `feedback` endpoint. Turn the feature on only after step 3
(`EZIL_OS_FEEDBACK=1`, `FEEDBACK_ADMIN_EMAILS=<allow-list>` through
`deploy/aws/os-staging/render-env.py`; screenshots stay off).

Rollback: unset `EZIL_OS_FEEDBACK` (feedback becomes inert). Dropping the tables is
a separate, reviewed operator action; the staging log row would then have to be
removed in the same transaction.

## Production

Not in scope. Production would need a grammar `migrations` entry with rehearsed
`before`/`after` catalog digests (`production-migrations.mjs`), and
`EZIL_OS_FEEDBACK` must stay unset in production until then: the route needs the tables.
