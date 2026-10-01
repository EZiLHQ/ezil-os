// HTTP layer: opens the streaming request for a model, maps HTTP failures to readable messages and
// yields neutral stream events. `fetch` is injectable for tests.

import { anthropicStream, buildAnthropicBody } from './anthropic';
import type { ResolvedModel } from './config';
import { hostOf, resolveEndpoint, type Endpoint } from './endpoints';
import { gatewayChat, type GatewayOptions } from './gateway';
import { buildOpenAIBody, openaiStream } from './openai';
import { sseEvents } from './sse';
import type { ChatRequest, StreamEvent } from './types';

export class ProviderError extends Error {
    constructor(message: string, public readonly status?: number, public readonly retryAfterSeconds?: number, public readonly upstream?: string) {
        super(message);
        this.name = 'ProviderError';
    }
}

export type ChatOptions = {
    signal: AbortSignal;
    fetch?: typeof fetch;
    /** Called with the request URL and the exact JSON body about to be sent (contains no credentials). */
    onRequest?: (url: string, body: Record<string, unknown>, detail?: string) => void;
    /** ezil-gateway only: transport log lines (request ids, Idempotency-Keys, error codes; never bodies or tokens). */
    log?: (line: string) => void;
    /** ezil-gateway only: test seams. */
    gateway?: Pick<GatewayOptions, 'newIdempotencyKey' | 'sleep' | 'now'>;
};

function upstreamMessage(text: string): string | undefined {
    if (!text) return undefined;
    try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const error = (parsed.error ?? parsed) as Record<string, unknown>;
        if (typeof error.message === 'string') return error.type && typeof error.type === 'string' ? `${error.type}: ${error.message}` : error.message;
        if (typeof error.code === 'string') return error.code;
    } catch { /* not JSON */ }
    return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

export function describeHttpError(model: ResolvedModel, endpoint: Endpoint, status: number, retryAfter: string | null, bodyText: string): ProviderError {
    const host = hostOf(endpoint.url);
    const upstream = upstreamMessage(bodyText);
    const where = `${model.providerName} (${host})`;
    const suffix = upstream ? ` Upstream said: ${upstream}` : '';
    const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
    switch (status) {
        case 401: return new ProviderError(`EZiL Models: ${where} rejected the API key (401). Check providers.${model.providerName}.apiKey in the models config.${suffix}`, status, undefined, upstream);
        case 402: return new ProviderError(`EZiL Models: ${where} reports a billing problem (402).${suffix}`, status, undefined, upstream);
        case 403: return new ProviderError(`EZiL Models: ${where} denied access (403). The key is valid but may not be allowed to use model "${model.model}".${suffix}`, status, undefined, upstream);
        case 404: return new ProviderError(`EZiL Models: ${where} has no model or deployment named "${model.model}" (404). Check models[].model and the endpoint URL.${suffix}`, status, undefined, upstream);
        case 408: case 409: return new ProviderError(`EZiL Models: ${where} timed out or conflicted (${status}); try again.${suffix}`, status, retryAfterSeconds, upstream);
        case 413: return new ProviderError(`EZiL Models: the request is too large for ${where} (413). Lower maxInputTokens for "${model.id}".${suffix}`, status, undefined, upstream);
        case 429: return new ProviderError(`EZiL Models: ${where} is rate limiting (429)${retryAfterSeconds !== undefined ? `; retry after ${retryAfterSeconds}s` : ''}.${suffix}`, status, retryAfterSeconds, upstream);
        case 529: case 503: return new ProviderError(`EZiL Models: ${where} is overloaded (${status}); try again in a moment.${suffix}`, status, retryAfterSeconds, upstream);
        default:
            if (status >= 500) return new ProviderError(`EZiL Models: ${where} failed with HTTP ${status}.${suffix}`, status, retryAfterSeconds, upstream);
            return new ProviderError(`EZiL Models: ${where} rejected the request (HTTP ${status}).${suffix}`, status, undefined, upstream);
    }
}

export function buildBody(model: ResolvedModel, request: ChatRequest): { endpoint: Endpoint; body: Record<string, unknown> } {
    // `thinking.display: "updates"` (progress notes between tool calls) is behind a beta header.
    const endpoint = resolveEndpoint(model.provider, model.thinking?.display === 'updates' ? ['thinking-display-updates-2026-08-18'] : []);
    const body = endpoint.api === 'anthropic' ? buildAnthropicBody(model, request) : buildOpenAIBody(model, request);
    return { endpoint, body };
}

export async function* chat(model: ResolvedModel, request: ChatRequest, options: ChatOptions): AsyncGenerator<StreamEvent> {
    if (model.provider.type === 'ezil-gateway') {
        yield* gatewayChat(model, request, {
            signal: options.signal,
            fetch: options.fetch,
            log: options.log,
            ...options.gateway,
            onRequest: (url, built, key) => options.onRequest?.(url, built.body as unknown as Record<string, unknown>,
                `key=${key} bound=${built.bound} tools=${built.body.tools?.length ?? 0}${built.droppedTools.length ? ` dropped=${built.droppedTools.length}(${built.droppedTools.slice(0, 8).join(',')}${built.droppedTools.length > 8 ? ',...' : ''})` : ''} max_output_tokens=${built.body.max_output_tokens}`),
        });
        return;
    }
    const { endpoint, body } = buildBody(model, request);
    options.onRequest?.(endpoint.url, body);
    const doFetch = options.fetch ?? fetch;
    let response: Response;
    try {
        response = await doFetch(endpoint.url, { method: 'POST', headers: endpoint.headers, body: JSON.stringify(body), signal: options.signal, redirect: 'error' });
    } catch (error) {
        if (options.signal.aborted) throw error;
        const cause = (error as { cause?: { message?: string; code?: string } }).cause;
        const detail = cause?.code ?? cause?.message ?? (error as Error).message;
        throw new ProviderError(`EZiL Models: cannot reach ${model.providerName} at ${hostOf(endpoint.url)} (${detail}).`);
    }
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw describeHttpError(model, endpoint, response.status, response.headers.get('retry-after'), text);
    }
    if (!response.body) throw new ProviderError(`EZiL Models: ${model.providerName} returned an empty response body.`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
        // Non-streaming JSON error bodies with a 200 status (some proxies) or a misconfigured endpoint.
        const text = await response.text().catch(() => '');
        const upstream = upstreamMessage(text);
        throw new ProviderError(`EZiL Models: ${model.providerName} did not answer with an event stream (content-type ${contentType || 'missing'}).${upstream ? ` Body: ${upstream}` : ''}`);
    }
    const stream = endpoint.api === 'anthropic' ? anthropicStream(sseEvents(response.body)) : openaiStream(sseEvents(response.body));
    yield* stream;
}
