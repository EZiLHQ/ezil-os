import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildGatewayBody, gatewayInputTokens, gatewayMessage, gatewayOutputTokens, gatewayTokenCount, gatewayTools, KIMI } from '../src/gateway-messages';
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
    test('thinking and redacted thinking are dropped', () => {
        const body = build(ask([msg('user', txt('q')), msg('assistant', thinking, { ...thinking, metadata: { redactedData: 'hidden' } }, txt('answer')), msg('user', txt('next'))]));
        expect(JSON.stringify(body)).not.toMatch(/thinking|reasoning|signature|hidden/);
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
        expect(gatewayTokenCount('你好')).toBe(Buffer.byteLength(JSON.stringify({ type: 'text', text: '你好' })));
        expect(gatewayTokenCount(msg('system', thinking))).toBe(0);
        expect(gatewayInputTokens(gw())).toBe(104480);
        expect(gatewayInputTokens({ ...gw(), toolReserve: 1000 })).toBe(127480);
        // Copilot counts its own tools; the default reserve is only a counting margin.
        expect(gatewayInputTokens({ maxInputTokens: 131072 })).toBe(131072 - 1056 - 1536 - 8000);
    });
    test('actual body bytes plus 1056 are bounded before sending', () => {
        expect(() => build(ask([msg('user', txt('字'.repeat(44000)))]))).toThrow('Conversation too large');
    });
    for (const [name, fixture] of Object.entries(fixtureRequests())) test(`fixture ${name} is produced by sanitizer`, () => {
        const expected = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/gateway-bodies/${name}.json`, 'utf8'));
        expect(buildGatewayBody(fixture.model, fixture.request).body).toEqual(expected);
    });
});
