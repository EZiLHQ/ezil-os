# Native authorization intents (source only, gates off)

Source: `app/src/server/native-auth/`, `app/src/app/api/mcp/native-auth-intents/`, `app/src/app/api/mcp/native-sessions/`,
`app/src/app/native/authorize/` and `app/src/app/api/native/authorize/`. Nothing here is deployed, applied to a database or
enabled. Builds on the native session broker (`docs/NATIVE-SESSION-BROKER.md`) and the shared delegation core
(`docs/DELEGATION-CORE.md`).

Flow: an MCP client prepares an intent → the owner opens the authorization URL → normal sign-in → the owner sees the exact
task and the finite terms and allows or denies → on allow, one transaction approves (binding the terms and the full placement
tuple) and seals the private task artifact → the trusted broker runner claims, exchanges once and delivers once under the
existing broker rules → status reports that exact operation.

## Gates and readiness

- `EZIL_NATIVE_AUTH_INTENTS=1` and `EZIL_NATIVE_SESSIONS=1`, otherwise every route is `404` before touching anything.
- `EZIL_NATIVE_SESSIONS_ORIGIN` (authorization URL and consent Origin check) and `EZIL_NATIVE_AUTH_CLIENT_IDS` (comma-separated
  exact MCP client ids). Verification is the shared core through the native wrapper
  `app/src/server/native-auth/delegation-verifier.ts`: the shared `EZIL_DELEGATION_*` pins, the shared replay ledger (0030)
  and account lookup, the native policy (one exact scope per fixed procedure), and the configured client ids intersected with
  the native allowlist before verification, so a refused client never consumes a JTI or reaches the account lookup.
- Finite consent terms: `EZIL_NATIVE_AUTHORIZATION_POLICY_ID`, `EZIL_NATIVE_CONSENT_EPOCH`, `EZIL_NATIVE_CONSENT_BUDGET_MICRO`
  (positive canonical decimals; microcredits, 10^6 per credit) and `EZIL_NATIVE_CONSENT_TTL_SECONDS` (1..86400).
- Delivery needs the broker's sealed exchange configuration and a private host transport that is `available` and
  `supportsKind(kind)`. Production's transport supports no kind, so an approval is blocked with zero proof, claim, exchange
  or delivery. Receipts report `capabilities.create` from that readiness and `renew: false` (no non-browser proof exists).

## MCP REST (signed `EZiL-Delegation`)

| Route | Procedure | Scope |
| --- | --- | --- |
| `POST /api/mcp/native-auth-intents` | `nativeAuthorization.prepare` | `ezil:native-sessions:write` |
| `GET /api/mcp/native-auth-intents/{operationId}` | `nativeAuthorization.get` | `ezil:native-sessions:read` |
| `GET /api/mcp/native-sessions/{sessionId}` | `nativeSession.get` | `ezil:native-sessions:read` |

Signed input: base64url(SHA-256(UTF-8 of `EZIL-NATIVE-REST/1` LF METHOD LF canonical pathname LF body)), where the body is
the exact raw POST JSON or empty for GET, so a GET is bound to its path. Query, fragment, percent-encoding, uppercase ids and
trailing slashes never match a route.

Prepare body, exactly: `{kind:"create", operationId, sessionId, computerId, instructionRevision:1, instructionDigest, instruction}`
or `{kind:"renew", operationId, sessionId}`. The instruction is kept as its exact UTF-8 bytes (no trimming or Unicode
normalisation), must be well-formed, non-blank and free of U+0000, and is at most 16384 bytes; the raw body is at most 65536
bytes. `instructionDigest` is `sha256:` + 64 lowercase hex over those bytes, recomputed by the server and passed unchanged to
the broker, artifact and host (the broker's own form; no translation).

Receipt (every valid receipt `200`):
`{operationId, kind, sessionId, computerId, authorization: {state, expiresAt, authorizationUrl, reason}, operation, capabilities}`.
`operation` is the base operation view (`operationId, kind, sessionId, computerId, state, reason, settled, grantId,
grantExpiresAt`, no `replayed`) of the operation stored under the same key, or null. `reason` is one of 23 fixed codes or
`authorization_unavailable`; a stopped consent reads `blocked/authorization_unavailable` with the exact operation unchanged.
The only definite refusal is `409 operation_conflict`; `404 not_found` once the computer is no longer the caller's. Session
status: `{statusKind: 'broker_status', session: {sessionId, computerId, instructionRevision: 1, created, latest}}`.

A renewal is never browser-approved: prepare derives its session's consent unchanged (same authorization, deadline, budget and
approved tuple, no new approval time) or blocks it (`session_not_active`), then blocks it before any claim because no
non-browser proof wire exists.

## Consent

`/native/authorize/{operationId}` is a normal-cookie page; `safeReturnUrl` accepts exactly that path for a lowercase UUID,
so a signed-out owner returns to it after the ordinary sign-in. The intent is read under (signed-in user, operation id), so
another account sees "not found" and an account switch never rebinds. The page shows the exact task and the actual terms to
the owner only.

`POST /api/native/authorize/{operationId}`: no bearer, the exact configured Origin, `Sec-Fetch-Site: same-origin` when sent,
and a small form: `decision` (allow|deny) with the shown `inputDigest` and `termsDigest`, or `decision=revoke` with the shown
`inputDigest` and `authorizationId`. Changed terms are a stale page (`409 terms_changed`), never an approval of unseen terms.
An approved create with no operation may be started again by its owner under the same id, body and stored binding; any
existing operation answers with zero effects.

