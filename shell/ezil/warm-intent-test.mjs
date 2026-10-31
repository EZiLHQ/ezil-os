// warm-intent-test.mjs — EZiL-authored. Phase B r8 (REVERSE-MOVE-CONTRACT §5.9, Option C) and r9 (the opt-in trigger).
//
// Run:  node --test shell/ezil/warm-intent-test.mjs   (or plain `node`; no bundle, no browser)
//
// The next open of a held Free computer starts moving its files to the Free computer, which cannot be undone. Since r9
// the server starts it only for an ask that says `intent: 'open'` (a tab still running an older bundle sends none and
// gets the D16 hold). The Browser icon's warm (`warm.js`, fired on a hover or press) is not that open. So:
//   - every ask `warm()` sends carries `intent: 'warm'`, and the server answers a computer whose open would move it with
//     the stop hold's `computer_stopped` (no row, no boot); the warm drops it, with no telemetry;
//   - r9: a real open (`session.openDesktop` from a window, or `claim()`'s own mint) carries `intent: 'open'`;
//   - a claimed warm never carries the warm marker into the click: its later asks say `'open'` instead, and when the
//     warm's answer was `computer_stopped` the claiming window gets a real open's answer instead, never that one;
//   - r9: a status poll, a frame check, a restart and an app-preview ask carry no intent at all.
import assert from 'node:assert/strict';
import test from 'node:test';
import session from './session.js';
import telemetry from './telemetry.js';
import { warm, claim, isWarmHeld, _resetForTests } from './warm.js';

