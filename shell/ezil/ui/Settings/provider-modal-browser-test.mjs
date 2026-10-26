// Real Chromium layout and focus against the source Settings modules. The
// provider frames and billing transport are LOCAL SIMULATIONS. This does not
// execute Stripe, connect a bank, pay, or validate the live Stripe bank flow.
// All URLs are intercepted; only parent-owned iframe elements are inspected.
// No committed shell bundle is read or generated.
//
// PLAYWRIGHT_REQUIRE_DIR=/path/to/existing/node_modules \
// TMPDIR="$PWD/.tmp" node shell/ezil/ui/Settings/provider-modal-browser-test.mjs
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
    console.error('SKIP: installed Playwright is unavailable; a DOM simulation cannot prove browser layout.');
    process.exit(2);
}

const sourceDir = process.env.SOURCE_SETTINGS_DIR || here;
const baseline = process.env.EXPECT_BASELINE_FAILURE === '1';
// The CI shell job already installs pinned Bun; no app-only esbuild dependency.
const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-modal-source-'));
let source;
try {
    const entry = path.join(buildDir, 'entry.js');
    await fs.writeFile(entry, `import { openUpgradeSheet } from ${JSON.stringify(path.join(sourceDir, 'upgrade-sheet.js'))}; window.openUpgradeSheet = openUpgradeSheet;`);
    source = execFileSync('bun', ['build', entry, '--target=browser', '--format=iife'], { encoding: 'utf8' });
} finally { await fs.rm(buildDir, { recursive: true, force: true }); }
const css = await fs.readFile(path.join(sourceDir, 'upgrade-sheet.css'), 'utf8');
const output = path.join(path.resolve(process.env.TMPDIR || '.tmp'), 'provider-modal-browser');
await fs.mkdir(output, { recursive: true });

