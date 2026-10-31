// Round 6 (seam C): the server's `computePreparing` flag on an AWS `sandbox_starting` answer (app aws-preview.ts
// AWS_PREPARING_REASONS: the desktop is taking this host boot's config, or code-server is starting after it).
// `isComputePreparing(computerId)` reads it for the open's surface. Round 6a (C2): the FIRST preparing answer in a
// loop also extends that loop's deadline once, to PREPARE_DEADLINE_MS from then (the Worker's 150 s verdict plus
// a margin), never shortening it and never past the ten-minute ceiling.
import assert from 'node:assert/strict';
import test from 'node:test';
import { previewUrl, withWakeAndOneRetry, pendingOrRefused, isComputePreparing, PREPARE_DEADLINE_MS, LAUNCH_DEADLINE_MS } from './session.js';
import { WAKE_DEADLINE_MS } from './boot-phases.js';
import { PREPARE_EXPECTED_S } from './ui/app-spinner.js';
import { AWS_BOOT_HARD_STOP_MS } from './ui/boot-progress.js';

const pending = { ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2' };
const preparing = { ...pending, computePreparing: true };
const ready = { ok: true, appPreviewUrl: 'https://app.example/' };
const launching = { ...pending, computeLaunching: true };
const unapplied = { ok: false, errorCode: 'desktop_config_unapplied', computeProvider: 'aws-ec2' };
const surfaces = [['Preview', previewUrl],
    ['Code mapper', id => withWakeAndOneRetry(async () => codeAnswer(await (await fetch('/code')).json()), 'codePreviewUrl', id)]];
/** apps/code.js `mintCodePreviewUrlOnce`'s mapping: ok passes, anything else is `pendingOrRefused`. */
function codeAnswer (data) { return data?.ok === true ? data : pendingOrRefused(data); }

async function run(t, { answer, open, onWait, frozen = false } = {}) {
    let now = 0, asks = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'setTimeout', (fn, ms) => { onWait?.({ now, asks }); if (!frozen) now += ms; queueMicrotask(fn); return 0; });
    t.mock.method(globalThis, 'fetch', async () => { asks++; return { ok: true, status: 200, json: async () => answer({ now, asks }) }; });
    return { result: await open('prep-computer'), get asks() { return asks; }, get elapsed() { return now; } };
}

test('pendingOrRefused carries computePreparing only when it is boolean true', () => {
    assert.equal(pendingOrRefused(preparing).computePreparing, true);
    for (const flag of [undefined, null, false, 'true', 1, {}, []]) {
        assert.equal(Object.hasOwn(pendingOrRefused({ ...pending, computePreparing: flag }), 'computePreparing'), false, JSON.stringify(flag));
    }
});

