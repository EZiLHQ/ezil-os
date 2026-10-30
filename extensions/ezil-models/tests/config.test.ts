import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, describeConfig, parseModelsConfig, redact, supportsForcedToolChoice } from '../src/config';

const env = { ANTHROPIC_API_KEY: 'sk-ant-secret-1234567890', AZURE_API_KEY: 'azure-secret-0987654321', OPENAI_API_KEY: 'sk-openai-secret', AZURE_OPENAI_API_KEY: 'azure-openai-secret' };
const files: Record<string, string> = { '/run/secrets/foundry-api-key': 'foundry-file-secret\n' };
const readFile = (path: string) => { const value = files[path]; if (value === undefined) throw new Error('ENOENT'); return value; };
const example = readFileSync(join(import.meta.dir, 'fixtures', 'direct-providers.models.json'), 'utf8');
/** The template the desktop image ships as /etc/ezil/models.json (four providers, all keys from the environment). */
const shipped = readFileSync(join(import.meta.dir, '..', '..', '..', 'worker', 'ezil-models', 'models.json'), 'utf8');

/** Structural failures throw; problems in individual entries come back on the config. Both are "errors" here. */
function errorsOf(text: string): string[] {
    try { return parseModelsConfig(text, { env, readFile }).errors; } catch (error) { if (error instanceof ConfigError) return error.errors; throw error; }
}

