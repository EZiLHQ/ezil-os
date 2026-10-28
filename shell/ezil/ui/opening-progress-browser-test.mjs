// Real Chromium against the SOURCE opening surface (`computer-progress.js` +
// `app-spinner.js` + `boot-progress.js`, bundled on the fly with Bun; the
// committed shell bundle is never read or generated) and the real shell CSS in
// bundle order (`computer-progress.css` before `ezil-shell.css`). No network.
// Proves what jsdom cannot: the one surface is centred over the older panel
// rules, the bar is one thin determinate bar, reduced motion drops the
// transition and the shimmer, and a phone width never scrolls sideways.
//
// PLAYWRIGHT_REQUIRE_DIR=/path/to/existing/node_modules \
// node shell/ezil/ui/opening-progress-browser-test.mjs
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

const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opening-browser-source-'));
let source;
try {
    const entry = path.join(buildDir, 'entry.js');
    await fs.writeFile(entry, `import { AppSpinner } from ${JSON.stringify(path.join(here, 'app-spinner.js'))};
import { BootProgress } from ${JSON.stringify(path.join(here, 'boot-progress.js'))};
window.AppSpinner = AppSpinner; window.BootProgress = BootProgress;`);
    source = execFileSync('bun', ['build', entry, '--target=browser', '--format=iife'], { encoding: 'utf8' });
} finally { await fs.rm(buildDir, { recursive: true, force: true }); }
const css = (await fs.readFile(path.join(here, 'computer-progress.css'), 'utf8'))
    + (await fs.readFile(path.join(here, 'ezil-shell.css'), 'utf8'));

const page_html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}
body { margin: 0; } .window-body { position: relative; width: 100vw; height: 100vh; }
</style></head><body><div class="window-body" id="host"></div></body></html>`;

const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
let checks = 0;
async function check (label, run) { await run(); checks++; console.log(`PASS ${label}`); }

try {
    for ( const [viewport, reducedMotion] of [[{ width: 1280, height: 800 }, 'no-preference'], [{ width: 390, height: 844 }, 'reduce']] ) {
        const context = await browser.newContext({ viewport, reducedMotion });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent(page_html);
        await page.addScriptTag({ content: source });
        const tag = `${viewport.width}px/${reducedMotion}`;

        await check(`${tag}: the spinner is one centred surface with a thin indeterminate bar and no ring`, async () => {
            const box = await page.evaluate(() => {
                const s = window.AppSpinner({ label: 'Opening Code…' });
                document.getElementById('host').appendChild(s.el);
                s.render({ kind: 'progress' }, { elapsedMs: 42_000 });
                const panel = s.el.querySelector('.ezil-opening');
                const bar = s.el.querySelector('.ezil-opening-bar').getBoundingClientRect();
                const fill = getComputedStyle(s.el.querySelector('.ezil-opening-fill'));
                return { align: getComputedStyle(panel).textAlign, h: bar.height, w: bar.width,
                    centre: Math.abs((bar.left + bar.width / 2) - window.innerWidth / 2), ring: !!s.el.querySelector('.ezil-app-spinner-ring'),
                    animation: fill.animationName, meta: s.el.querySelector('.ezil-opening-meta').textContent,
                    name: s.el.querySelector('.ezil-opening-name').textContent, overflow: document.documentElement.scrollWidth - window.innerWidth };
            });
            assert.equal(box.align, 'center');
            assert.equal(box.h, 4);
            assert.ok(box.w > 100 && box.w <= 220, String(box.w));
            assert.ok(box.centre < 2, `centred (${box.centre})`);
            assert.equal(box.ring, false);
            assert.equal(box.meta, '0:42');
            assert.equal(box.name, 'Code');
            assert.equal(box.overflow, 0, 'no sideways scroll');
            assert.equal(box.animation, reducedMotion === 'reduce' ? 'none' : 'ezil-opening-shimmer');
        });

        await check(`${tag}: BootProgress renders the same surface over the older panel rules; reduced motion drops the transition`, async () => {
            const out = await page.evaluate(() => {
                document.getElementById('host').replaceChildren();
                const b = window.BootProgress({ appName: 'Linux Desktop' });
                document.getElementById('host').appendChild(b.el);
                b.render({ kind: 'progress', currentPhase: 'mounting', confirmed: false, isRunningLong: false }, null, { elapsedMs: 9_000 });
                const panel = b.el.querySelector('.ezil-opening');
                const bar = b.el.querySelector('.ezil-opening-bar');
                const fill = getComputedStyle(b.el.querySelector('.ezil-opening-fill'));
                return { align: getComputedStyle(panel).textAlign, value: Number(bar.getAttribute('aria-valuenow')),
                    transition: fill.transitionDuration, rows: b.el.querySelectorAll('li').length,
                    status: b.el.querySelector('.ezil-boot-title').textContent };
            });
            assert.equal(out.align, 'center');
            assert.equal(out.rows, 0);
            assert.equal(out.status, 'Loading your files');
            assert.ok(out.value >= 25 && out.value < 90, String(out.value));
            assert.equal(out.transition, reducedMotion === 'reduce' ? '0s' : '0.9s');
            if ( reducedMotion === 'reduce' ) assert.equal(out.value % 10, 0, 'whole steps');
        });
        assert.deepEqual(errors, []);
        await context.close();
    }
} finally { await browser.close(); }
console.log(`${checks} checks passed`);
