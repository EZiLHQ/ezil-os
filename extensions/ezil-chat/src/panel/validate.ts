// Runtime guard for messages arriving from the webview. The webview is our own
// code, but it runs untrusted-ish (any script that gets into it can post), so the
// host never acts on an unchecked shape and caps every payload it would read.
import type { Mention, WebviewToHost } from '../protocol';

export const LIMITS = { text: 200_000, patch: 4_000_000, path: 4096, label: 1024, id: 256, query: 1024, mentions: 64, answerKeys: 64 } as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const isOptionalText = (value: unknown, max: number): boolean => value === undefined || isText(value, max);
const isLine = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100_000_000);

export function isMention(value: unknown): value is Mention {
    return isRecord(value) && isText(value.path, LIMITS.path) && isText(value.label, LIMITS.label) && isLine(value.start) && isLine(value.end);
}

function isModelId(value: unknown): boolean {
    return isRecord(value) && isText(value.providerID, LIMITS.id) && isText(value.modelID, LIMITS.id) && isOptionalText(value.variant, LIMITS.id);
}

function isAnswer(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const entries = Object.entries(value);
    if (entries.length > LIMITS.answerKeys) return false;
    return entries.every(([key, item]) => isText(key, LIMITS.id) && (
        isText(item, LIMITS.text) || typeof item === 'number' || typeof item === 'boolean'
        || (Array.isArray(item) && item.length <= LIMITS.answerKeys && item.every(part => isText(part, LIMITS.text)))
    ));
}

/** True when `value` is a well-formed, size-capped {@link WebviewToHost} message. */
export function isWebviewToHost(value: unknown): value is WebviewToHost {
    if (!isRecord(value) || typeof value.type !== 'string') return false;
    switch (value.type) {
        case 'ready': case 'stop': case 'newSession': case 'refreshSessions': case 'restartServer': return true;
        case 'send': return isText(value.text, LIMITS.text) && Array.isArray(value.mentions) && value.mentions.length <= LIMITS.mentions && value.mentions.every(isMention);
        case 'selectSession': return isText(value.sessionId, LIMITS.id);
        case 'setModel': return isModelId(value.model);
        case 'setAgent': return isText(value.agent, LIMITS.id);
        case 'permission': return isText(value.sessionId, LIMITS.id) && isText(value.requestId, LIMITS.id) && (value.decision === 'once' || value.decision === 'always' || value.decision === 'reject');
        case 'question': return isText(value.sessionId, LIMITS.id) && isText(value.questionId, LIMITS.id) && isAnswer(value.answer);
        case 'searchFiles': return typeof value.requestId === 'number' && Number.isFinite(value.requestId) && isText(value.query, LIMITS.query);
        case 'openFile': return isText(value.path, LIMITS.path) && isLine(value.line);
        case 'showDiff': return isText(value.file, LIMITS.path) && isText(value.patch, LIMITS.patch);
        default: return false;
    }
}
