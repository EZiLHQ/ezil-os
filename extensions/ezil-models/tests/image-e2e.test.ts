// Offline end to end over every OS hop an image crosses: Copilot's parts -> this provider -> the code host's real `/ai/v1`
// proxy (worker/src/ai-proxy.ts handleAiProxyRequest, the one handler for both the Cloudflare and the aws- code hosts,
// with its real HMAC bearer check and 160 KiB read bound) -> a Gateway stand-in that checks the Messages image contract
// (EZiL AI Gateway 8e28cfe4) on the exact bytes it receives. The Gateway and provider hops themselves are not run here.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { parseModelsConfig } from '../src/config';
import { forgetGatewayModels } from '../src/gateway';
import { AI_PROXY_MAX_BODY_BYTES } from '../src/gateway-messages';
import { fakeVscode, DataPart, TextPart } from './fixtures/fake-vscode';

mock.module('vscode', () => fakeVscode);
const { EZiLModelsProvider } = await import('../src/provider');
const { frames } = await import('./fixtures/gateway-response');
// Loaded by path: the Worker is type-checked by its own tsconfig, not this one.
const WORKER_PROXY: string = `${import.meta.dir}/../../../worker/src/ai-proxy.ts`;
const { AI_PROXY_MAX_BODY_BYTES: WORKER_CAP, deriveAiProxyToken, handleAiProxyRequest } = await import(WORKER_PROXY) as {
    AI_PROXY_MAX_BODY_BYTES: number;
    deriveAiProxyToken: (secret: string, sandboxId: string, nonce: string) => Promise<string>;
    handleAiProxyRequest: (request: Request, deps: Record<string, unknown>) => Promise<Response>;
};

