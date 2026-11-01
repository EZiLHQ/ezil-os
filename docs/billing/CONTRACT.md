# Billing contract v1 — Free + EZiL Pro, Settings → Billing, `/pricing`

Status: **frozen for wave 1** (2026-10-11). Every billing change in this repository is built against this file.
Changing a clause means changing this file first, in its own commit.
Plan of record: Notion task 3f67021e-76d7-8165-8b05-e3c2ca2e9998.

Ships **disabled by default**. With every flag unset, the product behaves exactly as it did before billing existed:
- no tab;
- no page;
- no new route answers anything but 404 or 503;
- no write to a new table.

## 1. Ownership

- **This repository (OS app) owns:**
  - plan and subscription state;
  - the workspace-time and storage meters;
  - Stripe Checkout, the Customer Portal and webhooks.
- **The AI Gateway owns the AI-credit ledger.**
  - This repository only queues AI grants in `ezil_billing_outbox`.
  - Delivery waits until the Gateway's USD ledger and an OS AI client are live (gate G4).
  - Until then the AI meter reports `state: 'unavailable'`.
- **Seller:** EZiL LLC. Currency: USD. Prices are shown "before applicable tax", and Stripe Tax computes tax at checkout (`automatic_tax`).

## 2. Catalog v1 (`app/src/server/billing/catalog.ts`)

| | Free (`free_v1`) | Pro (`pro_monthly_v1`) |
|---|---|---|
| Price | — | USD 20.00 / month, recurring, before tax |
| Workspace time | 8 h per calendar month (UTC) | 20 h per Stripe billing period |
| Saved storage | 2 GB (2 GiB = 2,147,483,648 bytes) | 20 GB (20 GiB), only once `BILLING_LARGE_STORAGE=1` (gate G-STOR); Free's cap until then |
| AI credit (provider cost, no markup) | one-time USD 0.50 trial | USD 3.00 per period |

2.1 The catalog is code, versioned by `CATALOG_VERSION`. A price change is a new SKU, never an edit.

2.2 Same standard computer for both plans. There are no model, size or speed differences, and no copy may suggest any.

2.3 **AI packs** are sold at face value plus a flat *service fee*. The fee is charged the same way whatever the payment method; it is never called a "card fee".
- `fee = ceil((credit + 30¢) / (1 − 0.049)) − credit`, giving $10 + $0.84 and $25 + $1.61.
- Packs are listed but **not sold** before G4.

## 3. Meters

### 3.1 Workspace time

**What counts:**
- Container running time per computer, from start to stop or sleep, summed over all of the user's computers. Two computers running at once count twice.
- Each interval is rounded **up** to the next whole minute.
- An interval that is still open counts until `now`.

**Window:**
- Free: the calendar month in UTC, `[first of month 00:00, first of next month)`.
- Pro: the subscription's `[current_period_start, current_period_end)`.
- While Pro is active, Free's allowance is suspended, not added.

**State thresholds:**
- `exhausted` when remaining ≤ 0;
- `low` when remaining ≤ 20% of the allowance;
- otherwise `ok`.

**Enforcement** (only when `BILLING_ENFORCEMENT=1`; wave 3):
- refuse a start with `workspace_time_exhausted` when fewer than 60 s remain;
- at zero, save then stop;
- **never force-stop after a failed save.**

### 3.2 Saved storage

