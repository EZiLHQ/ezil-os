# Sponsor attribution schema (FUTURE, not applied, not in the ordered journal)

`0001_sponsor_attribution.sql` adds two service-only tables, `public.ezil_sponsor_attributions` and `public.ezil_sponsor_trial_claims`, with immutability
triggers and no privilege for anon, authenticated or public. It needs only the 0021 trial schema. Every owned object is created as `"public"."name"` after
`SET LOCAL search_path = pg_catalog`, so a writable schema earlier in the session or role `search_path` can never receive an object. It is deliberately NOT
under `drizzle/`, NOT in `drizzle/meta/_journal.json`, and no startup, migrate-up or directory include may run it: the pending 0022-0025 objects must not be
applied or piggybacked.

## Files (pinned by sha256 in `run-sponsor-schema.mjs`)
- `preflight.sql`: read-only prerequisites and the absent / present state.
- `verify.sql`: read-only structural fingerprint of the exact owned objects (columns, constraints, indexes, triggers, RLS flags, policies, ACL for
  anon / authenticated / public, the two guard functions). Run under `set local search_path = pg_catalog`.
- `run-sponsor-schema.mjs`: the runner PROPOSAL. Not executed against any real database; it needs its own independent review first.

## Runner contract
- Target pinned by cluster system identifier AND exact `current_database()` AND exact `current_user` / `session_user`; no defaults.
- Preflight rows must be exactly the nine known, unique names with one state row and every `ok` literally true; empty, missing, duplicate or unknown rows refuse.
- PG 17 ONLY: every inspection (the first, and the one under the lock) refuses any other server major before a catalog row is read, so no DDL can follow on
  an unlisted major. A present schema is a no-op only if its fingerprint equals the pinned one. Any drift (RLS, ACL, index, column, constraint, trigger,
  policy, function) refuses and is never applied over.
- Apply: exact file hashes on the command line, `--apply --yes`, one advisory lock, a re-inspection under it, the pinned SQL (one transaction), and the
  post-inspection from the SAME locked session. An advisory lock dies with its session and a pooled client silently reconnects, so the runner records its
  backend pid with the lock and proves, before and after the DDL, that this very backend still holds it. If it does not (connection lost), the result is
  `apply_outcome_uncertain_session_lost` with exit 2: no success is claimed and no catalog readback from a replacement connection is used. The operator's fresh
  preflight on the pinned target is the recovery.
- Never reads `drizzle/` or any journal, never advances one, never runs on startup. The URL comes from a named environment variable and is never printed;
  the receipt holds digests, booleans and counts only.

## Tested
Only on disposable bounded Postgres 17 databases (`sponsor_*` on 127.0.0.1:55441) with a synthetic fixture that takes the real 0021 trial DDL:
`src/server/billing/v3/sponsor-{schema,store,legacy,runner}.pg.test.ts`, run with `BILLING_TEST_DATABASE_URL`. No real database was touched. The staging
Postgres major version is not known to this branch: if it is not 17, a fingerprint for it must be derived on a disposable database of that major and reviewed.
