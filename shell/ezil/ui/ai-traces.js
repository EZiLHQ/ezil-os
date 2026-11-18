import { validateInferenceTrace } from '../../../app/src/server/ai-traces/contract.js';

// Memory only, separate from feedback consent, errors and billing. No import-time listeners.
export function create_ai_trace_collector ({ fetchImpl = (...args) => fetch(...args), now = () => Date.now(), timer = setTimeout, cancelTimer = clearTimeout } = {}) {
    const registrations = new WeakMap();
    const rates = new WeakMap();
    const active = new Set();
    const seen = new Map();
    const queue = [];
    let pending = null;
    let sending = false;
    function schedule () {
        if (pending === null && queue.length) pending = timer(() => { pending = null; void flush(); }, 2000);
    }
    async function flush () {
        if (sending || !queue.length) return;
        sending = true;
        const traces = queue.splice(0, 8);
        try {
            await fetchImpl('/api/shell/ai-traces', { method: 'POST', credentials: 'same-origin',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, traces }),
                signal: AbortSignal.timeout(5000), keepalive: true });
        } catch { /* Drop, never retry or delay inference. */ }
        finally { sending = false; schedule(); }
    }
    function register (iframe, { origin } = {}) {
        registrations.get(iframe)?.dispose();
        const empty = { bindNonce () {}, dispose () {} };
        try {
            if (!iframe?.ownerDocument?.defaultView || !['https:', 'http:'].includes(new URL(origin).protocol)
                || new URL(origin).origin !== origin || origin === 'null' || new URL(iframe.src).origin !== origin) return empty;
        } catch { return empty; }
        const host = iframe.ownerDocument.defaultView;
        const src = iframe.src;
        let nonce = null;
        let disposed = false;
        const live = () => !disposed && iframe.isConnected && !!iframe.contentWindow && iframe.src === src;
        const registration = {
            bindNonce (value) { nonce = typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.exec(value)?.[0] === value ? value : null; },
            dispose () {
                disposed = true; nonce = null;
                host.removeEventListener('message', receive);
                host.removeEventListener('ezil:teardown', registration.dispose);
                active.delete(registration);
                if (registrations.get(iframe) === registration) registrations.delete(iframe);
                if (!active.size) { queue.length = 0; seen.clear(); if (pending !== null) cancelTimer(pending); pending = null; }
            },
        };
        function receive (event) {
            try {
                if (!live()) { registration.dispose(); return; }
                if (!event.source || event.source !== iframe.contentWindow || event.origin === 'null' || event.origin !== origin) return;
                const d = event.data;
                if (!d || typeof d !== 'object' || Array.isArray(d) || Reflect.ownKeys(d).length !== 4
                    || !['type','v','nonce','trace'].every(k => Object.hasOwn(d, k))
                    || d.type !== 'ezil.code.aiTrace' || d.v !== 1 || !nonce || d.nonce !== nonce) return;
                const at = now();
                const rate = (rates.get(iframe) ?? []).filter(t => at - t < 60_000);
                if (rate.length >= 120) return;
                rate.push(at); rates.set(iframe, rate);
                if (new TextEncoder().encode(JSON.stringify(d)).byteLength > 4096) return;
                const trace = validateInferenceTrace(d.trace);
                if (!trace) return;
                for (const [id, time] of seen) if (at - time >= 60_000) seen.delete(id);
                if (seen.has(trace.requestId)) return;
                if (seen.size >= 512) seen.delete(seen.keys().next().value);
                seen.set(trace.requestId, at);
                if (queue.length >= 64) queue.shift();
                queue.push(trace); schedule();
            } catch { /* Hostile input and disappearing frames are optional telemetry. */ }
        }
        registrations.set(iframe, registration); active.add(registration);
        host.addEventListener('message', receive);
        host.addEventListener('ezil:teardown', registration.dispose);
        return registration;
    }
    return { register, flush };
}
export const ai_trace_collector = create_ai_trace_collector();
