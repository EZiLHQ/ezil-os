// code-preview.js — EZiL-authored. Mint app previews for this Code frame's own computer (code-preview-v1).
// No listeners on import, no token storage or logging. A detached frame cannot complete a pending mint.
const bridges = new WeakMap();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && value.length === 22 && /^[A-Za-z0-9_-]{22}$/.test(value);
const errorCode = value => typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) && !/[\r\n]/.test(value);

/** A closed mintReply record, or null. The bootstrap credential is carried unchanged to the requesting frame. */
export function validatePreviewMintReply (value) {
    if ( ! object(value) ) return null;
    const keys = Reflect.ownKeys(value);
    if ( keys.length === 1 && keys[0] === 'error' && errorCode(value.error) ) return { error: value.error };
    if ( keys.length !== 2 || ! keys.includes('url') || ! keys.includes('expiresAt') || typeof value.url !== 'string'
        || value.url.length > 8192 || /[\x00-\x20\x7f\\]/.test(value.url) || ! Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 ) return null;
    try {
        const u = new URL(value.url);
        if ( u.protocol !== 'https:' || u.username || u.password || u.port
            || ! /^(?:3002-[a-z0-9-]{1,80}-app|aws-3002-[a-z0-9-]{1,80}-aws)\.[a-z0-9.-]+$/.test(u.hostname) ) return null;
        return { url: value.url, expiresAt: value.expiresAt };
    } catch { return null; }
}

function nonceToken () {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function attachPreviewMintBridge ({ iframe, frameUrl, computerId, mint }) {
    bridges.get(iframe)?.();
    let origin;
    try {
        const url = new URL(frameUrl);
        if ( url.protocol !== 'https:' || url.username || url.password ) return () => {};
        origin = url.origin;
    } catch { return () => {}; }
    if ( typeof mint !== 'function' || typeof computerId !== 'string' || ! computerId ) return () => {};
    const host = iframe.ownerDocument.defaultView;
    const pending = new Map(), seen = new Set(), times = [];
    let nonce, ready = false, detached = false;
    const live = () => ! detached && iframe.isConnected && iframe.src === frameUrl;
    const forget = id => {
        const request = pending.get(id);
        if ( ! request ) return;
        pending.delete(id);
        host.clearTimeout(request.timer);
        return request;
    };
    const cancel = id => { forget(id)?.controller.abort(); };
    const abort = () => { for ( const id of pending.keys() ) cancel(id); };
    function detach () {
        detached = true;
        ready = false;
        nonce = null;
        abort();
        host.removeEventListener('message', onMessage);
        iframe.removeEventListener('load', hello);
        if ( bridges.get(iframe) === detach ) bridges.delete(iframe);
    }
    function hello () {
        if ( ! live() ) { detach(); return; }
        abort();
        ready = false;
        nonce = nonceToken();
        try { iframe.contentWindow?.postMessage({ type: 'ezil.code.preview.hello', v: 1, nonce }, origin); } catch { /* gone */ }
    }
    function onMessage (event) {
        if ( event.source !== iframe.contentWindow || event.origin !== origin ) return;
        if ( ! live() ) { detach(); return; }
        const d = event.data;
        if ( ! object(d) || d.v !== 1 || ! nonce || d.nonce !== nonce ) return;
        const keys = Reflect.ownKeys(d);
        if ( d.type === 'ezil.code.preview.ready' && keys.length === 3 && keys.every(k => ['type', 'v', 'nonce'].includes(k)) ) {
            ready = true;
            return;
        }
        if ( ! ready || keys.length !== 4
            || ! keys.every(k => ['type', 'v', 'nonce', 'id'].includes(k)) || ! token(d.id) ) return;
        // Source, origin and the current handshake bind this id to this Code frame's own computer.
        if ( d.type === 'ezil.code.preview.cancel' ) { cancel(d.id); return; }
        if ( d.type !== 'ezil.code.preview.mint' || seen.has(d.id) ) return;
        const at = Date.now();
        while ( times.length && times[0] <= at - 60000 ) times.shift();
        if ( times.length >= 6 ) return;
        times.push(at);
        seen.add(d.id);
        const controller = new AbortController(), boundNonce = nonce, frame = iframe.contentWindow;
        const request = { controller, timer: null };
        pending.set(d.id, request);
        const answer = reply => {
            if ( ! live() ) { detach(); return; }
            if ( pending.get(d.id) !== request || controller.signal.aborted || nonce !== boundNonce || iframe.contentWindow !== frame ) return;
            try { frame.postMessage({ type: 'ezil.code.preview.url', v: 1, nonce: boundNonce, id: d.id, ...reply }, origin); } catch { /* gone */ }
        };
        request.timer = host.setTimeout(() => { answer({ error: 'timeout' }); cancel(d.id); }, 240000);
        void (async () => {
            try {
                const result = await mint(computerId, { signal: controller.signal });
                if ( result?.ok === true ) {
                    answer(validatePreviewMintReply({ url: result.url, expiresAt: result.expiresAt }) ?? { error: 'app_preview_invalid' });
                } else {
                    answer({ error: errorCode(result?.errorCode) ? result.errorCode : 'app_preview_unavailable' });
                }
            } catch { answer({ error: 'app_preview_unavailable' }); }
            finally { if ( pending.get(d.id) === request ) forget(d.id); }
        })();
    }
    host.addEventListener('message', onMessage);
    iframe.addEventListener('load', hello);
    bridges.set(iframe, detach);
    hello();
    return detach;
}
