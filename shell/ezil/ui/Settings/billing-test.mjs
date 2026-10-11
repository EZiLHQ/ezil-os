// billing-test.mjs — EZiL-authored. Exercises the shipped Settings bundle.
// Fake fetch is the only transport: no server, credentials or network needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.EZIL_SHELL_OUT_DIR || path.resolve(here, '../../../../app/public/os');
const dom = new JSDOM('<!doctype html><body><div class="desktop"></div></body>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/os',
});
const { window } = dom;
const calls = [];
const errors = [];
window.addEventListener('error', event => errors.push(event.message));
const reply = (data) => ({ ok: true, status: 200, json: async () => ({ result: { data: { json: data } } }) });
const failure = (message) => ({ ok: false, status: 500, json: async () => ({ error: { json: { message } } }) });
const fixture = () => ({
    enabled: true, version: 1,
    plan: { id: 'free', status: 'free', periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-11-01T00:00:00Z', renewsAt: null, cancelsAt: null },
    meters: {
        workspace: { usedSeconds: 5400, allowanceSeconds: 28800, remainingSeconds: 23400, resetsAt: '2026-11-01T00:00:00Z', state: 'ok' },
        storage: { usedBytes: '1500000000', capBytes: '2000000000', measuredAt: '2026-10-11T12:00:00Z', state: 'ok' },
        ai: { state: 'unavailable', trialMicro: '0', includedMicro: '0', purchasedMicro: '0', includedExpiresAt: null },
    },
    actions: { checkout: false, portal: false, topup: false },
    catalog: {
        pro: { sku: 'pro_monthly_v1', unitAmountCents: 2000, currency: 'usd', interval: 'month' },
        packs: [
            { sku: 'ai_pack_10_v1', creditCents: 1000, serviceFeeCents: 84, totalCents: 1084 },
            { sku: 'ai_pack_25_v1', creditCents: 2500, serviceFeeCents: 161, totalCents: 2661 },
        ],
    },
});
let summary = fixture();
let getSummary = () => reply(summary);
let mutation = () => reply({ url: '#checkout-complete' });
window.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, input: options.body ? JSON.parse(options.body).json : undefined });
    if ( String(url).includes('/api/trpc/billing.summary') ) return getSummary();
    if ( String(url).includes('/api/trpc/billing.') ) return mutation();
    if ( String(url).includes('/api/trpc/computer.list') ) return reply([]);
    return failure('Stubbed endpoint');
};
for ( const file of ['icons.js', 'bundle.min.js'] ) window.eval(fs.readFileSync(path.join(out, file), 'utf8'));
window.ezil.boot();
window.$.fx.off = true;
const payload = { user: { id: 'test-user', name: 'Test user' }, features: { billing: true }, desktopState: {} };
const context = { payload, desktopState: {} };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const settle = async () => { for ( let i = 0; i < 5; i++ ) await tick(); };
const q = selector => window.document.querySelector(selector);
const qa = selector => [...window.document.querySelectorAll(selector)];
const pane = () => q('[data-pane="billing"]');
const text = () => pane()?.textContent ?? '';
const click = element => {
    assert.ok(element, 'control exists before it is clicked');
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};
const count = () => calls.filter(call => call.url.includes('/billing.summary')).length;
const active = () => q('.ezil-settings-tab.active')?.dataset.tab;
async function open (ctx = { ...context, initialTab: 'billing' }) {
    const old = q('.window[data-app="settings"]');
    if ( old ) { await window.$(old).close(); await settle(); }
    await window.ezil.registry.launch('settings', ctx);
    await settle();
}
async function refresh () {
    click(q('[data-tab="account"]'));
    click(q('[data-tab="billing"]'));
    await settle();
}

