// failure-diagnostics.js — EZiL-authored. The browser's twin of
// `app/src/server/lib/failure-diagnostics.ts`.
//
// A failed start/mint can now carry, beside its public `errorCode`, the
// server's bounded machine `reason` (`worker_http_401:hmac_signature_mismatch`)
// and the `correlationId` on the server's log line for it. This shell keeps
// both on the failure result and in telemetry's LOCAL mirror only, so a
// feedback report can name the real cause and be matched to the server log.
//
// 🔴 ALLOWLISTED, NOT SANITISED. These values arrive from the network and end
// up in a report the user sends, so anything that does not match its shape is
// DROPPED, never repaired. The rules are the server's, verbatim, and
// `ui/feedback/feedback-test.mjs` pins the two implementations to the same
// answers — the bundle cannot import app code, so this copy has to exist.
//
// A leaf module: no imports, no side effects. `telemetry.js` imports it.

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

/**
 * The validated `{reason, correlationId}` of a server answer or error body.
 * Fields that fail are omitted; nothing else is ever copied.
 *
 * @param {unknown} source e.g. a `{ok:false,...}` body, or `body.error`
 * @returns {{reason?: string, correlationId?: string}}
 */
export function failureFields (source) {
    const out = {};
    if ( ! source || typeof source !== 'object' ) return out;
    if ( isFailureReason(source.reason) ) out.reason = source.reason;
    if ( isCorrelationId(source.correlationId) ) out.correlationId = source.correlationId;
    return out;
}

export default { failureFields, isCorrelationId, isFailureReason, isReasonSegment };
