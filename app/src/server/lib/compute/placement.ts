/**
 * Per-computer placement — the SINGLE WRITER of `ezil_computer_placements` and
 * `ezil_compute_usage` (docs/AWS-COMPUTERS.md R8, R13, C-2, C-3).
 *
 * 🔴 No other file may name either table. `placement-writer.test.ts` scans
 * the source tree and fails on any other mention, reads included, so every
 * statement against these tables is reviewable in this one file.
 *
 * The tables are NOT in production yet (`docs/aws-computers/sql/README.md`).
 * Nothing calls into this module while `EZIL_AWS_COMPUTERS_ENABLED` is unset:
 * `select.ts` short-circuits to Cloudflare before any read.
 *
 * ## Rules
 *
 * - **Read.** No row means `cloudflare` + `r2`. More than one row, or any
 *   value outside the enums below (NULL store included), throws
 *   `PlacementIntegrityError`, which maps to tRPC `PRECONDITION_FAILED`.
 * - **Create** takes `pg_advisory_xact_lock` on the computer, then refuses if
 *   any row exists. There is no UNIQUE index (the hosted grammar has none),
 *   so the lock is the only thing that stops two creators.
 * - **Transitions** are compare-and-swap:
 *   `UPDATE … WHERE computer_id = $1 AND generation = $g AND lease_epoch = $e
 *   AND state = $from RETURNING`, preceded in the same transaction by a
 *   duplicate check: a second row for the computer, whatever its keys,
 *   refuses the transition. Zero rows is a lost race, never retried here.
 * - **Leasing** (`STOPPED → LEASED`, `lease_epoch + 1`) and AWS creation need
 *   an `AdmissionLock`, which only `withAdmission` can mint, for the same
 *   transaction (C-3: admission runs under one global advisory lock).
 *
 * ## Locks
 *
 * Transaction-scoped only (`pg_advisory_xact_lock`): session locks do not
 * survive Supabase's transaction pooler. Lock order is always global
 * admission lock first, then the per-computer lock. Namespaces differ from
 * the migration engine `(1702521196, …)`, `apply-os-access-migration.mjs`
 * `(20260924, …)` and `local-supabase.ts` `(55321, …)`.
 *
 * 🔴 Counter reads must run at READ COMMITTED, AFTER the lock statement. At
 * REPEATABLE READ the snapshot is taken when the lock statement starts —
 * before it blocks — so a waiter would read counts from before the holder's
 * commit and admit twice. This module never issues `SET TRANSACTION`.
 */

import { TRPCError } from '@trpc/server';
import { sql, type SQL } from 'drizzle-orm';

// ── Enums ────────────────────────────────────────────────────────────────

export const PLACEMENT_PROVIDERS = ['cloudflare', 'aws-ec2'] as const;
export type PlacementProvider = (typeof PLACEMENT_PROVIDERS)[number];

/** `r2` / `s3`: checkpointed object store (Cloudflare). `ebs`: retained data volume (AWS, R3). */
export const WORKSPACE_STORES = ['r2', 's3', 'ebs'] as const;
export type WorkspaceStore = (typeof WORKSPACE_STORES)[number];

/** C-2 pinned pairs: `cloudflare` → `r2` | `s3`, `aws-ec2` → `ebs`. Anything else fails closed. */
const STORES_FOR_PROVIDER: Record<PlacementProvider, readonly WorkspaceStore[]> = { cloudflare: ['r2', 's3'], 'aws-ec2': ['ebs'] };
/** The store a newly created row records. */
const DEFAULT_STORE: Record<PlacementProvider, WorkspaceStore> = { cloudflare: 'r2', 'aws-ec2': 'ebs' };
/**
 * The lease_epoch a newly created row records. An AWS provision IS the
 * computer's first lease: its intent carries leaseEpoch 1 and the host writes
 * disk-marker epoch 1 (C-4). The row must say 1 too, so the first wake leases
 * 2. A row left at 0 would lease 1 on the first wake, and the host guard
 * refuses a lease epoch that is not above the marker's: the computer could
 * never wake. Cloudflare rows never lease and stay at 0.
 */
const INITIAL_LEASE_EPOCH: Record<PlacementProvider, 0 | 1> = { cloudflare: 0, 'aws-ec2': 1 };

