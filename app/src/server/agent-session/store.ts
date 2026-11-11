/**
 * EZiL Chat sessions through the editor bridge (EZiL MCP CONTRACT.md v3.0), on
 * Postgres (app/drizzle/hardening/0023_agent_sessions.sql), so every app
 * instance sees one queue. The tables carry no defaults or constraints beyond
 * unique indexes (the production migration grammar), so this module supplies
 * every id, time and status and is the only writer.
 *
 * Two sides meet here:
 *  - the person (or the EZiL MCP acting for them) lists sessions and sends or
 *    cancels instructions: `listSessions`, `sendInstruction`, `cancelOperation`;
 *  - the editor in their computer syncs: `syncEditor`, reached only through the
 *    Worker-verified editor-bridge token (see `./sync-route.ts`).
 *
 * Delivery is at most once. Each handout is one conditional UPDATE that gives
 * the operation a fresh `attempt_id`; the editor's report names that attempt,
 * so a replayed or late report for an earlier attempt never matches. Work only
 * goes back to the queue on a definite "not sent" for the CURRENT attempt, from
 * the current owner at the current epoch. If the owner changes, its lease
 * lapses, the computer changes hands, or no report arrives in time, whatever it
 * held becomes `uncertain`, never redelivered and never reported finished. The
 * lease is judged by one wall-clock reading taken after the owner row is
 * locked. The epoch only orders editors; it is not a credential.
 */
import { createHash } from 'node:crypto';

import { sql, type SQL } from 'drizzle-orm';

import {
    applyControlReport, controlLifecycle, controlReassigned, handOutControls, storeCatalog,
    type CatalogReport, type ControlDelivery,
} from './control-sync';

export interface SqlExecutor {
    execute(query: SQL): Promise<ArrayLike<Record<string, unknown>>>;
}
export interface SessionDb extends SqlExecutor {
    transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** An undelivered instruction waits at most this long for an editor, then expires. */
export const QUEUE_TTL_MS = 10 * 60_000;
/** An editor that stops syncing for this long loses ownership; its in-flight work becomes uncertain. */
export const LEASE_MS = 30_000;
/** Handed out but never reported on within this time: uncertain. */
export const REPORT_TIMEOUT_MS = 2 * 60_000;
export const POLL_MS = 2_000;
export const OTHER_OWNER_POLL_MS = 10_000;
export const MAX_DELIVER = 4;
export const MAX_SESSIONS = 200;
export const MAX_REPORTS = 32;
export const MAX_SEND_BYTES = 16_384;
export const MAX_RESPONSE_CHARS = 16_000;
export const RETENTION_DAYS = 7;
const BACKOFF_STEP_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const PRUNE_EVERY_MS = 10 * 60_000;
let lastPrune = 0;

export const OP_STATUSES = ['accepted', 'queued', 'queued_disconnected', 'running', 'completed', 'finished_unverified', 'failed',
    'rejected', 'refused_allowance', 'expired', 'cancel_requested', 'cancelled', 'uncertain'] as const;
export type OpStatus = (typeof OP_STATUSES)[number];

/** Internal statuses this module writes. `delivered` is public `accepted`: with the editor, not yet confirmed. */
type Stored = 'queued' | 'delivered' | 'running' | 'cancel_requested' | 'completed' | 'finished_unverified' | 'failed'
    | 'rejected' | 'expired' | 'cancelled' | 'uncertain';
const HELD: readonly Stored[] = ['delivered', 'running', 'cancel_requested'];
const FINAL: readonly Stored[] = ['completed', 'finished_unverified', 'failed', 'rejected', 'expired', 'cancelled', 'uncertain'];

export interface Op {
    id: string;
    sessionId: string;
    kind: 'send' | 'cancel';
    status: OpStatus;
    idempotencyKey: string;
    updatedAt: string;
    /** A cancel's target send, so a caller can check the cancel is the one it asked for. */
    targetOperationId?: string;
    expiresAt?: string;
    mode?: string;
    selectedModelId?: string;
    selectedEffort?: string | null;
    reason?: string;
}

export interface SessionRow {
    id: string;
    computerId: string;
    title: string | null;
    status: 'idle' | 'running' | 'unknown';
    bridge: 'connected' | 'disconnected';
    open: boolean;
    updatedAt: string;
}

export interface SessionEvent {
    seq: number;
    at: string;
    kind: 'user' | 'assistant' | 'operation';
    operationId: string;
    text?: string;
    status?: OpStatus;
}

export class SessionStoreError extends Error {
    /** `reason` is a short code a caller may show (a definite refusal such as `effort_not_per_session`); never free text. */
    constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST', readonly reason?: string) {
        super(code);
    }
}

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ms = (n: number) => sql.raw(`interval '${Math.trunc(n)} milliseconds'`);

/**
 * What a reader sees. Work an editor holds is only as live as that editor's
 * lease at the epoch it was handed out at: otherwise its outcome is unknown.
 */
function publicStatus(row: Record<string, unknown>): OpStatus {
    const status = String(row.status) as Stored;
    const live = row.lease_live === true;
    const sameOwner = live && row.owner_epoch !== null && String(row.owner_epoch) === String(row.delivered_epoch);
    switch (status) {
        case 'queued':
            if (row.past_expiry === true) return 'expired';
            return live ? 'queued' : 'queued_disconnected';
        case 'delivered':
            return sameOwner ? 'accepted' : 'uncertain';
        case 'running':
        case 'cancel_requested':
            return sameOwner ? status : 'uncertain';
        default:
            return status;
    }
}

