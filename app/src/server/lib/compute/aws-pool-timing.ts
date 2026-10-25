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
