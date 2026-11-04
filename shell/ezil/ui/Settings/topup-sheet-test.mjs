// topup-sheet-test.mjs — EZiL-authored. The Add AI credits dialog in jsdom with
// the real module bundled and a fake tRPC client. SYNTHETIC FIXTURES ONLY: no
// network, no Stripe, no real account; balances and catalogs below are invented.
import { summaryV3 } from './billing-v3-fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [path.resolve(here, '../../../../app')] }));
const source = (await build({
    stdin: { contents: "import * as topup from './topup-sheet.js'; window.topupApi = topup;", resolveDir: here },
    bundle: true, write: false, format: 'iife', target: 'es2022',
})).outputFiles[0].text;
const css = fs.readFileSync(new URL('./topup-sheet.css', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for ( let i = 0; i < 20; i++ ) await Promise.resolve(); };
const USER = 'fixture-user-1';
// The live catalog's shape (1,000 / 5,000 / 10,000 credits at $80 / $350 / $700) with synthetic SKUs.
const packs = [
    { sku: 'ai_pack_fixture_1k', aiCredits: 1000, creditCents: 10000, discountPercent: 20, totalCents: 8000, currency: 'usd' },
    { sku: 'ai_pack_fixture_5k', aiCredits: 5000, creditCents: 50000, discountPercent: 30, totalCents: 35000, currency: 'usd' },
    { sku: 'ai_pack_fixture_10k', aiCredits: 10000, creditCents: 100000, discountPercent: 30, totalCents: 70000, currency: 'usd' },
];
const customTopup = { minCents: 1000, maxCents: 1000000, centsPerCredit: 10 };
function fixture (tier = 'standard', remainingMicro = '271855000000', owner = USER) {
    const summary = summaryV3(tier);
    summary.actions.topup = true;
    summary.catalog.packs = packs.map(pack => ({ ...pack }));
    summary.catalog.customTopup = { ...customTopup };
    summary.ai.enrollment = 'enrolled';
    summary.ai.account = remainingMicro === null ? null : { userId: owner, remainingMicro, totalMicro: remainingMicro, labelled: false, grants: [] };
    return summary;
}
const quoteOf = input => {
    if ( 'sku' in input ) {
        const pack = packs.find(item => item.sku === input.sku);
        return pack ? { ok: true, data: { sku: pack.sku, custom: false, aiCredits: pack.aiCredits, creditCents: pack.creditCents, discountPercent: pack.discountPercent, totalCents: pack.totalCents, currency: 'usd' } }
            : { ok: false, code: 'BAD_REQUEST', message: 'unknown_pack' };
    }
    return { ok: true, data: { sku: 'ai_custom_v2', custom: true, aiCredits: input.customAmountCents / 10, creditCents: input.customAmountCents, discountPercent: 0, totalCents: input.customAmountCents, currency: 'usd' } };
};

function harness () {
    const dom = new JSDOM('<!doctype html><head></head><body><button id="opener">Add credits</button><main id="container"></main></body>', {
        runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/os',
    });
    const { window } = dom;
    const document = window.document;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    window.eval(source);
    const calls = [], checkouts = [], upgrades = [];
    let closed = 0;
    const h = {
        window, document, calls, checkouts, upgrades, api: window.topupApi,
        get closed () { return closed; },
        quote: async (_method, input) => quoteOf(input),
        q: selector => document.querySelector(selector),
        qa: selector => [...document.querySelectorAll(selector)],
        text: () => document.querySelector('[data-sheet="topup"]')?.textContent ?? '',
        value: role => document.querySelector(`[data-role="${role}"] dd`)?.textContent,
        rowHidden: role => document.querySelector(`[data-role="${role}"]`)?.hidden,
        pick: value => {
            const radio = document.querySelector(`input[name="ezil-topup-amount"][value="${value}"]`);
            assert.ok(radio, `option ${value} exists`);
            radio.checked = true;
            radio.dispatchEvent(new window.Event('change', { bubbles: true }));
        },
        type: text => {
            const input = document.querySelector('#ezil-topup-custom-input');
            input.value = text;
            input.dispatchEvent(new window.Event('input', { bubbles: true }));
        },
        submit: () => document.querySelector('form.ezil-topup-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
        key: key => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
    };
    h.trpc = { query: async (method, input) => { calls.push({ method, input }); return h.quote(method, input); }, mutate: async () => { throw new Error('the dialog never mutates'); } };
    h.open = (summary = fixture(), options = {}) => {
        h.handle = window.topupApi.openTopupSheet({ container: h.q('#container'), summary, trpc: h.trpc, userId: USER,
            checkout: params => checkouts.push(params), upgrade: choice => upgrades.push(choice), onClose: () => { closed++; }, ...options });
        return h.handle;
    };
    h.q('#opener').focus();
    return h;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('focused dialog: authoritative balance, the catalog presets, Custom, and an amount-specific primary', async h => {
    h.open();
    const dialog = h.q('[role="dialog"][data-sheet="topup"]');
    assert.ok(dialog);
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(h.q(`#${dialog.getAttribute('aria-labelledby')}`).textContent, 'Add AI credits');
    assert.ok(h.q('#container').hasAttribute('inert'), 'the page behind is inert');
    assert.equal(h.q('[data-role="topup-balance"] strong').textContent, '271,855 credits');
    assert.deepEqual(h.qa('.ezil-topup-option').map(option => option.querySelector('strong').textContent),
        ['1,000 credits', '5,000 credits', '10,000 credits', 'Custom amount']);
    assert.deepEqual(h.qa('.ezil-topup-option .ezil-topup-save').map(node => node.textContent), ['Save 20%', 'Save 30%', 'Save 30%']);
    assert.match(h.q('[data-option="ai_pack_fixture_1k"]').textContent, /\$80/);
    assert.match(h.q('[data-option="ai_pack_fixture_5k"]').textContent, /\$350/);
    assert.match(h.q('[data-option="ai_pack_fixture_10k"]').textContent, /\$700/);
    assert.equal(h.document.activeElement, h.q('input[value="ai_pack_fixture_1k"]'), 'the first preset is selected and focused');
    assert.equal(h.value('topup-added'), '+1,000');
    assert.equal(h.value('topup-new-balance'), '272,855');
    assert.equal(h.value('topup-discount'), '−$20 (20%)');
    assert.equal(h.value('topup-total'), '$80 USD');
    assert.equal(h.q('[data-action="topup-continue"]').textContent, 'Continue to payment · $80');
    assert.equal(h.q('[data-role="topup-custom"]').hidden, true, 'the custom input appears only for Custom');
    assert.doesNotMatch(h.text(), /₹|INR|auto-reload|automatic/i, 'USD only; no unrequested auto-reload');
    for ( const control of h.qa('[data-sheet="topup"] button, [data-sheet="topup"] input') ) {
        const name = control.getAttribute('aria-label') || control.textContent.trim() || [...(control.labels ?? [])].map(label => label.textContent).join('').trim();
        assert.ok(name, 'every control has an accessible name');
    }
    h.pick('ai_pack_fixture_10k');
    assert.equal(h.value('topup-added'), '+10,000');
    assert.equal(h.value('topup-discount'), '−$300 (30%)');
    assert.equal(h.value('topup-total'), '$700 USD');
});

test('custom amount: whole dollars within the server tariff; credits are 10 per dollar with no discount', async h => {
    h.open();
    h.pick('custom');
    assert.equal(h.q('[data-role="topup-custom"]').hidden, false);
    assert.equal(h.document.activeElement, h.q('#ezil-topup-custom-input'));
    assert.match(h.q('#ezil-topup-custom-hint').textContent, /Whole dollars, \$10 to \$10000\. 10 credits per dollar, no discount\./);
    assert.equal(h.q('[data-action="topup-continue"]').disabled, true, 'empty: nothing to pay yet');
    for ( const [text, credits, total] of [['50', '+500', '$50 USD'], ['$1,250', '+12,500', '$1250 USD'], ['80.00', '+800', '$80 USD'], ['10000', '+100,000', '$10000 USD'], ['010', '+100', '$10 USD']] ) {
        h.type(text);
        assert.equal(h.value('topup-added'), credits, text);
        assert.equal(h.value('topup-total'), total, text);
        assert.equal(h.rowHidden('topup-discount'), true, 'custom has no discount');
        assert.equal(h.q('#ezil-topup-custom-input').getAttribute('aria-invalid'), 'false');
        assert.equal(h.q('[data-action="topup-continue"]').disabled, false);
    }
    for ( const [text, copy] of [['12.50', /whole dollars, without cents/], ['9', /between \$10 and \$10000/], ['10001', /between \$10 and \$10000/],
        ['99999999999999', /between/], ['abc', /a number of dollars/], ['1e3', /a number of dollars/], ['-5', /a number of dollars/], ['5 0', /a number of dollars/]] ) {
        h.type(text);
        assert.equal(h.q('#ezil-topup-custom-input').getAttribute('aria-invalid'), 'true', text);
        assert.match(h.q('[data-role="topup-custom-error"]').textContent, copy, text);
        assert.equal(h.q('[data-action="topup-continue"]').disabled, true, text);
        assert.equal(h.value('topup-total'), '—');
    }
    h.type('');
    h.submit(); await settle();
    assert.match(h.q('[data-role="topup-custom-error"]').textContent, /Enter an amount in US dollars/);
    assert.equal(h.calls.length, 0, 'an invalid amount is never quoted');
});

test('typing in the custom field selects Custom; Enter submits; the quote and checkout carry exactly that amount', async h => {
    h.open();
    h.q('#ezil-topup-custom-input').focus();
    h.type('50');
    assert.equal(h.q('input[value="custom"]').checked, true);
    h.submit(); await settle();
    assert.deepEqual(plain(h.calls), [{ method: 'billing.quoteTopup', input: { customAmountCents: 5000 } }]);
    assert.equal(h.q('[data-sheet="topup"]'), null, 'the dialog hands off to payment');
    assert.equal(h.closed, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.checkouts)), [{ pack: { sku: 'ai_custom_v2', aiCredits: 500, totalCents: 5000, creditCents: 5000, discountPercent: 0,
        currency: 'usd', checkout: { customAmountCents: 5000, expectedTotalCents: 5000, expectedCredits: 500 } } }]);
});

test('a preset goes to payment pinned to its server quote', async h => {
    h.open(fixture(), { preselect: 'ai_pack_fixture_5k' });
    assert.equal(h.document.activeElement, h.q('input[value="ai_pack_fixture_5k"]'));
    h.submit(); await settle();
    assert.deepEqual(plain(h.calls), [{ method: 'billing.quoteTopup', input: { sku: 'ai_pack_fixture_5k' } }]);
    assert.deepEqual(plain(h.checkouts[0].pack.checkout), { sku: 'ai_pack_fixture_5k', expectedTotalCents: 35000, expectedCredits: 5000 });
});

test('duplicate clicks quote once; the dialog is busy and cannot be dismissed while it checks the price', async h => {
    let release;
    h.quote = (_method, input) => new Promise(resolve => { release = () => resolve(quoteOf(input)); });
    h.open();
    h.submit(); h.submit(); h.q('[data-action="topup-continue"]').click();
    await settle();
    assert.equal(h.calls.length, 1);
    assert.equal(h.q('[data-action="topup-continue"]').textContent, 'Checking the price…');
    assert.equal(h.q('[data-action="topup-continue"]').disabled, true);
    assert.ok(h.qa('input[name="ezil-topup-amount"]').every(radio => radio.disabled));
    h.q('[data-sheet="topup"] [data-action="close-sheet"]').click();
    h.q('.ezil-upgrade-backdrop').click();
    assert.ok(h.q('[data-sheet="topup"]'), 'close and backdrop are ignored while busy');
    release(); await settle();
    assert.equal(h.checkouts.length, 1);
    // A second open while one is showing returns the same dialog (one per document).
    const again = harness();
    again.open(); assert.equal(again.open(), again.handle);
    assert.equal(again.qa('[data-sheet="topup"]').length, 1);
});

test('a stale quote updates the dialog and needs a fresh confirmation; payment uses the new total', async h => {
    h.quote = async (_method, input) => ({ ok: true, data: { ...quoteOf(input).data, discountPercent: 0, totalCents: 10000 } });
    h.open();
    h.submit(); await settle();
    assert.equal(h.checkouts.length, 0, 'never pays a total the person did not see');
    assert.match(h.q('[data-role="topup-notice"]').textContent, /The price changed\. Check the new total, then continue\./);
    assert.equal(h.value('topup-total'), '$100 USD');
    assert.equal(h.rowHidden('topup-discount'), true);
    assert.equal(h.q('[data-action="topup-continue"]').textContent, 'Continue to payment · $100');
    assert.equal(h.document.activeElement, h.q('[data-action="topup-continue"]'));
    h.submit(); await settle();
    assert.equal(h.checkouts.length, 1);
    assert.deepEqual(plain(h.checkouts[0].pack.checkout), { sku: 'ai_pack_fixture_1k', expectedTotalCents: 10000, expectedCredits: 1000 });
});

test('server refusals and failures stay in the dialog with their own copy; tampered quotes never proceed', async h => {
    h.open();
    for ( const [reply, copy] of [
        [{ ok: false, code: 'BAD_REQUEST', message: '[{"code":"too_small"}]' }, /isn't available right now/],
        [{ ok: false, code: 'CONFLICT', message: 'quote_changed' }, /The price changed/],
        [{ ok: false, code: 'PRECONDITION_FAILED', message: 'ai_enrollment_required' }, /sign in with EZiL ID/],
        [{ ok: false, code: 'NETWORK', message: 'Could not reach the server.' }, /Could not reach billing/],
        [{ ok: true, data: { ...quoteOf({ sku: 'ai_pack_fixture_1k' }).data, currency: 'inr' } }, /Could not reach billing/],
        [{ ok: true, data: { ...quoteOf({ sku: 'ai_pack_fixture_1k' }).data, sku: 'ai_pack_other' } }, /Could not reach billing/],
        [{ ok: true, data: { ...quoteOf({ sku: 'ai_pack_fixture_1k' }).data, aiCredits: 0 } }, /Could not reach billing/],
    ] ) {
        h.quote = async () => reply;
        h.submit(); await settle();
        assert.match(h.q('[data-role="topup-notice"]').textContent, copy);
        assert.equal(h.q('[data-role="topup-notice"]').getAttribute('role'), 'alert');
        assert.equal(h.q('[data-action="topup-continue"]').disabled, false, 'retry is possible');
    }
    h.quote = async () => { throw new Error('offline'); };
    h.submit(); await settle();
    assert.match(h.q('[data-role="topup-notice"]').textContent, /Could not reach billing/);
    h.quote = async (_method, input) => ({ ok: true, data: { ...quoteOf({ customAmountCents: 5000 }).data, totalCents: 4999 } });
    h.pick('custom'); h.type('50'); h.submit(); await settle();
    assert.equal(h.checkouts.length, 0, 'a custom quote for another amount is refused');
});

test('exhausted (zero balance): recovery framing, Add credits and the eligible upgrade; Premium keeps top-up only', async h => {
    h.open(fixture('standard', '0'));
    assert.equal(h.q('#ezil-topup-title').textContent, "You're out of AI credits");
    assert.match(h.q('[data-role="topup-recovery"]').textContent, /Your conversation stays where it is; send your last message again once credits are added/);
    assert.equal(h.q('[data-role="topup-balance"] strong').textContent, '0 credits');
    assert.equal(h.value('topup-new-balance'), '1,000');
    const upgrade = h.q('[data-action="topup-upgrade"]');
    assert.equal(upgrade.textContent, 'Upgrade to Premium');
    assert.equal(upgrade.classList.contains('ezil-billing-sheet-secondary'), true, 'Add credits stays the primary');
    upgrade.click();
    assert.deepEqual(JSON.parse(JSON.stringify(h.upgrades)), [{ action: 'upgrade', sku: 'premium_monthly_v3', label: 'Upgrade to Premium',
        note: JSON.parse(JSON.stringify(h.upgrades[0])).note }]);
    assert.equal(h.q('[data-sheet="topup"]'), null);
    const premium = harness();
    premium.open(fixture('premium', '0'));
    assert.equal(premium.q('#ezil-topup-title').textContent, "You're out of AI credits");
    assert.equal(premium.q('[data-action="topup-upgrade"]'), null, 'top tier: no upgrade, a valid top-up');
    assert.ok(premium.q('[data-action="topup-continue"]'));
    const free = harness();
    free.open(fixture('free', '0'));
    assert.equal(free.q('[data-action="topup-upgrade"]').textContent, 'Upgrade to Standard');
    // The recovery link frames recovery even with credits left (a hold larger than the balance).
    const link = harness();
    link.open(fixture('standard', '1500000'), { reason: 'insufficient_credits' });
    assert.equal(link.q('#ezil-topup-title').textContent, "You're out of AI credits");
    // A plain Add credits with credits left is not a recovery and offers no upgrade.
    const plain = harness();
    plain.open(fixture('standard', '1500000'));
    assert.equal(plain.q('#ezil-topup-title').textContent, 'Add AI credits');
    assert.equal(plain.q('[data-action="topup-upgrade"]'), null);
});

test('identity isolation: another person\'s balance is never shown; a kept balance is marked and not added to', async h => {
    h.open(fixture('standard', '999000000', 'someone-else'));
    assert.equal(h.q('[data-role="topup-balance"] strong').textContent, 'Not available right now');
    assert.doesNotMatch(h.text(), /999/);
    assert.equal(h.rowHidden('topup-new-balance'), true);
    const kept = harness();
    const summary = fixture('standard', null);
    kept.open(summary, { lastAccount: { userId: USER, remainingMicro: '42000000', asOf: '2026-11-04T10:00:00Z' } });
    assert.equal(kept.q('[data-role="topup-balance"] strong').textContent, '42 credits');
    assert.match(kept.q('[data-role="topup-balance"]').textContent, /Couldn't refresh/);
    assert.equal(kept.rowHidden('topup-new-balance'), true, 'no new balance from a stale one');
    const foreignKept = harness();
    foreignKept.open(fixture('standard', null), { lastAccount: { userId: 'someone-else', remainingMicro: '42000000' } });
    assert.equal(foreignKept.q('[data-role="topup-balance"] strong').textContent, 'Not available right now');
});

test('keyboard: Escape closes when idle and returns focus to the opener; Tab stays inside the dialog', async h => {
    h.open();
    const dialog = h.q('[role="dialog"]');
    h.q('[data-action="topup-continue"]').focus();
    h.key('Tab');
    assert.ok(dialog.contains(h.document.activeElement), 'focus stays in the dialog');
    h.key('Escape');
    assert.equal(h.q('[data-sheet="topup"]'), null);
    assert.equal(h.document.activeElement, h.q('#opener'));
    assert.equal(h.closed, 1);
    assert.equal(h.q('#container').hasAttribute('inert'), false);
});

test('topupOffer: only well-formed USD presets, a valid tariff and an enrolled account; parseCustomAmount edges', async h => {
    const { topupOffer, parseCustomAmount } = h.api;
    assert.equal(topupOffer(null), null);
    const off = fixture(); off.actions.topup = false; assert.equal(topupOffer(off), null);
    const unenrolled = fixture(); unenrolled.ai.enrollment = 'needs_ezil_id'; assert.equal(topupOffer(unenrolled), null);
    const odd = fixture();
    odd.catalog.packs.push({ sku: 'ai_pack_bad', aiCredits: 1.5, totalCents: 100, currency: 'usd' }, { sku: 'ai_pack_inr', aiCredits: 10, totalCents: 100, currency: 'inr' },
        { sku: 'ai_pack_neg', aiCredits: 10, totalCents: -1, currency: 'usd' });
    assert.deepEqual(plain(topupOffer(odd).packs.map(pack => pack.sku)), packs.map(pack => pack.sku));
    for ( const tariff of [{ minCents: 1050, maxCents: 2000, centsPerCredit: 10 }, { minCents: 0, maxCents: 2000, centsPerCredit: 10 },
        { minCents: 2000, maxCents: 1000, centsPerCredit: 10 }, { minCents: 1000, maxCents: 2000, centsPerCredit: 0 }, null] ) {
        const bad = fixture(); bad.catalog.customTopup = tariff;
        assert.equal(topupOffer(bad).custom, null, JSON.stringify(tariff));
    }
    const none = fixture(); none.catalog.packs = []; none.catalog.customTopup = null; assert.equal(topupOffer(none), null);
    const customOnly = fixture(); customOnly.catalog.packs = []; assert.deepEqual(plain(topupOffer(customOnly).packs), []);
    assert.deepEqual(plain(parseCustomAmount(' 25 ', customTopup)), { cents: 2500, credits: 250 });
    assert.deepEqual(plain(parseCustomAmount('1,000.00', customTopup)), { cents: 100000, credits: 10000 });
    assert.deepEqual(plain(parseCustomAmount('1,00', customTopup)), { error: 'format' });
    assert.deepEqual(plain(parseCustomAmount('0x10', customTopup)), { error: 'format' });
    assert.deepEqual(plain(parseCustomAmount('Infinity', customTopup)), { error: 'format' });
});

test('narrow viewport: the dialog takes the screen and the options wrap without overflow rules', async h => {
    h.window.innerWidth = 375;
    h.open();
    assert.ok(h.q('.ezil-upgrade-backdrop').classList.contains('is-compact'), 'compact frame below 760 px');
    assert.match(css, /\.ezil-topup-options \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /\.is-compact \.ezil-topup-sheet \.ezil-billing-sheet-actions button \{ flex: 1 1 100%; \}/);
});

let failed = 0;
for ( const { name, fn } of tests ) {
    const h = harness();
    try {
        await fn(h);
        console.log(`PASS ${name}`);
    } catch ( error ) {
        failed++;
        console.log(`FAIL ${name}`);
        console.log(error);
    } finally {
        h.handle?.close?.();
        h.window.close();
    }
}
console.log(`${tests.length - failed}/${tests.length} top-up sheet tests passed (synthetic fixtures)`);
if ( failed ) process.exitCode = 1;