function fatalOf(text: string): string[] {
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
        expect(config.warnings).toEqual([]);
        expect(config.errors).toEqual([]);
    });

    describe('shipped gateway template', () => {
        test('serves only Qwen and Kimi with environment references', () => {
            const config = parseModelsConfig(shipped, { env: { EZIL_AI_BASE_URL: 'https://proxy.invalid/ai/v1', EZIL_AI_PROXY_TOKEN: 'synthetic-test-token' } });
            expect(Object.keys(config.providers)).toEqual(['ezil']);
            expect(config.models.map(model => model.id)).toEqual(['qwen.qwen3-coder-next', 'us.moonshotai.kimi-k3']);
            expect(config.models[0]!.roles).toEqual(['default', 'plan', 'utility', 'utilitySmall']);
            expect(config.models.map(model => model.stream)).toEqual([true, false]);
            expect(config.models.map(model => model.maxOutputTokens)).toEqual([8192, 4096]);
            expect(config.models.every(model => !model.forcedToolChoice && !model.cache.enabled && !model.capabilities.imageInput)).toBe(true);
            expect(config.errors).toEqual([]);
        });
        test('no gateway variables means no models, one redacted warning', () => {
            const config = parseModelsConfig(shipped, { env: { EZIL_AI_PROXY_TOKEN: 'synthetic-test-token' } });
            expect(config.models).toEqual([]);
            expect(config.warnings).toHaveLength(1);
            expect(config.warnings[0]).toContain('EZIL_AI_BASE_URL');
            expect(config.warnings[0]).not.toContain('synthetic-test-token');
        });
    });

    test('one bad model entry is reported and dropped; the other models are still served', () => {
        const config = parseModelsConfig(JSON.stringify({
            providers: { a: { type: 'anthropic', apiKey: 'k' } },
            models: [
                { id: 'good-1', provider: 'a', model: 'claude-sonnet-5', default: true },
                { id: 'broken', provider: 'a', model: 'claude-sonnet-5', thinking: { type: 'weird' }, maxOutputTokens: 0 },
                { id: 'ghosted', provider: 'nope', model: 'x' },
                { id: 'good-2', provider: 'a', model: 'claude-haiku-4-5' },
            ],
        }), { env, readFile });
        expect(config.models.map(model => model.id)).toEqual(['good-1', 'good-2']);
        expect(config.models[0]!.default).toBe(true);
        expect(config.warnings).toEqual([]);
        expect(config.errors).toEqual([
            'models[1].thinking.type must be adaptive, enabled or disabled',
            'models[1].maxOutputTokens must be a positive integer',
            'models[2].provider "nope" is not defined in "providers"',
        ]);
    });

    test('a provider with a schema problem is an error (not a warning) and its models are omitted, others served', () => {
        const config = parseModelsConfig(JSON.stringify({
            providers: { ok: { type: 'openai', apiKey: 'k' }, bad: { type: 'anthropic-foundry', apiKey: 'k' }, unset: { type: 'openai', apiKey: '{env:NOPE}', baseUrl: 'ftp://x' } },
            models: [{ id: 'a', provider: 'ok', model: 'gpt-5.5' }, { id: 'b', provider: 'bad', model: 'm' }, { id: 'c', provider: 'unset', model: 'm' }],
        }), { env, readFile });
        expect(config.models.map(model => model.id)).toEqual(['a']);
        expect(config.warnings).toEqual([]);
        expect(config.errors).toEqual([
            'providers.bad not loaded (1 model(s) not served): providers.bad: type anthropic-foundry needs "resource" (Azure resource name) or "baseUrl"',
            'providers.unset not loaded (1 model(s) not served): providers.unset.baseUrl must start with http:// or https://; apiKey: environment variable NOPE is not set',
        ]);
    });

    test('$comment is ignored at every level, including inside "providers"', () => {
        const config = parseModelsConfig(JSON.stringify({
            $comment: 'root',
            providers: { $comment: 'providers', p: { $comment: 'provider', type: 'openai', apiKey: 'k' } },
            defaults: { $comment: 'defaults', capabilities: { $comment: 'caps', imageInput: false } },
            models: [{ $comment: 'model', id: 'm', provider: 'p', model: 'gpt-5.5', thinking: { $comment: 'thinking', type: 'adaptive' }, cache: { $comment: 'cache' } }],
        }), { env, readFile });
        expect(Object.keys(config.providers)).toEqual(['p']);
        expect(config.models.map(model => model.id)).toEqual(['m']);
        expect(config.models[0]!.capabilities.imageInput).toBe(false);
        expect(config.errors).toEqual([]);
        expect(config.warnings).toEqual([]);
    });

    test('describeConfig and redact never expose key material', () => {
        const config = parseModelsConfig(example, { env, readFile });
        const summary = describeConfig(config);
        for (const secret of config.secrets) expect(summary).not.toContain(secret);
        expect(summary).toContain('apiKey=set');
        expect(redact(`x-api-key: ${env.ANTHROPIC_API_KEY} / ${encodeURIComponent('azure-secret-0987654321')}`, config.secrets)).toBe('x-api-key: [redacted] / [redacted]');
    });

    test('reports every validation problem at once with paths (unresolved references are warnings, the rest errors)', () => {
        const config = parseModelsConfig(JSON.stringify({
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
                { id: 'd', provider: 'envmissing', model: 'm' },
            ],
        }), { env, readFile });
        expect(config.models).toEqual([]);
        expect(config.providers).toEqual({});
        expect(config.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('providers.bad.type must be one of'),
            expect.stringContaining('providers.nokey not loaded (0 model(s) not served): providers.nokey.apiKey is required for type anthropic'),
            'providers.foundry not loaded (0 model(s) not served): providers.foundry: type anthropic-foundry needs "resource" (Azure resource name) or "baseUrl"',
            'providers.compat not loaded (0 model(s) not served): providers.compat: type openai-compatible needs "baseUrl"',
            'models[0].thinking.type must be adaptive, enabled or disabled',
            'models[0].cache.ttl must be "5m" or "1h"',
            'models[0].roles must be an array of default, plan, utility, utilitySmall',
            'models[0].maxInputTokens must be a positive integer',
            'models[1].provider "ghost" is not defined in "providers"',
            expect.stringContaining('models[2].id must match'),
            'models[3].model (provider model id or deployment name) is required',
        ]));
        expect(config.errors.filter(error => error.startsWith('models['))).toHaveLength(7); // models[0] x4, models[1], models[2], models[3]
        expect(config.warnings).toEqual([
            'providers.envmissing skipped (1 model(s) not served): apiKey: environment variable DOES_NOT_EXIST is not set',
            expect.stringContaining('providers.filemissing skipped (0 model(s) not served): apiKey: cannot read /nowhere'),
        ]);
        // A duplicate id is a problem of the later entry even when both sit on a provider that is not served.
        expect(errorsOf(JSON.stringify({ providers: { nokey: { type: 'anthropic' } }, models: [{ id: 'a', provider: 'nokey', model: 'm' }, { id: 'A', provider: 'nokey', model: 'm' }] })))
            .toContain('models[1].id "A" is duplicated (ids are compared case-insensitively)');
    });

    test('rejects YAML / non-JSON and missing sections outright; multiple defaults keep the first', () => {
        expect(fatalOf('providers:\n  a: {}')[0]).toContain('not valid JSON');
        expect(fatalOf('{}')).toEqual(['"providers" must be a non-empty object', '"models" must be a non-empty array']);
        expect(fatalOf(JSON.stringify({ providers: { $comment: 'only a comment' }, models: [] }))).toEqual(['"providers" must be a non-empty object', '"models" must be a non-empty array']);
        const two = parseModelsConfig(JSON.stringify({ providers: { p: { type: 'openai', apiKey: 'k' } }, models: [{ id: 'a', provider: 'p', model: 'm', default: true }, { id: 'b', provider: 'p', model: 'm', default: true }] }), { env, readFile });
        expect(two.errors).toEqual(['only one model may be marked "default" (a, b); keeping a']);
        expect(two.models.map(model => [model.id, model.default])).toEqual([['a', true], ['b', false]]);
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

test('gateway defaults and configurable reserves; forced choice and images stay off', () => {
    const config = parseModelsConfig(JSON.stringify({
        providers: { p: { type: 'ezil-gateway', baseUrl: 'https://proxy.invalid/ai/v1', apiKey: '{env:TOKEN}' } },
        models: [{ id: 'qwen', provider: 'p', model: 'qwen.qwen3-coder-next', forcedToolChoice: true, temperature: 3, topP: -1, toolReserve: 12000 },
            { id: 'kimi', provider: 'p', model: 'us.moonshotai.kimi-k3', stream: true, capabilities: { imageInput: true } }],
    }), { env: { TOKEN: 'synthetic-key' } });
    expect(config.errors).toEqual([]);
    expect(config.models[0]).toMatchObject({ maxInputTokens: 131072, maxOutputTokens: 8192, forcedToolChoice: false, toolReserve: 12000 });
    expect(config.models[1]).toMatchObject({ maxOutputTokens: 4096, stream: false, capabilities: { imageInput: false } });
});

test('manifest and image keep Qwen utility roles independent of Kimi selection', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
    expect(manifest.license).toBe('AGPL-3.0-only');
    expect(manifest.contributes.configurationDefaults['chat.utilityModel']).toBe('ezil/qwen.qwen3-coder-next');
    expect(manifest.contributes.configurationDefaults['chat.utilitySmallModel']).toBe('ezil/qwen.qwen3-coder-next');
    expect(manifest.contributes.commands.some((c: { command: string }) => c.command === 'ezil-models.showCredits')).toBe(true);
});

test('gateway config clamps output limits at both boundaries', () => {
    for (const [maxOutputTokens, expected] of [[0, 16], [-1, 16], [99999, 16384], [1024.9, 1024]] as const) {
        const config = parseModelsConfig(JSON.stringify({ providers: { p: { type: 'ezil-gateway', baseUrl: 'https://proxy.invalid/ai/v1', apiKey: '{env:TOKEN}' } },
            models: [{ id: 'qwen', provider: 'p', model: 'qwen.qwen3-coder-next', maxOutputTokens }] }), { env: { TOKEN: 'synthetic-key' } });
        expect(config.errors).toEqual([]); expect(config.models[0]!.maxOutputTokens).toBe(expected);
    }
});

describe('explicit Gateway protocol configuration', () => {
    const providers = {
        gateway: { type: 'ezil-gateway', baseUrl: 'https://proxy.invalid/ai/v1', apiKey: '{env:TOKEN}' },
        direct: { type: 'azure-openai', resource: 'synthetic-resource', apiKey: '{env:TOKEN}' },
    };
    const parse = (models: unknown[], defaults?: Record<string, unknown>) => parseModelsConfig(JSON.stringify({ providers, models, defaults }), { env: { TOKEN: 'synthetic-key' } });

    test('selects Responses only from the model field while preserving legacy defaults', () => {
        const config = parse([
            { id: 'legacy', provider: 'gateway', model: 'gpt-5.5' },
            { id: 'messages', provider: 'gateway', model: 'custom-alias', gatewayProtocol: 'anthropic-messages' },
            { id: 'responses', provider: 'gateway', model: 'custom-alias', gatewayProtocol: 'openai-responses' },
        ]);
        expect(config.errors).toEqual([]);
        expect(config.models.map(model => model.gatewayProtocol)).toEqual([undefined, 'anthropic-messages', 'openai-responses']);
        expect(config.models[2]).toMatchObject({ maxOutputTokens: 8192, stream: true, cache: { enabled: false }, capabilities: { imageInput: false } });
        expect(config.models[2]!.provider).toMatchObject({ type: 'ezil-gateway', baseUrl: 'https://proxy.invalid/ai/v1', apiKey: 'synthetic-key' });
    });

    test('invalid protocols and protocols on direct providers drop only those models', () => {
        const config = parse([
            { id: 'good', provider: 'gateway', model: 'custom-alias', gatewayProtocol: 'openai-responses' },
            ...['responses', 'OPENAI-RESPONSES', null, 1].map((gatewayProtocol, i) => ({ id: `bad-${i}`, provider: 'gateway', model: 'x', gatewayProtocol })),
            { id: 'direct', provider: 'direct', model: 'x', gatewayProtocol: 'openai-responses' },
        ]);
        expect(config.models.map(model => model.id)).toEqual(['good']);
        expect(config.errors).toHaveLength(5);
        expect(config.errors.slice(0, 4).every(error => error.includes('.gatewayProtocol must be one of'))).toBe(true);
        expect(config.errors[4]).toBe('models[5].gatewayProtocol is only supported for ezil-gateway providers');
    });

    test('defaults cannot opt models into Responses; an explicit model selection still works', () => {
        const config = parse([
            { id: 'legacy', provider: 'gateway', model: 'gpt-5.5' },
            { id: 'explicit', provider: 'gateway', model: 'x', gatewayProtocol: 'openai-responses' },
            { id: 'direct', provider: 'direct', model: 'x' },
        ], { gatewayProtocol: 'openai-responses', maxOutputTokens: 2048 });
        expect(config.models.map(model => model.gatewayProtocol)).toEqual([undefined, 'openai-responses', undefined]);
        expect(config.models.every(model => model.maxOutputTokens === 2048)).toBe(true);
        expect(config.errors).toEqual(['defaults.gatewayProtocol is not supported; set gatewayProtocol on each Gateway model (ignored)']);
    });

    test('Kimi compatibility settings apply only to the legacy protocol', () => {
        const config = parse([
            { id: 'legacy', provider: 'gateway', model: 'us.moonshotai.kimi-k3', stream: true },
            { id: 'responses', provider: 'gateway', model: 'us.moonshotai.kimi-k3', gatewayProtocol: 'openai-responses', stream: true },
            { id: 'json', provider: 'gateway', model: 'x', gatewayProtocol: 'openai-responses', stream: false },
        ]);
        expect(config.errors).toEqual([]);
        expect(config.models.map(model => [model.stream, model.maxOutputTokens])).toEqual([[false, 4096], [true, 8192], [false, 8192]]);
    });
});
