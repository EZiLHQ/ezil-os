import { createRequire } from 'node:module';
import path from 'node:path';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CheckoutStatus } from './checkout-status';

// Use the repository's installed DOM dependency; this exercises the actual
// React component without transport, Stripe frames, or a dependency install.
const shellRequire = createRequire(path.resolve(__dirname, '../../../../../shell/package.json'));
const { JSDOM } = shellRequire('jsdom');
const STANDARD = 'standard_monthly_v3';
const PREMIUM = 'premium_monthly_v3';
const free = { enabled: true, plan: { sku: 'free_v3', status: 'active' } };
const matching = { enabled: true, plan: { sku: STANDARD, status: 'active' } };
const completed = (paymentStatus: unknown, sku: unknown = STANDARD) => ({ status: 'complete', paymentStatus, sku });
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};
type Read = { procedure: string; sessionId?: string; signal?: AbortSignal | null; method: string; cache?: RequestCache; credentials?: RequestCredentials };

let dom: { window: Window & typeof globalThis };
let root: Root | null;
let target: HTMLElement;
let reads: Read[];
let status: (sessionId: string) => unknown | Promise<unknown>;
let summary: () => unknown | Promise<unknown>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

const text = () => target.textContent ?? '';
const active = () => /Your plan is active\./.test(text());
const count = (procedure: string) => reads.filter(read => read.procedure === procedure).length;
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function render(sessionId = 'cs_test_return') {
    await act(async () => { root!.render(createElement(CheckoutStatus, { sessionId })); await settle(); });
}
async function tick(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); await settle(); });
}
async function checkAgain() {
    const button = [...target.querySelectorAll('button')].find(button => button.textContent === 'Check again');
    expect(button).toBeTruthy();
    await act(async () => { button!.click(); await settle(); });
}
function assertReadOnly() {
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const read of reads) {
        expect(['billing.checkoutStatus', 'billing.summary']).toContain(read.procedure);
        expect(read.method).toBe('GET');
        expect(read.cache).toBe('no-store');
        expect(read.credentials).toBe('same-origin');
    }
    // Include replies supplied by mockResolvedValueOnce, which bypass the
    // default mock implementation's data selection and read bookkeeping.
    for (const [input, init] of fetchMock.mock.calls) {
        expect(new URL(String(input), dom.window.location.href).pathname).toMatch(/^\/api\/trpc\/billing\.(checkoutStatus|summary)$/);
        expect(init?.method ?? 'GET').toBe('GET');
        expect(init?.cache).toBe('no-store');
        expect(init?.credentials).toBe('same-origin');
    }
}

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(0);
    dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
        url: 'https://example.test/billing/return?session_id=cs_test_return', pretendToBeVisual: true,
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    target = dom.window.document.querySelector('main')!;
    reads = [];
    status = () => completed('unpaid');
    summary = () => free;
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(String(input), dom.window.location.href);
        const procedure = url.pathname.split('/').at(-1)!;
        const params = JSON.parse(url.searchParams.get('input') ?? '{}');
        const sessionId = params.json?.sessionId;
        reads.push({ procedure, sessionId, signal: init?.signal, method: init?.method ?? 'GET', cache: init?.cache, credentials: init?.credentials });
        const data = procedure === 'billing.checkoutStatus' ? await status(sessionId) : await summary();
        return new Response(JSON.stringify({ result: { data: { json: data } } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { createRoot } = await import('react-dom/client');
    root = createRoot(target);
});

afterEach(async () => {
    try {
        if (root) await act(async () => { root!.unmount(); await settle(); });
        assertReadOnly();
    } finally {
        root = null;
        dom.window.close();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    }
});

describe('Checkout return payment and plan confirmation', () => {
    it('starts with an accessible status and a persistent link back to Billing', async () => {
        const pending = deferred<unknown>();
        status = () => pending.promise;
        await render();
        expect(text()).toMatch(/Checking your payment/);
        expect(target.querySelector('[aria-live="polite"]')).toBeTruthy();
        const back = target.querySelector('a[href="/os?settings=billing"]');
        expect(back?.textContent).toBe('Back to Billing');
        expect(active()).toBe(false);
        expect(reads[0].sessionId).toBe('cs_test_return');
        assertReadOnly();
    });

    it.each([
        ['unpaid', /processing|pending/i, false],
        ['paid', /Payment received/i, true],
        ['no_payment_required', /No payment is required/i, true],
        [null, /confirmation is pending|could not confirm/i, false],
        [undefined, /confirmation is pending|could not confirm/i, false],
        ['PAID', /confirmation is pending|could not confirm/i, false],
    ])('complete with paymentStatus=%s waits for the matching webhook plan', async (paymentStatus, expected, canActivate) => {
        status = () => completed(paymentStatus);
        await render();
        expect(text()).toMatch(expected as RegExp);
        expect(active()).toBe(false);
        expect(text()).not.toMatch(/You're on|EZiL Pro|Free plan/);
        expect(count('billing.summary')).toBe(1);
        summary = () => matching;
        await tick(2000);
        expect(active()).toBe(canActivate);
        if (!canActivate) expect(text()).not.toMatch(/Payment received|Your plan is active/);
        expect(target.querySelector('a[href="/os?settings=billing"]')).toBeTruthy();
        assertReadOnly();
    });

    it('bank completion can become paid while the webhook plan still lags, then activate', async () => {
        await render();
        expect(text()).toMatch(/Bank payments can take a few days/);
        status = () => completed('paid');
        summary = () => ({ enabled: true, plan: { sku: PREMIUM, status: 'active' } });
        await tick(2000);
        expect(text()).toMatch(/Payment received/);
        expect(active()).toBe(false);
        summary = () => matching;
        await tick(2000);
        expect(active()).toBe(true);
        expect(text()).not.toMatch(/You're on|EZiL Pro/);
        const before = reads.length;
        await tick(60_000);
        expect(reads).toHaveLength(before);
        expect(vi.getTimerCount()).toBe(0);
        assertReadOnly();
    });

    it.each(['incomplete', 'past_due', 'upgrade_pending', undefined, 'cancelled'])('same SKU with plan status %s is not active access', async planStatus => {
        status = () => completed('paid');
        summary = () => ({ enabled: true, plan: { sku: STANDARD, status: planStatus } });
        await render();
        await tick(2000);
        expect(text()).toMatch(/Payment received/);
        expect(active()).toBe(false);
        summary = () => matching;
        await tick(2000);
        expect(active()).toBe(true);
    });

    it('same SKU scheduled to cancel retains confirmed active access', async () => {
        status = () => completed('paid');
        summary = () => ({ enabled: true, plan: { sku: STANDARD, status: 'cancels' } });
        await render();
        expect(active()).toBe(true);
    });

    it.each([false, undefined])('a summary with enabled=%s cannot confirm paid active access', async enabled => {
        status = () => completed('paid');
        summary = () => ({ ...matching, enabled });
        await render();
        await tick(2000);
        expect(active()).toBe(false);
        expect(text()).toMatch(/Payment received/);
    });

    it.each([null, undefined, ''])('missing purchased SKU %s cannot turn an existing plan into a purchase claim', async sku => {
        status = () => ({ status: 'complete', paymentStatus: 'paid', sku });
        summary = () => ({ plan: { sku: 'free_v3' } });
        await render();
        await tick(2000);
        expect(active()).toBe(false);
        expect(text()).toMatch(/purchased plan could not be confirmed/i);
        expect(text()).not.toMatch(/You're on|EZiL Pro|Free/);
        expect(count('billing.summary')).toBe(0);
    });

    it('legacy complete-only replies remain unconfirmed and never invent a plan', async () => {
        status = () => 'complete';
        summary = () => matching;
        await render();
        await tick(2000);
        expect(active()).toBe(false);
        expect(text()).not.toMatch(/Payment received|You're on|EZiL Pro|Free/);
        expect(count('billing.summary')).toBe(0);
    });

    it('expired checkout stops checking without claiming receipt or a plan', async () => {
        status = () => ({ status: 'expired', paymentStatus: 'unpaid', sku: STANDARD });
        await render();
        expect(text()).toMatch(/checkout.*expired/i);
        expect(active()).toBe(false);
        expect(count('billing.summary')).toBe(0);
        await tick(60_000);
        expect(count('billing.checkoutStatus')).toBe(1);
        expect(target.querySelector('a[href="/os?settings=billing"]')).toBeTruthy();
    });

    it('transient fetch errors retry the read for the same session and can recover', async () => {
        let attempts = 0;
        status = () => { if (++attempts === 1) throw new Error('offline'); return completed('paid'); };
        summary = () => matching;
        await render();
        expect(active()).toBe(false);
        await tick(2000);
        expect(active()).toBe(true);
        expect(reads.filter(read => read.procedure === 'billing.checkoutStatus').map(read => read.sessionId))
            .toEqual(['cs_test_return', 'cs_test_return']);
        assertReadOnly();
    });

    it('HTTP errors cannot turn a response body into an activation', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: { data: { json: completed('paid') } } }), { status: 503 }));
        summary = () => matching;
        await render();
        expect(active()).toBe(false);
        expect(count('billing.summary')).toBe(0);
        status = () => completed('paid');
        await tick(2000);
        expect(active()).toBe(true);
    });

    it('a 200 tRPC error envelope cannot use its tempting result as payment evidence', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            error: { json: { message: 'Unauthorized', code: -32001 } },
            result: { data: { json: completed('paid') } },
        }), { status: 200 }));
        summary = () => matching;
        await render();
        expect(active()).toBe(false);
        expect(count('billing.summary')).toBe(0);
        expect(text()).not.toMatch(/Payment received/);
        status = () => completed('paid');
        await tick(2000);
        expect(active()).toBe(true);
    });

    it('timeout offers Check again as read-only verification of the same session', async () => {
        await render();
        await tick(60_000);
        expect(active()).toBe(false);
        expect(text()).not.toMatch(/Payment received|You're on/);
        const before = reads.length;
        await tick(60_000);
        expect(reads).toHaveLength(before);
        status = () => completed('paid');
        summary = () => matching;
        await checkAgain();
        expect(active()).toBe(true);
        expect(reads.slice(before).map(read => read.procedure)).toEqual(['billing.checkoutStatus', 'billing.summary']);
        expect(reads.filter(read => read.procedure === 'billing.checkoutStatus').every(read => read.sessionId === 'cs_test_return')).toBe(true);
        assertReadOnly();
    });

    it('a hung status is aborted at the deadline and its late reply cannot activate', async () => {
        const pending = deferred<unknown>();
        status = () => pending.promise;
        summary = () => matching;
        await render();
        const signal = reads[0].signal;
        expect(signal?.aborted).toBe(false);
        await tick(60_000);
        expect(signal?.aborted).toBe(true);
        await act(async () => { pending.resolve(completed('paid')); await settle(); });
        expect(active()).toBe(false);
        expect(count('billing.summary')).toBe(0);
        status = () => completed('paid');
        await checkAgain();
        expect(active()).toBe(true);
        expect(reads.at(-1)?.signal).not.toBe(signal);
    });

    it('a summary arriving after the deadline cannot activate the plan', async () => {
        const pending = deferred<unknown>();
        status = () => completed('paid');
        summary = () => pending.promise;
        await render();
        expect(count('billing.summary')).toBe(1);
        await tick(60_000);
        await act(async () => { pending.resolve(matching); await settle(); });
        expect(active()).toBe(false);
        expect(target.querySelector('button')?.textContent).toBe('Check again');
    });

    it('unmount aborts a pending read and ignores its late response', async () => {
        const pending = deferred<unknown>();
        status = () => pending.promise;
        await render();
        const signal = reads[0].signal;
        await act(async () => { root!.unmount(); root = null; await settle(); });
        expect(signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { pending.resolve(completed('paid')); await settle(); });
        await tick(60_000);
        expect(count('billing.summary')).toBe(0);
        expect(count('billing.checkoutStatus')).toBe(1);
    });

    it('changing session rejects the old late status and waits for the new purchased SKU', async () => {
        const old = deferred<unknown>();
        status = sessionId => sessionId === 'cs_old' ? old.promise : completed('paid', PREMIUM);
        summary = () => matching;
        await render('cs_old');
        const oldSignal = reads[0].signal;
        await render('cs_new');
        expect(oldSignal?.aborted).toBe(true);
        expect(active()).toBe(false);
        await act(async () => { old.resolve(completed('paid', STANDARD)); await settle(); });
        expect(active()).toBe(false);
        expect(count('billing.summary')).toBe(1);
        summary = () => ({ enabled: true, plan: { sku: PREMIUM, status: 'active' } });
        await tick(2000);
        expect(active()).toBe(true);
        expect(reads.filter(read => read.procedure === 'billing.checkoutStatus').map(read => read.sessionId))
            .toEqual(['cs_old', 'cs_new', 'cs_new']);
    });

    it('changing session clears an earlier success while the new status is unknown', async () => {
        status = () => completed('paid');
        summary = () => matching;
        await render('cs_old');
        expect(active()).toBe(true);
        const pending = deferred<unknown>();
        status = () => pending.promise;
        await render('cs_new');
        expect(active()).toBe(false);
        expect(text()).toMatch(/Checking your payment/);
    });

    it('returning to an earlier session verifies it again instead of restoring its old success', async () => {
        status = () => completed('paid');
        summary = () => matching;
        await render('cs_old');
        expect(active()).toBe(true);

        const other = deferred<unknown>();
        const returning = deferred<unknown>();
        status = sessionId => sessionId === 'cs_new' ? other.promise : returning.promise;
        await render('cs_new');
        const otherSignal = reads.at(-1)?.signal;
        expect(active()).toBe(false);
        await render('cs_old');
        expect(otherSignal?.aborted).toBe(true);
        expect(active()).toBe(false);
        expect(text()).toMatch(/Checking your payment/);

        await act(async () => { other.resolve(completed('paid')); await settle(); });
        expect(active()).toBe(false);
        expect(count('billing.summary')).toBe(1);
        await act(async () => { returning.resolve(completed('paid')); await settle(); });
        expect(active()).toBe(true);
        expect(count('billing.summary')).toBe(2);
        expect(reads.filter(read => read.procedure === 'billing.checkoutStatus').map(read => read.sessionId))
            .toEqual(['cs_old', 'cs_new', 'cs_old']);
    });
});