const C = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
/** The server's answer to a warm on a computer whose open would start the move (the stop hold's value). */
const HELD = { ok: false, error: 'computer_stopped', errorCode: 'computer_stopped', retryable: false,
    provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2' };
/** The click's open on that computer: the reverse waiting answer. */
const MOVING = { ok: false, error: 'computer_moving', errorCode: 'sandbox_starting', retryable: true,
    provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2', computeMoving: true };
const STARTING = { ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2' };
const READY = { ok: true, guacamoleUrl: 'https://viewer.example/', frame: { confirmed: true } };

/**
 * A fake network for `POST /api/shell/desktop`: `answer(body, n)` answers the n-th ask (1-based). Timers run at once.
 * Returns the bodies sent, in order, and the telemetry captured.
 */
function wire (t, answer) {
    const bodies = [];
    const captured = [];
    t.mock.method(globalThis, 'setTimeout', (fn) => { queueMicrotask(fn); return 0; });
    t.mock.method(telemetry, 'capture', (event) => { captured.push(event); });
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(String(url), '/api/shell/desktop', `only the desktop route is asked: ${url}`);
        assert.equal(init?.method, 'POST');
        const body = JSON.parse(init.body);
        bodies.push(body);
        return { ok: true, status: 200, json: async () => answer(body, bodies.length) };
    });
    _resetForTests();
    t.after(() => _resetForTests());
    return { bodies, captured };
}

/** Let every queued microtask (and the timers `wire` turns into microtasks) run. */
const settle = () => new Promise(resolve => setImmediate(resolve));

test('isWarmHeld: only a refusal coded computer_stopped (the stop hold\'s value)', () => {
    assert.equal(isWarmHeld(HELD), true);
    for ( const res of [MOVING, STARTING, READY, { ok: true, errorCode: 'computer_stopped' }, { ok: false, errorCode: 'billing_files_on_aws' }, null, undefined] ) {
        assert.equal(isWarmHeld(res), false, JSON.stringify(res));
    }
});

test('warm() sends the marker; the held answer is dropped silently: one ask, no telemetry, nothing replayed', async t => {
    const net = wire(t, () => HELD);
    warm(C);
    await settle();
    assert.deepEqual(net.bodies, [{ computerId: C, intent: 'warm' }]);
    assert.deepEqual(net.captured, [], 'a deterministic refusal: no silent re-ask, no failure telemetry');
    // Dropped like any failure: the next hover asks again (still a warm), it is never replayed as a result.
    warm(C);
    await settle();
    assert.deepEqual(net.bodies, [{ computerId: C, intent: 'warm' }, { computerId: C, intent: 'warm' }]);
});

test('r9: a real open says intent \'open\' (never the warm marker), with or without a signal, a screen or warm:false', async t => {
    const net = wire(t, () => READY);
    const signal = new AbortController().signal;
    assert.equal((await session.openDesktop(C, { width: 1280, height: 800 }, { signal })).ok, true);
    assert.equal((await session.openDesktop(C)).ok, true);
    assert.equal((await session.openDesktop(C, { width: 1280, height: 800 }, { signal, warm: false })).ok, true);
    assert.equal((await session.openDesktop(C, undefined, { warm: () => false })).ok, true);
    assert.deepEqual(net.bodies.map(b => JSON.stringify(b)), [
        JSON.stringify({ computerId: C, screen: { width: 1280, height: 800 }, intent: 'open' }),
        JSON.stringify({ computerId: C, intent: 'open' }),
        JSON.stringify({ computerId: C, screen: { width: 1280, height: 800 }, intent: 'open' }),
        JSON.stringify({ computerId: C, intent: 'open' }),
    ]);
    // claim() with no warm held mints the click's own open: intent 'open'.
    assert.equal((await claim(C)).ok, true);
    assert.deepEqual(net.bodies.at(-1), { computerId: C, intent: 'open' });
});

test('r9: every ask of a real open\'s wake loop says \'open\' (a re-ask after sandbox_starting too)', async t => {
    const net = wire(t, (_body, n) => (n === 1 ? STARTING : READY));
    assert.equal((await session.openDesktop(C)).ok, true);
    assert.deepEqual(net.bodies, [{ computerId: C, intent: 'open' }, { computerId: C, intent: 'open' }]);
});

test('the click after a dropped warm asks a real open (intent \'open\') and gets the move, never computer_stopped', async t => {
    const net = wire(t, body => (body.intent === 'warm' ? HELD : MOVING));
    warm(C);
    await settle();
    const res = await claim(C);
    assert.deepEqual(net.bodies, [{ computerId: C, intent: 'warm' }, { computerId: C, intent: 'open' }]);
    assert.equal(res.computeMoving, true, JSON.stringify(res));
    assert.notEqual(res.errorCode, 'computer_stopped');
});

test('🔴 a click that claims the warm IN FLIGHT never gets its computer_stopped: it asks a real open (intent \'open\')', async t => {
    const net = wire(t, body => (body.intent === 'warm' ? HELD : MOVING));
    warm(C); // the hover's ask is already on the wire, with the marker
    const res = await claim(C); // the click joins it
    assert.deepEqual(net.bodies, [{ computerId: C, intent: 'warm' }, { computerId: C, intent: 'open' }]);
    assert.equal(res.errorCode, 'sandbox_starting');
    assert.equal(res.computeMoving, true, 'the window gets the move (and takes the wait over on its own signal)');
    assert.deepEqual(net.captured, []);
});

test('a claimed warm that is still waking: its later asks say \'open\' (they are the click\'s), and the answer passes through', async t => {
    const net = wire(t, (_body, n) => (n === 1 ? STARTING : READY));
    warm(C);
    const res = await claim(C);
    assert.equal(res.ok, true);
    assert.deepEqual(net.bodies, [{ computerId: C, intent: 'warm' }, { computerId: C, intent: 'open' }]);
});

test('control: an unclaimed warm that is still waking keeps the marker on every ask', async t => {
    const net = wire(t, (_body, n) => (n === 1 ? STARTING : READY));
    warm(C);
    await settle();
    assert.deepEqual(net.bodies, [{ computerId: C, intent: 'warm' }, { computerId: C, intent: 'warm' }]);
    // Resolved ok and fresh: the click takes it as is (no second ask).
    assert.equal((await claim(C)).ok, true);
    assert.equal(net.bodies.length, 2);
});

test('a warm\'s other failures still reach a claiming window unchanged (only computer_stopped is re-asked)', async t => {
    const refusal = { ok: false, errorCode: 'billing_files_on_aws', computeProvider: 'aws-ec2' };
    const net = wire(t, () => refusal);
    warm(C);
    const res = await claim(C);
    assert.equal(res.errorCode, 'billing_files_on_aws');
    assert.deepEqual(net.bodies, [{ computerId: C, intent: 'warm' }]);
});

test('r9: a status poll, a frame check, a restart and an app-preview ask carry no intent (only a real open or a warm does)', async t => {
    const seen = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        seen.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body) });
        const path = String(url).split('?')[0];
        const data = path === '/api/shell/restart' ? { ok: true }
            : path === '/api/shell/preview-url' ? { ok: true, appPreviewUrl: 'https://app.example/preview-bootstrap?token=t' }
            : { ok: true, guacamoleRunning: true, confirmed: true, status: 200 };
        return { ok: true, status: 200, json: async () => data };
    });
    // The restart route is feature-detected from the boot payload (`restartEndpoint`); nothing else here reads it.
    const hadWindow = 'window' in globalThis;
    const before = globalThis.window;
    globalThis.window = { __EZIL_BOOT__: { user: { id: 'u1' }, desktopState: { endpoints: { restart: '/api/shell/restart' } } } };
    t.after(() => { if ( hadWindow ) globalThis.window = before; else delete globalThis.window; });
    await session.desktopRunning(C);
    await session.confirmFrame(C, 'https://viewer.example/');
    assert.equal((await session.restartDesktop(C)).ok, true);
    assert.equal((await session.previewUrl(C)).ok, true);
    assert.deepEqual(seen.map(r => `${r.method} ${r.url.split('?')[0]}`), [
        'GET /api/shell/desktop', 'GET /api/shell/desktop', 'POST /api/shell/restart', 'POST /api/shell/preview-url',
    ]);
    for ( const r of seen ) {
        assert.ok(! /[?&]intent=/.test(r.url), `no intent in the query: ${r.url}`);
        if ( r.body !== undefined ) assert.deepEqual(r.body, { computerId: C }, `${r.method} ${r.url}: no intent in the body`);
    }
});
