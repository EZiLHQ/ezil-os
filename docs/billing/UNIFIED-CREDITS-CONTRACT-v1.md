# Unified credits contract v1 (FROZEN 2026-10-26) — Auth0 operator, Gateway credits, Stripe events, OS usage

Owner: the unified-credits integration lead. Lanes implement exactly this; changes go through the lead as v1.x amendments.
Targets: OS staging (`os-staging.ezil.work`) and Gateway `ezil-ai-gateway-os-staging` (`ai-staging.ezil.work`) only.
Production is out of scope for v1 (later port: Gateway prod migrations `0028+`).

## 0. Global rules (every lane)
- **No new environment variable names.** Use only existing names: `AUTH0_CLIENT_ID`, `AUTH0_SECRET_ID` (founder-created), `OPERATOR_EMAILS`, existing billing config (`fundingUrl`, `fundingHmacSecret`). The Auth0 issuer `https://id.ezil.work/` is a code constant.
- No installs, no network, no secrets, no deploys, no SQL against live databases, no git commits (the lead commits). `TMPDIR=<checkout>/.tmp`. Vitest: `--configLoader runner`.
- Edit only your lane's owned paths (§9). If the contract is wrong or a needed seam is missing, stop and report it in `issues`.
- Unapproved commercial values are **never invented**: top-up credits per pack and team seat allowances stay `null` and fail closed.
- Staging-only SQL goes in Gateway `scripts/os-staging/sql/NN_*.sql`, with a matching `NN_*.rollback.sql`. Never add `migrations/` files. The lead registers each file in `.github/production-migrations.json` as `kind: "snapshot"`.
- Every SQL routine: `security definer`, `set search_path = pg_catalog, pg_temp` (schema-qualify everything), revoke from PUBLIC/anon/authenticated/service_role, grant only to the named caller role. Refuse to install unless `shobj_description(current database) = 'ezil-os-staging'`.

## 1. Operator sign-in (Gateway: portable helpers from the existing auth worker; integration by the lead)
- Customer authentication is unchanged: Supabase JWTs and canonical UUIDs. **No ID token is ever accepted as a Gateway API bearer.**
- The existing auth worker delivers standalone, portable helpers only: PKCE/state/nonce transaction, code exchange, RS256 ID-token verification, opaque session value and hash. The lead integrates them into `src/auth/auth0-operator.ts`, `principal.ts`, `app.ts`, `config.ts`, `index.ts`, the console sign-in, `wrangler.jsonc` env.os-staging and `30_operator_auth0.sql`.
- **Operator** = exactly one account, pinned by email and Auth0 `sub`. Email per the task record: `contact@teacher.tech`. The `sub` is pinned at apply time only after it is **proven**: Auth0 user record, or the os-staging bridged user's `app_metadata.auth0_sub` with a confirmed email. Never guessed. Activation waits for that proof plus the callback and secret setup.
- Pin table (`30_operator_auth0.sql`): `ezil_ai.operator_pin(id boolean primary key default true check (id), email text not null, auth0_sub text not null, pinned_at timestamptz not null)`. Written only by the lead-run script from psql variables `:'operator_email'` (lowercase exact) and `:'operator_sub'` (`^[A-Za-z0-9-]+\|[A-Za-z0-9._-]+$`).
- `ezil_ai.founder_identity(p_actor uuid, p_issuer text)` is replaced: true iff an `auth.users` row `id = p_actor` has `lower(email) = pin.email`, `email_confirmed_at is not null`, `raw_app_meta_data->>'auth0_sub' = pin.auth0_sub`, not banned, not deleted, not anonymous. The rollback file restores the previous body; record its md5 in the file header.
- Sessions are **opaque and DB-backed**. Every Gateway secret is shared with another system, so nothing may be derived from one that grants access.
  - `ezil_ai.operator_sessions(session_sha256 text primary key, actor uuid not null, auth0_sub text not null, email text not null, created_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz)`. RLS on; no table grants to runtime roles.
  - `ezil_ai.operator_session_create(p_sub text, p_email text, p_session_sha256 text, p_ttl_seconds integer) returns jsonb` → `{ok:true, actor, expires_at}` | `{ok:false, error:'not_operator'}`. TTL ≤ 3600.
  - `ezil_ai.operator_session_resolve(p_session_sha256 text) returns jsonb` → `{ok:true, actor, email, sub, expires_at}` only while unexpired, unrevoked and the actor still passes `founder_identity`; else `{ok:false}`.
  - `ezil_ai.operator_session_revoke(p_session_sha256 text) returns jsonb`.
  - Execute grants go to `ezil_ai_gateway`.
