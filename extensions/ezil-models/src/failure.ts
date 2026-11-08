// The app-failure record a chat turn produces when it fails, retries, recovers or is cancelled: typed, content-free.
// Canonical contract (owned by the feedback lane): docs/FEEDBACK-APP-FAILURES-CONTRACT.md §2-§3, golden fixtures
// app/src/server/feedback/app-failures.fixtures.json. This file only produces it; it adds no field of its own.
import { randomUUID } from 'node:crypto';
import { GatewayError } from './gateway-error';
import { GatewayResponseError, type GatewayResponseReason } from './gateway-response';

export type AppFailureCategory = 'interrupted' | 'network' | 'timeout' | 'auth' | 'credits' | 'entitlement' | 'rate_limit' | 'provider'
    | 'cancellation' | 'app_startup';
export type AppFailureStage = 'startup' | 'admission' | 'request' | 'headers' | 'stream';
export type AppFailureOutcome = 'failed' | 'retrying' | 'recovered' | 'cancelled';
export type StreamReason = 'eof' | 'malformed_event' | 'missing_terminal';
export type CancellationSource = 'caller' | 'user_stop' | 'unknown';

export type AppFailure = {
    eventId: string; source: 'ezil_chat'; operation: 'chat_request' | 'app_start'; category: AppFailureCategory; code: string;
    stage: AppFailureStage; outcome: AppFailureOutcome; streamReason?: StreamReason; cancellationSource?: CancellationSource;
    clientRequestId?: string; gatewayRequestId?: string; attempt?: number; retryable?: boolean; durationMs?: number;
    modelKey?: string; httpStatus?: number;
};

/** Contract §3: each code with the one category it is valid in. */
export const APP_FAILURE_CODES: Readonly<Record<string, AppFailureCategory>> = Object.freeze({
    stream_interrupted: 'interrupted',
    network_offline: 'network', network_failed: 'network',
    request_timeout: 'timeout', first_token_timeout: 'timeout',
    auth_expired: 'auth', auth_invalid: 'auth', session_expired: 'auth',
    credits_exhausted: 'credits',
    membership_required: 'entitlement', model_not_entitled: 'entitlement',
    rate_limited: 'rate_limit',
    provider_error: 'provider', provider_overloaded: 'provider', provider_refused: 'provider', model_unavailable: 'provider',
    request_cancelled: 'cancellation',
    app_start_failed: 'app_startup', app_start_timeout: 'app_startup', chat_unavailable: 'app_startup',
});

