// AppFailure v1: the typed, content-free record of a chat turn that failed, retried, recovered or was cancelled.
// Contract and golden fixtures: docs/CHAT-FAILURE-CAPTURE-CONTRACT.md, docs/app-failure-v1.fixtures.json.
import { randomUUID } from 'node:crypto';
import { GatewayError } from './gateway-error';
import { GatewayResponseError, sanitizeUpstreamType, type GatewayResponseReason, type UpstreamCode } from './gateway-response';

export const APP_FAILURE_VERSION = 1;
export const APP_FAILURE_CATEGORIES = ['interrupted', 'network', 'timeout', 'auth', 'credits', 'entitlement', 'rate_limit', 'provider',
    'user_cancel', 'app_startup', 'request_rejected', 'unexpected'] as const;
export type AppFailureCategory = typeof APP_FAILURE_CATEGORIES[number];
export type AppFailureStage = 'startup' | 'admission' | 'request' | 'headers' | 'stream';
export type AppFailureOutcome = 'failed' | 'retrying' | 'recovered' | 'cancelled';
export type StreamReason = 'error_event' | 'missing_terminal' | 'malformed_event' | 'connection_lost';

export type AppFailure = {
    v: typeof APP_FAILURE_VERSION; eventId: string; source: 'ezil-models'; operation: 'chat_request';
    category: AppFailureCategory; code: string; stage: AppFailureStage; outcome: AppFailureOutcome;
    streamReason?: StreamReason; upstreamCode?: UpstreamCode;
    clientRequestId?: string; gatewayRequestId?: string; retryOfClientRequestId?: string;
    attempt: number; retryable: boolean; durationMs: number; modelKey?: string; httpStatus?: number; at: string;
};

/** The closed code list (contract §3), each with its category. Anything else is `unexpected_error`. */
const CODES: Readonly<Record<string, AppFailureCategory>> = Object.freeze({
    first_byte_timeout: 'timeout', stream_idle_timeout: 'timeout', completion_timeout: 'timeout', os_completion_timeout: 'timeout',
    upstream_timeout: 'timeout',
    os_unreachable: 'network', os_ai_unavailable: 'network', connection_lost: 'network',
    stream_interrupted: 'interrupted', invalid_response: 'interrupted',
    unauthorized: 'auth', os_session_missing: 'auth', os_session_expired: 'auth', access_token_expired: 'auth', os_proxy_unauthorized: 'auth',
    no_ezil_role: 'auth', not_a_member: 'auth', role_mismatch: 'auth', forbidden: 'auth', account_suspended: 'auth', suspended: 'auth',
    insufficient_credits: 'credits', no_live_grant: 'credits', window_budget_reached: 'credits', daily_budget_reached: 'credits',
    no_entitlement: 'entitlement', model_not_allowed: 'entitlement',
    rate_limited: 'rate_limit', concurrency_limit: 'rate_limit',
    upstream_error: 'provider', upstream_unavailable: 'provider', model_disabled: 'provider', model_not_found: 'provider',
    model_unavailable: 'provider', no_provider_route: 'provider', killswitch: 'provider', paused: 'provider', global_cap_reached: 'provider',
    catalog_unavailable: 'provider', max_tokens: 'provider', response_incomplete: 'provider', response_failed: 'provider',
    idempotency_replay: 'provider',
    input_too_large: 'request_rejected', body_too_large: 'request_rejected', local_input_too_large: 'request_rejected',
    local_too_many_messages: 'request_rejected', local_too_many_blocks: 'request_rejected', invalid_request: 'request_rejected',
    unsupported_parameter: 'request_rejected', max_output_tokens_invalid: 'request_rejected', local_build_error: 'request_rejected',
    cancelled: 'user_cancel', unexpected_error: 'unexpected',
});
/** Gateway/proxy spellings that mean a listed code. */
const ALIASES: Readonly<Record<string, string>> = { pause: 'paused' };
const STREAM_REASONS: Readonly<Record<GatewayResponseReason, StreamReason>> = {
    stream_error_event: 'error_event', stream_truncated: 'missing_terminal', stream_malformed: 'malformed_event',
    connection_reset: 'connection_lost', invalid_response: 'malformed_event',
};
const RETRYABLE: ReadonlySet<AppFailureCategory> = new Set(['interrupted', 'network', 'timeout', 'rate_limit', 'provider']);
const NOT_RETRYABLE_CODES = new Set(['settlement_pending', 'model_disabled', 'model_not_found', 'model_unavailable', 'no_provider_route',
    'killswitch', 'max_tokens', 'idempotency_replay', 'catalog_unavailable']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_KEY = /^[a-z0-9][a-z0-9._:-]{0,95}$/;

// JavaScript's $ also matches before a final newline; metadata must match the entire string.
function matches(value: unknown, pattern: RegExp): value is string {
    return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
/** A lowercase canonical UUID, or undefined. */
export function sanitizeFailureId(value: unknown): string | undefined {
    return typeof value === 'string' && matches(value.toLowerCase(), UUID) ? value.toLowerCase() : undefined;
}
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));

