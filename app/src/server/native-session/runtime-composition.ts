/** Trusted server composition over the actual 0031 reader exports. No caller-provided policy or authority. */
import type { PlacementExecutor } from '@/server/lib/compute/placement';
import type { NativeAiAuthorityPort, NativeAiConsentBinding } from './runtime-authority';
export interface StoredNativeConsentBinding {
    authorizationId: string; clientId: string; sessionId: string; computerId: string; authorizationDeadline: string;
}
export interface NativeConsentReadPorts {
    history(db: PlacementExecutor, key: { ownerUserId: string; operationId: string }): Promise<{ purpose: 'history'; binding: StoredNativeConsentBinding } | null>;
    active(db: PlacementExecutor, key: { ownerUserId: string; operationId: string }): Promise<Readonly<StoredNativeConsentBinding> | null>;
    revocation(db: PlacementExecutor, ownerUserId: string, authorizationId: string): Promise<{ revokedAt: string | Date } | null>;
}
/** Pass actual readNativeConsentHistory/readApprovedNativeConsentBinding/readNativeConsentRevocation exports. */
export function createNativeRuntimeAiPort(db: PlacementExecutor, ports: NativeConsentReadPorts,
    installedPolicyDigest: string | null): NativeAiAuthorityPort {
    if (installedPolicyDigest !== null && !/^[0-9a-f]{64}$/.test(installedPolicyDigest)) throw new TypeError('invalid installed runtime policy');
    const project = (b: Readonly<StoredNativeConsentBinding> | null): NativeAiConsentBinding | null => b ? {
        authorizationId: b.authorizationId, originalOAuthClientId: b.clientId, sessionId: b.sessionId, computerId: b.computerId,
        expiresAt: b.authorizationDeadline, policyDigest: installedPolicyDigest,
    } : null;
    return {
        history: async (ownerUserId, operationId) => project((await ports.history(db, { ownerUserId, operationId }))?.binding ?? null),
        active: async (ownerUserId, operationId) => project(await ports.active(db, { ownerUserId, operationId })),
        revocation: async (ownerUserId, authorizationId) => { const r = await ports.revocation(db, ownerUserId, authorizationId);
            return r ? { revokedAt: r.revokedAt instanceof Date ? r.revokedAt.toISOString() : r.revokedAt } : null; },
    };
}
