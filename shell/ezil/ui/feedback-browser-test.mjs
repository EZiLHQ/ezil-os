// Real Chromium against the SOURCE feedback modules (bundled on the fly with
// Bun; the committed shell bundle is never read or generated). The feedback
// route is a LOCAL MOCK: every request is intercepted, nothing reaches a
// network, and no report is stored anywhere. Proves what jsdom cannot: real
// clicks reach the chip in a full-bleed window with floating controls off,
// native <dialog> focus, the exact request bytes and header, and Chromium's own
// offline emulation followed by its `online` event.
//
// PLAYWRIGHT_REQUIRE_DIR=/path/to/existing/node_modules \
// node shell/ezil/ui/feedback-browser-test.mjs
// PLAYWRIGHT_CHROMIUM_EXECUTABLE may select an already installed Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
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

const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-browser-source-'));
let source;
try {
    const entry = path.join(buildDir, 'entry.js');
    await fs.writeFile(entry, `import * as feedback from ${JSON.stringify(path.join(here, 'feedback', 'feedback.js'))}; window.feedback = feedback;`);
    source = execFileSync('bun', ['build', entry, '--target=browser', '--format=iife'], { encoding: 'utf8' });
} finally { await fs.rm(buildDir, { recursive: true, force: true }); }
const css = await fs.readFile(path.join(here, 'feedback', 'feedback.css'), 'utf8');

const origin = 'https://os-fixture.test';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const COMPUTER = '11111111-1111-4111-8111-111111111111';
const REPORT = '22222222-2222-4222-8222-222222222222';
const boot = { user: { id: ACCOUNT, email: 'fixture@example.test' }, computer: { id: COMPUTER },
    desktopState: { endpoints: { feedback: '/api/shell/feedback' }, ui: { floatingControls: false, feedbackScreenshots: false } } };
// The real shell's full-bleed window: a fixed, opaque desktop under the top
// control strip (ezil-shell.css `--ezil-control-strip-height`: 43 px, 59 px
// under `pointer: coarse`).
const page_html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}
body { margin: 0; font: 14px system-ui; }
.window.ezil-fullbleed { position: fixed; inset: 0; z-index: 600; background: #11151f; }
.window.ezil-fullbleed { --strip: 43px; }
@media (pointer: coarse) { .window.ezil-fullbleed { --strip: 59px; } }
.window.ezil-fullbleed iframe { position: absolute; top: var(--strip); left: 0; width: 100%; height: calc(100% - var(--strip)); border: 0; background: #234; }
</style>
<script>window.__EZIL_BOOT__ = ${JSON.stringify(boot)};</script></head>
<body><div class="window ezil-fullbleed"><iframe title="Desktop stream" srcdoc="<p style='color:white'>stream</p>"></iframe></div></body></html>`;

const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
let checks = 0;
async function check (label, run) { await run(); checks++; console.log(`PASS ${label}`); }

try {
    for ( const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }] ) {
        const context = await browser.newContext({ viewport, hasTouch: viewport.width < 500 });
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
            if ( url.origin === origin && url.pathname === '/os' ) return route.fulfill({ contentType: 'text/html', body: page_html });
            if ( url.origin === origin && url.pathname === '/api/shell/feedback' ) {
                if ( request.method() === 'POST' ) {
                    if ( offline ) { offlineAttempts++; return route.abort('internetdisconnected'); }
                    posts.push({ body: request.postData(), contentType: request.headers()['content-type'] });
                    const { status, body } = reply();
                    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body ?? {}) });
                }
                if ( request.method() === 'GET' ) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"reports":[]}' });
            }
            return route.abort('blockedbyclient');
        });
        await page.goto(`${origin}/os`);
        await page.addScriptTag({ content: source });
        await page.evaluate(() => window.feedback.mount_feedback_chip());
        const tag = `${viewport.width}px`;
        const chip = page.locator('button.ezil-feedback-chip');
        const dialog = page.locator('dialog.ezil-feedback-dialog');
        const description = page.locator('#ezil-feedback-description');
        const status = page.locator('.ezil-feedback-result');
        const preview = () => page.locator('.ezil-feedback-preview pre').textContent();
        const openByChip = async () => { await chip.click(); await dialog.waitFor({ state: 'visible' }); };
        const closeDialog = async () => { await page.locator('[data-action="cancel"]').click(); await dialog.waitFor({ state: 'detached' }); };

        await check(`${tag}: the chip is reachable above a full-bleed desktop with floating controls off`, async () => {
            await chip.waitFor({ state: 'visible' });
            const box = await chip.boundingBox();
            assert.ok(box && box.width >= 34 && box.height >= 34, 'a real target');
            const strip = await page.evaluate(() => matchMedia('(pointer: coarse)').matches ? 59 : 43);
            assert.ok(box.y >= 0 && box.y + box.height <= strip, `inside the ${strip} px control strip, not over the stream (${JSON.stringify(box)})`);
            const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.className ?? null,
                { x: box.x + box.width / 2, y: box.y + box.height / 2 });
            assert.equal(hit, 'ezil-feedback-chip ezil-feedback-chip-fullbleed', 'the chip, not the desktop, receives the click');
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

        await check(`${tag}: no page errors`, async () => {
            assert.deepEqual(errors, []);
        });
        await context.close();
    }
    console.log(`\n${checks} feedback browser checks passed (local route mock; no network, no stored report).`);
} finally {
    await browser.close();
}
