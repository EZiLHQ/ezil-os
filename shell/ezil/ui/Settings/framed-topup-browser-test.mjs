// framed-topup-browser-test.mjs — EZiL-authored. REAL-BROWSER regression for Add AI credits in the two topologies the
// product serves: EZiL OS as the top-level page, and EZiL OS framed by its own Universe assignment work page
// (universe-staging -> os-staging `/app/code?repo=…&assignment=…`, the one entry `proxy.ts` lets that page frame).
//
// Run:  PLAYWRIGHT_REQUIRE_DIR=/path/to/node_modules node shell/ezil/ui/Settings/framed-topup-browser-test.mjs
//       (after shell/build-shell.sh: it runs the BUILT bundle in app/public/os, like stacking-browser-test.mjs)
//       PLAYWRIGHT_CHROMIUM_EXECUTABLE may select an installed Chromium. Exit 2 = SKIP (no Playwright), never a pass.
//
// Every request is intercepted: no network, no Stripe, no payment. Stripe.js and the billing API are LOCAL SIMULATIONS,
// so this proves the shell's own behaviour only. It does not prove the provider's redirect-required payment methods.
//
// What it holds:
//   1. Code's billing request (`registry.js` openBilling: Settings -> Billing with `billingRecovery`) opens the Add AI
//      credits dialog; its controls and the provider form are the topmost elements at their own centres; checkout
//      opens no popup and never navigates the top-level page or the frame away.
//   2. When the server answers `credited`, the dialog shows the new balance and Billing re-reads it.
//   3. A paid top-up whose dialog closes BEFORE the server answers `credited` (x while "Adding your AI credits…")
//      still reaches the displayed balance: Billing keeps asking `billing.topupStatus` and re-reads on `credited`.
//      Before the watch existed Billing stayed at "0 credits left" for good (incident 2026-11-26).
//   4. A top-up the server has ALREADY credited, with the dialog showing the new balance, reaches Billing however the
//      person leaves the dialog: Done, × (Close billing sheet), Escape or the backdrop. Each makes exactly one
//      billing.summary read and starts no watch. These runs open the dialog from Billing's own Add credits button with
//      a balance already above zero, and find Done and × by role and name, as a person does. Before the fix only Done
//      re-read: after ×, Escape or the backdrop Billing kept the old balance the dialog had just replaced (seen in a
//      hosted staging run, 2026-11-26: 1,199 in the dialog, 1,099 in Billing). On the previous bundle the two
//      re-read checks of each of those six runs fail.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { fileURLToPath } from 'node:url';
import { summaryV3 } from './billing-v3-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WT = path.resolve(here, '../../../..');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
    if ( process.env.PLAYWRIGHT_REQUIRE_DIR ) {
        const external = createRequire(path.join(path.resolve(process.env.PLAYWRIGHT_REQUIRE_DIR), 'probe.cjs'));
        try { ({ chromium } = external('playwright')); } catch { /* Explicit skip below. */ }
    }
}
if ( ! chromium ) {
    console.error('SKIP: installed Playwright is unavailable; a DOM simulation cannot prove framing, stacking or navigation.');
    process.exit(2);
}

// EZIL_SHELL_OUT_DIR: a directory holding the three shell files to run instead of the committed ones (`build-shell.sh`
// honours the same variable). It may hold a deployed shell's bytes saved by hand; nothing here fetches or contacts it.
const OSDIR = process.env.EZIL_SHELL_OUT_DIR ? path.resolve(process.env.EZIL_SHELL_OUT_DIR) : path.join(WT, 'app/public/os');
for ( const file of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OSDIR, file)) ) { console.error(`SKIP: ${file} is not built (run shell/build-shell.sh).`); process.exit(2); }
    console.log(`INFO  ${file} sha256 ${createHash('sha256').update(fs.readFileSync(path.join(OSDIR, file))).digest('hex')}`);
}
const icons = fs.readFileSync(path.join(OSDIR, 'icons.js'), 'utf8');
const bundle = fs.readFileSync(path.join(OSDIR, 'bundle.min.js'), 'utf8');
const css = fs.readFileSync(path.join(OSDIR, 'bundle.min.css'), 'utf8');

const OS = 'https://os-staging.ezil.work';
const UNIVERSE = 'https://universe-staging.ezil.work';
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const REPO = `https://github.ezil.work/default/u-0123456789abcdef-a-${ATTEMPT}.git`;
const FRAME_URL = `${OS}/app/code?repo=${encodeURIComponent(REPO)}&assignment=${ATTEMPT}`;

