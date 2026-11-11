/**
 * App-error coverage: a small, best-effort server context captured when a consented report is SUBMITTED.
 *
 * It describes the reporter's own compute state at submission time, NOT at the time of the error. A refusal
 * such as `user_has_aws_computer` depends on rows the client cannot see (another computer's unreleased migration
 * reservation, an open capacity demand), so the report would otherwise not explain itself.
 *
 * Bounds:
 *   - Only after consent (diagnostics present) and only for the computer `ingestFeedback` already verified as
 *     the reporter's own. Every query filters on the reporter as owner. Admission's usage-based ownership
 *     branch is deliberately not used, since it can reach another person's computer.
 *   - Closed enums and 0/1/2+ buckets only. Never `workspace_head`, host, instance, volume, region, URL or token
 *     values, and never another person's row.
 *   - One SQL statement inside a SAVEPOINT, under a server-side `statement_timeout`. A timeout (57014), a
 *     missing table or any other failure rolls back to the savepoint, records `outcome` and leaves the report
 *     to be stored. The timeout is restored before the report INSERT.
 *   - Stored under `diagnostics.serverContext`. The strict client schema cannot send that key, and every admin
 *     read splits it out (`admin-queries.ts`), so the client's previewed diagnostics stay exactly as posted.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { feedbackComputeContextQuery } from '@/server/lib/compute/placement';

/**
 * `placement.ts` `PLACEMENT_PROVIDERS`/`PLACEMENT_STATES`, as closed output enums. The query itself lives in
 * `placement.ts` (`feedbackComputeContextQuery`): only that module may name the placement tables (C-2).
 */
export const CONTEXT_PROVIDERS = ['cloudflare', 'aws-ec2'] as const;
export const CONTEXT_PLACEMENT_STATES = [
    'PROVISIONING', 'STOPPED', 'LEASED', 'STARTING', 'MOUNTING', 'RUNNING', 'DRAINING', 'STOPPING',
    'UNCONFIRMED', 'RECOVERING', 'RETIRING', 'RETIRED', 'PURGE_ELIGIBLE', 'WARMING', 'READY', 'CLAIMED',
] as const;
/** `0006_compute_migrations.sql` (Cloudflare to AWS). */
export const CONTEXT_MIGRATION_STATES = [
    'requested', 'fenced', 'exported', 'provisioning', 'restored', 'committed', 'failed_reopened', 'failed_needs_operator',
] as const;
/** `0012_compute_reverse_moves.sql` (AWS to Cloudflare). */
export const CONTEXT_REVERSE_STATES = [
    'requested', 'booting', 'exporting', 'copying', 'checking', 'flipping', 'committed', 'failed_reopened', 'failed_needs_operator',
] as const;
export const CONTEXT_BUCKETS = ['0', '1', '2+'] as const;
export const CONTEXT_OUTCOMES = ['captured', 'unavailable', 'timeout'] as const;

/** One statement's whole budget. The reporter's advisory lock is held meanwhile, so it stays small. */
export const SERVER_CONTEXT_TIMEOUT_MS = 800;

type Bucket = typeof CONTEXT_BUCKETS[number];
export interface FeedbackServerContext {
    capturedAt: string;
    outcome: typeof CONTEXT_OUTCOMES[number];
    selected?: {
        provider: typeof CONTEXT_PROVIDERS[number] | 'none' | 'other';
        state: typeof CONTEXT_PLACEMENT_STATES[number] | 'none' | 'other';
        migration: { direction: 'cf_to_aws'; state: typeof CONTEXT_MIGRATION_STATES[number] | 'other'; unreleasedReservation: boolean } | null;
        /** Absent where the deployment has no reverse-move table (production skips 0012). */
        reverseMove?: { direction: 'aws_to_cf'; state: typeof CONTEXT_REVERSE_STATES[number] | 'other' } | null;
    };
    otherComputers?: { awsPlacements: Bucket; unreleasedReservations: Bucket; activeDemands: Bucket };
}

