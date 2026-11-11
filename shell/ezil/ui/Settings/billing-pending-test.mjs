// Source-rendered Billing regressions: stored grant delivery is not an exhausted wallet.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { summaryV3 } from './billing-v3-fixtures.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [path.resolve(here, '../../../../app')] }));
const source = (await build({ stdin: { contents: "import { summaryV3Html } from './tabs/billing.js'; window.renderBilling = summaryV3Html;", resolveDir: here },
    bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent' })).outputFiles[0].text;
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://example.test/os' });
const { window } = dom;
window.html_encode = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.eval(source);
const account = remaining => ({ userId: 'u', state: remaining === '0' ? 'exhausted' : remaining === null ? 'unavailable' : 'ok',
    asOf: '2026-11-11T12:00:00Z', totalMicro: remaining === null ? null : '100000000', remainingMicro: remaining,
    heldMicro: remaining === null ? null : '0', usedMicro: null, labelled: false, grants: [] });
function render({ remaining = '0', delivery = { credits: 100 }, enrollment = 'enrolled', tier = 'premium', lastAccount = null } = {}) {
    const summary = summaryV3(tier);
    Object.assign(summary.ai, { state: 'exhausted', balance: remaining === null ? null : Number(remaining) / 1000000,
        account: account(remaining), enrollment, delivering: delivery });
    summary.actions.topup = true;
    summary.catalog.packs = [{ sku: 'ai_pack_10_v1', aiCredits: 2000, totalCents: 1000, currency: 'usd' }];
    window.document.body.innerHTML = window.renderBilling(summary, null, { userId: 'u', lastAccount });
    const meter = window.document.querySelector('[data-role="meter-ai"]');
    return { meter, text: meter.textContent, value: meter.querySelector('.ezil-billing-meter-value').textContent,
        primary: window.document.querySelector('[data-role="plan-actions"] [data-action="open-topup"]') };
}
let groups = 0;
function check(label, work) { work(); console.log(`PASS Billing pending: ${label}`); groups++; }
try {
    check('pending zero is neither exhausted nor a purchase prompt', () => {
        for (const tier of ['free', 'standard', 'premium']) {
            const result = render({ tier });
            assert.equal(result.value, 'Adding your AI credits…');
            assert.match(result.text, /100 credits are being added to your account\./);
            assert.doesNotMatch(result.text, /No credits left|0 credits left|Remaining 0|Used 0/);
            assert.equal(result.meter.classList.contains('is-danger'), false);
            assert.equal(result.meter.querySelector('[role="meter"]'), null);
            assert.equal(result.meter.querySelector('[data-action="topup"]'), null);
            assert.equal(result.primary, null);
        }
    });
    check('unreadable balance with trusted pending receipt stays pending without a figure', () => {
        const result = render({ remaining: null });
        assert.equal(result.value, 'Adding your AI credits…');
        assert.match(result.text, /100 credits are being added/);
        assert.doesNotMatch(result.text, /No credits left|\b0 credits|100 credits left/);
        assert.equal(result.primary, null);
    });
    check('genuine zero and malformed pending evidence remain exhausted', () => {
        for (const delivery of [undefined, null, {}, { credits: 0 }, { credits: -1 }, { credits: 1.5 }, { credits: '100' }]) {
            const result = render({ delivery: delivery === undefined ? null : delivery });
            assert.equal(result.value, '0 credits left of 100');
            assert.match(result.text, /No credits left/);
            assert.doesNotMatch(result.text, /being added/);
            assert.ok(result.meter.querySelector('[data-action="topup"]'));
            assert.ok(result.primary);
        }
    });
    check('unreadable balance alone never invents zero or pending credits', () => {
        const result = render({ remaining: null, delivery: null });
        assert.equal(result.value, '—');
        assert.match(result.text, /couldn't read your credits/);
        assert.doesNotMatch(result.text, /No credits left|\b0 credits|being added/);
    });
    check('a live wallet stays exact internally and whole floored when another grant is pending', () => {
        const result = render({ remaining: '99999999' });
        assert.equal(result.value, '99 credits left of 100');
        assert.match(result.text, /100 credits are being added/);
        assert.doesNotMatch(result.text, /99\.999|199|No credits left/);
        assert.equal(result.primary, null);
    });
    check('confirmed delivery removes pending copy without adding to balance', () => {
        const result = render({ remaining: '100000000', delivery: null });
        assert.equal(result.value, '100 credits left of 100');
        assert.doesNotMatch(result.text, /being added|200/);
    });
    check('enrollment states keep their existing activation message', () => {
        for (const enrollment of ['activating', 'needs_ezil_id']) {
            const result = render({ enrollment });
            assert.doesNotMatch(result.text, /being added|No credits left|0 credits/);
            assert.equal(result.primary, null);
        }
    });
    check('kept zero still shows stale timing with trusted delivery pending', () => {
        const result = render({ remaining: null, lastAccount: account('0') });
        assert.equal(result.value, 'Adding your AI credits…');
        assert.match(result.text, /Couldn't refresh · as of/);
        assert.match(result.text, /100 credits are being added/);
        assert.doesNotMatch(result.text, /No credits left|Remaining 0/);
    });
    console.log(`${groups} Billing pending groups passed`);
} finally { window.close(); }
