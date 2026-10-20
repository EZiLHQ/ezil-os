import { expect, test } from 'bun:test';
import { estimateMessageTokens, estimateTextTokens } from '../src/tokens';
import { CACHE_CONTROL_MIME } from '../src/types';
import { FIXTURES, loadFixture } from './fixtures/load';

test('token estimate is cheap, monotonic and errs high for the Copilot system prompt', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('hello world')).toBeGreaterThan(0);
    const fixture = loadFixture(FIXTURES.toolRoundTrip);
    const system = estimateMessageTokens(fixture.messages[0]!);
    // 10.5K chars of English prose is ~2.4K-2.8K tokens on current Claude tokenizers; the estimate must not under-count.
    expect(system).toBeGreaterThan(2_800);
    expect(system).toBeLessThan(4_000);
    const total = fixture.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    expect(total).toBeGreaterThan(system);
});

test('images cost a fixed budget, markers cost nothing, tool parts count their JSON', () => {
    expect(estimateMessageTokens({ role: 'user', parts: [{ type: 'data', mimeType: 'image/png', data: new Uint8Array(10) }] })).toBe(1604);
    expect(estimateMessageTokens({ role: 'user', parts: [{ type: 'data', mimeType: CACHE_CONTROL_MIME, data: new Uint8Array(9) }] })).toBe(4);
    const call = estimateMessageTokens({ role: 'assistant', parts: [{ type: 'tool_call', callId: 'c', name: 'create_file', input: { filePath: '/x', content: 'y'.repeat(340) } }] });
    expect(call).toBeGreaterThan(100);
    expect(estimateMessageTokens({ role: 'user', parts: [{ type: 'tool_result', callId: 'c', content: [{ type: 'text', value: 'ok' }] }] })).toBe(4 + 8 + 1);
});
