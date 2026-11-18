/**
 * Native session authority: the single writer of `ezil_native_session_operations`
 * (`app/drizzle/0029_native_session_operations.sql`, reserved and unapplied).
 *
 * Every accepted create or renew is an immutable (user, operation) tombstone that pins the canonical request
 * digest, the session and instruction revision, the owner and computer, and the AWS placement tuple
 * (generation, lease epoch, instance, fence) authority admitted. The same operation id with a different
 * request always conflicts, also after the computer is deleted or reassigned, because the tombstone is read
 * before anything about the computer.
 *
 * ## Claim transaction (READ COMMITTED, asserted on every lock statement)
 *
 * 1. Operation advisory lock (`NATIVE_OPERATION_LOCK_NAMESPACE`, hashtext of user/operation) FIRST.
 * 2. Tombstone lookup: same digest replays the stored row, another digest conflicts.
 * 3. Session advisory lock (`NATIVE_SESSION_LOCK_NAMESPACE`, hashtext of user/session): every create and renew
 *    of one session is serialised here. A new renewal key is refused while any earlier renewal is in flight
 *    or ended unknown (`exchange_unknown`, `delivery_unknown`); only positive reconciliation, which this
 *    module does not perform, could clear it. The gate reads stored rows only, never caller state.
 * 4. The canonical per-computer lock, the exact statement shape of the placement module
 *    (`PLACEMENT_LOCK_NAMESPACE`, `hashtext(<uuid>::text)`), then the live owned computer row `FOR SHARE`,
 *    then `readPlacement(tx, computerId, userId)`.
 * 5. Require AWS, RUNNING, a well-formed instance and fence, an unexpired lease (database clock) and the
 *    current owner; insert the tombstone as `claimed`.
 *
 * Never ensures, starts or wakes a computer and never takes the global admission lock. Each exported call is
 * one short transaction or one autocommit statement, so no database lock is ever held across the network:
 * callers exchange and deliver between calls. Outcomes move by compare-and-swap; the table's guard trigger
 * refuses illegal transitions, identity changes, DELETE and TRUNCATE. No token, proof or credential is stored.
 */

import { createHash } from 'node:crypto';

import { sql, type SQL } from 'drizzle-orm';

import {
    ImageJobConflictError, PLACEMENT_LOCK_NAMESPACE, PlacementIntegrityError, PlacementIsolationError, PlacementOwnerError,
    readPlacement, type PlacementExecutor,
} from '@/server/lib/compute/placement';

/** `pg_advisory_xact_lock(int4, int4)` namespace for operation keys. ASCII "EZno"; distinct from every other namespace. */
export const NATIVE_OPERATION_LOCK_NAMESPACE = 0x455a6e6f;
/** Namespace for session keys, taken after the operation lock and before the computer lock. ASCII "EZns". */
export const NATIVE_SESSION_LOCK_NAMESPACE = 0x455a6e73;

/** Renewal states that block a new renewal key: still in flight, or ended with an unknown external effect. */
const UNSETTLED_RENEWAL_STATES = ['claimed', 'exchanging', 'granted', 'delivering', 'exchange_unknown', 'delivery_unknown'] as const;

export interface NativeAuthorityDb extends PlacementExecutor {
    transaction<T>(fn: (tx: PlacementExecutor) => Promise<T>): Promise<T>;
}

export const NATIVE_OPERATION_STATES = [
    'claimed', 'exchanging', 'exchange_refused', 'exchange_unknown', 'granted',
    'authority_changed', 'delivering', 'delivered', 'host_refused', 'delivery_unknown',
] as const;
export type NativeOperationState = (typeof NATIVE_OPERATION_STATES)[number];

/** Final states. Every other state is in flight or interrupted: status reports it as stored, nothing resumes it. */
export const NATIVE_TERMINAL_STATES: ReadonlySet<NativeOperationState> = new Set([
    'exchange_refused', 'exchange_unknown', 'authority_changed', 'delivered', 'host_refused', 'delivery_unknown',
]);

