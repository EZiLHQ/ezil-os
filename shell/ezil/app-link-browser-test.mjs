// Local Chromium shell regression, with deterministic runtime/usage fixtures.
// This validates UI routing/preservation, not a live computer connection.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit', 'noop.js'));
let checks = 0;
for (const name of ['equal', 'deepEqual', 'ok']) { const original = assert[name]; assert[name] = (...args) => { checks += 1; return original(...args); }; }
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('SKIP playwright not resolvable (set PLAYWRIGHT_REQUIRE_DIR)'); process.exit(2); }
// EZIL_SHELL_OUT_DIR: a bundle built from this tree (`build-shell.sh` honours the same variable).
const assets = process.env.EZIL_SHELL_OUT_DIR || fileURLToPath(new URL('../../app/public/os/', import.meta.url));
let usageFails = false;
const requests = [];
// Anything the page asked for that this host does not serve. The shell is
// served at `/os` AND at `/app/<id>`, so a URL resolved against the
// document instead of being absolute shows up here as a 404.
const missing = [];
const TYPES = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Where the real page (`app/src/app/os/page.tsx`) loads them from.
    if (url.pathname.startsWith('/os/')) {
        const file = path.join(assets, url.pathname.slice('/os/'.length));
        if (file.startsWith(path.join(assets, path.sep)) && existsSync(file) && statSync(file).isFile()) {
            res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
            res.end(readFileSync(file)); return;
        }
        missing.push(url.pathname); res.statusCode = 404; res.end(); return;
    }
    if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
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
    // The two document routes, as the Next app serves them; nothing else.
    if (url.pathname !== '/os' && !/^\/app\/[a-z0-9-]+$/.test(url.pathname)) { missing.push(url.pathname); res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><head><link rel="stylesheet" href="/os/bundle.min.css"></head><body><div id="ezil-os-root"></div><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script></body></html>');
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
    // What Next's App Router does on hydration: its keys, merged into
    // whatever the entry already carried. Its popstate handler RELOADS on an
    // entry without `__NA`; count any traversal that would have.
    history.replaceState({ ...history.state, __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['', {}], renderedSearch: '' } }, '', location.href);
    window.__reloadingPops = 0;
    addEventListener('popstate', event => { if (event.state && !event.state.__NA) window.__reloadingPops += 1; });
}, { computerId });
const windows = page => page.locator('.window[data-app]');
// ── Code's geometry (docs/APP-CODE-FULL-VIEW.md §1) ──────────────────────────
// Read once nothing is moving the window: no jQuery animation (UIWindow opens
// with one, and its end used to write 980x680 back over full view), no CSS
// transition (`showWindow` restores with one), then two frames; twice, two
// frames apart, so a late write shows as `stable: false`. No timed waits.
const geometry = async page => {
    await page.waitForFunction(() => {
        const w = document.querySelector('.window[data-app="code"]');
        return !!w && !window.$(w).is(':animated') && w.getAnimations().length === 0;
    }, null, { timeout: 5000 });
    const read = () => page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const w = document.querySelector('.window[data-app="code"]');
        const r = w.getBoundingClientRect(), b = w.querySelector(':scope > .window-body').getBoundingClientRect();
        const hit = (x, y) => document.elementFromPoint(x, y)?.closest('.window') === w;
        return { rect: [r.x, r.y, r.width, r.height], body: [b.x, b.y, b.width, b.height], vp: [innerWidth, innerHeight],
            strip: Number.parseFloat(getComputedStyle(w).getPropertyValue('--ezil-control-strip-height')),
            opacity: getComputedStyle(w).opacity, full: w.classList.contains('ezil-fullbleed'),
            hits: hit(innerWidth / 2, innerHeight / 2) && hit(1, innerHeight - 1) && hit(innerWidth - 1, innerHeight - 1) };
    });
    const first = await read(), second = await read();
    return { ...second, stable: JSON.stringify(first) === JSON.stringify(second) };
};
// Within a pixel, value by value, rounded: this suite runs on every OS (ci.yml's
// portable family), and macOS Chromium can settle a box a pixel off Linux's
// (run-tests.sh, "CI FAMILY SPLIT"). The defects below miss by hundreds.
const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1);
const px = a => a.map(Math.round);
// Full view: the window IS the viewport, the body runs from the strip to the bottom edge, opaque, on top.
const fills = g => g.stable && g.full && g.strip > 0 && g.opacity === '1' && g.hits
    && near(g.rect, [0, 0, ...g.vp]) && near(g.body, [0, g.strip, g.vp[0], g.vp[1] - g.strip]);
