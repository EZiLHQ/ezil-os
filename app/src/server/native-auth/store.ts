/**
 * Native authorization intent store: the single writer of `ezil_native_auth_intents` and
 * `ezil_native_task_artifacts` (`app/drizzle/0031_native_auth_intents.sql`, reserved and unapplied).
 *
 * - An intent is keyed by (owner, operation id). Its identity (kind, session, computer, instruction, input
 *   digest, client, issuer, subject, scope) and fixed five-minute challenge expiry are immutable; the guard
 *   trigger refuses changes, DELETE and TRUNCATE.
 * - Decisions are compare-and-swap moves out of `required` (approved, denied, expired, blocked) on the
 *   database clock, plus `approved>blocked` when the one dispatch attempt was refused before any broker
 *   tombstone existed. Nothing ever moves back to `required`.
 * - A create approval binds finite consent terms, once: a fresh `authz_id`, the admitted epoch, budget and
 *   policy, the literal service and profile, and an authorization deadline at most 24 hours after the
 *   millisecond-exact first approval. A renewal is never browser-approved: it copies its session create's
 *   terms unchanged (same authorization, deadline and budget, no new approval time) while they last. An
 *   approved row without terms is never upgraded.
 * - Approval and sealing of the private task artifact are one transaction, so a sealed artifact always has an
 *   approved intent and an approved create always has its artifact. Concurrent approvals serialise on the
 *   row: exactly one wins and only the winner dispatches.
 *
 * Every exported call is one autocommit statement or one short transaction: no lock is ever held across the
 * network. Rows carry private owner text; nothing here logs.
 */

import { sql, type SQL } from 'drizzle-orm';

import type { PlacementExecutor } from '@/server/lib/compute/placement';
import {
    currentAuthority, lockComputer, type NativeAuthorityDb, type NativeRefusal, type PinnedPlacement,
} from '@/server/native-session/authority';
import type { NativeTaskResolver, SealedNativeTask } from '@/server/native-session/host-transport';

import {
    NATIVE_CONSENT_PROFILE, NATIVE_CONSENT_SERVICE, NATIVE_INSTRUCTION_MAX_BYTES, POSITIVE_DECIMAL, SHA256_DIGEST, UUID, isWellFormedUnicode,
    nativeInstructionDigest, nativeTaskRef, utf8Bytes, type NativeConsentTermsConfig, type NativeIntentInput,
} from './contract';

export const NATIVE_INTENT_STATES = ['required', 'approved', 'denied', 'expired', 'blocked'] as const;
export type NativeIntentState = (typeof NATIVE_INTENT_STATES)[number];

export interface NativeIntentActor {
    clientId: string;
    idpIssuer: string;
    subject: string;
    /** Canonical: the granted scopes sorted and space separated. */
    scope: string;
}

/** The finite consent an approval bound. Immutable once written. */
export interface NativeConsentTerms {
    authzId: string;
    epoch: string;
    budgetMicro: string;
    policyId: string;
    service: typeof NATIVE_CONSENT_SERVICE;
    profile: typeof NATIVE_CONSENT_PROFILE;
    initialApprovalAt: Date;
    authorizationDeadline: Date;
    /** The full tuple pinned under the owner and computer locks at approval; never inferred later. */
    placement: PinnedPlacement;
}

export interface NativeIntent extends NativeIntentActor {
    userId: string;
    operationId: string;
    kind: 'create' | 'renew';
    sessionId: string;
    computerId: string;
    instructionRevision: 1 | null;
    instructionDigest: string | null;
    /** Private owner text. Only the owner's consent page and the sealed artifact ever carry it. */
    instruction: string | null;
    inputDigest: string;
    state: NativeIntentState;
    reason: string | null;
    /** Null until approved, and for rows approved before terms existed (never upgraded). */
    terms: NativeConsentTerms | null;
    createdAt: Date;
    expiresAt: Date;
    decidedAt: Date | null;
}

