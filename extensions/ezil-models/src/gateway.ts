// EZiL AI gateway transport (provider type `ezil-gateway`): one Idempotency-Key per chat turn, the body
// serialized once and the same bytes reused on the only retries the contract allows, error mapping by
// `error.code`, the `/v1/models` limits cache and the credit states. ezil-ai-gateway
// docs/OS-INTEGRATION-CONTRACT.md §2-§9; in EZiL OS the base URL is the Worker proxy on the computer's own
// code host (`$EZIL_AI_BASE_URL`, `.../ai/v1`), authenticated by `$EZIL_AI_PROXY_TOKEN`.

import { randomUUID } from 'node:crypto';
import { redact, type ResolvedModel, type ResolvedProvider } from './config';
import { sseEvents } from './sse';
import { buildGatewayBody } from './gateway-messages';
import { gatewayJson, gatewayStream, GatewayResponseError } from './gateway-response';
import { emptyUsage } from './types';
import { localResetTime } from './status-data';
import type { ChatRequest, StreamEvent } from './types';

export const GATEWAY_FIRST_BYTE_TIMEOUT_MS = 30_000;
export const GATEWAY_IDLE_TIMEOUT_MS = 30_000;
/** Coupled to the Gateway's default `per_user_concurrency`; shared by all models for an identity. */
export const GATEWAY_MAX_IN_FLIGHT = 2;
const CONCURRENCY_WAIT_BUDGET_MS = 60_000;
const MODELS_TTL_MS = 5 * 60_000;
const SIDE_CALL_TIMEOUT_MS = 5_000;
const MICRO_PER_CREDIT = 1_000_000;

/** A gateway (or OS proxy) refusal, carrying what the UI and the log need. */
export class GatewayError extends Error {
    constructor(
        message: string,
        public readonly status: number | undefined,
        public readonly code: string | undefined,
        public readonly requestId: string | undefined,
        public readonly retryAfterSeconds?: number,
    ) {
        super(message);
        this.name = 'GatewayError';
    }
}

export type GatewayOptions = {
    signal: AbortSignal;
    fetch?: typeof fetch;
    /** Mints the per-turn key; injectable for tests. */
    newIdempotencyKey?: () => string;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    now?: () => number;
    log?: (line: string) => void;
    /** Called with the built request (no credentials) before it is sent. */
    onRequest?: (url: string, built: ReturnType<typeof buildGatewayBody>, idempotencyKey: string) => void;
};

// ── /v1/models limits (cached) and credits ────────────────────────────────────

export type GatewayModel = { id: string; enabled: boolean; max_input_tokens: number; max_output_tokens: number };
export type GatewayModels = { killswitch: boolean; pause: 'operations' | 'reconciliation' | null; data: GatewayModel[] };
export type GatewayGrant = { remaining_micro: number; live: boolean };
export type GatewayBalance = { state?: string; available_micro: number; held_micro: number; grants: GatewayGrant[] };

// Only Bearer auth is sent by this transport. Equivalent resolved providers must share admission
// and catalog state; neither their display name nor ignored custom headers change the identity.
function providerIdentity(provider: ResolvedProvider): string {
    return JSON.stringify([provider.baseUrl, provider.apiKey ?? '']);
}

const modelsCache = new Map<string, { baseUrl: ResolvedProvider['baseUrl']; at: number; models: GatewayModels }>();

/** Clear the `/v1/models` cache after availability/limit refusals, and in tests. */
export function forgetGatewayModels(baseUrl?: string): void {
    if (baseUrl === undefined) modelsCache.clear();
    else for (const [key, cached] of modelsCache) if (cached.baseUrl === baseUrl) modelsCache.delete(key);
}