function opView(row: Record<string, unknown>): Op {
    const status = publicStatus(row);
    const op: Op = {
        id: String(row.id), sessionId: String(row.session_id), kind: row.kind as Op['kind'], status,
        idempotencyKey: String(row.idempotency_key), updatedAt: iso(row.updated_at),
    };
    if (row.kind === 'cancel' && row.target_id) op.targetOperationId = String(row.target_id);
    if (status === 'queued' || status === 'queued_disconnected' || status === 'accepted') op.expiresAt = iso(row.expires_at);
    if (typeof row.mode === 'string') op.mode = row.mode;
    if (typeof row.selected_model_id === 'string') op.selectedModelId = row.selected_model_id;
    if (typeof row.selected_effort === 'string') op.selectedEffort = row.selected_effort;
    if (typeof row.reason === 'string') op.reason = row.reason;
    return op;
}

/**
 * One operation of this person. `liveComputer` also requires the computer to
 * still exist and be theirs (reads); a write's own result is read in its
 * transaction without that join, so a deletion racing the commit cannot turn a
 * recorded write into NOT_FOUND.
 */
async function readOp(db: SqlExecutor, userId: string, operationId: string, liveComputer = true): Promise<Record<string, unknown> | null> {
    const rows = await db.execute(sql`/* agent-session:op */
        SELECT o.id, o.session_id, o.kind, o.status, o.idempotency_key, o.target_id, o.updated_at, o.expires_at,
            o.mode, o.selected_model_id, to_jsonb(o)->>'selected_effort' AS selected_effort, o.reason, o.delivered_epoch, (o.expires_at <= now()) AS past_expiry,
            (w.lease_until > now() AND w.user_id = o.user_id) IS TRUE AS lease_live, w.epoch AS owner_epoch
        FROM public.ezil_agent_operations o
        ${liveComputer ? sql`JOIN public.ezil_computers c ON c.id = o.computer_id AND c.deleted_at IS NULL AND c.user_id = o.user_id` : sql``}
        LEFT JOIN public.ezil_editor_bridge_owner w ON w.computer_id = o.computer_id
        WHERE o.id = ${operationId}::uuid AND o.user_id = ${userId}::uuid`);
    return rows.length === 1 ? rows[0]! : null;
}

async function appendEvent(db: SqlExecutor, sessionId: string, operationId: string, kind: SessionEvent['kind'],
    fields: { text?: string | null; status?: string | null } = {}): Promise<void> {
    await db.execute(sql`/* agent-session:event */
        WITH s AS (UPDATE public.ezil_agent_sessions SET next_seq = next_seq + 1 WHERE id = ${sessionId}::uuid RETURNING next_seq)
        INSERT INTO public.ezil_agent_events (session_id, seq, at, kind, operation_id, text, status)
        SELECT ${sessionId}::uuid, next_seq, clock_timestamp(), ${kind}, ${operationId}::uuid, ${fields.text ?? null}, ${fields.status ?? null} FROM s`);
}

/** The status as an event shows it: `delivered` is announced as `accepted`. */
const eventStatus = (status: Stored) => (status === 'delivered' ? 'accepted' : status);

// ── The person's side ────────────────────────────────────────────────────────

const SESSION_COLUMNS = sql`s.id, s.computer_id, s.title, s.status, s.open, s.seen_at,
    (w.lease_until > now() AND w.user_id = s.user_id) IS TRUE AS lease_live`;
/** A session is the person's only while its computer is live and still theirs. */
const SESSION_FROM = (userId: string) => sql`public.ezil_agent_sessions s
    JOIN public.ezil_computers c ON c.id = s.computer_id AND c.deleted_at IS NULL AND c.user_id = ${userId}::uuid
    LEFT JOIN public.ezil_editor_bridge_owner w ON w.computer_id = s.computer_id`;

export async function listSessions(db: SqlExecutor, userId: string, computerId?: string): Promise<SessionRow[]> {
    const rows = await db.execute(sql`/* agent-session:list */
        SELECT ${SESSION_COLUMNS} FROM ${SESSION_FROM(userId)}
        WHERE s.user_id = ${userId}::uuid AND s.present
          ${computerId ? sql`AND s.computer_id = ${computerId}::uuid` : sql``}
        ORDER BY s.seen_at DESC, s.id
        LIMIT ${MAX_SESSIONS}`);
    return Array.from(rows, sessionView);
}

export async function getSession(db: SqlExecutor, userId: string, sessionId: string): Promise<SessionRow> {
    const rows = await db.execute(sql`/* agent-session:get */
        SELECT ${SESSION_COLUMNS} FROM ${SESSION_FROM(userId)}
        WHERE s.id = ${sessionId}::uuid AND s.user_id = ${userId}::uuid AND s.present`);
    if (rows.length !== 1) throw new SessionStoreError('NOT_FOUND');
    return sessionView(rows[0]!);
}

function sessionView(row: Record<string, unknown>): SessionRow {
    const connected = row.lease_live === true;
    return {
        id: String(row.id), computerId: String(row.computer_id), title: typeof row.title === 'string' && row.title ? row.title : null,
        status: connected ? (row.status as SessionRow['status']) : 'unknown', bridge: connected ? 'connected' : 'disconnected',
        open: connected && row.open === true, updatedAt: iso(row.seen_at),
    };
}

