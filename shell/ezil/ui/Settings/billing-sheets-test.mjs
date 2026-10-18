// Real sheet modules, deterministic tRPC DTO fakes, no network or browser.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [path.resolve(here, '../../../../app')] }));
const bundle = (await build({
    stdin: { contents: "import * as sheets from './billing-sheets.js'; import { openUpgradeSheet } from './upgrade-sheet.js'; import { BANNED_COPY } from './billing-format.js'; window.api = { ...sheets, openUpgradeSheet, BANNED_COPY };", resolveDir: here },
    bundle: true, write: false, format: 'iife', target: 'es2022',
})).outputFiles[0].text;
const css = fs.readFileSync(new URL('./upgrade-sheet.css', import.meta.url), 'utf8');
const banned = /faster|instant|unlimited|priority|gpu|heavy\s+use|fair\s+use|gpt|claude|gemini|llama|memory\s+is\s+kept|memory\s+survives|processes\s+keep\s+running|ai\s+included|includes\s+ai/i;
const END = '2026-11-01T00:00:00Z';
const TERMS = 'overage-v2-2026-10-18';
const COMPUTE = 'compute_monthly_v2', STANDARD = 'standard_monthly_v2';
const clone = data => JSON.parse(JSON.stringify(data));
const ok = data => ({ ok: true, data });
const fail = message => ({ ok: false, code: 'BAD_REQUEST', message });
const settle = async () => { for ( let i = 0; i < 20; i++ ) await Promise.resolve(); };
function deferred () { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture () {
    return {
        enabled: true, version: 2,
        plan: { sku: COMPUTE, family: 'compute', status: 'active', periodStart: '2026-10-01T00:00:00Z', periodEnd: END, renewsAt: END, cancelsAt: null, scheduledChange: null, pendingUpgrade: null, paymentIssue: null },
        actions: { checkout: true, portal: true, upgrade: true, downgrade: true, cancel: true, overage: true, selectSize: true },
        overage: { available: true, enabled: false, centsPerStdHour: 25, capCents: 4000, defaultCapCents: 2500, maxCapCents: 10000, accruedCents: 0, termsVersion: TERMS, acceptedVersion: null, acceptedAt: null, pausedReason: null },
        catalog: { version: 2, offers: [
            { sku: STANDARD, family: 'standard', priceCents: 2000, currency: 'usd', interval: 'month', allowanceStdSeconds: 216000, sizes: ['std-2'], overage: null },
            { sku: COMPUTE, family: 'compute', priceCents: 10000, currency: 'usd', interval: 'month', allowanceStdSeconds: 1800000, sizes: ['std-2', 'cmp-4', 'cmp-8'], overage: { centsPerStdHour: 25, defaultCapCents: 2500, maxCapCents: 10000 } },
        ], sizes: [
            { code: 'free-cf', vcpu: 2, memoryGiB: 6, weight: 1 },
            { code: 'std-2', vcpu: 2, memoryGiB: 8, weight: 1 },
            { code: 'cmp-4', vcpu: 4, memoryGiB: 16, weight: 2 },
            { code: 'cmp-8', vcpu: 8, memoryGiB: 32, weight: 4 },
        ] },
    };
}
const preview = { toSku: COMPUTE, prorationDate: 1792324807, amountDueCents: 4321, currency: 'usd', lines: [
    { description: 'Unused Standard time', amountCents: -1234 }, { description: 'Remaining Compute time', amountCents: 5555 },
], periodEnd: END, grantStdSeconds: 212.599 * 3600 | 0 };
const confirmation = status => ({ status, invoiceId: 'in_test', hostedInvoiceUrl: 'https://invoice.example.test/pay', expiresAt: status === 'payment_failed' ? '2026-10-20T13:45:00Z' : null });
const names = { upgrade: 'openComputeUpgradeSheet', downgrade: 'openDowngradeSheet', cancel: 'openCancelSheet', overage: 'openOverageSheet' };
const procedures = { upgrade: 'billing.confirmUpgrade', downgrade: 'billing.scheduleDowngrade', cancel: 'billing.cancelAtPeriodEnd', overage: 'billing.setOverage' };
const payloads = { upgrade: { toSku: COMPUTE, prorationDate: preview.prorationDate }, downgrade: { toSku: STANDARD }, cancel: { cancel: true }, overage: { enabled: true, capCents: 2500, termsVersion: TERMS } };
function harness () {
    const dom = new JSDOM('<!doctype html><body><button id="opener">Billing action</button><main id="container"></main><aside inert>Already inert</aside></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/os' });
    const { window } = dom, doc = window.document;
    window.eval(bundle);
    const calls = [], errors = [], states = [];
    let closed = 0, done = 0;
    window.addEventListener('error', event => errors.push(event.message));
    window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
    const h = {
        window, doc, calls, errors, states, summary: fixture(),
        get closed () { return closed; }, get done () { return done; },
        q: selector => doc.querySelector(selector),
        text: () => doc.querySelector('[role="dialog"]')?.textContent ?? '',
        reply: (method, input) => {
            if ( method === 'billing.previewUpgrade' ) return ok(clone(preview));
            if ( method === 'billing.confirmUpgrade' ) return ok(confirmation('applied'));
            if ( method === 'billing.scheduleDowngrade' ) return ok({ effectiveAt: END });
            if ( method === 'billing.cancelAtPeriodEnd' ) return ok({ cancelsAt: END });
            if ( method === 'billing.setOverage' ) return ok({ ...h.summary.overage, ...input, acceptedVersion: TERMS });
            throw new Error(`Unexpected ${method}`);
        },
        click: selector => { const el = h.q(selector); assert.ok(el, selector); el.click(); },
        key: (key, shiftKey = false) => doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })),
        input: value => { const el = h.q('input[type="number"]'); el.value = String(value); el.dispatchEvent(new window.Event('input', { bubbles: true })); },
        count: method => calls.filter(c => c.method === method).length,
    };
    const observer = new window.MutationObserver(() => { if ( h.q('[role="dialog"]') ) states.push(h.text()); });
    observer.observe(doc.body, { subtree: true, childList: true, characterData: true });
    h.options = () => ({ container: h.q('#container'), summary: h.summary, trpc: { mutate: async (method, input) => { calls.push({ method, input: clone(input) }); return h.reply(method, input); } }, onClose: () => { closed++; }, onDone: () => { done++; } });
    h.open = (kind = 'upgrade', extra = {}) => {
        h.handle = window.api[names[kind]]({ ...h.options(), ...extra });
        h.audit();
        return h.handle;
    };
    h.checkout = () => {
        const offer = h.summary.catalog.offers[0];
        h.handle = window.api.openUpgradeSheet({ ...h.options(), sku: offer.sku, offer, sizes: h.summary.catalog.sizes });
        return h.handle;
    };
    h.ready = async kind => { h.open(kind); await settle(); h.audit(); if ( kind === 'overage' ) h.click('input[type="checkbox"]'); };
    h.audit = () => {
        assert.doesNotMatch(h.text(), banned);
        for ( const element of doc.querySelectorAll('[role="dialog"] button, [role="dialog"] input, [role="dialog"] a, [role="dialog"] summary') ) {
            const name = element.getAttribute('aria-label') || (element.tagName === 'INPUT' ? [...element.labels].map(label => label.textContent).join('') : element.textContent);
            assert.ok(name?.trim(), `accessible name: ${element.outerHTML}`);
        }
        assert.deepEqual(errors, []);
    };
    h.cleanup = () => { h.handle?.close(); observer.disconnect(); window.close(); };
    h.q('#opener').focus();
    return h;
}
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
for ( const kind of Object.keys(names) ) {
    test(`${kind}: named dialog, focus trap, compact frame and inert restore`, async h => {
        h.window.innerWidth = 390;
        await h.ready(kind);
        const dialog = h.q('[role="dialog"]');
        assert.equal(dialog.dataset.role, 'billing-sheet');
        assert.equal(dialog.dataset.sheet, kind);
        assert.equal(dialog.getAttribute('aria-modal'), 'true');
        assert.ok(dialog.getAttribute('aria-label'));
        assert.equal(dialog.parentElement.parentElement, h.doc.body);
        assert.ok(h.q('#container').hasAttribute('inert'));
        assert.equal(h.doc.body.style.overflow, 'hidden');
        assert.ok(h.q('.ezil-upgrade-backdrop.is-compact'));
        const close = h.q('[data-action="close-sheet"]');
        const last = [...dialog.querySelectorAll('button, input, a[href]')].filter(el => ! el.disabled).at(-1);
        last.focus(); h.key('Tab'); assert.equal(h.doc.activeElement, close);
        close.focus(); h.key('Tab', true); assert.equal(h.doc.activeElement, last);
        h.q('[data-focus-edge="start"]').focus(); assert.equal(h.doc.activeElement, last);
        h.q('[data-focus-edge="end"]').focus(); assert.equal(h.doc.activeElement, close);
        h.key('Escape');
        assert.equal(h.q('[role="dialog"]'), null);
        assert.equal(h.closed, 1);
        assert.equal(h.doc.activeElement, h.q('#opener'));
        assert.equal(h.q('#container').hasAttribute('inert'), false);
        assert.ok(h.q('aside').hasAttribute('inert'));
        assert.equal(h.doc.body.style.overflow, '');
    });
    for ( const way of ['×', 'backdrop', 'handle', 'owner removed', 'backdrop removed', 'Done'] ) {
        test(`${kind}: ${way} closes once and restores focus`, async h => {
            await h.ready(kind);
            if ( way === 'Done' ) {
                h.click('[data-action="confirm"]'); await settle();
                assert.equal(h.done, 0, 'refresh waits for dismissal');
                h.click('[data-action="done"]');
            } else if ( way === '×' ) h.click('[data-action="close-sheet"]');
            else if ( way === 'backdrop' ) h.click('.ezil-upgrade-backdrop');
            else if ( way === 'owner removed' ) h.q('#container').remove();
            else if ( way === 'backdrop removed' ) h.q('.ezil-upgrade-backdrop').remove();
            else h.handle.close();
            await settle(); h.handle.close();
            assert.equal(h.closed, 1);
            assert.equal(h.done, way === 'Done' ? 1 : 0);
            assert.equal(h.q('[role="dialog"]'), null);
            assert.equal(h.doc.activeElement, h.q('#opener'));
        });
    }
    test(`${kind}: exact payload, double click, backdrop lock, late response isolation`, async h => {
        await h.ready(kind);
        const pending = deferred(), original = h.reply;
        h.reply = (method, input) => method === procedures[kind] ? pending.promise : original(method, input);
        const primary = h.q('[data-action="confirm"]');
        primary.click(); primary.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
        assert.ok(primary.disabled);
        assert.equal(h.count(procedures[kind]), 1);
        assert.deepEqual(h.calls.find(c => c.method === procedures[kind]).input, payloads[kind]);
        h.click('.ezil-upgrade-backdrop');
        assert.ok(h.q('[role="dialog"]'));
        const old = h.q('[role="dialog"]');
        h.click('[data-action="close-sheet"]');
        const oldHTML = old.innerHTML;
        h.reply = original;
        await h.ready(kind);
        const newHTML = h.q('[role="dialog"]').innerHTML;
        pending.resolve(original(procedures[kind], payloads[kind])); await settle();
        assert.equal(old.innerHTML, oldHTML);
        assert.equal(h.q('[role="dialog"]').innerHTML, newHTML);
        assert.equal(h.done, 0);
    });
    test(`${kind}: checkout and every billing opener share the document guard`, async h => {
        const first = h.open(kind);
        for ( const next of Object.keys(names) ) assert.equal(h.open(next), first);
        assert.equal(h.checkout(), first);
        assert.equal(h.doc.querySelectorAll('[role="dialog"]').length, 1);
        assert.equal(h.count('billing.createCheckout'), 0);
        first.close();
        const pending = deferred(); h.reply = () => pending.promise;
        const checkout = h.checkout();
        assert.equal(h.open(kind), checkout);
        assert.equal(h.count('billing.createCheckout'), 1);
        assert.equal(h.doc.querySelectorAll('[role="dialog"]').length, 1);
    });
    test(`${kind}: server error maps message and a retry can succeed`, async h => {
        await h.ready(kind);
        const original = h.reply;
        h.reply = () => fail('stripe_unavailable');
        h.click('[data-action="confirm"]'); await settle(); h.audit();
        assert.match(h.text(), /Payments are unavailable right now. Try again in a few minutes./);
        assert.equal(h.q('[data-action="confirm"]').disabled, false);
        h.reply = original;
        h.click('[data-action="confirm"]'); await settle();
        assert.ok(h.q('[data-action="done"]'));
    });
    test(`${kind}: actions flag gates opening, regardless of family`, async h => {
        h.summary.actions[kind] = false;
        assert.throws(() => h.open(kind), /unavailable/);
        assert.equal(h.q('[role="dialog"]'), null);
        assert.equal(h.calls.length, 0);
    });
}

