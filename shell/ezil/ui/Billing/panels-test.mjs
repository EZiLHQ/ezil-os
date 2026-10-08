// Local DOM tests; no gateway, checkout provider, or network is contacted.
// Run: node shell/ezil/ui/Billing/panels-test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createWalletBadge } from './wallet-badge.js';
import { mountComputeSize } from './compute-size.js';

const config = { WALLET_V2_ENABLED: true };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const wallet = (included = '10000000', purchased = '250000', plan = 'free') => ({
    version: 2, unit: 'usd_micro', plan,
    included: { balance: included, periodEnd: '2026-11-07T00:00:00.000Z' },
    purchased: { balance: purchased },
});
const shapes = (eligible = true) => [
    { id: 'standard', vcpu: 2, memoryGiB: 6, diskGB: 16, eligible: true },
    { id: 'performance', vcpu: 4, memoryGiB: 12, diskGB: 20, eligible, reason: 'subscription_required' },
];

function fixture (t) {
    const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', { url: 'https://ezil.local/' });
    t.after(() => dom.window.close());
    return { dom, doc: dom.window.document };
}

function badgeFixture (t, options = {}) {
    const { dom, doc } = fixture(t);
    const badge = createWalletBadge({ config, document: doc, wallet: wallet(), ...options });
    doc.body.append(badge.element);
    t.after(() => badge.destroy());
    return { dom, doc, badge };
}

async function pickerFixture (t, options = {}) {
    const { dom, doc } = fixture(t);
    const changes = [];
    const picker = mountComputeSize(doc.body, {
        config, getComputer: () => ({ id: 'c-1', shape: 'standard' }),
        getShapes: async () => shapes(), confirmChange: async () => true,
        changeShape: change => changes.push(change), ...options,
    });
    await picker.ready;
    return { dom, doc, picker, changes };
}

test('panels remain disabled by default without DOM, styles, reads, or callbacks', t => {
    const { doc } = fixture(t);
    for ( const flag of [undefined, false, 'true', 1] ) {
        const options = { config: { WALLET_V2_ENABLED: flag } };
        const badge = createWalletBadge({ ...options, document: doc, wallet: wallet(), onTopup: () => assert.fail('disabled callback') });
        assert.equal(badge.element, null);
        badge.update(wallet());
        badge.destroy();
        assert.equal(mountComputeSize(doc.body, { ...options, getShapes: () => assert.fail('disabled read') }), null);
    }
    assert.equal(doc.body.childElementCount, 0);
    assert.equal(doc.querySelector('style[data-ezil-billing]'), null);
});

test('one panel stylesheet per document, shared by multiple badges and compute grids', async t => {
    const { doc, badge } = badgeFixture(t);
    const second = createWalletBadge({ config, document: doc, wallet: wallet() });
    t.after(() => second.destroy());
    const picker = mountComputeSize(doc.body, { config, getShapes: async () => shapes() });
    await picker.ready;
    assert.equal(doc.querySelectorAll('style[data-ezil-billing="panels"]').length, 1);
    badge.destroy();
    assert.equal(doc.querySelectorAll('style[data-ezil-billing="panels"]').length, 1);
    const { doc: other } = fixture(t);
    createWalletBadge({ config, document: other, wallet: wallet() });
    assert.equal(other.querySelectorAll('style[data-ezil-billing="panels"]').length, 1);
});

test('wallet button opens and toggles a labelled popover; Escape closes and restores focus', t => {
    const { dom, doc, badge } = badgeFixture(t, { onTopup: () => {} });
    assert.equal(badge.element.tagName, 'BUTTON');
    assert.equal(badge.element.getAttribute('aria-expanded'), 'false');
    badge.element.click();
    const popover = doc.querySelector('[role="dialog"]');
    assert.ok(popover);
    assert.equal(popover.id, badge.element.getAttribute('aria-controls'));
    assert.equal(popover.getAttribute('aria-label'), 'AI credit balance');
    assert.equal(badge.element.getAttribute('aria-expanded'), 'true');
    assert.equal(doc.activeElement, popover.querySelector('[data-action="topup"]'));
    assert.match(popover.textContent, /Included\$10.00renews Nov 7Purchased\$0.25used after included credit/);
    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(doc.querySelector('[role="dialog"]'), null);
    assert.equal(badge.element.getAttribute('aria-expanded'), 'false');
    assert.equal(doc.activeElement, badge.element);
    badge.element.click();
    badge.element.click();
    assert.equal(doc.querySelector('[role="dialog"]'), null);
    badge.element.click();
    doc.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    assert.equal(doc.querySelector('[role="dialog"]'), null);
});