export async function listEvents(db: SqlExecutor, userId: string, sessionId: string, after = 0, limit = 50):
    Promise<{ events: SessionEvent[]; next: number | null }> {
    await getSession(db, userId, sessionId);
    const rows = await db.execute(sql`/* agent-session:events */
        SELECT e.seq, e.at, e.kind, e.operation_id, e.text, e.status
        FROM public.ezil_agent_events e
        WHERE e.session_id = ${sessionId}::uuid AND e.seq > ${after}
        ORDER BY e.seq
        LIMIT ${limit + 1}`);
    const list = Array.from(rows).slice(0, limit).map((row): SessionEvent => {
        const event: SessionEvent = { seq: Number(row.seq), at: iso(row.at), kind: row.kind as SessionEvent['kind'], operationId: String(row.operation_id) };
        if (typeof row.text === 'string') event.text = row.text;
        if (typeof row.status === 'string') event.status = row.status as OpStatus;
        return event;
    });
    return { events: list, next: rows.length > limit ? list[list.length - 1]!.seq : null };
}

export async function getOperation(db: SqlExecutor, userId: string, operationId: string): Promise<Op> {
    const row = await readOp(db, userId, operationId);
    if (!row) throw new SessionStoreError('NOT_FOUND');
    return opView(row);
}

interface Caller { userId: string; clientId: string }

/**
 * The idempotency key belongs to the person, not the OAuth client: `(user,
 * procedure, key)` is unique, so a retry through another connection still
 * finds the original. Checked FIRST, so a retry returns the original even if
 * its session has since gone. Same key + other input: CONFLICT.
 */
async function replayOf(tx: SqlExecutor, caller: Caller, proc: string, key: string, inputDigest: string): Promise<string | null> {
    const existing = await tx.execute(sql`/* agent-session:replay */
        SELECT id, input_digest FROM public.ezil_agent_operations
        WHERE user_id = ${caller.userId}::uuid AND proc = ${proc} AND idempotency_key = ${key}::uuid`);
    if (existing.length === 0) return null;
    if (existing[0]!.input_digest !== inputDigest) throw new SessionStoreError('CONFLICT');
    return String(existing[0]!.id);
}

async function insertOnce(tx: SqlExecutor, caller: Caller, proc: string, key: string, inputDigest: string, insert: SQL): Promise<{ created: boolean; id: string }> {
    const inserted = await tx.execute(insert);
    if (inserted.length === 1) return { created: true, id: String(inserted[0]!.id) };
    // Lost a race with a concurrent request under the same key.
    const id = await replayOf(tx, caller, proc, key, inputDigest);
    if (!id) throw new SessionStoreError('CONFLICT');
    return { created: false, id };
}

async function result(tx: SqlExecutor, caller: Caller, id: string): Promise<Op> {
    const row = await readOp(tx, caller.userId, id, false);
    if (!row) throw new SessionStoreError('CONFLICT');
    return opView(row);
}

export async function sendInstruction(db: SessionDb, caller: Caller,
    input: { sessionId: string; text: string; idempotencyKey: string }): Promise<Op> {
    const bytes = Buffer.byteLength(input.text, 'utf8');
    if (bytes < 1 || bytes > MAX_SEND_BYTES || !input.text.trim()) throw new SessionStoreError('BAD_REQUEST');
    const inputDigest = digest({ sessionId: input.sessionId, text: input.text });
    return db.transaction(async (tx) => {
        const replay = await replayOf(tx, caller, 'agentSession.send', input.idempotencyKey, inputDigest);
        if (replay) return result(tx, caller, replay);
        const sessions = await tx.execute(sql`/* agent-session:send-target */
            SELECT s.id, s.computer_id FROM ${SESSION_FROM(caller.userId)}
            WHERE s.id = ${input.sessionId}::uuid AND s.user_id = ${caller.userId}::uuid AND s.present`);
        if (sessions.length !== 1) throw new SessionStoreError('NOT_FOUND');
        const computerId = String(sessions[0]!.computer_id);
        const created = await insertOnce(tx, caller, 'agentSession.send', input.idempotencyKey, inputDigest, sql`/* agent-session:send */
            INSERT INTO public.ezil_agent_operations
                (id, session_id, computer_id, user_id, client_id, proc, idempotency_key, input_digest, kind, text, status,
                 attempts, not_before, expires_at, created_at, updated_at)
            VALUES (gen_random_uuid(), ${input.sessionId}::uuid, ${computerId}::uuid, ${caller.userId}::uuid, ${caller.clientId}, 'agentSession.send',
                ${input.idempotencyKey}::uuid, ${inputDigest}, 'send', ${input.text}, 'queued',
                0, now(), now() + ${ms(QUEUE_TTL_MS)}, now(), now())
            ON CONFLICT (user_id, proc, idempotency_key) DO NOTHING
            RETURNING id`);
        if (created.created) await appendEvent(tx, input.sessionId, created.id, 'operation', { status: 'queued' });
        return result(tx, caller, created.id);
    });
}

/**
 * Cancel ONE send. Still queued: withdrawn here, never delivered (`completed`).
 * Already with the editor: a cancel operation is queued for that same owner,
 * which only stops the request if it can verify it is ours; the cancel then
 * follows its target (`settleCancels`). Finished: refused (`rejected`).
 */
