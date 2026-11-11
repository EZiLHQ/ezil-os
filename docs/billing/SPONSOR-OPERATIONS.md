# Sponsor invitations and counts

This is source preparation for the same Standard calendar-month trial, with a card required and the normal paid renewal afterward. The existing eligibility checks, Stripe checkout and subscription binding remain authoritative. Issuing a link, signing in, and viewing Billing grant no trial or credits.

No partner campaigns ship in source. The master sponsor switch remains off unless explicitly configured. These tools neither deploy config nor apply SQL nor call Stripe.

## What is implemented

- `app/scripts/sponsor-operator.ts issue` creates a reusable 256-bit token for one campaign/partner and a signed registry entry containing its SHA-256 hash. The campaign starts disabled.
- `sign` signs a reviewed registry edit offline. Config changes require a version advance; existing partner/token identity cannot change.
- The app resolves `/sponsor/<token>` against that signed registry. Its private document loads no root analytics and sends no-referrer/no-store headers. The token continues only in a same-origin form body, never an OAuth URL.
- Signed auth state binds origin, state and nonce. Only actual new OS account creation through Supabase Admin writes the UUID/verified-subject-bound recovery hint. Existing accounts, including accounts newly linked to Auth0, receive attribution without signup credit.
- After the verified OTP session, first campaign attribution wins. Signup recovery can fill its own timestamp once; it cannot claim a trial. The foundation's creation hint lasts 24 hours and still needs the matching active campaign/config.
- `stats` reports independent counts from the two durable service-only sponsor tables. It works without the sponsor master flag or current registry, so historical campaigns remain visible.

The auth source is additive to the normal sign-in flow. Sponsor subjects support 255 printable ASCII characters; unsupported subjects refuse sponsor handling while ordinary public Auth0 sign-in keeps its existing contract.

## Prepare a private invitation bundle

Run from `app/` with the already installed Bun runtime. Use `--no-env-file`; this tool does not need the app's normal database environment. Supply the existing signing key through an operator secret environment as `SPONSOR_REGISTRY_KEY` (at least 32 characters). The tool never creates or prints that key.

The variables below are operator-supplied values, not included campaigns:

```sh
bun --no-env-file scripts/sponsor-operator.ts issue \
  --campaign-id "$CAMPAIGN_ID" --partner-id "$PARTNER_ID" \
  --starts-at "$STARTS_AT" --expires-at "$EXPIRES_AT" \
  --origin https://os-staging.ezil.work --out-dir "$NEW_PRIVATE_BUNDLE"
```

IDs use lowercase letters, digits, underscores or hyphens, 3–64 characters. Dates are ISO timestamps with a timezone. The origin must be one of the app's owned origins. For each additional campaign, pass `--previous-dir "$PRIOR_SIGNED_BUNDLE"` so previous entries remain in the new registry. Keep the newest complete registry as the next command's input.

The output directory must not exist. It is created with mode 0700; every file has mode 0600:

| File | Purpose |
| --- | --- |
| `registry.json` | Exact signed document; token hashes only; new campaign has `enabled: false`, version 1. |
| `registry.sig` | Domain-separated HMAC signature for those exact document bytes. |
| `runtime-config.json` | Exact `SPONSOR_REGISTRY` and `SPONSOR_REGISTRY_SIG` values. Contains neither key nor the master feature toggle. |
| `invitation.private.json` | The new campaign's raw invitation URL. Keep private; it is not printed to stdout. |

Appending creates a new private bundle; it does not overwrite earlier files or copy earlier raw invitation URLs. Keep each original invitation file in private operator storage. Do not put bundles, keys or links in git, analytics, tickets, console logs or public artifacts. The command emits only a fixed result code, campaign/partner IDs and registry digest.

## Review config and prepare signing

A disabled link is unusable. A future reviewed enable/revoke/window change edits a copy of the latest complete registry, advances each changed campaign's version, and then signs that copy:

```sh
bun --no-env-file scripts/sponsor-operator.ts sign \
  --registry "$REVIEWED_REGISTRY_JSON" --previous-dir "$PRIOR_SIGNED_BUNDLE" \
  --out-dir "$NEW_SIGNED_BUNDLE"
```

This writes config files only. It does not enable the runtime, move a deployment or write provider objects. New campaigns must come through `issue`. Existing campaign IDs retain their partner and token hash; removing an entry stops new starts but does not erase durable counts. Sign an updated version to revoke it with `enabled: false`.

For an eventual approved deployment, copy the two JSON fields in `runtime-config.json` byte-for-byte into the deployment's protected environment. JSON escaping is part of the transport, not part of the registry string. Use the same `SPONSOR_REGISTRY_KEY` on the server. Configure the separate, stable `SPONSOR_KEY` for signed contexts and pseudonymous account keys. Neither key is emitted by the tool. Changing `SPONSOR_KEY` changes account pseudonyms and requires a deliberate data migration plan.

