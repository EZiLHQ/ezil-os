/**
 * Durable private outbox for native authorization operations (migration 0033, reserved and unapplied).
 *
 * ## Inputs
 * - The configuration is READY only (`loadNativeAuthorizationConfig`): with the gate off or any pin missing the caller
 *   has nothing to pass, so nothing is claimed, written, signed or sent.
 * - The consent binding comes ONLY from the injected trusted reader, `readApprovedNativeConsentBinding`, owned by the
 *   session-visibility owner and keyed by the owner and the consent's original CREATE operation id. It is
 *   re-validated here and never taken from caller JSON. Each renewal's `leaseExpiresAt` is a separate,
 *   per-operation input from the coordinator.
 *
 * ## Lock order (every path)
 * This module's operation advisory lock, then the reader's own lock (the canonical computer lock), then the
 * authorization row. A renewal's dispatch reads the live consent before the authorization row and keeps that one
 * transaction through its dispatch compare-and-set.
 *
 * ## Prepare (one transaction, before any network)
 * Operation lock (`NATIVE_AUTHORIZATION_OPERATION_LOCK_NAMESPACE`, READ COMMITTED asserted), then the authorization
 * row. A known operation is returned as it is when the request is identical, and is a conflict otherwise; nothing is
 * rewritten. A new renewal binds, in the same transaction: the operation id, the full request digest, the semantic
 * tuple, and a fresh random `ezg_` candidate. The candidate is stored only as AES-256-GCM ciphertext, and only its
 * hash enters the tuple. A retry or restart of the same operation loads that same candidate and hash.
 *
 * ## Dispatch and reconciliation
 * - `dispatchNativeOperationOnce` moves `prepared` to `dispatching` with a new attempt id and commits that BEFORE the
 *   one POST. It then settles `granted` / `revoked` / `refused` / `delivery_unknown` by compare-and-set on that
 *   attempt id. A crash after the commit leaves `dispatching`, which dispatch never touches again.
 * - `reconcileNativeOperation` is the only path out of `delivery_unknown`, or out of a `dispatching` older than the
 *   exchange timeout. It re-signs a fresh envelope over the SAME stored tuple (same operation, hash and lease) for the
 *   Gateway's idempotent replay. It never creates an operation or a candidate, nor moves a term. It runs only under
 *   live consent, lease and configuration, at most `NATIVE_AUTHORIZATION_MAX_ATTEMPTS` attempts in all, and only
 *   when an explicit coordinator calls it. Nothing here retries on its own.
 * - One renewal in flight per authorization: while any renewal of it is `dispatching` or `delivery_unknown`, no
 *   other renewal is prepared or dispatched (`unresolved_renewal`). Only the same operation's reconciliation can
 *   resolve it. A renewal left unknown after its last attempt keeps the authorization blocked; continuing then needs
 *   a new consent and authorization.
 *
 * ## Revoke
 * Revoke marks the authorization terminal (`revoke_operation_id`, set once) in the same transaction that records the
 * signed revoke operation. From then on no renewal of it is prepared, dispatched, reconciled or opened, whatever the
 * revoke's own outcome. An unknown revoke never resumes grants.
 *
 * ## Delivery
 * `openNativeGrantCandidate` decrypts a granted, unexpired, unrevoked candidate whose consent is still the approved one,
 * into a `NativeGrantBearer` for the closed private host transport. It records no delivery state: host delivery is
 * not wired here.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { PlacementIsolationError, type PlacementExecutor } from '@/server/lib/compute/placement';

import type { NativeAuthorityDb } from './authority';
import {
    NativeGrantBearer, newNativeGrantCandidate, nativeTokenSha256, openNativeCandidate, sealNativeCandidate,
} from './native-authorization-candidate';
import type { NativeAuthorizationConfig } from './native-authorization-config';
import {
    NATIVE_AUTHORIZATION_TIMEOUT_MS, NativeAuthorizationSendError, postNativeRenewal, postNativeRevoke, type NativeExchangeDeps,
    type NativeRenewOutcome, type NativeRevokeOutcome,
} from './native-authorization-exchange';
import {
    NATIVE_ASSERTION_CLOCK_SKEW_MS, NATIVE_LEASE_MAX_MS, isNativeInstant, isNativeSemantic, isNativeUuid, nativeCanonicalDigest,
    nativeCanonicalJson, nativeConsentBinding, nativeRenewSemantic, nativeRevokeSemantic, nativeSemanticBinding,
    signNativeAssertion, type NativeConsentBinding, type NativeConsentKey, type NativeOperationKind, type NativeSemantic,
} from './native-authorization-protocol';

/** ASCII "EZng". Distinct from the native session ("EZno", "EZns") and placement namespaces. */
export const NATIVE_AUTHORIZATION_OPERATION_LOCK_NAMESPACE = 0x455a6e67;
export const NATIVE_AUTHORIZATION_MAX_ATTEMPTS = 3;
/** A renewal's lease must leave at least this long when it is prepared. */
export const NATIVE_RENEW_MIN_LEASE_MS = 30_000;
/** A dispatch older than this has outlived its exchange and may be reconciled. */
export const NATIVE_ABANDONED_DISPATCH_MS = NATIVE_AUTHORIZATION_TIMEOUT_MS + 5_000;
/** A grant is opened for delivery only while at least this long remains. */
export const NATIVE_GRANT_MIN_REMAINING_MS = 10_000;

