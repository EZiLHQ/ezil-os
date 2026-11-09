import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { APP_FAILURE_CODES, appFailure, emittableModelKey, isAppFailure, isSafeModelKey, MODEL_KEY_NAMESPACES, type AppFailureInput } from '../src/failure';
import { GatewayError } from '../src/gateway';
import { GatewayResponseError } from '../src/gateway-response';
import { CLIENT_ID, GATEWAY_ID, SENTINEL } from './fixtures/failure';

// The feedback lane's canonical golden fixtures (docs/FEEDBACK-APP-FAILURES-CONTRACT.md): the producer must agree with them.
const fixtures = JSON.parse(readFileSync(`${import.meta.dir}/../../../app/src/server/feedback/app-failures.fixtures.json`, 'utf8')) as {
    valid: { name: string; failure: unknown }[]; rejected: { name: string; failure: unknown }[] };
const EVENT_ID = 'e1e1e1e1-0000-4000-8000-000000000001';
const base: AppFailureInput = { outcome: 'failed', stage: 'headers', model: 'qwen.qwen3-coder-next', clientRequestId: CLIENT_ID,
    gatewayRequestId: GATEWAY_ID, attempts: 1, durationMs: 1234, newEventId: () => EVENT_ID };
const gatewayError = (code?: string, status?: number, origin: GatewayError['origin'] = 'gateway') => new GatewayError(SENTINEL, status, code, GATEWAY_ID, undefined, origin);

describe('canonical golden fixtures', () => {
    for (const { name, failure } of fixtures.valid) test(`valid: ${name}`, () => expect(isAppFailure(failure)).toBe(true));
    for (const { name, failure } of fixtures.rejected) test(`rejected: ${name}`, () => expect(isAppFailure(failure)).toBe(false));
});

