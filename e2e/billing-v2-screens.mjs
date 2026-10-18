/**
 * Screenshot the shipped app/public/os bundle, never a shell source rebuild.
 * Usage: node e2e/billing-v2-screens.mjs --out /tmp/billing-v2 [--only compute]
 * No server, listening port, Stripe connection, or external browser requests.
 * passed/failed count state × viewport runs; files lists every PNG actually saved.
 * Tabs: <state>-<width>-<1..5>.png. Sheets: <state>-<width>.png,
 * optionally <state>-<width>-2.png. Marketing: <state>-<width>.png (full page).
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchBrowser, scanCopy, hasHorizontalOverflow, redact } from './billing-e2e-lib.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const APP = path.join(ROOT, 'app');
const ORIGIN = 'http://localhost';
const NOW = '2026-10-18T12:00:00Z';
const START = '2026-10-01T00:00:00Z';
const END = '2026-11-01T00:00:00Z';
const EXPIRES = '2026-10-20T12:00:00Z';
const TERMS = 'overage-v2-2026-10-18';
const STANDARD = 'standard_monthly_v2';
const COMPUTE = 'compute_monthly_v2';
const PANE = '.ezil-settings-pane[data-pane="billing"]';
const VIEWPORTS = [{ width: 390, height: 844 }, { width: 1280, height: 800 }];
const TAB_STATES = [
    'free-legacy-8h', 'free-v2-low', 'standard-active', 'compute-active',
    'compute-overage-on', 'compute-overage-paused-cap', 'compute-terms-changed',
    'compute-cancels', 'compute-scheduled-downgrade', 'standard-upgrade-pending',
    'past-due', 'overage-unpaid', 'legacy-pro', 'summary-error', 'billing-disabled',
];
const SHEET_STATES = [
    'checkout-standard', 'checkout-compute', 'upgrade-preview', 'upgrade-requires-action',
    'upgrade-payment-failed', 'upgrade-applied', 'downgrade', 'cancel', 'overage-consent', 'size-saved',
];
const clone = value => structuredClone(value);
const summary = { passed: 0, failed: 0, files: [], failures: [] };
let browser, temporary, assets;

function cli() {
    const options = { only: '' };
    for (let i = 2; i < process.argv.length; i++) {
        const flag = process.argv[i];
        assert(['--out', '--only'].includes(flag), `Unknown option: ${flag}`);
        const value = process.argv[++i];
        assert(value && !value.startsWith('--'), `${flag} requires a value`);
        options[flag.slice(2)] = value;
    }
    assert(options.out, 'Usage: node e2e/billing-v2-screens.mjs --out <dir> [--only <substring>]');
    options.out = path.resolve(options.out);
    const relative = path.relative(ROOT, options.out);
    assert(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), '--out must be outside the repository');
    return options;
}

/** Complete Wire DTOs, with no server-only catalog fields. */
function v2(family = 'compute', freeHours = 2) {
    const free = family === 'free', compute = family === 'compute';
    const allowance = (free ? freeHours : compute ? 500 : family === 'standard' ? 60 : 20) * 3600;
    const allowedSizes = free ? ['free-cf'] : compute ? ['std-2', 'cmp-4', 'cmp-8'] : ['std-2'];
    const value = {
        enabled: true, version: 2,
        plan: {
            sku: free ? freeHours === 8 ? 'free_v1_legacy' : 'free_v2' : compute ? COMPUTE : family === 'standard' ? STANDARD : 'pro_monthly_v1',
            family, status: free ? 'free' : 'active', periodStart: START, periodEnd: END,
            renewsAt: free ? null : END, cancelsAt: null, scheduledChange: null, pendingUpgrade: null, paymentIssue: null,
        },
        compute: {
            allowanceStdSeconds: allowance, usedStdSeconds: 0, remainingStdSeconds: allowance,
            resetsAt: END, state: 'ok', remainingActualSecondsBySize: {}, allowedSizes, selectedSize: allowedSizes[0],
            session: { maxSeconds: 21600, warnSeconds: [900, 300], idleSleepSeconds: 600, activeDeadline: null },
        },
        overage: compute ? {
            available: true, enabled: false, centsPerStdHour: 25, capCents: 2500, defaultCapCents: 2500,
            maxCapCents: 10000, accruedCents: 0, termsVersion: TERMS, acceptedVersion: null, acceptedAt: null, pausedReason: null,
        } : null,
        estimate: {
            nextChargeAt: free ? null : END, subscriptionCents: free ? null : compute ? 10000 : 2000,
            accruedOverageCents: 0, worstCaseOverageCents: 0, currency: 'usd', taxNote: 'before_tax',
        },
        storage: { usedBytes: '1500000000', capBytes: '2000000000', state: 'ok', measuredAt: '2026-10-18T11:58:00Z' },
        ai: { state: 'unavailable', trialMicro: '0', includedMicro: '0', purchasedMicro: '0', includedExpiresAt: null },
        actions: { checkout: free, portal: !free, upgrade: family === 'standard', downgrade: compute, cancel: !free, overage: compute, selectSize: compute },
        catalog: {
            version: 2,
            offers: [
                { sku: STANDARD, family: 'standard', priceCents: 2000, currency: 'usd', interval: 'month', allowanceStdSeconds: 216000, sizes: ['std-2'], overage: null },
                { sku: COMPUTE, family: 'compute', priceCents: 10000, currency: 'usd', interval: 'month', allowanceStdSeconds: 1800000, sizes: ['std-2', 'cmp-4', 'cmp-8'], overage: { centsPerStdHour: 25, defaultCapCents: 2500, maxCapCents: 10000 } },
            ],
            sizes: [
                { code: 'free-cf', vcpu: 2, memoryGiB: 6, weight: 1 },
                { code: 'std-2', vcpu: 2, memoryGiB: 8, weight: 1 },
                { code: 'cmp-4', vcpu: 4, memoryGiB: 16, weight: 2 },
                { code: 'cmp-8', vcpu: 8, memoryGiB: 32, weight: 4 },
            ],
        },
    };
    usage(value, free ? 4501 : compute ? 765001 : 32401);
    return value;
}