/** A stored row that does not parse. Fails closed; never guessed. */
export class NativeIntentIntegrityError extends Error {
    constructor() { super('native_intent_invalid_row'); this.name = 'NativeIntentIntegrityError'; }
}

export type NativeIntentInsert =
    | { kind: 'inserted'; intent: NativeIntent }
    | { kind: 'existing'; intent: NativeIntent }
    | { kind: 'session_exists' };

const REASON = /^[a-z][a-z0-9_]{0,63}$/;

function rowsOf(result: unknown): Record<string, unknown>[] {
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    return ((result as { rows?: Record<string, unknown>[] } | null)?.rows ?? []) as Record<string, unknown>[];
}

function time(value: unknown): Date | null | undefined {
    if (value === null || value === undefined) return null;
    const d = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
    return d && Number.isFinite(d.getTime()) ? d : undefined;
}

/** The selected columns, qualified by `alias` when the statement joins another intent row. */
function columns(alias?: string): SQL {
    const p = alias ? `${alias}.` : '';
    return sql.raw([
        `${p}user_id::text AS user_id`, `${p}operation_id::text AS operation_id`, `${p}kind AS kind`, `${p}session_id::text AS session_id`,
        `${p}computer_id::text AS computer_id`, `${p}instruction_revision::text AS instruction_revision`, `${p}instruction_digest AS instruction_digest`,
        `${p}instruction AS instruction`, `${p}instruction_bytes AS instruction_bytes`, `${p}input_digest AS input_digest`, `${p}client_id AS client_id`,
        `${p}idp_issuer AS idp_issuer`, `${p}subject AS subject`, `${p}scope AS scope`, `${p}state AS state`, `${p}reason AS reason`,
        `${p}authz_id::text AS authz_id`, `${p}consent_epoch AS consent_epoch`, `${p}budget_micro AS budget_micro`,
        `${p}policy_id::text AS policy_id`, `${p}service AS service`, `${p}profile AS profile`, `${p}initial_approval_at AS initial_approval_at`,
        `${p}authorization_deadline AS authorization_deadline`, `${p}approved_placement_generation::text AS approved_placement_generation`,
        `${p}approved_placement_lease_epoch::text AS approved_placement_lease_epoch`, `${p}approved_placement_instance_id AS approved_placement_instance_id`,
        `${p}approved_placement_fence_token::text AS approved_placement_fence_token`, `${p}created_at AS created_at`, `${p}expires_at AS expires_at`,
        `${p}decided_at AS decided_at`,
    ].join(', '));
}
const COLUMNS = columns();

const INSTANCE = /^i-[0-9a-f]{8,17}$/;

function parseTerms(row: Record<string, unknown>, state: NativeIntentState, fail: () => never): NativeConsentTerms | null {
    const keys = ['authz_id', 'consent_epoch', 'budget_micro', 'policy_id', 'service', 'profile', 'initial_approval_at', 'authorization_deadline',
        'approved_placement_generation', 'approved_placement_lease_epoch', 'approved_placement_instance_id', 'approved_placement_fence_token'];
    const present = keys.filter(key => row[key] !== null && row[key] !== undefined).length;
    if (present === 0) return null;
    if (present !== keys.length || (state !== 'approved' && state !== 'blocked')) fail();
    const initialApprovalAt = time(row.initial_approval_at);
    const authorizationDeadline = time(row.authorization_deadline);
    if (typeof row.authz_id !== 'string' || !UUID.test(row.authz_id) || typeof row.policy_id !== 'string' || !UUID.test(row.policy_id)
        || typeof row.consent_epoch !== 'string' || !POSITIVE_DECIMAL.test(row.consent_epoch)
        || typeof row.budget_micro !== 'string' || !POSITIVE_DECIMAL.test(row.budget_micro)
        || row.service !== NATIVE_CONSENT_SERVICE || row.profile !== NATIVE_CONSENT_PROFILE || !initialApprovalAt || !authorizationDeadline
        || authorizationDeadline.getTime() <= initialApprovalAt.getTime()
        || authorizationDeadline.getTime() - initialApprovalAt.getTime() > 86_400_000) fail();
    const placement = {
        generation: String(row.approved_placement_generation), leaseEpoch: String(row.approved_placement_lease_epoch),
        instanceId: String(row.approved_placement_instance_id), fenceToken: String(row.approved_placement_fence_token),
    };
    if (!POSITIVE_DECIMAL.test(placement.generation) || !POSITIVE_DECIMAL.test(placement.leaseEpoch) || !INSTANCE.test(placement.instanceId)
        || !UUID.test(placement.fenceToken)) fail();
    return {
        authzId: row.authz_id as string, epoch: row.consent_epoch as string, budgetMicro: row.budget_micro as string, policyId: row.policy_id as string,
        service: NATIVE_CONSENT_SERVICE, profile: NATIVE_CONSENT_PROFILE, initialApprovalAt: initialApprovalAt!, authorizationDeadline: authorizationDeadline!,
        placement,
    };
}

