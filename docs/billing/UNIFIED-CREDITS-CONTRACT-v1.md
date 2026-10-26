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
- **Operator** = exactly one account, pinned by email and Auth0 `sub`. The founder's final correction is `contact@ezil.work`, superseding all prior operator-email requirements. The lead retains the verified Auth0 subject and canonical user UUID only in private apply receipts outside Git; tracked fixtures use synthetic identifiers. The lead-run SQL receives the proven subject through `:'operator_sub'` and pins that exact, case-sensitive subject to the existing confirmed user after revalidating the email/sub pair; it never creates a user or changes identity data. Activation still requires the callback and secret setup.
- Pin table (`30_operator_auth0.sql`): `ezil_ai.operator_pin(id boolean primary key default true check (id), email text not null, auth0_sub text not null, pinned_at timestamptz not null)`. Written only by the lead-run script from psql variables `:'operator_email'` (lowercase exact) and `:'operator_sub'` (`^[A-Za-z0-9-]+\|[A-Za-z0-9._-]+$`).
- `ezil_ai.founder_identity(p_actor uuid, p_issuer text)` is replaced: true iff an `auth.users` row `id = p_actor` matches the pin's canonical actor, has `email = pin.email`, `email_confirmed_at is not null`, `raw_app_meta_data->>'auth0_sub' = pin.auth0_sub`, not banned, not deleted, not anonymous, and an unambiguous email/sub pair. The existing issuer and member-suspension checks remain. Rollback fails closed with `false` for every actor and retains the existing restricted caller permissions; it never restores the legacy Google founder rule. The previous body's md5 is recorded in the SQL header.
- Sessions are **opaque and DB-backed**. Every Gateway secret is shared with another system, so nothing may be derived from one that grants access.
  - `ezil_ai.operator_sessions(session_sha256 text primary key, actor uuid not null, auth0_sub text not null, email text not null, created_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz)`. RLS on; no table grants to runtime roles.
  - `ezil_ai.operator_session_create(p_sub text, p_email text, p_session_sha256 text, p_ttl_seconds integer) returns jsonb` → `{ok:true, actor, expires_at}` | `{ok:false, error:'not_operator'}`. TTL ≤ 3600.
  - `ezil_ai.operator_session_resolve(p_session_sha256 text) returns jsonb` → `{ok:true, actor, email, sub, expires_at}` only while unexpired, unrevoked and the actor still passes `founder_identity`; else `{ok:false}`.
  - `ezil_ai.operator_session_revoke(p_session_sha256 text) returns jsonb`.
  - Only the owner can access the pin/session tables and internal `operator_actor_for` helper. Only the owner and `ezil_ai_gateway` can execute the three session RPCs, without caller grant options. SQL30 removes all other prior/default object and column grants and refuses unsafe role memberships without changing unrelated roles. Existing `founder_identity`/`assert_operator` callers are preserved.
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
- **Dispute restoration — restore chains (W0.3; supersedes the W0.2 restore text).**
  - **Chain.** An original entitlement `E` (generation 0, entitlement id `E`) and its restore grants (generation k ≥ 1, entitlement id = the restore eventId). At most **one** generation of a chain is unrevoked at any time; it is the chain **head**.
  - **Event id grammar** (the Gateway parses it for `revoke`/`restore`; `grant` is unchanged):
    - `E:revoke:dispute:<disputeId>`: a restorable revocation;
    - `E:revoke:refund:<refundId>`: a terminal revocation (never restored);
    - legacy `E:revoke` (rows queued before this change): terminal;
    - `E:restore:<disputeId>`.
  - **Revoke** with `entitlementId = E` always targets the chain head: generation 0 if it is unrevoked, else the latest restore grant. If the head is already revoked → outcome `already_revoked` (no-op). Each eventId is idempotent.
  - **Restore** `E:restore:<D>` is valid only when all of these hold:
    - the head is revoked by exactly `E:revoke:dispute:<D>`;
    - that revocation has not been restored;
    - no reservation on the head is open;
    - the root grant has not expired.
  - **Restore refusals:**
    - head unrevoked → 409 `restore_not_revoked`;
    - head revoked by a different event → 409 `restore_mismatch`;
    - head revoked by refund or legacy → `restore_refused_terminal` (OS done, no grant);
    - open hold → 409 `restore_hold_pending` (OS retries);
    - expired → `restore_expired`;
    - nothing unspent → `restore_nothing_forfeited`.
  - **Restore amount** = the revoked head's unspent value: its `credits_micro` minus every debit ever posted to it (the revoke forfeiture plus any remainder stranded on it when open holds settled). It mints **one** new head with the root grant's `expires_at`, `source 'entitlement'`, entitlement id = the restore eventId. A replay → `already_restored`, never mints.
  - **Revocation markers on an already-revoked head (W0.4).** A revoke event that reaches a head which is already revoked is **recorded**, not dropped:
    - a refund (`E:revoke:refund:<R>`) or legacy revoke marks that head **terminal** (outcome `terminalized`). Every later restore of it is `restore_refused_terminal`, even for the dispute that revoked it first;
    - a dispute (`E:revoke:dispute:<D2>`) adds an **unresolved dispute marker** (outcome `dispute_recorded`).
    - Replays of the same eventId stay idempotent.
  - **Overlapping disputes (W0.4).** A restore `E:restore:<D1>` is refused with 409 `restore_review_required` (no grant, fail closed) while the head carries any unresolved dispute marker other than `D1`, or whenever the restorable revocation is otherwise ambiguous. Resolution is an operator review; no amount is ever guessed. A restore for `D2` likewise requires `D1` to be resolved.
  - **Invariant** (tested): for every chain, Σ debits over all generations + Σ remaining over unrevoked generations ≤ the root grant's credits, and at most one generation is unrevoked.
  - **Safety completion (W0.5, frozen by root after independent financial review; it governs wherever W0.3/W0.4 wording differs. HTTP hook field shape is unchanged):**
    - **Edges, not timestamps.** `ezil_ai.funding_events` gains `parent_grant_id uuid null references ezil_ai.grants(id)`.
      - A restore event records `parent_grant_id` = the revoked source grant, `grant_id` = the minted child grant, and `entitlement_id` = always the root `E`.
      - Chain traversal follows parent→child edges only, never timestamps. Later revokes always name the root `E`; the Gateway resolves the head by following the edges.
    - **No double mint.** Partial unique index on `(parent_grant_id)`, and on the minted `grant_id`, where `action = 'restore' and outcome = 'restored'`. Distinct restore events can never mint twice from one parent. An arbitrary new restore id cannot mint.
    - **Tombstones.** Every revoke event records the resolved head `grant_id`, even when that head is already revoked. So a refund or legacy revoke that arrives after a dispute revoke stays a terminal tombstone. This supersedes the "`already_revoked` no-op" reading.
    - **Terminal wins.** Before any restore: if any terminal (refund/legacy) revoke exists anywhere in root `E`'s chain → `restore_refused_terminal`, no funding row, no mint.
    - **One dispute only.** The current head's dispute revocations must be exactly one distinct `D`, matching the restore's `D`. Several distinct `D` → 409 `restore_review_required`: no funding row, no mint, manual review. The second dispute is never ignored.
    - **Lock order.** Root advisory lock → event advisory lock → wallet → head grant. Re-read the head and its open holds after taking the locks.
    - **Rollback** drops only the new column and indexes, and refuses while any restore-chain rows exist.
    - **Required tests:**
      - D1 revoke → refund → D1 won ⇒ no restore;
      - overlapping D1/D2 ⇒ no restore (409 review);
      - D1 restore → D2 revoke → D2 restore preserves fractional micro amounts, the root expiry and conservation;
      - an arbitrary new restore id cannot mint.
  - **W0.4 tests:**
    - dispute `D` revokes → refund `R` on the revoked head → `terminalized` → restore `D` → `restore_refused_terminal`, no grant;
    - `D1` revokes → `D2` recorded → restore `D1` → 409 `restore_review_required`;
    - an identical replay of each event changes nothing.
  - Revoke and restore on the same chain serialize: lock on the root entitlement id.
  - The hook body is unchanged; `credits` must equal the root grant's whole credits, else 409 `event_conflict`.
  - **Gateway work (G5):** `src/entitlements.ts` accepts `restore`, `32_entitlement_restore.sql` implements the above, and new tests. The previous `entitlement_event` md5 is recorded; the rollback refuses if any chain generation ≥ 1 exists.
  - **OS follow-up (O-credits, after G5 lands):**
    - refund revokes emit `E:revoke:refund:<refundId>`; dispute revokes emit `E:revoke:dispute:<disputeId>`; a won dispute emits `restore` with `E:restore:<disputeId>`, always for the **root** `E` (the Gateway resolves the head);
    - the delivery check accepts exactly these grammars;
    - `ai_restore` is claimed only after the matching dispute revoke is delivered; `terminalized`, `restore_refused_terminal` and `restore_review_required` (409, no retry beyond the existing bound; review log) are final for that row;
    - refund receipts never produce a restore.