function usage(value, seconds, state = 'ok') {
    const meter = value.compute;
    meter.usedStdSeconds = seconds;
    meter.remainingStdSeconds = Math.max(0, meter.allowanceStdSeconds - seconds);
    meter.state = state;
    meter.remainingActualSecondsBySize = Object.fromEntries(meter.allowedSizes.map(code =>
        [code, Math.floor(meter.remainingStdSeconds / value.catalog.sizes.find(size => size.code === code).weight)]));
}

function history(value, state) {
    if (!value.enabled || value.plan.family === 'free') return [];
    const row = (id, kind, status, cents, created, description) => ({
        id, number: `EZ-2026-${id}`, status, kind, amountPaidCents: status === 'paid' ? cents : 0,
        amountDueCents: cents, currency: 'usd', created, url: `${ORIGIN}/invoices/${id}`, description,
    });
    const rows = [
        row('1001', 'subscription', 'paid', value.estimate.subscriptionCents ?? 10000, START, 'Monthly subscription · Oct 1–Nov 1'),
        row('1002', 'overage', 'paid', 375, '2026-10-02T08:00:00Z', 'Compute usage · previous billing period'),
    ];
    if (state === 'overage-unpaid') rows.push(row('1003', 'overage', 'open', 625, '2026-10-17T09:00:00Z', 'Unpaid usage invoice'));
    if (['past-due', 'standard-upgrade-pending'].includes(state)) rows.push(row('1004', 'subscription', 'open', 3483, '2026-10-18T10:00:00Z', 'Subscription payment'));
    return rows;
}

function fixture(name) {
    const family = name.startsWith('free-') || name.startsWith('checkout-') ? 'free'
        : name.startsWith('standard-') || name.startsWith('upgrade-') ? 'standard'
            : name === 'legacy-pro' ? 'pro_legacy' : 'compute';
    const value = name === 'billing-disabled' ? { enabled: false } : v2(family, name === 'free-legacy-8h' ? 8 : 2);
    if (name === 'free-v2-low') usage(value, 6600, 'low');
    if (name === 'compute-active') value.compute.session.activeDeadline = '2026-10-18T14:14:00Z';
    if (['compute-overage-on', 'compute-overage-paused-cap', 'compute-terms-changed', 'overage-unpaid'].includes(name)) {
        Object.assign(value.overage, { enabled: true, acceptedVersion: TERMS, acceptedAt: '2026-10-18T08:00:00Z', accruedCents: 375 });
        Object.assign(value.estimate, { accruedOverageCents: 375, worstCaseOverageCents: 2500 });
        usage(value, 1854000, 'exhausted');
    }
    if (name === 'compute-overage-paused-cap') {
        Object.assign(value.overage, { accruedCents: 2500, pausedReason: 'cap_reached' });
        value.estimate.accruedOverageCents = 2500;
        usage(value, 2160000, 'exhausted');
    }
    if (name === 'compute-terms-changed') value.overage.acceptedVersion = 'overage-v2-2026-10-01';
    if (name === 'compute-cancels') {
        Object.assign(value.plan, { status: 'cancels', cancelsAt: END, renewsAt: null });
        Object.assign(value.estimate, { nextChargeAt: null, subscriptionCents: null });
        value.actions.downgrade = false;
    }
    if (name === 'compute-scheduled-downgrade') {
        value.plan.scheduledChange = { toSku: STANDARD, effectiveAt: END };
        value.estimate.subscriptionCents = 2000;
        value.actions.downgrade = false;
    }
    if (name === 'standard-upgrade-pending') {
        Object.assign(value.plan, { status: 'upgrade_pending', paymentIssue: 'requires_action', pendingUpgrade: { toSku: COMPUTE, expiresAt: EXPIRES, hostedInvoiceUrl: `${ORIGIN}/invoices/1004` } });
        value.actions.upgrade = false;
    }
    if (name === 'past-due') {
        Object.assign(value.plan, { status: 'past_due', paymentIssue: 'payment_failed' });
        Object.assign(value.actions, { downgrade: false, selectSize: false, overage: false });
    }
    if (name === 'overage-unpaid') {
        value.plan.paymentIssue = 'overage_unpaid';
        Object.assign(value.overage, { enabled: false, accruedCents: 0, pausedReason: 'payment_failed' });
        Object.assign(value.estimate, { accruedOverageCents: 0, worstCaseOverageCents: 0 });
        value.actions.overage = false;
        usage(value, 1800000, 'exhausted');
    }
    return { name, value, invoices: history(value, name), calls: [], errors: [], routeErrors: [] };
}

