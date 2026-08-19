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
 *
 * The one field that got this wrong is `computerId` — it used to carry
 * `sandboxId`, which is a truncated RAW USER ID and not a UUID. It is now
 * never set; the reasoning is written out in full on the field itself, and
 * `telemetry.test.ts` pins the absence in both directions.
 *
 * ── KNOWN GAP, stated so nobody "fixes" it by putting the leak back ─────────
 * 🔴 Nothing drains `ezil-telemetry-spool` yet. These objects are written and
 * never read. Whoever writes the drainer must run each line through the app's
 * `parseTelemetryBatch` (which is `.strict()` and drops an event whole on any
 * failure) rather than inserting it directly, and must NOT reintroduce a
 * per-computer field until a real `ezil_computers.id` UUID is plumbed down to
 * the Worker — the only value that satisfies both the `uuid` column and the
 * no-raw-identity rule. Until then, worker/container events join on
 * `correlationId` and the R2 key's `dt=/hh=` layout only.
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
  /**
   * The app's `ezil_computers.id` — a real UUID, stored in a `uuid` column
   * with a foreign key.
   *
   * 🔴 THE WORKER CANNOT FILL THIS IN, and must not try. All it has is
   * `sandboxId`, which is `guac-<first 16 alnum of the user's id>-<first 16
   * alnum of the computer's id>` (`deriveGuacamoleSandboxId` in
   * `app/src/server/lib/cloudflare-guacamole-provider.ts`). That string is
   * two things this field must never be:
   *
   *   1. NOT A UUID. The app's zod schema is `computerId: z.string().uuid()`
   *      and its `.strict()` parse drops the WHOLE event on a failure —
   *      measured: a spooled worker event with `computerId` set to a
   *      sandboxId parses to `{ events: [], droppedInvalid: 1 }`, and the
   *      same event with the field removed parses clean. Filling it in did
   *      not attach a computer to worker telemetry; it silently discarded
   *      100% of worker telemetry at the first validator downstream.
   *   2. NOT ANONYMOUS. 16 alphanumeric characters of a Supabase user UUID is
   *      64 bits of the raw user id — enough to re-identify a user against
   *      `auth.users`. It is a truncated raw user id, not an opaque token,
   *      whatever the field it sits in is called. The Worker's own precedent
   *      for identity in structured output is a HASH (`userHash`, `u_xxxxxxxx`).
   *
   * Left unset, deliberately. Worker and container events join by
   * `correlationId` and by the R2 key's own `dt=/hh=` layout; per-computer
   * attribution from the worker side needs a real computer UUID to be handed
   * down from the app, which no route does today. See this module's
   * `KNOWN GAP` note.
   */
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

/**
 * Force a `code` into the wire contract's `^[a-z0-9_]{1,64}$`.
 *
 * 🔴 THIS IS NOT COSMETIC, AND IT IS NOT DEFENSIVE PADDING. The app's ingest
 * schema (`app/src/server/telemetry/schema.ts`) is `.strict()` and validates
 * `code` against `/^[a-z0-9_]+$/`; `parseTelemetryBatch` drops a FAILING EVENT
 * WHOLE. Until this function existed, this module only `.slice(0, 64)`d the
 * code, so any producer whose code contained a hyphen, a dot, a slash or a
 * capital had its event accepted here, written to R2, drained — and then
 * silently discarded at the last validator, with nothing anywhere saying why.
 *
 * That is not hypothetical: `docs/BROWSER-FIX-CONTRACT.md` §8 specifies the
 * codes for this change set as "short, lowercase, HYPHENATED", naming
 * `screen-unsupported`, `screen-upstream`, `decor-still-present` and
 * `xtest-dead`. Every one of those is invalid under the schema as written.
 * The shell producer already normalises (`normalizeCode` in
 * `shell/ezil/telemetry.js`, same rule, written first); this is the worker and
 * container half of the same rule, so all three producers spell one event the
 * same way and a `decor-still-present` from the container fingerprints
 * identically to a `decor_still_present` from the shell.
 *
 * Never rejects — normalises. An empty/unusable input becomes `unknown`, which
 * is a valid code, because dropping an event for a bad code is exactly the
 * failure mode this function exists to remove.
 */
