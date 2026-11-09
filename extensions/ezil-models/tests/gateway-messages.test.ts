import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildGatewayBody, gatewayInputTokens, gatewayMessage, gatewayOutputTokens, gatewayTokenCount, gatewayTools, geminiRoute, geminiToolSchema, KIMI, LocalRequestError, replaysThinking } from '../src/gateway-messages';
import type { Tool } from '../src/types';
import { ask, call, fixtureRequests, gw, image, marker, msg, result, thinking, tool, txt } from './fixtures/gateway';

const build = (request = ask()) => buildGatewayBody(gw(), request).body;
describe('gateway sanitizer', () => {
    test('only allowlisted top-level options; sampling only when passed', () => {
        expect(Object.keys(build()).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream']);
        const request = { ...ask(), modelOptions: { temperature: 3, top_p: -3, cache_control: {}, metadata: {}, thinking: {}, top_k: 2, output_config: {}, stream: false, max_tokens: 1, stop_sequences: ['x'] } };
        const body = build(request);
        expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream', 'temperature', 'top_p']);
        expect(body.temperature).toBe(1); expect(body.top_p).toBe(0);
        expect(body.max_tokens).toBe(8192);
    });
    test('configured sampling is clamped; nonfinite sampling omitted', () => {
        const model = { ...gw(), temperature: -1, topP: 3 };
        expect(buildGatewayBody(model, ask()).body).toMatchObject({ temperature: 0, top_p: 1 });
        expect(buildGatewayBody(model, { ...ask(), modelOptions: { temperature: NaN, top_p: Infinity } }).body.temperature).toBeUndefined();
    });
    test('Gemini aliases that refuse sampling never get temperature/top_p; other models keep them', () => {
        const options = { ...ask(), modelOptions: { temperature: 0.2, top_p: 0.9 } };
        for (const alias of ['gemini-3.8-flash', ' Gemini-3.8-Flash ', 'gemini-4-argon']) {
            const lines: string[] = [];
            const body = buildGatewayBody({ ...gw(), model: alias, temperature: 0.5, topP: 0.5 }, options, line => lines.push(line)).body;
            expect(body.temperature).toBeUndefined(); expect(body.top_p).toBeUndefined();
            expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream']);
            expect(lines).toEqual([`[gateway] temperature/top_p not sent: ${alias} refuses sampling options`]);
        }
        expect(buildGatewayBody({ ...gw(), model: 'gemini-3.8-flash' }, ask(), () => { throw new Error('no option, no log'); }).body.temperature).toBeUndefined();
        for (const alias of [gw().model, KIMI, 'gemini-3.1-pro-preview', 'gemini-3.8-flash-lite']) {
            expect(buildGatewayBody({ ...gw(), model: alias }, options).body).toMatchObject({ temperature: 0.2, top_p: 0.9 });
            expect(buildGatewayBody({ ...gw(), model: alias, temperature: 0.4, topP: 0.6 }, ask()).body).toMatchObject({ temperature: 0.4, top_p: 0.6 });
        }
    });
    test('system messages become text blocks and empty system text is dropped', () => {
        const body = build(ask([msg('system', txt(''), txt('rules'), marker), msg('user', txt('q'))]));
        expect(body.system).toEqual([{ type: 'text', text: 'rules' }]);
        expect(body.messages).toHaveLength(1);
    });
    test('image and document inputs become notes, text data stays text', () => {
        const body = build(ask([msg('user', image, { ...image, mimeType: 'application/pdf' }, { ...image, mimeType: 'text/plain', data: new TextEncoder().encode('data') })]));
        expect(body.messages[0]!.content).toEqual([{ type: 'text', text: '[image omitted: not supported by this model]' }, { type: 'text', text: '[document omitted: not supported by this model]' }, { type: 'text', text: 'data' }]);
    });
    test('empty blocks drop; empty messages have explicit filler', () => {
        expect(build(ask([msg('user', txt(''), txt('x'))])).messages[0]!.content).toEqual([{ type: 'text', text: 'x' }]);
        expect(build(ask([msg('user', txt(''))])).messages[0]!.content).toEqual([{ type: 'text', text: '(empty)' }]);
    });
    test('assistant-first and assistant-last history has user boundaries', () => {
        const body = build(ask([msg('assistant', txt('answer'))]));
        expect(body.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(build(ask([])).messages[0]!.role).toBe('user');
    });
    test('cache_control is stripped from every envelope, even with caching configured', () => {
        const request = { ...ask([msg('system', txt('sys'), marker), msg('user', txt('q'), marker), msg('assistant', call('a'), marker), msg('user', result('a', [txt('out'), marker]), marker)]), tools: [{ ...tool, cache_control: { type: 'ephemeral' } }], modelOptions: { cache_control: { type: 'ephemeral' } } };
        expect(JSON.stringify(buildGatewayBody({ ...gw(), cache: { enabled: true, ttl: '1h' } }, request).body)).not.toContain('cache_control');
    });
    test('signed thinking and redacted thinking are dropped on every non-native route (Qwen, Kimi Converse)', () => {
        for (const id of [gw().model, KIMI]) {
            const body = buildGatewayBody(gw(id), ask([msg('user', txt('q')), msg('assistant', thinking, { ...thinking, metadata: { redactedData: 'hidden' } }, txt('answer')), msg('user', txt('next'))])).body;
            expect(body.messages[1]!.content).toEqual([{ type: 'text', text: 'answer' }]);
            expect(JSON.stringify(body)).not.toMatch(/thinking|hidden|"sig"/);
        }
    });
    test('the native route is decided by the explicit Claude model id only', () => {
        for (const id of ['claude-sonnet-5-5', 'anthropic.claude-sonnet-5-5', 'us.anthropic.claude-sonnet-5-5']) expect(replaysThinking(id)).toBe(true);
        for (const id of [gw().model, KIMI, 'gemini-3.8-flash', 'gpt-6.1-sol', 'claude', 'x.claude-sonnet-5-5', 'us.anthropic.claude-sonnet-5-5\n']) expect(replaysThinking(id)).toBe(false);
    });
    test('signed thinking and redacted thinking are replayed on the native Anthropic route', () => {
        const body = buildGatewayBody(gw('us.anthropic.claude-sonnet-5-5'), ask([msg('user', txt('q')), msg('assistant', thinking, { ...thinking, metadata: { redactedData: 'hidden' } }, txt('answer')), msg('user', txt('next'))])).body;
        expect(body.messages[1]!.content).toEqual([{ type: 'thinking', thinking: 'reasoning', signature: 'sig' },
            { type: 'redacted_thinking', data: 'hidden' }, { type: 'text', text: 'answer' }]);
        expect(JSON.stringify(body)).not.toContain(thinking.value);
    });
    test('tool_use arguments are objects; invalid arguments and identifiers become text', () => {
        const request = { ...ask([msg('assistant', call('valid'), call('bad.id'), call('array', 'read_file', []), call('inf', 'read_file', { n: Infinity }))]), tools: [tool] };
        const body = build(request);
        expect(body.messages[1]!.content[0]).toEqual({ type: 'tool_use', id: 'valid', name: 'read_file', input: {} });
        expect(body.messages[1]!.content.slice(1).every(b => b.type === 'text')).toBe(true);
    });
    test('tool_result text flattens images, preserves error, and defaults empty output', () => {
        const body = build({ ...ask([msg('assistant', call('a'), call('b')), msg('user', { ...result('a', [txt('output'), image]), isError: true } as never, result('b', []))]), tools: [tool] });
        expect(body.messages.at(-1)!.content).toEqual([
            { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'output\n[image omitted: not supported by this model]' }], is_error: true },
            { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: '(no output)' }] },
        ]);
    });
    test('merge turns, repair missing results, orphan/duplicate results and undefined calls', () => {
        const body = build({ ...ask([msg('assistant', call('a')), msg('assistant', call('b'), call('a'), call('undefined', 'missing')), msg('user', result('a')), msg('user', result('a'), result('orphan'))]), tools: [tool] });
        expect(body.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
        const results = body.messages[2]!.content.filter(b => b.type === 'tool_result');
        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({ tool_use_id: 'b', is_error: true });
        expect(body.messages[1]!.content.filter(b => b.type === 'tool_use')).toHaveLength(2);
    });
    test('trailing calls get explicit failed results', () => {
        const body = build({ ...ask([msg('assistant', call('a'))]), tools: [tool] });
        expect(body.messages.at(-1)!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'a', is_error: true });
    });
    test('tools cap keeps first 64 and logs dropped names once', () => {
        const logs: string[] = [];
        const tools = Array.from({ length: 70 }, (_, i) => ({ ...tool, name: `tool_${i}` }));
        const kept = gatewayTools(tools, s => logs.push(s));
        expect(kept).toHaveLength(64); expect(kept.map(t => t.name)).toEqual(tools.slice(0, 64).map(t => t.name));
        expect(logs).toHaveLength(1); expect(logs[0]).toContain('tool_69');
    });
    test('tool names filter invalid and duplicate; schema object required; empty descriptions omitted', () => {
        const logs: string[] = [];
        const kept = gatewayTools([{ name: 'valid' }, { name: 'valid' }, { name: 'bad.name' }, { name: '' }, { name: 'x'.repeat(65) }, { name: 'array', inputSchema: { type: 'array' } }, { name: 'empty', description: ' ' }], s => logs.push(s));
        expect(kept).toEqual([{ name: 'valid', input_schema: { type: 'object', properties: {} } }, { name: 'empty', input_schema: { type: 'object', properties: {} } }]);
        expect(logs).toHaveLength(1);
    });
    test('required tool mode is auto, no tool_choice without tools', () => {
        const logs: string[] = [];
        const body = buildGatewayBody(gw(), { ...ask(), tools: [tool], toolMode: 'required' }, s => logs.push(s)).body;
        expect(body.tool_choice).toEqual({ type: 'auto' }); expect(logs[0]).toContain('mapped to auto');
        expect(build({ ...ask(), toolMode: 'required' }).tool_choice).toBeUndefined();
    });
    test('output limits are 16..16384, configured per model', () => {
        expect(gatewayOutputTokens({ ...gw(), maxOutputTokens: 1 })).toBe(16);
        expect(gatewayOutputTokens({ ...gw(), maxOutputTokens: 99000 })).toBe(16384);
        expect(gatewayOutputTokens(gw(KIMI))).toBe(4096);
    });
    test('Kimi never streams even when config and options request it', () => {
        expect(buildGatewayBody({ ...gw(KIMI), stream: true }, { ...ask(), modelOptions: { stream: true } }).body.stream).toBe(false);
        expect(buildGatewayBody({ ...gw(), stream: false }, ask()).body.stream).toBe(false);
        expect(build().stream).toBe(true);
    });
    test('byte count matches serialized UTF-8 wire messages and text parts', () => {
        const message = msg('user', txt('你好 🌍\n"'));
        expect(gatewayTokenCount(message)).toBe(Buffer.byteLength(JSON.stringify(gatewayMessage(message))));
        // A string counts as the text block it would be sent as (gateway-budget.test.ts says why).
        expect(gatewayTokenCount('你好')).toBe(Buffer.byteLength(JSON.stringify({ type: 'text', text: '你好' })));
        expect(gatewayTokenCount(msg('system', thinking))).toBe(0);
        expect(gatewayInputTokens(gw())).toBe(104480);
        expect(gatewayInputTokens({ ...gw(), toolReserve: 1000 })).toBe(127480);
        // Copilot counts its own tools; the default reserve is only a counting margin.
        expect(gatewayInputTokens({ maxInputTokens: 131072 })).toBe(131072 - 1056 - 1536 - 8000);
    });
    test('actual body bytes plus 1056 are bounded before sending', () => {
        expect(() => build(ask([msg('user', txt('字'.repeat(44000)))]))).toThrow(LocalRequestError);
        expect(() => build(ask([msg('user', txt('字'.repeat(43000)))]))).not.toThrow();
    });
    for (const [name, fixture] of Object.entries(fixtureRequests())) test(`fixture ${name} is produced by sanitizer`, () => {
        const expected = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/gateway-bodies/${name}.json`, 'utf8'));
        expect(buildGatewayBody(fixture.model, fixture.request).body).toEqual(expected);
    });
});

// The Gateway's Gemini schema allowlist (EZiL AI Gateway d59b82a5 src/providers/gemini-request.ts GEMINI_SCHEMA_KEYWORDS).
const GATEWAY_GEMINI_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'enum', 'format', 'minimum', 'maximum',
    'items', 'prefixItems', 'minItems', 'maxItems', 'anyOf', '$ref', '$defs', 'title', 'description', '$schema', '$id', '$comment', 'default', 'examples']);
/** Every keyword in a schema, walking the same schema positions as the Gateway. */
function keywords(schema: unknown, found = new Set<string>()): Set<string> {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return found;
    for (const [key, member] of Object.entries(schema)) {
        found.add(key);
        if (key === 'properties' || key === '$defs') for (const child of Object.values(member as object)) keywords(child, found);
        if (key === 'items' || key === 'additionalProperties') keywords(member, found);
        if (key === 'prefixItems' || key === 'anyOf') for (const child of member as unknown[]) keywords(child, found);
    }
    return found;
}
// Copilot Chat 0.69's own tools whose schemas carry keywords the Gateway refuses for Gemini (captured from the image, Agent mode).
const copilotTools = (): Tool[] => JSON.parse(readFileSync(new URL('./fixtures/copilot-0.69-gemini-tools.json', import.meta.url), 'utf8'));
const geminiBody = (tools: Tool[], log?: (line: string) => void) => buildGatewayBody({ ...gw(), model: 'gemini-3.8-flash' }, { ...ask(), tools }, log).body;

describe('Gemini tool schemas', () => {
    test('the depth bound is the Gateway\'s, boolean leaves included', () => {
        const nest = (levels: number, leaf: unknown) => { let node: unknown = leaf; for (let i = 0; i < levels; i++) node = { type: 'array', items: node }; return node; };
        // The root is depth 0 and `properties.a` depth 1, so a leaf under 63 more arrays sits at depth 64.
        for (const leaf of [true, { type: 'string' }]) {
            expect(geminiToolSchema({ type: 'object', properties: { a: nest(63, leaf) } })).toBeDefined();
            expect(geminiToolSchema({ type: 'object', properties: { a: nest(64, leaf) } })).toBeUndefined();
        }
    });
    test('a JSON-parsed __proto__ key is kept as a property or restated, never lost', () => {
        const property = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string","maxLength":3}},"required":["__proto__"]}');
        const projected = geminiToolSchema(property) as any;
        expect(Object.hasOwn(projected.properties, '__proto__')).toBe(true);
        expect(Object.getOwnPropertyDescriptor(projected.properties, '__proto__')!.value).toEqual({ type: 'string', description: 'JSON Schema constraints: {"maxLength":3}' });
        expect(JSON.stringify(projected)).toBe('{"type":"object","properties":{"__proto__":{"type":"string","description":"JSON Schema constraints: {\\"maxLength\\":3}"}},"required":["__proto__"]}');
        const keyword = geminiToolSchema(JSON.parse('{"type":"string","__proto__":{"x":1}}')) as any;
        expect(keyword).toEqual({ type: 'string', description: 'JSON Schema constraints: {"__proto__":{"x":1}}' });
    });
    test('Copilot tools keep every tool, only allowlisted keywords, and the moved constraints verbatim in descriptions', () => {
        const tools = copilotTools();
        const before = structuredClone(tools);
        const lines: string[] = [];
        const body = geminiBody(tools, line => lines.push(line));
        expect(body.tools!.map(t => t.name)).toEqual(tools.map(t => t.name));
        for (const t of body.tools!) for (const key of keywords(t.input_schema)) expect(GATEWAY_GEMINI_KEYWORDS.has(key)).toBe(true);
        const sent = JSON.stringify(body.tools);
        const terminalId = (before.find(t => t.name === 'get_terminal_output')!.inputSchema as any).properties.id;
        expect((body.tools!.find(t => t.name === 'get_terminal_output')!.input_schema as any).properties.id).toEqual({
            type: 'string', description: `${terminalId.description}\nJSON Schema constraints: ${JSON.stringify({ pattern: terminalId.pattern })}`,
        });
        expect(sent).toContain(JSON.stringify(JSON.stringify({ maxLength: 50 })).slice(1, -1));
        expect(sent).toContain('enumDescriptions');
        // Copilot validates tool input against its own schema: that object must be untouched.
        expect(tools).toEqual(before);
        expect(lines).toEqual(['[gateway] tool schema keywords Gemini refuses restated in descriptions: ["vscode_askQuestions","get_terminal_output","kill_terminal","run_in_terminal","send_to_terminal"]']);
    });
    test('other routes send the schemas unchanged', () => {
        const tools = copilotTools();
        for (const model of ['qwen.qwen3-coder-next', KIMI, 'claude-sonnet-5-5', 'gemini-3.8-flash-preview', 'google.gemini-3.8-flash']) {
            const body = buildGatewayBody({ ...gw(), model }, { ...ask(), tools }, () => { throw new Error('no log'); }).body;
            expect(body.tools!.map(t => t.input_schema)).toEqual(tools.map(t => t.inputSchema as Record<string, unknown>));
        }
        expect(['gemini-3.8-flash', ' Gemini-3.1-Pro-Preview ', 'gemini-4-argon'].every(geminiRoute)).toBe(true);
    });
    test('const becomes a one-value enum; beside an enum it is restated instead', () => {
        expect(geminiToolSchema({ type: 'object', properties: { mode: { type: 'string', const: 'read' } } }))
            .toEqual({ type: 'object', properties: { mode: { type: 'string', enum: ['read'] } } });
        expect(geminiToolSchema({ type: 'string', enum: ['a', 'b'], const: 'a' }))
            .toEqual({ type: 'string', enum: ['a', 'b'], description: 'JSON Schema constraints: {"const":"a"}' });
    });
    test('nested positions are projected; a property named like a keyword stays a property', () => {
        const restated = new Set<string>();
        const schema = { type: 'object', description: 'Top.', properties: { pattern: { type: 'string', minLength: 1 },
            list: { type: 'array', uniqueItems: true, items: { anyOf: [{ type: 'string', format: 'uri', maxLength: 9 }, { type: 'null' }] } },
            pair: { type: 'array', prefixItems: [{ type: 'number', multipleOf: 2 }] }, ref: { $ref: '#/$defs/x' } },
            $defs: { x: { type: 'integer', exclusiveMinimum: 0 } }, additionalProperties: { type: 'string', deprecated: true } };
        expect(geminiToolSchema(schema, restated)).toEqual({ type: 'object', description: 'Top.', properties: {
            pattern: { type: 'string', description: 'JSON Schema constraints: {"minLength":1}' },
            list: { type: 'array', items: { anyOf: [{ type: 'string', format: 'uri', description: 'JSON Schema constraints: {"maxLength":9}' }, { type: 'null' }] },
                description: 'JSON Schema constraints: {"uniqueItems":true}' },
            pair: { type: 'array', prefixItems: [{ type: 'number', description: 'JSON Schema constraints: {"multipleOf":2}' }] }, ref: { $ref: '#/$defs/x' } },
            $defs: { x: { type: 'integer', description: 'JSON Schema constraints: {"exclusiveMinimum":0}' } },
            additionalProperties: { type: 'string', description: 'JSON Schema constraints: {"deprecated":true}' } });
        expect([...restated].sort()).toEqual(['deprecated', 'exclusiveMinimum', 'maxLength', 'minLength', 'multipleOf', 'uniqueItems']);
    });
    test('a schema-holding keyword or a value the Gateway refuses drops only that tool', () => {
        const ok: Tool = { name: 'ok', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } };
        const bad = (name: string, inner: object): Tool => ({ name, inputSchema: { type: 'object', properties: { a: inner } } });
        let deep: object = { type: 'string' };
        for (let i = 0; i < 70; i++) deep = { type: 'array', items: deep };
        const refused = [bad('one_of', { oneOf: [{ type: 'string' }] }), bad('all_of', { allOf: [{ type: 'string' }] }), bad('not_', { not: { type: 'null' } }),
            bad('if_then', { if: { type: 'string' }, then: { minLength: 1 } }), bad('pattern_props', { type: 'object', patternProperties: { x: {} } }),
            { name: 'definitions', inputSchema: { type: 'object', definitions: { x: { type: 'string' } } } },
            bad('bad_type', { type: 'date' }), bad('empty_enum', { enum: [] }), bad('frac_items', { type: 'array', minItems: 1.5 }),
            bad('num_description', { type: 'string', description: 3 }), bad('empty_any_of', { anyOf: [] }), bad('deep', deep)];
        const lines: string[] = [];
        const body = geminiBody([ok, ...refused], line => lines.push(line));
        expect(body.tools!.map(t => t.name)).toEqual(['ok']);
        expect(lines).toEqual([`[gateway] dropped tools: ${JSON.stringify(refused.map(t => t.name))}`]);
        expect(geminiBody(refused, () => {}).tools).toBeUndefined();
        for (const inner of [{ type: 'string', contentSchema: { type: 'object' } }, { $dynamicRef: '#node' }, { type: 'object', required: [1] },
            { type: 'number', minimum: '1' }, { type: 'number', maximum: null }, { type: 'object', properties: [] }]) {
            expect(geminiToolSchema({ type: 'object', properties: { a: inner } })).toBeUndefined();
        }
        expect(geminiBody(refused, () => {}).tool_choice).toBeUndefined();
    });
});