- Worker routes:
  - `GET /auth/auth0/login` → 302 to `https://id.ezil.work/authorize` with `response_type=code`, `scope=openid email profile`, PKCE S256, `state`, `nonce` and `redirect_uri=https://<own host>/auth/auth0/callback`. The transaction goes in cookie `__Host-ezil-op-tx`: HMAC with key HKDF-SHA256(`AUTH0_SECRET_ID`, salt=issuer, info=`ezil/gateway/operator-tx/v1`), ≤600 s, HttpOnly, Secure, SameSite=Lax, Path=/.
  - `GET /auth/auth0/callback` → tx/state check → code exchange at `https://id.ezil.work/oauth/token` (`client_secret_post`) → ID-token checks:
    - RS256, `kid`, JWKS cache ≤10 min, ≤64 KiB;
    - `iss`; `aud` contains the client id; `azp` rules as OS `verifyIdToken`; exp/iat ≤60 s skew;
    - nonce compared constant-time; `email_verified === true`;
    - `lower(email)` equals the single `OPERATOR_EMAILS` entry exactly, with no normalisation.
    - Then a random 32-byte value; `operator_session_create(sub, email, sha256hex(value), 3600)`.
    - On success: cookie `__Host-ezil-op=<value>` (HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age ≤3600) → 303 `/`. Otherwise a 403 page and no cookie.
  - `POST /auth/logout` → `operator_session_revoke` + clear both cookies → 303 `/`.
- `principalFor` resolves the operator session **first**, and only when:
  - no `Authorization` header is present (a request with both is refused 400 `ambiguous_credentials`);
  - same-origin is proven (`Sec-Fetch-Site: same-origin`, or `Origin` equals own origin).
  - It returns `{via:"auth0_operator", role:"operations", adminAllowed:true, authUserId: actor, publicId: <member public_id or null>, email, expiresAt}`.
  - **CSRF (hard rule).** Every `*.ezil.work` host is same-site, including user-controlled `*-app.ezil.work` previews, so SameSite=Strict alone protects nothing. Cookie auth requires `Sec-Fetch-Site: same-origin`, or, only when `Sec-Fetch-Site` is absent, `Origin` exactly equal to the own origin. `Sec-Fetch-Site: same-site`, `cross-site` or `none` is refused even with a valid cookie; for example `Sec-Fetch-Site: same-site` + `Origin: https://x-app.ezil.work` → 403. A state-changing method (POST/PUT/PATCH/DELETE) carrying neither header is refused.
  - Without the cookie the hook makes **no** database call. Routes outside the list below (for example `/v1/me/assignments/:id/usage`) never accept the cookie principal.
- Routes accepting the cookie principal (exact): `/v1/admin/*`, `GET /v1/models`, `POST /v1/messages`, `POST /v1/responses`, `GET /v1/requests/:id`, `GET /v1/me/balance`, `GET /v1/me/usage`, `GET /v1/me/limits`. Metered and `/v1/me/*` routes still require an enrolled member row (else 403 `not_a_member`).
- `admin()` admits **only** `via:"auth0_operator"` AND DB `assert_operator(actor)`. Google operator admission and legacy operations-member admin are removed.
- Console: the sign-in button goes to `/auth/auth0/login`; the Supabase GoTrue PKCE flow is removed; `api()` uses `credentials:'same-origin'` and sends no bearer.

## 2. Admin directory (Gateway, lane G2)
- `GET /v1/admin/directory?q=&limit=1..50&cursor=` → `ezil_ai.admin_directory(p_actor uuid, p_query text, p_limit integer, p_cursor text) returns jsonb` (`31_admin_directory.sql`). Asserts `assert_operator(p_actor)` first.
- Row fields and sources:
  - `auth_user_id`, `email`, `registered_at` (`auth.users.created_at`), `email_confirmed`;
  - `ezil_id_linked` (`auth0_sub` present); `status` `active|banned|deleted`;
  - `member {public_id, role, suspended} | null` (`ezil_works.ai_members`);
  - `last_sign_in_at` (`auth.users.last_sign_in_at`, label "last EZiL ID sign-in to OS");
  - `sessions {live_count, last_refresh_at}`: `auth.sessions` rows with `not_after is null or not_after > now()` and refreshed/updated within 1 h. Never ip or user_agent.
  - `last_gateway_request_at` (max `ezil_ai.requests` created time for that user);
  - `computer {state} | null` (latest `public.ezil_computer_placements` row, guarded with `to_regclass`);
  - `ai {available_micro, held_micro} | null`;
  - `sources` (field → store map).
