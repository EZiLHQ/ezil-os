import { describe, expect, test } from 'bun:test';
import { anthropicStream, applyCacheBreakpoints, buildAnthropicBody, convertMessages, MAX_CACHE_BREAKPOINTS } from '../src/anthropic';
import { sseEvents } from '../src/sse';
import { CACHE_CONTROL_MIME, STATEFUL_MARKER_MIME, type ChatRequest, type Message, type StreamEvent } from '../src/types';
import { FIXTURES, frame, loadFixture, model, sseBody } from './fixtures/load';

type Block = Record<string, unknown> & { type?: string; cache_control?: { type: string; ttl?: string } };
type Body = { system?: Block[]; tools?: Block[]; messages: { role: string; content: Block[] }[]; [key: string]: unknown };

const marker = () => ({ type: 'data' as const, mimeType: CACHE_CONTROL_MIME, data: new TextEncoder().encode('ephemeral') });
const cached = (body: Body): Block[] => [...(body.tools ?? []), ...(body.system ?? []), ...body.messages.flatMap(message => message.content)].filter(block => block.cache_control);

async function collect(frames: string[], chunkSize = 0): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    for await (const event of anthropicStream(sseEvents(sseBody(frames, chunkSize)))) out.push(event);
    return out;
}

describe('Anthropic request from real Copilot Chat captures', () => {
    const fixture = loadFixture(FIXTURES.toolRoundTrip);

    test('Agent-mode tool round trip: system, 39 tools, merged user turns, tool_use + tool_result', () => {
        const body = buildAnthropicBody(model(), fixture) as Body;
        expect(body.model).toBe('claude-sonnet-5');
        expect(body.stream).toBe(true);
        expect(body.max_tokens).toBe(8192);
        // System role (value 3) became the top-level system prompt; Copilot's 10.5K-char prompt is intact.
        expect(body.system).toHaveLength(1);
        expect(body.system![0]!.text as string).toStartWith('You are an expert AI programming assistant');
        expect((body.system![0]!.text as string).length).toBeGreaterThan(10_000);
        expect(body.messages.some(message => (message as { role: string }).role === 'system')).toBe(false);
        // All 39 tools with schemas.
        expect(body.tools).toHaveLength(39);
        expect(body.tools!.map(tool => tool.name)).toContain('create_file');
        const createFile = body.tools!.find(tool => tool.name === 'create_file')!;
        expect(createFile.description).toBeString();
        expect((createFile.input_schema as { required: string[] }).required).toEqual(['filePath', 'content']);
        expect(createFile.type).toBeUndefined();
        expect(body.tool_choice).toBeUndefined(); // toolMode auto
        // Two consecutive Copilot user messages merged into one Anthropic user turn with two text blocks.
        expect(body.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user']);
        expect(body.messages[0]!.content.map(block => block.type)).toEqual(['text', 'text']);
        expect(body.messages[0]!.content[0]!.text as string).toStartWith('<environment_info>');
        expect(body.messages[1]!.content).toEqual([
            expect.objectContaining({ type: 'text', text: 'I will create hello.txt now.' }),
            expect.objectContaining({ type: 'tool_use', id: 'call_mock_1790681308771', name: 'create_file', input: { filePath: '/home/coder/project/hello.txt', content: 'hi\n' } }),
        ]);
        expect(body.messages[2]!.content[0]).toEqual(expect.objectContaining({
            type: 'tool_result', tool_use_id: 'call_mock_1790681308771',
            content: [{ type: 'text', text: 'The following files were successfully edited:\n/home/coder/project/hello.txt\n' }],
        }));
        // Copilot's modelOptions (_enableThinking, otel ids...) are not forwarded.
        expect(body.metadata).toBeUndefined();
        expect(Object.keys(body)).not.toContain('modelOptions');
    });

    test('automatic cache breakpoints: system, last tool and last user turn, at most 4, ttl from config', () => {
        const body = buildAnthropicBody(model(), fixture) as Body;
        const marked = cached(body);
        expect(marked.length).toBe(3);
        expect(body.system!.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
        expect(body.tools!.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
        expect(body.tools!.slice(0, -1).some(tool => tool.cache_control)).toBe(false);
        expect(body.messages.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
        expect(body.messages.at(-1)!.content.at(-1)!.type).toBe('tool_result');
        const hour = buildAnthropicBody(model({ cache: { enabled: true, ttl: '1h' } }), fixture) as Body;
        expect(cached(hour).every(block => block.cache_control?.ttl === '1h')).toBe(true);
        const off = buildAnthropicBody(model({ cache: { enabled: false, ttl: '5m' } }), fixture) as Body;
        expect(cached(off)).toHaveLength(0);
    });

    test('Copilot cache_control data-part markers are honoured and counted against the budget', () => {
        const messages: Message[] = fixture.messages.map(message => ({ ...message, parts: [...message.parts] }));
        messages[0]!.parts.push(marker()); // on the system prompt
        messages[1]!.parts.push(marker()); // after the workspace-info user text
        messages[2]!.parts.unshift(marker()); // leading marker -> attaches to previous block (none) -> ' ' text block
        const body = buildAnthropicBody(model(), { ...fixture, messages }) as Body;
        expect(body.system![0]!.cache_control).toEqual({ type: 'ephemeral' });
        const user = body.messages[0]!.content;
        expect(user[0]!.cache_control).toEqual({ type: 'ephemeral' });
        expect(user[1]).toEqual(expect.objectContaining({ type: 'text', text: ' ', cache_control: { type: 'ephemeral' } }));
        expect(cached(body).length).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
        // 3 explicit + automatic (system already marked, tools, last user) -> trimmed from the front to 4.
        expect(cached(body)).toHaveLength(4);
        expect(body.messages.at(-1)!.content.at(-1)!.cache_control).toBeDefined();
    });

    test('more than four explicit markers are reduced to four, keeping the latest ones', () => {
        const body: Body = {
            system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
            tools: [{ name: 't', cache_control: { type: 'ephemeral' } }],
            messages: [
                { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
                { role: 'assistant', content: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] },
                { role: 'user', content: [{ type: 'text', text: 'c', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'd', cache_control: { type: 'ephemeral' } }] },
            ],
        };
        expect(applyCacheBreakpoints(body as never, '1h')).toBe(4);
        expect(body.tools![0]!.cache_control).toBeUndefined();
        expect(body.system![0]!.cache_control).toBeUndefined();
        expect(cached(body).map(block => block.text)).toEqual(['a', 'b', 'c', 'd']);
        expect(cached(body).every(block => block.cache_control?.ttl === '1h')).toBe(true);
    });

    test('image attachment (drag-and-drop capture) becomes a base64 image block between the text blocks', () => {
        const image = loadFixture(FIXTURES.image);
        const body = buildAnthropicBody(model(), image) as Body;
        const last = body.messages.at(-1)!.content;
        const imageBlock = last.find(block => block.type === 'image')!;
        expect(imageBlock).toBeDefined();
        expect(imageBlock.source).toEqual({ type: 'base64', media_type: 'image/png', data: expect.stringMatching(/^iVBORw0KGgo/) });
        expect(last[last.indexOf(imageBlock) - 1]!.text).toBe('<attachments>\n');
        expect((last[last.indexOf(imageBlock) + 1]!.text as string)).toStartWith('\n</attachments>');
    });

    test('utility-model request (no tools) has no tools key and no tool_choice', () => {
        const utility = loadFixture(FIXTURES.utility);
        const body = buildAnthropicBody(model(), utility) as Body;
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
        expect(body.system![0]!.text as string).toStartWith('You are an expert in writing short');
        expect(body.messages).toEqual([{ role: 'user', content: [expect.objectContaining({ type: 'text' })] }]);
        expect(cached(body)).toHaveLength(2);
    });
});

describe('Anthropic request options', () => {
    const request: ChatRequest = {
        messages: [{ role: 'system', parts: [{ type: 'text', value: 'sys' }] }, { role: 'user', parts: [{ type: 'text', value: 'hi' }] }],
        tools: [{ name: 'a', description: 'A', inputSchema: { type: 'object', properties: {} } }],
        toolMode: 'required',
        modelOptions: {},
    };

    test('thinking adaptive/effort, enabled budget raises max_tokens, disabled, temperature only without thinking', () => {
        const adaptive = buildAnthropicBody(model({ thinking: { type: 'adaptive', effort: 'xhigh' }, temperature: 0.2 }), request) as Body;
        expect(adaptive.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(adaptive.output_config).toEqual({ effort: 'xhigh' });
        expect(adaptive.temperature).toBeUndefined();
        const enabled = buildAnthropicBody(model({ thinking: { type: 'enabled', budgetTokens: 16_000 }, maxOutputTokens: 8192 }), request) as Body;
        expect(enabled.thinking).toEqual({ type: 'enabled', budget_tokens: 16_000 });
        expect(enabled.max_tokens as number).toBeGreaterThan(16_000);
        const disabled = buildAnthropicBody(model({ thinking: { type: 'disabled' }, temperature: 0.2 }), request) as Body;
        expect(disabled.thinking).toEqual({ type: 'disabled' });
        expect(disabled.temperature).toBe(0.2);
        const none = buildAnthropicBody(model(), request) as Body;
        expect(none.thinking).toBeUndefined();
        expect(none.output_config).toBeUndefined();
    });

    test('required tool mode -> tool_choice any, except for models that reject forced tool use', () => {
        expect((buildAnthropicBody(model(), request) as Body).tool_choice).toEqual({ type: 'any' });
        expect((buildAnthropicBody(model({ model: 'claude-opus-5-5', forcedToolChoice: false }), request) as Body).tool_choice).toBeUndefined();
        expect((buildAnthropicBody(model(), { ...request, toolMode: 'auto' }) as Body).tool_choice).toBeUndefined();
    });

    test('maxTokens from modelOptions is capped by the model limit', () => {
        expect((buildAnthropicBody(model(), { ...request, modelOptions: { maxTokens: 512 } }) as Body).max_tokens).toBe(512);
        expect((buildAnthropicBody(model(), { ...request, modelOptions: { maxTokens: 999_999 } }) as Body).max_tokens).toBe(8192);
    });

    test('thinking replay, redacted thinking, stateful markers, PDFs and empty parts', () => {
        const { messages } = convertMessages([
            { role: 'user', parts: [{ type: 'text', value: '' }, { type: 'data', mimeType: STATEFUL_MARKER_MIME, data: new Uint8Array([1]) }, { type: 'data', mimeType: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]) }, { type: 'text', value: 'read it' }] },
            { role: 'assistant', parts: [
                { type: 'thinking', value: 'partial' },
                { type: 'thinking', value: '', metadata: { signature: 'sig', _completeThinking: 'full thought' } },
                { type: 'thinking', value: '', metadata: { redactedData: 'opaque' } },
                { type: 'text', value: 'ok' },
            ] },
            { role: 'assistant', parts: [] },
        ]);
        expect(messages).toEqual([
            { role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' } }, { type: 'text', text: 'read it' }] },
            { role: 'assistant', content: [{ type: 'thinking', thinking: 'full thought', signature: 'sig' }, { type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'ok' }] },
        ]);
    });
});

describe('Anthropic stream parsing', () => {
    const frames = [
        frame('message_start', { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 1200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 } } }),
        frame('ping', { type: 'ping' }),
        frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
        frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } }),
        frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think.' } }),
        frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG==' } }),
        frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
        frame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
        frame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'I will ' } }),
        frame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'create it.' } }),
        frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
        frame('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'create_file', input: {} } }),
        frame('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"filePath": "/home/co' } }),
        frame('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'der/project/hello.txt", "con' } }),
        frame('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'tent": "hi\\n"}' } }),
        frame('content_block_stop', { type: 'content_block_stop', index: 2 }),
        frame('content_block_start', { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_2', name: 'list_dir', input: {} } }),
        frame('content_block_stop', { type: 'content_block_stop', index: 3 }),
        frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 57 } }),
        frame('message_stop', { type: 'message_stop' }),
    ];

    test('reassembles thinking (with signature metadata), text and split input_json_delta tool calls; reports usage', async () => {
        for (const chunkSize of [0, 11]) {
            const events = await collect(frames, chunkSize);
            expect(events).toEqual([
                { type: 'thinking', value: 'Let me ' },
                { type: 'thinking', value: 'think.' },
                { type: 'thinking', value: '', metadata: { signature: 'SIG==', _completeThinking: 'Let me think.' } },
                { type: 'text', value: 'I will ' },
                { type: 'text', value: 'create it.' },
                { type: 'tool_call', callId: 'toolu_1', name: 'create_file', input: { filePath: '/home/coder/project/hello.txt', content: 'hi\n' } },
                { type: 'tool_call', callId: 'toolu_2', name: 'list_dir', input: {} },
                { type: 'usage', usage: { inputTokens: 1200, outputTokens: 57, cacheReadTokens: 1000, cacheWriteTokens: 0 } },
                { type: 'stop', reason: 'tool_use', details: undefined },
            ]);
        }
    });

    test('error events, invalid tool JSON and truncated streams fail loudly; refusal carries stop_details', async () => {
        await expect(collect([frames[0]!, frame('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })])).rejects.toThrow(/overloaded_error.*Overloaded/);
        await expect(collect([
            frames[0]!,
            frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'x', input: {} } }),
            frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } }),
            frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
        ])).rejects.toThrow('invalid JSON for tool call x');
        await expect(collect([frames[0]!, frames[7]!])).rejects.toThrow('ended before a message was completed');
        const refusal = await collect([frames[0]!, frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }, usage: { output_tokens: 0 } }), frame('message_stop', { type: 'message_stop' })]);
        expect(refusal.at(-1)).toEqual({ type: 'stop', reason: 'refusal', details: { type: 'refusal', category: 'cyber' } });
    });
});
