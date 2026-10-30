/**
 * AWS → Cloudflare moves (Phase B) — the store of `public.ezil_compute_reverse_moves`
 * (`app/drizzle/0012_compute_reverse_moves.sql`, docs/compute/REVERSE-MOVE-CONTRACT.md §3).
 *
 * A NEW table, never a relaxed 0006: no forward reader (claimStale, providerForPendingMigration,
 * readEnrollmentPlacement, statusFor) can ever see a reverse row, and an app rollback never reads it.
 *
 * - **One active row per computer** (partial unique index). `failed_needs_operator` still holds the
 *   computer; only an operator releases it to `failed_reopened`.
 * - **Cross-direction exclusion.** A create in either direction inserts, then takes the per-computer
 *   advisory lock (the placement lock key, so it also serialises with the flip), then refuses while
 *   the other direction holds the computer. The check runs after the lock in its own statement, so
 *   under READ COMMITTED it sees any creator that committed while this one waited.
 * - **Transitions are compare-and-swap** on `(id, state, updated_at::text)`, like the forward store.
 *   A lost race throws `ReverseMoveConflictError('lost_race')` and writes nothing.
 *
 * Inject the app's drizzle executor; this module never opens a connection. To write inside a
 * placement transaction (export-boot claim, flip), build the store over that transaction.
 */
import { sql, type SQL } from 'drizzle-orm';
import { PLACEMENT_LOCK_NAMESPACE, type PlacementDb, type PlacementExecutor } from './placement';

export const REVERSE_MOVE_STATES = ['requested', 'booting', 'exporting', 'copying', 'checking', 'flipping',
    'committed', 'failed_reopened', 'failed_needs_operator'] as const;
export type ReverseMoveState = (typeof REVERSE_MOVE_STATES)[number];
/** The machine advances these; the sweep may claim them. */
export const REVERSE_MOVE_IN_FLIGHT: readonly ReverseMoveState[] = ['requested', 'booting', 'exporting', 'copying', 'checking', 'flipping'];
/** Rows in these states occupy the computer (the one-active index predicate). */
export const REVERSE_MOVE_HOLDING: readonly ReverseMoveState[] = [...REVERSE_MOVE_IN_FLIGHT, 'failed_needs_operator'];
export type ReverseMoveStartedBy = 'user' | 'open' | 'cron';
export type ReverseMoveFailure = 'failed_reopened' | 'failed_needs_operator';

/** Every legal edge. `requested→booting` is `recordExportBoot`, `exporting→copying` is `recordExportHead`,
 * `flipping→committed` is `finish`, `*→failed_*` is `fail`; `advance` takes the rest. */
export const REVERSE_MOVE_TRANSITIONS: Readonly<Record<ReverseMoveState, readonly ReverseMoveState[]>> = {
    requested: ['booting', 'failed_reopened', 'failed_needs_operator'],
    booting: ['exporting', 'failed_reopened', 'failed_needs_operator'],
    exporting: ['copying', 'failed_reopened', 'failed_needs_operator'],
    copying: ['checking', 'failed_reopened', 'failed_needs_operator'],
    checking: ['flipping', 'failed_reopened', 'failed_needs_operator'],
    flipping: ['committed', 'failed_reopened', 'failed_needs_operator'],
    committed: [],
    failed_reopened: [],
    failed_needs_operator: ['failed_reopened'],
};
const ADVANCE: Readonly<Partial<Record<ReverseMoveState, ReverseMoveState>>> = { booting: 'exporting', copying: 'checking', checking: 'flipping' };

/** `summary.computer.move.stage` per row state; the shell's MOVE_STEP_OF reads these (contract §7). */
export const REVERSE_MOVE_DTO_STAGE: Readonly<Record<ReverseMoveState, string>> = {
    requested: 'saving', booting: 'saving', exporting: 'saving', copying: 'copying', checking: 'checking', flipping: 'flipping',
    committed: 'committed', failed_reopened: 'failed_reopened', failed_needs_operator: 'failed_needs_operator',
};

