// billing-trial-browser-test.mjs — EZiL-authored. REAL-BROWSER checks for the Standard one-calendar-month trial
// (request standard-trial-01b28d18-20261105-v1) against the BUILT stylesheet (app/public/os/bundle.min.css):
//   - the Billing pane in each trial state fits the 760 px Settings window and a 390 px phone, with the state's one
//     primary, and the three plan cards still side by side at 760 px with the free-month lines on Standard;
//   - one-activation checkout, in a browser whose time zone is America/Los_Angeles, shows a quote on
//     31 Jan 2027 03:00 UTC (end 28 Feb 03:00 UTC) in the viewer's date, and Checkout echoes that end without Continue.
//
// Run:  PLAYWRIGHT_REQUIRE_DIR=<dir with playwright> node shell/ezil/ui/Settings/billing-trial-browser-test.mjs
//       (after shell/build-shell.sh). EZIL_TRIAL_SCREENSHOT_DIR=<dir> also saves a PNG per state there; unset
//       (CI), nothing is written.
// Exit 2 (skip) when playwright or the bundle is not resolvable — never a silent pass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { trialSummaryV3 } from './billing-v3-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const OS = process.env.EZIL_SHELL_OUT_DIR || path.resolve(here, '../../../../app/public/os');
if ( ! fs.existsSync(path.join(OS, 'bundle.min.css')) ) {
    console.error(`missing ${path.join(OS, 'bundle.min.css')} — run shell/build-shell.sh first`);
    process.exit(2);
}
let chromium;
try { ({ chromium } = await import('playwright')); } catch {
    const dir = process.env.PLAYWRIGHT_REQUIRE_DIR;
    if ( dir ) {
        try {
            const req = createRequire(path.join(path.resolve(dir), 'noop.js'));
            ({ chromium } = req('playwright'));
        } catch ( e ) { console.error(`playwright not found via PLAYWRIGHT_REQUIRE_DIR: ${e?.message ?? e}`); }
    }
}
if ( ! chromium ) {
    console.error('playwright is not resolvable. This is a REAL-BROWSER test. Skipping, not passing.');
    process.exit(2);
}
const shots = process.env.EZIL_TRIAL_SCREENSHOT_DIR ? path.resolve(process.env.EZIL_TRIAL_SCREENSHOT_DIR) : null;
if ( shots ) fs.mkdirSync(shots, { recursive: true });

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

const { buildSync } = require(require.resolve('esbuild', { paths: [path.resolve(here, '../../../../app')] }));
const renderers = buildSync({
    stdin: { contents: `
        import { summaryV3Html } from './tabs/billing.js';
        import { openUpgradeSheet } from './upgrade-sheet.js';
        window.trial = { summaryV3Html, openUpgradeSheet };
    `, resolveDir: here },
    bundle: true, write: false, format: 'iife', target: 'es2022',
}).outputFiles[0].text;
const css = fs.readFileSync(path.join(OS, 'bundle.min.css'), 'utf8');

// The month-end quote: 31 Jan 2027 03:00 UTC + one calendar month = 28 Feb 2027 03:00 UTC (= 27 Feb in Los Angeles).
const END = '2027-02-28T03:00:00Z';
const PRIMARY = { offer: 'Start your free month', ineligible: 'Upgrade to Standard', trialing: null, ending: 'Resume plan', payment_pending: null,
    payment_failed: 'Update payment method' };