const PAYLOAD = {
    user: { id: 'user-1', email: 'synthetic@example.invalid' },
    features: { billing: true },
    computer: { id: 'computer-1', name: 'My Computer', slot: 1, createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false },
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
        endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop', previewUrl: '/api/shell/preview-url',
            focus: '/api/shell/focus', codePreviewUrl: '/api/shell/code-preview-url' } },
};

/** `opening`: the credits the simulated wallet holds before the top-up. */
function makeBackend (opening = 0) {
    const state = { credited: false, calls: [], sessionPolls: 0 };
    // The simulated ledger settles on its own clock (SETTLE_MS after the provider completes), whoever is polling.
    const settle = () => { if ( state.completed && Date.now() - state.completedAt >= SETTLE_MS ) state.credited = true; return state.credited; };
    const summary = () => {
        settle();
        const s = summaryV3('standard');
        s.actions.topup = true;
        s.catalog.packs = [{ sku: 'ai_topup_1000', aiCredits: 1000, creditCents: 1000, totalCents: 1000, discountPercent: 0, currency: 'usd' }];
        const left = opening + (state.credited ? 1000 : 0);
        const remaining = String(left * 1000000);
        s.ai.account = { userId: 'user-1', remainingMicro: remaining, totalMicro: String((left + 200) * 1000000),
            usedMicro: '200000000', heldMicro: '0', asOf: new Date().toISOString() };
        s.ai.balance = left; s.ai.balanceMicro = remaining; s.ai.state = left > 0 ? 'ok' : 'empty';
        return s;
    };
    const wrap = json => ({ result: { data: { json } } });
    function trpc (url, method) {
        const proc = new URL(url).pathname.replace('/api/trpc/', '');
        state.calls.push(`${method} ${proc}`);
        if ( proc === 'billing.summary' ) return wrap(summary());
        if ( proc === 'billing.history' ) return wrap([]);
        if ( proc === 'billing.usage' ) return wrap({ enabled: false });
        if ( proc === 'billing.quoteTopup' ) return wrap({ sku: 'ai_topup_1000', custom: false, aiCredits: 1000, creditCents: 1000, discountPercent: 0, totalCents: 1000, currency: 'usd' });
        if ( proc === 'billing.createTopupCheckout' ) return wrap({ sessionId: 'cs_test_simulated', clientSecret: 'cs_test_simulated_secret_simulated', publishableKey: 'pk_test_simulated' });
        if ( proc === 'billing.topupStatus' || proc === 'billing.checkoutStatus' ) {
            if ( ! state.completed ) return wrap({ status: 'pending', paymentStatus: 'unpaid', fulfillment: 'awaiting_payment', credits: null });
            state.sessionPolls++;
            if ( ! settle() ) return wrap({ status: 'complete', paymentStatus: 'paid', fulfillment: 'processing', credits: null });
            return wrap({ status: 'complete', paymentStatus: 'paid', fulfillment: 'credited', credits: 1000 });
        }
        if ( proc === 'computer.list' ) return wrap([{ id: 'computer-1', name: 'My Computer', slot: 1, createdAt: PAYLOAD.computer.createdAt, lastOpenedAt: null }]);
        return wrap({});
    }
    function shell (url, method) {
        if ( url.includes('confirm=frame') ) return { ok: true, confirmed: true, status: 200 };
        if ( url.includes('confirm=display') ) return { ok: true, display: 'live' };
        if ( url.includes('/api/shell/desktop') ) return method === 'POST' ? { ok: true, guacamoleUrl: 'about:blank', controlMode: 'interactive', mode: 'neko', frame: { confirmed: true } } : { ok: true, guacamoleRunning: true };
        if ( url.includes('/api/shell/code-preview-url') ) return { ok: false, error: 'sandbox_starting' };
        return { ok: true };
    }
    return { state, trpc, shell };
}

// A local stand-in for Stripe.js: the same surface upgrade-sheet.js uses, no network. `window.__completeProvider()`
// plays the provider's onComplete.
const FAKE_STRIPE = `window.Stripe = function (key) { window.__stripeKey = key; return {
  createEmbeddedCheckoutPage: async function (opts) { window.__stripeSecret = await opts.fetchClientSecret();
    return { mount: function (sel) { var host = document.querySelector(sel); var f = document.createElement('iframe');
        f.id = 'simulated-provider-form'; f.srcdoc = '<!doctype html><body style="background:#fff"><button id="pay">Pay (simulated)</button></body>';
        f.style.cssText = 'width:100%;height:220px;border:0'; host.appendChild(f); window.__providerMounted = true;
        window.__completeProvider = function () { opts.onComplete(); }; },
      destroy: function () { window.__providerDestroyed = true; }, unmount: function () {} }; } }; };`;

