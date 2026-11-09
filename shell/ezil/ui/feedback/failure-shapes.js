// Feedback-local validators adapted from origin/main shell/ezil/failure-diagnostics.js.
// Keep aligned with app/src/server/feedback/failure-shapes.ts. No side effects.
export const FAILURE_REASON_MAX = 96;
export const FAILURE_REASON_MAX_SEGMENTS = 3;
const SEGMENT_MAX = 48;

/** One snake_case code. See the server twin for why each word is shape-checked. */
export function isReasonSegment (value) {
    if ( typeof value !== 'string' || value.length === 0 || value.length > SEGMENT_MAX ) return false;
    if ( ! /^[a-z][a-z0-9_]*$/.test(value) ) return false;
    for ( const word of value.split('_') ) {
        if ( word === '' || word.length > 15 ) return false;
        const digits = /[0-9]/.test(word);
        const letters = /[a-z]/.test(word);
        if ( digits && ! letters && word.length > 4 ) return false;
        if ( digits && letters && word.length > 6 ) return false;
        if ( ! digits && word.length >= 8 && /^[a-f]+$/.test(word) ) return false;
    }
    return true;
}

/** 1-3 valid segments joined by `:`, at most `FAILURE_REASON_MAX` characters. */
export function isFailureReason (value) {
    if ( typeof value !== 'string' || value.length === 0 || value.length > FAILURE_REASON_MAX ) return false;
    const parts = value.split(':');
    return parts.length <= FAILURE_REASON_MAX_SEGMENTS && parts.every(isReasonSegment);
}

const CORRELATION_ID_RE =
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|cid_[0-9a-z]{6,40}|srv_[0-9a-f]{12})$/;

/** A server-minted request id (`randomUUID`, `cid_…`, `srv_…`) and nothing else. */
export function isCorrelationId (value) {
    return typeof value === 'string' && CORRELATION_ID_RE.test(value);
}

