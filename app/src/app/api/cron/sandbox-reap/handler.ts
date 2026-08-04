/**
 * The testable core of `POST /api/cron/sandbox-reap` — a BACKSTOP for the
 * container-billing bug (see the diagnosis: `boot.js`'s `warm()` on every
 * login, plus a 10s self-rescheduling flush alarm whose `containerFetch()`
 * auto-starts a stopped container, together defeat the container's own
 * `SLEEP_AFTER` timer, so a container a user has long since abandoned can
 * stay `running` — and billing — indefinitely).
 *
 * THE PRIMARY FIX IS ELSEWHERE: a Durable Object idle-stop that does a final
 * flush-then-stop the moment real inactivity is observed. This cron exists
 * ONLY to catch what that mechanism misses — a stuck container the DO alarm
 * never got a chance to stop (a bad deploy, a crashed alarm, a container that
 * predates the fix). When the primary mechanism is working, this finds
 * nothing to do: see `handleSandboxReap`'s doc comment below for why that is
 * true by construction, not by luck.
 *
 * FAIL CLOSED, same as `@/server/telemetry/maintenance-handler.ts`:
 *   1. No `CRON_SECRET` configured -> 404 (never runs unauthenticated).
 *   2. Wrong/missing bearer -> ALSO 404, not 401 — indistinguishable from
 *      "not yours to call" from the outside.
 * PLUS an operational kill switch (`reapCronDisabled`, same off/false/0/
 * disabled/no vocabulary as the Worker's own `focusDisabled` /
 * `restartDisabled` / `telemetryDrainDisabled`) — a same-vocabulary flag an
 * operator can flip without a deploy if this ever needs to be paused,
 * independent of whether `CRON_SECRET` is configured.
 *
 * Separated from `route.ts` for the same reason `maintenance-handler.ts` is
 * separated from its route: keeping `@/env` (throws on a missing DB URL) and
 * a live Postgres connection out of the import graph a unit test exercises.
 */
import { sql } from 'drizzle-orm';

export type SandboxReapKillSwitchFlag = string | undefined;

/**
 * Same non-secret kill-switch vocabulary as
 * `worker/src/sandbox-control.ts`'s `focusDisabled` / `restartDisabled` and
 * `worker/src/index.ts`'s `telemetryDrainDisabled` — off/false/0/disabled/no,
 * case-insensitive, trimmed. Unset (or any other value) means enabled.
 */
export function reapCronDisabled(flag: SandboxReapKillSwitchFlag): boolean {
    if (!flag) return false;
    return ['off', 'false', '0', 'disabled', 'no'].includes(flag.trim().toLowerCase());
}

/**
 * How long a computer's `last_opened_at` must be in the past before its
 * sandbox is even considered for this backstop. Deliberately MUCH larger
 * than either `SLEEP_AFTER` (`'5m'` post-fix) or `IDLE_STOP_MS` (10 min) —
 * this is not the precision instrument (the DO's own `lastActivityAt`-driven
 * idle-stop is), it is the "something has clearly gone wrong" tripwire. A
 * computer nobody has reopened in this long, whose sandbox the Worker STILL
 * reports as running, is not a legitimately long-lived session by any
 * reading of "no work, no activity from the user, it just cools down
 * automatically" — it is the exact bug this whole effort exists to contain.
 *
 * 24h also means this cron (which Vercel Hobby limits to once/day) always
 * gets at least one chance per calendar day at any given stuck container.
 */
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Upper bound on how many stale-computer rows one run will even look at. */
export const DEFAULT_MAX_CANDIDATES = 200;

/**
 * Upper bound on how many sandboxes one run will actually terminate. Same
 * value and same reasoning as `worker/scripts/reap-idle-sandboxes.mjs`'s
 * `DEFAULT_MAX_REAP_COUNT`: a backstop that can be tricked (by a bug
 * upstream of it, e.g. a `lastOpenedAt` write that stopped happening) into
 * mass-terminating is worse than no backstop. Remaining candidates are
 * reported as `skipped_cap`, never silently dropped.
 */
export const DEFAULT_MAX_REAP_PER_RUN = 25;

/** One `ezil_computers` row shaped just enough for this handler. */
export interface StaleComputerRow {
    id: string;
    userId: string;
    lastOpenedAt: Date | null;
}

/**
 * Same minimal shape as `@/server/telemetry/retention.ts`'s `RetentionDb` —
 * raw `execute(sql\`...\`)`, no relational-query-builder typing to fake in a
 * test. `route.ts` passes the real `db` straight through (it satisfies this
 * structurally); tests pass a plain `{ execute: vi.fn(...) }`, exactly like
 * `maintenance-handler.test.ts`'s `makeDb` helper.
 */
