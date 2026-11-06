// User images to EZiL AI: sent intact as base64 PNG blocks only when the model's own config entry opts in AND a catalog
// read now says `image_input: true` for its Messages route (the Gateway's default-off Claude image candidate); otherwise
// the user's current image fails the turn before anything is sent. Zero inference: every response is a fixture, and the
// PNGs are generated here.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { parseModelsConfig, type ResolvedConfig } from '../src/config';
import { forgetGatewayModels, gatewayCatalogModels, parseGatewayModels, withGatewayModelLimits } from '../src/gateway';
import { AI_PROXY_MAX_BODY_BYTES, buildGatewayBody, CLAUDE_IMAGE_TOKENS, gatewayMessage, gatewayTokenCount, imageProblem, LocalRequestError, MAX_IMAGE_BYTES,
    sendableImages } from '../src/gateway-messages';
import { buildGatewayResponsesBody } from '../src/gateway-responses';
import type { DataPart } from '../src/types';
import { fakeVscode, DataPart as VsDataPart, TextPart, ToolCallPart, ToolResultPart } from './fixtures/fake-vscode';
import { ask, gw, msg, txt } from './fixtures/gateway';

mock.module('vscode', () => fakeVscode);
const { EZiLModelsProvider, imageRefusal } = await import('../src/provider');
const { frames } = await import('./fixtures/gateway-response');

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes: Uint8Array): number { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}
/**
 * A structurally valid RGB PNG; `noise` makes it incompressible (deterministic), so its size follows its pixels. `shape`
 * edits the header or the chunk list (each chunk with a correct CRC) to build a PNG the Gateway refuses.
 */