/** Per-state fakes validate the real controls' procedure inputs. */
function procedure(f, name, input, computer) {
    f.calls.push({ name, input });
    const value = f.value;
    switch (name) {
        case 'billing.summary': return clone(value);
        case 'billing.history': return clone(f.invoices);
        case 'computer.list': return [computer];
        case 'billing.previewUpgrade':
            assert.deepEqual(input, { toSku: COMPUTE });
            return {
                toSku: COMPUTE, prorationDate: Date.parse(NOW) / 1000, amountDueCents: 3483, currency: 'usd',
                lines: [{ description: 'Unused Standard time', amountCents: -871 }, { description: 'Remaining Compute time', amountCents: 4354 }],
                periodEnd: END, grantStdSeconds: Math.floor(1584000 * (Date.parse(END) - Date.parse(NOW)) / (Date.parse(END) - Date.parse(START))),
            };
        case 'billing.confirmUpgrade': {
            assert.deepEqual(input, { toSku: COMPUTE, prorationDate: Date.parse(NOW) / 1000 });
            const status = f.name === 'upgrade-requires-action' ? 'requires_action' : f.name === 'upgrade-payment-failed' ? 'payment_failed' : 'applied';
            if (status === 'applied') {
                f.value = v2('compute');
                f.value.compute.allowanceStdSeconds = value.compute.allowanceStdSeconds
                    + Math.floor(1584000 * (Date.parse(END) - Date.parse(NOW)) / (Date.parse(END) - Date.parse(START)));
                usage(f.value, value.compute.usedStdSeconds);
            } else {
                Object.assign(value.plan, { status: 'upgrade_pending', paymentIssue: status,
                    pendingUpgrade: { toSku: COMPUTE, expiresAt: EXPIRES, hostedInvoiceUrl: `${ORIGIN}/invoices/upgrade` } });
                value.actions.upgrade = false;
            }
            return { status, invoiceId: 'in_screenshot_upgrade', hostedInvoiceUrl: `${ORIGIN}/invoices/upgrade`, expiresAt: status === 'applied' ? null : EXPIRES };
        }
        case 'billing.scheduleDowngrade':
            assert.deepEqual(input, { toSku: STANDARD });
            value.plan.scheduledChange = { toSku: STANDARD, effectiveAt: END };
            return { effectiveAt: END };
        case 'billing.cancelAtPeriodEnd':
            assert.equal(typeof input?.cancel, 'boolean');
            Object.assign(value.plan, { status: input.cancel ? 'cancels' : 'active', cancelsAt: input.cancel ? END : null, renewsAt: input.cancel ? null : END });
            return { cancelsAt: value.plan.cancelsAt };
        case 'billing.setOverage':
            assert.equal(typeof input?.enabled, 'boolean');
            assert.equal(input.termsVersion, TERMS);
            assert(Number.isInteger(input.capCents) && input.capCents >= 0 && input.capCents <= value.overage.maxCapCents);
            Object.assign(value.overage, input, { acceptedVersion: TERMS, acceptedAt: NOW });
            value.estimate.worstCaseOverageCents = input.enabled ? input.capCents : 0;
            return clone(value.overage);
        case 'billing.selectSize':
            assert.deepEqual(input, { size: 'cmp-8' });
            value.compute.selectedSize = input.size;
            return { selectedSize: input.size };
        case 'billing.createCheckout':
            assert.deepEqual(input, { sku: f.name === 'checkout-standard' ? STANDARD : COMPUTE });
            return { mode: 'embedded', sessionId: 'cs_test_screenshot', clientSecret: 'cs_test_screenshot_secret_placeholder', publishableKey: 'pk_test_screenshot' };
        case 'billing.checkoutStatus':
            assert.deepEqual(input, { sessionId: 'cs_test_screenshot' });
            return 'pending'; // CheckoutStatusDTO is a string, not { status }.
        default: throw new Error(`Unexpected tRPC procedure: ${name}`);
    }
}

