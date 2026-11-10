// Feedback-local adaptation of origin/main failure-diagnostics; keep validators aligned.
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

