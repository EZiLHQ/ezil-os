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
3. `EZIL_AWS_CANARY_USER_IDS` + `EZIL_AWS_CANARY_SINCE` choose which computers reach AWS.
   Without them no computer ever does: a computer with no placement row resolves to
   Cloudflare, and only AWS admission writes an `aws-ec2` row. Set both together with
   `EZIL_AWS_COMPUTERS_ENABLED`, after the tables exist. SINCE should be the moment you
   set them, so only computers the listed users create from then on go to AWS (older
   ones may hold an R2 workspace). Deleting an AWS computer starts its retire and
   completes in one delete; the sandbox-reap cron finishes the retirement in the
   background (docs/AWS-COMPUTERS.md, Retirement).
   **Pinning.** With placement reads on, the first sandbox start of a computer with no
   placement row (open, app/code preview, desktop restart) records a `cloudflare` row before
   the sandbox starts, so a computer that has run on Cloudflare (its workspace is in R2) can
   never later be reassigned to AWS by the canary. Reads and stops never pin. With reads OFF
   nothing is pinned, so set `EZIL_AWS_CANARY_SINCE` to the moment the canary is enabled
   (with reads on): computers created before it stay on Cloudflare.
   **Everyone (`*`).** `EZIL_AWS_CANARY_USER_IDS=*` (exactly `*`, nothing beside it; `*`
   mixed with ids is malformed and means no cohort) puts every signed-in user in the cohort.
   **Fallback.** A new computer goes to AWS only when admission would admit it right now
   (a read-only, unlocked pre-check with admission's own rules: config complete, kill switch
   off, a region below its running cap, the user has no other AWS computer, monthly caps not
   reached). Otherwise it stays on Cloudflare and is pinned there on its first sandbox start,
   so no user is handed a computer that cannot start. Admission still re-decides under its
   lock; a computer that loses that race refuses once (no row written) and falls back on the
   next open.

## Usage ledger (`ezil_compute_usage`)

Rows are written only by `placement.ts`, in the same transaction as the placement
transition that applied a lifecycle receipt: a confirmed `running` receipt opens one
row per instance run, a confirmed `stopped`/`retired` receipt closes it. Hours caps
therefore bind. `egress_bytes` is always NULL (egress is not measured yet), so the
egress caps do not bind.

## Ownership (`owner_user_id`)

`ezil_computer_placements.owner_user_id` is set once, at creation, from the
authenticated session user, and no later write changes it. Admission, the lease CAS
and every provider operation compare the caller with it; per-user caps count placements
by it (and usage metered to the user). `ezil_computers` is only a precondition (the
computer exists, is live and is the caller's), never the owner.

That matters because `ezil_computers` is user-writable through the Supabase API
(`app/drizzle/0000_massive_mole_man.sql`): the update policy pins `user_id` but no
column is protected, so a user can change `id` (re-key) and `deleted_at`, and the
insert policy accepts a caller-chosen `id`, including a soft-deleted row that takes no
slot. **Founder finding, not fixed here:** consider revoking `UPDATE (id)` and
caller-chosen ids on insert from `authenticated`; R2 prefixes and other tables keyed by
the computer id have the same exposure.

`ezil_computer_placements.reconciled_at` (nullable) is reconciler bookkeeping: the fleet pass stamps the
rows it claims so successive bounded passes rotate through every placement. No CAS reads it.
