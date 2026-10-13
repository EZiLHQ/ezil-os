# AWS computers: unregistered placement SQL

`0001_compute_placement.sql.txt` holds the C-2 tables from `docs/AWS-COMPUTERS.md`
(`ezil_computer_placements`, `ezil_compute_usage`). It is **not applied anywhere**
and nothing reads these tables while `EZIL_AWS_COMPUTERS_ENABLED` is unset.

## Why `.sql.txt` and why here

`node .github/scripts/production-migrations.mjs validate` inventories every tracked
or unignored `*.sql` file in the whole repository (`git ls-files -- '*.sql'`), not
only `app/drizzle/`. An unregistered `.sql` file anywhere, `docs/` included, fails
CI with "SQL inventory differs from manifest". A registered migration needs
`before`/`after` catalog digests observed against the production database, which
only the founder can do. The suffix keeps the file out of the inventory until then.

`app/src/server/lib/compute/placement-sql.test.ts` parses this file with the
engine's own `additiveSQL`, so it cannot drift outside the hosted grammar.

## Registration (founder)

1. Rehearse on a disposable database with matching PostgreSQL major version, roles,
   extensions and schema metadata (see `docs/production-migrations.md`). Do not
   replay Works fragments to build it.
2. Copy the file byte-for-byte to `app/drizzle/hardening/0003_compute_placement.sql`
   (the `.sql.txt` copy here may then be deleted).
3. In `.github/production-migrations.json`, add a `sources` entry
   `{ "path": "app/drizzle/hardening/0003_compute_placement.sql", "sha256": "<sha256 of the file>", "kind": "migration" }`.
4. Append one `migrations` entry
   `{ "id": "0003-compute-placement", "path": "…same path…", "sha256": "…", "before": "<observed>", "after": "<observed>" }`.
   `before` is the current live digest (`plan`), `after` is the digest observed after
   the rehearsal. The `ensure_rls` event trigger already enables RLS on new `public`
   tables, so the explicit `ENABLE ROW LEVEL SECURITY` is idempotent; the observed
   `after` digest accounts for it either way.
5. `node .github/scripts/production-migrations.mjs validate`, then release through the
   normal main-push apply path.

Only after the tables exist in production may `EZIL_AWS_COMPUTERS_ENABLED=1` be set:
with the flag on, provider selection reads `ezil_computer_placements` and a missing
table fails every lifecycle call.
