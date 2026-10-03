// Live smoke against Claude on Microsoft Foundry (or any Anthropic-style endpoint). Runs only when
// /workspace/secrets/foundry.env exists (KEY=VALUE lines); skipped otherwise. Never prints secrets.
//
// Recognised keys (first match wins):
//   FOUNDRY_API_KEY | AZURE_API_KEY | ANTHROPIC_API_KEY      the key
//   FOUNDRY_RESOURCE | AZURE_RESOURCE                        Azure resource name  (or)
//   FOUNDRY_BASE_URL | BASE_URL                              explicit base URL, e.g. https://x.services.ai.azure.com/anthropic
//   FOUNDRY_MODEL | DEPLOYMENT | MODEL                       deployment / model name (default claude-sonnet-5)
//   FOUNDRY_TYPE                                             anthropic-foundry (default) | anthropic | azure-openai | openai

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { chat } from '../src/client';
import { resolveModelsConfig } from '../src/config';
import type { ChatRequest, StreamEvent, Usage } from '../src/types';

const ENV_FILE = process.env.EZIL_LIVE_ENV ?? '/workspace/secrets/foundry.env';
const available = existsSync(ENV_FILE);

function loadEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!match) continue;
        out[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, '$2');
    }
    return out;
}

describe.skipIf(!available)('live Foundry smoke', () => {
    test('two turns; the second reads the prompt cache', async () => {
        const env = loadEnv();
        const pick = (...names: string[]) => names.map(name => env[name]).find(value => value);
        const apiKey = pick('FOUNDRY_API_KEY', 'AZURE_API_KEY', 'ANTHROPIC_API_KEY');
        const resource = pick('FOUNDRY_RESOURCE', 'AZURE_RESOURCE');
        const baseUrl = pick('FOUNDRY_BASE_URL', 'BASE_URL');
        const deployment = pick('FOUNDRY_MODEL', 'DEPLOYMENT', 'MODEL') ?? 'claude-sonnet-5';
        const type = pick('FOUNDRY_TYPE') ?? 'anthropic-foundry';
        expect(apiKey, `${ENV_FILE} needs FOUNDRY_API_KEY`).toBeTruthy();
        const config = resolveModelsConfig({
            providers: { live: { type, apiKey, resource, baseUrl } },
            models: [{ id: 'live', provider: 'live', model: deployment, maxOutputTokens: 1024, cache: { ttl: '5m' } }],
        }, { env: {} });
        const model = config.models[0]!;
        // ~5K tokens of stable system prompt so it clears every model's minimum cacheable prefix (Haiku 4.5: 4096).
        const system = `You are a terse assistant used in an automated smoke test. Answer in one short sentence.\n${'The quick brown fox jumps over the lazy dog near the riverbank while the sun sets slowly behind the hills. '.repeat(260)}`;
        const ask = async (question: string): Promise<{ text: string; usage: Usage | undefined; events: StreamEvent[] }> => {
            const request: ChatRequest = {
                messages: [{ role: 'system', parts: [{ type: 'text', value: system }] }, { role: 'user', parts: [{ type: 'text', value: question }] }],
                tools: [], toolMode: 'auto', modelOptions: {},
            };
            let text = ''; let usage: Usage | undefined; const events: StreamEvent[] = [];
            for await (const event of chat(model, request, { signal: new AbortController().signal })) {
                events.push(event);
                if (event.type === 'text') text += event.value;
                if (event.type === 'usage') usage = event.usage;
            }
            return { text, usage, events };
        };
        const first = await ask('Say hello.');
        expect(first.text.length).toBeGreaterThan(0);
        expect(first.usage).toBeDefined();
        const second = await ask('Say goodbye.');
        expect(second.text.length).toBeGreaterThan(0);
        console.log(`live ${type} ${deployment}: turn1 cache_write=${first.usage?.cacheWriteTokens} cache_read=${first.usage?.cacheReadTokens}; turn2 cache_write=${second.usage?.cacheWriteTokens} cache_read=${second.usage?.cacheReadTokens}`);
        if (type === 'anthropic' || type === 'anthropic-foundry') expect(second.usage!.cacheReadTokens).toBeGreaterThan(0);
    }, 120_000);
});

test.skipIf(available)('live smoke skipped (no secrets file)', () => {
    expect(available).toBe(false);
});