function png(width: number, height: number, noise = false, shape: { depth?: number; chunks?: (chunks: Uint8Array[]) => Uint8Array[] } = {}): Uint8Array {
    const header = new Uint8Array(13), view = new DataView(header.buffer);
    view.setUint32(0, width); view.setUint32(4, height); header.set([shape.depth ?? 8, 2, 0, 0, 0], 8);
    const raw = new Uint8Array(height * (1 + width * 3));
    let seed = 7;
    for (let i = 0; i < raw.length; i++) if (noise && i % (1 + width * 3) !== 0) raw[i] = (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
    const chunks = [chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
    const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...(shape.chunks ? shape.chunks(chunks) : chunks)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}
const SMALL = png(4, 3);
const image = (data: Uint8Array = SMALL, mimeType = 'image/png'): DataPart => ({ type: 'data', mimeType, data });
const decoded = (block: unknown): Uint8Array => new Uint8Array(Buffer.from((block as { source: { data: string } }).source.data, 'base64'));
const vision = () => ({ ...gw('claude-sonnet-5-5'), capabilities: { toolCalling: true, imageInput: true } });

describe('the wire: PNG bytes go intact, everything else is a marked note', () => {
    test('round trip: mixed text and image keep their order and the decoded bytes are identical', () => {
        const body = buildGatewayBody(vision(), ask([msg('user', txt('<attachments>\n'), image(), txt('\n</attachments>\nWhat is this?'))])).body;
        const content = body.messages[0]!.content;
        expect(content.map(block => block.type)).toEqual(['text', 'image', 'text']);
        expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(SMALL).toString('base64') } });
        expect(decoded(content[1])).toEqual(SMALL);
        expect(Object.keys(content[1]!).sort()).toEqual(['source', 'type']);
    });

    test('a model without image input keeps the note it always had (no data loss in text, no image bytes sent)', () => {
        const body = buildGatewayBody(gw(), ask([msg('user', txt('look'), image())]));
        expect(body.body.messages[0]!.content).toEqual([{ type: 'text', text: 'look' }, { type: 'text', text: '[image omitted: not supported by this model]' }]);
        expect(new TextDecoder().decode(body.bytes)).not.toContain(Buffer.from(SMALL).toString('base64'));
    });

    test('text-only requests are byte-identical with or without image input', () => {
        const request = ask([msg('system', txt('rules')), msg('user', txt('hello'))]);
        expect(buildGatewayBody(vision(), request).bytes).toEqual(buildGatewayBody({ ...vision(), capabilities: { toolCalling: true, imageInput: false } }, request).bytes);
    });

    test('images in tool results and assistant messages never become image blocks', () => {
        const request = { ...ask([msg('user', txt('read')), msg('assistant', { type: 'tool_call', callId: 'c1', name: 'read_file', input: {} }, image()),
            msg('user', { type: 'tool_result', callId: 'c1', content: [txt('out'), image()] })]), tools: [{ name: 'read_file', inputSchema: { type: 'object', properties: {} } }] };
        const body = buildGatewayBody(vision(), request).body;
        expect(JSON.stringify(body)).not.toContain('"type":"image"');
    });

    test('only the four most recent valid images go; older ones are marked, never dropped silently', () => {
        const images = Array.from({ length: 6 }, (_, i) => image(png(i + 1, 1)));
        const request = ask(images.map((part, i) => msg(i % 2 ? 'assistant' : 'user', ...(i % 2 ? [txt(`a${i}`)] : [txt(`u${i}`), part]))).concat(
            [msg('user', images[1]!, images[3]!, images[5]!, txt('now'))]));
        const body = buildGatewayBody(vision(), request).body;
        const blocks = body.messages.flatMap(m => m.content);
        // Six images in the chat: the current message's three and the newest earlier one go, in conversation order.
        expect(blocks.filter(b => b.type === 'image').map(decoded)).toEqual([images[4]!, images[1]!, images[3]!, images[5]!].map(part => part.data));
        expect(blocks.filter(b => b.type === 'text' && b.text === '[image omitted: only the 4 most recent images are sent]')).toHaveLength(2);
        expect(sendableImages(request.messages, true).size).toBe(4);
        // The budget can split one message: its newest images go first.
        const [a, b, c, d, e] = Array.from({ length: 5 }, (_, i) => image(png(i + 1, 2))) as [DataPart, DataPart, DataPart, DataPart, DataPart];
        expect([...sendableImages([msg('user', a, b, c), msg('assistant', txt('ok')), msg('user', d, e)], true)]).toEqual([e, d, c, b]);
        expect(sendableImages([msg('user', a)], false).size).toBe(0);
    });

    test('only user images count or become blocks, whatever set a caller passes', () => {
        const part = image();
        expect(sendableImages([msg('assistant', part), msg('system', image())], true).size).toBe(0);
        expect(gatewayMessage(msg('assistant', txt('x'), part), new Set([part]), true).content.some(block => block.type === 'image')).toBe(false);
        expect(gatewayMessage(msg('user', txt('x'), part), new Set([part]), true).content.some(block => block.type === 'image')).toBe(true);
    });

    test('unsupported type, size, structure and dimensions are explained, not sent', () => {
        const wide = png(8001, 1), empty = png(0, 1);
        const badCrc = png(4, 3); badCrc[45]! ^= 1; // a byte inside IDAT
        const apng = png(4, 3, false, { chunks: ([ihdr, ...rest]) => [ihdr!, chunk('acTL', new Uint8Array(8)), ...rest] });
        const noIdat = png(4, 3, false, { chunks: ([ihdr, , iend]) => [ihdr!, iend!] });
        const critical = png(4, 3, false, { chunks: ([ihdr, ...rest]) => [ihdr!, chunk('XYZW', new Uint8Array(1)), ...rest] });
        const ancillary = png(4, 3, false, { chunks: ([ihdr, ...rest]) => [ihdr!, chunk('tEXt', new TextEncoder().encode('k\0v')), ...rest] });
        const split = png(4, 3, false, { chunks: ([ihdr, idat, iend]) => [ihdr!, idat!, chunk('tEXt', new Uint8Array(1)), idat!, iend!] });
        const cases: [DataPart, RegExp][] = [
            [image(SMALL, 'image/jpeg'), /image\/jpeg images are not supported; only PNG/],
            [image(new Uint8Array(MAX_IMAGE_BYTES + 1)), /larger than 1 MiB/],
            [image(SMALL.subarray(0, SMALL.length - 1)), /not a valid PNG/],
            [image(new TextEncoder().encode('<svg/>'.padEnd(64, ' '))), /not a valid PNG/],
            [image(wide), /8001×1 px/],
            [image(empty), /0×1 px/],
            [image(badCrc), /not a valid PNG/],
            [image(apng), /animated PNGs are not supported/],
            [image(noIdat), /not a valid PNG/],
            [image(png(4, 3, false, { depth: 3 })), /not a valid PNG/],
            [image(critical), /not a valid PNG/],
            [image(split), /not a valid PNG/],
            [image(new Uint8Array([...SMALL, 0])), /not a valid PNG/],
        ];
        for (const [part, reason] of cases) {
            expect(imageProblem(part)).toMatch(reason);
            const content = buildGatewayBody(vision(), ask([msg('user', txt('x'), part)])).body.messages[0]!.content;
            expect(content[1]).toEqual({ type: 'text', text: expect.stringMatching(reason) });
        }
        expect(imageProblem(image())).toBeUndefined();
        expect(imageProblem(image(ancillary))).toBeUndefined();
        // A PNG the Gateway would refuse is never picked from history, so it cannot fail later turns.
        expect(sendableImages([msg('user', image(badCrc)), msg('assistant', txt('?')), msg('user', txt('next'))], true).size).toBe(0);
    });

    test('the input bound counts an image as the Gateway does, and the code host cap still applies', () => {
        const medium = png(195, 195, true); // about 114 KB: 152 KB of base64, over the 131,072 input bound if counted as text
        expect(Math.ceil(medium.length / 3) * 4).toBeGreaterThan(131_072);
        const built = buildGatewayBody(vision(), ask([msg('user', txt('describe'), image(medium))]));
        expect(decoded(built.body.messages[0]!.content[1])).toEqual(medium);
        const large = png(240, 240, true); // about 173 KB: over the 160 KiB code host cap once encoded
        try { buildGatewayBody(vision(), ask([msg('user', txt('describe'), image(large))])); throw new Error('expected a refusal'); }
        catch (error) {
            expect(error).toBeInstanceOf(LocalRequestError);
            expect((error as LocalRequestError).counts.limitBytes).toBe(AI_PROXY_MAX_BODY_BYTES);
        }
    });

    test('over the code host cap, earlier images become notes before any text is folded; the current image stays intact', () => {
        const earlier = png(150, 150, true), now = png(151, 150, true); // about 90 KB of base64 each: 180 KB together
        const built = buildGatewayBody(vision(), ask([msg('user', txt('first'), image(earlier)), msg('assistant', txt('A chart.')), msg('user', txt('and this'), image(now))]));
        const blocks = built.body.messages.flatMap(m => m.content);
        expect(blocks.filter(b => b.type === 'image').map(decoded)).toEqual([now]);
        expect(blocks).toContainEqual({ type: 'text', text: "[image omitted: earlier images are left out to fit EZiL AI's request size limit]" });
        expect(blocks).toContainEqual({ type: 'text', text: 'first' });
        expect(built.bytes.byteLength).toBeLessThanOrEqual(AI_PROXY_MAX_BODY_BYTES);
    });

    test('on a Responses model an earlier message\'s image is a note; the current one still refuses', () => {
        const responses = { ...gw('synthetic-responses'), gatewayProtocol: 'openai-responses' as const };
        const built = buildGatewayResponsesBody(responses, ask([msg('user', txt('look'), image()), msg('assistant', txt('A chart.')), msg('user', txt('thanks'))]));
        expect(built.body.input[0]).toEqual({ type: 'message', role: 'user', content: 'look[image omitted: not supported by this model]' });
        expect(() => buildGatewayResponsesBody(responses, ask([msg('user', txt('look'), image())]))).toThrow('text and function tools only');
    });

    test('token counts use the Gateway visual-token ceiling, not base64 length', () => {
        const medium = png(150, 150, true);
        const counted = gatewayTokenCount({ role: 'user', parts: [txt('q'), image(medium)] }, 'anthropic-messages', true);
        expect(counted).toBeGreaterThanOrEqual(CLAUDE_IMAGE_TOKENS);
        expect(counted).toBeLessThan(CLAUDE_IMAGE_TOKENS + 200);
        expect(gatewayTokenCount({ role: 'user', parts: [txt('q'), image(medium)] })).toBeLessThan(200);
    });

    test('the mirrored code host cap matches worker/src/ai-proxy.ts', () => {
        const source = readFileSync(`${import.meta.dir}/../../../worker/src/ai-proxy.ts`, 'utf8');
        const match = /export const AI_PROXY_MAX_BODY_BYTES = (\d+) \* (\d+);/.exec(source);
        expect(match).not.toBeNull();
        expect(Number(match![1]) * Number(match![2])).toBe(AI_PROXY_MAX_BODY_BYTES);
    });
});