/** C-3. Stage B's "terminated" is the end of a slot, not a stored state. */
export const PLACEMENT_STATES = [
    'PROVISIONING', 'STOPPED', 'LEASED', 'STARTING', 'MOUNTING', 'RUNNING', 'DRAINING', 'STOPPING',
    'UNCONFIRMED', 'RECOVERING',
    'RETIRING', 'RETIRED', 'PURGE_ELIGIBLE',
    'WARMING', 'READY', 'CLAIMED',
] as const;
export type PlacementState = (typeof PLACEMENT_STATES)[number];

/**
 * States that may have a live instance, counted against `AWS_MAX_RUNNING`.
 * Deliberately everything except the three states that cannot: an
 * UNCONFIRMED or RECOVERING computer may well still be running, and counting
 * it is the safe direction.
 */
export const RUNNING_CLASS_STATES: readonly PlacementState[] = PLACEMENT_STATES.filter(
    (s) => s !== 'STOPPED' && s !== 'RETIRED' && s !== 'PURGE_ELIGIBLE',
);

/**
 * Legal transitions for `transitionPlacement`. C-3 gives paths, not a full
 * edge list; this is the module's reading of it (reported as a contract gap):
 * every active state may fall to UNCONFIRMED ("every error is recorded on
 * UNCONFIRMED"), a lease may lapse back to STOPPED before start, and only a
 * STOPPED computer is retired. A provision may land RUNNING (first boot).
 * `STOPPED → LEASED` is NOT here: it exists only
 * through `leasePlacement`, under the admission lock.
 */
export const PLACEMENT_TRANSITIONS: Readonly<Record<PlacementState, readonly PlacementState[]>> = {
    // The infra provision launches AND boots the instance, so its receipt lands RUNNING
    // (first open boots straight in). STOPPED stays for a provision that ends stopped.
    PROVISIONING: ['RUNNING', 'STOPPED', 'UNCONFIRMED'],
    STOPPED: ['RETIRING'],
    LEASED: ['STARTING', 'STOPPED', 'UNCONFIRMED'],
    STARTING: ['MOUNTING', 'UNCONFIRMED'],
    MOUNTING: ['RUNNING', 'UNCONFIRMED'],
    RUNNING: ['DRAINING', 'UNCONFIRMED'],
    DRAINING: ['STOPPING', 'UNCONFIRMED'],
    STOPPING: ['STOPPED', 'UNCONFIRMED'],
    UNCONFIRMED: ['RECOVERING'],
    RECOVERING: ['STOPPED', 'UNCONFIRMED'],
    RETIRING: ['RETIRED', 'UNCONFIRMED'],
    RETIRED: ['PURGE_ELIGIBLE'],
    PURGE_ELIGIBLE: [],
    WARMING: ['READY', 'UNCONFIRMED'],
    READY: ['CLAIMED', 'UNCONFIRMED'],
    CLAIMED: ['UNCONFIRMED'],
};

// ── Errors ───────────────────────────────────────────────────────────────

export type PlacementIntegrityReason =
    | 'duplicate_placement'
    | 'unknown_provider'
    | 'unknown_store'
    | 'unknown_state'
    | 'invalid_row';

/** A placement that cannot be trusted. Never "fall back to Cloudflare". */
export class PlacementIntegrityError extends Error {
    constructor(
        readonly reason: PlacementIntegrityReason,
        readonly computerId: string,
    ) {
        super(`placement_integrity:${reason}`);
        this.name = 'PlacementIntegrityError';
    }
}

/** The caller is not the placement's recorded owner. */
export class PlacementOwnerError extends Error {
    constructor(readonly computerId: string) {
        super('placement_not_owned');
        this.name = 'PlacementOwnerError';
    }
}

/** Same answer the routers give for another user's computer: NOT_FOUND, never a distinguishing FORBIDDEN. */
export function placementOwnerTrpcError(error: PlacementOwnerError): TRPCError {
    return new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found.', cause: error });
}

/** Wire mapping: a typed refusal, never a 500 and never a silent default. */
export function placementTrpcError(error: PlacementIntegrityError): TRPCError {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error });
}

// ── Database surface ─────────────────────────────────────────────────────

/** The narrowest surface: drizzle's `execute`. Satisfied by `ctx.db` and any transaction. */
export interface PlacementExecutor {
    execute(query: SQL): Promise<unknown>;
}

/** `execute` plus a READ COMMITTED transaction (drizzle's default; no config is ever passed). */
export interface PlacementDb extends PlacementExecutor {
    transaction<T>(fn: (tx: PlacementExecutor) => Promise<T>): Promise<T>;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    return ((result as { rows?: Record<string, unknown>[] } | null)?.rows ?? []) as Record<string, unknown>[];
}