export async function cancelOperation(db: SessionDb, caller: Caller,
    input: { operationId: string; idempotencyKey: string }): Promise<Op> {
    const inputDigest = digest({ operationId: input.operationId });
    return db.transaction(async (tx) => {
        const replay = await replayOf(tx, caller, 'agentSession.cancel', input.idempotencyKey, inputDigest);
        if (replay) return result(tx, caller, replay);
        const targets = await tx.execute(sql`/* agent-session:cancel-target */
            SELECT o.id, o.session_id, o.computer_id, o.status, (o.expires_at <= now()) AS past_expiry
            FROM public.ezil_agent_operations o
            JOIN public.ezil_computers c ON c.id = o.computer_id AND c.deleted_at IS NULL AND c.user_id = ${caller.userId}::uuid
            WHERE o.id = ${input.operationId}::uuid AND o.user_id = ${caller.userId}::uuid AND o.kind = 'send'
            FOR UPDATE OF o`);
        if (targets.length !== 1) throw new SessionStoreError('NOT_FOUND');
        const target = targets[0]!;
        const sessionId = String(target.session_id);
        const targetStatus = String(target.status) as Stored;
        let status: Stored;
        let reason: string | null = null;
        if (targetStatus === 'queued' && target.past_expiry !== true) status = 'completed';
        else if (HELD.includes(targetStatus)) status = 'queued';
        else { status = 'rejected'; reason = 'already_finished'; }
        const created = await insertOnce(tx, caller, 'agentSession.cancel', input.idempotencyKey, inputDigest, sql`/* agent-session:cancel */
            INSERT INTO public.ezil_agent_operations
                (id, session_id, computer_id, user_id, client_id, proc, idempotency_key, input_digest, kind, target_id, status, reason,
                 attempts, not_before, expires_at, created_at, updated_at)
            VALUES (gen_random_uuid(), ${sessionId}::uuid, ${String(target.computer_id)}::uuid, ${caller.userId}::uuid, ${caller.clientId},
                'agentSession.cancel', ${input.idempotencyKey}::uuid, ${inputDigest}, 'cancel', ${input.operationId}::uuid, ${status}, ${reason},
                0, now(), now() + ${ms(QUEUE_TTL_MS)}, now(), now())
            ON CONFLICT (user_id, proc, idempotency_key) DO NOTHING
            RETURNING id`);
        if (!created.created) return result(tx, caller, created.id);
        if (status === 'completed') {
            await tx.execute(sql`/* agent-session:withdraw */
                UPDATE public.ezil_agent_operations SET status = 'cancelled', reason = 'withdrawn', updated_at = now()
                WHERE id = ${input.operationId}::uuid`);
            await appendEvent(tx, sessionId, input.operationId, 'operation', { status: 'cancelled' });
        }
        await appendEvent(tx, sessionId, created.id, 'operation', { status });
        return result(tx, caller, created.id);
    });
}

// ── The editor's side ────────────────────────────────────────────────────────

/**
 * What the editor may report about the attempt it was handed. `not_delivered`
 * means it definitely did not send it (busy, not open, refused before
 * delivery); `expired` means the workbench refused it because its delivery
 * deadline had passed, so it was not sent either.
 */
export const EDITOR_REPORTS = ['not_delivered', 'expired', 'rejected', 'running', 'cancel_requested', 'completed', 'cancelled',
    'finished_unverified', 'failed', 'uncertain'] as const;
export type EditorReportStatus = (typeof EDITOR_REPORTS)[number];

/** Protocol 2 adds one report: a create or configure the editor carried out, with what the runtime read back. */
export const EDITOR_REPORTS_V2 = [...EDITOR_REPORTS, 'applied'] as const;

export interface EditorReport {
    operationId: string;
    attemptId: string;
    status: EditorReportStatus | 'applied';
    reason?: string;
    requestId?: string;
    mode?: string;
    selectedModelId?: string;
    selectedEffort?: string | null;
    responseText?: string;
    /** Protocol 2, `applied` only: the session, its runtime model after the change, and its request count. */
    sessionResource?: string;
    model?: string | null;
    effort?: string | null;
    requestCount?: number;
}

export interface EditorSession {
    resource: string;
    title: string;
    open: boolean;
    status: 'idle' | 'running' | 'unknown';
    /** Protocol 2: the model selected in this session's own input now (null when closed) and its request count. */
    model?: string | null;
    effort?: string | null;
    requests?: number | null;
}

export interface EditorSync {
    /** What the body spoke. Anything but 2 is protocol 1; 2 only counts while the controls flag is on (`SyncOptions`). */
    protocol?: 1 | 2 | 3;
    ownerId: string;
    /** The epoch this editor last received, or 0 before its first sync. Reports are only taken at the current epoch. */
    epoch: number;
    /** Strictly increasing per owner; a replayed or reordered sync is refused. */
    seq: number;
    sessions?: EditorSession[];
    reports?: EditorReport[];
    catalog?: CatalogReport;
}

export interface SyncOptions {
    /**
     * The controls (protocol 2) are on: migration 0025 is applied. Off, `syncEditor` runs exactly the protocol-1 statements:
     * no control row, column or pass is touched.
     */
    controls?: boolean;
    effort?: boolean;
}