function parseIntent(row: Record<string, unknown>): NativeIntent {
    const fail = (): never => { throw new NativeIntentIntegrityError(); };
    const text = (key: string, pattern?: RegExp): string => {
        const v = row[key];
        return typeof v === 'string' && (!pattern || pattern.test(v)) ? v : fail();
    };
    const kind = row.kind === 'create' || row.kind === 'renew' ? row.kind : fail();
    const state = (NATIVE_INTENT_STATES as readonly unknown[]).includes(row.state) ? row.state as NativeIntentState : fail();
    const reason = row.reason === null ? null : text('reason', REASON);
    if ((reason !== null) !== (state === 'blocked')) fail();
    const createdAt = time(row.created_at);
    const expiresAt = time(row.expires_at);
    const decidedAt = time(row.decided_at);
    if (!createdAt || !expiresAt || decidedAt === undefined || (decidedAt === null) !== (state === 'required')) fail();
    let instruction: string | null = null;
    let instructionDigest: string | null = null;
    if (kind === 'create') {
        if (row.instruction_revision !== '1') fail();
        instruction = text('instruction');
        instructionDigest = text('instruction_digest', SHA256_DIGEST);
        // The stored text must still be exactly what was digested and measured at prepare time.
        if (!isWellFormedUnicode(instruction) || Number(row.instruction_bytes) !== utf8Bytes(instruction)
            || nativeInstructionDigest(instruction) !== instructionDigest) fail();
    } else if (row.instruction !== null || row.instruction_digest !== null || row.instruction_revision !== null) {
        fail();
    }
    return {
        userId: text('user_id', UUID), operationId: text('operation_id', UUID), kind, sessionId: text('session_id', UUID),
        computerId: text('computer_id', UUID), instructionRevision: kind === 'create' ? 1 : null, instructionDigest, instruction,
        inputDigest: text('input_digest', SHA256_DIGEST), clientId: text('client_id'), idpIssuer: text('idp_issuer'),
        subject: text('subject'), scope: text('scope'), state, reason, terms: parseTerms(row, state, fail),
        createdAt: createdAt!, expiresAt: expiresAt!, decidedAt: decidedAt ?? null,
    };
}

async function selectOne(db: PlacementExecutor, query: SQL): Promise<NativeIntent | null> {
    const rows = rowsOf(await db.execute(query));
    if (rows.length > 1) throw new NativeIntentIntegrityError();
    return rows[0] ? parseIntent(rows[0]) : null;
}

function assertKey(userId: string, operationId: string): void {
    if (!UUID.test(userId) || !UUID.test(operationId)) throw new TypeError('invalid native intent key');
}

/** The caller's own intent for that operation id, or null. One SELECT; no lock or write. */
export function lookupNativeIntent(db: PlacementExecutor, userId: string, operationId: string): Promise<NativeIntent | null> {
    assertKey(userId, operationId);
    return selectOne(db, sql`/* native-auth:intent */ SELECT ${COLUMNS} FROM public.ezil_native_auth_intents
        WHERE user_id = ${userId}::uuid AND operation_id = ${operationId}::uuid`);
}

