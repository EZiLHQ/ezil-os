import { z } from 'zod';

/** What a Catch records at `$.ctl.lastError`. `none` marks a clean task. */
export const RecordedErrorSchema = z.object({ Error: z.string().max(512), Cause: z.string().max(32768) }).strict();
export type RecordedError = z.infer<typeof RecordedErrorSchema>;
export const NO_ERROR: RecordedError = { Error: 'none', Cause: 'none' };

/** C-3: capacity and quota errors fail fast with their code. Each is a
 * definite refusal; EC2 created nothing for that request. */
export const CAPACITY_CODES = ['InsufficientInstanceCapacity', 'VcpuLimitExceeded', 'InstanceLimitExceeded',
    'InsufficientVolumeCapacity', 'VolumeLimitExceeded', 'MaxIOPSLimitExceeded'] as const;
/** Throttling is a definite rejection with no effect, so the same request may
 * be issued again after a bounded backoff. */
export const THROTTLE_CODES = ['RequestLimitExceeded', 'ThrottlingException', 'Throttling'] as const;
export const MAX_THROTTLE_RETRIES = 5;

// Step Functions names SDK errors `Ec2.<Code>Exception`, but EC2 errors that
// are not modelled can surface as a generic name with the code or the provider
// message only in Cause. Match on both; staging must confirm the real shape.
const capacityMessages = [/\bsufficient \S+ capacity/i, /vcpu (capacity|limit)/i];
const throttleMessages = [/request limit exceeded/i, /rate exceeded/i];

/** The request may or may not have taken effect: only observation can tell. */
const uncertainNames = new Set(['States.Timeout', 'States.HeartbeatTimeout']);
const uncertainText = [/InternalError/, /ServiceUnavailable/, /\bUnavailable\b/, /Status Code: 5\d\d/];

export type ProviderErrorClass = { kind: 'none' } | { kind: 'capacity'; code: string } | { kind: 'throttled' }
    | { kind: 'uncertain' } | { kind: 'failed'; code: string };
/** The code a terminal records for a definite provider rejection. */
export function errorCode(e: RecordedError): string {
    return `${e.Error}: ${e.Cause}`.slice(0, 512);
}
export function classifyProviderError(e: RecordedError): ProviderErrorClass {
    if (e.Error === NO_ERROR.Error && e.Cause === NO_ERROR.Cause) return { kind: 'none' };
    const text = `${e.Error}\n${e.Cause}`;
    for (const code of CAPACITY_CODES) if (text.includes(code)) return { kind: 'capacity', code };
    if (capacityMessages.some(r => r.test(text))) return { kind: 'capacity', code: 'InsufficientCapacity' };
    if (THROTTLE_CODES.some(code => text.includes(code)) || throttleMessages.some(r => r.test(text))) return { kind: 'throttled' };
    if (uncertainNames.has(e.Error) || uncertainText.some(r => r.test(text))) return { kind: 'uncertain' };
    // A definite rejection (UnauthorizedOperation, IncorrectInstanceState, ...)
    // fails fast with its code instead of waiting for the deadline.
    return { kind: 'failed', code: errorCode(e) };
}
/** Bounded exponential backoff with full jitter, in whole seconds. */
export function throttleDelaySeconds(attempt: number, random = Math.random): number {
    const ceiling = Math.min(60, 4 * 2 ** Math.max(0, attempt));
    return Math.max(2, Math.ceil(ceiling * random()));
}

/** Lambda reports `error.name` as the Step Functions error. The observation
 * Retry matches only RETRYABLE_ERROR; every other code is recorded and fails. */
export const RETRYABLE_ERROR = 'LifecycleRetryable';
export class LifecycleFailure extends Error {
    constructor(readonly code: string, name = 'LifecycleFailure') { super(code); this.name = name; }
}
const transientNames = new Set(['ThrottlingException', 'Throttling', 'RequestLimitExceeded', 'TooManyRequestsException',
    'TimeoutError', 'AbortError', 'RequestTimeout', 'RequestTimeoutException', 'ServiceUnavailable', 'InternalError',
    'InternalFailure', 'ServiceException']);
/** Read-side failures that say nothing about provider state. */
export function isTransient(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const e = error as Error & { $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
    if (e.message === 'authority_unavailable') return true;
    if (e.$retryable) return true;
    if ((e.$metadata?.httpStatusCode ?? 0) >= 500) return true;
    return transientNames.has(e.name);
}
/** Lambda entry wrapper: preserves the failure code instead of collapsing it. */
export function toLambdaError(error: unknown, fallback: string): LifecycleFailure {
    if (isTransient(error)) return new LifecycleFailure('lifecycle_unavailable', RETRYABLE_ERROR);
    const message = error instanceof Error ? error.message : '';
    return new LifecycleFailure(/^lifecycle_[a-z_]{1,60}$/.test(message) ? message : fallback);
}
