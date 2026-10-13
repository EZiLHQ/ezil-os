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

## Flags, in order

1. `EZIL_COMPUTE_PLACEMENT_READS=1` turns on placement reads in provider selection.
   Set it only after the tables exist: with reads on, a missing table fails every
   lifecycle call (it is never treated as "no row").
   **One-way: once on, never turn it off.** With reads off every computer resolves to
   Cloudflare, so a computer with an `aws-ec2` placement would silently open an empty
   Cloudflare workspace instead of refusing.
2. `EZIL_AWS_COMPUTERS_ENABLED=1` gates AWS admission and the aws-ec2 provider. It
   implies placement reads. With reads on and AWS off, an `aws-ec2` computer refuses
   with `aws_disabled`.

## Ownership caveat (`ezil_computers` RLS)

Admission's ownership and per-user checks read `ezil_computers`, which signed-in users
can write through the Supabase API (`app/drizzle/0000_massive_mole_man.sql`):

- the "Users can update own computers" policy pins `user_id = auth.uid()` in both
  USING and WITH CHECK, so a user cannot move a computer to another user id;
- but no column is protected, so a user can change `id` (re-key) or `deleted_at`, and
  "Users can insert own computers" lets them insert a row with a chosen `id`, including
  a soft-deleted one that takes no slot.

Admission therefore also counts placements metered to the user in the usage ledger,
refuses a computer whose usage was metered to another user, and refuses a soft-deleted
computer. Residual gap: a placement that has never run (no usage rows) can be hidden by
re-keying its row, or claimed by inserting a row with its id after the owner's account
is deleted. Follow-up (P3, before Stage A): record the owning user on the placement
(C-2 change) and/or revoke column `UPDATE (id)` and supplied ids on insert from
`authenticated`.
