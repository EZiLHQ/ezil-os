/**
 * The editor-sync half of the MCP session controls (editor bridge protocols 2/3, docs/EDITOR-BRIDGE-PROTOCOL-3.md): the
 * passes `syncEditor` (./store.ts) runs INSIDE its transaction, after the computer row and the owner row are locked and
 * the current owner is confirmed, so a create or configure is judged against exactly the owner a send would be:
 *
 *  - `handOutControls`: queued creates and configures become `delivered` under a fresh `attempt_id` at the owner's epoch;
 *  - `applyControlReport`: only the attempt this owner holds right now, from `delivered`, once; the readback the editor
 *    sends is stored as what is effective. A request is never copied into `effective_*`;
 *  - `controlLifecycle`: work an earlier owner held, work never reported on, and work past its deadline each end
 *    `uncertain` / `expired` / `failed`, never redelivered;
 *  - `controlReassigned`: another person's rows on a computer that changed hands never reach the new owner's editor;
 *  - `storeCatalog`: the editor's latest catalog, stamped with OS's own clock.
 *
 * Controls use 0025 only while its flag is on. Protocol-3 effort persistence additionally requires 0026 and its separate gate.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { EditorReport, SqlExecutor } from './store';

/** A queued create waits at most this long for an editor to take it (the MCP then reads `accepted`, then `expired`). */
export const CREATE_TTL_MS = 60_000;
/**
 * A configure is never queued beyond this: the caller waits this long for the editor's answer, then it is final. The MCP
 * gives OS 10 s per call (`OS_TIMEOUT_MS`), so the worst case below (this + the grace + 1 s) stays under it; a longer wait
 * would make the MCP report `uncertain` for a change OS then stores as applied.
 */
export const CONFIGURE_WAIT_MS = 5_000;
/** Handed out but not answered by this long after its deadline: `uncertain`. */
export const CONFIGURE_REPORT_GRACE_MS = 2_000;
/** A create handed out and never reported on: `uncertain` (the same bound as a send). */
export const CONTROL_REPORT_TIMEOUT_MS = 2 * 60_000;
export const MAX_CONTROL_DELIVER = 2;
const BACKOFF_STEP_MS = 1_000;
const BACKOFF_MAX_MS = 10_000;

const ms = (n: number) => sql.raw(`interval '${Math.trunc(n)} milliseconds'`);

/** One catalog row as the editor reports it (protocol 2). `availability` is optional: only a row carrying it can be attested. */
export interface CatalogRow {
    id: string;
    label: string;
    engine: 'ezil-chat';
    efforts: string[];
    defaultEffort: string | null;
    configuredEffort: string | null;
    availability?: 'available';
}
export type CatalogReport =
    | { status: 'available'; models: CatalogRow[]; observedAt: number }
    | { status: 'unavailable'; reason: string; observedAt: number };

export interface ControlDelivery {
    operationId: string;
    attemptId: string;
    kind: 'create' | 'configure';
    deliverWithinMs: number;
    model?: string;
    effort?: string;
    /** `configure` only: the target session. */
    sessionResource?: string;
    /** `configure` only, and only for a session OS created (docs/EDITOR-BRIDGE-PROTOCOL-2.md, `reveal`). */
    reveal?: true;
}

/** The editor's latest catalog, with OS's own reading time (the editor's `observedAt` is never trusted for freshness). */
export async function storeCatalog(tx: SqlExecutor, computerId: string, now: SQL, catalog: CatalogReport): Promise<void> {
    const stored = catalog.status === 'available' ? { status: 'available', models: catalog.models } : { status: 'unavailable', reason: catalog.reason };
    await tx.execute(sql`/* control-sync:catalog */
        UPDATE public.ezil_editor_bridge_owner SET catalog = ${JSON.stringify(stored)}::jsonb, catalog_at = ${now}
        WHERE computer_id = ${computerId}::uuid`);
}

/** The computer changed hands: nothing of the previous person's may reach this editor, or stay waiting. */
export async function controlReassigned(tx: SqlExecutor, computer: { id: string; userId: string }, now: SQL): Promise<void> {
    await tx.execute(sql`/* control-sync:reassigned-queued */
        UPDATE public.ezil_control_operations SET status = 'rejected', reason = 'computer_reassigned', attempt_id = NULL, updated_at = ${now}
        WHERE computer_id = ${computer.id}::uuid AND user_id <> ${computer.userId}::uuid AND status = 'queued'`);
    await tx.execute(sql`/* control-sync:reassigned-held */
        UPDATE public.ezil_control_operations SET status = 'uncertain', reason = 'computer_reassigned', attempt_id = NULL, updated_at = ${now}
        WHERE computer_id = ${computer.id}::uuid AND user_id <> ${computer.userId}::uuid AND status = 'delivered'`);
}

