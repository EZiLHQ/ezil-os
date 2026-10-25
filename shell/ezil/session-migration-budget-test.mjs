import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { openDesktop, previewUrl, withWakeAndOneRetry, pendingOrRefused,
    isComputeMigrating, MIGRATION_DEADLINE_MS } from './session.js';
import { AppSpinner } from './ui/app-spinner.js';

const pending = { ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2' };
const moving = { ...pending, computeMigrating: true };
const ready = { ok: true, guacamoleUrl: 'https://desktop.example/', appPreviewUrl: 'https://app.example/' };

async function run(t, { answer = () => moving, open = openDesktop, requestMs = 0, frozen = false, onWait } = {}) {
    let now = 0, asks = 0;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
        onWait?.({ now, asks });
        if (!frozen) now += ms;
        queueMicrotask(fn);
        return 0;
    });
    t.mock.method(globalThis, 'fetch', async () => {
        asks++;
        now += requestMs;
        return { ok: true, status: 200, json: async () => answer({ now, asks }) };
    });
    const result = await open('migration-computer');
    return { result, asks, elapsed: now };
}

for (const [name, open] of [['Desktop', openDesktop], ['Preview', previewUrl],
    ['Code mapper', id => withWakeAndOneRetry(async () => pendingOrRefused(await (await fetch('/code')).json()), 'codePreviewUrl', id)]]) {
    test(`${name}: migration waits the full eight minutes and preserves the timeout code`, async t => {
        const out = await run(t, { open });
        assert.equal(MIGRATION_DEADLINE_MS, 480_000);
        assert.equal(out.elapsed, 480_000);
        assert.equal(out.asks, 321);
        assert.equal(out.result.errorCode, 'sandbox_starting');
        assert.equal(out.result.computeMigrating, true);
        assert.equal(isComputeMigrating('migration-computer'), false);
    });
}

test('migration clock starts at the first flagged answer, not at window open', async t => {
    const out = await run(t, { answer: ({ now }) => now < 90_000 ? pending : moving });
    assert.equal(out.elapsed, 570_000);
    assert.equal(out.asks, 381);
    assert.equal(out.result.errorCode, 'sandbox_starting');
});

test('flag dropped: a full AWS wake budget resumes after even a nearly eight-minute move', async t => {
    const out = await run(t, { answer: ({ now }) => now < 480_000 ? moving : pending });
    assert.equal(out.elapsed, 696_000);
    assert.equal(out.asks, 465);
    assert.equal(out.result.errorCode, 'sandbox_starting');
    assert.equal(isComputeMigrating('migration-computer'), false);
});

test('migration plus first boot can succeed beyond the old 215s cutoff', async t => {
    const out = await run(t, { answer: ({ now }) => now < 210_000 ? moving : now < 390_000 ? pending : ready });
    assert.equal(out.result.ok, true);
    assert.equal(out.elapsed, 390_000);
});

test('repeated flags cannot restart the migration or resumed wake deadlines', async t => {
    const out = await run(t, { answer: ({ now }) => now === 300_000 || now === 450_000 ? pending : moving });
    assert.equal(out.elapsed, 516_000);
    assert.equal(out.result.errorCode, 'sandbox_starting');
});

test('slow first migration response does not spend the migration budget before it is observed', async t => {
    const out = await run(t, { requestMs: 60_000 });
    assert.equal(out.elapsed, 552_000);
    assert.equal(out.asks, 9);
    assert.equal(out.result.errorCode, 'sandbox_starting');
});

for (const [name, answer, cap] of [
    ['Cloudflare', () => ({ ...pending, computeProvider: 'cloudflare' }), 40],
    ['unlabelled', () => ({ ...pending, computeProvider: undefined }), 40],
    ['ordinary AWS', () => pending, 146],
    ['migration', () => moving, 322],
    ['resumed AWS', ({ asks }) => asks <= 300 ? moving : pending, 446],
]) {
    test(`${name}: frozen clock still stops at the deadline-derived issue cap (${cap})`, async t => {
        const out = await run(t, { answer, frozen: true });
        assert.equal(out.asks, cap);
        assert.equal(out.result.errorCode, 'unknown');
    });
}

