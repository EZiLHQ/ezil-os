// billing-recovery.js — EZiL-authored. Code's requests for the Billing dialogs (Free includes Gemini 3.8 Flash only):
// an EZiL AI credit refusal, or a plan-locked model chosen in Code's picker. The Worker's billing bridge
// (worker/src/code-billing-bridge.ts) forwards `{ reason, requestId?, model? }` after a nonce handshake with this
// window. Billing then picks the dialog from its own live summary (topup-sheet.js `billingRecoveryAction`): the Standard
// upgrade on Free, Add credits on a paid plan. No listeners, storage or telemetry on import.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REASONS = new Set(['credits_exhausted', 'model_locked']);
/** A repeat of a request, or any request this soon after the last one, opens nothing: no dialog loops. */
export const BILLING_REQUEST_GAP_MS = 5000;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A fresh closed request from Code, or null. Never repairs it. */
export function validate_billing_request (value) {
    if ( ! object(value) || ! Reflect.ownKeys(value).every(key => ['reason', 'requestId', 'model'].includes(key)) ) return null;
    if ( ! REASONS.has(value.reason) ) return null;
    if ( value.requestId !== undefined && ! (typeof value.requestId === 'string' && UUID.test(value.requestId)) ) return null;
    if ( value.model !== undefined && ! (typeof value.model === 'string' && ALIAS.test(value.model)) ) return null;
    return { reason: value.reason, ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
        ...(value.model === undefined ? {} : { model: value.model }) };
}

function token () {
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    return btoa(String.fromCharCode(...random)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Listen to one Code frame (`origin` is its own origin) and hand each accepted request to `open`, at most once per
 * request id and never twice within BILLING_REQUEST_GAP_MS. Returns the unregister function.
 */
export function register_billing_frame (iframe, { origin, open, now = () => Date.now() } = {}) {
    try {
        const parsed = new URL(origin);
        if ( ! ['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin || origin === 'null' ) return () => {};
    } catch { return () => {}; }
    if ( typeof open !== 'function' ) return () => {};
    const host = iframe.ownerDocument.defaultView;
    const frameUrl = iframe.src;
    const seen = new Set();
    let nonce = null;
    let detached = false;
    let lastAt = -Infinity;
    const live = () => ! detached && iframe.isConnected && iframe.src === frameUrl;
    function unregister () {
        detached = true;
        nonce = null;
        host.removeEventListener('message', onMessage);
        iframe.removeEventListener('load', hello);
    }
    function hello () {
        if ( ! live() ) { unregister(); return; }
        nonce = token();
        try { iframe.contentWindow?.postMessage({ type: 'ezil.code.billing.hello', v: 1, nonce }, origin); } catch { /* gone */ }
    }
    function onMessage (event) {
        if ( event.source !== iframe.contentWindow || event.origin === 'null' || event.origin !== origin ) return;
        if ( ! live() ) { unregister(); return; }
        const data = event.data;
        if ( ! object(data) || data.v !== 1 || ! nonce || data.nonce !== nonce || data.type !== 'ezil.code.billing.intent' ) return;
        if ( Reflect.ownKeys(data).length !== 4 || ! ['type', 'v', 'nonce', 'intent'].every(key => Object.hasOwn(data, key)) ) return;
        const request = validate_billing_request(data.intent);
        if ( ! request ) return;
        const at = now();
        if ( (request.requestId && seen.has(request.requestId)) || at - lastAt < BILLING_REQUEST_GAP_MS ) return;
        lastAt = at;
        if ( request.requestId ) {
            seen.add(request.requestId);
            if ( seen.size > 32 ) seen.delete(seen.values().next().value);
        }
        try { void Promise.resolve(open(request)).catch(() => {}); } catch { /* the launcher's failure stays here */ }
    }
    host.addEventListener('message', onMessage);
    iframe.addEventListener('load', hello);
    hello();
    return unregister;
}
