/**
 * One bounded log line per refused host enrollment (`POST /api/compute/aws/enroll`), so a host's
 * retry loop is visible in the app's logs long before `[enroll-timeout]` (aws-receipts.ts) fires.
 *
 * The caller is unauthenticated, so nothing it sends names a line or picks its rate-limit key. A
 * refusal names its computer and epoch only when `handleAwsEnrollment` attached `subject`: the
 * request presented that epoch's own nonce, and the values are the placement's. Every earlier
 * refusal (an unparseable or schema-invalid body, AWS off, enrollment unavailable, an unknown
 * computer, a wrong nonce, a handler throw) is anonymous: null computer and epoch, one shared key.
 *
 * Hosts retry every few seconds (enroll.py): the first refusal per key (everything its line says:
 * status, codes, the proven computer and epoch) is logged, then at most one line per key per
 * minute, carrying how many were suppressed in between; a changed diagnosis is a new key. The key
 * map is bounded (the least recently logged key is evicted first). On top of that, at most
 * `ENROLL_REFUSAL_LOG_MAX_LINES` lines per minute in all: refusals past the cap are only counted,
 * and the first refusal of the next window writes one `[aws-enroll] refusals suppressed` line
 * with that count (no timer in a serverless function). All of it is per server instance.
 *
 * 🔴 Logs only the status, bounded codes, and the proven computer id, generation and epoch
 * (validated shapes, else null). Never the nonce, the identity document or its signature, a
 * control key, a tunnel token or an address.
 */
import type { EnrollResponse } from './aws-enroll';

/** The Worker's and the app's error codes: lower-case snake case, short. */
const CODE = /^[a-z0-9_]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNTER_MAX = 2147483647;

export const ENROLL_REFUSAL_LOG_TAG = '[aws-enroll] refused';
export const ENROLL_REFUSALS_SUPPRESSED_LOG_TAG = '[aws-enroll] refusals suppressed';
export const ENROLL_REFUSAL_LOG_WINDOW_MS = 60_000;
export const ENROLL_REFUSAL_LOG_MAX_KEYS = 1024;
export const ENROLL_REFUSAL_LOG_MAX_LINES = 100;

/** `v` when it is a short snake-case code, else null: nothing free-form reaches a log line. */
export const boundedCode = (v: unknown): string | null => (typeof v === 'string' && CODE.test(v) ? v : null);

export interface EnrollSubject {
    computerId: string | null;
    generation: number | null;
    leaseEpoch: number | null;
}

/** A result's proven computer and epoch (`EnrollResponse.subject`), only in their valid shapes. */
export function enrollSubject(raw: unknown): EnrollSubject {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const id = typeof r.computerId === 'string' && r.computerId.length === 36 ? r.computerId.toLowerCase() : '';
    const counter = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= COUNTER_MAX ? v : null);
    return { computerId: UUID.test(id) ? id : null, generation: counter(r.generation), leaseEpoch: counter(r.leaseEpoch) };
}

export type EnrollRefusal = Pick<EnrollResponse, 'status' | 'body' | 'tunnel' | 'subject'>;
export type EnrollRefusalLogger = (result: EnrollRefusal) => void;

export function createEnrollRefusalLogger(opts: {
    nowMs?: () => number;
    warn?: (tag: string, fields: Record<string, unknown>) => void;
    windowMs?: number;
    maxKeys?: number;
    maxLines?: number;
} = {}): EnrollRefusalLogger {
    const nowMs = opts.nowMs ?? (() => Date.now());
    const warn = opts.warn ?? ((tag: string, fields: Record<string, unknown>) => console.warn(tag, fields));
    const windowMs = opts.windowMs ?? ENROLL_REFUSAL_LOG_WINDOW_MS;
    const maxKeys = Math.max(1, opts.maxKeys ?? ENROLL_REFUSAL_LOG_MAX_KEYS);
    const maxLines = Math.max(1, opts.maxLines ?? ENROLL_REFUSAL_LOG_MAX_LINES);
    // Insertion order is last-logged order: the first key is always the stalest one.
    const logged = new Map<string, { at: number; suppressed: number }>();
    // The global cap's fixed window: lines written in it, and refusals the cap kept out of it.
    let windowStart = -Infinity;
    let lines = 0;
    let capped = 0;
    return (result) => {
        if (result.status === 200) return;
        const now = nowMs();
        if (now - windowStart >= windowMs) {
            if (capped > 0) warn(ENROLL_REFUSALS_SUPPRESSED_LOG_TAG, { suppressed: capped });
            windowStart = now;
            lines = 0;
            capped = 0;
        }
        const subject = enrollSubject(result.subject);
        const tunnel = result.tunnel;
        const tunnelCode = boundedCode(tunnel?.code);
        const workerError = boundedCode(tunnel?.workerError);
        const detail = boundedCode(tunnel?.detail);
        const fields: Record<string, unknown> = {
            status: result.status, error: boundedCode(result.body.error) ?? 'unknown', retryable: result.body.retryable === true,
            computerId: subject.computerId, generation: subject.generation, leaseEpoch: subject.leaseEpoch,
            ...(tunnelCode ? { tunnel: tunnelCode } : {}),
            ...(workerError ? { workerError } : {}),
            ...(detail ? { detail } : {}),
        };
        // Every field is a bounded code or a proven id, so the key space is too.
        const key = JSON.stringify(fields);
        const prior = logged.get(key);
        if (prior && now - prior.at < windowMs) {
            prior.suppressed++;
            return;
        }
        // Over the cap: counted for the next window's summary, and the key stays as it was, so its
        // next refusal is still logged.
        if (lines >= maxLines) {
            capped++;
            return;
        }
        lines++;
        logged.delete(key);
        while (logged.size >= maxKeys) logged.delete(logged.keys().next().value!);
        logged.set(key, { at: now, suppressed: 0 });
        warn(ENROLL_REFUSAL_LOG_TAG, { ...fields, ...(prior?.suppressed ? { suppressed: prior.suppressed } : {}) });
    };
}

let defaultLogger = createEnrollRefusalLogger();

/** The route's logger: one process-wide rate limit. Never throws: logging must not change the host's answer. */
export const logEnrollRefusal: EnrollRefusalLogger = (result) => {
    try { defaultLogger(result); }
    catch { /* nothing to report */ }
};

export function resetEnrollRefusalLogForTests(): void {
    defaultLogger = createEnrollRefusalLogger();
}
