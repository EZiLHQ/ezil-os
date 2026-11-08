// The VS Code LanguageModelChatProvider. Bridges VS Code's LanguageModel* classes to the neutral
// shapes in types.ts, streams the provider response back as VS Code parts, and records usage.

import * as vscode from 'vscode';
import type { CompactionInfo } from './compact';
import { appFailure, type AppFailure } from './failure';
import { CATALOG_REFUSALS, GatewayError, gatewayCatalogModels, gatewayModelAvailable, gatewayModels, knownGatewayModels, parseCatalogModelId, withCatalogDefault, withGatewayModelLimits, type GatewayModels } from './gateway';
import { gatewayInputTokens, gatewayOutputTokens, gatewayTokenCount, QWEN } from './gateway-messages';
import { chat, ProviderError } from './client';
import { redact, type ResolvedModel, type ResolvedProvider } from './config';
import { estimateMessageTokens, estimateTextTokens } from './tokens';
import { isCacheMarker, isStatefulMarker, type ChatRequest, type Message, type Part, type Role, type Tool, type Usage } from './types';
import { createHash } from 'node:crypto';

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
    fetch?: typeof fetch;
};

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
 * The identity of one turn's continuation, for the signed-thinking fallback: the resolved provider and model, the
 * exact history the turn answered (thinking and cache/stateful markers left out, as Copilot rebuilds them), and the
 * turn's ordered tool calls with their full inputs. A hash: nothing of it is kept or logged as text.
 */
function continuationKey(model: ResolvedModel, history: readonly Message[], calls: readonly { callId: string; name: string; input: unknown }[]): string {
    const turns = history.map(message => [message.role, message.parts
        .filter(part => part.type !== 'thinking' && !isCacheMarker(part) && !isStatefulMarker(part)).map(canonicalPart)]);
    return createHash('sha256').update(JSON.stringify([model.providerName, model.model, turns,
        calls.map(call => [call.callId, call.name, stableJson(call.input)])])).digest('hex');
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
    info.isUserSelectable = true;
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
    try {
        const url = new URL(process.env.EZIL_AI_BASE_URL ?? '');
        // `reason` makes the OS open its Add AI credits dialog as exhaustion recovery (with an upgrade when one exists).
        if (url.protocol === 'https:') return vscode.Uri.parse(`${url.origin}/os?settings=billing&section=ai-credits&reason=insufficient_credits`);
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
     * Bounded; lost on reload, when the request goes without them as before.
     */
    private signedThinking = new Map<string, Part[]>();
    readonly onDidChangeLanguageModelChatInformation = this.changed.event;

    constructor(private readonly host: ProviderHost) {}

    refresh(): void { this.changed.fire(); }
    dispose(): void { this.changed.dispose(); this.modelIdentities.clear(); this.signedThinking.clear(); }

    private rememberSignedThinking(key: string, parts: readonly Part[]): void {
        this.signedThinking.delete(key);
        this.signedThinking.set(key, [...parts]);
        while (this.signedThinking.size > 64) this.signedThinking.delete(this.signedThinking.keys().next().value!);
    }

    /** Re-attach kept signed thinking to an assistant message only when it exactly continues the turn that produced it. */
    private restoreSignedThinking(model: ResolvedModel, request: ChatRequest): void {
        request.messages.forEach((message, index) => {
            if (message.role !== 'assistant' || message.parts.some(part => part.type === 'thinking')) return;
            const calls = message.parts.flatMap(part => part.type === 'tool_call' ? [{ callId: part.callId, name: part.name, input: part.input }] : []);
            if (!calls.length) return;
            const kept = this.signedThinking.get(continuationKey(model, request.messages.slice(0, index), calls));
            if (kept) message.parts = [...kept, ...message.parts];
        });
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
            const offered = [...models.filter(model => gatewayModelAvailable(model, catalog.get(model.provider))), ...listed]
                .map(model => withGatewayModelLimits(model, catalog.get(model.provider)));
            return this.rememberModels(withCatalogDefault(offered, catalog)).map(toInformation);
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
                // Qwen on the selected model's own provider (account) only; without one, the selected model serves it.
                const selected = resolved;
                resolved = this.configuredModels().find(candidate => candidate.provider.type === 'ezil-gateway' && candidate.providerName === selected.providerName
                    && candidate.gatewayProtocol !== 'openai-responses' && candidate.model === QWEN) ?? resolved;
            }
            const request = toNeutralRequest(messages, options);
            if (!thinkingCtor()) this.restoreSignedThinking(resolved, request);
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
            if (!Thinking && completed && signed.length && calls.length && !token.isCancellationRequested) {
                this.rememberSignedThinking(continuationKey(resolved, answered, calls), signed);
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
            if (error instanceof GatewayError && ['insufficient_credits', 'no_live_grant'].includes(error.code ?? '') && Date.now() - this.lastCreditWarningAt >= 60_000) {
                this.lastCreditWarningAt = Date.now();
                const link = aiCreditsLink();
                void Promise.resolve(vscode.window.showWarningMessage(message, ...link ? ['Add credits'] : [])).then(choice => {
                    if (choice === 'Add credits' && link) return vscode.env.openExternal(link);
                }).catch(() => {});
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

    async provideTokenCount(_model: vscode.LanguageModelChatInformation, value: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
        const resolved = await this.resolve(_model, undefined, true);
        if (resolved.provider.type === 'ezil-gateway') return gatewayTokenCount(typeof value === 'string' ? value : toNeutralMessage(value), resolved.gatewayProtocol);
        if (typeof value === 'string') return estimateTextTokens(value);
        return estimateMessageTokens(toNeutralMessage(value));
    }
}
