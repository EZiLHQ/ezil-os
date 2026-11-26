/**
 * `computer.start` for the EZiL MCP (proposals/session-controls.md): a normal start of one of the person's own
 * computers, with a durable idempotent row (app/drizzle/0036_editor_control_operations.sql).
 *
 * It is the open path (`cloudflareGuacamole.previewUrl`) without the open: it never changes plan, size or billing,
 * never stamps `last_opened_at`, never starts a reverse move, and never returns a desktop or preview URL (an AWS start still primes the pool relay exchange, as an open does).
 * The order is the point:
 *
 *   1. owner-scoped replay or insert of the row as `starting` (another person's computer is NOT_FOUND, and a
 *      retry under the same key returns this row and boots nothing);
 *   2. routing WITHOUT pinning a placement, then the billing/allowance gate. A refusal is recorded as
 *      `refused_allowance` and returns: nothing was pinned, synced, booted or metered (a moving computer likewise);
 *   3. only after the gate admits it: pin, boot (and meter, as every open does). The pin itself writes, so a pin that
 *      lands on another route than the admitted one (`route_changed`) is refused AFTER it was pinned, and before any boot.
 *
 * The heavy collaborators (routing, billing gate, providers, meter) are a `StartPort` so this order can be proven on
 * its own; `./port.ts` wires the real ones. A failure BEFORE the boot is recorded `failed` (nothing started). A throw
 * DURING the boot leaves an admitted row available for recovery. The existing minute sweep observes readiness
 * without waking the computer again. A retry with the same key always reads the same operation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';

import { sql } from 'drizzle-orm';
import { after } from 'next/server';

import {
    AWS_WAKE_DISPATCHED, CLOUDFLARE_WAKE_DISPATCHED, insertControl, ownsComputer, PROCEDURE_OF, pruneControlSometimes, replayControl, startControlView,
    type ControlCaller, type StartRow, type StartStatus,
} from '@/server/agent-session/control-store';
import { SessionStoreError, type SessionDb, type SqlExecutor } from '@/server/agent-session/store';
import { editorControlsEnabled } from '@/server/api/editor-delegation';

export interface StartRoute {
    kind: 'cloudflare' | 'aws-ec2';
    instanceType: string | null;
    /** The computer is held by a reverse move: an open starts it; a start must not. */
    moving: boolean;
}

export type BootOutcome = { state: 'running' } | { state: 'starting' } | { state: 'failed'; reason: string };
export type GateOutcome = { allowed: true } | { allowed: false; reason: string };

export interface StartPort {
    /** Routing. `pin: false` writes nothing (no placement is pinned); `pin: true` is the boot's own routing. */
    route(pin: boolean): Promise<StartRoute>;
    /** The billing/allowance gate for this route, exactly as an open applies it. */
    gate(route: StartRoute): Promise<GateOutcome>;
    /** Ensure the computer is running, and meter it when it is ready. Never returns a URL. */
    boot(route: StartRoute): Promise<BootOutcome>;
    /** Confirm the admitted route is still current; meter CF only, under the operation's observation claim. */
    recordReady?(): Promise<BootOutcome>;
}

export type { StartRow } from '@/server/agent-session/control-store';

const CODE = /^[a-z0-9_]{1,64}$/;
const codeOf = (value: string, fallback: string) => (CODE.test(value) ? value : fallback);

/** Only a row still `starting` can be finished; a final row is never overwritten. */
async function finish(db: SqlExecutor, id: string, status: StartStatus, reason: string | null): Promise<StartRow> {
    const rows = await db.execute(sql`/* start:finish */
        UPDATE public.ezil_control_operations SET status = ${status}, reason = ${reason}, updated_at = clock_timestamp()
        WHERE id = ${id}::uuid AND status = 'starting'
        RETURNING id, computer_id, status, updated_at, reason`);
    if (rows.length === 1) return startControlView(rows[0]!);
    return readStart(db, id);
}

async function readStart(db: SqlExecutor, id: string): Promise<StartRow> {
    const current = await db.execute(sql`/* start:read */
        SELECT id, computer_id, status, updated_at, reason FROM public.ezil_control_operations WHERE id = ${id}::uuid`);
    if (current.length !== 1) throw new Error('computer.start: control row no longer exists');
    return startControlView(current[0]!);
}