try {
    await open();
    assert.deepEqual(qa('.ezil-settings-tab').map(tab => tab.dataset.tab), ['account', 'billing', 'computers', 'system', 'appearance', 'about', 'troubleshoot']);
    assert.equal(active(), 'billing');
    assert.equal(count(), 1, 'direct entry activates exactly once');
    assert.equal(q('[data-tab="usage"]'), null, 'forbidden upstream tab stays absent; Billing above is the positive control');
    assert.match(text(), /EZiL Free/);
    assert.match(text(), /Free plan/);
    assert.match(text(), /1 h 30 m of 8 h used · resets Nov 1, 2026 UTC/);
    assert.match(text(), /1.5 GB of 2.0 GB used/);
    assert.match(text(), /Measured Oct 11, 2026 UTC/);
    assert.match(text(), /AI assistant coming soon/);
    assert.match(text(), /Counts while a computer is running. Computers stop after 10 minutes without activity./);
    assert.match(text(), /Saved project files across your computers/);
    assert.equal(qa('[data-pane="billing"] [role="progressbar"]').length, 3);
    for ( const bar of qa('[data-pane="billing"] [role="progressbar"]') ) {
        assert.equal(bar.getAttribute('aria-valuemin'), '0');
        assert.equal(bar.getAttribute('aria-valuemax'), '100');
        assert.ok(Number(bar.getAttribute('aria-valuenow')) >= 0 && Number(bar.getAttribute('aria-valuenow')) <= 100);
        assert.ok(bar.getAttribute('aria-valuetext'));
    }
    assert.equal(pane().querySelector('a[href="/pricing"]').target, '_blank');
    assert.equal(pane().querySelector('a[href="/pricing"]').rel, 'noopener');
    assert.equal(pane().querySelector('a[href="mailto:contact@ezil.work"]').textContent, 'Support');
    assert.equal(pane().querySelector('a[href="/refunds"]').textContent, 'Refunds');
    // All hidden actions below have enabled, clicked controls later in this run.
    for ( const action of ['checkout', 'portal', 'topup'] ) assert.equal(pane().querySelector(`[data-action="${action}"]`), null);
    const banned = /faster|instant|unlimited|priority|vcpu|gpu|heavy use|fair use|gpt|claude|gemini|llama/i;
    assert.ok(banned.test('unlimited'), 'copy guard positive control');
    assert.equal(banned.test(text()), false);

    // Every server state gets its own class on all three separate rows.
    for ( const state of ['ok', 'low', 'exhausted', 'over_cap', 'unavailable'] ) {
        for ( const meter of Object.values(summary.meters) ) meter.state = state;
        await refresh();
        for ( const name of ['workspace', 'storage', 'ai'] ) assert.ok(q(`[data-meter="${name}"]`).classList.contains(`is-${state}`));
    }
    for ( const [status, copy] of [['active', 'Renews on Nov 1, 2026 UTC'], ['cancels', 'Ends on Nov 1, 2026 UTC'], ['past_due', 'Payment failed — update your payment method to keep Pro']] ) {
        summary.plan = { ...summary.plan, id: status === 'past_due' ? 'free' : 'pro', status, renewsAt: '2026-11-01T00:00:00Z', cancelsAt: '2026-11-01T00:00:00Z' };
        await refresh();
        assert.ok(text().includes(copy));
        assert.ok(text().includes(status === 'past_due' ? 'EZiL Free' : 'EZiL Pro'));
    }
    summary.meters.ai = { state: 'ok', trialMicro: '500000', includedMicro: '3000000', purchasedMicro: '10000000', includedExpiresAt: '2026-11-01T00:00:00Z' };
    await refresh();
    assert.match(text(), /\$13.50 left/);
    assert.match(text(), /Included credit expires Nov 1, 2026 UTC/);
    summary.meters.ai.trialMicro = '90071992547409930000';
    summary.meters.ai.includedMicro = '70000';
    summary.meters.ai.purchasedMicro = '0';
    summary.meters.storage.usedBytes = '900719925474099399999';
    await refresh();
    assert.match(text(), /\$90071992547410.00 left/);
    assert.match(text(), /900719925474.1 GB/);
    assert.equal(q('[data-meter="storage"] [role="progressbar"]').getAttribute('aria-valuenow'), '100');
    summary.meters.storage.measuredAt = null;
    await refresh();
    assert.match(text(), /Not measured yet/); // Measured timestamp above is the positive control.

    summary = { enabled: false };
    await refresh();
    assert.match(text(), /Billing isn't available yet/);
    assert.equal(qa('[data-pane="billing"] [data-meter]').length, 0); // Three meters above.
    getSummary = () => failure('server detail');
    await refresh();
    assert.match(text(), /Couldn't load billing. Try again./);
    let releaseSummary;
    getSummary = () => new Promise(resolve => { releaseSummary = resolve; });
    click(q('[data-pane="billing"] [data-action="retry"]'));
    assert.match(text(), /Loading billing/);
    assert.equal(q('[data-role="billing-body"]').getAttribute('aria-busy'), 'true');
    summary = fixture();
    releaseSummary(reply(summary));
    await settle();
    assert.match(text(), /EZiL Free/);
    assert.equal(q('[data-role="billing-body"]').getAttribute('aria-busy'), 'false');
    assert.equal(pane().querySelector('[data-action="retry"]'), null); // Retry clicked above.
    getSummary = () => reply(summary);

    summary.actions = { checkout: true, portal: true, topup: true };
    await refresh();
    for ( const action of ['checkout', 'portal', 'topup'] ) assert.ok(pane().querySelector(`[data-action="${action}"]`));
    assert.match(text(), /Upgrade to Pro — \$20\/month/);
    assert.match(text(), /before applicable tax/);
    assert.match(text(), /\$10.00 credit \+ \$0.84 service fee/);
    let releaseMutation;
    mutation = () => new Promise(resolve => { releaseMutation = resolve; });
    const checkout = q('[data-action="checkout"]');
    assert.equal(checkout.disabled, false);
    click(checkout);
    const mutationCount = calls.length;
    assert.equal(checkout.disabled, true);
    click(checkout);
    assert.equal(calls.length, mutationCount, 'pending guard prevents duplicate mutation');
    assert.equal(calls.at(-1).method, 'POST');
    assert.deepEqual(calls.at(-1).input, { sku: 'pro_monthly_v1' });
    releaseMutation(failure('<img src=x onerror=alert(1)> Payment declined'));
    await settle();
    assert.equal(checkout.disabled, false);
    assert.match(q('[data-role="billing-action-error"]').textContent, /<img src=x onerror=alert\(1\)> Payment declined/);
    assert.equal(pane().querySelector('img'), null, 'error text remains text; literal payload above is the control');
    mutation = () => reply({ url: '#checkout-complete' });
    click(checkout);
    await settle();
    assert.equal(window.location.hash, '#checkout-complete');
    mutation = () => reply({ url: '#portal-complete' });
    click(q('[data-action="portal"]'));
    await settle();
    assert.ok(calls.at(-1).url.endsWith('/billing.portal'));
    assert.deepEqual(calls.at(-1).input, {});
    assert.equal(window.location.hash, '#portal-complete');
    q('[data-role="billing-pack"]').value = '1';
    mutation = () => reply({ url: '#topup-complete' });
    click(q('[data-action="topup"]'));
    await settle();
    assert.deepEqual(calls.at(-1).input, { sku: 'ai_pack_25_v1' });
    assert.equal(window.location.hash, '#topup-complete');
    mutation = () => reply({ url: 'javascript:alert(1)' });
    click(q('[data-action="portal"]'));
    await settle();
    assert.match(text(), /Could not open billing. Try again./);
    assert.equal(window.location.hash, '#topup-complete', 'invalid navigation refused after valid navigation controls');

    // Enabled boot is the positive control for every availability rejection.
    for ( const ctx of [
        { payload: { user: payload.user }, initialTab: 'billing' },
        { payload: { ...payload, features: { billing: false } }, initialTab: 'billing' },
        { payload: { ...payload, features: { billing: 'true' } }, initialTab: 'billing' },
        { payload: { features: { billing: true } }, initialTab: 'billing' },
        { ...context, desktopState: { provider: 'native-macos' }, initialTab: 'billing' },
        { payload: { ...payload, desktopState: { provider: 'native-macos' } }, initialTab: 'billing' },
    ] ) {
        const before = count();
        await open(ctx);
        assert.equal(q('[data-tab="billing"]'), null);
        assert.equal(active(), 'computers');
        assert.equal(count(), before);
    }
    await open({ ...context, initialTab: 'missing' });
    assert.equal(active(), 'computers');
    assert.ok(q('[data-tab="billing"]'));
    const before = count();
    click(q('[data-tab="billing"]'));
    await settle();
    assert.equal(count(), before + 1, 'tab click activates once');
    click(q('[data-tab="billing"]'));
    await settle();
    assert.equal(count(), before + 1, 'already active tab does not activate again');
    window.__EZIL_BOOT__ = payload;
    await open({ initialTab: 'billing' });
    assert.equal(active(), 'billing', 'boot payload fallback enables billing');
    await open({ payload: { features: {} }, initialTab: 'billing' });
    assert.equal(active(), 'computers', 'explicit context features override boot features');
    delete window.__EZIL_BOOT__;
    await open();
    assert.equal(active(), 'billing', 'reopened pane still loads');
    mutation = () => reply({ url: '#reopened' });
    click(q('[data-action="portal"]'));
    await settle();
    assert.equal(window.location.hash, '#reopened', 'reopened pane rebinds actions');
    assert.ok(calls.some(call => call.url.includes('/billing.summary')), 'error-free run made real stubbed requests');
    assert.deepEqual(errors, []);
    console.log('PASS Billing: availability, initial tab, meters, exact amounts, retry, actions, escaping, reopen');
} finally {
    dom.window.close();
}