/** Mirrors the guard trigger. `reason` is required exactly for the states that carry one. */
const TRANSITIONS: Readonly<Record<string, { reasons: readonly string[] | null; grant: boolean }>> = {
    'claimed>exchanging': { reasons: null, grant: false },
    // gateway_refused: a clean Gateway 4xx. The others are definite pre-send refusals: nothing was sent.
    'exchanging>exchange_refused': { reasons: ['gateway_refused', 'lease_boundary', 'proof_invalid', 'service_expired', 'request_too_large'], grant: false },
    'exchanging>exchange_unknown': { reasons: ['gateway_timeout', 'gateway_unavailable', 'gateway_invalid_response'], grant: false },
    'exchanging>granted': { reasons: null, grant: true },
    // authorization_revoked / authorization_unavailable: the owner's consent was stopped or is no longer readable,
    // proven before any host dispatch (the move happens before `delivering`).
    'granted>authority_changed': { reasons: ['placement_changed', 'lease_expired', 'computer_not_found', 'computer_not_aws',
        'computer_not_running', 'placement_unavailable', 'computer_busy', 'placement_invalid', 'lease_boundary', 'authorization_revoked',
        'authorization_unavailable'], grant: false },
    'granted>delivering': { reasons: null, grant: false },
    'delivering>delivered': { reasons: null, grant: false },
    'delivering>host_refused': { reasons: ['host_unavailable', 'host_refused', 'placement_mismatch'], grant: false },
    'delivering>delivery_unknown': { reasons: ['host_timeout', 'host_no_ack'], grant: false },
};

export interface NativeCreateRequest {
    kind: 'create';
    operationId: string;
    sessionId: string;
    computerId: string;
    instructionRevision: 1;
    instructionDigest: string;
    taskRef: string;
}

export interface NativeRenewRequest {
    kind: 'renew';
    operationId: string;
    sessionId: string;
}

export type NativeOperationRequest = NativeCreateRequest | NativeRenewRequest;

/** Placement counters are bigint decimal strings end to end: never narrowed to int4. */
export interface PinnedPlacement {
    generation: string;
    leaseEpoch: string;
    instanceId: string;
    fenceToken: string;
}