describe('capability: the config opts in, the catalog proves it per route', () => {
    const v1 = (rows: Record<string, unknown>[]) => ({ object: 'list', contract: 'ezil.gateway.models.v1', killswitch: false, pause: null, data: rows });
    const row = (id: string, capabilities?: Record<string, unknown>, protocols = ['anthropic-messages']) => ({ id, enabled: true, max_input_tokens: 200_000,
        max_output_tokens: 16_000, protocols, availability: { state: 'available', reasons: [] }, ...capabilities ? { capabilities } : {} });
    const on = vision();
    const id = on.model;
    test('image input needs config true and catalog image_input true on Messages', () => {
        expect(withGatewayModelLimits(on, parseGatewayModels(v1([row(id, { image_input: true, tool_calling: true, streaming: true })])))!.capabilities.imageInput).toBe(true);
        for (const catalog of [undefined, parseGatewayModels(v1([])), parseGatewayModels(v1([row(id, { tool_calling: true })])),
            parseGatewayModels(v1([row(id, { image_input: false })])), parseGatewayModels(v1([row(id, { image_input: true }, ['openai-responses', 'anthropic-messages'])])),
            parseGatewayModels({ object: 'list', data: [row(id, { image_input: true })] })]) {
            expect(withGatewayModelLimits(on, catalog).capabilities.imageInput).toBe(false);
        }
        const off = { ...on, capabilities: { toolCalling: true, imageInput: false } };
        expect(withGatewayModelLimits(off, parseGatewayModels(v1([row(id, { image_input: true })]))).capabilities.imageInput).toBe(false);
        expect(withGatewayModelLimits({ ...on, gatewayProtocol: 'openai-responses' }, parseGatewayModels(v1([row(id, { image_input: true })]))).capabilities.imageInput).toBe(false);
    });
    test('catalog-only rows never take images, even when the row says so', () => {
        const listed = gatewayCatalogModels(on.provider, parseGatewayModels(v1([row('synthetic-vision', { image_input: true, tool_calling: true })])), []);
        expect(listed.map(model => model.capabilities.imageInput)).toEqual([false]);
    });
});