function fakeStripe() {
    window.Stripe = function () {
        const create = async ({ fetchClientSecret }) => {
            await fetchClientSecret();
            let box;
            return {
                mount(selector) {
                    const host = document.querySelector(selector);
                    if (!host) throw new Error('Checkout mount is missing');
                    box = document.createElement('div');
                    box.dataset.role = 'fake-payment-form';
                    box.textContent = 'Secure payment form';
                    box.setAttribute('role', 'group');
                    box.setAttribute('aria-label', 'Secure payment form');
                    box.style.cssText = 'display:grid;place-items:center;min-height:480px;width:100%;box-sizing:border-box;border:1px solid #343b45;border-radius:8px;background:#141a23;color:#d1d5db;font:14px/20px system-ui,sans-serif';
                    host.replaceChildren(box);
                },
                destroy() { box?.remove(); },
            };
        };
        return { createEmbeddedCheckoutPage: create, initEmbeddedCheckout: create };
    };
}

async function openPage(viewport, f) {
    const context = await browser.newContext({ viewport, isMobile: false, reducedMotion: 'reduce', locale: 'en-US', colorScheme: 'dark', timezoneId: 'UTC', serviceWorkers: 'block' });
    try {
        // Context routing also protects popups; every HTTP request is fulfilled or aborted.
        await context.route('**/*', async route => {
            try {
                const request = route.request(), url = new URL(request.url());
                if (url.origin !== ORIGIN) return await route.abort('blockedbyclient');
                if (url.pathname === '/os') return await route.fulfill({ contentType: 'text/html', body: documentHTML('<div id="ezil-os-root"><div id="ezil-os-root-inner"></div></div>', `${assets.css}\nhtml{height:100%}body{min-height:100%;margin:0}`) });
                if (url.pathname.startsWith('/api/trpc/')) {
                    const names = decodeURIComponent(url.pathname.slice('/api/trpc/'.length)).split(',');
                    const batched = url.searchParams.get('batch') === '1';
                    const input = JSON.parse(request.postData() || url.searchParams.get('input') || '{}');
                    const replies = names.map((name, i) => {
                        if (name === 'billing.summary' && f.name === 'summary-error') {
                            return { error: { json: { message: 'stripe_unavailable', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: name } } } };
                        }
                        const envelope = batched ? input[i] : input;
                        const data = procedure(f, name, envelope?.json ?? envelope, f.computer);
                        return { result: { data: { json: data } } };
                    });
                    return await route.fulfill({ status: replies.some(reply => reply.error) ? batched ? 207 : 500 : 200, contentType: 'application/json', body: JSON.stringify(batched ? replies : replies[0]) });
                }
                if (url.pathname === '/api/shell/session') return await route.fulfill({ json: { ok: true, status: 'idle' } });
                if (url.pathname === '/api/shell/desktop') return await route.fulfill({ json: { ok: true, guacamoleRunning: false } });
                return await route.fulfill({ status: 404, body: '' });
            } catch (error) {
                f.routeErrors.push(redact(error));
                await route.fulfill({ status: 500, json: { error: { json: { message: 'Fixture failure', data: { code: 'INTERNAL_SERVER_ERROR' } } } } }).catch(() => {});
            }
        });
        // Route WebSockets too, without connectToServer(). Older Playwright is rejected.
        assert.equal(typeof context.routeWebSocket, 'function', 'Playwright must support routeWebSocket for offline captures');
        await context.routeWebSocket('**/*', socket => socket.close());
        const page = await context.newPage();
        page.setDefaultTimeout(12000);
        page.on('pageerror', error => f.errors.push(redact(error)));
        await page.addInitScript(fakeStripe);
        // Fix Date while keeping timeout/animation scheduling alive for shell boot.
        await page.clock.setFixedTime(new Date(NOW));
        return { context, page };
    } catch (error) {
        await context.close();
        throw error;
    }
}

