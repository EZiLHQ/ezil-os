/**
 * Worker-side contribution to the fleet crash-telemetry pipeline (see the
 * design doc, `scratchpad/telemetry-design.md`). Pure/testable helpers only —
 * no `@cloudflare/sandbox` import here, mirroring `./observability`,
 * `./hmac`, `./desktop-mode` (see those modules' own doc comments for why).
 *
 * Two producers feed this module:
 *   1. The Worker's OWN `LifecycleTimeline` events (`./observability.ts`) —
 *      `toTelemetryEventInput()` + `selectTelemetryWorthy()` turn the ones
 *      worth keeping into the wire shape.
 *   2. The CONTAINER's own structured boot-phase log, one JSON line per
 *      phase (`emit_telemetry()` in `scripts/start-neko.sh`) —
 *      `parseContainerTelemetryLines()` turns that raw NDJSON into the same
 *      wire shape, discarding (never throwing on) anything malformed.
 *
 * `TelemetryEventInput` here is a LOCAL COPY of the canonical contract
 * defined in `app/src/server/telemetry/types.ts` (design doc §1.2) — the
 * Worker has no import path into `app/` (different deploy target, different
 * package). Every field name, type and required/optional split below is
 * written to match that contract byte-for-byte; `telemetry.test.ts` pins the
 * exact JSON shape this module produces so a future integration test can
 * diff the two schemas for drift instead of discovering it in production.
 *
 * PRIVACY: every value that reaches a `TelemetryEventInput` here has ALREADY
 * been through `sanitizeErrorMessage()` — worker events via
 * `LifecycleTimeline.build()` (`./observability.ts`), container events
 * because `emit_telemetry()` only ever writes a closed-set phase name, a
 * closed-set status token, and an integer — never a message, a path, or a
 * secret. See the design doc §8 for the full field-by-field justification.
 */

import type { LogEvent } from './observability';

/** Mirrors `TELEMETRY_SCHEMA_VERSION` in the design doc's `types.ts` (§1.2). */
export const TELEMETRY_SCHEMA_VERSION = 1;

/** The nine-member closed set from the design doc §1. */
export const TELEMETRY_EVENT_CLASSES = [
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
export type TelemetryEventClass = (typeof TELEMETRY_EVENT_CLASSES)[number];

export type TelemetrySource = 'shell' | 'app' | 'worker' | 'container';
export type TelemetryOutcome = 'ok' | 'error' | 'skipped';

/** The wire shape a producer PUTs into the R2 spool — see this module's doc comment. */
export interface TelemetryEventInput {
  eventId: string;
  schemaVersion: number;
  eventClass: TelemetryEventClass;
  source: TelemetrySource;
  /** Producer's clock, ISO-8601. */
  occurredAt: string;
  /** Logical origin — never a file:line, never a URL. Max 96 chars by contract. */
  site: string;
  /** Typed low-cardinality code, `[a-z0-9_]+` by contract. Max 64 chars. */
  code: string;
  outcome: TelemetryOutcome;
  /** Already sanitized by the producer. Max 200 chars by contract. */
  detail?: string;
  durationMs?: number;
  /** Groups every event of one page-load / one Worker request. */
  correlationId?: string;
  /** Opaque, safe: a random id that joins to nothing outside our own DB. */
  computerId?: string;
}

/**
 * The `sandbox.preview.desktop_ready` event is the boot DENOMINATOR (design
 * §1, §6 Q2/Q4): it must be captured on success too, not only on error, or
 * "error rate" has no base to divide by. Every OTHER worker event is only
 * telemetry-worthy when it actually failed — a healthy `ok` event from any
 * other stage is exactly what `LifecycleTimeline`'s existing `console.log`
 * line already covers for local/`wrangler tail` debugging.
 */
const BOOT_SUMMARY_EVENT_NAME = 'sandbox.preview.desktop_ready';

/** Which built `LogEvent`s are worth spooling to R2 at all (design §4.1). */
export function selectTelemetryWorthy(events: readonly LogEvent[]): LogEvent[] {
  return events.filter((e) => e.outcome === 'error' || e.event === BOOT_SUMMARY_EVENT_NAME);
}

/** Fresh id for a Worker-minted `TelemetryEventInput` (not a `correlationId` — every row gets its own). */
function mintEventId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'evt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
}

/**
 * Map one Worker `LogEvent` (`./observability.ts`'s `LifecycleTimeline`) into
 * the wire shape. `sandbox.preview.desktop_ready` becomes `boot_summary`
 * (captured on BOTH `ok` and `error` — the denominator); every other event
 * reaching here has already been filtered by `selectTelemetryWorthy()` to
 * `outcome === 'error'` and becomes `worker_exception`.
 */
