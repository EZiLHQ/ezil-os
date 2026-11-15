import type { InferenceDiagnostic } from './inference-diagnostics';
export function validateInferenceTrace(value: unknown, maxBytes?: number): InferenceDiagnostic | null;
