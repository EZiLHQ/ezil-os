// The VS Code LanguageModelChatProvider. Bridges VS Code's LanguageModel* classes to the neutral
// shapes in types.ts, streams the provider response back as VS Code parts, and records usage.

import * as vscode from 'vscode';
import type { CompactionInfo } from './compact';
import { appFailure, type AppFailure } from './failure';
import { CATALOG_REFUSALS, GatewayError, gatewayCatalogModels, gatewayModelAvailable, gatewayModels, includedModelNames, knownGatewayModels, modelIncluded, parseCatalogModelId, withCatalogDefault, withGatewayModelLimits, withPlanLocks, type GatewayModels } from './gateway';
import { gatewayInputTokens, gatewayOutputTokens, gatewayTokenCount, QWEN } from './gateway-messages';
import { chat, ProviderError } from './client';
import { redact, type ResolvedModel, type ResolvedProvider } from './config';
import { estimateMessageTokens, estimateTextTokens } from './tokens';
import { isCacheMarker, isStatefulMarker, type ChatRequest, type Message, type Part, type Role, type Tool, type Usage } from './types';
import { createHash, createHmac, randomBytes } from 'node:crypto';

/** Role value of the proposed `languageModelSystem` API; guarded numerically so a missing proposal degrades to the value. */
export const SYSTEM_ROLE = 3;

export type ProviderHost = {
    models(): ResolvedModel[];
    configError(): string | undefined;
    secrets(): string[];
    logRequests(): boolean;
    log(line: string): void;
    recordUsage(model: ResolvedModel, usage: Usage, elapsedMs: number): void;
    requestFinished?(model: ResolvedModel): void;
    /** Content-free gateway outcomes; observer errors must never change a turn. */
    appFailure?(record: AppFailure): void;
    /** The request goes compacted (compact.ts); `finished` settles when its turn ends. */
    compacted?(model: ResolvedModel, info: CompactionInfo, finished: Promise<void>): void;
    /** Ask the EZiL OS window around Code to open its billing dialog; true only when it took the request. */
    billingIntent?(intent: BillingIntent): Promise<boolean>;
    fetch?: typeof fetch;
};

/**
 * What Code asks the EZiL OS window to open; the OS picks the dialog from its own billing summary (Free: the Standard
 * upgrade; Standard or Premium: Add credits). Only two causes ever ask: a credit refusal (exactly `insufficient_credits`
 * or `no_live_grant`) and a locked model chosen in the picker. Content-free: a Gateway request id and a model alias.
 */
export type BillingIntent = { reason: 'credits_exhausted' | 'model_locked'; requestId?: string; model?: string };
/** The credit refusals that ask for the billing dialog; budgets, entitlement and every other code never do. */
export const CREDIT_REFUSALS: readonly string[] = ['insufficient_credits', 'no_live_grant'];
/** `infoText` key that marks a plan-locked model for the workbench's `picker-locked` patch (patch-copilot-chat.sh). */
export const LOCKED_MODEL_INFO_KEY = 'ezilPlanLocked';

type AnyPart = Record<string, unknown>;

/** JSON with object keys sorted, so equal values hash equally whatever their key order. */
function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}
function canonicalPart(part: Part): unknown {
    switch (part.type) {
        case 'text': return ['text', part.value];
        case 'tool_call': return ['call', part.callId, part.name, stableJson(part.input)];
        case 'tool_result': return ['result', part.callId, part.isError ?? null, part.content.map(canonicalPart)];
        case 'data': return ['data', part.mimeType, createHash('sha256').update(part.data).digest('hex')];
        default: return ['other'];
    }
}
/**
 * The identity of one turn's continuation, for the signed-thinking fallback: the resolved connection (provider type,
 * endpoint and credential, so a provider reconfigured to another endpoint or account under the same name never gets
 * the old one's signed thinking) and model, ALL system text of the request (the turn's effective system prompt: the Gateway
 * hoists every system message, wherever it sits, so a system note added, changed or removed anywhere never restores old
 * thinking), the exact non-system history before the turn (thinking and cache/stateful markers left out, as Copilot rebuilds
 * them), and the turn's ordered tool calls with their full inputs. The turn's own text is not compared. The connection enters as `connection`, an opaque number the provider
 * instance assigns to each distinct connection (connectionIdentity): the credential is never hashed. An HMAC-SHA256
 * under `secret`, a random key of the provider instance that never leaves memory: a cache lookup key, nothing of it is
 * kept or logged as text.
 */
