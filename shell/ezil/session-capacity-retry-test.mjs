// session-capacity-retry-test.mjs — EZiL-authored (RETRY-118).
//
// Run:  node --test shell/ezil/session-capacity-retry-test.mjs
//
// `capacity_attempt_expired` is terminal for every AUTOMATIC path (the wake loop,
// the one transport retry): none of them may call the reset. Only `userRetry`, the
// shared handler of every surface's "Try again", resets exactly the stored attempt,
// once, and then reopens once, whatever the reset answered.
import assert from 'node:assert/strict';
import test from 'node:test';

const RETRY = '/api/shell/capacity-retry';
const ATTEMPT = '0b5d8a3e-1d2c-4f5a-9b6c-7d8e9f0a1b2c';
const boot = (endpoints) => ({ user: { id: 'u-1' }, computer: { id: 'computer-1' }, desktopState: { endpoints } });
globalThis.window = { __EZIL_BOOT__: boot({ capacityRetry: RETRY }) };
const session = await import('./session.js');
const { openDesktop, previewUrl, withWakeAndOneRetry, userRetry, retryCapacityAttempt, capacityRetryEndpoint, pendingOrRefused, readCapacityResetReply } = session;

const expired = { ok: false, errorCode: 'capacity_attempt_expired', error: 'capacity_attempt_expired', capacityAttemptId: ATTEMPT };

/** Every network call is intercepted; returns the recorded calls. */
function stubFetch (answer) {
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
        calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null });
        const data = typeof answer === 'function' ? await answer(String(url)) : answer;
        return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
    };
    return calls;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

for (const surface of ['Browser', 'Preview', 'Code']) {
    await test(`${surface}: the automatic path keeps capacity_attempt_expired terminal and never resets`, async () => {
        const calls = stubFetch((url) => (url === RETRY ? { ok: true, outcome: 'reset' } : expired));
        const result = surface === 'Browser' ? await openDesktop('computer-1')
            : surface === 'Preview' ? await previewUrl('computer-1')
            : await withWakeAndOneRetry(async () => pendingOrRefused(expired), 'codePreviewUrl', 'computer-1');
        assert.equal(result.errorCode, 'capacity_attempt_expired');
        assert.equal(result.capacityAttemptId, ATTEMPT, 'the id reaches the surface for its explicit Retry');
        assert.equal(calls.filter((c) => c.url === RETRY).length, 0, 'no reset from polling or the transport retry');
        assert.ok(calls.length <= 1, `asked once, never retried automatically (${calls.length})`);
    });
}

await test('only capacity_attempt_expired carries an attempt id through the session', () => {
    assert.equal(pendingOrRefused({ ok: false, errorCode: 'capacity_unavailable', capacityAttemptId: ATTEMPT }).capacityAttemptId, undefined);
    assert.equal(pendingOrRefused(expired).capacityAttemptId, ATTEMPT);
});

await test('userRetry: one window\'s double click resets once with the stored id, THEN reopens that window once', async () => {
    let release;
    const calls = stubFetch(() => new Promise((r) => { release = () => r({ ok: true, outcome: 'reset' }); }));
    let reopened = 0;
    const reopen = () => { reopened++; }; // stable per window, as the apps define it
    const first = userRetry('computer-1', expired, reopen);
    const second = userRetry('computer-1', expired, reopen); // the same window, clicked again while in flight
    await tick();
    assert.equal(reopened, 0, 'never reopened before the reset settled');
    assert.deepEqual(calls.map((c) => [c.url, c.method, c.body]), [[RETRY, 'POST', { computerId: 'computer-1', attemptId: ATTEMPT }]]);
    release();
    assert.deepEqual(await first, { reset: true, outcome: 'reset' });
    await second;
    assert.equal(reopened, 1, 'one reopen for the joined clicks');
    assert.equal(calls.length, 1);
});

await test('root P2 repro: Retry in Code, then in Browser, then Code closes → ONE reset and Browser still reopens once', async () => {
    let release;
    const calls = stubFetch(() => new Promise((r) => { release = () => r({ ok: true, outcome: 'reset' }); }));
    const windows = Object.fromEntries(['code', 'browser'].map((name) => {
        const w = { disposed: false, boots: 0, reopens: 0 };
        w.reopen = () => { w.reopens++; if ( ! w.disposed ) w.boots++; }; // mirrors `if ( ! disposed ) void start_boot()`
        return [name, w];
    }));
    const a = userRetry('computer-1', expired, windows.code.reopen);
    const b = userRetry('computer-1', expired, windows.browser.reopen);
    const b2 = userRetry('computer-1', expired, windows.browser.reopen); // and a double click in Browser
    windows.code.disposed = true; // Code closes while the reset is pending
    await tick();
    release();
    await Promise.all([a, b, b2]);
    assert.equal(calls.filter((c) => c.url === RETRY).length, 1, 'the reset is shared per computer+attempt');
    assert.equal(windows.browser.boots, 1, 'the still-open Browser reopens exactly once');
    assert.equal(windows.browser.reopens, 1);
    assert.equal(windows.code.boots, 0, 'the closed Code window does not boot');
});