/** EZiL Models, OS proxy and Gateway codes -> the contract's code. Anything absent is `unexpected_error`. */
const FROM_CODE: Readonly<Record<string, string>> = Object.freeze({
    first_byte_timeout: 'first_token_timeout', stream_idle_timeout: 'request_timeout', completion_timeout: 'request_timeout',
    os_completion_timeout: 'request_timeout', upstream_timeout: 'request_timeout',
    os_unreachable: 'network_failed', os_ai_unavailable: 'network_failed', connection_lost: 'network_failed',
    stream_interrupted: 'stream_interrupted', invalid_response: 'stream_interrupted',
    access_token_expired: 'auth_expired', os_session_expired: 'session_expired', os_session_missing: 'auth_invalid',
    unauthorized: 'auth_invalid', os_proxy_unauthorized: 'auth_invalid', account_suspended: 'auth_invalid', suspended: 'auth_invalid',
    insufficient_credits: 'credits_exhausted', no_live_grant: 'credits_exhausted', window_budget_reached: 'credits_exhausted',
    daily_budget_reached: 'credits_exhausted',
    no_ezil_role: 'membership_required', not_a_member: 'membership_required', role_mismatch: 'membership_required',
    forbidden: 'membership_required', no_entitlement: 'membership_required', model_not_allowed: 'model_not_entitled',
    rate_limited: 'rate_limited', concurrency_limit: 'rate_limited',
    upstream_error: 'provider_error', upstream_unavailable: 'provider_error', idempotency_replay: 'provider_error',
    response_incomplete: 'provider_error', response_failed: 'provider_error', max_tokens: 'provider_error',
    model_disabled: 'model_unavailable', model_not_found: 'model_unavailable', model_unavailable: 'model_unavailable',
    no_provider_route: 'model_unavailable', catalog_unavailable: 'model_unavailable', killswitch: 'model_unavailable',
    paused: 'model_unavailable', pause: 'model_unavailable', global_cap_reached: 'model_unavailable',
});
/** The code an SSE error event named (Gateway src/app.ts streamErrorEvent, or the provider's error type). */
const FROM_STREAM_ERROR: Readonly<Record<string, string>> = Object.freeze({
    stream_interrupted: 'stream_interrupted', upstream_timeout: 'request_timeout', timeout_error: 'request_timeout',
    settlement_pending: 'provider_error', upstream_error: 'provider_error', api_error: 'provider_error',
    overloaded_error: 'provider_overloaded', rate_limit_error: 'rate_limited',
});
const STREAM_REASONS: Readonly<Record<GatewayResponseReason, StreamReason | undefined>> = {
    stream_error_event: undefined, stream_truncated: 'missing_terminal', stream_malformed: 'malformed_event',
    connection_reset: 'eof', invalid_response: 'malformed_event',
};
const RETRYABLE = new Set(['stream_interrupted', 'network_offline', 'network_failed', 'request_timeout', 'first_token_timeout',
    'rate_limited', 'provider_error', 'provider_overloaded']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_KEY = /^[a-z0-9][a-z0-9._:/-]{0,63}$/;
// Exact mirror of app/src/server/feedback/types.ts: isSafeModelKey and its allowlist.
export const MODEL_KEY_NAMESPACES = Object.freeze([
    'anthropic', 'openai', 'google', 'gemini', 'vertex', 'bedrock', 'aws-bedrock', 'amazon', 'azure',
    'qwen', 'moonshot', 'moonshotai', 'kimi', 'zai', 'z-ai', 'glm', 'deepseek', 'mistral', 'meta', 'llama',
    'xai', 'cohere', 'minimax', 'groq', 'cerebras', 'openrouter', 'ezil',
]);
const NAMESPACES = new Set<string>(MODEL_KEY_NAMESPACES);
/** Model families a bare key (no namespace) may start with, e.g. `claude-sonnet-5-5`, `ezil-fast`. */
export const MODEL_KEY_FAMILIES = Object.freeze([
    'claude', 'gemini', 'gpt', 'qwen', 'kimi', 'glm', 'deepseek', 'mistral', 'codestral', 'llama', 'grok',
    'nova', 'ezil', 'minimax', 'command', 'sonar',
]);
const FAMILIES = new Set<string>(MODEL_KEY_FAMILIES);
const REGION = /^(?:us|eu|apac|global|au|jp)\./;
const TOKEN_WORD = /secret|token|passw|bearer|api[-_]?key|private|credential|session|cookie/;
const TOKEN_PREFIX = /^(?:sk|sb|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr])[-_]/;

export function isSafeModelKey(value: unknown): value is string {
    // `$` also matches before a final newline, hence the explicit exact test.
    if (typeof value !== 'string' || !MODEL_KEY.test(value) || value !== value.trim()) return false;
    if (value.includes('://') || value.split('/').length > 2) return false;
    // An optional inference-region prefix, then `ns/model`, `ns.model` or a bare family key.
    const key = value.replace(REGION, '');
    const match = /^([a-z0-9-]+)[/.](.+)$/.exec(key);
    let model: string;
    if (match && NAMESPACES.has(match[1]!)) model = match[2]!;
    else if (FAMILIES.has(/^[a-z]+/.exec(key)?.[0] ?? '')) model = key;
    else return false;
    const segments = model.split(/[/.:]/);
    if (segments.some(segment => !segment || TOKEN_PREFIX.test(segment) || TOKEN_WORD.test(segment)
        || /[a-z0-9]{20,}/.test(segment))) return false;
    // The model name itself carries a version or a family separator.
    return /[0-9-]/.test(segments[0]!);
}

