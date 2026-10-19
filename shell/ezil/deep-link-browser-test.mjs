// Real Chromium acceptance for `/app/<name>` (`deep-link.js` + boot.js), on the
// built bundle. Fixtures isolate the shell; they do not establish
// authentication, the server route, or hosted runtime readiness.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const os = process.env.EZIL_OS_DIR || path.resolve(here, '../../app/public/os');
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
const origin = 'https://ezil-deep-link-test.invalid';
const code = 'A'.repeat(42) + 'w';
const errors = [];
let passed = 0;
let failed = 0;
const browser = await chromium.launch();

async function check (name, run) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}

/** Serve the `/os` document at `pathAndHash` (as the server does for `/app/<name>`), then boot the real bundle. */
async function arrive (pathAndHash, apps = [{ id: 'desktop' }]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    const requests = [];
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && (url.pathname === '/os' || url.pathname.startsWith('/app/'))) {
            return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>${assets['bundle.min.css']}</style></head><body><div id="ezil-os-root"></div></body></html>` });
        }
        requests.push(route.request().url());
        if (url.pathname.startsWith('/api/trpc/computer.list')) {
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { data: { json: [] } } }) });
        }
        if (url.pathname.startsWith('/api/telemetry')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"errorCode":"not_configured"}' });
    });
    await page.goto(`${origin}${pathAndHash}`);
    await page.evaluate(payload => { window.__EZIL_BOOT__ = payload; }, {
        user: { id: 'deep-link-user', email: 'test@ezil.test' },
        computer: { id: 'deep-link-computer', name: 'Test computer', slot: 1, createdAt: '2026-10-14T00:00:00.000Z', isNew: false },
        apps, desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle', endpoints: {} },
    });
    await page.addScriptTag({ content: assets['icons.js'] });
    await page.addScriptTag({ content: assets['bundle.min.js'] });
    await page.locator('.taskbar').waitFor();
    return { page, requests };
}

const where = page => page.evaluate(() => location.pathname + location.search + location.hash);

try {
    {
        const { page } = await arrive('/app/settings');
        await page.locator('.window[data-app="settings"]').waitFor();
        await check('/app/settings opens Settings in front', async () => {
            assert.equal(await page.locator('.window[data-app="settings"]').count(), 1);
            assert.equal(await page.locator('.window').count(), 1);
        });
        await check('/app/settings leaves the address bar on /os', async () => assert.equal(await where(page), '/os'));
        await page.close();
    }
    {
        const { page, requests } = await arrive(`/app/code?task=t-1&project=p-1&repository=r-1&ref=refs%2Fheads%2Fmain#c=${code}`);
        await page.locator('.window[data-app="code"]').waitFor();
        await check('/app/code opens the Code window', async () => assert.equal(await page.locator('.window[data-app="code"]').count(), 1));
        await check('🔴 the launch code is not sent anywhere by the shell', async () => {
            assert.ok(requests.every(url => !url.includes(code)), requests.filter(url => url.includes(code)).join(', '));
        });
        await check('🔴 the launch code is gone from the address bar and from history', async () => {
            assert.equal(await where(page), '/os');
            // The arrival entry was REPLACED, not pushed: Back leaves the page entirely
            // (to the blank tab it was opened from) instead of revisiting `#c=<code>`.
            await page.goBack();
            assert.ok(!page.url().includes(code), page.url());
            assert.ok(!page.url().startsWith(`${origin}/app/`), page.url());
        });
        await page.close();
    }
    {
        const { page } = await arrive('/app/no-such-app');
        await page.waitForTimeout(500);
        await check('an unknown app opens nothing, and the URL is /os', async () => {
            assert.equal(await page.locator('.window').count(), 0);
            assert.equal(await where(page), '/os');
        });
        await page.close();
    }
    {
        const { page } = await arrive('/app/desktop', []);
        await page.waitForTimeout(500);
        await check('an app this computer does not offer opens nothing', async () => {
            assert.equal(await page.locator('.window[data-app="desktop"]').count(), 0);
        });
        await page.close();
    }
    {
        const { page } = await arrive('/os');
        await page.waitForTimeout(500);
        await check('/os still opens nothing (login opens nothing)', async () => {
            assert.equal(await page.locator('.window').count(), 0);
            assert.equal(await where(page), '/os');
        });
        await page.close();
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
