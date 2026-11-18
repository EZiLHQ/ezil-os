import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ChatRequest, StreamEvent, Usage } from './types';
import { estimateMessageTokens } from './tokens';

export const INFERENCE_CONTRACT = 'ezil.inference.v1' as const;
export const AGGREGATE_CONTRACT = 'ezil.inference.aggregate.v1' as const;
export const ADAPTER_VERSION = '0.1.0+carbon-progress.1';
export type Category = 'read' | 'search' | 'write' | 'other';
const counts = () => ({ read: 0, search: 0, write: 0, other: 0 });
export function toolCategory(name: string): Category {
    if (/^(read_file|list_dir|list_directory|open_file)$/.test(name)) return 'read';
    if (/^(file_search|grep_search|semantic_search|search|search_workspace)$/.test(name)) return 'search';
    if (/^(replace_string_in_file|multi_replace_string_in_file|create_file|edit_file|apply_patch|insert_edit_into_file|delete_file)$/.test(name)) return 'write';
    return 'other';
}
export type ToolObservation = { call: string; category: Category };
export type InferenceDiagnostic = {
    contract: typeof INFERENCE_CONTRACT; adapterVersion: string; requestId: string; turnId: string;
    modelAlias: string; clientRequestId: string | null; gatewayRequestId: string | null;
    conversationId: string | null; toolCalls: ToolObservation[]; observationsTruncated: boolean; toolResults: (ToolObservation & { state: 'error' | 'reported_success' | 'unknown' })[];
    offered: Record<Category, number>; requested: Record<Category, number>;
    results: { matched: number; error: number; reportedSuccess: number; unknown: number; unmatched: number };
    writeRequested: boolean; toolReportedSuccess: boolean; verifiedFileChange: null;
    usage: Usage | null; usageSource: 'provider_reported' | 'unknown'; estimatedInputTokens: number;
    wireBytes: number | null; totalWireBytes: number; attempts: number; compaction: { trigger: string; count: number; folded: number; shortened: number } | null;
    finishReason: string | null; durationMs: number; cancelled: boolean; outcome: 'completed' | 'failed' | 'cancelled';
    thought_signature_replayed: boolean; readHeavyWithoutVerifiedEdit: boolean;
};
const safeId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : null;
const safeAlias = (id: string) => /^[a-zA-Z0-9_.:-]{1,128}$/.test(id) ? id : 'unknown';
/** No content, paths, tool names/arguments, signatures or error strings survive this projection. */
export class InferenceTrace {
    readonly record: InferenceDiagnostic;
    private readonly started = Date.now();
    private readonly identify: (call: string) => string;
    constructor(alias: string, request: ChatRequest, correlation?: { conversationId: string | null; identifyCall: (call: string) => string }) {
        const secret = randomBytes(32);
        this.identify = correlation?.identifyCall ?? (call => createHmac('sha256', secret).update(call).digest('hex'));
        const toolResults: InferenceDiagnostic['toolResults'] = [];
        const offered = counts();
        for (const tool of request.tools) offered[toolCategory(tool.name)]++;
        const results = { matched: 0, error: 0, reportedSuccess: 0, unknown: 0, unmatched: 0 };
        const pending = new Map<string, Category>();
        let writeSuccess = false;
        // Only the latest result turn: older results must not be counted on every inference.
        let latestAssistant = -1;
        request.messages.forEach((message, i) => { if (message.role === 'assistant') latestAssistant = i; });
        let firstAssistant = latestAssistant;
        while (firstAssistant > 0 && request.messages[firstAssistant - 1]!.role !== 'user') firstAssistant--;
        for (const message of request.messages.slice(Math.max(0, firstAssistant), latestAssistant + 1)) for (const part of message.parts)
            if (message.role === 'assistant' && part.type === 'tool_call') pending.set(part.callId, toolCategory(part.name));
        for (const message of request.messages.slice(latestAssistant + 1)) for (const part of message.parts) {
            if (part.type !== 'tool_result') continue;
            const category = pending.get(part.callId);
            if (!category) { results.unmatched++; continue; }
            pending.delete(part.callId); results.matched++;
            if (toolResults.length < 128) toolResults.push({ call: this.identify(part.callId), category,
                state: part.isError === true ? 'error' : part.isError === false ? 'reported_success' : 'unknown' });
            if (part.isError === true) results.error++;
            else if (part.isError === false) { results.reportedSuccess++; if (category === 'write') writeSuccess = true; }
            else results.unknown++;
        }
        this.record = { contract: INFERENCE_CONTRACT, adapterVersion: ADAPTER_VERSION, requestId: randomUUID(), turnId: randomUUID(),
            conversationId: correlation?.conversationId ?? null, toolCalls: [], observationsTruncated: results.matched > 128, toolResults,
            modelAlias: safeAlias(alias), clientRequestId: null, gatewayRequestId: null, offered, requested: counts(), results,
            writeRequested: false, toolReportedSuccess: writeSuccess, verifiedFileChange: null, usage: null, usageSource: 'unknown',
            estimatedInputTokens: request.messages.reduce((n, message) => n + estimateMessageTokens(message), 0),
            wireBytes: null, totalWireBytes: 0, attempts: 0, compaction: null, finishReason: null, durationMs: 0, cancelled: false, outcome: 'failed',
            thought_signature_replayed: false, readHeavyWithoutVerifiedEdit: false };
    }
    event(event: StreamEvent): void {
        if (event.type === 'tool_call') {
            const category = toolCategory(event.name); this.record.requested[category]++;
            if (this.record.toolCalls.length < 128) this.record.toolCalls.push({ call: this.identify(event.callId), category });
            if (this.record.requested.read + this.record.requested.search + this.record.requested.write + this.record.requested.other > 128) this.record.observationsTruncated = true;
            if (category === 'write') this.record.writeRequested = true;
        }
        if (event.type === 'usage') {
            const u = event.usage;
            this.record.usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens,
                cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens,
                inputIncludesCache: u.inputIncludesCache, reasoningTokens: u.reasoningTokens };
            this.record.usageSource = 'provider_reported';
        }
        if (event.type === 'stop') this.record.finishReason = ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal', 'stop', 'length', 'completed', 'failed', 'incomplete'].includes(event.reason ?? '') ? event.reason! : null;
    }
    transport(value: { clientRequestId?: string; gatewayRequestId?: string; wireBytes: number | null; totalWireBytes: number; offered: Record<Category, number>; attempts: number; replayed: boolean }): void {
        this.record.clientRequestId = safeId(value.clientRequestId); this.record.gatewayRequestId = safeId(value.gatewayRequestId);
        this.record.wireBytes = value.wireBytes; this.record.totalWireBytes = value.totalWireBytes; this.record.offered = { ...value.offered }; this.record.attempts = value.attempts; this.record.thought_signature_replayed = value.replayed;
    }
    finish(cancelled: boolean, failed: boolean): InferenceDiagnostic {
        this.record.cancelled = cancelled; this.record.outcome = cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
        this.record.durationMs = Math.max(0, Date.now() - this.started);
        this.record.readHeavyWithoutVerifiedEdit = this.record.requested.read + this.record.requested.search > 0 && !this.record.writeRequested;
        return structuredClone(this.record);
    }
}
/** Bounded memory-only local trace; the collector may read a snapshot, never conversation content. */
export class InferenceRing {
    private records: InferenceDiagnostic[] = [];
    add(record: InferenceDiagnostic): void { this.records.push(structuredClone(record)); if (this.records.length > 128) this.records.shift(); }
    snapshot(): InferenceDiagnostic[] { return structuredClone(this.records); }
}
export function aggregateInference(records: readonly InferenceDiagnostic[]) {
    return { contract: AGGREGATE_CONTRACT, requests: records.length, writesRequested: records.filter(r => r.writeRequested).length,
        toolReportedSuccess: records.filter(r => r.toolReportedSuccess).length, verifiedFileChanges: null,
        cancelled: records.filter(r => r.cancelled).length, readOnlySuspicions: records.filter(r => r.readHeavyWithoutVerifiedEdit).length };
}