/** The trusted reader the session-visibility owner injects. Null for anything but a complete approved v1 consent. */
export type ReadApprovedNativeConsentBinding = (db: PlacementExecutor, key: NativeConsentKey) => Promise<NativeConsentBinding | null>;

export interface NativeOutboxDeps {
    readonly config: NativeAuthorizationConfig;
    readonly readConsent: ReadApprovedNativeConsentBinding;
    readonly now: () => number;
}

export interface NativeDispatchDeps extends NativeOutboxDeps {
    readonly fetchImpl: typeof fetch;
    readonly timeoutMs?: number;
}

export interface NativeRenewalRequest {
    readonly ownerUserId: string;
    /** The original CREATE operation of the approved consent: the reader's `operationId` key. */
    readonly consentOperationId: string;
    /** This Gateway renewal's own durable operation id. */
    readonly operationId: string;
    /** This operation's signed native lease: `toISOString` form, 30 s to 4 min 50 s ahead, before the deadline. */
    readonly leaseExpiresAt: string;
}

export interface NativeRevokeRequest {
    readonly ownerUserId: string;
    readonly consentOperationId: string;
    readonly operationId: string;
    readonly authorizationId: string;
}

export interface NativeOperationKey {
    readonly ownerUserId: string;
    readonly operationId: string;
}

export type NativeAuthorizationOperationState = 'prepared' | 'dispatching' | 'granted' | 'revoked' | 'refused' | 'delivery_unknown';

/** Safe to return to a coordinator: no candidate, ciphertext, hash, tuple or assertion. */
export interface NativeAuthorizationOperationStatus {
    readonly operationId: string;
    readonly kind: NativeOperationKind;
    readonly authorizationId: string;
    readonly state: NativeAuthorizationOperationState;
    readonly attempt: number;
    readonly reason: string | null;
    readonly refusalStatus: number | null;
    readonly leaseExpiresAt: string | null;
    readonly grantId: string | null;
    readonly grantExpiresAt: string | null;
    readonly replayed: boolean | null;
    readonly revokedAt: string | null;
    readonly alreadyRevoked: boolean | null;
}

export type NativePrepareRefusal = 'request_invalid' | 'service_expired' | 'consent_unavailable' | 'consent_mismatch'
    | 'policy_mismatch' | 'deadline_passed' | 'lease_invalid' | 'binding_conflict' | 'authorization_revoked' | 'unresolved_renewal';

export type NativePrepareOutcome =
    | { readonly kind: 'prepared' | 'existing'; readonly status: NativeAuthorizationOperationStatus }
    | { readonly kind: 'already_revoking'; readonly revokeOperationId: string }
    | { readonly kind: 'conflict' }
    | { readonly kind: 'refused'; readonly reason: NativePrepareRefusal };

export type NativeDispatchBlock = 'request_invalid' | 'not_found' | 'not_dispatchable' | 'dispatch_in_flight' | 'attempts_exhausted'
    | 'semantic_corrupt' | 'service_expired' | 'authorization_revoked' | 'consent_unavailable' | 'consent_changed'
    | 'deadline_passed' | 'lease_ended' | 'unresolved_renewal' | 'assertion_stale';

export type NativeDispatchOutcome =
    | { readonly kind: 'settled'; readonly status: NativeAuthorizationOperationStatus }
    | { readonly kind: 'blocked'; readonly reason: NativeDispatchBlock; readonly status?: NativeAuthorizationOperationStatus }
    /** A reconciliation took the operation over while this attempt was in flight; its answer was not recorded. */
    | { readonly kind: 'superseded' };

export type NativeOpenRefusal = 'request_invalid' | 'not_found' | 'not_granted' | 'authorization_revoked' | 'consent_unavailable'
    | 'consent_changed' | 'grant_expired' | 'wrapping_key_unavailable' | 'candidate_invalid';

/** The authorization terms the opened grant was issued under, exactly as sealed in its stored tuple. */
export interface NativeSourceAuthorization {
    readonly authorizationId: string;
    readonly epoch: string;
    readonly authorizationDeadline: string;
    readonly clientId: string;
    readonly profileId: NativeConsentBinding['profileId'];
    readonly policyId: string;
    readonly budgetMicro: string;
    readonly initialApprovalAt: string;
}

export type NativeOpenOutcome =
    | {
        readonly kind: 'opened';
        /** The candidate, reachable only through `authorizationHeader()`. */
        readonly bearer: NativeGrantBearer;
        /** The stored 64-hex SHA-256 the Gateway grant is bound to. */
        readonly tokenSha256: string;
        readonly sourceAuthorization: NativeSourceAuthorization;
    }
    | { readonly kind: 'refused'; readonly reason: NativeOpenRefusal };

/* ------------------------------------------------------------------ rows */

interface OperationRow {
    operation_id: string;
    owner_user_id: string;
    kind: NativeOperationKind;
    authorization_id: string;
    consent_operation_id: string;
    request_digest: string;
    semantic: string;
    semantic_digest: string;
    lease_expires_at: Date | null;
    token_sha256: string | null;
    candidate_version: number | null;
    candidate_key_id: string | null;
    candidate_nonce: Uint8Array | null;
    candidate_ciphertext: Uint8Array | null;
    state: NativeAuthorizationOperationState;
    attempt: number;
    attempt_id: string | null;
    dispatched_at: Date | null;
    reason: string | null;
    refusal_status: number | null;
    grant_id: string | null;
    grant_expires_at: Date | null;
    grant_replayed: boolean | null;
    gateway_revoked_at: Date | null;
    already_revoked: boolean | null;
}