export interface Delivery {
    operationId: string;
    attemptId: string;
    kind: 'send' | 'cancel';
    sessionResource: string;
    /** Time left to start this attempt; the workbench refuses it after that (as `expired`). */
    deliverWithinMs: number;
    text?: string;
    targetOperationId?: string;
    /** Protocol 2: OS created this session, so the editor may show its tab again before acting. Only ever true for such a session. */
    reveal?: true;
}

export type SyncResult =
    | { owner: 'self'; epoch: number; leaseMs: number; pollMs: number; deliver: (Delivery | ControlDelivery)[]; applied: number }
    | { owner: 'other'; pollMs: number }
    | { owner: 'replayed' }
    /** The computer is deleted or no longer this person's by the time the sync holds its lock: nothing was touched. */
    | { owner: 'gone' };

/** Allowed transitions for each report, by operation kind: from these internal statuses only. */
const SEND_FROM: Record<EditorReportStatus, readonly Stored[]> = {
    not_delivered: ['delivered'],
    expired: ['delivered'],
    rejected: ['delivered'],
    running: ['delivered'],
    cancel_requested: ['delivered', 'running'],
    completed: HELD,
    cancelled: HELD,
    finished_unverified: HELD,
    failed: HELD,
    uncertain: HELD,
};
/**
 * A cancel op is only ever `completed` when it withdrew its target before
 * delivery (`cancelOperation`). With the editor it can only be asked to stop
 * (`cancel_requested`) or refused; after that it follows its target.
 */
const CANCEL_FROM: Partial<Record<EditorReportStatus, readonly Stored[]>> = {
    not_delivered: ['delivered'],
    cancel_requested: ['delivered'],
    rejected: ['delivered'],
    uncertain: ['delivered', 'cancel_requested'],
};
const KNOWN_SENT: readonly Stored[] = ['running', 'cancel_requested', 'completed', 'cancelled', 'finished_unverified', 'failed'];

/** Once a send is final, a cancel waiting on it is final too: cancelled, uncertain, or rejected as already_finished. */
async function settleCancels(tx: SqlExecutor, targetId: string, targetStatus: Stored): Promise<void> {
    if (!FINAL.includes(targetStatus)) return;
    const status: Stored = targetStatus === 'cancelled' ? 'cancelled' : targetStatus === 'uncertain' ? 'uncertain' : 'rejected';
    const settled = await tx.execute(sql`/* agent-session:settle-cancels */
        UPDATE public.ezil_agent_operations
        SET status = ${status}, reason = ${status === 'rejected' ? 'already_finished' : null}, attempt_id = NULL, updated_at = clock_timestamp()
        WHERE target_id = ${targetId}::uuid AND kind = 'cancel' AND status IN ('queued', 'delivered', 'cancel_requested')
        RETURNING id, session_id`);
    for (const row of Array.from(settled)) await appendEvent(tx, String(row.session_id), String(row.id), 'operation', { status });
}

/** Events and cancel settlement for work just moved to a final status. */
async function finalize(tx: SqlExecutor, rows: ArrayLike<Record<string, unknown>>, status: Stored): Promise<void> {
    for (const row of Array.from(rows)) {
        await appendEvent(tx, String(row.session_id), String(row.id), 'operation', { status });
        if (row.kind === 'send') await settleCancels(tx, String(row.id), status);
    }
}