test('upgrade: preview shows signed invoice lines, amount and floored grant', async h => {
    h.open();
    assert.match(h.text(), /Checking the price…/);
    assert.equal(h.q('[data-action="confirm"]'), null);
    await settle();
    assert.deepEqual(h.calls, [{ method: 'billing.previewUpgrade', input: { toSku: COMPUTE } }]);
    assert.match(h.text(), /Unused Standard time−\$12.34/);
    assert.match(h.text(), /Remaining Compute time\$55.55/);
    assert.match(h.text(), /Due now \$43.21/);
    assert.match(h.text(), /USD. Any applicable tax appears on the invoice./);
    assert.match(h.text(), /Adds 212.5 standard-hours for the rest of this period \(until Nov 1\). Your usage so far carries over./);
    assert.equal(h.q('[data-action="confirm"]').textContent, 'Pay $43.21 and upgrade');
});
for ( const [kind, action, label] of [['upgrade', 'not-now', 'Not now'], ['downgrade', 'keep', 'Keep Compute']] ) {
    test(`${kind}: secondary ${label} closes without a request or refresh`, async h => {
        await h.ready(kind);
        const secondary = h.q(`[data-action="${action}"]`);
        assert.equal(secondary.textContent, label);
        assert.ok(secondary.classList.contains('ezil-billing-sheet-secondary'));
        assert.equal(secondary.previousElementSibling, h.q('[data-action="confirm"]'), 'primary comes first');
        const before = h.calls.length;
        secondary.click();
        await settle();
        assert.equal(h.calls.length, before, 'dismissal sends no request');
        assert.equal(h.count(procedures[kind]), 0, 'plan was not changed');
        assert.equal(h.done, 0);
        assert.equal(h.closed, 1);
        assert.equal(h.q('[role="dialog"]'), null);
        assert.equal(h.doc.activeElement, h.q('#opener'));
        h.handle.close();
        assert.equal(h.closed, 1);
    });
}
for ( const status of ['applied', 'requires_action', 'payment_failed'] ) {
    test(`upgrade: ${status} result and Done`, async h => {
        await h.ready('upgrade');
        h.reply = () => ok(confirmation(status));
        h.click('[data-action="confirm"]'); await settle(); h.audit();
        const text = h.text();
        if ( status === 'applied' ) assert.match(text, /You're on EZiL Compute/);
        else {
            if ( status === 'requires_action' ) {
                assert.match(text, /Confirm the payment with your bank to finish./);
                assert.match(text, /Your plan changes once payment is confirmed./);
            } else {
                assert.match(text, /The payment didn't go through./);
                assert.match(text, /Your upgrade is held until Oct 20, 2026 at 13:45 UTC. Pay the invoice or update your payment method before then./);
            }
            const link = h.q('[data-action="open-invoice"]');
            assert.equal(link.href, 'https://invoice.example.test/pay');
            assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener');
            h.click('.ezil-upgrade-backdrop'); assert.ok(h.q('[role="dialog"]'), 'payment still pending');
        }
        assert.equal(h.q('[data-action="confirm"]'), null);
        assert.equal(h.done, 0);
        h.click('[data-action="done"]');
        assert.equal(h.done, 1); assert.equal(h.closed, 1);
    });
}
for ( const url of ['http://invoice.example.test/pay', 'javascript:alert(1)', null] ) {
    test(`upgrade: invoice URL ${url} is validated`, async h => {
        await h.ready('upgrade');
        h.reply = () => ok({ ...confirmation('requires_action'), hostedInvoiceUrl: url });
        h.click('[data-action="confirm"]'); await settle();
        assert.equal(!!h.q('[data-action="open-invoice"]'), url?.startsWith('http:') === true);
        assert.ok(h.q('[data-action="done"]'));
    });
}
test('upgrade: failed preview has Retry, never Pay; late preview cannot alter a closed dialog', async h => {
    h.reply = () => fail('upgrade_not_allowed');
    h.open(); await settle(); h.audit();
    assert.match(h.text(), /This plan can't be upgraded right now./);
    assert.equal(h.q('[data-action="confirm"]'), null);
    const pending = deferred(); h.reply = () => pending.promise;
    h.click('[data-action="retry"]');
    assert.match(h.text(), /Checking the price…/);
    h.click('.ezil-upgrade-backdrop'); assert.ok(h.q('[role="dialog"]'));
    const old = h.q('[role="dialog"]'); h.handle.close(); const html = old.innerHTML;
    pending.resolve(ok(preview)); await settle();
    assert.equal(old.innerHTML, html);
    h.reply = () => ok(preview);
    h.open(); await settle(); assert.ok(h.q('[data-action="confirm"]'));
});
test('upgrade: malicious descriptions are plain text and large cents stay exact', async h => {
    h.reply = () => ok({ ...preview, lines: [{ description: '<img src=x onerror=alert(1)>', amountCents: '-9007199254740993123' }] });
    h.open(); await settle();
    assert.match(h.text(), /<img src=x onerror=alert\(1\)>/);
    assert.match(h.text(), /−\$90071992547409931.23/);
    assert.equal(h.q('[role="dialog"] img'), null);
});
test('upgrade: Retry re-previews once and confirms the refreshed proration date', async h => {
    h.reply = () => fail('stripe_unavailable');
    h.open(); await settle();
    const pending = deferred();
    h.reply = () => pending.promise;
    const retry = h.q('[data-action="retry"]');
    retry.click(); retry.click();
    assert.equal(h.count('billing.previewUpgrade'), 2);
    assert.equal(h.q('[data-action="confirm"]'), null);
    pending.resolve(ok({ ...preview, prorationDate: 1792400999, amountDueCents: 2900 }));
    await settle();
    assert.equal(h.q('[data-action="confirm"]').textContent, 'Pay $29 and upgrade');
    h.reply = () => ok(confirmation('applied'));
    h.click('[data-action="confirm"]'); await settle();
    assert.deepEqual(h.calls.at(-1).input, { toSku: COMPUTE, prorationDate: 1792400999 });
});
test('upgrade: a nullable failure expiry never invents a deadline', async h => {
    await h.ready('upgrade');
    h.reply = () => ok({ ...confirmation('payment_failed'), expiresAt: null, hostedInvoiceUrl: null });
    h.click('[data-action="confirm"]'); await settle();
    assert.match(h.text(), /The payment didn't go through./);
    assert.match(h.text(), /Pay the invoice or update your payment method to finish your upgrade./);
    assert.doesNotMatch(h.text(), /held until|Invalid Date|undefined|null/);
    assert.equal(h.q('[data-action="open-invoice"]'), null);
});
test('downgrade: Standard allowance, size and server effective date drive the copy', async h => {
    h.summary.catalog.offers[0].allowanceStdSeconds = 67 * 3600;
    h.summary.catalog.sizes[1].memoryGiB = 10;
    h.open('downgrade');
    assert.match(h.text(), /You keep EZiL Compute until Nov 1. From then: 67 standard-hours each billing period on a 2 vCPU · 10 GiB computer; 4 and 8 vCPU and overage end./);
    assert.equal(h.q('[data-action="confirm"]').textContent, 'Switch on Nov 1');
    h.reply = () => ok({ effectiveAt: '2026-11-02T00:00:00Z' });
    h.click('[data-action="confirm"]'); await settle();
    assert.match(h.text(), /Scheduled. You switch to Standard on Nov 2./);
});
test('cancel: plan name, period end, danger action and Keep plan', async h => {
    h.summary.plan.family = 'standard';
    h.open('cancel');
    assert.match(h.text(), /Cancel EZiL Standard/);
    assert.match(h.text(), /Your plan stays active until Nov 1, then moves to Free. You can resume any time before then./);
    assert.ok(h.q('[data-action="confirm"]').classList.contains('ezil-billing-sheet-danger'));
    h.click('[data-action="keep"]'); assert.equal(h.closed, 1); assert.equal(h.calls.length, 0);
    h.open('cancel');
    h.reply = () => ok({ cancelsAt: '2026-11-03T00:00:00Z' });
    h.click('[data-action="confirm"]'); await settle(); assert.match(h.text(), /Your plan ends Nov 3./);
});
test('overage: defaults, whole-dollar validation, live consent and cap-hours helper', async h => {
    h.open('overage');
    const input = h.q('input[type="number"]'), submit = h.q('[data-action="confirm"]');
    assert.equal(input.value, '25'); assert.equal(input.inputMode, 'numeric');
    assert.equal(input.min, '0'); assert.equal(input.max, '100'); assert.equal(input.step, '1');
    assert.match(h.text(), /Whole dollars, \$0 to \$100./);
    assert.match(h.text(), /When your 500 standard-hours are used up, keep working at \$0.25 per standard-hour/);
    assert.match(h.text(), /Usage is billed separately after each billing period, on its own invoice./);
    assert.match(h.text(), /Up to 100 extra standard-hours \(≈ 25 h at 8 vCPU\)./);
    assert.ok(submit.disabled); h.click('[data-action="confirm"]'); assert.equal(h.calls.length, 0);
    h.click('input[type="checkbox"]'); assert.equal(submit.disabled, false);
    for ( const invalid of ['-1', '101', '2.5', ''] ) { h.input(invalid); assert.ok(submit.disabled, invalid); h.audit(); }
    h.input('30'); assert.equal(submit.disabled, false);
    assert.equal(h.q('.ezil-billing-consent').textContent, 'I agree that usage beyond my allowance is billed separately after each billing period, up to my cap of $30.');
    assert.match(h.text(), /Up to 120 extra standard-hours \(≈ 30 h at 8 vCPU\)./);
    h.input('0'); assert.equal(submit.disabled, false);
    h.input('100'); assert.equal(submit.disabled, false);
    h.handle.close(); h.summary.overage.enabled = true;
    h.open('overage'); assert.equal(h.q('input[type="number"]').value, '40');
    assert.equal(h.q('[data-action="confirm"]').textContent, 'Save cap'); assert.ok(h.q('[data-action="confirm"]').disabled);
});
test('overage: rate, allowance, ceiling and size weight use the DTO', async h => {
    h.summary.overage = { ...h.summary.overage, centsPerStdHour: 50, maxCapCents: 8000, defaultCapCents: 3000 };
    h.summary.catalog.offers[1].allowanceStdSeconds = 700 * 3600;
    h.summary.catalog.sizes[3].weight = 2;
    h.open('overage');
    assert.match(h.text(), /When your 700 standard-hours are used up, keep working at \$0.50/);
    assert.match(h.text(), /Whole dollars, \$0 to \$80./);
    assert.match(h.text(), /Up to 60 extra standard-hours \(≈ 30 h at 8 vCPU\)./);
    assert.equal(h.q('input[type="number"]').max, '80');
});
for ( const [code, copy] of [['cap_out_of_range', 'Choose a cap between $0 and $80.'], ['terms_version_mismatch', 'The overage terms changed. Review them and try again.']] ) {
    test(`overage: ${code} uses message, preserves consent and supports retry`, async h => {
        h.summary.overage.maxCapCents = 8000;
        await h.ready('overage');
        const original = h.reply;
        h.reply = () => fail(code);
        h.click('[data-action="confirm"]'); await settle(); h.audit();
        assert.equal(h.q('[role="alert"]').textContent, copy);
        assert.equal(h.q('[data-action="confirm"]').disabled, false);
        h.reply = original;
        h.click('[data-action="confirm"]'); await settle();
        assert.match(h.text(), /Overage is on, up to \$25 a period./);
    });
}
test('overage: success uses the returned cap and submit echoes the active terms version', async h => {
    h.summary.overage.termsVersion = 'overage-v2-next';
    await h.ready('overage'); h.input('35');
    h.reply = () => ok({ ...h.summary.overage, enabled: true, capCents: 3000 });
    h.click('[data-action="confirm"]'); await settle();
    assert.deepEqual(h.calls[0].input, { enabled: true, capCents: 3500, termsVersion: 'overage-v2-next' });
    assert.match(h.text(), /Overage is on, up to \$30 a period./);
});
test('v2 copy scan positive controls and responsive/focus/motion styles', async h => {
    for ( const term of h.window.api.BANNED_COPY ) assert.ok(banned.test(term), term);
    assert.match(css, /flex-wrap: wrap/); assert.match(css, /tabular-nums/);
    assert.match(css, /:focus-visible/); assert.match(css, /prefers-reduced-motion/);
});
let failed = 0, states = 0;
for ( const { name, fn } of tests ) {
    const h = harness();
    try {
        await fn(h); await settle(); h.audit();
        for ( const state of h.states ) assert.doesNotMatch(state, banned);
        states += h.states.length;
        console.log(`PASS ${name}`);
    } catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
    finally { h.cleanup(); }
}
console.log(`${tests.length - failed}/${tests.length} billing sheet tests passed; ${states} rendered states scanned`);
process.exitCode = failed ? 1 : 0;