/**
 * Store a prepared intent as `required`, expiring five minutes after the database clock's insert time. An
 * existing row under the same key is returned untouched for the caller to compare; a second create intent for
 * the same session under another key is `session_exists`.
 */
export async function insertNativeIntent(db: PlacementExecutor, userId: string, input: NativeIntentInput, computerId: string,
    inputDigest: string, actor: NativeIntentActor): Promise<NativeIntentInsert> {
    assertKey(userId, input.operationId);
    if (!UUID.test(computerId) || !SHA256_DIGEST.test(inputDigest)) throw new TypeError('invalid native intent');
    const create = input.kind === 'create' ? input : null;
    const inserted = await selectOne(db, sql`/* native-auth:prepare */ INSERT INTO public.ezil_native_auth_intents
        (user_id, operation_id, kind, session_id, computer_id, instruction_revision, instruction_digest, instruction, instruction_bytes,
         input_digest, client_id, idp_issuer, subject, scope, state, created_at, expires_at, updated_at)
        SELECT ${userId}::uuid, ${input.operationId}::uuid, ${input.kind}, ${input.sessionId}::uuid, ${computerId}::uuid,
            ${create ? '1' : null}::bigint, ${create?.instructionDigest ?? null}, ${create?.instruction ?? null},
            ${create ? utf8Bytes(create.instruction) : null}::integer, ${inputDigest}, ${actor.clientId}, ${actor.idpIssuer},
            ${actor.subject}, ${actor.scope}, 'required', now_, now_ + interval '5 minutes', now_
        FROM (SELECT clock_timestamp() AS now_) clock
        ON CONFLICT DO NOTHING
        RETURNING ${COLUMNS}`);
    if (inserted) return { kind: 'inserted', intent: inserted };
    const existing = await lookupNativeIntent(db, userId, input.operationId);
    return existing ? { kind: 'existing', intent: existing } : { kind: 'session_exists' };
}

/**
 * Move an undecided intent to a final decision (autocommit compare-and-swap on the database clock).
 * `denied` and `blocked` need an unexpired intent; `expired` needs an expired one. Null when the stored
 * state is no longer `required` or the clock condition fails: the caller re-reads and never acts.
 */
export function decideNativeIntent(db: PlacementExecutor, userId: string, operationId: string,
    to: 'denied' | 'expired' | 'blocked', reason: string | null = null): Promise<NativeIntent | null> {
    assertKey(userId, operationId);
    if ((to === 'blocked') !== (reason !== null) || (reason !== null && !REASON.test(reason))) throw new TypeError('invalid native intent decision');
    const clock = to === 'expired' ? sql`clock_timestamp() >= expires_at` : sql`clock_timestamp() < expires_at`;
    return selectOne(db, sql`/* native-auth:decide */ UPDATE public.ezil_native_auth_intents
        SET state = ${to}, reason = ${reason}, decided_at = clock_timestamp(), updated_at = GREATEST(clock_timestamp(), updated_at)
        WHERE user_id = ${userId}::uuid AND operation_id = ${operationId}::uuid AND state = 'required' AND ${clock}
        RETURNING ${COLUMNS}`);
}

function assertTerms(terms: NativeConsentTermsConfig): void {
    if (!UUID.test(terms.policyId) || !POSITIVE_DECIMAL.test(terms.epoch) || !POSITIVE_DECIMAL.test(terms.budgetMicro)
        || !Number.isSafeInteger(terms.ttlSeconds) || terms.ttlSeconds < 1 || terms.ttlSeconds > 86_400) throw new TypeError('invalid native consent terms');
}

export type NativeApproval =
    | { kind: 'approved'; intent: NativeIntent }
    /** Another request decided it, the input differs, it is not a create, or the challenge expired. */
    | { kind: 'not_approvable' }
    /** The computer is not deliverable now (owner, AWS, RUNNING, instance, fence, lease): nothing was approved. */
    | { kind: 'refused'; reason: NativeRefusal };

