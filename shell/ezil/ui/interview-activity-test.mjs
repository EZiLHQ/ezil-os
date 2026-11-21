import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { create_interview_activity, idle_bucket } from './interview-activity.js';

const vectors = JSON.parse(readFileSync(new URL('../../../docs/contracts/interview-evidence-v1.vectors.json', import.meta.url)));
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REQ = '9d8e7f60-1a2b-4c3d-8e9f-a0b1c2d3e4f5';
const GW = 'e1d2c3b4-a5f6-4789-8a0b-1c2d3e4f5a6b';
const trace = (over = {}) => ({ requestId: REQ, gatewayRequestId: GW, modelAlias: 'claude-sonnet', durationMs: 6000, outcome: 'completed', requested: { read: 2, search: 1, write: 1, other: 0 }, ...over });

function setup ({ status = 202 } = {}) {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://os.test' });
    let t = 1_000_000;
    const calls = [];
    const activity = create_interview_activity({
        fetchImpl: async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { status, async json () { return { accepted: 1 }; } }; },
        now: () => t, timer: () => 1, cancelTimer: () => {}, win: dom.window,
    });
    const events = () => calls.flatMap(c => c.body.events);
    return { dom, calls, activity, events, adv: ms => { t += ms; } };
}

test('idle_bucket maps exactly the vectors.presenceIdleBuckets boundaries', () => {
    for (const { lastPresenceAgoMs, bucket } of vectors.presenceIdleBuckets) assert.equal(idle_bucket(lastPresenceAgoMs), bucket);
});

test('begin emits the initial visibility/focus/app/idle; flush posts them with interviewId and millisecond clientAt', async () => {
    const b = setup();
    b.activity.begin({ interviewId: 'iv-1' });
    await b.activity.flush();
    assert.equal(b.calls.length, 1);
    assert.equal(b.calls[0].url, '/api/shell/interview-events');
    assert.equal(b.calls[0].body.interviewId, 'iv-1');
    assert.deepEqual(b.calls[0].body.events.map(e => [e.type, JSON.stringify(e.data)]), [
        ['tab.visibility', '{"state":"visible"}'], ['window.focus', '{"focused":true}'],
        ['app.focus', '{"app":"code"}'], ['presence.idle', '{"bucket":"<15s"}'],
    ]);
    assert.ok(b.calls[0].body.events.every(e => AT.test(e.clientAt)));
});

test('sample emits a window.focus change and a growing presence-idle bucket (presence = visible AND focused)', async () => {
    const b = setup();
    b.activity.begin({ interviewId: 'iv-1' });
    await b.activity.flush();
    b.calls.length = 0;
    b.activity.sample({ visible: true, focused: false }); // blur: presence stops accruing
    b.adv(20000);
    b.activity.sample({ visible: true, focused: false }); // 20s idle -> 15-60s bucket
    await b.activity.flush();
    const seen = b.events().map(e => [e.type, JSON.stringify(e.data)]);
    assert.ok(seen.some(([t, d]) => t === 'window.focus' && d === '{"focused":false}'), 'window.focus false emitted');
    assert.ok(seen.some(([t, d]) => t === 'presence.idle' && d === '{"bucket":"15-60s"}'), 'idle grew to 15-60s');
    // positive control: coming back present re-focuses the window and resets the idle bucket.
    b.calls.length = 0;
    b.activity.sample({ visible: true, focused: true });
    await b.activity.flush();
    const recovered = b.events();
    assert.ok(recovered.some(e => e.type === 'window.focus' && e.data.focused === true), 'window.focus true on return');
    assert.ok(recovered.some(e => e.type === 'presence.idle' && e.data.bucket === '<15s'), 'idle reset to <15s');
});

test('note_trace forwards one agent.turn_end with tool-call COUNTS only, never content', async () => {
    const b = setup();
    b.activity.begin({ interviewId: 'iv-1' });
    await b.activity.flush();
    b.calls.length = 0;
    b.activity.note_trace(trace({ toolResults: [{ call: 'x' }], conversationId: 'secret' }));
    await b.activity.flush();
    const ev = b.events()[0];
    assert.equal(ev.type, 'agent.turn_end');
    assert.deepEqual(ev.data, { requestId: REQ, gatewayRequestId: GW, modelAlias: 'claude-sonnet', durationMs: 6000, outcome: 'completed', toolCalls: { read: 2, search: 1, write: 1, other: 0 } });
    assert.ok(! ('content' in ev.data) && ! ('toolResults' in ev.data) && ! ('conversationId' in ev.data));
});

test('ezil:window-focus sets app.focus from data-app (unknown when absent); ezil:interview-ai-trace forwards a trace', async () => {
    const b = setup();
    b.activity.begin({ interviewId: 'iv-1' });
    await b.activity.flush();
    b.calls.length = 0;
    const el = b.dom.window.document.createElement('div');
    el.setAttribute('data-app', 'settings');
    b.dom.window.dispatchEvent(new b.dom.window.CustomEvent('ezil:window-focus', { detail: { window: el } }));
    const bare = b.dom.window.document.createElement('div');
    b.dom.window.dispatchEvent(new b.dom.window.CustomEvent('ezil:window-focus', { detail: { window: bare } }));
    b.dom.window.dispatchEvent(new b.dom.window.CustomEvent('ezil:interview-ai-trace', { detail: trace() }));
    await b.activity.flush();
    const seen = b.events();
    assert.deepEqual(seen.filter(e => e.type === 'app.focus').map(e => e.data), [{ app: 'settings' }, { app: 'unknown' }]);
    assert.equal(seen.filter(e => e.type === 'agent.turn_end').length, 1);
});

test('a 404 from the events route stops the recorder for good; ezil:teardown also stops it', async () => {
    const b = setup({ status: 404 });
    b.activity.begin({ interviewId: 'iv-1' });
    await b.activity.flush(); // posts the initial batch, receives 404
    assert.equal(b.calls.length, 1);
    assert.equal(b.activity.started, false);
    b.calls.length = 0;
    b.activity.sample({ visible: false, focused: false });
    b.activity.note_trace(trace());
    await b.activity.flush();
    assert.equal(b.calls.length, 0, 'nothing posts after a 404');

    const t = setup();
    t.activity.begin({ interviewId: 'iv-2' });
    t.dom.window.dispatchEvent(new t.dom.window.Event('ezil:teardown'));
    assert.equal(t.activity.started, false);
});

test('heartbeat enqueues session.heartbeat and batches never exceed 20', async () => {
    const b = setup();
    b.activity.begin({ interviewId: 'iv-1' });
    for (let i = 0; i < 25; i++) b.activity.heartbeat();
    for (let i = 0; i < 6; i++) await b.activity.flush();
    const sizes = b.calls.map(c => c.body.events.length);
    assert.ok(sizes.every(s => s <= 20), `all batches <= 20, got ${sizes}`);
    assert.ok(b.events().filter(e => e.type === 'session.heartbeat').length === 25);
});
