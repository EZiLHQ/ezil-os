import { v3CopyForAudit, honestyBans } from './billing-copy-test-helpers.mjs';
// Billing v2: real shell + tRPC client, jsdom, fake fetch and injected sheets.
import { summaryV3 } from './billing-v3-fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, 'settings.css'), 'utf8');
// jsdom cannot compute container queries or color-mix; inspect the authored
// declarations and calculate WCAG contrast from the actual window tokens.
function cssRule (selector, last = false, property) {
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, selectors, body]) => selectors.split(',').some(value => value.trim() === selector)
            && (! property || body.includes(`${property}:`)));
    const rule = last ? rules.at(-1) : rules[0];
    assert.ok(rule, `CSS rule exists: ${selector}`);
    return Object.fromEntries(rule[2].split(';').filter(value => value.trim()).map(value => {
        const colon = value.indexOf(':');
        return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
    }));
}
const tokens = cssRule('.ezil-settings-window');
function rgb (value) {
    // `var(--name)` or `var(--name, fallback)`: round 3's --accent is `var(--ezil-accent, #00adb5)`.
    const variable = value.match(/^var\((--[\w-]+)(?:,\s*(.+))?\)$/);
    if ( variable ) return rgb(tokens[variable[1]] ?? variable[2]);
    const mix = value.match(/^color-mix\(in srgb, (.+) (\d+)%, (.+)\)$/);
    if ( mix ) {
        const front = rgb(mix[1]), back = rgb(mix[3]), alpha = Number(mix[2]) / 100;
        return front.map((channel, i) => channel * alpha + back[i] * (1 - alpha));
    }
    assert.match(value, /^#[\da-f]{6}$/i);
    return value.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255);
}
function luminance (color) {
    return rgb(color).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
        .reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
}
const { build } = require(require.resolve('esbuild', { paths: [path.resolve(here, '../../../../app')] }));
const out = process.env.EZIL_SHELL_OUT_DIR || path.resolve(here, '../../../../app/public/os');
const dom = new JSDOM('<!doctype html><body><div class="desktop"></div></body>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/os',
});
const { window } = dom;
const calls = [], errors = [], opened = [], sheets = [];
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
window.open = (...args) => opened.push(args);
let now = Date.parse('2026-10-18T12:00:00Z');
window.Date.now = () => now;
// Only the Billing interval is virtual; the rest of the shell retains real timers.
const intervals = new Map();
let intervalID = 100000;
const originalInterval = window.setInterval.bind(window), originalClear = window.clearInterval.bind(window);
window.setInterval = (fn, ms, ...args) => {
    if ( ms !== 30000 ) return originalInterval(fn, ms, ...args);
    const id = ++intervalID;
    intervals.set(id, fn);
    return id;
};
window.clearInterval = id => { intervals.delete(id); originalClear(id); };
const copy = value => JSON.parse(JSON.stringify(value));
const reply = data => ({ ok: true, status: 200, json: async () => ({ result: { data: { json: copy(data) } } }) });
const failure = (message, code = 'BAD_REQUEST') => ({ ok: false, status: 400, json: async () => ({ error: { json: { message, data: { code } } } }) });
const END = '2026-11-01T00:00:00Z';
const TERMS = 'overage-v2-2026-10-18';
function v2 (family = 'compute', freeHours = 2) {
    const free = family === 'free', compute = family === 'compute';
    const allowance = (free ? freeHours : compute ? 500 : family === 'standard' ? 60 : 20) * 3600;
    const allowedSizes = free ? ['free-cf'] : compute ? ['std-2', 'cmp-4', 'cmp-8'] : ['std-2'];
    return {
        enabled: true, version: 2,
        plan: {
            sku: free ? freeHours === 8 ? 'free_v1_legacy' : 'free_v2' : compute ? 'compute_monthly_v2' : family === 'standard' ? 'standard_monthly_v2' : 'pro_monthly_v1',
            family, status: free ? 'free' : 'active', periodStart: '2026-10-01T00:00:00Z', periodEnd: END,
            renewsAt: free ? null : END, cancelsAt: null, scheduledChange: null, pendingUpgrade: null, paymentIssue: null,
        },
        compute: {
            allowanceStdSeconds: allowance, usedStdSeconds: 4501, remainingStdSeconds: allowance - 4501, resetsAt: END, state: 'ok',
            remainingActualSecondsBySize: Object.fromEntries(allowedSizes.map((code, index) => [code, Math.floor((allowance - 4501) / 2 ** index)])),
            allowedSizes, selectedSize: allowedSizes[0],
            session: { maxSeconds: 21600, warnSeconds: [900, 300], idleSleepSeconds: 600, activeDeadline: null },
        },
        overage: compute ? { available: true, enabled: false, centsPerStdHour: 25, capCents: 2500, defaultCapCents: 2500, maxCapCents: 10000, accruedCents: 0, termsVersion: TERMS, acceptedVersion: null, acceptedAt: null, pausedReason: null } : null,
        estimate: { nextChargeAt: free ? null : END, subscriptionCents: free ? null : compute ? 10000 : 2000, accruedOverageCents: 0, worstCaseOverageCents: 2500, currency: 'usd', taxNote: 'before_tax' },
        storage: { usedBytes: '1500000000', capBytes: '2000000000', measuredAt: '2026-10-18T11:58:00Z', state: 'ok' },
        ai: { state: 'unavailable', trialMicro: '0', includedMicro: '0', purchasedMicro: '0', includedExpiresAt: null },
        actions: { checkout: free, portal: !free, upgrade: family === 'standard', downgrade: compute, cancel: !free, overage: compute, selectSize: compute },
        catalog: {
            version: 2,
            offers: [
                { sku: 'standard_monthly_v2', family: 'standard', priceCents: 2000, currency: 'usd', interval: 'month', allowanceStdSeconds: 216000, sizes: ['std-2'], overage: null },
                { sku: 'compute_monthly_v2', family: 'compute', priceCents: 10000, currency: 'usd', interval: 'month', allowanceStdSeconds: 1800000, sizes: ['std-2', 'cmp-4', 'cmp-8'], overage: { centsPerStdHour: 25, defaultCapCents: 2500, maxCapCents: 10000 } },
            ],
            sizes: [
                { code: 'free-cf', vcpu: 2, memoryGiB: 6, weight: 1 },
                { code: 'std-2', vcpu: 2, memoryGiB: 8, weight: 1 },
                { code: 'cmp-4', vcpu: 4, memoryGiB: 16, weight: 2 },
                { code: 'cmp-8', vcpu: 8, memoryGiB: 32, weight: 4 },
            ],
        },
    };
}
function invoice (kind = 'subscription', created = '2026-10-14T12:00:00Z', status = 'open') {
    return { id: 'in_test', number: null, status, kind, amountPaidCents: 1200, amountDueCents: 2345, currency: 'usd', created, url: `https://invoice.example.test/${kind}`, description: null };
}
let summary = v2(), history = [];
let getSummary = () => reply(summary), getHistory = () => reply(history), getUsage = () => failure('unavailable');
let mutation = () => reply({ url: 'https://billing.example.test/session' });
window.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method, input: options.body ? JSON.parse(options.body).json : undefined };
    calls.push(call);
    if ( call.url.includes('/api/trpc/billing.summary') ) return getSummary();
    if ( call.url.includes('/api/trpc/billing.history') ) return getHistory();
    if ( call.url.includes('/api/trpc/billing.usage') ) return getUsage();
    if ( call.url.includes('/api/trpc/billing.') ) return mutation(call);
    if ( call.url.includes('/api/trpc/computer.list') ) return reply([]);
    return failure('Stubbed endpoint');
};
const bundled = await build({
    stdin: {
        contents: "import './shell/ezil/boot.js'; import * as billing from './shell/ezil/ui/Settings/tabs/billing.js'; import * as format from './shell/ezil/ui/Settings/billing-format.js'; import * as computersTab from './shell/ezil/ui/Settings/tabs/computers.js'; window.billing = billing; window.billingFormat = format; window.computersTab = computersTab;",
        resolveDir: path.resolve(here, '../../../..'),
    },
    bundle: true, write: false, format: 'iife', target: 'es2022',

});
window.eval(fs.readFileSync(path.join(out, 'icons.js'), 'utf8'));
window.eval(bundled.outputFiles[0].text);
let openerFailure = false, legacyClose = false, pageCheckout = false;
const opener = kind => options => {
    if ( openerFailure ) throw new Error('unavailable');
    const element = window.document.createElement('div');
    element.dataset.role = kind === 'checkout' ? 'upgrade-sheet' : 'billing-sheet';
    element.dataset.sheet = kind;
    (kind === 'checkout' && pageCheckout ? window.document.body : options.container).append(element);
    const handle = { close () { element.remove(); if ( ! legacyClose ) options.onClose(); } };
    sheets.push({ kind, ...options, handle });
    return handle;
};
window.billing.setUpgradeSheetOpener(opener('checkout'));
window.billing.setBillingSheetOpeners(Object.fromEntries(['upgrade', 'downgrade', 'cancel', 'overage'].map(kind => [kind, opener(kind)])));
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
const count = (procedure = 'summary') => calls.filter(call => call.url.includes(`/billing.${procedure}`)).length;
const active = () => q('.ezil-settings-tab.active')?.dataset.tab;
const click = element => { assert.ok(element, 'clicked control exists'); element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); };
const changeSize = code => {
    const input = q(`input[value="${code}"]`);
    assert.ok(input && !input.disabled, 'native radio is enabled');
    input.focus();
    input.checked = true;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const banned = /faster|instant|unlimited|priority|gpu|heavy\s+use|gpt|claude|gemini|llama|memory\s+is\s+kept|memory\s+survives|processes\s+keep\s+running|ai\s+included|includes\s+ai|compute\s+hours|standard-hour/i;
let audited = 0, groups = 0;
function audit () {
    assert.equal(banned.test(summary.version === 2 ? text().replace(/standard-hours?/gi, '') : v3CopyForAudit(text())), false, 'whole pane passes v2 copy scan');
    for ( const element of qa('[data-pane="billing"] button, [data-pane="billing"] a, [data-pane="billing"] input[type="radio"]') ) {
        assert.ok(element.getAttribute('aria-label') || (element.type === 'radio' ? [...element.labels].map(label => label.textContent).join('').trim() : element.textContent.trim()), 'control has an accessible name');
    }
    assert.ok(qa('.ezil-billing-header .ezil-settings-btn-primary, [data-role="plan-card"] .ezil-settings-btn-primary, [data-role="billing-nudge"] .ezil-settings-btn-primary').length <= 1, 'at most one primary on the main surface');
    // Round 5 (D6): on v3 the WHOLE pane has at most one primary, whatever the state.
    if ( summary?.version === 3 ) assert.ok(qa('[data-pane="billing"] .ezil-settings-btn-primary').length <= 1, 'v3: at most one primary in the pane');
    assert.equal(qa('.ezil-billing-card h3, .ezil-billing-meter h3').length, 0, 'card headings use h4');
    assert.deepEqual(errors, []);
    assert.doesNotMatch(text(), honestyBans);
    audited++;
}
const pass = label => { groups++; console.log(`PASS Billing v2: ${label}`); };
async function open (ctx = { ...context, initialTab: 'billing' }) {
    const old = q('.window[data-app="settings"]');
    if ( old ) { await window.$(old).close(); await settle(); }
    await window.ezil.registry.launch('settings', ctx);
    await settle();
    audit();
}
async function refresh () {
    click(q('[data-tab="account"]'));
    click(q('[data-tab="billing"]'));
    await settle();
    audit();
}
async function closeSheet () { sheets.at(-1).handle.close(); await settle(); }
async function fixture (value = v2()) { summary = value; await refresh(); }
function has (selector, expected = true) { assert.equal(!!q(selector), expected, selector); }
function contains (selector, copy) { assert.ok(q(selector)?.textContent.includes(copy), `${selector} includes ${copy}`); }

try {
    for ( const [status, token, tint] of [
        ['active', '--accent', 18], ['free', '--muted', 0], ['cancels', '--warn', 12],
        ['incomplete', '--warn', 12], ['upgrade_pending', '--warn', 12], ['past_due', '--danger', 12],
    ] ) {
        const rule = cssRule(`.ezil-settings-billing [data-role="plan-status"][data-status="${status}"]`);
        assert.equal(rule.color, status === 'active' ? 'var(--text)' : `var(${token})`);
        assert.equal(rule.background, tint ? `color-mix(in srgb, var(${token}) ${tint}%, var(--surface))` : 'var(--surface-2)');
        const light = luminance(rule.color), dark = luminance(rule.background);
        assert.ok((Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) >= 4.5, `${status} chip reaches 4.5:1`);
    }
    assert.equal(cssRule('.ezil-settings-billing [data-role="plan-actions"]:empty').display, 'none');
    for ( const selector of ['.ezil-billing-card h4', '.ezil-billing-meter h4', '.ezil-billing-sizes legend'] ) {
        const rule = cssRule(selector);
        assert.equal(rule['font-size'], '16px'); assert.equal(rule['font-weight'], '600');
        assert.equal(rule.color, 'var(--text)'); assert.equal(rule['text-transform'], 'none');
    }
    assert.equal(cssRule('.ezil-billing-session', true)['font-size'], '13px');
    assert.equal(cssRule('.ezil-billing-session', true).color, 'var(--muted)');
    assert.equal(cssRule('.ezil-billing-session [data-role="session-countdown"]').color, 'var(--text)');
    assert.equal(cssRule('.ezil-billing-session [data-role="session-countdown"].ezil-billing-warning').color, 'var(--warn)');
    assert.equal(cssRule('.ezil-billing-invoice time')['white-space'], 'nowrap');
    const pill = cssRule('.ezil-billing-invoice [data-role="invoice-kind"]');
    assert.equal(pill['justify-self'], 'start'); assert.equal(pill.width, 'max-content');
    assert.equal(cssRule('.ezil-billing-invoice', false, 'grid-template-columns')['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(cssRule('.ezil-billing-invoice-heading', true).display, 'contents');
    assert.equal(cssRule('.ezil-billing-invoice-details', true).display, 'contents');
    pass('status colour rules and AA contrast, shared card headings, empty actions and responsive invoice/session styles');

    assert.ok(banned.test('unlimited'), 'copy scan positive control');
    for ( const term of window.billingFormat.BANNED_COPY ) assert.ok(banned.test(term));
    const f = window.billingFormat;
    assert.deepEqual(copy(f.BANNED_COPY), ['faster', 'instant', 'unlimited', 'priority', 'gpu', 'heavy use', 'gpt', 'claude', 'gemini', 'llama', 'memory is kept', 'memory survives', 'processes keep running', 'ai included', 'includes ai', 'compute hours', 'standard-hour']);
    assert.equal(f.dollars('900719925474099300'), '$9007199254740993.00');
    assert.equal(f.dollars(2000, { compact: true }), '$20');
    assert.equal(f.dollars(-2050, { compact: true }), '-$20.50');
    assert.equal(f.dateLabel('2026-11-01T23:00:00-05:00'), 'Nov 2');
    assert.equal(f.dateLabel(END, true), 'Nov 1, 2026');
    assert.equal(f.dateLabel(null), '—');
    for ( const [seconds, label] of [[450000, '125 h'], [5459, '1 h 30 m'], [2759, '45 m'], [59, '0 m'], [-1, '0 m']] ) assert.equal(f.durationLabel(seconds), label);
    assert.equal(f.stdHoursLabel(765000), '212.5');
    assert.equal(f.stdHoursLabel(216000), '60');
    assert.equal(f.stdHoursLabel(361, { round: 'up' }), '0.2');
    assert.equal(f.stdHoursLabel(361, { round: 'down' }), '0.1');
    assert.equal(f.sizeLabel(v2().catalog.sizes[3]), '8 vCPU · 32 GiB');
    assert.equal(f.webUrl('http://example.test/pay'), 'http://example.test/pay');
    for ( const url of ['javascript:alert(1)', 'data:text/html,x', '/relative', null] ) assert.throws(() => f.webUrl(url));
    const errorTable = {
        billing_not_configured: "Billing isn't available right now. Try again later.", unknown_sku: "That plan isn't available. Refresh and try again.",
        already_subscribed: 'You already have a plan. Refresh to see it.', not_subscribed: "You don't have a paid plan to change.",
        upgrade_not_allowed: "This plan can't be upgraded right now.", upgrade_pending: 'An upgrade is already waiting for payment.',
        downgrade_not_allowed: "This plan can't switch to Standard right now.", cap_out_of_range: 'Choose a cap between $0 and $100.',
        terms_version_mismatch: 'The overage terms changed. Review them and try again.', size_not_allowed: "That size isn't included in your plan.",
        customer_conflict: "We couldn't match your billing account. Contact support.", stripe_unavailable: 'Payments are unavailable right now. Try again in a few minutes.',
    };
    const fallback = 'Could not reach billing. Try again.';
    for ( const [code, expected] of Object.entries(errorTable) ) { assert.equal(f.errorCopy(code), expected); assert.notEqual(expected, fallback); }
    assert.equal(new Set(Object.keys(errorTable).map(code => f.errorCopy(code))).size, 12);
    for ( const code of ['NETWORK', 'unknown', 'toString', undefined] ) assert.equal(f.errorCopy(code), fallback);
    assert.equal(f.errorCopy('cap_out_of_range', 7500), 'Choose a cap between $0 and $75.');
    // Bundle the real module separately from the tab's injected sheet stubs.
    const sheetBundle = await build({
        stdin: { contents: "import * as sheets from './billing-sheets.js'; window.realBillingSheets = sheets;", resolveDir: here },
        bundle: true, write: false, format: 'iife', target: 'es2022',
    });
    window.eval(sheetBundle.outputFiles[0].text);
    assert.deepEqual(Object.keys(window.realBillingSheets).sort(), ['openComputeUpgradeSheet', 'openDowngradeSheet', 'openCancelSheet', 'openOverageSheet', 'openPlanPickerSheet', 'openSessionEndSheet'].sort());
    for ( const fn of Object.values(window.realBillingSheets) ) assert.equal(typeof fn, 'function');
    pass('shared formatting, 12 distinct error mappings, safe URLs and sheet exports');

    await open();
    assert.deepEqual(qa('.ezil-settings-tab').map(tab => tab.dataset.tab), ['account', 'usage', 'billing', 'computers', 'system', 'appearance', 'about', 'troubleshoot']);
    assert.equal(active(), 'billing');
    assert.equal(count(), 1);
    contains('.ezil-billing-header', 'Plan & usage');
    contains('.ezil-billing-header', 'Your plan, compute and what renews when.');
    assert.equal(q('.ezil-billing-header button').textContent, 'Manage billing');
    assert.equal(q('.ezil-billing-header button').classList.contains('ezil-settings-btn-primary'), false);
    for ( const [family, freeHours, name, price, allowance, chip] of [
        ['free', 8, 'EZiL Free', '$0', '8 h each month · 2 vCPU · 6 GiB', 'Current'],
        ['free', 2, 'EZiL Free', '$0', '2 h each month · 2 vCPU · 6 GiB', 'Current'],
        ['standard', 2, 'EZiL Standard', '$20/month', '60 standard-hours each billing period · 2 vCPU · 8 GiB', 'Active'],
        ['compute', 2, 'EZiL Compute', '$100/month', '500 standard-hours each billing period · 2, 4 or 8 vCPU', 'Active'],
        ['pro_legacy', 2, 'EZiL Pro', '$20/month', '20 standard-hours each billing period · 2 vCPU · 8 GiB', 'Active'],
    ] ) {
        await fixture(v2(family, freeHours));
        assert.equal(q('[data-role="plan-card"]').dataset.family, family);
        assert.equal(q('[data-role="plan-card"] h4').textContent, name);
        assert.equal(q('.ezil-billing-price').textContent, price);
        contains('[data-role="plan-card"]', allowance);
        assert.equal(q('[data-role="plan-status"]').textContent, chip);
        assert.equal(q('[data-role="plan-card"]').textContent.includes('USD · before applicable tax'), family !== 'free');
    }
    contains('[data-role="plan-card"]', 'Your original Pro plan, honoured as sold.');
    summary.estimate.subscriptionCents = 3456;
    await refresh();
    contains('.ezil-billing-price', '$34.56/month');
    for ( const [status, chip] of Object.entries({ free: 'Current', active: 'Active', cancels: 'Cancels Nov 1', past_due: 'Payment failed', incomplete: 'Payment incomplete', upgrade_pending: 'Upgrade pending' }) ) {
        summary = v2(); summary.plan.status = status; summary.plan.cancelsAt = END;
        await refresh();
        assert.equal(q('[data-role="plan-status"]').dataset.status, status);
        assert.equal(q('[data-role="plan-status"]').textContent, chip);
        if ( status === 'active' ) contains('[data-role="plan-card"]', 'Renews Nov 1');
        if ( status === 'cancels' ) {
            contains('[data-role="plan-card"]', 'Your plan ends Nov 1. You can resume before then.');
            has('[data-action="resume"].ezil-settings-btn-primary');
        }
        has('[data-action="resume"]', status === 'cancels');
        has('[data-action="cancel"]', status !== 'cancels');
    }
    summary.plan.scheduledChange = { toSku: 'standard_monthly_v2', effectiveAt: END };
    summary.plan.pendingUpgrade = { toSku: 'compute_monthly_v2', expiresAt: '2026-10-20T00:00:00Z', hostedInvoiceUrl: null };
    await refresh();
    contains('[data-role="plan-card"]', 'Switches to Standard on Nov 1.');
    contains('[data-role="plan-card"]', 'Compute starts once payment is confirmed. This upgrade expires Oct 20.');
    await fixture();
    assert.equal(text().includes('Switches to Standard on'), false);
    assert.equal(text().includes('Compute starts once payment'), false);
    pass('five plan variants, catalog allowances/prices, all status chips and scheduled lines');

    for ( const flag of Object.keys(summary.actions) ) {
        summary = v2();
        for ( const key of Object.keys(summary.actions) ) summary.actions[key] = key === flag;
        await refresh();
        for ( const action of ['checkout', 'portal', 'upgrade', 'downgrade', 'cancel', 'overage'] ) has(`[data-action="${action}"]`, action === flag);
        assert.equal(qa('[data-role="size-selector"] input:not(:disabled)').length, flag === 'selectSize' ? 3 : 0);
        summary.actions[flag] = false;
        await refresh();
        for ( const action of ['checkout', 'portal', 'upgrade', 'downgrade', 'cancel', 'overage'] ) has(`[data-action="${action}"]`, false);
        assert.equal(qa('[data-role="size-selector"] input:not(:disabled)').length, 0);
    }
    summary = v2(); summary.plan.status = 'cancels'; summary.plan.cancelsAt = END;
    summary.actions.upgrade = true;
    await refresh(); has('[data-action="resume"]');
    has('[data-action="resume"].ezil-settings-btn-primary');
    has('[data-role="plan-actions"] [data-action="upgrade"].ezil-settings-btn-primary', false);
    summary.actions.cancel = false; await refresh(); has('[data-action="resume"]', false);
    has('[data-role="plan-actions"] [data-action="upgrade"].ezil-settings-btn-primary');
    pass('every action flag has positive and negative controls');

    summary = v2('free');
    summary.catalog.offers[0].priceCents = 2750;
    summary.catalog.offers[1].priceCents = 12345;
    summary.catalog.offers[1].allowanceStdSeconds = 600 * 3600;
    summary.catalog.offers.reverse();
    await refresh();
    const cards = qa('[data-role="plan-picker"] article');
    assert.ok(q('[data-role="plan-actions"]').matches(':empty'), 'Free plan actions are truly empty for CSS hiding');
    assert.equal(cards.length, 2);
    assert.ok(cards[0].textContent.includes('EZiL Standard'));
    assert.ok(cards[0].textContent.includes('$27.50/month · before tax'));
    assert.ok(cards[0].textContent.includes('60 standard-hours each billing period'));
    assert.ok(cards[0].textContent.includes('2 vCPU · 8 GiB'));
    assert.ok(cards[1].textContent.includes('$123.45/month · before tax'));
    assert.ok(cards[1].textContent.includes('2, 4 or 8 vCPU · up to 32 GiB'));
    assert.ok(cards[1].textContent.includes('Optional usage beyond 600 standard-hours at $0.25 each — off unless you turn it on.'));
    for ( const card of cards ) {
        assert.ok(card.querySelector('.ezil-billing-offer-price strong'));
        assert.equal(card.querySelector('.ezil-billing-offer-price span').textContent, '/month · before tax');
        assert.equal(card.querySelectorAll('.ezil-billing-offer-allowances li').length, 2);
        assert.equal(card.lastElementChild.dataset.action, 'checkout');
    }
    assert.equal(cssRule('.ezil-billing-offer-price strong')['font-size'], '24px');
    assert.ok(parseInt(cssRule('.ezil-billing-offer-allowances').gap, 10) <= 6);
    assert.equal(cssRule('.ezil-billing-offers button')['margin-top'], 'auto');
    assert.equal(qa('[data-role="plan-picker"] .ezil-settings-btn-primary').length, 2);
    for ( const sku of ['standard_monthly_v2', 'compute_monthly_v2'] ) {
        const button = q(`[data-action="checkout"][data-sku="${sku}"]`), before = sheets.length;
        click(button); click(button);
        assert.equal(sheets.length, before + 1);
        const sheet = sheets.at(-1);
        assert.equal(sheet.sku, sku);
        assert.deepEqual(sheet.offer, summary.catalog.offers.find(offer => offer.sku === sku));
        assert.deepEqual(sheet.sizes, summary.catalog.sizes);
        assert.equal(sheet.container, q('.window[data-app="settings"] .window-body'));
        assert.equal(typeof sheet.trpc.query, 'function');
        assert.equal(typeof sheet.trpc.mutate, 'function');
        assert.equal(typeof sheet.onClose, 'function');
        await closeSheet();
        click(button); assert.equal(sheets.length, before + 2);
        const beforeSummary = count(), beforeHistory = count('history');
        sheets.at(-1).onDone();
        sheets.at(-1).handle.close();
        await settle(); audit();
        assert.equal(count(), beforeSummary + 1);
        assert.equal(count('history'), beforeHistory + 1);
    }
    legacyClose = true;
    for ( const mountOnPage of [false, true] ) {
        pageCheckout = mountOnPage;
        click(q('[data-action="checkout"]')); await closeSheet();
        const afterLegacy = sheets.length;
        click(q('[data-action="checkout"]'));
        assert.equal(sheets.length, afterLegacy + 1, 'v1 removal observer releases pane and page checkout');
        await closeSheet();
    }
    legacyClose = false; pageCheckout = false;
    openerFailure = true; click(q('[data-action="checkout"]'));
    contains('[data-role="billing-action-error"]', 'Could not open billing. Try again.');
    openerFailure = false; click(q('[data-action="checkout"]')); await closeSheet();
    pass('plan picker, DTO checkout options, double-click guard, callbacks and v1 close fallback');

    summary = v2();
    summary.compute.usedStdSeconds = 765001;
    summary.compute.remainingActualSecondsBySize = { 'std-2': 1803599, 'cmp-4': 900359, 'cmp-8': 450359, 'free-cf': 999999 };
    await refresh();
    contains('[data-meter="compute"] .ezil-billing-usage', '212.6');
    contains('[data-meter="compute"]', 'of 500 standard-hours');
    const bar = q('[data-meter="compute"] [role="progressbar"]');
    assert.equal(bar.getAttribute('aria-valuemin'), '0'); assert.equal(bar.getAttribute('aria-valuemax'), '100');
    assert.equal(bar.getAttribute('aria-valuenow'), '42');
    assert.equal(bar.getAttribute('aria-valuetext'), '212.6 of 500 standard-hours');
    contains('[data-meter="compute"]', 'Resets Nov 1 (UTC)');
    contains('[data-role="size-hours"]', 'Included time left');
    contains('[data-role="size-hours"] [data-size="cmp-8"]', '≈ 125 h at 8 vCPU');
    contains('[data-role="size-hours"] [data-size="cmp-4"]', '≈ 250 h at 4 vCPU');
    contains('[data-role="size-hours"] [data-size="std-2"]', '≈ 500 h at 2 vCPU');
    assert.equal(q('[data-role="size-hours"]').textContent, 'Included time left: ≈ 500 h at 2 vCPU · ≈ 250 h at 4 vCPU · ≈ 125 h at 8 vCPU');
    assert.equal(q('[data-role="size-hours"]').tagName, 'P');
    assert.ok(qa('[data-role="size-hours"] [data-size]').every(element => element.tagName === 'SPAN'));
    has('[data-role="size-hours"] ul', false);
    has('[data-role="size-hours"] [data-size="free-cf"]', false);
    contains('[data-meter="compute"]', '1 standard-hour = 1 hour at 2 vCPU.');
    contains('[data-meter="compute"]', '4 vCPU uses 2 per hour; 8 vCPU uses 4 per hour.');
    summary.compute.allowedSizes = ['std-2', 'cmp-8']; await refresh();
    has('[data-role="size-hours"] [data-size="cmp-4"]', false);
    for ( const [seconds, label] of [[59, '0 m'], [2759, '45 m'], [3599, '59 m'], [3600, '1 h'], [7199, '1 h']] ) {
        summary = v2();
        summary.compute.remainingStdSeconds = seconds;
        summary.compute.usedStdSeconds = summary.compute.allowanceStdSeconds - seconds;
        summary.compute.remainingActualSecondsBySize = Object.fromEntries(summary.compute.allowedSizes.map(code =>
            [code, Math.floor(seconds / summary.catalog.sizes.find(size => size.code === code).weight)]));
        await refresh();
        assert.equal(q('[data-role="size-hours"] [data-size="std-2"]').textContent, `≈ ${label} at 2 vCPU`);
        assert.equal(q('input[value="std-2"]').closest('label').querySelector('span > span:last-child').textContent, `≈ ${label} included left`);
    }
    pass('compact included-time line floors minutes below one hour and whole hours in the line and radios');
    summary = v2();
    summary.compute.remainingStdSeconds = 0;
    summary.compute.remainingActualSecondsBySize = { 'std-2': 0, 'cmp-4': 0, 'cmp-8': 0, 'free-cf': 999 };
    for ( const [over, caption] of [[0, 'of 500 standard-hours'], [360000, 'of 500 standard-hours · 100 over'], [360001, 'of 500 standard-hours · 100.1 over']] ) {
        summary.compute.usedStdSeconds = summary.compute.allowanceStdSeconds + over;
        await refresh();
        assert.equal(q('[data-role="size-hours"]').textContent, 'No included time left this period.');
        assert.equal(q('[data-meter="compute"] .ezil-billing-allowance').textContent, caption);
        assert.equal(q('[data-meter="compute"] [role="progressbar"]').getAttribute('aria-valuenow'), '100');
    }
    summary.compute.remainingActualSecondsBySize['std-2'] = 120;
    await refresh();
    contains('[data-role="size-hours"]', 'Included time left: ≈ 2 m at 2 vCPU');
    assert.equal(qa('[data-role="size-hours"] [data-size]').length, 3, 'mixed zero/nonzero sizes remain visible');
    pass('zero included-time message, allowed sizes only and rounded-up over-allowance caption');
    for ( const meter of ['compute', 'storage', 'ai'] ) for ( const state of ['ok', 'low', 'exhausted', 'over_cap', 'unavailable'] ) {
        summary = v2(); summary[meter].state = state;
        await refresh();
        assert.ok(q(`[data-meter="${meter}"]`).classList.contains(`is-${state}`));
        has(`[data-meter="${meter}"] [role="progressbar"]`, state !== 'unavailable');
        has('[data-role="billing-nudge"]', ['low', 'exhausted', 'over_cap'].includes(state));
    }
    for ( const [seconds, value] of [[0, '0'], [3600000, '100']] ) {
        summary = v2(); summary.compute.usedStdSeconds = seconds; await refresh();
        assert.equal(q('[data-meter="compute"] [role="progressbar"]').getAttribute('aria-valuenow'), value);
    }
    await fixture(v2('free', 8));
    contains('[data-meter="compute"]', '1 h 15 m'); contains('[data-meter="compute"]', 'of 8 h');
    has('[data-role="size-hours"] [data-size="free-cf"]');
    pass('compute rounding, accessible meter values, remaining time, allowed sizes and all meter states');

    await fixture();
    const radios = qa('[data-role="size-selector"] input');
    assert.equal(radios.length, 3);
    assert.equal(q('[data-role="size-selector"] legend').textContent, 'Computer size');
    for ( const input of radios ) {
        assert.equal(input.type, 'radio'); assert.equal(input.name, 'ezil-billing-size');
        assert.ok(input.closest('label')); assert.equal(input.tabIndex, 0);
        input.focus(); assert.equal(window.document.activeElement, input);
    }
    contains('[data-role="size-selector"]', 'Uses 1 standard-hour per hour');
    contains('[data-role="size-selector"]', 'Uses 4 standard-hours per hour');
    assert.equal(q('[data-role="size-status"]').getAttribute('aria-live'), 'polite');
    let releaseMutation;
    mutation = () => new Promise(resolve => { releaseMutation = resolve; });
    const beforeSize = count(), originalMeter = q('[data-meter="compute"]');
    changeSize('cmp-8');
    assert.deepEqual(calls.at(-1).input, { size: 'cmp-8' });
    assert.ok(calls.at(-1).url.endsWith('/billing.selectSize'));
    assert.equal(calls.at(-1).method, 'POST');
    contains('[data-role="size-status"]', 'Saving…');
    assert.ok(qa('[data-pane="billing"] button, [data-pane="billing"] input').every(el => el.disabled));
    const pendingCalls = calls.length;
    click(q('[data-action="portal"]')); assert.equal(calls.length, pendingCalls);
    releaseMutation(reply({ selectedSize: 'cmp-8' })); await settle(); audit();
    contains('[data-role="size-status"]', 'Size saved.');
    assert.equal(q('input[value="cmp-8"]').checked, true);
    assert.equal(count(), beforeSize); assert.equal(q('[data-meter="compute"]'), originalMeter);
    click(q('[data-action="overage"]'));
    assert.equal(sheets.at(-1).summary.compute.selectedSize, 'cmp-8'); await closeSheet();
    mutation = () => failure('size_not_allowed', 'BAD_REQUEST');
    changeSize('cmp-4'); await settle(); audit();
    contains('[data-role="size-status"]', "That size isn't included in your plan.");
    assert.equal(q('input[value="cmp-8"]').checked, true); assert.equal(q('input[value="cmp-4"]').checked, false);
    assert.ok(qa('[data-role="size-selector"] input').every(el => !el.disabled));
    const beforeSame = calls.length;
    changeSize('cmp-8'); await settle(); assert.equal(calls.length, beforeSame);
    for ( const [family, name, size] of [['standard', 'EZiL Standard', '2 vCPU · 8 GiB'], ['pro_legacy', 'EZiL Pro', '2 vCPU · 8 GiB'], ['free', 'EZiL Free', '2 vCPU · 6 GiB']] ) {
        for ( const upgrade of [true, false] ) {
            summary = v2(family); summary.actions.upgrade = upgrade; summary.actions.selectSize = true;
            await refresh();
            assert.equal(q('[data-role="size-selector"]').tagName, 'SECTION');
            assert.equal(q('[data-role="size-selector"] h4').textContent, 'Computer size');
            assert.equal(qa('[data-role="size-selector"] input').length, 0);
            contains('[data-role="size-locked"]', size);
            contains('[data-role="size-locked"]', `Included with ${name}`);
            const upgrades = qa('[data-role="size-selector"] [data-action="upgrade"]');
            assert.equal(upgrades.length, Number(upgrade));
            if ( upgrade ) {
                assert.equal(upgrades[0].textContent, 'Upgrade to Compute for 4 or 8 vCPU');
                assert.equal(q('[data-role="size-selector"]').textContent.split('Upgrade to Compute').length, 2, 'upgrade copy appears once');
                click(upgrades[0]); assert.equal(sheets.at(-1).kind, 'upgrade'); await closeSheet();
            }
        }
    }
    await fixture(v2('free'));
    for ( const selector of ['[data-role="plan-card"]', '[data-role="size-selector"]'] ) {
        contains(selector, '2 vCPU · 6 GiB'); assert.doesNotMatch(q(selector).textContent, /8 GiB/);
    }
    // A portal mutation must preserve the static size card.
    summary.actions.portal = true; await refresh();
    mutation = () => reply({ url: 'https://billing.example.test/session' });
    click(q('[data-action="portal"]')); await settle();
    assert.equal(qa('[data-role="size-selector"] input').length, 0);
    contains('[data-role="size-locked"]', 'Included with EZiL Free');
    pass('native size controls, pending lock, successful save without reload, rollback and locked plans');

    summary = v2(); summary.compute.session.activeDeadline = new Date(now + (2 * 3600 + 14 * 60) * 1000).toISOString();
    await refresh();
    assert.equal(q('[data-role="session-note"]').textContent, 'Sessions run up to 6 hours, then your work is saved and the computer restarts. Files and installed tools are kept; running processes start fresh.');
    assert.equal(q('[data-role="session-countdown"]').textContent, 'This session saves and restarts in 2 h 14 m.');
    assert.ok(q('[data-role="session-note"]').closest('.ezil-billing-card'));
    assert.equal(q('[data-role="session-note"]').nextElementSibling, q('[data-role="session-countdown"]'));
    assert.equal(intervals.size, 1);
    assert.equal(q('[data-role="session-countdown"]').classList.contains('ezil-billing-warning'), false);
    const firstTimer = [...intervals.keys()][0];
    now += (2 * 3600 - 60) * 1000;
    [...intervals.values()].forEach(fn => fn());
    contains('[data-role="session-countdown"]', '15 m');
    assert.equal(q('[data-role="session-countdown"]').classList.contains('ezil-billing-warning'), true);
    now += 15 * 60000;
    [...intervals.values()].forEach(fn => fn());
    assert.equal(q('[data-role="session-countdown"]').textContent, 'This session is saving and restarting now.');
    await refresh(); assert.equal(intervals.size, 1); assert.equal(intervals.has(firstTimer), false);
    click(q('[data-tab="account"]')); assert.equal(intervals.size, 0);
    click(q('[data-tab="billing"]')); await settle(); assert.equal(intervals.size, 1);
    await window.$(q('.window[data-app="settings"]')).close(); await settle(); assert.equal(intervals.size, 0);
    await open(); assert.equal(intervals.size, 1);
    summary.compute.session.activeDeadline = null; await refresh();
    has('[data-role="session-countdown"]', false); assert.equal(intervals.size, 0);
    pass('exact session note, 30-second countdown, warning/deadline and timer cleanup');

    await fixture();
    contains('[data-role="overage"]', 'Off. When your 500 standard-hours are used up, your computer saves and pauses until the next period.');
    assert.equal(q('[data-role="overage"]').dataset.enabled, 'false');
    assert.equal(q('[data-role="overage"] button').textContent, 'Turn on…');
    click(q('[data-role="overage"] button')); assert.equal(sheets.at(-1).kind, 'overage'); assert.deepEqual(sheets.at(-1).summary, summary); await closeSheet();
    for ( const family of ['free', 'standard'] ) { await fixture(v2(family)); has('[data-role="overage"]', false); }
    summary = v2(); summary.overage.available = false; await refresh(); has('[data-role="overage"]', false);
    summary = v2(); summary.compute.allowanceStdSeconds = 600000; summary.catalog.offers[1].allowanceStdSeconds = 700 * 3600;
    await refresh(); contains('[data-role="overage"]', 'When your 700 standard-hours');
    summary.overage.enabled = true; summary.overage.accruedCents = 375; summary.overage.acceptedVersion = TERMS; summary.overage.acceptedAt = '2026-10-18T00:00:00Z';
    await refresh();
    assert.equal(q('[data-role="overage"]').dataset.enabled, 'true');
    contains('[data-role="overage"]', 'On · up to $25.00 a period at $0.25 per standard-hour.');
    contains('[data-role="overage"]', 'Accrued this period: $3.75.');
    assert.equal(q('[data-action="overage"]').textContent, 'Change cap');
    click(q('[data-action="overage"]')); assert.deepEqual(sheets.at(-1).summary, summary); await closeSheet();
    assert.equal(text().includes('The overage terms changed.'), false);
    summary.overage.acceptedVersion = 'old'; await refresh();
    contains('[data-role="overage"]', 'The overage terms changed. Review them to keep overage on.');
    assert.equal(q('[data-role="overage"] p.ezil-billing-warning').textContent, 'The overage terms changed. Review them to keep overage on.');
    assert.equal(q('[data-action="overage"]').textContent, 'Review terms');
    click(q('[data-action="overage"]')); assert.equal(sheets.at(-1).kind, 'overage'); await closeSheet();
    for ( const [reason, copy] of [['cap_reached', 'Overage reached your $25.00 cap. Your computer saves and pauses until the next period, or raise the cap.'], ['payment_failed', "Overage is off because a usage invoice wasn't paid."]] ) {
        summary.overage.pausedReason = reason; await refresh();
        assert.equal(q('[data-role="overage-paused"]').dataset.reason, reason);
        assert.equal(q('[data-role="overage-paused"]').textContent, copy);
    }
    summary.overage.pausedReason = null; await refresh(); has('[data-role="overage-paused"]', false);
    let beforeMutationSummary = count(), beforeMutationHistory = count('history');
    mutation = () => reply({ ...summary.overage, enabled: false });
    click(q('[data-action="overage-off"]'));
    const offCall = calls.at(-1);
    assert.ok(offCall.url.endsWith('/billing.setOverage'));
    assert.deepEqual(offCall.input, { enabled: false, capCents: 2500, termsVersion: TERMS });
    await settle(); audit();
    assert.equal(count(), beforeMutationSummary + 1); assert.equal(count('history'), beforeMutationHistory + 1);
    mutation = () => failure('terms_version_mismatch');
    click(q('[data-action="overage-off"]')); await settle();
    contains('[data-role="billing-action-error"]', errorTable.terms_version_mismatch);
    summary.actions.overage = false; await refresh(); has('[data-action="overage-off"]', false); has('[data-action="overage"]', false);
    pass('overage availability, on/off, changed terms, paused reasons, sheet options and exact disable payload');

    summary = v2(); summary.overage.enabled = true; summary.overage.accruedCents = 375;
    summary.estimate = { ...summary.estimate, subscriptionCents: 12345, accruedOverageCents: 375, worstCaseOverageCents: 4200 };
    await refresh();
    contains('[data-role="estimate"]', 'Next charge on Nov 1: $123.45 subscription before tax.');
    contains('[data-role="estimate"]', 'Usage so far: $3.75, billed separately.');
    contains('[data-role="estimate"]', 'At your cap: up to $42.00, billed separately.');
    assert.equal(qa('[data-role="estimate"] p').length, 3);
    for ( const key of ['subscriptionCents', 'nextChargeAt'] ) {
        const original = summary.estimate[key]; summary.estimate[key] = null; await refresh();
        contains('[data-role="estimate"]', 'No upcoming subscription charge.');
        assert.equal(q('[data-role="estimate"]').textContent.includes('Next charge on'), false);
        summary.estimate[key] = original;
    }
    summary.overage.enabled = false; await refresh();
    contains('[data-role="estimate"]', 'Usage so far: $3.75, billed separately.');
    assert.equal(q('[data-role="estimate"]').textContent.includes('At your cap:'), false);
    summary.overage.accruedCents = 0; summary.estimate.accruedOverageCents = 0; await refresh();
    assert.equal(qa('[data-role="estimate"] p').length, 1);
    summary.overage.enabled = true; summary.estimate.worstCaseOverageCents = 0; await refresh();
    contains('[data-role="estimate"]', 'Usage so far: $0.00, billed separately.');
    contains('[data-role="estimate"]', 'At your cap: up to $0.00, billed separately.');
    await fixture(v2('standard')); assert.equal(qa('[data-role="estimate"] p').length, 1);
    await fixture(v2('free')); has('[data-role="estimate"]', false);
    pass('subscription and usage estimates stay separate with conditional lines');

    for ( const kind of ['upgrade', 'downgrade', 'cancel', 'overage'] ) {
        summary = v2(kind === 'upgrade' ? 'standard' : 'compute'); await refresh();
        const button = q(`[data-action="${kind}"]`), before = sheets.length;
        click(button); click(button);
        assert.equal(sheets.length, before + 1);
        const sheet = sheets.at(-1);
        assert.equal(sheet.kind, kind); assert.deepEqual(sheet.summary, summary);
        assert.equal(sheet.container, q('.window-body'));
        assert.equal(typeof sheet.trpc.query, 'function'); assert.equal(typeof sheet.trpc.mutate, 'function');
        assert.equal(typeof sheet.onDone, 'function'); assert.equal(typeof sheet.onClose, 'function');
        // Guard covers different entry points too.
        click(q('[data-action="portal"]')); assert.equal(sheets.length, before + 1);
        await closeSheet(); click(button); assert.equal(sheets.length, before + 2);
        const beforeDone = count(), historyBeforeDone = count('history');
        sheets.at(-1).onDone(); sheets.at(-1).handle.close(); await settle(); audit();
        assert.equal(count(), beforeDone + 1); assert.equal(count('history'), historyBeforeDone + 1);
        openerFailure = true; click(q(`[data-action="${kind}"]`));
        contains('[data-role="billing-action-error"]', 'Could not open billing. Try again.');
        openerFailure = false; click(q(`[data-action="${kind}"]`)); await closeSheet();
    }
    summary = v2(); summary.plan.status = 'cancels'; summary.plan.cancelsAt = END; await refresh();
    mutation = () => reply({ cancelsAt: null });
    beforeMutationSummary = count(); beforeMutationHistory = count('history');
    click(q('[data-action="resume"]'));
    assert.ok(calls.at(-1).url.endsWith('/billing.cancelAtPeriodEnd')); assert.deepEqual(calls.at(-1).input, { cancel: false });
    await settle(); assert.equal(count(), beforeMutationSummary + 1); assert.equal(count('history'), beforeMutationHistory + 1);
    mutation = () => failure('not_subscribed'); click(q('[data-action="resume"]')); await settle();
    contains('[data-role="billing-action-error"]', errorTable.not_subscribed);
    pass('all four sheet ports, guard release after throws, callbacks and resume mutation');

    summary = v2(); summary.compute.state = 'low'; summary.compute.selectedSize = 'cmp-8'; summary.compute.remainingActualSecondsBySize['cmp-8'] = 5400;
    await refresh();
    contains('[data-role="billing-nudge"]', 'Included compute is running low: ≈ 1 h 30 m left at 8 vCPU · 32 GiB.');
    assert.equal(q('[data-role="billing-nudge"] button').textContent, 'Turn on overage…');
    click(q('[data-role="billing-nudge"] button')); assert.equal(sheets.at(-1).kind, 'overage'); await closeSheet();
    summary.actions.upgrade = true; await refresh();
    assert.equal(q('[data-role="billing-nudge"] button').textContent, 'Upgrade to Compute');
    assert.equal(qa('[data-role="billing-nudge"] button').length, 1);
    summary.actions.upgrade = false; summary.overage.enabled = true; await refresh(); has('[data-role="billing-nudge"] button', false);
    summary.overage.enabled = false; summary.actions.overage = false; await refresh(); has('[data-role="billing-nudge"] button', false);
    summary.compute.state = 'exhausted'; await refresh(); contains('[data-role="billing-nudge"]', 'Included compute is used up for this period.');
    await fixture(); has('[data-role="billing-nudge"]', false);
    contains('[data-meter="storage"]', '1.5 GB'); contains('[data-meter="storage"]', 'of 2.0 GB');
    summary.storage.measuredAt = new Date(now - 120000).toISOString(); await refresh(); contains('[data-meter="storage"]', 'Updated 2 min ago');
    summary.storage.measuredAt = null; await refresh(); contains('[data-meter="storage"]', 'Not measured yet.');
    contains('[data-meter="ai"]', 'Coming soon'); contains('[data-meter="ai"]', 'AI assistant coming soon');
    assert.doesNotMatch(q('[data-meter="ai"]').textContent, /\$|credit ready|trial ready/i);
    summary.ai = { state: 'ok', trialMicro: '500000', includedMicro: '3000000', purchasedMicro: '10000000', includedExpiresAt: END };
    await refresh(); contains('[data-meter="ai"]', '$13.50 left'); contains('[data-meter="ai"]', 'Included credit expires Nov 1');
    summary.ai.trialMicro = '90071992547409930000'; summary.ai.includedMicro = '70000'; summary.ai.purchasedMicro = '0';
    summary.storage.usedBytes = '900719925474099399999'; await refresh();
    contains('[data-meter="ai"]', '$90071992547410.00 left'); contains('[data-meter="storage"]', '900719925474.1 GB');
    assert.equal(q('[data-meter="storage"] [role="progressbar"]').getAttribute('aria-valuenow'), '100');
    summary.ai.state = 'unavailable'; await refresh(); assert.doesNotMatch(q('[data-meter="ai"]').textContent, /\$/);
    for ( const [href, label] of [['/pricing', 'Plans'], ['/refunds', 'Refund policy'], ['mailto:contact@ezil.work', 'Support']] ) assert.equal(pane().querySelector(`a[href="${href}"]`).textContent, label);
    pass('attention nudges, one primary action, storage/AI behavior, exact large balances and footer');

    summary = v2(); summary.plan.paymentIssue = 'payment_failed'; await refresh();
    assert.equal(q('[data-role="payment-banner"]').dataset.issue, 'payment_failed');
    assert.equal(q('[data-role="payment-banner"]').getAttribute('role'), 'status');
    contains('[data-role="payment-banner"]', "Your last payment didn't go through. Update your payment method to keep your plan.");
    assert.equal(q('[data-role="payment-banner"] button').textContent, 'Update payment method');
    mutation = () => reply({ url: 'https://billing.example.test/session' });
    click(q('[data-role="payment-banner"] button')); await settle();
    assert.deepEqual(opened.at(-1), ['https://billing.example.test/session', '_blank', 'noopener']);
    assert.ok(calls.at(-1).url.endsWith('/billing.portal')); assert.equal(calls.at(-1).method, 'POST');
    summary.actions.portal = false; await refresh(); has('[data-role="payment-banner"] button', false);
    summary.actions.portal = true; summary.plan.paymentIssue = 'requires_action';
    summary.plan.pendingUpgrade = { toSku: 'compute_monthly_v2', expiresAt: END, hostedInvoiceUrl: 'https://invoice.example.test/pending' };
    // Deliberately unsorted, mixing kinds and statuses; pending upgrade wins first.
    history = [invoice('subscription', '2026-10-10T00:00:00Z'), { ...invoice('overage', '2026-10-25T00:00:00Z'), url: 'https://invoice.example.test/wrong-kind' },
        { ...invoice('subscription', '2026-10-15T00:00:00Z'), url: 'https://invoice.example.test/newest-subscription' },
        { ...invoice('subscription', '2026-10-28T00:00:00Z', 'paid'), url: 'https://invoice.example.test/already-paid' }];
    await refresh();
    contains('[data-role="payment-banner"]', 'Your bank needs you to confirm a payment.');
    assert.equal(q('[data-role="payment-banner"] button').textContent, 'Confirm payment');
    assert.equal(q('[data-role="payment-banner"] button').dataset.kind, 'subscription');
    let beforePortal = count('portal');
    click(q('[data-action="open-invoice"]')); await settle();
    assert.deepEqual(opened.at(-1), ['https://invoice.example.test/pending', '_blank', 'noopener']);
    assert.equal(count('portal'), beforePortal);
    summary.plan.pendingUpgrade.hostedInvoiceUrl = 'javascript:alert(1)'; await refresh();
    click(q('[data-action="open-invoice"]')); await settle();
    assert.equal(opened.at(-1)[0], 'https://invoice.example.test/newest-subscription');
    assert.equal(count('portal'), beforePortal);
    summary.plan.pendingUpgrade = null;
    history[2].url = 'javascript:alert(1)'; await refresh();
    click(q('[data-action="open-invoice"]')); await settle();
    assert.equal(opened.at(-1)[0], 'https://invoice.example.test/subscription');
    history[0].url = null; await refresh();
    click(q('[data-action="open-invoice"]')); await settle();
    assert.equal(count('portal'), beforePortal + 1); assert.equal(opened.at(-1)[0], 'https://billing.example.test/session');
    summary.plan.paymentIssue = 'overage_unpaid'; summary.plan.pendingUpgrade = { toSku: 'compute_monthly_v2', expiresAt: END, hostedInvoiceUrl: 'https://invoice.example.test/not-usage' };
    history = [{ ...invoice('overage', '2026-10-10T00:00:00Z'), url: 'https://invoice.example.test/old-usage' }, invoice('subscription', '2026-10-29T00:00:00Z'),
        { ...invoice('overage', '2026-10-15T00:00:00Z'), url: 'https://invoice.example.test/new-usage' }, invoice('overage', '2026-10-28T00:00:00Z', 'paid')];
    await refresh();
    assert.equal(q('[data-role="payment-banner"]').dataset.issue, 'overage_unpaid');
    contains('[data-role="payment-banner"]', 'Overage is paused until your usage invoice is paid. Your computer stops at your included allowance; saved files are kept.');
    assert.equal(q('[data-action="open-invoice"]').textContent, 'Pay usage invoice');
    assert.equal(q('[data-action="open-invoice"]').dataset.kind, 'overage');
    beforePortal = count('portal');
    click(q('[data-action="open-invoice"]')); await settle();
    assert.equal(opened.at(-1)[0], 'https://invoice.example.test/new-usage'); assert.equal(count('portal'), beforePortal);
    history[2].url = 'javascript:alert(1)'; await refresh();
    click(q('[data-action="open-invoice"]')); await settle(); assert.equal(opened.at(-1)[0], 'https://invoice.example.test/old-usage');
    history[0].url = null; await refresh();
    click(q('[data-action="open-invoice"]')); await settle(); assert.equal(count('portal'), beforePortal + 1);
    summary.actions.portal = false; await refresh();
    const beforeNoPortal = calls.length, beforeNoURL = opened.length;
    click(q('[data-action="open-invoice"]')); await settle();
    assert.equal(calls.length, beforeNoPortal); assert.equal(opened.length, beforeNoURL);
    contains('[data-role="billing-action-error"]', fallback);
    // History resolves after the banner renders: click must use the current history.
    let releaseHistory;
    summary.actions.portal = true;
    getHistory = () => new Promise(resolve => { releaseHistory = resolve; });
    await refresh(); contains('[data-role="invoice-rows"]', 'Loading invoices…');
    releaseHistory(reply([invoice('overage')])); await settle();
    click(q('[data-action="open-invoice"]')); await settle(); assert.equal(opened.at(-1)[0], 'https://invoice.example.test/overage');
    getHistory = () => reply(history);
    summary.plan.paymentIssue = null; await refresh(); has('[data-role="payment-banner"]', false);
    const beforeUnsafe = opened.length;
    mutation = () => new Promise(resolve => { releaseMutation = resolve; });
    const portal = q('[data-action="portal"]'); click(portal);
    assert.ok(qa('[data-pane="billing"] button, [data-pane="billing"] input').every(el => el.disabled));
    const beforeDuplicate = count('portal'); click(portal); assert.equal(count('portal'), beforeDuplicate);
    releaseMutation(reply({ url: 'javascript:alert(1)' })); await settle();
    assert.equal(opened.length, beforeUnsafe); assert.equal(portal.disabled, false);
    contains('[data-role="billing-action-error"]', fallback);
    mutation = () => failure('customer_conflict', 'BAD_REQUEST'); click(portal); await settle();
    contains('[data-role="billing-action-error"]', errorTable.customer_conflict);
    mutation = () => { throw new Error('network down'); }; click(portal); await settle();
    contains('[data-role="billing-action-error"]', fallback);
    // Allow-list, not a deny-list: only https: may ever be opened (javascript:, data:, vbscript: all refused).
    assert.equal(opened.every(([url]) => new URL(url).protocol === 'https:'), true);
    pass('all payment banners, click-time invoice precedence, portal gating and unsafe-URL rejection');

    history = Array.from({ length: 14 }, (_, i) => ({ ...invoice(['subscription', 'overage', 'other'][i % 3], `2026-10-${String(i + 1).padStart(2, '0')}T12:00:00Z`, i === 13 ? 'paid' : 'open'), id: `in_${i}`, description: `Invoice ${i}`, url: `https://invoice.example.test/${i}` }));
    history[13].description = '<img src=x onerror=alert(1)>';
    history[13].amountPaidCents = '900719925474099300';
    summary = v2(); await refresh();
    assert.equal(qa('.ezil-billing-invoice').length, 12); has('[data-role="invoices-empty"]', false);
    contains('.ezil-billing-invoice', 'Oct 14, 2026'); contains('.ezil-billing-invoice', '$9007199254740993.00');
    contains('.ezil-billing-invoice', '<img src=x onerror=alert(1)>'); has('.ezil-billing-invoice img', false);
    assert.equal(qa('.ezil-billing-invoice').at(-1).querySelector('time').textContent, 'Oct 3, 2026');
    assert.ok(qa('.ezil-billing-invoice')[1].textContent.includes('$23.45'), 'open invoice uses due amount');
    assert.equal(q('.ezil-billing-invoice a').target, '_blank'); assert.equal(q('.ezil-billing-invoice a').rel, 'noopener');
    assert.equal(q('.ezil-billing-invoice a').href, 'https://invoice.example.test/13');
    assert.deepEqual([...q('.ezil-billing-invoice-heading').children].map(element => element.tagName), ['TIME', 'SPAN']);
    assert.equal(q('.ezil-billing-invoice-heading [data-role="invoice-kind"]').dataset.kind, 'overage');
    assert.equal(q('.ezil-billing-invoice-description').textContent, '<img src=x onerror=alert(1)>');
    assert.deepEqual([...q('.ezil-billing-invoice-details').children].map(element => element.textContent), ['$9007199254740993.00', 'Paid', 'View ↗']);
    for ( const [kind, label] of [['subscription', 'Subscription'], ['overage', 'Usage'], ['other', 'Other']] ) assert.equal(q(`[data-role="invoice-kind"][data-kind="${kind}"]`).textContent, label);
    history[13].url = 'javascript:alert(1)'; await refresh(); assert.equal(q('.ezil-billing-invoice').querySelector('a'), null); contains('.ezil-billing-invoice', 'Link unavailable');
    for ( const kind of ['subscription', 'overage', 'other'] ) {
        history = [invoice(kind)]; await refresh(); contains('.ezil-billing-invoice', `EZiL ${kind}`);
    }
    getHistory = () => failure('History failed'); await refresh();
    contains('[data-role="invoices"]', "Couldn't load invoices."); assert.equal(qa('[data-meter]').length, 3); has('[data-action="portal"]');
    getHistory = () => reply([]);
    click(q('[data-role="invoices"] [data-action="retry"]')); await settle(); audit();
    contains('[data-role="invoices-empty"]', 'No invoices yet.'); has('[data-role="invoices"] [data-action="retry"]', false);
    history = []; getHistory = () => reply(history);
    pass('invoice kinds, paid/due amounts, newest 12, encoded descriptions, safe links and independent retry');

    for ( const sku of ['standard_monthly_v2', 'compute_monthly_v2'] ) {
        summary = v2('free'); const before = sheets.length;
        await open({ ...context, initialTab: 'billing', openUpgrade: sku });
        assert.equal(sheets.length, before + 1); assert.equal(sheets.at(-1).sku, sku);
        await closeSheet(); await refresh(); assert.equal(sheets.length, before + 1);
    }
    summary = v2('standard'); let beforeAuto = sheets.length;
    await open({ ...context, initialTab: 'billing', openUpgrade: 'compute_monthly_v2' });
    assert.equal(sheets.length, beforeAuto + 1); assert.equal(sheets.at(-1).kind, 'upgrade');
    await closeSheet(); await refresh(); assert.equal(sheets.length, beforeAuto + 1);
    summary = v2('free'); beforeAuto = sheets.length;
    let scrolled = 0;
    window.HTMLElement.prototype.scrollIntoView = function () { if ( this.dataset.role === 'plan-picker' ) scrolled++; };
    await open({ ...context, initialTab: 'billing', openUpgrade: true });
    assert.equal(sheets.length, beforeAuto); assert.equal(scrolled, 1);
    assert.equal(window.document.activeElement, q('[data-role="plan-picker"] button'));
    await refresh(); assert.equal(scrolled, 1);
    for ( const deepLink of [true, 'compute_monthly_v2', 'standard_monthly_v2', 'unknown_sku'] ) {
        summary = v2('free'); summary.actions.checkout = false;
        await open({ ...context, initialTab: 'billing', openUpgrade: deepLink }); assert.equal(sheets.length, beforeAuto);
        summary.actions.checkout = true; await refresh(); assert.equal(sheets.length, beforeAuto, 'first successful load consumes the deep link');
    }
    summary = v2('standard'); summary.actions.upgrade = false;
    await open({ ...context, initialTab: 'billing', openUpgrade: 'compute_monthly_v2' }); assert.equal(sheets.length, beforeAuto);
    summary = v2('free'); getSummary = () => failure('temporary');
    await open({ ...context, initialTab: 'billing', openUpgrade: 'standard_monthly_v2' }); assert.equal(sheets.length, beforeAuto);
    getSummary = () => reply(summary); click(q('[data-action="retry"]')); await settle();
    assert.equal(sheets.length, beforeAuto + 1, 'failed load does not consume deep link'); await closeSheet();
    pass('SKU and legacy deep links, focus, action gating and exactly-once successful activation');

    for ( const unavailable of [{ enabled: false }, { version: 1, enabled: true }] ) {
        await fixture(unavailable); contains('[data-role="billing-body"]', "Billing isn't available yet.");
        assert.equal(qa('[data-meter]').length, 0); has('[data-role="billing-body"] [role="alert"]', false);
    }
    getSummary = () => failure('private server detail'); await refresh();
    contains('[data-role="billing-body"] [role="alert"]', "Couldn't load billing. Try again.");
    assert.equal(text().includes('private server detail'), false);
    let releaseSummary;
    getSummary = () => new Promise(resolve => { releaseSummary = resolve; });
    click(q('[data-action="retry"]'));
    assert.equal(qa('.ezil-billing-skeleton').length, 3); assert.equal(q('[data-role="billing-body"]').getAttribute('aria-busy'), 'true');
    summary = v2(); releaseSummary(reply(summary)); await settle(); audit();
    contains('[data-role="plan-card"]', 'EZiL Compute'); has('.ezil-billing-skeleton', false);
    assert.equal(q('[data-role="billing-body"]').getAttribute('aria-busy'), 'false');
    getSummary = () => reply(summary);
    // Offer allowance/price owns the plan card even when the current meter is prorated.
    summary = v2('standard'); summary.compute.allowanceStdSeconds = 30000; summary.catalog.offers[0].allowanceStdSeconds = 90 * 3600; summary.catalog.offers[0].priceCents = 3000;
    await refresh(); contains('[data-role="plan-card"]', '90 standard-hours each billing period'); contains('.ezil-billing-price', '$30/month');
    pass('disabled/v1 summaries, failed summary retry, loading state and prorated plan-card source');

    // Round 5 (D6): one column — header, one state banner, current plan + Your computer, one usage card,
    // three plan cards, the AI top-up disclosure, invoices, footer. At most one primary per state (audit).
    for ( const tier of ['free', 'standard', 'premium'] ) {
        summary = summaryV3(tier); await open();
        contains('[data-role="plan-card"]', summary.plan.name);
        contains('[data-role="your-computer"]', `${summary.computer.vcpu} vCPU · ${summary.computer.memoryGiB} GB`);
        contains('[data-role="your-computer"]', summary.computer.sessionMaxSeconds === null ? 'No session time limit' : 'Sessions up to 1 hour');
        contains('[data-role="your-computer"] [data-action="computer-tab"]', 'Change configuration ›');
        if ( tier !== 'free' ) {
            contains('[data-role="plan-card"]', `$${tier === 'standard' ? 20 : 100} / month`);
            contains('[data-role="plan-card"]', `Renews on Nov 1, 2026 for $${tier === 'standard' ? 20 : 100}.`);
            contains('[data-role="plan-status"]', 'Active');
            contains('[data-role="your-computer"]', 'AWS (India)');
            contains('.ezil-billing-header [data-action="portal"]', 'Manage payment');
            has('.ezil-billing-header [data-action="portal"].ezil-settings-btn-primary', false);
            contains('.ezil-billing-v3-footer [data-action="cancel"]', 'Cancel plan');
        } else contains('[data-role="plan-card"]', 'Free · no card on file');
        contains('[data-role="fair-use"]', 'Within fair use');
        for ( const selector of ['[role="progressbar"]', '[data-meter]', '[data-role="size-selector"]', '[data-role="overage"]', '[data-role="estimate"]', '[data-role="ai-usage"]'] ) has(selector, false);
        assert.doesNotMatch(text(), /\bcompute\b|standard-hour|instant|unlimited|Next start:/i);
        assert.deepEqual(qa('[data-role="plans"] [data-role="plan-offer"]').map(card => card.dataset.sku), ['free_v3', 'standard_monthly_v3', 'premium_monthly_v3']);
        contains(`[data-role="plan-offer"][data-sku="${summary.plan.sku}"][data-current]`, 'Current plan');
        const primary = qa('[data-pane="billing"] .ezil-settings-btn-primary');
        assert.deepEqual(primary.map(button => button.textContent), tier === 'free' ? ['Upgrade to Standard'] : tier === 'standard' ? ['Upgrade to Premium'] : []);
        const action = tier === 'free' ? '[data-role="plan-actions"] [data-action="checkout"]' : tier === 'standard' ? '[data-role="plan-actions"] [data-action="upgrade"]' : '[data-action="downgrade"]';
        click(q(action));
        if ( tier === 'free' ) {
            assert.equal(sheets.at(-1).kind, 'checkout');
            assert.equal(sheets.at(-1).sku, 'standard_monthly_v3');
        } else assert.equal(sheets.at(-1).kind, tier === 'standard' ? 'upgrade' : 'downgrade');
        await closeSheet();
    }
    // From Free, every higher plan card is a secondary checkout; Premium reaches Standard as a link.
    summary = summaryV3('free'); await refresh();
    assert.deepEqual(qa('[data-role="plan-offer"] [data-action="checkout"]').map(button => [button.dataset.sku, button.textContent, button.classList.contains('ezil-settings-btn-primary')]),
        [['standard_monthly_v3', 'Choose Standard', false], ['premium_monthly_v3', 'Choose Premium', false]]);
    summary = summaryV3('premium'); await refresh();
    contains('[data-role="plan-offer"][data-sku="standard_monthly_v3"] [data-action="downgrade"]', 'Switch to Standard');
    // Round 3 (plan §6.3): the configuration choice lives in Settings → Computer; Billing links there.
    has('[data-role="machine-picker"]', false);
    assert.equal(qa('input[name="ezil-billing-machine"]').length, 0);
    assert.ok(! /Next session's computer/.test(text()));
    for ( const role of ['meter-ai', 'meter-time', 'meter-storage'] ) has(`[data-role="${role}"]`);
    click(q('[data-action="computer-tab"]')); await settle();
    assert.equal(active(), 'computers');
    click(q('.ezil-settings-tab[data-tab="billing"]')); await settle();
    for ( const tier of ['free', 'standard'] ) {
        summary = summaryV3(tier); await refresh();
        has('[data-role="machine-picker"]', false);
        has('[data-action="computer-tab"]');
    }
    // The three rows (D6): every row means "left"; split AI credits, hours at the CURRENT configuration, the real disk.
    summary = summaryV3('premium');
    Object.assign(summary.ai, { included: { granted: 1000, remaining: 812, periodEnd: END }, purchased: { remaining: 500, expiresAt: '2027-01-15T00:00:00Z' }, starter: null, pendingFromRenewal: null });
    summary.computer.disk = { provisionedGiB: 50, usedBytes: null, growsOnSwitch: false };
    getUsage = () => reply({ enabled: true, version: 1, asOf: END, session: {}, storage: {}, period: { unit: 'standard_seconds', remainingStandardSeconds: 1630800, allowanceStandardSeconds: 1800000,
        currentSize: 'cmp-8', currentWeight: 4, remainingHoursAtCurrent: 113, equivalents: [{ size: 'std-2', weight: 1, hours: 453 }, { size: 'cmp-4', weight: 2, hours: 226 }, { size: 'cmp-8', weight: 4, hours: 113 }] } });
    await refresh(); audit();
    contains('[data-role="meter-ai"]', '812 of 1,000 left');
    assert.equal(q('[data-role="meter-ai"] [role="meter"]').getAttribute('aria-valuenow'), '81');
    contains('[data-role="meter-ai"]', '+ 500 purchased · expire Jan 15, 2027');
    contains('[data-role="meter-ai"]', 'Used by EZiL AI in Code and Chat.');
    contains('[data-role="meter-time"]', '113 h left');
    assert.equal(q('[data-role="meter-time"] [role="meter"]').getAttribute('aria-valuenow'), '90');
    contains('[data-role="meter-time"]', 'About 113 hours left at 8 vCPU');
    assert.doesNotMatch(q('[data-role="meter-time"]').textContent, /resets/i, 'the reset date lives in the usage card header');
    contains('[data-role="billing-usage"] .ezil-billing-section-head', 'Resets Nov 1, 2026');
    contains('[data-role="meter-time"]', 'Same as 226 hours at 4 vCPU or 453 hours at 2 vCPU.');
    contains('[data-role="meter-time"]', 'Bigger configurations use your monthly time sooner: 4 vCPU counts double, 8 vCPU counts four times.');
    contains('[data-role="meter-storage"]', '50 GB disk for your projects');
    contains('[data-role="your-computer"]', '50 GB disk');
    contains('[data-role="plans"]', 'Your computer keeps its 50 GB disk when you change plan.');
    assert.equal(calls.filter(call => call.url.includes('/billing.usage')).at(-1)?.url.includes('billing.usage'), true);
    summary.ai.pendingFromRenewal = { credits: 1000, at: END }; summary.ai.included = null; summary.ai.balance = 369; await refresh();
    contains('[data-role="meter-ai"]', '369 of 1,000 left');
    contains('[data-role="meter-ai"]', '1,000 more from Nov 1');
    getUsage = () => failure('unavailable'); summary = summaryV3('free'); summary.computer.disk = { provisionedGiB: null, usedBytes: null }; await refresh(); audit();
    contains('[data-role="meter-storage"]', 'Your files are saved between sessions.');
    assert.doesNotMatch(q('[data-role="meter-storage"]').textContent, /\d+ GB/);
    assert.doesNotMatch(q('[data-role="meter-time"]').textContent, /resets/i);
    contains('[data-role="billing-usage"] .ezil-billing-section-head', 'Resets Nov 1, 2026');
    has('[data-role="meter-time"] [role="meter"]', false);
    pass('D6 one column: plan card, Your computer, three left-meters, plan cards; no machine picker; Change configuration links to Computer');
    // Hotfix r5 (ACCEPT #3): the smaller-configuration advice only when the plan allows a size with a
    // smaller time weight than the current one. Standard (2 vCPU only) and Premium on 2 vCPU have none.
    // Review: a computer still on a size its plan no longer offers (Standard on 4 vCPU after a downgrade)
    // takes that size's own weight, so the plan's 2 vCPU still counts as smaller.
    for ( const [tier, size, advice] of [['standard', 'std-2', false], ['premium', 'std-2', false], ['premium', 'cmp-4', true], ['premium', 'cmp-8', true], ['standard', 'cmp-4', true]] ) {
        summary = summaryV3(tier); summary.computer.size = size; summary.fairUse.status = 'near'; await refresh();
        contains('[data-role="fair-use"]', '! Running low.');
        assert.equal(/A smaller configuration makes your time last longer\./.test(q('[data-role="fair-use"]').textContent), advice, `${tier} on ${size}`);
    }
    summary = summaryV3(); await refresh();
    for ( const [status, copy] of [['near', '! Running low.'], ['paused', '■ Used up. You can start your computer again on Nov 1.']] ) {
        summary.fairUse.status = status; await refresh(); contains('[data-role="fair-use"]', copy);
    }
    contains('[data-role="fair-use-paused"]', 'Computer time is used up.');
    contains('[data-role="fair-use-paused"] .ezil-settings-btn-primary', 'Upgrade to Premium');
    has('[data-role="plan-actions"] .ezil-settings-btn-primary', false);
    summary.fairUse.status = 'ok';
    summary.plan.status = 'cancels'; summary.plan.cancelsAt = END; await refresh();
    contains('[data-role="cancels-banner"]', 'Your plan ends on Nov 1, 2026');
    contains('[data-role="cancels-banner"]', 'You keep Standard and your computer until then. After that you move to Free. Your files are kept.');
    assert.ok(! /renews/i.test(text()));
    contains('[data-role="cancels-banner"] [data-action="resume"].ezil-settings-btn-primary', 'Resume plan');
    has('.ezil-billing-v3-footer [data-action="cancel"]', false);
    summary.plan.status = 'past_due'; summary.plan.paymentIssue = 'payment_failed'; await refresh();
    contains('[data-role="payment-banner"]', "Your last payment didn't go through");
    contains('[data-role="payment-banner"]', 'Update your payment method to keep Standard and your computer.');
    contains('[data-role="payment-banner"] [data-action="portal"].ezil-settings-btn-primary', 'Update payment method');
    mutation = () => failure('stripe_unavailable'); click(q('[data-role="payment-banner"] [data-action="portal"]')); await settle();
    contains('[data-role="billing-action-error"]', 'Payments are unavailable'); assert.equal(q('[data-role="payment-banner"] [data-action="portal"]').disabled, false);
    mutation = () => reply({ url: 'javascript:alert(1)' }); const previousOpened = opened.length;
    click(q('[data-role="payment-banner"] [data-action="portal"]')); await settle(); assert.equal(opened.length, previousOpened);
    mutation = () => reply({ url: 'https://billing.example.test/v3' }); click(q('[data-role="payment-banner"] [data-action="portal"]')); await settle();
    assert.equal(opened.at(-1)[0], 'https://billing.example.test/v3');
    // Upgrade waiting for payment: the banner's Finish payment opens the pending invoice.
    summary = summaryV3(); Object.assign(summary.plan, { status: 'upgrade_pending', pendingUpgrade: { toSku: 'premium_monthly_v3', expiresAt: '2026-10-20T00:00:00Z', hostedInvoiceUrl: 'https://invoice.example.test/pending' } }); await refresh();
    contains('[data-role="upgrade-pending"]', 'Premium starts once payment is confirmed. This link expires Oct 20.');
    click(q('[data-role="upgrade-pending"] [data-action="open-invoice"].ezil-settings-btn-primary')); await settle();
    assert.equal(opened.at(-1)[0], 'https://invoice.example.test/pending');
    has('[data-role="plan-offer"][data-sku="premium_monthly_v3"] [data-action="upgrade"]', false);
    // Round 4 (D16-D18): the standing banners. Dates are UTC; the dead past_due-without-issue branch is gone.
    {
        const GRACE = '2026-11-05T00:00:00Z', ENDS = '2026-11-26T00:00:00Z';
        summary = summaryV3('premium'); Object.assign(summary.plan, { status: 'past_due', paymentIssue: 'payment_failed', graceEndsAt: GRACE });
        Object.assign(summary.computer, { standing: 'grace', filesOn: 'aws', heldSince: null, move: null }); await refresh();
        contains('[data-role="payment-grace"]', "Your payment didn't go through — update it by Nov 5, 2026 to keep your AWS computer.");
        contains('[data-role="payment-grace"] [data-action="portal"]', 'Update payment method');
        has('[data-role="payment-banner"]', false);
        assert.equal(qa('[data-role="payment-grace"], [data-role="payment-banner"]').length, 1, 'one payment banner');
        // In grace the new period's plan credits wait for the payment: never "0 of 0 left" + "more from <renewal>".
        Object.assign(summary.ai, { included: { granted: 0, remaining: 0, periodEnd: END }, pendingFromRenewal: { credits: 1000, at: END }, starter: { remaining: 100 } }); await refresh();
        contains('[data-role="meter-ai"]', '0 of 1,000 this period');
        contains('[data-role="meter-ai"]', 'Added once your payment goes through.');
        contains('[data-role="meter-ai"]', '100 starter credits left');
        assert.doesNotMatch(q('[data-role="meter-ai"]').textContent, /0 of 0|more from/);
        Object.assign(summary.ai, { included: { granted: 1000, remaining: 640, periodEnd: END } }); await refresh();
        contains('[data-role="meter-ai"]', '640 of 1,000 left');
        assert.doesNotMatch(q('[data-role="meter-ai"]').textContent, /added once your payment/i);
        summary = summaryV3('premium'); Object.assign(summary.plan, { status: 'cancels', cancelsAt: ENDS, planEndsAt: ENDS });
        Object.assign(summary.computer, { standing: 'plan_ending', filesOn: 'aws', heldSince: null, move: null }); await refresh();
        contains('[data-role="plan-ending"]', 'Premium ends on Nov 26, 2026. After that your files stay on your AWS computer until they are moved to your Free computer; nothing is deleted.');
        has('[data-role="cancels-banner"]', false);
        contains('[data-role="plan-ending"] [data-action="resume"].ezil-settings-btn-primary', 'Resume plan');
        summary = summaryV3('free'); Object.assign(summary.computer, { standing: 'files_on_aws', filesOn: 'aws', heldSince: null, move: null }); await refresh();
        contains('[data-role="files-held"]', 'Your files are still on your AWS (India) computer. It opens on the Free plan with Free limits; upgrade for no session time limit.');
        assert.equal(qa('[data-role="files-held"]').length, 1, 'the hold is said once');
        // Round 6 (R1-11): one provider string; the limit is the session line, and nothing to configure under the hold.
        contains('[data-role="your-computer"]', 'AWS (India)');
        assert.doesNotMatch(q('[data-role="your-computer"]').textContent, /with Free limits|Cloudflare/);
        contains('[data-role="your-computer"]', 'Sessions up to 1 hour on Free');
        contains('[data-role="your-computer"] [data-action="computer-tab"]', 'Computer details ›');
        contains('[data-role="plan-actions"] .ezil-settings-btn-primary', 'Upgrade to Standard');
        // Round 6: the founder's Billing on 10-30 (Free, held std-2, 763 AI credits of which 663 are from the cancelled Premium period).
        Object.assign(summary.computer, { size: 'std-2', vcpu: 2, memoryGiB: 8, disk: { provisionedGiB: 50, usedBytes: null, growsOnSwitch: false } });
        Object.assign(summary.ai, { grant: { amount: 100, per: 'once' }, balance: 763, state: 'ok', included: null, purchased: null, starter: { remaining: 100 },
            previous: { remaining: 663, expiresAt: '2026-11-30T12:00:00Z' }, pendingFromRenewal: null });
        getUsage = () => reply({ enabled: true, version: 1, asOf: END, session: {}, storage: {}, period: { unit: 'standard_seconds', remainingStandardSeconds: 20160,
            allowanceStandardSeconds: 28800, currentSize: 'std-2', currentWeight: 1, remainingHoursAtCurrent: 5, equivalents: [{ size: 'free-cf', weight: 1, hours: 5 }] } });
        await refresh(); audit();
        contains('[data-role="meter-time"]', '5 h left');
        contains('[data-role="meter-time"]', 'About 5 of 8 hours left this month');
        assert.doesNotMatch(q('[data-role="meter-time"]').textContent, /Same as/);
        contains('[data-role="meter-ai"]', '763 left');
        has('[data-role="meter-ai"] [role="meter"]', false);
        contains('[data-role="meter-ai"]', '100 starter credits left');
        contains('[data-role="meter-ai"]', '663 from your previous plan · expire Nov 30, 2026');
        assert.equal((q('[data-role="meter-ai"]').textContent.match(/\b100\b/g) ?? []).length, 1, 'the 100 starter credits are said once');
        contains('[data-role="meter-storage"]', '50 GB disk for your projects');
        contains('[data-role="your-computer"]', '2 vCPU · 8 GB memory · 50 GB disk · AWS (India)');
        assert.doesNotMatch(text(), banned); assert.doesNotMatch(text(), honestyBans); assert.doesNotMatch(text(), /mumbai/i);
        // Round 6 review (R4-02): a held 4 or 8 vCPU computer (placed size `awsSize`) can't open on Free. Billing
        // says so at its own size, in the Computer tab's words, never "opens on the Free plan" or a 1-hour session.
        for ( const [size, vcpu, memoryGiB] of [['cmp-4', 4, 16], ['cmp-8', 8, 32]] ) {
            summary.computer.awsSize = { size, vcpu, memoryGiB }; await refresh(); audit();
            contains('[data-role="files-held"]', `Your files are still on your ${vcpu} vCPU AWS (India) computer. The Free plan can't open it at that size; upgrade to open it again.`);
            assert.equal(q('[data-role="files-held"]').textContent, window.computersTab.heldClosedCopy(size, summary), 'the same words as the Computer tab');
            contains('[data-role="your-computer"]', `${vcpu} vCPU · ${memoryGiB} GB memory · 50 GB disk · AWS (India)`);
            contains('[data-role="your-computer"]', "Can't open on the Free plan at this size");
            for ( const role of ['files-held', 'your-computer'] ) assert.doesNotMatch(q(`[data-role="${role}"]`).textContent, /opens on the Free plan|Sessions up to/);
            assert.doesNotMatch(text(), banned); assert.doesNotMatch(text(), honestyBans); assert.doesNotMatch(text(), /mumbai/i);
        }
        // A held 2 vCPU placement keeps the hold copy.
        summary.computer.awsSize = { size: 'std-2', vcpu: 2, memoryGiB: 8 }; await refresh();
        contains('[data-role="files-held"]', 'It opens on the Free plan with Free limits');
        contains('[data-role="your-computer"]', 'Sessions up to 1 hour on Free');
        delete summary.computer.awsSize;
        getUsage = () => failure('unavailable');
        // After grace the plan block may still describe the unpaid subscription (STANDING-CONTRACT §2).
        summary = summaryV3('premium'); Object.assign(summary.plan, { status: 'past_due', paymentIssue: 'payment_failed' });
        Object.assign(summary.computer, { standing: 'files_on_aws', filesOn: 'aws', heldSince: '2026-11-05T00:00:00Z', move: null }); await refresh();
        has('[data-role="files-held"]'); has('[data-role="payment-grace"]', false);
        assert.doesNotMatch(q('[data-role="your-computer"]').textContent, /Your own computer on AWS/);
        // Round 6 review: past its grace the computer runs as Free, so the time meter says Free's month, not a size.
        getUsage = () => reply({ enabled: true, version: 1, asOf: END, session: {}, storage: {}, period: { unit: 'standard_seconds', remainingStandardSeconds: 27000,
            allowanceStandardSeconds: 28800, currentSize: 'std-2', currentWeight: 1, remainingHoursAtCurrent: 7, equivalents: [{ size: 'std-2', weight: 1, hours: 7 }] } });
        await refresh();
        contains('[data-role="meter-time"]', 'About 7 of 8 hours left this month');
        assert.doesNotMatch(q('[data-role="meter-time"]').textContent, /left at 2 vCPU|Same as/);
        getUsage = () => failure('unavailable');
        assert.doesNotMatch(text(), /ap-south-1|mumbai|have been moved|were moved|files moved/i);
        // Unknown or missing standing: no standing banner.
        for ( const standing of [undefined, 'moved'] ) {
            summary = summaryV3('free'); summary.computer.standing = standing; await refresh();
            for ( const role of ['payment-grace', 'plan-ending', 'files-held'] ) has(`[data-role="${role}"]`, false);
        }
        // The dead branch: past_due without a payment issue never painted its own banner (summary.ts always sets one).
        summary = summaryV3(); Object.assign(summary.plan, { status: 'past_due', paymentIssue: null }); await refresh();
        has('[data-role="payment-banner"]', false);
        // Billing and Settings → Computer say the same thing (two copies of one function, pinned here).
        const shapes = [
            ['grace', { plan: { graceEndsAt: GRACE }, computer: { filesOn: 'aws' } }], ['grace', { plan: {}, computer: { filesOn: 'cloudflare' } }],
            ['plan_ending', { plan: { name: 'Standard', planEndsAt: ENDS }, computer: { filesOn: 'aws' } }],
            ['plan_ending', { plan: { name: 'Premium', cancelsAt: ENDS }, computer: { filesOn: 'cloudflare' } }], ['plan_ending', { plan: {}, computer: {} }],
            ['files_on_aws', { plan: {}, computer: {} }], ['paid', { plan: {}, computer: {} }], ['free', { plan: {}, computer: {} }],
            ['files_on_aws', { plan: {}, computer: { awsSize: { size: 'cmp-8', vcpu: 8, memoryGiB: 32 } } }],
            ['files_on_aws', { plan: {}, computer: { awsSize: { size: 'std-2', vcpu: 2, memoryGiB: 8 } } }],
            ['files_on_aws', { plan: {}, computer: { awsSize: { size: 'cmp-4', vcpu: 'four' } } }],
        ];
        for ( const [standing, data] of shapes ) {
            const copy = window.billing.standingCopy(standing, data);
            assert.equal(window.computersTab.standingCopy(standing, data), copy, `${standing} copy agrees across tabs`);
            assert.doesNotMatch(copy, banned); assert.doesNotMatch(copy, honestyBans); assert.doesNotMatch(copy, /ap-south-1|mumbai/i);
        }
        pass('Round 4 standing banners: grace, plan ending, files held on AWS; unknown standing unchanged; copy pinned across tabs');
    }
    summary = summaryV3(); history = [invoice()]; getHistory = () => failure('private invoice failure'); await refresh();
    contains('[data-role="invoice-rows"]', "Couldn't load invoices.");
    getHistory = () => reply(history); click(q('[data-role="invoice-rows"] [data-action="retry"]')); await settle();
    has('[data-role="invoice-rows"] a');
    for ( const sku of ['standard_monthly_v3', 'premium_monthly_v3'] ) {
        summary = summaryV3('free'); await open({ ...context, initialTab: 'billing', openUpgrade: sku });
        assert.equal(sheets.at(-1).sku, sku); await closeSheet();
    }
    summary = summaryV3(); await open({ ...context, initialTab: 'billing', openUpgrade: 'premium_monthly_v3' });
    assert.equal(sheets.at(-1).kind, 'upgrade'); await closeSheet();
    summary = summaryV3(); summary.plan.name = '<img src=x onerror=alert(1)>'; await refresh();
    has('[data-role="plan-card"] img', false); contains('[data-role="plan-card"]', '<img');
    for ( const key of Object.keys(summary.actions) ) summary.actions[key] = false;
    await refresh(); assert.equal(qa('[data-role="plan-actions"] button').length, 0); has('[data-action="portal"]', false); has('[data-action="cancel"]', false);
    pass('v3 DTO-only plans, fair-use states, cancellation/payment, invoices, actions, deep links, escaping and failure recovery');

    const packs = [
        { sku: 'ai_pack_10_v1', aiCredits: 2000, totalCents: 1000, currency: 'usd' },
        { sku: 'ai_pack_25_v1', aiCredits: 5000, totalCents: 2500, currency: 'usd' },
    ];
    summary = summaryV3(); summary.ai.balance = 4000; await refresh();
    contains('#ai-credits h4', 'AI credits');
    assert.equal(q('#ai-credits .ezil-billing-meter-value').textContent, '4,000 left');
    // ADV-1: no breakdown from the server, so no invented "plan + extra" split.
    assert.doesNotMatch(q('#ai-credits').textContent, /from your plan|3,800 extra/);
    // Round 6 (R1-10): above the grant there is no denominator, so no bar (it was full by construction).
    has('#ai-credits [role="meter"]', false);
    has('#ai-credits button', false); has('[data-role="ai-topup"]', false);
    summary.catalog.packs = packs; await refresh(); has('[data-role="ai-topup"]', false);
    summary.actions.topup = false; await refresh(); has('[data-role="ai-topup"]', false);
    summary.actions.topup = true; summary.catalog.packs = []; await refresh(); has('[data-role="ai-topup"]', false);
    delete summary.catalog.packs; await refresh(); has('[data-role="ai-topup"]', false);
    summary.catalog.packs = packs;
    for ( const [balance, state, label, tone] of [[0, 'exhausted', '0 of 200 left', 'danger'], [17, 'low', '17 of 200 left', 'warn'], [null, 'unavailable', '—', 'ok']] ) {
        summary.ai.balance = balance; summary.ai.state = state; await refresh();
        contains('#ai-credits .ezil-billing-meter-value', label);
        assert.equal(q('#ai-credits').classList.contains(`is-${tone}`), true);
        assert.equal(qa('[data-role="ai-topup"] [data-action="topup"]').length, 2);
        assert.equal(q('[data-role="ai-topup"]').open, false, 'the top-up is a closed disclosure');
        if ( balance === null ) { has('#ai-credits [role="meter"]', false); assert.doesNotMatch(q('#ai-credits').textContent, /1\.000001|Not available|Unavailable/); }
    }
    assert.deepEqual(qa('[data-role="ai-topup"] [data-action="topup"]').map(button => button.textContent), ['Add 2,000 credits — $10', 'Add 5,000 credits — $25']);
    for ( const pack of packs ) {
        const button = q(`[data-role="ai-topup"] [data-sku="${pack.sku}"]`);
        assert.equal(button.classList.contains('ezil-settings-btn-primary'), false);
        const before = sheets.length;
        click(button); click(button);
        assert.equal(sheets.length, before + 1);
        assert.equal(sheets.at(-1).sku, pack.sku);
        assert.deepEqual(sheets.at(-1).pack, pack);
        assert.equal(sheets.at(-1).offer, undefined);
        const reads = count();
        sheets.at(-1).onDone(); await closeSheet();
        assert.equal(count(), reads + 1, 'finishing a top-up refreshes Billing');
    }
    packs[0].totalCents = 1234; await refresh(); contains('[data-role="ai-topup"] button', 'Add 2,000 credits — $12.34');
    const beforeInvalid = sheets.length;
    q('[data-role="ai-topup"] button').dataset.sku = 'unknown_pack'; click(q('[data-role="ai-topup"] button'));
    assert.equal(sheets.length, beforeInvalid, 'unknown packs cannot open a checkout');
    const staleButton = q('[data-role="ai-topup"] button'); staleButton.dataset.sku = packs[0].sku;
    summary.actions.topup = false; await refresh(); q('#ai-credits').append(staleButton); click(staleButton);
    assert.equal(sheets.length, beforeInvalid, 'top-up actions are checked again at click time');
    // Premium with credits running low: the page's one primary opens the top-up disclosure.
    summary = summaryV3('premium'); summary.ai.state = 'low'; summary.actions.topup = true; summary.catalog.packs = packs; await refresh();
    assert.deepEqual(qa('[data-pane="billing"] .ezil-settings-btn-primary').map(button => button.textContent), ['Add AI credits']);
    click(q('[data-action="open-topup"]')); await settle();
    assert.equal(q('[data-role="ai-topup"]').open, true);
    assert.equal(window.document.activeElement, q('[data-role="ai-topup"] summary'));
    // needs_ezil_id (D1): the waiting credits and the EZiL ID link; no top-up and no "Unavailable".
    summary = summaryV3('free'); Object.assign(summary.ai, { enrollment: 'needs_ezil_id', waiting: { credits: 100 }, balance: null, state: 'unavailable' });
    summary.actions.ezilId = '/login?method=ezil-id'; summary.actions.topup = true; summary.catalog.packs = packs; await refresh();
    contains('#ai-credits', '100 credits waiting');
    contains('#ai-credits', 'AI credits activate when you sign in with EZiL ID. Use the same email as this account.');
    assert.equal(q('#ai-credits a[data-action="ezil-id"]').getAttribute('href'), '/login?method=ezil-id');
    has('[data-role="ai-topup"]', false);
    assert.doesNotMatch(text(), /Unavailable|Not available/);
    pass('AI credit row: whole numbers, above-grant split, server states, top-up disclosure, checkout gating, Add AI credits primary and EZiL ID');

    let creditsScrolled = 0;
    window.HTMLElement.prototype.scrollIntoView = function () { if ( this.id === 'ai-credits' ) creditsScrolled++; };
    window.history.replaceState(null, '', '/os?settings=billing&section=ai-credits&view=files');
    summary = summaryV3(); getSummary = () => failure('temporary'); await open();
    assert.equal(creditsScrolled, 0);
    window.history.replaceState(null, '', '/os?view=files');
    getSummary = () => reply(summary); click(q('[data-action="retry"]')); await settle();
    assert.equal(creditsScrolled, 1);
    assert.equal(window.document.activeElement, q('#ai-credits h4'));
    assert.equal(q('#ai-credits h4').tabIndex, -1);
    await refresh(); assert.equal(creditsScrolled, 1, 'refresh does not steal focus');
    for ( const search of ['?settings=account&section=ai-credits', '?settings=billing&section=unknown', ''] ) {
        window.history.replaceState(null, '', `/os${search}`); await open();
        assert.equal(creditsScrolled, 1, 'only the Billing AI credits deep link focuses the card');
    }
    pass('AI credits deep-link heading focus survives URL cleanup and a failed summary without refocusing');
    // Round 5 (D6): no operator internals on the user surface, in any AI state.
    summary = summaryV3(); await refresh();
    for ( const role of ['ai-usage', 'ai-limits', 'ai-recent', 'ai-spending'] ) has(`[data-role="${role}"]`, false);
    assert.doesNotMatch(text(), /service ceiling|Held for requests|Requests per minute|Tokens per minute|Recent AI requests|Commitments|charged: /i);
    for ( const state of ['paused_operations', 'paused_reconciliation', 'paused_policy', 'unavailable'] ) {
        summary.ai.spendingState = state; await refresh();
        assert.doesNotMatch(text(), /spending is|paused by operations|reconciled/i);
    }
    // Stale summaries never overwrite a newer one (whole credits on the AI row).
    const old = summaryV3(); old.ai.balance = 123;
    let releaseOld;
    getSummary = () => new Promise(resolve => { releaseOld = resolve; });
    click(q('[data-tab="account"]')); click(q('[data-tab="billing"]')); await settle();
    click(q('[data-tab="account"]'));
    summary = summaryV3(); summary.ai.balance = 7; getSummary = () => reply(summary);
    click(q('[data-tab="billing"]')); await settle();
    releaseOld(reply(old)); await settle();
    contains('[data-role="meter-ai"]', '7 of 200 left');
    assert.doesNotMatch(q('[data-role="meter-ai"]').textContent, /123 of 200/);
    let releaseClosed;
    getSummary = () => new Promise(resolve => { releaseClosed = resolve; });
    click(q('[data-tab="account"]')); click(q('[data-tab="billing"]')); await settle();
    await window.$(q('.window[data-app="settings"]')).close(); await settle();
    getSummary = () => reply(summary); await open(); releaseClosed(reply(old)); await settle();
    contains('[data-role="meter-ai"]', '7 of 200 left');
    pass('no operator AI internals in any spending state; stale and closed-window summaries cannot repaint');
    summary = v2(); history = []; await refresh();

    const billingRequests = () => calls.filter(call => call.url.includes('/billing.')).length;
    for ( const ctx of [
        { payload: { user: payload.user }, initialTab: 'billing' },
        { payload: { ...payload, features: { billing: false } }, initialTab: 'billing' },
        { payload: { ...payload, features: { billing: 'true' } }, initialTab: 'billing' },
        { payload: { features: { billing: true } }, initialTab: 'billing' },
        { ...context, desktopState: { provider: 'native-macos' }, initialTab: 'billing' },
    ] ) {
        const before = billingRequests(); await open(ctx);
        has('[data-tab="billing"]', false); assert.equal(active(), ctx.desktopState?.provider !== 'native-macos' && ctx.payload?.user?.id ? 'account' : 'computers'); assert.equal(billingRequests(), before);
    }
    await open({ ...context, initialTab: 'missing' }); assert.equal(active(), 'account'); has('[data-tab="billing"]');
    const before = count(); click(q('[data-tab="billing"]')); await settle(); assert.equal(count(), before + 1);
    click(q('[data-tab="billing"]')); await settle(); assert.equal(count(), before + 1);
    await open();
    mutation = () => reply({ url: 'https://billing.example.test/reopened' });
    click(q('[data-action="portal"]')); await settle(); assert.equal(opened.at(-1)[0], 'https://billing.example.test/reopened');
    audit();
    assert.ok(count() > 0); assert.deepEqual(errors, []);
    pass('feature flag/native/auth gates, lazy loading and reopened-window bindings');
    console.log(`PASS Billing v2: ${groups} groups; ${audited} whole-pane copy/accessibility audits; 0 window errors`);
} finally {
    dom.window.close();
}