// ── The provider as Copilot drives it ────────────────────────────────────────────────────────────────────────────────
const BASE = 'https://computer.test/ai/v1';
const SONNET = 'claude-sonnet-5-5';
const config = (imageInput: boolean | undefined) => parseModelsConfig(JSON.stringify({
    providers: { ezil: { type: 'ezil-gateway', baseUrl: '{env:EZIL_AI_BASE_URL}', apiKey: '{env:EZIL_AI_PROXY_TOKEN}' } },
    models: [{ id: 'qwen.qwen3-coder-next', model: 'qwen.qwen3-coder-next', provider: 'ezil', default: true, roles: ['default', 'utility'], capabilities: { toolCalling: true, imageInput: false } },
        { id: SONNET, model: SONNET, name: 'Claude Sonnet 5.5', provider: 'ezil', capabilities: { toolCalling: true, ...imageInput === undefined ? {} : { imageInput } } }],
}), { env: { EZIL_AI_BASE_URL: BASE, EZIL_AI_PROXY_TOKEN: 'synthetic-proxy-token' } });
const catalog = (imageInput: boolean | undefined) => ({ object: 'list', contract: 'ezil.gateway.models.v1', killswitch: false, pause: null, data: [
    { id: 'qwen.qwen3-coder-next', enabled: true, max_input_tokens: 131_072, max_output_tokens: 8192, protocols: ['anthropic-messages'],
        availability: { state: 'available', reasons: [] }, capabilities: { tool_calling: true, image_input: false, streaming: true } },
    { id: SONNET, enabled: true, max_input_tokens: 200_000, max_output_tokens: 16_000, protocols: ['anthropic-messages'], availability: { state: 'available', reasons: [] },
        capabilities: { tool_calling: true, streaming: true, ...imageInput === undefined ? {} : { image_input: imageInput } } }] });