- Page summary: `registered`, `enrolled`, `live_session_evidence`, `requested_24h`.
- "Active" is derived only from sessions, requests or computer evidence, never from last sign-in. No export or bulk route.
- Console view `directory` (module `src/console/directory.ts` exports `DIRECTORY_JS`). It keeps the existing funding-account card behaviour.

## 3. Multi-model playground (Gateway, lane G3)
- Module `src/console/playground.ts` exports `PLAYGROUND_JS`. There is no new server route.
- Model list: `GET /v1/admin/registry` (enabled models/routes).
- Send: `POST /v1/messages` (anthropic-messages models) or `POST /v1/responses`, with:
  - `Idempotency-Key: op-<uuid>` (never `pk:`/`gw:`/`as:`);
  - `x-ezil-client: gateway-playground`;
  - `max_output_tokens` default 256, hard cap 1024;
  - a stream toggle.
- Show: response (JSON or SSE), `x-ezil-request-id`, trace id, then `GET /v1/requests/:id` and `GET /v1/admin/observability/requests/:id` (status, usage, hold, settled debit), and balance before/after (`/v1/me/balance`).
- Billed to the operator's own member account. Funding is one explicit, recorded operator grant; never automated.

## 4. Enrollment (Gateway SQL: G4; OS bridge call: unassigned; delivery retry: O-credits)
- `20_enroll_members.sql`: `ezil_works.enroll_ai_member(p_auth_user_id uuid, p_auth0_sub text) returns jsonb` → `{ok:true, public_id, role, created}` | `{ok:false, error}`.
  - Uses `pg_advisory_xact_lock` per user.
  - Requires `auth.users` confirmed, `raw_app_meta_data->>'auth0_sub' = p_auth0_sub`, not banned/deleted/anonymous.
  - Reuses an existing `ai_members` row unchanged: role, public_id and suspension are never altered.
  - Otherwise inserts role `creator` with `gen_random_uuid()` public_id (collision-checked).
  - In the same transaction it sets `raw_app_meta_data.ezil_role` to the member's role. Never `operations`, never `admin_grant`.
  - Execute is granted to the OS server DB role named by psql variable `:'os_server_role'` (must exist).
- OS bridge: after the Supabase user link and **before** `generateLink`/`verifyOtp`, call `select ezil_works.enroll_ai_member($1,$2)`, so the minted JWT carries `ezil_role`.
  - Enrollment runs only when `fundingUrl` origin is `https://ai-staging.ezil.work`; the SQL function also refuses non-staging databases.
  - Enrollment failure does not block sign-in; delivery retries.
- Free 500 credits: enqueued once at enrollment with the existing `aiCreditEntitlement`/`aiCreditOutboxItem` (same entitlement id as today).
- Outbox delivery: `no_ai_account` becomes `retry` (bounded by existing attempts/backoff), not terminal.
- Staging recovery script (dry-run default) reopens earlier `no_ai_account` rows. It revalidates the entitlement and never resurrects revoked or expired rows.

## 5. Credit events (OS: O-credits generates and delivers; Gateway: G5 ledger accepts)
- **Top-up (v1 protocol):**
  - `AI_PACKS[sku].aiCredits: number | null`, `null` for both existing packs. Checkout is refused while null (`PRECONDITION_FAILED`, `pack_credits_unset`).
  - `topup_paid` with null → `review:pack_credits_unset` and no grant.
  - With a value: `entitlementId = ezil-os:v1:topup:<packSku>:<paymentIntentId>`, `eventId = <entitlementId>:grant`, `expiresAt` = existing `purchasedPeriod(event.created).end`.
  - Full refund → `revoke` from the stored receipt (frozen `accountPublicId`).
  - Legacy `amountUsdMicro` rows are untouched.
- **Dispute restoration (event-correct):**
  - Refund revokes are terminal: never restored.
  - On `restore` (dispute won), for each AI receipt revoked by **that dispute**, enqueue kind `ai_restore`, action `restore`, `eventId = <entitlementId>:restore:<disputeId>`, with the original entitlementId, credits and expiresAt.
  - Delivery claims an `ai_restore` row only after that entitlement's `ai_revoke` row is delivered. Delivery timestamps are never used for ordering.
  - OS delivery's event check today requires `eventId === entitlementId + ':' + action`; for `restore` the rule is `eventId === entitlementId + ':restore:' + disputeId` (O-credits follow-up).