/**
 * The owner approves exactly the create intent they saw (`inputDigest`), binding the admitted terms and the
 * full placement tuple, and its private task artifact is sealed in the same transaction. The tuple is read
 * under the broker's own canonical computer lock, live owner row `FOR SHARE` and placement read
 * (`currentAuthority`), never inferred later. The first approval time is millisecond exact and the
 * authorization deadline is `ttlSeconds` after it.
 */
export function approveNativeIntent(db: NativeAuthorityDb, userId: string, operationId: string, computerId: string, inputDigest: string,
    terms: NativeConsentTermsConfig): Promise<NativeApproval> {
    assertKey(userId, operationId);
    if (!UUID.test(computerId) || !SHA256_DIGEST.test(inputDigest)) throw new TypeError('invalid native intent approval');
    assertTerms(terms);
    return db.transaction(async (tx): Promise<NativeApproval> => {
        const authority = await currentAuthority(tx, userId, computerId);
        if (!authority.ok) return { kind: 'refused', reason: authority.reason };
        const p = authority.placement;
        // Consent only: a native consent binds generation and lease epoch >= 1 (the general placement rule allows 0).
        if (!POSITIVE_DECIMAL.test(p.generation) || !POSITIVE_DECIMAL.test(p.leaseEpoch)) return { kind: 'refused', reason: 'placement_invalid' };
        const approved = await selectOne(tx, sql`/* native-auth:approve */ UPDATE public.ezil_native_auth_intents
            SET state = 'approved', decided_at = t.at, updated_at = GREATEST(t.at, updated_at), authz_id = gen_random_uuid(),
                consent_epoch = ${terms.epoch}, budget_micro = ${terms.budgetMicro}, policy_id = ${terms.policyId}::uuid,
                service = ${NATIVE_CONSENT_SERVICE}, profile = ${NATIVE_CONSENT_PROFILE}, initial_approval_at = t.at,
                authorization_deadline = t.at + make_interval(secs => ${terms.ttlSeconds}::integer),
                approved_placement_generation = ${p.generation}::bigint, approved_placement_lease_epoch = ${p.leaseEpoch}::bigint,
                approved_placement_instance_id = ${p.instanceId}, approved_placement_fence_token = ${p.fenceToken}::uuid
            FROM (SELECT date_trunc('milliseconds', clock_timestamp()) AS at) t
            WHERE user_id = ${userId}::uuid AND operation_id = ${operationId}::uuid AND computer_id = ${computerId}::uuid AND kind = 'create'
                AND state = 'required' AND input_digest = ${inputDigest} AND t.at < expires_at
            RETURNING ${COLUMNS}`);
        if (!approved) return { kind: 'not_approvable' };
        const sealed = rowsOf(await tx.execute(sql`/* native-auth:seal */ INSERT INTO public.ezil_native_task_artifacts
            (user_id, task_ref, operation_id, session_id, computer_id, instruction_revision, instruction_digest, instruction,
             instruction_bytes, sealed_at)
            SELECT user_id, 'native-task:' || operation_id::text, operation_id, session_id, computer_id, instruction_revision,
                instruction_digest, instruction, instruction_bytes, clock_timestamp()
            FROM public.ezil_native_auth_intents WHERE user_id = ${userId}::uuid AND operation_id = ${operationId}::uuid
            RETURNING task_ref`));
        if (sealed.length !== 1 || sealed[0]!.task_ref !== nativeTaskRef(operationId)) throw new NativeIntentIntegrityError();
        return { kind: 'approved', intent: approved };
    });
}

/**
 * A renewal derives its session's existing authority: it is approved only by copying the create's terms
 * (same `authz_id`, epoch, budget, policy, first approval time, deadline and approved placement tuple, all
 * unchanged) while that create is approved
 * with terms, for the same computer and client, and its deadline has not passed. No browser approval, no new
 * approval time. Null when there is nothing to derive; the caller then blocks the renewal.
 */