const SANDBOX = 'sbx-image-e2e', SECRET = 'synthetic-proxy-secret', NONCE = 'synthetic-nonce';
const BASE = `https://8443-${SANDBOX}-tok.code.example.test/ai/v1`;
const SONNET = 'claude-sonnet-5-5';

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes: Uint8Array) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}
/** An incompressible RGB PNG of `side`×`side` px, so its size follows its pixels. */
function png(side: number): Uint8Array {
    const header = new Uint8Array(13), view = new DataView(header.buffer);
    view.setUint32(0, side); view.setUint32(4, side); header.set([8, 2, 0, 0, 0], 8);
    const raw = new Uint8Array(side * (1 + side * 3));
    let seed = side;
    for (let i = 0; i < raw.length; i++) if (i % (1 + side * 3)) raw[i] = (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
    const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
    return new Uint8Array(Buffer.concat(parts));
}

type Hop = { proxyStatuses: number[]; gatewayBodies: Uint8Array[]; sentBodies: Uint8Array[] };
async function stack() {
    const token = await deriveAiProxyToken(SECRET, SANDBOX, NONCE);
    const config = parseModelsConfig(JSON.stringify({
        providers: { ezil: { type: 'ezil-gateway', baseUrl: '{env:EZIL_AI_BASE_URL}', apiKey: '{env:EZIL_AI_PROXY_TOKEN}' } },
        models: [{ id: SONNET, model: SONNET, name: 'Claude Sonnet 5.5', provider: 'ezil', default: true, capabilities: { toolCalling: true, imageInput: true } }],
    }), { env: { EZIL_AI_BASE_URL: BASE, EZIL_AI_PROXY_TOKEN: token } });
    expect(config.errors).toEqual([]);
    const hop: Hop = { proxyStatuses: [], gatewayBodies: [], sentBodies: [] };
    // The Gateway stand-in: the catalog says image_input for this Messages route, and every image block must meet the
    // contract on the bytes as received (user role, base64 PNG, at most 4, at most 1 MiB, the 4 MiB raw ceiling).
    const gateway = async (request: Request): Promise<Response> => {
        expect(request.headers.get('authorization')).toBe('Bearer synthetic-user-jwt');
        const path = new URL(request.url).pathname;
        if (path === '/v1/models') return Response.json({ object: 'list', contract: 'ezil.gateway.models.v1', killswitch: false, pause: null, data: [
            { id: SONNET, enabled: true, max_input_tokens: 200_000, max_output_tokens: 16_000, protocols: ['anthropic-messages'],
                availability: { state: 'available', reasons: [] }, capabilities: { tool_calling: true, streaming: true, image_input: true } }] });
        expect(path).toBe('/v1/messages');
        const raw = new Uint8Array(await request.arrayBuffer());
        hop.gatewayBodies.push(raw);
        expect(raw.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
        const body = JSON.parse(new TextDecoder().decode(raw)) as { messages: { role: string; content: { type: string; source?: Record<string, string> }[] }[] };
        const images = body.messages.flatMap(message => message.content.filter(block => block.type === 'image').map(block => ({ role: message.role, block })));
        expect(images.length).toBeLessThanOrEqual(4);
        for (const { role, block } of images) {
            expect(role).toBe('user');
            expect(Object.keys(block).sort()).toEqual(['source', 'type']);
            expect(Object.keys(block.source!).sort()).toEqual(['data', 'media_type', 'type']);
            expect([block.source!.type, block.source!.media_type]).toEqual(['base64', 'image/png']);
            const data = block.source!.data!;
            expect(Buffer.from(data, 'base64').toString('base64')).toBe(data); // canonical
            expect(Buffer.from(data, 'base64').byteLength).toBeLessThanOrEqual(1024 * 1024);
        }
        return new Response(frames('end_turn').join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
    const proxied = async (input: string | URL | Request, init: RequestInit = {}) => {
        const request = new Request(input, init);
        if (request.method === 'POST') hop.sentBodies.push(new Uint8Array(await request.clone().arrayBuffer()));
        const response = await handleAiProxyRequest(request, { gatewayUrl: 'https://ai.example.test', sandboxId: SANDBOX, proxySecret: SECRET, proxyNonce: NONCE,
            credential: async () => 'synthetic-user-jwt', dropCredential: async () => {}, fetch: gateway });
        if (request.method === 'POST') hop.proxyStatuses.push(response.status);
        return response;
    };
    const host = { models: () => config.models, configError: () => undefined, secrets: () => config.secrets, logRequests: () => false,
        log: () => {}, recordUsage: () => {}, fetch: proxied as typeof fetch };
    return { provider: new EZiLModelsProvider(host), hop };
}
const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
const send = (provider: InstanceType<typeof EZiLModelsProvider>, content: unknown[]) => provider.provideLanguageModelChatResponse({ id: SONNET } as never,
    [{ role: 1, content }] as never, { tools: [], modelOptions: {} } as never, { report: () => {} }, token() as never).then(() => undefined, (error: Error) => error.message);

beforeEach(() => forgetGatewayModels());

describe('image end to end over the OS hops (offline)', () => {
    test('the client cap is the Worker proxy cap', () => {
        expect(AI_PROXY_MAX_BODY_BYTES).toBe(WORKER_CAP);
    });

    test('a PNG crosses the real proxy byte for byte and arrives as a contract-valid image block', async () => {
        const { provider, hop } = await stack();
        const shot = png(120);
        expect(await send(provider, [new TextPart('<attachments>\n'), new DataPart(shot, 'image/png'), new TextPart('\n</attachments>\nWhat is wrong here?')])).toBeUndefined();
        expect(hop.proxyStatuses).toEqual([200]);
        expect(Buffer.from(hop.gatewayBodies[0]!).equals(Buffer.from(hop.sentBodies[0]!))).toBe(true);
        const body = JSON.parse(new TextDecoder().decode(hop.gatewayBodies[0]!));
        const block = body.messages[0].content.find((b: { type: string }) => b.type === 'image');
        expect(Buffer.from(block.source.data, 'base64').equals(Buffer.from(shot))).toBe(true);
    });

    test('across the effective limit, a request is refused here or accepted by the proxy: the proxy never refuses it', async () => {
        const outcomes = new Set<string>();
        for (let side = 196; side <= 212; side += 2) {
            const { provider, hop } = await stack();
            const message = await send(provider, [new TextPart('look'), new DataPart(png(side), 'image/png')]);
            expect(hop.proxyStatuses).not.toContain(413);
            if (message === undefined) { outcomes.add('sent'); expect(hop.proxyStatuses).toEqual([200]); }
            else { outcomes.add('refused'); expect(message).toMatch(/too large to send/); expect(hop.sentBodies).toHaveLength(0); }
        }
        expect([...outcomes].sort()).toEqual(['refused', 'sent']);
    });
});