describe('appFailure mapping', () => {
    for (const model of ['claude', 'x.claude-sonnet-5-5', 'us.unknownvendor.model-1', 'eu.claude-secret-1']) {
        test(`unsafe model ${model} is omitted without losing the record or its IDs`, () => {
            const record = appFailure({ ...base, model, error: gatewayError('upstream_error', 500) });
            expect(record).not.toHaveProperty('modelKey');
            expect(record).toMatchObject({ eventId: EVENT_ID, clientRequestId: CLIENT_ID, gatewayRequestId: GATEWAY_ID });
            expect(isAppFailure(record)).toBe(true);
            expect(isAppFailure({ ...record, modelKey: model })).toBe(false);
        });
    }
    // Credential shapes: rejected outright, or (embedded after a delimiter) accepted by the consumer's predicate but
    // never emitted by the producer. Either way the record and its request IDs are kept.
    for (const model of ['project/file-1', 'sb_secret_abcd-efgh-ijkl-mnop', 'claude-sk-abcd1234', 'gemini-ghp_x1', 'anthropic/claude-xoxb-1',
        'ezil-pat-1', 'qwen.sk-proj-abc1', 'claude-token-5']) {
        test(`credential-shaped model ${model} is never emitted, and the record keeps its IDs`, () => {
            const record = appFailure({ ...base, model, error: gatewayError('upstream_error', 500) });
            expect(record).not.toHaveProperty('modelKey');
            expect(record).toMatchObject({ eventId: EVENT_ID, clientRequestId: CLIENT_ID, gatewayRequestId: GATEWAY_ID });
            expect(isAppFailure(record)).toBe(true);
            expect(emittableModelKey(model)).toBe(false);
        });
    }
    for (const model of ['qwen.qwen3-coder-next', 'anthropic/claude-sonnet-4-5-20250929', 'us.anthropic.claude-sonnet-5-5', 'claude-sonnet-5-5', 'us.moonshotai.kimi-k3',
        'gemini-3.8-flash', 'ezil-code', 'ezil-fast']) {
        test(`safe model ${model} is preserved`, () => {
            const record = appFailure({ ...base, model });
            expect(record.modelKey).toBe(model);
            expect(isAppFailure(record)).toBe(true);
        });
    }
    test('namespace, token, segment and exact-match bounds mirror the contract', () => {
        for (const namespace of MODEL_KEY_NAMESPACES) {
            expect(isSafeModelKey(`${namespace}/model-1`)).toBe(true);
            expect(isSafeModelKey(`${namespace}.model-1`)).toBe(true);
        }
        for (const segment of ['sk-123', 'sb_123', 'pk_123', 'rk_123', 'ghp_123', 'gho_123', 'ghs_123', 'ghu_123',
            'github_pat_123', 'xoxa-123', 'xoxb-123', 'xoxp-123', 'xoxr-123', 'secret-1', 'token-1', 'passw-1', 'bearer-1',
            'apikey-1', 'api-key-1', 'api_key-1', 'private-1', 'credential-1', 'session-1', 'cookie-1', 'a'.repeat(20)]) {
            expect(isSafeModelKey(`qwen.model-1.${segment}`)).toBe(false);
        }
        for (const value of [null, 1, 'qwen/model', 'qwen/model-1/other', 'qwen/model-1..other', 'qwen/model-1:',
            'qwen:model-1', 'qwen/model-1://other', ' qwen/model-1', 'qwen/model-1\n', 'qwen/model-1 ', `qwen/${'a-'.repeat(30)}`]) {
            expect(isSafeModelKey(value)).toBe(false);
        }
        expect(isSafeModelKey(`qwen/model-${'a'.repeat(19)}`)).toBe(true);
    });
    const table: [string, string, string][] = [
        ['first_byte_timeout', 'timeout', 'first_token_timeout'], ['stream_idle_timeout', 'timeout', 'request_timeout'],
        ['completion_timeout', 'timeout', 'request_timeout'], ['os_completion_timeout', 'timeout', 'request_timeout'], ['upstream_timeout', 'timeout', 'request_timeout'],
        ['os_unreachable', 'network', 'network_failed'], ['os_ai_unavailable', 'network', 'network_failed'], ['connection_lost', 'network', 'network_failed'],
        ['access_token_expired', 'auth', 'auth_expired'], ['os_session_expired', 'auth', 'session_expired'], ['os_session_missing', 'auth', 'auth_invalid'],
        ['unauthorized', 'auth', 'auth_invalid'], ['os_proxy_unauthorized', 'auth', 'auth_invalid'], ['suspended', 'auth', 'auth_invalid'],
        ['insufficient_credits', 'credits', 'credits_exhausted'], ['no_live_grant', 'credits', 'credits_exhausted'], ['window_budget_reached', 'credits', 'credits_exhausted'],
        ['no_ezil_role', 'entitlement', 'membership_required'], ['no_entitlement', 'entitlement', 'membership_required'], ['model_not_allowed', 'entitlement', 'model_not_entitled'],
        ['rate_limited', 'rate_limit', 'rate_limited'], ['concurrency_limit', 'rate_limit', 'rate_limited'],
        ['upstream_error', 'provider', 'provider_error'], ['upstream_unavailable', 'provider', 'provider_error'], ['max_tokens', 'provider', 'provider_error'],
        ['model_disabled', 'provider', 'model_unavailable'], ['model_unavailable', 'provider', 'model_unavailable'], ['catalog_unavailable', 'provider', 'model_unavailable'],
        ['killswitch', 'provider', 'model_unavailable'], ['pause', 'provider', 'model_unavailable'],
        ['input_too_large', 'provider', 'unexpected_error'], ['local_build_error', 'provider', 'unexpected_error'], ['future_code', 'provider', 'unexpected_error'],
    ];
    for (const [from, category, code] of table) test(`${from} -> ${category}/${code}`, () => {
        const record = appFailure({ ...base, error: gatewayError(from, 400) });
        expect(record).toMatchObject({ category, code, stage: 'headers', outcome: 'failed', httpStatus: 400 });
        expect(isAppFailure(record)).toBe(true);
    });
    test('HTTP status decides an unknown code', () => {
        for (const [status, code] of [[401, 'auth_invalid'], [402, 'credits_exhausted'], [403, 'membership_required'], [429, 'rate_limited'], [500, 'unexpected_error']] as const) {
            expect(appFailure({ ...base, error: gatewayError(undefined, status) }).code).toBe(code);
        }
        expect(appFailure({ ...base, error: gatewayError(undefined, undefined, 'transport') })).toMatchObject({ category: 'network', code: 'unexpected_error' });
    });
    test('a stream failure is interrupted in the stream stage with its fixed reason', () => {
        for (const [reason, streamReason] of [['stream_truncated', 'missing_terminal'], ['stream_malformed', 'malformed_event'], ['connection_reset', 'eof'],
            ['invalid_response', 'malformed_event']] as const) {
            const record = appFailure({ ...base, stage: 'request', error: new GatewayResponseError(GATEWAY_ID, 'stream_interrupted', reason) });
            expect(record).toMatchObject({ category: 'interrupted', code: 'stream_interrupted', stage: 'stream', streamReason, retryable: true });
            expect(isAppFailure(record)).toBe(true);
        }
    });
    test('an SSE error event maps by its allowlisted code and carries no stream reason', () => {
        const event = (type?: string) => new GatewayResponseError(GATEWAY_ID, 'stream_interrupted', 'stream_error_event', type);
        expect(appFailure({ ...base, error: event('overloaded_error') })).toMatchObject({ category: 'provider', code: 'provider_overloaded', retryable: true });
        expect(appFailure({ ...base, error: event('settlement_pending') })).toMatchObject({ category: 'provider', code: 'provider_error', retryable: false });
        expect(appFailure({ ...base, error: event('upstream_timeout') })).toMatchObject({ category: 'timeout', code: 'request_timeout' });
        expect(appFailure({ ...base, error: event('rate_limit_error') })).toMatchObject({ category: 'rate_limit', code: 'rate_limited' });
        const gateway = appFailure({ ...base, error: event('stream_interrupted') });
        expect(gateway).toMatchObject({ category: 'interrupted', code: 'stream_interrupted', stage: 'stream' });
        expect(gateway).not.toHaveProperty('streamReason');
        expect(appFailure({ ...base, error: event(SENTINEL) })).toMatchObject({ category: 'interrupted', code: 'stream_interrupted' });
    });
    test('cancellation is neutral and proves only the caller', () => {
        const record = appFailure({ ...base, outcome: 'cancelled', cancellationSource: 'caller', stage: 'stream', error: gatewayError('upstream_error', 500) });
        expect(record).toEqual({ eventId: EVENT_ID, source: 'ezil_chat', operation: 'chat_request', category: 'cancellation', code: 'request_cancelled',
            stage: 'stream', outcome: 'cancelled', cancellationSource: 'caller', clientRequestId: CLIENT_ID, gatewayRequestId: GATEWAY_ID, attempt: 1,
            durationMs: 1234, modelKey: 'qwen.qwen3-coder-next' });
        expect(isAppFailure(record)).toBe(true);
        expect(appFailure({ ...base, outcome: 'cancelled' }).cancellationSource).toBe('unknown');
        for (const bad of [{ outcome: 'failed' }, { code: 'unexpected_error' }]) expect(isAppFailure({ ...record, ...bad })).toBe(false);
    });
    test('retrying and recovered are retryable; a failed credits refusal is not', () => {
        expect(appFailure({ ...base, outcome: 'retrying', error: gatewayError('rate_limited', 429) }).retryable).toBe(true);
        expect(appFailure({ ...base, outcome: 'recovered', error: gatewayError('rate_limited', 429) }).retryable).toBe(true);
        expect(appFailure({ ...base, error: gatewayError('insufficient_credits', 402) }).retryable).toBe(false);
    });
    test('IDs are never repaired, bounds hold, and no message text ever appears', () => {
        const record = appFailure({ ...base, error: gatewayError('unauthorized', 401), clientRequestId: CLIENT_ID.toUpperCase(), gatewayRequestId: `${GATEWAY_ID}\n`,
            model: 'https://gateway.example.test/v1', attempts: 0, durationMs: 3_600_001, newEventId: () => SENTINEL });
        expect(record).not.toHaveProperty('clientRequestId'); expect(record).not.toHaveProperty('gatewayRequestId');
        expect(record).not.toHaveProperty('modelKey'); expect(record).not.toHaveProperty('attempt');
        expect(record.durationMs).toBe(3_600_000);
        expect(record.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(appFailure({ ...base, attempts: 99 }).attempt).toBe(64);
        for (const status of [99, 600, 200.5]) expect(appFailure({ ...base, error: gatewayError('upstream_error', status) })).not.toHaveProperty('httpStatus');
        expect(JSON.stringify(record)).not.toContain('PRIVATE');
        expect(isAppFailure(record)).toBe(true);
    });
    test('every code the producer can emit is in the contract list', () => {
        const codes = new Set(Object.keys(APP_FAILURE_CODES));
        for (const [, , code] of table) expect(codes.has(code) || code === 'unexpected_error').toBe(true);
    });
});