/** Advisory-lock namespaces (`pg_advisory_xact_lock(int4, int4)`). ASCII "EZpl" / "EZad". */
export const PLACEMENT_LOCK_NAMESPACE = 1163555948;
export const ADMISSION_LOCK_NAMESPACE = 1163551076;

// ── Records ──────────────────────────────────────────────────────────────

export interface Placement {
    computerId: string;
    /** Set once at creation from the authenticated session; never from `ezil_computers`. */
    ownerUserId: string;
    provider: PlacementProvider;
    store: WorkspaceStore;
    generation: number;
    leaseEpoch: number;
    state: PlacementState;
    region: string | null;
    zoneId: string | null;
    instanceId: string | null;
    instanceType: string | null;
    volumeId: string | null;
    fsUuid: string | null;
    tunnelId: string | null;
    enrollNonceHash: string | null;
    enrollExpiresAt: Date | null;
    leaseUntil: Date | null;
    presenceAt: Date | null;
    updatedAt: Date;
}

/** What a reader acts on. `record` is null for the no-row default. */
export interface ResolvedPlacement {
    provider: PlacementProvider;
    store: WorkspaceStore;
    record: Placement | null;
}

export const DEFAULT_PLACEMENT: ResolvedPlacement = Object.freeze({ provider: 'cloudflare', store: 'r2', record: null });

/** Columns a transition may set, mapped to their SQL names and casts. Fixed: never caller-supplied. */
const MUTABLE_COLUMNS = {
    region: ['region', 'text'],
    zoneId: ['zone_id', 'text'],
    instanceId: ['instance_id', 'text'],
    instanceType: ['instance_type', 'text'],
    volumeId: ['volume_id', 'text'],
    fsUuid: ['fs_uuid', 'uuid'],
    tunnelId: ['tunnel_id', 'text'],
    enrollNonceHash: ['enroll_nonce_hash', 'text'],
    enrollExpiresAt: ['enroll_expires_at', 'timestamptz'],
    leaseUntil: ['lease_until', 'timestamptz'],
    presenceAt: ['presence_at', 'timestamptz'],
} as const;
export type PlacementFields = Partial<{
    [K in keyof typeof MUTABLE_COLUMNS]: (typeof MUTABLE_COLUMNS)[K][1] extends 'timestamptz' ? Date | null : string | null;
}>;