- **Gateway `restore` action** (ledger lane G5; `32_entitlement_restore.sql` widens the event action check and replaces `ezil_ai.entitlement_event`, recording the previous md5 for rollback):
  - for an entitlement whose grant was revoked by a prior event, and only once **no reservation on that grant is open** (else 409 `restore_hold_pending`; the OS retries), create **one new grant**. Its `credits_micro` = the micro forfeited by the revoke row(s) **plus** any positive remainder later stranded on the revoked grant when holds that were open at revoke time settled. Equivalently, the original credits minus everything actually debited. It keeps the original `expires_at`;
  - the new grant is addressable as entitlement `<entitlementId>:restore:<disputeId>`, so a later revoke can target it;
  - idempotent per eventId: a replay returns `already_restored` and **never mints**; the ledger stays append-only (no un-revoke);
  - outcomes `restored` | `already_restored` | 409 `restore_not_revoked` (OS retries) | `restore_expired` (OS done; no grant) | `restore_nothing_forfeited` (OS done; no grant).
  - Hook body fields are unchanged; `action` accepts `restore`; `credits` must equal the original grant's credits (consistency check), else 409 `event_conflict`.
- **Stripe inbox:** the same Stripe event id with a different payload sha256 → reject (HTTP 409 `event_conflict`, no processing, review log). An identical replay stays idempotent.

## 6. Canonical AI balance (parity) and service balance read
- The service balance read below is **frozen as an interface but not implemented or activated in v1**. W0 ships it as a 501 seam. It goes live only after an explicit review of the Universe ID-token → OS → Gateway delegation (v1.1). The audience checks are never weakened, and an operator/admin credential is never used for a customer.
- Gateway: `POST /v1/integrations/balance`.
  - Same HMAC scheme as entitlements (`X-EZiL-Timestamp`, `X-EZiL-Signature: v1=…`, `ENTITLEMENT_HMAC_SECRET`, skew check).
  - Body exactly `{accountPublicId}` → 200 `{account_public_id, state, available_micro, held_micro}`, where `state` is the `/v1/me/balance` vocabulary (`ok|exhausted|paused_reconciliation|paused_operations`); 404 `account_not_found`. Read-only.
- OS module `app/src/server/billing/ai-balance-state.ts` (O-API), `canonicalAiBalance(gateway: {state, available_micro, held_micro} | null, planGrantCredits: number)` → `{balance: number|null, state: 'ok'|'warning'|'exhausted'|'paused'|'unknown'}`:
  - `balance = floor(available_micro / 1e6)`;
  - `paused_*` → `paused`;
  - `available_micro == 0` → `exhausted`. Decide on micro, never on the floored number;
  - `available_micro ≤ 10% of planGrantCredits × 1e6` → `warning`;
  - else `ok`; unreadable → `unknown` with balance null.
- The OS summary (`BillingSummaryV3.ai.state`) adopts this vocabulary.
- The REST entitlement `ai` field is `{balance, state}` only for `ok|warning|exhausted`, and `null` for `paused|unknown` (the Universe client treats null as unknown).

## 7. OS REST adapter for Universe — DEFERRED to v1.1 (not dispatched)
Gated on the delegation review in §6. The OS API worker explicitly excludes it. The shape below is recorded so Universe's existing client (`OsBillingClient.php`) is not rebuilt.

Routes:
- `GET /api/billing/v3/entitlement`
- `GET /api/billing/v3/teams/mine`
- `POST /api/billing/v3/teams/{id}/seats`

Auth for all three:
- `Authorization: Bearer <EZiL ID id_token>`: RS256, `iss=https://id.ezil.work/`, `aud` contains `AUTH0_CLIENT_ID` (OS and Universe share that web client), exp checked.
- Subject → user via `auth.users.raw_app_meta_data->>'auth0_sub'`; unknown → 404 `unknown_subject`. Email is never used for mapping.

Responses:
- **entitlement:** shape exactly as consumed by Universe `core/app/Services/OsBillingClient.php`: `{plan:{sku,tier,team}, compute:{…}, ai}`. The compute fields follow the Batch 28 `v3/entitlement.ts` design; `ai` is from §6 via the G5 service read for the user's account public_id.
  - Reuse the OS owner's Batch 28 route/entitlement code when the owner hands it over; otherwise implement the same shape.
- **teams/mine:** `{teams: []}`. No team plan can be sold until team rules exist, so this is truthful.
- **seats:** 404 `team_not_found` while no teams exist. No team SKU, allowance or checkout is added (blocked until approved).

