// Config file loader for EZiL Models. JSON only, zero dependencies.
//
//   {
//     "providers": { "<name>": { "type": "anthropic" | "anthropic-foundry" | "openai" | "azure-openai" | "openai-compatible" | "ezil-gateway",
//                                 "apiKey": "{env:NAME}" | "{file:/path}" | "literal", "baseUrl"?, "resource"?, "apiVersion"?, "headers"?, "betas"? } },
//     "models": [ { "id", "name", "provider", "model", "family", "maxInputTokens", "maxOutputTokens",
//                   "capabilities": { "toolCalling", "imageInput" }, "thinking", "cache", "default", "roles" } ],
//     "defaults": { ...per-model defaults... }
//   }
//
// `{env:NAME}` and `{file:/path}` references are resolved at load time. Resolved secrets are collected
// in `ResolvedConfig.secrets` so callers can redact them from anything they log.

export const PROVIDER_TYPES = ['anthropic', 'anthropic-foundry', 'openai', 'azure-openai', 'openai-compatible', 'ezil-gateway'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const MODEL_ROLES = ['default', 'plan', 'utility', 'utilitySmall'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export type ThinkingConfig = {
    type: 'adaptive' | 'enabled' | 'disabled';
    budgetTokens?: number;
    effort?: Effort;
    display?: 'summarized' | 'omitted' | 'updates';
};

export type CacheConfig = { enabled?: boolean; ttl?: '5m' | '1h' };

export type ProviderConfig = {
    type: ProviderType;
    apiKey?: string;
    baseUrl?: string;
    resource?: string;
    apiVersion?: string;
    headers?: Record<string, string>;
    /** Anthropic `anthropic-beta` header values. */
    betas?: string[];
    /** OpenAI-style providers: send `stream_options.include_usage` (default true). */
    includeUsage?: boolean;
    /** OpenAI-style providers: which field carries the output-token limit (default depends on type). */
    maxTokensField?: 'max_tokens' | 'max_completion_tokens';
};

export type ModelConfig = {
    id: string;
    name?: string;
    provider: string;
    model: string;
    family?: string;
    version?: string;
    tooltip?: string;
    detail?: string;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    capabilities?: { toolCalling?: boolean | number; imageInput?: boolean };
    thinking?: ThinkingConfig;
    cache?: CacheConfig;
    default?: boolean;
    roles?: ModelRole[];
    /** Send `tool_choice: any` when Copilot asks for a required tool call. Off for models that 400 on forced tool use. */
    forcedToolChoice?: boolean;
    temperature?: number;
};

export type ModelsConfig = {
    providers: Record<string, ProviderConfig>;
    models: ModelConfig[];
    defaults?: Partial<Omit<ModelConfig, 'id' | 'provider' | 'model' | 'default' | 'roles'>>;
};

export type ResolvedProvider = Required<Pick<ProviderConfig, 'type' | 'headers' | 'betas' | 'includeUsage'>> &
    Pick<ProviderConfig, 'apiKey' | 'baseUrl' | 'resource' | 'apiVersion' | 'maxTokensField'> & { name: string };

export type ResolvedModel = {
    id: string;
    name: string;
    providerName: string;
    provider: ResolvedProvider;
    model: string;
    family: string;
    version: string;
    tooltip?: string;
    detail?: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    capabilities: { toolCalling: boolean | number; imageInput: boolean };
    thinking?: ThinkingConfig;
    cache: { enabled: boolean; ttl: '5m' | '1h' };
    default: boolean;
    roles: ModelRole[];
    forcedToolChoice: boolean;
    temperature?: number;
};

export type ResolvedConfig = {
    providers: Record<string, ResolvedProvider>;
    models: ResolvedModel[];
    /** Every resolved secret value (API keys, header values); use `redact()` before logging. */
    secrets: string[];
    /**
     * One line per provider that was skipped because a `{env:}` / `{file:}` reference could not be resolved
     * (names the variable or path, never a value). Its models are not served; every other provider is.
     */
    warnings: string[];
    /** Schema problems in individual providers/models. Those entries are dropped; the rest of the file is served. */
    errors: string[];
};

/**
 * Thrown only when the file cannot be used at all: not JSON, not an object, or missing/empty "providers" or
 * "models". Problems inside individual entries are reported in `ResolvedConfig.errors` / `.warnings` instead so
 * one bad provider or model never takes the others down.
 */
export class ConfigError extends Error {
    constructor(public readonly errors: string[], public readonly source?: string) {
        super(`${source ? `${source}: ` : ''}invalid EZiL models config:\n  - ${errors.join('\n  - ')}`);
        this.name = 'ConfigError';
    }
}

export type LoadOptions = {
    env?: NodeJS.ProcessEnv;
    readFile?: (path: string) => string;
    source?: string;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const REFERENCE = /^\{(env|file):([^}]+)\}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAnthropic(type: ProviderType): boolean {
    return type === 'anthropic' || type === 'anthropic-foundry';
}

/** The EZiL AI gateway (`ai.ezil.work`, reached through the EZiL OS Worker proxy): Responses API, no provider key. */
export function isGateway(type: ProviderType): boolean {
    return type === 'ezil-gateway';
}

/** Gateway alias defaults when a model entry does not set them (`ezil-code` today: 16,384 in / 4,096 out). */
export const GATEWAY_DEFAULT_MAX_INPUT_TOKENS = 16_384;
export const GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

/** Models known to reject forced `tool_choice` (`any`/`tool`) with a 400. */
export function supportsForcedToolChoice(model: string): boolean {
    return !/opus-5-5|fable-5|mythos/i.test(model);
}

export function parseModelsConfig(text: string, options: LoadOptions = {}): ResolvedConfig {
    const source = options.source;
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        throw new ConfigError([`not valid JSON (${(error as Error).message}). YAML is not supported; use JSON.`], source);
    }
    return resolveModelsConfig(raw, options);
}

/** A provider entry after resolution, plus why (if at all) it is not being served. */
type ProviderOutcome = {
    provider: ResolvedProvider;
    /** `{env:}` / `{file:}` references that could not be resolved (`apiKey: environment variable X is not set`). */
    unresolved: string[];
    /** Schema problems in this entry (full paths). */
    problems: string[];
    /** Models that referenced this provider and were therefore not served. */
    omittedModels: number;
};

export function resolveModelsConfig(raw: unknown, options: LoadOptions = {}): ResolvedConfig {
    const fatal: string[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const secrets: string[] = [];
    const env = options.env ?? process.env;
    const readFile = options.readFile ?? ((path: string) => require('node:fs').readFileSync(path, 'utf8') as string);

    type Sink = { problems: string[]; unresolved: string[] };
    /** Resolves one string field. Type problems go to `sink.problems`; a reference that cannot be resolved goes to `sink.unresolved` (naming the variable or path only, never a value). */
    const resolveString = (value: unknown, where: string, field: string, secret: boolean, sink: Sink): string | undefined => {
        if (value === undefined) return undefined;
        if (typeof value !== 'string') { sink.problems.push(`${where}.${field} must be a string`); return undefined; }
        const match = REFERENCE.exec(value.trim());
        let resolved = value;
        if (match) {
            const [, kind, target] = match as unknown as [string, 'env' | 'file', string];
            const name = target.trim();
            if (kind === 'env') {
                const fromEnv = env[name];
                if (fromEnv === undefined || fromEnv === '') { sink.unresolved.push(`${field}: environment variable ${name} is not set`); return undefined; }
                resolved = fromEnv;
            } else {
                try { resolved = readFile(name).trim(); } catch (error) { sink.unresolved.push(`${field}: cannot read ${name} (${(error as Error).message})`); return undefined; }
                if (!resolved) { sink.unresolved.push(`${field}: ${name} is empty`); return undefined; }
            }
        }
        if (secret && resolved) secrets.push(resolved);
        return resolved;
    };

    if (!isRecord(raw)) throw new ConfigError(['top level must be an object with "providers" and "models"'], options.source);

    // Every provider entry is resolved, valid or not, so models that point at a broken provider are still fully
    // validated (all problems reported at once) — only entries with no problems are served.
    const outcomes: Record<string, ProviderOutcome> = {};
    const providers: Record<string, ResolvedProvider> = {};
    const providerEntries = isRecord(raw.providers) ? Object.entries(raw.providers).filter(([name]) => name !== '$comment') : [];
    if (!isRecord(raw.providers) || providerEntries.length === 0) {
        fatal.push('"providers" must be a non-empty object');
    } else {
        for (const [name, value] of providerEntries) {
            const where = `providers.${name}`;
            const sink: Sink = { problems: [], unresolved: [] };
            if (!ID_PATTERN.test(name)) sink.problems.push(`${where}: provider names must match ${ID_PATTERN}`);
            if (!isRecord(value)) { errors.push(`${where} must be an object`); continue; }
            const type = value.type as ProviderType;
            if (!PROVIDER_TYPES.includes(type)) { errors.push(`${where}.type must be one of ${PROVIDER_TYPES.join(', ')}`); continue; }
            const apiKey = resolveString(value.apiKey, where, 'apiKey', true, sink);
            const baseUrl = resolveString(value.baseUrl, where, 'baseUrl', false, sink)?.replace(/\/+$/, '');
            const resource = resolveString(value.resource, where, 'resource', false, sink);
            const apiVersion = resolveString(value.apiVersion, where, 'apiVersion', false, sink);
            const headers: Record<string, string> = {};
            if (value.headers !== undefined) {
                if (!isRecord(value.headers)) sink.problems.push(`${where}.headers must be an object of strings`);
                else for (const [header, headerValue] of Object.entries(value.headers)) {
                    const resolved = resolveString(headerValue, where, `headers.${header}`, true, sink);
                    if (resolved !== undefined) headers[header.toLowerCase()] = resolved;
                }
            }
            let betas: string[] = [];
            if (value.betas !== undefined) {
                if (!Array.isArray(value.betas) || value.betas.some(beta => typeof beta !== 'string')) sink.problems.push(`${where}.betas must be an array of strings`);
                else betas = value.betas as string[];
            }
            if (value.includeUsage !== undefined && typeof value.includeUsage !== 'boolean') sink.problems.push(`${where}.includeUsage must be a boolean`);
            if (value.maxTokensField !== undefined && value.maxTokensField !== 'max_tokens' && value.maxTokensField !== 'max_completion_tokens') sink.problems.push(`${where}.maxTokensField must be max_tokens or max_completion_tokens`);
            // Presence checks only fire when the field is absent or blank — an unresolved reference is reported (once) above.
            const given = (field: string, resolved: string | undefined) => resolved || sink.unresolved.some(line => line.startsWith(`${field}:`)) || sink.problems.some(line => line.startsWith(`${where}.${field} `));
            if (!given('apiKey', apiKey) && type !== 'openai-compatible') sink.problems.push(`${where}.apiKey is required for type ${type}`);
            if ((type === 'anthropic-foundry' || type === 'azure-openai') && !given('resource', resource) && !given('baseUrl', baseUrl)) sink.problems.push(`${where}: type ${type} needs "resource" (Azure resource name) or "baseUrl"`);
            if (type === 'openai-compatible' && !given('baseUrl', baseUrl)) sink.problems.push(`${where}: type openai-compatible needs "baseUrl"`);
            if (type === 'ezil-gateway' && !given('baseUrl', baseUrl)) sink.problems.push(`${where}: type ezil-gateway needs "baseUrl" (the EZiL OS AI proxy, e.g. {env:EZIL_AI_BASE_URL})`);
            if (baseUrl && !/^https?:\/\//.test(baseUrl)) sink.problems.push(`${where}.baseUrl must start with http:// or https://`);
            if (resource && !/^[a-z0-9-]+$/i.test(resource)) sink.problems.push(`${where}.resource must be a bare Azure resource name (letters, digits, hyphens)`);
            const provider: ResolvedProvider = {
                name, type, apiKey, baseUrl, resource, apiVersion, headers, betas,
                includeUsage: value.includeUsage !== false,
                maxTokensField: value.maxTokensField as ResolvedProvider['maxTokensField'],
            };
            outcomes[name] = { provider, unresolved: sink.unresolved, problems: sink.problems, omittedModels: 0 };
            if (!sink.problems.length && !sink.unresolved.length) providers[name] = provider;
        }
    }

    const defaults = isRecord(raw.defaults) ? raw.defaults : {};
    if (raw.defaults !== undefined && !isRecord(raw.defaults)) errors.push('"defaults" must be an object (ignored)');

    const models: ResolvedModel[] = [];
    const seen = new Set<string>();
    if (!Array.isArray(raw.models) || raw.models.length === 0) {
        fatal.push('"models" must be a non-empty array');
    } else {
        raw.models.forEach((entry: unknown, index: number) => {
            const where = `models[${index}]`;
            const problems: string[] = [];
            if (!isRecord(entry)) { errors.push(`${where} must be an object`); return; }
            const merged: Record<string, unknown> = { ...defaults, ...entry };
            const id = typeof merged.id === 'string' ? merged.id : undefined;
            if (!id || !ID_PATTERN.test(id)) { errors.push(`${where}.id must match ${ID_PATTERN}`); return; }
            if (seen.has(id.toLowerCase())) problems.push(`${where}.id "${id}" is duplicated (ids are compared case-insensitively)`);
            seen.add(id.toLowerCase());
            const providerName = typeof merged.provider === 'string' ? merged.provider : undefined;
            const outcome = providerName ? outcomes[providerName] : undefined;
            if (!outcome) { errors.push(`${where}.provider "${String(merged.provider)}" is not defined in "providers"`); return; }
            const provider = outcome.provider;
            if (typeof merged.model !== 'string' || !merged.model) { errors.push(`${where}.model (provider model id or deployment name) is required`); return; }
            const positiveInt = (value: unknown, field: string, fallback: number): number => {
                if (value === undefined) return fallback;
                if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) { problems.push(`${where}.${field} must be a positive integer`); return fallback; }
                return value;
            };
            const capabilities = isRecord(merged.capabilities) ? merged.capabilities : {};
            if (merged.capabilities !== undefined && !isRecord(merged.capabilities)) problems.push(`${where}.capabilities must be an object`);
            const toolCalling = capabilities.toolCalling === undefined ? true : capabilities.toolCalling;
            if (typeof toolCalling !== 'boolean' && typeof toolCalling !== 'number') problems.push(`${where}.capabilities.toolCalling must be a boolean or a number`);
            const imageInput = capabilities.imageInput === undefined ? !isGateway(provider.type) : capabilities.imageInput;
            if (typeof imageInput !== 'boolean') problems.push(`${where}.capabilities.imageInput must be a boolean`);
            // The gateway refuses images, files and audio (400 unsupported_content).
            if (isGateway(provider.type) && imageInput === true) problems.push(`${where}.capabilities.imageInput must be false for ezil-gateway (the gateway accepts text only)`);

            let thinking: ThinkingConfig | undefined;
            if (merged.thinking !== undefined) {
                if (!isRecord(merged.thinking)) problems.push(`${where}.thinking must be an object`);
                else {
                    const type = merged.thinking.type;
                    if (type !== 'adaptive' && type !== 'enabled' && type !== 'disabled') problems.push(`${where}.thinking.type must be adaptive, enabled or disabled`);
                    else {
                        thinking = { type };
                        if (merged.thinking.budgetTokens !== undefined) thinking.budgetTokens = positiveInt(merged.thinking.budgetTokens, 'thinking.budgetTokens', 1024);
                        if (type === 'enabled' && thinking.budgetTokens === undefined) thinking.budgetTokens = 4096;
                        if (thinking.budgetTokens !== undefined && thinking.budgetTokens < 1024) problems.push(`${where}.thinking.budgetTokens must be at least 1024`);
                        if (merged.thinking.effort !== undefined) {
                            if (!EFFORT_LEVELS.includes(merged.thinking.effort as Effort)) problems.push(`${where}.thinking.effort must be one of ${EFFORT_LEVELS.join(', ')}`);
                            else thinking.effort = merged.thinking.effort as Effort;
                        }
                        if (merged.thinking.display !== undefined) {
                            if (!['summarized', 'omitted', 'updates'].includes(merged.thinking.display as string)) problems.push(`${where}.thinking.display must be summarized, omitted or updates`);
                            else thinking.display = merged.thinking.display as ThinkingConfig['display'];
                        }
                    }
                }
            }

            const cache: ResolvedModel['cache'] = { enabled: isAnthropic(provider.type), ttl: '5m' };
            if (merged.cache !== undefined) {
                if (!isRecord(merged.cache)) problems.push(`${where}.cache must be an object`);
                else {
                    if (merged.cache.enabled !== undefined) {
                        if (typeof merged.cache.enabled !== 'boolean') problems.push(`${where}.cache.enabled must be a boolean`);
                        else cache.enabled = merged.cache.enabled;
                    }
                    if (merged.cache.ttl !== undefined) {
                        if (merged.cache.ttl !== '5m' && merged.cache.ttl !== '1h') problems.push(`${where}.cache.ttl must be "5m" or "1h"`);
                        else cache.ttl = merged.cache.ttl;
                    }
                }
            }
            if (cache.enabled && !isAnthropic(provider.type)) cache.enabled = false;

            let roles: ModelRole[] = [];
            if (merged.roles !== undefined) {
                if (!Array.isArray(merged.roles) || merged.roles.some(role => !MODEL_ROLES.includes(role as ModelRole))) problems.push(`${where}.roles must be an array of ${MODEL_ROLES.join(', ')}`);
                else roles = merged.roles as ModelRole[];
            }
            if (merged.default !== undefined && typeof merged.default !== 'boolean') problems.push(`${where}.default must be a boolean`);
            if (merged.forcedToolChoice !== undefined && typeof merged.forcedToolChoice !== 'boolean') problems.push(`${where}.forcedToolChoice must be a boolean`);
            if (merged.temperature !== undefined && (typeof merged.temperature !== 'number' || merged.temperature < 0 || merged.temperature > 2)) problems.push(`${where}.temperature must be a number between 0 and 2`);
            for (const field of ['name', 'family', 'version', 'tooltip', 'detail'] as const) {
                if (merged[field] !== undefined && typeof merged[field] !== 'string') problems.push(`${where}.${field} must be a string`);
            }

            const isDefault = merged.default === true || roles.includes('default');
            const resolved: ResolvedModel = {
                id,
                name: typeof merged.name === 'string' ? merged.name : id,
                providerName: provider.name,
                provider,
                model: merged.model,
                family: typeof merged.family === 'string' ? merged.family : isAnthropic(provider.type) ? 'claude' : 'gpt',
                version: typeof merged.version === 'string' ? merged.version : '1',
                tooltip: typeof merged.tooltip === 'string' ? merged.tooltip : undefined,
                detail: typeof merged.detail === 'string' ? merged.detail : undefined,
                maxInputTokens: positiveInt(merged.maxInputTokens, 'maxInputTokens', isGateway(provider.type) ? GATEWAY_DEFAULT_MAX_INPUT_TOKENS : 200_000),
                maxOutputTokens: positiveInt(merged.maxOutputTokens, 'maxOutputTokens', isGateway(provider.type) ? GATEWAY_DEFAULT_MAX_OUTPUT_TOKENS : isAnthropic(provider.type) ? 64_000 : 32_768),
                capabilities: { toolCalling: toolCalling as boolean | number, imageInput: imageInput as boolean },
                thinking,
                cache,
                default: isDefault,
                roles,
                forcedToolChoice: typeof merged.forcedToolChoice === 'boolean' ? merged.forcedToolChoice : supportsForcedToolChoice(merged.model),
                temperature: typeof merged.temperature === 'number' ? merged.temperature : undefined,
            };
            // The model's own problems are always reported; a model on a provider that is not served is
            // validated (so every problem shows up in one pass) but counted, not served.
            if (problems.length) { errors.push(...problems); return; }
            if (outcome.problems.length || outcome.unresolved.length) { outcome.omittedModels += 1; return; }
            models.push(resolved);
        });
        if (models.length && !models.some(model => model.default)) models[0]!.default = true;
        const defaultModels = models.filter(model => model.default);
        if (defaultModels.length > 1) {
            errors.push(`only one model may be marked "default" (${defaultModels.map(model => model.id).join(', ')}); keeping ${defaultModels[0]!.id}`);
            for (const model of defaultModels.slice(1)) model.default = false;
        }
    }

    // One line per provider that is not served: a schema problem is an error, an unresolvable secret reference
    // (the key simply is not present on this machine) a warning. Both name what is missing, never a value.
    for (const [name, outcome] of Object.entries(outcomes)) {
        const omitted = `${outcome.omittedModels} model(s) not served`;
        if (outcome.problems.length) errors.push(`providers.${name} not loaded (${omitted}): ${[...outcome.problems, ...outcome.unresolved].join('; ')}`);
        else if (outcome.unresolved.length) warnings.push(`providers.${name} skipped (${omitted}): ${outcome.unresolved.join('; ')}`);
    }

    if (fatal.length) throw new ConfigError(fatal, options.source);
    return { providers, models, secrets: Array.from(new Set(secrets)).sort((a, b) => b.length - a.length), warnings, errors };
}

/** Replace every known secret in `text` (also as URL-encoded and base64 variants of plain secrets). */
export function redact(text: string, secrets: readonly string[]): string {
    let out = text;
    for (const secret of secrets) {
        if (secret.length < 4) continue;
        out = out.split(secret).join('[redacted]');
        const encoded = encodeURIComponent(secret);
        if (encoded !== secret) out = out.split(encoded).join('[redacted]');
    }
    return out;
}

/** A log-safe summary of the loaded config (no key material), ending with the per-entry problems, if any. */
export function describeConfig(config: ResolvedConfig): string {
    const lines: string[] = [];
    for (const warning of config.warnings) lines.push(`warning: ${warning}`);
    for (const error of config.errors) lines.push(`error: ${error}`);
    for (const provider of Object.values(config.providers)) {
        lines.push(`provider ${provider.name}: type=${provider.type}${provider.resource ? ` resource=${provider.resource}` : ''}${provider.baseUrl ? ` baseUrl=${provider.baseUrl}` : ''} apiKey=${provider.apiKey ? 'set' : 'none'}${provider.betas.length ? ` betas=${provider.betas.join(',')}` : ''}`);
    }
    for (const model of config.models) {
        lines.push(`model ${model.id}: "${model.name}" -> ${model.providerName}/${model.model} in=${model.maxInputTokens} out=${model.maxOutputTokens} tools=${String(model.capabilities.toolCalling)} images=${model.capabilities.imageInput}${model.thinking ? ` thinking=${model.thinking.type}${model.thinking.effort ? `/${model.thinking.effort}` : ''}` : ''}${model.cache.enabled ? ` cache=${model.cache.ttl}` : ''}${model.default ? ' [default]' : ''}${model.roles.length ? ` roles=${model.roles.join(',')}` : ''}`);
    }
    return lines.join('\n');
}
