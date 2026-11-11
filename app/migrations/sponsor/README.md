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
- A present schema is a no-op only if its fingerprint equals the pin for the server's MAJOR version (only 17 is pinned; an unlisted major refuses until a
  review adds it). Any drift (RLS, ACL, index, column, constraint, trigger, policy, function) refuses and is never applied over.
- Apply: exact file hashes on the command line, `--apply --yes`, one advisory lock, a re-inspection under it, the pinned SQL (one transaction), and the
  post-inspection STILL under the same lock. After an error or a dropped connection the only truth is a fresh catalog inspection, which is reported.
- Never reads `drizzle/` or any journal, never advances one, never runs on startup. The URL comes from a named environment variable and is never printed;
  the receipt holds digests, booleans and counts only.

## Tested
Only on disposable bounded Postgres 17 databases (`sponsor_*` on 127.0.0.1:55441) with a synthetic fixture that takes the real 0021 trial DDL:
`src/server/billing/v3/sponsor-{schema,store,legacy,runner}.pg.test.ts`, run with `BILLING_TEST_DATABASE_URL`. No real database was touched. The staging
Postgres major version is not known to this branch: if it is not 17, a fingerprint for it must be derived on a disposable database of that major and reviewed.