const SELECT_COLUMNS = sql.raw(
    [
        'computer_id::text AS computer_id', 'owner_user_id::text AS owner_user_id', 'provider', 'workspace_store', 'generation::text AS generation',
        'lease_epoch::text AS lease_epoch', 'state', 'region', 'zone_id', 'instance_id', 'instance_type',
        'volume_id', 'fs_uuid::text AS fs_uuid', 'tunnel_id', 'enroll_nonce_hash', 'enroll_expires_at',
        'lease_until', 'presence_at', 'updated_at',
    ].join(', '),
);

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
    return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function counter(value: unknown): number | null {
    const text = typeof value === 'number' || typeof value === 'bigint' ? String(value) : value;
    if (typeof text !== 'string' || !/^\d+$/.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : null;
}

function timestamp(value: unknown): Date | null | undefined {
    if (value === null || value === undefined) return null;
    const d = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
    return d && Number.isFinite(d.getTime()) ? d : undefined;
}

function nullableText(value: unknown): string | null | undefined {
    if (value === null || value === undefined) return null;
    return typeof value === 'string' ? value : undefined;
}

/** Parse one row strictly. Every unknown or malformed value fails closed. */
export function parsePlacementRow(row: Record<string, unknown>, computerId: string): Placement {
    const fail = (reason: PlacementIntegrityReason): never => {
        throw new PlacementIntegrityError(reason, computerId);
    };
    const provider = oneOf(PLACEMENT_PROVIDERS, row.provider) ? row.provider : fail('unknown_provider');
    const store = oneOf(WORKSPACE_STORES, row.workspace_store) ? row.workspace_store : fail('unknown_store');
    if (!STORES_FOR_PROVIDER[provider].includes(store)) fail('unknown_store');
    const state = oneOf(PLACEMENT_STATES, row.state) ? row.state : fail('unknown_state');
    const generation = counter(row.generation) ?? fail('invalid_row');
    const leaseEpoch = counter(row.lease_epoch) ?? fail('invalid_row');
    if (typeof row.computer_id !== 'string' || row.computer_id.toLowerCase() !== computerId.toLowerCase()) fail('invalid_row');
    const text = (key: string) => {
        const v = nullableText(row[key]);
        return v === undefined ? fail('invalid_row') : v;
    };
    const time = (key: string) => {
        const v = timestamp(row[key]);
        return v === undefined ? fail('invalid_row') : v;
    };
    const updatedAt = time('updated_at') ?? fail('invalid_row');
    const ownerUserId = typeof row.owner_user_id === 'string' && UUID.test(row.owner_user_id) ? row.owner_user_id.toLowerCase() : fail('invalid_row');
    return {
        computerId: row.computer_id as string, ownerUserId, provider, store, generation, leaseEpoch, state,
        region: text('region'), zoneId: text('zone_id'), instanceId: text('instance_id'),
        instanceType: text('instance_type'), volumeId: text('volume_id'), fsUuid: text('fs_uuid'),
        tunnelId: text('tunnel_id'), enrollNonceHash: text('enroll_nonce_hash'),
        enrollExpiresAt: time('enroll_expires_at'), leaseUntil: time('lease_until'), presenceAt: time('presence_at'),
        updatedAt,
    };
}

// ── Read ─────────────────────────────────────────────────────────────────

async function selectRows(db: PlacementExecutor, computerId: string): Promise<Record<string, unknown>[]> {
    // LIMIT 2: enough to see a duplicate, never a scan.
    return rowsOf(
        await db.execute(sql`/* placement:read */ SELECT ${SELECT_COLUMNS}
            FROM public.ezil_computer_placements
            WHERE computer_id = ${computerId}::uuid
            LIMIT 2`),
    );
}

/** C-2 read rule. Throws `PlacementIntegrityError` rather than guessing. */
export async function readPlacement(db: PlacementExecutor, rawComputerId: string): Promise<ResolvedPlacement> {
    const computerId = canonicalId(rawComputerId);
    const rows = await selectRows(db, computerId);
    if (rows.length === 0) return DEFAULT_PLACEMENT;
    if (rows.length > 1) throw new PlacementIntegrityError('duplicate_placement', computerId);
    const record = parsePlacementRow(rows[0]!, computerId);
    return { provider: record.provider, store: record.store, record };
}

/** C-2 periodic duplicate check. Any result must alarm and closes admission. */
export async function findDuplicatePlacements(db: PlacementExecutor): Promise<{ computerId: string; rows: number }[]> {
    const rows = rowsOf(
        await db.execute(sql`/* placement:duplicates */ SELECT computer_id::text AS computer_id, count(*)::int AS rows
            FROM public.ezil_computer_placements
            GROUP BY computer_id
            HAVING count(*) > 1`),
    );
    return rows.map((r) => ({ computerId: String(r.computer_id), rows: Number(r.rows) }));
}

// ── Locks ────────────────────────────────────────────────────────────────

/**
 * Ids are uuids: Postgres compares them by value, so `A…` and `a…` are one
 * computer. Every id is lower-cased at this module's boundary, and the lock
 * key hashes the CANONICAL `::uuid::text` form — hashing the raw string gave
 * mixed-case creators two different locks and two rows (review, real PG 16).
 */
const canonicalId = (id: string) => id.toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown when a lock is taken outside READ COMMITTED (see module doc). */
export class PlacementIsolationError extends Error {
    constructor(readonly isolation: string) {
        super(`placement locks require READ COMMITTED, got ${isolation}`);
        this.name = 'PlacementIsolationError';
    }
}

/**
 * Both locks return the transaction's isolation level from the SAME
 * statement and refuse anything but READ COMMITTED: under REPEATABLE READ
 * (e.g. a role or database `default_transaction_isolation`) the reads after
 * the lock would use a snapshot from before it, and two admissions at the
 * cap both won (review, 20/20 on PG 16).
 */
function assertReadCommitted(result: unknown): void {
    const isolation = rowsOf(result)[0]?.isolation;
    if (isolation !== 'read committed') throw new PlacementIsolationError(String(isolation));
}

async function lockComputer(tx: PlacementExecutor, computerId: string): Promise<void> {
    assertReadCommitted(
        await tx.execute(
            sql`/* placement:lock-computer */ SELECT pg_advisory_xact_lock(${PLACEMENT_LOCK_NAMESPACE}::int4, hashtext(${computerId}::uuid::text)), current_setting('transaction_isolation') AS isolation`,
        ),
    );
}

declare const ADMISSION_BRAND: unique symbol;

/**
 * Proof that the global admission lock is held by THIS transaction. Minted
 * only inside `withAdmission`. Opaque: the transaction it belongs to is kept
 * in a module-private WeakMap, so a copied or hand-built object (even one
 * carrying the right transaction) is never accepted.
 */
export interface AdmissionLock {
    readonly [ADMISSION_BRAND]: true;
}

const MINTED_LOCKS = new WeakMap<object, PlacementExecutor>();

/** Private: the lock must be the first statement of a transaction this module opened. */
async function takeAdmissionLock(tx: PlacementExecutor): Promise<AdmissionLock> {
    assertReadCommitted(
        await tx.execute(
            sql`/* placement:lock-admission */ SELECT pg_advisory_xact_lock(${ADMISSION_LOCK_NAMESPACE}::int4, 0), current_setting('transaction_isolation') AS isolation`,
        ),
    );
    const lock = Object.freeze({}) as AdmissionLock;
    MINTED_LOCKS.set(lock, tx);
    return lock;
}

/**
 * The ONLY way to obtain an `AdmissionLock`: opens the transaction itself,
 * takes the global lock as its first statement, and hands both to `fn`.
 * There is no way to mint a lock on a non-transactional executor, where it
 * would be released as soon as the statement ended.
 */
export function withAdmission<T>(db: PlacementDb, fn: (tx: PlacementExecutor, lock: AdmissionLock) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => fn(tx, await takeAdmissionLock(tx)));
}