function continuationKey(secret: Buffer, connection: number, model: ResolvedModel, request: readonly Message[], history: readonly Message[], calls: readonly { callId: string; name: string; input: unknown }[]): string {
    // As the Gateway receives it (gatewayConversation): the whole request's system text hoisted out in order, and the
    // non-system history as logical turns with adjacent same-role messages merged, so a history Copilot splits or rejoins
    // keys the same.
    const canonical = (message: Message) => message.parts.filter(part => part.type !== 'thinking' && !isCacheMarker(part) && !isStatefulMarker(part)).map(canonicalPart);
    const system = request.filter(message => message.role === 'system').flatMap(canonical);
    const turns: [Message['role'], unknown[]][] = [];
    for (const message of history) {
        if (message.role === 'system') continue;
        const parts = canonical(message);
        const previous = turns.at(-1);
        if (previous?.[0] === message.role) previous[1].push(...parts);
        else turns.push([message.role, parts]);
    }
    return createHmac('sha256', secret).update(JSON.stringify([connection, model.providerName, model.model, system, turns,
        calls.map(call => [call.callId, call.name, stableJson(call.input)])])).digest('hex');
}

type TurnCall = { callId: string; name: string; input: unknown };
function turnCalls(messages: readonly Message[]): TurnCall[] {
    return messages.flatMap(message => message.role !== 'assistant' ? [] : message.parts.flatMap(part => part.type === 'tool_call' ? [{ callId: part.callId, name: part.name, input: part.input }] : []));
}
/**
 * The end of the assistant turn that starts at `start`: adjacent assistant messages, and system messages among them
 * (the Gateway hoists those out, so they do not split the turn on the wire).
 */
function assistantTurnEnd(messages: readonly Message[], start: number): number {
    let end = start;
    for (let i = start; i < messages.length && messages[i]!.role !== 'user'; i++) if (messages[i]!.role === 'assistant') end = i + 1;
    return end;
}
/** Where a history's trailing assistant turn starts (its length when it ends in none): a reply continues that turn. */
function trailingAssistantTurn(messages: readonly Message[]): number {
    let start = messages.length;
    for (let i = messages.length - 1; i >= 0 && messages[i]!.role !== 'user'; i--) if (messages[i]!.role === 'assistant') start = i;
    return start;
}

