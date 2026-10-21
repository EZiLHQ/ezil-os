import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PlacementExecutor } from './placement';
import { pendingRecovery, reduceMigration, type MigrationEvent, type MigrationProgress, type SnapshotHead } from './provider-migrate';

export interface ComputeMigration extends MigrationProgress {
    id: string;
    userId: string;
    computerId: string;
    fromProvider: 'cloudflare';
    toProvider: 'aws-ec2';
    toSize: 'standard' | 'premium';
    restoreTokenSha256: string | null;
    restoreTokenExpiresAt: Date | null;
    createdAt: string;
    /** Opaque PostgreSQL timestamp text, preserving microseconds for CAS. */
    updatedAt: string;
}
export class MigrationConflictError extends Error {
    constructor() { super('migration_conflict'); }
}
const COLUMNS = sql.raw('*, created_at::text AS created_at, updated_at::text AS updated_at');
const ACTIVE = sql`state NOT IN ('committed', 'failed_reopened', 'failed_needs_operator')`;
const STAMP = sql`GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')`;
function rows(result: unknown): Record<string, unknown>[] {
    return (Array.isArray(result) ? result : (result as { rows?: Record<string, unknown>[] })?.rows) ?? [];
}
function parse(r: Record<string, unknown>): ComputeMigration {
    return {
        id: String(r.id), userId: String(r.user_id), computerId: String(r.computer_id),
        fromProvider: r.from_provider as 'cloudflare', toProvider: r.to_provider as 'aws-ec2', toSize: r.to_size as ComputeMigration['toSize'],
        state: r.state as ComputeMigration['state'], generation: r.generation as string | null,
        sourceEtag: r.source_etag as string | null, sourceSystemEtag: r.source_system_etag as string | null,
        workspaceHead: r.workspace_head as SnapshotHead | null, systemHead: r.system_head as SnapshotHead | null,
        migratedEtag: r.migrated_etag as string | null, attempts: Number(r.attempts), lastError: r.last_error as string | null,
        restoreTokenSha256: r.restore_token_sha256 as string | null,
        restoreTokenExpiresAt: r.restore_token_expires_at == null ? null : new Date(r.restore_token_expires_at as string),
        createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
}
const one = (result: unknown): ComputeMigration | null => { const r = rows(result)[0]; return r ? parse(r) : null; };
const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest();

/** Always compares two fixed-length digests, including unknown computers and malformed hashes. */
export function restoreTokenMatches(m: ComputeMigration | null, computerId: string, generation: string, token: string, now: Date): boolean {
    const stored = m?.restoreTokenSha256;
    const validHash = typeof stored === 'string' && /^[a-f0-9]{64}$/.test(stored);
    const equal = timingSafeEqual(digest(token), validHash ? Buffer.from(stored, 'hex') : Buffer.alloc(32));
    return equal && validHash && !!m && m.computerId === computerId && m.generation === generation
        && ['exported', 'provisioning'].includes(m.state) && !pendingRecovery(m)
        && m.restoreTokenExpiresAt !== null && m.restoreTokenExpiresAt.getTime() > now.getTime();
}

/** Inject the app's drizzle executor; this module never opens a connection. */
export function createProviderMigrationStore(db: PlacementExecutor, options: { now?: () => Date } = {}) {
    const now = options.now ?? (() => new Date());
    const readById = async (id: string) => one(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_migrations WHERE id = ${id}::uuid`));
    const readByComputer = async (computerId: string) => one(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_migrations
        WHERE computer_id = ${computerId}::uuid ORDER BY created_at DESC, id DESC LIMIT 1`));
    const readActiveByComputer = async (computerId: string) => one(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_migrations
        WHERE computer_id = ${computerId}::uuid AND ${ACTIVE}`));
    return {
        readById, readByComputer, readActiveByComputer,
        async claimStale(limit: number): Promise<ComputeMigration[]> {
            const count = Number.isFinite(limit) ? Math.max(0, Math.min(10, Math.trunc(limit))) : 0;
            return rows(await db.execute(sql`WITH stale AS (
                SELECT id FROM public.ezil_compute_migrations WHERE ${ACTIVE}
                  AND updated_at < clock_timestamp() - interval '30 seconds'
                ORDER BY updated_at, id LIMIT ${count} FOR UPDATE SKIP LOCKED
            ) UPDATE public.ezil_compute_migrations m SET updated_at = GREATEST(clock_timestamp(), m.updated_at + interval '1 microsecond')
              FROM stale WHERE m.id = stale.id RETURNING m.*, m.created_at::text AS created_at, m.updated_at::text AS updated_at`)).map(parse);
        },
        async statusFor(userId: string): Promise<'preparing' | 'failed' | null> {
            const r = rows(await db.execute(sql`SELECT state FROM public.ezil_compute_migrations
                WHERE user_id = ${userId}::uuid ORDER BY created_at DESC, id DESC LIMIT 1`))[0];
            return !r || r.state === 'committed' ? null : String(r.state).startsWith('failed_') ? 'failed' : 'preparing';
        },
        /** Non-secret provision intent; snapshot bytes and capabilities are never copied here. */
        async saveProvision(m: ComputeMigration, provision: unknown): Promise<void> {
            const updated = one(await db.execute(sql`UPDATE public.ezil_compute_migrations
                SET workspace_head = jsonb_set(workspace_head, '{_awsProvision}', (${JSON.stringify(provision)}::text)::jsonb), updated_at = ${STAMP}
                WHERE id = ${m.id}::uuid AND state = ${m.state} AND updated_at::text = ${m.updatedAt} RETURNING ${COLUMNS}`));
            if (!updated) throw new MigrationConflictError();
        },
        async createOrGetActive(input: { computerId: string; userId: string; toSize: 'standard' | 'premium' }): Promise<ComputeMigration> {
            // A separate read sees a concurrent creator's committed row under READ COMMITTED.
            for (let attempt = 0; attempt < 5; attempt++) {
                const inserted = one(await db.execute(sql`INSERT INTO public.ezil_compute_migrations
                    (computer_id, user_id, from_provider, to_provider, to_size)
                    VALUES (${input.computerId}::uuid, ${input.userId}::uuid, 'cloudflare', 'aws-ec2', ${input.toSize})
                    ON CONFLICT (computer_id) WHERE ${ACTIVE} DO NOTHING RETURNING ${COLUMNS}`));
                const m = inserted ?? await readActiveByComputer(input.computerId);
                if (!m) continue;
                if (m.userId !== input.userId.toLowerCase() || m.toSize !== input.toSize) throw new MigrationConflictError();
                return m;
            }
            throw new MigrationConflictError();
        },
        async applyTransition(expected: ComputeMigration, event: MigrationEvent) {
            const decision = reduceMigration(expected, event);
            if (!decision.accepted) return { ...decision, migration: expected };
            const m = decision.migration;
            const revoke = !['exported', 'provisioning'].includes(m.state) || !!pendingRecovery(m);
            const updated = one(await db.execute(sql`UPDATE public.ezil_compute_migrations SET
                state = ${m.state}, generation = ${m.generation}::uuid, source_etag = ${m.sourceEtag}, source_system_etag = ${m.sourceSystemEtag},
                workspace_head = (${JSON.stringify(m.workspaceHead)}::text)::jsonb, system_head = (${JSON.stringify(m.systemHead)}::text)::jsonb,
                migrated_etag = ${m.migratedEtag}, attempts = ${m.attempts}, last_error = ${m.lastError},
                restore_token_sha256 = ${revoke ? null : expected.restoreTokenSha256},
                restore_token_expires_at = ${revoke ? null : expected.restoreTokenExpiresAt?.toISOString() ?? null}::timestamptz,
                updated_at = ${STAMP}
                WHERE id = ${expected.id}::uuid AND state = ${expected.state} AND updated_at::text = ${expected.updatedAt}
                RETURNING ${COLUMNS}`));
            if (!updated) throw new MigrationConflictError();
            return { ...decision, migration: updated };
        },
        async mintRestoreToken(m: ComputeMigration): Promise<string> {
            if (!m.generation || !m.workspaceHead || m.workspaceHead.generation !== m.generation
                || !['exported', 'provisioning'].includes(m.state) || pendingRecovery(m)) throw new Error('migration_not_exported');
            const token = randomBytes(32).toString('base64url');
            const updated = one(await db.execute(sql`UPDATE public.ezil_compute_migrations
                SET restore_token_sha256 = ${digest(token).toString('hex')},
                    restore_token_expires_at = ${new Date(now().getTime() + 15 * 60_000).toISOString()}::timestamptz, updated_at = ${STAMP}
                WHERE id = ${m.id}::uuid AND computer_id = ${m.computerId}::uuid AND generation = ${m.generation}::uuid
                    AND state = ${m.state} AND state IN ('exported', 'provisioning') AND updated_at::text = ${m.updatedAt}
                RETURNING ${COLUMNS}`));
            if (!updated) throw new MigrationConflictError();
            // Callers re-read the row before their next transition; plaintext is never persisted.
            return token;
        },
        async verifyRestoreToken(computerId: string, generation: string, token: string): Promise<boolean> {
            return restoreTokenMatches(await readActiveByComputer(computerId), computerId, generation, token, now());
        },
    };
}
