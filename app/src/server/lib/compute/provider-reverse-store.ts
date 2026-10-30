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
 * - **The point of no return is in the row.** `checking → flipping` sets `commit_sent_at` (DB clock) before
 *   the Worker commit may be sent. From then on the row can only end `committed` or `failed_needs_operator`:
 *   `failed_reopened` is refused by this store and by the 0012 CHECK, because the Cloudflare head may
 *   already be this move's. `state_entered_at` moves only on a state change (never on claimStale or a
 *   retry), so every per-state timeout has a durable anchor.
 *
 * Inject the app's drizzle executor; this module never opens a connection. To write inside a
 * placement transaction (export-boot claim, flip), build the store over that transaction.
 */
import { sql, type SQL } from 'drizzle-orm';
import { AWS_REGION_PATTERN } from './aws-config';
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
 * `flipping→committed` is `finish`, `*→failed_*` is `fail`; `advance` takes the rest.
 * - `flipping` never reaches `failed_reopened`: the commit may have landed (contract §4.4, §5.5).
 * - An operator releases `failed_needs_operator`: to `failed_reopened` only while `commit_sent_at` is null,
 *   or to `committed` (`finish`, finishing a stuck flip) only when it is set. */
export const REVERSE_MOVE_TRANSITIONS: Readonly<Record<ReverseMoveState, readonly ReverseMoveState[]>> = {
    requested: ['booting', 'failed_reopened', 'failed_needs_operator'],
    booting: ['exporting', 'failed_reopened', 'failed_needs_operator'],
    exporting: ['copying', 'failed_reopened', 'failed_needs_operator'],
    copying: ['checking', 'failed_reopened', 'failed_needs_operator'],
    checking: ['flipping', 'failed_reopened', 'failed_needs_operator'],
    flipping: ['committed', 'failed_needs_operator'],
    committed: [],
    failed_reopened: [],
    failed_needs_operator: ['failed_reopened', 'committed'],
};
const ADVANCE: Readonly<Partial<Record<ReverseMoveState, ReverseMoveState>>> = { booting: 'exporting', copying: 'checking', checking: 'flipping' };

/** `summary.computer.move.stage` per row state; the shell's MOVE_STEP_OF reads these (contract §6.1). */
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
/** Rows past `requested` (each holds, or is about to hold, an export host), fleet-wide (contract §5.1.1 step 5b). */
export const REVERSE_MOVE_MAX_ACTIVE = 3;
/** The states `REVERSE_MOVE_MAX_ACTIVE` counts: a claim moved the row there, and only a terminal state leaves them. */
export const REVERSE_MOVE_HOST_BOUND: readonly ReverseMoveState[] = ['booting', 'exporting', 'copying', 'checking', 'flipping'];

/** The export boot's claim on the published placement row (contract §5). Integers are the placement's
 * own counters (`placementGeneration`), never the move's uuid `generation`. `region` is the placement's region
 * (r5): the flip deletes the placement row, so the D21 snapshot and the purge find the retained volume's region here. */