const docHtml = () => `<!doctype html><html class="h-full"><head><style>${css}</style><style>html{height:100%}body{min-height:100%}</style></head>
<body class="min-h-full flex flex-col"><div id="ezil-os-root"><div id="ezil-os-root-inner"></div></div>
<script>window.__EZIL_BOOT__ = ${JSON.stringify(PAYLOAD)};</script><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script></body></html>`;
// Universe's work page, as its controller and script build it: its CSP, Permissions-Policy and frame attributes.
const universeHtml = `<!doctype html><html><head><style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style></head><body><div id="stage" style="height:100%"></div></body></html>`;
const UNIVERSE_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src " + OS + "; worker-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

let SETTLE_MS = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const push = (name, pass, detail = '') => { checks.push({ name, pass: !! pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); return !! pass; };

/**
 * `late`: the simulated ledger settles SETTLE_MS after the provider completes, and the person closes the dialog first.
 * `leave`: how the person leaves the dialog once it shows the credited balance (Done, ×, Escape or backdrop); these
 * runs start from OPENING credits and open the dialog from Billing's Add credits button.
 */
const OPENING = 1099;
async function run (browser, topology, late, leave = null) {
    const label = `${topology}${late ? ' · dialog closed before credit' : ''}${leave ? ` · credited, left by ${leave}` : ''}`;
    SETTLE_MS = late ? 5000 : 1000;
    const backend = makeBackend(leave ? OPENING : 0);
    const context = await browser.newContext({ viewport: { width: 1366, height: 820 } });
    const page = await context.newPage();
    const popups = [], topNavs = [];
    context.on('page', p => popups.push(p.url()));
    page.on('framenavigated', f => { if ( f === page.mainFrame() ) topNavs.push(f.url()); });
    await context.route('**/*', async route => {
        const req = route.request(), url = req.url(), u = new URL(url);
        if ( u.origin === UNIVERSE && u.pathname === '/work' ) return route.fulfill({ status: 200, contentType: 'text/html', body: universeHtml,
            headers: { 'Content-Security-Policy': UNIVERSE_CSP, 'Permissions-Policy': 'display-capture=(self)', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' } });
        if ( u.origin === OS && (u.pathname === '/os' || u.pathname === '/app/code') ) return route.fulfill({ status: 200, contentType: 'text/html', body: docHtml(),
            headers: { 'Permissions-Policy': 'clipboard-read=(self "https://*.ezil.org" "https://*.ezil.work"), clipboard-write=(self "https://*.ezil.org" "https://*.ezil.work")',
                ...(u.pathname === '/app/code' ? { 'Content-Security-Policy': 'frame-ancestors ' + UNIVERSE } : {}) } });
        if ( u.origin === OS && u.pathname === '/os/icons.js' ) return route.fulfill({ status: 200, contentType: 'text/javascript', body: icons });
        if ( u.origin === OS && u.pathname === '/os/bundle.min.js' ) return route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle });
        if ( u.origin === OS && u.pathname.startsWith('/api/trpc/') ) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(backend.trpc(url, req.method())) });
        if ( u.origin === OS && u.pathname.startsWith('/api/') ) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(backend.shell(url, req.method())) });
        if ( u.origin === 'https://js.stripe.com' ) return route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_STRIPE });
        if ( u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:' ) return route.continue();
        return route.fulfill({ status: 404, body: '' });
    });

    let frame;
    if ( topology === 'standalone' ) {
        await page.goto(`${OS}/os`, { waitUntil: 'load' });
        frame = page.mainFrame();
    } else {
        await page.goto(`${UNIVERSE}/work`, { waitUntil: 'load' });
        // The frame as Universe builds it (assets/templates/basic/js/assignment-workspace.js): no sandbox, clipboard only.
        await page.evaluate(src => {
            const f = document.createElement('iframe');
            f.title = 'EZiL OS editor for your assignment'; f.referrerPolicy = 'no-referrer'; f.allow = 'clipboard-read; clipboard-write'; f.src = src;
            document.getElementById('stage').append(f);
        }, FRAME_URL);
        for ( let i = 0; i < 100 && ! (frame = page.frames().find(f => f.url().startsWith(`${OS}/app/code`))); i++ ) await sleep(50);
        await frame.waitForLoadState('load');
    }
    const until = async (fn, arg, ms = 8000) => { const end = Date.now() + ms; for ( ;; ) { const v = await frame.evaluate(fn, arg).catch(() => null); if ( v ) return v; if ( Date.now() > end ) return null; await sleep(60); } };
    const hit = sel => frame.evaluate(s => { const el = document.querySelector(s); if ( ! el ) return 'missing';
        const r = el.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return r.width > 0 && r.height > 0 && (at === el || el.contains(at)) ? 'topmost' : `covered by ${at?.tagName}.${String(at?.className).slice(0, 50)}`; }, sel);
    const balance = () => frame.evaluate(() => (document.querySelector('[data-pane="billing"] #ai-credits')?.textContent ?? 'none').replace(/\s+/g, ' ').trim());
    const status = () => frame.evaluate(() => document.querySelector('[data-role="billing-action-status"]')?.textContent ?? '');
    const summaries = () => backend.state.calls.filter(call => call === 'GET billing.summary').length;
    const sessionReads = () => backend.state.calls.filter(call => call === 'GET billing.topupStatus' || call === 'GET billing.checkoutStatus').length;

    push(`${label}: the shell booted`, await until(() => Array.isArray(window.ezil?.registry?.APPS) && window.ezil.registry.APPS.length > 0));
    const flags = await frame.evaluate(() => ({ embedded: window.is_embedded === true, top: window === window.top }));
    push(`${label}: the topology is the one named`, topology === 'framed' ? flags.embedded && ! flags.top : ! flags.embedded && flags.top, JSON.stringify(flags));
    await sleep(800);
    const dialogOpen = () => until(() => document.querySelector('.ezil-upgrade-backdrop [role="dialog"]')?.dataset.sheet === 'topup');
    if ( leave ) {
        // The person's own way in: Settings -> Billing, then the Add credits button beside the balance.
        await frame.evaluate(({ payload }) => window.ezil.registry.launch('settings', { payload, computer: payload.computer, desktopState: payload.desktopState,
            initialTab: 'billing' }), { payload: PAYLOAD });
        await frame.locator('[data-pane="billing"] #ai-credits').getByRole('button', { name: 'Add credits', exact: true }).click({ timeout: 8000 }).catch(() => {});
        push(`${label}: Billing's Add credits button opens Add AI credits`, await dialogOpen(), (await balance()).slice(0, 60));
    } else {
        // Exactly registry.js `openBilling`, which Code's billing bridge calls for a credit refusal.
        await frame.evaluate(({ payload }) => window.ezil.registry.launch('settings', { payload, computer: payload.computer, desktopState: payload.desktopState,
            initialTab: 'billing', billingRecovery: { reason: 'insufficient_credits', requestId: '22222222-2222-4222-8222-222222222222' } }), { payload: PAYLOAD });
        push(`${label}: Code's credit request opens Add AI credits`, await dialogOpen());
    }
    const primary = '.ezil-upgrade-backdrop [data-action="topup-continue"]';
    const primaryHit = await hit(primary);
    push(`${label}: Continue to payment is the topmost element at its centre`, primaryHit === 'topmost', primaryHit);
    await frame.locator(primary).click({ timeout: 4000 });
    push(`${label}: the provider form mounts with the server's session`, await until(() => window.__providerMounted === true && window.__stripeKey === 'pk_test_simulated' && typeof window.__stripeSecret === 'string'));
    const formHit = await hit('#simulated-provider-form');
    push(`${label}: the provider form is the topmost element at its centre`, formHit === 'topmost', formHit);

    backend.state.completed = true; backend.state.completedAt = Date.now();
    await frame.evaluate(() => window.__completeProvider());
    if ( leave ) {
        const was = `${OPENING.toLocaleString('en-US')} credits left`, now = `${(OPENING + 1000).toLocaleString('en-US')} credits left`;
        const dialog = frame.getByRole('dialog', { name: 'Add AI credits' });
        const copy = await until(() => document.querySelector('[data-role="topup-new-balance"]')?.textContent, undefined, 20000);
        push(`${label}: the dialog shows the server's new balance`, copy === `Your balance is now ${(OPENING + 1000).toLocaleString('en-US')} credits.`, String(copy));
        const before = { balance: await balance(), reads: summaries(), sessionReads: sessionReads() };
        push(`${label}: behind the open dialog Billing still shows the balance from before the payment`, before.balance.includes(was), before.balance.slice(0, 60));
        if ( leave === 'Done' ) await dialog.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 4000 });
        else if ( leave === '×' ) await dialog.getByRole('button', { name: 'Close billing sheet', exact: true }).click({ timeout: 4000 });
        else if ( leave === 'Escape' ) await page.keyboard.press('Escape');
        else await frame.locator('.ezil-upgrade-backdrop').click({ position: { x: 6, y: 6 }, timeout: 4000 });
        push(`${label}: the dialog closed`, await until(() => ! document.querySelector('.ezil-upgrade-backdrop')));
        push(`${label}: Billing shows the server's new balance`, await until(text => (document.querySelector('[data-pane="billing"] #ai-credits')?.textContent ?? '').includes(text), now), (await balance()).slice(0, 60));
        // Longer than the dialog's poll interval (1.5 s) and the Billing watch's first delay (3 s): a second read or a watch would show.
        await sleep(3500);
        push(`${label}: exactly one billing.summary read followed the close`, summaries() === before.reads + 1, `${before.reads} -> ${summaries()}`);
        push(`${label}: no session status is asked again after the close (no watch for a credited top-up)`, sessionReads() === before.sessionReads, `${before.sessionReads} -> ${sessionReads()}`);
        push(`${label}: Billing shows no pending or closed-checkout notice`, (await status()) === '', await status());
    } else if ( ! late ) {
        const copy = await until(() => document.querySelector('[data-role="topup-new-balance"]')?.textContent, undefined, 20000);
        push(`${label}: the dialog shows the server's new balance`, copy === 'Your balance is now 1,000 credits.', String(copy));
        await frame.locator('.ezil-upgrade-backdrop [data-action="done"]').click({ timeout: 4000 });
        push(`${label}: Billing shows the new balance after Done`, await until(() => /1,000 credits left/.test(document.querySelector('[data-pane="billing"] #ai-credits')?.textContent ?? '')), await balance());
    } else {
        push(`${label}: the dialog says the payment arrived and credits are being added`, await until(() => /Payment received\. Adding your AI credits/.test(document.querySelector('.ezil-upgrade-backdrop')?.textContent ?? '')));
        await frame.locator('.ezil-upgrade-backdrop [data-action="close-sheet"]').click({ timeout: 4000 });
        await sleep(300);
        const before = { balance: await balance(), reads: summaries() };
        push(`${label}: before the ledger settles Billing still shows the old balance`, /0 credits left/.test(before.balance) && ! backend.state.credited, before.balance.slice(0, 60));
        push(`${label}: Billing says the paid credits are on their way`, /Payment received/.test(await status()), await status());
        const refreshed = await until(() => /1,000 credits left/.test(document.querySelector('[data-pane="billing"] #ai-credits')?.textContent ?? ''), undefined, 20000);
        push(`${label}: Billing re-reads and shows the new balance once the server answers credited`, refreshed, (await balance()).slice(0, 60));
        push(`${label}: exactly one more billing.summary read made that change`, summaries() === before.reads + 1, `${before.reads} -> ${summaries()}`);
        push(`${label}: Billing says how many credits were added`, /1,000 AI credits added/.test(await status()), await status());
    }
    push(`${label}: checkout opened no popup`, popups.length === 0, popups.join(' '));
    push(`${label}: the top-level page never navigated away`, topNavs.every(url => url.startsWith(topology === 'framed' ? `${UNIVERSE}/work` : OS)), topNavs.join(' '));
    push(`${label}: the frame stayed on EZiL OS`, frame.url().startsWith(OS), frame.url().slice(0, 80));
    push(`${label}: one checkout was created and nothing else was written`, backend.state.calls.filter(call => call.startsWith('POST ')).join() === 'POST billing.createTopupCheckout',
        backend.state.calls.filter(call => call.startsWith('POST ')).join());
    await context.close();
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
    for ( const topology of ['standalone', 'framed'] ) for ( const late of [false, true] ) await run(browser, topology, late);
    for ( const topology of ['standalone', 'framed'] ) for ( const leave of ['Done', '×', 'Escape', 'backdrop'] ) await run(browser, topology, false, leave);
} finally { await browser.close(); }
const failed = checks.filter(check => ! check.pass);
console.log(`${checks.length - failed.length}/${checks.length} framed top-up checks passed (simulated provider and billing API)`);
process.exit(failed.length ? 1 : 0);
