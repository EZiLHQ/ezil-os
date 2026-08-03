/**
 * Sanitized structured observability for the sandbox Worker.
 *
 * Factored out of `index.ts` (no `@cloudflare/sandbox` import here) so the
 * event schema, redaction rules, and correlation timeline can be unit-tested
 * with plain `bun test` — mirroring `./hmac`, `./desktop-mode`, and
 * `./workspace-diag`.
 *
 * Purpose: emit a correlated debug timeline across the full project lifecycle
 * (browser → web API → project authorization → sandbox identity → workspace
 * mount → preview lifecycle) WITHOUT ever logging sensitive material.
 *
 * Hard sanitization rules (see `sanitizeErrorMessage`):
 *   - Never emit raw file contents, environment values, authorization material,
 *     cookies, request signatures, relay/TURN credentials, candidate IP
 *     addresses, authorization headers, or unrelated storage keys.
 *   - Upstream error strings are bounded and scrubbed before they leave.
 *   - User identifiers are only ever emitted as a non-reversible `safeUserHash`.
 */

/** Bumped when the emitted event shape changes in a non-additive way. */
export const LOG_SCHEMA_VERSION = 1;

/** Fixed lifecycle stages of a project preview, in causal order. */
export const STAGES = [
  'browser',
  'web_api',
  'project_authorization',
  'sandbox_identity',
  'workspace_mount',
  'preview_lifecycle',
] as const;
export type Stage = (typeof STAGES)[number];

/** Terminal outcome of a stage. */
export type Outcome = 'ok' | 'error' | 'skipped';

/** A single sanitized structured log record. */
export interface LogEvent {
  /** UTC ISO-8601 timestamp with millisecond precision. */
  ts: string;
  /** Correlates every event of one preview request (a.k.a. requestId). */
  correlationId: string;
  /** Machine event name, e.g. `sandbox.preview.workspace_mount`. */
  event: string;
  /** Schema version for downstream parsers. */
  schemaVersion: number;
  /** Stable lifecycle stage this event belongs to. */
  stage: Stage;
  /** Project identifier (non-sensitive) when known. */
  projectId?: string;
  /** Non-reversible user hash — NEVER the raw user id. */
  userHash?: string;
  /** Derived sandbox id when known. */
  sandboxId?: string;
  /** Wall-clock duration of the stage in milliseconds when measured. */
  durationMs?: number;
  /** Terminal outcome. */
  outcome: Outcome;
  /** Typed, bounded error code when `outcome === 'error'`. */
  errorCode?: string;
  /** Optional bounded, sanitized detail (never raw upstream strings). */
  detail?: string;
}

/**
 * Non-reversible, deterministic, synchronous user hash (FNV-1a, 32-bit) used
 * ONLY for cross-event correlation — never for security. The raw user id never
 * appears in a log. An empty/undefined id yields `u_anon` so events remain
 * correlatable without inventing identity.
 */
export function safeUserHash(userId?: string): string {
  if (!userId || !userId.trim()) return 'u_anon';
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'u_' + (h >>> 0).toString(16).padStart(8, '0');
}

/** Max length any sanitized detail/error string may reach before truncation. */
export const MAX_DETAIL_LEN = 200;

/**
 * Scrub and bound an upstream error/detail string so it is safe to log.
 *
 * Redacts common secret-bearing shapes (HMAC tokens/signatures, bearer/auth
 * headers, cookies, key/secret assignments, IPv4/IPv6 addresses, s3/r2 access
 * keys) and hard-truncates the result. Returns a stable placeholder for empty
 * input.
 */
export function sanitizeErrorMessage(input: unknown): string {
  let s =
    input instanceof Error ? input.message : typeof input === 'string' ? input : String(input ?? '');
  if (!s) return '';

  s = s
    // HMAC preview tokens `t=<ms>,v1=<hex>` and bare `v1=<hex>` signatures.
    .replace(/t=\d+,v1=[0-9a-f]+/gi, '[redacted-token]')
    .replace(/v1=[0-9a-f]{8,}/gi, 'v1=[redacted-sig]')
    // Authorization / bearer / cookie headers (value may contain spaces — redact
    // to end of line; over-redaction is preferred over leaking credentials).
    .replace(/bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'bearer [redacted]')
    .replace(/(authorization|cookie|set-cookie|x-signature)\s*[:=][^\n]*/gi, '$1=[redacted]')
    // key=... / secret=... / token=... / password=... assignments.
    .replace(
      /\b(secret|access[_-]?key|secret[_-]?key|api[_-]?key|token|password|passwd|pwd|cred|credential)s?\s*[:=]\s*\S+/gi,
      '$1=[redacted]',
    )
    // AWS/R2-style access key ids and long opaque secrets.
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-keyid]')
    // IPv4 addresses (ICE candidate leakage).
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[redacted-ip]')
    // IPv6 addresses.
    .replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, '[redacted-ip]')
    .replace(/\s+/g, ' ')
    .trim();

  if (s.length > MAX_DETAIL_LEN) s = s.slice(0, MAX_DETAIL_LEN - 1) + '\u2026';
  return s;
}

/**
 * Map an arbitrary error into a stable, low-cardinality typed error code.
 * Falls back to `unexpected_error` so every error path is still typed.
 */
