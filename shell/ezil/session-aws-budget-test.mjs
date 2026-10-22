import assert from 'node:assert/strict';
import test from 'node:test';
import { openDesktop } from './session.js';
import { WAKE_DEADLINE_MS, WAKE_REASK_MS } from './boot-phases.js';

async function run({ provider, readyAt = Infinity, elapsedPerAsk = 0 }) {
    const original = { fetch, now: Date.now, timeout: globalThis.setTimeout };
    let now = 0, asks = 0;
    Date.now = () => now;
    globalThis.setTimeout = (fn, ms) => { now += ms; queueMicrotask(fn); return 0; };
    globalThis.fetch = async () => {
        asks++; now += elapsedPerAsk;
        return { ok: true, status: 200, json: async () => asks >= readyAt
            ? { ok: true, guacamoleUrl: 'https://desktop.example/' }
            : { ok: false, errorCode: 'sandbox_starting', computeProvider: provider } };
    };
    try { return { result: await openDesktop('test-computer'), asks, elapsed: now }; }
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
