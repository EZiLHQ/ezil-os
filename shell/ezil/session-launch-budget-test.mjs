import assert from 'node:assert/strict';
import test from 'node:test';
import { openDesktop, previewUrl, withWakeAndOneRetry, pendingOrRefused,
    isComputeLaunching, isComputeMigrating, LAUNCH_DEADLINE_MS, LAUNCH_COPY } from './session.js';

const pending = { ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2' };
const launching = { ...pending, computeLaunching: true };
const ready = { ok: true, guacamoleUrl: 'https://desktop.example/', appPreviewUrl: 'https://app.example/' };
const surfaces = [['Desktop', openDesktop], ['Preview', previewUrl],
    ['Code mapper', id => withWakeAndOneRetry(async () => pendingOrRefused(await (await fetch('/code')).json()), 'codePreviewUrl', id)]];

async function run(t, { answer = () => launching, open = openDesktop, requestMs = 0, frozen = false, onWait } = {}) {
    let now = 0, asks = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
        onWait?.({ now, asks });
        if (!frozen) now += ms;
        queueMicrotask(fn);
        return 0;
    });
    t.mock.method(globalThis, 'fetch', async () => {
        asks++; now += requestMs;
        return { ok: true, status: 200, json: async () => answer({ now, asks }) };
    });
    return { result: await open('launch-computer'), get asks() { return asks; }, get elapsed() { return now; } };
}

for (const [name, open] of surfaces) {
    test(`${name}: fresh launch waits eight minutes and preserves the timeout code`, async t => {
        const out = await run(t, { open, onWait: () => {
            assert.equal(isComputeLaunching('launch-computer'), true);
            assert.equal(isComputeLaunching('another-computer'), false);
            assert.equal(isComputeMigrating('launch-computer'), false);
        } });
        assert.equal(LAUNCH_DEADLINE_MS, 480_000);
        assert.equal(out.elapsed, 480_000);
        assert.equal(out.asks, 321);
        assert.equal(out.result.errorCode, 'sandbox_starting');
        assert.equal(out.result.computeLaunching, true);
        assert.equal(isComputeLaunching('launch-computer'), false);
    });

    for (const flag of [undefined, null, false, 'true', 'false', 1, 0, {}, []]) {
        test(`${name}: non-true launch flag ${JSON.stringify(flag)} keeps the 216s ordinary timeout`, async t => {
            const out = await run(t, { open, answer: () => ({ ...pending, computeLaunching: flag }) });
            assert.equal(out.elapsed, 216_000);
            assert.equal(out.asks, 145);
            assert.equal(out.result.errorCode, 'sandbox_starting');
            assert.equal(Object.hasOwn(out.result, 'computeLaunching'), false);
        });
    }
}

test('replacement succeeds at 235.5s, beyond the incident cutoff, even after enrollment drops the flag', async t => {
    const out = await run(t, { answer: ({ now }) => now < 54_000 ? launching : now < 235_000 ? pending : ready });
    assert.equal(out.elapsed, 235_500);
    assert.equal(out.result.ok, true);
});

test('launch budget begins when first observed; later flags cannot restart it', async t => {
    const out = await run(t, { answer: ({ now }) => now < 90_000 || now === 300_000 ? pending : launching });
    assert.equal(out.elapsed, 570_000);
    assert.equal(out.result.errorCode, 'sandbox_starting');
});

test('dropping the launch flag retains the original bounded launch deadline', async t => {
    const out = await run(t, { answer: ({ now }) => now < 54_000 ? launching : pending });
    assert.equal(out.elapsed, 480_000);
    assert.equal(out.asks, 321);
});

test('slow launch responses remain bounded by elapsed time', async t => {
    const out = await run(t, { requestMs: 60_000 });
    assert.equal(out.elapsed, 552_000);
    assert.equal(out.asks, 9);
});