export type AppFailureInput = {
    outcome: AppFailureOutcome;
    /** The error that failed the turn, or that the next attempt retries. Only its typed fields are read, never its message. */
    error?: unknown;
    stage: AppFailureStage;
    model: string;
    clientRequestId?: string;
    retryOfClientRequestId?: string;
    gatewayRequestId?: string;
    /** Sends made so far in this turn; 0 when it ended before any send. */
    attempts: number;
    durationMs: number;
    at: number;
    newEventId?: () => string;
};

/** Pure metadata projection. Never reads messages, causes, event bodies, headers or any other error property. */
export function appFailure(input: AppFailureInput): AppFailure {
    const cancelled = input.outcome === 'cancelled';
    const error = !cancelled && (input.error instanceof GatewayError || input.error instanceof GatewayResponseError) ? input.error : undefined;
    const raw = error?.code === undefined ? undefined : ALIASES[error.code] ?? error.code;
    const code = cancelled ? 'cancelled' : raw !== undefined && Object.hasOwn(CODES, raw) && raw !== 'cancelled' ? raw : 'unexpected_error';
    const category = CODES[code];
    const status = error instanceof GatewayError ? error.status : undefined;
    const reason = error instanceof GatewayResponseError ? STREAM_REASONS[error.reason] : undefined;
    // A read failure after the reply began is still the stream breaking off: report it as interrupted, with its reason.
    const stage = cancelled ? input.stage : reason ? 'stream' : input.stage;
    const streamReason = category === 'interrupted' && stage === 'stream' ? reason ?? 'malformed_event' : undefined;
    const upstreamCode = streamReason === 'error_event' && error instanceof GatewayResponseError ? sanitizeUpstreamType(error.upstreamType) : undefined;
    const clientRequestId = sanitizeFailureId(input.clientRequestId);
    const retryOf = sanitizeFailureId(input.retryOfClientRequestId);
    const gatewayRequestId = sanitizeFailureId(input.gatewayRequestId);
    const modelKey = matches(input.model, MODEL_KEY) ? input.model : undefined;
    const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const retryable = !cancelled && RETRYABLE.has(category) && !NOT_RETRYABLE_CODES.has(code) && !(upstreamCode && NOT_RETRYABLE_CODES.has(upstreamCode));
    const eventId = sanitizeFailureId((input.newEventId ?? randomUUID)()) ?? randomUUID();
    return {
        v: APP_FAILURE_VERSION, eventId, source: 'ezil-models', operation: 'chat_request', category, code, stage, outcome: input.outcome,
        ...(streamReason ? { streamReason } : {}), ...(upstreamCode ? { upstreamCode } : {}),
        ...(clientRequestId ? { clientRequestId } : {}), ...(gatewayRequestId ? { gatewayRequestId } : {}),
        ...(retryOf && retryOf !== clientRequestId ? { retryOfClientRequestId: retryOf } : {}),
        attempt: clamp(input.attempts, 1, 64), retryable: input.outcome === 'retrying' || input.outcome === 'recovered' ? true : retryable,
        durationMs: clamp(input.durationMs, 0, 3_600_000), ...(modelKey ? { modelKey } : {}), ...(httpStatus ? { httpStatus } : {}),
        at: new Date(Number.isFinite(input.at) ? input.at : 0).toISOString(),
    };
}
