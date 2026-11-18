/**
 * The trusted native wrapper over the shared delegation core (`verifyDelegation`, docs/DELEGATION-CORE.md).
 * Adds no cryptography. Its own source-constant policy (`NATIVE_SCOPE_BY_PROCEDURE`, one exact scope per
 * fixed procedure) is separate from the computer receiver's; the binding is the route's fixed procedure and
 * the complete `EZIL-NATIVE-REST/1` transcript, never reserialised.
 *
 * The configured MCP client ids are intersected with the native client allowlist BEFORE the core runs, so a
 * client native refuses is rejected by the pure client check and never consumes a `jti` or reaches the account
 * lookup. The caller returned is the core's own verified identity; nothing is taken from raw HTTP.
 */

import { delegationConfig, verifyDelegation, type DelegatedAccount, type DelegatedIdentity, type DelegationConfig } from '@/server/api/delegation-core';
import { consumeDelegationJti, findDelegatedAccount, type SqlExecutor } from '@/server/api/delegation-store';
import { AUTH0_ISSUER } from '@/server/auth/issuer';

import { NATIVE_SCOPE_BY_PROCEDURE, type NativeDelegationVerifier } from './delegation';

export interface NativeDelegationVerifierDeps {
    /** The pinned shared configuration, or undefined when any part is missing (the core then rejects). */
    config: () => Promise<DelegationConfig | undefined>;
    /** Epoch seconds. */
    now: () => number;
    consumeJti: (jti: string, expiresAt: number) => Promise<boolean>;
    findAccount: (identity: DelegatedIdentity) => Promise<DelegatedAccount | null>;
}

const POLICY = { scopeByProcedure: NATIVE_SCOPE_BY_PROCEDURE as ReadonlyMap<string, string> };

export function nativeDelegationVerifier(deps: NativeDelegationVerifierDeps): NativeDelegationVerifier {
    return {
        async verify({ headers, procedure, serializedInput, allowedClientIds }) {
            const shared = await deps.config();
            const config = shared && { ...shared, clientIds: new Set([...shared.clientIds].filter(id => allowedClientIds.has(id))) };
            const outcome = await verifyDelegation(headers, {
                // The native route gate already ran; an empty intersection leaves no client the core can accept.
                enabled: true, config, binding: { procedure, serializedInput }, policy: POLICY, now: deps.now,
                consumeJti: deps.consumeJti, findAccount: deps.findAccount,
            });
            if (outcome.kind !== 'accepted') {
                const reason = outcome.kind === 'none' ? 'missing' : outcome.reason;
                return { ok: false, status: reason === 'client' || reason === 'scope' ? 403 : 401, code: reason };
            }
            const { caller } = outcome;
            if (caller.procedure !== procedure) return { ok: false, status: 401, code: 'binding' };
            return { ok: true, caller: { userId: caller.userId, idpIssuer: caller.idpIssuer, subject: caller.subject, clientId: caller.clientId, scope: [caller.scope] } };
        },
    };
}

/** Production wiring: the shared pins from the environment, the shared replay ledger (0030) and account lookup. */
export function productionNativeDelegationVerifier(db: SqlExecutor, env: Readonly<Record<string, string | undefined>> = process.env): NativeDelegationVerifier {
    return nativeDelegationVerifier({
        config: () => delegationConfig({
            EZIL_DELEGATION_ISSUER: env.EZIL_DELEGATION_ISSUER, EZIL_DELEGATION_AUDIENCE: env.EZIL_DELEGATION_AUDIENCE,
            EZIL_DELEGATION_PUBLIC_JWKS: env.EZIL_DELEGATION_PUBLIC_JWKS, EZIL_DELEGATION_CLIENT_IDS: env.EZIL_DELEGATION_CLIENT_IDS,
            NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
        }, AUTH0_ISSUER),
        now: () => Math.floor(Date.now() / 1000),
        consumeJti: (jti, expiresAt) => consumeDelegationJti(db, jti, expiresAt),
        findAccount: identity => findDelegatedAccount(db, identity),
    });
}
