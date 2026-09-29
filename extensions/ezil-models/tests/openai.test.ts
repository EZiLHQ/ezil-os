import { describe, expect, test } from 'bun:test';
import { buildOpenAIBody, openaiStream } from '../src/openai';
import { sseEvents } from '../src/sse';
import type { StreamEvent } from '../src/types';
import { FIXTURES, frame, loadFixture, model, sseBody } from './fixtures/load';

type Msg = { role: string; content: unknown; tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };
type Body = { messages: Msg[]; tools?: { type: string; function: { name: string; description: string; parameters: unknown } }[]; [key: string]: unknown };

const gpt = (overrides = {}, providerOverrides = {}) => model({ model: 'gpt-5.5', family: 'gpt', cache: { enabled: false, ttl: '5m' }, ...overrides }, { type: 'openai', ...providerOverrides });

async function collect(frames: string[], chunkSize = 0): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    for await (const event of openaiStream(sseEvents(sseBody(frames, chunkSize)))) out.push(event);
    return out;
}

describe('OpenAI chat-completions request from real Copilot Chat captures', () => {
    const fixture = loadFixture(FIXTURES.toolRoundTrip);

    test('Agent-mode tool round trip: system message, user text, assistant tool_calls, tool message', () => {
        const body = buildOpenAIBody(gpt(), fixture) as Body;
        expect(body.model).toBe('gpt-5.5');
        expect(body.stream).toBe(true);
        expect(body.stream_options).toEqual({ include_usage: true });
        expect(body.max_completion_tokens).toBe(8192);
        expect(body.max_tokens).toBeUndefined();
        expect(body.messages.map(message => message.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool']);
        expect(body.messages[0]!.content as string).toStartWith('You are an expert AI programming assistant');
        expect(typeof body.messages[1]!.content).toBe('string');
        expect(body.messages[3]).toEqual({ role: 'assistant', content: 'I will create hello.txt now.', tool_calls: [{ id: 'call_mock_1790681308771', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ filePath: '/home/coder/project/hello.txt', content: 'hi\n' }) } }] });
        expect(body.messages[4]).toEqual({ role: 'tool', tool_call_id: 'call_mock_1790681308771', content: 'The following files were successfully edited:\n/home/coder/project/hello.txt\n' });
        expect(body.tools).toHaveLength(39);
        expect(body.tools![0]).toEqual({ type: 'function', function: { name: 'create_directory', description: expect.stringContaining('Create a new directory'), parameters: expect.objectContaining({ type: 'object' }) } });
        expect(body.tool_choice).toBe('auto');
    });

    test('image attachment becomes a data-URL image_url part inside a content array', () => {
        const body = buildOpenAIBody(gpt(), loadFixture(FIXTURES.image)) as Body;
        const last = body.messages.at(-1)!;
        expect(Array.isArray(last.content)).toBe(true);
        const parts = last.content as { type: string; text?: string; image_url?: { url: string } }[];
        expect(parts.map(part => part.type)).toEqual(['text', 'image_url', 'text']);
        expect(parts[1]!.image_url!.url).toStartWith('data:image/png;base64,iVBORw0KGgo');
    });

    test('provider-type specifics: azure api-version and max_tokens for openai-compatible, reasoning_effort, required tools', () => {
        const compatible = buildOpenAIBody(gpt({}, { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', includeUsage: false }), { ...fixture, toolMode: 'required' }) as Body;
        expect(compatible.max_tokens).toBe(8192);
        expect(compatible.max_completion_tokens).toBeUndefined();
        expect(compatible.stream_options).toBeUndefined();
        expect(compatible.tool_choice).toBe('required');
        const reasoning = buildOpenAIBody(gpt({ thinking: { type: 'adaptive', effort: 'xhigh' }, temperature: 0.5 }), fixture) as Body;
        expect(reasoning.reasoning_effort).toBe('high');
        expect(reasoning.temperature).toBeUndefined();
        const plain = buildOpenAIBody(gpt({ temperature: 0.5 }, { maxTokensField: 'max_tokens' }), { ...fixture, tools: [], modelOptions: { maxTokens: 100 } }) as Body;
        expect(plain.temperature).toBe(0.5);
        expect(plain.max_tokens).toBe(100);
        expect(plain.tools).toBeUndefined();
        expect(plain.tool_choice).toBeUndefined();
    });
});

describe('OpenAI stream parsing', () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
        frame(undefined, { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });

    test('accumulates tool_calls by index across chunks, text, reasoning and usage', async () => {
        const frames = [
            chunk({ role: 'assistant', content: '' }),
            chunk({ reasoning_content: 'thinking...' }),
            chunk({ content: 'I will ' }),
            chunk({ content: 'create it.' }),
            chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'create_file', arguments: '' } }] }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: '{"filePath":"/h' } }] }),
            chunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] }),
            chunk({ tool_calls: [{ index: 0, function: { arguments: 'ello.txt","content":"hi\\n"}' } }] }),
            chunk({}, 'tool_calls'),
            frame(undefined, { id: 'c', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 2048 } } }),
            'data: [DONE]\n\n',
        ];
        for (const chunkSize of [0, 13]) {
            const events = await collect(frames, chunkSize);
            expect(events).toEqual([
                { type: 'thinking', value: 'thinking...' },
                { type: 'text', value: 'I will ' },
                { type: 'text', value: 'create it.' },
                { type: 'tool_call', callId: 'call_1', name: 'create_file', input: { filePath: '/hello.txt', content: 'hi\n' } },
                { type: 'tool_call', callId: 'call_2', name: 'list_dir', input: {} },
                { type: 'usage', usage: { inputTokens: 3000, outputTokens: 40, cacheReadTokens: 2048, cacheWriteTokens: 0 } },
                { type: 'stop', reason: 'tool_calls' },
            ]);
        }
    });

    test('error chunks, invalid tool JSON and empty streams fail loudly', async () => {
        await expect(collect([frame(undefined, { error: { message: 'boom', type: 'server_error' } })])).rejects.toThrow('Provider stream error: boom');
        await expect(collect([chunk({ tool_calls: [{ index: 0, id: 'x', function: { name: 'f', arguments: '{"a"' } }] }), chunk({}, 'tool_calls'), 'data: [DONE]\n\n'])).rejects.toThrow('invalid JSON for tool call f');
        await expect(collect(['data: [DONE]\n\n'])).rejects.toThrow('ended before any response');
    });
});
