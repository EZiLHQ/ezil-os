import type { ResolvedProvider } from './config';

export type ApiKind = 'anthropic' | 'openai' | 'responses';

export type Endpoint = { api: ApiKind; url: string; headers: Record<string, string> };

export const ANTHROPIC_VERSION = '2023-06-01';

export function apiKindOf(provider: ResolvedProvider): ApiKind {
    if (provider.type === 'ezil-gateway') return 'responses';
    return provider.type === 'anthropic' || provider.type === 'anthropic-foundry' ? 'anthropic' : 'openai';
}

/**
 * URL + auth headers per provider type:
 *  - anthropic:          https://api.anthropic.com/v1/messages                                   x-api-key
 *  - anthropic-foundry:  https://<resource>.services.ai.azure.com/anthropic/v1/messages          x-api-key
 *  - openai:             https://api.openai.com/v1/chat/completions                              authorization: Bearer
 *  - azure-openai:       https://<resource>.openai.azure.com/openai/v1/chat/completions          api-key
 *                        (or baseUrl https://<resource>.services.ai.azure.com/openai/v1)
 *  - openai-compatible:  <baseUrl>/chat/completions                                              authorization: Bearer (if key)
 *  - ezil-gateway:       <baseUrl>/responses (EZiL AI, via the EZiL OS proxy; see gateway.ts)    authorization: Bearer <proxy token>
 */
export function resolveEndpoint(provider: ResolvedProvider, extraBetas: readonly string[] = []): Endpoint {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
    let url: string;
    switch (provider.type) {
        case 'anthropic': {
            url = `${provider.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
            headers['x-api-key'] = provider.apiKey ?? '';
            headers['anthropic-version'] = ANTHROPIC_VERSION;
            break;
        }
        case 'anthropic-foundry': {
            url = `${provider.baseUrl ?? `https://${provider.resource}.services.ai.azure.com/anthropic`}/v1/messages`;
            headers['x-api-key'] = provider.apiKey ?? '';
            headers['anthropic-version'] = ANTHROPIC_VERSION;
            break;
        }
        case 'openai': {
            url = `${provider.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`;
            headers.authorization = `Bearer ${provider.apiKey ?? ''}`;
            break;
        }
        case 'azure-openai': {
            url = `${provider.baseUrl ?? `https://${provider.resource}.openai.azure.com/openai/v1`}/chat/completions`;
            if (provider.apiVersion) url += `?api-version=${encodeURIComponent(provider.apiVersion)}`;
            headers['api-key'] = provider.apiKey ?? '';
            break;
        }
        case 'openai-compatible': {
            url = `${provider.baseUrl}/chat/completions`;
            if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
            break;
        }
        case 'ezil-gateway': {
            // The proxy token for this computer, not a provider key: the EZiL OS Worker swaps it for the
            // user's own session token and forwards to ai.ezil.work (docs/AI-GATEWAY.md in ezil-os).
            url = `${provider.baseUrl}/responses`;
            headers.authorization = `Bearer ${provider.apiKey ?? ''}`;
            break;
        }
    }
    const betas = [...new Set([...provider.betas, ...extraBetas])];
    if (apiKindOf(provider) === 'anthropic' && betas.length) headers['anthropic-beta'] = betas.join(',');
    for (const [name, value] of Object.entries(provider.headers)) headers[name] = value;
    return { api: apiKindOf(provider), url, headers };
}

export function hostOf(url: string): string {
    try { return new URL(url).host; } catch { return url; }
}
