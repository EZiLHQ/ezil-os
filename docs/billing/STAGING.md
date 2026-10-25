# Billing staging

Billing staging is a separate Vercel project on the owned host
`billing-staging.ezil.work`, with isolated Supabase DB `ezil-os-awstest`
(`yjnwyugyhfpalqpqrnnt`) and the shared `ezil-os-worker-staging` Worker.

**Never btgq / curomaa:** never target `btgqfmnzycdecmeyqubx` (LIVE production,
even when called “preview”) or `curomaahbwlrddzijatd` (Website data).
Never run `.github/scripts/production-migrations.mjs` outside production.

Use Node and `psql` from the repository root. The founder supplies
`BILLING_STAGING_DATABASE_URL` securely in the environment, never in commands.
Direct host and pooler username pins are supported. URL query options are
limited to `sslmode` and `connect_timeout` to prevent connection overrides.

```sh
node app/scripts/billing-staging-schema.mjs plan
node app/scripts/billing-staging-schema.mjs baseline app/drizzle/0000_massive_mole_man.sql --yes
node app/scripts/billing-staging-schema.mjs apply --yes
```

Without the URL, plan prints filenames and SHA-256 hashes offline. With it,
plan creates the log table if absent and displays pending/applied status.
Review the full plan first. Baseline only files already applied and verified
by hand; it records their hashes without executing their SQL. Multiple paths
or unique basenames may follow `baseline`. Apply skips logged files, running
each pending file and its log insert together in one transaction. Any hash
mismatch stops the run; never edit previously logged files to bypass it.
Order: Drizzle 0000–0005, placement SQL, ready-pool SQL, then optional v3 SQL.
Run one operator at a time. After an interrupted run, inspect plan before retrying.

Staging project environment names (feature flags are off unless exactly `1`):

- `BILLING_TAB_ENABLED`, `PRICING_PAGE_ENABLED`, `CHECKOUT_ENABLED`
- `BILLING_ENFORCEMENT`, `BILLING_LARGE_STORAGE`, `BILLING_AUTOMATIC_TAX`
- `BILLING_ADAPTIVE_PRICING`, `BILLING_MANAGED_PAYMENTS`
- `STRIPE_SECRET`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_KEY` (legacy publishable-key fallback), `STRIPE_PRICE_PRO_MONTHLY` (optional)
- `BILLING_USAGE_HMAC_SECRET`, `BILLING_FUNDING_URL`, `BILLING_FUNDING_HMAC_SECRET`
- `CRON_SECRET`, `CLOUDFLARE_GUACAMOLE_WORKER_URL`, `CLOUDFLARE_GUACAMOLE_HMAC_SECRET`
- `DATABASE_URL`, `SUPABASE_DATABASE_URL`
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

`app/src/env.ts` requires `SUPABASE_DATABASE_URL` for the server; setting only
`DATABASE_URL` is insufficient. Both DB URLs and the public Supabase URL must
identify the isolated staging project. The schema script reads only its own
`BILLING_STAGING_DATABASE_URL`; it does not load env files or use app DB fallbacks.
Billing names come from `app/src/server/billing/config.ts`; funding, optional
price, and feature-gated values depend on which staging features are enabled.
All values are founder-set and never committed.