function assertAdmissionLock(tx: PlacementExecutor, lock: AdmissionLock): void {
    if (!lock || typeof lock !== 'object' || MINTED_LOCKS.get(lock) !== tx) {
        throw new Error('admission lock is not held by this transaction');
    }
}

// ── Create ───────────────────────────────────────────────────────────────

export interface CreatePlacementInput {
    computerId: string;
    /** The AUTHENTICATED session user. Recorded once; no later write changes it. */
    ownerUserId: string;
    provider: PlacementProvider;
    state: PlacementState;
    fields?: PlacementFields;
}

export type CreatePlacementResult = { ok: true; placement: Placement } | { ok: false; reason: 'placement_exists' };

async function createInTx(tx: PlacementExecutor, rawInput: CreatePlacementInput): Promise<CreatePlacementResult> {
    const input = { ...rawInput, computerId: canonicalId(rawInput.computerId), ownerUserId: canonicalId(rawInput.ownerUserId) };
    await lockComputer(tx, input.computerId);
    if ((await selectRows(tx, input.computerId)).length > 0) return { ok: false, reason: 'placement_exists' };
    const fields = input.fields ?? {};
    const keys = (Object.keys(MUTABLE_COLUMNS) as (keyof typeof MUTABLE_COLUMNS)[]).filter((k) => fields[k] !== undefined);
    const columns = ['computer_id', 'owner_user_id', 'provider', 'workspace_store', 'generation', 'lease_epoch', 'state', 'updated_at', ...keys.map((k) => MUTABLE_COLUMNS[k][0])];
    const values: SQL[] = [
        sql`${input.computerId}::uuid`,
        sql`${input.ownerUserId}::uuid`,
        sql`${input.provider}`,
        sql`${DEFAULT_STORE[input.provider]}`,
        sql`1`,
        sql.raw(String(INITIAL_LEASE_EPOCH[input.provider])),
        sql`${input.state}`,
        sql`now()`,
        ...keys.map((k) => valueSql(k, fields[k] ?? null)),
    ];
    const rows = rowsOf(
        await tx.execute(sql`/* placement:insert */ INSERT INTO public.ezil_computer_placements (${sql.raw(columns.join(', '))})
            VALUES (${sql.join(values, sql`, `)})
            RETURNING ${SELECT_COLUMNS}`),
    );
    if (rows.length !== 1) throw new PlacementIntegrityError('invalid_row', input.computerId);
    return { ok: true, placement: parsePlacementRow(rows[0]!, input.computerId) };
}

function valueSql(key: keyof typeof MUTABLE_COLUMNS, value: string | Date | null): SQL {
    const cast = MUTABLE_COLUMNS[key][1];
    const param = value instanceof Date ? value.toISOString() : value;
    return sql`${param}::${sql.raw(cast)}`;
}

/**
 * Create a Cloudflare placement row (e.g. a rollback record). AWS rows need
 * admission: use `createAwsPlacement`.
 */
export async function createPlacement(db: PlacementDb, input: CreatePlacementInput): Promise<CreatePlacementResult> {
    if (input.provider !== 'cloudflare') throw new Error('aws-ec2 placements are created only through admission');
    return db.transaction((tx) => createInTx(tx, input));
}

