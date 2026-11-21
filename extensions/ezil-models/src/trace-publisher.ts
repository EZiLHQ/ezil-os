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
export function publishInferenceTrace(
    record: unknown,
    execute: (command: string, record: InferenceDiagnostic, assignmentChatRequestId?: string) => unknown,
    assignmentChatRequestId?: string,
): void {
    try {
        const clean = prepareInferenceTrace(record);
        if (!clean) return;
        // The operational trace stays on its existing version. The renderer
        // can publish a separate, consent-gated link for this optional ID.
        const valid = assignmentChatRequestId
            && /^request_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(assignmentChatRequestId)?.[0] === assignmentChatRequestId;
        const delivery = valid ? execute(TRACE_COMMAND, clean, assignmentChatRequestId) : execute(TRACE_COMMAND, clean);
        void Promise.resolve(delivery).catch(() => {});
    } catch { /* Optional operational observer. */ }
}
