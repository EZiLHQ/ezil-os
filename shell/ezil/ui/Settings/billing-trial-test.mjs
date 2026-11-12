import { v3CopyForAudit, honestyBans } from './billing-copy-test-helpers.mjs';
// billing-trial-test.mjs — EZiL-authored. The Standard one-calendar-month trial (request
// standard-trial-01b28d18-20261105-v1) on the shell's surfaces, from the real modules bundled from source:
//   - the Billing tab in the server's states (an eligible offer, trialing, ending, payment pending, payment failed)
//     and ineligible; the first charge is a date, and the renewal preview an hour later is never a second charge;
//   - the checkout sheet's trial mode: one activation → quote → Checkout echoes the exact end;
//     month-end and leap-day quotes; a stale quote re-quoted; refusals never fall through to a paid checkout;
//   - the trial variants of the cancel sheet, the plan picker, the session-end sheet and the top-up recovery choice;
//   - Usage: no new meter, the authoritative balance with plan-labelled credits.
// Node-only (jsdom). Run: node shell/ezil/ui/Settings/billing-trial-test.mjs
import { summaryV3, trialSummaryV3, TRIAL_END } from './billing-v3-fixtures.mjs';
import { usage as usageSample } from './usage-fixtures.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

// The plan card and offer use the viewer's zone (no option): pin it, and pick one whose day differs from UTC's.
process.env.TZ = 'America/Los_Angeles';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [path.resolve(here, '../../../../app')] }));
const source = (await build({
    stdin: { contents: `
        import { summaryV3Html } from './tabs/billing.js';
        import { usageHtml } from './tabs/usage.js';
        import { openUpgradeSheet } from './upgrade-sheet.js';
        import { openCancelSheet, openPlanPickerSheet, openSessionEndSheet } from './billing-sheets.js';
        import { topupUpgrade } from './topup-sheet.js';
        import * as format from './billing-format.js';
        window.api = { summaryV3Html, usageHtml, openUpgradeSheet, openCancelSheet, openPlanPickerSheet, openSessionEndSheet, topupUpgrade, format };`, resolveDir: here },
    bundle: true, write: false, format: 'iife', target: 'es2022',
})).outputFiles[0].text;
const banned = /faster|instant|unlimited|priority|gpu|heavy\s+use|gpt|claude|gemini|llama|memory\s+is\s+kept|memory\s+survives|processes\s+keep\s+running|ai\s+included|includes\s+ai|compute\s+hours|standard-hour/i;
// A free month is never a payment: none of these may appear anywhere a trial is shown.
const paidWords = /payment received|\bpaid\b|No payment is required|Renews on|starts after payment|Total shown in the payment form|Renews monthly/i;
const settle = async () => { for ( let i = 0; i < 20; i++ ) await Promise.resolve(); };
const clean = node => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** Plain data from the page's realm (jsdom objects are not deep-strict-equal to Node's). */
const plain = value => JSON.parse(JSON.stringify(value));

function harness () {
    const dom = new JSDOM('<!doctype html><body><button id="opener">Open</button><main id="container"></main></body>', {
        runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/os',
    });
    const { window } = dom;
    window.html_encode = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let time = 0, nextId = 0;
    const timers = new Map();
    window.setTimeout = (callback, delay) => { const id = ++nextId; timers.set(id, { at: time + delay, callback }); return id; };
    window.clearTimeout = id => timers.delete(id);
    const tick = async ms => {
        const end = time + ms;
        await settle();
        for (;;) {
            const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            if ( ! next || next[1].at > end ) break;
            time = next[1].at;
            timers.delete(next[0]);
            next[1].callback();
            await settle();
        }
        time = end;
        await settle();
    };
    window.eval(source);
    const rendered = [];
    const observer = new window.MutationObserver(() => {
        const sheet = window.document.querySelector('[data-role="upgrade-sheet"], [data-role="billing-sheet"]');
        if ( sheet ) rendered.push(sheet.textContent);
    });
    observer.observe(window.document.body, { childList: true, subtree: true, characterData: true });
    const calls = [], opens = [];
    window.open = (...args) => { opens.push(args); return null; };
    let complete, mounted = 0, done = 0;
    const h = {
        window, document: window.document, api: window.api, calls, opens, rendered, tick,
        q: selector => window.document.querySelector(selector),
        qa: selector => [...window.document.querySelectorAll(selector)],
        text: () => window.document.querySelector('[data-role="upgrade-sheet"]')?.textContent ?? '',
        click: selector => { const el = window.document.querySelector(selector); assert.ok(el, `click target exists: ${selector}`); el.click(); },
        get mounted () { return mounted; }, get done () { return done; },
        complete: () => complete(),
        count: method => calls.filter(call => call.method === method).length,
        // Replies: a function per procedure, returning the shell client's envelope.
        replies: {},
        fragment: html => { const el = window.document.createElement('div'); el.innerHTML = html; return el; },
    };
    h.trpc = {
        mutate: async (method, input) => { calls.push({ method, input }); return h.replies[method]?.(input) ?? { ok: false, message: 'unexpected' }; },
        query: async (method, input) => { calls.push({ method, input }); return h.replies[method]?.(input) ?? { ok: false, message: 'unexpected' }; },
    };
    const instance = {
        mount: selector => { mounted++; const frame = window.document.createElement('iframe'); frame.title = 'Secure payment form'; h.q(selector).append(frame); },
        destroy: () => {},
    };
    h.loadStripe = async () => ({ initEmbeddedCheckout: async ({ onComplete }) => { complete = onComplete; return instance; } });
    h.openTrial = (options = {}) => {
        const offer = summaryV3('free').catalog.offers.find(item => item.sku === 'standard_monthly_v3');
        h.handle = window.api.openUpgradeSheet({ container: h.q('#container'), sku: offer.sku, offer, trpc: h.trpc, trial: true,
            onDone: () => { done++; }, onClose: () => {}, loadStripe: h.loadStripe, now: () => time, ...options });
        return h.handle;
    };
    h.cleanup = () => { h.handle?.close?.(); observer.disconnect(); window.close(); };
    h.q('#opener').focus();
    return h;
}