/**
 * A queued row past its deadline is final. A create is `expired`; a configure was never to be held: `busy` when its session
 * has since started (or been given) work, otherwise `failed` / `deadline_passed`. Nothing was delivered, so nothing changed.
 */
export async function expireControls(tx: SqlExecutor, now: SQL, scope: SQL): Promise<number> {
    const busy = sql`(EXISTS (SELECT 1 FROM public.ezil_agent_operations o WHERE o.session_id = c.session_id
            AND o.status IN ('queued', 'delivered', 'running', 'cancel_requested'))
        OR EXISTS (SELECT 1 FROM public.ezil_agent_sessions s WHERE s.id = c.session_id AND s.status = 'running'))`;
    const rows = await tx.execute(sql`/* control-sync:expire */
        UPDATE public.ezil_control_operations c SET
            status = CASE WHEN c.kind = 'create' THEN 'expired' WHEN ${busy} THEN 'busy' ELSE 'failed' END,
            reason = CASE WHEN c.kind = 'configure' AND ${busy} THEN 'session_running' ELSE 'deadline_passed' END,
            attempt_id = NULL, updated_at = ${now}
        WHERE c.status = 'queued' AND c.expires_at IS NOT NULL AND c.expires_at <= ${now} AND ${scope}
        RETURNING c.id`);
    return rows.length;
}

/** A delivered configure the editor never answered, past its deadline plus the grace: unknown, never redelivered. */
export async function overdueConfigures(tx: SqlExecutor, now: SQL, scope: SQL): Promise<number> {
    const rows = await tx.execute(sql`/* control-sync:overdue-configure */
        UPDATE public.ezil_control_operations c SET status = 'uncertain', reason = 'no_report_in_time', attempt_id = NULL, updated_at = ${now}
        WHERE c.status = 'delivered' AND c.kind = 'configure' AND c.expires_at + ${ms(CONFIGURE_REPORT_GRACE_MS)} <= ${now} AND ${scope}
        RETURNING c.id`);
    return rows.length;
}

export async function controlLifecycle(tx: SqlExecutor, computer: { id: string }, epoch: number, now: SQL): Promise<void> {
    // Whatever an earlier owner (or this one before its lease lapsed) still held has an unknown outcome.
    await tx.execute(sql`/* control-sync:orphan */
        UPDATE public.ezil_control_operations SET status = 'uncertain', reason = 'owner_changed', attempt_id = NULL, updated_at = ${now}
        WHERE computer_id = ${computer.id}::uuid AND status = 'delivered' AND delivered_epoch IS DISTINCT FROM ${epoch}`);
    await tx.execute(sql`/* control-sync:no-report */
        UPDATE public.ezil_control_operations SET status = 'uncertain', reason = 'no_report', attempt_id = NULL, updated_at = ${now}
        WHERE computer_id = ${computer.id}::uuid AND status = 'delivered' AND kind = 'create'
          AND delivered_at <= ${now} - ${ms(CONTROL_REPORT_TIMEOUT_MS)}`);
    await overdueConfigures(tx, now, sql`c.computer_id = ${computer.id}::uuid`);
    await expireControls(tx, now, sql`c.computer_id = ${computer.id}::uuid`);
}

/**
 * Hand out up to MAX_CONTROL_DELIVER queued controls of the computer's CURRENT owner. A configure goes out only while its
 * session is open and idle in the editor's last report and has no send queued or with the editor (the editor re-checks and
 * answers `busy`; a configure is never held for it). Reveal comes from the database only: `created_by_os`.
 */
