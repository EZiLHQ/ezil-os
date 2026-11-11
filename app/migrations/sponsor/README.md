# Sponsor attribution schema (FUTURE, not applied, not in the ordered journal)

`0001_sponsor_attribution.sql` adds two service-only tables, `ezil_sponsor_attributions` and `ezil_sponsor_trial_claims`, with immutability triggers
and no privilege for anon or authenticated. It needs only the 0021 trial schema. It is deliberately NOT under `drizzle/`, NOT in
`drizzle/meta/_journal.json`, and no startup, migrate-up or directory include may run it: the pending 0022-0025 objects must not be applied or
piggybacked.

`preflight.sql` is read-only: it checks the 0021 prerequisites and reports `absent` / `present` and any partial set.

A runner (not written yet, needs its own review) must: pin the target database system identifier; run `preflight.sql` read-only; refuse partial or
conflicting schema; apply ONLY `0001_sponsor_attribution.sql` (exact file sha256 allowlist, one transaction); verify an identical existing schema is a
no-op; write a receipt. No startup DDL and no global journal advancement.

Tested only on a disposable bounded Postgres 17 with a synthetic fixture (real 0021 `ezil_billing_trials` DDL): `sponsor-schema.pg.test.ts`, run with
`BILLING_TEST_DATABASE_URL`. No real database was touched.