/** A credential prefix as a whole part (`claude-sk-…`, `gemini-ghp_…`, `anthropic/claude-xoxb-…`, `ezil-pat-…`). */
const CREDENTIAL_PART = /^(?:sk|sb|pk|rk|ghp|gho|ghs|ghu|github|pat|xox[abpr])$/;
/**
 * What the producer emits as modelKey: the consumer's predicate, and also no credential prefix or credential word in
 * ANY part delimited by `/ . : _ -` (the consumer checks prefixes only at a segment's start). Stricter than the consumer
 * on purpose: an unsafe optional key is omitted here, before emitting, so it can never cost the record or its IDs.
 */
export function emittableModelKey(value: unknown): value is string {
    return isSafeModelKey(value) && !value.split(/[/.:_-]/).some(part => CREDENTIAL_PART.test(part) || TOKEN_WORD.test(part));
}

// JavaScript's $ also matches before a final newline; metadata must match the entire string.
function matches(value: unknown, pattern: RegExp): value is string {
    return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
/** A canonical lowercase UUID as given, else undefined: an ID is never case-folded or repaired into one. */
export function failureId(value: unknown): string | undefined {
    return matches(value, UUID) ? value : undefined;
}
const integer = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;

export type AppFailureInput = {
    outcome: AppFailureOutcome;
    /** The error that failed the turn, or that the next attempt retries. Only its typed code, status and reason are read. */
    error?: unknown;
    /** For `cancelled` only: what the cancellation proves. The outer token alone proves only `caller`. */
    cancellationSource?: CancellationSource;
    stage: AppFailureStage;
    model: string;
    clientRequestId?: string;
    gatewayRequestId?: string;
    /** Sends made so far in this turn; omitted from the record when none was made. */
    attempts: number;
    durationMs: number;
    newEventId?: () => string;
};

/** Pure metadata projection. Never reads an error's message, cause, stack, body, headers or any other property. */
export function appFailure(input: AppFailureInput): AppFailure {
    const cancelled = input.outcome === 'cancelled';
    const error = cancelled ? undefined : input.error instanceof GatewayError || input.error instanceof GatewayResponseError ? input.error : undefined;
    const status = error instanceof GatewayError && integer(error.status ?? NaN, 100, 599) ? error.status : undefined;
    let code: string;
    let streamReason: StreamReason | undefined;
    let stage = input.stage;
    if (cancelled) code = 'request_cancelled';
    else if (error instanceof GatewayResponseError) {
        // The reply had begun (headers 2xx): whatever broke it, it broke in the stream.
        stage = 'stream';
        code = error.reason === 'stream_error_event' ? FROM_STREAM_ERROR[error.upstreamType ?? ''] ?? 'stream_interrupted' : 'stream_interrupted';
        if (code === 'stream_interrupted') streamReason = STREAM_REASONS[error.reason];
    } else {
        const mapped = error?.code === undefined ? undefined : FROM_CODE[error.code];
        code = mapped ?? (status === 401 ? 'auth_invalid' : status === 402 ? 'credits_exhausted' : status === 403 ? 'membership_required'
            : status === 429 ? 'rate_limited' : 'unexpected_error');
    }
    // Every mapped code is in the contract list; one that is not is sent as unexpected_error, never as itself.
    const listed: AppFailureCategory | undefined = code === 'unexpected_error' ? undefined : APP_FAILURE_CODES[code];
    if (!listed) code = 'unexpected_error';
    const category: AppFailureCategory = listed ?? (error?.origin === 'transport' ? 'network' : 'provider');
    const eventId = failureId((input.newEventId ?? randomUUID)()) ?? randomUUID();
    const clientRequestId = failureId(input.clientRequestId);
    const gatewayRequestId = failureId(input.gatewayRequestId);
    const durationMs = Math.round(input.durationMs);
    return {
        eventId, source: 'ezil_chat', operation: 'chat_request', category, code, stage, outcome: input.outcome,
        ...(streamReason && stage === 'stream' ? { streamReason } : {}),
        ...(cancelled ? { cancellationSource: input.cancellationSource ?? 'unknown' } : {}),
        ...(clientRequestId ? { clientRequestId } : {}), ...(gatewayRequestId ? { gatewayRequestId } : {}),
        ...(integer(input.attempts, 1, 64) ? { attempt: input.attempts } : input.attempts > 64 ? { attempt: 64 } : {}),
        ...(cancelled ? {} : { retryable: input.outcome !== 'failed' || RETRYABLE.has(code) && error?.code !== 'settlement_pending'
            && !(error instanceof GatewayResponseError && error.upstreamType === 'settlement_pending') }),
        ...(integer(durationMs, 0, 3_600_000) ? { durationMs } : durationMs > 3_600_000 ? { durationMs: 3_600_000 } : {}),
        ...(emittableModelKey(input.model) ? { modelKey: input.model } : {}),
        // A recovered record names what was retried (its code) under the successful attempt's IDs; the retried
        // attempt's HTTP status belongs to that earlier attempt, so it is never paired with the new Gateway ID.
        ...(status !== undefined && input.outcome !== 'recovered' ? { httpStatus: status } : {}),
    };
}

const KEYS = new Set(['eventId', 'source', 'operation', 'category', 'code', 'stage', 'outcome', 'streamReason', 'cancellationSource',
    'clientRequestId', 'gatewayRequestId', 'vscodeRequestId', 'retryOfClientRequestId', 'attempt', 'retryable', 'durationMs', 'modelKey', 'httpStatus']);
const ENUMS: Readonly<Record<string, readonly string[]>> = {
    source: ['ezil_chat', 'code_app'], operation: ['chat_request', 'app_start'],
    stage: ['startup', 'admission', 'request', 'headers', 'stream'], outcome: ['failed', 'retrying', 'recovered', 'cancelled'],
    streamReason: ['eof', 'malformed_event', 'missing_terminal'], cancellationSource: ['caller', 'user_stop', 'unknown'],
};

/** Contract §2 exactly, as the shell validates it: the producer checks its own record before it leaves. */
export function isAppFailure(value: unknown): value is AppFailure {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const r = value as Record<string, unknown>;
    if (!Object.keys(r).every(key => KEYS.has(key))) return false;
    for (const [key, allowed] of Object.entries(ENUMS)) if (r[key] !== undefined && !allowed.includes(r[key] as string)) return false;
    if (!failureId(r.eventId) || r.source === undefined || r.operation === undefined || r.stage === undefined || r.outcome === undefined) return false;
    if (typeof r.category !== 'string' || typeof r.code !== 'string') return false;
    if (r.code !== 'unexpected_error' && APP_FAILURE_CODES[r.code] !== r.category) return false;
    if (r.code === 'unexpected_error' && !Object.values(APP_FAILURE_CODES).includes(r.category as AppFailureCategory)) return false;
    if (r.streamReason !== undefined && r.stage !== 'stream') return false;
    if ((r.category === 'cancellation') !== (r.cancellationSource !== undefined)) return false;
    if (r.outcome === 'cancelled' && r.category !== 'cancellation') return false;
    if (r.category === 'cancellation' && (r.code !== 'request_cancelled' || r.outcome !== 'cancelled')) return false;
    for (const key of ['clientRequestId', 'gatewayRequestId', 'vscodeRequestId', 'retryOfClientRequestId']) if (r[key] !== undefined && !failureId(r[key])) return false;
    if (r.attempt !== undefined && !integer(r.attempt as number, 1, 64)) return false;
    if (r.retryable !== undefined && typeof r.retryable !== 'boolean') return false;
    if (r.durationMs !== undefined && !integer(r.durationMs as number, 0, 3_600_000)) return false;
    if (r.modelKey !== undefined && !isSafeModelKey(r.modelKey)) return false;
    if (r.httpStatus !== undefined && !integer(r.httpStatus as number, 100, 599)) return false;
    return true;
}
