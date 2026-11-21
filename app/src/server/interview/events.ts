/**
 * Interview event shapes (docs/contracts/interview-evidence-v1.md §2, §3; interview-evidence-v1.schema.json).
 *
 * Pure and runtime-free of the DB, so the closed type list, the exact-key data rules and the turn_start derivation
 * are tested directly. The vectors win where this and the prose disagree.
 */

/** The 11 OS event types (contract §3). The DB `type` CHECK carries the same closed list. */
export const OS_EVENT_TYPES = [
    'consent.accepted', 'interview.started', 'computer.opened', 'tab.visibility', 'window.focus',
    'app.focus', 'presence.idle', 'session.heartbeat', 'agent.turn_start', 'agent.turn_end', 'interview.finished',
] as const;
export type OsEventType = (typeof OS_EVENT_TYPES)[number];

/** The only types a client may report through `/api/shell/interview-events` (vectors `types.osClientReported`). */
export const OS_CLIENT_REPORTED = [
    'tab.visibility', 'window.focus', 'app.focus', 'presence.idle', 'session.heartbeat', 'agent.turn_end',
] as const;
export type OsClientReportedType = (typeof OS_CLIENT_REPORTED)[number];

/** `at`/`clientAt`: UTC, millisecond precision, `YYYY-MM-DDTHH:MM:SS.mmmZ` (schema `$defs/at`). */
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** `$defs/anyUuid` — lowercase hex, any version. The ai-traces validator already lowercases the ids it passes on. */
const ANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `data:agent.turn_end.modelAlias` and `data:app.focus.app` patterns (schema). */
const MODEL_ALIAS_RE = /^(?:unknown|[A-Za-z][A-Za-z0-9_.:-]{0,127})$/;
const APP_RE = /^(?:unknown|[a-z0-9][a-z0-9._-]{0,63})$/;
const TAB_STATES = new Set(['visible', 'hidden']);
const IDLE_BUCKETS = new Set(['<15s', '15-60s', '1-5m', '>5m']);
const TURN_OUTCOMES = new Set(['completed', 'failed', 'cancelled']);
const TOOL_CALL_KEYS = ['read', 'search', 'write', 'other'] as const;

export function isValidAt(v: unknown): v is string {
    return typeof v === 'string' && AT_RE.test(v);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
/** Exactly these own keys, no more, no fewer. Rejects an extra key, a missing key and a prototype-polluting key. */
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
    Reflect.ownKeys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const isNonNegInt = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** A validated client event the server will persist (its `data` already proven against the closed type rule). */
export interface CleanClientEvent {
    type: OsClientReportedType;
    clientAt: string;
    data: Record<string, unknown>;
}

/** The `data` object for a client-reported type, or null if it is not exactly the contract shape. */
function cleanData(type: OsClientReportedType, data: unknown): Record<string, unknown> | null {
    if (!isObject(data)) return null;
    switch (type) {
        case 'tab.visibility':
            return exactKeys(data, ['state']) && typeof data.state === 'string' && TAB_STATES.has(data.state)
                ? { state: data.state } : null;
        case 'window.focus':
            return exactKeys(data, ['focused']) && typeof data.focused === 'boolean'
                ? { focused: data.focused } : null;
        case 'app.focus':
            return exactKeys(data, ['app']) && typeof data.app === 'string' && APP_RE.test(data.app)
                ? { app: data.app } : null;
        case 'presence.idle':
            return exactKeys(data, ['bucket']) && typeof data.bucket === 'string' && IDLE_BUCKETS.has(data.bucket)
                ? { bucket: data.bucket } : null;
        case 'session.heartbeat':
            return exactKeys(data, []) ? {} : null;
        case 'agent.turn_end': {
            if (!exactKeys(data, ['requestId', 'gatewayRequestId', 'modelAlias', 'durationMs', 'outcome', 'toolCalls'])) return null;
            const { requestId, gatewayRequestId, modelAlias, durationMs, outcome, toolCalls } = data;
            if (typeof requestId !== 'string' || !ANY_UUID_RE.test(requestId)) return null;
            if (gatewayRequestId !== null && !(typeof gatewayRequestId === 'string' && ANY_UUID_RE.test(gatewayRequestId))) return null;
            if (typeof modelAlias !== 'string' || !MODEL_ALIAS_RE.test(modelAlias)) return null;
            if (!isNonNegInt(durationMs)) return null;
            if (typeof outcome !== 'string' || !TURN_OUTCOMES.has(outcome)) return null;
            if (!isObject(toolCalls) || !exactKeys(toolCalls, TOOL_CALL_KEYS) || !TOOL_CALL_KEYS.every((k) => isNonNegInt(toolCalls[k]))) return null;
            return {
                requestId, gatewayRequestId, modelAlias, durationMs, outcome,
                toolCalls: { read: toolCalls.read, search: toolCalls.search, write: toolCalls.write, other: toolCalls.other },
            };
        }
    }
}

/** One batch entry `{type, clientAt, data}`, or null when it is not a valid client-reported event. */
export function validateClientEvent(value: unknown): CleanClientEvent | null {
    if (!isObject(value) || !exactKeys(value, ['type', 'clientAt', 'data'])) return null;
    const { type, clientAt } = value;
    if (typeof type !== 'string' || !(OS_CLIENT_REPORTED as readonly string[]).includes(type)) return null;
    if (!isValidAt(clientAt)) return null;
    const data = cleanData(type as OsClientReportedType, value.data);
    return data ? { type: type as OsClientReportedType, clientAt, data } : null;
}

/**
 * The derived `agent.turn_start.at` for a turn: `turn_end.at − durationMs`, both server time (vectors
 * `turnStartDerivation`). The server writes turn_start immediately before the turn_end (seq n, n+1).
 */
export function turnStartAtISO(turnEndAtISO: string, durationMs: number): string {
    return new Date(new Date(turnEndAtISO).getTime() - durationMs).toISOString();
}