function harness(resolved: ResolvedConfig, imageInput: boolean | undefined, options: { catalogDown?: boolean; answer?: () => Response } = {}) {
    const posts: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const gets: number[] = [];
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        if (String(input).endsWith('/models')) { gets.push(1); return options.catalogDown ? new Response('unavailable', { status: 503 }) : Response.json(catalog(imageInput)); }
        posts.push(JSON.parse(new TextDecoder().decode(init.body as Uint8Array)));
        return options.answer?.() ?? new Response(frames('end_turn').join(''), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof globalThis.fetch;
    const host = { models: () => resolved.models, configError: () => undefined, secrets: () => resolved.secrets, logRequests: () => true,
        log: (line: string) => { logs.push(line); }, recordUsage: () => {}, fetch };
    return { provider: new EZiLModelsProvider(host), posts, logs, gets };
}
const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
const user = (...content: unknown[]) => ({ role: 1, content });
type Provider = InstanceType<typeof EZiLModelsProvider>;
const send = (provider: Provider, id: string, messages: unknown[], modelOptions = {}, tools: unknown[] = []) =>
    provider.provideLanguageModelChatResponse({ id } as never, messages as never, { tools, modelOptions } as never, { report: () => {} }, token() as never);
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: Error) => error.message);
// Agent mode's size: 38 tools, about 54 KB of definitions.
const AGENT_TOOLS = Array.from({ length: 38 }, (_, i) => ({ name: `tool_${i}`, description: 'd'.repeat(1200),
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'p'.repeat(150) } } } }));
const infos = (provider: Provider) => provider.provideLanguageModelChatInformation({} as never, token() as never);

beforeEach(() => forgetGatewayModels());