export interface ReverseExportBoot {
    placementGeneration: number;
    leaseEpoch: number;
    region: string;
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
/** Bitmap: 128 hex chars = 512 bits, bit i = byte ⌊i/8⌋ mask 1<<(i%8) (PostgreSQL get_bit/set_bit, as restore_progress).
 * `first`/`last` are DB-clock ISO 8601 text (`to_jsonb(timestamptz)`), written by the store, never by the app clock. */
export interface ReverseImportProgress {
    bitmap: string;
    bytes: number;
    archiveSha256: string;
    first: string;
    last: string;
}
/**
 * Seconds since each deadline anchor, computed by PostgreSQL (`clock_timestamp()`) when the row is read or written
 * (contract §5.4): every deadline compares the DB clock with a DB-written timestamp, never the app clock.
 * - `stateEntered`: also the `booting` anchor (the claim's own transaction wrote it; completing the claim never moves it).
 * - `lastChunk`: since `import_progress.last`; null before the first chunk (the copy-stall clock then uses `stateEntered`).
 */
export interface ReverseMoveAges {
    created: number;
    stateEntered: number;
    commitSent: number | null;
    lastChunk: number | null;
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
    /** DB-clock text of the last state change; claimStale and retries never move it. */
    stateEnteredAt: string;
    /** DB-clock text, set by `checking → flipping`: the Worker commit may have been sent. Never cleared by the app. */
    commitSentAt: string | null;
    createdAt: string;
    /** Opaque PostgreSQL timestamp text, preserving microseconds for CAS. */
    updatedAt: string;
    /** DB-clock ages at the moment this copy was read or written (contract §5.4). */
    ages: ReverseMoveAges;
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
/** The ISO 8601 text `to_jsonb(timestamptz)` writes; anything else (a hand edit) never breaks a read, it just has no age. */
const ISO_TEXT = `'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?([+-][0-9]{2}(:[0-9]{2})?|Z)$'`;
/** Every read and RETURNING: timestamps as PostgreSQL text (CAS tokens) plus the DB-clock ages of §5.4. */
function columnsOf(alias = ''): SQL {
    const a = alias ? `${alias}.` : '';
    const age = (anchor: string) => `EXTRACT(EPOCH FROM clock_timestamp() - ${anchor})::float8`;
    return sql.raw(`${a}*, ${a}state_entered_at::text AS state_entered_at, ${a}commit_sent_at::text AS commit_sent_at, `
        + `${a}created_at::text AS created_at, ${a}updated_at::text AS updated_at, `
        + `${age(`${a}created_at`)} AS age_created, ${age(`${a}state_entered_at`)} AS age_state_entered, `
        + `${age(`${a}commit_sent_at`)} AS age_commit_sent, `
        + `CASE WHEN ${a}import_progress->>'last' ~ ${ISO_TEXT} THEN ${age(`(${a}import_progress->>'last')::timestamptz`)} END AS age_last_chunk`);
}
const COLUMNS = columnsOf();
const HOLDING = sql.raw(`state NOT IN ('committed', 'failed_reopened')`);
const STAMP = sql`GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')`;
const json = (value: unknown) => sql`(${JSON.stringify(value)}::text)::jsonb`;

function rows(result: unknown): Record<string, unknown>[] {
    return (Array.isArray(result) ? result : (result as { rows?: Record<string, unknown>[] })?.rows) ?? [];
}
const int = (value: unknown) => value == null ? null : Number(value);
const seconds = (value: unknown) => value == null ? null : Number(value);
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
        stateEnteredAt: String(r.state_entered_at), commitSentAt: r.commit_sent_at == null ? null : String(r.commit_sent_at),
        createdAt: String(r.created_at), updatedAt: String(r.updated_at),
        ages: { created: Number(r.age_created), stateEntered: Number(r.age_state_entered),
            commitSent: seconds(r.age_commit_sent), lastChunk: seconds(r.age_last_chunk) },
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

/**
 * Whether this database has 0012. Production (and the forward suites' schemas) do not: every reader of the table OUTSIDE
 * the reverse machine (forward create, receipts, select, progress, summary, the open trigger) calls this first and treats
 * an absent table as "no reverse move" (contract §3.4). Its own statement: a missing relation fails at parse time, and a
 * failed statement would abort the caller's transaction.
 */
export async function reverseMovesTablePresent(db: PlacementExecutor): Promise<boolean> {
    return rows(await db.execute(sql`SELECT to_regclass('public.ezil_compute_reverse_moves') IS NOT NULL AS present`))[0]?.present === true;
}

/** Whether a reverse move holds the computer. Called by the FORWARD create after its insert. A
 * database without 0012 has no reverse move by definition (`reverseMovesTablePresent`). */
export async function reverseMoveHolds(tx: PlacementExecutor, computerId: string): Promise<boolean> {
    if (!(await reverseMovesTablePresent(tx))) return false;
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
        && Number.isSafeInteger(boot.leaseEpoch) && boot.leaseEpoch >= 1
        && typeof boot.region === 'string' && AWS_REGION_PATTERN.test(boot.region) && VOLUME.test(boot.volumeId)
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

/** Bounds of the lane O / lane A listings (contract §7, G4). */
export const REVERSE_SNAPSHOT_LIST_MAX = 10;
export const REVERSE_RETENTION_LIST_MAX = 100;
/**
 * `last_error` values that mark a committed row's snapshot execution as spent (contract §3.4, §7.1, r4): `snapshot_failed`
 * (FAILED, TIMED_OUT or ABORTED) and `snapshot_receipt_invalid` (SUCCEEDED with a receipt that fails validation). The
 * execution name is spent too, so the sweep never retries it; the row leaves the sweep's queue and stays on the
 * `snapshot_missing` listing until an operator records a snapshot by hand.
 */
export const REVERSE_SNAPSHOT_SPENT_REASONS = ['snapshot_failed', 'snapshot_receipt_invalid'] as const;
export type ReverseSnapshotSpentReason = (typeof REVERSE_SNAPSHOT_SPENT_REASONS)[number];
const SPENT = sql.raw(`(${REVERSE_SNAPSHOT_SPENT_REASONS.map(r => `'${r}'`).join(', ')})`);
const clamp = (limit: number, max: number) => Number.isFinite(limit) ? Math.max(0, Math.min(max, Math.trunc(limit))) : 0;

/** Clock rule (contract §5.4): the store has no app clock. Every timestamp it writes is PostgreSQL's, and `ages` are computed by it. */
export function createProviderReverseStore(db: PlacementExecutor) {
    const readById = async (id: string) => one(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_reverse_moves WHERE id = ${id}::uuid`));
    const readByComputer = async (computerId: string) => one(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_reverse_moves
        WHERE computer_id = ${computerId}::uuid ORDER BY ezil_compute_reverse_moves.created_at DESC, id DESC LIMIT 1`));
    const readActiveByComputer = async (computerId: string) => one(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_reverse_moves
        WHERE computer_id = ${computerId}::uuid AND ${HOLDING}`));
    /**
     * The newest NON-committed row (in flight or failed) whose export boot claimed exactly this placement generation,
     * lease epoch and data volume. The receipts path keys its export-boot mode on this (contract §5.2):
     * - a released (failed) row still keeps its own boot out of RUNNING, and the same row's next boot (N+2/E+2) never matches;
     * - a committed row never matches: the flip deleted that placement row, so a later aws-ec2 row (a forward move onto a
     *   fresh volume) can reach the same counters and must boot normally. The volume match excludes it twice over.
     */
    const readByExportBoot = async (computerId: string, placementGeneration: number, leaseEpoch: number, volumeId: string) => {
        if (!Number.isSafeInteger(placementGeneration) || !Number.isSafeInteger(leaseEpoch) || !VOLUME.test(volumeId)) refuse('invalid_input');
        return one(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_reverse_moves
            WHERE computer_id = ${computerId}::uuid AND state <> 'committed'
              AND export_boot @> jsonb_build_object('placementGeneration', ${placementGeneration}::int, 'leaseEpoch', ${leaseEpoch}::int,
                'volumeId', ${volumeId}::text)
            ORDER BY ezil_compute_reverse_moves.created_at DESC, id DESC LIMIT 1`));
    };
    const legal = (from: ReverseMoveState, to: ReverseMoveState) => REVERSE_MOVE_TRANSITIONS[from]?.includes(to) ?? false;
    /** One compare-and-swap write; zero rows is a lost race, never retried here. */
    async function cas(expected: ComputeReverseMove, to: ReverseMoveState, set: SQL): Promise<ComputeReverseMove> {
        const entered = to === expected.state ? sql`state_entered_at` : sql`clock_timestamp()`;
        const updated = one(await db.execute(sql`UPDATE public.ezil_compute_reverse_moves SET state = ${to}, ${set},
            state_entered_at = ${entered}, updated_at = ${STAMP}
            WHERE id = ${expected.id}::uuid AND state = ${expected.state} AND updated_at::text = ${expected.updatedAt}
            RETURNING ${COLUMNS}`));
        return updated ?? refuse('lost_race');
    }
    /**
     * Fleet-wide rows in `booting` … `flipping` (contract §5.1.1 step 5b). A plain count: `admitExportBoot` runs it under the
     * admission lock, which serialises every claim, so two claims never both see a free slot.
     */
    const countHostBound = async (): Promise<number> => {
        const states = sql.join(REVERSE_MOVE_HOST_BOUND.map(s => sql`${s}`), sql`, `);
        const n = rows(await db.execute(sql`/* reverse:count-host-bound */ SELECT count(*)::int AS n
            FROM public.ezil_compute_reverse_moves WHERE state IN (${states})`))[0]?.n;
        if (!Number.isSafeInteger(Number(n))) throw new Error('reverse move count returned no count');
        return Number(n);
    };
    return {
        readById, readByComputer, readActiveByComputer, readByExportBoot, countHostBound,
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
                || held.region !== boot.region || held.volumeId !== boot.volumeId || held.claimedAt !== boot.claimedAt || !keeps('jobId') || !keeps('instanceId') || !keeps('fsUuid')) {
                refuse('illegal_transition');
            }
            return cas(expected, 'booting', sql`export_boot = ${json(boot)}`);
        },
        /**
         * `booting→exporting` (host enrolled), `copying→checking` (every chunk imported), `checking→flipping`. Resets attempts.
         * `checking→flipping` is the point of no return: it sets `commit_sent_at` from the DB clock, and the caller writes it
         * in the locked transaction that re-checked the entitlement, BEFORE sending the Worker commit (contract §5.5).
         */
        async advance(expected: ComputeReverseMove, to: ReverseMoveState): Promise<ComputeReverseMove> {
            if (ADVANCE[expected.state] !== to || !legal(expected.state, to)
                || (to === 'exporting' && !expected.exportBoot?.instanceId) || (to === 'checking' && !importComplete(expected))) refuse('illegal_transition');
            return cas(expected, to, to === 'flipping' ? sql`attempts = 0, last_error = NULL, commit_sent_at = clock_timestamp()` : sql`attempts = 0, last_error = NULL`);
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
        /**
         * Chunks the Worker verified and stored (contract §4 pull). Idempotent per index; progress resets attempts.
         * `first`/`last` are the DB clock (`statement_timestamp()`, ISO text): `last` is the copy-stall anchor (§5.4) and never
         * moves back; `first` is kept for the same archive. The app clock never reaches this column.
         */
        async recordImportProgress(expected: ComputeReverseMove, indices: readonly number[]): Promise<ComputeReverseMove> {
            const head = expected.exportHead;
            if (expected.state !== 'copying' || !head) refuse('illegal_transition');
            if (!indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= head!.chunks.length)) refuse('invalid_input');
            const previous = expected.importProgress?.archiveSha256 === head!.sha256 ? expected.importProgress : null;
            const bitmap = previous?.bitmap ?? '0'.repeat(BITMAP_HEX);
            const fresh = [...new Set(indices)].filter(i => !bitmapHas(bitmap, i));
            if (!fresh.length) return expected;
            const sha = head!.sha256;
            const bytes = (previous?.bytes ?? 0) + fresh.reduce((sum, i) => sum + head!.chunks[i]!.size, 0);
            const same = sql`import_progress->>'archiveSha256' = ${sha}::text`;
            const lastBefore = sql`CASE WHEN ${same} AND import_progress->>'last' ~ ${sql.raw(ISO_TEXT)} THEN (import_progress->>'last')::timestamptz END`;
            return cas(expected, 'copying', sql`import_progress = jsonb_build_object('bitmap', ${bitmapSet(bitmap, fresh)}::text,
                'bytes', ${bytes}::bigint, 'archiveSha256', ${sha}::text,
                'first', CASE WHEN ${same} AND jsonb_typeof(import_progress->'first') = 'string' THEN import_progress->'first'
                    ELSE to_jsonb(statement_timestamp()) END,
                'last', to_jsonb(GREATEST(${lastBefore}, statement_timestamp()))), attempts = 0, last_error = NULL`);
        },
        /**
         * One more bounded retry in the current state; `exhausted` (nothing written) means the caller must compensate and `fail`.
         * In `flipping` it is never exhausted (attempts saturate at 5): that state is bounded by `commit_sent_at` + 30 min, and
         * its only failure is `failed_needs_operator('flip_stuck')` (contract §5.4).
         */
        async recordRetry(expected: ComputeReverseMove, reason: string): Promise<{ move: ComputeReverseMove; exhausted: boolean }> {
            if (!REVERSE_MOVE_IN_FLIGHT.includes(expected.state)) refuse('illegal_transition');
            if (!REASON.test(reason)) refuse('invalid_input');
            const flipping = expected.state === 'flipping';
            if (!flipping && expected.attempts >= REVERSE_MOVE_MAX_ATTEMPTS) return { move: expected, exhausted: true };
            const attempts = Math.min(expected.attempts + 1, REVERSE_MOVE_MAX_ATTEMPTS);
            return { move: await cas(expected, expected.state, sql`attempts = ${attempts}::int, last_error = ${reason}`), exhausted: false };
        },
        /**
         * In-flight → `failed_reopened` | `failed_needs_operator`; an operator releases `failed_needs_operator` → `failed_reopened`.
         * `failed_reopened` is refused once `commit_sent_at` is set (the 0012 CHECK refuses it too): an operator who proved
         * the commit never landed clears `commit_sent_at` by hand first (runbook `clear_commit_sent`, contract §5.5.1).
         */
        async fail(expected: ComputeReverseMove, to: ReverseMoveFailure, reason: string): Promise<ComputeReverseMove> {
            if (!legal(expected.state, to) || (to === 'failed_reopened' && expected.commitSentAt !== null)) refuse('illegal_transition');
            if (!REASON.test(reason)) refuse('invalid_input');
            return cas(expected, to, sql`last_error = ${reason}`);
        },
        /**
         * `flipping→committed`, in the placement flip's transaction: the AWS volume is retained 14 days on this row (D21, R11);
         * the D21 snapshot is recorded after (`recordSnapshot`). An operator may also finish a stuck flip from
         * `failed_needs_operator`, only when `commit_sent_at` is set.
         */
        async finish(expected: ComputeReverseMove, retained: { awsVolumeId: string; awsFsUuid: string | null; awsSnapshotId: string | null }): Promise<ComputeReverseMove> {
            if (!legal(expected.state, 'committed') || expected.commitSentAt === null) refuse('illegal_transition');
            if (!VOLUME.test(retained.awsVolumeId) || (retained.awsFsUuid !== null && !UUID.test(retained.awsFsUuid))
                || (retained.awsSnapshotId !== null && !SNAPSHOT.test(retained.awsSnapshotId))) refuse('invalid_input');
            return cas(expected, 'committed', sql`aws_volume_id = ${retained.awsVolumeId}, aws_fs_uuid = ${retained.awsFsUuid}::uuid,
                aws_snapshot_id = ${retained.awsSnapshotId}, retain_until = clock_timestamp() + make_interval(days => ${REVERSE_MOVE_RETENTION_DAYS}::int),
                attempts = 0, last_error = NULL`);
        },
        /**
         * D21 snapshot of the retained volume, taken after the flip (lane O, contract §7). Committed rows only; set once.
         * The compare-and-swap is on `aws_snapshot_id IS NULL` (not `updated_at`), so it is idempotent: replaying the SAME id
         * after a lost response returns the row; a DIFFERENT id never replaces a recorded one (`lost_race`, or
         * `illegal_transition` when the caller's copy already shows it). `state_entered_at` (the commit time) never moves.
         */
        async recordSnapshot(expected: ComputeReverseMove, awsSnapshotId: string): Promise<ComputeReverseMove> {
            if (expected.state !== 'committed') refuse('illegal_transition');
            if (!SNAPSHOT.test(awsSnapshotId)) refuse('invalid_input');
            if (expected.awsSnapshotId !== null) return expected.awsSnapshotId === awsSnapshotId ? expected : refuse('illegal_transition');
            const written = one(await db.execute(sql`UPDATE public.ezil_compute_reverse_moves SET aws_snapshot_id = ${awsSnapshotId}, updated_at = ${STAMP}
                WHERE id = ${expected.id}::uuid AND state = 'committed' AND aws_snapshot_id IS NULL RETURNING ${COLUMNS}`));
            if (written) return written;
            const current = await readById(expected.id);
            return current?.state === 'committed' && current.awsSnapshotId === awsSnapshotId ? current : refuse('lost_race');
        },
        /**
         * Takes a committed row whose snapshot execution is spent out of the sweep's queue (contract §7.1, r4), so spent rows
         * never fill `listUnsnapshotted` and starve newer commits. A CAS on `aws_snapshot_id IS NULL AND last_error IS NULL`
         * (not `updated_at`): the first reason wins and a replay is free. After a write that matched nothing it re-reads; a
         * committed row that already left the queue (snapshotted, or spent) is returned unchanged. Writes only `last_error`
         * and `updated_at`: never `state_entered_at`, `retain_until` or `aws_snapshot_id`. A committed row's `last_error` is
         * never shown to the user (§6.1).
         */
        async markSnapshotSpent(expected: ComputeReverseMove, reason: ReverseSnapshotSpentReason): Promise<ComputeReverseMove> {
            if (expected.state !== 'committed') refuse('illegal_transition');
            if (!(REVERSE_SNAPSHOT_SPENT_REASONS as readonly string[]).includes(reason)) refuse('invalid_input');
            const leftQueue = (m: ComputeReverseMove) => m.awsSnapshotId !== null
                || (REVERSE_SNAPSHOT_SPENT_REASONS as readonly (string | null)[]).includes(m.lastError);
            if (leftQueue(expected)) return expected;
            const written = one(await db.execute(sql`UPDATE public.ezil_compute_reverse_moves SET last_error = ${reason}, updated_at = ${STAMP}
                WHERE id = ${expected.id}::uuid AND state = 'committed' AND aws_snapshot_id IS NULL AND last_error IS NULL RETURNING ${COLUMNS}`));
            if (written) return written;
            const current = await readById(expected.id);
            return current?.state === 'committed' && leftQueue(current) ? current : refuse('lost_race');
        },
        /**
         * Committed rows with no D21 snapshot yet, oldest commit first (`state_entered_at` of a committed row is its commit
         * time), at most `REVERSE_SNAPSHOT_LIST_MAX`. `committedForSeconds` (DB clock) lists only rows committed at least that
         * long ago. Rows marked spent (`markSnapshotSpent`) are left out unless `includeSpent`: the sweep's snapshot step calls
         * `listUnsnapshotted(3)`, the `snapshot_missing` listing `listUnsnapshotted(10, 3600, {includeSpent: true})`. A plain
         * read: starting the snapshot is idempotent by its execution name (contract §7), so two sweeps never need a row lock.
         * A purged row (`retain_until IS NULL` on a committed row: runbook `operator_purged`, contract §7, r5) is in neither
         * listing: its volume is gone, so there is nothing left to snapshot or to alert on.
         */
        async listUnsnapshotted(limit: number, committedForSeconds = 0, options: { includeSpent?: boolean } = {}): Promise<ComputeReverseMove[]> {
            const age = Number.isFinite(committedForSeconds) ? Math.max(0, Math.trunc(committedForSeconds)) : 0;
            const spent = options.includeSpent === true ? sql`` : sql` AND (last_error IS NULL OR last_error NOT IN ${SPENT})`;
            return rows(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_reverse_moves
                WHERE state = 'committed' AND aws_snapshot_id IS NULL AND retain_until IS NOT NULL${spent}
                  AND state_entered_at <= clock_timestamp() - make_interval(secs => ${age}::int)
                ORDER BY ezil_compute_reverse_moves.state_entered_at, id LIMIT ${clamp(limit, REVERSE_SNAPSHOT_LIST_MAX)}`)).map(parse);
        },
        /** Committed rows whose 14-day retention has ended (`retain_until < clock_timestamp()`), oldest first, at most
         * `REVERSE_RETENTION_LIST_MAX`. Read-only: deletion is an operator step outside the app (rule R11, contract §7).
         * The purge marker is `retain_until = NULL` (runbook `operator_purged`, r5), so a purged row leaves this listing and
         * more than 100 expired rows never hide the newer ones behind already-purged ones. */
        async listRetentionExpired(limit: number): Promise<ComputeReverseMove[]> {
            return rows(await db.execute(sql`SELECT ${COLUMNS} FROM public.ezil_compute_reverse_moves
                WHERE state = 'committed' AND retain_until < clock_timestamp()
                ORDER BY retain_until, id LIMIT ${clamp(limit, REVERSE_RETENTION_LIST_MAX)}`)).map(parse);
        },
        /**
         * In-flight rows untouched for 30 s (DB clock); claiming bumps `updated_at` only (the caller re-reads), never
         * `state_entered_at`. 🔴 Rows past `requested` (`booting` … `flipping`) come first, then `updated_at, id` (contract §5.4,
         * r5): at most `REVERSE_MOVE_MAX_ACTIVE` rows hold a host, so every claimable one is driven by the pass, and
         * `requested` rows share the rest. Ordering by `updated_at` alone let old `requested` rows starve a copy.
         */
        async claimStale(limit: number): Promise<ComputeReverseMove[]> {
            return rows(await db.execute(sql`WITH stale AS (
                SELECT id FROM public.ezil_compute_reverse_moves
                WHERE state IN ('requested', 'booting', 'exporting', 'copying', 'checking', 'flipping')
                  AND updated_at < clock_timestamp() - interval '30 seconds'
                ORDER BY (state = 'requested'), updated_at, id LIMIT ${clamp(limit, 10)} FOR UPDATE SKIP LOCKED
            ) UPDATE public.ezil_compute_reverse_moves m SET updated_at = GREATEST(clock_timestamp(), m.updated_at + interval '1 microsecond')
              FROM stale WHERE m.id = stale.id RETURNING ${columnsOf('m')}`)).map(parse);
        },
    };
}
export type ProviderReverseStore = ReturnType<typeof createProviderReverseStore>;