/** AWS creation, inside the admission transaction. Starts at PROVISIONING, generation 1, lease_epoch 1 (the provision is the first lease). */
export async function createAwsPlacement(
    tx: PlacementExecutor,
    lock: AdmissionLock,
    input: { computerId: string; ownerUserId: string; fields?: PlacementFields },
): Promise<CreatePlacementResult> {
    assertAdmissionLock(tx, lock);
    return createInTx(tx, { computerId: input.computerId, ownerUserId: input.ownerUserId, provider: 'aws-ec2', state: 'PROVISIONING', fields: input.fields });
}

// ── Transitions (CAS) ────────────────────────────────────────────────────

export interface CasExpectation {
    generation: number;
    leaseEpoch: number;
    state: PlacementState;
}

export type TransitionResult =
    | { ok: true; placement: Placement }
    | { ok: false; reason: 'cas_conflict' | 'illegal_transition' };

async function casInTx(
    tx: PlacementExecutor,
    rawComputerId: string,
    expected: CasExpectation,
    to: PlacementState,
    bump: { generation: 0 | 1; leaseEpoch: 0 | 1 },
    fields: PlacementFields,
    guard: { provider?: PlacementProvider; ownerUserId?: string } = {},
): Promise<TransitionResult> {
    const computerId = canonicalId(rawComputerId);
    // A duplicate whose keys do not match the CAS would let this writer win
    // while every reader fails closed. Refuse first, inside the transaction.
    if ((await selectRows(tx, computerId)).length > 1) throw new PlacementIntegrityError('duplicate_placement', computerId);
    const sets: SQL[] = [
        sql`state = ${to}`,
        sql`generation = generation + ${bump.generation}`,
        sql`lease_epoch = lease_epoch + ${bump.leaseEpoch}`,
        ...(Object.keys(MUTABLE_COLUMNS) as (keyof typeof MUTABLE_COLUMNS)[])
            .filter((k) => fields[k] !== undefined)
            .map((k) => sql`${sql.raw(MUTABLE_COLUMNS[k][0])} = ${valueSql(k, fields[k] ?? null)}`),
        sql`updated_at = now()`,
    ];
    const rows = rowsOf(
        await tx.execute(sql`/* placement:cas */ UPDATE public.ezil_computer_placements
            SET ${sql.join(sets, sql`, `)}
            WHERE computer_id = ${computerId}::uuid AND generation = ${expected.generation} AND lease_epoch = ${expected.leaseEpoch} AND state = ${expected.state}${guard.provider ? sql` AND provider = ${guard.provider}` : sql``}${guard.ownerUserId !== undefined ? sql` AND owner_user_id = ${canonicalId(guard.ownerUserId)}::uuid` : sql``}
            RETURNING ${SELECT_COLUMNS}`),
    );
    if (rows.length === 0) return { ok: false, reason: 'cas_conflict' };
    // Belt and braces behind the pre-read: throwing inside the transaction rolls a multi-row update back.
    if (rows.length > 1) throw new PlacementIntegrityError('duplicate_placement', computerId);
    return { ok: true, placement: parsePlacementRow(rows[0]!, computerId) };
}

/**
 * A USER-TRIGGERED C-3 transition, except leasing: open, stop, or the undo of a
 * failed start. `ownerUserId` is the AUTHENTICATED caller and is required: the
 * CAS also matches `owner_user_id`, so another user's placement never moves
 * (zero rows → `cas_conflict`). Zero rows otherwise means someone else moved first.
 */
export async function transitionPlacement(
    db: PlacementDb,
    input: { computerId: string; ownerUserId: string; expected: CasExpectation; to: PlacementState; fields?: PlacementFields },
): Promise<TransitionResult> {
    // Checked before anything else: a missing owner must never become an unguarded write.
    if (typeof input.ownerUserId !== 'string' || !UUID.test(input.ownerUserId)) throw new Error('transitionPlacement requires the caller ownerUserId');
    if (!PLACEMENT_TRANSITIONS[input.expected.state]?.includes(input.to)) return { ok: false, reason: 'illegal_transition' };
    return db.transaction((tx) =>
        casInTx(tx, input.computerId, input.expected, input.to, { generation: 0, leaseEpoch: 0 }, input.fields ?? {}, { ownerUserId: input.ownerUserId }),
    );
}

/**
 * RECONCILER ONLY: a C-3 transition with NO owner predicate, for the lifecycle
 * receipt path (execution results, EC2 observations), which moves a placement
 * whoever owns it. The same legal-edge table and CAS guards apply. A user-facing
 * path must never name it: `placement.test.ts` scans the user-path modules and
 * routers and fails if any of them does.
 */
