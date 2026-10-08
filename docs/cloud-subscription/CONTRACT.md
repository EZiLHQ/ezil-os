# Cloud subscription — frozen contract v1 (2026-10-08)

Request `os-cloud-subscription-fast-20261008-2003-v1`. Notion task 3f37021e-76d7-81a5-adec-e3079da780a5.
This file is identical in `EZiLHQ/ezil-os` (branch `feat/os-cloud-subscription`) and
`EZiLHQ/ezil-ai-gateway` (branch `feat/usd-subscription-wallet`). A change to one is a change to both.
Everything here ships **disabled by default**. Nothing is applied to hosted databases or paid infrastructure.

## C1. Compute shapes (OS server is the source of truth)

| id | runtime | vCPU | memory | disk | eligibility |
|---|---|---|---|---|---|
| `standard` | Cloudflare Containers custom (current prod) | 2 | 6 GiB | 16 GB | every signed-in user |
| `performance` | Cloudflare Containers `standard-4` | 4 | 12 GiB | 20 GB | active subscription only |

- vCPU is a Cloudflare virtual CPU allocation, not a physical core. Say so in the UI.
- 4 vCPU / 8 GiB is **not offered**: Cloudflare custom types need at least 3 GiB per vCPU (limits page, last updated 2026-09-30). `performance` is the nearest valid shape.
- A shape is one container class. `performance` is a second Durable Object/container binding (`SandboxPerformance`). Its `max_instances` is a hard config value, at most 4 in this PR.
- Changing shape means restarting into the other class. Files persist through the existing R2 workspace checkpoint. Running processes, open terminals and unsaved editor buffers do not. The UI must say this before it confirms.
- Eligibility is checked **server-side** on every start and claim. A client-sent shape is only a request.

## C2. Ready pool and leases (OS DB, drizzle, table `ezil_pool_slots`)

Columns: `id uuid pk`, `shape text not null`, `sandbox_id text unique not null`,
`state text not null check (state in ('warming','ready','leased','draining','destroyed'))`,
`created_at`, `ready_at`, `leased_at timestamptz null`, `lease_id uuid unique null`,
`leased_to_user_id uuid null`, `leased_computer_id uuid null`, `last_error text null`.

Invariants:
1. **Single use.** A slot goes `warming → ready → leased → draining → destroyed`. It never returns to `ready`. It never serves a second tenant. Release always destroys it.
2. **Atomic claim.** One statement: `update … set state='leased', lease_id=$new, … where id = (select id from ezil_pool_slots where state='ready' and shape=$shape order by ready_at for update skip locked limit 1) returning *`. Zero rows means a cold start (overflow), not an error.
3. **One live lease per user.** A unique partial index on `leased_to_user_id` where `state='leased'`. One computer gets at most one lease: a unique partial index on `leased_computer_id` where `state='leased'`.
4. **Subscriber priority.** If the ready count for a shape is at or below `POOL_SUBSCRIBER_RESERVE` (default 1), only subscribers may claim. Free users fall through to a cold start.
5. **Bounded refill.** Refill creates a slot only while `count(warming+ready of shape) < POOL_TARGET_<SHAPE>` **and** `count(non-destroyed) < POOL_MAX_TOTAL`. The decision takes a transaction-scoped advisory lock (`pg_advisory_xact_lock(hashtext('ezil_pool_refill'))`) so parallel refills cannot overshoot. Hard ceiling constant `POOL_HARD_MAX = 8` regardless of env.
   - Defaults: `POOL_TARGET_STANDARD=0`, `POOL_TARGET_PERFORMANCE=0`, `POOL_MAX_TOTAL=0`, so the pool is off.
6. **Ready means ready.** A slot becomes `ready` only after all three probes pass: the desktop/browser stream (existing readiness), code-server HTTP 200 and the relay.
7. **Idle stop.** `ready` slots older than `POOL_READY_TTL_SECONDS` (default 1800) are destroyed. Leased computers keep the existing idle-stop path.
8. **Workspace attach.** After a claim, the user's workspace is hydrated from their own R2 checkpoint prefix into the pristine slot before the URL is returned. A slot is never hydrated twice.