test('included bars use remaining divided by grant, independently of purchased credit', t => {
    const { doc, badge } = badgeFixture(t, { wallet: wallet('5000000', '90000000') });
    assert.equal(badge.element.querySelector('.ezil-billing-money').textContent, '$95.00');
    assert.equal(badge.element.querySelector('.ezil-billing-progress-fill').style.width, '25%');
    badge.element.click();
    const bar = () => doc.querySelector('[role="progressbar"]');
    assert.equal(bar().getAttribute('aria-valuenow'), '25');
    badge.update(wallet('20000000'));
    assert.equal(bar().getAttribute('aria-valuenow'), '100');
    badge.update(wallet('9007199254740993123456789'));
    assert.equal(bar().getAttribute('aria-valuenow'), '100');
    badge.update(wallet('0'));
    assert.equal(bar().getAttribute('aria-valuenow'), '0');
});

test('custom grants keep ratios exact beyond Number precision; zero grants are safe', t => {
    const { doc, badge } = badgeFixture(t, {
        wallet: wallet('9007199254740993000000'), periodGrantUsdMicro: '18014398509481986000000',
    });
    badge.element.click();
    assert.equal(doc.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '50');
    for ( const grant of ['0', 'invalid'] ) {
        const empty = createWalletBadge({ config, document: doc, wallet: wallet(), periodGrantUsdMicro: grant });
        assert.equal(empty.element.querySelector('.ezil-billing-progress-fill').style.width, '0%');
        empty.destroy();
    }
});

test('legacy wallets show only the supplied legacy balance and never bars or a popover', t => {
    const { doc, badge } = badgeFixture(t, { formatLegacyWallet: () => '42 credits' });
    badge.element.click();
    badge.update({ version: 1, balance_microcredits: '42' });
    assert.equal(badge.element.textContent, '42 credits');
    assert.equal(badge.element.disabled, true);
    assert.equal(doc.querySelector('.ezil-billing-progress'), null);
    assert.equal(doc.querySelector('[role="dialog"]'), null);
    badge.element.click();
    assert.equal(doc.querySelector('[role="dialog"]'), null);
    badge.update(wallet());
    assert.equal(badge.element.disabled, false);
    badge.element.click();
    assert.ok(doc.querySelector('[role="progressbar"]'));
    badge.destroy();
    assert.equal(doc.querySelector('[role="dialog"]'), null);
});

test('wallet footer calls each action once and offers Upgrade only to the free plan', t => {
    const calls = [];
    const { doc, badge } = badgeFixture(t, { onTopup: () => calls.push('topup'), onUpgrade: () => calls.push('upgrade') });
    for ( const action of ['topup', 'upgrade'] ) {
        badge.element.click();
        doc.querySelector(`[data-action="${action}"]`).click();
        assert.equal(doc.querySelector('[role="dialog"]'), null);
    }
    assert.deepEqual(calls, ['topup', 'upgrade']);
    badge.update(wallet('10000000', '250000', 'subscriber'));
    badge.element.click();
    assert.ok(doc.querySelector('[data-action="topup"]'));
    assert.equal(doc.querySelector('[data-action="upgrade"]'), null);
    assert.deepEqual(calls, ['topup', 'upgrade']);
});

test('wallet refresh keeps focus on its action and missing checkout hooks stay disabled', t => {
    const { doc, badge } = badgeFixture(t, { onUpgrade: () => {} });
    badge.element.click();
    assert.equal(doc.querySelector('[data-action="topup"]').disabled, true);
    assert.equal(doc.activeElement.dataset.action, 'upgrade');
    badge.update(wallet('5000000'));
    assert.equal(doc.activeElement.dataset.action, 'upgrade');
    badge.update(wallet('5000000', '0', 'subscriber'));
    assert.equal(doc.activeElement.getAttribute('role'), 'dialog');
});

test('locked compute cards are disabled with a reason and one banner above the radio grid', async t => {
    const { picker, changes } = await pickerFixture(t, { getShapes: async () => shapes(false), onUpgrade: () => {} });
    const card = picker.element.querySelector('[data-shape="performance"]');
    const grid = picker.element.querySelector('[role="radiogroup"]');
    assert.equal(card.disabled, true);
    assert.ok(card.classList.contains('ezil-billing-compute-card-locked'));
    assert.equal(card.querySelector('.ezil-billing-compute-reason').textContent, 'Requires EZiL Cloud');
    assert.equal(card.title, 'Requires EZiL Cloud');
    assert.equal(card.querySelectorAll('.ezil-billing-compute-spec svg').length, 3);
    assert.equal(card.querySelectorAll('.ezil-billing-compute-reason svg').length, 1);
    assert.deepEqual([...card.querySelectorAll('.ezil-billing-compute-spec')].map(row => row.textContent), ['4 vCPU', '12 GiB', '20 GB']);
    assert.equal(grid.previousElementSibling.className, 'ezil-billing-compute-banner');
    assert.equal(picker.element.querySelectorAll('[data-action="upgrade"]').length, 1);
    assert.equal(grid.previousElementSibling.hidden, false);
    assert.match(grid.previousElementSibling.textContent, /Bigger computers are included with EZiL Cloud/);
    card.click();
    assert.deepEqual(changes, []);
});

