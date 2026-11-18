/**
 * Native runtime control store: the single writer of `0032` (`app/drizzle/0032_runtime_control.sql`, reserved and
 * unapplied). Leases, requests and tombstones.
 *
 * - A request is an immutable (owner, requestId) row: unique per owner across clients, sessions and runtime epochs.
 *   The same id with other semantics conflicts forever; an id equal to one of the owner's `0029` operation ids
 *   (an initial task) conflicts too, so the exact getter never aliases.
 * - Admission is one short READ COMMITTED transaction: owner/request lock, replay, `0029` alias, tombstone, then
 *   owner/session lock, lease reuse or creation, insert. Nothing external happens inside; no lock is held across
 *   the network.
 * - The outbox is the request row itself: `approved → dispatching` by compare-and-swap exactly once (the
 *   `dispatch_claimed_at` stamp is permanent). Every later move is a guarded CAS; the trigger refuses the rest.
 * - Reads here never write. Consent expiry is derived at read time and persisted only by the consent decision.
 */
import { randomUUID } from 'node:crypto';

import { sql, type SQL } from 'drizzle-orm';

import { PLACEMENT_LOCK_NAMESPACE, PlacementIsolationError, type PlacementExecutor } from '@/server/lib/compute/placement';
import type { NativeAuthorityDb } from './authority';
import { readCurrentPlacement } from './runtime-authority';
import {
    CONTROL_EFFECTS, CONTROL_STATES, COUNTER, DIGEST, PRODUCER_DIGEST, RUNTIME_LEASE_DOMAIN, RUNTIME_LIMITS, RUNTIME_PROFILE_ID,
    isUuid, plainObject, sha256Hex, type ControlEffect, type ControlKind, type ControlState, type RuntimeControlBody,
    type RuntimePlacement, type RuntimeReason,
} from './runtime-contract';

/** `pg_advisory_xact_lock(int4, int4)` namespaces. ASCII "EZrr" (owner/request) and "EZrl" (owner/session lease). */
export const RUNTIME_REQUEST_LOCK_NAMESPACE = 0x455a7272;
export const RUNTIME_LEASE_LOCK_NAMESPACE = 0x455a726c;

export class RuntimeStoreIntegrityError extends Error {
    constructor() { super('native_runtime_invalid_row'); this.name = 'RuntimeStoreIntegrityError'; }
}

export type LeaseState = 'required' | 'approved' | 'denied';
export type ActionSet = 'runtime' | 'cancel_only';

export interface RuntimeLeaseScope {
    ownerUserId: string;
    clientId: string;
    sessionId: string;
    computerId: string;
    runtimeId: string | null;
    hostEpoch: string | null;
    placement: RuntimePlacement;
    policyDigest: string | null;
    aiAuthorizationId: string;
    actionSet: ActionSet;
}

