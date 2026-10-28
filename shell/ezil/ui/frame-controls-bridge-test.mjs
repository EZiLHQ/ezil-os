// Run: node shell/ezil/ui/frame-controls-bridge-test.mjs
// Exercise the actual message boundary (docs/FEEDBACK-CONTROLS-CONTRACT.md:84),
// because accepting a stale frame's PNG would attach the wrong desktop to feedback.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const sourceCode = readFileSync(new URL('./frame-controls-bridge.js', import.meta.url), 'utf8');
let sequence = 0;
const origin = 'https://test-nekodesktop.ezil.org';

async function harness(t) {
    const dom = new JSDOM('<iframe></iframe>', { url: 'https://os.ezil.org/os' });
    const win = dom.window;
    const oldWindow = globalThis.window, oldBlob = globalThis.Blob;
    globalThis.window = win;
    globalThis.Blob = win.Blob;
    const listeners = new Set();
    const add = win.addEventListener.bind(win), remove = win.removeEventListener.bind(win);
    win.addEventListener = (type, fn, options) => {
        if (type === 'message') listeners.add(fn);
        return add(type, fn, options);
    };
    win.removeEventListener = (type, fn, options) => {
        if (type === 'message') listeners.delete(fn);
        return remove(type, fn, options);
    };
    const iframe = win.document.querySelector('iframe');
    const sent = [];
    iframe.contentWindow.postMessage = (data, targetOrigin) => sent.push({ data, targetOrigin });
    const bridge = await import(`data:text/javascript;base64,${Buffer.from(sourceCode).toString('base64')}#${sequence++}`);
    const reply = (data = {}, event = {}) => win.dispatchEvent(new win.MessageEvent('message', {
        origin, source: iframe.contentWindow,
        data: { source: 'ezil-mobile', type: 'frame_capture_result', nonce: sent.at(-1)?.data.nonce, ...data },
        ...event,
    }));
    t.after(() => {
        bridge.register_capture_target(null, '');
        assert.equal(listeners.size, 0, 'no message listener survives cleanup');
        dom.window.close();
        globalThis.window = oldWindow;
        globalThis.Blob = oldBlob;
    });
    return { ...bridge, win, iframe, sent, reply, listeners };
}

test('classification requires the exact origin, source, namespace and notification type', async t => {
    const h = await harness(t);
    const source = h.iframe.contentWindow;
    const expected = { origin, source };
    for (const type of ['edge_reveal', 'controls_hotkey']) {
        const event = { origin, source, data: { source: 'ezil-mobile', type } };
        assert.deepEqual(h.classify_frame_controls_message(event, expected), { type });
        for (const changed of [
            { origin: `${origin}.attacker.test` }, { origin: 'null' }, { source: h.win }, { source: null },
            { data: null }, { data: { source: 'ezil-shell', type } },
            { data: { source: 'ezil-mobile', type: 'frame_capture_result' } },
            { data: { source: 'ezil-mobile', type: 'peer_state' } },
        ]) assert.equal(h.classify_frame_controls_message({ ...event, ...changed }, expected), null);
    }
    assert.equal(h.classify_frame_controls_message(null, expected), null);
});

test('capture posts only to the registered origin and ignores spoofed replies before the matching Blob', async t => {
    const h = await harness(t);
    h.register_capture_target(h.iframe, origin);
    const pending = h.request_frame_capture();
    assert.equal(h.listeners.size, 1);
    assert.equal(h.sent.length, 1);
    const { data, targetOrigin } = h.sent[0];
    assert.equal(targetOrigin, origin);
    assert.deepEqual(Object.keys(data).sort(), ['nonce', 'source', 'type']);
    assert.equal(data.source, 'ezil-shell');
    assert.equal(data.type, 'frame_capture_request');
    assert.ok(typeof data.nonce === 'string' && data.nonce.length > 0 && data.nonce.length <= 64);
    const blob = new h.win.Blob(['PNG'], { type: 'image/png' });
    h.reply({ blob, nonce: 'wrong' });
    h.reply({ blob }, { origin: 'https://attacker.test' });
    h.reply({ blob }, { source: h.win });
    h.reply({ blob, source: 'ezil-shell' });
    h.reply({ blob, type: 'stream_vitals' });
    assert.equal(h.listeners.size, 1, 'mismatches leave the real request pending');
    h.reply({ blob });
    assert.equal(await pending, blob);
    assert.equal(h.listeners.size, 0);
});