export function normalizeTelemetryCode(code: unknown): string {
  const s = String(code ?? 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (s || 'unknown').slice(0, 64);
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
  // Normalised for the SAME reason the container path below is — see
  // `normalizeTelemetryCode`. `errorCode` comes from `classifyError()`, which
  // is already snake_case today, so this is a no-op in practice and a
  // guarantee in principle.
  const code = normalizeTelemetryCode(logEvent.errorCode ?? (logEvent.outcome === 'ok' ? 'ok' : 'unexpected_error'));

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
  // 🔴 `logEvent.sandboxId` is deliberately NOT copied to `computerId`. It is
  // not a UUID (the app drops the whole event) and it carries 64 bits of the
  // raw user id (it is not anonymous). See `computerId`'s own doc comment.
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
      // 🔴 NOT `code.slice(0, 64)`. The container writes this field itself
      // (`emit_telemetry()` in `scripts/start-neko.sh`, and any future direct
      // NDJSON append), so it is the one `code` in this file that a human
      // types by hand — and the app's ingest schema drops a whole event whose
      // code does not match `^[a-z0-9_]+$`. See `normalizeTelemetryCode`.
      code: normalizeTelemetryCode(code),
      outcome,
      correlationId: ctx.correlationId,
    };
    if (durationMs !== undefined) event.durationMs = durationMs;
    // Same rule as the worker path above — see `computerId`'s doc comment.
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

// ── The R2 drain (`POST /telemetry/drain` + `/telemetry/ack`) ───────────────
//
// `spoolTelemetry()` above has been writing to `TELEMETRY_R2_BUCKET` all
// along; this is the missing last hop that finally reads it. See this
// module's own top-of-file "KNOWN GAP" note — this section is what closes it.
//
// Pure/testable helpers only, same discipline as the rest of this file: the
// actual `R2Bucket` calls (`.list()`/`.get()`/`.delete()`) live in
// `./index.ts`'s route handlers, which this module cannot import (no
// `@cloudflare/sandbox` here). What lives here is everything that does NOT
// need the Workers runtime to test: request-body parsing, key validation,
// and the page-size ceiling.

/** All spooled objects live under this prefix (`buildTelemetryR2Key`). The
 * drain lists ONLY this prefix — never the whole bucket — and the ack route
 * refuses to delete a key that does not start with it (`parseTelemetryAckKeys`),
 * so a caller can never turn `/telemetry/ack` into an arbitrary-object delete. */
export const TELEMETRY_SPOOL_PREFIX = 'v1/';

/** Hard ceiling on objects returned by one `/telemetry/drain` page, and on
 * keys accepted by one `/telemetry/ack` call (design: "cursor-paged, ≤200
 * objects"). Independent of R2's own list-page ceiling (1000) — this is a
 * deliberately smaller number so one drain page is cheap to re-process
 * whole on a crash between ingest and ack (idempotent via `eventId`, but
 * still bounded work). */
export const TELEMETRY_DRAIN_MAX_OBJECTS = 200;

/**
 * Non-secret production kill-switch for BOTH `/telemetry/drain` and
 * `/telemetry/ack`. Same vocabulary as `./sandbox-control.ts`'s
 * `focusDisabled`/`restartDisabled` and `./workspace-diag.ts`'s
 * `diagDisabled` — set to `off`/`false`/`0`/`disabled`/`no` to hard-disable
 * both routes (404) without a code change. Both routes share ONE flag
 * (`SANDBOX_TELEMETRY_DRAIN`) because acking without draining first (or vice
 * versa) is never a coherent half-state to leave reachable.
 */
export function telemetryDrainDisabled(flag: string | undefined): boolean {
  if (!flag) return false;
  return ['off', 'false', '0', 'disabled', 'no'].includes(flag.trim().toLowerCase());
}

/** Clamp a caller-requested page size into `[1, TELEMETRY_DRAIN_MAX_OBJECTS]`.
 * A missing/non-numeric/non-finite request falls back to the ceiling itself
 * (the drain cron always wants as much as it is allowed in one page). */
export function clampDrainLimit(requested: unknown): number {
  const n = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : TELEMETRY_DRAIN_MAX_OBJECTS;
  return Math.min(Math.max(n, 1), TELEMETRY_DRAIN_MAX_OBJECTS);
}

export interface TelemetryDrainRequestBody {
  cursor?: string;
  limit?: number;
}

/** Parse `POST /telemetry/drain`'s JSON body. Never throws: an absent or
 * malformed body just means "start from the beginning, default page size". */
export function parseTelemetryDrainBody(body: unknown): TelemetryDrainRequestBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const b = body as Record<string, unknown>;
  const cursor = typeof b.cursor === 'string' && b.cursor.trim() !== '' ? b.cursor : undefined;
  const limit = typeof b.limit === 'number' ? b.limit : undefined;
  return { cursor, limit };
}

/**
 * Validate `POST /telemetry/ack`'s `{ keys: string[] }` body into a safe
 * delete list: every entry must be a string, rooted under
 * `TELEMETRY_SPOOL_PREFIX`, and boundedly short — so a caller (even one that
 * already holds a valid HMAC token) can never turn this route into a delete
 * of an arbitrary R2 object elsewhere in the bucket. Anything else is
 * silently dropped from the list, never thrown on — one bad key must not
 * sink the ack of every other valid one. Capped at
 * `TELEMETRY_DRAIN_MAX_OBJECTS`, matching the largest page `/telemetry/drain`
 * can ever hand back in one call.
 */
export function parseTelemetryAckKeys(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const raw = (body as Record<string, unknown>).keys;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const k of raw) {
    if (out.length >= TELEMETRY_DRAIN_MAX_OBJECTS) break;
    if (typeof k === 'string' && k.length > 0 && k.length < 500 && k.startsWith(TELEMETRY_SPOOL_PREFIX)) {
      out.push(k);
    }
  }
  return out;
}
