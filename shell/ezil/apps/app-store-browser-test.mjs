// Real Chromium acceptance for the built bundle. Fixtures isolate the shell;
// they do not establish authentication or hosted runtime readiness.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const os = process.env.EZIL_OS_DIR || path.resolve(here, '../../../app/public/os');
let chromium;
try { ({ chromium } = await import('playwright')); } catch {
    const dir = process.env.PLAYWRIGHT_REQUIRE_DIR;
    if (dir) ({ chromium } = createRequire(path.join(path.resolve(dir), 'noop.js'))('playwright'));
}
if (!chromium || !fs.existsSync(path.join(os, 'bundle.min.js'))) {
    console.error('SKIP: install Playwright and build the shell before running this browser suite.');
    process.exit(2);
}

const assets = Object.fromEntries(['icons.js', 'bundle.min.js', 'bundle.min.css'].map(file => [file, fs.readFileSync(path.join(os, file), 'utf8')]));
const origin = 'https://ezil-store-test.invalid';
const errors = [];
let passed = 0;
let failed = 0;
const browser = await chromium.launch();

async function check (name, run) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}

async function boot ({ apps = [{ id: 'desktop' }], name = 'Test computer', width = 1280, mobile = false, configured = true } = {}) {
    const page = await browser.newPage({
        viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile,
        ...(mobile ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' } : {}),
    });
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    const requests = [];
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/os') {
            return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${assets['bundle.min.css']}</style></head><body><div id="ezil-os-root"></div></body></html>` });
        }
        requests.push({ path: url.pathname, method: route.request().method() });
        if (url.pathname.startsWith('/api/trpc/computer.list')) {
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data: { json: [] } } }) });
        }
        if (url.pathname.startsWith('/api/telemetry')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
        // Unexpected provider calls fail instead of fabricating a ready app.
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"errorCode":"not_configured"}' });
    });
    await page.goto(`${origin}/os`);
    await page.evaluate(payload => { window.__EZIL_BOOT__ = payload; }, {
        user: { id: 'store-test-user', email: 'test@ezil.test' },
        computer: { id: 'store-test-computer', name, slot: 1, createdAt: '2026-09-23T00:00:00.000Z', isNew: false },
        apps, desktopState: { provider: 'cloudflare-guacamole', configured, hasHmacSecret: configured, status: 'idle', endpoints: {} },
    });
    await page.addScriptTag({ content: assets['icons.js'] });
    await page.addScriptTag({ content: assets['bundle.min.js'] });
    await page.locator('.taskbar-item[data-app="app-store"]').waitFor();
    return { page, requests, store: page.locator('.window[data-app="app-store"]') };
}

try {
    const { page, store, requests } = await boot();
    const dock = page.locator('.taskbar-item[data-app="app-store"]');
    await check('login exposes the pinned store without opening any application', async () => {
        assert.equal(await page.locator('.window').count(), 0);
        assert.equal(await dock.getAttribute('title'), 'App Store');
    });
    await dock.click();
    await store.getByRole('heading', { name: 'Discover', exact: true }).waitFor();
    await check('dock opens a real catalog; repeated launch keeps one window', async () => {
        await dock.click();
        assert.equal(await store.count(), 1);
        assert.equal(await store.locator('[data-catalog-app]').count(), 5);
    });
    await check('search finds Reticle and its details honestly show no install or open action', async () => {
        await store.getByRole('searchbox', { name: 'Search apps' }).fill('RETICLE');
        assert.deepEqual(await store.locator('[data-catalog-app]').evaluateAll(items => items.map(item => item.dataset.catalogApp)), ['reticle']);
        await store.getByRole('button', { name: 'Details for Reticle' }).click();
        assert.equal(await store.getByRole('heading', { name: 'Reticle', exact: true }).count(), 1);
        assert.equal(await store.getByRole('button', { name: /^(Install|Open) Reticle$/ }).count(), 0);
        assert.match(await store.innerText(), /Not released/);
        const source = store.getByRole('link', { name: 'View source on GitHub' });
        assert.equal(await source.getAttribute('href'), 'https://github.com/reticlehq/reticle');
        assert.equal(await source.getAttribute('rel'), 'noopener noreferrer');
        await store.getByRole('button', { name: 'Back to Discover' }).click();
        assert.equal(await store.getByRole('searchbox').inputValue(), 'RETICLE');
        assert.equal(await store.getByRole('button', { name: 'Details for Reticle' }).evaluate(button => button === document.activeElement), true);
    });
    await check('empty search has a working recovery action', async () => {
        await store.getByRole('searchbox').fill('<script>missing</script>');
        assert.equal(await store.getByRole('heading', { name: 'No apps found' }).count(), 1);
        await store.getByRole('button', { name: 'Clear filters' }).click();
        assert.equal(await store.locator('[data-catalog-app]').count(), 5);
        assert.equal(await store.getByRole('searchbox').inputValue(), '');
    });
    await check('categories and Your apps exclude unrelated or unreleased apps', async () => {
        await store.getByRole('button', { name: 'Development', exact: true }).click();
        assert.deepEqual(await store.locator('[data-catalog-app]').evaluateAll(items => items.map(item => item.dataset.catalogApp)), ['code', 'preview', 'reticle']);
        await store.getByRole('button', { name: 'Your apps 4', exact: true }).click();
        assert.equal(await store.locator('[data-catalog-app]').count(), 4);
        assert.equal(await store.locator('[data-catalog-app="reticle"]').count(), 0);
    });
    await check('browsing the store does not start a computer or install anything', async () => {
        assert.deepEqual(requests.filter(request => request.path.startsWith('/api/') && !request.path.startsWith('/api/telemetry')), []);
        assert.deepEqual(await page.locator('.window').evaluateAll(items => items.map(item => item.dataset.app)), ['app-store']);
    });
    await check('Open launches the actual Settings window', async () => {
        await store.getByRole('button', { name: 'Open Settings', exact: true }).click();
        const settings = page.locator('.window[data-app="settings"]');
        await settings.getByRole('button', { name: 'Computers', exact: true }).waitFor();
        assert.equal(await settings.count(), 1);
        await settings.getByRole('button', { name: 'Close', exact: true }).click();
        await settings.waitFor({ state: 'detached' });
    });
    await check('closing keeps the dock entry and launcher reopens the store', async () => {
        await store.getByRole('button', { name: 'Close', exact: true }).click();
        await store.waitFor({ state: 'detached' });
        assert.equal(await dock.count(), 1);
        await page.locator('[title="Start"]').click();
        await page.locator('.context-menu .contextmenu-label').filter({ hasText: /^App Store$/ }).click();
        await store.getByRole('heading', { name: 'Discover', exact: true }).waitFor();
        assert.equal(await store.count(), 1);
    });
    await page.close();

    const gated = await boot({ apps: [], configured: false, name: '<img src=x onerror="window.storeInjection=true">' });
    await gated.page.locator('.taskbar-item[data-app="app-store"]').click();
    await check('catalog respects served apps and escapes the computer name', async () => {
        assert.equal(await gated.store.locator('[data-catalog-app="desktop"]').count(), 0);
        assert.equal(await gated.store.locator('.ezil-store-computer img').count(), 0);
        assert.match(await gated.store.locator('.ezil-store-computer').innerText(), /<img src=x/);
        assert.equal(await gated.page.evaluate(() => window.storeInjection), undefined);
        await gated.store.getByRole('button', { name: 'Details for Code' }).click();
        assert.match(await gated.store.innerText(), /This computer needs to be connected/);
    });
    await gated.page.close();

    for (const [width, mobile] of [[1280, false], [700, false], [390, true]]) {
        const responsive = await boot({ width, mobile });
        await responsive.page.locator('.taskbar-item[data-app="app-store"]').click();
        await check(`store remains usable at ${width}px${mobile ? ' on a phone' : ''}`, async () => {
            await responsive.store.getByRole('button', { name: 'Your apps 4', exact: true }).click();
            await responsive.store.getByRole('button', { name: 'Details for Code' }).click();
            await responsive.store.getByRole('button', { name: 'Back to your apps' }).click();
            const geometry = await responsive.store.evaluate(element => {
                const content = element.querySelector('.ezil-store-content');
                const rect = element.getBoundingClientRect();
                return { fits: content.scrollWidth <= content.clientWidth + 1, left: rect.left, right: rect.right, viewport: innerWidth };
            });
            assert.equal(geometry.fits, true);
            assert.ok(geometry.left >= -1 && geometry.right <= geometry.viewport + 1);
        });
        await responsive.page.close();
    }
    await check('no uncaught browser errors', () => assert.deepEqual(errors, []));
} catch (error) {
    failed++;
    console.error(`FAIL browser setup or interaction: ${error.stack}`);
} finally {
    await browser.close();
}
console.log(`\n${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
