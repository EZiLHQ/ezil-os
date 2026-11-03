// browser-route-browser-test.mjs — a shared Browser link, end to end in
// Chromium: the real shell bundle, the real app link parser and history owner,
// and the app's REAL return-URL rules (`app/src/utils/constants.ts`:
// `isShellAppId`, `returnUrlFor`, `safeReturnUrl`).
//
// 🔴 FIXTURES, NOT STAGING. The document gate, the computer lookup and the
// identity provider below are this file's stand-ins, labelled as such on every
// page they serve:
//   - the gate mirrors `app/src/app/os/page.tsx` + `app/[appId]/page.tsx`
//     (404 for an id outside the allowlist; signed out → `/login?returnUrl=`
//     built by `returnUrlFor`; a `computer` that is not the signed-in user's →
//     "Couldn't open your computer", never another computer). Those server
//     rules are pinned against the real page in `app/src/app/os/page.test.ts`.
//   - "FIXTURE IdP" stands in for EZiL ID: it signs in one of two fixture
//     users and returns to `safeReturnUrl(returnUrl)`, as the real callbacks
//     do. It is not Auth0 and proves nothing about the real login pages.
//   - `/api/shell/desktop` (the Browser's start/attach) is COUNTED and refused;
//     no computer exists.
// No external host is reachable: Chromium resolves every name but 127.0.0.1
// to nothing, so a forged return URL can only fail closed or stay local.
//
// Run: cd shell && node ezil/browser-route-browser-test.mjs (EZIL_SHELL_OUT_DIR: a bundle built from this tree)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The return-URL rules are TypeScript. Node 24 strips types by default; the
// portable CI job runs Node 22, which needs the flag, so ask for it once.
// Once only: a child that still cannot strip types fails below, never relaunches.
if (!process.features?.typescript && process.env.EZIL_STRIP_TYPES_RELAUNCHED !== '1') {
    const { spawnSync } = await import('node:child_process');
    process.exit(spawnSync(process.execPath, ['--experimental-strip-types', ...process.argv.slice(1)],
        { stdio: 'inherit', env: { ...process.env, EZIL_STRIP_TYPES_RELAUNCHED: '1' } }).status ?? 1);
}
const require = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit', 'noop.js'));
let checks = 0;
for (const name of ['equal', 'deepEqual', 'ok', 'match']) { const original = assert[name]; assert[name] = (...args) => { checks += 1; return original(...args); }; }
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('SKIP playwright not resolvable (set PLAYWRIGHT_REQUIRE_DIR)'); process.exit(2); }
// The app's own rules, not a copy (Node strips the types).
const { isShellAppId, returnUrlFor, shellAppRoute, getReturnUrlQueryParam, safeReturnUrl, Routes } =
    await import(new URL('../../app/src/utils/constants.ts', import.meta.url).href);
const assets = process.env.EZIL_SHELL_OUT_DIR || fileURLToPath(new URL('../../app/public/os/', import.meta.url));

