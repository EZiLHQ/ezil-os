import { isCorrelationId, isFailureReason } from '@/server/lib/failure-diagnostics';
import { sanitizeErrorMessage } from '@/server/telemetry/sanitize';
import { FEEDBACK_LIMITS, type FeedbackDiagnostics } from './types';

const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/** Preserve useful prose (including email addresses); only credential-shaped
 * values are removed here. Diagnostics have a stricter policy below because
 * they are collected automatically (docs/FEEDBACK-CONTROLS-CONTRACT.md:115). */
export function redactDescription(input: string): { text: string; count: number } {
    let count = 0;
    let text = input;
    const rules: [RegExp, string][] = [
        [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'bearer'],
        [/__Host-ezil-os-auth\s*=\s*[^\s;,]+/g, 'auth-cookie'],
        [/\bsb-[A-Za-z0-9_-]+-auth-token(?:\.\d+)?\s*=\s*[^\s;,]+/g, 'supabase-auth'],
        [JWT, 'jwt'],
        [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, 'api-key'],
        [/\bsk_live_[A-Za-z0-9]{16,}\b/g, 'api-key'],
        [/\bAKIA[0-9A-Z]{16}\b/g, 'aws-key'],
        [/\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, 'github-token'],
        [/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, 'slack-token'],
        [/\b(?:key|secret|token|password)\s*=\s*["']?[A-Za-z0-9_+/-]{32,}={0,2}["']?/gi, 'secret'],
    ];
    for (const [pattern, kind] of rules) {
        text = text.replace(pattern, () => {
            count++;
            return `[redacted:${kind}]`;
        });
    }
    return { text, count };
}

function diagnosticString(value: string, max: number): string {
    // Mask before telemetry truncates, so a token crossing its cutoff cannot
    // survive as a partial credential (telemetry/sanitize.ts:65).
    return sanitizeErrorMessage(redactDescription(value).text
        .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, '[redacted:email]')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted:uuid]'))
        .slice(0, max);
}

type RecentEvent = NonNullable<FeedbackDiagnostics['recentEvents']>[number];

/**
 * FEEDBACK-DIAG: one recent event's failure annotation, ALLOWLISTED — a value
 * that does not match its shape is dropped, never repaired.
 *
 * 🔴 `correlationId` is the ONE diagnostics field exempt from the UUID mask
 * below, and narrowly: it must be a server-minted correlation id
 * (`isCorrelationId`: a lowercase `randomUUID`, `cid_…` or `srv_…`), it
 * identifies one request rather than a person or a computer, and it is
 * dropped if it equals the reporter's own user or computer id. Masking it
 * would turn the one value support can grep the server log for into
 * `[redacted:uuid]`.
 */
function annotation(event: RecentEvent, excludeIds: ReadonlySet<string>): Pick<RecentEvent, 'reason' | 'correlationId'> {
    const out: Pick<RecentEvent, 'reason' | 'correlationId'> = {};
    if (isFailureReason(event.reason)) out.reason = event.reason;
    if (isCorrelationId(event.correlationId) && !excludeIds.has(event.correlationId)) out.correlationId = event.correlationId;
    return out;
}

export interface SanitizeDiagnosticsOptions {
    /** Ids a `correlationId` must never equal (the reporter's user and computer). Compared lowercase. */
    excludeIds?: readonly (string | null | undefined)[];
}

export function sanitizeDiagnostics(
    input: FeedbackDiagnostics | null | undefined, options: SanitizeDiagnosticsOptions = {},
): FeedbackDiagnostics | null {
    if (!input) return null;
    const out: FeedbackDiagnostics = {};
    if (input.shellVersion !== undefined) out.shellVersion = diagnosticString(input.shellVersion, 64);
    if (input.appCommit !== undefined) out.appCommit = diagnosticString(input.appCommit, 64);
    if (input.browser) out.browser = { family: diagnosticString(input.browser.family, 32), major: input.browser.major };
    if (input.os !== undefined) out.os = diagnosticString(input.os, 32);
    if (input.deviceClass !== undefined) out.deviceClass = input.deviceClass;
    if (input.viewport) out.viewport = { ...input.viewport };
    if (input.fullscreen !== undefined) out.fullscreen = input.fullscreen;
    if (input.fullbleed !== undefined) out.fullbleed = input.fullbleed;
    if (input.computerStatus !== undefined) out.computerStatus = diagnosticString(input.computerStatus, 32);
    if (input.traceId !== undefined) out.traceId = diagnosticString(input.traceId, 64);
    if (input.phases) out.phases = input.phases.map((phase) => diagnosticString(phase, 40));
    if (input.recentEvents) {
        const excludeIds = new Set((options.excludeIds ?? []).filter((id): id is string => !!id).map((id) => id.toLowerCase()));
        // Events are oldest-first; only the newest `recentEventsAnnotatedMax`
        // annotated ones keep their annotation.
        const kept = new Map<number, Pick<RecentEvent, 'reason' | 'correlationId'>>();
        for (let i = input.recentEvents.length - 1; i >= 0 && kept.size < FEEDBACK_LIMITS.recentEventsAnnotatedMax; i--) {
            const extra = annotation(input.recentEvents[i]!, excludeIds);
            if (extra.reason || extra.correlationId) kept.set(i, extra);
        }
        out.recentEvents = input.recentEvents.map((event, i) => ({
            eventClass: diagnosticString(event.eventClass, 40),
            site: diagnosticString(event.site, 80),
            code: diagnosticString(event.code, 80),
            ...kept.get(i),
        }));
    }
    if (input.stream) {
        out.stream = { ...input.stream };
        if (input.stream.state !== undefined) out.stream.state = diagnosticString(input.stream.state, 24);
    }
    return out;
}

/**
 * FEEDBACK-DIAG: the validated `{correlationId, reason}` pairs a sanitized
 * report carries, deduplicated, for the one server log line that lets support
 * go from a feedback report to the failure's own log line (and back).
 */
export function feedbackFailureRefs(diagnostics: FeedbackDiagnostics | null): { correlationId?: string; reason?: string }[] {
    const seen = new Set<string>();
    const refs: { correlationId?: string; reason?: string }[] = [];
    for (const event of diagnostics?.recentEvents ?? []) {
        if (!event.correlationId && !event.reason) continue;
        const key = `${event.correlationId ?? ''}|${event.reason ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ ...(event.correlationId ? { correlationId: event.correlationId } : {}), ...(event.reason ? { reason: event.reason } : {}) });
    }
    return refs.slice(-FEEDBACK_LIMITS.recentEventsAnnotatedMax);
}
