import { expect, test } from 'bun:test';
import { copilotUsage } from '../src/usage';
import { parseGatewayModels, withGatewayModelLimits, gatewayChat } from '../src/gateway';
import { gatewayInputTokens, buildGatewayBody, gatewayTokenCount } from '../src/gateway-messages';
import { estimatePartTokens } from '../src/tokens';
import { gw, ask, msg, txt, tool } from './fixtures/gateway';
import { messageJson } from './fixtures/gateway-response';
import { gatewayJson } from '../src/gateway-response';
import { gatewayResponsesJson } from '../src/gateway-responses';

test('Messages cache tokens count once toward context, independently of cost discounts', () => {
    expect(copilotUsage({ inputTokens: 500, outputTokens: 60, cacheReadTokens: 3000, cacheWriteTokens: 200 })).toEqual({
        prompt_tokens: 3700, completion_tokens: 60, total_tokens: 3760,
        prompt_tokens_details: { cached_tokens: 3000, cache_creation_input_tokens: 200 }, ezil_usage: { source: 'measured' },
    });
    const missing = copilotUsage({ inputTokens: 500, outputTokens: 60 });
    expect(missing.ezil_usage.source).toBe('estimated');
    expect(missing.prompt_tokens_details).toEqual({});
    expect(copilotUsage({ inputTokens: 500, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 }).ezil_usage.source).toBe('measured');
});

test('Responses inclusive input and output/reasoning subsets survive JSON without cache fabrication', () => {
    const events = gatewayResponsesJson({ id: 'resp_1', object: 'response', status: 'completed', output: [],
        usage: { input_tokens: 1000, output_tokens: 120, input_tokens_details: { cached_tokens: 700 }, output_tokens_details: { reasoning_tokens: 90 } } });
    const event = events.find(event => event.type === 'usage');
    if (event?.type !== 'usage') throw new Error('missing usage');
    const result = copilotUsage(event.usage);
    expect(result).toMatchObject({ prompt_tokens: 1000, completion_tokens: 120, total_tokens: 1120,
        completion_tokens_details: { reasoning_tokens: 90 }, prompt_tokens_details: { cached_tokens: 700 }, ezil_usage: { source: 'measured' } });
    expect(result.prompt_tokens_details).not.toHaveProperty('cache_creation_input_tokens');
    expect(estimatePartTokens({ type: 'thinking', value: 'x'.repeat(34), metadata: { _completeThinking: 'x'.repeat(340) } })).toBe(100);
});

test('Messages JSON permits missing cache counters but never creates cache hits or zero counters', () => {
    const events = gatewayJson({ ...messageJson(), usage: { input_tokens: 53, output_tokens: 12 } });
    const event = events.find(event => event.type === 'usage');
    if (event?.type !== 'usage') throw new Error('missing usage');
    expect(copilotUsage(event.usage)).toMatchObject({ prompt_tokens: 53, completion_tokens: 12, total_tokens: 65, prompt_tokens_details: {}, ezil_usage: { source: 'estimated' } });
});

test('explicit local capacity cannot exceed input allowance; unverified catalog capacity is ignored', () => {
    const model = { ...gw(), toolReserve: 8000, stream: false };
    const row = { id: model.model, enabled: true, max_input_tokens: 131072, max_output_tokens: 8192, context_window_tokens: 262144 };
    const catalog = (contract: string, value: unknown = row.context_window_tokens) => parseGatewayModels({ contract, data: [{ ...row, context_window_tokens: value }] });
    const explicit = withGatewayModelLimits({ ...model, contextWindowTokens: 262144 }, catalog('ezil.gateway.models.v1'));
    expect(withGatewayModelLimits(model, catalog('ezil.gateway.models.v1')).contextWindowTokens).toBeUndefined();
    expect(explicit.contextWindowTokens).toBe(262144);
    expect(gatewayInputTokens(explicit)).toBe(112832); // min(131072, 262144 - 8192) - 8192 summary - 2048 system - 8000 tools
    expect(gatewayInputTokens({ ...explicit, maxOutputTokens: 4096 })).toBe(112832);
    expect(gatewayInputTokens(withGatewayModelLimits({ ...model, contextWindowTokens: 65536 }, catalog('ezil.gateway.models.v1')))).toBe(39104);
    for (const c of [catalog('legacy'), catalog('ezil.gateway.models.v1', -1), catalog('ezil.gateway.models.v1', '262144')]) {
        expect(gatewayInputTokens(withGatewayModelLimits(model, c))).toBe(104640);
    }
    expect(() => buildGatewayBody(explicit, ask([msg('user', txt('x'.repeat(131072)))]))).toThrow();
});

test('long tool/multiturn history uses token units; transport compaction adds no paid summary or resend', async () => {
    const model = { ...gw(), toolReserve: 8000, stream: false };
    const history = [msg('system', txt('Keep system instructions')), msg('user', txt('start'))];
    let dispatches = 0, compactions = 0;
    const localFetch = (async (_url: unknown, init?: RequestInit) => {
        dispatches++;
        const bytes = init!.body as Uint8Array;
        expect(bytes.byteLength + 1056).toBeLessThanOrEqual(131072);
        expect(new TextDecoder().decode(bytes)).toContain('Keep system instructions');
        return Response.json(messageJson());
    }) as typeof fetch;
    for (let turn = 0; turn < 20; turn++) {
        history.push(msg('assistant', { type: 'tool_call', callId: `call_${turn}`, name: tool.name, input: {} }),
            msg('user', { type: 'tool_result', callId: `call_${turn}`, content: [txt('x'.repeat(8500))] }), msg('user', txt(`current ${turn}`)));
        const occupancy = history.reduce((n, message) => n + gatewayTokenCount(message), 0);
        expect(occupancy).toBeLessThan(51000); // 20 x 2500 tokens plus framing: below half of safe 104640.
        const request = { ...ask(history), tools: [tool] };
        const before = JSON.stringify(request);
        for await (const _event of gatewayChat(model, request, { signal: new AbortController().signal, fetch: localFetch,
            log: () => {}, onCompact: () => { compactions++; } })) { /* drain */ }
        expect(dispatches).toBe(turn + 1);
        expect(JSON.stringify(request)).toBe(before); // saved chat is never rewritten
    }
    expect(compactions).toBeGreaterThan(0); // byte bound can still require local shaping at low TOKEN occupancy
});