## C3. Money (AI Gateway)

- **Unit:** `usd_micro` (bigint, 1 = USD 0.000001). This is wallet **v2**, behind `WALLET_V2_ENABLED` (default `false`).
  - The legacy microcredit wallet (1 credit = INR 0.10, FX × markup) is untouched.
  - No account moves from v1 to v2 without a versioned, founder-approved conversion policy. This PR ships no conversion.
- **Buckets:** `included` (subscription, per period) and `purchased` (top-up).
  - Spend order comes from `SPEND_ORDER`, default `included_first`, which is provisional.
  - Neither bucket can go negative.
- **Subscription grant:** exactly `SUBSCRIPTION_INCLUDED_USD_MICRO` (default `20000000`) once per `subscription_period_paid` event. AI credit is never reduced to fund compute.
- **Included-credit expiry** is `INCLUDED_EXPIRY_POLICY ∈ {period_end, rollover}`. There is **no default**: v2 refuses to enable while it is unset (the commercial decision is open).
- **Funding hook:** `POST /v1/integrations/funding`. It uses the same HMAC scheme as `/v1/integrations/entitlements` (`X-EZiL-Timestamp`, `X-EZiL-Signature: v1=<hex HMAC-SHA256(secret, "<ts>.<raw body>")>`), with its own secret `FUNDING_HMAC_SECRET`.
  - Body, exactly these fields: `{eventId uuid, provider "cashfree", providerPaymentId string, accountPublicId uuid, kind, amountUsdMicro string(int), periodStart iso|null, periodEnd iso|null, occurredAt iso}`.
  - `kind ∈ subscription_period_paid | topup_paid | refund | subscription_cancelled | renewal_failed`.
  - Idempotency: unique `(provider, providerPaymentId, kind)` **and** unique `eventId`.
    - A replay with identical fields returns `200 {applied:false, duplicate:true}`.
    - The same key with different fields returns `409 event_conflict`.
  - Out of order: an event whose `occurredAt` is older than the latest applied event for that subscription is recorded but does not change state.
  - `refund` removes at most the remaining balance of the grant it names. Any shortfall is recorded, never made negative.
  - A return URL or client call **never** grants.
- **SQL entry points:**
  - `ezil_ai.apply_funding_event(p jsonb) returns jsonb`
  - `ezil_ai.wallet_v2(p_account_public_id uuid) returns jsonb`
  - The existing `reserve`/`settle` keep request-id idempotency. A retried request id never charges twice. A cancelled or failed request releases its hold.
- **Reads:**
  - `GET /v1/wallet` returns `{version:2, unit:"usd_micro", plan:"free"|"subscriber", included:{balance, periodEnd}, purchased:{balance}}`. Balances are integer strings. When v2 is off it returns `version:1` with the legacy fields.
  - `GET /v1/me/plan` returns `{plan, periodEnd, shapes:["standard"(,"performance")]}`. The OS server calls this through `EntitlementSource.getPlan(userId)`.

## C4. Error envelope (gateway → OS chat)

The existing envelope is kept. The new fields are additive.

| HTTP | `error.code` | client action |
|---|---|---|
| 402 | `insufficient_credits` | top-up popup (`actions:["topup"]`, plus `"subscribe"` when plan=free) |
| 402 | `no_entitlement` | subscribe/upgrade popup (`actions:["subscribe"]`) |
| 429 | `rate_limited`, `tpm_limited`, `concurrency_limit`, `spend_limit_reached`, `global_cap_reached` | "try again later" with `retryAfterSeconds`. **Never** a top-up. |
| 502/503/504 | `provider_error`, `provider_unavailable`, `upstream_timeout` | "provider problem, nothing charged" with retry |

Rules for 402:
- Added fields: `balance:{includedUsdMicro,purchasedUsdMicro}` and `requiredUsdMicro` (strings). With v2 off, `balance` carries the legacy fields.
- A 402 or 429 is returned **before** any upstream call.
- OS client mapping: `classifyGatewayError(status, body) → "topup" | "subscribe" | "retry_later" | "provider" | "unknown"`.
- The draft is preserved. Resend is explicit, never automatic, and uses a fresh request id. The refused request was never charged.

