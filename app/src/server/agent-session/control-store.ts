/**
 * EZiL MCP session controls on the OS side (proposals/session-controls.md of the EZiL MCP): the model catalog, a
 * session's runtime settings, session create and configure, and the durable control rows they leave
 * (app/drizzle/hardening/0024_control_operations.sql and 0025_editor_controls.sql; `computer.start` shares the rows:
 * ../computer-start/start.ts).
 *
 * They run over editor bridge protocol 2 (docs/EDITOR-BRIDGE-PROTOCOL-2.md). What each one does:
 *   - `models`: the editor's own offer, only while its lease is live, it syncs protocol 2 and its catalog is fresh, and
 *     only the rows the Gateway marked available for this account; otherwise `unavailable` with the exact reason and NO
 *     models. Never the admin registry, a static file, an empty list standing for "cannot tell", or an `accountScoped`
 *     claim without such a report (`attest`). `accountScoped` means an authenticated report from the current computer's
 *     editor, not an independent attestation by the Gateway or OS: the Gateway's own authorization at request time stays the
 *     execution authority.
 *   - `settings`: only what a connected editor reported for that session's own input, read within CATALOG_FRESH_MS.
 *   - `create` / `configure`: a durable row, handed to the editor by the next sync and answered by its report. `effective`
 *     is only ever what the editor read back after the change. Effort requires protocol 3 and fresh account/route capability. A configure is never held: busy, disconnected or
 *     an unanswered handout is final, and nothing but an `applied` report says it changed.
 *
 * Idempotency is per (person, OAuth client, procedure, key) for 7 days, checked FIRST so a retry returns the original row
 * whatever the session or editor has done since; the same key with other input is CONFLICT. Everything is owner-scoped:
 * another person's computer, session or row is NOT_FOUND, exactly like a missing one.
 */
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
    CONFIGURE_REPORT_GRACE_MS, CONFIGURE_WAIT_MS, CONTROL_REPORT_TIMEOUT_MS, CREATE_TTL_MS, expireControls, overdueConfigures,
} from './control-sync';
import { getSession, SessionStoreError, type SessionDb, type SqlExecutor } from './store';

export const CONTROL_RETENTION_DAYS = 7;
const PRUNE_EVERY_MS = 10 * 60_000;
let lastPrune = 0;

export const CREATE_STATUSES = ['accepted', 'applied', 'disconnected', 'rejected', 'failed', 'expired', 'uncertain'] as const;
export const CONFIGURE_STATUSES = ['applied', 'busy', 'disconnected', 'rejected', 'failed', 'uncertain'] as const;
export const START_STATUSES = ['starting', 'running', 'refused_allowance', 'failed'] as const;
export type CreateStatus = (typeof CREATE_STATUSES)[number];
export type ConfigureStatus = (typeof CONFIGURE_STATUSES)[number];
export type StartStatus = (typeof START_STATUSES)[number];
export type ControlKind = 'create' | 'configure';

export const PROCEDURE_OF = { create: 'agentSession.create', configure: 'agentSession.configure', start: 'computer.start' } as const;

/** Who is asking: the person and the OAuth client they act through ('' for their own signed-in session). */
export interface ControlCaller { userId: string; clientId: string }

export interface Selection { model: string | null; effort: string | null }

/** What the editor's runtime read back after the change. Never the request echoed back. */
export interface Effective { model: string | null; effort: string | null; observedAt: string; source: 'runtime' }

/** A durable control row as the MCP reads it (its `agentSession.create` / `.configure` / `.control` shape). */
export interface ControlRow {
    id: string;
    kind: ControlKind;
    status: CreateStatus | ConfigureStatus;
    sessionId: string | null;
    computerId: string;
    updatedAt: string;
    /** While `accepted`: when OS stops waiting for the editor. */
    expiresAt: string | null;
    reason: string | null;
    requested: Selection;
    /** Only for `applied`, and only what the editor reported. */
    effective: Effective | null;
}