test('current shape is marked without triggering another restart; keyboard can focus another card', async t => {
    const { picker, doc, dom, changes } = await pickerFixture(t);
    assert.equal(picker.element.querySelector('h3').textContent, 'Computer size');
    assert.equal(picker.element.querySelector('.ezil-billing-compute-description').textContent, 'vCPUs are virtual CPU allocations, not physical cores.');
    const standard = picker.element.querySelector('[data-shape="standard"]');
    const performance = picker.element.querySelector('[data-shape="performance"]');
    assert.equal(standard.getAttribute('aria-checked'), 'true');
    assert.equal(standard.querySelector('.ezil-billing-compute-current').textContent, 'Current');
    assert.equal(performance.getAttribute('aria-checked'), 'false');
    assert.equal(performance.querySelector('.ezil-billing-compute-current'), null);
    assert.equal(picker.element.querySelector('.ezil-billing-compute-banner').hidden, true);
    standard.click();
    assert.deepEqual(changes, []);
    standard.focus();
    standard.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(doc.activeElement, performance);
    assert.deepEqual(changes, []);
});

test('resize sends exact confirmation copy before mutation, preserves cancellation, and ignores duplicate clicks', async t => {
    let resolveConfirmation;
    const events = [];
    const { picker, dom } = await pickerFixture(t, {
        confirmChange: options => {
            events.push('confirm');
            assert.equal(options.message, 'Restart into Performance (4 vCPU · 12 GiB)? Your files are kept. Open apps, terminals and unsaved editor changes are closed.');
            assert.equal(options.confirmLabel, 'Restart and resize');
            assert.equal(options.cancelLabel, 'Cancel');
            return new Promise(resolve => { resolveConfirmation = resolve; });
        },
        changeShape: change => { events.push(change); },
    });
    const performance = () => picker.element.querySelector('[data-shape="performance"]');
    performance().click();
    assert.deepEqual(events, ['confirm']);
    assert.equal(performance().disabled, true);
    performance().click();
    resolveConfirmation(false);
    await tick();
    assert.deepEqual(events, ['confirm']);
    performance().click();
    performance().dispatchEvent(new dom.window.MouseEvent('click', { detail: 2 }));
    assert.deepEqual(events, ['confirm', 'confirm']);
    resolveConfirmation(true);
    await tick();
    assert.deepEqual(events, ['confirm', 'confirm', { computerId: 'c-1', shape: 'performance' }]);
});

test('confirmation cannot resize a switched session or a removed picker', async t => {
    for ( const scenario of ['switch', 'remove'] ) {
        let computer = { id: 'c-1', shape: 'standard' };
        let confirm;
        const { picker, changes } = await pickerFixture(t, {
            getComputer: () => computer,
            confirmChange: () => new Promise(resolve => { confirm = resolve; }),
        });
        picker.element.querySelector('[data-shape="performance"]').click();
        if ( scenario === 'switch' ) computer = { id: 'c-2', shape: 'standard' };
        else picker.element.remove();
        confirm(true);
        await tick();
        assert.deepEqual(changes, []);
    }
});

test('Upgrade refreshes eligibility and unknown reasons remain localised text', async t => {
    let upgraded = false;
    let reason = 'subscription_required';
    const { picker } = await pickerFixture(t, {
        getShapes: async () => shapes(upgraded).map(shape => ({ ...shape, reason })),
        onUpgrade: () => { upgraded = true; },
    });
    const performance = () => picker.element.querySelector('[data-shape="performance"]');
    for ( reason of ['future_reason', 'Active subscription required <script>', undefined, null, ''] ) {
        await picker.refresh();
        assert.equal(performance().querySelector('.ezil-billing-compute-reason').textContent, 'Not available on your plan');
        assert.equal(picker.element.querySelector('script'), null);
        assert.doesNotMatch(picker.element.textContent, /future_reason|<script>/);
    }
    picker.element.querySelector('[data-action="upgrade"]').click();
    await tick();
    assert.equal(performance().disabled, false);
    assert.equal(picker.element.querySelector('.ezil-billing-compute-banner').hidden, true);
});

test('compute eligibility reasons use translations without exposing server reason strings', async t => {
    const previousI18n = globalThis.i18n;
    t.after(() => {
        if ( previousI18n === undefined ) delete globalThis.i18n;
        else globalThis.i18n = previousI18n;
    });
    globalThis.i18n = key => ({
        compute_card_requires_cloud: 'Abonnement EZiL Cloud requis',
        compute_ineligible: 'Indisponible avec votre forfait',
    })[key] ?? key;
    let reason = 'subscription_required';
    const { picker } = await pickerFixture(t, {
        getShapes: async () => shapes(false).map(shape => ({ ...shape, reason })),
    });
    const card = () => picker.element.querySelector('[data-shape="performance"]');
    assert.equal(card().title, 'Abonnement EZiL Cloud requis');
    assert.equal(card().querySelector('.ezil-billing-compute-reason').textContent, card().title);
    reason = 'future_reason';
    await picker.refresh();
    assert.equal(card().title, 'Indisponible avec votre forfait');
    assert.equal(card().querySelector('.ezil-billing-compute-reason').textContent, card().title);
    assert.equal(card().disabled, true);
});