const ok = data => ({ ok: true, data });
const fail = message => ({ ok: false, code: 'CONFLICT', message });
/** A `billing.quoteTrial` reply: the server quoted at `quotedAt` and fixed `trialEndsAt` (also the first charge). */
const quote = (trialEndsAt, quotedAt = '2027-01-31T03:00:00Z') => ok({ sku: 'standard_monthly_v3', todayCents: 0, trialEndsAt, firstChargeAt: trialEndsAt,
    amountCents: 2000, currency: 'usd', interval: 'month', quoteExpiresAt: new Date(Date.parse(quotedAt) + 30 * 60 * 1000).toISOString().replace('.000', '') });
const embedded = ok({ mode: 'embedded', sessionId: 'cs_test_trial', clientSecret: 'secret', publishableKey: 'pk_test' });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Billing tab: the four states and ineligible ───────────────────────────────

test('offer: Free with an eligible offer says "Start your free month", $0 today, then $20/month from the date (viewer\'s zone)', async h => {
    // 03:30 UTC on Dec 5 is Dec 4 in Los Angeles: the card names the viewer's day, never UTC's.
    const summary = trialSummaryV3('offer', { endsAt: '2026-12-05T03:30:00Z' });
    const el = h.fragment(h.api.summaryV3Html(summary));
    const primaries = [...el.querySelectorAll('.ezil-settings-btn-primary')];
    assert.deepEqual(primaries.map(clean), ['Start your free month']);
    assert.equal(primaries[0].dataset.action, 'trial');
    const card = el.querySelector('[data-role="plan-offer"][data-sku="standard_monthly_v3"]');
    const terms = clean(card.querySelector('[data-role="trial-offer"]'));
    assert.equal(terms, '$0 today $20/month from Dec 4, 2026 One calendar month. Card required. Cancel before Dec 4, 2026 and you pay nothing.');
    assert.equal(clean(card.querySelector('[data-action="trial"]')), 'Start your free month');
    assert.ok(! card.querySelector('[data-action="trial"]').classList.contains('ezil-settings-btn-primary'), 'the card CTA is secondary');
    assert.equal(card.querySelector('[data-action="checkout"]'), null, 'the free month replaces the paid Standard checkout');
    // Premium never shows a trial.
    const premium = el.querySelector('[data-role="plan-offer"][data-sku="premium_monthly_v3"]');
    assert.doesNotMatch(clean(premium), /free month|\$0 today|trial/i);
    assert.equal(clean(premium.querySelector('[data-action="checkout"]')), 'Choose Premium');
    // No checkout (billing off) or no offer key: the ordinary Standard checkout, unchanged.
    for ( const change of [s => { s.actions.checkout = false; }, s => { delete s.trialOffer; }, s => { s.trialOffer = null; },
        s => { s.trialOffer.sku = 'premium_monthly_v3'; }, s => { s.trialOffer.endsAt = 'soon'; }] ) {
        const s = trialSummaryV3('offer'); change(s);
        const html = h.api.summaryV3Html(s);
        assert.doesNotMatch(html, /free month|data-action="trial"/i);
    }
    return el;
});

test('ineligible: no trial CTA, the Standard checkout stays, plain eligibility reasons without a second trial', async h => {
    for ( const [reason, line] of [['trial_used', "You've already used your free month."], ['paid_before', 'The free month is for accounts without an earlier paid plan.'],
        ['email_unverified', 'Verify your email to start a free month.'], ['not_free', 'The free month is for accounts on the Free plan.'], ['operator_plan', 'Your account already has access assigned by EZiL.'], ['no_email', 'Add and verify an email address to start a free month.']] ) {
        const el = h.fragment(h.api.summaryV3Html(trialSummaryV3('ineligible', { reason })));
        assert.deepEqual([...el.querySelectorAll('.ezil-settings-btn-primary')].map(clean), ['Upgrade to Standard'], reason);
        assert.equal(el.querySelector('[data-action="trial"]'), null, reason);
        const card = el.querySelector('[data-role="plan-offer"][data-sku="standard_monthly_v3"]');
        assert.equal(clean(card.querySelector('[data-action="checkout"]')), 'Choose Standard', reason);
        assert.equal(clean(card.querySelector('[data-role="trial-ineligible"]')) || null, line, reason);
        assert.equal(el.querySelectorAll('[data-role="trial-ineligible"]').length, line ? 1 : 0, `${reason}: one quiet line at most`);
    }
});