**What counts:** the latest sample per computer, from `ezil_billing_storage_samples` (`latestStorageTotal`), summed over:
- **Legacy "Saved storage"** (the per-user v1 allowance): every computer of the user, including deleted computers that are not yet purged.
- **A v3 computer disk** (`computer.disk` and `storage` in `billing.summary`, `storage.disk` in `billing.usage`): only the user's LIVE computers of that disk's kind, the aws-ec2 ones on an AWS volume and the others on a Cloudflare disk (`storageDisk`, with the live computers from the router's placement read). A deleted computer's retained volume is on no disk the user can reach, so it never fills the new computer's disk. A placement read that lists no computers (failed, or placement reads off) counts none, so the disk reads "not measured yet".

**No sample is not zero:** with no sample at all, every summary (v1, v2, v3) returns `usedBytes: null` with state `unavailable`. The shell shows an unmeasured AWS disk as its size with "Space used isn't measured yet." (the disk figure it showed before the sampler existed) and "Space used isn't measured on this computer." where there is no disk figure (Cloudflare), never "0 used", and shows a bar and Full / Almost full only for a measured figure.

**Units:** bytes are stored as `bigint`. Every figure shown is GiB (1024³ bytes), labelled "GB" like every disk size. The v1 caps were decimal (2,000,000,000 bytes) until 2026-11-01. Making them GiB only ever grants more.

**Cap:** `storageCapBytes(plan, largeStorageEnabled)`.

**Policy (approved 2026-11-01).** The meter counts the logical primary bytes a user owns, each datum once.
- **AWS computer:** the sample is the used bytes (`statvfs`: `(f_blocks − f_bfree) × f_frsize`) of the computer's retained data volume. That volume holds `/workspace`, HOME, the overlay upper and the profiles, including editor and chat state, so chat is counted once, inside it.
  - **Who measures:** the HOST agent, outside the guest container (`infra/host-agent/lib/ezil_host/storage.py`), and only while the volume is that lease's guarded mount.
  - **When:** 60 s after the agent starts, every 15 min, and once on stop. The stop sample runs after the sync and before the unmount, on its own thread that the shutdown waits for at most 5 s of wall-clock time; a post still in flight then is abandoned.
  - **Endpoint:** it posts to `POST /api/compute/aws/storage` (`app/src/server/billing/http/host-storage.ts`) with `source: 'host-agent'`.
- **Excluded, as operator cost rather than user quota:** checkpoint generations, S3 noncurrent versions, EBS snapshots and the host root disk.
- **Credential:**
  - The host signs each sample with its epoch's control key, the one enrollment already issued and kept host-only. The app re-derives that key from the placement's consumed-nonce proof (`deriveControlKey`). No deployment-wide secret is ever delivered into a guest, where users are root.
  - The signed headers carry the computer and its epoch, and the key proves them. The owner comes from the placement. The body names no computer or user, and a body that does is refused.
  - A signature expires after 300 s. A sample measured more than 30 min ago, or more than 5 min ahead, is refused.
  - A retry of the same `(computer, measured_at)` is answered `recorded: false`. This is enforced by an advisory-locked insert-if-absent, with no new index.
- **Usage-secret path:** `POST /api/billing/usage` no longer accepts `storage` events for an `aws-ec2` computer.

**Metering gaps that remain:**
- **Cloudflare computers have no emitter.** Their container is user-reachable, so a sample from inside it would be advisory only. Their storage stays "not measured", and the UI says so.
- **On Cloudflare/Free, the 512 MiB checkpoint cap binds long before the 2 GB Free figure,** so that allowance cannot be reached there.
- **No per-user write enforcement exists beyond the volume size.** An AWS disk fills to ENOSPC, and the 80% / 95% states are warnings only.
- **A deleted computer's last sample counts in legacy "Saved storage" until a purge marker exists.** No purge state is recorded yet, and the 14-day purge is a dry run. The v3 disk never counts it, and no v3 field shows the per-user total yet (the v3 `storage` wire type is pinned).
- **AWS disks read "Space used isn't measured yet." until the host AMI that carries `storage.py` is rolled out,** and on each computer until its first sample (60 s after its agent starts). That AMI ships separately from the app deploy. Until then the disk shows its size, as before, so the app deploy changes nothing visible for AWS users and needs no rollback flag. The plan's `STORAGE_METER_V2` flag and its `layer_breakdown` / `measurement_kind` columns and unique index were not added (no schema change in this run).
- **A stop sample is refused once a control-plane stop has begun.** DRAINING clears the key's proof, so the last periodic sample, at most 15 min old, stands. Idle stops, which the agent initiates, are sampled.
- **Two live AWS computers can read falsely full in the unscoped summary.**
  - The `billing.summary` and unscoped `billing.usage` compare the sum of the live AWS computers' latest samples with the smallest of their volumes (`readVolumeGiB`).
  - `billing.usage` with a `computerId` compares one computer with its own volume, which is correct.
  - Fixing this needs a product decision: a per-user total or a per-disk meter.

**State thresholds:**
- `over_cap` when used > cap;
- `exhausted` when used ≥ 95% of the cap;
- `low` when used ≥ 80%;
- otherwise `ok`.

### 3.3 AI

`state: 'unavailable'` with every balance `"0"` and `includedExpiresAt: null` until G4.

## 4. Data model (`app/src/server/db/schema/billing.ts`, migration `app/drizzle/0003_billing.sql`)

**Common to every table:**
- named `ezil_billing_*`;
- RLS enabled, with a service-role-only policy (same pattern as `0002_os_access.sql`);
- a `user_id` FK to `auth.users` with `ON DELETE CASCADE`.

| table | columns | notes |
|---|---|---|
| `ezil_billing_customers` | `user_id uuid pk`, `stripe_customer_id text unique not null`, `created_at` | one Stripe customer per user |
| `ezil_billing_subscriptions` | `stripe_subscription_id text pk`, `user_id uuid not null`, `status text not null`, `sku text not null`, `current_period_start timestamptz`, `current_period_end timestamptz`, `cancel_at_period_end boolean not null default false`, `stripe_event_created timestamptz not null`, `updated_at` | state row; an update is applied only when `stripe_event_created ≥` the stored value |
| `ezil_billing_events` | `event_id text pk`, `type text not null`, `livemode boolean not null`, `payload_sha256 text not null`, `received_at`, `processed_at timestamptz null`, `outcome text null` | webhook inbox; a duplicate `event_id` is a no-op |
| `ezil_billing_grants` | `id uuid pk`, `user_id`, `meter text check in ('workspace_seconds','ai_usd_micro')`, `kind text check in ('pro_period','topup','revoke','suspend','restore')`, `amount bigint not null` (negative for revoke/suspend), `period_start`, `period_end`, `source_type text check in ('invoice','payment_intent','refund','dispute')`, `source_id text not null`, `created_at`; `unique(source_type, source_id, meter, kind)` | **append-only**: a trigger refuses UPDATE, DELETE and TRUNCATE |
| `ezil_billing_usage_intervals` | `id uuid pk`, `user_id`, `computer_id uuid not null` (FK `ezil_computers`), `started_at not null`, `last_seen_at not null`, `ended_at null`, `close_reason text null`, `source text not null` | partial unique index: one open interval per computer (`where ended_at is null`) |
| `ezil_billing_storage_samples` | `id uuid pk`, `user_id`, `computer_id uuid not null`, `bytes bigint not null check ≥ 0`, `measured_at not null`, `source text not null` | append-only (trigger) |
| `ezil_billing_outbox` | `id uuid pk`, `event_key text unique not null`, `user_id`, `kind text not null`, `payload jsonb not null`, `created_at`, `delivered_at null`, `attempts int not null default 0`, `last_error text null` | AI grants waiting for the Gateway |

## 5. Server modules (`app/src/server/billing/`)

### 5.1 Pure modules (no DB, no network; fully unit-tested)

- **`types.ts`, `catalog.ts`, `config.ts`:** lead-owned seams; already committed.
- **`meters.ts`** exports:
  - `freeWindow(now: Date): { start: Date; end: Date }`
  - `workspaceUsedSeconds(intervals: {startedAt: Date; endedAt: Date | null}[], window: {start: Date; end: Date}, now: Date): number`
    - clips each interval to the window;
    - ends an open interval at `now`;
    - rounds each clipped interval up to the minute, but 0 stays 0.
  - `workspaceState(remaining: number, allowance: number): MeterState`
  - `storageState(used: bigint, cap: bigint): MeterState`
  - `resolvePlan(subs: SubscriptionRow[], now: Date): { plan: 'free'|'pro'; status: PlanStatus; window: {start,end}; renewsAt: Date|null; cancelsAt: Date|null }`
  - `buildSummary(input: { config: BillingConfig; now: Date; subs: SubscriptionRow[]; intervals: IntervalRow[]; storage: { computerId: string; bytes: bigint; measuredAt: Date }[] }): BillingSummaryEnabled`
    - `storage` may hold several samples per computer; only the newest per `computerId` counts.
    - `actions.checkout` = checkout available (flag + key); `actions.portal` = checkout available **and** the plan is Pro or past due; `actions.topup` = false until G4.
    - Catalog cents (`unitAmountCents`, `creditCents`, `serviceFeeCents`, `totalCents`) are small integers and travel as numbers.
- **Pro resolution in `resolvePlan`:** a subscription grants Pro when its status is `active` or `trialing` and `now ∈ [current_period_start, current_period_end)`.
  - `cancel_at_period_end` turns that into status `cancels` (`cancelsAt = current_period_end`).
  - A subscription that is `past_due` or `unpaid` gives `plan: 'free'` with `status: 'past_due'`.
  - Anything else is Free.
- **`stripe/verify.ts`** exports:
  - `verifyStripeSignature({ rawBody, header, secret, nowMs, toleranceSeconds = 300 }): Promise<void>`
    - throws `WebhookNotVerified`;
    - follows the `Stripe-Signature: t=…,v1=…[,v1=…]` scheme, HMAC-SHA256 over `${t}.${rawBody}`;
    - compares every candidate in constant time.
  - Ported from EZiL Works `apps/api/src/routes/money.ts` `verifyStripe`.
- **`stripe/events.ts`** exports `planStripeEvent(event: StripeEventLike): BillingAction[]`. It is pure and decides what an event means; it never reads payload metadata to choose a user.

| Stripe event | action(s) |
|---|---|
| `checkout.session.completed` | `link_customer` `{customerId, clientReferenceId}` only when `client_reference_id` is present (never from metadata; a session without it links nothing and must not throw); `topup_paid` when `mode=payment` and `payment_status=paid` |
| `checkout.session.async_payment_succeeded` | `topup_paid` |
| `invoice.paid` | `grant_period` (from the invoice's subscription line `period`, keyed by invoice id) |
| `invoice.payment_failed` | `sync_subscription` |
| `customer.subscription.created`, `…updated`, `…deleted` | `sync_subscription` |
| `refund.created`, `refund.updated` | `revoke` `{chargeId, refundId}` (grant key = refund id). Current API versions do not embed refunds in `charge.refunded` |
| `charge.refunded` | one `revoke` per refund in `refunds.data` when an older API version embeds it; otherwise `[]` |
| `charge.dispute.created` | `suspend` |
| `charge.dispute.closed` | `restore` when won |
| anything else | `[]` (acknowledged, ignored) |

### 5.2 Effectful modules (wave 2)

- `stripe/client.ts`: a minimal `fetch`-based Stripe REST client. No SDK dependency, form-encoded bodies, and an `Idempotency-Key` on every POST.
- `store.ts`: DB reads and writes.
- `processor.ts`:
  - applies a `BillingAction[]` in one transaction;
  - **re-reads** the subscription or invoice from Stripe before acting;
  - resolves the user only through `ezil_billing_customers`;
  - grants via `insert … on conflict do nothing`.
  - **No multi-statement transaction, deliberately.** Every write is idempotent and keyed by a Stripe object id, and an event whose processing throws stays `unprocessed` in the inbox and is re-run in full on Stripe's retry. A partial application therefore converges instead of needing a rollback.

## 6. Routes and API

**tRPC router `billing`** (`app/src/server/api/routers/billing.ts`); every procedure is a `protectedProcedure`, with the user taken from the session only:
- `summary` returns `BillingSummary`: `{enabled:false}` unless `BILLING_TAB_ENABLED=1`.
- `createCheckout({ sku })` (wave 2) returns `{ url }`.
  - It uses `client_reference_id` = the user id, `automatic_tax`, and `success_url /billing/return?session_id={CHECKOUT_SESSION_ID}`.
  - It returns `PRECONDITION_FAILED` unless checkout is available.
  - Packs return `PRECONDITION_FAILED` before G4.
- `portal()` (wave 2) returns `{ url }`.
- `checkoutStatus({ sessionId })` (wave 2) returns `{ status: CheckoutStatus }`. It never grants anything.

**HTTP routes:**
- `POST /api/billing/stripe/webhook` (wave 2):
  - 503 without a webhook secret;
  - 400 on a bad signature;
  - 200 once the event is in the inbox, duplicates included.
- `POST /api/billing/usage` (wave 2): the Worker's signed `start`/`stop`/`heartbeat`/`storage` events (storage for an `aws-ec2` computer is refused; see §3.2).
- `POST /api/compute/aws/storage`: an AWS host agent's storage sample under its epoch control key (§3.2). 401 for every unauthenticated case, 400 for a bad or id-bearing body, 422 for a stale or future measurement, 503 `retryable` for an outage, 200 `{ recorded }`.
  - Signed with `X-EZiL-Timestamp` and `X-EZiL-Signature: v1=<hex HMAC-SHA256(secret, "<ts>.<body>")>`, with a 300 s skew window.
  - A computer is owned only through `ezil_computers`.
- **`/pricing`:** returns `notFound()` unless `PRICING_PAGE_ENABLED=1`. `/login` shows a plain `<a href="/pricing">Plans</a>` only when it is set.

**Shell:**
- `ShellBootPayload.features` exists **only** when billing is enabled: `{ billing: true }`.
- The Billing tab is `available` only when `payload.features.billing === true` and Account would be available.
- `openSettingsWindow({ initialTab })` opens on that tab when it is available.

## 7. Flags and secrets (`config.ts`)

**Flags** — each is on only when set to exactly `1`:
- `BILLING_TAB_ENABLED`
- `PRICING_PAGE_ENABLED`
- `CHECKOUT_ENABLED`
- `BILLING_ENFORCEMENT`
- `BILLING_LARGE_STORAGE`
- `BILLING_AUTOMATIC_TAX`
- `BILLING_ADAPTIVE_PRICING`
- `BILLING_MANAGED_PAYMENTS` (default off; takes precedence over automatic tax and Adaptive Pricing)

**Secrets** — only ever tested for presence, never logged:
- `STRIPE_SECRET`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_PRO_MONTHLY` (optional)
- `BILLING_USAGE_HMAC_SECRET`
- `BILLING_FUNDING_URL`
- `BILLING_FUNDING_HMAC_SECRET`

### Tax

This subsection governs Checkout tax behavior, including the references in §1 and §6. By default, Stripe Tax is off: EZiL LLC has no tax registrations. The recommended live setting is `BILLING_MANAGED_PAYMENTS=1` **after the founder accepts Stripe Managed Payments terms in the Stripe dashboard**. Stripe becomes the merchant of record, handling sales tax/VAT/GST in 80+ countries, fraud, disputes and buyer support for an additional 3.5% per transaction. Buyers enter their name and billing address; Stripe chooses payment methods and shows local currency.

Managed Payments ignores `BILLING_AUTOMATIC_TAX` and `BILLING_ADAPTIVE_PRICING` and omits their incompatible Checkout fields. Every inline product (Pro, AI credits and the service fee) uses `MANAGED_PAYMENTS_TAX_CODE = txcd_10103000` ("Software as a service (SaaS) – personal use"). When `STRIPE_PRICE_PRO_MONTHLY` selects a dashboard Price, set that tax code on its Product in Stripe; Checkout sends no inline product data for that Price.

Alternatively, keep Managed Payments off and enable Stripe Tax with `BILLING_AUTOMATIC_TAX=1` once EZiL LLC has the required tax registrations.

## 8. Copy rules (checked by a test)

User-facing pricing and billing copy must not contain any of the following (case-insensitive; this is the list `e2e/billing-e2e-lib.mjs` `scanCopy` enforces — keep them identical):
- `faster`
- `instant`
- `unlimited`
- `priority`
- `gpu`
- `heavy use`
- a model name (`gpt`, `claude`, `gemini`, `llama`)
- `memory is kept`, `memory survives`, `processes keep running`
- `ai included`, `includes ai`
- `compute hours`, `standard-hour`

`vCPU` is allowed in configuration labels ("2 vCPU · 8 GB"); `fair use` left the banned list in c6943c56.

Prices are written as `$20` / `USD`, next to "before applicable tax". AI rows say "AI assistant coming soon" until G4.
