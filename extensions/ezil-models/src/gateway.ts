// EZiL AI gateway transport (provider type `ezil-gateway`): one Idempotency-Key per chat turn, the body
// serialized once and the same bytes reused on the only retries the contract allows, error mapping by
// `error.code`, the `/v1/models` limits cache and the credit states. ezil-ai-gateway
// docs/OS-INTEGRATION-CONTRACT.md §2-§9; in EZiL OS the base URL is the Worker proxy on the computer's own
// code host (`$EZIL_AI_BASE_URL`, `.../ai/v1`), authenticated by `$EZIL_AI_PROXY_TOKEN`.

import { randomUUID } from 'node:crypto';
import { redact, type GatewayProtocol, type ResolvedModel, type ResolvedProvider } from './config';
import { sseEvents } from './sse';
import { buildGatewayBody, DEFAULT_TOOL_RESERVE, KIMI, LocalRequestError, type LocalRequestCounts } from './gateway-messages';
import { gatewayJson, gatewayStream, GatewayResponseError } from './gateway-response';
import { buildGatewayResponsesBody, gatewayResponsesJson, gatewayResponsesStream } from './gateway-responses';
import { emptyUsage } from './types';
import { localResetTime } from './status-data';
import { credits, creditsFloor2 } from './credits-format';
import type { ChatRequest, StreamEvent } from './types';

export const GATEWAY_FIRST_BYTE_TIMEOUT_MS = 30_000;
export const GATEWAY_IDLE_TIMEOUT_MS = 30_000;
/**
 * Non-stream (JSON) requests only: the Gateway answers a JSON request after the whole generation (jsonThrough
 * reads the upstream body and settles before sending headers), so a 30 s first-byte deadline would cap every
 * Kimi reply at 30 s. Bounded instead by one completion deadline from the request's first send (only a transport
 * failure within its first 30 s is resent, and the resend shares it; see gatewayChat), the same value as the OS proxy's
 * AI_PROXY_COMPLETION_TIMEOUT_MS (worker/src/ai-proxy.ts). The Gateway figures below are cited from the Gateway
 * owner, not verifiable in this repo: a 180 s upstream headers deadline (EZiL AI Gateway src/config.ts
 * DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS) that starts only at its upstream fetch, after the proxy hop and admission;
 * and, when a client leaves, a 20 s drain, after which a call still unanswered becomes upstream_timeout, pending,
 * and disables that model route for everyone. 200 s is the Gateway owner's choice (3 Nov 2026): when the request
 * reaches the Gateway's upstream fetch within 20 s of its first send, counting admission and any resend, the
 * Gateway's own deadline answers first (a 504 with its request id); within 40 s, its deadline still fires during
 * the drain, so abandoning here never pauses a route the Gateway itself would not have paused. Later than that, a
 * reply that would have finished before the Gateway's deadline is abandoned and its route paused. A reply abandoned
 * here may still be charged if the model finished. Streaming deadlines are unchanged.
 */
export const GATEWAY_COMPLETION_TIMEOUT_MS = 200_000;
/** Coupled to the Gateway's default `per_user_concurrency`; shared by all models for an identity. */
export const GATEWAY_MAX_IN_FLIGHT = 2;
const CONCURRENCY_WAIT_BUDGET_MS = 60_000;
const MODELS_TTL_MS = 5 * 60_000;
const SIDE_CALL_TIMEOUT_MS = 5_000;
const MICRO_PER_CREDIT = 1_000_000;

/**
 * Where a failure arose: `local` (refused or failed on this computer; nothing was sent), `os_proxy` (the EZiL OS
 * AI proxy answered itself), `gateway` (an EZiL AI refusal relayed by the proxy), `transport` (a deadline or
 * connection failure on the way, or an HTTP error neither of them wrote) or `response` (a reply that arrived but
 * was truncated, incomplete or malformed).
 */
export type GatewayErrorOrigin = 'local' | 'os_proxy' | 'gateway' | 'transport' | 'response';

