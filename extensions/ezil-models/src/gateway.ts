// EZiL AI gateway transport (provider type `ezil-gateway`): one Idempotency-Key per chat turn, the body
// serialized once and the same bytes reused on the only retries the contract allows, error mapping by
// `error.code`, the `/v1/models` limits cache and the credit states. ezil-ai-gateway
// docs/OS-INTEGRATION-CONTRACT.md §2-§9; in EZiL OS the base URL is the Worker proxy on the computer's own
// code host (`$EZIL_AI_BASE_URL`, `.../ai/v1`), authenticated by `$EZIL_AI_PROXY_TOKEN`.

import { randomUUID } from 'node:crypto';
import type { ResolvedModel, ResolvedProvider } from './config';
import { sseEvents } from './sse';
import { buildResponsesBody, responsesStream, type BuiltResponsesBody, type GatewayLimits } from './responses';
import type { ChatRequest, StreamEvent } from './types';

/** How long a turn waits for EZiL OS to push a fresh session after a 401 (one activity beat is 60 s). */
export const SESSION_WAIT_MS = 65_000;
const SESSION_POLL_MS = 5_000;
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
    onRequest?: (url: string, built: BuiltResponsesBody, idempotencyKey: string) => void;
};

// ── /v1/models limits (cached) and credits ────────────────────────────────────

export type GatewayModel = { id: string; enabled: boolean; max_input_tokens: number; max_output_tokens: number };
export type GatewayModels = { killswitch: boolean; pause: 'operations' | 'reconciliation' | null; data: GatewayModel[] };
export type GatewayGrant = { remaining_micro: number; live: boolean };
export type GatewayBalance = { state?: string; available_micro: number; held_micro: number; grants: GatewayGrant[] };

const modelsCache = new Map<string, { at: number; models: GatewayModels }>();

/** Clear the `/v1/models` cache (after `killswitch` / `model_disabled` / `max_output_tokens_invalid`, and in tests). */
export function forgetGatewayModels(baseUrl?: string): void {
    if (baseUrl === undefined) modelsCache.clear();
    else modelsCache.delete(baseUrl);
}

