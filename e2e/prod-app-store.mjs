/**
 * The App Store preview must be usable inside the authenticated production OS.
 * This is intentionally not an installation test: Reticle is still Planned.
 * Exit 2 means the production check could not run, never a pass.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const app = process.env.EZIL_E2E_APP ?? 'https://ezil-os.vercel.app';
const email = process.env.EZIL_E2E_EMAIL;
const password = process.env.EZIL_E2E_PASSWORD;
if (!email || !password) {
    console.error('SKIP: EZIL_E2E_EMAIL and EZIL_E2E_PASSWORD are required.');
    process.exit(2);
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch {
    const dir = process.env.PLAYWRIGHT_REQUIRE_DIR;
    if (dir) {
        try {
            ({ chromium } = createRequire(path.join(path.resolve(dir), 'noop.js'))('playwright'));
        } catch { /* Report the missing runner dependency below. */ }
    }
}
if (!chromium) {
    console.error('SKIP: Playwright is required to test the deployed App Store.');
    process.exit(2);
}

const screenshotDir = process.env.EZIL_E2E_SCREENSHOT_DIR;
const shapes = [
    { name: 'desktop', viewport: { width: 1440, height: 900 }, mobile: false },
    { name: 'phone', viewport: { width: 390, height: 844 }, mobile: true },
];

const browser = await chromium.launch();
try {
    for (const shape of shapes) {
        const context = await browser.newContext({
            viewport: shape.viewport,
            ...(shape.mobile ? {
                hasTouch: true,
                isMobile: true,
                deviceScaleFactor: 3,
                userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            } : {}),
        });
        try {
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));

            await page.goto(new URL('/login?returnUrl=%2Fos', app).toString(), { waitUntil: 'domcontentloaded' });
            await page.locator('#email').fill(email);
            await page.locator('#password').fill(password);
            await page.locator('form').filter({ has: page.locator('#email') })
                .locator('button[type="submit"]').click();
            await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 60_000 });
            await page.goto(new URL('/os', app).toString(), { waitUntil: 'domcontentloaded' });

            const dock = page.locator('.taskbar-item[data-app="app-store"]');
            await dock.waitFor({ timeout: 45_000 });
            assert.equal(await page.locator('.window[data-app="desktop"]').count(), 0);
            await dock.click();

            const store = page.locator('.window[data-app="app-store"]');
            await store.getByRole('heading', { name: 'Discover', exact: true }).waitFor();
            // On a phone the window covers the dock; there is no second visible
            // dock target until the window closes. Desktop can test focusing it.
            if (!shape.mobile) await dock.click();
            assert.equal(await store.count(), 1, 'the store must have one window');
            assert.ok(await store.locator('[data-catalog-app]').count() >= 1);

            if (screenshotDir) {
                await fs.mkdir(screenshotDir, { recursive: true });
                await page.screenshot({ path: path.join(screenshotDir, `app-store-${shape.name}.png`) });
            }

            await store.getByRole('searchbox', { name: 'Search apps' }).fill('reticle');
            assert.equal(await store.locator('[data-catalog-app]').count(), 1);
            assert.equal(await store.locator('[data-catalog-app="reticle"]').count(), 1);
            await store.getByRole('button', { name: 'Details for Reticle' }).click();
            assert.equal(await store.getByRole('heading', { name: 'Reticle', exact: true }).count(), 1);
            assert.match(await store.innerText(), /Not released/);
            assert.equal(await store.getByRole('button', { name: /^(Install|Open) Reticle$/ }).count(), 0);
            assert.equal(await page.locator('.window[data-app="desktop"]').count(), 0);
            assert.deepEqual(errors, [], 'the App Store must not throw in the browser');
            console.log(`PASS ${shape.name}: authenticated OS boots, App Store opens, search and Reticle details work`);
        } finally {
            await context.close();
        }
    }
} catch (error) {
    console.error(`FAIL production App Store: ${error?.stack ?? error}`);
    process.exitCode = 1;
} finally {
    await browser.close();
}
