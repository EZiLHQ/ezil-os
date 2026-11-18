# Shared delegation core (source contract)

`app/src/server/api/delegation-core.ts` is the one verifier for `Authorization: EZiL-Delegation <jws>`. It
imports no database, environment, cookie client or network; wrappers inject all I/O. Nothing here is enabled:
each wrapper keeps its own gate, and the replay ledger (`0030`) is an unapplied snapshot.

## API

```ts
verifyDelegation(headers: Headers, deps: DelegationCoreDeps): Promise<DelegationCoreOutcome>

interface DelegationCoreBinding { procedure: string; serializedInput: string }        // from the wrapper's validated request
interface DelegationPolicy { scopeByProcedure: ReadonlyMap<string, string> }        // wrapper SOURCE constant
interface DelegationCoreDeps {
  enabled: boolean; config: DelegationConfig | undefined; binding: DelegationCoreBinding | undefined;
  policy: DelegationPolicy; now: () => number;                                       // epoch seconds
  consumeJti: (jti: string, expiresAt: number) => Promise<boolean>;                  // delegation-store consumeDelegationJti
  findAccount: (identity: DelegatedIdentity) => Promise<DelegatedAccount | null>;    // delegation-store findDelegatedAccount
}
type DelegationCoreOutcome =
  | { kind: 'none' }                                                                  // no delegation header
  | { kind: 'rejected'; reason: DelegationRejection }                                 // never fall back to a cookie
  | { kind: 'accepted'; caller: VerifiedDelegatedCaller; account: DelegatedAccount };
interface VerifiedDelegatedCaller {
  userId: string; idpIssuer: string; subject: string; clientId: string; scope: string; procedure: string; jti: string;
}
```

Also exported, unchanged from the computer receiver: `delegationConfig`/`parseDelegationConfig` (pinned
configuration), `inputDigest`, `isDelegationHeader`, `bareHttpsOrigin`, `identityIssuerOf`, the
`DELEGATION_*` constants and the `DelegationConfig`, `DelegationEnv`, `DelegatedIdentity`, `DelegatedAccount`
and `DelegationRejection` types. `delegation-auth.ts` re-exports them for existing callers.

## Order and rules

1. Header absent → `none`. Gate off → `disabled`; no configuration → `not_configured`; no binding → `binding`.
2. Pure checks, no I/O: canonical encoding, exact JOSE header and pinned `kid`, raw 64-byte ES256 signature,
   exact claim set, issuer, audience, identity issuer and subject shape, client allow-list.
3. Policy: `scope` must equal exactly `policy.scopeByProcedure.get(proc)`; a procedure outside the wrapper's
   policy is refused. Then `proc === binding.procedure` and `inp === base64url(sha256(binding.serializedInput))`.
4. Lifetime (≤ 60 s, `iat` ≤ now + 10 s, unexpired).
5. One-time `jti` in the shared ledger, so an assertion is accepted once across ALL policies.
6. Account lookup; the caller is built only from the verified claims and that existing account.

## Wrapper obligations

- The policy is a source constant of the wrapper; never derived from the request or the token.
- `serializedInput` is built by the wrapper from the actual accepted request and never reserialised.
  - Computer reads (`delegation-auth.ts`): the exact decoded `input` query string, or `''`. Unchanged.
  - Native REST (auth-intent lane, not implemented here):
    `EZIL-NATIVE-REST/1` LF `METHOD` LF canonical pathname LF (POST: exact raw JSON body; GET: empty), so GET
    operation and session selectors are bound too. MCP and OS must build the same canonical pathname.
- A wrapper never retries another policy after a rejection and never falls back to a cookie.