interface AuthorizationRow {
    owner_user_id: string;
    binding: string;
    binding_digest: string;
    revoke_operation_id: string | null;
}

/** Instants leave SQL as `toISOString` text (whole milliseconds, as every writer here stores them), whatever the driver. */
const instantColumn = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${column}`;
const OPERATION_COLUMNS = sql.raw(`operation_id::text AS operation_id, owner_user_id::text AS owner_user_id, kind,
    authorization_id::text AS authorization_id, consent_operation_id::text AS consent_operation_id, request_digest, semantic,
    semantic_digest, ${instantColumn('lease_expires_at')}, token_sha256, candidate_version, candidate_key_id, candidate_nonce,
    candidate_ciphertext, state, attempt, attempt_id::text AS attempt_id, ${instantColumn('dispatched_at')}, reason, refusal_status,
    grant_id::text AS grant_id, ${instantColumn('grant_expires_at')}, grant_replayed, ${instantColumn('gateway_revoked_at')},
    already_revoked`);

function rowsOf(result: unknown): Record<string, unknown>[] {
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    return ((result as { rows?: Record<string, unknown>[] } | null)?.rows ?? []) as Record<string, unknown>[];
}

function assertReadCommitted(result: unknown): void {
    const isolation = rowsOf(result)[0]?.isolation;
    if (isolation !== 'read committed') throw new PlacementIsolationError(String(isolation));
}

const at = (ms: number) => new Date(ms).toISOString();
const iso = (value: Date | null) => (value ? value.toISOString() : null);
const bytes = (value: unknown) => (value instanceof Uint8Array ? value : null);
const instant = (value: unknown) => (typeof value === 'string' && isNativeInstant(value) ? new Date(value) : null);

function toOperation(raw: Record<string, unknown>): OperationRow {
    const row = raw as unknown as OperationRow;
    return { ...row, candidate_nonce: bytes(raw.candidate_nonce), candidate_ciphertext: bytes(raw.candidate_ciphertext),
        lease_expires_at: instant(raw.lease_expires_at), dispatched_at: instant(raw.dispatched_at),
        grant_expires_at: instant(raw.grant_expires_at), gateway_revoked_at: instant(raw.gateway_revoked_at),
        candidate_version: raw.candidate_version === null ? null : Number(raw.candidate_version), attempt: Number(raw.attempt),
        refusal_status: raw.refusal_status === null ? null : Number(raw.refusal_status) };
}

function statusOf(row: OperationRow): NativeAuthorizationOperationStatus {
    return Object.freeze({
        operationId: row.operation_id, kind: row.kind, authorizationId: row.authorization_id, state: row.state,
        attempt: row.attempt, reason: row.reason, refusalStatus: row.refusal_status, leaseExpiresAt: iso(row.lease_expires_at),
        grantId: row.grant_id, grantExpiresAt: iso(row.grant_expires_at), replayed: row.grant_replayed,
        revokedAt: iso(row.gateway_revoked_at), alreadyRevoked: row.already_revoked,
    });
}

async function lockOperation(tx: PlacementExecutor, operationId: string): Promise<void> {
    assertReadCommitted(await tx.execute(sql`/* native-authorization:lock-operation */ SELECT pg_advisory_xact_lock(${NATIVE_AUTHORIZATION_OPERATION_LOCK_NAMESPACE}::int4, hashtext(${operationId}::uuid::text)), current_setting('transaction_isolation') AS isolation`));
}

async function selectOperation(tx: PlacementExecutor, operationId: string, lock: 'update' | 'share'): Promise<OperationRow | null> {
    const mode = sql.raw(lock === 'update' ? 'FOR UPDATE' : 'FOR SHARE');
    const [row] = rowsOf(await tx.execute(sql`/* native-authorization:operation */ SELECT ${OPERATION_COLUMNS}
        FROM public.ezil_native_authorization_operations WHERE operation_id = ${operationId}::uuid ${mode}`));
    return row ? toOperation(row) : null;
}

async function selectAuthorization(tx: PlacementExecutor, authorizationId: string, lock: 'update' | 'share'): Promise<AuthorizationRow | null> {
    const mode = sql.raw(lock === 'update' ? 'FOR UPDATE' : 'FOR SHARE');
    const [row] = rowsOf(await tx.execute(sql`/* native-authorization:authorization */ SELECT owner_user_id::text AS owner_user_id,
        binding, binding_digest, revoke_operation_id::text AS revoke_operation_id
        FROM public.ezil_native_authorizations WHERE authorization_id = ${authorizationId}::uuid ${mode}`));
    return (row as unknown as AuthorizationRow | undefined) ?? null;
}

/**
 * Records `binding` as the authorization's immutable terms on first use and locks the row. Null when the
 * authorization is already bound to another owner or to different terms: a rebinding needs a new consent.
 */
async function bindAuthorization(tx: PlacementExecutor, binding: NativeConsentBinding, now: number): Promise<AuthorizationRow | null> {
    const digest = nativeCanonicalDigest(binding);
    await tx.execute(sql`/* native-authorization:bind */ INSERT INTO public.ezil_native_authorizations
        (authorization_id, owner_user_id, binding, binding_digest, revoke_operation_id, revoke_requested_at, created_at)
        VALUES (${binding.authorizationId}::uuid, ${binding.ownerUserId}::uuid, ${nativeCanonicalJson(binding)}, ${digest}, NULL, NULL,
        ${at(now)}::timestamptz) ON CONFLICT (authorization_id) DO NOTHING`);
    const row = await selectAuthorization(tx, binding.authorizationId, 'update');
    return row && row.owner_user_id === binding.ownerUserId && row.binding_digest === digest ? row : null;
}

/**
 * True while another renewal of the authorization is `dispatching` or `delivery_unknown`: its grant may exist, so no
 * other renewal is prepared or sent until that same operation is reconciled. Called under the authorization row lock.
 */
async function hasUnresolvedRenewal(tx: PlacementExecutor, authorizationId: string, exceptOperationId: string | null): Promise<boolean> {
    const [row] = rowsOf(await tx.execute(sql`/* native-authorization:unresolved */ SELECT 1 AS unresolved
        FROM public.ezil_native_authorization_operations WHERE authorization_id = ${authorizationId}::uuid AND kind = 'renew'
        AND state IN ('dispatching', 'delivery_unknown') AND operation_id IS DISTINCT FROM ${exceptOperationId}::uuid LIMIT 1`));
    return Boolean(row);
}

/** The stored tuple, or null when it is not the one its digest and row columns seal. */
function storedSemantic(row: OperationRow): NativeSemantic | null {
    let value: unknown;
    try { value = JSON.parse(row.semantic); } catch { return null; }
    if (!isNativeSemantic(value) || nativeCanonicalJson(value) !== row.semantic || nativeCanonicalDigest(value) !== row.semantic_digest) return null;
    if (value.operation !== row.kind || value.operationId !== row.operation_id || value.ownerUserId !== row.owner_user_id
        || value.authorizationId !== row.authorization_id) return null;
    if (value.operation === 'renew' && (value.tokenSha256 !== row.token_sha256
        || Date.parse(value.leaseExpiresAt) !== row.lease_expires_at?.getTime())) return null;
    return value;
}

function sameRequest(row: OperationRow, ownerUserId: string, requestDigest: string): boolean {
    return row.owner_user_id === ownerUserId && row.request_digest === requestDigest;
}

/** The consent read through the trusted reader, re-validated; null for anything but the exact 13-field v1 binding. */
async function readConsent(tx: PlacementExecutor, deps: NativeOutboxDeps, ownerUserId: string,
    consentOperationId: string): Promise<NativeConsentBinding | null> {
    return nativeConsentBinding(await deps.readConsent(tx, { ownerUserId, operationId: consentOperationId }));
}

/* ------------------------------------------------------------------ prepare */

/** Thrown inside a prepare transaction to refuse AND roll back what it already wrote. */
class PrepareRollback extends Error {
    constructor(readonly reason: NativePrepareRefusal) {
        super(`native_prepare_${reason}`);
        this.name = 'PrepareRollback';
    }
}

/** The time terms of a renewal at `now`: service credential, fixed deadline and the operation's lease window. */
function renewTimeRefusal(deps: NativeOutboxDeps, binding: NativeConsentBinding, leaseExpiresAt: string,
    now: number): NativePrepareRefusal | null {
    if (deps.config.serviceExpiresAt.getTime() <= now) return 'service_expired';
    const deadline = Date.parse(binding.authorizationDeadline);
    if (now >= deadline) return 'deadline_passed';
    const lease = Date.parse(leaseExpiresAt);
    // The Gateway accepts a lease of at most five minutes on ITS clock; keep the skew allowance on ours.
    if (lease - now < NATIVE_RENEW_MIN_LEASE_MS || lease > now + NATIVE_LEASE_MAX_MS - NATIVE_ASSERTION_CLOCK_SKEW_MS || lease > deadline) {
        return 'lease_invalid';
    }
    return null;
}

/**
 * Prepares one renewal, or returns the identical one already prepared. Nothing is sent. The candidate is generated
 * before the transaction and discarded unless this call is the one that inserts the operation.
 */
export async function prepareNativeRenewal(db: NativeAuthorityDb, deps: NativeOutboxDeps,
    request: NativeRenewalRequest): Promise<NativePrepareOutcome> {
    const { ownerUserId, consentOperationId, operationId, leaseExpiresAt } = request;
    if (![ownerUserId, consentOperationId, operationId].every(isNativeUuid) || !isNativeInstant(leaseExpiresAt)) {
        return { kind: 'refused', reason: 'request_invalid' };
    }
    const requestDigest = nativeCanonicalDigest({ kind: 'renew', ownerUserId, consentOperationId, operationId, leaseExpiresAt });
    const candidate = newNativeGrantCandidate();
    const tokenSha256 = nativeTokenSha256(candidate);
    return db.transaction(async (tx): Promise<NativePrepareOutcome> => {
        await lockOperation(tx, operationId);
        const existing = await selectOperation(tx, operationId, 'update');
        if (existing) return sameRequest(existing, ownerUserId, requestDigest) ? { kind: 'existing', status: statusOf(existing) } : { kind: 'conflict' };
        // The clock is read only AFTER the reader's (computer) lock wait, never before it.
        const binding = await readConsent(tx, deps, ownerUserId, consentOperationId);
        if (!binding) return { kind: 'refused', reason: 'consent_unavailable' };
        if (binding.ownerUserId !== ownerUserId) return { kind: 'refused', reason: 'consent_mismatch' };
        if (binding.policyId !== deps.config.policyId) return { kind: 'refused', reason: 'policy_mismatch' };
        const early = renewTimeRefusal(deps, binding, leaseExpiresAt, deps.now());
        if (early) return { kind: 'refused', reason: early };
        const bindNow = deps.now();
        const authorization = await bindAuthorization(tx, binding, bindNow);
        if (!authorization) return { kind: 'refused', reason: 'binding_conflict' };
        if (authorization.revoke_operation_id !== null) return { kind: 'refused', reason: 'authorization_revoked' };
        if (await hasUnresolvedRenewal(tx, binding.authorizationId, null)) return { kind: 'refused', reason: 'unresolved_renewal' };
        const semantic = nativeRenewSemantic(binding, operationId, leaseExpiresAt, tokenSha256, deps.config.environment);
        const semanticDigest = nativeCanonicalDigest(semantic);
        const sealed = await sealNativeCandidate(deps.config.wrapping, candidate,
            { ownerUserId, operationId, authorizationId: binding.authorizationId, semanticDigest, tokenSha256 });
        // Again on a fresh clock after the row lock and sealing: a late refusal rolls the whole transaction back,
        // including a first-time authorization binding.
        const now = deps.now();
        const late = renewTimeRefusal(deps, binding, leaseExpiresAt, now);
        if (late) throw new PrepareRollback(late);
        const [row] = rowsOf(await tx.execute(sql`/* native-authorization:prepare-renew */ INSERT INTO public.ezil_native_authorization_operations
            (operation_id, owner_user_id, kind, authorization_id, consent_operation_id, request_digest, semantic, semantic_digest,
             lease_expires_at, token_sha256, candidate_version, candidate_key_id, candidate_nonce, candidate_ciphertext,
             state, attempt, attempt_id, dispatched_at, reason, refusal_status, grant_id, grant_expires_at, grant_replayed,
             gateway_revoked_at, already_revoked, created_at, updated_at)
            VALUES (${operationId}::uuid, ${ownerUserId}::uuid, 'renew', ${binding.authorizationId}::uuid, ${consentOperationId}::uuid,
             ${requestDigest}, ${nativeCanonicalJson(semantic)}, ${semanticDigest}, ${leaseExpiresAt}::timestamptz, ${tokenSha256},
             ${sealed.version}, ${sealed.keyId}, ${Buffer.from(sealed.nonce)}, ${Buffer.from(sealed.ciphertext)},
             'prepared', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${at(now)}::timestamptz, ${at(now)}::timestamptz)
            RETURNING ${OPERATION_COLUMNS}`));
        return { kind: 'prepared', status: statusOf(toOperation(row!)) };
    }).catch((error: unknown): NativePrepareOutcome => {
        if (error instanceof PrepareRollback) return { kind: 'refused', reason: error.reason };
        throw error;
    });
}

/**
 * Prepares the signed revoke of one authorization and makes it terminal for renewals at once. The terms are the
 * authorization's recorded binding; only an authorization never renewed here is bound from the trusted reader, so
 * the Gateway records a revoked tombstone that refuses any later renewal.
 */
export async function prepareNativeRevoke(db: NativeAuthorityDb, deps: NativeOutboxDeps,
    request: NativeRevokeRequest): Promise<NativePrepareOutcome> {
    const { ownerUserId, consentOperationId, operationId, authorizationId } = request;
    if (![ownerUserId, consentOperationId, operationId, authorizationId].every(isNativeUuid)) return { kind: 'refused', reason: 'request_invalid' };
    const requestDigest = nativeCanonicalDigest({ kind: 'revoke', ownerUserId, consentOperationId, operationId, authorizationId });
    return db.transaction(async tx => {
        await lockOperation(tx, operationId);
        const existing = await selectOperation(tx, operationId, 'update');
        if (existing) return sameRequest(existing, ownerUserId, requestDigest) ? { kind: 'existing', status: statusOf(existing) } : { kind: 'conflict' };
        // An unlocked look first: only an authorization never bound here needs the reader, whose computer lock must
        // come before the authorization row lock (the order every path keeps).
        const [known] = rowsOf(await tx.execute(sql`/* native-authorization:known */ SELECT 1 AS known
            FROM public.ezil_native_authorizations WHERE authorization_id = ${authorizationId}::uuid`));
        let authorization = known ? await selectAuthorization(tx, authorizationId, 'update') : null;
        let binding: NativeConsentBinding | null;
        if (authorization) {
            if (authorization.owner_user_id !== ownerUserId) return { kind: 'refused', reason: 'consent_mismatch' };
            let stored: unknown = null;
            try { stored = JSON.parse(authorization.binding); } catch { /* refused below */ }
            binding = nativeConsentBinding(stored);
            if (!binding || nativeCanonicalDigest(binding) !== authorization.binding_digest) return { kind: 'refused', reason: 'binding_conflict' };
        } else {
            binding = await readConsent(tx, deps, ownerUserId, consentOperationId);
            if (!binding) return { kind: 'refused', reason: 'consent_unavailable' };
            if (binding.ownerUserId !== ownerUserId || binding.authorizationId !== authorizationId) return { kind: 'refused', reason: 'consent_mismatch' };
            if (deps.config.serviceExpiresAt.getTime() <= deps.now()) return { kind: 'refused', reason: 'service_expired' };
            authorization = await bindAuthorization(tx, binding, deps.now());
            if (!authorization) return { kind: 'refused', reason: 'binding_conflict' };
        }
        if (binding.policyId !== deps.config.policyId) return { kind: 'refused', reason: 'policy_mismatch' };
        if (authorization.revoke_operation_id !== null) return { kind: 'already_revoking', revokeOperationId: authorization.revoke_operation_id };
        // Clock read after every lock wait.
        const now = deps.now();
        if (deps.config.serviceExpiresAt.getTime() <= now) return { kind: 'refused', reason: 'service_expired' };
        const semantic = nativeRevokeSemantic(binding, operationId, deps.config.environment);
        await tx.execute(sql`/* native-authorization:mark-revoked */ UPDATE public.ezil_native_authorizations
            SET revoke_operation_id = ${operationId}::uuid, revoke_requested_at = ${at(now)}::timestamptz
            WHERE authorization_id = ${authorizationId}::uuid AND revoke_operation_id IS NULL`);
        const [row] = rowsOf(await tx.execute(sql`/* native-authorization:prepare-revoke */ INSERT INTO public.ezil_native_authorization_operations
            (operation_id, owner_user_id, kind, authorization_id, consent_operation_id, request_digest, semantic, semantic_digest,
             lease_expires_at, token_sha256, candidate_version, candidate_key_id, candidate_nonce, candidate_ciphertext,
             state, attempt, attempt_id, dispatched_at, reason, refusal_status, grant_id, grant_expires_at, grant_replayed,
             gateway_revoked_at, already_revoked, created_at, updated_at)
            VALUES (${operationId}::uuid, ${ownerUserId}::uuid, 'revoke', ${authorizationId}::uuid, ${consentOperationId}::uuid,
             ${requestDigest}, ${nativeCanonicalJson(semantic)}, ${nativeCanonicalDigest(semantic)}, NULL, NULL, NULL, NULL, NULL, NULL,
             'prepared', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${at(now)}::timestamptz, ${at(now)}::timestamptz)
            RETURNING ${OPERATION_COLUMNS}`));
        return { kind: 'prepared', status: statusOf(toOperation(row!)) };
    });
}

/* ------------------------------------------------------------------ dispatch */

type Started = { kind: 'started'; semantic: NativeSemantic; attemptId: string; token: string; issuedAt: string; expiresAt: string }
    | { kind: 'blocked'; reason: NativeDispatchBlock; status?: NativeAuthorizationOperationStatus };

async function startAttempt(tx: PlacementExecutor, deps: NativeDispatchDeps, key: NativeOperationKey,
    mode: 'once' | 'reconcile'): Promise<Started> {
    await lockOperation(tx, key.operationId);
    const row = await selectOperation(tx, key.operationId, 'update');
    if (!row || row.owner_user_id !== key.ownerUserId) return { kind: 'blocked', reason: 'not_found' };
    const status = statusOf(row);
    const now = deps.now();
    const timeoutMs = deps.timeoutMs ?? NATIVE_AUTHORIZATION_TIMEOUT_MS;
    if (mode === 'once') {
        if (row.state !== 'prepared') return { kind: 'blocked', reason: 'not_dispatchable', status };
    } else if (row.state === 'dispatching') {
        if (now - (row.dispatched_at?.getTime() ?? now) < NATIVE_ABANDONED_DISPATCH_MS) return { kind: 'blocked', reason: 'dispatch_in_flight', status };
    } else if (row.state !== 'delivery_unknown') {
        return { kind: 'blocked', reason: 'not_dispatchable', status };
    }
    if (row.attempt >= NATIVE_AUTHORIZATION_MAX_ATTEMPTS) return { kind: 'blocked', reason: 'attempts_exhausted', status };
    const semantic = storedSemantic(row);
    if (!semantic) return { kind: 'blocked', reason: 'semantic_corrupt', status };
    // Lock order everywhere: operation, then the reader's own (computer) lock, then the authorization row.
    const consent = semantic.operation === 'renew' ? await readConsent(tx, deps, row.owner_user_id, row.consent_operation_id) : null;
    // A renewal locks the row exclusively, so two renewals of one authorization never pass the in-flight check together.
    const authorization = await selectAuthorization(tx, row.authorization_id, semantic.operation === 'renew' ? 'update' : 'share');
    if (!authorization || authorization.owner_user_id !== row.owner_user_id
        || authorization.binding_digest !== nativeCanonicalDigest(nativeSemanticBinding(semantic))) {
        return { kind: 'blocked', reason: 'semantic_corrupt', status };
    }
    if (semantic.operation === 'renew') {
        if (authorization.revoke_operation_id !== null) return { kind: 'blocked', reason: 'authorization_revoked', status };
        if (await hasUnresolvedRenewal(tx, row.authorization_id, row.operation_id)) return { kind: 'blocked', reason: 'unresolved_renewal', status };
        if (!consent) return { kind: 'blocked', reason: 'consent_unavailable', status };
        if (nativeCanonicalDigest(consent) !== authorization.binding_digest) return { kind: 'blocked', reason: 'consent_changed', status };
    } else if (authorization.revoke_operation_id !== row.operation_id) {
        return { kind: 'blocked', reason: 'semantic_corrupt', status };
    }
    // Time terms on a clock read AFTER every lock wait, then again after signing, immediately before the CAS.
    const signedAt = deps.now();
    const timeBlock = attemptTimeBlock(deps, semantic, signedAt, timeoutMs);
    if (timeBlock) return { kind: 'blocked', reason: timeBlock, status };
    // Signed before the attempt commits, so nothing after the commit can fail before the send but the send itself.
    const assertion = await signNativeAssertion(deps.config.signer, semantic,
        { issuer: deps.config.issuer, audience: deps.config.audience, nowMs: signedAt });
    const casAt = deps.now();
    // An assertion that could expire within the exchange timeout is discarded unsent; the operation stays as it was.
    if (casAt - signedAt > NATIVE_ASSERTION_CLOCK_SKEW_MS || Date.parse(assertion.expiresAt) - casAt <= timeoutMs) {
        return { kind: 'blocked', reason: 'assertion_stale', status };
    }
    const lateBlock = attemptTimeBlock(deps, semantic, casAt, timeoutMs);
    if (lateBlock) return { kind: 'blocked', reason: lateBlock, status };
    const attemptId = randomUUID();
    const [updated] = rowsOf(await tx.execute(sql`/* native-authorization:dispatch */ UPDATE public.ezil_native_authorization_operations
        SET state = 'dispatching', attempt = attempt + 1, attempt_id = ${attemptId}::uuid, dispatched_at = ${at(casAt)}::timestamptz,
            reason = NULL, updated_at = ${at(casAt)}::timestamptz
        WHERE operation_id = ${row.operation_id}::uuid AND state = ${row.state} AND attempt = ${row.attempt}
        RETURNING operation_id`));
    if (!updated) return { kind: 'blocked', reason: 'not_dispatchable', status };
    return { kind: 'started', semantic, attemptId, ...assertion };
}

/** The time terms of one attempt at `now`: a service credential and, for a renewal, deadline and lease that outlive the exchange. */
function attemptTimeBlock(deps: NativeDispatchDeps, semantic: NativeSemantic, now: number, timeoutMs: number): NativeDispatchBlock | null {
    if (deps.config.serviceExpiresAt.getTime() - now <= timeoutMs) return 'service_expired';
    if (semantic.operation !== 'renew') return null;
    if (now >= Date.parse(semantic.authorizationDeadline)) return 'deadline_passed';
    if (Date.parse(semantic.leaseExpiresAt) - now <= timeoutMs) return 'lease_ended';
    return null;
}

function settlement(outcome: NativeRenewOutcome | NativeRevokeOutcome) {
    switch (outcome.kind) {
    case 'granted':
        return sql`state = 'granted', grant_id = ${outcome.grantId}::uuid, grant_expires_at = ${outcome.expiresAt.toISOString()}::timestamptz,
            grant_replayed = ${outcome.replayed}`;
    case 'revoked':
        return sql`state = 'revoked', gateway_revoked_at = ${outcome.revokedAt.toISOString()}::timestamptz, already_revoked = ${outcome.alreadyRevoked}`;
    case 'refused':
        return sql`state = 'refused', refusal_status = ${outcome.status}, reason = 'gateway_refused'`;
    case 'unknown':
        return sql`state = 'delivery_unknown', reason = ${outcome.reason}`;
    }
}

async function runAttempt(db: NativeAuthorityDb, deps: NativeDispatchDeps, key: NativeOperationKey,
    mode: 'once' | 'reconcile'): Promise<NativeDispatchOutcome> {
    if (!isNativeUuid(key.ownerUserId) || !isNativeUuid(key.operationId)) return { kind: 'blocked', reason: 'request_invalid' };
    const started = await db.transaction(tx => startAttempt(tx, deps, key, mode));
    if (started.kind === 'blocked') return started;
    const exchange: NativeExchangeDeps = { fetchImpl: deps.fetchImpl, now: deps.now, timeoutMs: deps.timeoutMs };
    const assertion = { token: started.token, issuedAt: started.issuedAt, expiresAt: started.expiresAt };
    let outcome: NativeRenewOutcome | NativeRevokeOutcome;
    try {
        outcome = started.semantic.operation === 'renew'
            ? await postNativeRenewal(deps.config, started.semantic, assertion, exchange)
            : await postNativeRevoke(deps.config, started.semantic, assertion, exchange);
    } catch (error) {
        // Nothing was sent, but the attempt is committed: it stays `dispatching` until a reconciliation, never resent here.
        if (error instanceof NativeAuthorizationSendError) return { kind: 'blocked', reason: 'service_expired' };
        throw error;
    }
    return db.transaction(async tx => {
        await lockOperation(tx, key.operationId);
        const [row] = rowsOf(await tx.execute(sql`/* native-authorization:settle */ UPDATE public.ezil_native_authorization_operations
            SET ${settlement(outcome)}, updated_at = ${at(deps.now())}::timestamptz
            WHERE operation_id = ${key.operationId}::uuid AND state = 'dispatching' AND attempt_id = ${started.attemptId}::uuid
            RETURNING ${OPERATION_COLUMNS}`));
        return row ? { kind: 'settled', status: statusOf(toOperation(row)) } : { kind: 'superseded' };
    });
}

/** Sends a `prepared` operation exactly once. Any other state is returned untouched. */
export function dispatchNativeOperationOnce(db: NativeAuthorityDb, deps: NativeDispatchDeps,
    key: NativeOperationKey): Promise<NativeDispatchOutcome> {
    return runAttempt(db, deps, key, 'once');
}

/**
 * Explicit, bounded reconciliation of the SAME Gateway operation after an unknown outcome: one more POST of the
 * stored tuple under a fresh envelope. Only from `delivery_unknown` or an abandoned `dispatching`; only under the
 * still-approved consent, a live lease, an unrevoked authorization and a valid service credential; at most
 * `NATIVE_AUTHORIZATION_MAX_ATTEMPTS` attempts per operation. Revoke reconciliation needs no live consent.
 */
export function reconcileNativeOperation(db: NativeAuthorityDb, deps: NativeDispatchDeps,
    key: NativeOperationKey): Promise<NativeDispatchOutcome> {
    return runAttempt(db, deps, key, 'reconcile');
}

/* ------------------------------------------------------------------ read and open */

export async function readNativeAuthorizationOperation(db: NativeAuthorityDb,
    key: NativeOperationKey): Promise<NativeAuthorizationOperationStatus | null> {
    if (!isNativeUuid(key.ownerUserId) || !isNativeUuid(key.operationId)) return null;
    const [row] = rowsOf(await db.execute(sql`/* native-authorization:status */ SELECT ${OPERATION_COLUMNS}
        FROM public.ezil_native_authorization_operations WHERE operation_id = ${key.operationId}::uuid
        AND owner_user_id = ${key.ownerUserId}::uuid`));
    return row ? statusOf(toOperation(row)) : null;
}

/**
 * Opens a granted candidate for the closed private host transport. Refuses unless the renewal is granted, its
 * authorization was never revoked here, its consent is still the approved binding, at least
 * `NATIVE_GRANT_MIN_REMAINING_MS` of the grant remains, and the candidate authenticates under the pinned wrapping key
 * (a rotated key fails closed). Records nothing.
 */
export async function openNativeGrantCandidate(db: NativeAuthorityDb, deps: NativeOutboxDeps,
    key: NativeOperationKey): Promise<NativeOpenOutcome> {
    if (!isNativeUuid(key.ownerUserId) || !isNativeUuid(key.operationId)) return { kind: 'refused', reason: 'request_invalid' };
    return db.transaction(async (tx): Promise<NativeOpenOutcome> => {
        const row = await selectOperation(tx, key.operationId, 'share');
        if (!row || row.owner_user_id !== key.ownerUserId) return { kind: 'refused', reason: 'not_found' };
        if (row.kind !== 'renew' || row.state !== 'granted' || !row.grant_id || !row.grant_expires_at) return { kind: 'refused', reason: 'not_granted' };
        const semantic = storedSemantic(row);
        if (!semantic || semantic.operation !== 'renew') return { kind: 'refused', reason: 'candidate_invalid' };
        // Same lock order as dispatch: the reader's (computer) lock before the authorization row.
        const consent = await readConsent(tx, deps, row.owner_user_id, row.consent_operation_id);
        const authorization = await selectAuthorization(tx, row.authorization_id, 'share');
        if (!authorization || authorization.binding_digest !== nativeCanonicalDigest(nativeSemanticBinding(semantic))) {
            return { kind: 'refused', reason: 'candidate_invalid' };
        }
        if (authorization.revoke_operation_id !== null) return { kind: 'refused', reason: 'authorization_revoked' };
        if (!consent) return { kind: 'refused', reason: 'consent_unavailable' };
        if (nativeCanonicalDigest(consent) !== authorization.binding_digest) return { kind: 'refused', reason: 'consent_changed' };
        if (row.grant_expires_at.getTime() - deps.now() < NATIVE_GRANT_MIN_REMAINING_MS) return { kind: 'refused', reason: 'grant_expired' };
        if (row.candidate_key_id !== deps.config.wrapping.keyId) return { kind: 'refused', reason: 'wrapping_key_unavailable' };
        const token = row.candidate_version === null || !row.candidate_key_id || !row.candidate_nonce || !row.candidate_ciphertext
            ? null
            : await openNativeCandidate(deps.config.wrapping,
                { version: row.candidate_version, keyId: row.candidate_key_id, nonce: row.candidate_nonce, ciphertext: row.candidate_ciphertext },
                { ownerUserId: row.owner_user_id, operationId: row.operation_id, authorizationId: row.authorization_id,
                    semanticDigest: row.semantic_digest, tokenSha256: semantic.tokenSha256 });
        if (!token) return { kind: 'refused', reason: 'candidate_invalid' };
        // Fresh clock after decryption: the grant must still have its margin and the consent its deadline.
        const openedAt = deps.now();
        if (row.grant_expires_at.getTime() - openedAt < NATIVE_GRANT_MIN_REMAINING_MS
            || openedAt >= Date.parse(semantic.authorizationDeadline)) return { kind: 'refused', reason: 'grant_expired' };
        return {
            kind: 'opened',
            bearer: new NativeGrantBearer(token, row.operation_id, row.grant_id, row.grant_expires_at),
            tokenSha256: semantic.tokenSha256,
            sourceAuthorization: Object.freeze({
                authorizationId: semantic.authorizationId, epoch: semantic.epoch, authorizationDeadline: semantic.authorizationDeadline,
                clientId: semantic.clientId, profileId: semantic.profileId, policyId: semantic.policyId, budgetMicro: semantic.budgetMicro,
                initialApprovalAt: semantic.initialApprovalAt,
            }),
        };
    });
}