export function deriveRenewNativeIntent(db: PlacementExecutor, userId: string, operationId: string): Promise<NativeIntent | null> {
    assertKey(userId, operationId);
    return selectOne(db, sql`/* native-auth:derive-renew */ UPDATE public.ezil_native_auth_intents r
        SET state = 'approved', decided_at = clock_timestamp(), updated_at = GREATEST(clock_timestamp(), r.updated_at), authz_id = c.authz_id,
            consent_epoch = c.consent_epoch, budget_micro = c.budget_micro, policy_id = c.policy_id, service = c.service, profile = c.profile,
            initial_approval_at = c.initial_approval_at, authorization_deadline = c.authorization_deadline,
            approved_placement_generation = c.approved_placement_generation, approved_placement_lease_epoch = c.approved_placement_lease_epoch,
            approved_placement_instance_id = c.approved_placement_instance_id, approved_placement_fence_token = c.approved_placement_fence_token
        FROM public.ezil_native_auth_intents c
        WHERE r.user_id = ${userId}::uuid AND r.operation_id = ${operationId}::uuid AND r.kind = 'renew' AND r.state = 'required'
            AND clock_timestamp() < r.expires_at
            AND c.user_id = r.user_id AND c.session_id = r.session_id AND c.kind = 'create' AND c.state = 'approved' AND c.authz_id IS NOT NULL
            AND c.computer_id = r.computer_id AND c.client_id = r.client_id AND clock_timestamp() < c.authorization_deadline
            AND NOT EXISTS (SELECT 1 FROM public.ezil_native_consent_revocations v WHERE v.user_id = c.user_id AND v.authz_id = c.authz_id)
        RETURNING ${columns('r')}`);
}

/**
 * The local STOP tombstone with the consent binding captured at the moment of the stop. Immutable; the
 * Gateway-side revocation is sent under `gatewayRevokeOperationId`, also for an authorization never issued.
 */
export interface NativeConsentRevocation {
    authorizationId: string;
    consentOperationId: string;
    gatewayRevokeOperationId: string;
    ownerUserId: string;
    sessionId: string;
    computerId: string;
    clientId: string;
    policyId: string;
    epoch: string;
    budgetMicro: string;
    initialApprovalAt: string;
    authorizationDeadline: string;
    placement: PinnedPlacement;
    revokedAt: string;
}

/**
 * The owner's local STOP of a whole AI consent: writes the terminal tombstone for `authzId` once (idempotent;
 * the first stop stays), capturing the immutable binding of the owner's create consent and a stable gateway-revoke
 * operation id. Works whatever the deployment's terms, Gateway configuration or computer state (no RUNNING, lease
 * or live placement prerequisite). Null when the owner has no create consent with that authorization. Never
 * touches, cancels or restarts an operation.
 *
 * One READ COMMITTED transaction under the SAME canonical computer lock dispatch holds (the computer id comes
 * from the owner's immutable consent): either the stop commits first and every later binding read is null, or
 * a dispatch that already read the binding finishes first and its genuine in-flight operation is preserved. The
 * transaction commits before any Gateway revocation step runs; no lock is held across the network.
 */
export async function revokeNativeConsent(db: NativeAuthorityDb, userId: string, authzId: string): Promise<NativeConsentRevocation | null> {
    if (!UUID.test(userId) || !UUID.test(authzId)) throw new TypeError('invalid native consent revocation');
    return db.transaction(async (tx) => {
        const owned = rowsOf(await tx.execute(sql`/* native-auth:revoke-locate */ SELECT computer_id::text AS computer_id
            FROM public.ezil_native_auth_intents WHERE user_id = ${userId}::uuid AND authz_id = ${authzId}::uuid AND kind = 'create'`));
        if (owned.length === 0) return null;
        if (owned.length !== 1 || typeof owned[0]!.computer_id !== 'string' || !UUID.test(owned[0]!.computer_id)) throw new NativeIntentIntegrityError();
        await lockComputer(tx, owned[0]!.computer_id);
        await insertRevocation(tx, userId, authzId);
        return readNativeConsentRevocation(tx, userId, authzId);
    });
}

