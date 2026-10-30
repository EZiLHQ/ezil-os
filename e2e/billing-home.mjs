/** Public-page acceptance stays independent of the implementation: DESIGN §2, §5, §6. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser, redact, scanCopy, hasHorizontalOverflow } from './billing-e2e-lib.mjs';

let browser;
let base;
try {
    assert(process.env.HOME_BASE_URL, 'Set HOME_BASE_URL to an app with PRICING_PAGE_ENABLED=1');
    base = new URL(process.env.HOME_BASE_URL);
    browser = await launchBrowser();
    if (process.env.BILLING_SCREENSHOTS) await mkdir(process.env.BILLING_SCREENSHOTS, { recursive: true });
} catch (error) {
    console.error(`UNABLE TO RUN: ${redact(error)}`);
    await browser?.close();
    process.exit(2);
}

const steps = [];
async function check(name, run) {
    try {
        await run();
        steps.push({ name, passed: true });
    } catch (error) {
        steps.push({ name, passed: false, error: redact(error) });
    }
}

/**
 * Vercel previews sit behind SSO. VERCEL_AUTOMATION_BYPASS_SECRET (the same
 * name e2e/deployed-target.mjs and preview.yml use) is sent as a header only;
 * redact() already scrubs x-vercel-protection-bypass from any error text.
 */
function bypassHeaders() {
    const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    return secret ? { 'x-vercel-protection-bypass': secret } : {};
}

async function assertHref(page, selector, href) {
    const link = page.locator(selector);
    assert.equal(await link.count(), 1, `${selector} must be unique`);
    assert.equal(await link.evaluate(element => element.tagName), 'A');
    assert.equal(await link.getAttribute('href'), href);
}

/** Chromium computes names here, including aria-labelledby and image alternatives. */
async function namedControls(page) {
    for (const role of ['button', 'link']) {
        const controls = page.getByRole(role);
        assert(await controls.count() > 0 || role === 'button', 'The home page must expose navigation links');
        assert.equal(await controls.count(), await page.getByRole(role, { name: /\S/ }).count(), `Every ${role} must have an accessible name`);
    }
    // Native controls are required to participate in the accessibility tree.
    for (const control of await page.locator('a[href], button, summary').all()) {
        if (!await control.isVisible()) continue;
        const snapshot = await control.ariaSnapshot();
        assert.match(snapshot, /^- (?:link|button) "[^"\n]*\S[^"\n]*"/m, 'Visible controls must expose a named semantic role');
        await control.focus();
        assert(await control.evaluate(element => {
            const style = getComputedStyle(element);
            return element === document.activeElement && style.outlineStyle !== 'none'
                && parseFloat(style.outlineWidth) >= 2 && parseFloat(style.outlineOffset) >= 2;
        }), 'Every control has the specified visible focus outline');
    }
}

