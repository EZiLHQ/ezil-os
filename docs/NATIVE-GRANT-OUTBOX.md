# Native grant outbox (source only, default OFF)

Status: source and tests only. Nothing here is deployed, configured, keyed or applied.

- Migration `app/drizzle/0033_native_grant_outbox.sql` is a reserved production snapshot. It is not in the staging
  runner and not in the Drizzle journal.
- No signing key, wrapping key, service credential or policy is provisioned.
- No production caller is wired. The auth owner composes the APIs below, and the host owner delivers.

## 1. What it does

After one explicit normal-cookie consent, EZiL OS renews short Gateway grants for the native runtime (profile
`ezil-native-claude-v1`), and does so without a browser JWT or a new click per renewal. The consent fixes a finite
budget and a deadline. For each renewal operation, the OS:

1. generates a random `ezg_` candidate and stores it only encrypted, with its hash sealed into an immutable tuple;
2. signs an `ezil.native-authorization.v1` assertion binding that hash;
3. POSTs it once to the fixed staging Gateway.

The Gateway returns grant metadata only: there is no access token on the wire. The candidate is opened only for the
private host transport.

Code: `app/src/server/native-session/native-authorization-{protocol,candidate,config,exchange,outbox}.ts`.

## 2. Wire (Gateway source `c1b4448f`, helper sha256 `fdf42236…93ed`)

- **Assertion.**
  - `token = base64url(payload) "." base64url(Ed25519 signature)`.
  - The payload is canonical JSON of the claim: keys sorted by UTF-16 code unit, no whitespace.
  - The signed bytes are UTF-8 of `ezil.native-authorization.v1:signature.` followed by the payload segment.
  - The envelope (`format`, `alg`, `keyId`, `issuer`, `audience`, `issuedAt`, `expiresAt`) lives 30 s and never more
    than 60 s, and may be refreshed on each attempt.
  - The semantic tuple is immutable per `operationId`. It holds the 13 consent fields, `operation`, `operationId`,
    `environment` (`staging`), and, for a renewal, `leaseExpiresAt` and `tokenSha256`.
- **Renew.** `POST https://ai-staging.ezil.work/v1/token/exchange`, with `Authorization: Bearer ezs_…` (the
  `ezil-os-native` service credential).
  - Body: `{policyId, proofKind:"ezil_native_authorization", subjectToken}`.
  - Answer: `201` new or `200` equal replay, with exactly `object`, `grant_id`, `expires_at`, `authorization_id`,
    `epoch`, `authorization_deadline`, `budget_micro`, `replayed`.
- **Revoke.** `POST https://ai-staging.ezil.work/v1/token/native-authorization/revoke`.
  - Body: `{policyId, subjectToken}`.
  - Answer: `200` with exactly `object`, `authorization_id`, `revoked_at`, `already_revoked`.
- **Sending.**
  - One send per call: no redirects, retries or fallbacks; an 8 s timeout and capped bodies.
  - A clean `4xx` is a definite refusal.
  - Anything else after the send, or any answer whose bindings, shape, status or expiry bounds do not match, is
    `delivery_unknown`.
- **Grant expiry.** It must be no later than the lease, the deadline and the service credential. A new grant must
  also expire after the answer was received and within five minutes of it. An equal replay may carry the original,
  already expired metadata; delivery then refuses it.

## 3. Inputs and trust

- **Configuration.** All pins absent means off; any partial or invalid set means misconfigured. Either way nothing is
  claimed, written, signed or sent. The pins are:
  - `EZIL_NATIVE_AUTHORIZATION=enabled`;
  - `EZIL_NATIVE_AUTHORIZATION_ISSUER`, `_AUDIENCE`, `_SIGNING_KEY_ID`, `_POLICY_ID`;
  - `EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY`: an Ed25519 private JWK with exactly `kty`, `crv`, `x`, `d`, imported
    non-extractable after a pair self-test;
  - `EZIL_NATIVE_AUTHORIZATION_SERVICE_CREDENTIAL` and `_SERVICE_EXPIRES_AT`, for the `ezil-os-native` service. These
    are not the Supabase broker's `EZIL_NATIVE_GATEWAY_*` pins.
  - `EZIL_NATIVE_GRANT_WRAPPING_KEY_ID` and `EZIL_NATIVE_GRANT_WRAPPING_KEY`: 32 bytes, base64url, AES-256-GCM,
    non-extractable.
- **Consent.** It comes only from the injected trusted reader:
  - `ReadApprovedNativeConsentBinding(db, {ownerUserId, operationId})`, owned by the auth owner. `operationId` is the
    consent's original 0031 CREATE operation and stays the same for every rotation.
  - The reader returns the exact 13-field `NativeConsentBinding`: `authorizationId`, `epoch`, `ownerUserId`,
    `sessionId`, `computerId`, `placement {generation, leaseEpoch, instanceId, fenceToken}`, `clientId`, `profileId`,
    `policyId`, `serviceId`, `budgetMicro` (micro-credits), `initialApprovalAt`, `authorizationDeadline` (24 h or less
    after approval).
  - `nativeConsentBinding` re-validates every result. Anything else, including old approved rows without complete v1
    terms or extra fields such as task digests, is refused and never completed.
  - Task instruction and input digests stay in 0031 and the broker claim; they are never proof fields.
- **Lease.** Each renewal's `leaseExpiresAt` is a separate, per-operation input from the coordinator. It must be at
  least 30 s ahead, no more than 4 min 50 s ahead, and before the deadline.
- **Fixed terms.** The authorization's binding is recorded on first use and is immutable: owner, session, computer,
  full placement, client, profile, policy, budget, approval and deadline. Different terms under the same
  `authorizationId` are refused; rebinding needs a new consent and authorization. The lease may roll per operation;
  the budget and deadline never slide.

