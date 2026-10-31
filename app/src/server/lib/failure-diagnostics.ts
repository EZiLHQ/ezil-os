/**
 * Failure diagnostics: a bounded machine `reason` and a server `correlationId`
 * that travel BESIDE a public error, so a feedback report can name the real
 * cause instead of only the shell's classification of it.
 *
 * Why this exists: production feedback for "We couldn't start your computer"
 * said only `unauthorized`, while the server log said `worker_http_401
 * hmac_signature_mismatch`. The label was right and still useless, because
 * nothing tied the report to the log line. `reason` carries the underlying
 * code; `correlationId` is the id already on the server's failure log line, so
 * support can grep for it.
 *
 * 🔴 BOTH VALUES CROSS INTO A BROWSER AND INTO A STORED REPORT. They are
 * therefore ALLOWLISTED by shape, never sanitised by substitution: a value
 * that does not match is DROPPED, not repaired. Repairing (lowercasing,
 * replacing characters) can turn a secret into something that looks like a
 * code. Nothing here may ever carry a URL, a token, a body, a stack trace or
 * another person's id. See `isReasonSegment` for the exact rule.
 *
 * The shell keeps a twin of these two predicates
 * (`shell/ezil/failure-diagnostics.js`) because the browser bundle cannot
 * import app code. `shell/ezil/ui/feedback/feedback-test.mjs` imports this
 * file and pins the two to the same answers, so they cannot drift quietly.
 *
 * No `@/` imports and nothing but erasable TypeScript: the shell's Node test
 * loads this file directly.
 */

import { randomBytes } from 'node:crypto';

/** Longest `reason`, all segments and separators included. */
export const FAILURE_REASON_MAX = 96;
/** `worker_http_401:hmac_signature_mismatch` is two; `aws_preview_unavailable:worker_status_401:<worker code>` is three. */
export const FAILURE_REASON_MAX_SEGMENTS = 3;
const SEGMENT_MAX = 48;

/**
 * One `:`-separated part of a reason: a snake_case code such as
 * `worker_http_401` or `hmac_signature_mismatch`.
 *
 * The charset alone (`[a-z0-9_]`) is NOT enough: a 32-character lowercase hex
 * HMAC passes it. So each `_`-separated word is also shape-checked:
 *   - letters only: at most 15 characters, and not 8+ characters of pure
 *     `a-f` (a hex run that happens to contain no digit);
 *   - digits only: at most 4 (an HTTP status, never an id or a timestamp);
 *   - letters and digits: at most 6 (`v2`, `ec2`, `http2`), never a hash.
 * A word longer than 15 characters with no `_` is opaque, not a word.
 */
export function isReasonSegment(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > SEGMENT_MAX) return false;
    if (!/^[a-z][a-z0-9_]*$/.test(value)) return false;
    for (const word of value.split('_')) {
        if (word === '' || word.length > 15) return false;
        const digits = /[0-9]/.test(word);
        const letters = /[a-z]/.test(word);
        if (digits && !letters && word.length > 4) return false;
        if (digits && letters && word.length > 6) return false;
        if (!digits && word.length >= 8 && /^[a-f]+$/.test(word)) return false;
    }
    return true;
}

/** A whole reason: 1-3 valid segments joined by `:`, at most `FAILURE_REASON_MAX` characters. */
export function isFailureReason(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > FAILURE_REASON_MAX) return false;
    const parts = value.split(':');
    return parts.length <= FAILURE_REASON_MAX_SEGMENTS && parts.every(isReasonSegment);
}

/**
 * Join the parts that pass, in order. A part may itself be a whole reason
 * (`a:b`); a part that fails is dropped entirely, never trimmed into shape.
 * `undefined` when nothing survives. Never throws.
 */
export function failureReason(...parts: unknown[]): string | undefined {
    const kept: string[] = [];
    for (const part of parts) {
        if (!isFailureReason(part)) continue;
        for (const segment of part.split(':')) {
            if (kept.length >= FAILURE_REASON_MAX_SEGMENTS) break;
            if (kept.join(':').length + (kept.length ? 1 : 0) + segment.length > FAILURE_REASON_MAX) break;
            if (kept[kept.length - 1] !== segment) kept.push(segment);
        }
    }
    return kept.length ? kept.join(':') : undefined;
}

/**
 * The leading code of an internal error string — `worker_http_401` from
 * `worker_http_401: {"ok":false,...}`, `sandbox_starting` from
 * `sandbox_starting: the container is still waking...` — or the whole string
 * when it IS a code (`desktop_frame_http_error_404`). Only `code: ` (colon,
 * space) counts as a separator, so `https://...` never yields `https`.
 */
export function leadingCode(error: unknown): string | undefined {
    if (typeof error !== 'string') return undefined;
    if (isReasonSegment(error)) return error;
    const match = /^([a-z][a-z0-9_]*): /.exec(error);
    return match && isReasonSegment(match[1]) ? match[1] : undefined;
}

/**
 * The Worker's own public code from a JSON error body (`{"error":"hmac_signature_mismatch"}`),
 * when it passes the allowlist. Anything else — non-JSON, a message, a URL — is nothing.
 */
export function workerBodyCode(body: unknown): string | undefined {
    if (typeof body !== 'string' || body.length === 0) return undefined;
    try {
        const error = (JSON.parse(body) as { error?: unknown } | null)?.error;
        return isReasonSegment(error) ? error : undefined;
    } catch {
        return undefined;
    }
}

/**
 * A server correlation id in one of the three shapes this app mints, and
 * nothing else: `randomUUID()` (lowercase), the provider's `cid_` fallback
 * (`newCorrelationId`), or `srv_` + 12 hex (`newShortCorrelationId`). A
 * correlation id identifies one request, not a person or a computer.
 */
const CORRELATION_ID_RE =
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|cid_[0-9a-z]{6,40}|srv_[0-9a-f]{12})$/;

export function isCorrelationId(value: unknown): value is string {
    return typeof value === 'string' && CORRELATION_ID_RE.test(value);
}

/** For a failure whose request had no correlation id: short, random, greppable. */
export function newShortCorrelationId(): string {
    return `srv_${randomBytes(6).toString('hex')}`;
}

export interface FailureFields {
    reason?: string;
    correlationId?: string;
}

/** The validated subset of `{reason, correlationId}` — fields that fail are omitted, never repaired. */
export function failureFields(input: { reason?: unknown; correlationId?: unknown }): FailureFields {
    const out: FailureFields = {};
    if (isFailureReason(input.reason)) out.reason = input.reason;
    if (isCorrelationId(input.correlationId)) out.correlationId = input.correlationId;
    return out;
}

/**
 * Carried as a `TRPCError`'s `cause` so a THROWN failure keeps its diagnostics
 * through `shellErrorResponse`, which replaces every 5xx message with a fixed
 * generic one. Validated at construction; the message is a constant.
 */
export class FailureDiagnosticsError extends Error {
    readonly fields: FailureFields;

    constructor(input: { reason?: unknown; correlationId?: unknown }) {
        super('failure diagnostics');
        this.name = 'FailureDiagnosticsError';
        this.fields = failureFields(input);
    }
}

/** The validated fields from a thrown error's `cause`, or nothing. */
export function failureFieldsOf(err: unknown): FailureFields {
    const cause = (err as { cause?: unknown } | null)?.cause;
    return cause instanceof FailureDiagnosticsError ? { ...cause.fields } : {};
}