test('coupon source is authoritative: unlocked in Billing, prior eligibility still refuses, query hints cannot grant a trial', async h => {
    const offered = trialSummaryV3('offer');
    offered.trialOffer.source = 'sponsor'; offered.trialOffer.partnerId = 'example';
    const unlocked = h.fragment(h.api.summaryV3Html(offered));
    assert.match(clean(unlocked.querySelector('[data-role="coupon-offer"]')), /Coupon offer unlocked/);
    assert.equal(unlocked.querySelectorAll('[data-role="plan-actions"] [data-action="trial"]').length, 1);
    const used = trialSummaryV3('ineligible', { reason: 'trial_used' }); used.trialOffer.source = 'sponsor';
    const refused = h.fragment(h.api.summaryV3Html(used));
    assert.match(clean(refused.querySelector('[data-role="coupon-offer"]')), /already used your free month/);
    assert.equal(refused.querySelector('[data-action="trial"]'), null);
    for (const [plan, reason] of [['standard', 'not_free'], ['standard', 'trial_used']]) {
        const paid = summaryV3(plan);
        paid.actions.checkout = false;
        paid.trialOffer = { source: 'sponsor', eligible: false, reason };
        const el = h.fragment(h.api.summaryV3Html(paid));
        assert.match(clean(el.querySelector('[data-role="coupon-offer"]')), reason === 'not_free' ? /accounts on the Free plan/ : /already used your free month/);
        assert.equal(el.querySelector('[data-action="trial"]'), null);
    }
    for (const hint of ['unavailable','identity_required']) {
        const plain = summaryV3('free');
        const el = h.fragment(h.api.summaryV3Html(plain, null, { couponEntry: hint }));
        assert.ok(el.querySelector('[data-role="coupon-entry"]'));
        assert.equal(el.querySelector('[data-action="trial"]'), null);
        assert.doesNotMatch(clean(el), /Coupon offer unlocked/);
    }
    assert.equal(h.fragment(h.api.summaryV3Html(summaryV3('free'), null, { couponEntry: '<script>' })).querySelector('[data-role="coupon-entry"]'), null);
});

test('trialing: "Free trial · Standard", free until the end, first charge $20.00 from the date, cancel before then; no upgrade, no renewal line', async h => {
    // 07:30 UTC on 5 Dec is 11:30 PM on 4 Dec in Los Angeles; the renewal preview (Stripe's collection, an hour later)
    // falls on 5 Dec there and must never show up as another date or a second charge.
    const summary = trialSummaryV3('trialing', { endsAt: '2026-12-05T07:30:00Z' });
    assert.equal(summary.plan.renewal.at, '2026-12-05T08:30:00Z');
    const el = h.fragment(h.api.summaryV3Html(summary));
    const card = el.querySelector('[data-role="plan-card"]');
    assert.equal(card.dataset.trial, 'trialing');
    assert.equal(clean(card.querySelector('h4')), 'Free trial · Standard');
    const until = card.querySelector('[data-role="trial-until"]');
    assert.equal(clean(until), 'Free until Dec 4, 2026 at 11:30 PM Pacific Standard Time');
    assert.equal(until.querySelector('time').getAttribute('datetime'), '2026-12-05T07:30:00Z');
    assert.match(clean(card), /First charge \$20\.00 from Dec 4, 2026\./);
    assert.doesNotMatch(clean(el), /Dec 5|12:30|on Dec 4/, 'one first charge, by date, never the collection time');
    assert.match(clean(card), /Cancel before then and you pay nothing\./);
    assert.doesNotMatch(clean(el), /Renews on|Upgrade to Premium|\$20 \/ month for/);
    assert.equal(el.querySelector('[data-action="upgrade"]'), null, 'a trial is never upgraded');
    assert.equal(el.querySelectorAll('.ezil-settings-btn-primary').length, 0);
    assert.equal(clean(el.querySelector('.ezil-billing-v3-footer [data-action="cancel"]')), 'Cancel free month');
    assert.equal(el.querySelector('.ezil-billing-banner'), null);
    return el;
});