function documentHTML(body, css) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EZiL billing screenshots</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body>${body}</body></html>`;
}

async function bootShell(page, f) {
    f.computer = { id: '00000000-0000-4000-8000-000000000002', name: 'My computer', slot: 1, createdAt: START, lastOpenedAt: NOW, isNew: false };
    const payload = {
        user: { id: '00000000-0000-4000-8000-000000000001', email: 'billing-screens@example.test' }, computer: f.computer,
        features: { billing: true }, apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
        desktopState: {
            provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
            endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop', previewUrl: '/api/shell/preview-url', focus: '/api/shell/focus', codePreviewUrl: '/api/shell/code-preview-url' },
        },
    };
    await page.goto(`${ORIGIN}/os?settings=billing`, { waitUntil: 'load' });
    await page.evaluate(boot => { window.__EZIL_BOOT__ = boot; }, payload);
    await page.addScriptTag({ content: assets.icons });
    await page.addScriptTag({ content: assets.bundle });
    await page.locator(PANE).waitFor({ state: 'visible' });
    // These two deliberate non-summary states cannot render a plan card.
    const ready = f.name === 'summary-error' ? '[data-action="retry"]'
        : f.name === 'billing-disabled' ? '[data-role="billing-body"][aria-busy="false"]' : '[data-role="plan-card"]';
    await page.locator(`${PANE} ${ready}`).waitFor({ state: 'visible' });
    if (!['summary-error', 'billing-disabled'].includes(f.name)) {
        await page.locator(`${PANE} [data-role="invoice-rows"][aria-busy="false"]`).waitFor({ state: 'visible' });
    }
}

async function openState(page, name) {
    const pane = page.locator(PANE);
    if (name === 'size-saved') {
        await pane.locator('input[name="ezil-billing-size"][value="cmp-8"]').check();
        await pane.getByText('Size saved.', { exact: true }).waitFor();
        return null;
    }
    if (!SHEET_STATES.includes(name)) return null;
    const kind = name.startsWith('checkout-') ? 'checkout' : name.startsWith('upgrade-') ? 'upgrade' : name === 'overage-consent' ? 'overage' : name;
    const action = kind === 'checkout' ? `[data-action="checkout"][data-sku="${name === 'checkout-standard' ? STANDARD : COMPUTE}"]`
        : kind === 'overage' ? '[data-role="overage"] [data-action="overage"]' : `[data-role="plan-actions"] [data-action="${kind}"]`;
    await pane.locator(action).click();
    const selector = kind === 'checkout' ? '[data-role="upgrade-sheet"]' : `[data-role="billing-sheet"][data-sheet="${kind}"]`;
    const sheet = page.locator(selector);
    await sheet.waitFor({ state: 'visible' });
    if (kind === 'checkout') await sheet.locator('#ezil-embedded-checkout [data-role="fake-payment-form"]').waitFor({ state: 'visible' });
    if (kind === 'upgrade') {
        await sheet.locator('[data-action="confirm"]').waitFor({ state: 'visible' });
        if (name !== 'upgrade-preview') {
            await sheet.locator('[data-action="confirm"]').click();
            await sheet.locator('[data-action="done"]').waitFor({ state: 'visible' });
        }
    }
    if (kind === 'overage') {
        await sheet.locator('input[type="number"]').fill('40');
        await sheet.locator('input[type="checkbox"]').check();
    }
    await page.waitForFunction(selector => !document.querySelector(selector)?.querySelector('[aria-busy="true"]'), selector);
    return selector;
}

async function checkState(page, f, sheetSelector) {
    const pane = page.locator(PANE), name = f.name;
    const contains = async (locator, text) => assert((await locator.innerText()).includes(text), `Expected text: ${text}`);
    const exists = async selector => assert(await page.locator(selector).count(), `Missing selector: ${selector}`);
    if (name === 'summary-error') return exists(`${PANE} [role="alert"] [data-action="retry"]`);
    if (name === 'billing-disabled') return contains(pane, "Billing isn't available yet.");
    // The applied result does not reload the tab until Done is clicked.
    const family = name.startsWith('upgrade-') ? 'standard' : f.value.plan.family;
    await exists(`${PANE} [data-role="plan-card"][data-family="${family}"]`);
    for (const selector of ['[data-meter="compute"]', '[data-meter="storage"]', '[data-meter="ai"]', '[data-role="size-selector"]', '[data-role="session-note"]', '[data-role="invoices"]']) await exists(`${PANE} ${selector}`);
    if (family === 'free') {
        await exists(`${PANE} [data-role="plan-picker"]`);
        await exists(`${PANE} input[value="free-cf"]:checked:disabled`);
        await contains(pane.locator('[data-role="plan-card"]'), name === 'free-legacy-8h' ? '8 h each month' : '2 h each month');
    }
    if (name === 'free-v2-low') await exists(`${PANE} [data-meter="compute"].is-low`);
    if (name === 'standard-active') {
        await exists(`${PANE} input[value="std-2"]:checked:disabled`);
        await contains(pane.locator('[data-role="size-locked"]'), 'Upgrade to Compute for 4 or 8 vCPU');
    }
    if (family === 'compute') assert.equal(await pane.locator('[data-role="size-selector"] input').count(), 3);
    if (name === 'compute-active') {
        await exists(`${PANE} [data-role="overage"][data-enabled="false"]`);
        await contains(pane.locator('[data-role="session-countdown"]'), '2 h 14 m');
    }
    if (name === 'compute-overage-on') {
        await exists(`${PANE} [data-role="overage"][data-enabled="true"]`);
        await contains(pane.locator('[data-role="overage"]'), 'Accrued this period: $3.75.');
        await contains(pane.locator('[data-role="estimate"]'), 'Usage so far: $3.75, billed separately.');
    }
    if (name === 'compute-overage-paused-cap') {
        await exists(`${PANE} [data-role="overage-paused"][data-reason="cap_reached"]`);
        await exists(`${PANE} [data-meter="compute"].is-exhausted`);
    }
    if (name === 'compute-terms-changed') await contains(pane.locator('[data-role="overage"]'), 'Review terms');
    if (name === 'compute-cancels') await exists(`${PANE} [data-action="resume"]`);
    if (name === 'compute-scheduled-downgrade') await contains(pane.locator('[data-role="plan-card"]'), 'Switches to Standard on Nov 1.');
    const issue = { 'standard-upgrade-pending': 'requires_action', 'past-due': 'payment_failed', 'overage-unpaid': 'overage_unpaid' }[name];
    if (issue) await exists(`${PANE} [data-role="payment-banner"][data-issue="${issue}"]`);
    if (name === 'legacy-pro') await contains(pane.locator('[data-role="plan-card"]'), 'Your original Pro plan, honoured as sold.');
    if (name === 'size-saved') {
        await exists(`${PANE} input[value="cmp-8"]:checked`);
        await contains(pane.locator('[data-role="size-status"]'), 'Size saved.');
        assert(f.calls.some(call => call.name === 'billing.selectSize'), 'Size mutation was called');
    }
    if (!sheetSelector) return;
    const sheet = page.locator(sheetSelector);
    assert.equal(await sheet.getAttribute('role'), 'dialog');
    assert.equal(await sheet.getAttribute('aria-modal'), 'true');
    await exists(`${sheetSelector} [data-action="close-sheet"]`);
    if (name.startsWith('checkout-')) await contains(sheet.locator('#ezil-embedded-checkout'), 'Secure payment form');
    if (name === 'upgrade-preview') {
        assert.equal(await sheet.locator('table tbody tr').count(), 2);
        await contains(sheet, 'Due now $34.83');
    }
    const resultText = { 'upgrade-requires-action': 'Confirm the payment with your bank to finish.', 'upgrade-payment-failed': "The payment didn't go through.", 'upgrade-applied': "You're on EZiL Compute" }[name];
    if (resultText) await contains(sheet, resultText);
    if (name === 'downgrade') await contains(sheet, 'Switch on Nov 1');
    if (name === 'cancel') await contains(sheet, 'Keep plan');
    if (name === 'overage-consent') {
        assert.equal(await sheet.locator('input[type="number"]').inputValue(), '40');
        assert(await sheet.locator('input[type="checkbox"]').isChecked());
        assert(await sheet.locator('[data-action="confirm"]').isEnabled());
        await contains(sheet, 'up to my cap of $40.');
    }
}

/** CSS-visible copy only: includes scrolled content, excludes hidden details/tabs. */
async function inspect(page, marketing) {
    return page.evaluate(({ paneSelector, marketing }) => {
        const pane = document.querySelector(paneSelector);
        const scopes = marketing ? [document.body] : [pane, document.querySelector('[role="dialog"][aria-modal="true"]')].filter(Boolean);
        const texts = [];
        for (const scope of scopes) {
            const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (!node.textContent.trim() || node.parentElement.closest('script, style')) continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                const style = getComputedStyle(node.parentElement);
                if (style.visibility === 'hidden' || style.visibility === 'collapse' || !range.getClientRects().length) continue;
                texts.push(node.textContent);
            }
        }
        const elements = [pane, pane?.querySelector('[data-role="billing-body"]'), pane?.closest('.ezil-settings-content'), document.querySelector('[role="dialog"][aria-modal="true"]')].filter(Boolean);
        return {
            text: texts.join(' '),
            layout: { viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth },
            content: elements.map(el => ({ name: el.dataset.role || el.className, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth })),
        };
    }, { paneSelector: PANE, marketing });
}

async function settle(page) {
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

async function save(page, f, file, problems, { fullPage = false, sheetSelector = null, marketing = false } = {}) {
    const check = async (label, fn) => {
        try { await fn(); } catch (error) { problems.push({ file, check: label, error: redact(error) }); }
    };
    await check('settled layout', () => settle(page));
    await check('expected state', () => marketing ? checkMarketing(page, f) : checkState(page, f, sheetSelector));
    await check('layout and copy', async () => {
        const observed = await inspect(page, marketing);
        if (hasHorizontalOverflow(observed.layout)) problems.push({ file, check: 'document overflow', error: JSON.stringify(observed.layout) });
        for (const element of observed.content) if (element.clientWidth <= 0 || element.scrollWidth > element.clientWidth) problems.push({ file, check: 'content overflow', error: JSON.stringify(element) });
        const banned = scanCopy(observed.text);
        if (banned.length) problems.push({ file, check: 'copy', error: `scanCopy: ${banned.join(', ')}` });
    });
    await check('screenshot', async () => {
        await page.screenshot({ path: file, fullPage, animations: 'disabled' });
        summary.files.push(file);
    });
    await check('page errors', () => assert.deepEqual(f.errors, []));
    await check('fixture errors', () => assert.deepEqual(f.routeErrors, []));
}

async function captureShell(page, f, out, width, sheetSelector, problems) {
    if (f.name === 'size-saved') {
        await page.locator(`${PANE} [data-role="size-selector"]`).scrollIntoViewIfNeeded();
        return save(page, f, path.join(out, `${f.name}-${width}.png`), problems);
    }
    const scroller = sheetSelector ? page.locator(sheetSelector) : page.locator(`${PANE}`).locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ezil-settings-content ")][1]');
    assert.equal(await scroller.count(), 1, 'Expected the actual content scroll container');
    await scroller.evaluate(el => { el.scrollTop = 0; });
    const maximum = sheetSelector ? 2 : 5;
    for (let part = 1; part <= maximum; part++) {
        const suffix = sheetSelector && part === 1 ? '' : `-${part}`;
        const file = path.join(out, `${f.name}-${width}${suffix}.png`);
        await save(page, f, file, problems, { sheetSelector });
        const dimensions = await scroller.evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight }));
        assert(dimensions.height > 0, 'Scroll container has no height');
        if (dimensions.top + dimensions.height >= dimensions.total - 1) return;
        if (part === maximum) {
            problems.push({ file, check: 'scroll coverage', error: `Content exceeds ${maximum} screenshot parts: ${JSON.stringify(dimensions)}` });
            return;
        }
        await scroller.evaluate(el => { el.scrollTop += el.clientHeight; });
    }
}

/** Only marketing is built from source; all emitted files live under os.tmpdir(). */
async function buildMarketing() {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'ezil-billing-v2-screens-'));
    const { build } = await import(pathToFileURL(path.join(APP, 'node_modules/esbuild/lib/main.js')).href);
    const source = await readFile(path.join(APP, 'src/app/(marketing)/_components/home-page.tsx'), 'utf8');
    const hasEffectiveDate = /\bfreeV2EffectiveAt\??\s*[:=,}]/.test(source);
    const outfile = path.join(temporary, 'marketing.mjs');
    await build({
        stdin: {
            contents: `import { renderToStaticMarkup } from 'react-dom/server';
                import MarketingHome from './src/app/(marketing)/_components/home-page';
                import './src/app/globals.css';
                export const render = (focusPlans, freeV2EffectiveAt) => renderToStaticMarkup(MarketingHome({ largeStorageEnabled: false, focusPlans${hasEffectiveDate ? ', freeV2EffectiveAt' : ''} }));`,
            resolveDir: APP, sourcefile: 'billing-v2-marketing.tsx', loader: 'tsx',
        },
        bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', conditions: ['style'],
        loader: { '.module.css': 'local-css', '.css': 'css' }, tsconfig: path.join(APP, 'tsconfig.json'),
        outfile, logLevel: 'silent',
        // React's server renderer requires Node built-ins when bundled into ESM.
        banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(APP, 'package.json'))});` },
    });
    const { render } = await import(pathToFileURL(outfile).href);
    const css = await readFile(path.join(temporary, 'marketing.css'), 'utf8');
    // Equivalent to the root layout's h-full/min-h-full/flex/flex-col classes.
    // Esbuild bundles Tailwind's preflight but does not generate its utility classes.
    const rootCSS = 'html{height:100%;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}body{min-height:100%;margin:0;display:flex;flex-direction:column}';
    return { render, css: `${css}\n${rootCSS}`, hasEffectiveDate };
}