export const NO_EDITOR_REASON = 'no_connected_editor';
export const CATALOG_UNAVAILABLE_REASON = 'catalog_unavailable';
/** A catalog or a session's model is read only within this long of OS receiving it (the MCP's freshness window is 60 s). */
export const CATALOG_FRESH_MS = 45_000;

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ms = (n: number) => sql.raw(`interval '${Math.trunc(n)} milliseconds'`);
const sleep = (n: number) => new Promise<void>((resolve) => setTimeout(resolve, n));

// ── Shared rows (also used by computer.start) ────────────────────────────────

export interface NewControl {
    proc: string;
    key: string;
    inputDigest: string;
    kind: 'create' | 'configure' | 'start';
    computerId: string;
    sessionId: string | null;
    status: string;
    reason: string | null;
    requested: Selection;
    /** Set for a row the editor will be handed (create/configure): how long it may wait for delivery. Only these use 0025's columns. */
    ttlMs?: number;
}

const COLUMNS = sql`id, kind, status, session_id, computer_id, updated_at, reason, requested_model, requested_effort`;

/** The row this person's client already recorded under this key, or null. Same key, other input: CONFLICT. */
export async function replayControl(tx: SqlExecutor, caller: ControlCaller, proc: string, key: string, inputDigest: string):
    Promise<Record<string, unknown> | null> {
    const rows = await tx.execute(sql`/* control:replay */
        SELECT ${COLUMNS}, input_digest FROM public.ezil_control_operations
        WHERE user_id = ${caller.userId}::uuid AND client_id = ${caller.clientId} AND proc = ${proc} AND idempotency_key = ${key}::uuid`);
    if (rows.length === 0) return null;
    if (rows[0]!.input_digest !== inputDigest) throw new SessionStoreError('CONFLICT');
    return rows[0]!;
}

/** Insert once. A concurrent request under the same key that won the race is returned instead (`created: false`). */
export async function insertControl(tx: SqlExecutor, caller: ControlCaller, row: NewControl):
    Promise<{ created: boolean; row: Record<string, unknown> }> {
    const delivery = row.ttlMs !== undefined;
    const inserted = await tx.execute(sql`/* control:insert */
        INSERT INTO public.ezil_control_operations
            (id, user_id, client_id, proc, idempotency_key, input_digest, kind, computer_id, session_id, status, reason,
             requested_model, requested_effort, created_at, updated_at${delivery ? sql`, expires_at, not_before, attempts` : sql``})
        VALUES (gen_random_uuid(), ${caller.userId}::uuid, ${caller.clientId}, ${row.proc}, ${row.key}::uuid, ${row.inputDigest}, ${row.kind},
            ${row.computerId}::uuid, ${row.sessionId}::uuid, ${row.status}, ${row.reason}, ${row.requested.model}, ${row.requested.effort},
            clock_timestamp(), clock_timestamp()${delivery ? sql`, clock_timestamp() + ${ms(row.ttlMs!)}, clock_timestamp(), 0` : sql``})
        ON CONFLICT (user_id, client_id, proc, idempotency_key) DO NOTHING
        RETURNING ${COLUMNS}`);
    if (inserted.length === 1) return { created: true, row: inserted[0]! };
    // Lost a race with a concurrent request under the same key: the other transaction has committed by now (ON CONFLICT waits
    // for it), and this statement's fresh snapshot sees its row.
    const existing = await replayControl(tx, caller, row.proc, row.key, row.inputDigest);
    if (!existing) throw new SessionStoreError('CONFLICT');
    return { created: false, row: existing };
}

/** Control rows (and nothing else) older than the retention window are deleted. */
export async function pruneControl(db: SqlExecutor): Promise<void> {
    await db.execute(sql`/* control:prune */
        DELETE FROM public.ezil_control_operations
        WHERE created_at < now() - ${sql.raw(`interval '${CONTROL_RETENTION_DAYS} days'`)}`);
}