export interface NativeOperation {
    userId: string;
    operationId: string;
    kind: 'create' | 'renew';
    sessionId: string;
    computerId: string;
    instructionRevision: string;
    instructionDigest: string;
    taskRef: string;
    requestDigest: string;
    placement: PinnedPlacement;
    state: NativeOperationState;
    reason: string | null;
    grantId: string | null;
    grantExpiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export type NativeRefusal =
    | 'computer_not_found' | 'computer_not_aws' | 'computer_not_running' | 'placement_unavailable' | 'lease_expired'
    | 'computer_busy' | 'placement_invalid' | 'session_not_found' | 'session_not_active' | 'placement_changed'
    | 'renewal_pending' | 'renewal_unreconciled' | 'lease_boundary';

export type NativeClaimResult =
    | { kind: 'claimed'; operation: NativeOperation; leaseUntil: Date }
    | { kind: 'existing'; operation: NativeOperation }
    | { kind: 'conflict'; reason: 'operation_conflict' | 'session_exists' }
    | { kind: 'refused'; reason: NativeRefusal };

/** `leaseUntil` is the live lease boundary at check time: nothing delivered may outlive it. */
export type NativeAuthorityCheck = { ok: true; placement: PinnedPlacement; leaseUntil: Date } | { ok: false; reason: NativeRefusal };

export interface NativeSessionStatus {
    created: NativeOperation;
    latest: NativeOperation;
}

/** A stored row that does not parse. Fails closed; never guessed. */
export class NativeOperationIntegrityError extends Error {
    constructor() { super('native_operation_invalid_row'); this.name = 'NativeOperationIntegrityError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TASK_REF = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const INSTANCE = /^i-[0-9a-f]{8,17}$/;
const COUNTER = /^(0|[1-9][0-9]{0,18})$/;

function rowsOf(result: unknown): Record<string, unknown>[] {
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    return ((result as { rows?: Record<string, unknown>[] } | null)?.rows ?? []) as Record<string, unknown>[];
}

function assertRequest(request: NativeOperationRequest): void {
    const ok = UUID.test(request.operationId) && UUID.test(request.sessionId) && (request.kind === 'renew'
        || (UUID.test(request.computerId) && request.instructionRevision === 1 && DIGEST.test(request.instructionDigest)
            && TASK_REF.test(request.taskRef)));
    if (!ok) throw new TypeError('invalid native operation request');
}

/** sha256 over the canonical request semantics (lowercase ids, fixed field order). The operation id is the key, not the digest. */
export function nativeRequestDigest(request: NativeOperationRequest): string {
    assertRequest(request);
    const canonical = request.kind === 'create'
        ? ['ezil.native-session.request.v1', 'create', request.sessionId, request.computerId, String(request.instructionRevision),
            request.instructionDigest, request.taskRef]
        : ['ezil.native-session.request.v1', 'renew', request.sessionId];
    return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

// ── Locks ────────────────────────────────────────────────────────────────

function assertReadCommitted(result: unknown): void {
    const isolation = rowsOf(result)[0]?.isolation;
    if (isolation !== 'read committed') throw new PlacementIsolationError(String(isolation));
}

async function lockOperation(tx: PlacementExecutor, userId: string, operationId: string): Promise<void> {
    assertReadCommitted(await tx.execute(sql`/* native-session:lock-operation */ SELECT pg_advisory_xact_lock(${NATIVE_OPERATION_LOCK_NAMESPACE}::int4, hashtext(${userId}::uuid::text || '/' || ${operationId}::uuid::text)), current_setting('transaction_isolation') AS isolation`));
}

async function lockSession(tx: PlacementExecutor, userId: string, sessionId: string): Promise<void> {
    assertReadCommitted(await tx.execute(sql`/* native-session:lock-session */ SELECT pg_advisory_xact_lock(${NATIVE_SESSION_LOCK_NAMESPACE}::int4, hashtext(${userId}::uuid::text || '/' || ${sessionId}::uuid::text)), current_setting('transaction_isolation') AS isolation`));
}

/**
 * The placement module's per-computer lock, statement for statement, asserting READ COMMITTED. Exported so the
 * native consent STOP serialises with dispatch on the very same lock.
 */
export async function lockComputer(tx: PlacementExecutor, computerId: string): Promise<void> {
    assertReadCommitted(await tx.execute(sql`/* native-session:lock-computer */ SELECT pg_advisory_xact_lock(${PLACEMENT_LOCK_NAMESPACE}::int4, hashtext(${computerId}::uuid::text)), current_setting('transaction_isolation') AS isolation`));
}

// ── Rows ─────────────────────────────────────────────────────────────────

const COLUMNS = sql.raw([
    'user_id::text AS user_id', 'operation_id::text AS operation_id', 'kind', 'session_id::text AS session_id',
    'computer_id::text AS computer_id', 'instruction_revision::text AS instruction_revision', 'instruction_digest', 'task_ref',
    'request_digest', 'placement_generation::text AS placement_generation', 'placement_lease_epoch::text AS placement_lease_epoch',
    'placement_instance_id', 'placement_fence_token::text AS placement_fence_token', 'state', 'reason', 'grant_id::text AS grant_id',
    'grant_expires_at', 'created_at', 'updated_at',
].join(', '));

function time(value: unknown): Date | null | undefined {
    if (value === null || value === undefined) return null;
    const d = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
    return d && Number.isFinite(d.getTime()) ? d : undefined;
}

function parseOperation(row: Record<string, unknown>): NativeOperation {
    const fail = (): never => { throw new NativeOperationIntegrityError(); };
    const text = (key: string, pattern?: RegExp): string => {
        const v = row[key];
        return typeof v === 'string' && (!pattern || pattern.test(v)) ? v : fail();
    };
    const kind = row.kind === 'create' || row.kind === 'renew' ? row.kind : fail();
    const state = (NATIVE_OPERATION_STATES as readonly unknown[]).includes(row.state) ? row.state as NativeOperationState : fail();
    const reason = row.reason === null ? null : text('reason', /^[a-z][a-z0-9_]{0,63}$/);
    const grantId = row.grant_id === null ? null : text('grant_id', UUID);
    const grantExpiresAt = time(row.grant_expires_at);
    const createdAt = time(row.created_at);
    const updatedAt = time(row.updated_at);
    if (grantExpiresAt === undefined || !createdAt || !updatedAt || (grantId === null) !== (grantExpiresAt === null)) fail();
    return {
        userId: text('user_id', UUID), operationId: text('operation_id', UUID), kind, sessionId: text('session_id', UUID),
        computerId: text('computer_id', UUID), instructionRevision: text('instruction_revision', COUNTER),
        instructionDigest: text('instruction_digest', DIGEST), taskRef: text('task_ref', TASK_REF),
        requestDigest: text('request_digest', DIGEST),
        placement: {
            generation: text('placement_generation', COUNTER), leaseEpoch: text('placement_lease_epoch', COUNTER),
            instanceId: text('placement_instance_id', INSTANCE), fenceToken: text('placement_fence_token', UUID),
        },
        state, reason, grantId, grantExpiresAt: grantExpiresAt ?? null, createdAt: createdAt!, updatedAt: updatedAt!,
    };
}

async function selectOne(db: PlacementExecutor, query: SQL): Promise<NativeOperation | null> {
    const rows = rowsOf(await db.execute(query));
    if (rows.length > 1) throw new NativeOperationIntegrityError();
    return rows[0] ? parseOperation(rows[0]) : null;
}

function selectOperation(db: PlacementExecutor, userId: string, operationId: string): Promise<NativeOperation | null> {
    return selectOne(db, sql`/* native-session:operation */ SELECT ${COLUMNS} FROM public.ezil_native_session_operations
        WHERE user_id = ${userId}::uuid AND operation_id = ${operationId}::uuid`);
}

function selectSessionCreate(db: PlacementExecutor, userId: string, sessionId: string): Promise<NativeOperation | null> {
    return selectOne(db, sql`/* native-session:session-create */ SELECT ${COLUMNS} FROM public.ezil_native_session_operations
        WHERE user_id = ${userId}::uuid AND session_id = ${sessionId}::uuid AND kind = 'create'`);
}

// ── Authority ────────────────────────────────────────────────────────────

/**
 * Under the computer lock: live owned computer row FOR SHARE, then the placement module's own read. Must run
 * inside a READ COMMITTED transaction (asserted by the lock statement); the native consent store uses it to pin
 * the approved tuple under the same lock and statement shapes as the claim.
 */
export async function currentAuthority(tx: PlacementExecutor, userId: string, computerId: string): Promise<NativeAuthorityCheck> {
    await lockComputer(tx, computerId);
    const owner = rowsOf(await tx.execute(sql`/* native-session:computer-owner */ SELECT id::text AS id FROM public.ezil_computers
        WHERE id = ${computerId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL FOR SHARE`));
    if (owner.length !== 1) return { ok: false, reason: 'computer_not_found' };
    let record;
    try {
        record = (await readPlacement(tx, computerId, userId)).record;
    } catch (error) {
        if (error instanceof PlacementOwnerError) return { ok: false, reason: 'computer_not_found' };
        if (error instanceof ImageJobConflictError) return { ok: false, reason: 'computer_busy' };
        if (error instanceof PlacementIntegrityError) return { ok: false, reason: 'placement_invalid' };
        throw error;
    }
    if (!record || record.provider !== 'aws-ec2') return { ok: false, reason: 'computer_not_aws' };
    if (record.state !== 'RUNNING') return { ok: false, reason: 'computer_not_running' };
    const fenceToken = record.fenceToken?.toLowerCase() ?? '';
    if (!record.instanceId || !INSTANCE.test(record.instanceId) || !UUID.test(fenceToken)) return { ok: false, reason: 'placement_unavailable' };
    const clock = time(rowsOf(await tx.execute(sql`/* native-session:clock */ SELECT clock_timestamp() AS now`))[0]?.now);
    if (!clock) throw new NativeOperationIntegrityError();
    if (!record.leaseUntil || record.leaseUntil.getTime() <= clock.getTime()) return { ok: false, reason: 'lease_expired' };
    return {
        ok: true,
        placement: { generation: String(record.generation), leaseEpoch: String(record.leaseEpoch), instanceId: record.instanceId, fenceToken },
        leaseUntil: record.leaseUntil,
    };
}

export function samePlacement(a: PinnedPlacement, b: PinnedPlacement): boolean {
    return a.generation === b.generation && a.leaseEpoch === b.leaseEpoch && a.instanceId === b.instanceId && a.fenceToken === b.fenceToken;
}

/**
 * Claim a create or renew. One transaction; nothing external happens inside it. A replay with the same
 * digest returns the stored tombstone whatever its state (in flight and interrupted look alike once the lock
 * is released) and must never be re-exchanged or re-delivered by the caller.
 *
 * `leaseMustCover`: the latest expiry the caller's exchange can produce. A lease ending at or before it is
 * refused (`lease_boundary`) with no tombstone, so nothing is exchanged for a grant the lease cannot hold.
 * The claimed result carries the admitted `leaseUntil` for validating the grant afterwards.
 *
 * `expectPlacement`: the full tuple the owner's consent approved. When given, the live tuple read under the
 * claim's own locks must equal it exactly, else `placement_changed` with no tombstone.
 */
export async function claimNativeOperation(db: NativeAuthorityDb, userId: string, request: NativeOperationRequest,
    options: { leaseMustCover?: Date; expectPlacement?: PinnedPlacement } = {}): Promise<NativeClaimResult> {
    if (!UUID.test(userId)) throw new TypeError('invalid user id');
    const digest = nativeRequestDigest(request);
    return db.transaction(async (tx): Promise<NativeClaimResult> => {
        await lockOperation(tx, userId, request.operationId);
        const existing = await selectOperation(tx, userId, request.operationId);
        if (existing) {
            return existing.requestDigest === digest && existing.kind === request.kind && existing.sessionId === request.sessionId
                ? { kind: 'existing', operation: existing } : { kind: 'conflict', reason: 'operation_conflict' };
        }
        await lockSession(tx, userId, request.sessionId);
        const created = await selectSessionCreate(tx, userId, request.sessionId);
        let pinned: PinnedPlacement | null = null;
        let fields: { computerId: string; revision: string; instructionDigest: string; taskRef: string };
        if (request.kind === 'create') {
            if (created) return { kind: 'conflict', reason: 'session_exists' };
            fields = { computerId: request.computerId, revision: '1', instructionDigest: request.instructionDigest, taskRef: request.taskRef };
        } else {
            if (!created) return { kind: 'refused', reason: 'session_not_found' };
            if (created.state !== 'delivered') return { kind: 'refused', reason: 'session_not_active' };
            const prior = rowsOf(await tx.execute(sql`/* native-session:renewal-gate */ SELECT state FROM public.ezil_native_session_operations
                WHERE user_id = ${userId}::uuid AND session_id = ${request.sessionId}::uuid AND kind = 'renew'
                    AND state IN (${sql.join(UNSETTLED_RENEWAL_STATES.map(s => sql`${s}`), sql`, `)})`));
            if (prior.some(row => row.state === 'exchange_unknown' || row.state === 'delivery_unknown')) {
                return { kind: 'refused', reason: 'renewal_unreconciled' };
            }
            if (prior.length > 0) return { kind: 'refused', reason: 'renewal_pending' };
            pinned = created.placement;
            fields = { computerId: created.computerId, revision: created.instructionRevision, instructionDigest: created.instructionDigest,
                taskRef: created.taskRef };
        }
        const authority = await currentAuthority(tx, userId, fields.computerId);
        if (!authority.ok) return { kind: 'refused', reason: authority.reason };
        if (pinned && !samePlacement(pinned, authority.placement)) return { kind: 'refused', reason: 'placement_changed' };
        if (options.expectPlacement && !samePlacement(options.expectPlacement, authority.placement)) return { kind: 'refused', reason: 'placement_changed' };
        if (options.leaseMustCover && authority.leaseUntil.getTime() <= options.leaseMustCover.getTime()) {
            return { kind: 'refused', reason: 'lease_boundary' };
        }
        const p = authority.placement;
        // DO NOTHING covers a concurrent create of the same session on another computer (different lock).
        const inserted = await selectOne(tx, sql`/* native-session:claim */ INSERT INTO public.ezil_native_session_operations
            (user_id, operation_id, kind, session_id, computer_id, instruction_revision, instruction_digest, task_ref, request_digest,
             placement_generation, placement_lease_epoch, placement_instance_id, placement_fence_token, state, created_at, updated_at)
            VALUES (${userId}::uuid, ${request.operationId}::uuid, ${request.kind}, ${request.sessionId}::uuid, ${fields.computerId}::uuid,
                ${fields.revision}::bigint, ${fields.instructionDigest}, ${fields.taskRef}, ${digest}, ${p.generation}::bigint,
                ${p.leaseEpoch}::bigint, ${p.instanceId}, ${p.fenceToken}::uuid, 'claimed', clock_timestamp(), clock_timestamp())
            ON CONFLICT DO NOTHING
            RETURNING ${COLUMNS}`);
        return inserted ? { kind: 'claimed', operation: inserted, leaseUntil: authority.leaseUntil } : { kind: 'conflict', reason: 'session_exists' };
    });
}

/**
 * Whether `computerId` is a live computer of `userId` right now (`ezil_computers` owner, `deleted_at IS NULL`).
 * One SELECT; no lock, refresh or write. Gates serialising a replayed receipt; never consulted for a conflict.
 */
export async function nativeComputerOwnedNow(db: PlacementExecutor, userId: string, computerId: string): Promise<boolean> {
    if (!UUID.test(userId) || !UUID.test(computerId)) throw new TypeError('invalid native ownership key');
    const rows = rowsOf(await db.execute(sql`/* native-session:owned-now */ SELECT 1 AS owned FROM public.ezil_computers
        WHERE id = ${computerId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL`));
    return rows.length === 1;
}

/** Read-only replay lookup for the caller's own operation key. No lock, no write. */
export function lookupNativeOperation(db: PlacementExecutor, userId: string, operationId: string): Promise<NativeOperation | null> {
    if (!UUID.test(userId) || !UUID.test(operationId)) throw new TypeError('invalid native operation key');
    return selectOperation(db, userId, operationId);
}

/**
 * Recheck current authority against an operation's pinned tuple immediately before private host delivery.
 * Same lock order as the claim. The host must still recheck independently when it executes.
 */
export function recheckNativeAuthority(db: NativeAuthorityDb, operation: NativeOperation): Promise<NativeAuthorityCheck> {
    return db.transaction(async (tx): Promise<NativeAuthorityCheck> => {
        await lockOperation(tx, operation.userId, operation.operationId);
        const authority = await currentAuthority(tx, operation.userId, operation.computerId);
        if (!authority.ok) return authority;
        return samePlacement(operation.placement, authority.placement) ? authority : { ok: false, reason: 'placement_changed' };
    });
}

/**
 * Compare-and-swap one state move (autocommit). Returns null when the stored state is no longer `from`:
 * the caller stops and never performs the external step the move would have authorised.
 */
export async function advanceNativeOperation(
    db: PlacementExecutor,
    operation: Pick<NativeOperation, 'userId' | 'operationId'>,
    from: NativeOperationState,
    to: NativeOperationState,
    detail: { reason?: string; grant?: { id: string; expiresAt: Date } } = {},
): Promise<NativeOperation | null> {
    const rule = TRANSITIONS[`${from}>${to}`];
    const reason = detail.reason ?? null;
    if (!rule || (rule.reasons === null ? reason !== null : !rule.reasons.includes(reason ?? ''))
        || rule.grant !== (detail.grant !== undefined)) throw new TypeError(`illegal native operation transition ${from}>${to}`);
    const grantId = detail.grant ? detail.grant.id.toLowerCase() : null;
    if (grantId !== null && !UUID.test(grantId)) throw new TypeError('invalid grant id');
    const grantExpiresAt = detail.grant ? detail.grant.expiresAt.toISOString() : null;
    return selectOne(db, sql`/* native-session:advance */ UPDATE public.ezil_native_session_operations
        SET state = ${to}, reason = ${reason}, grant_id = COALESCE(${grantId}::uuid, grant_id),
            grant_expires_at = COALESCE(${grantExpiresAt}::timestamptz, grant_expires_at),
            updated_at = GREATEST(clock_timestamp(), updated_at)
        WHERE user_id = ${operation.userId}::uuid AND operation_id = ${operation.operationId}::uuid AND state = ${from}
        RETURNING ${COLUMNS}`);
}

/**
 * Current status of the caller's session: its create tombstone and latest operation, returned only while the
 * session's computer is still a live computer of the caller (`ezil_computers` owner, `deleted_at IS NULL`).
 * After deletion or reassignment this answers null; the tombstones themselves stay intact and
 * `lookupNativeOperation` still replays them. One SELECT: no lock, refresh, exchange, wake, dispatch or write.
 */
export async function readNativeSessionStatus(db: PlacementExecutor, userId: string, sessionId: string): Promise<NativeSessionStatus | null> {
    if (!UUID.test(userId) || !UUID.test(sessionId)) throw new TypeError('invalid native session key');
    const live = sql`EXISTS (SELECT 1 FROM public.ezil_computers c
        WHERE c.id = o.computer_id AND c.user_id = ${userId}::uuid AND c.deleted_at IS NULL)`;
    const rows = rowsOf(await db.execute(sql`/* native-session:status */
        (SELECT 'created' AS part, ${COLUMNS} FROM public.ezil_native_session_operations o
            WHERE o.user_id = ${userId}::uuid AND o.session_id = ${sessionId}::uuid AND o.kind = 'create' AND ${live})
        UNION ALL
        (SELECT 'latest' AS part, ${COLUMNS} FROM public.ezil_native_session_operations o
            WHERE o.user_id = ${userId}::uuid AND o.session_id = ${sessionId}::uuid AND ${live}
            ORDER BY o.created_at DESC, o.operation_id DESC LIMIT 1)`));
    const created = rows.filter(row => row.part === 'created');
    const latest = rows.filter(row => row.part === 'latest');
    if (created.length === 0 && latest.length === 0) return null;
    if (created.length !== 1 || latest.length !== 1) throw new NativeOperationIntegrityError();
    return { created: parseOperation(created[0]!), latest: parseOperation(latest[0]!) };
}