/** The Worker snapshot codec's limits (worker/src/workspace-persist.ts, workspace-snapshot-script.ts). */
export const EXPORT_CHUNK_BYTES = 1024 * 1024;
export const EXPORT_MAX_CHUNKS = 512;
export const EXPORT_MAX_BYTES = EXPORT_MAX_CHUNKS * EXPORT_CHUNK_BYTES;
export const EXPORT_MAX_ENTRIES = 100_000;
export const REVERSE_MOVE_MAX_ATTEMPTS = 5;
export const REVERSE_MOVE_RETENTION_DAYS = 14;

/** The export boot's claim on the published placement row (contract §5). Integers are the placement's
 * own counters (`placementGeneration`), never the move's uuid `generation`. */
export interface ReverseExportBoot {
    placementGeneration: number;
    leaseEpoch: number;
    volumeId: string;
    jobId: string | null;
    instanceId: string | null;
    fsUuid: string | null;
    claimedAt: string;
}
/** The host's export head (contract §2.3). `generation` is the move's import generation. */
export interface ReverseExportHead {
    generation: string;
    sha256: string;
    entries: number;
    skipped: number;
    bytes: number;
    chunks: Array<{ i: number; size: number; sha256: string }>;
}
/** Bitmap: 128 hex chars = 512 bits, bit i = byte ⌊i/8⌋ mask 1<<(i%8) (PostgreSQL get_bit/set_bit, as restore_progress). */
export interface ReverseImportProgress {
    bitmap: string;
    bytes: number;
    archiveSha256: string;
    first: string;
    last: string;
}
export interface ComputeReverseMove {
    id: string;
    userId: string;
    computerId: string;
    startedBy: ReverseMoveStartedBy;
    state: ReverseMoveState;
    /** The Cloudflare import generation: chunk owner and new v1 head generation. Immutable per row. */
    generation: string;
    exportBoot: ReverseExportBoot | null;
    exportHead: ReverseExportHead | null;
    importProgress: ReverseImportProgress | null;
    bytesTotal: number | null;
    skipped: number | null;
    awsVolumeId: string | null;
    awsFsUuid: string | null;
    awsSnapshotId: string | null;
    retainUntil: Date | null;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    /** Opaque PostgreSQL timestamp text, preserving microseconds for CAS. */
    updatedAt: string;
}