/** At most once per PRUNE_EVERY_MS per process; a failed prune never fails a request. */
export async function pruneControlSometimes(db: SqlExecutor): Promise<void> {
    if (Date.now() - lastPrune <= PRUNE_EVERY_MS) return;
    lastPrune = Date.now();
    await pruneControl(db).catch(() => {});
}

/** One computer of this person, live. A false answer reads exactly like a missing one. `lock` holds it until the transaction ends. */
export async function ownsComputer(db: SqlExecutor, userId: string, computerId: string, lock = false): Promise<boolean> {
    const rows = await db.execute(sql`/* control:owns-computer */
        SELECT 1 FROM public.ezil_computers WHERE id = ${computerId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
        ${lock ? sql`FOR SHARE` : sql``}`);
    return rows.length === 1;
}

// ── A control row, as a reader sees it ───────────────────────────────────────

const READ = sql`SELECT c.id, c.kind, c.status, c.session_id, c.computer_id, c.updated_at, c.reason, c.requested_model, c.requested_effort,
        c.delivered_epoch, c.effective_model, c.effective_effort, c.effective_at,
        CASE WHEN c.status = 'delivered' THEN c.delivered_at + ${ms(CONTROL_REPORT_TIMEOUT_MS)} ELSE c.expires_at END AS held_until,
        (c.expires_at IS NOT NULL AND c.expires_at <= clock_timestamp()) AS past_expiry,
        (c.delivered_at IS NOT NULL AND c.delivered_at + ${ms(CONTROL_REPORT_TIMEOUT_MS)} <= clock_timestamp()) AS report_overdue,
        (c.expires_at IS NOT NULL AND c.expires_at + ${ms(CONFIGURE_REPORT_GRACE_MS)} <= clock_timestamp()) AS configure_overdue,
        (w.lease_until > clock_timestamp() AND w.user_id = c.user_id) IS TRUE AS lease_live, w.epoch AS owner_epoch
    FROM public.ezil_control_operations c LEFT JOIN public.ezil_editor_bridge_owner w ON w.computer_id = c.computer_id`;

interface Derived { status: string; reason: string | null; expiresAt: string | null; final: boolean }

/**
 * The status a reader sees, derived at read time as `publicStatus` (./store.ts) does for a send: work an editor holds is only
 * as live as its lease at the epoch it was handed out at, and a queued row past its deadline is over, whether or not any
 * sync has run since. A configure is never held, so while one is neither answered nor expired it reads `uncertain`
 * (`in_progress`) rather than a status the frozen set does not have.
 */
function derive(row: Record<string, unknown>): Derived {
    const stored = String(row.status);
    const reason = typeof row.reason === 'string' ? row.reason : null;
    const create = row.kind === 'create';
    if (stored === 'queued') {
        if (row.past_expiry === true) return { status: create ? 'expired' : 'failed', reason: 'deadline_passed', expiresAt: null, final: true };
        return create ? { status: 'accepted', reason, expiresAt: iso(row.held_until), final: false }
            : { status: 'uncertain', reason: 'in_progress', expiresAt: null, final: false };
    }
    if (stored === 'delivered') {
        const same = row.lease_live === true && row.owner_epoch !== null && String(row.owner_epoch) === String(row.delivered_epoch);
        if (!same) return { status: 'uncertain', reason: 'owner_changed', expiresAt: null, final: true };
        if (create) {
            return row.report_overdue === true ? { status: 'uncertain', reason: 'no_report', expiresAt: null, final: true }
                : { status: 'accepted', reason, expiresAt: iso(row.held_until), final: false };
        }
        return row.configure_overdue === true ? { status: 'uncertain', reason: 'no_report_in_time', expiresAt: null, final: true }
            : { status: 'uncertain', reason: 'in_progress', expiresAt: null, final: false };
    }
    return { status: stored, reason, expiresAt: null, final: true };
}

