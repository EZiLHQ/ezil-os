/** Durable Cloudflare -> AWS migration decisions. Effects are executed by the caller. */
export const MIGRATION_STATES = ['requested', 'fenced', 'exported', 'provisioning', 'restored', 'committed', 'failed_reopened', 'failed_needs_operator'] as const;
export type MigrationState = typeof MIGRATION_STATES[number];
export const TERMINAL_MIGRATION_STATES: readonly MigrationState[] = ['committed', 'failed_reopened', 'failed_needs_operator'];
export type SnapshotHead = { generation: string; [key: string]: unknown };
export interface MigrationProgress {
    state: MigrationState;
    generation: string | null;
    sourceEtag: string | null;
    sourceSystemEtag: string | null;
    workspaceHead: SnapshotHead | null;
    systemHead: SnapshotHead | null;
    migratedEtag: string | null;
    attempts: number;
    lastError: string | null;
}
export type MigrationEvent =
    | { type: 'fenced'; etag: string; systemEtag: string | null; generation: string }
    | { type: 'exported'; workspaceHead: SnapshotHead; systemHead: SnapshotHead | null }
    | { type: 'provisioned' }
    | { type: 'host_restored'; generation: string }
    | { type: 'committed'; migratedEtag: string }
    | { type: 'error'; step: string; retryable: boolean }
    /** Only after the abort/reopen effect has succeeded (including an idempotent replay). */
    | { type: 'reopened' };
export type MigrationEffect = 'abort' | 'reopen' | 'retry' | null;
export interface MigrationDecision { accepted: boolean; migration: MigrationProgress; effect: MigrationEffect }
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const RECOVERY_PREFIX = 'recovery:';
export function pendingRecovery(m: MigrationProgress): 'abort' | 'reopen' | null {
    if (m.lastError?.startsWith(`${RECOVERY_PREFIX}abort:`)) return 'abort';
    if (m.lastError?.startsWith(`${RECOVERY_PREFIX}reopen:`)) return 'reopen';
    return null;
}
export function reduceMigration(m: MigrationProgress, event: MigrationEvent): MigrationDecision {
    const unchanged = (): MigrationDecision => ({ accepted: false, migration: m, effect: null });
    const move = (patch: Partial<MigrationProgress>, effect: MigrationEffect = null): MigrationDecision =>
        ({ accepted: true, migration: { ...m, ...patch }, effect });
    if (TERMINAL_MIGRATION_STATES.includes(m.state)) return unchanged();
    const recovery = pendingRecovery(m);
    if (event.type === 'error') {
        if (event.step === 'reopen' || event.step === 'abort') {
            if (recovery !== event.step) return unchanged();
            return move({ state: 'failed_needs_operator', lastError: `recovery_failed:${event.step}` });
        }
        if (recovery) return move({}, recovery);
        if (event.retryable && m.attempts < 5) return move({ attempts: m.attempts + 1, lastError: `retry:${event.step}` }, 'retry');
        // Commit's response may have been lost: the caller must fetch the current
        // export ETag before reopen; an old pre-commit ETag must never be used.
        const effect = event.step === 'commit' || m.migratedEtag ? 'reopen' : 'abort';
        return move({ lastError: `${RECOVERY_PREFIX}${effect}:${event.step}` }, effect);
    }
    if (event.type === 'reopened') return recovery ? move({ state: 'failed_reopened' }) : unchanged();
    if (recovery) return unchanged();
    switch (event.type) {
        case 'fenced':
            return m.state === 'requested' && UUID.test(event.generation) && !!event.etag
                ? move({ state: 'fenced', generation: event.generation, sourceEtag: event.etag, sourceSystemEtag: event.systemEtag, lastError: null }) : unchanged();
        case 'exported':
            return m.state === 'fenced' && !!m.generation && event.workspaceHead.generation === m.generation
                && ((m.sourceSystemEtag === null) === (event.systemHead === null))
                ? move({ state: 'exported', workspaceHead: event.workspaceHead, systemHead: event.systemHead, lastError: null }) : unchanged();
        case 'provisioned':
            return m.state === 'exported' ? move({ state: 'provisioning', lastError: null }) : unchanged();
        case 'host_restored':
            return m.state === 'provisioning' && !!m.generation && event.generation === m.generation
                ? move({ state: 'restored', lastError: null }) : unchanged();
        case 'committed':
            return m.state === 'restored' && !!event.migratedEtag
                ? move({ state: 'committed', migratedEtag: event.migratedEtag, lastError: null }) : unchanged();
        default: { const exhaustive: never = event; void exhaustive; return unchanged(); }
    }
}

export interface RestoreLease {
    kind: 'cf-snapshot';
    workspace: SnapshotHead;
    system: SnapshotHead | null;
    fetchBase: string;
    identityToken: string;
}
export function restoreFetchBase(appOrigin: string, computerId: string): string {
    if (!UUID.test(computerId)) throw new Error('invalid migration computer');
    return `${new URL(appOrigin).origin}/api/compute/restore/${computerId}`;
}
export function restoreLeaseFor(m: MigrationProgress & { computerId: string }, token: string, fetchBase: string): RestoreLease {
    const url = new URL(fetchBase);
    if (!['exported', 'provisioning'].includes(m.state) || pendingRecovery(m) || !m.generation
        || !m.workspaceHead || m.workspaceHead.generation !== m.generation
        || !/^[A-Za-z0-9_-]{43}$/.test(token)
        || !['https:', 'http:'].includes(url.protocol) || url.username || url.password
        || url.search || url.hash || url.pathname !== `/api/compute/restore/${m.computerId}`) throw new Error('invalid migration restore lease');
    return { kind: 'cf-snapshot', workspace: m.workspaceHead, system: m.systemHead, fetchBase, identityToken: token };
}
