// billing-recovery-test.mjs — EZiL-authored. Node + jsdom: the actual receiver for Code's billing requests (Free
// includes Gemini 3.8 Flash only). SYNTHETIC values only: no network, no bundle rebuild.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const M = await import('./billing-recovery.js');
let checks = 0;
async function check (name, run) { await run(); checks++; console.log(`PASS ${name}`); }

const UUID = '6f1d3a52-9b0e-4c1d-8a7b-2e5f4d3c2b1a';
const OTHER_UUID = '7a2e4b63-0c1f-4d2e-9b8c-3f6a5e4d3c2b';
await check('validate_billing_request: the known reasons, a lowercase UUID and a catalog alias; a fresh copy; never repaired', () => {
    for (const value of [{ reason: 'credits_exhausted' }, { reason: 'model_locked', model: 'gemini-3.1-pro' }, { reason: 'credits_exhausted', requestId: UUID }]) {
        const clean = M.validate_billing_request(value);
        assert.deepEqual(clean, value);
        assert.notEqual(clean, value);
    }
    for (const value of [null, undefined, 'credits_exhausted', [], { reason: 'topup' }, { reason: 'credits_exhausted', extra: 1 },
        { reason: 'credits_exhausted', requestId: UUID.toUpperCase() }, { reason: 'credits_exhausted', requestId: 'x' },
        { reason: 'model_locked', model: 'Gemini' }, { reason: 'model_locked', model: 'a/b' }, { reason: 'model_locked', model: 1 }]) {
        assert.equal(M.validate_billing_request(value), null, JSON.stringify(value));
    }
});

// The records every layer reads (worker/copilot-chat/billing-intent-vectors.json): what the Worker bridge posts
// (`expect`, asserted by its own test) is what this receiver keeps, unchanged; every refused record stays refused.
const vectors = JSON.parse(readFileSync(new URL('../../../../worker/copilot-chat/billing-intent-vectors.json', import.meta.url), 'utf8'));
await check('validate_billing_request: keeps exactly what the bridge posts for every shared record, refuses every refused one', () => {
    assert.ok(vectors.accept.length >= 8 && vectors.reject.length >= 20);
    for (const { expect } of vectors.accept) assert.deepEqual(M.validate_billing_request(expect), expect, JSON.stringify(expect));
    for (const record of vectors.reject) assert.equal(M.validate_billing_request(record), null, JSON.stringify(record));
});
await check('billing_recovery_context: a credit refusal asks for credits, a locked model for its plan, a credit window keeps its reset and never becomes a credit refusal', () => {
    const want = {
        credits_exhausted: e => ({ reason: 'insufficient_credits', ...(e.requestId ? { requestId: e.requestId } : {}) }),
        model_locked: e => ({ reason: 'model_locked', ...(e.requestId ? { requestId: e.requestId } : {}) }),
        window_limit: e => ({ reason: 'window_limit', ...(e.requestId ? { requestId: e.requestId } : {}), ...(e.resetsAt ? { resetsAt: e.resetsAt } : {}) }),
    };
    for (const { expect } of vectors.accept) assert.deepEqual(M.billing_recovery_context(expect), want[expect.reason](expect), JSON.stringify(expect));
});

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://os.test/os', pretendToBeVisual: true });
const { window } = dom;
for (const key of ['window', 'document', 'navigator', 'crypto', 'btoa']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : key === 'crypto' ? globalThis.crypto ?? window.crypto : key === 'btoa' ? globalThis.btoa : window[key] });
}
const ORIGIN = 'https://code.test';
function frame ({ open, now } = {}) {
    const iframe = document.createElement('iframe'); iframe.src = ORIGIN; document.body.append(iframe);
    const sent = [], opened = [];
    let clock = 0;
    iframe.contentWindow.postMessage = (data, origin) => sent.push({ data, origin });
    const unregister = M.register_billing_frame(iframe, { origin: ORIGIN, open: open ?? (request => { opened.push(request); }), now: now ?? (() => clock) });
    const nonce = () => sent.at(-1)?.data.nonce;
    const post = (data, overrides = {}) => window.dispatchEvent(new window.MessageEvent('message', { source: iframe.contentWindow, origin: ORIGIN, data, ...overrides }));
    return { iframe, sent, opened, unregister, nonce, post, advance: ms => { clock += ms; },
        ask: (intent, overrides) => post({ type: 'ezil.code.billing.intent', v: 1, nonce: nonce(), intent }, overrides),
        load: () => iframe.dispatchEvent(new window.Event('load')) };
}