describe('provider: the user\'s image goes intact or the turn fails before sending', () => {
    test('opted in and proven: the picker says images, and the PNG reaches the Gateway byte for byte, never in logs', async () => {
        const h = harness(config(true), true);
        expect((await infos(h.provider)).map(info => [info.id, info.capabilities.imageInput])).toEqual([['qwen.qwen3-coder-next', false], [SONNET, true]]);
        const medium = png(64, 64, true);
        await send(h.provider, SONNET, [user(new TextPart('<attachments>\n'), new VsDataPart(medium, 'image/png'), new TextPart('\n</attachments>\nWhat is this?'))]);
        expect(h.posts).toHaveLength(1);
        const content = (h.posts[0]!.messages as { content: unknown[] }[])[0]!.content;
        expect(decoded(content[1])).toEqual(medium);
        const encoded = Buffer.from(medium).toString('base64');
        expect(h.logs.some(line => line.includes(encoded.slice(0, 64)))).toBe(false);
    });

    for (const [name, opted, proven] of [['the Gateway flag is off (image_input false)', true, false], ['the catalog row says nothing', true, undefined],
        ['the config does not opt in', undefined, true], ['the config opts out', false, true]] as const) {
        test(`${name}: no image capability, and an attached image fails clearly with nothing sent`, async () => {
            const h = harness(config(opted), proven);
            expect((await infos(h.provider)).find(info => info.id === SONNET)!.capabilities.imageInput).toBe(false);
            const error = await send(h.provider, SONNET, [user(new TextPart('look'), new VsDataPart(SMALL, 'image/png'))]).then(() => undefined, (e: Error) => e);
            expect(error?.message).toMatch(/Claude Sonnet 5\.5 does not accept images through EZiL AI right now\..*Nothing was sent or charged/);
            expect(h.posts).toHaveLength(0);
        });
    }

    test('unsupported current images fail clearly; text-only turns and utility requests still go', async () => {
        const h = harness(config(true), true);
        const refused = async (...content: unknown[]) => (await send(h.provider, SONNET, [user(...content)]).then(() => undefined, (e: Error) => e))?.message;
        expect(await refused(new TextPart('x'), new VsDataPart(SMALL, 'image/jpeg'))).toMatch(/Image 1 cannot be sent: image\/jpeg images are not supported; only PNG is/);
        expect(await refused(new TextPart('x'), new VsDataPart(SMALL.subarray(0, 40), 'image/png'))).toMatch(/not a valid PNG/);
        // A trailing whitespace-only user message is not the current request (as compaction's `typed`): the image still is.
        expect(await failure(send(h.provider, SONNET, [user(new TextPart('x'), new VsDataPart(SMALL, 'image/jpeg')), user(new TextPart('  '))]))).toMatch(/image\/jpeg/);
        expect(await refused(...Array.from({ length: 5 }, () => new VsDataPart(SMALL, 'image/png')))).toMatch(/5 images; EZiL AI accepts at most 4/);
        expect(await refused(new VsDataPart(png(240, 240, true), 'image/png'))).toMatch(/too large to send: .*over the 163840-byte request limit/);
        expect(h.posts).toHaveLength(0);
        await send(h.provider, SONNET, [user(new TextPart('just text'))]);
        expect(h.posts).toHaveLength(1);
        // A title request about a chat with an image goes (to Qwen, which takes no images) with the image as a note.
        await send(h.provider, SONNET, [user(new TextPart('look'), new VsDataPart(SMALL, 'image/png'))], { requestInitiator: 'title' });
        expect(h.posts).toHaveLength(2);
        expect(JSON.stringify(h.posts[1])).toContain('[image omitted: not supported by this model]');
    });

    test('an earlier message\'s image does not fail a later turn on a model without images', async () => {
        const h = harness(config(true), false);
        await send(h.provider, SONNET, [user(new TextPart('look'), new VsDataPart(SMALL, 'image/png')), { role: 2, content: [new TextPart('A chart.')] }, user(new TextPart('thanks'))]);
        expect(h.posts).toHaveLength(1);
        expect(JSON.stringify(h.posts[0])).toContain('[image omitted: not supported by this model]');
    });

    test('a tool-result image is the current step, not the user\'s attachment: it stays the existing note', async () => {
        const h = harness(config(true), true);
        await send(h.provider, SONNET, [user(new TextPart('run it')), { role: 2, content: [] }, user(new ToolResultPart('c1', [new TextPart('out'), new VsDataPart(SMALL, 'image/png')]))]);
        expect(h.posts).toHaveLength(1);
        expect(JSON.stringify(h.posts[0])).not.toContain('"type":"image"');
    });

    test('in an agent loop the user\'s image stays the current request and goes intact on every step', async () => {
        const h = harness(config(true), true);
        const shot = png(32, 32, true);
        const step = [user(new TextPart('fix the layout'), new VsDataPart(shot, 'image/png')), { role: 2, content: [new ToolCallPart('c1', 'read_file', {})] },
            user(new ToolResultPart('c1', [new TextPart('file text')]))];
        await send(h.provider, SONNET, step, {}, [{ name: 'read_file', inputSchema: { type: 'object', properties: {} } }]);
        const content = (h.posts[0]!.messages as { content: { type: string }[] }[])[0]!.content;
        expect(decoded(content.find(block => block.type === 'image'))).toEqual(shot);
    });

    test('with Agent mode\'s tools, an image over the code host cap is refused as an image problem, nothing sent', async () => {
        const h = harness(config(true), true);
        const message = await failure(send(h.provider, SONNET, [user(new TextPart('look'), new VsDataPart(png(175, 175, true), 'image/png'))], {}, AGENT_TOOLS));
        expect(message).toMatch(/This request with its images is too large to send.*over EZiL AI's 163,840-byte request limit.*Attach a smaller PNG/);
        expect(h.posts).toHaveLength(0);
        // A small screenshot with the same tools still goes.
        await send(h.provider, SONNET, [user(new TextPart('look'), new VsDataPart(png(40, 40, true), 'image/png'))], {}, AGENT_TOOLS);
        expect(h.posts).toHaveLength(1);
    });

    test('a Gateway refusal of the image (its flag went off) forgets the catalog, so the next turn re-reads it', async () => {
        const h = harness(config(true), true, { answer: () => Response.json({ type: 'error', error: { type: 'invalid_request_error', code: 'unsupported_parameter',
            message: 'Image input is not enabled for this gateway.' } }, { status: 400 }) });
        expect(await failure(send(h.provider, SONNET, [user(new TextPart('look'), new VsDataPart(SMALL, 'image/png'))]))).toBeDefined();
        const reads = h.gets.length;
        await failure(send(h.provider, SONNET, [user(new TextPart('again'))]));
        expect(h.gets.length).toBe(reads + 1);
    });

    test('while the model list cannot be read, an opted-in model says so instead of "does not accept images"', async () => {
        const h = harness(config(true), true, { catalogDown: true });
        expect(await failure(send(h.provider, SONNET, [user(new TextPart('look'), new VsDataPart(SMALL, 'image/png'))])))
            .toMatch(/Could not load the model list, so whether Claude Sonnet 5\.5 accepts images cannot be checked right now/);
        expect(h.posts).toHaveLength(0);
    });

    test('imageRefusal ignores requests without images', () => {
        expect(imageRefusal(ask([msg('user', txt('x'))]), gw())).toBeUndefined();
    });
});
