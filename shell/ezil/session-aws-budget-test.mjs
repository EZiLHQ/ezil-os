import assert from 'node:assert/strict';
import test from 'node:test';
import { openDesktop, previewUrl, pendingOrRefused } from './session.js';
import { WAKE_DEADLINE_MS, WAKE_REASK_MS } from './boot-phases.js';

async function run({ provider, readyAt = Infinity, elapsedPerAsk = 0, open = openDesktop }) {
    const original = { fetch, now: Date.now, timeout: globalThis.setTimeout };
    let now = 0, asks = 0;
    Date.now = () => now;
    globalThis.setTimeout = (fn, ms) => { now += ms; queueMicrotask(fn); return 0; };
    globalThis.fetch = async () => {
        asks++; now += elapsedPerAsk;
        return { ok: true, status: 200, json: async () => asks >= readyAt
            ? { ok: true, guacamoleUrl: 'https://desktop.example/', appPreviewUrl: 'https://app.example/' }
            : { ok: false, errorCode: 'sandbox_starting', computeProvider: provider } };
    };
    try { return { result: await open('test-computer'), asks, elapsed: now }; }
    finally { globalThis.fetch = original.fetch; Date.now = original.now; globalThis.setTimeout = original.timeout; }
}

test('AWS fast pending responses survive 40 asks and open after a 57s enrollment plus display startup', async () => {
    const outcome = await run({ provider: 'aws-ec2', readyAt: 65 });
    assert.equal(outcome.result.ok, true);
    assert.equal(outcome.asks, 65);
    assert.equal(outcome.elapsed, 64 * WAKE_REASK_MS);
});

test('Cloudflare and unlabelled fast pending responses retain the 40-request backstop', async () => {
    for (const provider of ['cloudflare', undefined]) {
        const outcome = await run({ provider, readyAt: 65 });
        assert.equal(outcome.result.ok, false);
        assert.equal(outcome.asks, 40);
    }
});

test('AWS never-ready responses exhaust the wall-clock budget with the pending timeout code', async () => {
    const outcome = await run({ provider: 'aws-ec2' });
    assert.equal(outcome.result.errorCode, 'sandbox_starting');
    assert.ok(outcome.elapsed >= WAKE_DEADLINE_MS);
    assert.ok(outcome.elapsed <= WAKE_DEADLINE_MS + WAKE_REASK_MS);
    assert.ok(outcome.asks <= Math.ceil(WAKE_DEADLINE_MS / WAKE_REASK_MS) + 1);
});

test('slow AWS requests cannot bypass the same wall-clock deadline', async () => {
    const outcome = await run({ provider: 'aws-ec2', elapsedPerAsk: 60_000 });
    assert.equal(outcome.result.errorCode, 'sandbox_starting');
    assert.equal(outcome.asks, 4);
});

test('AWS pending app/code previews keep the provider, so they get the AWS wake budget too', async () => {
    const outcome = await run({ provider: 'aws-ec2', readyAt: 65, open: previewUrl });
    assert.equal(outcome.result.ok, true);
    assert.equal(outcome.asks, 65);
    const cf = await run({ provider: 'cloudflare', readyAt: 65, open: previewUrl });
    assert.equal(cf.result.ok, false);
    assert.equal(cf.asks, 40);
    assert.deepEqual(pendingOrRefused({ errorCode: 'sandbox_starting', computeProvider: 'aws-ec2' }),
        { ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2' });
});

test('the default session object exposes pendingOrRefused (code.js calls it as session.pendingOrRefused)', async () => {
    const session = (await import('./session.js')).default;
    assert.equal(session.pendingOrRefused, pendingOrRefused);
});

test('code.js hands not-ok Code preview bodies to pendingOrRefused (source check: code.js needs a DOM to import)', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./apps/code.js', import.meta.url), 'utf8');
    assert.match(source, /if \( data\?\.ok !== true \) return session\.pendingOrRefused\(data\);/);
    assert.doesNotMatch(source, /return \{ ok: false, errorCode: data\?\.errorCode \?\? 'unknown' \}/);
});