## 4. Secrets

- **The candidate.**
  - It is 32 CSPRNG bytes in `ezg_` form, stored only as AES-256-GCM ciphertext with a random 12-byte nonce.
  - The additional data binds version, key id, owner, operation, authorization, semantic digest and token hash.
  - An unknown version or key id, or any changed field, fails closed; there is no fallback key.
  - Only its SHA-256 (`tokenSha256`, over the full UTF-8 token) enters the tuple and the Gateway.
- **The bearer.** `NativeGrantBearer` keeps the token in a private field, reachable only through
  `authorizationHeader()`. JSON, superjson, string conversion and inspection show metadata only.
- **The configuration.** The configuration object keeps the service credential private and serialises without
  secrets.
- **No secret anywhere else.** No log, Notion record, DTO, row or response holds a plaintext candidate, key or
  credential. Status DTOs carry no candidate, ciphertext, hash, tuple or assertion.

## 5. API (`native-authorization-outbox.ts`)

`deps = {config, readConsent, now}`. The dispatch calls also take `fetchImpl` and an optional `timeoutMs`. `db` is
`NativeAuthorityDb`.

| Function | Effect |
|---|---|
| `prepareNativeRenewal(db, deps, {ownerUserId, consentOperationId, operationId, leaseExpiresAt})` | One transaction, no network. Returns `prepared`, `existing` (identical request: same candidate and hash), `conflict` (changed request), or `refused` with a reason. Time terms are checked on a clock read after the lock waits and again immediately before the insert; a late refusal rolls back. |
| `dispatchNativeOperationOnce(db, deps, {ownerUserId, operationId})` | Only from `prepared`. Rechecks live consent, revocation, the in-flight rule, deadline, lease and service. Signs a fresh envelope, discarding it unsent if it is stale. Commits `dispatching` with a new attempt id before the one POST, then settles by compare-and-set on that attempt. |
| `reconcileNativeOperation(db, deps, key)` | The only exit from `delivery_unknown`, or from a `dispatching` row older than 13 s. Sends the SAME stored tuple and hash under a fresh envelope, with the same live checks (revoke needs no live consent). At most 3 attempts per operation. Never creates an operation or candidate, and never moves a term. |
| `prepareNativeRevoke(db, deps, {ownerUserId, consentOperationId, operationId, authorizationId})` | Marks the authorization terminal (`revoke_operation_id`, set once) together with the signed revoke operation. Uses the saved binding, and calls the reader only for an authorization never bound here. |
| `openNativeGrantCandidate(db, deps, {ownerUserId, operationId})` | For the private host transport only. Requires a granted, unrevoked renewal whose consent is still the approved binding and whose grant has 10 s or more left (rechecked after decryption), under the pinned wrapping key. Returns `bearer`, the stored 64-hex `tokenSha256` and the exact 8-field `sourceAuthorization` (`authorizationId`, `epoch`, `authorizationDeadline`, `clientId`, `profileId`, `policyId`, `budgetMicro`, `initialApprovalAt`), all from the same stored tuple. It records nothing. |
| `readNativeAuthorizationOperation(db, key)` | Safe status DTO. |

**Durable states:**
- `prepared → dispatching → granted | revoked | refused | delivery_unknown`;
- `delivery_unknown → dispatching` (reconcile);
- `dispatching → dispatching` (reconcile of an abandoned attempt).

A SQL guard enforces the transitions, the attempt rule and immutability. Rows are never deleted or truncated.

## 6. Unknown outcomes and the one-in-flight rule

- **Unknown stays on its operation.** A crash after the dispatch commit leaves `dispatching`, which is never sent
  again except by explicit reconciliation after the exchange timeout. A late answer from a superseded attempt is not
  recorded.
- **One renewal in flight per authorization.** While any renewal of it is `dispatching` or `delivery_unknown`, no
  other renewal is prepared or dispatched (`unresolved_renewal`). Only the same operation's reconciliation resolves
  it.
- **Exhausted attempts.** A renewal still unknown after 3 attempts keeps the authorization blocked; continuing needs
  a new consent.
- **No automatic retry.** Nothing here retries on its own.

## 7. Local STOP and Gateway revoke

- **Local STOP.** The auth owner's STOP runs in its own transaction under the computer lock. It calls
  `prepareNativeRevoke` there and commits before any Gateway send. From that commit on, no renewal of the
  authorization is prepared, dispatched, reconciled or opened, whatever the revoke's outcome; an unknown revoke never
  resumes grants.
- **Gateway revoke.** `dispatchNativeOperationOnce` and `reconcileNativeOperation` then send the signed revoke. For
  an authorization the Gateway never saw, it records a revoked tombstone.
- **Binding capture.** Revoke after a tombstone works from the saved binding. Capturing the binding of a never-issued
  authorization belongs to the auth owner.

## 8. Lock order

Every path takes, in order:

1. this module's operation advisory lock (namespace `0x455a6e67`, READ COMMITTED asserted);
2. the reader's canonical computer lock;
3. the authorization row (`FOR UPDATE` for renewal dispatch and prepare, `FOR SHARE` for open and revoke dispatch).

The clock is read after these waits.

## 9. Limits (not in this source)

- **Not wired:**
  - the production reader, runner, timer and STOP (auth owner);
  - the private host route, delivery and Supervisor renewal (host owner).
- **Not provisioned or applied:** keys, credentials and policies; 0033.
- **Not claimed:** no deployed, 24-hour or AWS acceptance.
- **Evidence:**
  - real PostgreSQL 17 tests of this module (disposable schema);
  - unit tests with an independent node:crypto verifier;
  - a private, untracked cross-check against the pinned Gateway helper.