function authHeaders(provider: ResolvedProvider): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${provider.apiKey ?? ''}` };
    return headers;
}

async function getJson(provider: ResolvedProvider, path: string, doFetch: typeof fetch, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
    const timeout = AbortSignal.timeout(SIDE_CALL_TIMEOUT_MS);
    const response = await doFetch(`${provider.baseUrl}${path}`, {
        headers: authHeaders(provider),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
    });
    const text = await response.text().catch(() => '');
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: response.status, json };
}

function asModels(json: unknown): GatewayModels | undefined {
    if (typeof json !== 'object' || json === null || !Array.isArray((json as GatewayModels).data)) return undefined;
    const raw = json as Record<string, unknown>;
    if (raw.data === undefined || !Array.isArray(raw.data) || raw.data.some(entry => typeof entry !== 'object' || entry === null
        || typeof entry.id !== 'string' || typeof entry.enabled !== 'boolean'
        || !Number.isSafeInteger(entry.max_input_tokens) || entry.max_input_tokens <= 0
        || !Number.isSafeInteger(entry.max_output_tokens) || entry.max_output_tokens <= 0)) return undefined;
    return { killswitch: raw.killswitch === true, pause: raw.pause === 'operations' || raw.pause === 'reconciliation' ? raw.pause : null, data: raw.data as GatewayModel[] };
}

/** Apply validated catalog caps without mutating config; callers still apply wire clamps/reserves. */
export function withGatewayModelLimits(model: ResolvedModel, catalog: GatewayModels | undefined): ResolvedModel {
    const entry = catalog?.data.find(entry => entry.id === model.model);
    if (!entry || model.provider.type !== 'ezil-gateway') return model;
    return { ...model, maxInputTokens: Math.min(model.maxInputTokens, entry.max_input_tokens),
        maxOutputTokens: Math.min(model.maxOutputTokens, entry.max_output_tokens) };
}

/** `GET /v1/models`, cached for five minutes per base URL + auth context. `undefined` when it cannot be read. */
export async function gatewayModels(provider: ResolvedProvider, doFetch: typeof fetch, now: number = Date.now(), signal?: AbortSignal): Promise<GatewayModels | undefined> {
    const key = providerIdentity(provider);
    const cached = modelsCache.get(key);
    if (cached && now - cached.at < MODELS_TTL_MS) return cached.models;
    try {
        const { status, json } = await getJson(provider, '/models', doFetch, signal);
        const models = status === 200 ? asModels(json) : undefined;
        if (models) modelsCache.set(key, { baseUrl: provider.baseUrl, at: now, models });
        return models;
    } catch {
        return undefined;
    }
}

export async function gatewayBalance(provider: ResolvedProvider, doFetch: typeof fetch, signal?: AbortSignal): Promise<GatewayBalance | undefined> {
    try {
        const { status, json } = await getJson(provider, '/me/balance', doFetch, signal);
        if (status !== 200 || typeof json !== 'object' || json === null) return undefined;
        const raw = json as Record<string, unknown>;
        if (!Number.isSafeInteger(raw.available_micro) || (raw.available_micro as number) < 0 || !Number.isSafeInteger(raw.held_micro) || (raw.held_micro as number) < 0 || !Array.isArray(raw.grants)
            || raw.grants.some(grant => typeof grant !== 'object' || grant === null || typeof grant.live !== 'boolean')) return undefined;
        return raw as unknown as GatewayBalance;
    } catch {
        return undefined;
    }
}

export type CreditState =
    | 'unknown'
    | 'paused_reconciliation' | 'paused_operations' | 'model_disabled'
    | 'used' | 'expired' | 'not_included' | 'held' | 'ok';

export const CREDIT_STATE_TEXT: Record<CreditState, string> = {
    unknown: 'AI credit balance is unavailable.',
    paused_reconciliation: 'AI is paused while usage is being reconciled. Your credits are safe.',
    paused_operations: 'AI is temporarily unavailable. Your credits are safe.',
    model_disabled: 'This model is not available right now.',
    used: 'You have used your included AI credits.',
    expired: 'Your AI credits have expired.',
    not_included: 'AI credits are not included for this account.',
    held: 'Your credits are held by requests in progress or being settled.',
    ok: 'AI credits available.',
};

/** Contract §7 "Credit UX states", evaluated top to bottom. Either input may be unknown. */
export function creditState(models: GatewayModels | undefined, balance: GatewayBalance | undefined, alias: string): { state: CreditState; text: string; credits?: number } {
    const pick = (state: CreditState, credits?: number) => ({ state, text: state === 'ok' && credits !== undefined ? `AI credits: ${credits} remaining` : CREDIT_STATE_TEXT[state], ...(credits === undefined ? {} : { credits }) });
    if (models?.killswitch) return pick(models.pause === 'reconciliation' ? 'paused_reconciliation' : 'paused_operations');
    if (models && models.data.find(entry => entry.id === alias)?.enabled === false) return pick('model_disabled');
    if (!balance) return pick('unknown');
    if (balance.available_micro === 0 && balance.held_micro === 0) {
        if (balance.grants.some(grant => grant.live)) return pick('used');
        return pick(balance.grants.length ? 'expired' : 'not_included');
    }
    if (balance.available_micro === 0 && balance.held_micro > 0) return pick('held');
    return pick('ok', balance.available_micro / MICRO_PER_CREDIT);
}

// ── error mapping (by error.code, never by message; contract §8) ─────────────

type ErrorBody = { code?: string; message?: string; request_id?: string; reason?: string; pause?: string; param?: string;
    no_live_grant?: boolean; available_micro?: number; hold_micro?: number; input_bound_tokens?: number; max_input_tokens?: number; status?: string };

export function parseErrorBody(text: string): ErrorBody {
    try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === 'object' && parsed.error !== null) return parsed.error as ErrorBody;
    } catch { /* not JSON (an edge error page) */ }
    return {};
}

export function retryDelay(value: string | null, fallback = 5, now = Date.now()): number {
    const seconds = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value ? (Date.parse(value) - now) / 1000 : fallback;
    return Math.min(60, Math.max(0, Number.isFinite(seconds) ? seconds : fallback));
}

export function describeGatewayError(alias: string, status: number, retryAfter: string | null, body: ErrorBody, headerRequestId: string | null,
    balance?: GatewayBalance, now = Date.now()): GatewayError {
    const requestId = body.request_id ?? headerRequestId ?? undefined;
    const ref = requestId ? ` (request ${requestId})` : '';
    const code = body.code;
    const make = (message: string) => new GatewayError(`EZiL AI: ${message}${ref}`, status, code, requestId, retryDelay(retryAfter));
    if (body.reason === 'no_ezil_role' || code === 'no_ezil_role') return make('Your EZiL account has no AI access yet');
    switch (code) {
        case 'window_budget_reached': {
            // This is a reset deadline, not a retry delay: never cap it to the transport's 60 seconds.
            const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : retryAfter ? (Date.parse(retryAfter) - now) / 1000 : NaN;
            const reset = new Date(now + Math.max(0, delay) * 1000);
            const seconds = Number.isFinite(reset.getTime()) ? Math.max(0, Math.ceil(delay)) : undefined;
            return new GatewayError(`EZiL AI: This window's EZiL AI credits are used up. ${seconds === undefined
                ? 'Check EZiL AI status for the reset time.' : `Resets at ${localResetTime(reset)} (local time).`}${ref}`,
                status, code, requestId, seconds);
        }
        case 'insufficient_credits': case 'no_live_grant': {
            const available = body.available_micro ?? balance?.available_micro;
            const state = balance ? creditState(undefined, balance, alias).text : body.no_live_grant || code === 'no_live_grant'
                ? 'No live AI credit grant.' : 'Not enough AI credits for this request.';
            return make(`${state}${available !== undefined ? ` Available credits: ${available / MICRO_PER_CREDIT}.` : ''}`);
        }
        // The OS app delivers a session only for accounts with an EZiL AI role (ai-credential.ts), so a missing
        // session means either no AI access on this account or no delivered sign-in yet: say both.
        case 'os_session_missing': return make('EZiL AI is not available here yet: this account has no EZiL AI access, or this computer has not received your sign-in. Reopen Code to retry');
        case 'os_session_expired': case 'access_token_expired': return make('Your OS sign-in has expired. Reopen Code or sign in again');
        case 'os_proxy_unauthorized': return make('EZiL OS refused this computer’s AI connection. Restart the computer to reconnect');
        case 'unauthorized':
            if (body.reason === 'token_expired' || body.reason === 'expired') return make('Your AI sign-in has expired. Reopen Code or sign in again');
            if (body.reason === 'wrong_issuer') return make('EZiL AI does not accept this account’s sign-in (this OS environment is not connected to EZiL AI)');
            if (body.reason === 'bad_signature') return make('EZiL AI could not verify this account’s sign-in signature. Contact your administrator');
            return make('EZiL AI refused this account’s sign-in. Contact your administrator');
        case 'os_ai_unavailable': return make('EZiL OS could not reach EZiL AI. Retry the request');
        case 'not_a_member': case 'role_mismatch': case 'forbidden': return make('Your EZiL account does not have AI membership');
        case 'account_suspended': case 'suspended': return make('AI access is suspended for your EZiL account');
        case 'input_too_large': case 'body_too_large': return make('Conversation too large — start a new chat');
        case 'unsupported_bedrock_converse_request': case 'unsupported_parameter': case 'invalid_request':
        case 'max_output_tokens_invalid': case 'idempotency_conflict': case 'idempotency_key_required':
            return make(`Internal EZiL Models bug (${code}); please report it`);
        case 'killswitch': return make(body.pause === 'reconciliation' ? 'AI is paused while usage is reconciled' : 'AI is paused by operations');
        case 'paused': case 'pause': case 'global_cap_reached': return make('AI is temporarily paused');
        case 'no_provider_route': case 'model_disabled': case 'model_not_found': return make('This model is temporarily unavailable');
        case 'upstream_timeout': return make('The model provider did not answer in time');
        case 'idempotency_replay': return make('already processed');
        case 'rate_limited': return make('Too many requests; try again later');
        case 'concurrency_limit': return make('Wait for the current response to finish');
        default:
            if (status === 401) return make('The AI service refused authentication. Contact your administrator');
            if (status === 402) return make('No AI credits available');
            if (status === 403) return make('Your EZiL account does not have AI access');
            if (status === 413) return make('Conversation too large — start a new chat');
            return make(`AI request failed (${code ?? `HTTP ${status}`})`);
    }
}

// ── the turn ──────────────────────────────────────────────────────────────────

type AdmissionGate = { active: number; queue: (() => void)[] };
const admissionGates = new Map<string, AdmissionGate>();

/** FIFO admission; only retries after a server concurrency refusal have a queue deadline. */
function acquireGatewaySlot(key: string, signal: AbortSignal, budget?: { ms: number; error: GatewayError }): Promise<() => void> {
    signal.throwIfAborted();
    const gate = admissionGates.get(key) ?? { active: 0, queue: [] };
    admissionGates.set(key, gate);
    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
        const enter = () => {
            cleanup();
            gate.active++;
            let released = false;
            resolve(() => {
                if (released) return;
                released = true;
                gate.active--;
                const next = gate.queue.shift();
                if (next) next();
                else if (gate.active === 0) admissionGates.delete(key);
            });
        };
        const leave = (error: unknown) => {
            const index = gate.queue.indexOf(enter);
            if (index >= 0) gate.queue.splice(index, 1);
            cleanup();
            reject(error);
        };
        const onAbort = () => leave(signal.reason);
        if (gate.active < GATEWAY_MAX_IN_FLIGHT) { enter(); return; }
        if (budget && budget.ms <= 0) { reject(budget.error); return; }
        gate.queue.push(enter);
        signal.addEventListener('abort', onAbort, { once: true });
        if (budget) timer = setTimeout(() => leave(budget.error), budget.ms);
    });
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Race I/O as well as aborting it: even a transport that ignores abort cannot keep Thinking alive. */
async function bounded<T>(work: Promise<T>, ms: number, abort: AbortController, error: GatewayError): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const deadline = new Promise<never>((_, reject) => {
        onAbort = () => reject(abort.signal.reason);
        timer = setTimeout(() => abort.abort(error), Math.max(1, ms));
        abort.signal.addEventListener('abort', onAbort, { once: true });
        if (abort.signal.aborted) onAbort();
    });
    try { return await Promise.race([work, deadline]); }
    finally { clearTimeout(timer); abort.signal.removeEventListener('abort', onAbort); }
}

async function timedResponse(doFetch: typeof fetch, url: string, init: RequestInit, abort: AbortController): Promise<Response> {
    const started = performance.now();
    const timeout = (code: string, requestId?: string) => new GatewayError(
        `EZiL AI: ${code === 'first_byte_timeout' ? 'did not answer within 30 seconds' : 'the response stopped arriving'}. Retry the request${requestId ? ` (request ${requestId})` : ''}`,
        undefined, code, requestId);
    const response = await bounded(doFetch(url, { ...init, signal: abort.signal }), GATEWAY_FIRST_BYTE_TIMEOUT_MS, abort, timeout('first_byte_timeout'));
    if (!response.body) return response;
    const reader = response.body.getReader();
    const requestId = response.headers.get('x-ezil-request-id') ?? undefined;
    let first = true;
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const next = await bounded(reader.read(), first ? GATEWAY_FIRST_BYTE_TIMEOUT_MS - (performance.now() - started) : GATEWAY_IDLE_TIMEOUT_MS,
                    abort, timeout(first ? 'first_byte_timeout' : 'stream_idle_timeout', requestId));
                first = false;
                if (next.done) controller.close();
                else controller.enqueue(next.value);
            } catch (error) {
                void reader.cancel().catch(() => {});
                controller.error(error);
            }
        },
        cancel() { abort.abort(); void reader.cancel().catch(() => {}); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, headers: response.headers });
}

/** One UUID and serialization, bounded admission retries. No retries after generation starts. */
export async function* gatewayChat(model: ResolvedModel, request: ChatRequest, options: GatewayOptions): AsyncGenerator<StreamEvent> {
    const provider = model.provider;
    const doFetch = options.fetch ?? fetch;
    const now = options.now ?? Date.now;
    const started = now();
    const log = (line: string) => options.log?.(redact(line, [provider.apiKey ?? '', ...Object.values(provider.headers)]));
    const idempotencyKey = (options.newIdempotencyKey ?? randomUUID)();
    let requestId: string | undefined;
    let hold: string | null = null;
    let status: number | undefined;
    let stopReason: string | undefined;
    let errorCode: string | undefined;
    let stream = model.model !== 'us.moonshotai.kimi-k3' && model.stream !== false;
    let used = emptyUsage();
    let attemptAbort = new AbortController();
    const cancelAttempt = () => attemptAbort.abort(options.signal.reason);
    options.signal.addEventListener('abort', cancelAttempt, { once: true });
    try {
        options.signal.throwIfAborted();
        const built = buildGatewayBody(model, request, log);
        stream = built.body.stream;
        const url = `${provider.baseUrl}/messages`;
        // Callback is for tests/integration, never used for gateway prompt logging.
        options.onRequest?.(url, built, idempotencyKey);
        const headers = { ...authHeaders(provider), 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', 'idempotency-key': idempotencyKey };
        const identity = providerIdentity(provider);
        let retried = false;
        let concurrencyStarted: number | undefined;
        let concurrencyWaited = 0;
        let concurrencyRetries = 0;
        let concurrencyError: GatewayError | undefined;
        // Count both requested sleeps (also with injected clocks) and elapsed time, including re-queueing.
        const remainingWait = () => Math.max(0, CONCURRENCY_WAIT_BUDGET_MS - Math.max(concurrencyWaited,
            concurrencyStarted === undefined ? 0 : now() - concurrencyStarted));
        for (;;) {
            options.signal.throwIfAborted();
            const release = await acquireGatewaySlot(identity, options.signal,
                concurrencyError ? { ms: remainingWait(), error: concurrencyError } : undefined);
            let waitMs: number;
            try {
                options.signal.throwIfAborted();
                if (concurrencyError && now() - concurrencyStarted! > CONCURRENCY_WAIT_BUDGET_MS) throw concurrencyError;
                attemptAbort = new AbortController();
                let response: Response;
                try {
                    response = await timedResponse(doFetch, url, { method: 'POST', headers, body: built.bytes, redirect: 'error' }, attemptAbort);
                } catch (error) {
                    if (options.signal.aborted || attemptAbort.signal.reason instanceof GatewayError) throw error;
                    if (!retried) { retried = true; continue; }
                    throw new GatewayError('EZiL AI: cannot reach EZiL AI. Retry the request', undefined, 'os_unreachable', requestId);
                }
                status = response.status;
                hold = response.headers.get('x-ezil-hold-micro');
                requestId = response.headers.get('x-ezil-request-id') ?? undefined;
                if (response.ok) {
                    options.signal.throwIfAborted();
                    if (!response.body) throw new GatewayResponseError(requestId);
                    const contentType = response.headers.get('content-type') ?? '';
                    if (!(stream ? contentType.includes('text/event-stream') : contentType.includes('application/json'))) {
                        await response.body.cancel();
                        throw new GatewayResponseError(requestId, 'invalid_response');
                    }
                    const events = stream ? gatewayStream(sseEvents(response.body), requestId) : gatewayJson(await response.json(), requestId);
                    for await (const event of events) {
                        options.signal.throwIfAborted();
                        if (event.type === 'usage') used = event.usage;
                        if (event.type === 'stop') stopReason = event.reason;
                        yield event;
                    }
                    if (stopReason === 'max_tokens') throw new GatewayError(`Response truncated (request ${requestId ?? 'unknown'})`, status, 'max_tokens', requestId);
                    return;
                }
                // Body read failures happen after headers: never treat them as pre-header transport failures.
                const body = parseErrorBody(await response.text());
                requestId = body.request_id ?? requestId;
                const retryAfter = response.headers.get('retry-after');
                if (status === 429 && body.code === 'concurrency_limit') {
                    concurrencyStarted ??= now();
                    concurrencyError = describeGatewayError(model.model, status, retryAfter, body, requestId ?? null, undefined, now());
                    const remaining = remainingWait();
                    if (remaining <= 0) throw concurrencyError;
                    const fallback = Math.min(15, 2 ** Math.min(concurrencyRetries + 1, 4));
                    waitMs = Math.min(remaining, Math.min(15, Math.max(1, retryDelay(retryAfter, fallback, now()))) * 1000);
                    concurrencyWaited += waitMs;
                    concurrencyRetries++;
                    retried = true;
                } else if (!retried && status === 429 && body.code === 'rate_limited') {
                    retried = true;
                    waitMs = retryDelay(retryAfter, 60, now()) * 1000;
                } else {
                    if (['killswitch', 'model_disabled', 'model_not_found', 'max_output_tokens_invalid', 'input_too_large'].includes(body.code ?? '')) forgetGatewayModels(provider.baseUrl);
                    throw describeGatewayError(model.model, status, retryAfter, body, requestId ?? null, undefined, now());
                }
            } finally {
                attemptAbort.abort();
                release();
            }
            await (options.sleep ?? defaultSleep)(waitMs, options.signal);
        }
    } catch (error) {
        if (options.signal.aborted) return;
        if (attemptAbort.signal.reason instanceof GatewayError) error = attemptAbort.signal.reason;
        errorCode = error instanceof GatewayError || error instanceof GatewayResponseError ? error.code : status === undefined ? 'invalid_request' : 'stream_interrupted';
        if (error instanceof GatewayError || error instanceof GatewayResponseError) throw error;
        if (status !== undefined) throw new GatewayResponseError(requestId);
        throw new GatewayError('Conversation too large or invalid — start a new chat', undefined, errorCode, requestId);
    } finally {
        options.signal.removeEventListener('abort', cancelAttempt);
        attemptAbort.abort();
        const cancelled = options.signal.aborted;
        log(JSON.stringify({ request_id: requestId ?? null, model: model.model, stream, hold, http_status: status ?? null,
            latency_ms: Math.max(0, now() - started), usage: { input: used.inputTokens, output: used.outputTokens, cache_read: used.cacheReadTokens, cache_write: used.cacheWriteTokens },
            stop_reason: stopReason ?? null, error_code: cancelled ? 'cancelled' : errorCode ?? null,
            ...(cancelled ? { notice: `cancelled; may still be charged (request ${requestId ?? 'unknown'})` } : {}) }));
    }
}

/** For the "Show AI credits" command: models + balance + the §7 state for `alias`. */
export async function readCredits(provider: ResolvedProvider, alias: string, doFetch: typeof fetch = fetch): Promise<{ text: string; state: CreditState; models?: GatewayModels; balance?: GatewayBalance }> {
    forgetGatewayModels(provider.baseUrl); // the panel just opened: read it fresh (contract §3)
    const [models, balance] = await Promise.all([gatewayModels(provider, doFetch), gatewayBalance(provider, doFetch)]);
    const state = creditState(models, balance, alias);
    const text = !models && !balance ? 'EZiL AI could not be reached. Keep EZiL OS open and try again.' : state.text;
    return { text, state: state.state, models, balance };
}