async function checkMarketing(page, f) {
    for (const selector of ['#plans', '#home-content', '[data-testid="plan-free"]', '[data-testid="plan-standard"]', '[data-testid="plan-compute"]']) {
        assert(await page.locator(selector).count(), `Missing v2 marketing selector: ${selector}`);
    }
    assert.equal(await page.locator('[data-testid="home-hero"]').count(), f.name === 'home' ? 1 : 0);
    if (f.name === 'pricing-free-v2-effective') {
        assert.match(await page.locator('[data-testid="plan-free"]').innerText(), /\b2\s*h(?:ours)?\b/i, 'Effective Free offer has 2 hours');
    }
}

async function runState(name, viewport, out, marketing) {
    const f = fixture(name), problems = [];
    let context, page;
    try {
        ({ context, page } = await openPage(viewport, f));
        if (marketing) {
            // setContent avoids a server and imports no hydration/client scripts.
            const html = marketing.render(name !== 'home', name === 'pricing-free-v2-effective' ? NOW : undefined);
            await page.setContent(documentHTML(html, marketing.css), { waitUntil: 'load' });
            await save(page, f, path.join(out, `${name}-${viewport.width}.png`), problems, { fullPage: true, marketing: true });
        } else {
            await bootShell(page, f);
            const sheetSelector = await openState(page, name);
            await captureShell(page, f, out, viewport.width, sheetSelector, problems);
        }
    } catch (error) {
        problems.push({ check: 'state setup/capture', error: redact(error) });
        // A stale committed bundle must still leave a useful diagnostic PNG.
        if (page && !page.isClosed()) {
            const file = path.join(out, `${name}-${viewport.width}${TAB_STATES.includes(name) ? '-1' : ''}.png`);
            if (!summary.files.includes(file)) await save(page, f, file, problems, { fullPage: !!marketing, marketing: !!marketing });
        }
    } finally {
        try { await context?.close(); } catch (error) { problems.push({ check: 'context cleanup', error: redact(error) }); }
    }
    if (problems.length) {
        summary.failed++;
        summary.failures.push(...problems.map(problem => ({ state: name, width: viewport.width, ...problem })));
    } else summary.passed++;
    console.error(`${problems.length ? 'FAIL' : 'PASS'} ${name} ${viewport.width}: ${problems.length} check failure(s)`);
}