export async function handOutControls(tx: SqlExecutor, computer: { id: string; userId: string }, epoch: number, now: SQL): Promise<ControlDelivery[]> {
    const handed = await tx.execute(sql`/* control-sync:handout */
        WITH picked AS (
            SELECT c.id FROM public.ezil_control_operations c
            WHERE c.computer_id = ${computer.id}::uuid AND c.user_id = ${computer.userId}::uuid AND c.status = 'queued'
              AND c.not_before <= ${now} AND c.expires_at > ${now}
              AND (c.kind = 'create' OR (
                    EXISTS (SELECT 1 FROM public.ezil_agent_sessions s WHERE s.id = c.session_id AND s.computer_id = ${computer.id}::uuid
                        AND s.user_id = ${computer.userId}::uuid AND s.present
                        AND ((s.open AND s.status = 'idle') OR (s.created_by_os IS TRUE AND s.status IN ('idle', 'unknown'))))
                    AND NOT EXISTS (SELECT 1 FROM public.ezil_agent_operations o WHERE o.session_id = c.session_id
                        AND o.status IN ('queued', 'delivered', 'running', 'cancel_requested'))))
            ORDER BY c.created_at, c.id
            LIMIT ${MAX_CONTROL_DELIVER}
            FOR UPDATE OF c SKIP LOCKED
        )
        UPDATE public.ezil_control_operations c
        SET status = 'delivered', delivered_epoch = ${epoch}, attempt_id = gen_random_uuid(), attempts = COALESCE(c.attempts, 0) + 1,
            delivered_at = ${now}, updated_at = ${now}
        WHERE c.id IN (SELECT id FROM picked) AND c.status = 'queued'
        RETURNING c.id, c.kind, c.attempt_id, c.requested_model, c.requested_effort, c.created_at,
            GREATEST(0, floor(extract(epoch FROM (c.expires_at - ${now})) * 1000))::bigint AS within_ms,
            (SELECT s.resource FROM public.ezil_agent_sessions s WHERE s.id = c.session_id) AS resource,
            (SELECT s.created_by_os IS TRUE FROM public.ezil_agent_sessions s WHERE s.id = c.session_id) AS created_by_os`);
    return Array.from(handed)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
        .map((row): ControlDelivery => {
            const configure = row.kind === 'configure';
            return {
                operationId: String(row.id), attemptId: String(row.attempt_id), kind: configure ? 'configure' : 'create',
                deliverWithinMs: Number(row.within_ms),
                ...(typeof row.requested_model === 'string' ? { model: row.requested_model } : {}),
                ...(typeof row.requested_effort === 'string' ? { effort: row.requested_effort } : {}),
                ...(configure ? { sessionResource: String(row.resource) } : {}),
                ...(configure && row.created_by_os === true ? { reveal: true as const } : {}),
            };
        });
}

interface Outcome { status: string; reason: string | null }

const reasonOr = (report: EditorReport, fallback: string) => report.reason ?? fallback;

/** What a definite editor answer (anything but `applied`) means for each kind, onto the frozen statuses. Null: not a control answer. */
export function controlOutcome(kind: 'create' | 'configure', report: EditorReport): Outcome | 'requeue' | null {
    switch (report.status) {
        case 'not_delivered':
            if (kind === 'create') return 'requeue';
            if (report.reason === 'busy') return { status: 'busy', reason: 'session_running' };
            if (report.reason === 'not_open') return { status: 'rejected', reason: 'session_not_open' };
            if (report.reason === 'stale_owner' || report.reason === 'no_owner' || report.reason === 'disconnected') {
                return { status: 'disconnected', reason: report.reason };
            }
            return { status: 'failed', reason: reasonOr(report, 'not_delivered') };
        case 'rejected': return { status: 'rejected', reason: reasonOr(report, 'unspecified') };
        case 'expired': return kind === 'create' ? { status: 'expired', reason: 'deadline_passed' } : { status: 'failed', reason: 'deadline_passed' };
        case 'failed': return { status: 'failed', reason: reasonOr(report, 'unspecified') };
        case 'uncertain': return { status: 'uncertain', reason: reasonOr(report, 'unspecified') };
        default: return null;
    }
}

/** The fixed effort the editor sends for `model`, read from the catalog it reported (null: none, or the model is not in it). */
async function configuredEffort(tx: SqlExecutor, computerId: string, model: string | null): Promise<string | null> {
    if (model === null) return null;
    const rows = await tx.execute(sql`/* control-sync:effort */
        SELECT m->>'configuredEffort' AS effort
        FROM public.ezil_editor_bridge_owner w, jsonb_array_elements(CASE WHEN w.catalog->>'status' = 'available' THEN w.catalog->'models' ELSE '[]'::jsonb END) m
        WHERE w.computer_id = ${computerId}::uuid AND m->>'id' = ${model}
        LIMIT 1`);
    return rows.length === 1 && typeof rows[0]!.effort === 'string' ? String(rows[0]!.effort) : null;
}

/**
 * The editor's answer to ONE handed-out create or configure. Only the attempt this owner holds at this epoch, only from
 * `delivered`; a duplicate or late report finds the row no longer `delivered` and changes nothing.
 */