/** A gateway (or OS proxy, or local) refusal, carrying what the UI and the log need. */
export class GatewayError extends Error {
    constructor(
        message: string,
        public readonly status: number | undefined,
        public readonly code: string | undefined,
        public readonly requestId: string | undefined,
        public readonly retryAfterSeconds?: number,
        public readonly origin: GatewayErrorOrigin = 'gateway',
        /** Local refusals only: sizes, never payload text. */
        public readonly counts?: LocalRequestCounts,
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
    onRequest?: (url: string, built: ReturnType<typeof buildGatewayBody> | ReturnType<typeof buildGatewayResponsesBody>, idempotencyKey: string) => void;
};

// ── /v1/models limits (cached) and credits ────────────────────────────────────

/** Closed in `ezil.gateway.models.v1` (Gateway docs/CATALOG-CONSUMER-CONTRACT.md §2); an unknown value is ignored. */
export const AVAILABILITY_STATES = ['available', 'unavailable', 'unknown'] as const;
export const AVAILABILITY_REASONS = ['model_disabled', 'no_active_pricing', 'gateway_paused', 'no_route', 'route_not_ready', 'not_allowed_for_caller', 'catalog_unavailable'] as const;
export type GatewayAvailability = { state: typeof AVAILABILITY_STATES[number]; reasons: (typeof AVAILABILITY_REASONS[number])[] };
/** Capability flags a row may carry. Absent means "not established": a catalog-only row gets none of them. */
export type GatewayCapabilities = { tool_calling?: boolean; image_input?: boolean; streaming?: boolean };
export type GatewayModel = { id: string; enabled: boolean; max_input_tokens: number; max_output_tokens: number; protocols?: readonly GatewayProtocol[];
    availability?: GatewayAvailability; name?: string; capabilities?: GatewayCapabilities };
export type GatewayModels = { killswitch: boolean; pause: 'operations' | 'reconciliation' | null; data: GatewayModel[] };
export type GatewayGrant = { remaining_micro: number; live: boolean };
export type GatewayBalance = { state?: string; available_micro: number; held_micro: number; grants: GatewayGrant[] };

// Only Bearer auth is sent by this transport. Equivalent resolved providers must share admission
// and catalog state; neither their display name nor ignored custom headers change the identity.
function providerIdentity(provider: ResolvedProvider): string {
    return JSON.stringify([provider.baseUrl, provider.apiKey ?? '']);
}

const modelsCache = new Map<string, { baseUrl: ResolvedProvider['baseUrl']; at: number; models: GatewayModels }>();

/** Refusals that mean the catalog this client listed is out of date (contract §1): read it again, and re-list. */
export const CATALOG_REFUSALS: readonly string[] = ['killswitch', 'model_disabled', 'model_not_found', 'no_provider_route', 'model_unavailable'];

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

const KNOWN_PROTOCOLS: readonly GatewayProtocol[] = ['anthropic-messages', 'openai-responses'];
/** The Gateway's own alias rule (src/catalog.ts MODEL_ALIAS); a catalog-only row is listed under this id. */
const CATALOG_ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Shown as plain text in the picker and the status panel: no control or bidirectional-override characters.
const DISPLAY_NAME = /^[^\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]{1,64}$/u;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function availabilityOf(value: unknown): GatewayAvailability | undefined {
    if (!record(value) || !AVAILABILITY_STATES.includes(value.state as GatewayAvailability['state'])) return undefined;
    const reasons = Array.isArray(value.reasons) ? value.reasons.filter((reason): reason is GatewayAvailability['reasons'][number] =>
        AVAILABILITY_REASONS.includes(reason as GatewayAvailability['reasons'][number])) : [];
    return { state: value.state as GatewayAvailability['state'], reasons: [...new Set(reasons)] };
}

function capabilitiesOf(value: unknown): GatewayCapabilities | undefined {
    if (!record(value)) return undefined;
    const capabilities: GatewayCapabilities = {};
    for (const key of ['tool_calling', 'image_input', 'streaming'] as const) if (typeof value[key] === 'boolean') capabilities[key] = value[key];
    return capabilities;
}

/**
 * `GET /v1/models`, reduced to the fields this client reads; everything else in a row (pricing, upstream model) is
 * dropped here. A malformed core field rejects the catalog as before. A new field's unknown or malformed value is
 * ignored for that row, never a reason to distrust the whole catalog.
 */
export function parseGatewayModels(json: unknown): GatewayModels | undefined {
    if (typeof json !== 'object' || json === null || !Array.isArray((json as GatewayModels).data)) return undefined;
    const raw = json as Record<string, unknown>;
    if (raw.data === undefined || !Array.isArray(raw.data) || raw.data.some(entry => typeof entry !== 'object' || entry === null
        || typeof entry.id !== 'string' || typeof entry.enabled !== 'boolean'
        || !Number.isSafeInteger(entry.max_input_tokens) || entry.max_input_tokens <= 0
        || !Number.isSafeInteger(entry.max_output_tokens) || entry.max_output_tokens <= 0
        || (entry.protocols !== undefined && (!Array.isArray(entry.protocols) || entry.protocols.some((protocol: unknown) => typeof protocol !== 'string'))))) return undefined;
    // A protocol this client does not speak is dropped from its row, never a reason to distrust the whole catalog:
    // a row left with no known protocol is selectable by nobody here (gatewayModelAvailable).
    const data = (raw.data as Record<string, unknown>[]).map(entry => {
        const row: GatewayModel = { id: entry.id as string, enabled: entry.enabled as boolean,
            max_input_tokens: entry.max_input_tokens as number, max_output_tokens: entry.max_output_tokens as number };
        if (entry.protocols !== undefined) row.protocols = (entry.protocols as GatewayProtocol[]).filter(protocol => KNOWN_PROTOCOLS.includes(protocol));
        const availability = availabilityOf(entry.availability);
        if (availability) row.availability = availability;
        if (typeof entry.name === 'string' && DISPLAY_NAME.test(entry.name.trim())) row.name = entry.name.trim();
        const capabilities = capabilitiesOf(entry.capabilities);
        if (capabilities) row.capabilities = capabilities;
        return row;
    });
    return { killswitch: raw.killswitch === true, pause: raw.pause === 'operations' || raw.pause === 'reconciliation' ? raw.pause : null, data };
}

/** Legacy catalogs imply Messages only. Responses requires an explicit, enabled catalog route. */
export function gatewayModelAvailable(model: ResolvedModel, catalog: GatewayModels | undefined): boolean {
    if (model.provider.type !== 'ezil-gateway') return true;
    const entry = catalog?.data.find(entry => entry.id === model.model);
    if (entry?.enabled === false || entry?.availability?.state === 'unavailable') return false;
    const protocol = model.gatewayProtocol ?? 'anthropic-messages';
    if (protocol === 'openai-responses') return !catalog?.killswitch && entry?.enabled === true && entry.protocols?.includes(protocol) === true;
    return entry?.protocols === undefined || entry.protocols.includes(protocol);
}

/**
 * Apply validated catalog caps and capabilities without mutating config; callers still apply wire clamps/reserves.
 * The catalog can only take a capability away: a row saying `streaming: false` sends JSON from the first request.
 */
export function withGatewayModelLimits(model: ResolvedModel, catalog: GatewayModels | undefined): ResolvedModel {
    const entry = catalog?.data.find(entry => entry.id === model.model);
    if (!entry || model.provider.type !== 'ezil-gateway') return model;
    const capabilities = entry.capabilities;
    return { ...model, maxInputTokens: Math.min(model.maxInputTokens, entry.max_input_tokens),
        maxOutputTokens: Math.min(model.maxOutputTokens, entry.max_output_tokens),
        capabilities: { toolCalling: capabilities?.tool_calling === false ? false : model.capabilities.toolCalling,
            imageInput: model.capabilities.imageInput && capabilities?.image_input !== false },
        stream: capabilities?.streaming === false ? false : model.stream };
}

/** Contract §2 rule 1: available for this caller, over a protocol this client speaks (Messages first). */
function selectableProtocol(entry: GatewayModel): GatewayProtocol | undefined {
    if (entry.enabled !== true || entry.availability?.state !== 'available') return undefined;
    return KNOWN_PROTOCOLS.find(protocol => entry.protocols?.includes(protocol));
}

/**
 * The models a Gateway catalog adds to the configured ones (founder request 920): each row the Gateway marks
 * `available` for this caller over a protocol this client speaks, listed by its alias. A configured model with the
 * same alias or picker id wins, and a catalog without `availability` adds nothing. Nothing the row does not say is
 * assumed: tool calling, image input and streaming stay off unless its capabilities turn them on (images always
 * do, as for every Gateway model), and caps are the row's own.
 */
export function gatewayCatalogModels(provider: ResolvedProvider, catalog: GatewayModels | undefined, configured: readonly ResolvedModel[]): ResolvedModel[] {
    if (provider.type !== 'ezil-gateway' || !catalog) return [];
    const taken = new Set(configured.flatMap(model => [model.id.toLowerCase(), ...model.provider.type === 'ezil-gateway' ? [model.model.toLowerCase()] : []]));
    const models: ResolvedModel[] = [];
    for (const entry of catalog.data) {
        const protocol = selectableProtocol(entry);
        if (!protocol || !CATALOG_ALIAS.test(entry.id) || taken.has(entry.id)) continue;
        taken.add(entry.id);
        models.push({
            id: entry.id, name: entry.name ?? entry.id, providerName: provider.name, provider, model: entry.id,
            ...protocol === 'openai-responses' ? { gatewayProtocol: protocol } : {},
            family: entry.id, version: '1',
            maxInputTokens: entry.max_input_tokens, maxOutputTokens: Math.max(16, Math.min(16_384, entry.max_output_tokens)),
            capabilities: { toolCalling: entry.capabilities?.tool_calling === true, imageInput: false },
            cache: { enabled: false, ttl: '5m' }, default: false, roles: [], forcedToolChoice: false,
            stream: entry.capabilities?.streaming === true && entry.id !== KIMI, toolReserve: DEFAULT_TOOL_RESERVE,
        });
    }
    return models;
}

/** `GET /v1/models`, cached for five minutes per base URL + auth context. `undefined` when it cannot be read. */
export async function gatewayModels(provider: ResolvedProvider, doFetch: typeof fetch, now: number = Date.now(), signal?: AbortSignal,
    /** Read now even within the five minutes (a panel opening); a failed read keeps the last catalog. */ fresh = false): Promise<GatewayModels | undefined> {
    const key = providerIdentity(provider);
    const cached = modelsCache.get(key);
    if (!fresh && cached && now - cached.at < MODELS_TTL_MS) return cached.models;
    try {
        const { status, json } = await getJson(provider, '/models', doFetch, signal);
        const models = status === 200 ? parseGatewayModels(json) : undefined;
        if (models) modelsCache.set(key, { baseUrl: provider.baseUrl, at: now, models });
        return models;
    } catch {
        return undefined;
    }
}

/** How long a catalog that can no longer be read still lists the rows it had (only for its own base URL + token). */
export const CATALOG_STALE_MS = 30 * 60_000;

/**
 * The last catalog read for this base URL + token, up to `CATALOG_STALE_MS` old, without a request. A failed read is
 * "unknown", never "unavailable": the rows already listed stay selectable and the request decides. Cleared, like
 * the cache, after an availability or limit refusal; never shared with another token.
 */
export function knownGatewayModels(provider: ResolvedProvider, now: number = Date.now()): GatewayModels | undefined {
    const cached = modelsCache.get(providerIdentity(provider));
    return cached && now - cached.at < CATALOG_STALE_MS ? cached.models : undefined;
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
    // The text is the exact decimal (credits-format.ts), never a float's rendering; `credits` stays a number for callers.
    const pick = (state: CreditState, micro?: number) => ({ state, text: state === 'ok' && micro !== undefined ? `AI credits: ${credits(micro)} remaining` : CREDIT_STATE_TEXT[state],
        ...(micro === undefined ? {} : { credits: micro / MICRO_PER_CREDIT }) });
    if (models?.killswitch) return pick(models.pause === 'reconciliation' ? 'paused_reconciliation' : 'paused_operations');
    if (models && models.data.find(entry => entry.id === alias)?.enabled === false) return pick('model_disabled');
    if (!balance) return pick('unknown');
    if (balance.available_micro === 0 && balance.held_micro === 0) {
        if (balance.grants.some(grant => grant.live)) return pick('used');
        return pick(balance.grants.length ? 'expired' : 'not_included');
    }
    if (balance.available_micro === 0 && balance.held_micro > 0) return pick('held');
    return pick('ok', balance.available_micro);
}

// ── error mapping (by error.code, never by message; contract §8) ─────────────

type ErrorBody = { code?: string; message?: string; request_id?: string; reason?: string; pause?: string; param?: string;
    no_live_grant?: boolean; available_micro?: number; hold_micro?: number; floor_hold_micro?: number; max_affordable_output_tokens?: number | null;
    input_bound_tokens?: number; max_input_tokens?: number; status?: string; source?: string };

/**
 * Who wrote an HTTP refusal. The OS proxy marks its own bodies `source: "ezil-os-proxy"` and uses `os_` codes
 * (worker/src/ai-proxy.ts proxyError). It relays Gateway refusals rebuilt from an allow-list that never copies
 * `source` and never admits an `os_` code (safeGatewayError). A body without a code came from neither.
 */
export function errorOrigin(body: ErrorBody): GatewayErrorOrigin {
    if (body.source === 'ezil-os-proxy' || (typeof body.code === 'string' && body.code.startsWith('os_'))) return 'os_proxy';
    return typeof body.code === 'string' ? 'gateway' : 'transport';
}

const NOTHING_CHARGED = 'and your conversation history is kept. You can start a new chat';

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
    const origin = errorOrigin(body);
    const make = (message: string) => new GatewayError(`${origin === 'os_proxy' ? 'EZiL OS' : 'EZiL AI'}: ${message}${ref}`, status, code, requestId, retryDelay(retryAfter), origin);
    const tooLarge = () => {
        if (origin === 'os_proxy') return make(`This request is larger than the 160 KiB EZiL OS forwards. Nothing was sent to EZiL AI or charged, ${NOTHING_CHARGED}`);
        if (origin === 'transport') return make(`This request was refused as too large (HTTP ${status}) before any model ran, so it was not charged, ${NOTHING_CHARGED}`);
        const bound = Number.isSafeInteger(body.input_bound_tokens) && Number.isSafeInteger(body.max_input_tokens)
            ? ` (input bound ${body.input_bound_tokens} > ${body.max_input_tokens} tokens)` : '';
        return make(`This conversation is too large for ${alias}${bound}. EZiL AI refused it before the model ran, so it was not charged, ${NOTHING_CHARGED}`);
    };
    if (body.reason === 'no_ezil_role' || code === 'no_ezil_role') return make('Your EZiL account has no AI access yet');
    switch (code) {
        case 'window_budget_reached': {
            // This is a reset deadline, not a retry delay: never cap it to the transport's 60 seconds.
            const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : retryAfter ? (Date.parse(retryAfter) - now) / 1000 : NaN;
            const reset = new Date(now + Math.max(0, delay) * 1000);
            const seconds = Number.isFinite(reset.getTime()) ? Math.max(0, Math.ceil(delay)) : undefined;
            return new GatewayError(`EZiL AI: This window's EZiL AI credits are used up. ${seconds === undefined
                ? 'Check EZiL AI status for the reset time.' : `Resets at ${localResetTime(reset)} (local time).`}${ref}`,
                status, code, requestId, seconds, origin);
        }
        case 'insufficient_credits': case 'no_live_grant': {
            if (body.no_live_grant || code === 'no_live_grant') return make('You have no AI credits left. Add credits to continue.');
            const available = body.available_micro ?? balance?.available_micro;
            // Floored: the balance is never shown as more than it is (the hold below is a requirement, so it keeps toFixed).
            const credits = typeof available === 'number' && Number.isSafeInteger(available) && available >= 0 ? creditsFloor2(available) : 'Not measured';
            const state = typeof body.hold_micro === 'number' && Number.isFinite(body.hold_micro)
                && typeof available === 'number' && Number.isFinite(available) && body.hold_micro > available
                ? `This request needs up to ${(body.hold_micro / MICRO_PER_CREDIT).toFixed(2)} credits, and you have ${credits}.`
                : `Not enough AI credits for this request. Available credits: ${credits}.`;
            const shorter = typeof body.max_affordable_output_tokens === 'number' && Number.isFinite(body.max_affordable_output_tokens) && body.max_affordable_output_tokens > 0
                ? ' A shorter reply would fit; try again or reduce the conversation.' : '';
            return make(`${state} Add credits, or start a new chat or pick a smaller model to use less.${shorter}`);
        }
        // The OS app delivers a session only for accounts with an EZiL AI role (ai-credential.ts), so a missing
        // session means either no AI access on this account or no delivered sign-in yet: say both.
        case 'os_session_missing': return make('EZiL AI is not available here yet: this account has no EZiL AI access, or this computer has not received your sign-in. Reopen Code to retry');
        case 'os_session_expired': case 'access_token_expired': return make('Your OS sign-in has expired. Reopen Code or sign in again');
        case 'os_proxy_unauthorized': return make('This computer’s AI connection was refused. Restart the computer to reconnect');
        case 'unauthorized':
            if (body.reason === 'token_expired' || body.reason === 'expired') return make('Your AI sign-in has expired. Reopen Code or sign in again');
            if (body.reason === 'wrong_issuer') return make('EZiL AI does not accept this account’s sign-in (this OS environment is not connected to EZiL AI)');
            if (body.reason === 'bad_signature') return make('EZiL AI could not verify this account’s sign-in signature. Contact your administrator');
            return make('EZiL AI refused this account’s sign-in. Contact your administrator');
        case 'os_ai_unavailable': return make('Could not reach EZiL AI. Retry the request');
        case 'os_completion_timeout': return make(`No complete reply from EZiL AI within ${GATEWAY_COMPLETION_TIMEOUT_MS / 1000} seconds, so EZiL OS stopped waiting. `
            + 'The request may still be charged if the model finished, never more than EZiL AI settles for it. You can retry or switch to a streaming model');
        case 'not_a_member': case 'role_mismatch': case 'forbidden': return make('Your EZiL account does not have AI membership');
        case 'account_suspended': case 'suspended': return make('AI access is suspended for your EZiL account');
        case 'input_too_large': case 'body_too_large': return tooLarge();
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
            if (status === 413) return tooLarge();
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

type TransportCode = 'first_byte_timeout' | 'stream_idle_timeout' | 'completion_timeout' | 'connection_lost';
// Mirrors the cancelled notice: a JSON request abandoned or cut off here may still be charged if the model finished.
const MAY_BE_CHARGED = 'The request may still be charged if the model finished, never more than EZiL AI settles for it.';
const TRANSPORT_TEXT: Record<TransportCode, string> = {
    first_byte_timeout: 'did not answer within 30 seconds. Retry the request',
    stream_idle_timeout: 'the response stopped arriving. Retry the request',
    completion_timeout: `no complete reply within ${GATEWAY_COMPLETION_TIMEOUT_MS / 1000} seconds, so EZiL Models stopped waiting (this model sends its reply only when it is complete). `
        + `${MAY_BE_CHARGED} You can retry or switch to a streaming model`,
    // Not on the provider's Retry list, like completion_timeout: a retry is a new request and may be charged again.
    connection_lost: 'the connection was lost while waiting for the complete reply (this model sends its reply only when it is complete), '
        + `and EZiL AI may already have been running the request, so EZiL Models did not send it again. ${MAY_BE_CHARGED} You can retry or switch to a streaming model`,
};
const transportError = (code: TransportCode, requestId?: string) => new GatewayError(
    `EZiL AI: ${TRANSPORT_TEXT[code]}${requestId ? ` (request ${requestId})` : ''}`, undefined, code, requestId, undefined, 'transport');

/**
 * Streams: 30 s to the first byte, then 30 s per chunk, per attempt. Non-stream: the whole reply by the completion
 * deadline counted from `sentAt`, when this request was first sent, so a transport resend gets only what is left.
 * With nothing left it fails with `completion_timeout` (`abort` carries it) and sends nothing.
 */
async function timedResponse(doFetch: typeof fetch, url: string, init: RequestInit, abort: AbortController, stream: boolean, sentAt: number): Promise<Response> {
    const started = stream ? performance.now() : sentAt;
    const deadline = stream ? GATEWAY_FIRST_BYTE_TIMEOUT_MS : GATEWAY_COMPLETION_TIMEOUT_MS;
    const firstCode: TransportCode = stream ? 'first_byte_timeout' : 'completion_timeout';
    const left = deadline - (performance.now() - started);
    if (left <= 0) { const expired = transportError(firstCode); abort.abort(expired); throw expired; }
    const response = await bounded(doFetch(url, { ...init, signal: abort.signal }), left, abort, transportError(firstCode));
    if (!response.body) return response;
    const reader = response.body.getReader();
    const requestId = response.headers.get('x-ezil-request-id') ?? undefined;
    let first = true;
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const remaining = deadline - (performance.now() - started);
                // After the first byte a body may idle 30 s per chunk, and a JSON reply must still finish by its deadline.
                const [ms, code]: [number, TransportCode] = first ? [remaining, firstCode]
                    : stream || remaining > GATEWAY_IDLE_TIMEOUT_MS ? [GATEWAY_IDLE_TIMEOUT_MS, 'stream_idle_timeout'] : [remaining, 'completion_timeout'];
                const next = await bounded(reader.read(), ms, abort, transportError(code, requestId));
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

/** Validate the entire Responses completion before releasing any executable tool call.
 * The converters validate arguments and terminal usage, and SSE requires clean EOF. Keep the
 * suffix from the first non-text event so JSON text/tool order is preserved as well. */
async function* validateResponsesTools(events: Iterable<StreamEvent> | AsyncIterable<StreamEvent>, offered: ReadonlySet<string>,
    signal: AbortSignal, requestId?: string): AsyncGenerator<StreamEvent> {
    const pending: StreamEvent[] = [];
    for await (const event of events) {
        signal.throwIfAborted();
        if (event.type === 'text' && pending.length === 0) yield event;
        else pending.push(event);
    }
    signal.throwIfAborted();
    if (pending.some(event => event.type === 'tool_call' && !offered.has(event.name))) throw new GatewayResponseError(requestId, 'invalid_response');
    for (const event of pending) {
        signal.throwIfAborted();
        yield event;
    }
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
    let failureOrigin: GatewayErrorOrigin | undefined;
    let localCounts: LocalRequestCounts | undefined;
    let attempted = false;
    const responses = model.gatewayProtocol === 'openai-responses';
    let stream = (responses || model.model !== 'us.moonshotai.kimi-k3') && model.stream !== false;
    let used = emptyUsage();
    let attemptAbort = new AbortController();
    const cancelAttempt = () => attemptAbort.abort(options.signal.reason);
    options.signal.addEventListener('abort', cancelAttempt, { once: true });
    try {
        options.signal.throwIfAborted();
        // A direct client invocation must enforce the same opt-in as the model picker.
        if (responses) {
            const catalog = await gatewayModels(provider, doFetch, now(), options.signal);
            options.signal.throwIfAborted();
            if (!gatewayModelAvailable(model, catalog)) throw new GatewayError('EZiL AI: This model does not advertise an available Responses route', undefined, 'model_unavailable', undefined, undefined, 'local');
            model = withGatewayModelLimits(model, catalog);
        }
        const built = responses ? buildGatewayResponsesBody(model, request, log) : buildGatewayBody(model, request, log);
        // Snapshot the serialized request's tools before callbacks or network waits can mutate input.
        const offeredTools = new Set(built.body.tools?.map(tool => tool.name));
        stream = built.body.stream;
        const url = `${provider.baseUrl}/${responses ? 'responses' : 'messages'}`;
        // Callback is for tests/integration, never used for gateway prompt logging.
        options.onRequest?.(url, built, idempotencyKey);
        const headers = { ...authHeaders(provider), 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', 'idempotency-key': idempotencyKey };
        const identity = providerIdentity(provider);
        let retried = false;
        // Set once a transport failure was resent with the same key: a later idempotency_replay means the first send arrived.
        let resent = false;
        // Non-stream only, on the performance.now() clock: when the request a transport resend repeats was first sent.
        // EZiL AI may already be running it, so the resend shares its completion deadline (and its admission wait
        // counts against it). A 429 refusal answers before anything runs, so the attempt after one starts afresh.
        let resendOf: number | undefined;
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
                concurrencyError ? { ms: remainingWait(), error: concurrencyError }
                    : resendOf !== undefined ? { ms: resendOf + GATEWAY_COMPLETION_TIMEOUT_MS - performance.now(), error: transportError('completion_timeout') } : undefined);
            let waitMs: number;
            try {
                options.signal.throwIfAborted();
                if (concurrencyError && now() - concurrencyStarted! > CONCURRENCY_WAIT_BUDGET_MS) throw concurrencyError;
                attemptAbort = new AbortController();
                const sentAt = resendOf ?? performance.now();
                let response: Response;
                try {
                    attempted = true;
                    response = await timedResponse(doFetch, url, { method: 'POST', headers, body: built.bytes, redirect: 'error' }, attemptAbort, stream, sentAt);
                } catch (error) {
                    if (options.signal.aborted || attemptAbort.signal.reason instanceof GatewayError) throw error;
                    // A JSON reply has no headers until it is complete, so a failure this late may have cut off a request
                    // EZiL AI is already running: a same-key resend could only be answered idempotency_replay.
                    if (!stream && performance.now() - sentAt > GATEWAY_FIRST_BYTE_TIMEOUT_MS) throw transportError('connection_lost', requestId);
                    if (!retried) { retried = true; resent = true; resendOf = stream ? undefined : sentAt; continue; }
                    throw new GatewayError('EZiL AI: cannot reach EZiL AI. Retry the request', undefined, 'os_unreachable', requestId, undefined, 'transport');
                }
                resendOf = undefined;
                status = response.status;
                hold = response.headers.get('x-ezil-hold-micro');
                requestId = response.headers.get('x-ezil-request-id') ?? undefined;
                if (response.ok) {
                    options.signal.throwIfAborted();
                    const clamped = Number(response.headers.get('x-ezil-output-limit-clamped'));
                    const requested = Number(response.headers.get('x-ezil-output-limit-requested'));
                    if (Number.isSafeInteger(clamped) && clamped > 0 && Number.isSafeInteger(requested) && clamped < requested) {
                        log(`Reply limited to ${clamped} tokens to fit your credit balance`);
                    }
                    if (!response.body) throw new GatewayResponseError(requestId);
                    const contentType = response.headers.get('content-type') ?? '';
                    if (!(stream ? contentType.includes('text/event-stream') : contentType.includes('application/json'))) {
                        await response.body.cancel();
                        throw new GatewayResponseError(requestId, 'invalid_response');
                    }
                    const parsed = responses
                        ? stream ? gatewayResponsesStream(response.body, requestId)
                            : gatewayResponsesJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer())), requestId)
                        : stream ? gatewayStream(sseEvents(response.body), requestId) : gatewayJson(await response.json(), requestId);
                    const events = responses ? validateResponsesTools(parsed, offeredTools, options.signal, requestId) : parsed;
                    for await (const event of events) {
                        options.signal.throwIfAborted();
                        if (event.type === 'usage') used = event.usage;
                        if (event.type === 'stop') stopReason = event.reason;
                        yield event;
                    }
                    if (stopReason === 'max_tokens') throw new GatewayError(`Response truncated (request ${requestId ?? 'unknown'})`, status, 'max_tokens', requestId, undefined, 'response');
                    if (stopReason === 'incomplete' || stopReason === 'failed') throw new GatewayError(`EZiL AI: Response ${stopReason} (request ${requestId ?? 'unknown'})`, status, `response_${stopReason}`, requestId, undefined, 'response');
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
                    if (CATALOG_REFUSALS.includes(body.code ?? '') || ['max_output_tokens_invalid', 'input_too_large'].includes(body.code ?? '')) forgetGatewayModels(provider.baseUrl);
                    const refusal = describeGatewayError(model.model, status, retryAfter, body, requestId ?? null, undefined, now());
                    throw resent && refusal.code === 'idempotency_replay' && refusal.origin === 'gateway' ? replayAfterResend(refusal) : refusal;
                }
            } finally {
                attemptAbort.abort();
                release();
            }
            await (options.sleep ?? defaultSleep)(waitMs, options.signal);
        }
    } catch (caught) {
        if (options.signal.aborted) return;
        let error: unknown = attemptAbort.signal.reason instanceof GatewayError ? attemptAbort.signal.reason : caught;
        if (error instanceof LocalRequestError) error = localRefusal(model, error);
        else if (!(error instanceof GatewayError || error instanceof GatewayResponseError)) {
            // Only a failure before any send is local; once a request may have left, it is an interrupted response.
            error = status !== undefined || attempted ? new GatewayResponseError(requestId) : new GatewayError(
                `EZiL Models: internal error while preparing the request (${errorName(error)}); nothing was sent or charged. Please report it (local_build_error)`,
                undefined, 'local_build_error', undefined, undefined, 'local');
        }
        const failure = error as GatewayError | GatewayResponseError;
        errorCode = failure.code;
        failureOrigin = failure.origin;
        localCounts = failure instanceof GatewayError ? failure.counts : undefined;
        throw failure;
    } finally {
        options.signal.removeEventListener('abort', cancelAttempt);
        attemptAbort.abort();
        const cancelled = options.signal.aborted;
        // Metadata only: local refusals add their sizes, never content.
        log(JSON.stringify({ request_id: requestId ?? null, model: model.model, stream, hold, http_status: status ?? null,
            latency_ms: Math.max(0, now() - started), usage: { input: used.inputTokens, output: used.outputTokens, cache_read: used.cacheReadTokens, cache_write: used.cacheWriteTokens },
            stop_reason: stopReason ?? null, error_code: cancelled ? 'cancelled' : errorCode ?? null, origin: cancelled ? null : failureOrigin ?? null,
            ...(!cancelled && localCounts ? { body_bytes: localCounts.bodyBytes, limit_bytes: localCounts.limitBytes, messages: localCounts.messages,
                max_blocks: localCounts.maxBlocks, tools: localCounts.tools, tool_bytes: localCounts.toolBytes } : {}),
            ...(cancelled ? { notice: `cancelled; may still be charged (request ${requestId ?? 'unknown'})` } : {}) }));
    }
}

