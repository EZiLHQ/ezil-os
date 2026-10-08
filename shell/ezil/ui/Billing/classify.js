// EZiL-authored. Gateway contract v1.1 A5: both the status and code must match.
const RATE_CODES = new Set([
    'rate_limited', 'tpm_limited', 'concurrency_limit',
    'spend_limit_reached',
]);
const SERVICE_CODES = new Set([
    'global_cap_reached', 'killswitch', 'paused', 'model_disabled',
    'policy_unavailable', 'controls_unavailable', 'credit_policy_unavailable', 'pricing_unavailable',
]);

export function classifyGatewayError (status, body) {
    const code = body?.error?.code;
    if ( status === 402 && code === 'insufficient_credits' ) return 'topup';
    if ( status === 402 && code === 'no_entitlement' ) return 'subscribe';
    if ( status === 429 && RATE_CODES.has(code) ) return 'retry_later';
    if ( status === 503 && SERVICE_CODES.has(code) ) return 'retry_later';
    if ( [502, 504].includes(status) && typeof code === 'string' && code.startsWith('upstream_') ) return 'provider';
    return 'unknown';
}
