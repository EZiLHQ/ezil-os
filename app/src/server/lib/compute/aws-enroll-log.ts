/**
 * One bounded log line per refused host enrollment (`POST /api/compute/aws/enroll`), so a host's
 * retry loop is visible in the app's logs long before `[enroll-timeout]` (aws-receipts.ts) fires.
 *
 * Hosts retry every few seconds (enroll.py): the first refusal per (computer, error) is logged,
 * then at most one line per pair per minute, carrying how many were suppressed in between. The
 * map is bounded (the least recently logged pair is evicted first) and per server instance.
 *
 * 🔴 Logs only the status, bounded codes, and the computer id, generation and epoch the host
 * named (validated shapes, else null). Never the nonce, the identity document or its signature,
 * a control key, a tunnel token or an address.
 */
import type { EnrollResponse } from './aws-enroll';

/** The Worker's and the app's error codes: lower-case snake case, short. */
const CODE = /^[a-z0-9_]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNTER_MAX = 2147483647;

export const ENROLL_REFUSAL_LOG_TAG = '[aws-enroll] refused';
export const ENROLL_REFUSAL_LOG_WINDOW_MS = 60_000;
export const ENROLL_REFUSAL_LOG_MAX_KEYS = 1024;

/** `v` when it is a short snake-case code, else null: nothing free-form reaches a log line. */
export const boundedCode = (v: unknown): string | null => (typeof v === 'string' && CODE.test(v) ? v : null);

export interface EnrollSubject {
    computerId: string | null;
    generation: number | null;
    leaseEpoch: number | null;
}

/** The computer and epoch an (unauthenticated) host body names, only in their valid shapes. */
export function enrollSubject(raw: unknown): EnrollSubject {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const id = typeof r.computerId === 'string' && r.computerId.length === 36 ? r.computerId.toLowerCase() : '';
    const counter = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= COUNTER_MAX ? v : null);
    return { computerId: UUID.test(id) ? id : null, generation: counter(r.generation), leaseEpoch: counter(r.leaseEpoch) };
}

export type EnrollRefusal = Pick<EnrollResponse, 'status' | 'body' | 'tunnel'>;
export type EnrollRefusalLogger = (result: EnrollRefusal, raw: unknown) => void;

export function createEnrollRefusalLogger(opts: {
    nowMs?: () => number;
    warn?: (tag: string, fields: Record<string, unknown>) => void;
    windowMs?: number;
    maxKeys?: number;
} = {}): EnrollRefusalLogger {
    const nowMs = opts.nowMs ?? (() => Date.now());
    const warn = opts.warn ?? ((tag: string, fields: Record<string, unknown>) => console.warn(tag, fields));
    const windowMs = opts.windowMs ?? ENROLL_REFUSAL_LOG_WINDOW_MS;
    const maxKeys = Math.max(1, opts.maxKeys ?? ENROLL_REFUSAL_LOG_MAX_KEYS);
    // Insertion order is last-logged order: the first key is always the stalest pair.
    const logged = new Map<string, { at: number; suppressed: number }>();
    return (result, raw) => {
        if (result.status === 200) return;
        const subject = enrollSubject(raw);
        const error = boundedCode(result.body.error) ?? 'unknown';
        const key = `${subject.computerId ?? '-'}|${error}`;
        const now = nowMs();
        const prior = logged.get(key);
        if (prior && now - prior.at < windowMs) {
            prior.suppressed++;
            return;
        }
        logged.delete(key);
        while (logged.size >= maxKeys) logged.delete(logged.keys().next().value!);
        logged.set(key, { at: now, suppressed: 0 });
        const tunnel = result.tunnel;
        const tunnelCode = boundedCode(tunnel?.code);
        const workerError = boundedCode(tunnel?.workerError);
        const detail = boundedCode(tunnel?.detail);
        warn(ENROLL_REFUSAL_LOG_TAG, {
            status: result.status, error, retryable: result.body.retryable === true,
            computerId: subject.computerId, generation: subject.generation, leaseEpoch: subject.leaseEpoch,
            ...(tunnelCode ? { tunnel: tunnelCode } : {}),
            ...(workerError ? { workerError } : {}),
            ...(detail ? { detail } : {}),
            ...(prior?.suppressed ? { suppressed: prior.suppressed } : {}),
        });
    };
}

let defaultLogger = createEnrollRefusalLogger();

/** The route's logger: one process-wide rate limit. Never throws: logging must not change the host's answer. */
export const logEnrollRefusal: EnrollRefusalLogger = (result, raw) => {
    try { defaultLogger(result, raw); }
    catch { /* nothing to report */ }
};

export function resetEnrollRefusalLogForTests(): void {
    defaultLogger = createEnrollRefusalLogger();
}