export function classifyError(input: unknown): string {
  const raw =
    input instanceof Error ? input.message : typeof input === 'string' ? input : String(input ?? '');
  const trimmed = raw.trim();
  // Special container/runtime shapes take precedence over a generic prefix so
  // e.g. `fuse: device not found` maps to a meaningful code, not just `fuse`.
  if (/fuse|device not found/i.test(trimmed)) return 'workspace_fuse_unavailable';
  if (/already (mounted|in use)/i.test(trimmed)) return 'mount_already_present';
  const m = /^([a-z][a-z0-9_]{2,64}):/i.exec(trimmed);
  if (m) return m[1].toLowerCase();
  // A bare snake_case token with no trailing message is itself a typed code.
  const bare = /^([a-z][a-z0-9_]{2,64})$/i.exec(trimmed);
  if (bare) return bare[1].toLowerCase();
  if (/timeout|timed out/i.test(trimmed)) return 'timeout';
  if (/not (found|configured)/i.test(trimmed)) return 'not_configured';
  return 'unexpected_error';
}

/** Where a built event is written. Defaults to `console.log(JSON.stringify)`. */
export type LogSink = (event: LogEvent) => void;

const defaultSink: LogSink = (event) => {
  // Single-line JSON so log processors can parse it directly.
  console.log(JSON.stringify(event));
};

/**
 * A sink that behaves EXACTLY like the default (`console.log(JSON.stringify(event))`,
 * so `wrangler tail` keeps working unchanged) while ALSO accumulating every
 * built event into `events`, so a caller can harvest the ones worth spooling
 * to the telemetry pipeline (`./telemetry.ts`'s `selectTelemetryWorthy` +
 * `toTelemetryEventInput`) once the request is done.
 *
 * Purely additive: none of the 25 existing `tl.event`/`tl.stage` call sites
 * in `index.ts` change — only the `LifecycleTimeline` CONSTRUCTION site
 * passes `{ sink: createCollectingSink(events) }` instead of relying on the
 * default. `events` is mutated in place (pushed to) rather than returned,
 * so the caller can pass the SAME array to multiple timelines/requests if it
 * ever needs to (not done today — one array per request).
 */
export function createCollectingSink(events: LogEvent[]): LogSink {
  return (event) => {
    console.log(JSON.stringify(event));
    events.push(event);
  };
}

/**
 * A correlation timeline binding every stage event of one preview request to a
 * single `correlationId`, with per-stage duration measurement.
 *
 * Usage:
 *   const tl = new LifecycleTimeline({ projectId, userId });
 *   tl.event('web_api', 'sandbox.preview.received', 'ok');
 *   const done = tl.stage('workspace_mount', 'sandbox.preview.workspace_mount');
 *   ... work ...
 *   done('ok');            // or done('error', err)
 */
export class LifecycleTimeline {
  readonly correlationId: string;
  private projectId?: string;
  private userHash: string;
  private sandboxId?: string;
  private sink: LogSink;

  constructor(opts: {
    projectId?: string;
    userId?: string;
    correlationId?: string;
    sandboxId?: string;
    sink?: LogSink;
  }) {
    this.correlationId = opts.correlationId ?? newCorrelationId();
    this.projectId = sanitizeProjectId(opts.projectId);
    this.userHash = safeUserHash(opts.userId);
    this.sandboxId = opts.sandboxId;
    this.sink = opts.sink ?? defaultSink;
  }

  /** Attach the derived sandbox id to all subsequent events. */
  setSandboxId(id: string): void {
    this.sandboxId = id;
  }

  /** Build (but do not emit) a sanitized event — exposed for testing. */
  build(
    stage: Stage,
    event: string,
    outcome: Outcome,
    extra?: { durationMs?: number; error?: unknown; detail?: string },
  ): LogEvent {
    const rec: LogEvent = {
      ts: new Date().toISOString(),
      correlationId: this.correlationId,
      event,
      schemaVersion: LOG_SCHEMA_VERSION,
      stage,
      outcome,
    };
    if (this.projectId) rec.projectId = this.projectId;
    if (this.userHash) rec.userHash = this.userHash;
    if (this.sandboxId) rec.sandboxId = this.sandboxId;
    if (typeof extra?.durationMs === 'number') rec.durationMs = Math.round(extra.durationMs);
    if (outcome === 'error' && extra?.error !== undefined) {
      rec.errorCode = classifyError(extra.error);
      rec.detail = sanitizeErrorMessage(extra.error);
    } else if (extra?.detail) {
      rec.detail = sanitizeErrorMessage(extra.detail);
    }
    return rec;
  }

  /** Emit a point-in-time stage event. */
  event(
    stage: Stage,
    event: string,
    outcome: Outcome,
    extra?: { durationMs?: number; error?: unknown; detail?: string },
  ): void {
    this.sink(this.build(stage, event, outcome, extra));
  }

  /**
   * Begin a timed stage; returns a completion callback that emits the event
   * with a measured `durationMs`.
   */
  stage(stage: Stage, event: string): (outcome: Outcome, error?: unknown, detail?: string) => void {
    const start = Date.now();
    return (outcome, error, detail) => {
      this.event(stage, event, outcome, { durationMs: Date.now() - start, error, detail });
    };
  }
}

/** Fresh correlation/request id. */
export function newCorrelationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'cid_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
}

/**
 * Bound and lightly sanitize a project id for logging. Project ids are
 * non-sensitive but we still cap length and strip whitespace/control chars so a
 * hostile value can't bloat or break a log line.
 */
export function sanitizeProjectId(projectId?: string): string | undefined {
  if (!projectId || !projectId.trim()) return undefined;
  return projectId.replace(/[\s\u0000-\u001f]+/g, '').slice(0, 64) || undefined;
}
