import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { readBroker, readModelCatalog, type BrokerModel, type ModelBrokerDescriptor } from './broker';
import { brokerError } from './broker-errors';

const OUTPUT_LIMIT = 8192;
type Emit = (part: vscode.LanguageModelResponsePart) => void;

function textContent(message: vscode.LanguageModelChatRequestMessage): string {
    const parts: string[] = [];
    for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) parts.push(part.value);
        else throw new Error('EZiL currently accepts text messages only.');
    }
    return parts.join('');
}

export function requestBody(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, allowance?: BrokerModel): object {
    if (options.tools?.length) throw new Error('This configured EZiL provider does not advertise tool calling.');
    const requested = options.modelOptions?.maxTokens;
    if (requested !== undefined && (!Number.isInteger(requested) || requested < (allowance?.minOutputTokens ?? (model.version === 'ezil-gateway' ? 16 : 1)))) throw brokerError('request_invalid');
    const maxTokens = requested !== undefined ? Math.min(requested, model.maxOutputTokens, OUTPUT_LIMIT) : Math.min(model.maxOutputTokens, allowance?.defaultOutputTokens ?? 4096);
    return {
        model: model.id,
        messages: messages.map(message => {
            if (message.role !== vscode.LanguageModelChatMessageRole.User && message.role !== vscode.LanguageModelChatMessageRole.Assistant) throw new Error('Unsupported chat role.');
            return { role: message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant', content: textContent(message) };
        }),
        maxTokens,
    };
}

function crc32(value: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of value) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function bedrockEvent(frame: Buffer): { type?: string; payload: unknown } {
    if (frame.length < 16 || frame.readUInt32BE(0) !== frame.length) throw new Error('Invalid Bedrock event stream frame.');
    const headerBytes = frame.readUInt32BE(4);
    if (headerBytes > frame.length - 16 || frame.readUInt32BE(8) !== crc32(frame.subarray(0, 8)) || frame.readUInt32BE(frame.length - 4) !== crc32(frame.subarray(0, -4))) throw new Error('Invalid Bedrock event stream checksum.');
    let offset = 12; const end = offset + headerBytes; let type: string | undefined;
    while (offset < end) {
        const nameBytes = frame[offset++];
        if (!nameBytes || offset + nameBytes + 1 > end) throw new Error('Invalid Bedrock event stream headers.');
        const name = frame.subarray(offset, offset + nameBytes).toString('utf8'); offset += nameBytes;
        const valueType = frame[offset++];
        if (valueType === undefined) throw new Error('Invalid Bedrock event stream headers.');
        if (valueType === 0 || valueType === 1) continue;
        const widths: Record<number, number> = { 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };
        if (valueType === 6 || valueType === 7) {
            if (offset + 2 > end) throw new Error('Invalid Bedrock event stream headers.');
            const length = frame.readUInt16BE(offset); offset += 2;
            if (offset + length > end) throw new Error('Invalid Bedrock event stream headers.');
            if (name === ':event-type' && valueType === 7) type = frame.subarray(offset, offset + length).toString('utf8');
            offset += length;
        } else {
            const width = widths[valueType]; if (!width || offset + width > end) throw new Error('Invalid Bedrock event stream headers.'); offset += width;
        }
    }
    if (offset !== end) throw new Error('Invalid Bedrock event stream headers.');
    const raw = frame.subarray(end, frame.length - 4).toString('utf8');
    return { type, payload: raw ? JSON.parse(raw) : {} };
}

async function consumeSSE(body: ReadableStream<Uint8Array>, emit: Emit, requireDone: boolean): Promise<void> {
    const reader = body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '', terminal = false, bytes = 0;
    try { while (true) {
        const { done, value } = await reader.read(); buffer = (buffer + decoder.decode(value, { stream: !done })).replaceAll('\r\n', '\n');
        bytes += value?.byteLength || 0;
        if (bytes > 8 * 1024 * 1024) throw brokerError('stream_invalid');
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, split); buffer = buffer.slice(split + 2);
            if (event.length > 1024 * 1024) throw brokerError('stream_invalid');
            const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            if (!data) continue;
            if (terminal && requireDone) throw brokerError('stream_invalid');
            if (data === '[DONE]') { terminal = true; continue; }
            let value; try { value = JSON.parse(data); } catch { throw brokerError('stream_invalid'); }
            if (value?.error) throw brokerError(value.error.code);
            const text = value?.choices?.[0]?.delta?.content;
            if (typeof text === 'string' && text) emit(new vscode.LanguageModelTextPart(text));
        }
        if (buffer.length > 1024 * 1024) throw brokerError('stream_invalid');
        if (done) break;
    }
    if ((buffer.trim() && (requireDone || buffer.trim() !== 'data: [DONE]')) || (requireDone && !terminal)) throw brokerError('stream_invalid');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function consumeBedrock(body: ReadableStream<Uint8Array>, emit: Emit): Promise<void> {
    const reader = body.getReader(); let buffer = Buffer.alloc(0);
    while (true) {
        const { done, value } = await reader.read(); if (value) buffer = Buffer.concat([buffer, Buffer.from(value)]);
        while (buffer.length >= 4) {
            const length = buffer.readUInt32BE(0);
            if (length < 16 || length > 1024 * 1024) throw new Error('Invalid Bedrock event stream frame.');
            if (buffer.length < length) break;
            const event = bedrockEvent(buffer.subarray(0, length)); buffer = buffer.subarray(length);
            if (event.type?.endsWith('Exception')) throw new Error('Bedrock response failed.');
            if (event.type === 'contentBlockDelta') {
                const text = (event.payload as { delta?: { text?: unknown } })?.delta?.text;
                if (typeof text === 'string' && text) emit(new vscode.LanguageModelTextPart(text));
            }
        }
        if (done) break;
    }
    if (buffer.length) throw new Error('Incomplete Bedrock response stream.');
}

export async function streamChat(descriptor: ModelBrokerDescriptor, body: object, emit: Emit, token: vscode.CancellationToken): Promise<void> {
    const controller = new AbortController();
    // One key for this logical invocation; no automatic retries at any layer.
    const idempotencyKey = randomUUID();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
        const response = await fetch(`${descriptor.url}/v1/chat`, {
            method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { authorization: `Bearer ${descriptor.capability}`, 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(body),
        });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw brokerError(response.headers.get('x-ezil-error'), response.headers.get('retry-after')); }
        const type = response.headers.get('content-type')?.split(';', 1)[0];
        if (type === 'text/event-stream') await consumeSSE(response.body, emit, response.headers.get('x-ezil-stream') === 'responses-v1');
        else if (type === 'application/vnd.amazon.eventstream') await consumeBedrock(response.body, emit);
        else throw new Error('Unsupported provider response format.');
    } finally { controller.abort(); cancellation.dispose(); }
}

export class EZiLModelProvider implements vscode.LanguageModelChatProvider {
    private catalog = new Map<string, BrokerModel>();
    constructor(private readonly descriptorPath: () => string | undefined, private readonly folders: () => readonly string[]) {}
    private descriptor(): ModelBrokerDescriptor {
        const value = readBroker(this.descriptorPath(), this.folders());
        if (!('url' in value)) throw new Error('EZiL model broker is unavailable.');
        return value;
    }
    async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
        if (token.isCancellationRequested) return [];
        const models = await readModelCatalog(this.descriptor());
        this.catalog = new Map(models.map(model => [model.id, model]));
        return models.map(model => ({ id: model.id, name: model.id, family: model.id, version: model.gateway ? 'ezil-gateway' : 'configured', maxInputTokens: model.maxInputTokens, maxOutputTokens: model.maxOutputTokens, capabilities: { imageInput: false, toolCalling: false } }));
    }
    async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
        await streamChat(this.descriptor(), requestBody(model, messages, options, this.catalog.get(model.id)), part => progress.report(part), token);
    }
    async provideTokenCount(_model: vscode.LanguageModelChatInformation, value: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
        const text = typeof value === 'string' ? value : textContent(value);
        return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
    }
}
