import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildGatewayBody, GEMINI_ALIASES, GEMINI_SCHEMA_KEYWORDS, SAMPLING_REFUSED, parseGatewayTransport, TRANSPORT_CONTRACT } from '../src/gateway-messages';
import { gatewayChat } from '../src/gateway';
import { InferenceTrace, aggregateInference } from '../src/inference-diagnostics';
// Load the actual worker module under its own runtime contract; its Workers TS config differs from the extension's.
const proxyPath = '../../../worker/src/ai-proxy';
const { handleAiProxyRequest, deriveAiProxyToken, effectiveTransport } = await import(proxyPath);
import { ask, call, gw, msg, result, tool, txt } from './fixtures/gateway';
import type { Part, StreamEvent } from '../src/types';

const root = process.env.EZIL_GATEWAY_CONTRACT_ROOT ?? resolve(import.meta.dir, '../../../../gateway-ledger');
const available = existsSync(join(root, 'src/providers/gemini-request.ts'));
const gateway = available ? await import(join(root, 'src/providers/gemini-request.ts')) : undefined;
const response = available ? await import(join(root, 'src/providers/gemini-response.ts')) : undefined;
const carbon = 'gemini-4-carbon';
const signed = (signature: string): Part => ({ type: 'thinking', value: '', metadata: { signature: `ezil-gemini-v1:${signature}`, _completeThinking: '' } });
const edit = { name: 'replace_string_in_file', inputSchema: { type: 'object', properties: {
    filePath: { type: 'string', pattern: '^/', maxLength: 4096 }, oldString: { type: 'string' }, newString: { type: 'string' },
}, required: ['filePath', 'oldString', 'newString'] } };
const transport = { contract: TRANSPORT_CONTRACT, max_request_bytes: { '/v1/messages': 4194304, '/v1/responses': 262144 }, input_bound_method: 'utf8_json_plus_framing', token_limits_unit: 'tokens' };
const model = () => ({ ...gw(carbon), stream: false, maxInputTokens: 983040,
    gatewayMaxRequestBytes: parseGatewayTransport(effectiveTransport(transport))!.max_request_bytes['/v1/messages'] });
const target = (alias = carbon) => ({ routeId: null, modelAlias: alias, providerId: 'fixture', kind: 'google-ai-studio', aigSegment: 'google-ai-studio', protocol: 'anthropic-messages', endpoint: {}, secretName: 'CF_AIG_BYOK', upstreamModel: alias, priority: 1 });
function translate(built: ReturnType<typeof buildGatewayBody>, alias = carbon) {
    return gateway.prepareGeminiRequest(target(alias), { body: built.bytes, stream: built.body.stream }).body;
}
const geminiReply = (parts: unknown[]) => ({ responseId: 'fixture-reply', candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 20, cachedContentTokenCount: 10, totalTokenCount: 140 } });
const generated = (parts: unknown[]) => response.geminiJsonToAnthropic(geminiReply(parts), carbon);
const digest = (data: string) => createHash('sha256').update(data).digest('hex');