test('ending: "Your free month ends on <date>. You won\'t be charged. Standard stays available until then" with Resume', async h => {
    const summary = trialSummaryV3('ending');
    const el = h.fragment(h.api.summaryV3Html(summary));
    const banner = el.querySelector('[data-role="trial-ending"]');
    assert.ok(banner, 'the trial banner replaces the plan-ending banner');
    assert.equal(el.querySelector('[data-role="plan-ending"], [data-role="cancels-banner"]'), null);
    assert.equal(clean(banner.querySelector('.ezil-billing-banner-title')), 'Your free month ends on Dec 5, 2026.');
    assert.match(clean(banner), /You won't be charged\. Standard stays available until then\./);
    assert.match(clean(banner), /If you resume, \$20\.00 is charged from Dec 5, 2026, then every month until you cancel\./);
    assert.deepEqual([...el.querySelectorAll('.ezil-settings-btn-primary')].map(button => [clean(button), button.dataset.action]), [['Resume plan', 'resume']]);
    assert.equal(clean(el.querySelector('[data-role="plan-card"] h4')), 'Free trial · Standard');
    assert.match(clean(el.querySelector('[data-role="plan-card"]')), /Free until Dec 5, 2026 at 6:30 AM Pacific Standard Time.*Cancelled · you won't be charged\./);
    assert.doesNotMatch(clean(el), /First charge|moved to your Free computer|Renews on/);
    // No Resume action from the server: no button and no resume promise.
    const locked = trialSummaryV3('ending'); locked.actions.cancel = false;
    const without = h.fragment(h.api.summaryV3Html(locked));
    assert.equal(without.querySelector('[data-action="resume"]'), null);
    assert.doesNotMatch(clean(without), /If you resume/);
    return el;
});

test('payment_failed: the free month ended and $20.00 did not go through; Standard paused, files kept; portal only; never grace copy', async h => {
    for ( const standing of ['files_on_aws', 'free', 'grace'] ) {
        const summary = trialSummaryV3('payment_failed', { standing });
        const el = h.fragment(h.api.summaryV3Html(summary));
        const banner = el.querySelector('[data-role="payment-banner"]');
        assert.equal(clean(banner.querySelector('.ezil-billing-banner-title')), "Your free month ended and the $20.00 payment didn't go through.", standing);
        assert.match(clean(banner), /Standard is paused until a payment succeeds; your files are kept\./);
        assert.deepEqual([...el.querySelectorAll('.ezil-settings-btn-primary')].map(button => [clean(button), button.dataset.action]), [['Update payment method', 'portal']]);
        assert.equal(el.querySelector('[data-role="payment-grace"]'), null, `${standing}: never the grace banner`);
        assert.doesNotMatch(clean(el), /update it by|to keep Standard|keep your (plan|AWS computer)|grace|upgrade for sessions/i, standing);
        assert.equal(clean(el.querySelector('[data-role="plan-status"]')), 'Paused');
        assert.equal(el.querySelector('[data-action="trial"], [data-action="checkout"], [data-action="upgrade"]'), null);
    }
    const noPortal = trialSummaryV3('payment_failed'); noPortal.actions.portal = false;
    assert.equal(h.fragment(h.api.summaryV3Html(noPortal)).querySelector('[data-role="payment-banner"] button'), null);
    // A bank confirmation outranks it: the existing requires_action banner is the actionable one.
    const action = trialSummaryV3('payment_failed'); action.plan.paymentIssue = 'requires_action';
    assert.match(clean(h.fragment(h.api.summaryV3Html(action)).querySelector('[data-role="payment-banner"]')), /Your bank needs you to confirm a payment/);
    return h.fragment(h.api.summaryV3Html(trialSummaryV3('payment_failed')));
});

test('payment_pending: "Your free month has ended. We\'re collecting your first $20.00 payment…"; never active; portal; the server\'s cancel', async h => {
    for ( const standing of ['free', 'files_on_aws'] ) {
        const summary = trialSummaryV3('payment_pending', { standing });
        const el = h.fragment(h.api.summaryV3Html(summary));
        const banner = el.querySelector('[data-role="trial-payment-pending"]');
        assert.ok(banner, standing);
        assert.equal([...banner.querySelectorAll('div > p')].map(clean).join(' '),
            "Your free month has ended. We're collecting your first $20.00 payment; Standard resumes as soon as it goes through. Your files are kept.");
        assert.equal(clean(banner.querySelector('[data-action="portal"]')), 'Update payment method');
        // Nothing has failed yet: no alarm and no primary anywhere on the page.
        assert.ok(banner.classList.contains('is-warn') && banner.getAttribute('role') === 'status');
        assert.equal(el.querySelectorAll('.ezil-settings-btn-primary').length, 0, standing);
        const card = el.querySelector('[data-role="plan-card"]');
        assert.equal(card.dataset.trial, 'payment_pending');
        assert.equal(clean(card.querySelector('h4')), 'Standard');
        const chip = card.querySelector('[data-role="plan-status"]');
        assert.deepEqual([clean(chip), chip.dataset.status], ['Payment pending', 'payment_pending']);
        // Never "active", never the trial's live lines, never the renewal preview as a charge or date.
        assert.doesNotMatch(clean(el), /\bActive\b|Free trial|Free until|First charge|Renews|Cancel free month|grace|upgrade for sessions|didn't go through/i, standing);
        assert.equal(el.querySelector('[data-action="upgrade"], [data-action="trial"], [data-action="checkout"], [data-action="resume"]'), null, standing);
        // Review U2: the server's cancel (actions.cancel) is offered; its sheet says what it does and does not do.
        assert.equal(clean(el.querySelector('.ezil-billing-v3-footer [data-action="cancel"]')), 'Cancel plan', standing);
        // Standard waits: the computer is the one the server rates as Free, never Standard's computer.
        assert.match(clean(el.querySelector('[data-role="your-computer"]')), standing === 'free'
            ? /2 vCPU · 6 GB memory · files saved between sessions · Cloudflare/ : /2 vCPU · 8 GB memory · 50 GB disk · AWS \(India\)/, standing);
        assert.doesNotMatch(clean(el.querySelector('[data-role="your-computer"]')), /Sessions? up to/i, standing);
    }
    // No cancel from the server: none offered.
    const noCancel = trialSummaryV3('payment_pending'); noCancel.actions.cancel = false;
    assert.equal(h.fragment(h.api.summaryV3Html(noCancel)).querySelector('[data-action="cancel"]'), null);
    // Cancelled while the first payment is collected: said in the banner, with Resume; never "active" or "stays active".
    const cancelled = trialSummaryV3('payment_pending');
    Object.assign(cancelled.plan, { status: 'cancels', cancelsAt: '2027-01-05T14:30:00Z' });
    const banner = h.fragment(h.api.summaryV3Html(cancelled)).querySelector('[data-role="trial-payment-pending"]');
    assert.match(clean(banner), /You cancelled later renewals\. If that payment goes through, Standard runs until Jan 5, 2027 and then ends\./);
    assert.equal(clean(banner.querySelector('[data-action="resume"]')), 'Resume plan');
    assert.doesNotMatch(clean(banner), /stays active|\bActive\b/);
    // No portal for this account: the banner still says what happens, with no button.
    const noPortal = trialSummaryV3('payment_pending'); noPortal.actions.portal = false;
    assert.equal(h.fragment(h.api.summaryV3Html(noPortal)).querySelector('[data-role="trial-payment-pending"] button'), null);
    // The charge succeeded: plan.trial is gone and the plan is ordinary Standard again.
    const paid = trialSummaryV3('payment_pending'); delete paid.plan.trial; paid.computer.standing = 'paid';
    const after = h.fragment(h.api.summaryV3Html(paid));
    assert.equal(after.querySelector('[data-role="trial-payment-pending"]'), null);
    assert.equal(clean(after.querySelector('[data-role="plan-status"]')), 'Active');
    // It failed: the payment_failed state takes over.
    assert.ok(h.fragment(h.api.summaryV3Html(trialSummaryV3('payment_failed'))).querySelector('[data-role="payment-banner"]'));
    return h.fragment(h.api.summaryV3Html(trialSummaryV3('payment_pending')));
});

// ── The checkout sheet's trial mode ───────────────────────────────────────────

for ( const [label, trialEndsAt, timeZone, expected, day] of [
    // A quote on 31 Jan at 03:00 UTC ends on 28 Feb (2027 has no 29th) at the same UTC time; in Los Angeles that is 27 Feb.
    ['31 Jan 2027 → 28 Feb (America/Los_Angeles)', '2027-02-28T03:00:00Z', 'America/Los_Angeles', 'Saturday, February 27, 2027 at 7:00 PM Pacific Standard Time (America/Los_Angeles)', 'Feb 27, 2027'],
    ['31 Jan 2027 → 28 Feb (UTC)', '2027-02-28T03:00:00Z', 'UTC', 'Sunday, February 28, 2027 at 3:00 AM Coordinated Universal Time', 'Feb 28, 2027'],
    // Leap year: 31 Jan 2028 → 29 Feb 2028; seconds are never shown and the minute shown is not after the instant.
    ['31 Jan 2028 → 29 Feb (Asia/Tokyo)', '2028-02-29T09:15:42Z', 'Asia/Tokyo', 'Tuesday, February 29, 2028 at 6:15 PM Japan Standard Time (Asia/Tokyo)', 'Feb 29, 2028'],
] ) test(`one activation at a month end: ${label} opens Checkout with exactly the quoted end`, async h => {
    h.replies['billing.quoteTrial'] = () => quote(trialEndsAt);
    h.replies['billing.createCheckout'] = () => embedded;
    h.openTrial({ timeZone });
    await settle();
    assert.equal(h.count('billing.quoteTrial'), 1);
    assert.deepEqual(plain(h.calls.filter(call => call.method === 'billing.createCheckout').map(call => call.input)), [{ sku: 'standard_monthly_v3', trial: { trialEndsAt } }]);
    assert.equal(h.mounted, 1);
    assert.equal(h.q('[data-action="trial-continue"]'), null, 'no intermediate Continue');
    assert.equal(h.q('[data-role="trial-confirm"]'), null, 'the activating CTA opens Checkout directly');
    assert.equal(clean(h.q('#ezil-upgrade-title')), 'Start your free month');
    assert.match(clean(h.q('.ezil-upgrade-price')), /^\$0 today$/);
    assert.equal(clean(h.q('[data-role="trial-then"]')), `Then $20.00/month from ${day} · USD · before applicable tax`);
    assert.equal(clean(h.q('.ezil-upgrade-total')), 'Due today$0.00');
    assert.equal(clean(h.q('[data-role="trial-first-charge"]')), `$20.00 from ${day}, then every month until you cancel.`);
    assert.equal(clean(h.q('[data-role="trial-cancel-by"]')), `Cancel before ${day} in Settings → Billing and you pay nothing.`);
    assert.match(clean(h.q('[data-role="trial-renews"]')), /A payment method is required/);
    assert.doesNotMatch(h.text(), paidWords);
});

test('trial_quote_stale: one automatic re-quote echoes only each exact quote and opens Checkout without Continue', async h => {
    const first = '2027-02-28T03:00:00Z', second = '2027-02-28T03:41:07Z';
    let quotes = 0, creates = 0;
    h.replies['billing.quoteTrial'] = () => quote(quotes++ ? second : first);
    h.replies['billing.createCheckout'] = () => creates++ ? embedded : fail('trial_quote_stale');
    h.openTrial({ timeZone: 'UTC' });
    await settle();
    assert.equal(h.count('billing.quoteTrial'), 2);
    assert.deepEqual(h.calls.filter(call => call.method === 'billing.createCheckout').map(call => call.input.trial.trialEndsAt), [first, second]);
    assert.equal(h.mounted, 1);
    assert.equal(h.q('[data-action="trial-continue"]'), null);
});

test('repeated stale quotes stop at Retry instead of creating an unbounded Checkout loop', async h => {
    h.replies['billing.quoteTrial'] = () => quote('2027-02-28T03:00:00Z');
    h.replies['billing.createCheckout'] = () => fail('trial_quote_stale');
    h.openTrial();
    await settle();
    assert.equal(h.count('billing.quoteTrial'), 2);
    assert.equal(h.count('billing.createCheckout'), 2);
    assert.equal(h.mounted, 0);
    assert.ok(h.q('[data-action="retry"]'));
    assert.match(h.text(), /dates changed/);
    assert.equal(h.q('[data-action="trial-continue"]'), null);
});

test('refusals: trial_unavailable / trial_checkout_complete go back to Billing; an unreadable quote is never shown; never a paid checkout', async h => {
    h.replies['billing.quoteTrial'] = () => fail('trial_unavailable');
    h.openTrial();
    await settle();
    assert.match(h.text(), /The free month isn't available for this account\./);
    assert.equal(h.count('billing.createCheckout'), 0);
    h.click('[data-action="return-to-billing"]');
    assert.equal(h.done, 1, 'Billing re-reads the offer');
    // Checkout already completed in another tab: the trial is starting.
    h.replies['billing.quoteTrial'] = () => quote('2027-02-28T03:00:00Z');
    h.replies['billing.createCheckout'] = () => fail('trial_checkout_complete');
    h.openTrial();
    await settle();
    assert.match(h.text(), /Your free month is already starting\. Wait a moment, then refresh Billing\./);
    assert.ok(h.q('[data-action="return-to-billing"]'));
    assert.equal(h.q('[data-action="retry"]'), null);
    h.handle.close();
    // Anything but a $0 Standard quote whose end is its first charge is refused before it is disclosed.
    for ( const bad of [{ todayCents: 2000 }, { sku: 'premium_monthly_v3' }, { firstChargeAt: '2027-03-01T00:00:00Z' }, { trialEndsAt: 'next month' }, { amountCents: 0 }] ) {
        h.replies['billing.quoteTrial'] = () => ok({ ...quote('2027-02-28T03:00:00Z').data, ...bad });
        const before = h.count('billing.createCheckout');
        h.openTrial();
        await settle();
        assert.equal(h.q('[data-role="trial-confirm"]'), null, JSON.stringify(bad));
        assert.ok(h.q('[data-action="retry"]'), JSON.stringify(bad));
        assert.equal(h.count('billing.createCheckout'), before);
        h.handle.close();
    }
    assert.ok(h.calls.filter(call => call.method === 'billing.createCheckout').every(call => call.input.trial?.trialEndsAt), 'every checkout carried the trial');
});

test('completion: "Your free month is starting", then "has started" with the first charge; never "payment received" or "paid"', async h => {
    h.replies['billing.quoteTrial'] = () => quote('2027-02-28T03:00:00Z');
    h.replies['billing.createCheckout'] = () => embedded;
    let status = ok({ status: 'open', paymentStatus: null, sku: 'standard_monthly_v3' });
    h.replies['billing.checkoutStatus'] = () => status;
    let summary = summaryV3('free');
    h.replies['billing.summary'] = () => ok(summary);
    h.openTrial({ timeZone: 'America/Los_Angeles' });
    await settle();
    status = ok({ status: 'complete', paymentStatus: 'no_payment_required', sku: 'standard_monthly_v3' });
    h.complete();
    await settle();
    assert.match(h.text(), /Your free month is starting\. Waiting for your plan to update\./);
    summary = trialSummaryV3('trialing', { endsAt: '2027-02-28T03:00:00Z' });
    await h.tick(1500);
    assert.equal(clean(h.q('[data-role="upgrade-success"] p')), 'Your free month of Standard has started');
    assert.match(h.text(), /First charge \$20\.00 from Feb 27, 2027 unless you cancel before then\./);
    for ( const state of h.rendered ) assert.doesNotMatch(state, paidWords);
    h.click('[data-action="done"]');
    assert.equal(h.done, 1);
});

test('review U1: a completed trial checkout is confirmed only by paid access, never by the Standard SKU alone', async h => {
    h.replies['billing.quoteTrial'] = () => quote('2027-02-28T03:00:00Z');
    h.replies['billing.createCheckout'] = () => embedded;
    h.replies['billing.checkoutStatus'] = () => ok({ status: 'complete', paymentStatus: 'no_payment_required', sku: 'standard_monthly_v3', trial: true });
    let summary = trialSummaryV3('payment_pending', { endsAt: '2027-02-28T03:00:00Z' });
    h.replies['billing.summary'] = () => ok(summary);
    h.openTrial({ timeZone: 'UTC' });
    await settle();
    h.complete();
    // Standard SKU, but paused (payment_pending, standing free), then the SKU with no standing at all: no success.
    await h.tick(1500);
    assert.equal(h.q('[data-role="upgrade-success"]'), null);
    summary = summaryV3('standard');
    await h.tick(1500);
    assert.equal(h.q('[data-role="upgrade-success"]'), null);
    // A converted plan (no trial, paid standing) is ordinary Standard, not "free month started".
    summary = { ...summaryV3('standard'), computer: { ...summaryV3('standard').computer, standing: 'paid' } };
    await h.tick(1500);
    assert.equal(clean(h.q('[data-role="upgrade-success"] p')), "You're on Standard");
    assert.doesNotMatch(h.text(), /free month of Standard has started/);
});

test('redirect mode: the trial checkout opens the same hosted tab and polls as Standard does', async h => {
    h.replies['billing.quoteTrial'] = () => quote('2027-02-28T03:00:00Z');
    h.replies['billing.createCheckout'] = () => ok({ mode: 'redirect', sessionId: 'cs_test_redirect', url: 'https://checkout.example.test/c/pay' });
    h.replies['billing.checkoutStatus'] = () => ok({ status: 'complete', paymentStatus: 'no_payment_required', sku: 'standard_monthly_v3' });
    h.replies['billing.summary'] = () => ok(trialSummaryV3('trialing', { endsAt: '2027-02-28T03:00:00Z' }));
    h.openTrial({ timeZone: 'UTC' });
    await settle();
    assert.equal(h.opens[0][0], 'https://checkout.example.test/c/pay');
    await h.tick(1500);
    assert.match(h.text(), /Your free month of Standard has started/);
    assert.equal(h.calls.find(call => call.method === 'billing.createCheckout').input.trial.trialEndsAt, '2027-02-28T03:00:00Z');
});

test('double activation while quote or Checkout is pending keeps one quote, one session and one payment form', async h => {
    let resolveQuote, resolveCheckout;
    h.replies['billing.quoteTrial'] = () => new Promise(resolve => { resolveQuote = resolve; });
    h.replies['billing.createCheckout'] = () => new Promise(resolve => { resolveCheckout = resolve; });
    h.openTrial(); h.openTrial();
    await settle();
    assert.equal(h.count('billing.quoteTrial'), 1);
    assert.equal(h.count('billing.createCheckout'), 0);
    resolveQuote(quote('2027-02-28T03:00:00Z'));
    await settle();
    h.openTrial();
    assert.equal(h.count('billing.createCheckout'), 1);
    resolveCheckout(embedded);
    await settle();
    assert.equal(h.mounted, 1);
});

test('closing during quote prevents a late Checkout mutation', async h => {
    let resolve;
    h.replies['billing.quoteTrial'] = () => new Promise(done => { resolve = done; });
    h.openTrial(); h.handle.close();
    resolve(quote('2027-02-28T03:00:00Z'));
    await settle();
    assert.equal(h.count('billing.createCheckout'), 0);
    assert.equal(h.mounted, 0);
});

// ── Trial variants of the other billing sheets ────────────────────────────────

test('cancel sheet while the first payment is collected (review U2): paused-access words; never "stays active"; never a voided invoice', async h => {
    const summary = trialSummaryV3('payment_pending');
    h.replies['billing.cancelAtPeriodEnd'] = input => { assert.deepEqual(plain(input), { cancel: true }); return ok({ cancelsAt: '2027-01-05T14:30:00Z' }); };
    h.handle = h.api.openCancelSheet({ container: h.q('#container'), summary, trpc: h.trpc, onDone: () => {}, onClose: () => {} });
    const sheet = h.q('[data-role="billing-sheet"]');
    assert.equal(clean(sheet.querySelector('h2')), 'Cancel Standard');
    assert.equal(clean(sheet.querySelector('[data-role="sheet-body"] > p')),
        "Your free month has ended and your first $20.00 payment is still being collected. Cancelling stops later renewals; it doesn't cancel that first payment. Standard stays paused until it goes through; if it does, Standard runs to the end of that month and then ends.");
    assert.doesNotMatch(clean(sheet), /stays active|\bActive\b|refund|void|won't be charged|pay nothing/i);
    assert.equal(clean(sheet.querySelector('[data-action="confirm"]')), 'Cancel later renewals');
    h.click('[data-action="confirm"]');
    await settle();
    assert.equal(h.count('billing.cancelAtPeriodEnd'), 1);
    assert.match(clean(sheet), /Later renewals are cancelled\. Your first payment is still being collected; if it goes through, Standard runs until Jan 5, 2027 and then ends\./);
    assert.doesNotMatch(clean(sheet), /stays active|won't be charged|void/i);
});

test('cancel sheet in a trial: the free month\'s words, the same cancelAtPeriodEnd, "you won\'t be charged"', async h => {
    const summary = trialSummaryV3('trialing', { endsAt: '2026-12-05T03:30:00Z' });
    summary.computer.awsSize = { size: 'std-2', vcpu: 2, memoryGiB: 8 };
    h.replies['billing.cancelAtPeriodEnd'] = input => { assert.deepEqual(plain(input), { cancel: true }); return ok({ cancelsAt: '2026-12-05T03:30:00Z' }); };
    h.handle = h.api.openCancelSheet({ container: h.q('#container'), summary, trpc: h.trpc, onDone: () => {}, onClose: () => {} });
    const sheet = h.q('[data-role="billing-sheet"]');
    assert.equal(clean(sheet.querySelector('h2')), 'Cancel your free month');
    assert.match(clean(sheet), /Standard stays available until Dec 4, 2026 at 7:30 PM Pacific Standard Time and you won't be charged\. Then you move to Free\./);
    assert.match(clean(sheet), /After Dec 4, 2026 your computer opens under Free limits/);
    assert.equal(clean(sheet.querySelector('[data-action="keep"]')), 'Keep free month');
    h.click('[data-action="confirm"]');
    await settle();
    assert.equal(h.count('billing.cancelAtPeriodEnd'), 1);
    assert.match(clean(sheet), /Your free month ends on Dec 4, 2026\. You won't be charged\./);
    // A paid plan's cancel sheet is unchanged.
    h.handle.close();
    h.handle = h.api.openCancelSheet({ container: h.q('#container'), summary: summaryV3('standard'), trpc: h.trpc, onDone: () => {}, onClose: () => {} });
    assert.equal(clean(h.q('[data-role="billing-sheet"] h2')), 'Cancel Standard');
    assert.doesNotMatch(clean(h.q('[data-role="billing-sheet"]')), /free month/i);
});

test('plan picker and session end: Standard is the free month when offered (checkout gets trial: true); Premium never', async h => {
    const handed = [];
    const summary = trialSummaryV3('offer');
    h.handle = h.api.openPlanPickerSheet({ container: h.q('#container'), summary, trpc: h.trpc, onClose: () => {}, checkout: params => handed.push(params) });
    const standard = h.q('[data-plan="standard_monthly_v3"]'), premium = h.q('[data-plan="premium_monthly_v3"]');
    assert.match(clean(standard.querySelector('[data-role="trial-offer"]')), /^\$0 today\$20\/month from Dec 5, 2026\. One calendar month\. Card required\. Cancel before Dec 5, 2026 and you pay nothing\.$/);
    assert.equal(standard.querySelector('[data-action="checkout"]'), null);
    assert.doesNotMatch(clean(premium), /free month|\$0 today/i);
    h.click('[data-plan="standard_monthly_v3"] [data-action="trial"]');
    assert.deepEqual(handed.map(params => [params.sku, params.trial]), [['standard_monthly_v3', true]]);
    // Ineligible: the picker's Standard "Upgrade" (paid checkout), as before.
    h.handle = h.api.openPlanPickerSheet({ container: h.q('#container'), summary: trialSummaryV3('ineligible'), trpc: h.trpc, onClose: () => {}, checkout: params => handed.push(params) });
    h.click('[data-plan="standard_monthly_v3"] [data-action="checkout"]');
    assert.deepEqual(handed.at(-1).trial, undefined);
    // Session end on Free with an offer.
    const ended = trialSummaryV3('offer');
    h.handle = h.api.openSessionEndSheet({ container: h.q('#container'), summary: ended, reason: 'session_max', trpc: h.trpc, onClose: () => {}, checkout: params => handed.push(params) });
    const sheet = h.q('[data-sheet="session-end"]');
    assert.match(clean(sheet), /Standard: \$0 today, then \$20\/month from Dec 5, 2026 unless you cancel\./);
    assert.equal(clean(sheet.querySelector('[data-action="continue"]')), 'Start your free month');
    h.click('[data-sheet="session-end"] [data-action="continue"]');
    assert.deepEqual([handed.at(-1).sku, handed.at(-1).trial], ['standard_monthly_v3', true]);
    // The top-up recovery dialog offers the same free month.
    assert.deepEqual(plain(h.api.topupUpgrade(trialSummaryV3('offer'))), { action: 'trial', sku: 'standard_monthly_v3', label: 'Start your free month', note: 'Standard adds 200 AI credits every month.' });
    assert.equal(h.api.topupUpgrade(trialSummaryV3('ineligible')).action, 'checkout');
});

for (const entry of ['plan picker', 'session end']) test(`${entry}: one real CTA reaches the shared quote and Checkout without Continue`, async h => {
    h.replies['billing.quoteTrial'] = () => quote('2027-02-28T03:00:00Z');
    h.replies['billing.createCheckout'] = () => embedded;
    const options = { container: h.q('#container'), summary: trialSummaryV3('offer'), trpc: h.trpc, onClose: () => {}, loadStripe: h.loadStripe };
    h.handle = entry === 'plan picker' ? h.api.openPlanPickerSheet(options) : h.api.openSessionEndSheet({ ...options, reason: 'session_max' });
    h.click(entry === 'plan picker' ? '[data-plan="standard_monthly_v3"] [data-action="trial"]' : '[data-sheet="session-end"] [data-action="continue"]');
    await settle();
    assert.equal(h.count('billing.quoteTrial'), 1);
    assert.equal(h.count('billing.createCheckout'), 1);
    assert.equal(h.mounted, 1);
    assert.equal(h.q('[data-action="trial-continue"]'), null);
});

// ── Usage: no new meter, the authoritative balance, plan-labelled credits ─────

test('usage during a trial: the same three rows; credits are the server\'s balance labelled Plan, never an invented trial figure', async h => {
    const account = { userId: null, state: 'ok', asOf: '2026-11-06T00:00:00Z', totalMicro: '200000000', remainingMicro: '187500000', heldMicro: '0',
        usedMicro: '12500000', planBaselineMicro: '200000000', labelled: true,
        grants: [{ kind: 'plan', creditsMicro: '200000000', remainingMicro: '187500000', expiresAt: TRIAL_END }] };
    const trialing = trialSummaryV3('trialing'); trialing.ai.account = account;
    const paid = summaryV3('standard'); paid.ai.account = account;
    const rows = html => [...h.fragment(html).querySelectorAll('[data-usage]')].map(row => row.dataset.usage);
    const html = h.api.usageHtml(usageSample, trialing);
    assert.deepEqual(rows(html), rows(h.api.usageHtml(usageSample, paid)), 'no new meter for a trial');
    const ai = clean(h.fragment(html).querySelector('[data-usage="ai"]'));
    assert.match(ai, /187 credits left of 200/);
    assert.match(ai, /Plan 200/);
    assert.doesNotMatch(ai, /trial/i);
    // Billing's AI row: the same balance and label.
    const billing = clean(h.fragment(h.api.summaryV3Html(trialing)).querySelector('[data-role="meter-ai"]'));
    assert.match(billing, /187 credits left of 200/);
    assert.match(billing, /Plan 200/);
    assert.doesNotMatch(billing, /trial/i);
});

let failed = 0, scanned = 0;
for ( const { name, fn } of tests ) {
    const h = harness();
    try {
        const el = await fn(h);
        await settle();
        for ( const state of [...h.rendered, ...(el ? [el.textContent] : [])] ) {
            assert.doesNotMatch(state, honestyBans);
            assert.doesNotMatch(v3CopyForAudit(state), banned);
            scanned++;
        }
        console.log(`PASS ${name}`);
    } catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
    finally { h.cleanup(); }
}
console.log(`${tests.length - failed}/${tests.length} billing trial tests passed; ${scanned} rendered states scanned`);
process.exitCode = failed ? 1 : 0;
