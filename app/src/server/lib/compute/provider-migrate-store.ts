import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { PlacementExecutor } from './placement';
import type { MigrateConflictReason } from '../cloudflare-guacamole-provider';
import { pendingRecovery, reduceMigration, type MigrationEvent, type MigrationProgress, type SnapshotHead } from './provider-migrate';
import { inMoveTransaction, reverseMoveHolds } from './provider-reverse-store';

export type MigrationFailureReason = MigrateConflictReason | 'system_head_mismatch';
export type MigrationStoreEvent = MigrationEvent & { reason?: MigrationFailureReason };

export interface MigrationRestoreProgress {
    /** Hex-encoded 512-bit sets, indexed with PostgreSQL bytea get_bit/set_bit. */
    workspace: string;
    system: string;
    bytes: number;
    first: string;
    last: string;
}

export interface ComputeMigration extends MigrationProgress {
    id: string;
    userId: string;
    computerId: string;
    fromProvider: 'cloudflare';
    toProvider: 'aws-ec2';
    toSize: 'standard' | 'premium';
    restoreTokenSha256: string | null;
    restoreTokenExpiresAt: Date | null;
    restoreProgress?: MigrationRestoreProgress | null;
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
        restoreProgress: r.restore_progress as MigrationRestoreProgress | null ?? null,
        createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
}
const one = (result: unknown): ComputeMigration | null => { const r = rows(result)[0]; return r ? parse(r) : null; };
const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest();

export function snapshotChunkSizes(head: SnapshotHead | null): number[] | null {
    if (!head || !Array.isArray(head.chunks)) return null;
    const sizes: number[] = [];
    for (const chunk of head.chunks) {
        if (!chunk || typeof chunk.size !== 'number' || !Number.isSafeInteger(chunk.size) || chunk.size < 0) return null;
        sizes.push(chunk.size);
    }
    return sizes;
}

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
        WHERE computer_id = ${computerId}::uuid ORDER BY ezil_compute_migrations.created_at DESC, id DESC LIMIT 1`));
    const readActiveByComputer = async (computerId: string) => one(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_migrations
        WHERE computer_id = ${computerId}::uuid AND ${ACTIVE}`));
    return {
        readById, readByComputer, readActiveByComputer,
        async recordRestoreChunk(m: ComputeMigration, kind: 'workspace' | 'system', index: number): Promise<void> {
            const size = snapshotChunkSizes(kind === 'workspace' ? m.workspaceHead : m.systemHead)?.[index];
            if (!m.generation || !Number.isInteger(index) || index < 0 || index > 511 || size === undefined)
                throw new Error('invalid_restore_chunk');
            const at = now().toISOString();
            const bits = sql`decode(COALESCE(restore_progress ->> ${kind}::text, repeat('0', 128)), 'hex')`;
            // Evaluate against the locked row, not a read/modify/write snapshot. Progress
            // must not consume the lifecycle CAS timestamp or postpone reconciliation.
            await db.execute(sql`UPDATE public.ezil_compute_migrations SET restore_progress =
                COALESCE(restore_progress, jsonb_build_object('workspace', repeat('0', 128), 'system', repeat('0', 128)))
                || jsonb_build_object(
                    ${kind}::text, encode(set_bit(${bits}, ${index}::int, 1), 'hex'),
                    'bytes', COALESCE((restore_progress ->> 'bytes')::bigint, 0)
                        + CASE WHEN get_bit(${bits}, ${index}::int) = 0 THEN ${size}::bigint ELSE 0 END,
                    'first', COALESCE(restore_progress ->> 'first', ${at}::text),
                    'last', GREATEST(restore_progress ->> 'last', ${at}::text))
                WHERE id = ${m.id}::uuid AND generation = ${m.generation}::uuid`);
        },
        async claimStale(limit: number): Promise<ComputeMigration[]> {
            const count = Number.isFinite(limit) ? Math.max(0, Math.min(10, Math.trunc(limit))) : 0;
            return rows(await db.execute(sql`WITH stale AS (
                SELECT id FROM public.ezil_compute_migrations WHERE (${ACTIVE}
                  OR (state IN ('failed_reopened', 'failed_needs_operator')
                    AND workspace_head ? '_awsProvision'
                    AND COALESCE(workspace_head #>> '{_awsProvision,released}', 'false') <> 'true'))
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
                // Cross-direction exclusion (docs/compute/REVERSE-MOVE-CONTRACT.md §3.2): a new row is
                // kept only if, under the per-computer lock, no reverse move holds the computer.
                const inserted = await inMoveTransaction(db, async tx => {
                    const row = one(await tx.execute(sql`INSERT INTO public.ezil_compute_migrations
                    (computer_id, user_id, from_provider, to_provider, to_size)
                    VALUES (${input.computerId}::uuid, ${input.userId}::uuid, 'cloudflare', 'aws-ec2', ${input.toSize})
                    ON CONFLICT (computer_id) WHERE ${ACTIVE} DO NOTHING RETURNING ${COLUMNS}`));
                    if (row && await reverseMoveHolds(tx, input.computerId)) throw new MigrationConflictError();
                    return row;
                });
                const m = inserted ?? await readActiveByComputer(input.computerId);
                if (!m) continue;
                if (m.userId !== input.userId.toLowerCase() || m.toSize !== input.toSize) throw new MigrationConflictError();
                return m;
            }
            throw new MigrationConflictError();
        },
        async applyTransition(expected: ComputeMigration, event: MigrationStoreEvent) {
            const decision = reduceMigration(expected, event);
            if (!decision.accepted) return { ...decision, migration: expected };
            const m = decision.migration;
            // Keep the reducer's recovery prefix and step intact. An existing
            // recovery retains its original cause until abort/reopen itself fails.
            if (event.type === 'error' && event.reason && m.lastError
                && (!pendingRecovery(expected) || event.step === 'abort' || event.step === 'reopen')) {
                m.lastError += `:${event.reason}`;
            }
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
