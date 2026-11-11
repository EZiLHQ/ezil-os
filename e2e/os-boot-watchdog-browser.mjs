// Local-only regression: actual React component, real deferred-script loading, virtual time. No staging/auth.
// Uses existing installed esbuild/Playwright; never installs or writes a bundle.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'app/package.json'));
const { build } = require('esbuild');
let chromium;
try { ({ chromium } = require('playwright')); } catch {
    assert.ok(process.env.PLAYWRIGHT_REQUIRE_DIR, 'set PLAYWRIGHT_REQUIRE_DIR to existing installed Playwright');
    ({ chromium } = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR, 'probe.cjs'))('playwright'));
}
const built = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {BootWatchdog} from './src/app/os/boot-watchdog';
        createRoot(document.getElementById('root')).render(React.createElement(BootWatchdog));`, resolveDir: path.join(root, 'app'), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'local-host-only', setup(b) {
        b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }));
        b.onResolve({ filter: /^@\/utils\/constants$/ }, () => ({ path: 'constants', namespace: 'fixture' }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'link'
            ? "import React from 'react'; export default props=>React.createElement('a',props,props.children);"
            : "export const Routes={COMPUTERS:'/computers'};", resolveDir: path.join(root, 'app') }));
    } }],
});
const bundle = built.outputFiles[0].text;
const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const healthyScript = "window.ezil={mounted:true};const t=document.createElement('div');t.className='taskbar';document.body.append(t);";
async function scenario(name, delay, healthy, fatal = false) {
    const ctx = await browser.newContext(), page = await ctx.newPage();
    const origin = 'https://watchdog-fixture.test';
    let release, requested, navigations = 0;
    const waiting = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { requested = resolve; });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        assert.equal(u.origin, origin, 'no external request');
        if (u.pathname === '/slow-shell.js') { requested(); await waiting; return route.fulfill({ contentType: 'application/javascript', body: healthy ? healthyScript : fatal ? "window.ezil={mounted:false,stalled:{reason:'mount-budget-exhausted'}};window.dispatchEvent(new Event('ezil:stalled'));" : '' }); }
        assert.equal(u.pathname, '/os'); navigations++;
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><body><div id="root"></div><script>
            window.__EZIL_BOOT__={};window.__watchdogIntervals=new Set();
            const originalSetInterval=window.setInterval,originalClearInterval=window.clearInterval;
            window.setInterval=(fn,ms,...args)=>{const id=originalSetInterval(fn,ms,...args);if(ms===250)window.__watchdogIntervals.add(id);return id;};
            window.clearInterval=id=>{window.__watchdogIntervals.delete(id);return originalClearInterval(id);};
            ${bundle}</script><script defer src="/slow-shell.js"></script></body>` });
    });
    try {
        await page.goto(origin + '/os', { waitUntil: 'commit' }); await arrived;
        await page.waitForFunction(() => window.__watchdogIntervals?.size === 1);
        await page.clock.fastForward(delay);
        assert.notEqual(await page.evaluate(() => document.readyState), 'complete', 'deferred script really holds document load');
        const error = page.locator('[data-ezil-stalled]');
        assert.equal(await error.count(), delay >= 30000 ? 1 : 0, 'no false failure at10s while document is pending, but30s stays bounded');
        release(); await page.waitForLoadState('load');
        if (healthy) {
            await page.waitForFunction(() => window.ezil?.mounted && document.querySelector('.taskbar'));
            await page.clock.fastForward(250);
            await page.waitForFunction(() => !document.querySelector('[data-ezil-stalled]'));
            assert.equal(await page.evaluate(() => window.__watchdogIntervals.size), 0, 'successful mount stops polling');
        } else {
            await page.clock.fastForward(10000);
            await error.waitFor(); assert.equal(await error.getAttribute('data-ezil-stalled'), fatal ? 'shell-gave-up' : 'timeout');
            assert.match(await error.textContent(), /Reload/);
            await page.clock.fastForward(60000);
            assert.equal(await error.count(), 1, 'genuine failure remains actionable');
            assert.equal(await page.evaluate(() => window.__watchdogIntervals.size), 0, 'genuine failure does not poll forever');
        }
        assert.equal(navigations, 1, 'no automatic reload loop'); assert.deepEqual(errors, []);
        console.log('PASS ' + name);
    } finally { release(); await ctx.close(); }
}
try {
    await scenario('deferred shell arrives after11s without a false Reload overlay', 11000, true);
    await scenario('deferred shell arrives after bounded timeout and removes existing Reload overlay', 30000, true);
    await scenario('loaded document without shell retains failure and stops polling', 0, false);
    await scenario('genuine shell surrender retains its failure and bounded monitor', 0, false, true);
} finally { await browser.close(); }