export interface RuntimeLease extends RuntimeLeaseScope {
    controlAuthorizationId: string;
    profile: typeof RUNTIME_PROFILE_ID;
    preparedRequestId: string;
    leaseDigest: string;
    state: LeaseState;
    consentExpiresAt: Date;
    controlDeadline: Date;
    decidedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface RuntimeRequest {
    ownerUserId: string;
    requestId: string;
    clientId: string;
    sessionId: string;
    computerId: string;
    kind: ControlKind;
    requestDigest: string;
    instructionDigest: string | null;
    instruction: string | null;
    promptId: string | null;
    promptRevision: number | null;
    promptInputDigest: string | null;
    decision: 'allow' | 'deny' | null;
    message: string | null;
    targetRequestId: string | null;
    promptSnapshot: Record<string, unknown> | null;
    controlAuthorizationId: string | null;
    requestDeadline: Date | null;
    state: ControlState;
    effect: ControlEffect;
    reason: string | null;
    dispatchClaimedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface StoredRuntimeRequest { request: RuntimeRequest; lease: RuntimeLease | null }

// ── Rows ─────────────────────────────────────────────────────────────────

function rowsOf(result: unknown): Record<string, unknown>[] {
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    return ((result as { rows?: Record<string, unknown>[] } | null)?.rows ?? []) as Record<string, unknown>[];
}

function time(value: unknown): Date | null | undefined {
    if (value === null || value === undefined) return null;
    const d = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
    return d && Number.isFinite(d.getTime()) ? d : undefined;
}

const fail = (): never => { throw new RuntimeStoreIntegrityError(); };

const REQUEST_COLUMNS = sql.raw([
    'r.owner_user_id::text AS r_owner_user_id', 'r.request_id::text AS r_request_id', 'r.client_id AS r_client_id',
    'r.session_id::text AS r_session_id', 'r.computer_id::text AS r_computer_id', 'r.kind AS r_kind',
    'r.request_digest AS r_request_digest', 'r.instruction_digest AS r_instruction_digest', 'r.instruction AS r_instruction',
    'r.prompt_id::text AS r_prompt_id', 'r.prompt_revision AS r_prompt_revision', 'r.prompt_input_digest AS r_prompt_input_digest',
    'r.decision AS r_decision', 'r.message AS r_message', 'r.target_request_id::text AS r_target_request_id',
    'r.prompt_snapshot AS r_prompt_snapshot', 'r.control_authorization_id::text AS r_control_authorization_id',
    'r.request_deadline AS r_request_deadline', 'r.state AS r_state', 'r.effect AS r_effect', 'r.reason AS r_reason',
    'r.dispatch_claimed_at AS r_dispatch_claimed_at', 'r.created_at AS r_created_at', 'r.updated_at AS r_updated_at',
].join(', '));

const LEASE_COLUMNS = sql.raw([
    'l.control_authorization_id::text AS l_control_authorization_id', 'l.owner_user_id::text AS l_owner_user_id',
    'l.client_id AS l_client_id', 'l.session_id::text AS l_session_id', 'l.computer_id::text AS l_computer_id',
    'l.runtime_id::text AS l_runtime_id', 'l.host_epoch AS l_host_epoch', 'l.placement_generation::text AS l_placement_generation',
    'l.placement_lease_epoch::text AS l_placement_lease_epoch', 'l.placement_instance_id AS l_placement_instance_id',
    'l.placement_fence_token::text AS l_placement_fence_token', 'l.profile AS l_profile', 'l.policy_digest AS l_policy_digest',
    'l.ai_authorization_id::text AS l_ai_authorization_id', 'l.action_set AS l_action_set',
    'l.prepared_request_id::text AS l_prepared_request_id', 'l.lease_digest AS l_lease_digest', 'l.state AS l_state',
    'l.consent_expires_at AS l_consent_expires_at', 'l.control_deadline AS l_control_deadline', 'l.decided_at AS l_decided_at',
    'l.created_at AS l_created_at', 'l.updated_at AS l_updated_at',
].join(', '));

function parseLease(row: Record<string, unknown>): RuntimeLease {
    const text = (key: string, pattern?: RegExp): string => {
        const v = row[`l_${key}`];
        return typeof v === 'string' && (!pattern || pattern.test(v)) ? v : fail();
    };
    const nullable = (key: string, pattern: RegExp): string | null => row[`l_${key}`] === null ? null : text(key, pattern);
    const state = row.l_state === 'required' || row.l_state === 'approved' || row.l_state === 'denied' ? row.l_state : fail();
    const actionSet = row.l_action_set === 'runtime' || row.l_action_set === 'cancel_only' ? row.l_action_set : fail();
    const consentExpiresAt = time(row.l_consent_expires_at);
    const controlDeadline = time(row.l_control_deadline);
    const decidedAt = time(row.l_decided_at);
    const createdAt = time(row.l_created_at);
    const updatedAt = time(row.l_updated_at);
    if (!consentExpiresAt || !controlDeadline || decidedAt === undefined || !createdAt || !updatedAt) fail();
    if (row.l_profile !== RUNTIME_PROFILE_ID) fail();
    const runtimeId = nullable('runtime_id', /^[0-9a-f-]{36}$/);
    const hostEpoch = nullable('host_epoch', /^[A-Za-z0-9_-]{1,128}$/);
    if ((runtimeId === null) !== (hostEpoch === null) || (runtimeId !== null && !isUuid(runtimeId))) fail();
    return {
        controlAuthorizationId: text('control_authorization_id', /^[0-9a-f-]{36}$/), ownerUserId: text('owner_user_id'),
        clientId: text('client_id'), sessionId: text('session_id'), computerId: text('computer_id'), runtimeId, hostEpoch,
        placement: {
            generation: text('placement_generation', COUNTER), leaseEpoch: text('placement_lease_epoch', COUNTER),
            instanceId: text('placement_instance_id', /^i-[0-9a-f]{8,17}$/), fenceToken: text('placement_fence_token', /^[0-9a-f-]{36}$/),
        },
        profile: RUNTIME_PROFILE_ID, policyDigest: nullable('policy_digest', PRODUCER_DIGEST),
        aiAuthorizationId: text('ai_authorization_id', /^[0-9a-f-]{36}$/), actionSet,
        preparedRequestId: text('prepared_request_id', /^[0-9a-f-]{36}$/), leaseDigest: text('lease_digest', DIGEST), state,
        consentExpiresAt: consentExpiresAt!, controlDeadline: controlDeadline!, decidedAt: decidedAt ?? null,
        createdAt: createdAt!, updatedAt: updatedAt!,
    };
}

function parseRequest(row: Record<string, unknown>): RuntimeRequest {
    const text = (key: string, pattern?: RegExp): string => {
        const v = row[`r_${key}`];
        return typeof v === 'string' && (!pattern || pattern.test(v)) ? v : fail();
    };
    const nullable = (key: string, pattern?: RegExp): string | null => row[`r_${key}`] === null ? null : text(key, pattern);
    const kind = row.r_kind === 'send' || row.r_kind === 'answer' || row.r_kind === 'cancel' ? row.r_kind : fail();
    const state = (CONTROL_STATES as readonly unknown[]).includes(row.r_state) ? row.r_state as ControlState : fail();
    const effect = (CONTROL_EFFECTS as readonly unknown[]).includes(row.r_effect) ? row.r_effect as ControlEffect : fail();
    const decision = row.r_decision === null ? null : row.r_decision === 'allow' || row.r_decision === 'deny' ? row.r_decision : fail();
    const revision = row.r_prompt_revision === null ? null
        : Number.isSafeInteger(row.r_prompt_revision) ? row.r_prompt_revision as number : fail();
    const snapshot = row.r_prompt_snapshot === null ? null : plainObject(row.r_prompt_snapshot) ? row.r_prompt_snapshot : fail();
    const requestDeadline = time(row.r_request_deadline);
    const dispatchClaimedAt = time(row.r_dispatch_claimed_at);
    const createdAt = time(row.r_created_at);
    const updatedAt = time(row.r_updated_at);
    if (requestDeadline === undefined || dispatchClaimedAt === undefined || !createdAt || !updatedAt) fail();
    const ids = ['owner_user_id', 'request_id', 'session_id', 'computer_id'].map(key => text(key));
    if (!ids.every(isUuid)) fail();
    return {
        ownerUserId: ids[0]!, requestId: ids[1]!, clientId: text('client_id'), sessionId: ids[2]!, computerId: ids[3]!, kind,
        requestDigest: text('request_digest', DIGEST), instructionDigest: nullable('instruction_digest', DIGEST),
        instruction: nullable('instruction'), promptId: nullable('prompt_id'), promptRevision: revision,
        promptInputDigest: nullable('prompt_input_digest', PRODUCER_DIGEST), decision, message: nullable('message'),
        targetRequestId: nullable('target_request_id'), promptSnapshot: snapshot,
        controlAuthorizationId: nullable('control_authorization_id'), requestDeadline: requestDeadline ?? null, state, effect,
        reason: nullable('reason', /^[a-z][a-z0-9_]{0,63}$/), dispatchClaimedAt: dispatchClaimedAt ?? null,
        createdAt: createdAt!, updatedAt: updatedAt!,
    };
}

async function selectStored(db: PlacementExecutor, where: SQL): Promise<StoredRuntimeRequest | null> {
    const rows = rowsOf(await db.execute(sql`/* native-runtime:request */ SELECT ${REQUEST_COLUMNS}, ${LEASE_COLUMNS}
        FROM public.ezil_native_runtime_requests r
        LEFT JOIN public.ezil_native_runtime_leases l ON l.control_authorization_id = r.control_authorization_id
        WHERE ${where}`));
    if (rows.length > 1) fail();
    const row = rows[0];
    if (!row) return null;
    const request = parseRequest(row);
    const lease = row.l_control_authorization_id === null ? null : parseLease(row);
    if ((lease === null) !== (request.controlAuthorizationId === null)) fail();
    if (lease && (lease.ownerUserId !== request.ownerUserId || lease.sessionId !== request.sessionId
        || lease.clientId !== request.clientId || lease.computerId !== request.computerId)) fail();
    return { request, lease };
}

function assertKey(ownerUserId: string, requestId: string): void {
    if (!isUuid(ownerUserId) || !isUuid(requestId)) throw new TypeError('invalid native runtime request key');
}

/** The owner's exact request and its lease. One SELECT: no lock, no write. */
export function lookupRuntimeRequest(db: PlacementExecutor, ownerUserId: string, requestId: string): Promise<StoredRuntimeRequest | null> {
    assertKey(ownerUserId, requestId);
    return selectStored(db, sql`r.owner_user_id = ${ownerUserId}::uuid AND r.request_id = ${requestId}::uuid`);
}

/** Is `requestId` one of the owner's `0029` operation ids (an initial task or renewal)? Read only. */
export async function isNativeOperationId(db: PlacementExecutor, ownerUserId: string, requestId: string): Promise<boolean> {
    assertKey(ownerUserId, requestId);
    return rowsOf(await db.execute(sql`/* native-runtime:operation-alias */ SELECT 1 AS hit FROM public.ezil_native_session_operations
        WHERE user_id = ${ownerUserId}::uuid AND operation_id = ${requestId}::uuid`)).length === 1;
}

export async function lookupRuntimeTombstone(db: PlacementExecutor, ownerUserId: string, requestId: string)
    : Promise<{ sessionId: string; clientId: string; cancelRequestId: string } | null> {
    assertKey(ownerUserId, requestId);
    const rows = rowsOf(await db.execute(sql`/* native-runtime:tombstone */ SELECT session_id::text AS session_id, client_id,
        cancel_request_id::text AS cancel_request_id FROM public.ezil_native_runtime_tombstones
        WHERE owner_user_id = ${ownerUserId}::uuid AND target_request_id = ${requestId}::uuid`));
    if (rows.length > 1) fail();
    const row = rows[0];
    if (!row) return null;
    if (!isUuid(row.session_id) || typeof row.client_id !== 'string' || !isUuid(row.cancel_request_id)) fail();
    return { sessionId: row.session_id as string, clientId: row.client_id as string, cancelRequestId: row.cancel_request_id as string };
}

// ── Locks and clock ──────────────────────────────────────────────────────

function assertReadCommitted(result: unknown): void {
    const isolation = rowsOf(result)[0]?.isolation;
    if (isolation !== 'read committed') throw new PlacementIsolationError(String(isolation));
}

async function lockRequest(tx: PlacementExecutor, ownerUserId: string, requestId: string): Promise<void> {
    assertReadCommitted(await tx.execute(sql`/* native-runtime:lock-request */ SELECT pg_advisory_xact_lock(${RUNTIME_REQUEST_LOCK_NAMESPACE}::int4, hashtext(${ownerUserId}::uuid::text || '/' || ${requestId}::uuid::text)), current_setting('transaction_isolation') AS isolation`));
}

async function lockLease(tx: PlacementExecutor, ownerUserId: string, sessionId: string): Promise<void> {
    assertReadCommitted(await tx.execute(sql`/* native-runtime:lock-lease */ SELECT pg_advisory_xact_lock(${RUNTIME_LEASE_LOCK_NAMESPACE}::int4, hashtext(${ownerUserId}::uuid::text || '/' || ${sessionId}::uuid::text)), current_setting('transaction_isolation') AS isolation`));
}

async function clockOf(tx: PlacementExecutor): Promise<Date> {
    const now = time(rowsOf(await tx.execute(sql`/* native-runtime:clock */ SELECT clock_timestamp() AS now`))[0]?.now);
    if (!now) fail();
    return now!;
}

// ── Semantics ────────────────────────────────────────────────────────────

/** Everything that makes a request what it is; compared on replay. The lease is not part of it. */
export function sameRequestSemantics(stored: RuntimeRequest, clientId: string, body: RuntimeControlBody, requestDigest: string): boolean {
    return stored.kind === body.kind && stored.sessionId === body.sessionId && stored.clientId === clientId
        && stored.requestDigest === requestDigest;
}

/** The lease's own digest: its immutable scope, action set and deadlines. */
export function leaseDigestOf(lease: Omit<RuntimeLease, 'leaseDigest' | 'state' | 'decidedAt' | 'createdAt' | 'updatedAt'>): string {
    return sha256Hex(JSON.stringify([RUNTIME_LEASE_DOMAIN, lease.controlAuthorizationId, lease.ownerUserId, lease.clientId,
        lease.sessionId, lease.computerId, lease.runtimeId, lease.hostEpoch, lease.placement.generation, lease.placement.leaseEpoch,
        lease.placement.instanceId, lease.placement.fenceToken, lease.profile, lease.policyDigest, lease.aiAuthorizationId,
        lease.actionSet, lease.preparedRequestId, lease.consentExpiresAt.toISOString(), lease.controlDeadline.toISOString()]));
}

/** What the browser approves: one lease together with exactly the one pending request it is shown with. */
export function consentDigestOf(lease: RuntimeLease, request: RuntimeRequest): string {
    return sha256Hex(JSON.stringify([RUNTIME_LEASE_DOMAIN, 'consent', lease.leaseDigest, request.requestId, request.requestDigest]));
}

// ── Admission ────────────────────────────────────────────────────────────

export type AdmissionDecision =
    | { kind: 'blocked'; reason: RuntimeReason }
    | { kind: 'lease'; scope: RuntimeLeaseScope; leaseUntil: Date; aiExpiresAt: Date | null; promptSnapshot: Record<string, unknown> | null };

export interface AdmissionInput {
    ownerUserId: string;
    clientId: string;
    computerId: string;
    body: RuntimeControlBody;
    requestDigest: string;
    decision: AdmissionDecision;
}

export type AdmissionResult =
    | { kind: 'existing'; stored: StoredRuntimeRequest }
    | { kind: 'conflict' }
    | { kind: 'admitted'; stored: StoredRuntimeRequest };

function sameLeaseScope(lease: RuntimeLease, scope: RuntimeLeaseScope): boolean {
    return lease.ownerUserId === scope.ownerUserId && lease.clientId === scope.clientId && lease.sessionId === scope.sessionId
        && lease.computerId === scope.computerId && lease.runtimeId === scope.runtimeId && lease.hostEpoch === scope.hostEpoch
        && lease.placement.generation === scope.placement.generation && lease.placement.leaseEpoch === scope.placement.leaseEpoch
        && lease.placement.instanceId === scope.placement.instanceId && lease.placement.fenceToken === scope.placement.fenceToken
        && lease.policyDigest === scope.policyDigest && lease.aiAuthorizationId === scope.aiAuthorizationId
        && lease.actionSet === scope.actionSet;
}

async function findLease(tx: PlacementExecutor, scope: RuntimeLeaseScope, now: Date): Promise<RuntimeLease | null> {
    const rows = rowsOf(await tx.execute(sql`/* native-runtime:lease-scope */ SELECT ${LEASE_COLUMNS}
        FROM public.ezil_native_runtime_leases l
        WHERE l.owner_user_id = ${scope.ownerUserId}::uuid AND l.session_id = ${scope.sessionId}::uuid
            AND l.runtime_id IS NOT DISTINCT FROM ${scope.runtimeId}::uuid
            AND ((l.state = 'approved' AND l.control_deadline > ${now.toISOString()}::timestamptz)
                OR (l.state = 'required' AND l.consent_expires_at > ${now.toISOString()}::timestamptz))
        ORDER BY (l.state = 'approved') DESC, l.created_at DESC, l.control_authorization_id`));
    for (const row of rows) {
        const lease = parseLease(row);
        if (sameLeaseScope(lease, scope)) return lease;
    }
    return null;
}

async function insertLease(tx: PlacementExecutor, scope: RuntimeLeaseScope, preparedRequestId: string, now: Date, leaseUntil: Date): Promise<RuntimeLease | null> {
    const controlDeadline = new Date(Math.min(now.getTime() + RUNTIME_LIMITS.controlWindowMs, leaseUntil.getTime()));
    const consentExpiresAt = new Date(Math.min(now.getTime() + RUNTIME_LIMITS.consentWindowMs, controlDeadline.getTime()));
    if (consentExpiresAt.getTime() <= now.getTime()) return null;
    const base = {
        ...scope, controlAuthorizationId: randomUUID(), profile: RUNTIME_PROFILE_ID, preparedRequestId, consentExpiresAt, controlDeadline,
    } as const;
    const leaseDigest = leaseDigestOf(base);
    const rows = rowsOf(await tx.execute(sql`/* native-runtime:lease-insert */ INSERT INTO public.ezil_native_runtime_leases AS l
        (control_authorization_id, owner_user_id, client_id, session_id, computer_id, runtime_id, host_epoch, placement_generation,
         placement_lease_epoch, placement_instance_id, placement_fence_token, profile, policy_digest, ai_authorization_id,
         action_set, prepared_request_id, lease_digest, state, consent_expires_at, control_deadline, decided_at, created_at, updated_at)
        VALUES (${base.controlAuthorizationId}::uuid, ${scope.ownerUserId}::uuid, ${scope.clientId}, ${scope.sessionId}::uuid,
            ${scope.computerId}::uuid, ${scope.runtimeId}::uuid, ${scope.hostEpoch}, ${scope.placement.generation}::bigint,
            ${scope.placement.leaseEpoch}::bigint, ${scope.placement.instanceId}, ${scope.placement.fenceToken}::uuid,
            ${RUNTIME_PROFILE_ID}, ${scope.policyDigest}, ${scope.aiAuthorizationId}::uuid, ${scope.actionSet},
            ${preparedRequestId}::uuid, ${leaseDigest}, 'required', ${consentExpiresAt.toISOString()}::timestamptz,
            ${controlDeadline.toISOString()}::timestamptz, NULL, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
        RETURNING ${LEASE_COLUMNS}`));
    return rows[0] ? parseLease(rows[0]) : fail();
}

async function insertRequest(tx: PlacementExecutor, input: AdmissionInput, fields: {
    lease: RuntimeLease | null; requestDeadline: Date | null; state: ControlState; effect: ControlEffect; reason: string | null;
    promptSnapshot: Record<string, unknown> | null; now: Date;
}): Promise<void> {
    const b = input.body;
    const send = b.kind === 'send' ? b : null;
    const answer = b.kind === 'answer' ? b : null;
    const cancel = b.kind === 'cancel' ? b : null;
    await tx.execute(sql`/* native-runtime:request-insert */ INSERT INTO public.ezil_native_runtime_requests
        (owner_user_id, request_id, client_id, session_id, computer_id, kind, request_digest, instruction_digest, instruction,
         prompt_id, prompt_revision, prompt_input_digest, decision, message, target_request_id, prompt_snapshot,
         control_authorization_id, request_deadline, state, effect, reason, dispatch_claimed_at, created_at, updated_at)
        VALUES (${input.ownerUserId}::uuid, ${b.requestId}::uuid, ${input.clientId}, ${b.sessionId}::uuid, ${input.computerId}::uuid,
            ${b.kind}, ${input.requestDigest}, ${send?.instructionDigest ?? null}, ${send?.instruction ?? null},
            ${answer?.promptId ?? null}::uuid, ${answer?.revision ?? null}::integer, ${answer?.promptInputDigest ?? null},
            ${answer?.decision ?? null}, ${answer?.message ?? null}, ${cancel?.targetRequestId ?? null}::uuid,
            ${fields.promptSnapshot === null ? null : JSON.stringify(fields.promptSnapshot)}::jsonb,
            ${fields.lease?.controlAuthorizationId ?? null}::uuid, ${fields.requestDeadline?.toISOString() ?? null}::timestamptz,
            ${fields.state}, ${fields.effect}, ${fields.reason}, NULL, ${fields.now.toISOString()}::timestamptz,
            ${fields.now.toISOString()}::timestamptz)`);
}

/**
 * Admit one control request. Replay and conflict are decided first, under the request lock and before anything
 * about the lease; a stored row is returned as it is and never re-admitted.
 */
export function admitRuntimeRequest(db: NativeAuthorityDb, input: AdmissionInput): Promise<AdmissionResult> {
    assertKey(input.ownerUserId, input.body.requestId);
    if (!DIGEST.test(input.requestDigest) || !isUuid(input.computerId)) throw new TypeError('invalid native runtime admission');
    return db.transaction(async (tx): Promise<AdmissionResult> => {
        const { ownerUserId, body } = input;
        await lockRequest(tx, ownerUserId, body.requestId);
        const prior = await selectStored(tx, sql`r.owner_user_id = ${ownerUserId}::uuid AND r.request_id = ${body.requestId}::uuid`);
        if (prior) return sameRequestSemantics(prior.request, input.clientId, body, input.requestDigest) ? { kind: 'existing', stored: prior } : { kind: 'conflict' };
        if (await isNativeOperationId(tx, ownerUserId, body.requestId)) return { kind: 'conflict' };
        const now = await clockOf(tx);
        const reread = () => selectStored(tx, sql`r.owner_user_id = ${ownerUserId}::uuid AND r.request_id = ${body.requestId}::uuid`)
            .then(stored => stored ?? fail());

        const tombstone = await lookupRuntimeTombstone(tx, ownerUserId, body.requestId);
        if (tombstone) {
            // Cancelled before it was ever seen: recorded once, never dispatched. A tombstone of another session or
            // client still burns the id (nothing it names may run), as a definite refusal.
            const own = tombstone.sessionId === body.sessionId && tombstone.clientId === input.clientId;
            await insertRequest(tx, input, {
                lease: null, requestDeadline: null, state: own ? 'cancelled_before_dispatch' : 'blocked',
                effect: own ? 'tombstone_before_dispatch' : 'none', reason: own ? null : 'target_session_mismatch', promptSnapshot: null, now,
            });
            return { kind: 'admitted', stored: await reread() };
        }

        const decision = input.decision;
        if (decision.kind === 'blocked') {
            await insertRequest(tx, input, { lease: null, requestDeadline: null, state: 'blocked', effect: 'none', reason: decision.reason, promptSnapshot: null, now });
            return { kind: 'admitted', stored: await reread() };
        }
        const scope = decision.scope;
        if (scope.ownerUserId !== ownerUserId || scope.clientId !== input.clientId || scope.sessionId !== body.sessionId
            || scope.computerId !== input.computerId || (scope.actionSet === 'cancel_only' && body.kind !== 'cancel')) {
            throw new TypeError('native runtime lease scope does not match the request');
        }
        await lockLease(tx, ownerUserId, body.sessionId);
        const lease = await findLease(tx, scope, now) ?? await insertLease(tx, scope, body.requestId, now, decision.leaseUntil);
        if (!lease) {
            await insertRequest(tx, input, { lease: null, requestDeadline: null, state: 'blocked', effect: 'none', reason: 'control_deadline_passed', promptSnapshot: null, now });
            return { kind: 'admitted', stored: await reread() };
        }
        const cap = body.kind === 'cancel' || decision.aiExpiresAt === null ? lease.controlDeadline.getTime()
            : Math.min(lease.controlDeadline.getTime(), decision.aiExpiresAt.getTime());
        if (cap <= now.getTime()) {
            const reason: RuntimeReason = body.kind !== 'cancel' && decision.aiExpiresAt && decision.aiExpiresAt.getTime() <= now.getTime()
                ? 'ai_authorization_inactive' : 'control_deadline_passed';
            await insertRequest(tx, input, { lease: null, requestDeadline: null, state: 'blocked', effect: 'none', reason, promptSnapshot: null, now });
            return { kind: 'admitted', stored: await reread() };
        }
        await insertRequest(tx, input, {
            lease, requestDeadline: new Date(cap), state: lease.state === 'approved' ? 'approved' : 'authorization_required',
            effect: 'none', reason: null, promptSnapshot: decision.promptSnapshot, now,
        });
        return { kind: 'admitted', stored: await reread() };
    });
}

// ── Consent ──────────────────────────────────────────────────────────────

export type ConsentResult =
    | { kind: 'decided'; stored: StoredRuntimeRequest }
    | { kind: 'unchanged'; stored: StoredRuntimeRequest }
    | { kind: 'digest_mismatch' }
    | { kind: 'not_found' };

/**
 * The browser decision for one pending request: CAS lease and request `required → approved|denied` exactly once.
 * A lease already approved through another request approves this one only with its own matching digest. An expired
 * consent window persists `authorization_expired`. Anything else returns the current row unchanged.
 */
export function decideRuntimeConsent(db: NativeAuthorityDb, ownerUserId: string, requestId: string, decision: 'approve' | 'deny',
    consentDigest: string): Promise<ConsentResult> {
    assertKey(ownerUserId, requestId);
    return db.transaction(async (tx): Promise<ConsentResult> => {
        await lockRequest(tx, ownerUserId, requestId);
        const where = sql`r.owner_user_id = ${ownerUserId}::uuid AND r.request_id = ${requestId}::uuid`;
        const stored = await selectStored(tx, where);
        if (!stored) return { kind: 'not_found' };
        const { request, lease } = stored;
        if (!lease || request.state !== 'authorization_required') return { kind: 'unchanged', stored };
        if (consentDigestOf(lease, request) !== consentDigest) return { kind: 'digest_mismatch' };
        await lockLease(tx, ownerUserId, request.sessionId);
        const now = await clockOf(tx);
        const reread = async () => (await selectStored(tx, where)) ?? fail();
        const moveRequest = (to: ControlState) => tx.execute(sql`/* native-runtime:consent-request */ UPDATE public.ezil_native_runtime_requests
            SET state = ${to}, updated_at = GREATEST(${now.toISOString()}::timestamptz, updated_at)
            WHERE owner_user_id = ${ownerUserId}::uuid AND request_id = ${requestId}::uuid AND state = 'authorization_required'`);
        const current = (await selectStored(tx, where))!.lease!;
        if (current.state === 'denied') { await moveRequest('authorization_denied'); return { kind: 'decided', stored: await reread() }; }
        const windowOpen = current.state === 'approved' ? current.controlDeadline.getTime() > now.getTime() && (request.requestDeadline?.getTime() ?? 0) > now.getTime()
            : current.consentExpiresAt.getTime() > now.getTime();
        if (!windowOpen) { await moveRequest('authorization_expired'); return { kind: 'decided', stored: await reread() }; }
        if (current.state === 'required') {
            await tx.execute(sql`/* native-runtime:consent-lease */ UPDATE public.ezil_native_runtime_leases
                SET state = ${decision === 'approve' ? 'approved' : 'denied'}, decided_at = ${now.toISOString()}::timestamptz,
                    updated_at = GREATEST(${now.toISOString()}::timestamptz, updated_at)
                WHERE control_authorization_id = ${current.controlAuthorizationId}::uuid AND state = 'required'`);
        } else if (decision === 'deny') {
            // An approved lease is not revoked by declining one more request under it; only this request is denied.
            await moveRequest('authorization_denied');
            return { kind: 'decided', stored: await reread() };
        }
        await moveRequest(decision === 'approve' ? 'approved' : 'authorization_denied');
        return { kind: 'decided', stored: await reread() };
    });
}

/**
 * A replayed `authorization_required` request whose lease was approved through another request: move it to
 * `approved` (CAS) so dispatch can claim it. Only within its own deadline; never for a denied or expired lease.
 */
export async function adoptApprovedLease(db: PlacementExecutor, ownerUserId: string, requestId: string): Promise<StoredRuntimeRequest | null> {
    assertKey(ownerUserId, requestId);
    await db.execute(sql`/* native-runtime:adopt-lease */ UPDATE public.ezil_native_runtime_requests r
        SET state = 'approved', updated_at = GREATEST(clock_timestamp(), r.updated_at)
        FROM public.ezil_native_runtime_leases l
        WHERE r.owner_user_id = ${ownerUserId}::uuid AND r.request_id = ${requestId}::uuid AND r.state = 'authorization_required'
            AND l.control_authorization_id = r.control_authorization_id AND l.state = 'approved'
            AND l.control_deadline > clock_timestamp() AND r.request_deadline > clock_timestamp()`);
    return lookupRuntimeRequest(db, ownerUserId, requestId);
}

// ── Outbox ───────────────────────────────────────────────────────────────

/**
 * Claim the outbox once: `approved → dispatching` while the lease is approved and the request deadline is in the
 * future (database clock). Null when the stored row is no longer claimable: the caller sends nothing.
 */
export async function claimRuntimeDispatch(db: NativeAuthorityDb, ownerUserId: string, requestId: string): Promise<StoredRuntimeRequest | null> {
    assertKey(ownerUserId, requestId);
    return db.transaction(async tx => {
        // The same canonical request lock cancel takes before observing this target. A claim and an OS
        // tombstone can never pass each other between the read and conditional write.
        await lockRequestsInOrder(tx, ownerUserId, [requestId]);
        const rows = rowsOf(await tx.execute(sql`/* native-runtime:claim */ UPDATE public.ezil_native_runtime_requests r
            SET state = 'dispatching', dispatch_claimed_at = clock_timestamp(), updated_at = GREATEST(clock_timestamp(), r.updated_at)
            FROM public.ezil_native_runtime_leases l
            WHERE r.owner_user_id = ${ownerUserId}::uuid AND r.request_id = ${requestId}::uuid AND r.state = 'approved'
                AND r.dispatch_claimed_at IS NULL AND l.control_authorization_id = r.control_authorization_id AND l.state = 'approved'
                AND r.request_deadline > clock_timestamp() AND l.control_deadline > clock_timestamp()
            RETURNING r.request_id`));
        if (rows.length === 0) return null;
        if (rows.length !== 1) fail();
        return lookupRuntimeRequest(tx, ownerUserId, requestId);
    });
}

/** Compare-and-swap one request move (autocommit). Null when the stored state is no longer `from`. */
export async function advanceRuntimeRequest(db: PlacementExecutor, ownerUserId: string, requestId: string, from: ControlState,
    to: ControlState, effect: ControlEffect, reason: string | null): Promise<StoredRuntimeRequest | null> {
    assertKey(ownerUserId, requestId);
    if (reason !== null && !/^[a-z][a-z0-9_]{0,63}$/.test(reason)) throw new TypeError('invalid native runtime reason');
    const rows = rowsOf(await db.execute(sql`/* native-runtime:advance */ UPDATE public.ezil_native_runtime_requests
        SET state = ${to}, effect = ${effect}, reason = ${reason}, updated_at = GREATEST(clock_timestamp(), updated_at)
        WHERE owner_user_id = ${ownerUserId}::uuid AND request_id = ${requestId}::uuid AND state = ${from}
        RETURNING request_id`));
    if (rows.length === 0) return null;
    return lookupRuntimeRequest(db, ownerUserId, requestId);
}

// ── Cancel before dispatch ───────────────────────────────────────────────

export type TombstoneResult =
    | { kind: 'tombstoned'; stored: StoredRuntimeRequest }
    | { kind: 'dispatch_target' }
    | { kind: 'refused'; stored: StoredRuntimeRequest }
    | { kind: 'stale' };

const UNDISPATCHED: ReadonlySet<ControlState> = new Set(['authorization_required', 'approved']);

/**
 * Every mutator that touches more than one request takes all request locks in this one order (ascending id), so
 * reciprocal cancels (A cancels B while B cancels A) cannot deadlock. Then, if needed, the computer lock.
 */
async function lockRequestsInOrder(tx: PlacementExecutor, ownerUserId: string, requestIds: readonly string[]): Promise<void> {
    for (const id of [...new Set(requestIds)].sort()) await lockRequest(tx, ownerUserId, id);
}

/** The placement module's canonical per-computer lock, statement for statement (as `authority.ts` takes it). */
async function lockComputer(tx: PlacementExecutor, computerId: string): Promise<void> {
    assertReadCommitted(await tx.execute(sql`/* native-runtime:lock-computer */ SELECT pg_advisory_xact_lock(${PLACEMENT_LOCK_NAMESPACE}::int4, hashtext(${computerId}::uuid::text)), current_setting('transaction_isolation') AS isolation`));
}

/**
 * For an approved cancel whose target was never dispatched (unseen, or pending/approved with an unclaimed outbox):
 * write the permanent tombstone, move a known target to `cancelled_before_dispatch`, and complete the cancel with
 * `tombstone_before_dispatch`. Inside the one transaction, after the request locks (ascending) and the computer
 * lock, it re-validates everything the write depends on: the cancel is still approved and unclaimed, its lease is
 * approved, both deadlines are in the future on the database clock, the owner still owns the computer and the live
 * placement equals the lease's. Stale → the cancel is `blocked` and nothing is tombstoned. A cancel needs no active
 * AI grant, but never bypasses its control deadline or the current owner.
 *
 * Target classification: the session's own initial task (its `0029` create, same session) is a dispatched target
 * (`dispatch_target`: only a qualified Core cancel may stop it); any other `0029` operation id, or a known request of
 * another session or client, is `target_session_mismatch`; only a truly unseen id gets an OS-only tombstone.
 */
export function tombstoneBeforeDispatch(db: NativeAuthorityDb, cancel: RuntimeRequest): Promise<TombstoneResult> {
    if (cancel.kind !== 'cancel' || !cancel.targetRequestId) throw new TypeError('not a cancel request');
    const target = cancel.targetRequestId;
    return db.transaction(async (tx): Promise<TombstoneResult> => {
        const owner = cancel.ownerUserId;
        await lockRequestsInOrder(tx, owner, [target, cancel.requestId]);
        const self = sql`r.owner_user_id = ${owner}::uuid AND r.request_id = ${cancel.requestId}::uuid`;
        const current = await selectStored(tx, self);
        if (!current || current.request.state !== 'approved' || current.request.dispatchClaimedAt !== null || !current.lease) return { kind: 'stale' };
        await lockComputer(tx, current.request.computerId);
        const now = await clockOf(tx);
        const refuse = async (reason: RuntimeReason): Promise<TombstoneResult> => {
            await tx.execute(sql`/* native-runtime:cancel-refuse */ UPDATE public.ezil_native_runtime_requests
                SET state = 'blocked', reason = ${reason}, updated_at = GREATEST(${now.toISOString()}::timestamptz, updated_at)
                WHERE owner_user_id = ${owner}::uuid AND request_id = ${cancel.requestId}::uuid AND state = 'approved'`);
            return { kind: 'refused', stored: (await selectStored(tx, self)) ?? fail() };
        };
        const lease = current.lease;
        if (lease.state !== 'approved') return refuse('authorization_unavailable');
        if (lease.controlDeadline.getTime() <= now.getTime() || (current.request.requestDeadline?.getTime() ?? 0) <= now.getTime()) {
            return refuse('control_deadline_passed');
        }
        const live = await readCurrentPlacement(tx, owner, current.request.computerId);
        if (!live.ok) return refuse(live.reason);
        if (live.placement.generation !== lease.placement.generation || live.placement.leaseEpoch !== lease.placement.leaseEpoch
            || live.placement.instanceId !== lease.placement.instanceId || live.placement.fenceToken !== lease.placement.fenceToken) {
            return refuse('placement_changed');
        }

        const operation = rowsOf(await tx.execute(sql`/* native-runtime:target-operation */ SELECT kind, session_id::text AS session_id
            FROM public.ezil_native_session_operations WHERE user_id = ${owner}::uuid AND operation_id = ${target}::uuid`));
        if (operation.length > 1) fail();
        if (operation[0]) {
            return operation[0].kind === 'create' && operation[0].session_id === cancel.sessionId
                ? { kind: 'dispatch_target' } : refuse('target_session_mismatch');
        }
        const known = await selectStored(tx, sql`r.owner_user_id = ${owner}::uuid AND r.request_id = ${target}::uuid`);
        if (known) {
            if (known.request.sessionId !== cancel.sessionId || known.request.clientId !== cancel.clientId) return refuse('target_session_mismatch');
            if (!UNDISPATCHED.has(known.request.state) || known.request.dispatchClaimedAt !== null) {
                return known.request.dispatchClaimedAt !== null && !['host_refused', 'completed', 'failed', 'cancelled', 'blocked'].includes(known.request.state)
                    ? { kind: 'dispatch_target' } : refuse('target_settled');
            }
        }
        const prior = await lookupRuntimeTombstone(tx, owner, target);
        if (prior && (prior.sessionId !== cancel.sessionId || prior.clientId !== cancel.clientId)) return refuse('target_session_mismatch');
        if (known) {
            const changed = rowsOf(await tx.execute(sql`/* native-runtime:target-cancel */ UPDATE public.ezil_native_runtime_requests
                SET state = 'cancelled_before_dispatch', effect = 'tombstone_before_dispatch',
                    updated_at = GREATEST(${now.toISOString()}::timestamptz, updated_at)
                WHERE owner_user_id = ${owner}::uuid AND request_id = ${target}::uuid
                    AND state IN ('authorization_required', 'approved') AND dispatch_claimed_at IS NULL
                RETURNING request_id`));
            // A different terminal transition can still win a CAS. Do not insert a tombstone or claim completion.
            if (changed.length === 0) return { kind: 'stale' };
            if (changed.length !== 1) fail();
        }
        if (!prior) {
            await tx.execute(sql`/* native-runtime:tombstone-insert */ INSERT INTO public.ezil_native_runtime_tombstones
                (owner_user_id, target_request_id, session_id, client_id, cancel_request_id, created_at)
                VALUES (${owner}::uuid, ${target}::uuid, ${cancel.sessionId}::uuid, ${cancel.clientId}, ${cancel.requestId}::uuid,
                    ${now.toISOString()}::timestamptz)`);
        }
        const completed = rowsOf(await tx.execute(sql`/* native-runtime:cancel-complete */ UPDATE public.ezil_native_runtime_requests
            SET state = 'completed', effect = 'tombstone_before_dispatch', updated_at = GREATEST(${now.toISOString()}::timestamptz, updated_at)
            WHERE owner_user_id = ${owner}::uuid AND request_id = ${cancel.requestId}::uuid AND state = 'approved'
            RETURNING request_id`));
        if (completed.length !== 1) fail(); // rolls back target CAS and tombstone together
        return { kind: 'tombstoned', stored: (await selectStored(tx, self)) ?? fail() };
    });
}
