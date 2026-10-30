// Real Chromium against the PRODUCTION path: the BUILT shell bundle
// (`app/public/os`, what `/os` serves — run shell/build-shell.sh first, or point
// EZIL_SHELL_OUT_DIR or EZIL_OS_DIR at a build), booted with `endpoints.feedback` published so
// boot.js mounts Feedback itself. Every request is answered by a LOCAL route
// mock: nothing reaches a network and no report is stored anywhere.
//
// Founder, 2026-10-29: no Feedback on the home screen (Settings → Feedback is
// the main entry); while an app is open, a very small icon. Proves what jsdom
// cannot, at a fine-pointer desktop and a coarse-pointer phone:
//   - the empty desktop shows no Feedback control;
//   - the Browser (opened from the dock, full-bleed) and Settings each show ONE
//     icon-only "Send feedback" button: a 20px disc in a 24px target, or a
//     44px target under `pointer: coarse`; on top of the windows (hit-tested),
//     inside the full-bleed control strip, clear of the drawer and of every
//     window's traffic lights;
//   - minimising or closing the last app window hides it again;
//   - Code in full view (app-code lane A2, 2026-10-30): the icon keeps its
//     corner of the same strip, right of the compact top bar's minimise /
//     restore / close, which never sit under it;
//   - clicking it opens the real dialog: native <dialog> focus, the exact
//     request bytes and header, refusals, the draft, and Chromium's own offline
//     emulation followed by its `online` event.
//
// PLAYWRIGHT_REQUIRE_DIR=/path/to/existing/node_modules \
// node shell/ezil/ui/feedback-browser-test.mjs
// PLAYWRIGHT_CHROMIUM_EXECUTABLE may select an already installed Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = process.env.EZIL_SHELL_OUT_DIR || process.env.EZIL_OS_DIR || path.resolve(here, '../../../app/public/os');
for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`SKIP: missing ${path.join(OS, f)} — run shell/build-shell.sh first (or set EZIL_SHELL_OUT_DIR).`);
        process.exit(2);
    }
}
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
    if ( process.env.PLAYWRIGHT_REQUIRE_DIR ) {
        const external = createRequire(path.join(path.resolve(process.env.PLAYWRIGHT_REQUIRE_DIR), 'probe.cjs'));
        try { ({ chromium } = external('playwright')); } catch { /* Explicit skip below. */ }
    }
}
if ( ! chromium ) {
    console.error('SKIP: installed Playwright is unavailable; a DOM simulation cannot prove browser behaviour.');
    process.exit(2);
}

const icons = fs.readFileSync(path.join(OS, 'icons.js'), 'utf8');
const bundle = fs.readFileSync(path.join(OS, 'bundle.min.js'), 'utf8');
const css = fs.readFileSync(path.join(OS, 'bundle.min.css'), 'utf8');

const origin = 'https://os-fixture.test';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const COMPUTER = '11111111-1111-4111-8111-111111111111';
const REPORT = '22222222-2222-4222-8222-222222222222';
const ENDPOINTS = { session: '/api/shell/session', desktop: '/api/shell/desktop', focus: '/api/shell/focus',
    feedback: '/api/shell/feedback' };
const boot = { user: { id: ACCOUNT, email: 'fixture@example.test' },
    computer: { id: COMPUTER, name: 'Computer', slot: 1, createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false },
    apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
    desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
        endpoints: ENDPOINTS, ui: { floatingControls: false, feedbackScreenshots: false } } };
const page_html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style></head><body><div id="ezil-os-root"><div id="ezil-os-root-inner"></div></div></body></html>`;
// The streamed desktop: reports decoded frames so the window goes full-bleed.
const stream_html = `<!doctype html><html><body style="margin:0;background:#14484c"><script>
let n = 0;
setInterval(() => { n++; parent.postMessage({ source: 'ezil-mobile', type: 'stream_vitals',
    attempt: new URL(location.href).searchParams.get('ezilAttempt'),
    vitals: { connectionState: 'connected', framesDecoded: n, bytesReceived: n * 100, width: 1280, height: 720 } }, location.origin); }, 100);