export async function syncEditor(db: SessionDb, computer: { id: string; userId: string }, body: EditorSync, options: SyncOptions = {}): Promise<SyncResult> {
    const controls = options.controls === true;
    // Protocol 2 counts only while the controls are on; otherwise a protocol-2 body is handled as protocol 1 (its extras ignored).
    const proto3 = controls && options.effort === true && body.protocol === 3;
    const proto2 = controls && (body.protocol === 2 || body.protocol === 3);
    const outcome = await db.transaction(async (tx): Promise<SyncResult> => {
        // The caller resolved `computer` BEFORE this transaction. Everything below (the lease, the reassigned passes, the handout
        // and every report) trusts `computer.userId`, so confirm it NOW and hold it: FOR SHARE conflicts with the row UPDATE of a
        // transfer or a deletion, which therefore waits for this sync and cannot slip in between the check and the handout.
        // The computer row is always locked before the owner row.
        const current = await tx.execute(sql`/* agent-session:computer-lock */
            SELECT 1 FROM public.ezil_computers
            WHERE id = ${computer.id}::uuid AND user_id = ${computer.userId}::uuid AND deleted_at IS NULL FOR SHARE`);
        if (current.length !== 1) return { owner: 'gone' };
        await tx.execute(sql`/* agent-session:owner-row */
            INSERT INTO public.ezil_editor_bridge_owner (computer_id, user_id, owner_id, epoch, last_seq, lease_until, updated_at)
            VALUES (${computer.id}::uuid, ${computer.userId}::uuid, '', 0, 0, '-infinity', clock_timestamp())
            ON CONFLICT (computer_id) DO NOTHING`);
        const locked = await tx.execute(sql`/* agent-session:owner-lock */
            SELECT owner_id, user_id::text AS user_id, epoch, last_seq FROM public.ezil_editor_bridge_owner
            WHERE computer_id = ${computer.id}::uuid FOR UPDATE`);
        const row = locked[0]!;
        // One wall-clock reading AFTER the lock is held: a sync that waited on the lock past the
        // lease's end must not renew it (transaction-start now() would predate the wait).
        const clock = await tx.execute(sql`/* agent-session:clock */
            SELECT c.t::text AS t, (w.lease_until > c.t) AS live
            FROM (SELECT clock_timestamp() AS t) c, public.ezil_editor_bridge_owner w WHERE w.computer_id = ${computer.id}::uuid`);
        const t = String(clock[0]!.t);
        const now = sql`${t}::timestamptz`;
        const live = clock[0]!.live === true;
        const reowned = String(row.user_id) !== computer.userId;
        const same = !reowned && live && row.owner_id === body.ownerId;
        if (!same && live && !reowned) return { owner: 'other', pollMs: OTHER_OWNER_POLL_MS };
        if (same && body.seq <= Number(row.last_seq)) return { owner: 'replayed' };
        const epoch = same ? Number(row.epoch) : Number(row.epoch) + 1;
        await tx.execute(sql`/* agent-session:owner-take */
            UPDATE public.ezil_editor_bridge_owner
            SET owner_id = ${body.ownerId}, user_id = ${computer.userId}::uuid, epoch = ${epoch}, last_seq = ${body.seq},
                lease_until = ${now} + ${ms(LEASE_MS)}, updated_at = ${now}
            WHERE computer_id = ${computer.id}::uuid`);
        if (controls) {
            // The protocol this owner syncs with; a new owner starts with no catalog (never the previous window's).
            await tx.execute(same
                ? sql`/* agent-session:owner-protocol */ UPDATE public.ezil_editor_bridge_owner SET protocol = ${proto3 ? 3 : proto2 ? 2 : 1} WHERE computer_id = ${computer.id}::uuid`
                : sql`/* agent-session:owner-protocol-reset */ UPDATE public.ezil_editor_bridge_owner SET protocol = ${proto3 ? 3 : proto2 ? 2 : 1}, catalog = NULL, catalog_at = NULL
                    WHERE computer_id = ${computer.id}::uuid`);
        }

        // The computer changed hands: nothing of the previous person's may reach this editor.
        if (reowned) {
            await tx.execute(sql`/* agent-session:reassigned-sessions */
                UPDATE public.ezil_agent_sessions SET present = false, open = false, status = 'unknown'
                WHERE computer_id = ${computer.id}::uuid AND user_id <> ${computer.userId}::uuid AND present`);
            const refused = await tx.execute(sql`/* agent-session:reassigned-queued */
                UPDATE public.ezil_agent_operations SET status = 'rejected', reason = 'computer_reassigned', attempt_id = NULL, updated_at = ${now}
                WHERE computer_id = ${computer.id}::uuid AND user_id <> ${computer.userId}::uuid AND status = 'queued'
                RETURNING id, session_id, kind`);
            await finalize(tx, refused, 'rejected');
            const lost = await tx.execute(sql`/* agent-session:reassigned-held */
                UPDATE public.ezil_agent_operations SET status = 'uncertain', reason = 'computer_reassigned', attempt_id = NULL, updated_at = ${now}
                WHERE computer_id = ${computer.id}::uuid AND user_id <> ${computer.userId}::uuid AND status IN ('delivered', 'running', 'cancel_requested')
                RETURNING id, session_id, kind`);
            await finalize(tx, lost, 'uncertain');
            if (controls) await controlReassigned(tx, computer, now);
        }

        // Whatever an earlier owner (or this one before its lease lapsed) still held has an unknown outcome.
        const orphaned = await tx.execute(sql`/* agent-session:orphan */
            UPDATE public.ezil_agent_operations SET status = 'uncertain', reason = 'owner_changed', attempt_id = NULL, updated_at = ${now}
            WHERE computer_id = ${computer.id}::uuid AND status IN ('delivered', 'running', 'cancel_requested')
              AND delivered_epoch IS DISTINCT FROM ${epoch}
            RETURNING id, session_id, kind`);
        await finalize(tx, orphaned, 'uncertain');
        // Handed out, never reported on: it may have run.
        const unreported = await tx.execute(sql`/* agent-session:no-report */
            UPDATE public.ezil_agent_operations SET status = 'uncertain', reason = 'no_report', attempt_id = NULL, updated_at = ${now}
            WHERE computer_id = ${computer.id}::uuid AND status = 'delivered' AND delivered_at <= ${now} - ${ms(REPORT_TIMEOUT_MS)}
            RETURNING id, session_id, kind`);
        await finalize(tx, unreported, 'uncertain');
        if (controls) await controlLifecycle(tx, computer, epoch, now);

        let applied = 0;
        if (same && body.epoch === epoch) {
            for (const rawReport of body.reports ?? []) {
                const { effort: _effort, selectedEffort: _selected, ...oldReport } = rawReport;
                const report = proto3 ? rawReport : oldReport;
                if (await applyReport(tx, computer, epoch, now, report)) applied += 1;
                else if (controls && await applyControlReport(tx, computer, epoch, now, report, proto3)) applied += 1;
            }
        }

        if (body.sessions) {
            const reported = JSON.stringify(body.sessions);
            // Never touches created_by_os / created_control_id: OS's own marking survives every later report.
            if (proto2) {
                await tx.execute(sql`/* agent-session:sessions-v2 */
                    INSERT INTO public.ezil_agent_sessions AS s (id, computer_id, user_id, resource, title, present, open, status, seen_at, next_seq,
                        model, model_at, request_count${proto3 ? sql`, effort` : sql``})
                    SELECT gen_random_uuid(), ${computer.id}::uuid, ${computer.userId}::uuid, x.resource, x.title, true, x.open, x.status, ${now}, 0,
                        CASE WHEN x.open THEN x.model END, ${now}, x.requests${proto3 ? sql`, CASE WHEN x.open THEN x.effort END` : sql``}
                    FROM jsonb_to_recordset(${reported}::jsonb) AS x(resource text, title text, open boolean, status text, model text, requests integer, effort text)
                    ON CONFLICT (computer_id, user_id, resource) DO UPDATE SET
                        title = EXCLUDED.title, open = EXCLUDED.open, status = EXCLUDED.status, seen_at = EXCLUDED.seen_at, present = true,
                        model = EXCLUDED.model, model_at = EXCLUDED.model_at, request_count = EXCLUDED.request_count${proto3 ? sql`, effort = EXCLUDED.effort` : sql``}`);
            } else {
                await tx.execute(sql`/* agent-session:sessions */
                    INSERT INTO public.ezil_agent_sessions AS s (id, computer_id, user_id, resource, title, present, open, status, seen_at, next_seq)
                    SELECT gen_random_uuid(), ${computer.id}::uuid, ${computer.userId}::uuid, x.resource, x.title, true, x.open, x.status, ${now}, 0
                    FROM jsonb_to_recordset(${reported}::jsonb) AS x(resource text, title text, open boolean, status text)
                    ON CONFLICT (computer_id, user_id, resource) DO UPDATE SET
                        title = EXCLUDED.title, open = EXCLUDED.open, status = EXCLUDED.status, seen_at = EXCLUDED.seen_at, present = true`);
            }
            await tx.execute(sql`/* agent-session:sessions-gone */
                UPDATE public.ezil_agent_sessions SET present = false, open = false, status = 'unknown'
                WHERE computer_id = ${computer.id}::uuid AND user_id = ${computer.userId}::uuid AND present
                  AND resource NOT IN (SELECT x.resource FROM jsonb_to_recordset(${reported}::jsonb) AS x(resource text))`);
        }

        // The editor's catalog, from the owner at its current epoch only (the first sync of a new owner never carries one).
        if (proto2 && same && body.epoch === epoch && body.catalog) await storeCatalog(tx, computer.id, now, !proto3 && body.catalog.status === 'available'
                ? { ...body.catalog, models: body.catalog.models.map(m => ({...m, efforts: [], defaultEffort: null})) } : body.catalog);

        const expired = await tx.execute(sql`/* agent-session:expire */
            UPDATE public.ezil_agent_operations SET status = 'expired', updated_at = ${now}
            WHERE computer_id = ${computer.id}::uuid AND status = 'queued' AND expires_at <= ${now}
            RETURNING id, session_id, kind`);
        await finalize(tx, expired, 'expired');

        // Controls first (protocol 2 bodies only): a create or configure is judged against the same owner and epoch as a send.
        const controlDeliveries = proto2 ? await handOutControls(tx, computer, epoch, now) : [];

        // Fair handout: at most one operation per session per sync (a cancel first), only work of the
        // computer's current owner in a session that is theirs and present, ready (not backed off) and
        // unexpired, and never a second send to a session while one is handed out and unreported.
        const handed = await tx.execute(sql`/* agent-session:handout */
            WITH eligible AS (
                SELECT DISTINCT ON (o.session_id) o.id, o.not_before, o.created_at
                FROM public.ezil_agent_operations o
                JOIN public.ezil_agent_sessions s ON s.id = o.session_id AND s.present
                    AND s.computer_id = ${computer.id}::uuid AND s.user_id = ${computer.userId}::uuid
                WHERE o.computer_id = ${computer.id}::uuid AND o.user_id = ${computer.userId}::uuid AND o.status = 'queued'
                  AND o.not_before <= ${now} AND o.expires_at > ${now}
                  AND (o.kind = 'cancel' OR NOT EXISTS (SELECT 1 FROM public.ezil_agent_operations b
                       WHERE b.session_id = o.session_id AND b.kind = 'send' AND b.status = 'delivered'))
                ORDER BY o.session_id, (o.kind = 'cancel') DESC, o.created_at, o.id
            ), picked AS (
                SELECT o.id FROM public.ezil_agent_operations o JOIN eligible e ON e.id = o.id
                ORDER BY e.not_before, e.created_at, o.id
                LIMIT ${MAX_DELIVER}
                FOR UPDATE OF o SKIP LOCKED
            )
            UPDATE public.ezil_agent_operations o
            SET status = 'delivered', delivered_epoch = ${epoch}, attempt_id = gen_random_uuid(), attempts = o.attempts + 1,
                delivered_at = ${now}, updated_at = ${now}
            FROM public.ezil_agent_sessions s
            WHERE s.id = o.session_id AND o.id IN (SELECT id FROM picked) AND o.status = 'queued'
            RETURNING o.id, o.kind, o.text, o.target_id, o.attempt_id, o.session_id, o.not_before, o.created_at, s.resource,
                ${proto2 ? sql`s.created_by_os IS TRUE` : sql`FALSE`} AS created_by_os,
                GREATEST(0, floor(extract(epoch FROM (o.expires_at - ${now})) * 1000))::bigint AS within_ms`);
        const rows = Array.from(handed)
            .sort((a, b) => iso(a.not_before).localeCompare(iso(b.not_before)) || iso(a.created_at).localeCompare(iso(b.created_at)));
        const deliver = rows.map((row): Delivery => ({
            operationId: String(row.id), attemptId: String(row.attempt_id), kind: row.kind as Delivery['kind'],
            sessionResource: String(row.resource), deliverWithinMs: Number(row.within_ms),
            ...(row.kind === 'send' ? { text: String(row.text) } : { targetOperationId: String(row.target_id) }),
            // Only for a session OS created, from the database; never for a person's own chat.
            ...(proto2 && row.kind === 'send' && row.created_by_os === true ? { reveal: true as const } : {}),
        }));
        for (const row of rows) await appendEvent(tx, String(row.session_id), String(row.id), 'operation', { status: 'accepted' });
        return { owner: 'self', epoch, leaseMs: LEASE_MS, pollMs: POLL_MS, deliver: [...controlDeliveries, ...deliver], applied };
    });
    if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        await pruneOperations(db).catch(() => {});
    }
    return outcome;
}