async function insertRevocation(tx: PlacementExecutor, userId: string, authzId: string): Promise<void> {
    await tx.execute(sql`/* native-auth:revoke */ INSERT INTO public.ezil_native_consent_revocations (user_id, authz_id, consent_operation_id,
            gateway_revoke_operation_id, session_id, computer_id, client_id, policy_id, consent_epoch, budget_micro, initial_approval_at,
            authorization_deadline, approved_placement_generation, approved_placement_lease_epoch, approved_placement_instance_id,
            approved_placement_fence_token, revoked_at)
        SELECT i.user_id, i.authz_id, i.operation_id, gen_random_uuid(), i.session_id, i.computer_id, i.client_id, i.policy_id, i.consent_epoch,
            i.budget_micro, i.initial_approval_at, i.authorization_deadline, i.approved_placement_generation, i.approved_placement_lease_epoch,
            i.approved_placement_instance_id, i.approved_placement_fence_token, clock_timestamp()
        FROM public.ezil_native_auth_intents i
        WHERE i.user_id = ${userId}::uuid AND i.authz_id = ${authzId}::uuid AND i.kind = 'create'
        ON CONFLICT DO NOTHING`);
}

/** The owner's captured revocation of this consent, or null. One SELECT; works inside a caller's transaction. */
export async function readNativeConsentRevocation(db: PlacementExecutor, userId: string, authzId: string): Promise<NativeConsentRevocation | null> {
    if (!UUID.test(userId) || !UUID.test(authzId)) throw new TypeError('invalid native consent key');
    const rows = rowsOf(await db.execute(sql`/* native-auth:revocation */ SELECT user_id::text AS user_id, authz_id::text AS authz_id,
            consent_operation_id::text AS consent_operation_id, gateway_revoke_operation_id::text AS gateway_revoke_operation_id,
            session_id::text AS session_id, computer_id::text AS computer_id, client_id, policy_id::text AS policy_id, consent_epoch, budget_micro,
            initial_approval_at, authorization_deadline, approved_placement_generation::text AS generation,
            approved_placement_lease_epoch::text AS lease_epoch, approved_placement_instance_id AS instance_id,
            approved_placement_fence_token::text AS fence_token, revoked_at
        FROM public.ezil_native_consent_revocations WHERE user_id = ${userId}::uuid AND authz_id = ${authzId}::uuid`));
    if (rows.length === 0) return null;
    const r = rows[0]!;
    const at = (v: unknown) => { const d = time(v); if (!d) throw new NativeIntentIntegrityError(); return d.toISOString(); };
    const str = (v: unknown, pattern: RegExp) => { if (typeof v !== 'string' || !pattern.test(v)) throw new NativeIntentIntegrityError(); return v; };
    return Object.freeze({
        authorizationId: str(r.authz_id, UUID), consentOperationId: str(r.consent_operation_id, UUID),
        gatewayRevokeOperationId: str(r.gateway_revoke_operation_id, UUID), ownerUserId: str(r.user_id, UUID), sessionId: str(r.session_id, UUID),
        computerId: str(r.computer_id, UUID), clientId: str(r.client_id, /^[^]{1,256}$/), policyId: str(r.policy_id, UUID),
        epoch: str(r.consent_epoch, POSITIVE_DECIMAL), budgetMicro: str(r.budget_micro, POSITIVE_DECIMAL),
        initialApprovalAt: at(r.initial_approval_at), authorizationDeadline: at(r.authorization_deadline),
        placement: Object.freeze({ generation: str(r.generation, POSITIVE_DECIMAL), leaseEpoch: str(r.lease_epoch, POSITIVE_DECIMAL),
            instanceId: str(r.instance_id, INSTANCE), fenceToken: str(r.fence_token, UUID) }),
        revokedAt: at(r.revoked_at),
    });
}

