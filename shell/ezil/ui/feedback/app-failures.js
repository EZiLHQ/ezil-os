// App failure context v1. No listeners, storage or telemetry on import.
// Wire allowlist: docs/FEEDBACK-APP-FAILURES-CONTRACT.md §2/§3.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODES = {
    interrupted: ['stream_interrupted'], network: ['network_offline', 'network_failed'],
    timeout: ['request_timeout', 'first_token_timeout'], auth: ['auth_expired', 'auth_invalid', 'session_expired'],
    credits: ['credits_exhausted'], entitlement: ['membership_required', 'model_not_entitled'],
    rate_limit: ['rate_limited'], provider: ['provider_error', 'provider_overloaded', 'provider_refused', 'model_unavailable'],
    cancellation: ['request_cancelled'], app_startup: ['app_start_failed', 'app_start_timeout', 'chat_unavailable'],
};
/** Mirror of the server's `MODEL_KEY_NAMESPACES`; the shell test asserts equality. */
export const MODEL_KEY_NAMESPACES = Object.freeze([
    'anthropic', 'openai', 'google', 'gemini', 'vertex', 'bedrock', 'aws-bedrock', 'amazon', 'azure',
    'qwen', 'moonshot', 'moonshotai', 'kimi', 'zai', 'z-ai', 'glm', 'deepseek', 'mistral', 'meta', 'llama',
    'xai', 'cohere', 'minimax', 'groq', 'cerebras', 'openrouter', 'ezil',
]);
const NAMESPACES = new Set(MODEL_KEY_NAMESPACES);
const TOKEN_WORD = /secret|token|passw|bearer|api[-_]?key|private|credential|session|cookie/;
const TOKEN_PREFIX = /^(?:sk|sb|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpr])[-_]/;
/** Mirror of the server's `isSafeModelKey` (contract §2): namespaced, never a credential, path or URL. */
export function safe_model_key (value) {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:/-]{0,63}$/.test(value) || value !== value.trim()) return false;
    if (value.includes('://') || value.split('/').length > 2) return false;
    const match = /^([a-z0-9-]+)[/.](.+)$/.exec(value);
    if (!match || !NAMESPACES.has(match[1])) return false;
    const segments = match[2].split(/[/.:]/);
    if (segments.some(segment => !segment || TOKEN_PREFIX.test(segment) || TOKEN_WORD.test(segment)
        || /[a-z0-9]{20,}/.test(segment))) return false;
    return /[0-9-]/.test(segments[0]);
}
const oneOf = values => value => values.includes(value);
const uuid = value => typeof value === 'string' && UUID.test(value);
const integer = (min, max) => value => Number.isInteger(value) && value >= min && value <= max;
const FIELDS = {
    eventId: uuid, source: oneOf(['ezil_chat', 'code_app']), operation: oneOf(['chat_request', 'app_start']),
    category: oneOf(Object.keys(CODES)), code: value => typeof value === 'string',
    stage: oneOf(['startup', 'admission', 'request', 'headers', 'stream']),
    outcome: oneOf(['failed', 'retrying', 'recovered', 'cancelled']),
    streamReason: oneOf(['eof', 'malformed_event', 'missing_terminal']),
    cancellationSource: oneOf(['caller', 'user_stop', 'unknown']),
    clientRequestId: uuid, gatewayRequestId: uuid, vscodeRequestId: uuid, retryOfClientRequestId: uuid,
    attempt: integer(1, 64), retryable: value => typeof value === 'boolean', durationMs: integer(0, 3_600_000),
    modelKey: safe_model_key,
    httpStatus: integer(100, 599),
};
const REQUIRED = ['eventId', 'source', 'operation', 'category', 'code', 'stage', 'outcome'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A fresh, strictly allowlisted record, or null. Never repairs producer data. */
export function validate_failure (record) {
    if (!object(record) || !REQUIRED.every(key => Object.hasOwn(record, key))) return null;
    const clean = {};
    for (const key of Reflect.ownKeys(record)) {
        if (!Object.hasOwn(FIELDS, key) || !FIELDS[key](record[key])) return null;
        clean[key] = record[key];
    }
    if (clean.code !== 'unexpected_error' && !CODES[clean.category].includes(clean.code)) return null;
    if (Object.hasOwn(clean, 'streamReason') && clean.stage !== 'stream') return null;
    // Neutral cancellation: its source is required, and `cancelled` belongs to it alone.
    const cancellation = clean.category === 'cancellation';
    if (cancellation !== Object.hasOwn(clean, 'cancellationSource') || cancellation !== (clean.outcome === 'cancelled')) return null;
    return clean;
}

const TTL = 30 * 60_000;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
function token () {
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    return btoa(String.fromCharCode(...random)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function exactKeys (value, keys) {
    return object(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Isolated stores and a shell clock injection for deterministic tests. */
export function create_app_failure_store ({ now = () => Date.now() } = {}) {
    const rings = new Map();
    const frames = new Set();
    const registrations = new WeakMap();
    let rates = new WeakMap();
    let sequence = 0;
    function prune (at) {
        for (const [key, ring] of rings) {
            ring.entries = ring.entries.filter(entry => at - entry.receivedAt <= TTL);
            if (!ring.entries.length) rings.delete(key);
        }
    }

    function register_app_frame (iframe, { origin, computerId, appSession, app } = {}) {
        registrations.get(iframe)?.();
        try {
            const parsed = new URL(origin);
            if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin || origin === 'null') return () => {};
        } catch { return () => {}; }
        if (app !== 'code' || typeof computerId !== 'string' || !computerId
            || typeof appSession !== 'string' || !appSession) return () => {};
        const host = iframe.ownerDocument.defaultView;
        const frameUrl = iframe.src;
        const context = { computerId, appSession, responsive: false };
        const key = JSON.stringify([computerId, appSession]);
        let nonce = null;
        let detached = false;
        const live = () => !detached && iframe.isConnected && iframe.src === frameUrl;
        function unregister () {
            detached = true;
            nonce = null;
            host.removeEventListener('message', onMessage);
            iframe.removeEventListener('load', hello);
            frames.delete(context);
            if (registrations.get(iframe) === unregister) registrations.delete(iframe);
        }
        function hello () {
            if (!live()) { unregister(); return; }
            context.responsive = false;
            nonce = token();
            try { iframe.contentWindow?.postMessage({ type: 'ezil.code.diag.hello', v: 1, nonce }, origin); } catch { /* gone */ }
        }
        function onMessage (event) {
            if (event.source !== iframe.contentWindow) return;
            if (event.origin === 'null' || event.origin !== origin) return;
            if (!live()) { unregister(); return; }
            const data = event.data;
            if (!object(data) || data.v !== 1 || !nonce || data.nonce !== nonce) return;
            const ready = data.type === 'ezil.code.diag.ready';
            if (!ready && data.type !== 'ezil.code.failure') return;
            if (!exactKeys(data, ready ? ['type', 'v', 'nonce'] : ['type', 'v', 'nonce', 'failure'])) return;
            try { if (bytes(data) > 2048) return; } catch { return; }
            const failure = ready ? null : validate_failure(data.failure);
            if (!ready && !failure) return;
            const at = now();
            const accepted = (rates.get(iframe) || []).filter(time => at - time < 60_000);
            if (accepted.length >= 20) return;
            accepted.push(at);
            rates.set(iframe, accepted);
            context.responsive = true;
            prune(at);
            if (ready) return;
            const ring = rings.get(key) || { computerId, appSession, entries: [] };
            if (ring.entries.some(entry => entry.failure.eventId === failure.eventId)) return;
            ring.entries.push({ failure, app, receivedAt: at, sequence: ++sequence });
            ring.entries = ring.entries.slice(-50);
            rings.set(key, ring);
        }
        context.unregister = unregister;
        context.live = live;
        frames.add(context);
        registrations.set(iframe, unregister);
        host.addEventListener('message', onMessage);
        iframe.addEventListener('load', hello);
        hello();
        return unregister;
    }

    function app_failures_for ({ computerId, appSession } = {}) {
        const at = now();
        prune(at);
        for (const context of frames) if (!context.live()) context.unregister();
        // Scope (contract §4): with an appSession, that one window; without one
        // (the global entry), every app session of the frozen computer.
        const matches = context => context.computerId === computerId
            && (appSession === undefined || context.appSession === appSession);
        const failures = [...rings.values()].filter(matches).flatMap(ring => ring.entries)
            .sort((a, b) => b.receivedAt - a.receivedAt || b.sequence - a.sequence).slice(0, 10)
            .map(entry => ({ ...entry.failure, app: entry.app, ageMs: Math.max(0, Math.round(at - entry.receivedAt)) }));
        while (bytes(failures) > 8 * 1024) failures.pop();
        // Retained entries outlive their window (closing Code after a failure must
        // not hide it); with none, a live responsive collector still counts.
        const available = failures.length > 0 || [...frames].some(context => matches(context) && context.responsive);
        return { available, failures };
    }

    function clear_app_failures () {
        // Detach as well as clearing: unloading frames cannot refill a signed-out store.
        for (const unregister of [...frames].map(context => context.unregister)) unregister();
        rings.clear();
        rates = new WeakMap();
    }

    return { register_app_frame, app_failures_for, clear_app_failures };
}

export const { register_app_frame, app_failures_for, clear_app_failures } = create_app_failure_store();