// Constructor lookups are lazy because the proposed ThinkingPart may not exist at all.
function thinkingCtor(): (new (value: string | string[], id?: string, metadata?: Record<string, unknown>) => unknown) | undefined {
    return (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as never;
}

function isInstance(part: unknown, ctor: unknown): boolean {
    return typeof ctor === 'function' && part instanceof (ctor as new () => unknown);
}

export function toNeutralPart(part: unknown): Part | undefined {
    if (typeof part !== 'object' || part === null) return undefined;
    const record = part as AnyPart;
    const name = (record.constructor as { name?: string } | undefined)?.name;
    if (isInstance(part, vscode.LanguageModelToolCallPart) || (typeof record.callId === 'string' && typeof record.name === 'string' && 'input' in record)) {
        return { type: 'tool_call', callId: record.callId as string, name: record.name as string, input: record.input };
    }
    if (isInstance(part, vscode.LanguageModelToolResultPart) || (typeof record.callId === 'string' && Array.isArray(record.content))) {
        const content = (record.content as unknown[]).map(toNeutralPart).filter((inner): inner is Part => !!inner);
        return { type: 'tool_result', callId: record.callId as string, content, isError: record.isError === true };
    }
    if (isInstance(part, vscode.LanguageModelDataPart) || (typeof record.mimeType === 'string' && record.data instanceof Uint8Array)) {
        return { type: 'data', mimeType: record.mimeType as string, data: record.data as Uint8Array };
    }
    if (record.type === 'thinking' || record.type === 'redacted_thinking' || isInstance(part, thinkingCtor()) || (name === 'LanguageModelThinkingPart' && 'value' in record)) {
        const value = Array.isArray(record.value) ? (record.value as string[]).join('') : String(record.value ?? '');
        return { type: 'thinking', value, id: typeof record.id === 'string' ? record.id : undefined, metadata: record.metadata as Record<string, unknown> | undefined };
    }
    if (isInstance(part, vscode.LanguageModelTextPart) || typeof record.value === 'string') {
        return { type: 'text', value: record.value as string };
    }
    return undefined;
}

export function toNeutralRole(role: number): Role {
    if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
    if (role === SYSTEM_ROLE) return 'system';
    return 'user';
}

export function toNeutralMessage(message: vscode.LanguageModelChatRequestMessage): Message {
    const parts = (message.content as readonly unknown[]).map(toNeutralPart).filter((part): part is Part => !!part);
    const out: Message = { role: toNeutralRole(message.role as number), parts };
    if (message.name) out.name = message.name;
    return out;
}

export function toNeutralRequest(messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions): ChatRequest {
    const tools: Tool[] = (options.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    return {
        messages: messages.map(toNeutralMessage),
        tools,
        toolMode: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
        modelOptions: (options.modelOptions ?? {}) as Record<string, unknown>,
    };
}

export function toInformation(model: ResolvedModel): vscode.LanguageModelChatInformation {
    const info: vscode.LanguageModelChatInformation & Record<string, unknown> = {
        id: model.id,
        name: model.name,
        family: model.family,
        version: model.version,
        tooltip: model.tooltip ?? `${model.providerName} / ${model.model}`,
        detail: model.detail ?? model.providerName,
        maxInputTokens: model.provider.type === 'ezil-gateway' ? gatewayInputTokens(model) : model.maxInputTokens,
        maxOutputTokens: model.provider.type === 'ezil-gateway' ? gatewayOutputTokens(model) : model.maxOutputTokens,
        capabilities: { toolCalling: model.capabilities.toolCalling, imageInput: model.provider.type === 'ezil-gateway' ? false : model.capabilities.imageInput },
    };
    // Proposed `chatProvider` fields. code-server 4.141's extension host accepts them without the proposal enabled, and
    // `isDefault` is what makes the config's default model the first one in Chat (no chat.defaultModel is configured).
    info.isDefault = model.default;
    // A plan-locked model is never a chat model: VS Code never restores, defaults to or hands it to a subagent, so a saved
    // pick on Free falls back to the default with no dialog. The `picker-locked` patch still lists it (lock icon and this
    // text) and turns choosing it into the upgrade offer.
    info.isUserSelectable = !model.locked;
    if (model.locked) {
        const ThemeIcon = (vscode as unknown as Record<string, unknown>).ThemeIcon as (new (id: string) => unknown) | undefined;
        if (ThemeIcon) info.statusIcon = new ThemeIcon('lock');
        info.infoText = { [LOCKED_MODEL_INFO_KEY]: 'Not included in your plan. Choose it to see the upgrade.' };
    }
    return info;
}

const LONG_BASE64 = /"data":\s*"([A-Za-z0-9+/=]{200,})"/g;
const LONG_DATA_URL = /"url":\s*"data:([^;"]+);base64,[A-Za-z0-9+/=]{200,}"/g;

export function requestForLog(body: Record<string, unknown>, secrets: readonly string[]): string {
    const text = JSON.stringify(body, null, 1)
        .replace(LONG_BASE64, (_match, data: string) => `"data": "<${data.length} base64 chars>"`)
        .replace(LONG_DATA_URL, (_match, mime: string) => `"url": "data:${mime};base64,<omitted>"`);
    return redact(text, secrets);
}

/** Copilot uses initiator/role metadata for title, summary and progress utility calls. */
export function isUtilityRequest(options: Record<string, unknown>): boolean {
    return ['role', 'requestInitiator'].some(key => typeof options[key] === 'string' && /(?:^|[./_-])(utility(?:Small)?|title|summary|summariz(?:e|ation)|progress)(?:$|[./_-])/i.test(options[key] as string));
}

/**
 * Copilot 0.69 shows a failed request as "Reason:" plus the error's stack when it has one (toErrorMessage, verbose), so the
 * user saw extension.js frames under a repeated message. The message alone goes; the output channel keeps the details.
 */
function withoutStack(error: unknown): Error {
    const plain = error instanceof Error ? error : new Error(String(error));
    // VS Code serializes `cause` too (transformErrorForSerialization): clear every stack in the chain.
    let link: unknown = plain;
    for (let depth = 0; link instanceof Error && depth < 8; depth++, link = link.cause) link.stack = '';
    return plain;
}

function aiCreditsLink(): vscode.Uri | undefined {
    return osBillingLink('section=ai-credits&reason=insufficient_credits');
}

/**
 * An OS billing link, for a Code that is not inside an EZiL OS window. `reason=insufficient_credits` frames exhaustion
 * recovery, where the OS opens the Standard upgrade on Free and Add credits on a paid plan; `upgrade=standard` is the
 * pricing page's Standard link.
 */
function osBillingLink(query: string): vscode.Uri | undefined {
    try {
        const url = new URL(process.env.EZIL_AI_BASE_URL ?? '');
        if (url.protocol === 'https:') return vscode.Uri.parse(`${url.origin}/os?settings=billing&${query}`);
    } catch { /* no usable OS origin */ }
    return undefined;
}

