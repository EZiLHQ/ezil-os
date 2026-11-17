import type { InferenceDiagnostic } from './inference-diagnostics';
import { validateInferenceTrace } from './trace-validator.js';
export { validateInferenceTrace } from './trace-validator.js';
export const TRACE_COMMAND = '_ezil.aiRequestTrace';
/** Preserve complete local counts; trim only pseudonymous detail to fit the nonce envelope. */
export function prepareInferenceTrace(record: unknown): InferenceDiagnostic | null {
    const clean = validateInferenceTrace(record, 65536);
    if (!clean) return null;
    const bytes = () => new TextEncoder().encode(JSON.stringify({ type: 'ezil.code.aiTrace', v: 1, nonce: '0'.repeat(22), trace: clean })).byteLength;
    while (bytes() > 4096 && (clean.toolCalls.length || clean.toolResults.length)) {
        (clean.toolCalls.length >= clean.toolResults.length ? clean.toolCalls : clean.toolResults).pop();
        clean.observationsTruncated = true;
    }
    return bytes() <= 4096 ? validateInferenceTrace(clean) : null;
}
/** Neither synchronous throws nor rejected/unsupported older commands can affect inference. */
export function publishInferenceTrace(record: unknown, execute: (command: string, record: InferenceDiagnostic) => unknown): void {
    try {
        const clean = prepareInferenceTrace(record);
        if (clean) void Promise.resolve(execute(TRACE_COMMAND, clean)).catch(() => {});
    } catch { /* Optional operational observer. */ }
}
