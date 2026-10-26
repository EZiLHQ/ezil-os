// Local Chromium shell regression, with deterministic runtime/usage fixtures.
// This validates UI routing/preservation, not a live computer connection.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit', 'noop.js'));
const { chromium } = require('playwright');
const assets = new URL('../../app/public/os/', import.meta.url);
let usageFails = false;
const requests = [];
const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (['/bundle.min.js', '/icons.js', '/bundle.min.css'].includes(url.pathname)) {
        res.setHeader('content-type', url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript');
        res.end(readFileSync(new URL(url.pathname.slice(1), assets))); return;
    }
    requests.push(url.pathname);
    if (url.pathname === '/api/trpc/billing.usage') {
        res.setHeader('content-type', 'application/json');
        if (usageFails) { res.statusCode = 503; res.end('{}'); return; }
        res.end(JSON.stringify({ result: { data: { json: {
            enabled: true, version: 1, asOf: '2026-10-26T05:00:00Z',
            session: { state: 'stale', elapsedSeconds: 1200, startedAt: '2026-10-26T04:00:00Z', observedAt: '2026-10-26T04:20:00Z' },
            period: { unit: 'standard_seconds', usedStandardSeconds: 3600, allowanceStandardSeconds: 7200, remainingStandardSeconds: 3600, startsAt: '2026-10-01T00:00:00Z', resetsAt: '2026-11-01T00:00:00Z' },
            storage: { state: 'unavailable', capBytes: '2147483648', samples: [] }, egress: { state: 'unavailable', usedBytes: null },
        } } } })); return;
    }
    if (url.pathname.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result: { data: { json: [] } } })); return; }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><head><link rel="stylesheet" href="/bundle.min.css"></head><body><div id="ezil-os-root"></div><script src="/icons.js"></script><script src="/bundle.min.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
const computerId = '11111111-1111-4111-8111-111111111111';
await context.addInitScript(({ computerId }) => {
    window.__EZIL_BOOT__ = { user: { id: 'fixture-user', email: 'fixture@example.com' }, computer: { id: computerId, name: 'Fixture computer', slot: 1 }, apps: [{ id: 'desktop' }], desktopState: { provider: 'cloudflare-guacamole', configured: false } };
}, { computerId });
const windows = page => page.locator('.window[data-app]');
try {
    const page = await context.newPage();
    await page.goto(`${origin}/os?app=code&computer=${computerId}&path=%2Fproject%2Fa&project=demo`);
    await page.locator('.window[data-app="code"]').waitFor();
    assert.equal(await windows(page).count(), 1);
    await page.reload(); await page.locator('.window[data-app="code"]').waitFor();
    assert.equal(await windows(page).count(), 1);
    await page.locator('.taskbar-item[data-app="settings"]').click();
    await page.locator('[data-pane="account"].active').waitFor();
    await page.locator('.ezil-settings-tab[data-tab="appearance"]').click();
    await page.locator('.window[data-app="settings"] .window-close-btn').first().click();
    await page.locator('.window[data-app="settings"]').waitFor({ state: 'detached' });
    await page.locator('.taskbar-item[data-app="settings"]').click();
    await page.locator('[data-pane="account"].active').waitFor();
    await page.evaluate(() => { history.pushState({}, '', '?app=settings&settings=system'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.locator('[data-pane="system"].active').waitFor();
    await page.evaluate(() => { history.pushState({}, '', '?app=code'); dispatchEvent(new PopStateEvent('popstate')); dispatchEvent(new PopStateEvent('popstate')); });
    assert.equal(await windows(page).count(), 2);
    assert.equal(await page.locator('.window[data-app="code"]').count(), 1);
    const second = await context.newPage();
    await second.goto(`${origin}/os?app=browser`);
    await second.locator('.window[data-app="desktop"]').waitFor();
    assert.equal(await windows(second).count(), 1);
    assert.equal(await windows(page).count(), 2, 'second OS tab preserves first tab windows');
    await second.reload(); await second.locator('.window[data-app="desktop"]').waitFor();
    assert.equal(await windows(second).count(), 1);
    const ordinary = await context.newPage(); await ordinary.goto(`${origin}/os`);
    await ordinary.locator('.taskbar-item[data-app="settings"]').waitFor();
    assert.equal(await windows(ordinary).count(), 0);
    await ordinary.goto(`${origin}/os?app=code&app=browser`);
    await ordinary.locator('.taskbar-item[data-app="settings"]').waitFor();
    assert.equal(await windows(ordinary).count(), 0);
    const dir = process.env.EZIL_TEST_EVIDENCE_DIR;
    if (dir) { mkdirSync(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, 'ui-windows.png') }); }
    await ordinary.locator('.taskbar-item[data-app="settings"]').click();
    await ordinary.locator('.ezil-settings-tab[data-tab="usage"]').click();
    await ordinary.getByText('Last observation is stale', { exact: false }).waitFor();
    assert.ok((await ordinary.locator('[data-role="usage-body"]').textContent()).includes('Current total: unavailable'));
    assert.ok(!requests.includes('/api/trpc/billing.summary'), 'Usage does not invoke the billing summary side effects');
    if (dir) await ordinary.screenshot({ path: path.join(dir, 'ui-usage.png') });
    usageFails = true; await ordinary.getByRole('button', { name: 'Refresh', exact: true }).click();
    await ordinary.getByRole('alert').filter({ hasText: 'Could not load usage' }).waitFor();
    usageFails = false; await ordinary.getByRole('button', { name: 'Refresh', exact: true }).click();
    await ordinary.getByText('Last observation is stale', { exact: false }).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS local Chromium: fresh Code/Browser, refresh, Settings close/reopen/default/deep section, repeated target, two OS tabs, ordinary entry, invalid target, truthful Usage and failed-refresh recovery');
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
