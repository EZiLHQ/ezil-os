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

import { totalsOf, utcNextMonthStart, type MonthUsage, type UsageTotals } from './usage';
import { INSTANCE_VCPU, instanceVcpu } from './aws-config';

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
 * UNCONFIRMED"), a lease may lapse back to STOPPED before start, and a STOPPED
 * or RUNNING computer is retired (the lifecycle's retire stops a running instance
 * gracefully, then terminates it). A provision may land RUNNING (first boot).
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
    RUNNING: ['DRAINING', 'RETIRING', 'UNCONFIRMED'],
    DRAINING: ['STOPPING', 'UNCONFIRMED'],
    STOPPING: ['STOPPED', 'UNCONFIRMED'],
    UNCONFIRMED: ['RECOVERING'],
    // RECOVERING → RETIRING: a DELETED computer's stuck placement is recovered by retiring it
    // (aws-receipts.ts `recoverDeletedAwsPlacement`); the retire job resolves any instance state.
    RECOVERING: ['STOPPED', 'RETIRING', 'UNCONFIRMED'],
    // RETIRING → STOPPED / RUNNING is the undo of a retire whose StartExecution was refused:
    // nothing ran, so the placement returns to the state the retire started from.
    RETIRING: ['RETIRED', 'STOPPED', 'RUNNING', 'UNCONFIRMED'],
    RETIRED: ['PURGE_ELIGIBLE'],
    PURGE_ELIGIBLE: [],
    WARMING: ['READY', 'UNCONFIRMED'],
    READY: ['CLAIMED', 'UNCONFIRMED'],
    CLAIMED: ['UNCONFIRMED'],
};

/**
 * Edges only `transitionPlacementAsReconciler` may take, never a user's request.
 *
 * RUNNING → STOPPED: EC2 shows the RUNNING placement's instance gone, terminating or
 * terminated (an external terminate or an EC2 failure), while its retained data volume
 * still exists (aws-receipts.ts `reconcileGuestStop`). The tunnel is fenced and the usage
 * row closed in the same pass, and `last_error` = `INSTANCE_LOST` makes the next open a
 * REPLACE onto that volume. One atomic step: a multi-step detour through UNCONFIRMED could
 * strand the row there if interrupted.
 */
export const RECONCILER_TRANSITIONS: Readonly<Partial<Record<PlacementState, readonly PlacementState[]>>> = {
    RUNNING: ['STOPPED'],
    // UNCONFIRMED / RECOVERING → RETIRED: the RELEASE of a placement that owns nothing to
    // keep (aws-receipts.ts `settleUnconfirmedAwsPlacement`): no instance and no volume
    // exist for it, proven by EC2 (a tag search for a placement that recorded no ids, or
    // its recorded instance AND volume both gone). One step, guarded on the same instance
    // id; the usage row is closed in the same transaction. Nothing is retained, so it then
    // goes PURGE_ELIGIBLE at once, freeing the user's AWS-computer allowance.
    UNCONFIRMED: ['RETIRED'],
    RECOVERING: ['RETIRED'],
};

/** `last_error` of a placement whose instance was lost while its data volume survives: the next open replaces. */
export const INSTANCE_LOST = 'instance_lost';
/** `last_error` of a placement whose instance was lost AND whose data volume is gone: nothing to boot onto. */
export const INSTANCE_LOST_VOLUME_MISSING = 'instance_lost_volume_missing';
/** `last_error` of a placement released with nothing to keep: EC2 shows no instance and no volume for it. */
export const RELEASED_NO_RESOURCES = 'released_no_resources';

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
    /** The nonce's deadline. Kept after consume as the bounded window of `enrollConsumedHash`. */
    enrollExpiresAt: Date | null;
    /**
     * Proof of the CONSUMED nonce (C-6): consume moves the hash here and nulls `enrollNonceHash`
     * (single use). A host recovering its own enrollment (completion not recorded, or its 200
     * lost) must still present that nonce, before `enrollExpiresAt`; an identity document alone
     * never reaches the Worker. Cleared on a failed finish, on stop/retire, and at the next lease.
     */
    enrollConsumedHash: string | null;
    leaseUntil: Date | null;
    presenceAt: Date | null;
    /**
     * The fence token the CURRENT generation's instance and data volume are tagged
     * with (infra `tagsFor`). Minted by a provision or replace only; every start and
     * stop of that generation must carry it, or the lifecycle helper refuses
     * (`lifecycle_volume_invalid`). A replace hands it on as `previousFenceToken`.
     */
    fenceToken: string | null;
    /** The lifecycle job this placement is waiting on: execution `computer-<jobId>`, answered by the authority check. */
    lifecycleJobId: string | null;
    /** sha256 of that job's intent document (the execution input's `digest`). */
    lifecycleDigest: string | null;
    /** Machine-readable lifecycle error or explicit enrollment outcome (ENROLLMENT_* below). */
    lastError: string | null;
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
    enrollConsumedHash: ['enroll_consumed_hash', 'text'],
    leaseUntil: ['lease_until', 'timestamptz'],
    presenceAt: ['presence_at', 'timestamptz'],
    fenceToken: ['fence_token', 'uuid'],
    lifecycleJobId: ['lifecycle_job_id', 'uuid'],
    lifecycleDigest: ['lifecycle_digest', 'text'],
    lastError: ['last_error', 'text'],
} as const;
export type PlacementFields = Partial<{
    [K in keyof typeof MUTABLE_COLUMNS]: (typeof MUTABLE_COLUMNS)[K][1] extends 'timestamptz' ? Date | null : string | null;
}>;

// Placement.updatedAt is a JavaScript Date and the generation CAS uses exact
// SQL equality. Every placement updated_at writer must therefore store whole
// milliseconds. Advance at least 1 ms on updates, even within one transaction
// (now() is fixed there), so a same-state write always invalidates old snapshots.
const PLACEMENT_INSERT_TIME = sql`date_trunc('milliseconds', now())`;
const PLACEMENT_UPDATE_TIME = sql`GREATEST(date_trunc('milliseconds', now()), date_trunc('milliseconds', updated_at) + interval '1 millisecond')`;