/**
 * The Gateway's idempotency_replay after this call's own same-key transport resend: the first send had reached EZiL AI,
 * which never runs a key twice, so the reply was lost on the way rather than refused. Code, status and origin are kept.
 */
function replayAfterResend(error: GatewayError): GatewayError {
    const ref = error.requestId ? ` (request ${error.requestId})` : '';
    return new GatewayError(`EZiL AI: the connection failed after this request had reached EZiL AI, so EZiL AI did not run it again and its reply was lost on the way. ${MAY_BE_CHARGED} You can retry${ref}`,
        error.status, error.code, error.requestId, error.retryAfterSeconds, error.origin);
}

/** An exception's class name only: its message may quote request content. */
function errorName(error: unknown): string {
    const name = error instanceof Error ? error.name : typeof error;
    return /^[A-Za-z0-9_$]{1,64}$/.test(name) ? name : 'Error';
}

const bytes = (value: number) => value.toLocaleString('en-US');

/** The user-facing text of a local refusal: what was measured, that nothing left this computer, what to do. */
function localRefusal(model: ResolvedModel, error: LocalRequestError): GatewayError {
    const c = error.counts;
    const kept = 'Nothing was sent or charged, and your conversation history is kept.';
    const text = error.code === 'local_input_too_large'
        ? `This conversation is too large to send to ${model.name}: ${bytes(c.bodyBytes)} bytes, including ${bytes(c.toolBytes)} bytes of tool definitions; `
            + `the limit is ${bytes(c.limitBytes)} bytes. ${kept} You can start a new chat.`
        : error.code === 'local_too_many_messages'
            ? `This conversation has ${bytes(c.messages)} messages, more than EZiL AI accepts in one request. ${kept} You can start a new chat.`
            : `One message in this conversation has ${bytes(c.maxBlocks)} parts, more than EZiL AI accepts in one message. ${kept} You can start a new chat.`;
    return new GatewayError(`EZiL Models: ${text} (${error.code})`, undefined, error.code, undefined, undefined, 'local', c);
}

/** For the "Show AI credits" command: models + balance + the §7 state for `alias`. */
export async function readCredits(provider: ResolvedProvider, alias: string, doFetch: typeof fetch = fetch): Promise<{ text: string; state: CreditState; models?: GatewayModels; balance?: GatewayBalance }> {
    forgetGatewayModels(provider.baseUrl); // the panel just opened: read it fresh (contract §3)
    const [models, balance] = await Promise.all([gatewayModels(provider, doFetch), gatewayBalance(provider, doFetch)]);
    const state = creditState(models, balance, alias);
    const text = !models && !balance ? 'EZiL AI could not be reached. Keep EZiL OS open and try again.' : state.text;
    return { text, state: state.state, models, balance };
}
