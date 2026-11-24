// Rehearses the corner control (controls.css + status-control.js) in isolated Chromium: roles and names, a red dot only
// while recording, reduced motion, 24 px targets, visibility above a checkout sheet, and resize without overflow.
// Every request is intercepted; the page is a fixture. Run: node shell/ezil/assignment-video/status-control-browser-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const {chromium} = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit', 'test.cjs'))('playwright');
const here = new URL('.', import.meta.url).pathname;
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const origin = 'https://fixture.invalid';
const page_html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/controls.css">
<style>body{margin:0;background:#ddd;font:14px system-ui} #sheet{position:fixed;inset:0;z-index:1000000000;background:rgba(0,0,0,.5)}
#top-right{position:fixed;top:6px;right:290px;width:28px;height:28px;background:#357}</style></head>
<body><div id="sheet" role="dialog" aria-label="Checkout"></div><button id="top-right" aria-label="Fixture window control"></button>
<script type="module">
import {createCountdown} from '/countdown.js';
import {createStatusControl} from '/status-control.js';
const countdown = createCountdown();
const T = Date.now();
countdown.sync({serverNow:new Date(T).toISOString(),startedAt:new Date(T-60000).toISOString(),deadlineAt:new Date(T+3541000).toISOString(),revision:1});
let stops = 0;
window.__stops = () => stops;
window.__countdown = countdown;
const control = createStatusControl({win: window, countdown, onStop: () => { stops++; }});
window.__control = control;
control.set('recording');
</script></body></html>`;
const browser = await chromium.launch({headless: process.env.EZIL_CHROME_HEADED !== '1',
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/google-chrome', args: ['--disable-dev-shm-usage', '--host-resolver-rules=MAP * ~NOTFOUND']});
let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('PASS ' + name); } catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.stack); }
}
async function open(viewport, {reducedMotion = 'no-preference'} = {}) {
    const context = await browser.newContext({viewport, reducedMotion});
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        const files = {'/': ['text/html', page_html], '/controls.css': ['text/css', read('controls.css')],
            '/countdown.js': ['text/javascript', read('countdown.js')], '/status-control.js': ['text/javascript', read('status-control.js')]};
        const hit = files[url.pathname];
        return hit ? route.fulfill({contentType: hit[0], body: hit[1]}) : route.abort();
    });
    const page = await context.newPage();
    await page.goto(origin + '/');
    await page.waitForFunction(() => window.__control);
    return {page, close: () => context.close()};
}
const box = (page, selector) => page.locator(selector).first().boundingBox();

try {
    await check('roles and accessible names: one group, a timer that is not live, a named Stop, a polite status', async () => {
        const {page, close} = await open({width: 1024, height: 700});
        const group = page.getByRole('group', {name: 'Assignment recording'});
        assert.equal(await group.count(), 1);
        const timer = group.getByRole('timer');
        assert.equal(await timer.getAttribute('aria-live'), 'off');
        assert.match(await timer.textContent(), /^\d\d:\d\d$/);
        const stop = group.getByRole('button', {name: 'Stop sharing this assignment tab'});
        assert.equal(await stop.count(), 1);
        assert.equal(await stop.textContent(), 'Stop');
        assert.equal(await group.locator('.ezil-assignment-recording-dot').getAttribute('aria-hidden'), 'true');
        assert.equal(await group.locator('[role=status]').getAttribute('aria-live'), 'polite');
        assert.equal(await group.locator('.ezil-assignment-recording-state').textContent(), 'Recording');
        await close();
    });

    await check('the dot is red only while recording and a ring in every other state', async () => {
        const {page, close} = await open({width: 1024, height: 700});
        const dot = () => page.locator('.ezil-assignment-recording-dot').evaluate(el => {
            const s = getComputedStyle(el); return {bg: s.backgroundColor, border: s.borderTopColor};
        });
        assert.deepEqual(await dot(), {bg: 'rgb(244, 107, 104)', border: 'rgb(244, 107, 104)'});
        for (const state of ['paused', 'stopped', 'idle', 'interrupted']) {
            await page.evaluate(s => window.__control.set(s), state);
            const style = await dot();
            assert.equal(style.bg, 'rgba(0, 0, 0, 0)', state + ' is not filled');
            assert.equal(style.border, 'rgb(244, 107, 104)', state + ' keeps the ring');
        }
        await close();
    });

    await check('Stop is a 24 px target, hidden after a stop, and the control stays visible above a checkout sheet', async () => {
        const {page, close} = await open({width: 1024, height: 700});
        const stop = await box(page, '.ezil-assignment-recording-stop');
        assert.ok(stop.height >= 24 && stop.width >= 24, JSON.stringify(stop));
        const centre = await page.evaluate(() => {
            const r = document.querySelector('.ezil-assignment-recording-status').getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!hit.closest('.ezil-assignment-recording-status');
        });
        assert.equal(centre, true, 'the checkout sheet (z-index 1e9) does not cover the countdown');
        await page.getByRole('button', {name: 'Stop sharing this assignment tab'}).click();
        assert.equal(await page.evaluate(() => window.__stops()), 1);
        await page.evaluate(() => window.__control.set('stopped'));
        assert.equal(await page.locator('.ezil-assignment-recording-stop').isHidden(), true);
        assert.equal(await page.locator('.ezil-assignment-recording-status').isVisible(), true);
        await close();
    });

    await check('reduced motion stops the pulse', async () => {
        const normal = await open({width: 800, height: 600});
        const moving = await normal.page.locator('.ezil-assignment-recording-dot').evaluate(el => getComputedStyle(el).animationName);
        assert.equal(moving, 'ezil-assignment-pulse');
        await normal.close();
        const still = await open({width: 800, height: 600}, {reducedMotion: 'reduce'});
        assert.equal(await still.page.locator('.ezil-assignment-recording-dot').evaluate(el => getComputedStyle(el).animationName), 'none');
        await still.close();
    });

    await check('resize: inside the viewport, no horizontal scroll, clear of the fixture window control at 1280 and 768, down to 320 px', async () => {
        for (const width of [1280, 1024, 768, 480, 375, 320]) {
            const {page, close} = await open({width, height: 640});
            for (const state of ['recording', 'paused', 'stopped']) {
                await page.evaluate(s => window.__control.set(s), state);
                const rect = await box(page, '.ezil-assignment-recording-status');
                assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 0.5, `${width}/${state}: ${JSON.stringify(rect)}`);
                assert.ok(rect.height <= 36, `${width}/${state} compact: ${rect.height}`);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}/${state} no horizontal scroll`);
                if (width >= 768 && state !== 'paused') {
                    const other = await box(page, '#top-right');
                    assert.ok(rect.x >= other.x + other.width || rect.x + rect.width <= other.x, `${width}/${state} overlaps the window control`);
                }
            }
            await close();
        }
    });

    await check('the paused state keeps the frozen time visible and says why in words, and a long state text is cut, not wrapped', async () => {
        const {page, close} = await open({width: 320, height: 640});
        await page.evaluate(() => {
            window.__countdown.sync({serverNow: new Date().toISOString(), deadlineAt: new Date(Date.now() + 3600000).toISOString(), pausedAt: new Date().toISOString(),
                pauseReason: 'system_upgrade', remainingMs: 17 * 60000, revision: 2});
            window.__control.set('paused');
        });
        assert.equal(await page.locator('.ezil-assignment-recording-time').textContent(), '17:00');
        assert.equal(await page.locator('.ezil-assignment-recording-state').getAttribute('title'), 'Paused for system upgrade');
        const rect = await box(page, '.ezil-assignment-recording-status');
        assert.ok(rect.height <= 36, 'one line at 320 px: ' + rect.height);
        await close();
    });
} finally { await browser.close(); }
if (failures) { console.error(failures + ' failed'); process.exit(1); }
console.log('PASS status control browser rehearsal');