const fixtureOrigin = 'https://checkout-fixture.test';
const providerOrigin = 'https://js.stripe.com';
const providerPaths = new Set([
    '/v3/linked-accounts-inner-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html',
    '/v3/universal-link-modal-inner-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.html',
    '/v3/embedded-checkout-modal-7e9062bdebb7787bd35541947181c8612c500a68.html',
]);
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const receipts = [];
try {
    for ( const preexisting of [false, true] ) for ( const viewport of [{ width: 691, height: 1536 }, { width: 1440, height: 900 }] ) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if ( url.origin === fixtureOrigin && url.pathname === '/' ) return route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><button id="opener">Open checkout fixture</button><main id="container"></main><aside id="already-inert" inert>Previously inert</aside><div id="os-window">OS window at its maximum stack</div></body></html>',
            });
            if ( url.origin === providerOrigin && providerPaths.has(url.pathname) && ! url.username && ! url.password ) {
                const label = url.pathname.includes('/embedded-checkout-modal-') ? 'Embedded Checkout follow-up'
                    : url.pathname.includes('/universal-link-modal-inner-') ? 'Link continuation' : 'Bank connection consent';
                return route.fulfill({
                    contentType: 'text/html',
                    body: `<!doctype html><html><body style="margin:0;background:#f8f8fa;font:24px system-ui;color:#161619;display:grid;place-items:center;height:100vh"><div style="max-width:420px;padding:32px"><strong>Simulated provider dialog</strong><p>${label}</p><button onclick="parent.postMessage('fixture-success','https://checkout-fixture.test')">Success</button><p style="font-size:16px">Local fixture only. No bank connection or payment.</p></div><script>document.addEventListener('keydown', event => { if(event.key === 'Escape') parent.postMessage('fixture-dismiss','https://checkout-fixture.test'); });</script></body></html>`,
                });
            }
            return route.abort('blockedbyclient');
        });
        await page.goto(`${fixtureOrigin}/`);
        await page.addStyleTag({ content: css + '\nbody { margin: 0; } #os-window { position:fixed; inset:0; z-index:999999999; background:#345; color:white; padding:24px; } #ezil-embedded-checkout iframe { width:100%; height:360px; border:0; background:white; }' });
        await page.addScriptTag({ content: source });
        await page.evaluate(preexisting => {
            const counts = { sessions: 0, initialized: 0, mounted: 0, destroyed: 0, done: 0, closed: 0 };
            const offer = { sku: 'standard_monthly_v3', name: 'Standard', priceCents: 2000, bullets: ['Usage included'] };
            const fixture = window.fixture = {
                counts,
                statusReply: { status: 'open', paymentStatus: 'unpaid' },
                statusReads: 0,
                closeProvider: id => document.getElementById(id).remove(),
                preloadCheckoutModal: () => {
                    const wrapper = document.createElement('div');
                    wrapper.id = 'provider-checkout-modal-wrapper';
                    wrapper.style.cssText = 'position:fixed;inset:0;z-index:2147483647;visibility:hidden;opacity:0;';
                    const iframe = document.createElement('iframe');
                    iframe.id = 'provider-checkout-modal';
                    iframe.title = 'Locally simulated embedded checkout secondary modal';
                    iframe.src = 'https://js.stripe.com/v3/embedded-checkout-modal-7e9062bdebb7787bd35541947181c8612c500a68.html';
                    iframe.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;';
                    wrapper.append(iframe);
                    document.body.prepend(wrapper);
                },
                showCheckoutModal: visible => {
                    const wrapper = document.getElementById('provider-checkout-modal-wrapper');
                    wrapper.style.visibility = visible ? 'visible' : 'hidden';
                    wrapper.style.opacity = visible ? '1' : '0';
                },
                addProvider: (id, wrapped = false) => {
                    const iframe = document.createElement('iframe');
                    iframe.id = id;
                    iframe.title = 'Locally simulated Stripe provider portal';
                    iframe.src = wrapped
                        ? 'https://js.stripe.com/v3/universal-link-modal-inner-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.html'
                        : 'https://js.stripe.com/v3/linked-accounts-inner-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html';
                    // Match Stripe's maximum stack and prepend ordering. The
                    // former equal-z checkout wins by appearing later in body.
                    iframe.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647;';
                    if ( wrapped ) {
                        const wrapper = document.createElement('div');
                        wrapper.id = `${id}-wrapper`;
                        wrapper.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
                        wrapper.append(iframe);
                        document.body.prepend(wrapper);
                    } else document.body.prepend(iframe);
                    return iframe;
                },
            };
            window.addEventListener('message', event => {
                if (event.source === document.getElementById('embedded-fixture')?.contentWindow) {
                    if (event.data === 'fixture-bank') fixture.addProvider('provider-first');
                    if (event.data === 'fixture-subscribe') fixture.addProvider('provider-second', true);
                    if (event.data === 'fixture-card') fixture.cardSelected = true;
                } else if (event.origin === 'https://js.stripe.com' && event.source === document.getElementById('provider-first')?.contentWindow && event.data === 'fixture-success') {
                    fixture.closeProvider('provider-first');
                    fixture.bankSelected = true;
                } else if (event.origin === 'https://js.stripe.com' && event.source === document.getElementById('provider-second')?.contentWindow && event.data === 'fixture-dismiss') {
                    document.getElementById('provider-second-wrapper').remove();
                }
            });
            if (preexisting) fixture.preloadCheckoutModal();
            const options = {
                container: document.getElementById('container'), sku: offer.sku, offer, sizes: [],
                onDone: () => counts.done++, onClose: () => counts.closed++,
                trpc: {
                    mutate: async (method) => {
                        if ( method !== 'billing.createCheckout' ) throw new Error(`Unexpected mutation ${method}`);
                        counts.sessions++;
                        return { mode: 'embedded', sessionId: 'cs_test_fixture', clientSecret: 'fixture_secret', publishableKey: 'pk_test_fixture' };
                    },
                    query: async method => {
                        if ( method === 'billing.checkoutStatus' ) { fixture.statusReads++; return fixture.statusReply; }
                        return { plan: { sku: 'free_v3' } };
                    },
                },
                loadStripe: async () => ({
                    [preexisting ? 'createEmbeddedCheckoutPage' : 'initEmbeddedCheckout']: async ({ fetchClientSecret, onComplete }) => {
                        counts.initialized++;
                        fixture.complete = onComplete;
                        if ( await fetchClientSecret() !== 'fixture_secret' ) throw new Error('Wrong fixture session');
                        return {
                            mount: selector => {
                                counts.mounted++;
                                const iframe = document.createElement('iframe');
                                iframe.id = 'embedded-fixture';
                                iframe.title = 'Local embedded checkout fixture';
                                iframe.srcdoc = `<body style="font:18px system-ui;padding:24px"><h2>Simulated checkout</h2><p>No payment or bank connection</p><button onclick="parent.postMessage('fixture-bank','*')">Bank</button><button onclick="parent.postMessage('fixture-card','*')">Card</button><button onclick="parent.postMessage('fixture-subscribe','*')">Subscribe</button><input aria-label="Card fixture field"></body>`;
                                document.querySelector(selector).append(iframe);
                                // Stripe preloads this hidden body portal when
                                // mounting Embedded Checkout, then shows it
                                // through its own outer_set_modal lifecycle.
                                if (!preexisting) fixture.preloadCheckoutModal();
                            },
                            destroy: () => {
                                counts.destroyed++;
                                document.getElementById('provider-checkout-modal-wrapper')?.remove();
                            },
                        };
                    },
                }),
            };
            document.getElementById('opener').focus();
            fixture.handle = window.openUpgradeSheet(options);
            fixture.openAgain = () => window.openUpgradeSheet(options);
        }, preexisting);
        await page.waitForSelector('#embedded-fixture');
        const initial = await page.evaluate(() => {
            const backdrop = document.querySelector('.ezil-upgrade-backdrop');
            const dialog = document.querySelector('[data-role="upgrade-sheet"]');
            const bounds = dialog.getBoundingClientRect();
            const top = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
            return {
                osZ: Number(getComputedStyle(document.getElementById('os-window')).zIndex),
                checkoutZ: Number(getComputedStyle(backdrop).zIndex),
                checkoutTop: backdrop.contains(top),
                inViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
                bodyLocked: document.body.style.overflow === 'hidden',
                backgroundInert: document.getElementById('container').inert && document.getElementById('os-window').inert,
                compact: backdrop.classList.contains('is-compact'),
                preloadHidden: getComputedStyle(document.getElementById('provider-checkout-modal-wrapper')).visibility === 'hidden',
                preloadDoesNotClaimModality: dialog.getAttribute('aria-modal') === 'true' && ! dialog.inert && dialog.contains(document.activeElement),
            };
        });
        assert.equal(initial.osZ, 999999999);
        if (!baseline) assert.equal(initial.checkoutZ, 1000000000);
        assert.equal(initial.checkoutTop, true, 'checkout is hit-tested above the raised OS window');
        assert.equal(initial.inViewport, true, 'checkout fits the viewport');
        assert.equal(initial.bodyLocked, true);
        assert.equal(initial.backgroundInert, true);
        assert.equal(initial.compact, viewport.width < 760);
        assert.equal(initial.preloadHidden, true);
        assert.equal(initial.preloadDoesNotClaimModality, true, 'the invisible checkout modal preload leaves base checkout accessible');

        if (!baseline) {
            const isolated = await page.evaluate(async () => {
                const roots = [];
                for (const src of ['https://js.stripe.com.evil.test/v3/linked-accounts-inner-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html', 'https://js.stripe.com/v3/unrelated.html', 'https://user@js.stripe.com/v3/linked-accounts-inner-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html', 'srcdoc']) {
                    const root = document.createElement('div');
                    root.hidden = true;
                    const frame = document.createElement('iframe');
                    frame.src = src === 'srcdoc' ? 'https://js.stripe.com/v3/linked-accounts-inner-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html' : src;
                    if (src === 'srcdoc') frame.srcdoc = '<button>Untrusted</button>';
                    root.append(frame); document.body.append(root); roots.push(root);
                }
                await new Promise(resolve => setTimeout(resolve,0));
                const result = roots.every(root => root.inert);
                roots.forEach(root => root.remove());
                return result;
            });
            assert.equal(isolated, true, 'unrecognized URLs, credentials and srcdoc retain background isolation');
        }
        // Interact with our simulated checkout document, never a real provider.
        await page.frameLocator('#embedded-fixture').getByRole('button', { name: 'Card', exact: true }).click();
        await page.frameLocator('#embedded-fixture').getByRole('textbox').fill('synthetic-card-input');
        // postMessage is asynchronous across the fixture iframe boundary.
        await page.waitForFunction(() => window.fixture.cardSelected === true, null, { timeout: 8000 });
        assert.equal(await page.evaluate(() => window.fixture.cardSelected), true);
        await page.frameLocator('#embedded-fixture').getByRole('button', { name: 'Bank', exact: true }).click();
        await page.waitForSelector('#provider-first', { state: 'attached' });
        await page.waitForTimeout(50);
        if (baseline) {
            const failure = await page.evaluate(() => {
                const iframe = document.getElementById('provider-first');
                iframe.focus();
                return { top: document.elementFromPoint(innerWidth/2,innerHeight/2) === iframe, focused: document.activeElement === iframe };
            });
            assert.equal(failure.top, false);
            assert.equal(failure.focused, false);
            await page.screenshot({path:path.join(output, `${viewport.width}-${preexisting}-baseline-failure.png`)});
            receipts.push({viewport,preexisting,initial,failure});
            await context.close();
            continue;
        }
        const first = await page.evaluate(() => {
            const iframe = document.getElementById('provider-first');
            iframe.focus();
            const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            iframe.dispatchEvent(event);
            return {
                providerZ: Number(getComputedStyle(iframe).zIndex),
                providerPrecedesCheckout: !! (iframe.compareDocumentPosition(document.querySelector('.ezil-upgrade-backdrop')) & Node.DOCUMENT_POSITION_FOLLOWING),
                top: document.elementFromPoint(innerWidth / 2, innerHeight / 2) === iframe,
                focused: document.activeElement === iframe,
                escapeNotCaptured: ! event.defaultPrevented,
                modalRetained: !! document.querySelector('[data-role="upgrade-sheet"]'),
                checkoutIsNotActiveModal: document.querySelector('[data-role="upgrade-sheet"]')?.getAttribute('aria-modal') !== 'true',
                counts: { ...window.fixture.counts },
            };
        });
        assert.equal(first.providerZ, 2147483647);
        assert.equal(first.providerPrecedesCheckout, true, 'simulated provider matches Stripe prepend ordering');
        assert.equal(first.top, true, 'provider is hit-tested above checkout');
        assert.equal(first.focused, true, 'parent sheet does not steal provider focus');
        assert.equal(first.escapeNotCaptured, true, 'parent lets provider own Escape');
        assert.equal(first.modalRetained, true, 'provider Escape leaves checkout alive');
        assert.equal(first.checkoutIsNotActiveModal, true);
        assert.deepEqual(first.counts, { sessions: 1, initialized: 1, mounted: 1, destroyed: 0, done: 0, closed: 0 });
        await page.screenshot({ path: path.join(output, `${viewport.width}-${preexisting}-provider-first.png`) });

        // Model the reported transition: the first bank modal is replaced by a
        // second body portal. Parent checkout and its sole session must survive.
        await page.frameLocator('#provider-first').getByRole('button', {name:'Success',exact:true}).click();
        await page.waitForFunction(() => window.fixture.bankSelected && !document.getElementById('provider-first'));
        await page.frameLocator('#embedded-fixture').getByRole('button', {name:'Subscribe',exact:true}).click();
        await page.waitForFunction(() => document.getElementById('provider-second') && ! document.getElementById('provider-second').closest('[inert]'));
        const second = await page.evaluate(() => {
            const iframe = document.getElementById('provider-second');
            iframe.focus();
            const backdrop = document.querySelector('.ezil-upgrade-backdrop');
            // A click that belongs to the provider lifecycle cannot dismiss the
            // parent, even when a provider's transparent surface reveals it.
            backdrop.click();
            return {
                top: document.elementFromPoint(innerWidth / 2, innerHeight / 2) === iframe,
                providerPrecedesCheckout: !! (iframe.parentElement.compareDocumentPosition(backdrop) & Node.DOCUMENT_POSITION_FOLLOWING),
                focused: document.activeElement === iframe,
                modalRetained: !! document.querySelector('[data-role="upgrade-sheet"]'),
                backgroundInert: document.getElementById('container').inert,
                sameHandle: window.fixture.openAgain() === window.fixture.handle,
                counts: { ...window.fixture.counts },
            };
        });
        assert.equal(second.top, true, 'secondary provider remains above checkout');
        assert.equal(second.providerPrecedesCheckout, true);
        assert.equal(second.focused, true);
        assert.equal(second.modalRetained, true);
        assert.equal(second.backgroundInert, true);
        assert.equal(second.sameHandle, true);
        assert.deepEqual(second.counts, { sessions: 1, initialized: 1, mounted: 1, destroyed: 0, done: 0, closed: 0 });
        await page.screenshot({ path: path.join(output, `${viewport.width}x${viewport.height}-${preexisting}-provider-second.png`) });

        // Once bank consent closes, Stripe can show its separately preloaded
        // Embedded Checkout modal. Exercise that third body-portal lifecycle.
        // Wait for the simulated cross-origin document, then focus it through
        // a normal pointer action before physical key dispatch.
        console.log('second document pointer focus');
        await page.frameLocator('#provider-second').getByText('Link continuation', {exact:true}).click();
        console.log('physical Escape');
        await page.keyboard.press('Escape');
        console.log('waiting second dismissal');
        await page.waitForFunction(() => !document.getElementById('provider-second-wrapper'));
        console.log('second dismissed');
        assert.equal(await page.locator('#embedded-fixture').count(), 1, 'provider Escape retains checkout');
        await page.evaluate(() => window.fixture.showCheckoutModal(true));
        await page.waitForFunction(() => ! document.getElementById('provider-checkout-modal').closest('[inert]')
            && document.querySelector('[data-role="upgrade-sheet"]').inert);
        const third = await page.evaluate(() => {
            const iframe = document.getElementById('provider-checkout-modal');
            const wrapper = iframe.parentElement;
            const backdrop = document.querySelector('.ezil-upgrade-backdrop');
            iframe.focus();
            const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            iframe.dispatchEvent(event);
            return {
                top: document.elementFromPoint(innerWidth / 2, innerHeight / 2) === iframe,
                visible: getComputedStyle(wrapper).visibility === 'visible' && getComputedStyle(wrapper).opacity === '1',
                providerPrecedesCheckout: !! (wrapper.compareDocumentPosition(backdrop) & Node.DOCUMENT_POSITION_FOLLOWING),
                focused: document.activeElement === iframe,
                escapeNotCaptured: ! event.defaultPrevented,
                modalRetained: !! document.querySelector('[data-role="upgrade-sheet"]'),
                counts: { ...window.fixture.counts },
            };
        });
        assert.equal(third.top, true, 'the separately preloaded checkout modal is above the OS overlay after bank consent');
        assert.equal(third.visible, true);
        assert.equal(third.providerPrecedesCheckout, true);
        assert.equal(third.focused, true);
        assert.equal(third.escapeNotCaptured, true);
        assert.equal(third.modalRetained, true);
        assert.deepEqual(third.counts, { sessions: 1, initialized: 1, mounted: 1, destroyed: 0, done: 0, closed: 0 });
        await page.screenshot({ path: path.join(output, `${viewport.width}x${viewport.height}-${preexisting}-provider-checkout-modal.png`) });

        await page.evaluate(() => window.fixture.showCheckoutModal(false));
        await page.waitForFunction(() => document.querySelector('[data-role="upgrade-sheet"]')?.contains(document.activeElement));
        const recovered = await page.evaluate(() => {
            const dialog = document.querySelector('[data-role="upgrade-sheet"]');
            const checkout = document.getElementById('embedded-fixture');
            checkout.focus();
            return {
                activeModal: dialog.getAttribute('aria-modal') === 'true',
                checkoutFocusable: document.activeElement === checkout,
                checkoutRetained: checkout.isConnected && ! checkout.closest('[hidden], [inert]'),
                counts: { ...window.fixture.counts },
            };
        });
        assert.equal(recovered.activeModal, true);
        assert.equal(recovered.checkoutFocusable, true, 'user can continue in the existing payment form');
        assert.equal(recovered.checkoutRetained, true);
        assert.deepEqual(recovered.counts, { sessions: 1, initialized: 1, mounted: 1, destroyed: 0, done: 0, closed: 0 });
        await page.screenshot({ path: path.join(output, `${viewport.width}x${viewport.height}-${preexisting}-checkout-recovered.png`) });

        assert.equal(await page.frameLocator('#embedded-fixture').getByRole('textbox').inputValue(), 'synthetic-card-input');
        await page.frameLocator('#embedded-fixture').getByRole('button', {name:'Card',exact:true}).click();

        await page.locator('[data-action="close-sheet"]').focus();
        console.log('physical Escape');
        await page.keyboard.press('Escape');
        const closed = await page.evaluate(() => ({
            absent: ! document.querySelector('[data-role="upgrade-sheet"]'),
            openerFocused: document.activeElement === document.getElementById('opener'),
            scrollRestored: document.body.style.overflow === '',
            backgroundRestored: ! document.getElementById('container').inert && ! document.getElementById('os-window').inert,
            priorInertRetained: document.getElementById('already-inert').inert,
            preloadDestroyed: ! document.getElementById('provider-checkout-modal-wrapper'),
            counts: { ...window.fixture.counts },
        }));
        assert.equal(closed.absent, true, 'Escape resumes normal parent dismissal');
        assert.equal(closed.openerFocused, true);
        assert.equal(closed.scrollRestored, true);
        assert.equal(closed.backgroundRestored, true);
        assert.equal(closed.priorInertRetained, true);
        assert.equal(closed.preloadDestroyed, true);
        assert.deepEqual(closed.counts, { sessions: 1, initialized: 1, mounted: 1, destroyed: 1, done: 0, closed: 1 });
        assert.deepEqual(errors, []);
        receipts.push({ viewport, preexisting, initial, first, second, third, recovered, cardInputPreserved: true, closed, errors });
        console.log(`PASS real Chromium ${viewport.width}x${viewport.height}: OS < checkout < three simulated provider portals; preload/focus/Escape/close recovery; one checkout session`);
        await context.close();
    }
    await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify({ simulatedProvider: true, actualStripeBankFlow: false, receipts }, null, 2) + '\n');
    console.log(`Browser fixture receipts: ${output}`);
} finally { await browser.close(); }
