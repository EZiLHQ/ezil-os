// Round 6 (seam C): the server's `computePreparing` flag on an AWS `sandbox_starting` answer (app aws-preview.ts
// AWS_PREPARING_REASONS: the desktop is taking this host boot's config, or code-server is starting after it).
// It qualifies the wake; it never bounds it. `isComputePreparing(computerId)` reads it for the open's surface.
import assert from 'node:assert/strict';
import test from 'node:test';
import { previewUrl, withWakeAndOneRetry, pendingOrRefused, isComputePreparing } from './session.js';

const pending = { ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2' };
const preparing = { ...pending, computePreparing: true };
const ready = { ok: true, appPreviewUrl: 'https://app.example/' };
const surfaces = [['Preview', previewUrl],
    ['Code mapper', id => withWakeAndOneRetry(async () => codeAnswer(await (await fetch('/code')).json()), 'codePreviewUrl', id)]];
/** apps/code.js `mintCodePreviewUrlOnce`'s mapping: ok passes, anything else is `pendingOrRefused`. */
function codeAnswer (data) { return data?.ok === true ? data : pendingOrRefused(data); }

async function run(t, { answer, open, onWait } = {}) {
    let now = 0, asks = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'setTimeout', (fn, ms) => { onWait?.({ now, asks }); now += ms; queueMicrotask(fn); return 0; });
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

    test(`${name}: preparing never extends the wake bound (216 s, as an ordinary AWS wake)`, async t => {
        const out = await run(t, { open, answer: () => preparing });
        assert.equal(out.elapsed, 216_000);
        assert.equal(out.asks, 145);
        assert.equal(out.result.errorCode, 'sandbox_starting');
        assert.equal(isComputePreparing('prep-computer'), false);
    });

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
