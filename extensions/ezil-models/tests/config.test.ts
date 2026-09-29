import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, describeConfig, parseModelsConfig, redact, supportsForcedToolChoice } from '../src/config';

const env = { ANTHROPIC_API_KEY: 'sk-ant-secret-1234567890', AZURE_API_KEY: 'azure-secret-0987654321', OPENAI_API_KEY: 'sk-openai-secret', AZURE_OPENAI_API_KEY: 'azure-openai-secret' };
const files: Record<string, string> = { '/run/secrets/foundry-api-key': 'foundry-file-secret\n' };
const readFile = (path: string) => { const value = files[path]; if (value === undefined) throw new Error('ENOENT'); return value; };
const example = readFileSync(join(import.meta.dir, '..', 'examples', 'models.example.json'), 'utf8');

function errorsOf(text: string): string[] {
    try { parseModelsConfig(text, { env, readFile }); } catch (error) { if (error instanceof ConfigError) return error.errors; throw error; }
    throw new Error('expected a ConfigError');
}

describe('config loader', () => {
    test('loads the shipped example with {env:} and {file:} references resolved', () => {
        const config = parseModelsConfig(example, { env, readFile, source: 'example' });
        expect(Object.keys(config.providers)).toEqual(['anthropic', 'foundry-claude', 'foundry-openai', 'azure', 'openai', 'local-mock']);
        expect(config.providers.anthropic!.apiKey).toBe(env.ANTHROPIC_API_KEY);
        expect(config.providers['foundry-claude']!.apiKey).toBe('foundry-file-secret');
        expect(config.providers['foundry-claude']!.resource).toBe('my-foundry-resource');
        expect(config.providers['local-mock']!.baseUrl).toBe('http://127.0.0.1:18792/v1');
        expect(config.models.map(model => model.id)).toEqual(['opus-5.5', 'sonnet-5', 'haiku-4.5', 'foundry-sonnet-5', 'gpt-5.5-foundry', 'gpt-5.5', 'mock']);
        const opus = config.models[0]!;
        expect(opus.default).toBe(true);
        expect(opus.roles).toEqual(['default', 'plan']);
        expect(opus.thinking).toEqual({ type: 'adaptive', effort: 'medium', display: 'summarized' });
        expect(opus.cache).toEqual({ enabled: true, ttl: '5m' });
        expect(opus.forcedToolChoice).toBe(false); // Opus 5.5 rejects forced tool_choice
        expect(opus.maxOutputTokens).toBe(128_000);
        expect(config.models[1]!.forcedToolChoice).toBe(true);
        expect(config.models[3]!.cache.ttl).toBe('1h');
        expect(config.models[4]!.cache.enabled).toBe(false); // caching only applies to Anthropic providers
        expect(config.models[4]!.capabilities).toEqual({ toolCalling: true, imageInput: true }); // from defaults
        expect(config.secrets).toContain(env.ANTHROPIC_API_KEY);
        expect(config.secrets).toContain('foundry-file-secret');
        expect(config.secrets).toContain('test-key');
    });

    test('describeConfig and redact never expose key material', () => {
        const config = parseModelsConfig(example, { env, readFile });
        const summary = describeConfig(config);
        for (const secret of config.secrets) expect(summary).not.toContain(secret);
        expect(summary).toContain('apiKey=set');
        expect(redact(`x-api-key: ${env.ANTHROPIC_API_KEY} / ${encodeURIComponent('azure-secret-0987654321')}`, config.secrets)).toBe('x-api-key: [redacted] / [redacted]');
    });

    test('reports every validation problem at once with paths', () => {
        const errors = errorsOf(JSON.stringify({
            providers: {
                bad: { type: 'nope' },
                nokey: { type: 'anthropic' },
                foundry: { type: 'anthropic-foundry', apiKey: 'k' },
                compat: { type: 'openai-compatible' },
                envmissing: { type: 'openai', apiKey: '{env:DOES_NOT_EXIST}' },
                filemissing: { type: 'openai', apiKey: '{file:/nowhere}' },
            },
            models: [
                { id: 'a', provider: 'nokey', model: 'm', thinking: { type: 'weird' }, cache: { ttl: '2h' }, roles: ['boss'], maxInputTokens: -1 },
                { id: 'A', provider: 'ghost', model: 'm' },
                { id: 'bad id', provider: 'nokey', model: 'm' },
                { id: 'c', provider: 'nokey' },
            ],
        }));
        expect(errors).toEqual(expect.arrayContaining([
            expect.stringContaining('providers.bad.type must be one of'),
            'providers.nokey.apiKey is required for type anthropic',
            'providers.foundry: type anthropic-foundry needs "resource" (Azure resource name) or "baseUrl"',
            'providers.compat: type openai-compatible needs "baseUrl"',
            'providers.envmissing.apiKey: environment variable DOES_NOT_EXIST is not set',
            expect.stringContaining('providers.filemissing.apiKey: cannot read /nowhere'),
            'models[0].thinking.type must be adaptive, enabled or disabled',
            'models[0].cache.ttl must be "5m" or "1h"',
            'models[0].roles must be an array of default, plan, utility, utilitySmall',
            'models[0].maxInputTokens must be a positive integer',
            'models[1].id "A" is duplicated (ids are compared case-insensitively)',
            'models[1].provider "ghost" is not defined in "providers"',
            expect.stringContaining('models[2].id must match'),
            'models[3].model (provider model id or deployment name) is required',
        ]));
    });

    test('rejects YAML / non-JSON, missing sections and multiple defaults', () => {
        expect(errorsOf('providers:\n  a: {}')[0]).toContain('not valid JSON');
        expect(errorsOf('{}')).toEqual(['"providers" must be a non-empty object', '"models" must be a non-empty array']);
        const two = errorsOf(JSON.stringify({ providers: { p: { type: 'openai', apiKey: 'k' } }, models: [{ id: 'a', provider: 'p', model: 'm', default: true }, { id: 'b', provider: 'p', model: 'm', default: true }] }));
        expect(two).toEqual(['only one model may be marked "default"']);
    });

    test('fills defaults: first model is default, families by provider, thinking budget, forced tool choice detection', () => {
        const config = parseModelsConfig(JSON.stringify({
            providers: { a: { type: 'anthropic', apiKey: 'k' }, o: { type: 'openai', apiKey: 'k' } },
            models: [
                { id: 'haiku', provider: 'a', model: 'claude-haiku-4-5', thinking: { type: 'enabled' } },
                { id: 'fable', provider: 'a', model: 'claude-fable-5-1', cache: { enabled: false } },
                { id: 'gpt', provider: 'o', model: 'gpt-5.5', capabilities: { toolCalling: 64, imageInput: false } },
            ],
        }), { env, readFile });
        const [haiku, fable, gpt] = config.models;
        expect(haiku!.default).toBe(true);
        expect(haiku!.family).toBe('claude');
        expect(haiku!.thinking).toEqual({ type: 'enabled', budgetTokens: 4096 });
        expect(haiku!.maxInputTokens).toBe(200_000);
        expect(haiku!.maxOutputTokens).toBe(64_000);
        expect(fable!.forcedToolChoice).toBe(false);
        expect(fable!.cache.enabled).toBe(false);
        expect(gpt!.family).toBe('gpt');
        expect(gpt!.maxOutputTokens).toBe(32_768);
        expect(gpt!.capabilities).toEqual({ toolCalling: 64, imageInput: false });
        expect(supportsForcedToolChoice('claude-opus-5')).toBe(true);
        expect(supportsForcedToolChoice('claude-opus-5-5')).toBe(false);
    });

    test('header values are secrets too and are lower-cased', () => {
        const config = parseModelsConfig(JSON.stringify({
            providers: { p: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1/', headers: { 'X-Proxy-Token': '{env:AZURE_API_KEY}' } } },
            models: [{ id: 'm', provider: 'p', model: 'x' }],
        }), { env, readFile });
        expect(config.providers.p!.headers).toEqual({ 'x-proxy-token': env.AZURE_API_KEY });
        expect(config.providers.p!.baseUrl).toBe('http://127.0.0.1:1/v1');
        expect(config.secrets).toEqual([env.AZURE_API_KEY]);
        expect(config.providers.p!.apiKey).toBeUndefined();
    });
});