async function applyReport(tx: SqlExecutor, computer: { id: string; userId: string }, epoch: number, now: SQL, report: EditorReport): Promise<boolean> {
    // Only the attempt this owner holds right now, for work that is still the current person's.
    const rows = await tx.execute(sql`/* agent-session:report-target */
        SELECT o.id, o.kind, o.status, o.session_id, o.text, o.attempts FROM public.ezil_agent_operations o
        WHERE o.id = ${report.operationId}::uuid AND o.computer_id = ${computer.id}::uuid AND o.user_id = ${computer.userId}::uuid
          AND o.delivered_epoch = ${epoch} AND o.attempt_id = ${report.attemptId}::uuid
        FOR UPDATE`);
    if (rows.length !== 1) return false;
    const op = rows[0]!;
    const current = String(op.status) as Stored;
    // `applied` is a control answer: it never moves a send or a cancel.
    if (report.status === 'applied') return false;
    const from = (op.kind === 'send' ? SEND_FROM : CANCEL_FROM)[report.status];
    if (!from || !from.includes(current)) return false;
    const sessionId = String(op.session_id);
    const id = String(op.id);
    // A failed or rejected operation always says why (the MCP's wording points to it).
    const reason = report.reason ?? (report.status === 'failed' || report.status === 'rejected' ? 'unspecified' : null);
    if (report.status === 'not_delivered') {
        // Definitely not sent: back in line behind others, with a growing pause, under a NEW attempt next time.
        const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_STEP_MS * Math.max(1, Number(op.attempts)));
        await tx.execute(sql`/* agent-session:requeue */
            UPDATE public.ezil_agent_operations
            SET status = 'queued', delivered_epoch = NULL, attempt_id = NULL, delivered_at = NULL, reason = ${reason},
                not_before = ${now} + ${ms(backoff)}, updated_at = ${now}
            WHERE id = ${id}::uuid`);
        return true;
    }
    const status = report.status as Stored;
    const final = FINAL.includes(status);
    await tx.execute(sql`/* agent-session:report */
        UPDATE public.ezil_agent_operations SET status = ${status}, reason = ${reason}, updated_at = ${now},
            attempt_id = ${final ? null : report.attemptId}::uuid,
            request_id = COALESCE(${report.requestId ?? null}, request_id),
            mode = COALESCE(${report.mode ?? null}, mode),
            selected_model_id = COALESCE(${report.selectedModelId ?? null}, selected_model_id)
            ${report.selectedEffort !== undefined ? sql`, selected_effort = ${report.selectedEffort}` : sql``}
        WHERE id = ${id}::uuid`);
    if (op.kind === 'send' && current === 'delivered' && KNOWN_SENT.includes(status)) {
        await appendEvent(tx, sessionId, id, 'user', { text: String(op.text) });
    }
    await appendEvent(tx, sessionId, id, 'operation', { status: eventStatus(status) });
    if (op.kind === 'send' && ['completed', 'cancelled', 'finished_unverified', 'failed'].includes(status)) {
        // One assistant event per finished send, even when the response is empty or unknown.
        const text = report.responseText ?? '';
        await appendEvent(tx, sessionId, id, 'assistant', { text: text.length > MAX_RESPONSE_CHARS ? text.slice(-MAX_RESPONSE_CHARS) : text });
    }
    if (op.kind === 'send') await settleCancels(tx, id, status);
    return true;
}

/** Instructions, responses and their events are kept for RETENTION_DAYS, then deleted. */
export async function pruneOperations(db: SqlExecutor): Promise<void> {
    const cutoff = sql.raw(`interval '${RETENTION_DAYS} days'`);
    await db.execute(sql`/* agent-session:prune */
        WITH old AS (
            SELECT o.id FROM public.ezil_agent_operations o
            WHERE o.created_at < now() - ${cutoff}
              AND NOT EXISTS (SELECT 1 FROM public.ezil_agent_operations c WHERE c.target_id = o.id AND c.created_at >= now() - ${cutoff})
        ), gone AS (
            DELETE FROM public.ezil_agent_events e USING old WHERE e.operation_id = old.id RETURNING e.operation_id
        )
        DELETE FROM public.ezil_agent_operations o USING old WHERE o.id = old.id`);
}