for (const [name, answer, cap] of [
    ['launch', () => launching, 322],
    ['launch flag dropped', ({ asks }) => asks === 1 ? launching : pending, 322],
    ['ordinary AWS', () => pending, 146],
    ['Cloudflare', () => ({ ...launching, computeProvider: 'cloudflare' }), 40],
    ['unlabelled', () => ({ ...launching, computeProvider: undefined }), 40],
]) {
    test(`${name}: frozen clock stops at ${cap} requests`, async t => {
        const out = await run(t, { answer, frozen: true });
        assert.equal(out.asks, cap);
        assert.equal(out.result.errorCode, 'unknown');
    });
}

for (const flag of ['true', 1, {}]) {
    test(`wake loop itself rejects non-boolean launch flag ${JSON.stringify(flag)}`, async t => {
        const out = await run(t, { answer: () => ({ ...pending, computeLaunching: flag }), open: id => withWakeAndOneRetry(async () => (await fetch('/raw')).json(), 'raw', id) });
        assert.equal(out.elapsed, 216_000);
        assert.equal(out.asks, 145);
    });
}

for (const answer of [{ ...launching, ok: true }, { ...launching, errorCode: 'code_preview_unavailable' }]) {
    test(`launch flag cannot relabel success/refusal: ${answer.ok}/${answer.errorCode}`, async t => {
        let asks = 0, observations = 0;
        const originalSet = Map.prototype.set;
        t.mock.method(Map.prototype, 'set', function (key, value) {
            if (value === 'launch-computer') observations++;
            return originalSet.call(this, key, value);
        });
        const out = await withWakeAndOneRetry(async () => { asks++; return answer; }, 'terminal', 'launch-computer');
        assert.deepEqual(out, answer);
        assert.equal(observations, 0);
        assert.equal(asks, 1);
        assert.equal(isComputeLaunching('launch-computer'), false);
    });
}

test('concurrent launches remain computer-scoped and clear after the last request', async t => {
    const waits = [];
    t.mock.method(globalThis, 'setTimeout', fn => { waits.push(fn); return 0; });
    const start = () => {
        let asks = 0;
        return withWakeAndOneRetry(async () => ++asks === 1 ? launching : ready, 'concurrent', 'same-computer');
    };
    const first = start(), second = start();
    await Promise.resolve();
    assert.equal(isComputeLaunching('same-computer'), true);
    assert.equal(isComputeLaunching('other-computer'), false);
    waits.shift()(); await first;
    assert.equal(isComputeLaunching('same-computer'), true);
    waits.shift()(); await second;
    assert.equal(isComputeLaunching('same-computer'), false);
});

test('launch observations clear if a request throws', async t => {
    t.mock.method(globalThis, 'setTimeout', fn => { queueMicrotask(fn); return 0; });
    let asks = 0;
    await assert.rejects(withWakeAndOneRetry(async () => {
        if (++asks === 1) return launching;
        throw new Error('request failed');
    }, 'throw', 'launch-computer'), /request failed/);
    assert.equal(isComputeLaunching('launch-computer'), false);
});

test('launch copy is neutral and the default session exposes the scoped observation', async () => {
    assert.equal(LAUNCH_COPY.title, 'Starting a fresh computer…');
    assert.doesNotMatch(JSON.stringify(LAUNCH_COPY), /Mumbai|Moving your computer/);
    assert.equal((await import('./session.js')).default.isComputeLaunching, isComputeLaunching);
});

test('migration keeps its own copy and deadline when both flags are present', async t => {
    const out = await run(t, { answer: () => ({ ...launching, computeMigrating: true }), onWait: () => {
        assert.equal(isComputeMigrating('launch-computer'), true);
        assert.equal(isComputeLaunching('launch-computer'), false);
    } });
    assert.equal(out.elapsed, 480_000);
    assert.equal(out.asks, 321);
});

test('launch preserves one automatic retry for a subsequent genuine failure', async t => {
    const out = await run(t, { answer: ({ now }) => now < 300_000 ? launching : { ok: false, errorCode: 'fetch_failed' } });
    assert.equal(out.elapsed, 301_500);
    assert.equal(out.asks, 202);
    assert.equal(out.result.errorCode, 'fetch_failed');
    assert.equal(isComputeLaunching('launch-computer'), false);
});
