// Turns the requests captured from Copilot Chat 0.67 (probe provider, /workspace/copilot-byok-test) into
// neutral ChatRequests. The probe serialised every VS Code part as {type:'text'|'tool_call'|'tool_result'|'data'}
// with roles by name; data parts carry only the first 64 base64 chars (`base64Head`) of the payload.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedModel, ResolvedProvider } from '../../src/config';
import type { ChatRequest, Message, Part, Role } from '../../src/types';

type CapturedPart =
    | { type: 'text'; value: string }
    | { type: 'tool_call'; callId: string; name: string; input: unknown }
    | { type: 'tool_result'; callId: string; content: CapturedPart[] }
    | { type: 'data'; mimeType: string; byteLength: number; base64Head: string };
type CapturedMessage = { role: string; name?: string; parts: CapturedPart[] };
type Captured = {
    body: {
        model: string;
        options: { toolMode: number; modelOptions?: Record<string, unknown>; requestInitiator?: string };
        tools: { name: string; description?: string; inputSchema?: unknown }[];
        messages: CapturedMessage[];
    };
};

export const FIXTURES = {
    toolRoundTrip: 'copilot-agent-tool-roundtrip.json',
    image: 'copilot-agent-image.json',
    utility: 'copilot-utility-progress.json',
} as const;

function part(captured: CapturedPart): Part {
    switch (captured.type) {
        case 'text': return { type: 'text', value: captured.value };
        case 'tool_call': return { type: 'tool_call', callId: captured.callId, name: captured.name, input: captured.input };
        case 'tool_result': return { type: 'tool_result', callId: captured.callId, content: captured.content.map(part) };
        case 'data': return { type: 'data', mimeType: captured.mimeType, data: new Uint8Array(Buffer.from(captured.base64Head, 'base64')) };
    }
}

export function loadFixture(name: (typeof FIXTURES)[keyof typeof FIXTURES]): ChatRequest & { captured: Captured['body'] } {
    const captured = JSON.parse(readFileSync(join(import.meta.dir, name), 'utf8')) as Captured;
    const messages: Message[] = captured.body.messages.map(message => {
        const role: Role = message.role === 'system' ? 'system' : message.role === 'assistant' ? 'assistant' : 'user';
        const out: Message = { role, parts: message.parts.map(part) };
        if (message.name) out.name = message.name;
        return out;
    });
    return {
        messages,
        tools: captured.body.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        toolMode: captured.body.options.toolMode === 2 ? 'required' : 'auto',
        modelOptions: { ...(captured.body.options.modelOptions ?? {}), requestInitiator: captured.body.options.requestInitiator },
        captured: captured.body,
    };
}

export function provider(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
    return { name: 'test', type: 'anthropic', apiKey: 'sk-test-key', headers: {}, betas: [], includeUsage: true, ...overrides };
}

export function model(overrides: Partial<ResolvedModel> = {}, providerOverrides: Partial<ResolvedProvider> = {}): ResolvedModel {
    const resolvedProvider = overrides.provider ?? provider(providerOverrides);
    return {
        id: 'test-model',
        name: 'Test Model',
        providerName: resolvedProvider.name,
        provider: resolvedProvider,
        model: 'claude-sonnet-5',
        family: 'claude',
        version: '1',
        maxInputTokens: 200_000,
        maxOutputTokens: 8192,
        capabilities: { toolCalling: true, imageInput: true },
        cache: { enabled: resolvedProvider.type === 'anthropic' || resolvedProvider.type === 'anthropic-foundry', ttl: '5m' },
        default: true,
        roles: [],
        forcedToolChoice: true,
        ...overrides,
    };
}

/** Wrap a list of SSE frames as a ReadableStream, optionally splitting the bytes at arbitrary points. */
export function sseBody(frames: string[], chunkSize = 0): ReadableStream<Uint8Array> {
    const text = frames.join('');
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
        start(controller) {
            if (!chunkSize) controller.enqueue(bytes);
            else for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
            controller.close();
        },
    });
}

export function frame(event: string | undefined, data: unknown): string {
    return `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}
