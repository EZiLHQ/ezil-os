// EZiL-authored. Gateway contract C4: both the status and code must match.
const RATE_CODES = new Set([
    'rate_limited', 'tpm_limited', 'concurrency_limit',
    'spend_limit_reached', 'global_cap_reached',
]);
const PROVIDER_CODES = new Set(['provider_error', 'provider_unavailable', 'upstream_timeout']);

export function classifyGatewayError (status, body) {
    const code = body?.error?.code;
    if ( status === 402 && code === 'insufficient_credits' ) return 'topup';
    if ( status === 402 && code === 'no_entitlement' ) return 'subscribe';
    if ( status === 429 && RATE_CODES.has(code) ) return 'retry_later';
    if ( [502, 503, 504].includes(status) && PROVIDER_CODES.has(code) ) return 'provider';
    return 'unknown';
}