const stateOf = <T extends readonly [string, ...string[]]>(values: T) => z.enum([...values, 'other']);
/** Admin rendering parses with this; anything else is shown as unreadable, never echoed. */
export const serverContextSchema = z.object({
    capturedAt: z.string().datetime(),
    outcome: z.enum(CONTEXT_OUTCOMES),
    selected: z.object({
        provider: z.enum([...CONTEXT_PROVIDERS, 'none', 'other']),
        state: z.enum([...CONTEXT_PLACEMENT_STATES, 'none', 'other']),
        migration: z.object({ direction: z.literal('cf_to_aws'), state: stateOf(CONTEXT_MIGRATION_STATES), unreleasedReservation: z.boolean() }).strict().nullable(),
        reverseMove: z.object({ direction: z.literal('aws_to_cf'), state: stateOf(CONTEXT_REVERSE_STATES) }).strict().nullable().optional(),
    }).strict().optional(),
    otherComputers: z.object({
        awsPlacements: z.enum(CONTEXT_BUCKETS), unreleasedReservations: z.enum(CONTEXT_BUCKETS), activeDemands: z.enum(CONTEXT_BUCKETS),
    }).strict().optional(),
}).strict();

interface ContextTx {
    execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
    transaction: <T>(run: (tx: ContextTx) => Promise<T>) => Promise<T>;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
    return (Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows ?? []) as Record<string, unknown>[];
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | 'other' =>
    typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : 'other';

function bucket(value: unknown): Bucket {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) return '0';
    return n === 1 ? '1' : '2+';
}

function shape(row: Record<string, unknown> | undefined, capturedAt: string, reverseTable: boolean): FeedbackServerContext {
    if (!row) return { capturedAt, outcome: 'unavailable' };
    const placement = row.placement as { provider?: unknown; state?: unknown } | null;
    const migration = row.migration as { state?: unknown; unreleased?: unknown } | null;
    const reverse = row.reverse as { state?: unknown } | null;
    return {
        capturedAt, outcome: 'captured',
        selected: {
            provider: placement ? oneOf(CONTEXT_PROVIDERS, placement.provider) : 'none',
            state: placement ? oneOf(CONTEXT_PLACEMENT_STATES, placement.state) : 'none',
            migration: migration ? { direction: 'cf_to_aws', state: oneOf(CONTEXT_MIGRATION_STATES, migration.state),
                unreleasedReservation: migration.unreleased === true } : null,
            // Omitted, not null, where the deployment has no reverse-move table: "none" would be a claim.
            ...(reverseTable ? { reverseMove: reverse ? { direction: 'aws_to_cf' as const, state: oneOf(CONTEXT_REVERSE_STATES, reverse.state) } : null } : {}),
        },
        otherComputers: {
            awsPlacements: bucket(row.other_aws), unreleasedReservations: bucket(row.other_reservations), activeDemands: bucket(row.other_demands),
        },
    };
}

/**
 * Never throws. `tx` is the report's own transaction. The lookup runs in a nested savepoint, so its failure
 * cannot abort the INSERT that follows.
 */
export async function captureServerContext(
    tx: ContextTx, input: { userId: string; computerId: string; now: Date }, timeoutMs = SERVER_CONTEXT_TIMEOUT_MS,
): Promise<FeedbackServerContext> {
    const capturedAt = input.now.toISOString();
    try {
        return await tx.transaction(async (sp) => {
            // The reverse-move table (0012) is optional: production deliberately does not have it. Its absence leaves
            // that one field out, rather than failing the whole lookup on 42P01.
            const [previous] = rowsOf(await sp.execute(sql`SELECT current_setting('statement_timeout') AS t,
                to_regclass('ezil_compute_reverse_moves') IS NOT NULL AS reverse_table`));
            const reverseTable = previous?.reverse_table === true;
            await sp.execute(sql`SELECT set_config('statement_timeout', ${`${Math.max(1, Math.round(timeoutMs))}ms`}, true)`);
            const [row] = rowsOf(await sp.execute(feedbackComputeContextQuery(input.userId, input.computerId, reverseTable)));
            // A released savepoint keeps SET LOCAL until the outer COMMIT; the report INSERT must not inherit it.
            await sp.execute(sql`SELECT set_config('statement_timeout', ${String(previous?.t ?? '0')}, true)`);
            return shape(row, capturedAt, reverseTable);
        });
    } catch (error) {
        // Rolled back to the savepoint, which also reverted the timeout. Only the class of failure is kept.
        const code = (error as { code?: unknown; cause?: { code?: unknown } })?.code ?? (error as { cause?: { code?: unknown } })?.cause?.code;
        return { capturedAt, outcome: code === '57014' ? 'timeout' : 'unavailable' };
    }
}
