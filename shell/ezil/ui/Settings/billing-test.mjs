// billing-test.mjs — EZiL-authored. Exercises Settings with an injected payment surface.
// Bundle the real entry plus the test hook; the parallel sheet needs no local file.
// Fake fetch is the only transport: no server, credentials or network needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../app')] }));

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
        workspace: { usedSeconds: 4320, allowanceSeconds: 28800, remainingSeconds: 23400, resetsAt: '2026-11-01T00:00:00Z', state: 'ok' },
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
let mutation = () => reply({ url: 'https://billing.example.test/session' });
let history = [];
let getHistory = () => reply(history);
const opened = [];
window.open = (...args) => { opened.push(args); };
const sheets = [];
let openerFailure = false;
window.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, input: options.body ? JSON.parse(options.body).json : undefined });
    if ( String(url).includes('/api/trpc/billing.summary') ) return getSummary();
    if ( String(url).includes('/api/trpc/billing.history') ) return getHistory();
    if ( String(url).includes('/api/trpc/billing.') ) return mutation();
    if ( String(url).includes('/api/trpc/computer.list') ) return reply([]);
    return failure('Stubbed endpoint');
};
const bundled = await build({
    stdin: {
        contents: "import './shell/ezil/boot.js'; import { setUpgradeSheetOpener } from './shell/ezil/ui/Settings/tabs/billing.js'; window.setUpgradeSheetOpener = setUpgradeSheetOpener;",
        resolveDir: path.resolve(here, '../../../..'),
    },
    bundle: true, write: false, format: 'iife', target: 'es2022',
    plugins: [{ name: 'payment-surface-port', setup (builder) {
        builder.onResolve({ filter: /upgrade-sheet\.js$/ }, () => ({ path: 'sheet', namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: "export function openUpgradeSheet () { throw new Error('Inject the test opener'); }\n"
            // boot.js also imports the deep-link parser; the stub has no deep link to parse.
            + "export function parseBillingDeepLink () { return null; }" }));
    } }],
});
window.eval(fs.readFileSync(path.join(out, 'icons.js'), 'utf8'));
window.eval(bundled.outputFiles[0].text);
window.setUpgradeSheetOpener(options => {
    if ( openerFailure ) throw new Error('Sheet failed');
    const element = window.document.createElement('div');
    element.dataset.role = 'upgrade-sheet';
    options.container.append(element);
    const handle = { close: () => element.remove() };
    sheets.push({ ...options, handle });
    return handle;
});
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
    assert.equal(count(), 1);
    assert.match(text(), /Plan & usage/);
    assert.match(text(), /Your allowances and what renews when/);
    assert.match(text(), /EZiL Free/);
    assert.match(text(), /Current/);
    assert.match(text(), /Free plan/);
    assert.match(q('[data-meter="workspace"]').textContent, /1 h 12 m\s+of 8 h/);
    assert.match(q('[data-meter="storage"]').textContent, /1.5 GB\s+of 2.0 GB/);
    assert.match(text(), /AI assistant coming soon/);
    assert.match(text(), /\$0.50 trial ready/);
    assert.match(text(), /Resets Nov 1 \(UTC\)/);
    assert.equal(qa('[data-meter]').length, 3);
    assert.equal(qa('[data-meter] [role="progressbar"]').length, 2);
    assert.equal(q('[data-meter="ai"] [role="progressbar"]'), null); // Available AI has a bar below.
    assert.equal(q('[data-role="invoices-empty"]').textContent, 'No invoices yet.');
    for ( const [href, label] of [['/pricing', 'Plans'], ['/refunds', 'Refund policy'], ['mailto:contact@ezil.work', 'Support']] ) {
        assert.equal(pane().querySelector(`a[href="${href}"]`).textContent, label);
    }
    // Enabled, clicked controls later are positive controls for each hidden action.
    for ( const action of ['checkout', 'portal', 'topup'] ) assert.equal(q(`[data-action="${action}"]`), null);
    assert.equal(q('[data-role="billing-nudge"]'), null); // Every attention state below renders a nudge.
    const banned = /faster|instant|unlimited|priority|vcpu|gpu|heavy use|fair use|gpt|claude|gemini|llama/i;
    assert.ok(banned.test('unlimited'));
    assert.equal(banned.test(text()), false);

    for ( const name of ['workspace', 'storage', 'ai'] ) {
        for ( const state of ['ok', 'low', 'exhausted', 'over_cap', 'unavailable'] ) {
            summary = fixture();
            summary.meters[name].state = state;
            await refresh();
            assert.ok(q(`[data-meter="${name}"]`).classList.contains(`is-${state}`));
            assert.equal(!! q('[data-role="billing-nudge"]'), ['low', 'exhausted', 'over_cap'].includes(state));
        }
    }
    summary = fixture();
    summary.meters.workspace = { ...summary.meters.workspace, remainingSeconds: 720, state: 'low' };
    summary.actions.checkout = true;
    await refresh();
    assert.match(text(), /12 minutes of workspace time left this month/);
    assert.ok(q('[data-role="billing-nudge"] [data-action="checkout"]'));
    assert.equal(qa('[data-pane="billing"] .ezil-settings-btn-primary').length, 1);
    summary.meters.workspace.remainingSeconds = 0;
    await refresh();
    assert.match(text(), /Workspace time is used up/);

    for ( const [status, copy] of [['active', 'Renews Nov 1 · $20/month'], ['cancels', 'Ends Nov 1'], ['past_due', 'Payment failed — update your card']] ) {
        summary = fixture();
        summary.plan = { ...summary.plan, id: status === 'past_due' ? 'free' : 'pro', status, renewsAt: '2026-11-01T00:00:00Z', cancelsAt: '2026-11-01T00:00:00Z' };
        summary.actions = { checkout: true, portal: true, topup: false };
        await refresh();
        assert.ok(text().includes(copy));
        assert.equal(q('.ezil-billing-header button').dataset.action, status === 'past_due' ? 'checkout' : 'portal');
        assert.equal(qa('.ezil-billing-header button').length, 1);
        assert.equal(!! q('[data-action="checkout"]'), status === 'past_due');
        assert.match(text(), /USD · before applicable tax/);
        assert.equal(banned.test(text()), false);
    }
    summary.actions.checkout = false;
    await refresh();
    assert.equal(q('.ezil-billing-header button').dataset.action, 'portal');
    summary.meters.ai = { state: 'ok', trialMicro: '500000', includedMicro: '3000000', purchasedMicro: '10000000', includedExpiresAt: '2026-11-01T00:00:00Z' };
    await refresh();
    assert.match(text(), /\$13.50 left/);
    assert.match(text(), /Included credit expires Nov 1/);
    assert.ok(q('[data-meter="ai"] [role="progressbar"]'));
    summary.meters.ai.trialMicro = '90071992547409930000';
    summary.meters.ai.includedMicro = '70000';
    summary.meters.ai.purchasedMicro = '0';
    summary.meters.storage.usedBytes = '900719925474099399999';
    await refresh();
    assert.match(text(), /\$90071992547410.00 left/);
    assert.match(text(), /900719925474.1 GB/);
    assert.equal(q('[data-meter="storage"] [role="progressbar"]').getAttribute('aria-valuenow'), '100');
    summary.meters.storage.measuredAt = new Date(Date.now() - 120000).toISOString();
    await refresh();
    assert.match(text(), /Updated 2 min ago/);
    summary.meters.storage.measuredAt = null;
    await refresh();
    assert.match(text(), /Not measured yet/);

    history = Array.from({ length: 14 }, (_, i) => ({ id: `in_${i}`, number: null, created: `2026-10-${String(i + 1).padStart(2, '0')}T12:00:00Z`, description: `Invoice ${i}`, amountPaidCents: 2000, currency: 'usd', status: 'paid', url: `https://invoice.example.test/${i}` }));
    history[13].description = '<img src=x onerror=alert(1)>';
    history[13].amountPaidCents = '900719925474099300';
    await refresh();
    assert.equal(qa('.ezil-billing-invoice').length, 12);
    assert.equal(q('[data-role="invoices-empty"]'), null); // Empty state above.
    assert.match(q('.ezil-billing-invoice').textContent, /Oct 14, 2026/);
    assert.match(q('.ezil-billing-invoice').textContent, /\$9007199254740993.00/);
    assert.match(q('.ezil-billing-invoice').textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(q('.ezil-billing-invoice img'), null); // Literal payload above.
    assert.equal(q('.ezil-billing-invoice a').target, '_blank');
    assert.equal(q('.ezil-billing-invoice a').rel, 'noopener');
    assert.equal(q('.ezil-billing-invoice a').href, 'https://invoice.example.test/13');
    history[13].url = 'javascript:alert(1)';
    await refresh();
    assert.equal(q('.ezil-billing-invoice').querySelector('a'), null); // Valid URL above.
    assert.match(q('.ezil-billing-invoice').textContent, /Link unavailable/);
    getHistory = () => failure('History failed');
    await refresh();
    assert.match(text(), /Couldn't load invoices/);
    assert.equal(qa('[data-meter]').length, 3);
    assert.ok(q('[data-action="portal"]'));
    getHistory = () => reply([]);
    click(q('[data-role="invoices"] [data-action="retry"]'));
    await settle();
    assert.ok(q('[data-role="invoices-empty"]'));
    assert.equal(q('[data-role="invoices"] [data-action="retry"]'), null); // Clicked above.

    summary = { enabled: false };
    await refresh();
    assert.match(text(), /Billing isn't available yet/);
    assert.equal(qa('[data-meter]').length, 0); // Three above.
    getSummary = () => failure('server detail');
    await refresh();
    assert.match(text(), /Couldn't load billing/);
    let releaseSummary;
    getSummary = () => new Promise(resolve => { releaseSummary = resolve; });
    click(q('[data-action="retry"]'));
    assert.equal(qa('.ezil-billing-skeleton').length, 3);
    assert.equal(q('[data-role="billing-body"]').getAttribute('aria-busy'), 'true');
    summary = fixture();
    releaseSummary(reply(summary));
    await settle();
    assert.match(text(), /EZiL Free/);
    assert.equal(q('[data-role="billing-body"]').getAttribute('aria-busy'), 'false');
    assert.equal(q('.ezil-billing-skeleton'), null); // Loading skeleton above.
    getSummary = () => reply(summary);

    summary.actions = { checkout: true, portal: true, topup: true };
    await refresh();
    assert.equal(q('.ezil-billing-header button').textContent, 'Upgrade to Pro');
    assert.match(text(), /\$10.00 credit \+ \$0.84 service fee/);
    const checkout = q('[data-action="checkout"]');
    click(checkout);
    assert.equal(sheets.length, 1, 'first click opens a sheet');
    click(checkout);
    assert.equal(sheets.length, 1, 'sheet guard blocks a second click');
    assert.equal(sheets[0].sku, 'pro_monthly_v1');
    assert.ok(sheets[0].container.classList.contains('window-body'));
    assert.equal(typeof sheets[0].trpc.query, 'function');
    sheets[0].handle.close();
    await settle();
    click(checkout);
    assert.equal(sheets.length, 2, 'cancellation permits reopening');
    const beforeDone = count();
    const historyBeforeDone = calls.filter(call => call.url.includes('billing.history')).length;
    sheets[1].handle.close();
    sheets[1].onDone();
    await settle();
    assert.equal(count(), beforeDone + 1);
    assert.equal(calls.filter(call => call.url.includes('billing.history')).length, historyBeforeDone + 1);
    openerFailure = true;
    click(q('[data-action="checkout"]'));
    assert.match(text(), /Could not open billing/);
    openerFailure = false;

    const beforeAuto = sheets.length;
    await open({ ...context, initialTab: 'billing', openUpgrade: true });
    assert.equal(sheets.length, beforeAuto + 1, 'deep link auto-opens once');
    sheets.at(-1).handle.close();
    await settle();
    await refresh();
    assert.equal(sheets.length, beforeAuto + 1, 'tab reactivation does not auto-open again');
    summary.actions.checkout = false;
    await open({ ...context, initialTab: 'billing', openUpgrade: true });
    assert.equal(sheets.length, beforeAuto + 1, 'checkout availability gates auto-open');
    click(q('[data-action="portal"]'));
    await settle();
    assert.deepEqual(opened.at(-1), ['https://billing.example.test/session', '_blank', 'noopener']);
    assert.ok(calls.at(-1).url.endsWith('/billing.portal'));
    assert.equal(calls.at(-1).method, 'POST');
    const openedBefore = opened.length;
    let releaseMutation;
    mutation = () => new Promise(resolve => { releaseMutation = resolve; });
    const portal = q('[data-action="portal"]');
    click(portal);
    const pendingCalls = calls.length;
    assert.equal(portal.disabled, true);
    click(portal);
    assert.equal(calls.length, pendingCalls);
    releaseMutation(reply({ url: 'javascript:alert(1)' }));
    await settle();
    assert.equal(opened.length, openedBefore); // Valid portal opened above.
    assert.equal(portal.disabled, false);
    assert.match(text(), /Could not open billing/);
    mutation = () => reply({ url: 'https://billing.example.test/pack' });
    q('[data-role="billing-pack"]').value = '1';
    click(q('[data-action="topup"]'));
    await settle();
    assert.deepEqual(calls.at(-1).input, { sku: 'ai_pack_25_v1' });
    assert.equal(opened.at(-1)[0], 'https://billing.example.test/pack');

    // Enabled boot above is the positive control for every availability rejection.
    for ( const ctx of [
        { payload: { user: payload.user }, initialTab: 'billing' },
        { payload: { ...payload, features: { billing: false } }, initialTab: 'billing' },
        { payload: { ...payload, features: { billing: 'true' } }, initialTab: 'billing' },
        { payload: { features: { billing: true } }, initialTab: 'billing' },
        { ...context, desktopState: { provider: 'native-macos' }, initialTab: 'billing' },
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
    assert.equal(count(), before + 1);
    click(q('[data-tab="billing"]'));
    await settle();
    assert.equal(count(), before + 1);
    await open();
    click(q('[data-action="portal"]'));
    await settle();
    assert.equal(opened.at(-1)[0], 'https://billing.example.test/pack', 'reopened pane rebinds actions');
    for ( const element of qa('[data-pane="billing"] button, [data-pane="billing"] a') ) assert.ok(element.getAttribute('aria-label') || element.textContent.trim());
    assert.ok(calls.some(call => call.url.includes('/billing.summary')));
    assert.deepEqual(errors, []);
    console.log('PASS Billing: states, action choice, nudge, invoices, exact amounts, retry, sheet guard, deep link, portal, feature gate, reopen');
} finally {
    dom.window.close();
}