const USERS = {
    a: { id: 'fixture-user-a', email: 'fixture-a@example.com', computer: '11111111-1111-4111-8111-111111111111' },
    b: { id: 'fixture-user-b', email: 'fixture-b@example.com', computer: '22222222-2222-4222-8222-222222222222' },
};
const P = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const R = '12345678-9abc-4def-8123-456789abcdef';
const TYPES = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const FIXTURE = '<p data-fixture>FIXTURE — local test server, not EZiL staging</p>';
/** Every document the gate answered, and every Browser start it was asked for. */
const documents = [];
const starts = [];
/** Shell assets the page asked for that the bundle does not ship. */
const missingAssets = [];
const sessionOf = req => /(?:^|;\s*)fixture_session=([ab])(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
const html = (res, body, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><html><body>${body}</body></html>`); };
/** Next hands the page decoded search params, a repeated key as an array. */
const record = search => {
    const out = {};
    for (const [key, value] of search) out[key] = key in out ? [].concat(out[key], value) : value;
    return out;
};
const bootPayload = user => ({
    user: { id: user.id, email: user.email },
    computer: { id: user.computer, name: 'Fixture computer', slot: 1 },
    apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
    desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle', endpoints: { desktop: '/api/shell/desktop' } },
});
const body = req => new Promise(resolve => { let text = ''; req.on('data', chunk => { text += chunk; }); req.on('end', () => resolve(text)); });

const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/os/')) {
        const file = path.join(assets, url.pathname.slice('/os/'.length));
        if (file.startsWith(path.join(assets, path.sep)) && existsSync(file) && statSync(file).isFile()) {
            res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
            res.end(readFileSync(file)); return;
        }
        missingAssets.push(url.pathname); res.statusCode = 404; res.end(); return;
    }
    if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
    // FIXTURE IdP: the real login page and callbacks end in `safeReturnUrl(returnUrl)`.
    if (url.pathname === Routes.LOGIN) {
        const returnUrl = url.searchParams.get('returnUrl') ?? '';
        html(res, `${FIXTURE}<h1>FIXTURE IdP — not EZiL ID</h1><form method="post" action="/fixture-idp/callback">
            <input type="hidden" name="returnUrl" value="${returnUrl.replace(/[&"<>]/g, c => `&#${c.charCodeAt(0)};`)}">
            <button name="user" value="a">Sign in as fixture user A</button><button name="user" value="b">Sign in as fixture user B</button></form>`);
        return;
    }
    if (url.pathname === '/fixture-idp/callback' && req.method === 'POST') {
        const form = new URLSearchParams(await body(req));
        const user = form.get('user') === 'a' ? 'a' : 'b';
        res.statusCode = 303;
        res.setHeader('set-cookie', `fixture_session=${user}; Path=/; HttpOnly; SameSite=Lax`);
        res.setHeader('location', safeReturnUrl(form.get('returnUrl')));
        res.end(); return;
    }
    if (url.pathname === '/computers') { html(res, `${FIXTURE}<h1 data-page="computers">Your computers (fixture)</h1>`); return; }
    if (url.pathname === '/api/shell/desktop' && req.method === 'POST') {
        let computerId = null;
        try { computerId = JSON.parse(await body(req)).computerId ?? null; } catch { /* recorded as null */ }
        starts.push({ user: sessionOf(req), computerId });
        res.statusCode = 412; res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: false, errorCode: 'fixture_no_computer', message: 'Fixture: no computer exists.' })); return;
    }
    if (url.pathname.startsWith('/api/')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result: { data: { json: [] } } })); return; }
    // The document gate (mirrors os/page.tsx and app/[appId]/page.tsx).
    const appMatch = /^\/app\/([^/]+)$/.exec(url.pathname);
    if (url.pathname !== '/os' && !appMatch) { html(res, `${FIXTURE}<h1>404</h1>`, 404); return; }
    const appId = appMatch ? decodeURIComponent(appMatch[1]) : undefined;
    if (appId !== undefined && !isShellAppId(appId)) { documents.push({ path: url.pathname, outcome: '404' }); html(res, `${FIXTURE}<h1>404</h1>`, 404); return; }
    const who = sessionOf(req);
    if (!who) {
        const returnUrl = returnUrlFor(appId === undefined ? Routes.OS : shellAppRoute(appId), record(url.searchParams));
        documents.push({ path: url.pathname, outcome: 'login' });
        res.statusCode = 307; res.setHeader('location', `${Routes.LOGIN}?${getReturnUrlQueryParam(returnUrl)}`); res.end(); return;
    }
    const user = USERS[who];
    const computer = url.searchParams.getAll('computer');
    if (computer.length > 0 && !(computer.length === 1 && computer[0].toLowerCase() === user.computer)) {
        // os/page.tsx: an invalid or unowned target is NOT_FOUND → CouldNotOpen; the default is never substituted.
        documents.push({ path: url.pathname, user: who, outcome: 'could-not-open' });
        html(res, `${FIXTURE}<h1 data-page="could-not-open">Couldn't open your computer</h1>`); return;
    }
    documents.push({ path: url.pathname, user: who, outcome: 'shell' });
    html(res, `<link rel="stylesheet" href="/os/bundle.min.css"><div id="ezil-os-root"></div>
        <script>window.__EZIL_BOOT__ = ${JSON.stringify(bootPayload(user))};</script><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
    headless: true,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
});
const errors = [];
const foreign = [];
/** Console lines, printed only when a check fails (diagnosis, not an assertion). */
const consoleTail = [];
const fresh = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.on('page', page => {
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => consoleTail.push(`${message.type()} ${message.text()}`.slice(0, 300)));
    });
    context.on('request', request => { if (!request.url().startsWith(origin)) foreign.push(request.url()); });
    // What Next's App Router does on hydration (app-link-browser-test.mjs).
    await context.addInitScript(() => {
        history.replaceState({ ...history.state, __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['', {}], renderedSearch: '' } }, '', location.href);
    });
    return context;
};
const signIn = async (context, user) => context.addCookies([{ name: 'fixture_session', value: user, url: origin }]);
const where = page => page.evaluate(() => [location.pathname + location.search + location.hash, history.length]);
const browserWindows = page => page.locator('.window[data-app="desktop"]').count();
// Settled, then focused: a launch re-asserts its window's focus 120ms later (`ensureOnTop`).
const active = async (page, id) => { await page.locator(`.window[data-app="${id}"].window-active`).waitFor(); await page.waitForTimeout(300); };
const startsSince = n => starts.slice(n);
const A = USERS.a, B = USERS.b;

try {
    // ── 1. A fresh shared link, signed out → FIXTURE IdP → the Browser ──────
    {
        const context = await fresh();
        const page = await context.newPage();
        const before = starts.length;
        await page.goto(`${origin}/app/browser?x=1#frag`);
        await page.locator('h1', { hasText: 'FIXTURE IdP' }).waitFor();
        const login = new URL(page.url());
        assert.equal(login.pathname, '/login', '1: signed out, the link goes to sign-in');
        assert.equal(login.searchParams.get('returnUrl'), '/app/browser?x=1', '1: the return URL is the canonical link, query kept');
        const hashAtLogin = login.hash;
        assert.deepEqual(startsSince(before), [], '1: nothing is started for a signed-out visitor');
        await page.getByRole('button', { name: 'Sign in as fixture user B' }).click();
        await page.locator('.window[data-app="desktop"]').waitFor();
        await active(page, 'desktop');
        const [url, length] = await where(page);
        assert.equal(url.split('#')[0], '/app/browser?x=1', '1: after sign-in the shell is at the canonical Browser link');
        assert.equal(await browserWindows(page), 1, '1: exactly one Browser window');
        assert.equal(await page.locator('.window[data-app]').count(), 1, '1: and nothing else');
        const opened = startsSince(before);
        assert.ok(opened.length >= 1 && opened.every(s => s.user === 'b' && s.computerId === B.computer),
            `1: the Browser asks to start the SIGNED-IN user's own computer only: ${JSON.stringify(opened)}`);
        console.log(`MEASURED 1: hash at the gate's redirect target ${JSON.stringify(hashAtLogin)}; after the FIXTURE IdP form ${JSON.stringify(url.includes('#') ? url.slice(url.indexOf('#')) : '')}; history.length ${length}; Browser start requests on load ${opened.length} (no click)`);
        await context.close();
    }

    // ── 2. Already signed in: the canonical link, the legacy links ──────────
    const context = await fresh();
    await signIn(context, 'b');
    for (const [entry, canonical] of [
        ['/app/browser', '/app/browser'],
        [`/app/desktop?computer=${B.computer}&x=%41#top`, `/app/browser?computer=${B.computer}&x=%41#top`],
        ['/os?app=desktop', '/app/browser'],
        ['/os?app=browser&x=1', '/app/browser?x=1'],
    ]) {
        const page = await context.newPage();
        const before = starts.length;
        await page.goto(`${origin}${entry}`);
        await active(page, 'desktop');
        // A new tab's about:blank, then the link: canonicalising added no entry.
        assert.deepEqual(await where(page), [canonical, 2], `2: ${entry} → ${canonical} in place, no new entry`);
        assert.equal(await browserWindows(page), 1, `2: ${entry} opens one Browser`);
        assert.ok(startsSince(before).every(s => s.computerId === B.computer), `2: ${entry} starts only B's computer`);
        // ── 3. Refresh keeps the canonical link and one Browser ────────────
        await page.reload(); await active(page, 'desktop');
        assert.deepEqual(await where(page), [canonical, 2], `3: a reload of ${canonical} stays put`);
        assert.equal(await browserWindows(page), 1, `3: one Browser after the reload of ${canonical}`);
        await page.close();
    }

    // ── 4. Back/Forward between the Browser, Settings and Code ─────────────
    {
        const page = await context.newPage();
        await page.goto(`${origin}/app/desktop?computer=${B.computer}`);
        await active(page, 'desktop');
        const [entry, base] = await where(page);
        assert.equal(entry, `/app/browser?computer=${B.computer}`);
        // A real click: the dock's Settings, or the Browser's drawer when it is full-bleed and hides the dock.
        if (await page.locator('.taskbar-item[data-app="settings"]').isVisible()) await page.locator('.taskbar-item[data-app="settings"]').click();
        else {
            await page.locator('.window[data-app="desktop"] .dashboard-app-drawer-toggle').click();
            await page.locator('.window[data-app="desktop"] .ezil-app-drawer [aria-label="Settings"]').click();
        }
        await active(page, 'settings');
        assert.deepEqual(await where(page), [`/app/settings?computer=${B.computer}`, base + 1], '4: a launch pushes one entry');
        await page.goBack(); await active(page, 'desktop');
        assert.deepEqual(await where(page), [entry, base + 1], '4: Back returns to /app/browser');
        assert.equal(await browserWindows(page), 1, '4: Back focused the Browser, opened no second one');
        assert.equal(await page.locator('.window[data-app="settings"]').count(), 1, '4: and closed nothing');
        await page.goForward(); await active(page, 'settings');
        assert.deepEqual(await where(page), [`/app/settings?computer=${B.computer}`, base + 1], '4: Forward re-focuses Settings');
        await page.goBack(); await active(page, 'desktop');
        await page.reload(); await active(page, 'desktop');
        assert.deepEqual(await where(page), [entry, base + 1], '4: reload on the Back entry keeps /app/browser');
        const loads = documents.length;
        await page.goForward();
        await page.waitForFunction(() => location.pathname === '/app/settings');
        await active(page, 'settings');
        // Measured, not assumed: Chromium may traverse into the reloaded
        // document (popstate) or load the entry anew. Either way Settings is
        // named and in front, and there is never a second Browser.
        console.log(`MEASURED 4: Forward after a reload was ${documents.length > loads ? 'a document load' : 'a same-document traversal'}`);
        assert.deepEqual(await where(page), [`/app/settings?computer=${B.computer}`, base + 1], '4: Forward after a reload names Settings');
        assert.ok(await browserWindows(page) <= 1, '4: never a second Browser');
        await page.goBack(); await active(page, 'desktop');
        assert.deepEqual(await where(page), [entry, base + 1], '4: Back again: the Browser at its canonical link');
        assert.equal(await browserWindows(page), 1, '4: one Browser');
        await page.close();
    }

    // ── 5. Code's own links are untouched ───────────────────────────────────
    {
        const page = await context.newPage();
        const link = `/app/code?project=${P}&repo=${R}&path=src/main.ts`;
        await page.goto(`${origin}${link}`);
        await page.locator('.window[data-app="code"]').waitFor();
        assert.deepEqual(await where(page), [link, 2], '5: a Code project link stays exactly as written');
        assert.equal(await browserWindows(page), 0, '5: and opens no Browser');
        await page.close();
    }

    // ── 6. Unknown apps and forged targets ──────────────────────────────────
    {
        const page = await context.newPage();
        for (const bad of ['/app/unknown', '/app/Browser', '/app/browser%2fx', '/app/desktop.', '/app/__proto__']) {
            const before = starts.length;
            const response = await page.goto(`${origin}${bad}`);
            assert.equal(response.status(), 404, `6: ${bad} is a 404`);
            assert.equal(startsSince(before).length, 0, `6: ${bad} starts nothing`);
        }
        // B opens A's shared link: A's computer is not B's. Never A's, never a substitute.
        const before = starts.length;
        await page.goto(`${origin}/app/browser?computer=${A.computer}`);
        await page.locator('[data-page="could-not-open"]').waitFor();
        await page.waitForTimeout(500);
        assert.deepEqual(startsSince(before), [], "6: another user's computer in the link: refused, nothing started");
        await page.close();
    }
    await context.close();

    // ── 7. A shared link signed out, then signed in as someone else ─────────
    {
        const ctx = await fresh();
        const page = await ctx.newPage();
        const before = starts.length;
        await page.goto(`${origin}/app/browser?computer=${A.computer}`);
        await page.getByRole('button', { name: 'Sign in as fixture user B' }).click();
        await page.locator('[data-page="could-not-open"]').waitFor();
        assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, `/app/browser?computer=${A.computer}`, '7: B returns to the link as written');
        assert.deepEqual(startsSince(before), [], "7: B gets the refusal, not A's computer or B's own started");
        await ctx.close();
        // The same link, signed in as its owner on another device: it opens.
        const own = await fresh();
        const tab = await own.newPage();
        const mark = starts.length;
        await tab.goto(`${origin}/app/browser?computer=${A.computer}`);
        await tab.getByRole('button', { name: 'Sign in as fixture user A' }).click();
        await active(tab, 'desktop');
        // about:blank, the sign-in page, the link (the gate's redirect is not an entry).
        assert.deepEqual(await where(tab), [`/app/browser?computer=${A.computer}`, 3], "7: A's own link opens A's Browser after sign-in");
        assert.ok(startsSince(mark).length >= 1 && startsSince(mark).every(s => s.user === 'a' && s.computerId === A.computer), '7: only A\'s computer');
        await own.close();
    }

    // ── 8. Forged return targets after sign-in (the real safeReturnUrl) ─────
    {
        const ctx = await fresh();
        const page = await ctx.newPage();
        for (const [returnUrl, lands] of [
            ['//evil.example/app/browser', '/computers'],
            ['https://evil.example/app/browser', '/computers'],
            ['/app/browser\\evil', '/computers'],
            ['/app/unknown', '/os'],
            ['/app/desktop?x=1', '/app/browser?x=1'],
        ]) {
            await ctx.clearCookies();
            await page.goto(`${origin}/login?${new URLSearchParams({ returnUrl })}`);
            await page.getByRole('button', { name: 'Sign in as fixture user B' }).click();
            await page.waitForLoadState('load');
            if (lands.startsWith('/app/browser')) await active(page, 'desktop'); else await page.waitForTimeout(300);
            const now = new URL(page.url());
            assert.equal(now.origin, origin, `8: ${returnUrl} stays on this origin`);
            assert.equal(now.pathname + now.search, lands, `8: ${returnUrl} lands on ${lands}`);
        }
        await ctx.close();
    }

    assert.ok(starts.every(s => s.user && s.computerId === USERS[s.user].computer), "every Browser start named the signed-in user's own computer");
    // Pre-existing and path-independent (app-link-browser-test.mjs): jQuery UI's theme sprites are not shipped.
    assert.deepEqual(missingAssets.filter(p => !/^\/os\/images\/ui-icons_[0-9a-f]+_256x240\.png$/.test(p)), [], 'no shell asset missing but the known sprites');
    assert.deepEqual(foreign, [], 'no request left 127.0.0.1');
    assert.deepEqual(errors, [], 'no page errors');
    console.log(`MEASURED gate outcomes: ${JSON.stringify(documents.reduce((n, d) => ({ ...n, [d.outcome]: (n[d.outcome] ?? 0) + 1 }), {}))}; Browser start requests ${starts.length}, all for the signed-in user's own computer`);
    console.log(`PASS ${checks} checks, local Chromium with FIXTURE gate/IdP and the real return-URL rules: fresh shared link signed out → sign-in → /app/browser; already signed in; legacy /app/desktop and /os?app=desktop|browser rewritten in place (query and hash kept, no new entry); refresh; Back/Forward, and after a reload; Code project link unchanged; unknown app and case/encoding variants 404; another user's computer refused without a start; forged return targets stay on this origin`);
} catch (error) {
    console.error(`FAIL after ${checks} checks; documents ${JSON.stringify(documents.slice(-6))}; starts ${JSON.stringify(starts.slice(-6))}; page errors ${JSON.stringify(errors)}`);
    console.error(consoleTail.slice(-25).join('\n'));
    throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
