// Real layout/focus regression. All HTTP responses are local fixtures; no Stripe transport.
// Run: PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit node shell/ezil/ui/Settings/sheet-frame-visibility-browser-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const req = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR ?? process.cwd(), 'noop.js'));
const { chromium } = req('playwright');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sheet-visibility-'));
let source;
try {
    const entry = path.join(temp, 'entry.js');
    const sourceDir = path.dirname(fileURLToPath(import.meta.url));
    await fs.writeFile(entry, `import { openSheetFrame } from ${JSON.stringify(path.join(sourceDir, 'sheet-frame.js'))};
import { isStripeModalFrame } from ${JSON.stringify(path.join(sourceDir, 'upgrade-sheet.js'))};
window.openSheetFrame = openSheetFrame; window.isStripeModalFrame = isStripeModalFrame;`);
    source = execFileSync('bun', ['build', entry, '--target=browser', '--format=iife'], { encoding: 'utf8' });
} finally { await fs.rm(temp, { recursive: true, force: true }); }
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let checks = 0;
try {
    for ( const [name, initial] of [
        ['zero width', 'width:0;height:200px;border:0'],
        ['zero height', 'width:300px;height:0;border:0'],
        ['scaled to zero', 'width:300px;height:200px;border:0;transform:scale(0)'],
        ['transparent frame', 'width:300px;height:200px;border:0;opacity:0'],
        ['transparent ancestor', 'width:300px;height:200px;border:0'],
    ] ) {
        const page = await browser.newPage();
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><button>Mock challenge</button>' }));
        await page.setContent('<!doctype html><body><button id="opener">Billing</button><main></main></body>');
        await page.addScriptTag({ content: source });
        await page.evaluate(({ name, initial }) => {
            const root = document.createElement('div');
            root.id = 'provider';
            if ( name === 'transparent ancestor' ) root.style.opacity = '0';
            root.innerHTML = '<iframe title="Mock challenge" src="https://js.stripe.com/v3/three-ds-2-challenge-0123456789abcdef0123456789abcdef.html" style="' + initial + '"></iframe>';
            document.body.append(root);
            document.querySelector('#opener').focus();
            const frame = openSheetFrame({ container: document.querySelector('main'), title: 'Checkout' });
            frame.content.innerHTML = '<input id="checkout" aria-label="Payment field">';
            document.querySelector('#checkout').focus();
            window.fixture = frame;
            frame.registerProviderPortals({ matchesFrame: isStripeModalFrame });
        }, { name, initial });
        const ownership = () => page.evaluate(() => ({
            inert: fixture.dialog.hasAttribute('inert'),
            modal: fixture.dialog.getAttribute('aria-modal'),
            focus: document.activeElement.id,
        }));
        assert.deepEqual(await ownership(), { inert: false, modal: 'true', focus: 'checkout' }, `${name}: invisible preload must not own focus`);
        checks++;
        await page.evaluate(() => {
            const root = document.querySelector('#provider');
            root.style.opacity = '1';
            root.firstElementChild.style.cssText = 'width:300px;height:200px;border:0';
        });
        await page.waitForFunction(() => fixture.dialog.hasAttribute('inert') && document.activeElement.tagName === 'IFRAME');
        checks++;
        const hide = () => page.evaluate(({ name, initial }) => {
            const root = document.querySelector('#provider');
            if ( name === 'transparent ancestor' ) root.style.opacity = '0';
            else root.firstElementChild.style.cssText = initial;
        }, { name, initial });
        await hide();
        await page.waitForFunction(() => !fixture.dialog.hasAttribute('inert') && document.activeElement.id === 'checkout');
        checks++;
        await page.evaluate(() => {
            const root = document.querySelector('#provider');
            root.style.opacity = '1';
            root.firstElementChild.style.cssText = 'width:300px;height:200px;border:0';
        });
        await page.waitForFunction(() => fixture.dialog.hasAttribute('inert'));
        await page.evaluate(() => { fixture.close(); });
        assert.equal(await page.locator('[role="dialog"]').count(), 1, `${name}: visible provider owns dismissal`);
        checks++;
        await hide();
        await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
        assert.equal(await page.evaluate(() => document.activeElement.id), 'opener', `${name}: hidden provider finishes queued close`);
        checks++;
        console.log(`PASS ${name}: preload, show, hide, close`);
        await page.close();
    }
    // An opacity fade begins with computed opacity zero. The style observer
    // alone cannot observe its final visible state, so transition completion must.
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><button>Mock challenge</button>' }));
    await page.setContent('<!doctype html><body><main></main></body>');
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
        const root = document.createElement('div');
        root.id = 'provider';
        root.style.cssText = 'opacity:0;transition:opacity 100ms linear';
        root.innerHTML = '<iframe src="https://js.stripe.com/v3/three-ds-2-challenge-0123456789abcdef0123456789abcdef.html" style="width:300px;height:200px;border:0"></iframe>';
        document.body.append(root);
        window.fixture = openSheetFrame({ container: document.querySelector('main'), title: 'Checkout' });
        fixture.registerProviderPortals({ matchesFrame: isStripeModalFrame });
        void root.offsetWidth;
        root.style.opacity = '1';
    });
    await page.waitForFunction(() => fixture.dialog.hasAttribute('inert') && document.activeElement.tagName === 'IFRAME');
    checks++;
    await page.close();
    console.log('PASS opacity transition activates visible provider without another style mutation');
    console.log(`${checks} real browser assertions passed`);
} finally { await browser.close(); }
