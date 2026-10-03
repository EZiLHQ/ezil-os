// In-process mock of an OpenAI chat-completions endpoint (streaming). Accepts `authorization: Bearer <key>`
// or `api-key: <key>` so it stands in for OpenAI, Azure OpenAI / Foundry openai/v1 and openai-compatible.
// Special model ids: mock-401, mock-429, mock-500.

import http from 'node:http';

export type MockChoice =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool_call'; id: string; name: string; arguments: unknown };

export type MockPlan = MockChoice[] | ((body: Record<string, unknown>) => MockChoice[]);
export type CapturedRequest = { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
export type MockServer = { url: string; port: number; requests: CapturedRequest[]; next(plan: MockPlan): void; close(): Promise<void> };

function heuristic(body: Record<string, unknown>): MockChoice[] {
    const messages = body.messages as { role: string; content: unknown; tool_call_id?: string }[];
    const last = messages.at(-1);
    if (last?.role === 'tool') return [{ type: 'text', text: 'Done. I created the file as requested.' }];
    const text = typeof last?.content === 'string' ? last.content : Array.isArray(last?.content) ? (last!.content as { text?: string }[]).map(part => part.text ?? '').join('') : '';
    const tools = (body.tools ?? []) as { function: { name: string } }[];
    if (/hello\.txt/i.test(text) && tools.some(tool => tool.function.name === 'create_file')) {
        return [
            { type: 'text', text: 'I will create hello.txt now.' },
            { type: 'tool_call', id: `call_mock_${Date.now()}`, name: 'create_file', arguments: { filePath: '/home/coder/project/hello.txt', content: 'hi\n' } },
        ];
    }
    return [{ type: 'text', text: `Mock GPT reply. tools=${tools.length} messages=${messages.length}. You said: "${text.slice(0, 80)}"` }];
}

function chunk(text: string, size = 6): string[] {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out.length ? out : [''];
}

export async function startMockOpenAI(options: { apiKey: string; port?: number } = { apiKey: 'test-key' }): Promise<MockServer> {
    const requests: CapturedRequest[] = [];
    let scripted: MockPlan | undefined;
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', part => { raw += part; });
        req.on('end', () => {
            const fail = (status: number, message: string, headers: Record<string, string> = {}) => {
                res.writeHead(status, { 'content-type': 'application/json', ...headers });
                res.end(JSON.stringify({ error: { message, type: 'invalid_request_error', code: null } }));
            };
            let body: Record<string, unknown>;
            try { body = JSON.parse(raw || '{}'); } catch { fail(400, 'body is not JSON'); return; }
            requests.push({ url: req.url ?? '', headers: req.headers, body });
            if (req.method !== 'POST' || !(req.url ?? '').includes('/chat/completions')) { fail(404, `no route ${req.method} ${req.url}`); return; }
            const bearer = req.headers.authorization === `Bearer ${options.apiKey}`;
            const apiKey = req.headers['api-key'] === options.apiKey;
            if (!bearer && !apiKey) { fail(401, 'Incorrect API key provided'); return; }
            const model = String(body.model);
            if (model === 'mock-401') { fail(401, 'Incorrect API key provided'); return; }
            if (model === 'mock-429') { fail(429, 'Rate limit reached', { 'retry-after': '3' }); return; }
            if (model === 'mock-500') { fail(500, 'The server had an error'); return; }
            const plan = scripted ?? heuristic;
            scripted = undefined;
            const choices = typeof plan === 'function' ? plan(body) : plan;
            const id = `chatcmpl-mock-${Date.now()}`;
            const send = (delta: Record<string, unknown>, finish: string | null = null) => {
                res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
            };
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            send({ role: 'assistant', content: '' });
            let toolIndex = 0;
            let completion = 0;
            for (const choice of choices) {
                if (choice.type === 'text') { for (const piece of chunk(choice.text)) send({ content: piece }); completion += Math.ceil(choice.text.length / 4); }
                else if (choice.type === 'reasoning') { for (const piece of chunk(choice.text)) send({ reasoning_content: piece }); }
                else {
                    send({ tool_calls: [{ index: toolIndex, id: choice.id, type: 'function', function: { name: choice.name, arguments: '' } }] });
                    for (const piece of chunk(JSON.stringify(choice.arguments), 5)) send({ tool_calls: [{ index: toolIndex, function: { arguments: piece } }] });
                    toolIndex += 1;
                    completion += 8;
                }
            }
            send({}, toolIndex ? 'tool_calls' : 'stop');
            const prompt = Math.ceil(raw.length / 4);
            if ((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage) {
                res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: requests.length > 1 ? Math.floor(prompt / 2) : 0 } } })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
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
    startMockOpenAI({ apiKey: key, port: Number(process.env.MOCK_PORT ?? 18792) }).then(server => {
        console.log(`mock OpenAI listening on ${server.url}/v1/chat/completions`);
    });
}
