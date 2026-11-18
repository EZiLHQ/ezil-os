// Run: node shell/ezil/apps/code-preview-test.mjs (fake frame/window, like code-folder-test.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { attachPreviewMintBridge, validatePreviewMintReply } from './code-preview.js';
import { codePreviewBridgeScript } from '../../../worker/src/code-preview-bridge.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../docs/contracts/code-preview-v1.vectors.json', import.meta.url), 'utf8'));
let passed = 0, failed = 0;
async function check (name, fn) {
    try { await fn(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
const ORIGIN = 'https://8443-guac-u-c-code.ezil.org', ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const URL_REPLY = vectors.mintReply.accept[0];
function frame ({ mint = async () => ({ ok: true, ...URL_REPLY }), url = `${ORIGIN}/preview-bootstrap?token=t` } = {}) {
    const messages = new Set(), loads = new Set(), sent = [], calls = [];
    let now = 0, nextTimer = 0;
    const timers = new Map();
    const host = { addEventListener: (t, f) => messages.add(f), removeEventListener: (t, f) => messages.delete(f),
        setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimeout: id => timers.delete(id) };
    const iframe = { isConnected: true, src: url, ownerDocument: { defaultView: host },
        addEventListener: (t, f) => loads.add(f), removeEventListener: (t, f) => loads.delete(f),
        contentWindow: { postMessage: (data, origin) => sent.push({ data, origin }) } };
    const mintFn = (computerId, options) => { calls.push({ computerId, ...options }); return mint(computerId, options); };
    const attach = () => attachPreviewMintBridge({ iframe, frameUrl: url, computerId: 'own-computer', mint: mintFn });
    const detach = attach();
    const nonce = () => sent.filter(m => m.data.type === 'ezil.code.preview.hello').at(-1)?.data.nonce;
    const post = (data, over = {}) => { for (const f of messages) f({ data, source: iframe.contentWindow, origin: ORIGIN, ...over }); };
    const ready = () => post({ type: 'ezil.code.preview.ready', v: 1, nonce: nonce() });
    const ask = (id = ID, over = {}) => post({ type: 'ezil.code.preview.mint', v: 1, nonce: nonce(), id, ...over });
    const cancel = (id = ID, over = {}, owner = {}) => post({ type: 'ezil.code.preview.cancel', v: 1, nonce: nonce(), id, ...over }, owner);
    return { iframe, sent, calls, messages, loads, detach, attach, nonce, post, ready, ask, cancel, timers,
        advance: ms => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
        replies: () => sent.filter(m => m.data.type === 'ezil.code.preview.url'), load: () => { for (const f of loads) f(); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
for (const [i, r] of vectors.mintReply.accept.entries()) await check(`accept mintReply vector ${i}`, () => assert.deepEqual(validatePreviewMintReply(r), r));
for (const [i, r] of vectors.mintReply.refuse.entries()) await check(`refuse mintReply vector ${i}`, () => assert.equal(validatePreviewMintReply(r), null));
await check('hello pins the minted origin, waits for ready, and uses fresh nonces on load', async () => {
    const f = frame(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].origin, ORIGIN); assert.match(f.nonce(), /^[A-Za-z0-9_-]{22}$/);
    f.ask(); assert.equal(f.calls.length, 0); f.ready(); f.ask(); await flush();
    assert.equal(f.calls[0].computerId, 'own-computer'); assert.ok(f.calls[0].signal instanceof AbortSignal);
    assert.deepEqual(f.replies()[0], { data: { type: 'ezil.code.preview.url', v: 1, nonce: f.nonce(), id: ID, ...URL_REPLY }, origin: ORIGIN });
    const old = f.nonce(); f.load(); assert.notEqual(f.nonce(), old); assert.ok(f.sent.every(m => m.origin !== '*')); f.detach();
});
await check('spoofed sources/origins, stale nonce, malformed ready and request records are dropped', async () => {
    const f = frame(), ready = { type: 'ezil.code.preview.ready', v: 1, nonce: f.nonce() };
    for (const over of [{ source: {} }, { origin: '*' }, { origin: 'null' }, { origin: 'https://evil.test' }]) f.post(ready, over);
    f.post({ ...ready, extra: 1 }); f.ask(); assert.equal(f.calls.length, 0); f.ready();
    const request = { type: 'ezil.code.preview.mint', v: 1, nonce: f.nonce(), id: ID };
    for (const over of [{ source: {} }, { origin: 'https://evil.test' }]) f.post(request, over);
    for (const over of [{ nonce: 'stale' }, { v: 2 }, { id: ID + '\n' }, { id: 'short' }, { extra: 1 }]) f.ask(ID, over);
    for (const r of [...vectors.attachment.accept, ...vectors.attachment.refuse]) f.post(r);
    assert.equal(f.calls.length, 0); f.ask(); await flush(); assert.equal(f.calls.length, 1); f.detach();
});
await check('one mint and reply per id, even after resolution, with concurrent distinct requests', async () => {
    let finish; const f = frame({ mint: () => new Promise(resolve => { finish = resolve; }) }); f.ready();
    f.ask(); f.ask(); assert.equal(f.calls.length, 1); finish({ ok: true, ...URL_REPLY }); await flush();
    f.ask(); assert.equal(f.replies().length, 1); assert.equal(f.calls.length, 1); f.detach();
    const active = frame({ mint: () => new Promise(() => {}) }); active.ready(); active.ask(); active.ask('BBBBBBBBBBBBBBBBBBBBBB');
    assert.equal(active.calls.length, 2); active.detach(); assert.ok(active.calls.every(c => c.signal.aborted));
});
await check('at most six mints per rolling minute; loading does not reset the budget', async () => {
    const original = Date.now; let now = 1000; Date.now = () => now;
    const f = frame();
    try {
        f.ready(); for (let i = 0; i < 7; i++) f.ask(String(i).padStart(22, 'A'));
        assert.equal(f.calls.length, 6); f.load(); f.ready(); f.ask('BBBBBBBBBBBBBBBBBBBBBB'); assert.equal(f.calls.length, 6);
        now += 59999; f.ask('BBBBBBBBBBBBBBBBBBBBBB'); assert.equal(f.calls.length, 6);
        now++; f.ask('BBBBBBBBBBBBBBBBBBBBBB'); assert.equal(f.calls.length, 7); await flush();
    } finally { Date.now = original; f.detach(); }
});
await check('detach, reload and replacement abort old work and never deliver its answer', async () => {
    for (const action of ['detach', 'load', 'replace', 'src', 'remove']) {
        let finish; const f = frame({ mint: () => new Promise(resolve => { finish = resolve; }) }); f.ready(); f.ask();
        const nonce = f.nonce(); let detachNext;
        if (action === 'detach') f.detach();
        if (action === 'load') f.load();
        if (action === 'replace') detachNext = f.attach();
        if (action === 'src') { f.iframe.src += '&changed=1'; f.ask(); }
        if (action === 'remove') { f.iframe.isConnected = false; f.ask(); }
        assert.equal(f.calls[0].signal.aborted, true, action);
        finish({ ok: true, ...URL_REPLY }); await flush(); assert.deepEqual(f.replies(), []);
        f.post({ type: 'ezil.code.preview.mint', v: 1, nonce, id: 'BBBBBBBBBBBBBBBBBBBBBB' }); assert.equal(f.calls.length, 1);
        f.detach(); detachNext?.(); assert.equal(f.messages.size, 0); assert.equal(f.loads.size, 0);
    }
});
await check('navigation during mint cannot receive its token even without a load event', async () => {
    let finish; const f = frame({ mint: () => new Promise(resolve => { finish = resolve; }) }); f.ready(); f.ask();
    f.iframe.src += '&changed=1'; finish({ ok: true, ...URL_REPLY }); await flush();
    assert.deepEqual(f.replies(), []); assert.equal(f.calls[0].signal.aborted, true); f.detach();
});
await check('same-ID close aborts only its underlying mint, ignores late completion and allows reopen', async () => {
    const finishes = [];
    const f = frame({ mint: () => new Promise(resolve => finishes.push(resolve)) }); f.ready(); f.ask(); f.ask('BBBBBBBBBBBBBBBBBBBBBB');
    f.cancel(); f.cancel(); assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls[1].signal.aborted, false);
    assert.equal(f.timers.size, 1); f.ask(); assert.equal(f.calls.length, 2);
    finishes[0]({ ok: true, ...URL_REPLY }); await flush(); assert.deepEqual(f.replies(), []);
    f.ask('CCCCCCCCCCCCCCCCCCCCCC'); assert.equal(f.calls.length, 3);
    finishes[2]({ ok: true, ...URL_REPLY }); await flush(); assert.equal(f.replies()[0].data.id, 'CCCCCCCCCCCCCCCCCCCCCC');
    f.detach(); assert.equal(f.timers.size, 0); assert.equal(f.calls[1].signal.aborted, true);
});
await check('cancel rejects another owner, origin, nonce, unknown ID and open workspace schemas', async () => {
    const f = frame({ mint: () => new Promise(() => {}) }); f.ready(); f.ask();
    for (const owner of [{ source: {} }, { origin: 'https://evil.test' }, { origin: 'null' }, { origin: '*' }]) f.cancel(ID, {}, owner);
    for (const data of [{ v: 2 }, { nonce: 'stale' }, { id: 'short' }, { id: 'BBBBBBBBBBBBBBBBBBBBBB' },
        { computerId: 'other-computer' }, { workspace: '/other' }, { extra: true }]) f.cancel(ID, data);
    assert.equal(f.calls[0].signal.aborted, false); assert.equal(f.calls[0].computerId, 'own-computer');
    f.cancel(); assert.equal(f.calls[0].signal.aborted, true); f.detach();
});
await check('cancel bypasses the mint rate limit; stalled work times out, aborts and clears pending timers', async () => {
    const finishes = [], f = frame({ mint: () => new Promise(resolve => finishes.push(resolve)) }); f.ready();
    for (let i = 0; i < 6; i++) f.ask(String(i).padStart(22, 'A'));
    f.cancel('0'.padStart(22, 'A')); assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.timers.size, 5);
    f.advance(239999); assert.equal(f.calls[1].signal.aborted, false);
    f.advance(1); assert.ok(f.calls.every(c => c.signal.aborted)); assert.equal(f.timers.size, 0);
    assert.equal(f.replies().length, 5); assert.ok(f.replies().every(r => r.data.error === 'timeout'));
    for (const finish of finishes) finish({ ok: true, ...URL_REPLY }); await flush(); assert.equal(f.replies().length, 5);
    f.detach();
});
for (const port of [3000, 9223, 8443]) await check(`refuses CF and AWS ${port} minted URLs as app_preview_invalid`, async () => {
    for (const url of [`https://${port}-guac-u-c-app.ezil.org/`, `https://aws-${port}-guac-u-c-aws.ezil.org/`]) {
        const f = frame({ mint: async () => ({ ok: true, url, expiresAt: 1 }) }); f.ready(); f.ask(); await flush();
        assert.equal(f.replies()[0].data.error, 'app_preview_invalid'); assert.equal(f.replies()[0].data.url, undefined); f.detach();
    }
});
await check('accepts AWS app URLs; refuses credentials, explicit ports, bad expiry and extra reply fields', () => {
    assert.deepEqual(validatePreviewMintReply({ url: 'https://aws-3002-guac-u-c-aws.ezil.org/', expiresAt: 1 }),
        { url: 'https://aws-3002-guac-u-c-aws.ezil.org/', expiresAt: 1 });
    for (const url of ['https://u:p@3002-guac-u-c-app.ezil.org/', 'https://3002-guac-u-c-app.ezil.org:3002/', 'https://3002-guac-u-c-app.ezil.org/\n'])
        assert.equal(validatePreviewMintReply({ url, expiresAt: 1 }), null);
    for (const expiresAt of [undefined, null, '1', 0, -1, 1.5, Infinity]) assert.equal(validatePreviewMintReply({ ...URL_REPLY, expiresAt }), null);
    assert.equal(validatePreviewMintReply({ ...URL_REPLY, command: 'x' }), null);
});
await check('maps only bounded snake-case error codes; rejects invalid results and thrown/rejected mint calls', async () => {
    for (const [errorCode, expected] of [['app_preview_starting', 'app_preview_starting'], ['Not A Code', 'app_preview_unavailable'],
        ['a'.repeat(41), 'app_preview_unavailable'], ['valid\n', 'app_preview_unavailable'], [undefined, 'app_preview_unavailable']]) {
        const f = frame({ mint: async () => ({ ok: false, errorCode }) }); f.ready(); f.ask(); await flush();
        assert.equal(f.replies()[0].data.error, expected); f.detach();
    }
    for (const mint of [() => { throw Error('private'); }, async () => { throw Error('private'); }, async () => null]) {
        const f = frame({ mint }); f.ready(); f.ask(); await flush(); assert.equal(f.replies()[0].data.error, 'app_preview_unavailable'); f.detach();
    }
});
await check('renderer-format close/timeout traverses the injected bridge and aborts the real session.previewUrl fetch', async () => {
    const { previewUrl } = await import('../session.js');
    const originalFetch = globalThis.fetch, requests = [], listeners = new Map(), replies = [];
    globalThis.fetch = (url, options) => new Promise(resolve => requests.push({ url, options, resolve }));
    const f = frame({ mint: previewUrl }), shell = 'https://os.ezil.work';
    const parent = { postMessage(data, origin) { assert.equal(origin, shell); f.post(structuredClone(data)); } };
    const codeWindow = { parent, addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
        dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event); return !event.defaultPrevented; } };
    const deliver = data => codeWindow.dispatchEvent({ type: 'message', data: structuredClone(data), source: parent, origin: shell });
    const originalPost = f.iframe.contentWindow.postMessage;
    f.iframe.contentWindow.postMessage = (data, origin) => { originalPost(data, origin); deliver(data); };
    const host = f.iframe.ownerDocument.defaultView;
    try {
        runInNewContext(codePreviewBridgeScript([shell]), { window: codeWindow, URL, CustomEvent, Date,
            setTimeout: host.setTimeout, clearTimeout: host.clearTimeout });
        codeWindow.addEventListener('ezil-preview-mint-reply', ev => replies.push(JSON.parse(ev.detail)));
        deliver(f.sent[0].data);
        const dispatch = (type, id) => codeWindow.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify({ v: 1, id }), cancelable: true }));
        const resolve = index => requests[index].resolve({ ok: true, json: async () => ({ ok: true, appPreviewUrl: URL_REPLY.url, expiresAt: URL_REPLY.expiresAt }) });
        assert.equal(dispatch('ezil-preview-mint', ID), false); await flush();
        assert.equal(requests[0].url, '/api/shell/preview-url');
        assert.deepEqual(JSON.parse(requests[0].options.body), { computerId: 'own-computer' });
        dispatch('ezil-preview-mint-cancel', ID);
        assert.equal(requests[0].options.signal.aborted, true); assert.equal(f.timers.size, 0);
        resolve(0); await flush(); assert.deepEqual(replies, []);
        const reopened = 'BBBBBBBBBBBBBBBBBBBBBB';
        assert.equal(dispatch('ezil-preview-mint', reopened), false); await flush();
        assert.equal(requests[1].options.signal.aborted, false); resolve(1); await flush();
        assert.equal(replies.length, 1); assert.equal(replies[0].id, reopened); assert.equal(f.timers.size, 0);
        const timedOut = 'CCCCCCCCCCCCCCCCCCCCCC';
        dispatch('ezil-preview-mint', timedOut); await flush(); f.advance(240000);
        assert.equal(requests[2].options.signal.aborted, true); assert.equal(f.timers.size, 0);
        assert.deepEqual(replies.at(-1), { v: 1, id: timedOut, error: 'timeout' });
        resolve(2); await flush(); assert.equal(replies.length, 2);
    } finally { f.detach(); globalThis.fetch = originalFetch; }
});
console.log(`${passed} pass, ${failed} fail`);
if (failed) process.exitCode = 1;
