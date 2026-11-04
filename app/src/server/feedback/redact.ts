import { sanitizeErrorMessage } from '@/server/telemetry/sanitize';
import { APP_NAMES, BROWSER_FAMILIES, OS_FAMILIES, oneOf, projectEvent, projectLogLine } from './event-vocabulary.js';
import type { FeedbackDiagnostics } from './types';

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

/**
 * Fail closed (re-review 88e642df-feedback-closed-projection-v1): every field a
 * shell computes from a closed list is checked against that list here, and
 * telemetry events (`recentEvents`, `logs`) keep only the closed vocabulary in
 * `event-vocabulary.js`, whatever the client sent. Fields no shell produces
 * (`appCommit`, `phases`, `stream.state`) are dropped. Left as bounded text,
 * through diagnosticString: `shellVersion` (≤64), `computerStatus` (≤32, the
 * desktop window's own status copy) and `traceId` (≤64, a generated id).
 */
export function sanitizeDiagnostics(input: FeedbackDiagnostics | null | undefined): FeedbackDiagnostics | null {
    if (!input) return null;
    const out: FeedbackDiagnostics = {};
    if (input.shellVersion !== undefined) out.shellVersion = diagnosticString(input.shellVersion, 64);
    const app = oneOf(APP_NAMES, input.app);
    if (app) out.app = app;
    const family = oneOf(BROWSER_FAMILIES, input.browser?.family);
    if (family && input.browser) out.browser = { family, major: input.browser.major };
    const os = oneOf(OS_FAMILIES, input.os);
    if (os) out.os = os;
    if (input.deviceClass !== undefined) out.deviceClass = input.deviceClass;
    if (input.viewport) out.viewport = { ...input.viewport };
    if (input.fullscreen !== undefined) out.fullscreen = input.fullscreen;
    if (input.fullbleed !== undefined) out.fullbleed = input.fullbleed;
    if (input.computerStatus !== undefined) out.computerStatus = diagnosticString(input.computerStatus, 32);
    if (input.traceId !== undefined) out.traceId = diagnosticString(input.traceId, 64);
    let dropped = 0;
    if (input.recentEvents) {
        out.recentEvents = input.recentEvents.map(projectEvent).filter((event) => event !== null);
        dropped += input.recentEvents.length - out.recentEvents.length;
    }
    if (input.stream) {
        out.stream = {};
        if (input.stream.kbps !== undefined) out.stream.kbps = input.stream.kbps;
        if (input.stream.rttMs !== undefined) out.stream.rttMs = input.stream.rttMs;
    }
    if (input.logs) {
        out.logs = input.logs.map(projectLogLine).filter((line) => line !== null);
        dropped += input.logs.length - out.logs.length;
    }
    const omitted = (input.omitted ?? 0) + dropped;
    if (omitted) out.omitted = Math.min(1_000_000_000, omitted);
    return out;
}