function controlView(row: Record<string, unknown>): { row: ControlRow; final: boolean; stored: string } {
    const derived = derive(row);
    const applied = derived.status === 'applied' && row.effective_at !== null && row.effective_at !== undefined;
    return {
        final: derived.final, stored: String(row.status),
        row: {
            id: String(row.id), kind: row.kind as ControlKind, status: derived.status as ControlRow['status'],
            sessionId: typeof row.session_id === 'string' ? row.session_id : null, computerId: String(row.computer_id),
            updatedAt: iso(row.updated_at), expiresAt: derived.expiresAt, reason: derived.reason,
            requested: {
                model: typeof row.requested_model === 'string' ? row.requested_model : null,
                effort: typeof row.requested_effort === 'string' ? row.requested_effort : null,
            },
            effective: applied ? {
                model: typeof row.effective_model === 'string' ? row.effective_model : null,
                effort: typeof row.effective_effort === 'string' ? row.effective_effort : null,
                observedAt: iso(row.effective_at), source: 'runtime',
            } : null,
        },
    };
}

async function readControl(db: SqlExecutor, id: string): Promise<{ row: ControlRow; final: boolean; stored: string }> {
    const rows = await db.execute(sql`/* control:read */ ${READ} WHERE c.id = ${id}::uuid`);
    // The row was just written by this request; losing it means it was pruned or deleted under us: an unconfirmed outcome.
    if (rows.length !== 1) throw new Error('control row vanished');
    return controlView(rows[0]!);
}

// ── What the editor reported (catalog, session models) ───────────────────────

interface BridgeInfo {
    live: boolean;
    protocol: number | null;
    catalog: { status: 'available'; models: CatalogEntry[] } | { status: 'unavailable'; reason: string } | null;
    catalogAt: string | null;
    catalogAgeMs: number | null;
    now: string;
}
interface CatalogEntry { efforts: string[]; defaultEffort: string | null; id: string; label: string; engine: string; configuredEffort: string | null; availability?: string }

async function bridgeInfo(db: SqlExecutor, userId: string, computerId: string): Promise<BridgeInfo> {
    const rows = await db.execute(sql`/* control:bridge */
        SELECT (w.lease_until > clock_timestamp() AND w.user_id = ${userId}::uuid) IS TRUE AS live, w.protocol, w.catalog, w.catalog_at,
            extract(epoch FROM (clock_timestamp() - w.catalog_at)) * 1000 AS catalog_age_ms, clock_timestamp() AS now
        FROM public.ezil_editor_bridge_owner w WHERE w.computer_id = ${computerId}::uuid`);
    if (rows.length !== 1) {
        const clock = await db.execute(sql`/* control:clock */ SELECT clock_timestamp() AS t`);
        return { live: false, protocol: null, catalog: null, catalogAt: null, catalogAgeMs: null, now: iso(clock[0]!.t) };
    }
    const row = rows[0]!;
    const catalog = typeof row.catalog === 'string' ? JSON.parse(row.catalog) : row.catalog;
    return {
        live: row.live === true, protocol: row.protocol === null || row.protocol === undefined ? null : Number(row.protocol),
        catalog: catalog && typeof catalog === 'object' ? catalog as BridgeInfo['catalog'] : null,
        catalogAt: row.catalog_at ? iso(row.catalog_at) : null, catalogAgeMs: row.catalog_age_ms === null ? null : Number(row.catalog_age_ms),
        now: iso(row.now),
    };
}

