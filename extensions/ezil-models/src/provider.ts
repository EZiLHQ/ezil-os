// The VS Code LanguageModelChatProvider. Bridges VS Code's LanguageModel* classes to the neutral
// shapes in types.ts, streams the provider response back as VS Code parts, and records usage.

import * as vscode from 'vscode';
import { chat, ProviderError } from './client';
import { redact, type ResolvedModel } from './config';
import { estimateMessageTokens, estimateTextTokens } from './tokens';
import type { ChatRequest, Message, Part, Role, Tool, Usage } from './types';

/** Role value of the proposed `languageModelSystem` API; guarded numerically so a missing proposal degrades to the value. */
export const SYSTEM_ROLE = 3;

export type ProviderHost = {
    models(): ResolvedModel[];
    configError(): string | undefined;
    secrets(): string[];
    logRequests(): boolean;
    log(line: string): void;
    recordUsage(model: ResolvedModel, usage: Usage, elapsedMs: number): void;
    fetch?: typeof fetch;
};

type AnyPart = Record<string, unknown>;

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
    if (isInstance(part, thinkingCtor()) || (name === 'LanguageModelThinkingPart' && 'value' in record)) {
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
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: { toolCalling: model.capabilities.toolCalling, imageInput: model.capabilities.imageInput },
    };
    // Proposed `chatProvider` fields; harmless extras where the proposal is not enabled.
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

export class EZiLModelsProvider implements vscode.LanguageModelChatProvider {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this.changed.event;

    constructor(private readonly host: ProviderHost) {}

    refresh(): void { this.changed.fire(); }
    dispose(): void { this.changed.dispose(); }

    async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
        if (token.isCancellationRequested) return [];
        return this.host.models().map(toInformation);
    }

    private resolve(model: vscode.LanguageModelChatInformation): ResolvedModel {
        const found = this.host.models().find(candidate => candidate.id === model.id);
        if (found) return found;
        const error = this.host.configError();
        throw new ProviderError(error ? `EZiL Models: the config could not be loaded. ${error}` : `EZiL Models: model "${model.id}" is no longer in the config file. Pick another model.`);
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const resolved = this.resolve(model);
        const request = toNeutralRequest(messages, options);
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        const started = Date.now();
        const Thinking = thinkingCtor();
        let emittedText = false;
        try {
            const events = chat(resolved, request, {
                signal: controller.signal,
                fetch: this.host.fetch,
                onRequest: (url, body) => {
                    this.host.log(`[request] ${resolved.id} -> ${redact(url, this.host.secrets())} messages=${request.messages.length} tools=${request.tools.length} toolMode=${request.toolMode}${options.modelOptions?.requestInitiator ? ` initiator=${String(options.modelOptions.requestInitiator)}` : ''}`);
                    if (this.host.logRequests()) this.host.log(requestForLog(body, this.host.secrets()));
                },
            });
            for await (const event of events) {
                if (token.isCancellationRequested) break;
                switch (event.type) {
                    case 'text':
                        emittedText = true;
                        progress.report(new vscode.LanguageModelTextPart(event.value));
                        break;
                    case 'tool_call':
                        progress.report(new vscode.LanguageModelToolCallPart(event.callId, event.name, (typeof event.input === 'object' && event.input !== null ? event.input : {}) as object));
                        break;
                    case 'thinking':
                        if (Thinking) progress.report(new Thinking(event.value, event.id, event.metadata) as vscode.LanguageModelResponsePart);
                        break;
                    case 'usage':
                        this.host.recordUsage(resolved, event.usage, Date.now() - started);
                        break;
                    case 'stop':
                        if (event.reason === 'refusal') {
                            const details = event.details as { category?: string; explanation?: string } | undefined;
                            const message = `The model declined this request${details?.category ? ` (${details.category})` : ''}.${details?.explanation ? ` ${details.explanation}` : ''}`;
                            if (emittedText) progress.report(new vscode.LanguageModelTextPart(`\n\n_${message}_`));
                            else throw new ProviderError(`EZiL Models: ${message}`);
                        } else if (event.reason === 'max_tokens' || event.reason === 'length') {
                            this.host.log(`[warn] ${resolved.id}: output truncated at maxOutputTokens=${resolved.maxOutputTokens}`);
                        }
                        break;
                }
            }
        } catch (error) {
            if (controller.signal.aborted) return;
            // Every message shown to the user or logged is redacted: upstream error bodies and URLs are not trusted
            // to be free of key material (a gateway may echo headers or carry the key in its path).
            const message = redact(error instanceof Error ? error.message : String(error), this.host.secrets());
            this.host.log(`[error] ${resolved.id}: ${message}`);
            if (error instanceof ProviderError) throw new ProviderError(message, error.status, error.retryAfterSeconds, error.upstream && redact(error.upstream, this.host.secrets()));
            throw new Error(message.startsWith('EZiL Models') ? message : `EZiL Models: ${message}`);
        } finally {
            cancellation.dispose();
        }
    }

    async provideTokenCount(_model: vscode.LanguageModelChatInformation, value: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
        if (typeof value === 'string') return estimateTextTokens(value);
        return estimateMessageTokens(toNeutralMessage(value));
    }
}
