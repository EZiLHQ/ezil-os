import { sql } from 'drizzle-orm';
import { LIMITS, parseBatch } from './schema';
import type { InferenceTrace } from './types';
export interface TraceDb { execute(query: ReturnType<typeof sql>): Promise<unknown> }
export const rowsOf = (result: unknown): Record<string, unknown>[] => Array.isArray(result) ? result : (result as { rows?: Record<string, unknown>[] })?.rows ?? [];

/** One atomic statement: serialize by account before reading the wall clock.
 * A delayed transaction cannot move a newer quota bucket backwards.
 * All values are parameterized. No billing/error tables or computer association. */
export async function ingestTraces(db: TraceDb, userId: string, traces: InferenceTrace[]) {
    const clean = parseBatch({ v: 1, traces });
    if (!clean || !/^[0-9a-f-]{36}$/i.test(userId)) return;
    await db.execute(sql`
        WITH guard AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(hashtextextended('ezil.ai-traces:' || ${userId}::text, 0))
        ), stamp AS MATERIALIZED (
            SELECT date_trunc('minute', clock_timestamp()) AS minute FROM guard
        ), budget AS (
            INSERT INTO ezil_ai_trace_limits (user_id, window_start, used)
            SELECT ${userId}::uuid, stamp.minute, ${clean.length} FROM stamp WHERE true
            ON CONFLICT (user_id) DO UPDATE SET
                window_start = excluded.window_start,
                used = CASE WHEN ezil_ai_trace_limits.window_start = excluded.window_start
                    THEN ezil_ai_trace_limits.used + excluded.used ELSE excluded.used END
            WHERE (ezil_ai_trace_limits.window_start < excluded.window_start AND excluded.used <= ${LIMITS.perMinute})
                OR (ezil_ai_trace_limits.window_start = excluded.window_start
                    AND ezil_ai_trace_limits.used + excluded.used <= ${LIMITS.perMinute})
            RETURNING user_id
        )
        INSERT INTO ezil_ai_request_traces
            (user_id, request_id, received_at, model_alias, outcome, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, duration_ms, read_heavy, metadata)
        SELECT budget.user_id, (r->>'requestId')::uuid, now(), r->>'modelAlias', r->>'outcome',
            (r->'usage'->>'inputTokens')::integer, (r->'usage'->>'outputTokens')::integer,
            (r->'usage'->>'cacheReadTokens')::integer, (r->'usage'->>'cacheWriteTokens')::integer,
            (r->>'durationMs')::integer, (r->>'readHeavyWithoutVerifiedEdit')::boolean, r
        FROM budget CROSS JOIN jsonb_array_elements(${JSON.stringify(clean)}::jsonb) AS r
        ON CONFLICT (user_id, request_id) DO NOTHING
    `);
}

export async function retainTraces(db: TraceDb) {
    const present = rowsOf(await db.execute(sql`SELECT to_regclass('ezil_ai_request_traces') IS NOT NULL AS present`));
    if (present[0]?.present !== true) return { skipped: true, deleted: 0, hitBudget: false };
    let deleted = 0;
    const started = Date.now();
    let hitBudget = true;
    for (let i = 0; i < LIMITS.purgeBatches && Date.now() - started < 5000; i++) {
        const result = rowsOf(await db.execute(sql`
            DELETE FROM ezil_ai_request_traces WHERE (user_id, request_id) IN (
                SELECT user_id, request_id FROM ezil_ai_request_traces
                WHERE received_at < now() - interval '7 days'
                ORDER BY received_at LIMIT ${LIMITS.purgeBatch}
            ) RETURNING request_id`));
        deleted += result.length;
        if (result.length < LIMITS.purgeBatch) { hitBudget = false; break; }
    }
    await db.execute(sql`DELETE FROM ezil_ai_trace_limits WHERE user_id IN (
        SELECT user_id FROM ezil_ai_trace_limits WHERE window_start < now() - interval '7 days'
        ORDER BY window_start LIMIT ${LIMITS.purgeBatch})`);
    return { skipped: false, deleted, hitBudget };
}