/** Control, line-separator and bidirectional-override characters (the MCP's own set): never part of an id, stripped from a label. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_ALL = new RegExp(`${UNSAFE.source}+`, 'g');

export interface CatalogModelOut { id: string; label: string; engine: string; efforts: string[]; defaultEffort: string | null; configuredEffort: string | null }

type Attestation = { ok: true; models: CatalogModelOut[]; observedAt: string } | { ok: false; reason: string };

/** Exactly why OS cannot attest an account-scoped list. These are the source gaps; none falls back to anything else. */
const GAP_NO_EDITOR = 'No editor is connected on this computer, so EZiL OS cannot list the models this account may use.';
const GAP_PROTOCOL = 'The editor on this computer does not report its models (it has not negotiated session controls), so EZiL OS cannot list them.';
const GAP_NO_CATALOG = 'The editor on this computer has not reported its models yet, so EZiL OS cannot list them.';
const GAP_STALE = 'The editor on this computer has not reported its models recently, so EZiL OS cannot list them.';
const GAP_NOT_ACCOUNT = 'The editor lists the models its picker offers, including ones configured for every account, and does not report which of them '
    + 'the EZiL Gateway allows this account to use, so EZiL OS cannot confirm an account-scoped list.';

/**
 * The only way a model list reaches a caller. A list is the models THIS account may use only when the editor, with the
 * computer's own AI token, reported the Gateway marking that row `available`: a configured row is listed whatever the
 * account, so it proves nothing. Everything else is `unavailable` with its reason and no models. The editor's own evidence
 * policy (a read that began at most 15 s before it emitted the catalog) and this 45 s receipt window are separate, and the
 * transit between them is bounded by neither (docs/MCP-SESSION-CONTROLS.md).
 */