- **Stripe inbox:** the same Stripe event id with a different payload sha256 → reject (HTTP 409 `event_conflict`, no processing, review log). An identical replay stays idempotent.

## 6. Canonical AI balance (parity) and service balance read
- The service balance read below is **frozen as an interface but not implemented or activated in v1**. W0 ships it as a 501 seam. It goes live only after an explicit review of the Universe ID-token → OS → Gateway delegation (v1.1). The audience checks are never weakened, and an operator/admin credential is never used for a customer.
- Gateway: `POST /v1/integrations/balance`.
  - Same HMAC scheme as entitlements (`X-EZiL-Timestamp`, `X-EZiL-Signature: v1=…`, `ENTITLEMENT_HMAC_SECRET`, skew check).
  - Body exactly `{accountPublicId}` → 200 `{account_public_id, state, available_micro, held_micro}`, where `state` is the `/v1/me/balance` vocabulary (`ok|exhausted|paused_reconciliation|paused_operations`); 404 `account_not_found`. Read-only.
- **OS views keep exact fractions (W0.3, aligned with the O-API phase-1 implementation).**
  - `ai.balanceMicro` is the exact decimal string; `ai.balance` is credits exact to 6 decimals and is **never floored** in OS views.
  - `exhausted` iff `available_micro == 0`; `warning` iff `available_micro ≤ 10% of the plan grant × 1e6`; else `ok`; unreadable → `unknown` with null balance.
  - Pauses (`paused_*` or the models killswitch) are reported as a separate spending state and are never shown as healthy.
  - The legacy `ai.state`/`ai.balance` fields stay compatible as the O-API patch defines them.
  - A whole-credit floor applies only at the Universe REST boundary (v1.1), because that client validates integers.
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