try {
    await check('says hello to the frame at its own origin with a fresh 22-character nonce, again on each load', () => {
        const f = frame();
        assert.deepEqual(f.sent.map(m => [m.data.type, m.data.v, m.origin]), [['ezil.code.billing.hello', 1, ORIGIN]]);
        assert.match(f.nonce(), /^[A-Za-z0-9_-]{22}$/);
        const first = f.nonce(); f.load();
        assert.equal(f.sent.length, 2); assert.notEqual(f.nonce(), first);
        f.unregister();
    });

    await check('opens Billing once per accepted request; ignores other sources, origins, nonces, shapes and the ready', async () => {
        const f = frame();
        f.post({ type: 'ezil.code.billing.ready', v: 1, nonce: f.nonce() });
        f.ask({ reason: 'credits_exhausted', requestId: UUID }, { origin: 'https://evil.test' });
        f.ask({ reason: 'credits_exhausted', requestId: UUID }, { source: window });
        f.post({ type: 'ezil.code.billing.intent', v: 1, nonce: 'BBBBBBBBBBBBBBBBBBBBBB', intent: { reason: 'credits_exhausted' } });
        f.post({ type: 'ezil.code.billing.intent', v: 2, nonce: f.nonce(), intent: { reason: 'credits_exhausted' } });
        f.post({ type: 'ezil.code.billing.intent', v: 1, nonce: f.nonce(), intent: { reason: 'credits_exhausted' }, extra: true });
        f.ask({ reason: 'topup' });
        f.ask({ reason: 'credits_exhausted', extra: 1 });
        assert.deepEqual(f.opened, []);
        f.ask({ reason: 'credits_exhausted', requestId: UUID });
        assert.deepEqual(f.opened, [{ reason: 'credits_exhausted', requestId: UUID }]);
        f.unregister();
    });

    await check('one dialog per failure: a repeated request id never reopens; anything within 5 s of the last is dropped', () => {
        const f = frame();
        f.ask({ reason: 'credits_exhausted', requestId: UUID });
        f.ask({ reason: 'model_locked', model: 'gemini-3.1-pro' });
        f.advance(M.BILLING_REQUEST_GAP_MS);
        f.ask({ reason: 'credits_exhausted', requestId: UUID });
        f.ask({ reason: 'credits_exhausted', requestId: OTHER_UUID });
        assert.deepEqual(f.opened, [{ reason: 'credits_exhausted', requestId: UUID }, { reason: 'credits_exhausted', requestId: OTHER_UUID }]);
        f.unregister();
    });

    await check('a failing launcher stays inside; a detached or renavigated frame is unregistered; bad options register nothing', async () => {
        const failing = frame({ open: () => { throw new Error('launch failed'); } });
        failing.ask({ reason: 'credits_exhausted' });
        const rejecting = frame({ open: () => Promise.reject(new Error('launch failed')) });
        rejecting.ask({ reason: 'credits_exhausted' });
        await new Promise(resolve => setTimeout(resolve, 0));
        const f = frame();
        f.iframe.src = 'https://code.test/other';
        f.ask({ reason: 'credits_exhausted' });
        assert.deepEqual(f.opened, []);
        const iframe = document.createElement('iframe'); iframe.src = ORIGIN; document.body.append(iframe);
        for (const options of [{ origin: 'null', open () {} }, { origin: 'ftp://code.test', open () {} }, { origin: `${ORIGIN}/path`, open () {} }, { origin: ORIGIN }]) {
            const sent = []; iframe.contentWindow.postMessage = data => sent.push(data);
            M.register_billing_frame(iframe, options)();
            assert.deepEqual(sent, [], JSON.stringify(options));
        }
    });
} finally {
    window.close();
}
console.log(`${checks}/${checks} billing recovery checks passed (synthetic)`);