/** A catalog as listed, for noticing that a later read changed it (ids, availability, caps and capabilities). */
function catalogSignature(catalog: GatewayModels | undefined): string {
    return catalog ? JSON.stringify([catalog.default_model ?? null, catalog.data.map(entry => [entry.id, entry.enabled, entry.protocols, entry.availability?.state,
        entry.name, entry.max_input_tokens, entry.max_output_tokens, entry.capabilities])]) : 'unread';
}

export class EZiLModelsProvider implements vscode.LanguageModelChatProvider {
    private readonly changed = new vscode.EventEmitter<void>();
    private lastCreditWarningAt = -Infinity;
    /** Per configured Gateway provider: the catalog the picker was last given. */
    private listedCatalogs = new Map<ResolvedProvider, string>();
    /** Keep only identity metadata for stale picker selections, including when the config cannot be read. */
    private modelIdentities = new Map<string, { type: ResolvedProvider['type']; model: string }>();
    /**
     * Fallback for a workbench without the ThinkingPart API: Copilot can then not carry a turn's signed thinking into its
     * history, and a native Claude tool turn needs it back. The completed signed or redacted blocks are kept here, in
     * memory only and never logged, under continuationKey: the resolved provider and model, the exact history the turn
     * answered and its full ordered tool calls (id, name, input). They are re-attached only to an assistant message that
     * continues exactly that history with exactly those calls (gateway-messages.ts replays them on the native route
     * only), so another conversation that reuses a call id, a changed input, or another model never receives them.
     * EZiL Gateway providers only (see respond). Bounded; lost on reload, when the request goes without them as before.
     */
    private signedThinking = new Map<string, Part[]>();
    /** The HMAC key for continuationKey: random per provider instance, never exported, logged or persisted. */
    private readonly continuationSecret = randomBytes(32);
    /** Opaque numbers for distinct connections (type, endpoint, credential), so no credential is ever hashed. Bounded. */
    private connectionIds = new Map<string, number>();
    private lastConnectionId = 0;
    readonly onDidChangeLanguageModelChatInformation = this.changed.event;

    constructor(private readonly host: ProviderHost) {}

    refresh(): void { this.changed.fire(); }
    dispose(): void { this.changed.dispose(); this.modelIdentities.clear(); this.signedThinking.clear(); this.connectionIds.clear(); }

    /** The same number for the same connection while it stays among the 16 most recent; another one for any change. */
    private connectionIdentity(provider: ResolvedProvider): number {
        const tuple = JSON.stringify([provider.type, provider.baseUrl ?? '', provider.resource ?? '', provider.apiVersion ?? '', provider.apiKey ?? '']);
        let id = this.connectionIds.get(tuple);
        if (id === undefined) {
            id = ++this.lastConnectionId;
            this.connectionIds.set(tuple, id);
            while (this.connectionIds.size > 16) this.connectionIds.delete(this.connectionIds.keys().next().value!);
        }
        return id;
    }

    private rememberSignedThinking(key: string, parts: readonly Part[]): void {
        this.signedThinking.delete(key);
        this.signedThinking.set(key, [...parts]);
        while (this.signedThinking.size > 64) this.signedThinking.delete(this.signedThinking.keys().next().value!);
    }

    /**
     * Re-attach kept signed thinking to an assistant turn only when it continues exactly the history the thinking was
     * produced after, with exactly the same ordered calls. A turn is what the Gateway receives as one assistant message:
     * adjacent assistant messages (Copilot may split one reply's text and calls into several) and system messages among
     * them, looked up as it was stored (storeSignedThinking). The Gateway puts the thinking first in the merged turn.
     */
    private restoreSignedThinking(model: ResolvedModel, request: ChatRequest): void {
        const messages = request.messages;
        for (let start = 0, end = 0; start < messages.length; start = Math.max(end, start + 1)) {
            if (messages[start]!.role !== 'assistant') { end = start + 1; continue; }
            end = assistantTurnEnd(messages, start);
            const turn = messages.slice(start, end).filter(message => message.role === 'assistant');
            if (turn.some(message => message.parts.some(part => part.type === 'thinking'))) continue;
            const calls = turnCalls(turn);
            if (!calls.length) continue;
            const kept = this.signedThinking.get(continuationKey(this.continuationSecret, this.connectionIdentity(model.provider), model, messages, messages.slice(0, start), calls));
            if (kept) turn[0]!.parts = [...kept, ...turn[0]!.parts];
        }
    }