Readiness also requires configured Auth0, global checkout availability, the separately reviewed sponsor schema, and the explicit `SPONSOR_TRIALS_ENABLED=1` runtime choice. A valid sponsor does not require the public trial flag. Missing/invalid registry, absent schema or master-off mode fail closed for sponsor entry and preserve ordinary public auth/billing. Checkout always rechecks eligibility, person history, campaign state and frozen quote terms.

## Read aggregate tracking

This command is an operator report, not a public API or browser page. Export only the explicitly chosen connection as `SPONSOR_REPORT_DATABASE_URL`; it deliberately ignores `SUPABASE_DATABASE_URL`. Supply the known PostgreSQL cluster system identifier, database and service database user:

```sh
bun --no-env-file scripts/sponsor-operator.ts stats \
  --target-id "$CLUSTER_SYSTEM_IDENTIFIER" --database "$DATABASE" --user "$SERVICE_DB_USER"
```

It uses one READ ONLY transaction, bounded connect/statement timeouts, a pinned search path, exact cluster/database/current-user/session-user checks, and a schema readiness probe. It refuses a role that cannot see every sponsor row through RLS rather than returning misleading partial totals. The database owner without forced RLS, a superuser or an explicitly configured BYPASSRLS service reporting role can meet that check; the command changes no role, grants or policy.

The result has `campaigns` and exact `partners` totals. Counts are decimal strings so bigint totals cannot lose precision:

| Field | Meaning | Event timestamp |
| --- | --- | --- |
| `attributedAccounts` | Distinct accounts whose first sponsor attribution was accepted. Includes existing eligible users. | `accepted_at` |
| `newSignups` | Distinct genuinely new OS accounts with a verified server creation hint materialized once. | `signed_up_at` |
| `quotedTrials` | Distinct persisted sponsor trial linkages, including unclaimed quotes. | `quoted_at` |
| `claimedTrials` | Distinct trial IDs actually bound to a Stripe subscription, with both claim time and subscription ID present. | `claimed_at` |

Signup is not claim. Existing accounts may claim without being new signups; abandoned quotes are not claims. The two tables are aggregated separately before joining, preventing quote/attribution fanout. Cancellation and account deletion retain attribution and consumed claim counts. Unstarted linkages can be reclaimed/deleted and re-quotes move `quoted_at`, so `quotedTrials` is the count of persisted linkages, not a permanent count of every historical checkout attempt.

Optional `--from "$FROM_ISO" --to "$TO_ISO"` gives a half-open interval [from, to). Each metric uses its own timestamp. These are event counts for that period, not a signup cohort conversion rate. Both boundaries are required together. Without them the report is lifetime totals at the report query's database snapshot.

With `--registry-dir "$SIGNED_BUNDLE"` and `SPONSOR_REGISTRY_KEY`, unused configured campaigns appear as zero-count rows too. Historical database campaigns absent from the registry remain included. No registry is needed for historical reporting. Only partner/campaign IDs and aggregates are emitted, never account keys, user IDs, email addresses, Stripe IDs, token URLs, keys or connection URLs.

## Schema rollout boundary

The actual new tables are `public.ezil_sponsor_attributions` and `public.ezil_sponsor_trial_claims`. Their SQL remains outside the ordered Drizzle journal. This operator tool never applies it.

The native runner lane owns the exact-file schema runner and its pinned SQL, preflight, structural verification and documentation under `app/migrations/sponsor/`. Its source admits PostgreSQL 17 only. The staging major must be established before any rollout decision. The two-table DDL is still held for the user's concrete schema approval; pending journal 0022–0025 must not be applied as part of sponsor work. No real schema, campaign, identity, Stripe object or deployment was changed while preparing this source.

## Source checks

```sh
NODE_OPTIONS=--max-old-space-size=1024 node_modules/.bin/vitest run \
  src/server/billing/v3/sponsor-operator.test.ts --maxWorkers=1 --no-file-parallelism
bun --no-env-file scripts/sponsor-operator.ts help
```

Operator tests use synthetic fixture IDs, local temporary private bundles, actual signing/token/hash helpers and an injected reporting connection. They cover permissions, append preservation, collisions, config versioning, safe output, target pins, read-only mode, schema/RLS refusal and independent count/query semantics. These checks do not exercise a live database or Stripe.

The gated `sponsor-operator.pg.test.ts` additionally creates a fresh owned `sponsor_operator_*` database only on an explicitly supplied disposable fixture at loopback port 55443. It executes the actual report SQL against synthetic 0021/sponsor tables: independent lifetime and event-window counts, exact partner totals, historical/canceled claims, target refusal and no report mutations. The integrated source passed all four cases. The test drops only its own database; fixture setup never targets the app database or the held real schema rollout.