export async function transitionPlacementAsReconciler(
    db: PlacementDb,
    input: { computerId: string; expected: CasExpectation; to: PlacementState; fields?: PlacementFields },
): Promise<TransitionResult> {
    if (!PLACEMENT_TRANSITIONS[input.expected.state]?.includes(input.to)) return { ok: false, reason: 'illegal_transition' };
    return db.transaction((tx) =>
        casInTx(tx, input.computerId, input.expected, input.to, { generation: 0, leaseEpoch: 0 }, input.fields ?? {}),
    );
}

/**
 * `STOPPED → LEASED`, reserving `lease_epoch + 1` (and `generation + 1` for a
 * replace or recovery, C-3). Only inside the admission transaction.
 */
export async function leasePlacement(
    tx: PlacementExecutor,
    lock: AdmissionLock,
    input: { computerId: string; ownerUserId: string; expected: { generation: number; leaseEpoch: number }; leaseUntil: Date; replace?: boolean },
): Promise<TransitionResult> {
    assertAdmissionLock(tx, lock);
    return casInTx(
        tx,
        input.computerId,
        { ...input.expected, state: 'STOPPED' },
        'LEASED',
        { generation: input.replace ? 1 : 0, leaseEpoch: 1 },
        { leaseUntil: input.leaseUntil },
        // Only the recorded owner's aws-ec2 row matches: a Cloudflare row is never leased under
        // AWS caps, and a re-keyed or re-inserted ezil_computers row cannot claim a placement.
        { provider: 'aws-ec2', ownerUserId: input.ownerUserId },
    );
}

// ── Admission reads ──────────────────────────────────────────────────────

export interface UsageRow {
    computerId: string;
    userId: string;
    startedAt: Date;
    stoppedAt: Date | null;
    egressBytes: number | null;
}

export interface AdmissionCounters {
    /** `ezil_computers.user_id` of the target, or null when no such computer exists. */
    targetOwnerId: string | null;
    /** `owner_user_id` of the target's placement, or null when it has none. Authoritative. */
    targetPlacementOwnerId: string | null;
    /** The target computer row is soft-deleted. */
    targetDeleted: boolean;
    /** Usage rows for the target metered to anyone but the caller. */
    targetForeignUsage: number;
    /** aws-ec2 placements in a running-class state, any user. */
    runningCount: number;
    /**
     * The same running-class rows, per region (only regions that have any). A
     * region absent here has none. Rows without a region are `runningUnplaced`
     * and count against EVERY region (the safe direction).
     */
    runningByRegion: Readonly<Record<string, number>>;
    runningUnplaced: number;
    /**
     * The user's OTHER aws-ec2 placements not yet PURGE_ELIGIBLE: counted by
     * `owner_user_id` (or usage metered to the user), never through
     * `ezil_computers`, so re-keying a computer row hides nothing.
     */
    userOtherAwsComputers: number;
    duplicates: { computerId: string; rows: number }[];
    /** Usage rows overlapping [monthStart, now], every user. */
    usage: UsageRow[];
}