export async function applyControlReport(tx: SqlExecutor, computer: { id: string; userId: string }, epoch: number, now: SQL,
    report: EditorReport, proto3 = false): Promise<boolean> {
    const rows = await tx.execute(sql`/* control-sync:report-target */
        SELECT c.id, c.kind, c.status, c.session_id, c.requested_model, c.requested_effort, c.attempts, c.expires_at, (c.expires_at > ${now}) AS unexpired
        FROM public.ezil_control_operations c
        WHERE c.id = ${report.operationId}::uuid AND c.computer_id = ${computer.id}::uuid AND c.user_id = ${computer.userId}::uuid
          AND c.delivered_epoch = ${epoch} AND c.attempt_id = ${report.attemptId}::uuid
        FOR UPDATE`);
    if (rows.length !== 1 || rows[0]!.status !== 'delivered') return false;
    const op = rows[0]!;
    const id = String(op.id);
    const kind = op.kind === 'configure' ? 'configure' : 'create';

    if (report.status === 'applied') {
        const model = typeof report.model === 'string' ? report.model : null;
        const effort = proto3 ? report.effort ?? null : await configuredEffort(tx, computer.id, model);
        if ((typeof op.requested_model === 'string' && model !== op.requested_model)
            || (typeof op.requested_effort === 'string' && (!proto3 || effort !== op.requested_effort))) {
            await tx.execute(sql`UPDATE public.ezil_control_operations SET status='uncertain', reason='settings_readback_mismatch', attempt_id=NULL, updated_at=${now} WHERE id=${id}::uuid`);
            return true;
        }
        if (kind === 'create') {
            // A created session is OS's only if it is new to OS and the editor says it holds no request: anything else
            // may be the person's own chat, which `reveal` must never open.
            const tracked = typeof report.sessionResource === 'string' && report.sessionResource !== '' && report.requestCount === 0
                ? await tx.execute(sql`/* control-sync:created-session */
                    INSERT INTO public.ezil_agent_sessions AS s (id, computer_id, user_id, resource, title, present, open, status, seen_at, next_seq,
                        model, model_at, request_count, created_by_os, created_control_id${proto3 ? sql`, effort` : sql``})
                    VALUES (gen_random_uuid(), ${computer.id}::uuid, ${computer.userId}::uuid, ${report.sessionResource}, '', true, true, 'idle',
                        ${now}, 0, ${model}, ${now}, 0, true, ${id}::uuid${proto3 ? sql`, ${effort}` : sql``})
                    ON CONFLICT (computer_id, user_id, resource) DO NOTHING
                    RETURNING s.id`)
                : [];
            if (tracked.length !== 1) {
                await tx.execute(sql`/* control-sync:created-untracked */
                    UPDATE public.ezil_control_operations SET status = 'uncertain', reason = 'created_session_not_tracked', attempt_id = NULL,
                        updated_at = ${now} WHERE id = ${id}::uuid`);
                return true;
            }
            await tx.execute(sql`/* control-sync:created */
                UPDATE public.ezil_control_operations SET status = 'applied', session_id = ${String(tracked[0]!.id)}::uuid,
                    reason = ${report.reason ?? 'ephemeral_until_first_send'}, attempt_id = NULL,
                    effective_model = ${model}, effective_effort = ${effort}, effective_at = ${now}, updated_at = ${now}
                WHERE id = ${id}::uuid`);
            return true;
        }
        await tx.execute(sql`/* control-sync:session-model */
            UPDATE public.ezil_agent_sessions SET model = ${model}, model_at = ${now}${proto3 ? sql`, effort = ${effort}` : sql``}
            WHERE id = ${String(op.session_id)}::uuid AND computer_id = ${computer.id}::uuid AND user_id = ${computer.userId}::uuid`);
        await tx.execute(sql`/* control-sync:configured */
            UPDATE public.ezil_control_operations SET status = 'applied', reason = ${report.reason ?? null}, attempt_id = NULL,
                effective_model = ${model}, effective_effort = ${effort}, effective_at = ${now}, updated_at = ${now}
            WHERE id = ${id}::uuid`);
        return true;
    }

    const outcome = controlOutcome(kind, report);
    if (outcome === null) return false;
    if (outcome === 'requeue') {
        // Definitely not created (the fence refused it before the workbench was touched): again, under a NEW attempt, until it expires.
        const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_STEP_MS * Math.max(1, Number(op.attempts)));
        await tx.execute(sql`/* control-sync:requeue */
            UPDATE public.ezil_control_operations SET status = 'queued', delivered_epoch = NULL, attempt_id = NULL, delivered_at = NULL,
                reason = ${report.reason ?? null}, not_before = ${now} + ${ms(backoff)}, updated_at = ${now}
            WHERE id = ${id}::uuid`);
        return true;
    }
    await tx.execute(sql`/* control-sync:final */
        UPDATE public.ezil_control_operations SET status = ${outcome.status}, reason = ${outcome.reason}, attempt_id = NULL, updated_at = ${now}
        WHERE id = ${id}::uuid`);
    return true;
}
