import { describe, expect, test } from 'bun:test';
import { CHAT_FAILURE_VERSION, classifyChatFailure, type ChatFailureKind } from '../src/failure';
import { GatewayError, type GatewayErrorOrigin } from '../src/gateway';
import { GatewayResponseError } from '../src/gateway-response';
import { CLIENT_ID, GATEWAY_ID, PREVIOUS_ID, SENTINEL } from './fixtures/failure';

const input = { cancelled: false, model: 'org/model-v1.2:alias', clientRequestId: CLIENT_ID, previousClientRequestId: PREVIOUS_ID,
    gatewayRequestId: GATEWAY_ID, attempts: 2, partial: true, at: 0, latencyMs: 123 };
const gatewayError = (code?: string, status?: number, origin: GatewayErrorOrigin = 'gateway') => new GatewayError(SENTINEL, status, code, GATEWAY_ID, undefined, origin);
const groups: Partial<Record<ChatFailureKind, string[]>> = {
    timeout: ['first_byte_timeout', 'stream_idle_timeout', 'completion_timeout', 'os_completion_timeout'],
    network: ['os_unreachable', 'os_ai_unavailable', 'connection_lost'],
    auth: ['unauthorized', 'os_session_missing', 'os_session_expired', 'access_token_expired', 'os_proxy_unauthorized', 'no_ezil_role',
        'not_a_member', 'role_mismatch', 'forbidden', 'account_suspended', 'suspended'],
    credits: ['insufficient_credits', 'no_live_grant', 'window_budget_reached', 'daily_budget_reached'],
    rate: ['rate_limited', 'concurrency_limit'], upstream: ['upstream_timeout', 'upstream_unavailable', 'upstream_error'],
    refused: ['max_tokens', 'response_incomplete', 'response_failed'],
    unavailable: ['killswitch', 'paused', 'pause', 'global_cap_reached', 'model_disabled', 'model_not_found', 'model_unavailable',
        'no_provider_route', 'no_entitlement', 'model_not_allowed', 'catalog_unavailable'],
    too_large: ['input_too_large', 'body_too_large', 'local_input_too_large', 'local_too_many_messages', 'local_too_many_blocks'],
    local: ['local_build_error'],
};
describe('classifyChatFailure kinds', () => {
    for (const [kind, codes] of Object.entries(groups)) for (const code of codes) test(`${code} -> ${kind}`, () => {
        const record = classifyChatFailure({ ...input, error: gatewayError(code) });
        expect(record).toMatchObject({ v: CHAT_FAILURE_VERSION, outcome: 'failed', kind, code });
        expect(JSON.stringify(record)).not.toContain(SENTINEL);
    });
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [402, 'credits'], [429, 'rate'], [413, 'too_large']] as const) {
        test(`HTTP ${status} default -> ${kind}`, () => {
            expect(classifyChatFailure({ ...input, error: gatewayError(undefined, status) })).toMatchObject({ kind, httpStatus: status });
        });
    }
    test('explicit budget code takes precedence over HTTP 429', () => {
        expect(classifyChatFailure({ ...input, error: gatewayError('window_budget_reached', 429) }).kind).toBe('credits');
    });
    test('cancellation overrides every error and omits response failure details', () => {
        for (const error of [gatewayError('upstream_error', 503), new GatewayResponseError(GATEWAY_ID, 'stream_interrupted', 'stream_error_event', 'api_error'), new Error(SENTINEL)]) {
            const record = classifyChatFailure({ ...input, cancelled: true, error });
            expect(record).toMatchObject({ outcome: 'cancelled', kind: 'cancelled', code: 'cancelled', origin: null });
            expect(record).not.toHaveProperty('reason'); expect(record).not.toHaveProperty('upstreamType');
        }
    });
    for (const reason of ['stream_error_event', 'stream_truncated', 'stream_malformed', 'connection_reset', 'invalid_response'] as const) {
        test(`response ${reason} -> ${reason === 'connection_reset' ? 'network' : 'interrupted'}`, () => {
            expect(classifyChatFailure({ ...input, error: new GatewayResponseError(GATEWAY_ID, 'stream_interrupted', reason) }))
                .toMatchObject({ kind: reason === 'connection_reset' ? 'network' : 'interrupted', reason, origin: 'response' });
        });
    }
    test('other local origin -> local', () => {
        expect(classifyChatFailure({ ...input, error: gatewayError('future_local_code', undefined, 'local') })).toMatchObject({ kind: 'local', code: 'future_local_code' });
    });
    test('unknown errors -> internal without copying even plausible error properties', () => {
        for (const error of [new Error(SENTINEL), undefined, { code: 'unauthorized', message: SENTINEL, origin: 'gateway' }]) {
            expect(classifyChatFailure({ ...input, error })).toMatchObject({ kind: 'internal', code: 'internal_error', origin: null });
        }
    });
});

