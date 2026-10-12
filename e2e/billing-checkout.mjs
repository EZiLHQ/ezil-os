/**
 * Opt-in checkout acceptance boots the shipped shell without a listening port.
 * Stripe is real test mode; the local summary transition simulates webhook delivery.
 * This suite does not exercise Postgres, webhook signatures or grant idempotency.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, redact, requireTestKeys } from './billing-e2e-lib.mjs';

const origin = 'http://localhost';
const label = 'ezil-os billing e2e';
const os = fileURLToPath(new URL('../app/public/os/', import.meta.url));
const sessionIds = [];
const steps = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let keys;
let browser;
let icons;
let bundle;
let css;
try {
    keys = requireTestKeys(process.env.STRIPE_E2E_SECRET, process.env.STRIPE_E2E_PUBLISHABLE);
    [icons, bundle, css] = await Promise.all(['icons.js', 'bundle.min.js', 'bundle.min.css'].map(file => readFile(path.join(os, file), 'utf8')));
    browser = await launchBrowser();
    if (process.env.BILLING_SCREENSHOTS) await mkdir(process.env.BILLING_SCREENSHOTS, { recursive: true });
} catch (error) {
    console.error(`UNABLE TO RUN: ${redact(error)}`);
    console.log(JSON.stringify({ steps: [{ name: 'prerequisites', passed: false, error: redact(error) }], passed: 0, failed: 1, sessionIds }));
    await browser?.close();
    process.exit(2);
}

async function stripe(endpoint, fields) {
    const response = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
        method: fields ? 'POST' : 'GET',
        headers: {
            Authorization: `Bearer ${keys.secret}`,
            ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': randomUUID() } : {}),
        },
        body: fields ? new URLSearchParams(fields) : undefined,
        signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    assert(response.ok, redact(body.error?.message || `Stripe HTTP ${response.status}`));
    assert.equal(body.livemode, false, 'Stripe object positive control: test mode');
    return body;
}

function summary(pro) {
    const start = new Date();
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const allowance = (pro ? 20 : 8) * 3600;
    return {
        enabled: true, version: 1,
        plan: { id: pro ? 'pro' : 'free', status: pro ? 'active' : 'free',
            periodStart: start.toISOString(), periodEnd: end.toISOString(),
            renewsAt: pro ? end.toISOString() : null, cancelsAt: null },
        meters: {
            workspace: { usedSeconds: 0, allowanceSeconds: allowance, remainingSeconds: allowance, resetsAt: end.toISOString(), state: 'ok' },
            storage: { usedBytes: '0', capBytes: '2000000000', state: 'ok', measuredAt: null },
            ai: { state: 'unavailable', trialMicro: '0', includedMicro: '0', purchasedMicro: '0', includedExpiresAt: null },
        },
        actions: { checkout: true, portal: pro, topup: false },
        catalog: {
            pro: { sku: 'pro_monthly_v1', unitAmountCents: 2000, currency: 'usd', interval: 'month' },
            packs: [
                { sku: 'ai_pack_10_v1', creditCents: 1000, serviceFeeCents: 84, totalCents: 1084 },
                { sku: 'ai_pack_25_v1', creditCents: 2500, serviceFeeCents: 161, totalCents: 2661 },
            ],
        },
    };
}

/** Unknown local API calls fail visibly instead of accidentally reaching a real server. */
async function fixture() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', locale: 'en-US' });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const state = { pro: false, createCalls: 0, sessions: [], errors: [], routeErrors: [] };
    const userId = randomUUID();
    const computer = { id: randomUUID(), name: 'E2E Computer', slot: 1,
        createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false };
    const payload = {
        user: { id: userId, email: 'billing-e2e@example.com' }, computer,
        features: { billing: true },
        apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
        desktopState: {
            provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
            endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop',
                previewUrl: '/api/shell/preview-url', focus: '/api/shell/focus', codePreviewUrl: '/api/shell/code-preview-url' },
        },
    };
    page.on('pageerror', error => state.errors.push(redact(error)));

    async function procedure(name, input) {
        switch (name) {
            case 'billing.summary': return summary(state.pro);
            case 'billing.history': return [];
            case 'computer.list': return [computer];
            case 'billing.createCheckout': {
                assert.equal(input?.sku, 'pro_monthly_v1');
                state.createCalls++;
                // Leave the request pending long enough for a second click to expose races.
                await delay(500);
                const customer = await stripe('customers', {
                    email: payload.user.email, name: label, description: label,
                    'metadata[test_suite]': label, 'metadata[user_id]': userId,
                });
                const session = await stripe('checkout/sessions', {
                    customer: customer.id, ui_mode: 'embedded_page', mode: 'subscription',
                    'payment_method_types[0]': 'card',
                    'line_items[0][quantity]': '1',
                    'line_items[0][price_data][currency]': 'usd',
                    'line_items[0][price_data][unit_amount]': '2000',
                    'line_items[0][price_data][recurring][interval]': 'month',
                    'line_items[0][price_data][product_data][name]': label,
                    redirect_on_completion: 'if_required',
                    return_url: 'http://localhost/billing/return?session_id={CHECKOUT_SESSION_ID}',
                    billing_address_collection: 'auto', 'customer_update[address]': 'auto',
                    'automatic_tax[enabled]': 'true',
                    'saved_payment_method_options[payment_method_save]': 'enabled',
                    'metadata[sku]': 'pro_monthly_v1', 'metadata[test_suite]': label,
                    'subscription_data[metadata][sku]': 'pro_monthly_v1',
                    'subscription_data[metadata][test_suite]': label,
                    'subscription_data[description]': label,
                    client_reference_id: userId,
                });
                sessionIds.push(session.id);
                state.sessions.push(session.id);
                assert(session.client_secret, 'Real embedded session has a client secret');
                return { mode: 'embedded', sessionId: session.id, clientSecret: session.client_secret, publishableKey: keys.publishable };
            }
            case 'billing.checkoutStatus': {
                assert(state.sessions.includes(input?.sessionId), 'Status belongs to this fixture');
                const session = await stripe(`checkout/sessions/${encodeURIComponent(input.sessionId)}`);
                return { status: session.status === 'open' ? 'pending' : session.status };
            }
            default: throw new Error(`Unexpected tRPC procedure: ${name}`);
        }
    }

    await page.route('**/*', async route => {
        try {
            const request = route.request();
            const url = new URL(request.url());
            const host = url.hostname;
            if (host === 'stripe.com' || host.endsWith('.stripe.com')
                || host === 'stripe.network' || host.endsWith('.stripe.network')) return route.continue();
            if (url.origin !== origin) return route.abort('blockedbyclient');
            if (url.pathname === '/os') {
                return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html{height:100%}body{min-height:100%;margin:0}</style></head><body><div id="ezil-os-root"><div id="ezil-os-root-inner"></div></div></body></html>` });
            }
            if (url.pathname.startsWith('/api/trpc/')) {
                const names = decodeURIComponent(url.pathname.slice('/api/trpc/'.length)).split(',');
                const batched = url.searchParams.get('batch') === '1';
                const input = JSON.parse(request.postData() || url.searchParams.get('input') || '{}');
                const replies = [];
                for (let i = 0; i < names.length; i++) {
                    const envelope = batched ? input[i] : input;
                    const data = await procedure(names[i], envelope?.json ?? envelope);
                    replies.push({ result: { data: { json: data } } });
                }
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify(batched ? replies : replies[0]) });
            }
            if (url.pathname === '/api/shell/session') {
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'idle' }) });
            }
            if (url.pathname === '/api/shell/desktop') {
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, guacamoleRunning: false }) });
            }
            return route.fulfill({ status: 404, body: '' });
        } catch (error) {
            state.routeErrors.push(redact(error));
            await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: redact(error) } }) }).catch(() => {});
        }
    });
    try {
        await page.goto(`${origin}/os?settings=billing&upgrade=pro`, { waitUntil: 'load' });
        await page.evaluate(boot => { window.__EZIL_BOOT__ = boot; }, payload);
        await page.addScriptTag({ content: icons });
        await page.addScriptTag({ content: bundle });
        await page.locator('.ezil-settings-pane[data-pane="billing"]').waitFor({ state: 'visible' });
        return { context, page, state };
    } catch (error) {
        await context.close();
        throw error;
    }
}

async function sheetReady(page) {
    const sheet = page.locator('[data-role="upgrade-sheet"]');
    await sheet.waitFor({ state: 'visible' });
    assert.equal(await sheet.getAttribute('role'), 'dialog');
    assert.equal(await sheet.getAttribute('aria-modal'), 'true');
    await page.locator('#ezil-embedded-checkout iframe').first().waitFor({ state: 'visible', timeout: 60_000 });
    return page.frameLocator('#ezil-embedded-checkout iframe').first();
}

/** Stripe owns the form DOM; find named fields in the checkout and its secure child frames. */
async function field(frame, expression, role = 'textbox') {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const candidates = [frame];
        const children = await frame.locator('iframe').count();
        for (let i = 0; i < children; i++) candidates.push(frame.frameLocator('iframe').nth(i));
        for (const candidate of candidates) {
            for (const locator of [candidate.getByRole(role, { name: expression }), candidate.getByLabel(expression)]) {
                for (const match of await locator.all()) {
                    if (await match.isVisible()) return match;
                }
            }
        }
        await delay(150);
    }
    throw new Error(`Stripe named field not found: ${expression}`);
}

async function pay(page, card) {
    const frame = await sheetReady(page);
    const cardOption = frame.getByRole('radio', { name: /card/i });
    if (await cardOption.count() && await cardOption.first().isVisible()) await cardOption.first().click();
    await (await field(frame, /card number/i)).fill(card);
    await (await field(frame, /expiration|expiry|MM\s*\/\s*YY/i)).fill('12/34');
    await (await field(frame, /security code|CVC|CVV/i)).fill('123');
    await (await field(frame, /cardholder|name on card|full name/i)).fill('EZiL Billing E2E');
    const country = await field(frame, /country/i, 'combobox');
    if (await country.evaluate(element => element.tagName === 'SELECT')) {
        await country.selectOption({ label: 'United States' });
    } else {
        await country.click();
        await frame.getByRole('option', { name: 'United States', exact: true }).click();
    }
    await (await field(frame, /ZIP|postal code/i)).fill('10001');
    await frame.getByRole('button', { name: /^(Subscribe|Pay)(\b|\s)/i }).click();
    return frame;
}

async function noSuccess(page) {
    assert.equal(await page.locator('[data-role="upgrade-success"]:visible').count(), 0);
}

async function scenario(name, run) {
    // BILLING_E2E_ONLY=<name> runs one scenario while debugging.
    if (process.env.BILLING_E2E_ONLY && process.env.BILLING_E2E_ONLY !== name) return;
    let fixtureState;
    try {
        fixtureState = await fixture();
        await run(fixtureState);
        assert.deepEqual(fixtureState.state.routeErrors, [], 'All fake server requests succeeded');
        assert.deepEqual(fixtureState.state.errors, [], 'No uncaught shell page errors');
        if (process.env.BILLING_SCREENSHOTS) {
            await fixtureState.page.screenshot({ path: path.join(process.env.BILLING_SCREENSHOTS, `billing-checkout-${name}.png`), fullPage: true });
        }
        steps.push({ name, passed: true });
    } catch (error) {
        // A failure screenshot is the only way to see what Stripe's iframe showed.
        if (process.env.BILLING_SCREENSHOTS && fixtureState?.page) {
            await fixtureState.page.screenshot({ path: path.join(process.env.BILLING_SCREENSHOTS, `billing-checkout-${name}-FAILED.png`), fullPage: true }).catch(() => {});
        }
        steps.push({ name, passed: false, error: redact(error), routeErrors: fixtureState?.state.routeErrors || [] });
    } finally { await fixtureState?.context.close(); }
}

try {
    await scenario('successful-payment', async ({ page, state }) => {
        await sheetReady(page);
        assert.equal(state.pro, false, 'Positive control: user begins on Free');
        await noSuccess(page);
        await pay(page, '4242424242424242');
        const deadline = Date.now() + 60_000;
        let session;
        do {
            session = await stripe(`checkout/sessions/${encodeURIComponent(state.sessions[0])}`);
            if (session.status === 'complete') break;
            await delay(1500);
        } while (Date.now() < deadline);
        assert.equal(session.status, 'complete', 'Real Stripe Checkout Session completed');
        assert.equal(session.payment_status, 'paid', 'Real test-mode payment succeeded');
        await noSuccess(page);
        // Simulate the separate webhook step only after Stripe confirms payment.
        state.pro = true;
        const success = page.locator('[data-role="upgrade-success"]');
        await success.waitFor({ state: 'visible', timeout: 35_000 });
        assert.match(await success.innerText(), /You're on EZiL Pro/);
        await success.getByRole('button', { name: 'Done', exact: true }).click();
        await page.locator('[data-role="upgrade-sheet"]').waitFor({ state: 'detached' });
        await page.locator('[data-action="portal"]').waitFor({ state: 'visible' });
    });
    await scenario('declined-payment', async ({ page, state }) => {
        const frame = await pay(page, '4000000000000002');
        await frame.getByText(/your card (?:was|has been) declined|card has been declined/i).first().waitFor({ state: 'visible' });
        assert.equal(state.pro, false);
        await noSuccess(page);
        const session = await stripe(`checkout/sessions/${encodeURIComponent(state.sessions[0])}`);
        assert.equal(session.status, 'open', 'Declined session stays open');
        assert.equal(session.payment_status, 'unpaid', 'Declined session has no payment');
    });
    await scenario('close-mid-flow', async ({ page, state }) => {
        await sheetReady(page);
        const firstSession = state.sessions[0];
        await page.locator('[data-action="close-sheet"]').click();
        await page.locator('[data-role="upgrade-sheet"]').waitFor({ state: 'detached' });
        assert.equal(await page.locator('#ezil-embedded-checkout').count(), 0);
        await page.locator('[data-action="checkout"]').click();
        await sheetReady(page);
        assert.equal(state.createCalls, 2, 'Reopening creates a fresh session');
        assert.equal(state.sessions.length, 2);
        assert.notEqual(state.sessions[1], firstSession);
        await page.keyboard.press('Escape');
        await page.locator('[data-role="upgrade-sheet"]').waitFor({ state: 'detached' });
    });
    await scenario('double-click-upgrade', async ({ page, state }) => {
        await sheetReady(page);
        await page.locator('[data-action="close-sheet"]').click();
        await page.locator('[data-role="upgrade-sheet"]').waitFor({ state: 'detached' });
        const before = state.createCalls;
        await page.locator('[data-action="checkout"]').dblclick();
        await sheetReady(page);
        assert.equal(state.createCalls - before, 1, 'One createCheckout call for a double click');
        assert.equal(state.sessions.length, before + 1, 'One real session for the new opening');
    });
} finally { await browser.close(); }
const passed = steps.filter(step => step.passed).length;
console.log(redact(JSON.stringify({ steps, passed, failed: steps.length - passed, sessionIds })));
process.exitCode = passed === steps.length ? 0 : 1;