try {
    for (const [width, height] of [[390, 844], [1280, 900]]) {
        for (const pathname of ['/', '/pricing']) {
            await check(`${pathname} at ${width}×${height}`, async () => {
                const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', extraHTTPHeaders: bypassHeaders() });
                const page = await context.newPage();
                const errors = [];
                page.on('pageerror', error => errors.push(redact(error)));
                try {
                    const response = await page.goto(new URL(pathname, base).href, { waitUntil: 'networkidle' });
                    assert(response?.ok(), 'Public page responds successfully');
                    assert.equal(new URL(page.url()).pathname, pathname, 'Signed-out route renders without redirecting');
                    await page.evaluate(() => document.fonts.ready);
                    assert.equal(await page.locator('h1').count(), 1);
                    if (pathname === '/') {
                        assert.equal((await page.locator('[data-testid="home-hero"] h1').innerText()).trim(), 'Open EZiL OS and get to work.');
                        await assertHref(page, '[data-testid="cta-start-free"]', '/login');
                        await assertHref(page, '[data-testid="cta-sign-in"]', '/login');
                    } else {
                        // /pricing is plans-first: no hero, the plans title is the page's h1
                        // and the plans are in view on load without any scrolling.
                        assert.equal(await page.locator('[data-testid="home-hero"]').count(), 0);
                        assert.equal(await page.locator('#plans h1').count(), 1);
                    }
                    await assertHref(page, '[data-testid="cta-get-pro"]', '/login?returnUrl=%2Fos%3Fsettings%3Dbilling%26upgrade%3Dpro');
                    await assertHref(page, '[data-testid="plan-free"] a', '/login');
                    assert.equal(await page.locator('#plans').count(), 1);
                    for (const plan of ['free', 'pro']) {
                        const card = page.locator(`[data-testid="plan-${plan}"]`);
                        assert.equal(await card.count(), 1);
                        assert.match(await card.innerText(), plan === 'pro' ? /USD\s*·\s*before applicable tax/ : /USD\s*·\s*no card needed/);
                        assert.match(await card.innerText(), plan === 'pro' ? /\$20/ : /\$0/);
                        for (const meter of ['workspace', 'storage', 'ai']) {
                            assert.equal(await card.locator(`[data-testid="allowance-${plan}-${meter}"]`).count(), 1);
                        }
                        assert.match(await card.locator(`[data-testid="allowance-${plan}-ai"]`).innerText(), /assistant coming soon/i);
                    }
                    // FAQ is six open questions (h3) — no <details>/<summary>, which Chromium
                    // exposes to assistive technology only as plain text.
                    assert.equal(await page.locator('section[aria-labelledby="faq-title"] h3').count(), 6);
                    assert.equal(await page.locator('details, summary').count(), 0);
                    if (pathname === '/') {
                        const decor = page.locator('[aria-hidden="true"]').filter({ hasText: 'Browser' }).filter({ hasText: 'VS Code' });
                        assert(await decor.count() > 0, 'Product frame is decorative and aria-hidden');
                    }
                    assert.deepEqual(scanCopy(await page.locator('body').innerText()), [], 'Visible copy follows CONTRACT §8');
                    const dimensions = await page.evaluate(() => ({
                        viewportWidth: document.documentElement.clientWidth,
                        documentWidth: document.documentElement.scrollWidth,
                        bodyWidth: document.body.scrollWidth,
                    }));
                    assert.equal(dimensions.viewportWidth, width, 'Viewport positive control');
                    assert.equal(hasHorizontalOverflow(dimensions), false, JSON.stringify(dimensions));
                    if (pathname === '/pricing') {
                        const position = await page.locator('#plans').evaluate(element => element.getBoundingClientRect().top);
                        assert(position >= -2 && position < height / 2, '/pricing scrolls to the plans section');
                    }
                    await namedControls(page);
                    await page.evaluate(() => scrollTo(0, 0));
                    if (process.env.BILLING_SCREENSHOTS) {
                        await page.screenshot({ path: path.join(process.env.BILLING_SCREENSHOTS, `billing-home-${pathname === '/' ? 'root' : 'pricing'}-${width}.png`), fullPage: true });
                    }
                    assert.deepEqual(errors, [], 'No uncaught page errors after rendering and keyboard focus');
                } finally { await context.close(); }
            });
        }
    }
    if (process.env.HOME_FLAG_OFF_BASE_URL) {
        await check('flag off redirects signed-out root to login', async () => {
            const context = await browser.newContext({ extraHTTPHeaders: bypassHeaders() });
            try {
                const page = await context.newPage();
                const response = await page.goto(new URL('/', process.env.HOME_FLAG_OFF_BASE_URL).href);
                assert(response?.ok(), 'Login is reachable with the flag off');
                assert.equal(new URL(page.url()).pathname, '/login');
            } finally { await context.close(); }
        });
    }
} finally { await browser.close(); }
const passed = steps.filter(step => step.passed).length;
console.log(JSON.stringify({ steps, passed, failed: steps.length - passed }));
process.exitCode = passed === steps.length ? 0 : 1;