const page_html = (width, height) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>
    <style>html, body { margin: 0; background: #000; }</style>
    <script>window.html_encode = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));</script></head><body>
    <div class="window ezil-settings-window" style="display: block; position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px;">
        <div class="window-body" style="height: 100%; overflow: auto;">
            <div class="ezil-settings">
                <nav class="ezil-settings-sidebar" role="tablist" aria-label="Settings"><button type="button" class="ezil-settings-tab active">Billing</button></nav>
                <div class="ezil-settings-content"><div class="ezil-settings-pane active" data-pane="billing" role="tabpanel">
                    <div class="ezil-settings-billing"><div data-role="billing-body"></div></div>
                </div></div>
            </div>
        </div>
    </div></body></html>`;

const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
    for ( const [label, viewport, width] of [['desktop 760 window', { width: 1440, height: 1000 }, 760], ['phone 390 px', { width: 390, height: 844 }, 390]] ) {
        // The browser's own zone, so every trial date is the viewer's: Los Angeles shows the UTC 28 Feb end as 27 Feb.
        const context = await browser.newContext({ viewport, timezoneId: 'America/Los_Angeles', locale: 'en-US' });
        const page = await context.newPage();
        // Tall enough that nothing in the pane scrolls, so a screenshot holds the whole state.
        await page.setContent(page_html(width, 2400));
        await page.addScriptTag({ content: renderers });
        for ( const state of Object.keys(PRIMARY) ) {
            const summary = trialSummaryV3(state, { endsAt: END });
            const m = await page.evaluate(summary => {
                const body = document.querySelector('[data-role="billing-body"]');
                body.innerHTML = window.trial.summaryV3Html(summary);
                const offers = [...document.querySelectorAll('[data-role="plan-offer"]')].map(el => el.getBoundingClientRect());
                const pane = document.querySelector('.ezil-settings-billing');
                const text = sel => document.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim() ?? null;
                return {
                    tops: offers.map(r => Math.round(r.top)), widths: offers.map(r => Math.round(r.width)),
                    overflow: pane.scrollWidth - pane.clientWidth,
                    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    primaries: [...document.querySelectorAll('.ezil-settings-btn-primary')].map(el => el.textContent.trim()),
                    primaryHeight: Math.round(document.querySelector('.ezil-settings-btn-primary')?.getBoundingClientRect().height ?? 0),
                    until: text('[data-role="trial-until"]'), offer: text('[data-role="trial-offer"]'),
                    ending: text('[data-role="trial-ending"] .ezil-billing-banner-title'), failed: text('[data-role="payment-banner"] .ezil-billing-banner-title'),
                    pending: [...document.querySelectorAll('[data-role="trial-payment-pending"] > div > p')].map(p => p.textContent.trim()).join(' ') || null, chip: getComputedStyle(document.querySelector('[data-role="plan-status"]')).color,
                    // Probe chips in the same pane: what "waiting" (incomplete) and "Active" are painted with.
                    probe: Object.fromEntries(['incomplete', 'active'].map(status => {
                        const span = document.createElement('span');
                        Object.assign(span, { className: 'ezil-settings-pill' }); span.dataset.role = 'plan-status'; span.dataset.status = status;
                        document.querySelector('[data-role="plan-card"]').append(span);
                        const color = getComputedStyle(span).color; span.remove(); return [status, color];
                    })),
                    height: Math.ceil(body.getBoundingClientRect().height),
                };
            }, summary);
            const expected = PRIMARY[state];
            push(`${label} · ${state}: the one primary is the state's own`, JSON.stringify(m.primaries) === JSON.stringify(expected ? [expected] : []), m.primaries.join(' | '));
            if ( expected ) push(`${label} · ${state}: the primary is at least 32 px tall`, m.primaryHeight >= 32, `${m.primaryHeight}`);
            push(`${label} · ${state}: no horizontal overflow`, m.overflow <= 0 && m.docOverflow <= 0, `pane ${m.overflow} doc ${m.docOverflow}`);
            if ( width === 760 ) push(`${label} · ${state}: Free | Standard | Premium sit side by side, each at least 140 px`,
                m.tops.length === 3 && new Set(m.tops).size === 1 && m.widths.every(w => w >= 140), `tops ${m.tops} widths ${m.widths}`);
            else push(`${label} · ${state}: the plan cards stack`, m.tops.length === 3 && new Set(m.tops).size === 3, `${m.tops}`);
            if ( state === 'offer' ) push(`${label} · offer: $0 today, $20/month from the viewer's day, cancel before it`,
                m.offer === '$0 today $20/month from Feb 27, 2027 One calendar month. Card required. Cancel before Feb 27, 2027 and you pay nothing.', m.offer);
            if ( state === 'trialing' ) push(`${label} · trialing: free until the end in the browser's zone, with its name`,
                m.until === 'Free until Feb 27, 2027 at 7:00 PM Pacific Standard Time', m.until);
            if ( state === 'ending' ) push(`${label} · ending: the free month's end day in the browser's zone`, m.ending === 'Your free month ends on Feb 27, 2027.', m.ending);
            if ( state === 'payment_pending' ) {
                push(`${label} · payment_pending: the free month ended and the first payment is being collected`,
                    m.pending === "Your free month has ended. We're collecting your first $20.00 payment; Standard resumes as soon as it goes through. Your files are kept.", m.pending);
                // The chip is painted as waiting (the warn tone), never as Active.
                push(`${label} · payment_pending: the chip is painted as waiting, not Active`, m.chip === m.probe.incomplete && m.chip !== m.probe.active, `${m.chip} vs ${JSON.stringify(m.probe)}`);
            }
            if ( state === 'payment_failed' ) push(`${label} · payment_failed: the trial copy, never grace`, m.failed === "Your free month ended and the $20.00 payment didn't go through.", m.failed);
            if ( shots ) await page.locator('[data-role="billing-body"]').screenshot({ path: path.join(shots, `billing-trial-${state}-${width}.png`) });
        }
        await context.close();
    }

    // The checkout sheet's trial confirmation, in the browser's zone (no injected zone): exact quote, then the echo.
    for ( const [label, viewport] of [['desktop 1440x1000', { width: 1440, height: 1000 }], ['laptop 1280x720', { width: 1280, height: 720 }], ['phone 375x667', { width: 375, height: 667 }]] ) {
        const context = await browser.newContext({ viewport, timezoneId: 'America/Los_Angeles', locale: 'en-US' });
        const page = await context.newPage();
        await page.setContent(page_html(Math.min(760, viewport.width), 560));
        await page.addScriptTag({ content: renderers });
        const offer = trialSummaryV3('offer').catalog.offers.find(item => item.sku === 'standard_monthly_v3');
        const t = await page.evaluate(async ({ offer, END }) => {
            window.calls = [];
            const trpc = {
                mutate: async (method, input) => {
                    window.calls.push({ method, input });
                    if ( method === 'billing.quoteTrial' ) return { ok: true, data: { sku: 'standard_monthly_v3', todayCents: 0, trialEndsAt: END, firstChargeAt: END,
                        amountCents: 2000, currency: 'usd', interval: 'month', quoteExpiresAt: '2027-01-31T03:30:00Z' } };
                    return { ok: true, data: { mode: 'embedded', sessionId: 'cs_test_trial', clientSecret: 'secret', publishableKey: 'pk_test' } };
                },
                query: async () => ({ ok: true, data: { status: 'open', paymentStatus: null } }),
            };
            const loadStripe = async () => ({ initEmbeddedCheckout: async () => ({ mount: selector => {
                const frame = document.createElement('div'); frame.style.height = '320px'; frame.textContent = 'Secure payment form (fake)';
                frame.dataset.role = 'fake-stripe'; document.querySelector(selector).append(frame); }, destroy: () => {} }) });
            window.trial.openUpgradeSheet({ container: document.querySelector('.window-body'), sku: offer.sku, offer, trpc, trial: true, loadStripe });
            for ( let i = 0; i < 20; i++ ) await Promise.resolve();
            await new Promise(resolve => setTimeout(resolve, 50));
            const dialog = document.querySelector('[data-role="upgrade-sheet"]');
            const rect = dialog.getBoundingClientRect();
            return {
                then: dialog.querySelector('[data-role="trial-then"]')?.textContent ?? null,
                charge: dialog.querySelector('[data-role="trial-renews"]')?.textContent ?? null,
                cancel: dialog.querySelector('[data-role="trial-cancel-by"]')?.textContent ?? null,
                inside: rect.left >= -0.5 && rect.right <= innerWidth + 0.5, overflow: dialog.scrollWidth - dialog.clientWidth,
                continueCount: dialog.querySelectorAll('[data-action="trial-continue"]').length,
                checkouts: window.calls.filter(call => call.method === 'billing.createCheckout').map(call => call.input),
                mounted: !!dialog.querySelector('[data-role="fake-stripe"]'),
            };
        }, { offer, END });
        push(`${label} · one activation: Checkout mounts without Continue`, t.mounted && t.continueCount === 0, JSON.stringify(t));
        push(`${label} · quote: the exact end is echoed once`, JSON.stringify(t.checkouts) === JSON.stringify([{ sku: 'standard_monthly_v3', trial: { trialEndsAt: END } }]), JSON.stringify(t.checkouts));
        push(`${label} · terms: $20/month from the browser's date`, t.then === 'Then $20.00/month from Feb 27, 2027 · USD · before applicable tax', t.then);
        push(`${label} · terms: card required, renewal and cancellation remain visible`, /A payment method is required/.test(t.charge) && /charged monthly/.test(t.charge) && /Cancel before Feb 27, 2027/.test(t.cancel), `${t.charge} | ${t.cancel}`);
        push(`${label} · layout: sheet inside viewport without horizontal overflow`, t.inside && t.overflow <= 0, JSON.stringify(t));
        if ( shots && viewport.width === 1440 ) await page.screenshot({ path: path.join(shots, 'trial-checkout-1440.png') });
        await context.close();
    }
} finally {
    await browser.close();
}

const failed = checks.filter(c => ! c.pass);
if ( shots ) console.log(`screenshots: ${shots}`);
console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed (billing trial, real browser)`);
process.exit(failed.length ? 1 : 0);