for (const flag of [undefined, false, 'true', 1]) {
    test(`non-true migration flag ${String(flag)} preserves the ordinary AWS deadline`, async t => {
        const out = await run(t, { answer: () => ({ ...pending, computeMigrating: flag }) });
        assert.equal(out.elapsed, 216_000);
        assert.equal(out.asks, 145);
        assert.equal(out.result.errorCode, 'sandbox_starting');
    });
}

test('migration flag alone cannot relabel another provider or retry a terminal refusal', async t => {
    const out = await run(t, { answer: () => ({ ...moving, computeProvider: 'cloudflare' }) });
    assert.equal(out.asks, 40);
    const refused = await withWakeAndOneRetry(async () => ({ ...moving, errorCode: 'code_preview_unavailable' }), 'refused');
    assert.equal(refused.errorCode, 'code_preview_unavailable');
});

test('migration preserves the one automatic retry for a genuine post-move failure', async t => {
    const out = await run(t, { answer: ({ now }) => now < 300_000 ? moving : { ok: false, errorCode: 'fetch_failed' } });
    assert.equal(out.elapsed, 301_500);
    assert.equal(out.asks, 202);
    assert.equal(out.result.errorCode, 'fetch_failed');
});

test('concurrent requests retain migration copy until the last migrating request settles', async t => {
    const waits = [];
    t.mock.method(globalThis, 'setTimeout', fn => { waits.push(fn); return 0; });
    const start = () => {
        let asks = 0;
        return withWakeAndOneRetry(async () => ++asks === 1 ? moving : ready, 'concurrent', 'same-computer');
    };
    const first = start(), second = start();
    await Promise.resolve();
    assert.equal(waits.length, 2);
    assert.equal(isComputeMigrating('same-computer'), true);
    waits.shift()();
    await first;
    assert.equal(isComputeMigrating('same-computer'), true);
    waits.shift()();
    await second;
    assert.equal(isComputeMigrating('same-computer'), false);
});

test('copy follows migration observations, stays computer-scoped, then restores normal and timeout copy', async t => {
    const dom = new JSDOM('<!doctype html>');
    t.after(() => dom.window.close());
    const originalDocument = globalThis.document;
    globalThis.document = dom.window.document;
    t.after(() => { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; });
    const spinner = AppSpinner({ label: 'Opening Code…', isMigrating: () => isComputeMigrating('migration-computer') });
    const other = AppSpinner({ label: 'Opening Browser…', isMigrating: () => isComputeMigrating('other-computer') });
    const label = s => s.el.querySelector('.ezil-app-spinner-label').textContent;
    let movingCopy = 0, normalCopy = 0;
    const out = await run(t, {
        answer: ({ now }) => now < 3_000 ? moving : pending,
        onWait: ({ now }) => {
            spinner.render({ kind: 'progress' });
            other.render({ kind: 'progress' });
            assert.equal(label(other), 'Opening Browser…');
            if (now < 3_000) {
                assert.equal(label(spinner), 'Moving your computer to AWS (India)');
                assert.equal(spinner.el.querySelector('.ezil-app-spinner-sub').textContent,
                    'This first start takes a few minutes. Your files come with you.');
                assert.equal(spinner.el.querySelector('.ezil-app-spinner-sub').hidden, false);
                movingCopy++;
            } else {
                assert.equal(label(spinner), 'Opening Code…');
                assert.equal(spinner.el.querySelector('.ezil-app-spinner-sub').hidden, true);
                normalCopy++;
            }
        },
    });
    assert.equal(out.result.errorCode, 'sandbox_starting');
    assert.ok(movingCopy > 0 && normalCopy > 0);
    spinner.render({ kind: 'failed', reason: 'timeout' });
    assert.equal(label(spinner), 'This is taking too long');
    assert.match(spinner.el.querySelector('.ezil-app-spinner-sub').textContent, /background/);
    assert.equal(spinner.el.querySelector('.ezil-boot-actions').hidden, false);
});
