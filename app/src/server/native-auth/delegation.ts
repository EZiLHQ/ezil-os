/**
 * The seam to the shared EZiL-Delegation receiver core. This module adds NO cryptography and never trusts a
 * claim it did not receive from that verifier.
 *
 * The receiver lane owns the pure verification core (`@/server/api/delegation-core`): `Authorization:
 * EZiL-Delegation` ES256 with unchanged claims, a fixed procedure, `inp` = base64url(SHA-256(serializedInput)), a
 * fresh JTI, the scope and the existing-account mapping. It answers the ORIGINAL verified identity
 * `{userId, idpIssuer, subject, clientId, scope}`. The trusted native wrapper is `delegation-verifier.ts`; a
 * `null` verifier makes every native REST route answer `503 native_auth_blocked` before any ledger read.
 */

import { NATIVE_SCOPE_READ, NATIVE_SCOPE_WRITE, type NativeProcedure } from './contract';

/** The trusted source policy: one scope per fixed procedure. Both scopes are explicitly consented at the IdP. */
export const NATIVE_SCOPE_BY_PROCEDURE: ReadonlyMap<NativeProcedure, string> = new Map<NativeProcedure, string>([
    ['nativeAuthorization.prepare', NATIVE_SCOPE_WRITE],
    ['nativeAuthorization.get', NATIVE_SCOPE_READ],
    ['nativeSession.get', NATIVE_SCOPE_READ],
]);

export interface NativeVerifiedCaller {
    /** The existing EZiL account the receiver mapped the delegation to. */
    readonly userId: string;
    readonly idpIssuer: string;
    readonly subject: string;
    readonly clientId: string;
    /** The core's ONE verified scope string, as an array (the adapter returns `[scope]`). */
    readonly scope: readonly string[];
}

export type NativeDelegationOutcome =
    | { ok: true; caller: NativeVerifiedCaller }
    | { ok: false; status: 401 | 403; code: string };

/**
 * The trusted native wrapper over `verifyDelegation(headers, deps)` from `@/server/api/delegation-core` (the
 * receiver lane's module, not in this tree yet). The wrapper must:
 * - bind `{procedure, serializedInput}` exactly as given;
 * - use `NATIVE_SCOPE_BY_PROCEDURE` as the core's `scopeByProcedure` policy;
 * - intersect the core's configured client ids with `allowedClientIds` BEFORE verification, so a refused
 *   native client never consumes a JTI or reaches the account lookup;
 * - return the core's original `{userId, idpIssuer, subject, clientId, scope}`, never a manufactured caller.
 */
export interface NativeDelegationVerifier {
    verify(input: {
        headers: Headers;
        procedure: NativeProcedure;
        /** The full `EZIL-NATIVE-REST/1` transcript. */
        serializedInput: string;
        allowedClientIds: ReadonlySet<string>;
    }): Promise<NativeDelegationOutcome>;
}