for (const [name, open] of surfaces) {
    test(`${name}: a preparing answer is seen for this computer only, and kept for the rest of the loop`, async t => {
        const seen = [];
        const out = await run(t, { open,
            // Preparing on asks 3-5, then other starting answers without the flag (the container restarting), then ready.
            answer: ({ asks }) => asks >= 3 && asks <= 5 ? preparing : asks < 12 ? pending : ready,
            onWait: ({ asks }) => seen.push([asks, isComputePreparing('prep-computer'), isComputePreparing('another-computer')]) });
        assert.equal(out.result.ok, true);
        assert.deepEqual(seen.filter(([asks]) => asks < 3).map(([, p]) => p), [false, false]);
        assert.ok(seen.filter(([asks]) => asks >= 3).every(([, p, other]) => p === true && other === false), JSON.stringify(seen));
        assert.equal(isComputePreparing('prep-computer'), false, 'cleared when the loop ends');
    });

    test(`${name}: preparing from the first ask keeps the 216 s wake bound (its own 180 s ends inside it)`, async t => {
        const out = await run(t, { open, answer: () => preparing });
        assert.equal(out.elapsed, 216_000);
        assert.equal(out.asks, 145);
        assert.equal(out.result.errorCode, 'sandbox_starting');
        assert.equal(isComputePreparing('prep-computer'), false);
    });

    test(`${name}: preparing never seen keeps the 216 s wake bound`, async t => {
        const out = await run(t, { open, answer: () => pending });
        assert.equal(out.elapsed, 216_000);
        assert.equal(out.asks, 145);
        assert.equal(out.result.errorCode, 'sandbox_starting');
    });

    // 🔴 C2, the founder's stall in another form: a Standard open (no launch flag: a stopped computer starting in
    // place, a warm pool adopt) first sees preparing at ~70 s; the container restarts (starting answers without the
    // flag) and the Worker answers at ~222 s, past the old 216 s give-up.
    const c2 = last => ({ now }) => now < 70_000 ? pending : now < 150_000 ? preparing : now < 222_000 ? pending : last;
    test(`${name}: C2 preparing first seen at 70.5 s, ready at 222 s: the loop waits for it`, async t => {
        const out = await run(t, { open, answer: c2(ready) });
        assert.equal(out.result.ok, true, JSON.stringify(out.result));
        assert.equal(out.elapsed, 222_000);
        assert.equal(out.asks, 149);
    });

    test(`${name}: C2 with the Worker's unapplied verdict at 222 s returns that verdict, not a timeout`, async t => {
        const out = await run(t, { open, answer: c2(unapplied) });
        assert.equal(out.result.errorCode, 'desktop_config_unapplied');
        assert.equal(out.elapsed, 222_000);
        assert.equal(out.asks, 149, 'no silent re-ask of a terminal verdict');
    });

    test(`${name}: C2 never answered ends at 70.5 s + 180 s, not at 216 s`, async t => {
        const out = await run(t, { open, answer: c2(pending) });
        assert.equal(out.result.errorCode, 'sandbox_starting');
        assert.equal(out.elapsed, 70_500 + PREPARE_DEADLINE_MS);
    });

    // One preparing answer late in the wake, then only unflagged starting answers: the extension (and its raised
    // cap) holds. A cap reset by those later starting answers would stop at 146 asks with `unknown`.
    test(`${name}: one preparing answer at 201 s extends the deadline once, to 381 s, below the ten-minute ceiling`, async t => {
        const out = await run(t, { open, answer: ({ now }) => now >= 200_000 && now < 201_500 ? preparing : pending });
        assert.equal(out.result.errorCode, 'sandbox_starting', JSON.stringify(out.result));
        assert.equal(out.elapsed, 201_000 + PREPARE_DEADLINE_MS);
        assert.equal(out.asks, 255);
        assert.ok(out.elapsed < AWS_BOOT_HARD_STOP_MS);
    });

    test(`${name}: a later preparing answer never extends it again`, async t => {
        const out = await run(t, { open, answer: ({ now }) => (now >= 100_000 && now < 101_500) || now >= 250_000 ? preparing : pending });
        assert.equal(out.result.errorCode, 'sandbox_starting');
        assert.equal(out.elapsed, 100_500 + PREPARE_DEADLINE_MS);
    });

    test(`${name}: a launch first, then preparing at 550 s: still ends at the ten-minute ceiling`, async t => {
        const out = await run(t, { open, answer: ({ now }) => now < 550_000 ? launching : preparing });
        assert.equal(out.result.errorCode, 'sandbox_starting');
        assert.equal(out.elapsed, LAUNCH_DEADLINE_MS);
        assert.equal(out.asks, 401);
    });

    for (const [label, answer, cap] of [['from the first ask', () => preparing, 146],
        ['from ask 50', ({ asks }) => asks < 50 ? pending : preparing, 49 + 122]]) {
        test(`${name}: preparing ${label} on a frozen clock still stops at a finite cap (${cap} asks)`, async t => {
            const out = await run(t, { open, answer, frozen: true });
            assert.equal(out.asks, cap);
            assert.equal(out.result.errorCode, 'unknown');
        });
    }

    for (const flag of [undefined, false, 'true', 1]) {
        test(`${name}: a non-true flag ${JSON.stringify(flag)} is not preparing`, async t => {
            const seen = [];
            await run(t, { open, answer: ({ asks }) => asks < 4 ? { ...pending, computePreparing: flag } : ready,
                onWait: () => seen.push(isComputePreparing('prep-computer')) });
            assert.ok(seen.length > 0 && seen.every(p => p === false));
        });
    }

    test(`${name}: a Cloudflare starting answer with the flag is not preparing`, async t => {
        const seen = [];
        await run(t, { open, answer: ({ asks }) => asks < 4 ? { ...preparing, computeProvider: undefined } : ready,
            onWait: () => seen.push(isComputePreparing('prep-computer')) });
        assert.ok(seen.length > 0 && seen.every(p => p === false));
    });
}

test('a terminal desktop answer ends the loop at once (no silent re-ask) and clears preparing', async t => {
    for (const errorCode of ['desktop_config_unapplied', 'desktop_failed']) {
        const out = await run(t, { open: id => withWakeAndOneRetry(async () => codeAnswer(await (await fetch('/code')).json()), 'codePreviewUrl', id),
            answer: ({ asks }) => asks < 3 ? preparing : { ok: false, errorCode, computeProvider: 'aws-ec2' } });
        assert.equal(out.result.errorCode, errorCode);
        assert.equal(out.asks, 3, `${errorCode}: no automatic second ask`);
        assert.equal(isComputePreparing('prep-computer'), false);
    }
});

test('the preparing deadline outlasts its "Taking longer than usual" and stays inside the client ceilings', () => {
    assert.equal(PREPARE_DEADLINE_MS, 180_000);
    // The spinner flips to "Taking longer than usual" PREPARE_EXPECTED_S after the same first sight: always first.
    assert.ok(PREPARE_EXPECTED_S * 1000 < PREPARE_DEADLINE_MS);
    // The Worker's 150 s bound is what the spinner quotes, and what the margin is added to.
    assert.equal(PREPARE_EXPECTED_S, 150);
    // An ordinary wake extended at its last moment still ends inside the loader's ten-minute stop.
    assert.equal(LAUNCH_DEADLINE_MS, AWS_BOOT_HARD_STOP_MS);
    assert.ok(WAKE_DEADLINE_MS + PREPARE_DEADLINE_MS < AWS_BOOT_HARD_STOP_MS);
});

test('the deadline extension belongs to the loop: it holds with no computer id (only the surface flag needs one)', async t => {
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'setTimeout', (fn, ms) => { now += ms; queueMicrotask(fn); return 0; });
    const out = await withWakeAndOneRetry(async () => (now >= 70_000 && now < 150_000 ? preparing : now < 222_000 ? pending : ready), 'raw');
    assert.equal(out.ok, true);
    assert.equal(now, 222_000);
});