/** Read every admission input, inside `withAdmission`. */
export async function readAdmissionCounters(
    tx: PlacementExecutor,
    lock: AdmissionLock,
    rawInput: { userId: string; computerId: string; monthStart: Date; now: Date },
): Promise<AdmissionCounters> {
    assertAdmissionLock(tx, lock);
    const input = { ...rawInput, userId: canonicalId(rawInput.userId), computerId: canonicalId(rawInput.computerId) };
    // ezil_computers is user-writable (id, deleted_at, chosen ids on insert): it is a
    // precondition here (the computer exists, is live and is the caller's), never the owner.
    const ownerRows = rowsOf(
        await tx.execute(sql`/* placement:computer-owner */ SELECT c.user_id::text AS user_id, (c.deleted_at IS NOT NULL) AS deleted
            FROM public.ezil_computers c
            WHERE c.id = ${input.computerId}::uuid`),
    );
    const target = await readPlacement(tx, input.computerId);
    const foreignRows = rowsOf(
        await tx.execute(sql`/* placement:usage-foreign */ SELECT count(*)::int AS n
            FROM public.ezil_compute_usage
            WHERE computer_id = ${input.computerId}::uuid AND user_id <> ${input.userId}::uuid`),
    );
    const running = sql.join(RUNNING_CLASS_STATES.map((s) => sql`${s}`), sql`, `);
    const runningRows = rowsOf(
        await tx.execute(sql`/* placement:count-running */ SELECT count(*)::int AS n
            FROM public.ezil_computer_placements
            WHERE provider = 'aws-ec2' AND state IN (${running})`),
    );
    const regionRows = rowsOf(
        await tx.execute(sql`/* placement:count-running-region */ SELECT region, count(*)::int AS n
            FROM public.ezil_computer_placements
            WHERE provider = 'aws-ec2' AND state IN (${running})
            GROUP BY region`),
    );
    // No `deleted_at IS NULL`: soft-deleting a computer must not free the per-user slot
    // while its volume still exists.
    const userRows = rowsOf(
        await tx.execute(sql`/* placement:count-user */ SELECT count(DISTINCT p.computer_id)::int AS n
            FROM public.ezil_computer_placements p
            WHERE p.provider = 'aws-ec2' AND p.computer_id <> ${input.computerId}::uuid AND p.state <> 'PURGE_ELIGIBLE'
              AND (p.owner_user_id = ${input.userId}::uuid
                OR EXISTS (SELECT 1 FROM public.ezil_compute_usage u WHERE u.computer_id = p.computer_id AND u.user_id = ${input.userId}::uuid))`),
    );
    const duplicates = await findDuplicatePlacements(tx);
    const usageRows = rowsOf(
        await tx.execute(sql`/* placement:usage-month */ SELECT computer_id::text AS computer_id, user_id::text AS user_id,
                started_at, stopped_at, egress_bytes::text AS egress_bytes
            FROM public.ezil_compute_usage
            WHERE started_at < ${input.now.toISOString()}::timestamptz
              AND (stopped_at IS NULL OR stopped_at >= ${input.monthStart.toISOString()}::timestamptz)`),
    );
    const count = (rows: Record<string, unknown>[]) => {
        const n = counter(rows[0]?.n);
        if (n === null) throw new Error('admission counter query returned no count');
        return n;
    };
    const runningByRegion: Record<string, number> = {};
    let runningUnplaced = 0;
    for (const r of regionRows) {
        const n = counter(r.n);
        if (n === null) throw new Error('admission region counter returned no count');
        if (r.region === null || r.region === undefined) runningUnplaced += n;
        else if (typeof r.region === 'string' && !Object.prototype.hasOwnProperty.call(runningByRegion, r.region)) runningByRegion[r.region] = n;
        else throw new Error('admission region counter returned a duplicate or invalid region');
    }
    const owner = ownerRows[0];
    return {
        targetOwnerId: typeof owner?.user_id === 'string' ? owner.user_id : null,
        targetPlacementOwnerId: target.record?.ownerUserId ?? null,
        targetDeleted: owner?.deleted === true,
        targetForeignUsage: count(foreignRows),
        runningCount: count(runningRows),
        runningByRegion,
        runningUnplaced,
        userOtherAwsComputers: count(userRows),
        duplicates,
        usage: usageRows.map((r) => {
            const startedAt = timestamp(r.started_at);
            const stoppedAt = timestamp(r.stopped_at);
            if (!startedAt || stoppedAt === undefined) throw new Error('usage row has an invalid timestamp');
            const egress = r.egress_bytes === null || r.egress_bytes === undefined ? null : counter(r.egress_bytes);
            if (egress === null && r.egress_bytes !== null && r.egress_bytes !== undefined) {
                throw new Error('usage row has an invalid egress_bytes');
            }
            return { computerId: String(r.computer_id), userId: String(r.user_id), startedAt, stoppedAt, egressBytes: egress };
        }),
    };
}

// ── Retention reads ──────────────────────────────────────────────────────

/**
 * Read-only input to the purge dry run (§6): every STOPPED or RETIRED
 * placement and when it last changed. For RETIRED, `updated_at` is the
 * retirement stamp (C-2 has no `retired_at`); a later write only delays
 * eligibility, which is the safe direction.
 */
export async function readRetentionCandidates(db: PlacementExecutor): Promise<{ computerId: string; state: PlacementState; updatedAt: Date }[]> {
    const rows = rowsOf(
        await db.execute(sql`/* placement:retention */ SELECT computer_id::text AS computer_id, state, updated_at
            FROM public.ezil_computer_placements
            WHERE state IN ('STOPPED', 'RETIRED')`),
    );
    return rows.map((r) => {
        const computerId = String(r.computer_id);
        const updatedAt = timestamp(r.updated_at);
        if (!updatedAt || !oneOf(PLACEMENT_STATES, r.state)) throw new PlacementIntegrityError('invalid_row', computerId);
        return { computerId, state: r.state, updatedAt };
    });
}
