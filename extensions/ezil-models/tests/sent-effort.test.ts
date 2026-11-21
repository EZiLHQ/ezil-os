// The effort the bridge catalog reports is the effort this extension really sends (client.ts sentEffort), never the
// configured value alone: the EZiL Gateway body carries none.
import { expect, test } from 'bun:test';

import { sentEffort } from '../src/client';
import { model } from './fixtures/load';

test('Anthropic sends output_config.effort; OpenAI maps it to reasoning_effort; the Gateway and openai-compatible send none', () => {
    expect(sentEffort(model({ thinking: { type: 'adaptive', effort: 'high' } }))).toBe('high');
    expect(sentEffort(model({ thinking: { type: 'adaptive' } }))).toBeNull();
    expect(sentEffort(model())).toBeNull();
    const openai = { model: 'gpt-5.5', family: 'gpt', cache: { enabled: false, ttl: '5m' as const } };
    expect(sentEffort(model({ ...openai, thinking: { type: 'adaptive', effort: 'xhigh' } }, { type: 'openai' }))).toBe('high');
    expect(sentEffort(model({ ...openai, thinking: { type: 'disabled', effort: 'high' } }, { type: 'openai' }))).toBeNull();
    expect(sentEffort(model({ ...openai, thinking: { type: 'adaptive', effort: 'high' } }, { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }))).toBeNull();
    expect(sentEffort(model({ model: 'qwen.qwen3-coder-next', thinking: { type: 'adaptive', effort: 'max' } }, { type: 'ezil-gateway', baseUrl: 'https://h/ai/v1' }))).toBeNull();
});
