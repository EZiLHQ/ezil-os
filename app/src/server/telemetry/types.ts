/**
 * The single shared telemetry contract — shell, worker (via R2 spool) and
 * app-server producers all target this shape. See
 * `scratchpad/telemetry-design.md` §1.2 for the full design; this file is
 * the "wire type" it specifies, landed first per §9's suggested order.
 *
 * Nothing here is trusted as-is: every field is re-validated by the zod
 * schema in `./schema.ts` before it reaches `ingestBatch`. This file only
 * fixes the shape and the closed enums so shell/worker producers and the app
 * ingest path cannot drift on what a valid event even looks like.
 */

/** Bumped when the wire shape changes in a non-additive way. Mirrors
 * `LOG_SCHEMA_VERSION`'s discipline in `worker/src/observability.ts`. */
export const TELEMETRY_SCHEMA_VERSION = 1;

/** Closed set. Adding a class requires updating `./schema.ts`'s per-class
 * `attrs` allow-list (§8.2) at the same time — never left implicit. */
export const EVENT_CLASSES = [
    'boot_phase',
    'boot_summary',
    'boot_stall',
    'crash',
    'window_error',
    'api_failure',
    'display_failure',
    'worker_exception',
    'contract_violation',
] as const;
export type EventClass = (typeof EVENT_CLASSES)[number];

export const SOURCES = ['shell', 'app', 'worker', 'container'] as const;
export type Source = (typeof SOURCES)[number];

/** Reuses `worker/src/observability.ts`'s `Outcome` vocabulary verbatim. */
export const OUTCOMES = ['ok', 'error', 'skipped'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Per-class `attrs` allow-list. Anything else is STRIPPED (not rejected —
 * an unknown attrs key must never fail the whole event, only be dropped) by
 * the zod schema. Keys not listed for a class carry no attrs at all. */
export const ATTRS_ALLOW_LIST: Record<EventClass, readonly string[]> = {
    crash: ['stack_head'],
    window_error: ['app_id'],
    api_failure: ['status', 'retryable'],
    display_failure: ['seen'],
    boot_summary: ['phases', 'total_ms'],
    boot_phase: [],
    boot_stall: [],
    worker_exception: [],
    contract_violation: [],
};

/**
 * What a client PUTS ON THE WIRE. Note what is absent: no userId, no
 * fingerprint, no URL, no email, no stack beyond `attrs.stack_head`.
 */
export interface TelemetryEventInput {
    /** Client-generated UUIDv4. The idempotency key — a re-sent batch is a no-op. */
    eventId: string;
    schemaVersion: number;
    eventClass: EventClass;
    source: Source;
    /** Client's clock, ISO-8601. Advisory only; the server also stamps its own. */
    occurredAt: string;
    /** LOGICAL origin, never a file:line. Closed-ish set, low cardinality by
     * construction. Max 96 chars. */
    site: string;
    /** Typed low-cardinality code. Max 64 chars, `[a-z0-9_]+`. */
    code: string;
    outcome: Outcome;
    /** Already run through `sanitizeErrorMessage()` BY THE PRODUCER. Max 200. */
    detail?: string;
    durationMs?: number;
    /** Groups every event of one page-load / one Worker request. */
    correlationId?: string;
    /** Non-sensitive opaque id (an `ezil_computers.id`). */
    computerId?: string;
    /** Bounded allow-listed extras. Schema per class, `ATTRS_ALLOW_LIST`. */
    attrs?: Record<string, string | number | boolean>;
}

export interface TelemetryBatch {
    schemaVersion: number;
    /** Max 50. Longer batches are truncated server-side, not rejected. */
    events: TelemetryEventInput[];
}

/**
 * The `userHash` a drained worker/container event is stored under.
 * `ezil_error_events.userHash` is `NOT NULL` and a worker/container event has
 * no user at all — there is no session, no cookie, nothing to hash. This is
 * the ONE reserved value in that column that is not a real
 * `safeUserHash()` output (a real hash is 8 hex digits derived from a FNV-1a
 * fold; this is deliberately all zeros, unattainable by that function for any
 * input), so it can never collide with an actual user.
 *
 * 🔴 MUST be excluded from every "distinct users" count that a worker/container
 * fingerprint could otherwise inflate to a false "1 distinct user" —
 * `queries.ts`'s `fingerprintLeaderboard` and `fingerprintLeaderboardFromRollup`
 * both do this via a `FILTER (WHERE user_hash <> ...)` on the `count(DISTINCT
 * ...)` aggregate, not a `WHERE` clause, so a worker-only fingerprint still
 * shows up in the leaderboard (with its real event count) instead of vanishing
 * from it entirely. See `app/src/server/telemetry/spool-drain.ts`'s doc
 * comment for where this is actually inserted.
 */
export const WORKER_SENTINEL_USER_HASH = 'u_00000000';

/** Server-side limits enforced at every layer that can enforce them
 * (zod schema, route handler, `ingestBatch`). Kept in one place so the
 * numbers cited in comments elsewhere cannot drift from what actually runs. */
export const TELEMETRY_LIMITS = {
    /** Hard cap on events accepted from a single request body. */
    MAX_EVENTS_PER_BATCH: 50,
    /** Hard cap on the raw request body Next.js is asked to parse as JSON. */
    MAX_BODY_BYTES: 64 * 1024,
    MAX_SITE_LEN: 96,
    MAX_CODE_LEN: 64,
    MAX_DETAIL_LEN: 200,
    MAX_CORRELATION_ID_LEN: 64,
    /** attrs.stack_head and other free-ish string attrs. */
    MAX_ATTR_STRING_LEN: 160,
} as const;