function attest(info: BridgeInfo): Attestation {
    if (!info.live) return { ok: false, reason: GAP_NO_EDITOR };
    if ((info.protocol !== 2 && info.protocol !== 3)) return { ok: false, reason: GAP_PROTOCOL };
    if (!info.catalog || info.catalogAt === null) return { ok: false, reason: GAP_NO_CATALOG };
    if (info.catalogAgeMs === null || info.catalogAgeMs > CATALOG_FRESH_MS) return { ok: false, reason: GAP_STALE };
    if (info.catalog.status === 'unavailable') return { ok: false, reason: `The editor could not read its model list (${info.catalog.reason}), so EZiL OS cannot list the models this account may use.` };
    // Only rows the MCP can show whole: it refuses a whole catalog for one unsafe id, empty label or repeated id.
    const seen = new Set<string>();
    const rows = info.catalog.models.filter((m) => {
        if (m.availability !== 'available' || seen.has(m.id) || UNSAFE.test(m.id) || m.label.replace(UNSAFE_ALL, ' ').trim() === '') return false;
        seen.add(m.id);
        return true;
    });
    if (rows.length === 0) return { ok: false, reason: GAP_NOT_ACCOUNT };
    return {
        ok: true, observedAt: info.catalogAt,
        models: rows.map((m) => ({ id: m.id, label: m.label, engine: m.engine, efforts: info.protocol === 3 ? m.efforts : [], defaultEffort: info.protocol === 3 ? m.defaultEffort : null, configuredEffort: m.configuredEffort ?? null })),
    };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface ModelCatalog {
    computerId: string;
    catalog: 'available' | 'unavailable';
    reason?: string;
    observedAt: string;
    models: CatalogModelOut[];
    /** Present (true) only for an `available` list OS attests as this account's own. */
    accountScoped?: true;
}

export async function listModels(db: SqlExecutor, userId: string, computerId: string): Promise<ModelCatalog> {
    if (!await ownsComputer(db, userId, computerId)) throw new SessionStoreError('NOT_FOUND');
    const info = await bridgeInfo(db, userId, computerId);
    const attested = attest(info);
    // `observedAt` is OS's own reading time of the catalog (never the editor's clock); an unavailable answer is read now.
    return attested.ok
        ? { computerId, catalog: 'available', accountScoped: true, observedAt: attested.observedAt, models: attested.models }
        : { computerId, catalog: 'unavailable', observedAt: info.now, models: [], reason: attested.reason };
}

export interface SessionSettings {
    sessionId: string;
    computerId: string;
    status: 'idle' | 'running' | 'unknown';
    bridge: 'connected' | 'disconnected';
    /** Only what a connected editor reported for this session's own input, within CATALOG_FRESH_MS; otherwise null. */
    settings: { model: string | null; effort: string | null; effortSupported: boolean; observedAt: string; source: 'runtime' } | null;
}

export async function sessionSettings(db: SqlExecutor, userId: string, sessionId: string): Promise<SessionSettings> {
    const session = await getSession(db, userId, sessionId);
    const base = { sessionId: session.id, computerId: session.computerId, status: session.status, bridge: session.bridge };
    if (session.bridge !== 'connected' || !session.open) return { ...base, settings: null };
    const rows = await db.execute(sql`/* control:session-model */
        SELECT s.model, CASE WHEN (to_jsonb(s)->>'effort_observed_at')::timestamptz = s.model_at
            AND (to_jsonb(s)->>'effort_observed_at')::timestamptz >= s.seen_at
            THEN to_jsonb(s)->>'effort' END AS effort, s.model_at, extract(epoch FROM (clock_timestamp() - s.model_at)) * 1000 AS age_ms
        FROM public.ezil_agent_sessions s WHERE s.id = ${sessionId}::uuid AND s.user_id = ${userId}::uuid AND s.present`);
    const row = rows[0];
    if (!row || typeof row.model !== 'string' || row.model_at === null || row.age_ms === null || Number(row.age_ms) > CATALOG_FRESH_MS) {
        return { ...base, settings: null };
    }
    // Protocol 3 reads jointly observed session effort; protocol 2 keeps its legacy catalog-only readback.
    const info = await bridgeInfo(db, userId, session.computerId);
    const listed = (info.protocol === 2 || info.protocol === 3) && info.catalog?.status === 'available' && info.catalogAgeMs !== null && info.catalogAgeMs <= CATALOG_FRESH_MS
        ? info.catalog.models.find((m) => m.id === row.model) : undefined;
    return { ...base, settings: { model: row.model, effort: info.protocol === 3 ? (typeof row.effort === 'string' ? row.effort : null) : listed?.configuredEffort ?? null, effortSupported: info.live && info.protocol === 3 && listed?.availability === 'available' && !!listed?.efforts.length, observedAt: iso(row.model_at), source: 'runtime' } };
}

/** The stored outcome of an earlier create or configure by this person's client under this key (for the MCP's retry reconciliation). */
export async function getControl(db: SqlExecutor, caller: ControlCaller, input: { kind: ControlKind | 'start'; idempotencyKey: string }):
    Promise<{ found: false } | { found: true; row: ControlRow | import('@/server/computer-start/start').StartRow }> {
    const rows = await db.execute(sql`/* control:get */
        SELECT id FROM public.ezil_control_operations
        WHERE user_id = ${caller.userId}::uuid AND client_id = ${caller.clientId} AND proc = ${PROCEDURE_OF[input.kind]}
          AND idempotency_key = ${input.idempotencyKey}::uuid`);
    if (input.kind === 'start' && rows.length === 1) {
        const starts = await db.execute(sql`SELECT id, computer_id, status, updated_at, reason FROM public.ezil_control_operations WHERE id=${String(rows[0]!.id)}::uuid AND user_id=${caller.userId}::uuid AND client_id=${caller.clientId} AND proc='computer.start'`);
        const start = starts[0];
        return start ? { found:true, row:{id:String(start.id),computerId:String(start.computer_id),status:start.status as StartStatus,updatedAt:iso(start.updated_at),reason:typeof start.reason==='string'?start.reason:null} } : {found:false};
    }
    return rows.length === 1 ? { found: true, row: (await readControl(db, String(rows[0]!.id))).row } : { found: false };
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface CreateInput { computerId: string; model?: string; effort?: string; idempotencyKey: string }
export interface ConfigureInput { sessionId: string; model?: string; effort?: string; idempotencyKey: string }

/** How long a caller waits for the editor's answer. Tests shorten it; production uses the defaults. */
export interface ControlTiming { createWaitMs: number; configureWaitMs: number; pollMs: number }
export const CONTROL_TIMING: ControlTiming = { createWaitMs: 4_000, configureWaitMs: CONFIGURE_WAIT_MS, pollMs: 200 };


type Verdict = { queue: true } | { queue: false; status: string; reason: string };

/** The model must be one OS itself attests for this account, now: the editor re-validates, but OS never takes it on trust. */
function modelVerdict(info: BridgeInfo, model: string | null): Verdict | null {
    if (model === null) return null;
    const attested = attest(info);
    if (!attested.ok) return { queue: false, status: 'rejected', reason: CATALOG_UNAVAILABLE_REASON };
    return attested.models.some((m) => m.id === model) ? null : { queue: false, status: 'rejected', reason: 'model_not_offered' };
}

function effortVerdict(info: BridgeInfo, model: string | null, effort: string | null): Verdict | null {
    if (effort === null) return null;
    if (info.protocol !== 3) return { queue:false,status:'rejected',reason:'effort_not_per_session' };
    const available = attest(info);
    if (!available.ok || model === null || !available.models.find(m => m.id === model)?.efforts.includes(effort))
        return { queue:false,status:'rejected',reason:'effort_unavailable' };
    return null;
}

/**
 * Wait (bounded, outside any transaction) for the editor's answer to a row just written, resolving what time has settled.
 * A create may stay `accepted`: the caller reads it later. A configure never does: past its deadline it is `busy` / `failed`
 * if never delivered, and `uncertain` if delivered and unanswered.
 */
async function settle(db: SqlExecutor, id: string, kind: ControlKind, timing: ControlTiming): Promise<ControlRow> {
    const until = Date.now() + (kind === 'create' ? timing.createWaitMs : timing.configureWaitMs + CONFIGURE_REPORT_GRACE_MS + 1_000);
    let resweeps = 0;
    for (;;) {
        // Time settles a row between the sweep below and the read after it: the sweep then runs again, so what is stored
        // (a configure's `busy`, say) is what is returned, never only what time derives.
        const now = sql`clock_timestamp()`;
        await expireControls(db, now, sql`c.id = ${id}::uuid`);
        if (kind === 'configure') await overdueConfigures(db, now, sql`c.id = ${id}::uuid`);
        const { row, final, stored } = await readControl(db, id);
        if (final && stored === 'queued' && resweeps < 3) {
            resweeps += 1;
            continue;
        }
        if (final || Date.now() >= until) return row;
        await sleep(timing.pollMs);
    }
}

export async function createSession(db: SessionDb, caller: ControlCaller, input: CreateInput, timing: ControlTiming = CONTROL_TIMING): Promise<ControlRow> {
    const requested: Selection = { model: input.model ?? null, effort: input.effort ?? null };
    const inputDigest = digest({ computerId: input.computerId.toLowerCase(), ...requested });
    const id = await db.transaction(async (tx) => {
        const replay = await replayControl(tx, caller, PROCEDURE_OF.create, input.idempotencyKey, inputDigest);
        if (replay) return String(replay.id);
        // The computer stays this person's until this transaction ends (a transfer or deletion waits for it).
        if (!await ownsComputer(tx, caller.userId, input.computerId, true)) throw new SessionStoreError('NOT_FOUND');
        const info = await bridgeInfo(tx, caller.userId, input.computerId);
        let verdict: Verdict;
        if (!info.live) verdict = { queue: false, status: 'disconnected', reason: NO_EDITOR_REASON };
        else if ((info.protocol !== 2 && info.protocol !== 3)) verdict = { queue: false, status: 'rejected', reason: 'editor_controls_unsupported' };
        else verdict = modelVerdict(info, requested.model) ?? effortVerdict(info, requested.model, requested.effort) ?? { queue: true };
        return String((await insertControl(tx, caller, {
            proc: PROCEDURE_OF.create, key: input.idempotencyKey, inputDigest, kind: 'create', computerId: input.computerId, sessionId: null,
            status: verdict.queue ? 'queued' : verdict.status, reason: verdict.queue ? null : verdict.reason, requested,
            ...(verdict.queue ? { ttlMs: CREATE_TTL_MS } : {}),
        })).row.id);
    });
    await pruneControlSometimes(db);
    return settle(db, id, 'create', timing);
}

export async function configureSession(db: SessionDb, caller: ControlCaller, input: ConfigureInput, timing: ControlTiming = CONTROL_TIMING): Promise<ControlRow> {
    if (input.model === undefined && input.effort === undefined) throw new SessionStoreError('BAD_REQUEST', 'nothing_to_change');
    const requested: Selection = { model: input.model ?? null, effort: input.effort ?? null };
    const inputDigest = digest({ sessionId: input.sessionId.toLowerCase(), ...requested });
    const id = await db.transaction(async (tx) => {
        const replay = await replayControl(tx, caller, PROCEDURE_OF.configure, input.idempotencyKey, inputDigest);
        if (replay) return String(replay.id);
        const session = await getSession(tx, caller.userId, input.sessionId);
        if (!await ownsComputer(tx, caller.userId, session.computerId, true)) throw new SessionStoreError('NOT_FOUND');
        const holding = await tx.execute(sql`/* control:session-busy */
            SELECT 1 FROM public.ezil_agent_operations
            WHERE session_id = ${input.sessionId}::uuid AND user_id = ${caller.userId}::uuid
              AND status IN ('queued', 'delivered', 'running', 'cancel_requested')
            LIMIT 1`);
        const info = await bridgeInfo(tx, caller.userId, session.computerId);
        // A session OS created may be hidden by a later one (one chat pane per group); the editor shows it again for `reveal`.
        const own = (await tx.execute(sql`/* control:created-by-os */
            SELECT created_by_os IS TRUE AS own FROM public.ezil_agent_sessions WHERE id = ${session.id}::uuid`))[0]?.own === true;
        let verdict: Verdict;
        if (session.bridge !== 'connected') verdict = { queue: false, status: 'disconnected', reason: NO_EDITOR_REASON };
        else if ((info.protocol !== 2 && info.protocol !== 3)) verdict = { queue: false, status: 'rejected', reason: 'editor_controls_unsupported' };
        else if (session.status === 'running' || holding.length > 0) verdict = { queue: false, status: 'busy', reason: 'session_running' };
        else if (!session.open && !own) verdict = { queue: false, status: 'rejected', reason: 'session_not_open' };
        // Connected, but the editor has not shown this session idle: not provably safe to change (the editor re-checks and says busy).
        else if (session.status !== 'idle' && !(own && session.status === 'unknown')) verdict = { queue: false, status: 'rejected', reason: 'session_state_unknown' };
        else verdict = modelVerdict(info, requested.model) ?? effortVerdict(info, requested.model ?? (requested.effort !== null ? (await sessionSettings(tx, caller.userId, session.id)).settings?.model ?? null : null), requested.effort) ?? { queue: true };
        return String((await insertControl(tx, caller, {
            proc: PROCEDURE_OF.configure, key: input.idempotencyKey, inputDigest, kind: 'configure', computerId: session.computerId, sessionId: session.id,
            status: verdict.queue ? 'queued' : verdict.status, reason: verdict.queue ? null : verdict.reason, requested,
            ...(verdict.queue ? { ttlMs: timing.configureWaitMs } : {}),
        })).row.id);
    });
    await pruneControlSometimes(db);
    return settle(db, id, 'configure', timing);
}