try {
    const options = cli();
    await mkdir(options.out, { recursive: true });
    const shellStates = [...TAB_STATES, ...SHEET_STATES].filter(name => name.includes(options.only));
    let marketing;
    let marketingStates = ['pricing', 'home', 'pricing-free-v2-effective'].filter(name => name.includes(options.only));
    if (marketingStates.length) {
        try {
            marketing = await buildMarketing();
            if (!marketing.hasEffectiveDate) {
                marketingStates = marketingStates.filter(name => name !== 'pricing-free-v2-effective');
                console.error('SKIP pricing-free-v2-effective: MarketingHome does not expose a freeV2EffectiveAt prop.');
            }
        } catch (error) {
            summary.failed++;
            summary.failures.push({ state: 'marketing-build', error: redact(error) });
            marketingStates = [];
        }
    }
    assert(shellStates.length + marketingStates.length > 0, `No runnable states match --only ${JSON.stringify(options.only)}`);
    if (shellStates.length) {
        const [icons, bundle, css] = await Promise.all(['icons.js', 'bundle.min.js', 'bundle.min.css'].map(file => readFile(path.join(APP, 'public/os', file), 'utf8')));
        assets = { icons, bundle, css };
    }
    browser = await launchBrowser();
    for (const name of shellStates) for (const viewport of VIEWPORTS) await runState(name, viewport, options.out);
    for (const name of marketingStates) for (const viewport of VIEWPORTS) await runState(name, viewport, options.out, marketing);
} catch (error) {
    summary.failed++;
    summary.failures.push({ state: 'prerequisites', error: redact(error) });
} finally {
    for (const [name, cleanup] of [['browser', () => browser?.close()], ['temporary output', () => temporary && rm(temporary, { recursive: true, force: true })]]) {
        try { await cleanup(); } catch (error) { summary.failed++; summary.failures.push({ state: name, error: redact(error) }); }
    }
    process.exitCode = summary.failed ? 1 : 0;
    console.log(JSON.stringify(summary));
}
