// In-process mock of the Anthropic Messages API (streaming). Used by the integration tests and usable
// as a stand-in endpoint for a `type: "anthropic"` provider with `baseUrl` pointing at it.
//
// Behaviour:
//  - requires `x-api-key` == the configured key (else 401) and an `anthropic-version` header (else 400)
//  - answers with a scripted plan (`next(...)`) or a heuristic: tool_result in the last message -> "Done.",
//    a user prompt mentioning hello.txt with a create_file tool -> text + tool_use, otherwise an echo
//  - simulates prompt caching: the first request with a given system prompt and `cache_control` reports
//    cache_creation_input_tokens, later ones cache_read_input_tokens
//  - special model ids: mock-401, mock-429 (retry-after: 7), mock-refusal, mock-error-event, mock-overloaded

import http from 'node:http';
import { createHash } from 'node:crypto';

export type MockBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'thinking'; thinking: string; signature: string }
    | { type: 'redacted_thinking'; data: string };

export type MockPlan = MockBlock[] | ((body: Record<string, unknown>) => MockBlock[]);

export type CapturedRequest = { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };

export type MockServer = {
    url: string;
    port: number;
    requests: CapturedRequest[];
    next(plan: MockPlan): void;
    close(): Promise<void>;
};

function estimate(text: string): number { return Math.ceil(text.length / 4); }

function systemText(body: Record<string, unknown>): string {
    const system = body.system;
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) return system.map(block => (block as { text?: string }).text ?? '').join('');
    return '';
}

function hasCacheControl(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasCacheControl);
    if (typeof value === 'object' && value !== null) return 'cache_control' in value || Object.values(value).some(hasCacheControl);
    return false;
}

function heuristic(body: Record<string, unknown>): MockBlock[] {
    const messages = body.messages as { role: string; content: unknown }[];
    const last = messages.at(-1);
    const content = Array.isArray(last?.content) ? last!.content as Record<string, unknown>[] : [];
    if (content.some(block => block.type === 'tool_result')) return [{ type: 'text', text: 'Done. I created the file as requested.' }];
    const text = content.filter(block => block.type === 'text').map(block => String(block.text)).join('') || (typeof last?.content === 'string' ? last.content : '');
    const tools = (body.tools ?? []) as { name: string }[];
    if (/hello\.txt/i.test(text) && tools.some(tool => tool.name === 'create_file')) {
        return [
            { type: 'text', text: 'I will create hello.txt now.' },
            { type: 'tool_use', id: `toolu_mock_${Date.now()}`, name: 'create_file', input: { filePath: '/home/coder/project/hello.txt', content: 'hi\n' } },
        ];
    }
    return [{ type: 'text', text: `Mock Claude reply. tools=${tools.length} messages=${messages.length}. You said: "${text.slice(0, 80)}"` }];
}

function chunk(text: string, size = 7): string[] {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out.length ? out : [''];
}

export async function startMockAnthropic(options: { apiKey: string; port?: number } = { apiKey: 'test-key' }): Promise<MockServer> {
    const requests: CapturedRequest[] = [];
    const seenSystems = new Set<string>();
    let scripted: MockPlan | undefined;
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', part => { raw += part; });
        req.on('end', () => {
            const send = (event: string, data: unknown) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
            const fail = (status: number, type: string, message: string, headers: Record<string, string> = {}) => {
                res.writeHead(status, { 'content-type': 'application/json', ...headers });
                res.end(JSON.stringify({ type: 'error', error: { type, message } }));
            };
            let body: Record<string, unknown>;
            try { body = JSON.parse(raw || '{}'); } catch { fail(400, 'invalid_request_error', 'body is not JSON'); return; }
            requests.push({ url: req.url ?? '', headers: req.headers, body });
            if (req.method !== 'POST' || !(req.url ?? '').endsWith('/v1/messages')) { fail(404, 'not_found_error', `no route ${req.method} ${req.url}`); return; }
            if (req.headers['x-api-key'] !== options.apiKey) { fail(401, 'authentication_error', 'invalid x-api-key'); return; }
            if (!req.headers['anthropic-version']) { fail(400, 'invalid_request_error', 'anthropic-version header is required'); return; }
            const model = String(body.model);
            if (model === 'mock-401') { fail(401, 'authentication_error', 'invalid x-api-key'); return; }
            if (model === 'mock-429') { fail(429, 'rate_limit_error', 'This request would exceed your rate limit', { 'retry-after': '7' }); return; }
            if (model === 'mock-overloaded') { fail(529, 'overloaded_error', 'Overloaded'); return; }
            if (model === 'mock-404') { fail(404, 'not_found_error', `model: ${model}`); return; }

            const plan = scripted ?? heuristic;
            scripted = undefined;
            const blocks = typeof plan === 'function' ? plan(body) : plan;
            const system = systemText(body);
            const promptTokens = estimate(JSON.stringify(body.messages)) + estimate(JSON.stringify(body.tools ?? []));
            const usage: Record<string, number> = { input_tokens: promptTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
            if (system && hasCacheControl(body)) {
                const key = createHash('sha256').update(String(body.model)).update(system).digest('hex');
                if (seenSystems.has(key)) usage.cache_read_input_tokens = estimate(system);
                else { usage.cache_creation_input_tokens = estimate(system); seenSystems.add(key); }
            } else usage.input_tokens = (usage.input_tokens ?? 0) + estimate(system);

            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            send('message_start', { type: 'message_start', message: { id: `msg_mock_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage } });
            send('ping', { type: 'ping' });
            if (model === 'mock-error-event') { send('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded mid-stream' } }); res.end(); return; }
            let outputTokens = 0;
            blocks.forEach((block, index) => {
                if (block.type === 'text') {
                    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
                    for (const piece of chunk(block.text)) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
                    outputTokens += estimate(block.text);
                } else if (block.type === 'tool_use') {
                    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
                    for (const piece of chunk(JSON.stringify(block.input), 5)) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } });
                    outputTokens += estimate(JSON.stringify(block.input)) + 4;
                } else if (block.type === 'thinking') {
                    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
                    for (const piece of chunk(block.thinking)) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: piece } });
                    send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
                    outputTokens += estimate(block.thinking);
                } else {
                    send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data: block.data } });
                }
                send('content_block_stop', { type: 'content_block_stop', index });
            });
            const refusal = model === 'mock-refusal';
            const stopReason = refusal ? 'refusal' : blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
            const delta: Record<string, unknown> = { stop_reason: stopReason, stop_sequence: null };
            if (refusal) delta.stop_details = { type: 'refusal', category: 'cyber', explanation: 'mock refusal' };
            send('message_delta', { type: 'message_delta', delta, usage: { output_tokens: outputTokens } });
            send('message_stop', { type: 'message_stop' });
            res.end();
        });
    });
    await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        next: plan => { scripted = plan; },
        close: () => new Promise(resolve => server.close(() => resolve())),
    };
}

if (import.meta.main) {
    const key = process.env.MOCK_API_KEY ?? 'test-key';
    startMockAnthropic({ apiKey: key, port: Number(process.env.MOCK_PORT ?? 18791) }).then(server => {
        console.log(`mock Anthropic listening on ${server.url}/v1/messages (x-api-key: ${key === 'test-key' ? 'test-key' : '<MOCK_API_KEY>'})`);
    });
}
