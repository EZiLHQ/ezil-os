import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { create_ai_trace_collector } from './ai-traces.js';
import { create_app_failure_store } from './feedback/app-failures.js';
const fixture = JSON.parse(readFileSync(new URL('../../../app/src/server/ai-traces/fixture.json', import.meta.url)));
const nonce = 'AAAAAAAAAAAAAAAAAAAAAA';
function setup({ failFetch = false } = {}) {
    const dom = new JSDOM('<iframe src="https://code.test/editor"></iframe>', { url: 'https://os.test' });
    const iframe = dom.window.document.querySelector('iframe');
    const calls = [];
    const collector = create_ai_trace_collector({ fetchImpl: async (...a) => { calls.push(a); if (failFetch) throw Error('offline'); }, timer: () => 1, cancelTimer: () => {} });
    const r = collector.register(iframe, { origin: 'https://code.test' }); r.bindNonce(nonce);
    const send = (trace = fixture, fields = {}, event = {}) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        source: iframe.contentWindow, origin: 'https://code.test', data: { type: 'ezil.code.aiTrace', v: 1, nonce, trace, ...fields }, ...event,
    }));
    return { dom, iframe, calls, collector, r, send };
}
test('strict source/origin/nonce/version/schema and no null-window equivalence; metadata reaches POST', async () => {
    const b = setup();
    for (const event of [{ source: null }, { source: b.dom.window }, { origin: 'null' }, { origin: 'https://forged.test' }]) b.send(fixture, {}, event);
    for (const fields of [{ nonce: 'wrong' }, { v: 2 }, { type: 'ezil.code.failure' }, { userId: 'spoof' }]) b.send(fixture, fields);
    b.send({ ...fixture, toolResults: 'secret' }); await b.collector.flush(); assert.equal(b.calls.length, 0);
    b.send(); b.send(); await b.collector.flush(); assert.equal(b.calls.length, 1);
    assert.deepEqual(JSON.parse(b.calls[0][1].body), { v: 1, traces: [fixture] });
    assert.equal(b.calls[0][0], '/api/shell/ai-traces'); b.r.dispose(); b.dom.window.close();
});
test('detached and navigated frames are rejected; registration and shared hello rotate the nonce', async () => {
    for (const change of [b => b.iframe.remove(), b => b.iframe.src = 'https://code.test/elsewhere']) {
        const b = setup(); change(b); b.send(); await b.collector.flush(); assert.equal(b.calls.length, 0); b.dom.window.close();
    }
    const b = setup(); const store = create_app_failure_store();
    const posted = []; b.iframe.contentWindow.postMessage = d => posted.push(d);
    const stop = store.register_app_frame(b.iframe, { origin: 'https://code.test', computerId: 'computer', appSession: 'session', app: 'code', onDiagnosticNonce: n => b.r.bindNonce(n) });
    b.send(); await b.collector.flush(); assert.equal(b.calls.length, 0);
    b.send(fixture, { nonce: posted.at(-1).nonce }); await b.collector.flush(); assert.equal(b.calls.length, 1);
    const old = posted.at(-1).nonce; b.iframe.dispatchEvent(new b.dom.window.Event('load'));
    assert.notEqual(old, posted.at(-1).nonce);
    b.send({ ...fixture, requestId: '10000000-0000-4000-8000-000000000002' }, { nonce: old });
    await b.collector.flush(); assert.equal(b.calls.length, 1); stop(); b.r.dispose(); b.dom.window.close();
});
test('flood caps queue at 64 and batches at 8, duplicates stay dropped across re-registration; network failure is soft', async () => {
    const b = setup();
    for (let i = 0; i < 200; i++) b.send({ ...fixture, requestId: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
    for (let i = 0; i < 10; i++) await b.collector.flush();
    assert.equal(b.calls.length, 8); assert.ok(b.calls.every(c => JSON.parse(c[1].body).traces.length === 8));
    const next = b.collector.register(b.iframe, { origin: 'https://code.test' }); next.bindNonce(nonce);
    b.send(); await b.collector.flush(); assert.equal(b.calls.length, 8); // per-frame flood budget survives re-register
    next.dispose(); b.dom.window.close();
    const failed = setup({ failFetch: true }); failed.send();
    await assert.doesNotReject(() => failed.collector.flush());
    await failed.collector.flush(); assert.equal(failed.calls.length, 1);
    failed.r.dispose(); failed.dom.window.close();
});