const resize = async (page, width, height) => {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height]);
};
try {
    const page = await context.newPage();
    await page.goto(`${origin}/os?app=code&computer=${computerId}&path=%2Fproject%2Fa&project=demo`);
    await page.locator('.window[data-app="code"]').waitFor();
    assert.equal(await windows(page).count(), 1);
    await page.reload(); await page.locator('.window[data-app="code"]').waitFor();
    assert.equal(await windows(page).count(), 1);
    // The route opens Code in full view (APP-ROUTES §3), which hides the
    // dock; Code's own "Restore window" control gives it back.
    await page.locator('.window[data-app="code"].ezil-fullbleed').waitFor();
    assert.equal(await page.locator('.taskbar').isVisible(), false, 'the Code link opens in full view, without the dock');
    await page.locator('.window[data-app="code"] > .ezil-full-view-bar [data-action="restore"]').click();
    await page.locator('.taskbar-item[data-app="settings"]').waitFor({ state: 'visible' });
    await page.locator('.taskbar-item[data-app="settings"]').click();
    await page.locator('[data-pane="account"].active').waitFor();
    await page.locator('.ezil-settings-tab[data-tab="appearance"]').click();
    await page.locator('.window[data-app="settings"] .window-close-btn').first().click();
    await page.locator('.window[data-app="settings"]').waitFor({ state: 'detached' });
    await page.locator('.taskbar-item[data-app="settings"]').click();
    await page.locator('[data-pane="account"].active').waitFor();
    await page.evaluate(() => { history.pushState({ __NA: true }, '', '/os?app=settings&settings=system'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.locator('[data-pane="system"].active').waitFor();
    await page.evaluate(() => { history.pushState({ __NA: true }, '', '/os?app=code'); dispatchEvent(new PopStateEvent('popstate')); dispatchEvent(new PopStateEvent('popstate')); });
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
    await ordinary.locator('[data-usage="session"]', { hasText: 'Measuring this session…' }).waitFor();
    assert.ok((await ordinary.locator('[data-role="usage-body"]').textContent()).includes('Not measured yet'));
    // billing.summary has side effects: read at most once when Usage opens, never on the 30 s poll.
    assert.ok(requests.filter(p => p === '/api/trpc/billing.summary').length <= 1, 'Usage reads the billing summary at most once per open');
    if (dir) await ordinary.screenshot({ path: path.join(dir, 'ui-usage.png') });
    usageFails = true; await ordinary.getByRole('button', { name: 'Refresh', exact: true }).click();
    await ordinary.getByRole('alert').filter({ hasText: "Couldn't refresh. Showing the last update from" }).waitFor();
    assert.ok((await ordinary.locator('[data-usage="session"]').textContent()).includes('Measuring this session…'));
    assert.ok((await ordinary.locator('[data-usage="session"]').textContent()).includes('20 min'), 'failed refresh retains recorded runtime');
    usageFails = false; await ordinary.getByRole('button', { name: 'Refresh', exact: true }).click();
    await ordinary.locator('[data-usage="session"]', { hasText: 'Measuring this session…' }).waitFor();
    // ── /app/<id> routes and the history contract (docs/APP-ROUTES.md) ────
    const nav = await context.newPage();
    const failed = [];
    nav.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    const where = () => nav.evaluate(() => [location.pathname + location.search, history.length]);
    // Settled, then focused: a launch re-asserts its window's focus 120ms
    // later (`ensureOnTop` in registry.js), and acting inside that window is
    // faster than a person and races it.
    const active = async id => { await nav.locator(`.window[data-app="${id}"].window-active`).waitFor(); await nav.waitForTimeout(300); };
    await nav.goto(`${origin}/os?app=settings&computer=${computerId}`);
    await active('settings');
    const [entry, base] = await where();
    assert.equal(entry, `/app/settings?computer=${computerId}`, 'the alias is rewritten to /app/<id> in place');
    await nav.reload(); await active('settings');
    assert.deepEqual(await where(), [entry, base], 'a reload of /app/settings serves the shell and reopens Settings');
    await nav.locator('.taskbar-item[data-app="code"]').click();
    await nav.locator('.window[data-app="code"]').waitFor(); await active('code');
    assert.deepEqual(await where(), [`/app/code?computer=${computerId}`, base + 1], 'a dock launch pushes one entry');
    await nav.locator('.taskbar-item[data-app="code"]').click(); await nav.waitForTimeout(300);
    assert.deepEqual(await where(), [`/app/code?computer=${computerId}`, base + 1], 'clicking the app already in the address bar pushes nothing');
    await nav.goBack(); await active('settings');
    assert.deepEqual(await where(), [entry, base + 1], 'Back returns to /app/settings');
    assert.equal(await windows(nav).count(), 2, 'Back focused Settings and closed nothing');
    await nav.goForward(); await active('code');
    assert.deepEqual(await where(), [`/app/code?computer=${computerId}`, base + 1], 'Forward re-focuses Code');
    assert.equal(await windows(nav).count(), 2);
    // `focusWindow` is where every click on a window lands (the windows
    // overlap here: Settings opens maximised over Code's head).
    const focus = id => nav.evaluate(app => window.$(`.window[data-app="${app}"]`).focusWindow(), id);
    await focus('settings'); await active('settings');
    assert.deepEqual(await where(), [entry, base + 1], 'a focus change replaces the entry');
    await focus('code'); await active('code');
    assert.deepEqual(await where(), [`/app/code?computer=${computerId}`, base + 1]);
    await nav.reload(); await active('code');
    assert.deepEqual(await where(), [`/app/code?computer=${computerId}`, base + 1], 'a reload of /app/code serves the shell and reopens Code');
    assert.equal(await windows(nav).count(), 1, 'a reload opens only the app the URL names');
    await nav.goBack(); await nav.locator('.window[data-app="settings"]').waitFor();
    assert.equal((await where())[0], entry, 'Back across a reload still lands on Settings');
    assert.equal(await nav.evaluate(() => window.__reloadingPops), 0, 'no traversal landed on an entry Next would reload for');
    for (const bad of [`/app/code?project=${computerId}&project=${computerId}`, '/os?app=code&app=browser', '/app/code?app=browser']) {
        await nav.goto(`${origin}${bad}`); await nav.locator('.taskbar-item[data-app="settings"]').waitFor(); await nav.waitForTimeout(300);
        assert.equal(await windows(nav).count(), 0, `${bad} opens nothing`);
        assert.equal((await where())[0], bad, `${bad} is left as it was`);
    }
    await nav.goto(`${origin}/app/browser`); await nav.locator('.window[data-app="desktop"]').waitFor();
    assert.equal((await where())[0], '/app/desktop', 'the browser alias becomes the registry id');
    // ── the entry follows the screen (docs/APP-ROUTES.md §5 "State") ───────
    // Back never resizes an open Code, so the entry it lands on takes the
    // view Code shows now, and a reload of that entry reopens Code that way.
    // E1: Code from /app/code, full. Minimised from full view (the dock comes
    // back), Settings from the dock pushes E2, Code's dock icon pushes E3
    // (Code comes back full). Restore window on E3, then Back, Back to E1,
    // which still said full. Positive control: no Restore, full throughout.
    // No timed waits: each step waits for the page or the window it needs.
    // A launch commits right after its window is built (microtasks), so the
    // next `evaluate` reads the entry as written.
    for (const restore of [true, false]) {
        const tab = await context.newPage();
        const label = restore ? 'Restore window' : 'positive control, no Restore';
        const now = () => tab.evaluate(() => [location.pathname, history.length, history.state?.ezilView ?? null,
            document.querySelector('.window[data-app="code"]')?.classList.contains('ezil-fullbleed') ?? null, window.__reloadingPops]);
        const fullCode = tab.locator('.window[data-app="code"].ezil-fullbleed');
        const bar = action => tab.locator(`.window[data-app="code"] > .ezil-full-view-bar [data-action="${action}"]`).click();
        const at = pathname => tab.waitForFunction(p => location.pathname === p, pathname);
        await tab.goto(`${origin}/app/code`);
        await fullCode.waitFor();
        const base = (await now())[1];
        assert.deepEqual(await now(), ['/app/code', base, 'full', true, 0], `${label}: E1, Code full from its route, and E1 says so`);
        let g = await geometry(tab);
        assert.ok(fills(g), `🔴 ${label}: E1, the first load of /app/code FILLS the viewport (not 980x680 at 0,0): ${JSON.stringify(g)}`);
        await bar('minimize');
        await tab.locator('.taskbar-item[data-app="settings"]').click();
        await tab.locator('.window[data-app="settings"].window-active').waitFor(); await at('/app/settings');
        await tab.locator('.taskbar-item[data-app="code"]').click();
        await at('/app/code'); await fullCode.waitFor();
        assert.deepEqual(await now(), ['/app/code', base + 2, 'full', true, 0], `${label}: E3, Code back from the dock in full view`);
        g = await geometry(tab);
        assert.ok(fills(g), `🔴 ${label}: E3, back from the dock it FILLS the viewport: ${JSON.stringify(g)}`);
        // The viewport changes while Code is open. The minimise above left a
        // 1280x800 snapshot on the window, which `showWindow` used to write
        // back when Back/Forward relaunched the open window.
        await resize(tab, 1100, 700);
        g = await geometry(tab);
        assert.ok(fills(g) && g.vp[0] === 1100, `🔴 ${label}: a viewport resize while full keeps filling: ${JSON.stringify(g)}`);
        let windowed = null;
        if ( restore ) {
            const stash = await tab.evaluate(() => { const d = document.querySelector('.window[data-app="code"]').dataset;
                return [d.ezilPrevFpLeft, d.ezilPrevFpTop, d.ezilPrevFpWidth, d.ezilPrevFpHeight].map(Number.parseFloat); });
            await bar('restore'); await fullCode.waitFor({ state: 'detached' });
            assert.deepEqual(await now(), ['/app/code', base + 2, 'window', false, 0], 'Restore window, recorded on E3');
            g = await geometry(tab); windowed = g.rect;
            assert.deepEqual([near(windowed, stash), px(windowed.slice(2)), g.stable], [true, [980, 680], true],
                'positive control: Restore window lands on the 980x680 box Code had before full view (to the pixel), not the viewport');
        }
        await tab.goBack(); await at('/app/settings');
        await tab.goBack(); await at('/app/code');
        assert.deepEqual(await now(), ['/app/code', base + 2, restore ? 'window' : 'full', ! restore, 0],
            restore ? '🔴 Back to E1: Code stays windowed, and E1 takes its view' : `${label}: Back to E1, full`);
        // Back focuses Code 80ms after `showWindow` (Settings is in front until then).
        await tab.locator('.window[data-app="code"].window-active').waitFor();
        g = await geometry(tab);
        if ( restore ) assert.deepEqual([g.rect, g.stable], [windowed, true], '🔴 Back onto the open, windowed Code leaves its box exactly where it was');
        else assert.ok(fills(g) && g.vp[0] === 1100, `🔴 ${label}: Back onto the open full Code leaves it filling the RESIZED viewport: ${JSON.stringify(g)}`);
        await tab.reload();
        await tab.locator('.window[data-app="code"].ezil-full-view-host').waitFor();
        assert.deepEqual(await now(), ['/app/code', base + 2, restore ? 'window' : 'full', ! restore, 0],
            restore ? '🔴 a reload of E1 opens Code WINDOWED, as it was on screen' : `${label}: a reload of E1 opens Code full`);
        g = await geometry(tab);
        if ( restore ) assert.deepEqual([px(g.rect.slice(2)), g.full], [[980, 680], false], 'positive control: the windowed reload opens at 980x680');
        else assert.ok(fills(g) && g.vp[0] === 1100, `🔴 ${label}: the reload FILLS the viewport: ${JSON.stringify(g)}`);
        await tab.close();
    }
    // ── two more ways a NEW Code window opens straight into full view ──────
    // Back to an entry whose Code was closed (its recorded view, 'full'), and a
    // dock launch after the user's last choice was full (`ezil-os:view.code`).
    // Both build the window and enter full view in the same turn, as a first
    // load does. Positive control: the dock's first, windowed open.
    {
        const tab = await context.newPage();
        const at = pathname => tab.waitForFunction(p => location.pathname === p, pathname);
        const code = tab.locator('.window[data-app="code"]');
        const bar = action => tab.locator(`.window[data-app="code"] > .ezil-full-view-bar [data-action="${action}"]`).click();
        await tab.goto(`${origin}/app/code`);
        await tab.locator('.window[data-app="code"].ezil-fullbleed').waitFor();
        await bar('minimize');
        await tab.locator('.taskbar-item[data-app="settings"]').click();
        await tab.locator('.window[data-app="settings"].window-active').waitFor(); await at('/app/settings');
        await tab.evaluate(() => window.$('.window[data-app="code"]').close());
        await code.waitFor({ state: 'detached' });
        await tab.goBack(); await at('/app/code');
        await tab.locator('.window[data-app="code"].ezil-fullbleed.window-active').waitFor();
        let g = await geometry(tab);
        assert.ok(fills(g), `🔴 Back to a closed Code reopens it full, FILLING the viewport: ${JSON.stringify(g)}`);
        await bar('close'); await code.waitFor({ state: 'detached' });
        await tab.locator('.taskbar-item[data-app="code"]').click();
        await code.waitFor();
        g = await geometry(tab);
        assert.deepEqual([px(g.rect.slice(2)), g.full], [[980, 680], false], 'positive control: a dock launch with no remembered choice opens windowed, 980x680');
        await tab.locator('.window[data-app="code"] > .window-head .window-scale-btn').click();
        await tab.locator('.window[data-app="code"].ezil-fullbleed').waitFor();
        g = await geometry(tab);
        assert.ok(fills(g), `🔴 the green button on a windowed Code FILLS the viewport: ${JSON.stringify(g)}`);
        await bar('close'); await code.waitFor({ state: 'detached' });
        await tab.locator('.taskbar-item[data-app="code"]').click();
        await tab.locator('.window[data-app="code"].ezil-fullbleed').waitFor();
        g = await geometry(tab);
        assert.ok(fills(g), `🔴 a dock launch remembering full opens straight into full view, FILLING the viewport: ${JSON.stringify(g)}`);
        await tab.close();
    }
    // 🔴 PRE-EXISTING, NOT A ROUTE ARTIFACT: `bundle.min.css` carries jQuery
    // UI's theme sprites as `url("images/ui-icons_*.png")`, which resolve
    // against the STYLESHEET (`/os/bundle.min.css`), and `build-shell.sh`
    // ships no `images/`. Proved path-independent below: the same requests
    // fail from a page at `/os`. Anything else is a failure of this suite.
    const sprite = request => /^\/os\/images\/ui-icons_[0-9a-f]+_256x240\.png$/.test(request.replace(/^\d+ /, ''));
    const atOs = await context.newPage();
    const osFailed = [];
    atOs.on('response', response => { if (response.status() >= 400) osFailed.push(`${response.status()} ${new URL(response.url()).pathname}`); });
    await atOs.goto(`${origin}/os`); await atOs.locator('.taskbar-item[data-app="settings"]').click();
    await atOs.locator('.window[data-app="settings"]').waitFor(); await atOs.locator('.taskbar-item[data-app="code"]').click();
    await atOs.locator('.window[data-app="code"]').waitFor(); await atOs.waitForTimeout(500);
    assert.deepEqual(failed.filter(request => !sprite(request)), [], 'no asset, icon or page 404 at /app/<id>');
    assert.ok([...new Set(failed)].every(request => osFailed.includes(request)), `every /app 404 also happens at /os: ${[...new Set(failed)]} vs ${[...new Set(osFailed)]}`);
    assert.deepEqual(missing.filter(request => !sprite(request)), [], 'nothing was requested from a path this host does not serve');
    assert.ok(!missing.some(request => request.startsWith('/app/')), 'nothing resolved against /app/');
    assert.deepEqual(errors, []);
    console.log(`PASS ${checks} checks, local Chromium: fresh Code/Browser, refresh, Settings close/reopen/default/deep section, repeated target, two OS tabs, ordinary entry, invalid target, truthful Usage and failed-refresh recovery, /app/<id> reloads (no route-specific 404; the jQuery UI sprite 404 is the same at /os), alias canonicalisation, gesture-only pushes, Back/Forward focus without closing, the entry follows the screen (Back, Back, reload: Code windowed as on screen; full as control), invalid links`);
} finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
