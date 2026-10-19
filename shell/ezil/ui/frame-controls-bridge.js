// The frame owns the video DOM; the shell can only request a single image.
// Keep both directions pinned to docs/FEEDBACK-CONTROLS-CONTRACT.md:79.

let capture_target = null;
let pending_capture = null;

/** @returns {null | {type: 'edge_reveal'|'controls_hotkey'}} */
export function classify_frame_controls_message (ev, { origin, source }) {
    if (!ev || ev.origin !== origin || ev.source !== source || ev.data?.source !== 'ezil-mobile') return null;
    const type = ev.data.type;
    return type === 'edge_reveal' || type === 'controls_hotkey' ? { type } : null;
}

/** @param {HTMLIFrameElement} iframe @param {string} origin */
export function register_capture_target (iframe, origin) {
    if (capture_target?.iframe !== iframe || capture_target?.origin !== origin) pending_capture?.(null);
    capture_target = { iframe, origin };
}

/** @returns {Promise<Blob|null>} */
export async function request_frame_capture ({ timeoutMs = 4000 } = {}) {
    // Replacing a request settles its promise too, so rapid clicks never leave
    // listeners or images waiting behind a newer preview
    // (docs/FEEDBACK-CONTROLS-CONTRACT.md:82).
    pending_capture?.(null);
    const { iframe, origin } = capture_target || {};
    const source = iframe?.contentWindow;
    if (!source) return null;

    try {
        const url = new URL(origin);
        if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return null;
        const bytes = window.crypto.getRandomValues(new Uint8Array(16));
        const nonce = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        return await new Promise(resolve => {
            let timer;
            let settled = false;
            function settle (blob) {
                if (settled) return;
                settled = true;
                window.removeEventListener('message', on_message);
                clearTimeout(timer);
                if (pending_capture === settle) pending_capture = null;
                resolve(blob);
            }
            function on_message (ev) {
                const d = ev.data;
                // Unrelated traffic must not cancel a legitimate in-flight
                // capture; only the matching reply can settle it
                // (docs/FEEDBACK-CONTROLS-CONTRACT.md:87).
                if (ev.origin !== origin || ev.source !== source ||
                    d?.source !== 'ezil-mobile' || d.type !== 'frame_capture_result' || d.nonce !== nonce) return;
                settle(d.blob instanceof Blob ? d.blob : null);
            }
            pending_capture = settle;
            window.addEventListener('message', on_message);
            timer = setTimeout(() => settle(null), Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 4000);
            try {
                source.postMessage({ source: 'ezil-shell', type: 'frame_capture_request', nonce }, origin);
            } catch (_) {
                settle(null);
            }
        });
    } catch (_) {
        return null;
    }
}