describe.skipIf(!available)('Gateway 9deecb9 Carbon contract and owned filesystem', () => {
    test('exact pinned alias/schema/sampling parity and edit schema acceptance', () => {
        expect(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim()).toBe('9deecb9869d7742664c71138ec9412f49ff8b93e');
        expect([...GEMINI_ALIASES].sort()).toEqual([...gateway.GEMINI_MODELS].sort());
        expect([...GEMINI_SCHEMA_KEYWORDS].sort()).toEqual([...gateway.GEMINI_SCHEMA_KEYWORDS].sort());
        expect([...SAMPLING_REFUSED].sort()).toEqual([...gateway.GEMINI_SAMPLING_IGNORED, ...gateway.GEMINI_SAMPLING_UNVERIFIED].sort());
        for (const alias of GEMINI_ALIASES) {
            const built = buildGatewayBody({ ...model(), model: alias, gatewayPromptCache: true }, { ...ask(), tools: [edit], modelOptions: { temperature: 0.4, top_p: 0.8 } });
            const projected = translate(built, alias);
            expect(JSON.stringify(built.body)).not.toContain('cache_control');
            expect(projected.tools[0].functionDeclarations[0].parametersJsonSchema.properties.filePath.description).toContain('maxLength');
            expect(projected.generationConfig.temperature).toBe(alias === 'gemini-3.1-pro-preview' ? 0.4 : undefined);
        }
    });
    test('ordered parallel bindings survive merging; foreign, nonempty, dangling and removed targets never rebind', () => {
        const request = { ...ask([msg('user', txt('inspect')), msg('assistant', signed('TextSig'), txt('Reading.'), signed('SigA'), call('a')),
            msg('assistant', signed('SigB'), call('b'), signed('TrailingSig'), txt('')), msg('user', result('b'), result('a'))]), tools: [tool] };
        const body = translate(buildGatewayBody(model(), request));
        expect(body.contents[1].parts).toEqual([{ text: 'Reading.', thoughtSignature: 'TextSig' },
            { functionCall: { id: 'a', name: 'read_file', args: {} }, thoughtSignature: 'SigA' },
            { functionCall: { id: 'b', name: 'read_file', args: {} }, thoughtSignature: 'SigB' }]);
        expect(body.contents[2].parts.map((p: any) => p.functionResponse.id)).toEqual(['a', 'b']);
        for (const invalid of [signed('bad space'), { ...signed('Nonempty'), value: 'reasoning' },
            { type: 'thinking', value: '', metadata: { signature: 'ClaudeSignature', _completeThinking: '' } } as Part]) {
            const wire = buildGatewayBody(model(), { ...ask([msg('user', txt('q')), msg('assistant', invalid, call('a')), msg('user', result('a'))]), tools: [tool] });
            expect(wire.body.messages[1]!.content.some(b => b.type === 'thinking')).toBe(false);
        }
        const removed = buildGatewayBody(model(), { ...ask([msg('user', txt('q')), msg('assistant', signed('Wrong'), call('bad', 'unavailable'), call('a')), msg('user', result('a'))]), tools: [tool] });
        expect(JSON.stringify(removed.body)).not.toContain('Wrong');
        expect(JSON.stringify(translate(removed))).not.toContain('Wrong');
    });
    for (const mode of ['edit', 'write-error', 'read-only', 'compaction'] as const) test(`large imported project through actual OS proxy and Gateway pure translators: ${mode}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ezil-carbon-project-'));
        try {
            for (let i = 0; i < 180; i++) writeFileSync(join(dir, `import-${i}.ts`), `export const item${i} = '${'imported source '.repeat(80)}';\n`);
            const filePath = join(dir, 'target.ts'); writeFileSync(filePath, 'export const status = "old";\n');
            const before = new Map(readdirSync(dir).map(name => [name, digest(readFileSync(join(dir, name), 'utf8'))]));
            const request = { ...ask([msg('system', txt('Edit only target.ts and retain exact surrounding text.')),
                msg('user', txt('Imported project context: ' + [...before.keys()].map(name => readFileSync(join(dir, name), 'utf8')).join('\n'))),
                msg('assistant', txt('Project imported.')), msg('user', txt('LATEST: replace old with new in target.ts.'))]), tools: [tool, edit] };
            expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(160 * 1024);
            if (mode === 'compaction') request.messages[1]!.parts.push(txt('old context '.repeat(90000)));
            const m = { ...model(), stream: mode === 'edit' }; const sandboxId = 'fixture-sandbox'; const secret = 'synthetic-local-secret'; const nonce = 'fixture-boot';
            m.provider = { ...m.provider, apiKey: await deriveAiProxyToken(secret, sandboxId, nonce) };
            let step = 0; let proof: boolean | null = null;
            const records: ReturnType<InferenceTrace['finish']>[] = [];
            const upstream: any[] = [];
            const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => handleAiProxyRequest(new Request(String(input), init), {
                gatewayUrl: 'https://gateway.invalid', sandboxId, proxySecret: secret, proxyNonce: nonce,
                credential: async () => 'synthetic-user-token', modelAccess: async () => ({ known: true, includedModels: [carbon] }), dropCredential: async () => {},
                fetch: async (req: Request) => {
                    const bytes = new Uint8Array(await req.arrayBuffer());
                    const parsed = gateway.prepareGeminiRequest(target(), { body: bytes, stream: m.stream }).body; upstream.push(parsed);
                    expect(parsed.systemInstruction.parts[0].text).toContain('Edit only target.ts');
                    expect(JSON.stringify(parsed)).toContain('LATEST: replace old with new');
                    expect(parsed.tools[0].functionDeclarations.some((t: any) => t.name === edit.name)).toBe(true);
                    const next = step === 0 || mode === 'read-only' ? { functionCall: { id: `read_${step}`, name: 'read_file', args: { path: filePath } }, thoughtSignature: `ReadSig${step}` }
                        : { functionCall: { id: `edit_${step}`, name: edit.name, args: { filePath, oldString: '"old"', newString: '"new"' } }, thoughtSignature: `EditSig${step}` };
                    if (m.stream) return new Response(response.geminiBody(new Response(`data: ${JSON.stringify(geminiReply([next]))}\n\n`).body!, true, carbon), { headers: { 'content-type': 'text/event-stream', 'x-ezil-request-id': `fixture-${step}` } });
                    return Response.json(generated([next]), { headers: { 'x-ezil-request-id': `fixture-${step}` } });
                },
            })) as typeof fetch;
            for (step = 0; step < 3; step++) {
                const trace = new InferenceTrace(carbon, request);
                const events: StreamEvent[] = [];
                for await (const event of gatewayChat(m, request, { signal: new AbortController().signal, fetch: mockFetch,
                    onDiagnosticTransport: value => trace.transport(value), onCompact: info => { trace.record.compaction = { trigger: info.cause, count: 1, folded: info.folded, shortened: info.shortened }; } })) {
                    trace.event(event); events.push(event);
                }
                records.push(trace.finish(false, false));
                const parts = events.filter((event): event is Extract<StreamEvent, { type: 'text' | 'thinking' | 'tool_call' }> => ['text', 'thinking', 'tool_call'].includes(event.type));
                const requested = parts.find(part => part.type === 'tool_call')! as Extract<Part, { type: 'tool_call' }>;
                let output: Part;
                if (requested.name === 'read_file') output = result(requested.callId, [txt(readFileSync(filePath, 'utf8'))]);
                else if (mode === 'write-error') output = { ...result(requested.callId, [txt('synthetic write refusal')]), isError: true } as Part;
                else {
                    // Execute only the call decoded from Gateway's translated Gemini response, within the owned fixture.
                    const args = requested.input as { filePath: string; oldString: string; newString: string };
                    expect(args.filePath).toBe(filePath);
                    const old = readFileSync(args.filePath, 'utf8');
                    if (old.includes(args.oldString)) writeFileSync(args.filePath, old.replace(args.oldString, args.newString));
                    proof = digest(readFileSync(filePath, 'utf8')) !== before.get('target.ts');
                    output = result(requested.callId, [txt('tool acknowledgement')]); // Public API omits isError: UNKNOWN.
                }
                request.messages.push(msg('assistant', ...parts), msg('user', output));
            }
            expect(readFileSync(filePath, 'utf8')).toBe(mode === 'edit' || mode === 'compaction' ? 'export const status = "new";\n' : 'export const status = "old";\n');
            for (const [name, hash] of before) if (name !== 'target.ts') expect(digest(readFileSync(join(dir, name), 'utf8'))).toBe(hash);
            expect(digest(readFileSync(filePath, 'utf8'))).toBe(digest(mode === 'edit' || mode === 'compaction' ? 'export const status = "new";\n' : 'export const status = "old";\n'));
            expect(records[0]!.wireBytes!).toBeGreaterThan(mode === 'compaction' ? 0 : 160 * 1024);
            expect(records[1]!.thought_signature_replayed).toBe(true);
            expect(JSON.stringify(upstream[1])).toContain('ReadSig0');
            expect(JSON.stringify(upstream[1])).not.toContain('skip_thought_signature_validator');
            expect(records[2]!.results[mode === 'write-error' ? 'error' : 'unknown']).toBe(1);
            expect(records.every(r => r.verifiedFileChange === null && !r.toolReportedSuccess)).toBe(true);
            expect(proof).toBe(mode === 'edit' || mode === 'compaction' ? true : null);
            if (mode === 'compaction') expect(records[0]!.compaction!.folded).toBeGreaterThan(0);
            if (mode === 'read-only') expect(aggregateInference(records).readOnlySuspicions).toBe(3);
            expect(JSON.stringify(records)).not.toMatch(/target\.ts|synthetic write refusal|ReadSig|synthetic-user-token|Imported project/);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