export async function startComputer(db: SessionDb, port: StartPort, caller: ControlCaller,
    input: { computerId: string; idempotencyKey: string }): Promise<StartRow> {
    const inputDigest = createHash('sha256').update(JSON.stringify({ computerId: input.computerId.toLowerCase() })).digest('hex');
    const recorded = await db.transaction(async (tx) => {
        const replay = await replayControl(tx, caller, PROCEDURE_OF.start, input.idempotencyKey, inputDigest);
        if (replay) return { created: false, row: replay };
        if (!await ownsComputer(tx, caller.userId, input.computerId)) throw new SessionStoreError('NOT_FOUND');
        return insertControl(tx, caller, {
            proc: PROCEDURE_OF.start, key: input.idempotencyKey, inputDigest, kind: 'start', computerId: input.computerId,
            sessionId: null, status: 'starting', reason: null, requested: { model: null, effort: null },
        });
    });
    await pruneControlSometimes(db);
    // A retry (or the loser of a race) shows the recorded row and starts nothing.
    if (!recorded.created) return startControlView(recorded.row);
    const id = String(recorded.row.id);

    let pinned: StartRoute;
    try {
        const route = await port.route(false);
        if (route.moving) return await finish(db, id, 'failed', 'computer_move_in_progress');
        const gate = await port.gate(route);
        if (!gate.allowed) return await finish(db, id, 'refused_allowance', codeOf(`billing_${gate.reason}`, 'billing_refused'));
        // Admitted: only now may a placement be pinned for this computer. Pinning reads again under the computer lock
        // and may land elsewhere (a demand hold or a committed migration); the gate admitted `route`, so booting
        // anything else would start a computer the allowance never rated.
        pinned = await port.route(true);
        if (pinned.kind !== route.kind || pinned.instanceType !== route.instanceType || pinned.moving) {
            return await finish(db, id, 'failed', 'route_changed');
        }
    } catch (error) {
        // Nothing was booted yet. Record it, and answer it as a value (the caller's retry would only repeat it).
        console.error('[computer.start] refused before boot', { computerId: input.computerId, error: error instanceof Error ? error.name : 'error' });
        return await finish(db, id, 'failed', 'start_error');
    }
    // Persist the admission BEFORE the single dispatch. A crash or ambiguous throw can only be observed,
    // never redispatched. Retain the rated route in the receipt so a later provider/size change cannot pass.
    const marker = pinned.kind === 'cloudflare' ? CLOUDFLARE_WAKE_DISPATCHED : AWS_WAKE_DISPATCHED + (pinned.instanceType ?? '');
    const admitted = await db.execute(sql`/* start:admit */
        UPDATE public.ezil_control_operations op SET reason = ${marker}, updated_at = clock_timestamp()
        WHERE op.id = ${id}::uuid AND op.status = 'starting' AND op.reason IS NULL
            AND EXISTS (SELECT 1 FROM public.ezil_computers c WHERE c.id = op.computer_id
                AND c.user_id = op.user_id AND c.deleted_at IS NULL)
        RETURNING id, computer_id, status, updated_at, reason`);
    if (admitted.length !== 1) return finish(db, id, 'failed', 'computer_unavailable');
    const accepted = startControlView(admitted[0]!);
    const completion = Promise.resolve().then(() => port.boot(pinned))
        // A rejected boot does not prove that dispatch failed. Keep its admission for bounded observation.
        .catch((): BootOutcome => ({ state: 'starting' }))
        .then(outcome => settleAdmittedStart(db, id, () =>
            outcome.state === 'running' && port.recordReady
                ? port.recordReady() : Promise.resolve(outcome)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const early = await Promise.race([
            completion,
            new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 2_000); }),
        ]);
        if (early) return early;
        // Track the same call, not a new boot. Recovery works after this process has gone away.
        const tracked = completion.catch(() => {});
        try { after(tracked); } catch { /* A direct tRPC caller has no Next request context. */ }
        return accepted;
    } finally {
        clearTimeout(timer);
    }
}

export type AdmittedStartComputer = {
    userId: string;
    computerId: string;
    /** Derived only from the durable admission, never from a caller's requested route. */
    admittedRoute: StartRoute;
};
type ObserveStart = (computer: AdmittedStartComputer) => Promise<BootOutcome>;

// A NULL legacy receipt proves no admission. It may expire, but must never reach a provider observer.
const observable = sql`(op.reason = ${CLOUDFLARE_WAKE_DISPATCHED} OR starts_with(op.reason, ${AWS_WAKE_DISPATCHED})
    OR (op.reason IS NULL AND op.created_at < clock_timestamp() - interval '5 minutes'))`;

/** A caller polling its own start can recover readiness without dispatching a second wake or adding a cron. */
export async function reconcileColdStart(db: SessionDb, caller: ControlCaller, key: string, observe: ObserveStart): Promise<void> {
    if (!editorControlsEnabled(process.env)) return;
    const rows = await db.execute(sql`/* start:caller-observation */
        SELECT op.id FROM public.ezil_control_operations op JOIN public.ezil_computers c
            ON c.id = op.computer_id AND c.user_id = op.user_id AND c.deleted_at IS NULL
        WHERE op.user_id = ${caller.userId}::uuid AND op.client_id = ${caller.clientId}
            AND op.idempotency_key = ${key}::uuid AND op.proc = ${PROCEDURE_OF.start} AND op.kind = 'start'
            AND op.status = 'starting' AND ${observable}
            AND (op.not_before IS NULL OR op.not_before <= clock_timestamp()) LIMIT 1`);
    if (rows.length === 1) await settleAdmittedStart(db, String(rows[0]!.id), observe);
}