## C5. Acceptance (each worker runs its repo's suite; the lead re-runs everything)

- OS: `cd app && npx vitest run` (the existing runner; install with `bun install` first) plus the new tests. Shell: `node shell/ezil/ui/Billing/*.test.mjs`.
- Gateway: `npm test` (vitest + PGlite migration replay).
- Use `PATH=/root/.bun/bin:$PATH`. No hosted DB, no wrangler deploy, no AWS writes, no Cashfree calls.

---

## v1.1 amendment (2026-10-08, lead). Supersedes conflicting text above.

Cause: the C4 table named codes and statuses the gateway does not emit. The real codes on `origin/main` `c60ac94` are below. Existing codes are **not renamed**.

**A1. v2 enrolment.** An account enrols in v2 on its first accepted funding event if it has no v1 wallet, or if its v1 wallet is **empty**. Empty means:
- zero balance
- no grants ever
- no ledger rows
- no reservations

That move is lossless, because nothing gets converted. A non-empty v1 wallet gets `409 policy_conflict` with `detail: "wallet_conversion_required"`, and nothing changes.

**A2. Retry hints.** `rate_limited`, `tpm_limited`, `concurrency_limit` and `spend_limit_reached` are 429s. They add `error.retryAfterSeconds` (a positive integer) and a matching `Retry-After` header.

**A3. Service-side refusals.** All are 503 and are refused before any provider call:
- `global_cap_reached`
- `killswitch`
- `paused`
- `model_disabled`
- `policy_unavailable`
- `controls_unavailable`
- `credit_policy_unavailable`
- `pricing_unavailable`

They add `error.retryAfterSeconds` when known. The OS classifies them `retry_later` and never offers a top-up.

**A4. Provider failures.** These are the existing codes:

| code | status |
|---|---|
| `upstream_error` | 502 |
| `upstream_unavailable` | 502 |
| `upstream_timeout` | 504 |

They add `error.charge ∈ {"none","pending_review"}`:
- `none` means the hold was released and nothing was charged.
- `pending_review` means cost is unknown and the hold is kept. It is reconciled from real usage and never charged twice.

The OS classifies any 502/504 `upstream_*` code as `provider`. The UI says "nothing was charged" **only** when `charge === "none"`. Otherwise it says the usage will be reconciled and charged at most once. The names `provider_error` and `provider_unavailable` are withdrawn.

**A5. Classifier table, final:**

| status / code | class |
|---|---|
| 402 `insufficient_credits` | `topup` |
| 402 `no_entitlement` | `subscribe` |
| 429 (any A2 code) | `retry_later` |
| 503 (any A3 code) | `retry_later` |
| 502/504 `upstream_*` | `provider` |
| anything else | `unknown` |

## v1.2 amendment (2026-10-08, lead). Gaps found by integrating the QA suite.

**A6. v2 view of unenrolled accounts.** With v2 enabled, an account whose v1 wallet is missing or empty (A1 definition) is treated as v2 everywhere, with zero balances:
- `GET /v1/wallet` returns `version:2`
- 402 bodies use the v2 `balance` shape (`includedUsdMicro`, `purchasedUsdMicro`)
- reserve and settle use the v2 path

Only an account with a **non-empty** v1 wallet keeps the v1 view and v1 money path.

**A7. SQL entry point.** The only executable money entry point for the gateway role is `ezil_ai.wallet_v2_call(p_operation text, p_args jsonb, p_config jsonb)`, with operations `funding`, `admit` and `admit_key`.
- It supplies the transaction-local v2 config.
- `ezil_ai.apply_funding_event` is internal. Called without that config it returns `policy_unavailable`.
- `ezil_ai.wallet_v2(uuid)` stays a read-only function.

**A8. Timestamps** in JSON responses are RFC 3339 UTC with a `Z` suffix (JS `toISOString()` form).

**A9. Provider code mapping is unchanged from `origin/main`.**
- A thrown or failed fetch is `upstream_unavailable` (502).
- A provider HTTP error or unreadable or usage-less body is `upstream_error` (502).
- A deadline is `upstream_timeout` (504).