await test('different attempts on the same computer are separate resets; the same attempt on two computers too', async () => {
    const calls = stubFetch({ ok: true, outcome: 'reset' });
    const other = { ...expired, capacityAttemptId: '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c' };
    await Promise.all([userRetry('computer-1', expired, () => {}), userRetry('computer-1', other, () => {}),
        userRetry('computer-2', expired, () => {})]);
    assert.deepEqual(calls.map((c) => c.body).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))), [
        { computerId: 'computer-1', attemptId: ATTEMPT }, { computerId: 'computer-1', attemptId: other.capacityAttemptId },
        { computerId: 'computer-2', attemptId: ATTEMPT }].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))));
});

await test('reset replies are read strictly: app-level ok must match a known outcome', () => {
    const cases = [
        [{ ok: true, outcome: 'reset' }, { reset: true, outcome: 'reset' }],
        [{ ok: true, outcome: 'already_reset' }, { reset: false, outcome: 'already_reset' }],
        [{ ok: true, outcome: 'superseded' }, { reset: false, outcome: 'superseded' }],
        [{ ok: false, outcome: 'not_found' }, { reset: false, outcome: 'not_found' }],
        [{ ok: false, outcome: 'reset' }, { reset: false, errorCode: 'malformed_reply' }],
        [{ ok: true, outcome: 'not_found' }, { reset: false, errorCode: 'malformed_reply' }],
        [{ ok: 1, outcome: 'reset' }, { reset: false, errorCode: 'malformed_reply' }],
        [{ ok: true, outcome: 'done' }, { reset: false, errorCode: 'malformed_reply' }],
        [{ ok: true, outcome: 'constructor' }, { reset: false, errorCode: 'malformed_reply' }],
        [{ ok: true }, { reset: false, errorCode: 'malformed_reply' }],
        [null, { reset: false, errorCode: 'malformed_reply' }],
        ['reset', { reset: false, errorCode: 'malformed_reply' }],
    ];
    for (const [reply, expected] of cases) assert.deepEqual(readCapacityResetReply(reply), expected, JSON.stringify(reply));
});

await test('an HTTP-200 {ok:false, outcome:"reset"} is malformed, never a reset, and still reopens once', async () => {
    stubFetch({ ok: false, outcome: 'reset' });
    let reopened = 0;
    assert.deepEqual(await userRetry('computer-1', expired, () => { reopened++; }), { reset: false, errorCode: 'malformed_reply' });
    assert.equal(reopened, 1);
});

for (const outcome of ['already_reset', 'superseded', 'not_found']) {
    await test(`userRetry: ${outcome} still reopens once and never asks twice`, async () => {
        const calls = stubFetch({ ok: outcome !== 'not_found', outcome });
        let reopened = 0;
        assert.deepEqual(await userRetry('computer-1', expired, () => { reopened++; }), { reset: false, outcome });
        assert.equal(reopened, 1);
        assert.equal(calls.length, 1);
    });
}

await test('userRetry: a transport failure of the reset still reopens (the next open is the truth)', async () => {
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    let reopened = 0;
    const result = await userRetry('computer-1', expired, () => { reopened++; });
    assert.equal(result.reset, false);
    assert.equal(reopened, 1);
});

await test('userRetry: any other failure, or no stored id, reopens immediately without a reset request', async () => {
    const calls = stubFetch({ ok: true, outcome: 'reset' });
    for (const failure of [null, { ok: false, errorCode: 'capacity_unavailable' }, { ...expired, capacityAttemptId: undefined },
        { ...expired, capacityAttemptId: '' }, { ok: false, errorCode: 'region_capacity', capacityAttemptId: ATTEMPT }]) {
        let reopened = 0;
        assert.deepEqual(await userRetry('computer-1', failure, () => { reopened++; }), { reset: false });
        assert.equal(reopened, 1, JSON.stringify(failure));
    }
    assert.equal(calls.length, 0);
});

await test('userRetry: an unpublished capacityRetry endpoint is never invented; Retry just reopens', async () => {
    globalThis.window.__EZIL_BOOT__ = boot({});
    try {
        const calls = stubFetch({ ok: true, outcome: 'reset' });
        assert.equal(capacityRetryEndpoint(), null);
        let reopened = 0;
        await userRetry('computer-1', expired, () => { reopened++; });
        assert.equal(reopened, 1);
        assert.deepEqual(await retryCapacityAttempt('computer-1', expired), { reset: false });
        assert.equal(calls.length, 0);
    } finally {
        globalThis.window.__EZIL_BOOT__ = boot({ capacityRetry: RETRY });
    }
});