/** When the owner revoked this consent, or null. One SELECT. */
export async function nativeConsentRevokedAt(db: PlacementExecutor, userId: string, authzId: string): Promise<Date | null> {
    if (!UUID.test(userId) || !UUID.test(authzId)) throw new TypeError('invalid native consent key');
    const rows = rowsOf(await db.execute(sql`/* native-auth:revoked */ SELECT revoked_at FROM public.ezil_native_consent_revocations
        WHERE user_id = ${userId}::uuid AND authz_id = ${authzId}::uuid`));
    const at = rows[0] ? time(rows[0].revoked_at) : null;
    if (at === undefined) throw new NativeIntentIntegrityError();
    return at;
}

/**
 * Record a definite PRE-CLAIM refusal of the one dispatch attempt (for example no fresh proof, a stopped
 * computer or an existing session): only while NO native session operation exists under this key in any
 * state, so nothing was exchanged or dispatched. Once one exists, even unknown, this matches nothing and the
 * intent stays approved with that exact operation as its status; the guard trigger enforces the same rule.
 * `decided_at`, the terms, the input digest and the expiry are untouched.
 */
export function blockApprovedNativeIntent(db: PlacementExecutor, userId: string, operationId: string, reason: string): Promise<NativeIntent | null> {
    assertKey(userId, operationId);
    if (!REASON.test(reason)) throw new TypeError('invalid native intent reason');
    return selectOne(db, sql`/* native-auth:block-approved */ UPDATE public.ezil_native_auth_intents i
        SET state = 'blocked', reason = ${reason}, updated_at = GREATEST(clock_timestamp(), i.updated_at)
        WHERE i.user_id = ${userId}::uuid AND i.operation_id = ${operationId}::uuid AND i.state = 'approved'
            AND NOT EXISTS (SELECT 1 FROM public.ezil_native_session_operations o
                WHERE o.user_id = i.user_id AND o.operation_id = i.operation_id)
        RETURNING ${COLUMNS}`);
}

/**
 * The real owned task resolver: `native-task:<operationId>` resolves only to the owner's own sealed artifact,
 * joined to its still-approved create intent (same operation, session, computer, revision and digest) and to
 * a computer that is still the owner's live computer. A blocked, denied or expired intent, or a transferred
 * or deleted computer, resolves to nothing. The text is re-measured and re-digested before it is admitted;
 * the `sha256:` digest form is kept as is.
 */
export function nativeArtifactTaskResolver(db: PlacementExecutor): NativeTaskResolver {
    return {
        async resolve(taskRef, owner): Promise<SealedNativeTask | null> {
            const match = /^native-task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(taskRef);
            if (!UUID.test(owner.userId) || !match) return null;
            const rows = rowsOf(await db.execute(sql`/* native-auth:artifact */ SELECT a.task_ref, a.instruction_revision::text AS instruction_revision,
                a.instruction_digest, a.instruction, a.instruction_bytes
                FROM public.ezil_native_task_artifacts a
                JOIN public.ezil_native_auth_intents i ON i.user_id = a.user_id AND i.operation_id = a.operation_id
                JOIN public.ezil_computers c ON c.id = a.computer_id AND c.user_id = a.user_id AND c.deleted_at IS NULL
                WHERE a.user_id = ${owner.userId}::uuid AND a.task_ref = ${taskRef} AND a.operation_id = ${match[1]}::uuid
                    AND i.kind = 'create' AND i.state = 'approved' AND i.session_id = a.session_id AND i.computer_id = a.computer_id
                    AND i.instruction_revision = a.instruction_revision AND i.instruction_digest = a.instruction_digest`));
            if (rows.length === 0) return null;
            const row = rows[0]!;
            const instruction = row.instruction;
            if (rows.length !== 1 || row.task_ref !== taskRef || row.instruction_revision !== '1' || typeof instruction !== 'string'
                || typeof row.instruction_digest !== 'string' || !isWellFormedUnicode(instruction)
                || utf8Bytes(instruction) !== Number(row.instruction_bytes) || utf8Bytes(instruction) > NATIVE_INSTRUCTION_MAX_BYTES
                || nativeInstructionDigest(instruction) !== row.instruction_digest) throw new NativeIntentIntegrityError();
            return Object.freeze({ taskRef, instructionRevision: 1, instructionDigest: row.instruction_digest, instruction });
        },
    };
}