test('matching null or non-Blob result fails closed and removes the listener', async t => {
    const h = await harness(t);
    h.register_capture_target(h.iframe, origin);
    for (const blob of [null, {}, 'data:image/png;base64,AAAA', undefined]) {
        const pending = h.request_frame_capture();
        h.reply({ blob });
        assert.equal(await pending, null);
        assert.equal(h.listeners.size, 0);
    }
});

test('timeout after only mismatched traffic returns null and removes its listener', async t => {
    const h = await harness(t);
    h.register_capture_target(h.iframe, origin);
    const pending = h.request_frame_capture({ timeoutMs: 15 });
    h.reply({ nonce: 'stale', blob: new h.win.Blob(['PNG']) });
    assert.equal(await pending, null);
    assert.equal(h.listeners.size, 0);
});

test('a new request or target settles the old request, keeping at most one listener', async t => {
    const h = await harness(t);
    h.register_capture_target(h.iframe, origin);
    const first = h.request_frame_capture();
    const oldNonce = h.sent[0].data.nonce;
    const second = h.request_frame_capture();
    assert.equal(await first, null);
    assert.equal(h.listeners.size, 1);
    assert.notEqual(h.sent[1].data.nonce, oldNonce);
    h.reply({ nonce: oldNonce, blob: new h.win.Blob(['old']) });
    assert.equal(h.listeners.size, 1);
    const next = h.win.document.createElement('iframe');
    h.win.document.body.appendChild(next);
    const nextSent = [];
    next.contentWindow.postMessage = (data, targetOrigin) => nextSent.push({ data, targetOrigin });
    h.register_capture_target(next, 'https://next-nekodesktop.ezil.org');
    assert.equal(await second, null);
    const third = h.request_frame_capture();
    const blob = new h.win.Blob(['new']);
    h.reply({ nonce: nextSent[0].data.nonce, blob }, {
        origin: nextSent[0].targetOrigin, source: next.contentWindow,
    });
    assert.equal(await third, blob);
    assert.equal(h.listeners.size, 0);
});

test('missing targets, wildcard origins and postMessage failures return null without leaking listeners', async t => {
    const h = await harness(t);
    assert.equal(await h.request_frame_capture(), null);
    for (const invalid of ['*', 'null', `${origin}/path`, 'data:text/plain,hello']) {
        h.register_capture_target(h.iframe, invalid);
        assert.equal(await h.request_frame_capture(), null);
    }
    assert.equal(h.sent.length, 0);
    h.register_capture_target(h.iframe, origin);
    h.iframe.contentWindow.postMessage = () => { throw new Error('frame closed'); };
    assert.equal(await h.request_frame_capture(), null);
    assert.equal(h.listeners.size, 0);
});

test('cancellation removes the listener and stale replies cannot complete a later capture', async t => {
    const h = await harness(t);
    h.register_capture_target(h.iframe, origin);
    const controller = new AbortController();
    const pending = h.request_frame_capture({ signal: controller.signal });
    const nonce = h.sent[0].data.nonce;
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(h.listeners.size, 0);
    assert.equal(await h.request_frame_capture({ signal: controller.signal }), null);
    assert.equal(h.sent.length, 1, 'already cancelled requests send nothing');
    const next = h.request_frame_capture();
    h.reply({ nonce, blob: new h.win.Blob(['old']) });
    assert.equal(h.listeners.size, 1);
    const blob = new h.win.Blob(['new']);
    h.reply({ blob });
    assert.equal(await next, blob);
    assert.equal(h.listeners.size, 0);
});

test('a capture target counts as registered only while its iframe is attached (round-3 F4)', async t => {
    const h = await harness(t);
    assert.equal(h.capture_target_registered(), false, 'nothing registered by default');
    h.register_capture_target(h.iframe, origin);
    assert.equal(h.capture_target_registered(), true);
    h.iframe.remove();
    assert.equal(h.capture_target_registered(), false, 'a detached frame is not a target');
    h.register_capture_target(null, '');
    assert.equal(h.capture_target_registered(), false);
});
