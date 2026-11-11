/**
 * `computer.start` for the EZiL MCP (proposals/session-controls.md): a normal start of one of the person's own
 * computers, with a durable idempotent row (app/drizzle/hardening/0024_control_operations.sql).
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
 * DURING the boot leaves the row `starting` and rethrows: whether it started is unknown, and a retry with the same
 * key shows that row instead of starting twice.
 */
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
    insertControl, ownsComputer, PROCEDURE_OF, pruneControlSometimes, replayControl, type ControlCaller, type StartStatus,
} from '@/server/agent-session/control-store';
import { SessionStoreError, type SessionDb } from '@/server/agent-session/store';

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
}

export interface StartRow {
    id: string;
    computerId: string;
    status: StartStatus;
    updatedAt: string;
    reason: string | null;
}

const CODE = /^[a-z0-9_]{1,64}$/;
const codeOf = (value: string, fallback: string) => (CODE.test(value) ? value : fallback);
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());

function view(row: Record<string, unknown>): StartRow {
    return {
        id: String(row.id), computerId: String(row.computer_id), status: row.status as StartStatus, updatedAt: iso(row.updated_at),
        reason: typeof row.reason === 'string' ? row.reason : null,
    };
}

/** Only a row still `starting` can be finished; a final row is never overwritten. */
async function finish(db: SessionDb, id: string, status: StartStatus, reason: string | null): Promise<StartRow> {
    const rows = await db.execute(sql`/* start:finish */
        UPDATE public.ezil_control_operations SET status = ${status}, reason = ${reason}, updated_at = clock_timestamp()
        WHERE id = ${id}::uuid AND status = 'starting'
        RETURNING id, computer_id, status, updated_at, reason`);
    if (rows.length === 1) return view(rows[0]!);
    const current = await db.execute(sql`/* start:read */
        SELECT id, computer_id, status, updated_at, reason FROM public.ezil_control_operations WHERE id = ${id}::uuid`);
    // The row vanished mid-start: whether it booted is unknown, which is an unconfirmed outcome (500), not a key conflict.
    if (current.length !== 1) throw new Error('computer.start: the control row vanished before it was finished');
    return view(current[0]!);
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
    if (!recorded.created) return view(recorded.row);
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
    const booted = await port.boot(pinned);
    if (booted.state === 'running') return finish(db, id, 'running', null);
    if (booted.state === 'starting') return finish(db, id, 'starting', null);
    return finish(db, id, 'failed', codeOf(booted.reason, 'start_failed'));
}