/** Fence the ready-time observation with the control row's existing attempt fields. No connection is held
 * across a Worker or billing call. A replaced process relinquishes the claim when its bounded lease expires. */
async function settleAdmittedStart(db: SessionDb, id: string, observe: ObserveStart): Promise<StartRow> {
    const attempt = randomUUID();
    const rows = await db.execute(sql`/* start:claim-observation */
        UPDATE public.ezil_control_operations op SET attempt_id = ${attempt}::uuid, not_before = clock_timestamp() + interval '60 seconds'
        WHERE op.id = ${id}::uuid AND op.kind = 'start' AND op.status = 'starting' AND ${observable}
            AND (op.not_before IS NULL OR op.not_before <= clock_timestamp())
            AND EXISTS (SELECT 1 FROM public.ezil_computers c WHERE c.id = op.computer_id
                AND c.user_id = op.user_id AND c.deleted_at IS NULL)
        RETURNING user_id, computer_id, reason, created_at < clock_timestamp() - interval '5 minutes' AS past_deadline`);
    if (rows.length !== 1) return readStart(db, id);
    const row = rows[0]!;
    const marker = String(row.reason);
    const admittedRoute: StartRoute = marker === CLOUDFLARE_WAKE_DISPATCHED
        ? { kind: 'cloudflare', instanceType: null, moving: false }
        : { kind: 'aws-ec2', instanceType: marker.slice(AWS_WAKE_DISPATCHED.length) || null, moving: false };
    let outcome: BootOutcome;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        outcome = row.past_deadline ? { state: 'failed', reason: 'readiness_unconfirmed' }
            : await Promise.race([
                observe({ userId: String(row.user_id), computerId: String(row.computer_id), admittedRoute }),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('observation timeout')), 5_000); }),
            ]);
    } catch {
        // Leave the claim until its lease expires. A late answer cannot publish readiness, and a later poll
        // can retry status (never boot) or close the receipt at its original five-minute deadline.
        return readStart(db, id);
    } finally {
        clearTimeout(timer);
    }
    const reason = outcome.state === 'starting' ? marker
        : outcome.state === 'failed' ? codeOf(outcome.reason, 'start_failed') : null;
    const saved = await db.execute(sql`/* start:finish-observation */
        UPDATE public.ezil_control_operations op SET
            status = CASE WHEN created_at < clock_timestamp() - interval '5 minutes' THEN 'failed' ELSE ${outcome.state} END,
            reason = CASE WHEN created_at < clock_timestamp() - interval '5 minutes' THEN 'readiness_unconfirmed' ELSE ${reason} END,
            updated_at = clock_timestamp(),
            attempt_id = NULL, not_before = NULL
        WHERE op.id = ${id}::uuid AND op.status = 'starting' AND op.attempt_id = ${attempt}::uuid AND op.not_before > clock_timestamp()
            AND EXISTS (SELECT 1 FROM public.ezil_computers c WHERE c.id = op.computer_id AND c.user_id = op.user_id AND c.deleted_at IS NULL)
        RETURNING id, computer_id, status, updated_at, reason`);
    return saved.length === 1 ? startControlView(saved[0]!) : readStart(db, id);
}

/** Existing minute sweep: inspect explicit wake admissions and expire unconfirmed legacy receipts. Never re-dispatch a start, including after a crash. */
export async function reconcileColdStarts(db: SessionDb, observe: ObserveStart): Promise<void> {
    if (!editorControlsEnabled(process.env)) return;
    const due = await db.execute(sql`/* start:due */
        SELECT op.id FROM public.ezil_control_operations op JOIN public.ezil_computers c
            ON c.id = op.computer_id AND c.user_id = op.user_id AND c.deleted_at IS NULL
        WHERE op.proc = ${PROCEDURE_OF.start} AND op.kind = 'start' AND op.status = 'starting'
            AND ${observable} AND (op.not_before IS NULL OR op.not_before <= clock_timestamp())
            AND op.updated_at <= clock_timestamp() - interval '15 seconds'
        ORDER BY op.updated_at, op.id LIMIT 8`);
    await Promise.all(Array.from(due, async row => {
        try { await settleAdmittedStart(db, String(row.id), observe); }
        catch { console.warn('[computer.start] readiness observation unavailable', { operationId: row.id }); }
    }));
}