describe('failure metadata sanitizers', () => {
    test('UUIDs become lowercase and valid metadata has the exact version 1 shape', () => {
        expect(classifyChatFailure({ ...input, error: gatewayError('unauthorized', 401), clientRequestId: CLIENT_ID.toUpperCase(),
            previousClientRequestId: PREVIOUS_ID.toUpperCase(), gatewayRequestId: GATEWAY_ID.toUpperCase() })).toEqual({
            model: input.model, clientRequestId: CLIENT_ID, previousClientRequestId: PREVIOUS_ID, gatewayRequestId: GATEWAY_ID,
            attempts: 2, partial: true, latencyMs: 123, at: '1970-01-01T00:00:00.000Z',
            v: 1, outcome: 'failed', kind: 'auth', code: 'unauthorized', origin: 'gateway', httpStatus: 401,
        });
    });
    test('garbage IDs and model are null; an invalid previous ID is omitted', () => {
        const record = classifyChatFailure({ ...input, clientRequestId: SENTINEL, previousClientRequestId: SENTINEL, gatewayRequestId: SENTINEL, model: SENTINEL });
        expect(record).toMatchObject({ clientRequestId: null, gatewayRequestId: null, model: null });
        expect(record).not.toHaveProperty('previousClientRequestId');
        expect(JSON.stringify(record)).not.toContain(SENTINEL);
    });
    test('paths, spaces, overlong and malformed codes use a kind-derived fallback', () => {
        for (const code of ['private/path', 'private message', 'A_code', '_code', 'a'.repeat(49), SENTINEL]) {
            const record = classifyChatFailure({ ...input, error: gatewayError(code, 401) });
            expect(record).toMatchObject({ kind: 'auth', code: 'unauthorized' });
            expect(JSON.stringify(record)).not.toContain(code);
        }
    });
    test('safe code and model length boundaries are retained', () => {
        expect(classifyChatFailure({ ...input, model: 'm'.repeat(128), error: gatewayError('a'.repeat(48)) })).toMatchObject({ model: 'm'.repeat(128), code: 'a'.repeat(48) });
        expect(classifyChatFailure({ ...input, model: 'm'.repeat(129) }).model).toBeNull();
    });
    test('trailing newlines cannot pass the code, model or UUID patterns', () => {
        const record = classifyChatFailure({ ...input, model: 'qwen\n', clientRequestId: `${CLIENT_ID}\n`,
            previousClientRequestId: `${PREVIOUS_ID}\n`, gatewayRequestId: `${GATEWAY_ID}\n`, error: gatewayError('unauthorized\n') });
        expect(record).toMatchObject({ model: null, clientRequestId: null, gatewayRequestId: null, code: 'internal_error' });
        expect(record).not.toHaveProperty('previousClientRequestId');
    });
    test('invalid origin, status, reason and upstream type are dropped', () => {
        const error = gatewayError('future_code', 999);
        Object.assign(error, { origin: SENTINEL });
        expect(classifyChatFailure({ ...input, error })).toMatchObject({ origin: null, httpStatus: null });
        const response = new GatewayResponseError(GATEWAY_ID);
        Object.assign(response, { reason: SENTINEL, upstreamType: SENTINEL });
        const record = classifyChatFailure({ ...input, error: response });
        expect(record).not.toHaveProperty('reason'); expect(record).not.toHaveProperty('upstreamType');
        expect(JSON.stringify(record)).not.toContain(SENTINEL);
    });
    test('status is an integer in 100..599', () => {
        for (const status of [99, 600, 200.5, NaN, Infinity]) expect(classifyChatFailure({ ...input, error: gatewayError(undefined, status) }).httpStatus).toBeNull();
        for (const status of [100, 599]) expect(classifyChatFailure({ ...input, error: gatewayError(undefined, status) }).httpStatus).toBe(status);
    });
    test('counts clamp to 1e9 and malformed counts and dates become null', () => {
        expect(classifyChatFailure({ ...input, attempts: Number.MAX_SAFE_INTEGER, latencyMs: 1e9 + 1 })).toMatchObject({ attempts: 1e9, latencyMs: 1e9 });
        for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            expect(classifyChatFailure({ ...input, attempts: value, latencyMs: value })).toMatchObject({ attempts: null, latencyMs: null });
        }
        for (const at of [NaN, Infinity, 8.64e15 + 1]) expect(classifyChatFailure({ ...input, at }).at).toBeNull();
    });
    test('runtime malformed input types never become free text', () => {
        const record = classifyChatFailure({ ...input, model: {}, clientRequestId: {}, gatewayRequestId: 1, previousClientRequestId: [],
            attempts: '1', latencyMs: SENTINEL, at: SENTINEL, partial: 'true', cancelled: 'true' } as unknown as Parameters<typeof classifyChatFailure>[0]);
        expect(record).toMatchObject({ outcome: 'failed', model: null, clientRequestId: null, gatewayRequestId: null, attempts: null, latencyMs: null, at: null, partial: false });
        expect(JSON.stringify(record)).not.toContain(SENTINEL);
    });
    test('the upstream allowlist is closed at error construction', () => {
        for (const type of ['overloaded_error', 'api_error', 'rate_limit_error', 'timeout_error', 'invalid_request_error', 'authentication_error',
            'permission_error', 'not_found_error', 'request_too_large', 'billing_error', 'upstream_error', 'upstream_timeout', 'upstream_unavailable']) {
            expect(new GatewayResponseError(undefined, 'stream_interrupted', 'stream_error_event', type).upstreamType).toBe(type);
        }
        for (const type of [SENTINEL, 'OVERLOADED_ERROR', {}, null]) expect(new GatewayResponseError(undefined, 'stream_interrupted', 'stream_error_event', type).upstreamType).toBeUndefined();
    });
});