## 8. OS display (O-API; the ai-proxy allow-list is the VS Code worker's)
- tRPC `billing.aiUsage({limit 1..50, before?})` → `{rows:[{requestId, model, createdAt, status, credits}]} | {unavailable:true}`.
- tRPC `billing.aiLimits()` → a credits subset of `/v1/me/limits` (daily/monthly used+limit, rpm, concurrency, pauses, allowed models) | `{unavailable:true}`.
- Both use the same token rule and 3 s bound as `readAiBalance`, and never echo upstream text.
- Worker `ai-proxy` allow-list adds `GET /ai/v1/me/limits` (no query).
- UI: an "EZiL AI" section in the billing/account panel showing balance + canonical state (from the summary), 5 recent requests and limits.
- The VS Code extension is unchanged in v1 (it ships in the desktop image).

## 9. Ownership (exclusive while writing; the lead integrates shared seams)
- **W0 (lead, committed before new lanes)**:
  - Gateway seams: `src/store.ts` RPC methods `operatorSessionCreate/Resolve/Revoke` (`operator_session_*`), `adminDirectory` (`admin_directory`), `integrationBalance` (`integration_balance`, v1.1), and `EntitlementEventArgs.action` widened to `"grant"|"revoke"|"restore"`;
  - `src/app.ts` routes `GET /auth/auth0/login`, `GET /auth/auth0/callback`, `POST /auth/logout`, `POST /v1/integrations/balance`, `GET /v1/admin/directory`, all 501 stubs, plus a `principalFor` hook calling `operatorSessionPrincipal()` (stub returns null);
  - `Principal.via` += `"auth0_operator"`;
  - console splice of `DIRECTORY_JS` and `PLAYGROUND_JS` (empty stub modules) and the Controls nav entries `directory` and `playground` (`src/console/observe.ts`, W0.1);
  - `test/live/lib.mjs` route list;
  - this contract (Gateway `docs/UNIFIED-CREDITS-CONTRACT-v1.md`; OS `docs/billing/UNIFIED-CREDITS-CONTRACT-v1.md`).
- **Lead (integration)**:
  - ports the auth worker's portable helpers into `src/auth/auth0-operator.ts`;
  - `src/auth/principal.ts`, `src/config.ts`, `src/index.ts`, the `src/app.ts` `admin()`/principal path, the console sign-in/`api()` parts of `src/console/{page,script}.ts`, `wrangler.jsonc` env.os-staging;
  - `scripts/os-staging/sql/30_operator_auth0{,.rollback}.sql`;
  - `.github/production-migrations.json` snapshot registration; integration of all lanes.
- **Existing auth worker** (prod-lineage RAM worktree): standalone portable C1 helper modules + tests only.
- **New G2 DIRECTORY**: `src/admin/directory.ts`, `src/console/directory.ts` (defines `VIEWS.directory`), `scripts/os-staging/sql/31_admin_directory{,.rollback}.sql`, new tests.
- **New G3 PLAYGROUND**: `src/console/playground.ts` (defines `VIEWS.playground`), new tests.
- **New G4 ENROLLMENT**: `scripts/os-staging/sql/20_enroll_members{,.rollback}.sql`, `docs/OS-STAGING.md` (enrollment section only), new tests.
- **New G5 LEDGER**: `src/entitlements.ts` (accept `restore`), `scripts/os-staging/sql/32_entitlement_restore{,.rollback}.sql`, new tests. `src/integrations-balance.ts` stays a 501 seam (v1.1).
- **Existing O-credits worker**: v1 delivery retry (`no_ai_account` → retry), top-up nullable guard (explicit configuration + synthetic fixtures, live fail-closed), Stripe inbox payload-digest conflict, narrow ports and webhook changes. Follow-up after G5 lands: OS `ai_restore` enqueue/delivery per §5 (root scopes it).
- **Existing O-API worker**: §6 canonical balance state, §8 tRPC usage/limits projection and shell UI. Not §7.
- **Existing VS Code worker**: extension status/data/tests/README, plus only the exact `GET /ai/v1/me/limits` ai-proxy allow-list + tests. The lead owns the later VSIX packaging/image handoff.
- **Unassigned (root dispatches a writer or the lead does it at integration)**: OS bridge enrollment per §4 — `app/src/server/auth/bridge.ts`, new `app/src/server/auth/staging-ai-enrollment.ts`, Free enqueue at enrollment. It must not touch O-credits' outbox files.
- **QA (after code exists)**: new `qa-unified-*` test files written from this contract only.

## 10. Receipt (every lane)
JSON `{completed, undone, files, commands:[{cmd, exit}], issues}`.
