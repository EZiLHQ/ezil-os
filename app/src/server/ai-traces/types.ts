/** Runtime-free wire types; exact parity with the producer is checked by TypeScript. */
export type Counts = { read: number; search: number; write: number; other: number };
export type Category = keyof Counts;
export interface InferenceTrace {
    contract: 'ezil.inference.v1'; adapterVersion: string; requestId: string; turnId: string; modelAlias: string;
    clientRequestId: string | null; gatewayRequestId: string | null; conversationId: string | null;
    toolCalls: { call: string; category: Category }[];
    toolResults: { call: string; category: Category; state: 'error' | 'reported_success' | 'unknown' }[];
    observationsTruncated: boolean; offered: Counts; requested: Counts;
    results: { matched: number; error: number; reportedSuccess: number; unknown: number; unmatched: number };
    writeRequested: boolean; toolReportedSuccess: boolean; verifiedFileChange: null;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; inputIncludesCache?: boolean; reasoningTokens?: number } | null;
    usageSource: 'provider_reported' | 'unknown'; estimatedInputTokens: number; wireBytes: number | null; totalWireBytes: number; attempts: number;
    compaction: { trigger: string; count: number; folded: number; shortened: number } | null;
    finishReason: string | null; durationMs: number; cancelled: boolean; outcome: 'completed' | 'failed' | 'cancelled';
    thought_signature_replayed: boolean; readHeavyWithoutVerifiedEdit: boolean;
}
