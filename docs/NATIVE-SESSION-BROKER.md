# Native session broker (source only, gate off)

Source: `app/src/server/native-session/` and `app/src/app/api/shell/native-sessions/`. Nothing here is
deployed, applied to a database or enabled. The production wiring is truthfully blocked: no owned task
resolver exists and the private host transport is `UNAVAILABLE_HOST_TRANSPORT`. The typed runner (`runNativeOperation`) mints a
new key only with consent metadata from the trusted consent reader (`docs/NATIVE-AUTH-INTENTS.md`); the cookie create/renew routes
below have none, so a new key there answers `503 native_session_blocked/consent_terms_unavailable` before any proof or claim, while
stored keys still replay.

## Routes

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/shell/native-sessions` | exactly `{operationId, sessionId, computerId, instructionRevision: 1, instructionDigest, taskRef}` | operation view |
| `GET /api/shell/native-sessions/{sessionId}` | none | `{session: {sessionId, computerId, instructionRevision, created, latest}}` |
| `POST /api/shell/native-sessions/{sessionId}/renew` | exactly `{operationId}` | operation view |

Operation view: `operationId, kind, sessionId, computerId, state, reason, settled, grantId, grantExpiresAt, replayed`.
`201` delivered, `202` in flight or unknown, `409` definite non-delivery. Never a proof, service credential,
grant or relay capability, in a response, the database or a log.

## Configuration (all required; any gap is `503 native_session_blocked` with zero exchange)

- `EZIL_NATIVE_SESSIONS=1` (otherwise every route is `404` before touching anything)
- `EZIL_NATIVE_SESSIONS_ORIGIN`: the exact canonical https origin. `Origin` must equal it; Host and
  X-Forwarded-* are never read. `Sec-Fetch-Site`, when sent, must be `same-origin`.
- `EZIL_NATIVE_GATEWAY_POLICY_ID` (UUID), `EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL` (`ezs_` + exactly 43
  base64url characters), `EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT` (RFC 3339, future)
- An owned task artifact resolver (create) and an available private host transport: neither exists yet.

## Write pipeline

1. Any `Authorization` header: `401`. Cookie identity only (`getUser`).
2. Same operation key, before any capability check: different canonical input is `409 operation_conflict`
   forever, whoever owns the computer now. Identical input returns the original read-only receipt only while its
   computer is still a live computer of the caller (one SELECT), even if resolver, transport or configuration
   have since disappeared; after deletion or reassignment it is `404 not_found` with no receipt fields. The
   private tombstone is never changed. No proof helper, exchange, host dispatch or write on any replay.
3. New key only: sealed config, owned task resolver (create) and available transport, else blocked. Then
   `currentAccessToken(userId, headers, same client)` as the proof.
4. `authority.ts` claim (one transaction): operation lock → session lock → canonical computer lock,
   READ COMMITTED, live owner row `FOR SHARE`, `readPlacement`; RUNNING AWS placement, instance, fence,
   unexpired lease. Renewals need a delivered create and no in-flight or unknown earlier renewal. c9 issues a
   fixed five-minute grant stamped at issuance and takes no TTL or issued-at field, so the claim is refused
   (`lease_boundary`, no tombstone) unless the lease outlasts the latest possible grant:
   min(now + exchange timeout + 5 min, proof expiry, service expiry).
5. `claimed → exchanging`, then one exchange (`broker.ts`, Gateway c9):
   `POST https://ai-staging.ezil.work/v1/token/exchange`, `Authorization: Bearer ezs_…`, body
   `{policyId, proofKind: 'supabase', subjectToken}`; `201 {token_type, access_token: 'ezg_…', grant_id, expires_at}`.
   `expires_at` is RFC 3339 as PostgreSQL renders it (`2026-11-16T17:30:00+00:00`); `Z` and other numeric
   offsets are accepted, impossible calendar values are not. No redirect, cache or retry; capped bodies; one
   timeout, and an answer received after it is unknown. Immediately before sending, admission is re-run on
   the send-time clock (queueing for the claim or CAS may have used the lease budget): if the admitted lease can
   no longer hold the latest possible grant, or the proof or service credential has expired, nothing is sent
   and the operation becomes a definite `exchange_refused` with that fixed reason. Expiry must be after receipt, at most five minutes
   after receipt, and no later than the proof, the service credential and the admitted lease. A clean 4xx is `exchange_refused`; anything else uncertain is `exchange_unknown`, which
   quarantines the operation and blocks new renewals.
6. Recheck authority after the exchange; a changed tuple or a grant outliving the live lease is
   `authority_changed`. Then `delivering` and one delivery under a hard deadline that does not rely on the
   adapter honouring abort: at the deadline the operation is `delivery_unknown` for good, and a late
   acknowledgement is dropped. No acknowledgement is ever invented.

No database lock is held across the exchange or delivery. Failures log a fixed category only, never an
error's name, code, message, stack or cause.

## Status (GET)

Standard normal-cookie `getUser()`, then one SELECT of the caller's operations, answered only while the
session's computer is still a live computer of the caller. The standard Supabase server client may refresh
the browser's own login session inside `getUser()`, exactly as on every authenticated route; this feature
adds no refresh of its own and no custom cookie handling. "Pure" means no native proof helper
(`currentAccessToken`), Gateway exchange, host call, operation write, wake or dispatch.

## Host contract (not built here)

The Gateway grant is service and subject scoped. The private host relay must enforce the bound computer,
session, generation, lease epoch, fence, lease and policy on every relayed call, recheck the placement
before executing, and give the CLI only a short local relay capability.

## Migration

`app/drizzle/0029_native_session_operations.sql` is reserved source: a production snapshot entry only,
absent from the staging runner and the Drizzle journal, never applied.