function authHeaders(provider: ResolvedProvider): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${provider.apiKey ?? ''}` };
    for (const [name, value] of Object.entries(provider.headers)) headers[name] = value;
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
    return { killswitch: raw.killswitch === true, pause: raw.pause === 'operations' || raw.pause === 'reconciliation' ? raw.pause : null, data: raw.data as GatewayModel[] };
}

/** `GET /v1/models`, cached for five minutes per base URL. `undefined` when it cannot be read. */
export async function gatewayModels(provider: ResolvedProvider, doFetch: typeof fetch, now: number = Date.now(), signal?: AbortSignal): Promise<GatewayModels | undefined> {
    const key = provider.baseUrl ?? '';
    const cached = modelsCache.get(key);
    if (cached && now - cached.at < MODELS_TTL_MS) return cached.models;
    try {
        const { status, json } = await getJson(provider, '/models', doFetch, signal);
        const models = status === 200 ? asModels(json) : undefined;
        if (models) modelsCache.set(key, { at: now, models });
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
        if (typeof raw.available_micro !== 'number' || typeof raw.held_micro !== 'number' || !Array.isArray(raw.grants)) return undefined;
        return raw as unknown as GatewayBalance;
    } catch {
        return undefined;
    }
}

/** The limits a request must respect: the config's, lowered to the gateway's when `/v1/models` knows the alias. */
export function effectiveLimits(model: ResolvedModel, models: GatewayModels | undefined): GatewayLimits {
    const entry = models?.data.find(candidate => candidate.id === model.model);
    const input = typeof entry?.max_input_tokens === 'number' && entry.max_input_tokens > 0 ? Math.min(entry.max_input_tokens, model.maxInputTokens) : model.maxInputTokens;
    const output = typeof entry?.max_output_tokens === 'number' && entry.max_output_tokens >= 16 ? Math.min(entry.max_output_tokens, model.maxOutputTokens) : model.maxOutputTokens;
    return { maxInputTokens: input, maxOutputTokens: output };
}

export type CreditState =
    | 'paused_reconciliation' | 'paused_operations' | 'model_disabled'
    | 'used' | 'expired' | 'not_included' | 'held' | 'ok';

export const CREDIT_STATE_TEXT: Record<CreditState, string> = {
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
    if (!balance) return pick('ok');
    if (balance.available_micro === 0 && balance.held_micro === 0) {
        if (balance.grants.some(grant => grant.live)) return pick('used');
        return pick(balance.grants.length ? 'expired' : 'not_included');
    }
    if (balance.available_micro === 0 && balance.held_micro > 0) return pick('held');
    return pick('ok', Math.floor(balance.available_micro / MICRO_PER_CREDIT));
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

const SESSION_CODES = new Set(['unauthorized', 'os_session_missing', 'role_mismatch']);
const BUG_CODES = new Set(['idempotency_key_required', 'idempotency_conflict', 'invalid_request', 'unsupported_parameter', 'invalid_json', 'unsupported_input_item', 'unsupported_tool', 'method_not_allowed', 'max_output_tokens_invalid']);
const PROVIDER_CODES = new Set(['upstream_unavailable', 'upstream_error', 'settlement_pending', 'credit_policy_unavailable', 'pricing_unavailable']);
const UNAVAILABLE_CODES = new Set(['auth_unavailable', 'database_unavailable', 'not_configured', 'internal_error', 'os_ai_unavailable']);

/** Whether a 401/403 is worth waiting for the next session push (contract: refresh once, retry with the same key and bytes). */
export function isSessionRefusal(status: number, body: ErrorBody): boolean {
    if (status !== 401 && status !== 403) return false;
    if (body.reason === 'no_ezil_role') return false; // an account without a role; a new token will not have one either
    return body.code === undefined ? status === 401 : SESSION_CODES.has(body.code);
}

export function describeGatewayError(alias: string, status: number, retryAfter: string | null, body: ErrorBody, headerRequestId: string | null,
    balance?: GatewayBalance): GatewayError {
    const requestId = body.request_id ?? headerRequestId ?? undefined;
    const ref = requestId ? ` (request ${requestId})` : '';
    const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
    const code = body.code;
    const make = (message: string, retry?: number) => new GatewayError(`EZiL AI: ${message}`, status, code, requestId, retry);
    switch (code) {
        case 'insufficient_credits': {
            // §7: the balance picks the text; without it, `no_live_grant` (0007) and the hold/available pair do.
            const credit = balance ? creditState(undefined, balance, alias) : undefined;
            if (credit && (credit.state === 'used' || credit.state === 'expired' || credit.state === 'not_included')) return make(`no credits. ${credit.text}`);
            if (credit?.state === 'held') return make(`no credits available right now. ${credit.text}`);
            const tooSmall = credit?.state === 'ok'
                || (body.no_live_grant === false)
                || (typeof body.hold_micro === 'number' && typeof body.available_micro === 'number' && body.hold_micro > body.available_micro && body.available_micro > 0);
            if (tooSmall) return make('not enough credits for this request. Shorten the conversation or start a new chat.');
            return make('no credits. Your account has no AI credits left.');
        }
        case 'killswitch':
            return make(body.pause === 'reconciliation'
                ? 'AI paused (reconciliation): usage is being reconciled. Your credits are safe.'
                : 'AI paused (operations): AI is temporarily unavailable. Your credits are safe.');
        case 'global_cap_reached':
            return make('AI paused: the platform\'s daily AI budget is reached. Your credits are safe.');
        case 'rate_limited':
            return make(`too many requests; try again in ${retryAfterSeconds ?? 60} s.`, retryAfterSeconds ?? 60);
        case 'concurrency_limit':
            return make(`wait for the current response to finish; try again in ${retryAfterSeconds ?? 5} s.`, retryAfterSeconds ?? 5);
        case 'input_too_large':
        case 'body_too_large':
            return make(`prompt too large for ${alias}${typeof body.input_bound_tokens === 'number' ? ` (${body.input_bound_tokens} of ${body.max_input_tokens ?? '?'} allowed)` : ''}. Start a new chat or attach less context.`);
        case 'unauthorized':
        case 'os_session_missing':
            if (body.reason === 'no_ezil_role') return make('AI is not set up for this account yet. Reopen EZiL OS to finish setting up your EZiL account.');
            return make('your EZiL session expired. Reopen EZiL OS (or keep it open) to sign in again.');
        case 'not_a_member':
        case 'role_mismatch':
        case 'forbidden':
            return make('AI is not enabled for this account.');
        case 'account_suspended':
            return make('AI is not available for this account.');
        case 'model_not_found':
        case 'model_disabled':
            return make(`the model ${alias} is not available right now.`);
        case 'idempotency_replay':
            return make(`already processed${ref}. This request was already sent once and is not run again.`);
        case 'unsupported_content':
            return make('images and files are not supported by EZiL AI.');
        case 'upstream_timeout':
            return make(`the model provider did not answer in time${ref}.`);
        case 'os_proxy_unauthorized':
            return make('this computer is not authorized for EZiL AI. Restart the computer from EZiL OS.');
        default:
            break;
    }
    if (code && BUG_CODES.has(code)) return make(`the gateway refused the request (${code}${body.param ? `, ${body.param}` : ''})${ref}. This is an EZiL Models bug; please report it.`);
    if (code && PROVIDER_CODES.has(code)) return make(`model provider unavailable${ref}.`);
    if (code && UNAVAILABLE_CODES.has(code)) return make(`AI is temporarily unavailable${ref}.`, retryAfterSeconds);
    // Unknown code: by HTTP status (contract §1).
    if (status === 401) return make('your EZiL session expired. Reopen EZiL OS to sign in again.');
    if (status === 402) return make('no credits.');
    if (status === 403) return make('AI is not enabled for this account.');
    if (status === 404) return make(`the model ${alias} or the EZiL AI endpoint was not found${ref}.`);
    if (status === 413) return make(`prompt too large for ${alias}. Start a new chat.`);
    if (status === 429) return make(`too many requests; try again in ${retryAfterSeconds ?? 60} s.`, retryAfterSeconds ?? 60);
    if (status >= 500) return make(`AI is temporarily unavailable (HTTP ${status})${ref}.`, retryAfterSeconds);
    return make(`the request was refused (HTTP ${status}${code ? `, ${code}` : ''})${ref}.`);
}

// ── the turn ──────────────────────────────────────────────────────────────────

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Wait (up to SESSION_WAIT_MS) until the proxy stops answering 401 for a cheap `GET /models`. */
async function waitForSession(provider: ResolvedProvider, doFetch: typeof fetch, options: GatewayOptions): Promise<boolean> {
    const sleep = options.sleep ?? defaultSleep;
    for (let waited = 0; waited < SESSION_WAIT_MS; waited += SESSION_POLL_MS) {
        await sleep(SESSION_POLL_MS, options.signal);
        try {
            const { status } = await getJson(provider, '/models', doFetch, options.signal);
            if (status !== 401 && status !== 403) return true;
        } catch (error) {
            if (options.signal.aborted) throw error;
        }
    }
    return false;
}

/**
 * One chat turn against the gateway. The Idempotency-Key is minted once and the body bytes are built
 * once; both are reused unchanged for (a) one retry after a transport failure before any response and
 * (b) one retry after a session refusal once EZiL OS has pushed a fresh token. Nothing else is retried:
 * not a 409 replay, not a 5xx, and never a started stream.
 */
export async function* gatewayChat(model: ResolvedModel, request: ChatRequest, options: GatewayOptions): AsyncGenerator<StreamEvent> {
    const provider = model.provider;
    const doFetch = options.fetch ?? fetch;
    const log = options.log ?? (() => undefined);
    const models = await gatewayModels(provider, doFetch, (options.now ?? Date.now)(), options.signal);
    const built = buildResponsesBody(model, request, effectiveLimits(model, models));
    const idempotencyKey = (options.newIdempotencyKey ?? randomUUID)();
    const url = `${provider.baseUrl}/responses`;
    options.onRequest?.(url, built, idempotencyKey);
    const headers = { ...authHeaders(provider), 'content-type': 'application/json', accept: 'text/event-stream', 'idempotency-key': idempotencyKey };

    let transportRetried = false;
    let sessionRetried = false;
    let response: Response;
    for (;;) {
        try {
            response = await doFetch(url, { method: 'POST', headers, body: built.bytes, signal: options.signal, redirect: 'error' });
        } catch (error) {
            if (options.signal.aborted) throw error;
            if (!transportRetried) {
                transportRetried = true;
                log(`[gateway] ${model.id} key=${idempotencyKey}: transport failure before a response; retrying once with the same key and bytes`);
                continue;
            }
            const cause = (error as { cause?: { code?: string; message?: string } }).cause;
            throw new GatewayError(`EZiL AI: cannot reach EZiL AI (${cause?.code ?? cause?.message ?? (error as Error).message}).`, undefined, 'os_unreachable', undefined);
        }
        if (response.ok) break;
        const text = await response.text().catch(() => '');
        const body = parseErrorBody(text);
        const requestId = response.headers.get('x-ezil-request-id');
        log(`[gateway] ${model.id} key=${idempotencyKey} status=${response.status} code=${body.code ?? '-'}${body.reason ? ` reason=${body.reason}` : ''} request=${body.request_id ?? requestId ?? '-'}`);
        if (!sessionRetried && isSessionRefusal(response.status, body)) {
            sessionRetried = true;
            log(`[gateway] ${model.id}: waiting up to ${SESSION_WAIT_MS / 1000} s for EZiL OS to refresh the session`);
            if (await waitForSession(provider, doFetch, options)) continue;
        }
        if (body.code === 'killswitch' || body.code === 'model_disabled' || body.code === 'model_not_found' || body.code === 'max_output_tokens_invalid') forgetGatewayModels(provider.baseUrl);
        const balance = body.code === 'insufficient_credits' ? await gatewayBalance(provider, doFetch, options.signal) : undefined;
        throw describeGatewayError(model.model, response.status, response.headers.get('retry-after'), body, requestId, balance);
    }

    const requestId = response.headers.get('x-ezil-request-id') ?? undefined;
    log(`[gateway] ${model.id} key=${idempotencyKey} status=200 request=${requestId ?? '-'} hold_micro=${response.headers.get('x-ezil-hold-micro') ?? '-'}`);
    if (!response.body) throw new GatewayError(`EZiL AI: the response was empty (request ${requestId ?? 'unknown'}).`, 200, 'empty_body', requestId);
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        await response.body.cancel().catch(() => undefined);
        throw new GatewayError(`EZiL AI: expected an event stream (request ${requestId ?? 'unknown'}).`, 200, 'not_sse', requestId);
    }
    yield* responsesStream(sseEvents(response.body), requestId, id => log(`[gateway] ${model.id} request=${requestId ?? '-'} response.id=${id}`));
}

/** For the "Show AI credits" command: models + balance + the §7 state for `alias`. */
export async function readCredits(provider: ResolvedProvider, alias: string, doFetch: typeof fetch = fetch): Promise<{ text: string; state: CreditState; models?: GatewayModels; balance?: GatewayBalance }> {
    forgetGatewayModels(provider.baseUrl); // the panel just opened: read it fresh (contract §3)
    const [models, balance] = await Promise.all([gatewayModels(provider, doFetch), gatewayBalance(provider, doFetch)]);
    const state = creditState(models, balance, alias);
    const text = !models && !balance ? 'EZiL AI could not be reached. Keep EZiL OS open and try again.' : state.text;
    return { text, state: state.state, models, balance };
}