export type ReverseMoveConflictReason = 'lost_race' | 'forward_active' | 'owner_mismatch' | 'illegal_transition' | 'invalid_input' | 'create_failed';
export class ReverseMoveConflictError extends Error {
    constructor(readonly reason: ReverseMoveConflictReason) { super(`reverse_move_conflict:${reason}`); }
}
function refuse(reason: ReverseMoveConflictReason): never { throw new ReverseMoveConflictError(reason); }
export class MoveLockIsolationError extends Error {
    constructor(isolation: string) { super(`move locks require READ COMMITTED, got ${isolation}`); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const VOLUME = /^vol-[0-9a-f]{8,17}$/;
const SNAPSHOT = /^snap-[0-9a-f]{8,17}$/;
const INSTANCE = /^i-[0-9a-f]{8,17}$/;
const REASON = /^[a-z0-9_.:-]{1,200}$/;
const BITMAP_HEX = EXPORT_MAX_CHUNKS / 4;
const COLUMNS = sql.raw('*, created_at::text AS created_at, updated_at::text AS updated_at');
const HOLDING = sql.raw(`state NOT IN ('committed', 'failed_reopened')`);
const STAMP = sql`GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')`;
const json = (value: unknown) => sql`(${JSON.stringify(value)}::text)::jsonb`;

function rows(result: unknown): Record<string, unknown>[] {
    return (Array.isArray(result) ? result : (result as { rows?: Record<string, unknown>[] })?.rows) ?? [];
}
const int = (value: unknown) => value == null ? null : Number(value);
function parse(r: Record<string, unknown>): ComputeReverseMove {
    return {
        id: String(r.id), userId: String(r.user_id), computerId: String(r.computer_id),
        startedBy: r.started_by as ReverseMoveStartedBy, state: r.state as ReverseMoveState, generation: String(r.generation),
        exportBoot: (r.export_boot ?? null) as ReverseExportBoot | null, exportHead: (r.export_head ?? null) as ReverseExportHead | null,
        importProgress: (r.import_progress ?? null) as ReverseImportProgress | null,
        bytesTotal: int(r.bytes_total), skipped: int(r.skipped),
        awsVolumeId: (r.aws_volume_id ?? null) as string | null, awsFsUuid: r.aws_fs_uuid == null ? null : String(r.aws_fs_uuid),
        awsSnapshotId: (r.aws_snapshot_id ?? null) as string | null,
        retainUntil: r.retain_until == null ? null : new Date(r.retain_until as string | Date),
        attempts: Number(r.attempts), lastError: (r.last_error ?? null) as string | null,
        createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
}
const one = (result: unknown): ComputeReverseMove | null => { const r = rows(result)[0]; return r ? parse(r) : null; };

// ── Cross-direction exclusion (shared with provider-migrate-store.ts) ────────

/** Run `fn` in a READ COMMITTED transaction when the executor can open one; otherwise on the
 * executor itself, which must then already be a transaction (its locks last until its commit). */
export function inMoveTransaction<T>(db: PlacementExecutor, fn: (tx: PlacementExecutor) => Promise<T>): Promise<T> {
    const transaction = (db as Partial<PlacementDb>).transaction;
    return typeof transaction === 'function' ? transaction.call(db, fn) as Promise<T> : fn(db);
}

/** The per-computer placement lock (placement.ts `lockComputer`: same namespace and key), READ COMMITTED only. */
export async function lockComputerMoves(tx: PlacementExecutor, computerId: string): Promise<void> {
    const r = rows(await tx.execute(sql`/* moves:lock-computer */ SELECT pg_advisory_xact_lock(${PLACEMENT_LOCK_NAMESPACE}::int4, hashtext(${computerId}::uuid::text)), current_setting('transaction_isolation') AS isolation`))[0];
    if (r?.isolation !== 'read committed') throw new MoveLockIsolationError(String(r?.isolation));
}

/** Whether a reverse move holds the computer. Called by the FORWARD create after its insert. A
 * database without 0012 (production; the forward suites' schemas) has no reverse move by definition:
 * the probe is its own statement because a missing relation fails at parse time. */
export async function reverseMoveHolds(tx: PlacementExecutor, computerId: string): Promise<boolean> {
    const probe = rows(await tx.execute(sql`SELECT to_regclass('public.ezil_compute_reverse_moves') IS NOT NULL AS present`))[0];
    if (probe?.present !== true) return false;
    await lockComputerMoves(tx, computerId);
    return rows(await tx.execute(sql`SELECT 1 AS held FROM public.ezil_compute_reverse_moves
        WHERE computer_id = ${computerId}::uuid AND ${HOLDING} LIMIT 1`)).length > 0;
}

/** Whether the forward machine still has work for the computer: an active row, or a failed one whose
 * AWS provision is not released yet (exactly what forward claimStale still picks up). */
async function forwardMoveBusy(tx: PlacementExecutor, computerId: string): Promise<boolean> {
    return rows(await tx.execute(sql`SELECT 1 AS busy FROM public.ezil_compute_migrations
        WHERE computer_id = ${computerId}::uuid AND (state NOT IN ('committed', 'failed_reopened', 'failed_needs_operator')
          OR (state IN ('failed_reopened', 'failed_needs_operator') AND workspace_head ? '_awsProvision'
            AND COALESCE(workspace_head #>> '{_awsProvision,released}', 'false') <> 'true')) LIMIT 1`)).length > 0;
}

// ── Pure validation ──────────────────────────────────────────────────────

export function validExportBoot(boot: ReverseExportBoot): boolean {
    return !!boot && Number.isSafeInteger(boot.placementGeneration) && boot.placementGeneration >= 1
        && Number.isSafeInteger(boot.leaseEpoch) && boot.leaseEpoch >= 1 && VOLUME.test(boot.volumeId)
        && (boot.jobId === null || UUID.test(boot.jobId)) && (boot.instanceId === null || INSTANCE.test(boot.instanceId))
        && (boot.fsUuid === null || UUID.test(boot.fsUuid)) && typeof boot.claimedAt === 'string' && Number.isFinite(Date.parse(boot.claimedAt));
}

/** The export head the host reports (contract §2.3), bound to this move's generation. */
export function validExportHead(head: ReverseExportHead, generation: string): boolean {
    if (!head || head.generation !== generation || !HASH.test(head.sha256) || !Number.isSafeInteger(head.entries)
        || head.entries < 0 || head.entries > EXPORT_MAX_ENTRIES || !Number.isSafeInteger(head.skipped) || head.skipped < 0
        || !Array.isArray(head.chunks) || head.chunks.length < 1 || head.chunks.length > EXPORT_MAX_CHUNKS) return false;
    let bytes = 0;
    for (const [index, chunk] of head.chunks.entries()) {
        const last = index === head.chunks.length - 1;
        if (!chunk || chunk.i !== index || !HASH.test(chunk.sha256) || !Number.isSafeInteger(chunk.size) || chunk.size < 1
            || (last ? chunk.size > EXPORT_CHUNK_BYTES : chunk.size !== EXPORT_CHUNK_BYTES)) return false;
        bytes += chunk.size;
    }
    return head.bytes === bytes && bytes <= EXPORT_MAX_BYTES;
}

/** Bits set in a 512-bit progress bitmap (128 hex chars). */
export function bitmapHas(bitmap: string, index: number): boolean {
    const byte = Number.parseInt(bitmap.slice(Math.floor(index / 8) * 2, Math.floor(index / 8) * 2 + 2), 16);
    return Number.isInteger(byte) && (byte & (1 << (index % 8))) !== 0;
}
export function bitmapSet(bitmap: string, indices: readonly number[]): string {
    const bytes = Buffer.from(bitmap, 'hex');
    for (const index of indices) bytes[Math.floor(index / 8)]! |= 1 << (index % 8);
    return bytes.toString('hex');
}
/** Whether every chunk of the export head is recorded as imported. */
export function importComplete(m: Pick<ComputeReverseMove, 'exportHead' | 'importProgress'>): boolean {
    const head = m.exportHead, progress = m.importProgress;
    return !!head && !!progress && progress.archiveSha256 === head.sha256
        && head.chunks.every(chunk => bitmapHas(progress.bitmap, chunk.i));
}

// ── Store ────────────────────────────────────────────────────────────────

export function createProviderReverseStore(db: PlacementExecutor, options: { now?: () => Date } = {}) {
    const now = options.now ?? (() => new Date());
    const readById = async (id: string) => one(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_reverse_moves WHERE id = ${id}::uuid`));
    const readByComputer = async (computerId: string) => one(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_reverse_moves
        WHERE computer_id = ${computerId}::uuid ORDER BY ezil_compute_reverse_moves.created_at DESC, id DESC LIMIT 1`));
    const readActiveByComputer = async (computerId: string) => one(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_reverse_moves
        WHERE computer_id = ${computerId}::uuid AND ${HOLDING}`));
    const legal = (from: ReverseMoveState, to: ReverseMoveState) => REVERSE_MOVE_TRANSITIONS[from]?.includes(to) ?? false;
    /** One compare-and-swap write; zero rows is a lost race, never retried here. */
    async function cas(expected: ComputeReverseMove, to: ReverseMoveState, set: SQL): Promise<ComputeReverseMove> {
        const updated = one(await db.execute(sql`UPDATE public.ezil_compute_reverse_moves SET state = ${to}, ${set}, updated_at = ${STAMP}
            WHERE id = ${expected.id}::uuid AND state = ${expected.state} AND updated_at::text = ${expected.updatedAt}
            RETURNING ${COLUMNS}`));
        return updated ?? refuse('lost_race');
    }
    return {
        readById, readByComputer, readActiveByComputer,
        /**
         * The computer's holding row, or a new `requested` row. Refuses (`forward_active`) while the
         * forward machine has work for the computer, and (`owner_mismatch`) another owner's row.
         */
        async createOrGetActive(input: { computerId: string; userId: string; startedBy: ReverseMoveStartedBy }): Promise<ComputeReverseMove> {
            if (!UUID.test(input.computerId.toLowerCase()) || !UUID.test(input.userId.toLowerCase())
                || !['user', 'open', 'cron'].includes(input.startedBy)) refuse('invalid_input');
            // A separate read sees a concurrent creator's committed row under READ COMMITTED.
            for (let attempt = 0; attempt < 5; attempt++) {
                const inserted = await inMoveTransaction(db, async tx => {
                    const row = one(await tx.execute(sql`INSERT INTO public.ezil_compute_reverse_moves (computer_id, user_id, started_by)
                        VALUES (${input.computerId}::uuid, ${input.userId}::uuid, ${input.startedBy})
                        ON CONFLICT (computer_id) WHERE ${HOLDING} DO NOTHING RETURNING ${COLUMNS}`));
                    if (row) {
                        await lockComputerMoves(tx, input.computerId);
                        if (await forwardMoveBusy(tx, input.computerId)) refuse('forward_active');
                    }
                    return row;
                });
                const m = inserted ?? await readActiveByComputer(input.computerId);
                if (!m) continue;
                if (m.userId !== input.userId.toLowerCase()) refuse('owner_mismatch');
                return m;
            }
            return refuse('create_failed');
        },
        /** `requested→booting` with the claim; in `booting`, adds jobId/instanceId/fsUuid to the SAME claim. */
        async recordExportBoot(expected: ComputeReverseMove, boot: ReverseExportBoot): Promise<ComputeReverseMove> {
            if (!validExportBoot(boot)) refuse('invalid_input');
            if (expected.state === 'requested') return cas(expected, 'booting', sql`export_boot = ${json(boot)}, attempts = 0, last_error = NULL`);
            const held = expected.exportBoot;
            const keeps = (key: 'jobId' | 'instanceId' | 'fsUuid') => held?.[key] == null || held[key] === boot[key];
            if (expected.state !== 'booting' || !held || held.placementGeneration !== boot.placementGeneration || held.leaseEpoch !== boot.leaseEpoch
                || held.volumeId !== boot.volumeId || held.claimedAt !== boot.claimedAt || !keeps('jobId') || !keeps('instanceId') || !keeps('fsUuid')) {
                refuse('illegal_transition');
            }
            return cas(expected, 'booting', sql`export_boot = ${json(boot)}`);
        },
        /** `booting→exporting` (host enrolled), `copying→checking` (every chunk imported), `checking→flipping`. Resets attempts. */
        async advance(expected: ComputeReverseMove, to: ReverseMoveState): Promise<ComputeReverseMove> {
            if (ADVANCE[expected.state] !== to || !legal(expected.state, to)
                || (to === 'exporting' && !expected.exportBoot?.instanceId) || (to === 'checking' && !importComplete(expected))) refuse('illegal_transition');
            return cas(expected, to, sql`attempts = 0, last_error = NULL`);
        },
        /** `exporting→copying` with the validated head; import progress starts empty. */
        async recordExportHead(expected: ComputeReverseMove, head: ReverseExportHead): Promise<ComputeReverseMove> {
            if (expected.state !== 'exporting') refuse('illegal_transition');
            if (!validExportHead(head, expected.generation)) refuse('invalid_input');
            const stored: ReverseExportHead = { generation: head.generation, sha256: head.sha256, entries: head.entries, skipped: head.skipped,
                bytes: head.bytes, chunks: head.chunks.map(({ i, size, sha256 }) => ({ i, size, sha256 })) };
            return cas(expected, 'copying', sql`export_head = ${json(stored)}, bytes_total = ${head.bytes}::bigint, skipped = ${head.skipped}::int,
                import_progress = NULL, attempts = 0, last_error = NULL`);
        },
        /** Chunks the Worker verified and stored (contract §4 pull). Idempotent per index; progress resets attempts. */
        async recordImportProgress(expected: ComputeReverseMove, indices: readonly number[]): Promise<ComputeReverseMove> {
            const head = expected.exportHead;
            if (expected.state !== 'copying' || !head) refuse('illegal_transition');
            if (!indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= head!.chunks.length)) refuse('invalid_input');
            const previous = expected.importProgress?.archiveSha256 === head!.sha256 ? expected.importProgress : null;
            const bitmap = previous?.bitmap ?? '0'.repeat(BITMAP_HEX);
            const fresh = [...new Set(indices)].filter(i => !bitmapHas(bitmap, i));
            if (!fresh.length) return expected;
            const at = now().toISOString();
            const progress: ReverseImportProgress = { bitmap: bitmapSet(bitmap, fresh), archiveSha256: head!.sha256,
                bytes: (previous?.bytes ?? 0) + fresh.reduce((sum, i) => sum + head!.chunks[i]!.size, 0),
                first: previous?.first ?? at, last: previous && previous.last > at ? previous.last : at };
            return cas(expected, 'copying', sql`import_progress = ${json(progress)}, attempts = 0, last_error = NULL`);
        },
        /** One more bounded retry in the current state; `exhausted` (nothing written) means the caller must `fail`. */
        async recordRetry(expected: ComputeReverseMove, reason: string): Promise<{ move: ComputeReverseMove; exhausted: boolean }> {
            if (!REVERSE_MOVE_IN_FLIGHT.includes(expected.state)) refuse('illegal_transition');
            if (!REASON.test(reason)) refuse('invalid_input');
            if (expected.attempts >= REVERSE_MOVE_MAX_ATTEMPTS) return { move: expected, exhausted: true };
            return { move: await cas(expected, expected.state, sql`attempts = ${expected.attempts + 1}::int, last_error = ${reason}`), exhausted: false };
        },
        /** In-flight → `failed_reopened` | `failed_needs_operator`; an operator releases `failed_needs_operator` → `failed_reopened`. */
        async fail(expected: ComputeReverseMove, to: ReverseMoveFailure, reason: string): Promise<ComputeReverseMove> {
            if (!legal(expected.state, to)) refuse('illegal_transition');
            if (!REASON.test(reason)) refuse('invalid_input');
            return cas(expected, to, sql`last_error = ${reason}`);
        },
        /** `flipping→committed`: the AWS volume (and snapshot, when taken) is retained 14 days on this row (D21, R11). */
        async finish(expected: ComputeReverseMove, retained: { awsVolumeId: string; awsFsUuid: string | null; awsSnapshotId: string | null }): Promise<ComputeReverseMove> {
            if (!legal(expected.state, 'committed')) refuse('illegal_transition');
            if (!VOLUME.test(retained.awsVolumeId) || (retained.awsFsUuid !== null && !UUID.test(retained.awsFsUuid))
                || (retained.awsSnapshotId !== null && !SNAPSHOT.test(retained.awsSnapshotId))) refuse('invalid_input');
            return cas(expected, 'committed', sql`aws_volume_id = ${retained.awsVolumeId}, aws_fs_uuid = ${retained.awsFsUuid}::uuid,
                aws_snapshot_id = ${retained.awsSnapshotId}, retain_until = clock_timestamp() + make_interval(days => ${REVERSE_MOVE_RETENTION_DAYS}::int),
                attempts = 0, last_error = NULL`);
        },
        /** In-flight rows untouched for 30 s, oldest first; claiming bumps `updated_at` (the caller re-reads). */
        async claimStale(limit: number): Promise<ComputeReverseMove[]> {
            const count = Number.isFinite(limit) ? Math.max(0, Math.min(10, Math.trunc(limit))) : 0;
            return rows(await db.execute(sql`WITH stale AS (
                SELECT id FROM public.ezil_compute_reverse_moves
                WHERE state IN ('requested', 'booting', 'exporting', 'copying', 'checking', 'flipping')
                  AND updated_at < clock_timestamp() - interval '30 seconds'
                ORDER BY updated_at, id LIMIT ${count} FOR UPDATE SKIP LOCKED
            ) UPDATE public.ezil_compute_reverse_moves m SET updated_at = GREATEST(clock_timestamp(), m.updated_at + interval '1 microsecond')
              FROM stale WHERE m.id = stale.id RETURNING m.*, m.created_at::text AS created_at, m.updated_at::text AS updated_at`)).map(parse);
        },
    };
}
export type ProviderReverseStore = ReturnType<typeof createProviderReverseStore>;
