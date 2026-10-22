import type { ChatRequest, Message, Part } from '../../src/types';
import { KIMI, QWEN } from '../../src/gateway-messages';
import { model } from './load';

export const gw = (id = QWEN) => model({ id, model: id, name: id, stream: id !== KIMI, maxInputTokens: 131072, maxOutputTokens: id === KIMI ? 4096 : 8192, toolReserve: 24000 },
    { type: 'ezil-gateway', name: 'ezil', baseUrl: 'https://proxy.invalid/ai/v1', apiKey: 'synthetic-proxy-token' });
export const txt = (value: string): Part => ({ type: 'text', value });
export const msg = (role: Message['role'], ...parts: Part[]): Message => ({ role, parts });
export const call = (id: string, name = 'read_file', input: unknown = {}): Part => ({ type: 'tool_call', callId: id, name, input });
export const result = (id: string, content: Part[] = [txt('ok')]): Part => ({ type: 'tool_result', callId: id, content });
export const image: Extract<Part, { type: 'data' }> = { type: 'data', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) };
export const thinking: Extract<Part, { type: 'thinking' }> = { type: 'thinking', value: 'private prior reasoning', metadata: { signature: 'sig', _completeThinking: 'reasoning' } };
export const marker: Part = { type: 'data', mimeType: 'cache_control', data: new TextEncoder().encode('ephemeral') };
export const tool = { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } };
export const ask = (messages = [msg('user', txt('Hello'))]): ChatRequest => ({ messages, tools: [], toolMode: 'auto', modelOptions: {} });
export function fixtureRequests(): Record<string, { model: ReturnType<typeof gw>; request: ChatRequest }> {
    return {
        'plain-ask': { model: gw(), request: ask([msg('system', txt('Be concise.')), msg('user', txt('Explain UTF-8.'))]) },
        'agent-40-tools': { model: gw(), request: { ...ask([msg('user', txt('Inspect the project.'))]), tools: Array.from({ length: 40 }, (_, i) => ({ ...tool, name: `tool_${i}` })) } },
        'multi-step-tools': { model: gw(), request: { ...ask([msg('user', txt('Read three files.')), ...[1, 2, 3].flatMap(i => [msg('assistant', call(`call_${i}`, 'read_file', { path: `file${i}.ts` })), msg('user', result(`call_${i}`, [txt(`file ${i} content`)]))])]), tools: [tool] } },
        'tool-result-image': { model: gw(), request: { ...ask([msg('user', txt('Read the output.')), msg('assistant', call('call_image')), msg('user', result('call_image', [txt('Attached image:'), image]))]), tools: [tool] } },
        'history-thinking': { model: gw(), request: ask([msg('user', txt('Think about this.')), msg('assistant', thinking, txt('Earlier answer'), marker), msg('user', txt('Continue.'))]) },
        'kimi-request': { model: gw(KIMI), request: ask([msg('system', txt('Be concise.')), msg('user', txt('Explain the code.'))]) },
    };
}