export function toTelemetryEventInput(logEvent: LogEvent): TelemetryEventInput {
  const eventClass: TelemetryEventClass =
    logEvent.event === BOOT_SUMMARY_EVENT_NAME ? 'boot_summary' : 'worker_exception';
  const code = logEvent.errorCode ?? (logEvent.outcome === 'ok' ? 'ok' : 'unexpected_error');

  const out: TelemetryEventInput = {
    eventId: mintEventId(),
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventClass,
    source: 'worker',
    occurredAt: logEvent.ts,
    site: logEvent.event,
    code,
    outcome: logEvent.outcome,
  };
  if (logEvent.correlationId) out.correlationId = logEvent.correlationId;
  if (typeof logEvent.durationMs === 'number') out.durationMs = Math.round(logEvent.durationMs);
  if (logEvent.detail) out.detail = logEvent.detail;
  // `sandboxId` is an opaque, per-computer random id — safe as `computerId`
  // (design §8.1: "joins to nothing outside our own DB; the row is already
  // scoped to its owner").
  if (logEvent.sandboxId) out.computerId = logEvent.sandboxId;
  return out;
}

/** Options that fill in the fields a container's raw NDJSON line cannot supply itself. */
export interface ContainerTelemetryContext {
  /** The preview/restart request's own correlation id, so container events join the same request. */
  correlationId: string;
  /** Opaque per-computer id, when known. */
  sandboxId?: string;
  /** Injectable for deterministic tests; defaults to `new Date()`. */
  now?: Date;
}

/**
 * Parse `emit_telemetry()`'s NDJSON output (`scripts/start-neko.sh`) into
 * `TelemetryEventInput`s.
 *
 * Fails closed per LINE, never for the whole batch: a line that is not valid
 * JSON, or whose shape does not match the closed-set contract below, is
 * silently dropped — a full disk, a torn write, or a future field this
 * parser does not know about yet must never take down the whole drain (or,
 * worse, throw and lose every OTHER valid line in the same read). Mirrors
 * `emit_telemetry()`'s own `|| true` discipline on the write side.
 *
 * `eventId`/`schemaVersion`/`occurredAt` are NOT written by the container
 * (its `printf` line only carries `eventClass`/`site`/`code`/`outcome`/
 * `durationMs` — see that function's doc comment) — filled in HERE, at drain
 * time, by the Worker.
 */
export function parseContainerTelemetryLines(
  raw: string | null | undefined,
  ctx: ContainerTelemetryContext,
): TelemetryEventInput[] {
  if (!raw) return [];
  const occurredAt = (ctx.now ?? new Date()).toISOString();
  const out: TelemetryEventInput[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // torn/partial write — drop this line only
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const p = parsed as Record<string, unknown>;

    const eventClass = p.eventClass;
    const site = p.site;
    const code = p.code;
    const outcome = p.outcome;
    if (typeof eventClass !== 'string' || !(TELEMETRY_EVENT_CLASSES as readonly string[]).includes(eventClass)) {
      continue;
    }
    if (typeof site !== 'string' || site.length === 0) continue;
    if (typeof code !== 'string' || code.length === 0) continue;
    if (outcome !== 'ok' && outcome !== 'error' && outcome !== 'skipped') continue;

    const durationMs =
      typeof p.durationMs === 'number' && Number.isFinite(p.durationMs) ? Math.round(p.durationMs) : undefined;

    const event: TelemetryEventInput = {
      eventId: mintEventId(),
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventClass: eventClass as TelemetryEventClass,
      source: 'container',
      occurredAt,
      site: site.slice(0, 96),
      code: code.slice(0, 64),
      outcome,
      correlationId: ctx.correlationId,
    };
    if (durationMs !== undefined) event.durationMs = durationMs;
    if (ctx.sandboxId) event.computerId = ctx.sandboxId;
    out.push(event);
  }
  return out;
}

/** One NDJSON line per event, in the order given — the exact shape the R2 object stores. */
export function serializeTelemetryBatch(events: readonly TelemetryEventInput[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

/**
 * Deterministic R2 key for a spooled batch: `v1/dt=<date>/hh=<hour>/<id>.ndjson`
 * (design §4.1) — hour-bucketed so the retention job (app-side, out of scope
 * here) can sweep by prefix, and named by correlation id so re-spooling the
 * same request is idempotent-by-overwrite rather than accumulating
 * duplicates.
 */
export function buildTelemetryR2Key(now: Date, correlationId: string): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const safeId = (correlationId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'unknown';
  return `v1/dt=${yyyy}-${mm}-${dd}/hh=${hh}/${safeId}.ndjson`;
}