</script></body></html>`;

const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
let checks = 0;
async function check (label, run) { await run(); checks++; console.log(`PASS ${label}`); }
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

try {
    for ( const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }] ) {
        const touch = viewport.width < 500;
        const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const posts = [];
        // Playwright still fulfils routed requests under setOffline, so the
        // mock fails them exactly as Chromium does offline. navigator.onLine
        // and the `online` event remain Chromium's own.
        let offline = false;
        let offlineAttempts = 0;
        let reply = () => ({ status: 201, body: { id: REPORT, createdAt: '2026-10-28T12:00:00.000Z', screenshotAccepted: false } });
        await context.route('**/*', route => {
            const request = route.request();
            const url = new URL(request.url());
            const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            if ( url.origin !== origin ) return route.abort('blockedbyclient');
            if ( url.pathname === '/os' ) return route.fulfill({ contentType: 'text/html', body: page_html });
            if ( url.pathname === '/frame' ) return route.fulfill({ contentType: 'text/html', body: stream_html });
            if ( url.pathname === '/api/shell/feedback' ) {
                if ( request.method() === 'POST' ) {
                    if ( offline ) { offlineAttempts++; return route.abort('internetdisconnected'); }
                    posts.push({ body: request.postData(), contentType: request.headers()['content-type'] });
                    const { status, body } = reply();
                    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body ?? {}) });
                }
                return json({ reports: [] });
            }
            if ( url.pathname.startsWith('/api/') ) {
                if ( url.searchParams.get('confirm') === 'frame' ) return json({ ok: true, confirmed: true, status: 200 });
                if ( url.searchParams.get('confirm') === 'display' ) return json({ ok: true, display: 'live' });
                if ( url.pathname === ENDPOINTS.desktop ) return json(request.method() === 'POST'
                    ? { ok: true, guacamoleUrl: `${origin}/frame?desktop=1`, frame: { confirmed: true } } : { ok: true, guacamoleRunning: true });
                // The Code window's mint (its default route; not in ENDPOINTS).
                if ( url.pathname === '/api/shell/code-preview-url' ) return json({ ok: true, codePreviewUrl: `${origin}/frame?code=1` });
                return json({ ok: true });
            }
            return route.fulfill({ status: 404, body: '' });
        });
        await page.goto(`${origin}/os`);
        await page.evaluate(payload => { window.__EZIL_BOOT__ = payload; }, boot);
        await page.addScriptTag({ content: icons });
        await page.addScriptTag({ content: bundle });
        await page.evaluate(async () => { await window.ezil.boot(); });
        const tag = `${viewport.width}px`;
        const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
        assert.equal(coarse, touch, 'the emulated pointer is the one this pass is about');
        const chip = page.locator('button.ezil-feedback-chip');
        const dialog = page.locator('dialog.ezil-feedback-dialog');
        const description = page.locator('#ezil-feedback-description');
        const status = page.locator('.ezil-feedback-result');
        const preview = () => page.locator('.ezil-feedback-preview pre').textContent();
        const openByChip = async () => { await chip.click(); await dialog.waitFor({ state: 'visible' }); };
        const closeDialog = async () => { await page.locator('[data-action="cancel"]').click(); await dialog.waitFor({ state: 'detached' }); };
        const launch = id => page.evaluate(app => { window.$(`.taskbar-item[data-app="${app}"]`).trigger('click'); }, id);
        // The icon, its glyph disc, what is under its centre, and every window
        // control on screen: traffic lights (with their 6px hit pads) and the
        // full-bleed drawer with its buttons.
        const measure = () => page.evaluate(() => {
            const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
            const icon = document.querySelector('button.ezil-feedback-chip');
            const box = rect(icon);
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            const open = [...document.querySelectorAll('.window[data-app]')].filter(w => w.dataset.app
                && ! ['true', '1'].includes(w.getAttribute('data-is_minimized')) && getComputedStyle(w).display !== 'none');
            const controls = open.flatMap(w => [
                ...[...w.querySelectorAll(':scope > .window-head > .window-action-btn')].map(rect)
                    .map(r => ({ x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 })),
                ...[...w.querySelectorAll('.ezil-app-drawer, .ezil-app-drawer button')].map(rect),
                // Code's full-view top bar (lane A2): its own window controls.
                ...[...w.querySelectorAll(':scope > .ezil-full-view-bar button')].map(rect),
            ]).filter(r => r.width > 0 && r.height > 0);
            const strip = document.querySelector('.window.ezil-fullbleed');
            return { box, disc: rect(icon.querySelector('svg')), hitIsIcon: hit?.closest('button') === icon, controls,
                strip: strip ? Number.parseFloat(getComputedStyle(strip).getPropertyValue('--ezil-control-strip-height')) : null,
                label: icon.getAttribute('aria-label'), tooltip: icon.title, text: icon.textContent.trim() };
        });
        const assertTiny = async where => {
            await chip.waitFor({ state: 'visible' });
            const m = await measure();
            assert.equal(await chip.count(), 1, 'one icon');
            assert.deepEqual([m.label, m.tooltip, m.text], ['Send feedback', 'Send feedback', ''], 'icon only, named "Send feedback"');
            assert.ok(m.disc.width <= 20 && m.disc.height <= 20 && m.disc.width >= 16, `a small visual (${JSON.stringify(m.disc)})`);
            if ( coarse ) assert.ok(m.box.width >= 44 && m.box.height >= 44, `a 44px touch target (${JSON.stringify(m.box)})`);
            else assert.ok(m.box.width === 24 && m.box.height === 24, `a compact 24px target (${JSON.stringify(m.box)})`);
            assert.ok(m.hitIsIcon, `${where}: the icon, not the window under it, receives the click`);
            assert.ok(m.box.x + m.box.width <= viewport.width && m.box.y >= 0, 'on screen');
            const hits = m.controls.filter(r => overlaps(m.box, r));
            assert.deepEqual(hits, [], `${where}: clear of every window control`);
            return m;
        };

        await check(`${tag}: the home screen (no app window) shows no Feedback control`, async () => {
            await page.waitForSelector('.taskbar-item[data-app="desktop"]');
            await chip.waitFor({ state: 'attached' });
            assert.equal(await chip.isVisible(), false);
        });

        await check(`${tag}: the Browser, full-bleed, shows one tiny icon in the control strip, clear of the drawer`, async () => {
            await launch('desktop');
            await page.waitForSelector('.window[data-app="desktop"].ezil-fullbleed', { timeout: 30_000 });
            const open = await assertTiny('drawer open');
            assert.ok(open.strip > 0 && open.box.y + open.box.height <= open.strip, `inside the ${open.strip}px strip, not over the stream (${JSON.stringify(open.box)})`);
            await page.locator('.window[data-app="desktop"] .dashboard-app-drawer-toggle').click();
            await page.waitForFunction(() => document.querySelector('.window[data-app="desktop"] .ezil-app-drawer')?.classList.contains('collapsed'));
            await assertTiny('drawer collapsed');
            await openByChip();
            assert.equal(await page.evaluate(() => document.activeElement?.id), 'ezil-feedback-description', 'focus moves into the dialog');
        });

        await check(`${tag}: the preview is byte-for-byte the request body; JSON content-type; 201 shows thanks`, async () => {
            await description.fill('[synthetic r3] browser test report');
            await page.locator('input[name="diagnostics"]').check();
            await page.locator('.ezil-feedback-preview summary').click();
            const shown = await preview();
            await page.locator('button[type="submit"]').click();
            await status.filter({ hasText: 'Thanks — we got it' }).waitFor();
            assert.equal(posts.length, 1);
            assert.equal(posts[0].body, shown, 'the visible preview is exactly what was sent');
            assert.match(posts[0].contentType, /^application\/json/);
            const sent = JSON.parse(posts[0].body);
            assert.equal(sent.computerId, COMPUTER);
            assert.equal(sent.screenshot, null);
            assert.equal(sent.diagnostics.fullbleed, true, 'sent from the full-bleed desktop');
            assert.doesNotMatch(posts[0].body, /fixture@example\.test|33333333-3333/, 'no email and no account id leave the browser');
            assert.equal(await page.locator('[data-capture]').count(), 0, 'screenshots are off');
            await closeDialog();
            assert.equal(await page.evaluate(id => localStorage.getItem(`ezil:feedback:draft:v1:${id}`), ACCOUNT), null, 'a sent report leaves no draft');
            posts.length = 0;
        });

        for ( const [code, copy] of [
            [429, "You've sent several reports this hour — try again later."],
            [413, 'This report is too large. Remove the screenshot and try again.'],
            [415, 'This page could not send the report. Reload EZiL OS and try again.'],
        ] ) await check(`${tag}: ${code} keeps the text, says so and is not retried`, async () => {
            reply = () => ({ status: code, body: { error: 'x' } });
            await openByChip();
            await description.fill(`[synthetic r3] refused ${code}`);
            await page.locator('button[type="submit"]').click();
            await status.filter({ hasText: copy }).waitFor();
            assert.equal(await description.inputValue(), `[synthetic r3] refused ${code}`);
            assert.equal(posts.length, 1);
            await page.evaluate(() => window.dispatchEvent(new Event('online')));
            await page.waitForTimeout(100);
            assert.equal(posts.length, 1, 'a definitive refusal is never re-sent');
            await description.fill('');
            await closeDialog();
            posts.length = 0;
        });

        await check(`${tag}: the draft survives closing the dialog (Escape) and keeps its request id`, async () => {
            reply = () => ({ status: 201, body: { id: REPORT, screenshotAccepted: false } });
            await openByChip();
            await description.fill('[synthetic r3] half-written');
            const id = JSON.parse(await preview()).clientRequestId;
            await page.keyboard.press('Escape');
            await dialog.waitFor({ state: 'detached' });
            await openByChip();
            assert.equal(await description.inputValue(), '[synthetic r3] half-written');
            assert.equal(JSON.parse(await preview()).clientRequestId, id);
            assert.equal(posts.length, 0, 'nothing is sent before Submit');
        });

        await check(`${tag}: offline submit is kept, then sent exactly once on Chromium's own \`online\` event`, async () => {
            const shownId = JSON.parse(await preview()).clientRequestId;
            await page.locator('.ezil-feedback-preview summary').click();
            const shown = await preview();
            await context.setOffline(true); offline = true;
            await page.waitForFunction(() => navigator.onLine === false);
            await page.locator('button[type="submit"]').click();
            await status.filter({ hasText: "You're offline" }).waitFor();
            assert.equal(posts.length, 0, 'the offline attempt was not delivered');
            assert.equal(offlineAttempts, 1);
            await closeDialog();
            await openByChip();
            assert.equal(await description.inputValue(), '[synthetic r3] half-written', 'the unsent text is still there');
            await closeDialog();
            offline = false; await context.setOffline(false);
            await page.waitForFunction(() => navigator.onLine === true);
            await page.waitForFunction(id => localStorage.getItem(`ezil:feedback:outbox:v1:${id}`) === null, ACCOUNT);
            assert.equal(posts.length, 1, 'exactly one request after reconnecting');
            assert.equal(posts[0].body, shown, 'the queued request is the previewed body, byte for byte');
            assert.equal(JSON.parse(posts[0].body).clientRequestId, shownId, 'same clientRequestId — a replay, never a duplicate');
            await page.evaluate(() => window.dispatchEvent(new Event('online')));
            await page.waitForTimeout(100);
            assert.equal(posts.length, 1);
            posts.length = 0;
        });

        await check(`${tag}: minimising the Browser (the last app window) hides the icon`, async () => {
            await page.evaluate(() => { document.querySelector('.window[data-app="desktop"]')._ezil_minimise(); });
            await chip.waitFor({ state: 'hidden' });
        });

        await check(`${tag}: Settings shows the icon again, clear of its traffic lights; closing it hides the icon`, async () => {
            await launch('settings');
            await page.waitForSelector('.window[data-app="settings"] .window-close-btn');
            await assertTiny('Settings');
            if ( ! coarse ) {
                // Maximised, the window's head runs under the icon: still clear of the lights.
                await page.locator('.window[data-app="settings"] .window-scale-btn').click();
                await page.waitForFunction(() => document.querySelector('.window[data-app="settings"]').getBoundingClientRect().y === 0);
                const m = await assertTiny('Settings maximised');
                const head = await page.locator('.window[data-app="settings"] > .window-head').boundingBox();
                assert.ok(m.box.y >= head.y && m.box.y + m.box.height <= head.y + head.height, `level with the window head (${JSON.stringify({ box: m.box, head })})`);
            }
            await page.locator('.window[data-app="settings"] > .window-head > .window-close-btn').click();
            await page.waitForSelector('.window[data-app="settings"]', { state: 'detached' });
            await chip.waitFor({ state: 'hidden' });
        });

        await check(`${tag}: Code in full view (the /app/code route) shows one tiny icon in its strip, right of and clear of the top bar's controls; closing Code hides it`, async () => {
            await page.evaluate(async () => {
                const p = window.__EZIL_BOOT__;
                await window.ezil.registry.launch('code', { payload: p, computer: p.computer, desktopState: p.desktopState, view: 'full' });
            });
            await page.waitForSelector('.window[data-app="code"].ezil-fullbleed .ezil-full-view-bar button[data-action="close"]', { state: 'visible' });
            const m = await assertTiny('Code full view');
            assert.ok(m.strip > 0 && m.box.y >= 0 && m.box.y + m.box.height <= m.strip, `inside the ${m.strip}px strip (${JSON.stringify(m.box)})`);
            const bar = await page.evaluate(() => [...document.querySelectorAll('.window[data-app="code"] > .ezil-full-view-bar button')]
                .map(b => { const r = b.getBoundingClientRect(); return { action: b.dataset.action, x: r.x, w: r.width }; }));
            assert.deepEqual(bar.map(b => b.action), ['minimize', 'restore', 'close'], 'the bar\'s three controls are on screen');
            assert.ok(bar.every(b => b.x + b.w <= m.box.x), `every control ends left of the icon (${JSON.stringify({ bar, icon: m.box })})`);
            assert.ok(m.controls.length >= 3, 'the bar\'s controls were part of the overlap check');
            await page.locator('.window[data-app="code"] > .ezil-full-view-bar button[data-action="close"]').click();
            await page.waitForSelector('.window[data-app="code"]', { state: 'detached' });
            await chip.waitFor({ state: 'hidden' });
        });

        await check(`${tag}: no page errors`, async () => {
            assert.deepEqual(errors, []);
        });
        await context.close();
    }
    console.log(`\n${checks} feedback browser checks passed (built bundle; local route mock; no network, no stored report).`);
} finally {
    await browser.close();
}