    /**
     * Keep a completed turn's signed thinking under the key its continuation is looked up by. A history that ends in an
     * assistant turn (the reply continues it, as one assistant message at the Gateway) keys the history before that turn
     * and its calls followed by the reply's.
     */
    private storeSignedThinking(model: ResolvedModel, answered: readonly Message[], calls: readonly TurnCall[], signed: readonly Part[]): void {
        const start = trailingAssistantTurn(answered);
        const key = continuationKey(this.continuationSecret, this.connectionIdentity(model.provider), model, answered, answered.slice(0, start), [...turnCalls(answered.slice(start)), ...calls]);
        this.rememberSignedThinking(key, signed);
    }

    private rememberModels(models: ResolvedModel[]): ResolvedModel[] {
        for (const model of models) this.modelIdentities.set(model.id, { type: model.provider.type, model: model.model });
        return models;
    }

    private configuredModels(): ResolvedModel[] {
        return this.rememberModels(this.host.models());
    }

    /**
     * Re-list when a catalog read since the last listing changed what the picker shows (after a request, or when the
     * status panel opens). Reads only the cache: never a request of its own.
     */
    refreshIfCatalogChanged(): void {
        for (const [provider, listed] of this.listedCatalogs) {
            const known = knownGatewayModels(provider);
            if (known && catalogSignature(known) !== listed) { this.refresh(); return; }
        }
    }

    private gatewayProviders(): ResolvedProvider[] {
        return [...new Set(this.configuredModels().filter(model => model.provider.type === 'ezil-gateway').map(model => model.provider))];
    }

