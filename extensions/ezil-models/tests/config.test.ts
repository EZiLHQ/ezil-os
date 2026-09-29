import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, describeConfig, parseModelsConfig, redact, supportsForcedToolChoice } from '../src/config';

const env = { ANTHROPIC_API_KEY: 'sk-ant-secret-1234567890', AZURE_API_KEY: 'azure-secret-0987654321', OPENAI_API_KEY: 'sk-openai-secret', AZURE_OPENAI_API_KEY: 'azure-openai-secret' };
const files: Record<string, string> = { '/run/secrets/foundry-api-key': 'foundry-file-secret\n' };
const readFile = (path: string) => { const value = files[path]; if (value === undefined) throw new Error('ENOENT'); return value; };
const example = readFileSync(join(import.meta.dir, '..', 'examples', 'models.example.json'), 'utf8');
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

    describe('shipped image template (worker/ezil-models/models.json)', () => {
        const ids = (config: { models: { id: string }[] }) => config.models.map(model => model.id);

        test('with every variable set, all four providers and eight models are served', () => {
            const config = parseModelsConfig(shipped, { env: { ...env, AZURE_RESOURCE_NAME: 'my-foundry' }, readFile });
            expect(Object.keys(config.providers)).toEqual(['anthropic', 'foundry-anthropic', 'foundry-openai', 'openai']);
            expect(ids(config)).toEqual(['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5', 'foundry-claude-sonnet-5', 'foundry-gpt-4-1', 'foundry-gpt-5', 'gpt-5']);
            expect(config.models.filter(model => model.default).map(model => model.id)).toEqual(['claude-opus-5-5']);
            expect(config.providers['foundry-anthropic']!.resource).toBe('my-foundry');
            expect(config.warnings).toEqual([]);
            expect(config.errors).toEqual([]);
        });

        test('with only ANTHROPIC_API_KEY set, the anthropic models are served and the other providers are skipped with one warning each', () => {
            const config = parseModelsConfig(shipped, { env: { ANTHROPIC_API_KEY: 'sk-ant-only-1234567890' }, readFile });
            expect(Object.keys(config.providers)).toEqual(['anthropic']);
            expect(ids(config)).toEqual(['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5']);
            expect(config.models[0]!.default).toBe(true);
            expect(config.errors).toEqual([]);
            expect(config.warnings).toEqual([
                'providers.foundry-anthropic skipped (1 model(s) not served): apiKey: environment variable AZURE_API_KEY is not set; resource: environment variable AZURE_RESOURCE_NAME is not set',
                'providers.foundry-openai skipped (2 model(s) not served): apiKey: environment variable AZURE_API_KEY is not set; resource: environment variable AZURE_RESOURCE_NAME is not set',
                'providers.openai skipped (1 model(s) not served): apiKey: environment variable OPENAI_API_KEY is not set',
            ]);
            expect(config.secrets).toEqual(['sk-ant-only-1234567890']);
        });

        test('with no variable set, zero models are served and each of the four providers gets one warning naming its variables', () => {
            const config = parseModelsConfig(shipped, { env: {}, readFile });
            expect(config.models).toEqual([]);
            expect(config.providers).toEqual({});
            expect(config.errors).toEqual([]);
            expect(config.warnings).toHaveLength(4);
            expect(config.warnings.map(warning => warning.split(' ')[0])).toEqual(['providers.anthropic', 'providers.foundry-anthropic', 'providers.foundry-openai', 'providers.openai']);
            expect(config.warnings[0]).toBe('providers.anthropic skipped (4 model(s) not served): apiKey: environment variable ANTHROPIC_API_KEY is not set');
            for (const [variable, count] of [['ANTHROPIC_API_KEY', 1], ['AZURE_RESOURCE_NAME', 2], ['AZURE_API_KEY', 2], ['OPENAI_API_KEY', 1]] as const) {
                expect(config.warnings.filter(warning => warning.includes(`environment variable ${variable} is not set`))).toHaveLength(count);
            }
            // The log summary carries the warnings so the output channel shows them.
            expect(describeConfig(config).split('\n').filter(line => line.startsWith('warning: '))).toHaveLength(4);
        });

        test('a partially resolved provider never leaks the value that did resolve', () => {
            const config = parseModelsConfig(shipped, { env: { AZURE_API_KEY: 'azure-only-secret-value' }, readFile });
            expect(config.models).toEqual([]);
            for (const warning of config.warnings) expect(warning).not.toContain('azure-only-secret-value');
            expect(config.warnings.filter(warning => warning.startsWith('providers.foundry-'))).toEqual([
                'providers.foundry-anthropic skipped (1 model(s) not served): resource: environment variable AZURE_RESOURCE_NAME is not set',
                'providers.foundry-openai skipped (2 model(s) not served): resource: environment variable AZURE_RESOURCE_NAME is not set',
            ]);
            expect(config.secrets).toEqual(['azure-only-secret-value']); // still known, so it is redacted from logs
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
