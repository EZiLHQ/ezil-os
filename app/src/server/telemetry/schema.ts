import { z } from 'zod';

import { ATTRS_ALLOW_LIST, EVENT_CLASSES, OUTCOMES, SOURCES, TELEMETRY_LIMITS } from './types';
import type { EventClass } from './types';

/**
 * Required-vs-optional and every bound is enforced in exactly ONE place:
 * here. Used by the ingest route AND (eventually) any R2-spool drainer, so
 * a field failing validation always means the same thing regardless of
 * which producer sent it.
 */

const attrScalar = z.union([z.string().max(TELEMETRY_LIMITS.MAX_ATTR_STRING_LEN), z.number(), z.boolean()]);

/**
 * `.strict()`: an unrecognised top-level key — most importantly `userId` or
 * `email`, which the shell must NEVER send (design §5.2) — fails validation
 * for THIS EVENT ONLY. `parseTelemetryBatch` drops a failing event and keeps
 * the rest, so one caller "helpfully" adding an identity field cannot sink a
 * whole request's telemetry, but the leak attempt itself is a hard failure
 * rather than something that quietly accretes into the schema.
 * `schema.test.ts` asserts the reject, not just the pass path.
 */
export const telemetryEventInputSchema = z
    .object({
        eventId: z.string().uuid(),
        schemaVersion: z.number().int().positive(),
        eventClass: z.enum(EVENT_CLASSES),
        source: z.enum(SOURCES),
        // Client's clock. Advisory only — not parsed as a real Date here,
        // just bounded as a string; the server's own `receivedAt` is what
        // every time-window query actually uses.
        occurredAt: z.string().min(1).max(40),
        site: z.string().min(1).max(TELEMETRY_LIMITS.MAX_SITE_LEN),
        code: z
            .string()
            .min(1)
            .max(TELEMETRY_LIMITS.MAX_CODE_LEN)
            .regex(/^[a-z0-9_]+$/, 'code must match [a-z0-9_]+'),
        outcome: z.enum(OUTCOMES),
        detail: z.string().max(TELEMETRY_LIMITS.MAX_DETAIL_LEN).optional(),
        // 24h ceiling: a boot or a preview mint is never a legitimate
        // multi-day "duration" — a bogus huge value here is either a client
        // bug or an attempt to pollute an average.
        durationMs: z
            .number()
            .int()
            .nonnegative()
            .max(24 * 60 * 60 * 1000)
            .optional(),
        correlationId: z.string().max(TELEMETRY_LIMITS.MAX_CORRELATION_ID_LEN).optional(),
        computerId: z.string().uuid().optional(),
        // Bounded generically here; PER-CLASS filtering (dropping keys not
        // on that class's allow-list) happens in `sanitizeAttrs` below, not
        // here — that step must never fail the event, only narrow it.
        attrs: z.record(z.string().max(64), attrScalar).optional(),
    })
    .strict();

export type ParsedTelemetryEventInput = z.infer<typeof telemetryEventInputSchema>;

/** Cap on how many attrs keys survive `sanitizeAttrs`, independent of the
 * allow-list length — defence in depth if a class's list ever grows large. */
const MAX_ATTRS_KEPT = 8;

/**
 * Strip any `attrs` key not on this event class's allow-list
 * (`types.ts`'s `ATTRS_ALLOW_LIST`). Never throws and never rejects the
 * event — an unknown or disallowed attrs key is simply dropped, per design
 * §8.2 ("Anything not on this list is stripped ... not rejected").
 */
export function sanitizeAttrs(
    eventClass: EventClass,
    attrs: ParsedTelemetryEventInput['attrs'],
): Record<string, string | number | boolean> | undefined {
    if (!attrs) return undefined;
    const allowed = ATTRS_ALLOW_LIST[eventClass];
    if (allowed.length === 0) return undefined;
    const out: Record<string, string | number | boolean> = {};
    let kept = 0;
    for (const key of allowed) {
        if (kept >= MAX_ATTRS_KEPT) break;
        if (Object.hasOwn(attrs, key)) {
            out[key] = attrs[key];
            kept++;
        }
    }
    return kept > 0 ? out : undefined;
}

const rawBatchSchema = z.object({
    schemaVersion: z.number().int().positive(),
    events: z.array(z.unknown()),
});

export interface ParsedTelemetryBatch {
    schemaVersion: number;
    /** Valid events only, already capped at `TELEMETRY_LIMITS.MAX_EVENTS_PER_BATCH`. */
    events: ParsedTelemetryEventInput[];
    /** Raw entry count before capping/validation — visibility only, never
     * echoed back to the caller (the response body is never meaningfully read). */
    rawCount: number;
    /** How many (already-capped) entries failed per-event validation. */
    droppedInvalid: number;
}

/**
 * Parse a raw request body into a batch of VALID events only. Never throws:
 * a malformed top-level shape yields an empty batch; an individual event
 * failing `.strict()` validation (extra key, bad enum, oversized field, an
 * unrecognised `eventClass` — i.e. an unknown event type) is dropped and
 * does not affect its siblings.
 */
export function parseTelemetryBatch(body: unknown): ParsedTelemetryBatch {
    const top = rawBatchSchema.safeParse(body);
    if (!top.success) return { schemaVersion: 0, events: [], rawCount: 0, droppedInvalid: 0 };

    const rawCount = top.data.events.length;
    // Cap BEFORE per-event validation: "longer batches are truncated
    // server-side, not rejected" (design §1.2) — a flood of 10,000 events in
    // one body costs us at most 50 validations and 50 inserts, never 10,000.
    const capped = top.data.events.slice(0, TELEMETRY_LIMITS.MAX_EVENTS_PER_BATCH);

    const events: ParsedTelemetryEventInput[] = [];
    let droppedInvalid = 0;
    for (const raw of capped) {
        const parsed = telemetryEventInputSchema.safeParse(raw);
        if (parsed.success) events.push(parsed.data);
        else droppedInvalid++;
    }
    return { schemaVersion: top.data.schemaVersion, events, rawCount, droppedInvalid };
}