    async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
        if (token.isCancellationRequested) return [];
        const controller = new AbortController();
        const cancel = token.onCancellationRequested(() => controller.abort());
        try {
            const models = this.configuredModels();
            const providers = this.gatewayProviders();
            const catalog = new Map(await Promise.all(providers.map(async provider => [provider, await gatewayModels(provider, this.host.fetch ?? fetch, Date.now(), controller.signal)] as const)));
            if (token.isCancellationRequested) return [];
            // Configured models follow only a catalog read now (unknown keeps them listed). Catalog-only models are listed
            // from this read, or the last one for the same base URL and token while this one fails (sent only once checked).
            const used = new Map(providers.map(provider => [provider, catalog.get(provider) ?? knownGatewayModels(provider)]));
            const listed = providers.flatMap(provider => gatewayCatalogModels(provider, used.get(provider), models));
            // What the catalog-only rows came from: during an outage, the last catalog, so requests do not re-list each time.
            this.listedCatalogs = new Map(providers.map(provider => [provider, catalogSignature(used.get(provider))]));
            // The Gateway's suggested default counts only from this read: during an outage the configured default stays.
            // The OS plan's locks (Free: Gemini 3.8 Flash only) follow the same catalog as the rows they lock.
            const offered = [...models.filter(model => gatewayModelAvailable(model, catalog.get(model.provider))), ...listed]
                .map(model => withGatewayModelLimits(model, catalog.get(model.provider)));
            return this.rememberModels(withPlanLocks(withCatalogDefault(offered, catalog), used)).map(toInformation);
        } finally { cancel.dispose(); }
    }

    /**
     * A configured model, or a catalog-only one. A catalog-only id names exactly one configured Gateway provider (one
     * account): only that provider's catalog is read (the five-minute cache, else a request), and only its credential
     * is ever used. A catalog that cannot be read now is not checked: the last read only lists (contract §4), so the
     * model is not sent. Token counts (`known`), which send nothing, take the last read first. Anything that does not
     * resolve to that one provider fails closed, never to another provider's model of the same alias.
     */
    private async resolve(model: vscode.LanguageModelChatInformation, signal?: AbortSignal, known = false): Promise<ResolvedModel> {
        const models = this.configuredModels();
        const found = models.find(candidate => candidate.id === model.id);
        if (found) return found;
        const id = parseCatalogModelId(model.id);
        const named = id ? this.gatewayProviders().filter(provider => provider.name === id.providerName) : [];
        let catalog: GatewayModels | undefined;
        if (named.length === 1) {
            const provider = named[0]!;
            signal?.throwIfAborted();
            const read = () => gatewayModels(provider, this.host.fetch ?? fetch, Date.now(), signal);
            catalog = known ? knownGatewayModels(provider) ?? await read() : await read();
            const listed = gatewayCatalogModels(provider, catalog, models).find(candidate => candidate.id === model.id);
            if (listed) return listed;
        }
        const error = this.host.configError();
        if (error) throw new ProviderError(`EZiL Models: the config could not be loaded. ${error}`);
        if (named.length !== 1) throw new ProviderError(`EZiL Models: model "${model.id}" is no longer in the config file. Pick another model.`);
        // Never another model in its place (contract §2 rule 3). Unknown is not unavailable.
        if (!catalog) throw new GatewayError('EZiL AI: Could not load the model list, so this model cannot be checked right now. Nothing was sent or charged. Try again.', undefined, 'catalog_unavailable', undefined, undefined, 'local');
        throw new GatewayError('EZiL AI: This model is not available right now. Pick another model. Nothing was sent or charged.', undefined, 'model_unavailable', undefined, undefined, 'local');
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        let finish!: () => void;
        const finished = new Promise<void>(resolve => { finish = resolve; });
        try {
            await this.respond(model, messages, options, progress, token, finished);
        } catch (error) {
            throw withoutStack(error);
        } finally { finish(); }
    }

    private async respond(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        finished: Promise<void>,
    ): Promise<void> {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        const started = Date.now();
        let resolved: ResolvedModel | undefined;
        let chatStarted = false;
        let terminalOutcome = false;
        const onOutcome = (record: AppFailure) => {
            if (record.outcome === 'failed' || record.outcome === 'cancelled') terminalOutcome = true;
            try { this.host.appFailure?.(record); } catch { /* Optional observer. */ }
        };
        try {
            resolved = await this.resolve(model, controller.signal);
            controller.signal.throwIfAborted();
            if (resolved.provider.type === 'ezil-gateway' && resolved.gatewayProtocol !== 'openai-responses' && isUtilityRequest(options.modelOptions ?? {})) {
                // Qwen on the selected model's own provider (account) only, and only when the account's plan includes it
                // (on Free the selected Flash serves titles and summaries); otherwise the selected model serves it.
                const selected = resolved;
                const plan = await gatewayModels(selected.provider, this.host.fetch ?? fetch, Date.now(), controller.signal);
                if (modelIncluded(plan ?? knownGatewayModels(selected.provider), QWEN)) {
                    resolved = this.configuredModels().find(candidate => candidate.provider.type === 'ezil-gateway' && candidate.providerName === selected.providerName
                        && candidate.gatewayProtocol !== 'openai-responses' && candidate.model === QWEN) ?? resolved;
                }
            }
            const request = toNeutralRequest(messages, options);
            // The signed-thinking fallback is for the EZiL Gateway only: its transport sends just its own Bearer credential
            // (custom headers are ignored), which continuationKey covers. A direct provider may authenticate through custom
            // header overrides, so it keeps its reviewed behaviour: no fallback.
            const fallback = !thinkingCtor() && resolved.provider.type === 'ezil-gateway';
            if (fallback) this.restoreSignedThinking(resolved, request);
            // The history this turn answers, for the fallback's key (fixed before anything below can change the request).
            const answered = request.messages.slice();
            const Thinking = thinkingCtor();
            let emittedText = false;
            // Completed signed/redacted thinking of this turn, kept only when the ThinkingPart API is missing.
            const signed: Part[] = [];
            const calls: { callId: string; name: string; input: unknown }[] = [];
            let completed = false;
            if (resolved.provider.type === 'ezil-gateway') {
                // Resolve again for each turn: cached limits may have expired or been invalidated by a refusal.
                const catalog = await gatewayModels(resolved.provider, this.host.fetch ?? fetch, Date.now(), controller.signal);
                controller.signal.throwIfAborted();
                if (!gatewayModelAvailable(resolved, catalog)) {
                    throw new GatewayError('EZiL AI: This model is not available right now.', undefined, 'model_disabled', undefined, undefined, 'local');
                }
                // Not in the account's OS plan (Free: Gemini 3.8 Flash only): refused here, so nothing is sent, held or
                // charged. No billing dialog either: a saved pick, an agent's or subagent's model choice or a stale
                // picker reaches this, and only a pick in the picker offers the upgrade (lockedModelChosen).
                const plan = catalog ?? knownGatewayModels(resolved.provider);
                if (!modelIncluded(plan, resolved.model)) {
                    throw new GatewayError(`EZiL AI: ${resolved.name} is not included in your plan. Nothing was sent or charged. Pick ${includedModelNames(plan)}, `
                        + 'or upgrade in Settings → Billing.', undefined, 'os_model_not_included', undefined, undefined, 'local');
                }
                resolved = withGatewayModelLimits(resolved, catalog);
                // Never send tools to a model without tool calling: leave them out, as Copilot 0.69 does for its own
                // endpoints without tool calls (interceptBody), and earlier tool calls go as text. A picker entry from
                // before the catalog took tool calling away is listed again.
                if (request.tools.length && !resolved.capabilities.toolCalling) {
                    request.tools = [];
                    if ((model.capabilities as { toolCalling?: unknown } | undefined)?.toolCalling) this.refresh();
                }
            }
            const sending = resolved;
            const events = chat(resolved, request, {
                signal: controller.signal,
                fetch: this.host.fetch,
                gateway: {
                    onCompact: info => this.host.compacted?.(sending, info, finished),
                    onOutcome,
                },
                log: line => this.host.log(redact(line, this.host.secrets())),
                onRequest: (url, body) => {
                    if (sending.provider.type === 'ezil-gateway') return;
                    this.host.log(`[request] ${sending.id} -> ${redact(url, this.host.secrets())} messages=${request.messages.length} tools=${request.tools.length} toolMode=${request.toolMode}${options.modelOptions?.requestInitiator ? ` initiator=${String(options.modelOptions.requestInitiator)}` : ''}`);
                    if (this.host.logRequests()) this.host.log(requestForLog(body, this.host.secrets()));
                },
            });
            chatStarted = true;
            for await (const event of events) {
                if (token.isCancellationRequested) break;
                switch (event.type) {
                    case 'text':
                        emittedText = true;
                        progress.report(new vscode.LanguageModelTextPart(event.value));
                        break;
                    case 'tool_call':
                        calls.push({ callId: event.callId, name: event.name, input: event.input });
                        progress.report(new vscode.LanguageModelToolCallPart(event.callId, event.name, (typeof event.input === 'object' && event.input !== null ? event.input : {}) as object));
                        break;
                    case 'thinking':
                        if (Thinking) progress.report(new Thinking(event.value, event.id, event.metadata) as vscode.LanguageModelResponsePart);
                        else if (typeof event.metadata?.redactedData === 'string'
                            || (typeof event.metadata?._completeThinking === 'string' && typeof event.metadata?.signature === 'string' && event.metadata.signature)) {
                            signed.push({ type: 'thinking', value: '', metadata: event.metadata });
                        }
                        break;
                    case 'usage':
                        this.host.recordUsage(resolved, event.usage, Date.now() - started);
                        break;
                    case 'stop':
                        completed = true;
                        if (event.reason === 'refusal') {
                            const details = event.details as { category?: string; explanation?: string } | undefined;
                            const requestId = (event.details as { requestId?: string } | undefined)?.requestId;
                            const message = `The model declined this request${details?.category ? ` (${details.category})` : ''}.${details?.explanation ? ` ${details.explanation}` : ''}${requestId ? ` (request ${requestId})` : ''}`;
                            if (emittedText) progress.report(new vscode.LanguageModelTextPart(`\n\n_${message}_`));
                            else throw new ProviderError(`EZiL Models: ${message}`);
                        } else if (event.reason === 'max_tokens' || event.reason === 'length') {
                            if (resolved.provider.type === 'ezil-gateway') break;
                            this.host.log(`[warn] ${resolved.id}: output truncated at maxOutputTokens=${resolved.maxOutputTokens}`);
                        }
                        break;
                }
            }
            // Only a turn that completed (not cancelled or cut off) and ended in tool calls is kept for its continuation.
            if (fallback && completed && signed.length && calls.length && !token.isCancellationRequested) {
                this.storeSignedThinking(resolved, answered, calls, signed);
            }
        } catch (error) {
            const known = this.modelIdentities.get(model.id);
            const catalogId = parseCatalogModelId(model.id);
            const gateway = resolved ? resolved.provider.type === 'ezil-gateway'
                : known ? known.type === 'ezil-gateway' : catalogId !== undefined;
            // Before chat there are no request IDs. Once chat starts, its own terminal outcome owns the turn.
            if (gateway && !chatStarted && !terminalOutcome) onOutcome(appFailure({
                outcome: controller.signal.aborted ? 'cancelled' : 'failed', cancellationSource: 'caller',
                error: error instanceof GatewayError ? error : undefined,
                stage: 'admission', model: resolved?.model ?? known?.model ?? catalogId?.alias ?? '',
                attempts: 0, durationMs: Date.now() - started,
            }));
            if (controller.signal.aborted) return;
            // Resolution errors keep their original cause chain; the public boundary clears its stacks.
            if (!resolved && !(error instanceof GatewayError)) throw error;
            // Every message shown to the user or logged is redacted: upstream error bodies and URLs are not trusted
            // to be free of key material (a gateway may echo headers or carry the key in its path).
            const message = redact(error instanceof Error ? error.message : String(error), this.host.secrets());
            if (resolved && resolved.provider.type !== 'ezil-gateway') this.host.log(`[error] ${resolved.id}: ${message}`);
            // Exactly these two codes ask for billing, at most once a minute (in-flight turns or an agent loop that all run
            // out ask once). The OS window opens the upgrade on Free and Add credits on a paid plan; a Code outside one
            // keeps the notice and its link. The turn is not retried: the conversation and input stay as they are.
            if (error instanceof GatewayError && CREDIT_REFUSALS.includes(error.code ?? '') && Date.now() - this.lastCreditWarningAt >= 60_000) {
                this.lastCreditWarningAt = Date.now();
                const link = aiCreditsLink();
                void this.askBilling({ reason: 'credits_exhausted', requestId: error.requestId }).then(opened => opened ? undefined
                    : Promise.resolve(vscode.window.showWarningMessage(message, ...link ? ['Add credits'] : [])).then(choice => {
                        if (choice === 'Add credits' && link) return vscode.env.openExternal(link);
                    })).catch(() => {});
            }
            if (error instanceof GatewayError && ['first_byte_timeout', 'stream_idle_timeout', 'os_unreachable', 'os_ai_unavailable', 'upstream_timeout'].includes(error.code ?? '')) {
                // Do not await a notification: the failed turn must leave Thinking immediately.
                void Promise.resolve(vscode.window.showErrorMessage(message, 'Retry')).then(choice => {
                    if (choice === 'Retry') return vscode.commands.executeCommand('workbench.action.chat.retry');
                }).catch(() => {});
            }
            // The picker still shows what the refusal says is gone or changed: list again from a fresh catalog.
            if (error instanceof GatewayError && CATALOG_REFUSALS.includes(error.code ?? '')) this.refresh();
            if (error instanceof ProviderError) throw new ProviderError(message, error.status, error.retryAfterSeconds, error.upstream && redact(error.upstream, this.host.secrets()));
            throw new Error(message.startsWith('EZiL Models') ? message : `EZiL Models: ${message}`);
        } finally {
            cancellation.dispose();
            if (resolved) this.host.requestFinished?.(resolved);
        }
    }

    /** The host's billing request; false (not taken) when there is none or it fails. Never throws. */
    private async askBilling(intent: BillingIntent): Promise<boolean> {
        try { return (await this.host.billingIntent?.(intent)) === true; } catch { return false; }
    }

    /**
     * A plan-locked model was chosen in the picker (the workbench `picker-locked` patch runs `_ezil-models.lockedModel`
     * instead of selecting it, so the previous model stays selected). The plan is read again first: if it now includes
     * the model (an upgrade just went through), the picker lists it again and nothing opens. Otherwise the OS window
     * opens its upgrade; a Code outside one shows a notice with the Standard link. Nothing is ever sent to a model here.
     */
    async lockedModelChosen(id: unknown): Promise<'listed' | 'asked' | 'ignored'> {
        if (typeof id !== 'string') return 'ignored';
        const configured = this.configuredModels().find(model => model.id === id);
        const catalogId = configured ? undefined : parseCatalogModelId(id);
        const provider = configured?.provider ?? this.gatewayProviders().find(candidate => candidate.name === catalogId?.providerName);
        const alias = configured?.model ?? catalogId?.alias;
        if (!provider || provider.type !== 'ezil-gateway' || !alias) return 'ignored';
        const fresh = await gatewayModels(provider, this.host.fetch ?? fetch, Date.now(), undefined, true);
        if (modelIncluded(fresh ?? knownGatewayModels(provider), alias)) {
            this.refresh();
            return 'listed';
        }
        if (!await this.askBilling({ reason: 'model_locked', model: alias })) {
            const link = osBillingLink('upgrade=standard');
            const name = configured?.name ?? (fresh ?? knownGatewayModels(provider))?.data.find(row => row.id === alias)?.name ?? alias;
            void Promise.resolve(vscode.window.showInformationMessage(`${name} is not included in your plan.`, ...link ? ['Upgrade'] : []))
                .then(choice => { if (choice === 'Upgrade' && link) return vscode.env.openExternal(link); }).catch(() => {});
        }
        return 'asked';
    }

    async provideTokenCount(_model: vscode.LanguageModelChatInformation, value: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
        const resolved = await this.resolve(_model, undefined, true);
        if (resolved.provider.type === 'ezil-gateway') return gatewayTokenCount(typeof value === 'string' ? value : toNeutralMessage(value), resolved.gatewayProtocol);
        if (typeof value === 'string') return estimateTextTokens(value);
        return estimateMessageTokens(toNeutralMessage(value));
    }
}