STOP (`revoke`) ends the whole AI consent: one READ COMMITTED transaction under the broker's canonical computer lock writes a
permanent local tombstone capturing the immutable binding and a stable gateway-revoke operation id. It needs no running
computer, lease or configuration. After it no binding is readable and no renewal derives; existing operations are never
cancelled, rewritten or restarted. The Gateway-side revocation (native48 outbox) is not wired in this lane.

## Trusted consent reader

`readApprovedNativeConsentBindingTx(tx, {ownerUserId, operationId})` (and the wrapper opening its own transaction) answers the
exact binding — `authorizationId, epoch, budgetMicro, ownerUserId, sessionId, computerId, placement, clientId, serviceId,
profileId, policyId, initialApprovalAt, authorizationDeadline` — only while the owner, the approved tuple (generation and lease
epoch >= 1), the deadline and the absence of a STOP all hold now, and any same-key operation matches. `operationId` is the
original create consent id. The operation's state is not consulted, so an unknown operation keeps its consent readable for
explicit reconciliation. `readNativeConsentHistory` returns `{binding, purpose: 'history'}`: identity only, never permission.

The runner mints only with this reader's output: a delivery carries `sourceAuthorization` from it and `grant.tokenSha256`
(raw 64 lowercase hex of the full `ezg_` token), and the consent is re-read after the exchange, before any host dispatch
(`authority_changed` with `authorization_revoked` or `authorization_unavailable`). The legacy cookie create/renew routes have
no consent record, so a new key there is blocked before any proof or claim (`consent_terms_unavailable`); replays still answer.

## States (migration 0031)

`required` → `approved` | `denied` | `expired` | `blocked`, plus `approved` → `blocked` only for a definite pre-claim refusal
while no native session operation exists under the key. The challenge is fixed at five minutes; a consent lasts at most 24
hours from its millisecond-exact first approval. Identity, timestamps, terms and the first decision time are immutable; rows
are never deleted and an approved row without terms is never upgraded. An approval without an operation reads as
`dispatch_pending` for 60 seconds and `dispatch_unknown` after.

`app/drizzle/0031_native_auth_intents.sql` is reserved source: a production snapshot entry only, absent from the staging
runner and the Drizzle journal, never applied. It requires 0029. 0030 is the receiver lane's.


## 0033 composition (17 November, source only)

The consent runner uses `prepareNativeRenewal`, `dispatchNativeOperationOnce`, and
`openNativeGrantCandidate` from the local outbox source commit
`fe5c79b8f5bb967d36fcc7a8bc3bf828b2550ad5`. It never consumes a browser access
JWT. The reader is `readApprovedNativeConsentBindingTx(tx, {ownerUserId,
operationId: ORIGINAL_CREATE_ID})`; CREATE requires that original id to equal its
session operation id. Existing operation replay and normal status reads precede
configuration/readiness and remain side-effect free. Outbox reasons map into
0029's fixed reason vocabulary; 0029 is unchanged.

Approval is the task producer: `approveNativeIntent` atomically seals the owner's
exact instruction/digest/revision into `ezil_native_task_artifacts` under
`native-task:<ORIGINAL_CREATE_ID>`. `productionNativeConsentDeps` uses the real
`nativeArtifactTaskResolver(db)`; the plain cookie session route has no resolver.

STOP commits `revokeNativeConsent` under the canonical READ COMMITTED computer
lock before loading config or preparing/sending a 0033 revoke. Historical terms
are used only for cleanup. Unknown revoke never revives consent. No host resend
or fake acknowledgement is added. Renew is blocked until actual Core admission
and revision CAS are qualified; unknown CREATE is never promoted here.

### Implementation-ready deployment inputs (no live changes made)

Reserved SQL order: compute placement prerequisites, 0029 native session ledger,
0031 native auth intents, then 0033 grant outbox. 0032 and the private runtime
channel belong to the separate Host lane. These snapshots remain unapplied.
Use the production migration review workflow; neither Drizzle journal nor staging
runner was changed by this composition.

Public gates: `EZIL_NATIVE_SESSIONS=1`, `EZIL_NATIVE_AUTH_INTENTS=1`, exact HTTPS
`EZIL_NATIVE_SESSIONS_ORIGIN`, admitted native client allowlist, and finite
`EZIL_NATIVE_CONSENT_EPOCH`, `EZIL_NATIVE_CONSENT_BUDGET_MICRO`,
`EZIL_NATIVE_CONSENT_TTL_SECONDS` (<=86400). Native assertion pins are enumerated
by `NATIVE_AUTHORIZATION_ENV` in `native-authorization-config.ts`; the policy
UUID comes from `EZIL_NATIVE_AUTHORIZATION_POLICY_ID`. Key/service/wrapping
material is deliberately absent. No legacy `EZIL_NATIVE_GATEWAY_*` pin authorizes
this runner.

Remaining code dependencies, not configuration alone: production host transport
is `UNAVAILABLE_HOST_TRANSPORT`; the Host factory must implement the existing
pure `checkReadiness(target, signal?)` plus private delivery. The existing finite
binding carries policyId, not policyDigest. A runtime requiring policyDigest has
no accepted producer in this source and must stay blocked. Core currentAdmission
and renewal revision-CAS exports are also missing. No key, pin or fabricated
identity/digest can substitute for these boundaries. No AWS/customer acceptance
is claimed.