const SELECT_COLUMNS = sql.raw(
    [
        'computer_id::text AS computer_id', 'owner_user_id::text AS owner_user_id', 'provider', 'workspace_store', 'generation::text AS generation',
        'lease_epoch::text AS lease_epoch', 'state', 'region', 'zone_id', 'instance_id', 'instance_type',
        'volume_id', 'fs_uuid::text AS fs_uuid', 'tunnel_id', 'enroll_nonce_hash', 'enroll_expires_at', 'enroll_consumed_hash',
        'lease_until', 'presence_at', 'fence_token::text AS fence_token', 'lifecycle_job_id::text AS lifecycle_job_id',
        'lifecycle_digest', 'last_error', 'updated_at',
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
        enrollExpiresAt: time('enroll_expires_at'), enrollConsumedHash: text('enroll_consumed_hash'),
        leaseUntil: time('lease_until'), presenceAt: time('presence_at'),
        fenceToken: text('fence_token'), lifecycleJobId: text('lifecycle_job_id'), lifecycleDigest: text('lifecycle_digest'),
        lastError: text('last_error'),
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

/**
 * C-2 read rule. Throws `PlacementIntegrityError` rather than guessing.
 * User-facing callers supply the authenticated owner so a foreign placement
 * is refused BEFORE querying image reservations. Ownerless background reads
 * still fail closed on reservations.
 */
export async function readPlacement(db: PlacementExecutor, rawComputerId: string, expectedOwnerUserId?: string): Promise<ResolvedPlacement> {
    const computerId = canonicalId(rawComputerId);
    const rows = await selectRows(db, computerId);
    if (rows.length === 0) { await assertNoImageReservation(db, computerId); return DEFAULT_PLACEMENT; }
    if (rows.length > 1) throw new PlacementIntegrityError('duplicate_placement', computerId);
    const record = parsePlacementRow(rows[0]!, computerId);
    if (expectedOwnerUserId !== undefined && record.ownerUserId !== canonicalId(expectedOwnerUserId)) {
        throw new PlacementOwnerError(computerId);
    }
    await assertNoImageReservation(db, computerId);
    return { provider: record.provider, store: record.store, record };
}

export class ImageJobConflictError extends Error {
    constructor() { super('image_job_conflict'); this.name = 'ImageJobConflictError'; }
}

/** Every ordinary reader/admission fails closed for reservations, including corrupt or orphan rows. */
export async function assertNoImageReservation(db: PlacementExecutor, computerId: string): Promise<void> {
    const rows = rowsOf(await db.execute(sql`/* placement:image-reservation */
        SELECT job_id::text AS job_id FROM public.ezil_computer_image_jobs
        WHERE computer_id = ${canonicalId(computerId)}::uuid AND phase NOT IN ('succeeded', 'recovered', 'cancelled')
        UNION ALL SELECT image_upgrade_job_id::text AS job_id FROM public.ezil_computer_placements
        WHERE computer_id = ${canonicalId(computerId)}::uuid AND image_upgrade_job_id IS NOT NULL LIMIT 2`));
    if (rows.length) throw new ImageJobConflictError();
}

export interface ImagePlacement extends Placement {
    lowerImageDigest: string | null;
    lowerDigestObservedAt: Date | null;
    imageUpgradeJobId: string | null;
}

/** Image store only, inside global admission -> computer -> row locks. */
export async function lockImagePlacement(tx: PlacementExecutor, lock: AdmissionLock, computerId: string): Promise<ImagePlacement | null> {
    assertAdmissionLock(tx, lock);
    await lockComputer(tx, canonicalId(computerId));
    const rows = rowsOf(await tx.execute(sql`/* placement:image-read */ SELECT ${SELECT_COLUMNS}, lower_image_digest,
        lower_digest_observed_at, image_upgrade_job_id::text AS image_upgrade_job_id
        FROM public.ezil_computer_placements WHERE computer_id = ${canonicalId(computerId)}::uuid FOR UPDATE`));
    if (!rows.length) return null;
    if (rows.length !== 1) throw new ImageJobConflictError();
    const r = rows[0]!, p = parsePlacementRow(r, computerId);
    const digest = nullableText(r.lower_image_digest), observed = timestamp(r.lower_digest_observed_at), jobId = nullableText(r.image_upgrade_job_id);
    if (digest === undefined || observed === undefined || jobId === undefined || (digest === null) !== (observed === null)
        || (digest !== null && !/^sha256:[0-9a-f]{64}$/.test(digest)) || (jobId !== null && !UUID.test(jobId))) throw new ImageJobConflictError();
    return { ...p, lowerImageDigest: digest, lowerDigestObservedAt: observed, imageUpgradeJobId: jobId };
}

/** Only the image store calls this under its reservation lock; exactly one placement changes. */
export async function setImageReservation(tx: PlacementExecutor, lock: AdmissionLock, p: ImagePlacement, jobId: string | null): Promise<void> {
    assertAdmissionLock(tx, lock);
    const rows = rowsOf(await tx.execute(sql`/* placement:image-cas */ UPDATE public.ezil_computer_placements
        SET image_upgrade_job_id = ${jobId}::uuid, updated_at = ${PLACEMENT_UPDATE_TIME}
        WHERE computer_id = ${p.computerId}::uuid AND owner_user_id = ${p.ownerUserId}::uuid
          AND generation = ${p.generation} AND lease_epoch = ${p.leaseEpoch}
          AND image_upgrade_job_id IS NOT DISTINCT FROM ${p.imageUpgradeJobId}::uuid RETURNING computer_id`));
    if (rows.length !== 1) throw new ImageJobConflictError();
}

/** C-2 periodic duplicate check. Any result must alarm and closes admission. */
export type ImagePlacementFields = Partial<Pick<ImagePlacement, 'state' | 'generation' | 'leaseEpoch' | 'fenceToken' | 'instanceId' | 'volumeId'
    | 'lifecycleJobId' | 'lifecycleDigest' | 'enrollNonceHash' | 'enrollConsumedHash' | 'enrollExpiresAt' | 'lastError'
    | 'lowerImageDigest' | 'lowerDigestObservedAt' | 'imageUpgradeJobId' | 'leaseUntil' | 'presenceAt'>>;
/** Image store only: the caller has validated the job and owner under these same locks. */
export async function writeImagePlacement(tx: PlacementExecutor, lock: AdmissionLock, p: ImagePlacement, fields: ImagePlacementFields): Promise<void> {
    assertAdmissionLock(tx, lock);
    const types: Record<keyof ImagePlacementFields, string> = { state: 'text', generation: 'bigint', leaseEpoch: 'bigint', fenceToken: 'uuid',
        instanceId: 'text', volumeId: 'text', lifecycleJobId: 'uuid', lifecycleDigest: 'text', enrollNonceHash: 'text', enrollConsumedHash: 'text',
        enrollExpiresAt: 'timestamptz', lastError: 'text', lowerImageDigest: 'text', lowerDigestObservedAt: 'timestamptz', imageUpgradeJobId: 'uuid', leaseUntil: 'timestamptz', presenceAt: 'timestamptz' };
    const assignments = Object.entries(fields).map(([key, value]) => {
        const type = types[key as keyof ImagePlacementFields];
        if (!type) throw new ImageJobConflictError();
        // Drizzle's postgres-js timestamp serializer passes values through;
        // postgres-js Bind expects text, not a Date object.
        const param = value instanceof Date ? value.toISOString() : value;
        return sql`${sql.raw(key.replace(/[A-Z]/g, c => '_' + c.toLowerCase()))} = ${param}::${sql.raw(type)}`;
    });
    if (fields.leaseEpoch !== undefined && fields.leaseEpoch < p.leaseEpoch) throw new ImageJobConflictError();
    const rows = rowsOf(await tx.execute(sql`/* placement:image-write */ UPDATE public.ezil_computer_placements
        SET ${sql.join(assignments, sql`, `)}, updated_at = ${PLACEMENT_UPDATE_TIME}
        WHERE computer_id = ${p.computerId}::uuid AND owner_user_id = ${p.ownerUserId}::uuid
          AND provider = 'aws-ec2' AND generation = ${p.generation} AND lease_epoch = ${p.leaseEpoch}
          AND fence_token IS NOT DISTINCT FROM ${p.fenceToken}::uuid
          AND lifecycle_job_id IS NOT DISTINCT FROM ${p.lifecycleJobId}::uuid
          AND image_upgrade_job_id IS NOT DISTINCT FROM ${p.imageUpgradeJobId}::uuid RETURNING computer_id`));
    if (rows.length !== 1) throw new ImageJobConflictError();
}

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

declare const TICKET_BRAND: unique symbol;

/**
 * Proof that admission ADMITTED one exact request (computer, user, create or
 * lease) inside THIS transaction, after `readAdmissionCounters` read that
 * computer's counters under the same lock. Opaque and single use, kept in a
 * module-private WeakMap like `AdmissionLock`. Holding the lock alone no
 * longer creates or leases an AWS placement (review R-PL F3): a caller that
 * skips the decision cannot get past the per-user and running caps.
 */
export interface AdmissionTicket {
    readonly [TICKET_BRAND]: true;
}

interface TicketRecord {
    tx: PlacementExecutor;
    computerId: string;
    userId: string;
    kind: 'create' | 'lease';
    used: boolean;
}

const MINTED_TICKETS = new WeakMap<object, TicketRecord>();
/** Lock → the computer whose admission counters were read under it. */
const COUNTED = new WeakMap<object, string>();

/**
 * ADMISSION ONLY: `admission.ts` calls this once `decideAdmission` has admitted
 * the request. No other non-test module may name it; `placement.test.ts` scans
 * the repository for that. It refuses unless the lock is this transaction's
 * and the counters for this very computer were read under it.
 */
export function mintAdmissionTicket(
    tx: PlacementExecutor,
    lock: AdmissionLock,
    input: { computerId: string; userId: string; kind: 'create' | 'lease' },
): AdmissionTicket {
    assertAdmissionLock(tx, lock);
    const computerId = canonicalId(input.computerId);
    if (COUNTED.get(lock) !== computerId) throw new Error('admission counters were not read for this computer under this lock');
    const ticket = Object.freeze({}) as AdmissionTicket;
    MINTED_TICKETS.set(ticket, { tx, computerId, userId: canonicalId(input.userId), kind: input.kind, used: false });
    return ticket;
}

function consumeTicket(tx: PlacementExecutor, ticket: AdmissionTicket, expected: { computerId: string; userId: string; kind: 'create' | 'lease' }): void {
    const record = ticket && typeof ticket === 'object' ? MINTED_TICKETS.get(ticket) : undefined;
    if (
        !record ||
        record.tx !== tx ||
        record.used ||
        record.kind !== expected.kind ||
        record.computerId !== canonicalId(expected.computerId) ||
        record.userId !== canonicalId(expected.userId)
    ) {
        throw new Error('admission ticket is not valid for this request');
    }
    record.used = true;
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

async function createInTx(tx: PlacementExecutor, rawInput: CreatePlacementInput, computerLocked = false): Promise<CreatePlacementResult> {
    const input = { ...rawInput, computerId: canonicalId(rawInput.computerId), ownerUserId: canonicalId(rawInput.ownerUserId) };
    if (!computerLocked) await lockComputer(tx, input.computerId);
    await assertNoImageReservation(tx, input.computerId);
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
        PLACEMENT_INSERT_TIME,
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

/**
 * AWS creation, inside the admission transaction, with that admission's ticket.
 * Starts at PROVISIONING, generation 1, lease_epoch 1 (the provision is the first lease).
 */
export async function createAwsPlacement(
    tx: PlacementExecutor,
    lock: AdmissionLock,
    ticket: AdmissionTicket,
    input: { computerId: string; ownerUserId: string; fields?: PlacementFields },
): Promise<CreatePlacementResult> {
    assertAdmissionLock(tx, lock);
    consumeTicket(tx, ticket, { computerId: input.computerId, userId: input.ownerUserId, kind: 'create' });
    return createInTx(tx, { computerId: input.computerId, ownerUserId: input.ownerUserId, provider: 'aws-ec2', state: 'PROVISIONING', fields: input.fields });
}

export interface FlipPlacementToAwsInput {
    computerId: string;
    ownerUserId: string;
    migrationId: string;
    /** Keep the normal ready receipt pending until migration commit. */
    pendingReady?: boolean;
    /** Receipt of the already admitted, restored AWS host. No new host is launched here. */
    fields: PlacementFields & { region: 'ap-south-1'; instanceId: string; volumeId: string; fsUuid: string };
}

/** Retire/remove the old immutable row and publish the restored host atomically.
 * The migration row lock also serializes this against migration state transitions.
 * Admission for the actual launch belongs to the migration orchestrator; this is
 * a publication of that existing host, under the global then computer lock order.
 */
export function flipPlacementToAws(db: PlacementDb, input: FlipPlacementToAwsInput): Promise<Placement> {
    const computerId = canonicalId(input.computerId), ownerUserId = canonicalId(input.ownerUserId);
    return withAdmission(db, async (tx) => {
        await lockComputer(tx, computerId);
        const migration = rowsOf(await tx.execute(sql`SELECT state, user_id::text, computer_id::text, to_provider, last_error
            FROM public.ezil_compute_migrations WHERE id = ${input.migrationId}::uuid FOR UPDATE`))[0];
        if (!migration || migration.state !== 'restored' || migration.user_id !== ownerUserId
            || migration.computer_id !== computerId || migration.to_provider !== 'aws-ec2'
            || String(migration.last_error ?? '').startsWith('recovery:')) throw new Error('migration_not_restored');
        if (input.fields.region !== 'ap-south-1' || !input.fields.instanceId || !input.fields.volumeId || !input.fields.fsUuid) {
            throw new Error('migration_aws_receipt_invalid');
        }
        const current = (await readPlacement(tx, computerId)).record;
        if (current?.provider === 'aws-ec2' && current.ownerUserId === ownerUserId
            && current.instanceId === input.fields.instanceId && current.volumeId === input.fields.volumeId
            && current.fsUuid === input.fields.fsUuid && current.fenceToken === (input.fields.fenceToken ?? null)
            && current.state === (input.pendingReady ? 'PROVISIONING' : 'RUNNING')) return current;
        if (current) {
            if (current.provider !== 'cloudflare' || current.ownerUserId !== ownerUserId) throw new Error('migration_source_mismatch');
            let retired = current;
            for (const to of ['RETIRING', 'RETIRED'] as const) {
                if (retired.state === 'RETIRED' || retired.state === to) continue;
                if (!PLACEMENT_TRANSITIONS[retired.state].includes(to)) throw new Error('migration_source_not_retirable');
                const result = await casInTx(tx, computerId, retired, to, { generation: 0, leaseEpoch: 0 }, {}, { ownerUserId, provider: 'cloudflare' });
                if (!result.ok) throw new Error('migration_placement_conflict');
                retired = result.placement;
            }
            const deleted = rowsOf(await tx.execute(sql`/* placement:migration-remove */ DELETE FROM public.ezil_computer_placements
                WHERE computer_id = ${computerId}::uuid AND owner_user_id = ${ownerUserId}::uuid
                    AND provider = 'cloudflare' AND state = 'RETIRED' AND generation = ${retired.generation} AND lease_epoch = ${retired.leaseEpoch}
                RETURNING computer_id`));
            if (deleted.length !== 1) throw new Error('migration_placement_conflict');
        }
        const created = await createInTx(tx, { computerId, ownerUserId, provider: 'aws-ec2', state: input.pendingReady ? 'PROVISIONING' : 'RUNNING', fields: input.fields }, true);
        if (!created.ok) throw new Error('migration_placement_conflict');
        return created.placement;
    });
}

/** A concurrent first open cannot re-pin CF after empty-workspace cutover. */
export async function pinCloudflarePlacement(db: PlacementDb, computer: { computerId: string; userId: string }): Promise<ResolvedPlacement> {
    return db.transaction(async tx => {
        await lockComputer(tx, computer.computerId);
        const existing = await readPlacement(tx, computer.computerId, computer.userId);
        if (existing.record) return existing;
        const { createProviderMigrationStore } = await import('./provider-migrate-store');
        const m = await createProviderMigrationStore(tx).readByComputer(computer.computerId);
        if (m?.userId === computer.userId.toLowerCase() && m.state === 'committed' && m.lastError === 'fresh_provision')
            return { provider: 'aws-ec2', store: 'ebs', record: null };
        const created = await createInTx(tx, { computerId: computer.computerId, ownerUserId: computer.userId,
            provider: 'cloudflare', state: 'STOPPED' }, true);
        if (!created.ok) throw new PlacementIntegrityError('invalid_row', computer.computerId);
        return { provider: 'cloudflare', store: created.placement.store, record: created.placement };
    });
}

/** Retire an empty CF pin and finish its migration atomically under the computer lock.
 * Recheck emptiness inside the lock; a STOPPED pin alone says nothing about R2.
 */
export async function finishFreshProvision(db: PlacementDb, m: import('./provider-migrate-store').ComputeMigration,
    proveEmpty: () => Promise<boolean>): Promise<void> {
    const { createProviderMigrationStore, MigrationConflictError } = await import('./provider-migrate-store');
    await withAdmission(db, async tx => {
        await lockComputer(tx, m.computerId);
        const store = createProviderMigrationStore(tx);
        const current = await store.readById(m.id);
        if (!current || current.userId !== m.userId || current.computerId !== m.computerId
            || current.state !== 'requested' || current.updatedAt !== m.updatedAt) throw new MigrationConflictError();
        const p = (await readPlacement(tx, m.computerId)).record;
        if (p && (p.provider !== 'cloudflare' || p.ownerUserId !== m.userId || p.state !== 'STOPPED'))
            throw new MigrationConflictError();
        if (!await proveEmpty()) throw new MigrationConflictError();
        if (p) {
            const deleted = rowsOf(await tx.execute(sql`/* placement:fresh-remove */ DELETE FROM public.ezil_computer_placements
                WHERE computer_id = ${m.computerId}::uuid AND owner_user_id = ${m.userId}::uuid
                  AND provider = 'cloudflare' AND state = 'STOPPED'
                  AND generation = ${p.generation} AND lease_epoch = ${p.leaseEpoch}
                RETURNING computer_id`));
            if (deleted.length !== 1) throw new MigrationConflictError();
        }
        const result = await store.applyTransition(current, { type: 'fresh_provision' });
        if (!result.accepted) throw new MigrationConflictError();
    });
}

/** Compensate only this migration's unpublished boot. The retained CF snapshot is authoritative. */
export function rollbackMigrationPlacement(db: PlacementDb, m: import('./provider-migrate-store').ComputeMigration, source: Placement | null): Promise<void> {
    return withAdmission(db, async tx => {
        await lockComputer(tx, m.computerId);
        const locked = rowsOf(await tx.execute(sql`SELECT state, last_error FROM public.ezil_compute_migrations
            WHERE id = ${m.id}::uuid AND computer_id = ${m.computerId}::uuid AND user_id = ${m.userId}::uuid FOR UPDATE`))[0];
        if (!locked || !String(locked.last_error).startsWith('recovery:')) throw new Error('migration_not_recovering');
        const p = (await readPlacement(tx, m.computerId)).record;
        if (!p || p.provider === 'cloudflare') return;
        if (p.ownerUserId !== m.userId || p.state !== 'PROVISIONING' || p.lastError !== `migration_pending:${m.id}`)
            throw new Error('migration_rollback_conflict');
        const removed = rowsOf(await tx.execute(sql`DELETE FROM public.ezil_computer_placements
            WHERE computer_id = ${m.computerId}::uuid AND owner_user_id = ${m.userId}::uuid
              AND provider = 'aws-ec2' AND state = 'PROVISIONING' AND last_error = ${p.lastError}
              AND generation = ${p.generation} AND lease_epoch = ${p.leaseEpoch} RETURNING computer_id`));
        if (removed.length !== 1) throw new Error('migration_rollback_conflict');
        if (source) {
            const restored = await createInTx(tx, { computerId: m.computerId, ownerUserId: m.userId,
                provider: 'cloudflare', state: source.state, fields: source }, true);
            if (!restored.ok) throw new Error('migration_rollback_conflict');
        }
    });
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
    guard: {
        provider?: PlacementProvider; ownerUserId?: string; enrollNonceHash?: string; enrollUnexpired?: boolean;
        states?: readonly PlacementState[]; preserveState?: boolean; availableInstanceId?: string;
        instanceId?: string | null; lastError?: string | null; nonceConsumed?: boolean;
        confirmedGeneration?: number; lifecycleJobId?: string; lifecycleDigest?: string;
        fenceToken?: string; volumeId?: string; updatedAt?: Date;
        /** Timestamp fields written as GREATEST(current, new): concurrent writers can never move them back. */
        monotonic?: readonly ('presenceAt' | 'leaseUntil')[];
    } = {},
): Promise<TransitionResult> {
    const computerId = canonicalId(rawComputerId);
    // A duplicate whose keys do not match the CAS would let this writer win
    // while every reader fails closed. Refuse first, inside the transaction.
    if ((await selectRows(tx, computerId)).length > 1) throw new PlacementIntegrityError('duplicate_placement', computerId);
    await assertNoImageReservation(tx, computerId);
    const sets: SQL[] = [
        guard.preserveState ? sql`state = state` : sql`state = ${to}`,
        guard.confirmedGeneration === undefined ? sql`generation = generation + ${bump.generation}` : sql`generation = ${guard.confirmedGeneration}`,
        sql`lease_epoch = lease_epoch + ${bump.leaseEpoch}`,
        ...(Object.keys(MUTABLE_COLUMNS) as (keyof typeof MUTABLE_COLUMNS)[])
            .filter((k) => fields[k] !== undefined)
            .map((k) => {
                const col = sql.raw(MUTABLE_COLUMNS[k][0]);
                // GREATEST ignores NULL, so a first write still lands and a NULL is never written over a value.
                return (guard.monotonic as readonly string[] | undefined)?.includes(k)
                    ? sql`${col} = GREATEST(${col}, ${valueSql(k, fields[k] ?? null)})`
                    : sql`${col} = ${valueSql(k, fields[k] ?? null)}`;
            }),
        sql`updated_at = ${PLACEMENT_UPDATE_TIME}`,
    ];
    const rows = rowsOf(
        await tx.execute(sql`/* placement:cas */ UPDATE public.ezil_computer_placements
            SET ${sql.join(sets, sql`, `)}
            WHERE computer_id = ${computerId}::uuid AND generation = ${expected.generation} AND lease_epoch = ${expected.leaseEpoch}
                AND image_upgrade_job_id IS NULL
                AND ${guard.states ? sql`state IN (${sql.join(guard.states.map((s) => sql`${s}`), sql`, `)})` : sql`state = ${expected.state}`}
                ${guard.provider ? sql` AND provider = ${guard.provider}` : sql``}
                ${guard.ownerUserId !== undefined ? sql` AND owner_user_id = ${canonicalId(guard.ownerUserId)}::uuid` : sql``}
                ${guard.enrollNonceHash !== undefined ? sql` AND enroll_nonce_hash = ${guard.enrollNonceHash}` : sql``}
                ${guard.enrollUnexpired ? sql` AND enroll_expires_at > now()` : sql``}
                ${guard.availableInstanceId !== undefined ? sql` AND (instance_id IS NULL OR instance_id = ${guard.availableInstanceId})` : sql``}
                ${guard.instanceId !== undefined ? sql` AND instance_id IS NOT DISTINCT FROM ${guard.instanceId}::text` : sql``}
                ${guard.lastError !== undefined ? sql` AND last_error IS NOT DISTINCT FROM ${guard.lastError}::text` : sql``}
                ${guard.nonceConsumed ? sql` AND enroll_nonce_hash IS NULL` : sql``}
                ${guard.lifecycleJobId !== undefined ? sql` AND lifecycle_job_id = ${guard.lifecycleJobId}::uuid` : sql``}
                ${guard.lifecycleDigest !== undefined ? sql` AND lifecycle_digest = ${guard.lifecycleDigest}` : sql``}
                ${guard.fenceToken !== undefined ? sql` AND fence_token = ${guard.fenceToken}::uuid` : sql``}
                ${guard.volumeId !== undefined ? sql` AND volume_id = ${guard.volumeId}` : sql``}
                ${guard.updatedAt !== undefined ? sql` AND updated_at = ${guard.updatedAt.toISOString()}::timestamptz` : sql``}
            RETURNING ${SELECT_COLUMNS}`),
    );
    if (rows.length === 0) return { ok: false, reason: 'cas_conflict' };
    // Belt and braces behind the pre-read: throwing inside the transaction rolls a multi-row update back.
    if (rows.length > 1) throw new PlacementIntegrityError('duplicate_placement', computerId);
    return { ok: true, placement: parsePlacementRow(rows[0]!, computerId) };
}

/** Reconciler only: settle provisional replacement authority from verified volume tags.
 * Lease epochs never move backwards. The failed job and both nonce proofs are revoked.
 */
export async function reconcileReplacementGeneration(db: PlacementDb, expected: Placement,
    confirmed: { generation: number; fenceToken: string; instanceId: string; instanceLost: boolean; instanceType?: string }): Promise<TransitionResult> {
    if (!expected.lifecycleJobId || !expected.lifecycleDigest || !expected.volumeId || !expected.fenceToken
        || !['LEASED', 'STARTING', 'MOUNTING', 'UNCONFIRMED'].includes(expected.state)
        || !Number.isInteger(confirmed.generation) || confirmed.generation < 1 || confirmed.generation > expected.generation
        || !UUID.test(confirmed.fenceToken) || !/^i-[0-9a-f]{17}$/.test(confirmed.instanceId)) return { ok: false, reason: 'cas_conflict' };
    return withAdmission(db, async (tx) => {
        await lockComputer(tx, expected.computerId);
        const { record: current } = await readPlacement(tx, expected.computerId);
        if (!current || current.ownerUserId !== expected.ownerUserId || current.provider !== 'aws-ec2') return { ok: false, reason: 'cas_conflict' };
        const result = await casInTx(tx, expected.computerId, expected, 'STOPPED', { generation: 0, leaseEpoch: 0 }, {
            fenceToken: confirmed.fenceToken, instanceId: confirmed.instanceId, instanceType: confirmed.instanceType,
            lifecycleJobId: null, lifecycleDigest: null, enrollNonceHash: null, enrollConsumedHash: null,
            enrollExpiresAt: null, leaseUntil: null, lastError: confirmed.instanceLost ? INSTANCE_LOST : LIFECYCLE_START_FAILED,
        }, { provider: 'aws-ec2', ownerUserId: expected.ownerUserId, confirmedGeneration: confirmed.generation,
            lifecycleJobId: expected.lifecycleJobId!, lifecycleDigest: expected.lifecycleDigest!, fenceToken: expected.fenceToken!,
            volumeId: expected.volumeId!, updatedAt: expected.updatedAt });
        if (result.ok) await applyUsageInTx(tx, result.placement, { kind: 'close', observedBy: 'generation-reconcile' });
        return result;
    });
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
 * Lease renewal (R9, GW-3: "lease renewal stays with the control plane"): the
 * AUTHENTICATED owner's presence on a RUNNING computer moves `presence_at` and
 * `lease_until`. No state change, so no transition edge: an owner-guarded CAS on the
 * row's generation, epoch and RUNNING state that keeps the state. Best effort: a lost
 * race (`cas_conflict`) means someone else moved the row, and the next beat renews.
 * The caller never shortens a lease (aws-ec2.ts `renewLease`).
 */
export async function renewPlacementLease(
    db: PlacementDb,
    input: { computerId: string; ownerUserId: string; expected: CasExpectation; presenceAt: Date; leaseUntil: Date },
): Promise<TransitionResult> {
    if (typeof input.ownerUserId !== 'string' || !UUID.test(input.ownerUserId)) throw new Error('renewPlacementLease requires the caller ownerUserId');
    if (input.expected.state !== 'RUNNING') return { ok: false, reason: 'illegal_transition' };
    return db.transaction((tx) =>
        casInTx(tx, input.computerId, input.expected, 'RUNNING', { generation: 0, leaseEpoch: 0 },
            { presenceAt: input.presenceAt, leaseUntil: input.leaseUntil },
            // Monotonic: two renewals racing (two tabs, an open and a heartbeat) both win the CAS;
            // whichever commits last must never move presence or the lease backward.
            { ownerUserId: input.ownerUserId, provider: 'aws-ec2', preserveState: true, monotonic: ['presenceAt', 'leaseUntil'] }),
    );
}

// ── Lifecycle starts whose outcome is unknown ────────────────────────────

/**
 * `last_error` of an in-flight placement whose recorded job's StartExecution got no
 * answer (5xx, timeout, connection lost): `lifecycle_start_unknown:<undo state>`. The
 * execution may be running, so the placement keeps its state and its job (the authority
 * endpoint still authorizes it); the receipt path follows the execution if it exists, and
 * once it is still absent after a settle window, knows the start never happened and moves
 * the placement to `<undo state>`, the state a definite refusal would have left.
 */
export const LIFECYCLE_START_UNKNOWN = 'lifecycle_start_unknown';
/** `last_error` after a start known not to have happened (absent once settled, or refused on retry). */
export const LIFECYCLE_START_FAILED = 'lifecycle_start_failed';

/** The undo state recorded by `markLifecycleStartUnknown`, or null when `lastError` is not such a mark. */
export function lifecycleStartUnknownUndo(p: Pick<Placement, 'state' | 'lastError'>): PlacementState | null {
    const prefix = `${LIFECYCLE_START_UNKNOWN}:`;
    if (!p.lastError?.startsWith(prefix)) return null;
    const undo = p.lastError.slice(prefix.length) as PlacementState;
    return PLACEMENT_TRANSITIONS[p.state]?.includes(undo) ? undo : 'UNCONFIRMED';
}

/**
 * Mark the in-flight placement `expected` (its job already recorded) as started-unknown,
 * without moving its state. CAS on the same keys and on `last_error` being what the caller
 * saw, so it never overwrites enrollment or receipt progress made meanwhile. `ownerUserId`
 * when a user's request launched it; omitted for the reconciler's own starts.
 */
export async function markLifecycleStartUnknown(
    db: PlacementDb,
    input: { computerId: string; ownerUserId?: string; expected: CasExpectation & Pick<Placement, 'lastError'>; undo: PlacementState },
): Promise<TransitionResult> {
    if (!PLACEMENT_TRANSITIONS[input.expected.state]?.includes(input.undo)) return { ok: false, reason: 'illegal_transition' };
    return db.transaction((tx) =>
        casInTx(tx, input.computerId, input.expected, input.expected.state, { generation: 0, leaseEpoch: 0 },
            { lastError: `${LIFECYCLE_START_UNKNOWN}:${input.undo}` },
            { provider: 'aws-ec2', preserveState: true, lastError: input.expected.lastError, ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}) }),
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
    input: {
        computerId: string;
        expected: CasExpectation & Partial<Pick<Placement, 'instanceId' | 'lastError'>>;
        to: PlacementState;
        fields?: PlacementFields;
        /** Usage-ledger write tied to THIS transition: same transaction, only when the CAS won. */
        usage?: UsageEffect;
    },
): Promise<TransitionResult> {
    const from = input.expected.state;
    if (!PLACEMENT_TRANSITIONS[from]?.includes(input.to) && !RECONCILER_TRANSITIONS[from]?.includes(input.to)) return { ok: false, reason: 'illegal_transition' };
    return db.transaction(async (tx) => {
        const r = await casInTx(tx, input.computerId, input.expected, input.to, { generation: 0, leaseEpoch: 0 }, input.fields ?? {},
            { instanceId: input.expected.instanceId, lastError: input.expected.lastError });
        if (r.ok && input.usage) await applyUsageInTx(tx, r.placement, input.usage);
        return r;
    });
}

// ── Usage ledger writes (R9) ─────────────────────────────────────────────

/**
 * What a confirmed lifecycle receipt means for the usage ledger. Written only by
 * `transitionPlacementAsReconciler`, in the SAME transaction as the CAS that applied
 * the receipt, so only the transition's winner writes and each run is recorded once.
 *
 * - `open`: the receipt confirmed this instance running. Any other open row of the
 *   computer is closed first (a replaced instance is gone); a row already open for
 *   this instance is kept, so re-applying is a no-op. `startedAt` is when the
 *   lifecycle job started (its execution start), else the database clock.
 * - `close`: the receipt confirmed the computer's instance stopped or retired.
 *
 * Egress is NOT measured: `egress_bytes` is always written NULL, so the egress caps
 * do not bind yet (usage.ts). Only the hour caps are real.
 */
export type UsageEffect =
    | { kind: 'open'; instanceId: string; instanceType: string; startedAt: Date | null; observedBy: string }
    | { kind: 'close'; observedBy: string };

async function applyUsageInTx(tx: PlacementExecutor, p: Placement, effect: UsageEffect): Promise<void> {
    const computerId = canonicalId(p.computerId);
    if (effect.kind === 'close') {
        await tx.execute(sql`/* placement:usage-close */ UPDATE public.ezil_compute_usage
            SET stopped_at = now(), observed_by = ${effect.observedBy}, updated_at = now()
            WHERE computer_id = ${computerId}::uuid AND stopped_at IS NULL`);
        return;
    }
    await tx.execute(sql`/* placement:usage-close-other */ UPDATE public.ezil_compute_usage
        SET stopped_at = now(), observed_by = ${effect.observedBy}, updated_at = now()
        WHERE computer_id = ${computerId}::uuid AND stopped_at IS NULL AND instance_id <> ${effect.instanceId}`);
    await tx.execute(sql`/* placement:usage-open */ INSERT INTO public.ezil_compute_usage
            (computer_id, user_id, instance_id, instance_type, started_at, stopped_at, egress_bytes, observed_by, updated_at)
        SELECT ${computerId}::uuid, ${canonicalId(p.ownerUserId)}::uuid, ${effect.instanceId}, ${effect.instanceType},
            COALESCE(${effect.startedAt ? effect.startedAt.toISOString() : null}::timestamptz, now()), NULL, NULL, ${effect.observedBy}, now()
        WHERE NOT EXISTS (SELECT 1 FROM public.ezil_compute_usage
            WHERE computer_id = ${computerId}::uuid AND instance_id = ${effect.instanceId} AND stopped_at IS NULL)`);
}

/** Image custody uses the same usage writer while holding admission and placement locks. */
export async function recordImageUsage(tx: PlacementExecutor, lock: AdmissionLock, p: ImagePlacement, effect: UsageEffect): Promise<void> {
    assertAdmissionLock(tx, lock);
    await applyUsageInTx(tx, p, effect);
}

/**
 * Reconciler input (aws-receipts.ts `reconcileAwsFleet`): aws-ec2 placements that may
 * hold running capacity — RUNNING (a guest may have stopped its instance, or its lease
 * or hour cap may have lapsed) and the states waiting on a lifecycle receipt.
 *
 * ROTATING, so a bounded pass never starves rows: the pass CLAIMS up to `limit` rows,
 * least recently reconciled first (never reconciled first of all), and stamps their
 * `reconciled_at`. Healthy long-running rows keep their old `updated_at`, so ordering by
 * it alone selected the same oldest rows forever and a guest-stopped row behind them was
 * never seen. `reconciled_at` is bookkeeping only: no CAS reads it and `updated_at` is
 * untouched. SKIP LOCKED leaves a row a writer holds to that writer; two passes never
 * claim the same row. A duplicate placement's rows are returned once; the caller's own
 * read then fails closed on it.
 */
export async function claimAwsPlacementsToReconcile(db: PlacementExecutor, limit: number): Promise<{ computerId: string; ownerUserId: string }[]> {
    const states = sql.join(RECONCILABLE_STATES.map((s) => sql`${s}`), sql`, `);
    const rows = rowsOf(
        await db.execute(sql`/* placement:reconcile-claim */ UPDATE public.ezil_computer_placements
            SET reconciled_at = now()
            WHERE computer_id IN (SELECT computer_id FROM public.ezil_computer_placements
                WHERE provider = 'aws-ec2' AND state IN (${states})
                ORDER BY reconciled_at ASC NULLS FIRST, updated_at ASC, computer_id ASC
                LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 100))}
                FOR UPDATE SKIP LOCKED)
            RETURNING computer_id::text AS computer_id, owner_user_id::text AS owner_user_id`),
    );
    const seen = new Set<string>();
    const claimed: { computerId: string; ownerUserId: string }[] = [];
    for (const r of rows) {
        const computerId = String(r.computer_id);
        if (!UUID.test(computerId) || typeof r.owner_user_id !== 'string' || !UUID.test(r.owner_user_id)) throw new PlacementIntegrityError('invalid_row', computerId);
        if (seen.has(computerId.toLowerCase())) continue;
        seen.add(computerId.toLowerCase());
        claimed.push({ computerId, ownerUserId: r.owner_user_id });
    }
    return claimed;
}

/**
 * States a deleted computer's placement is driven out of, toward RETIRED
 * (`claimAwsPlacementsPendingRetire`). UNCONFIRMED and RECOVERING are here because a
 * failed, timed-out or aborted stop/retire lands UNCONFIRMED, and with the computer
 * already deleted nothing else would ever retry it (Codex 4276508568).
 */
export const RETIRE_PENDING_STATES: readonly PlacementState[] = ['RUNNING', 'DRAINING', 'STOPPING', 'STOPPED', 'RETIRING', 'UNCONFIRMED', 'RECOVERING'];

/**
 * Background retirement input (aws-receipts.ts `reconcileDeletedAwsComputers`): aws-ec2
 * placements that can still hold an instance or a job while their computer row is
 * soft-deleted (`computer.delete` succeeds once the retire, or the stop before it, is
 * durably recorded) or gone (an account deletion cascades the row away). The placement's
 * owner is unchanged; the computer row only says "retire".
 *
 * It ROTATES like `claimAwsPlacementsToReconcile`: least recently checked first (never
 * checked first of all), stamping `reconciled_at`, skipping writer-held rows. A row that
 * cannot progress (its instance gone, its region unconfigured) therefore never pins the
 * head of the list and starves the rest. A duplicate's rows are returned once.
 */
export async function claimAwsPlacementsPendingRetire(db: PlacementExecutor, limit: number): Promise<{ computerId: string; ownerUserId: string }[]> {
    const states = sql.join(RETIRE_PENDING_STATES.map((s) => sql`${s}`), sql`, `);
    const rows = rowsOf(
        await db.execute(sql`/* placement:retire-pending-claim */ UPDATE public.ezil_computer_placements
            SET reconciled_at = now()
            WHERE computer_id IN (SELECT p.computer_id FROM public.ezil_computer_placements p
                LEFT JOIN public.ezil_computers c ON c.id = p.computer_id
                WHERE p.provider = 'aws-ec2' AND p.state IN (${states})
                  AND (c.id IS NULL OR c.deleted_at IS NOT NULL)
                ORDER BY p.reconciled_at ASC NULLS FIRST, p.updated_at ASC, p.computer_id ASC
                LIMIT ${Math.max(1, Math.min(Math.trunc(limit), 100))}
                FOR UPDATE OF p SKIP LOCKED)
            RETURNING computer_id::text AS computer_id, owner_user_id::text AS owner_user_id`),
    );
    const seen = new Set<string>();
    const claimed: { computerId: string; ownerUserId: string }[] = [];
    for (const r of rows) {
        const computerId = String(r.computer_id);
        if (!UUID.test(computerId) || typeof r.owner_user_id !== 'string' || !UUID.test(r.owner_user_id)) throw new PlacementIntegrityError('invalid_row', computerId);
        if (seen.has(computerId.toLowerCase())) continue;
        seen.add(computerId.toLowerCase());
        claimed.push({ computerId, ownerUserId: r.owner_user_id });
    }
    return claimed;
}

/**
 * For the Cloudflare reaper's candidate query (cron/sandbox-reap): true for a computer
 * with no placement or only a `cloudflare` one. Applied in SQL BEFORE the candidate
 * LIMIT, so AWS rows can never fill the window and starve Cloudflare reaping. Any
 * other placement (aws-ec2, unknown, a duplicate including one) excludes the computer:
 * the reaper never addresses it. Only with placement reads on (the table exists).
 */
export function noNonCloudflarePlacement(computerId: SQL): SQL {
    return sql`NOT EXISTS (SELECT 1 FROM public.ezil_computer_placements p WHERE p.computer_id = ${computerId} AND p.provider <> 'cloudflare')`;
}

/** States `claimAwsPlacementsToReconcile` claims: RUNNING plus every state waiting on a receipt. */
export const RECONCILABLE_STATES: readonly PlacementState[] = ['RUNNING', 'PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'DRAINING', 'STOPPING', 'RETIRING', 'UNCONFIRMED'];

/**
 * `STOPPED → LEASED` (also RUNNING for a resize), reserving `lease_epoch + 1` (and `generation + 1` for a
 * replace or recovery, C-3). Only inside the admission transaction, with that
 * admission's ticket.
 */
export async function leasePlacement(
    tx: PlacementExecutor,
    lock: AdmissionLock,
    ticket: AdmissionTicket,
    input: {
        computerId: string;
        ownerUserId: string;
        expected: { generation: number; leaseEpoch: number };
        leaseUntil: Date;
        replace?: boolean;
        /** Admission's selected type, written with the new generation and lease. */
        resizeInstanceType?: string;
        /** Written in the SAME compare-and-swap as the lease: the job, fence and enrollment nonce hash of this boot. */
        fields?: PlacementFields;
    },
): Promise<TransitionResult> {
    assertAdmissionLock(tx, lock);
    consumeTicket(tx, ticket, { computerId: input.computerId, userId: input.ownerUserId, kind: 'lease' });
    const { record: current } = await readPlacement(tx, input.computerId);
    if (input.resizeInstanceType !== undefined && (!input.replace || !input.resizeInstanceType || input.resizeInstanceType === current?.instanceType)) {
        return { ok: false, reason: 'illegal_transition' };
    }
    // A failed enrollment still owns a live instance. Only a fresh replace may lease it.
    const recover = input.replace && current?.state === 'UNCONFIRMED' && current.lastError === ENROLLMENT_FAILED;
    return casInTx(
        tx,
        input.computerId,
        { ...input.expected, state: recover ? 'UNCONFIRMED' : input.resizeInstanceType && current?.state === 'RUNNING' ? 'RUNNING' : 'STOPPED' },
        'LEASED',
        { generation: input.replace ? 1 : 0, leaseEpoch: 1 },
        {
            ...input.fields, ...(input.replace ? { instanceId: null } : {}), leaseUntil: input.leaseUntil, lastError: null,
            // A caller's miscellaneous fields cannot bypass the type/region admission checked.
            instanceType: input.resizeInstanceType ?? current?.instanceType, region: current?.region,
        },
        // Only the recorded owner's aws-ec2 row matches: a Cloudflare row is never leased under
        // AWS caps, and a re-keyed or re-inserted ezil_computers row cannot claim a placement.
        { provider: 'aws-ec2', ownerUserId: input.ownerUserId, lastError: recover ? ENROLLMENT_FAILED : undefined },
    );
}

// ── Enrollment (C-6) ─────────────────────────────────────────────────────

/** States a host may enroll in: the provision's first boot, or a wake's boot (C-6 step 3). */
export const ENROLLABLE_STATES: readonly PlacementState[] = ['PROVISIONING', 'STARTING', 'MOUNTING'];

// Stored in last_error: a cleared nonce alone is never evidence of GW-1 success.
export const ENROLLMENT_PENDING = 'enroll_tunnel_pending';
export const ENROLLMENT_SUCCEEDED = 'enroll_succeeded';
export const ENROLLMENT_FAILED = 'enroll_tunnel_failed';

/**
 * C-6 step 4: consume the boot's one-time enrollment nonce. ONE compare-and-swap
 * matches the generation, lease epoch, an enrollable state, provider, nonce hash
 * AND a deadline after the database clock. Receipt progress is preserved.
 * It clears both nonce columns and records a pending outcome; only GW-1 success
 * may complete enrollment. An existing instance binding must match the host.
 * The state does not change. `fields` records what the verified host proved
 * (its instance and data volume). No owner predicate: the caller is a host, not
 * a user; the nonce, the signed identity document and the live describe are the
 * authority. Only the enrollment handler may call it.
 */
export async function consumeEnrollmentNonce(
    db: PlacementDb,
    input: { computerId: string; expected: CasExpectation; nonceHash: string; fields: { instanceId: string; volumeId: string }; lowerImageDigest?: string; observedAt?: Date },
): Promise<TransitionResult> {
    if (!ENROLLABLE_STATES.includes(input.expected.state)) return { ok: false, reason: 'illegal_transition' };
    if (!/^[a-f0-9]{64}$/.test(input.nonceHash)) return { ok: false, reason: 'cas_conflict' };
    return db.transaction(async (tx) => {
        const result = await casInTx(
            tx,
            input.computerId,
            input.expected,
            input.expected.state,
            { generation: 0, leaseEpoch: 0 },
            // Single use: the nonce hash moves to the consumed proof; its deadline stays as that proof's window.
            { ...input.fields, enrollNonceHash: null, enrollConsumedHash: input.nonceHash, lastError: ENROLLMENT_PENDING },
            {
                provider: 'aws-ec2', enrollNonceHash: input.nonceHash, enrollUnexpired: true,
                states: ENROLLABLE_STATES, preserveState: true, availableInstanceId: input.fields.instanceId,
            },
        );
        if (result.ok && input.lowerImageDigest !== undefined) {
            if (!/^sha256:[0-9a-f]{64}$/.test(input.lowerImageDigest) || !input.observedAt || !Number.isFinite(input.observedAt.getTime())) throw new ImageJobConflictError();
            const rows = rowsOf(await tx.execute(sql`/* placement:enroll-digest */ UPDATE public.ezil_computer_placements
                SET lower_image_digest = ${input.lowerImageDigest}, lower_digest_observed_at = ${input.observedAt.toISOString()}::timestamptz
                WHERE computer_id = ${input.computerId}::uuid AND generation = ${result.placement.generation} AND lease_epoch = ${result.placement.leaseEpoch}
                  AND enroll_consumed_hash = ${input.nonceHash} AND image_upgrade_job_id IS NULL RETURNING computer_id`));
            if (rows.length !== 1) throw new ImageJobConflictError();
        }
        return result;
    });
}

/** Replays may never replace the digest accepted with this nonce. */
export async function checkEnrollmentDigest(db: PlacementExecutor, p: Placement, digest: string): Promise<boolean> {
    const rows = rowsOf(await db.execute(sql`SELECT lower_image_digest FROM public.ezil_computer_placements
        WHERE computer_id = ${p.computerId}::uuid AND generation = ${p.generation} AND lease_epoch = ${p.leaseEpoch}
          AND enroll_consumed_hash = ${p.enrollConsumedHash} AND image_upgrade_job_id IS NULL LIMIT 2`));
    return rows.length === 1 && rows[0]!.lower_image_digest === digest;
}

/** Complete only the consumed boot, preserving receipt progress and fencing a moved epoch. */
export async function finishEnrollment(
    db: PlacementDb,
    input: { computerId: string; expected: Placement; success: boolean },
): Promise<TransitionResult> {
    return db.transaction((tx) => casInTx(
        tx, input.computerId, input.expected, input.success ? input.expected.state : 'UNCONFIRMED',
        { generation: 0, leaseEpoch: 0 },
        // Success keeps the consumed proof for the replay window; a failure can never be recovered.
        input.success ? { lastError: ENROLLMENT_SUCCEEDED } : { lastError: ENROLLMENT_FAILED, enrollConsumedHash: null, enrollExpiresAt: null },
        {
            provider: 'aws-ec2', states: ENROLLABLE_STATES, preserveState: input.success,
            instanceId: input.expected.instanceId, lastError: ENROLLMENT_PENDING, nonceConsumed: true,
        },
    ));
}

// ── Admission reads ──────────────────────────────────────────────────────

export interface UsageRow {
    computerId: string;
    userId: string;
    instanceType: string | null;
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
    runningVcpu: number;
    /**
     * The same running-class rows, per region (only regions that have any). A
     * region absent here has none. Rows without a region are `runningUnplaced`
     * and count against EVERY region (the safe direction).
     */
    runningByRegion: Readonly<Record<string, number>>;
    runningUnplaced: number;
    runningVcpuByRegion: Readonly<Record<string, number>>;
    runningVcpuUnplaced: number;
    /**
     * The user's OTHER aws-ec2 placements not yet PURGE_ELIGIBLE: counted by
     * `owner_user_id` (or usage metered to the user), never through
     * `ezil_computers`, so re-keying a computer row hides nothing.
     */
    userOtherAwsComputers: number;
    duplicates: { computerId: string; rows: number }[];
    /** This month's usage, totalled in the database: fleet-wide and per user (`readMonthUsage`). */
    usage: MonthUsage;
}

/**
 * The canary precondition (`select.ts`): the computer row's owner, deletion and
 * creation time. ezil_computers is user-writable, so this only gates a rollout
 * for allowlisted users; ownership is the placement's owner_user_id, written at
 * admission. A row it cannot parse throws: never AWS or Cloudflare by accident.
 */
export async function readCanaryComputer(
    db: PlacementExecutor,
    rawComputerId: string,
): Promise<{ userId: string; deleted: boolean; createdAt: Date } | null> {
    const rows = rowsOf(
        await db.execute(sql`/* placement:canary-computer */ SELECT c.user_id::text AS user_id, (c.deleted_at IS NOT NULL) AS deleted, c.created_at
            FROM public.ezil_computers c
            WHERE c.id = ${canonicalId(rawComputerId)}::uuid`),
    );
    if (rows.length === 0) return null;
    const [row] = rows;
    const createdAt = timestamp(row!.created_at);
    if (rows.length > 1 || typeof row!.user_id !== 'string' || typeof row!.deleted !== 'boolean' || !createdAt) {
        throw new PlacementIntegrityError('invalid_row', canonicalId(rawComputerId));
    }
    return { userId: canonicalId(row!.user_id), deleted: row!.deleted, createdAt };
}

/** Same closed, fail-closed vCPU mapping as the pure accounting helpers. */
function instanceVcpuSql(column: SQL): SQL {
    return sql`CASE ${column} ${sql.join(Object.entries(INSTANCE_VCPU).map(([type, vcpu]) => sql`WHEN ${type} THEN ${vcpu}::int`), sql` `)} ELSE ${instanceVcpu(null)}::int END`;
}

/**
 * This month's usage, TOTALLED IN THE DATABASE: one row per user with usage overlapping
 * the UTC month that contains `now`, never the ledger's rows. The arithmetic is usage.ts's,
 * exactly (`monthUsageFromRows` is the reference): a run counts from max(started_at,
 * monthStart) to min(stopped_at ?? now, now, nextMonth), an open run until now, and its
 * whole egress counts in every month it overlaps (NULL = 0). Weighted seconds floor
 * each clipped row duration before multiplying by vCPU / 2. Admission reads it under its
 * lock, so its size is bounded by users, not by how often computers stop and wake.
 * Session-limit enforcement (aws-receipts.ts `enforceSessionLimits`) reads it without one:
 * a cap is checked again by the next pass.
 */
export async function readMonthUsage(db: PlacementExecutor, now: Date, monthStart: Date): Promise<MonthUsage> {
    const nextMonth = utcNextMonthStart(now);
    const rows = rowsOf(
        await db.execute(sql`/* placement:usage-month */ WITH w AS (SELECT ${now.toISOString()}::timestamptz AS now_at,
                ${monthStart.toISOString()}::timestamptz AS month_start, ${nextMonth.toISOString()}::timestamptz AS next_month)
            SELECT u.user_id::text AS user_id,
                COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM (LEAST(COALESCE(u.stopped_at, w.now_at), w.now_at, w.next_month)
                    - GREATEST(u.started_at, w.month_start))), 0)), 0)::text AS seconds,
                COALESCE(SUM(FLOOR(GREATEST(EXTRACT(EPOCH FROM (LEAST(COALESCE(u.stopped_at, w.now_at), w.now_at, w.next_month)
                    - GREATEST(u.started_at, w.month_start))), 0)) * (${instanceVcpuSql(sql`u.instance_type`)} / 2)), 0)::text AS weighted_seconds,
                COALESCE(SUM(u.egress_bytes), 0)::text AS egress_bytes
            FROM public.ezil_compute_usage u CROSS JOIN w
            WHERE u.started_at < LEAST(w.now_at, w.next_month)
              AND (u.stopped_at IS NULL OR u.stopped_at >= w.month_start)
            GROUP BY u.user_id`),
    );
    const byUser = new Map<string, UsageTotals>();
    for (const r of rows) {
        const userId = typeof r.user_id === 'string' ? canonicalId(r.user_id) : '';
        const seconds = typeof r.seconds === 'string' && /^\d+(\.\d+)?$/.test(r.seconds) ? Number(r.seconds) : NaN;
        const egress = counter(r.egress_bytes);
        const weightedSeconds = counter(r.weighted_seconds);
        if (!UUID.test(userId) || byUser.has(userId)) throw new Error('usage aggregate has an invalid user_id');
        if (!Number.isFinite(seconds)) throw new Error('usage aggregate has invalid seconds');
        if (weightedSeconds === null) throw new Error('usage aggregate has invalid weighted_seconds');
        if (egress === null) throw new Error('usage aggregate has an invalid egress_bytes');
        byUser.set(userId, { hours: seconds / 3_600, weightedSeconds, egressBytes: egress });
    }
    return { global: totalsOf(byUser.values()), byUser };
}

/** Read every admission input, inside `withAdmission`. */
export async function readAdmissionCounters(
    tx: PlacementExecutor,
    lock: AdmissionLock,
    rawInput: { userId: string; computerId: string; monthStart: Date; now: Date },
): Promise<AdmissionCounters> {
    assertAdmissionLock(tx, lock);
    const counters = await readCounters(tx, rawInput);
    // Every read succeeded for this computer under this lock: admission may now mint a ticket for it.
    COUNTED.set(lock, canonicalId(rawInput.computerId));
    return counters;
}

/** Image admission supplies the already locked reserved placement; all capacity reads are shared. */
export async function readImageAdmissionCounters(tx: PlacementExecutor, lock: AdmissionLock, p: ImagePlacement, now: Date): Promise<AdmissionCounters> {
    assertAdmissionLock(tx, lock);
    return readCounters(tx, { userId: p.ownerUserId, computerId: p.computerId, now, monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) }, p);
}

/**
 * The same admission inputs, read WITHOUT the admission lock and minting nothing:
 * a point-in-time view for a routing pre-check (select.ts canary fallback). It can be
 * stale by the time admission runs; admission re-reads under its lock and decides.
 */
export async function peekAdmissionCounters(
    db: PlacementExecutor,
    rawInput: { userId: string; computerId: string; monthStart: Date; now: Date },
): Promise<AdmissionCounters> {
    return readCounters(db, rawInput);
}

/** The admission lock covers placement launches and migration reservations alike. */
const CAPACITY_PLACEMENTS = sql`(
    SELECT computer_id, owner_user_id, provider, state, region, instance_type FROM public.ezil_computer_placements
    UNION ALL
    SELECT m.computer_id, m.user_id, 'aws-ec2', 'PROVISIONING',
        m.workspace_head #>> '{_awsProvision,placement,region}', m.workspace_head #>> '{_awsProvision,placement,instanceType}'
    FROM public.ezil_compute_migrations m
    WHERE m.workspace_head ? '_awsProvision' AND m.state <> 'committed'
      AND COALESCE(m.workspace_head #>> '{_awsProvision,released}', 'false') <> 'true'
      AND NOT EXISTS (SELECT 1 FROM public.ezil_computer_placements p WHERE p.computer_id = m.computer_id AND p.provider = 'aws-ec2')
)`;

async function readCounters(
    tx: PlacementExecutor,
    rawInput: { userId: string; computerId: string; monthStart: Date; now: Date },
    image?: ImagePlacement,
): Promise<AdmissionCounters> {
    const input = { ...rawInput, userId: canonicalId(rawInput.userId), computerId: canonicalId(rawInput.computerId) };
    // ezil_computers is user-writable (id, deleted_at, chosen ids on insert): it is a
    // precondition here (the computer exists, is live and is the caller's), never the owner.
    const ownerRows = rowsOf(
        await tx.execute(sql`/* placement:computer-owner */ SELECT c.user_id::text AS user_id, (c.deleted_at IS NOT NULL) AS deleted
            FROM public.ezil_computers c
            WHERE c.id = ${input.computerId}::uuid`),
    );
    const target = image ? { record: image } : await readPlacement(tx, input.computerId);
    const foreignRows = rowsOf(
        await tx.execute(sql`/* placement:usage-foreign */ SELECT count(*)::int AS n
            FROM public.ezil_compute_usage
            WHERE computer_id = ${input.computerId}::uuid AND user_id <> ${input.userId}::uuid`),
    );
    const running = sql.join(RUNNING_CLASS_STATES.map((s) => sql`${s}`), sql`, `);
    const runningRows = rowsOf(
        await tx.execute(sql`/* placement:count-running */ SELECT count(*)::int AS n,
                COALESCE(SUM(${instanceVcpuSql(sql`instance_type`)}), 0)::text AS vcpu
            FROM ${CAPACITY_PLACEMENTS} AS capacity
            WHERE provider = 'aws-ec2' AND state IN (${running})`),
    );
    const regionRows = rowsOf(
        await tx.execute(sql`/* placement:count-running-region */ SELECT region, count(*)::int AS n,
                COALESCE(SUM(${instanceVcpuSql(sql`instance_type`)}), 0)::text AS vcpu
            FROM ${CAPACITY_PLACEMENTS} AS capacity
            WHERE provider = 'aws-ec2' AND state IN (${running})
            GROUP BY region`),
    );
    // No `deleted_at IS NULL`: soft-deleting a computer must not free the per-user slot
    // while its volume still exists.
    const userRows = rowsOf(
        await tx.execute(sql`/* placement:count-user */ SELECT count(DISTINCT p.computer_id)::int AS n
            FROM ${CAPACITY_PLACEMENTS} p
            WHERE p.provider = 'aws-ec2' AND p.computer_id <> ${input.computerId}::uuid AND p.state <> 'PURGE_ELIGIBLE'
              AND (p.owner_user_id = ${input.userId}::uuid
                OR EXISTS (SELECT 1 FROM public.ezil_compute_usage u WHERE u.computer_id = p.computer_id AND u.user_id = ${input.userId}::uuid))`),
    );
    const duplicates = await findDuplicatePlacements(tx);
    const usage = await readMonthUsage(tx, input.now, input.monthStart);
    const count = (rows: Record<string, unknown>[]) => {
        const n = counter(rows[0]?.n);
        if (n === null) throw new Error('admission counter query returned no count');
        return n;
    };
    const runningByRegion: Record<string, number> = {};
    const runningVcpuByRegion: Record<string, number> = {};
    let runningUnplaced = 0;
    let runningVcpuUnplaced = 0;
    const runningVcpu = counter(runningRows[0]?.vcpu);
    if (runningVcpu === null) throw new Error('admission counter query returned no vcpu');
    for (const r of regionRows) {
        const n = counter(r.n);
        if (n === null) throw new Error('admission region counter returned no count');
        const vcpu = counter(r.vcpu);
        if (vcpu === null) throw new Error('admission region counter returned no vcpu');
        if (r.region === null || r.region === undefined) {
            runningUnplaced += n;
            runningVcpuUnplaced += vcpu;
        } else if (typeof r.region === 'string' && !Object.prototype.hasOwnProperty.call(runningByRegion, r.region)) {
            runningByRegion[r.region] = n;
            runningVcpuByRegion[r.region] = vcpu;
        }
        else throw new Error('admission region counter returned a duplicate or invalid region');
    }
    const owner = ownerRows[0];
    return {
        targetOwnerId: typeof owner?.user_id === 'string' ? owner.user_id : null,
        targetPlacementOwnerId: target.record?.ownerUserId ?? null,
        targetDeleted: owner?.deleted === true,
        targetForeignUsage: count(foreignRows),
        runningCount: count(runningRows),
        runningVcpu,
        runningByRegion,
        runningUnplaced,
        runningVcpuByRegion,
        runningVcpuUnplaced,
        userOtherAwsComputers: count(userRows),
        duplicates,
        usage,
    };
}

// ── Retention reads ──────────────────────────────────────────────────────

/**
 * Read-only input to the purge dry run (§6): every STOPPED or RETIRED AWS
 * placement and when it last changed. Only aws-ec2 rows retain a volume: a
 * `cloudflare` row (a pinned Cloudflare computer, select.ts) is never a candidate. For RETIRED, `updated_at` is the
 * retirement stamp (C-2 has no `retired_at`); a later write only delays
 * eligibility, which is the safe direction.
 */
export async function readRetentionCandidates(db: PlacementExecutor): Promise<{ computerId: string; state: PlacementState; updatedAt: Date }[]> {
    const rows = rowsOf(
        await db.execute(sql`/* placement:retention */ SELECT computer_id::text AS computer_id, state, updated_at
            FROM public.ezil_computer_placements
            WHERE provider = 'aws-ec2' AND state IN ('STOPPED', 'RETIRED')`),
    );
    return rows.map((r) => {
        const computerId = String(r.computer_id);
        const updatedAt = timestamp(r.updated_at);
        if (!updatedAt || !oneOf(PLACEMENT_STATES, r.state)) throw new PlacementIntegrityError('invalid_row', computerId);
        return { computerId, state: r.state, updatedAt };
    });
}

/** Lifecycle authority may inspect a migration boot; user routing must keep using readPlacement. */
export async function readLifecyclePlacement(db: PlacementExecutor, computerId: string): Promise<ResolvedPlacement> {
    return (await import('./provider-migrate-provision')).readEnrollmentPlacement(db, computerId);
}

export interface PaidMigrationCandidate {
    userId: string;
    computerId: string;
    toSize: 'standard' | 'premium';
}

/** One computer per paid owner, including the implicit Cloudflare placement. */
export async function paidCloudflareCandidates(db: PlacementExecutor, now: Date, limit = 10): Promise<PaidMigrationCandidate[]> {
    const count = Number.isFinite(limit) ? Math.max(0, Math.min(10, Math.trunc(limit))) : 0;
    if (!count) return [];
    const result = await db.execute(sql`SELECT DISTINCT ON (s.user_id) s.user_id::text AS user_id,
        c.id::text AS computer_id, s.sku
        FROM public.ezil_billing_subscriptions s
        JOIN public.ezil_computers c ON c.user_id = s.user_id AND c.deleted_at IS NULL
        LEFT JOIN public.ezil_computer_placements p ON p.computer_id = c.id
        WHERE s.sku IN ('standard_monthly_v3', 'premium_monthly_v3') AND s.status = 'active'
          AND s.current_period_start <= ${now.toISOString()}::timestamptz
          AND s.current_period_end > ${now.toISOString()}::timestamptz
          AND (p.computer_id IS NULL OR p.provider = 'cloudflare')
          AND NOT EXISTS (SELECT 1 FROM public.ezil_compute_migrations done WHERE done.computer_id = c.id
            AND done.state = 'committed' AND done.last_error = 'fresh_provision')
          AND NOT EXISTS (SELECT 1 FROM public.ezil_compute_migrations m WHERE m.user_id = s.user_id
            AND (m.state NOT IN ('committed', 'failed_reopened', 'failed_needs_operator')
              OR m.updated_at >= ${new Date(now.getTime() - 600_000).toISOString()}::timestamptz))
        ORDER BY s.user_id, s.current_period_end DESC, s.current_period_start DESC, c.slot, c.id LIMIT ${count}`);
    const rows: Record<string, unknown>[] = (Array.isArray(result) ? result : (result as { rows?: Record<string, unknown>[] })?.rows) ?? [];
    return rows.map(row => ({ userId: String(row.user_id), computerId: String(row.computer_id),
        toSize: row.sku === 'standard_monthly_v3' ? 'standard' : 'premium' }));
}
