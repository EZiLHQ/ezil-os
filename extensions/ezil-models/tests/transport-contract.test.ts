import { expect, test } from 'bun:test';
import { ENDPOINT_MAX_BYTES, parseGatewayTransport, gatewayInputTokens, buildGatewayBody, INPUT_FRAMING, LocalRequestError } from '../src/gateway-messages';
import { buildGatewayResponsesBody } from '../src/gateway-responses';
import { parseGatewayModels, withGatewayModelLimits, gatewayChat } from '../src/gateway';
import { gw, ask, msg, txt, tool } from './fixtures/gateway';
import { messageJson } from './fixtures/gateway-response';
const transport = { contract: 'ezil.gateway.transport.v1', max_request_bytes: ENDPOINT_MAX_BYTES,
    input_bound_method: 'utf8_json_plus_framing', token_limits_unit: 'tokens' } as const;
function model(protocol: 'anthropic-messages' | 'openai-responses' = 'anthropic-messages', cap = 983040) {
    const base = { ...gw(), gatewayProtocol: protocol, maxInputTokens: cap, stream: false };
    return withGatewayModelLimits(base, parseGatewayModels({ transport, data: [{ id: base.model, enabled: true, max_input_tokens: cap, max_output_tokens: 8192 }] }));
}
test('transport contract feature detection, hard clamps and conservative old-server fallback', () => {
    expect(parseGatewayTransport(transport)).toEqual(transport);
    expect(parseGatewayTransport({ ...transport, max_request_bytes: { '/v1/messages': 1e9, '/v1/responses': 1e9 } })?.max_request_bytes).toEqual(ENDPOINT_MAX_BYTES);
    for (const value of [undefined, {}, { ...transport, token_limits_unit: 'bytes' }, { ...transport, contract: 'future' }, { ...transport, max_request_bytes: { '/v1/messages': 1.5 } }]) expect(parseGatewayTransport(value)).toBeUndefined();
    expect(() => buildGatewayBody({ ...gw(), maxInputTokens: 983040 }, ask([msg('user', txt('x'.repeat(160000)))]))).toThrow(LocalRequestError);
});
test('explicit capacity and verified input allowance keep reserves in token units', () => {
    const base = { ...model(), maxInputTokens: 131072, contextWindowTokens: 262144, toolReserve: 8000 };
    expect(gatewayInputTokens(base)).toBe(112832);
    expect(gatewayInputTokens({ ...base, contextWindowTokens: 65536 })).toBe(39104);
    expect(gatewayInputTokens({ ...base, contextWindowTokens: undefined })).toBe(112832);
});
test('long multiturn >128 KiB fits model AND verified endpoint without compaction or resend', async () => {
    const m = model();
    const history = [msg('system', txt('Keep rules')), msg('user', txt('start'))];
    for (let i = 0; i < 20; i++) history.push(msg('assistant', { type: 'tool_call', name: tool.name, callId: `t${i}`, input: {} }),
        msg('user', { type: 'tool_result', callId: `t${i}`, content: [txt('字'.repeat(3000))] }));
    history.push(msg('user', txt('continue')));
    const request = { ...ask(history), tools: [tool] }, saved = JSON.stringify(request);
    let calls = 0, compactions = 0;
    const localFetch = (async (_url: unknown, init?: RequestInit) => {
        calls++;
        const bytes = init!.body as Uint8Array;
        expect(bytes.byteLength).toBeGreaterThan(160 * 1024);
        expect(bytes.byteLength).toBeLessThanOrEqual(ENDPOINT_MAX_BYTES['/v1/messages']);
        expect(bytes.byteLength + INPUT_FRAMING).toBeLessThanOrEqual(m.maxInputTokens);
        return Response.json(messageJson());
    }) as typeof fetch;
    for await (const _ of gatewayChat(m, request, { signal: new AbortController().signal, fetch: localFetch, onCompact: () => compactions++ })) {}
    expect(calls).toBe(1); expect(compactions).toBe(0); expect(JSON.stringify(request)).toBe(saved);
    expect(() => buildGatewayBody({ ...m, maxInputTokens: 128000 }, request)).toThrow(LocalRequestError);
});
test('Messages exact endpoint cap and conservative model bound both apply', () => {
    const m = { ...model(), maxInputTokens: 5_000_000 };
    const fixed = buildGatewayBody(m, ask([msg('user', txt('x'))])).bytes.byteLength - 1;
    const cap = ENDPOINT_MAX_BYTES['/v1/messages'];
    expect(buildGatewayBody(m, ask([msg('user', txt('x'.repeat(cap - fixed)))])).bytes.byteLength).toBe(cap);
    expect(() => buildGatewayBody(m, ask([msg('user', txt('x'.repeat(cap - fixed + 1))) ]))).toThrow(LocalRequestError);
    const small = { ...m, maxInputTokens: 10000 };
    expect(buildGatewayBody(small, ask([msg('user', txt('x'.repeat(10000 - INPUT_FRAMING - fixed)))])).bytes.byteLength + INPUT_FRAMING).toBe(10000);
    expect(() => buildGatewayBody(small, ask([msg('user', txt('x'.repeat(10001 - INPUT_FRAMING - fixed))) ]))).toThrow(LocalRequestError);
});
test('Responses endpoint cap and its escaped-schema/item/tool bound remain independent', () => {
    const m = model('openai-responses');
    const request = ask([msg('user', txt('字'.repeat(55000)))]);
    expect(buildGatewayResponsesBody(m, request).bytes.byteLength).toBeGreaterThan(131072);
    expect(() => buildGatewayResponsesBody({ ...m, maxInputTokens: 131072 }, request)).toThrow(LocalRequestError);
    expect(() => buildGatewayResponsesBody(m, ask([msg('user', txt('字'.repeat(90000)))]))).toThrow(LocalRequestError);
    const schemaRequest = { ...ask([msg('user', txt('hi'))]), tools: [{ ...tool, inputSchema: { type: 'object', description: '字'.repeat(1000) } }] };
    const built = buildGatewayResponsesBody(m, schemaRequest);
    expect(() => buildGatewayResponsesBody({ ...m, maxInputTokens: built.bytes.byteLength + 2000 }, schemaRequest)).toThrow(LocalRequestError);
});
