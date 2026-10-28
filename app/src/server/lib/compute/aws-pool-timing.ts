import { z } from 'zod';

const stamp = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const POOL_TIMING_PHASES = ['claimObservedMs', 'guardDoneMs', 'enrollDoneMs', 'warmStoppedMs',
    'relayAvailableMs', 'desktopStartedMs', 'desktopHealthyMs'] as const;
// Partial traces support upgrades and same-instance recovery after tmpfs was lost.
export const poolTimingSchema = z.object({
    claimObservedMs: stamp.optional(), guardDoneMs: stamp.optional(), enrollDoneMs: stamp.optional(),
    warmStoppedMs: stamp.optional(), relayAvailableMs: stamp.optional(), desktopStartedMs: stamp.optional(),
    desktopHealthyMs: stamp.optional(), claimPublishedAtMs: z.number().finite().nonnegative().max(4102444800000).optional(),
}).strict().superRefine((value, ctx) => {
    const phases = POOL_TIMING_PHASES.flatMap(k => value[k] === undefined ? [] : [value[k]!]);
    if (phases.some((v, i) => i > 0 && v < phases[i - 1]!)
        || (phases.length > 1 && phases.at(-1)! - phases[0]! > 86_400_000))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pool_timing_order_or_span' });
});

export function poolTimingDeltas(t: z.infer<typeof poolTimingSchema>): Record<string, number> {
    const result: Record<string, number> = {};
    for (let i = 1; i < POOL_TIMING_PHASES.length; i++) {
        const phase = POOL_TIMING_PHASES[i]!;
        const previous = t[POOL_TIMING_PHASES[i - 1]!];
        if (t[phase] !== undefined && previous !== undefined) result[phase] = t[phase]! - previous;
    }
    if (t.claimObservedMs !== undefined && t.desktopHealthyMs !== undefined)
        result.claimToHealthyMs = t.desktopHealthyMs - t.claimObservedMs;
    if (t.claimPublishedAtMs !== undefined) result.claimPublishedAtMs = t.claimPublishedAtMs;
    return result;
}

/**
 * Round 3: persist a compute timing as a row through the app's existing telemetry ingestion
 * (`ingestBatch` → `ezil_error_events`, class `boot_summary`, source `app`; no new table or env).
 * `phases` is a compact `name:ms` list; `durationMs` the whole segment. Best effort: a database
 * without the query builder (tests, the fake) or an ingest failure writes nothing and never
 * fails the caller. The user is stored only as the telemetry user hash.
 */
export interface ComputeTiming {
    site: 'compute.pool_session_timing' | 'compute.transition';
    code: string;
    outcome: 'ok' | 'error';
    ownerUserId: string;
    computerId: string;
    durationMs: number | null;
    phases: Record<string, number>;
}
export function compactPhases(phases: Record<string, number>): string {
    return Object.entries(phases).filter(([, v]) => Number.isFinite(v))
        .map(([k, v]) => `${k.replace(/Ms$/, '').replace(/[^A-Za-z0-9_]/g, '')}:${Math.round(v)}`).join(',').slice(0, 160);
}
export async function recordComputeTiming(db: unknown, timing: ComputeTiming): Promise<boolean> {
    try {
        if (!db || typeof (db as { transaction?: unknown }).transaction !== 'function' || typeof (db as { insert?: unknown }).insert !== 'function') return false;
        const [{ ingestBatch }, { safeUserHash }, { telemetryEventInputSchema }, { randomUUID }] = await Promise.all([
            import('@/server/telemetry/ingest'), import('@/server/telemetry/sanitize'), import('@/server/telemetry/schema'), import('node:crypto')]);
        const duration = timing.durationMs !== null && Number.isFinite(timing.durationMs) ? Math.max(0, Math.min(86_400_000, Math.round(timing.durationMs))) : undefined;
        const event = telemetryEventInputSchema.parse({
            eventId: randomUUID(), schemaVersion: 1, eventClass: 'boot_summary', source: 'app', occurredAt: new Date().toISOString(),
            site: timing.site, code: timing.code.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) || 'unknown', outcome: timing.outcome,
            ...(duration === undefined ? {} : { durationMs: duration }), computerId: timing.computerId.toLowerCase(),
            attrs: { phases: compactPhases(timing.phases), ...(duration === undefined ? {} : { total_ms: duration }) },
        });
        await ingestBatch(db as Parameters<typeof ingestBatch>[0], [event], safeUserHash(timing.ownerUserId));
        return true;
    } catch {
        console.error('[compute.timing] persist failed');
        return false;
    }
}