export interface SandboxReapDb {
    execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/** Same normalization `retention.ts` uses: `postgres.js` results are
 * array-like directly; some drivers/mocks wrap them in `{ rows }`. */
function rowsOf(result: unknown): unknown[] {
    if (Array.isArray(result)) return result;
    const withRows = result as { rows?: unknown[] };
    return withRows?.rows ?? [];
}

interface RawStaleComputerRow {
    id: string;
    user_id: string;
    last_opened_at: string | Date;
}

/**
 * Find live (non-soft-deleted) computers whose `lastOpenedAt` is older than
 * `staleBefore`, oldest first, capped at `limit`. A soft-deleted computer is
 * excluded on purpose: `computer.delete` already calls
 * `terminateComputerSandbox()` (`@/server/api/routers/computer.ts`) as part
 * of the delete flow, so a deleted-and-still-running sandbox is a different
 * failure (that call not being confirmed) than the one this backstop targets.
 */
export async function findStaleComputers(
    db: SandboxReapDb,
    staleBefore: Date,
    limit: number,
): Promise<StaleComputerRow[]> {
    const result = await db.execute(sql`
        SELECT id, user_id, last_opened_at
        FROM ezil_computers
        WHERE deleted_at IS NULL
          AND last_opened_at IS NOT NULL
          AND last_opened_at < ${staleBefore}
        ORDER BY last_opened_at ASC
        LIMIT ${limit}
    `);
    return rowsOf(result).map((row) => {
        const r = row as RawStaleComputerRow;
        const lastOpenedAt = r.last_opened_at instanceof Date ? r.last_opened_at : new Date(r.last_opened_at);
        return { id: r.id, userId: r.user_id, lastOpenedAt };
    });
}

export type SandboxReapOutcome =
    | 'terminated'
    | 'not_running'
    | 'check_failed'
    | 'terminate_failed'
    | 'skipped_cap';

export interface SandboxReapResultRow {
    computerId: string;
    sandboxName: string;
    outcome: SandboxReapOutcome;
    error?: string;
}

export interface SandboxReapResponseBody {
    ok: boolean;
    skipped?: boolean;
    reason?: string;
    candidates?: number;
    reaped?: number;
    results?: SandboxReapResultRow[];
    error?: string;
}

export interface SandboxReapDeps {
    cronSecret: string | undefined;
    db: SandboxReapDb;
    killSwitch: SandboxReapKillSwitchFlag;
    /** Current time; injectable for tests. Defaults to `new Date()`. */
    now?: () => Date;
    staleAfterMs?: number;
    maxCandidates?: number;
    maxReapPerRun?: number;
    /** Derive the sandbox name for a (userId, computerId) pair — MUST match
     * `deriveGuacamoleSandboxId`/`deriveSandboxId`. Injected rather than
     * imported directly so tests never need a real HMAC/Worker config. */
    deriveSandboxName(userId: string, computerId: string): string;
    /**
     * `GET /sandbox/:name/status` (never waking, never touching the
     * container — see `worker/src/index.ts`'s `handleStatus` doc comment).
     * Resolves to whether a desktop is CURRENTLY reported running.
     */
    checkRunning(sandboxName: string): Promise<boolean>;
    /**
     * The Worker's EXISTING `DELETE /sandbox/:name` — already flushes to R2
     * then destroys (`handleTerminate`). This handler invents no new
     * teardown path.
     */
    terminate(sandboxName: string): Promise<{ ok: boolean; terminated: boolean; outcome?: string; error?: string }>;
}

const NOT_FOUND = (): Response => new Response(null, { status: 404 });

/**
 * `handleSandboxReap` is harmless when the primary DO idle-stop is working:
 * that mechanism stops a container the moment real inactivity is observed,
 * long before `lastOpenedAt` could ever age past `staleAfterMs` (24h by
 * default). So `findStaleComputers` either returns nothing, or returns rows
 * whose sandbox `checkRunning` reports as already stopped — either way,
 * `terminate` is never called. Only a container the primary mechanism
 * genuinely failed to stop reaches the terminate call.
 */
export async function handleSandboxReap(req: Request, deps: SandboxReapDeps): Promise<Response> {
    if (!deps.cronSecret) return NOT_FOUND();
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${deps.cronSecret}`) return NOT_FOUND();

    if (reapCronDisabled(deps.killSwitch)) {
        const body: SandboxReapResponseBody = { ok: true, skipped: true, reason: 'kill_switch_disabled' };
        return Response.json(body);
    }

    const now = (deps.now ?? (() => new Date()))();
    const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const maxCandidates = deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    const maxReapPerRun = deps.maxReapPerRun ?? DEFAULT_MAX_REAP_PER_RUN;
    const staleBefore = new Date(now.getTime() - staleAfterMs);

    try {
        const candidates = await findStaleComputers(deps.db, staleBefore, maxCandidates);
        const results: SandboxReapResultRow[] = [];
        let reaped = 0;

        for (const candidate of candidates) {
            const sandboxName = deps.deriveSandboxName(candidate.userId, candidate.id);

            if (reaped >= maxReapPerRun) {
                results.push({ computerId: candidate.id, sandboxName, outcome: 'skipped_cap' });
                continue;
            }

            let running: boolean;
            try {
                running = await deps.checkRunning(sandboxName);
            } catch (err) {
                results.push({
                    computerId: candidate.id,
                    sandboxName,
                    outcome: 'check_failed',
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }

            if (!running) {
                results.push({ computerId: candidate.id, sandboxName, outcome: 'not_running' });
                continue;
            }

            const term = await deps.terminate(sandboxName);
            if (term.ok) {
                if (term.terminated) reaped++;
                results.push({
                    computerId: candidate.id,
                    sandboxName,
                    outcome: term.terminated ? 'terminated' : 'not_running',
                });
            } else {
                results.push({
                    computerId: candidate.id,
                    sandboxName,
                    outcome: 'terminate_failed',
                    error: term.error,
                });
            }
        }

        const body: SandboxReapResponseBody = {
            ok: true,
            candidates: candidates.length,
            reaped,
            results,
        };
        return Response.json(body);
    } catch (err) {
        console.error('[sandbox-reap] cron run failed', { m: String((err as Error)?.message ?? err) });
        const body: SandboxReapResponseBody = { ok: false, error: 'internal_error' };
        return Response.json(body, { status: 500 });
    }
}
