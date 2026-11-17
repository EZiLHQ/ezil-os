import { validateInferenceTrace } from './contract.js';
import type { InferenceTrace } from './types';
export { validateInferenceTrace };
export const LIMITS = Object.freeze({ bodyBytes: 32_768, traceBytes: 4096, batch: 8, perMinute: 120, retentionDays: 7, purgeBatch: 1000, purgeBatches: 10 });
export function parseBatch(value: unknown): InferenceTrace[] | null {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== 2
        || !Object.hasOwn(value, 'v') || !Object.hasOwn(value, 'traces')) return null;
    const batch = value as { v: unknown; traces: unknown };
    if (batch.v !== 1 || !Array.isArray(batch.traces) || !batch.traces.length || batch.traces.length > LIMITS.batch) return null;
    const traces: InferenceTrace[] = [];
    for (const trace of batch.traces) {
        if (new TextEncoder().encode(JSON.stringify(trace)).byteLength > LIMITS.traceBytes) return null;
        const clean = validateInferenceTrace(trace);
        if (!clean) return null;
        if (!traces.some(r => r.requestId === clean.requestId)) traces.push(clean);
    }
    return traces;
}
