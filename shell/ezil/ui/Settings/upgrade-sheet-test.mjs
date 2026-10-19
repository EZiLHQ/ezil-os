// upgrade-sheet-test.mjs — EZiL-authored. Like the Settings harness, this
// drives DOM controls in jsdom with no transport. Bundle the real modules
// so fake Stripe and a deterministic clock exercise every race.
import { summaryV3 } from './billing-v3-fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [path.resolve(here, '../../../../app')] }));
const source = (await build({
    stdin: { contents: "import * as checkout from './upgrade-sheet.js'; window.sheetApi = checkout;", resolveDir: here },
    bundle: true, write: false, format: 'iife', target: 'es2022',
})).outputFiles[0].text;
const css = fs.readFileSync(new URL('./upgrade-sheet.css', import.meta.url), 'utf8');
const embedded = { mode: 'embedded', sessionId: 'cs_test', clientSecret: 'test_client_secret', publishableKey: 'pk_test' };
const standard = { enabled: true, version: 2, plan: { sku: 'standard_monthly_v2' } };
const sizes = [
    { code: 'std-2', vcpu: 2, memoryGiB: 8, weight: 1 },
    { code: 'cmp-4', vcpu: 4, memoryGiB: 16, weight: 2 },
    { code: 'cmp-8', vcpu: 8, memoryGiB: 32, weight: 4 },
];
const offer = { sku: 'standard_monthly_v2', family: 'standard', priceCents: 2300, currency: 'usd', interval: 'month', allowanceStdSeconds: 63 * 3600, sizes: ['std-2'], overage: null };
const computeOffer = { ...offer, sku: 'compute_monthly_v2', family: 'compute', priceCents: 12345, allowanceStdSeconds: 510 * 3600, sizes: sizes.map(size => size.code), overage: { centsPerStdHour: 30, defaultCapCents: 2500, maxCapCents: 10000 } };
const banned = /faster|instant|unlimited|priority|gpu|heavy\s+use|gpt|claude|gemini|llama|memory\s+is\s+kept|memory\s+survives|processes\s+keep\s+running|ai\s+included|includes\s+ai|compute\s+hours|standard-hour/i;
const free = { enabled: true, version: 2, plan: { sku: 'free_v2' } };
const settle = async () => { for ( let i = 0; i < 20; i++ ) await Promise.resolve(); };
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function harness () {
    const dom = new JSDOM('<!doctype html><body><button id="opener">Subscribe to Standard</button><main id="container"></main></body>', {
        runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/os',
    });
    const { window } = dom;
    const document = window.document;
    let time = 0;
    let nextId = 0;
    const timers = new Map();
    window.setTimeout = (callback, delay) => {
        const id = ++nextId;
        timers.set(id, { at: time + delay, callback });
        return id;
    };
    window.clearTimeout = id => timers.delete(id);
    const tick = async ms => {
        const end = time + ms;
        await settle();
        for (;;) {
            const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            if ( ! next || next[1].at > end ) break;
            time = next[1].at;
            timers.delete(next[0]);
            next[1].callback();
            await settle();
        }
        time = end;
        await settle();
    };
    window.eval(source);
    const rendered = [];
    const observer = new window.MutationObserver(() => {
        const sheet = document.querySelector('[data-role="upgrade-sheet"]');
        if ( sheet ) rendered.push(sheet.textContent);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const calls = [];
    const opens = [];
    window.open = (...args) => { opens.push(args); return null; };
    let complete;
    let destroyed = 0;
    let mounted = 0;
    let loaded = 0;
    let done = 0;
    let closed = 0;
    const h = {
        dom, window, document, timers, tick, calls, opens, rendered, v3: false,
        q: selector => document.querySelector(selector),
        text: () => document.querySelector('[data-role="upgrade-sheet"]')?.textContent ?? '',
        create: async () => embedded,
        status: async () => 'complete',
        summary: async () => standard,
        get mounted () { return mounted; },
        get destroyed () { return destroyed; },
        get loaded () { return loaded; },
        get done () { return done; },
        get closed () { return closed; },
        complete: () => complete(),
        count: method => calls.filter(call => call.method === method).length,
        click: selector => {
            const element = document.querySelector(selector);
            assert.ok(element, `click target exists: ${selector}`);
            element.click();
        },
        key: (key, shiftKey = false) => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })),
    };
    const instance = {
        mount: selector => {
            mounted++;
            assert.equal(selector, '#ezil-embedded-checkout');
            assert.ok(h.q(selector), 'real Stripe target exists when mounted');
            const iframe = document.createElement('iframe');
            iframe.title = 'Secure payment form';
            h.q(selector).append(iframe);
        },
        destroy: () => { destroyed++; },
    };
    h.instance = instance;
    h.stripe = {
        initEmbeddedCheckout: async ({ fetchClientSecret, onComplete }) => {
            assert.equal(await fetchClientSecret(), embedded.clientSecret);
            complete = onComplete;
            return instance;
        },
    };
    h.loadStripe = async key => { loaded++; assert.equal(key, embedded.publishableKey); return h.stripe; };
    h.trpc = {
        mutate: async (method, input) => { calls.push({ method, input }); return h.create(); },
        query: async (method, input) => {
            calls.push({ method, input });
            return method === 'billing.checkoutStatus' ? h.status() : h.summary();
        },
    };
    h.open = (options = {}) => {
        h.handle = window.sheetApi.openUpgradeSheet({
            container: h.q('#container'), sku: offer.sku, offer, sizes, trpc: h.trpc,
            onDone: () => { done++; }, onClose: () => { closed++; }, loadStripe: h.loadStripe, now: () => time, ...options,
        });
        return h.handle;
    };
    h.cleanup = () => { h.handle?.close(); window.close(); };
    h.q('#opener').focus();
    return h;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('page-level sheet escapes Settings geometry and restores page scrolling on close', async h => {
    const container = h.q('#container');
    container.style.cssText = 'width: 760px; height: 560px; position: static; overflow: hidden;';
    const originalStyle = container.getAttribute('style');
    h.document.body.style.overflow = 'auto';
    h.open();
    await settle();
    const sheet = h.q('[data-role="upgrade-sheet"]');
    const backdrop = sheet.parentElement;
    assert.equal(backdrop.parentElement, h.document.body, 'body owns the backdrop and its dialog');
    assert.equal(container.contains(sheet), false, 'positive ownership is document.body above');
    assert.equal(container.getAttribute('style'), originalStyle);
    assert.equal(h.document.body.style.overflow, 'hidden');
    assert.ok(container.hasAttribute('inert'));
    assert.equal(h.mounted, 1);
    h.handle.close();
    assert.equal(h.q('[data-role="upgrade-sheet"]'), null, 'page-level dialog existed above');
    assert.equal(h.document.body.style.overflow, 'auto');
    assert.equal(container.hasAttribute('inert'), false, 'container was inert while the dialog was open');
    assert.equal(h.destroyed, 1);
});

test('backdrop dismisses idle checkout but preserves confirmation until it finishes', async h => {
    h.summary = async () => free;
    h.open();
    await settle();
    const first = h.q('[data-role="upgrade-sheet"]');
    h.click('.ezil-upgrade-payment');
    assert.equal(h.q('[data-role="upgrade-sheet"]'), first, 'clicks inside the dialog keep it open');
    h.click('.ezil-upgrade-backdrop');
    assert.equal(h.q('[data-role="upgrade-sheet"]'), null, 'the same idle dialog closes on its backdrop');
    assert.equal(h.destroyed, 1);
    h.open();
    await settle();
    h.complete();
    const confirming = h.q('[data-role="upgrade-sheet"]');
    h.click('.ezil-upgrade-backdrop');
    assert.equal(h.q('[data-role="upgrade-sheet"]'), confirming, 'onComplete protects even the pending status read');
    await settle();
    assert.match(h.text(), /Confirming your payment…/);
    assert.ok(h.timers.size > 0);
    h.click('.ezil-upgrade-backdrop');
    assert.equal(h.q('[data-role="upgrade-sheet"]'), confirming, 'receipt verification also keeps the dialog open');
    assert.equal(h.destroyed, 1, 'only the earlier idle checkout was destroyed');
    h.summary = async () => standard;
    await h.tick(1500);
    assert.ok(h.q('[data-role="upgrade-success"]'));
    h.click('.ezil-upgrade-backdrop');
    assert.equal(h.q('[data-role="upgrade-sheet"]'), null, 'finished confirmation permits backdrop dismissal');
    assert.equal(h.destroyed, 2);
    assert.equal(h.timers.size, 0, 'verification timers existed above');
});

test('redirect polling allows dismissal before payment and protects a received payment until timeout', async h => {
    h.create = async () => ({ mode: 'redirect', sessionId: 'cs_redirect', url: 'https://checkout.stripe.com/test' });
    h.status = async () => ({ status: 'pending' });
    h.open();
    await settle();
    assert.match(h.text(), /Finish in the new tab/);
    h.click('.ezil-upgrade-backdrop');
    assert.equal(h.q('[data-role="upgrade-sheet"]'), null, 'pending hosted checkout was visible above');
    h.status = async () => ({ status: 'complete' });
    h.summary = async () => free;
    h.open();
    await settle();
    assert.match(h.text(), /Confirming your payment…/);
    const sheet = h.q('[data-role="upgrade-sheet"]');
    h.click('.ezil-upgrade-backdrop');
    assert.equal(h.q('[data-role="upgrade-sheet"]'), sheet);
    await h.tick(60000);
    assert.match(h.text(), /Payment received — your plan updates in a moment/);
    h.click('.ezil-upgrade-backdrop');
    assert.equal(h.q('[data-role="upgrade-sheet"]'), null, 'timeout releases the protected dialog above');
});

test('viewport width controls the compact class at 760px and resize cleanup releases its listener', async h => {
    h.window.innerWidth = 390;
    h.open();
    const backdrop = h.q('.ezil-upgrade-backdrop');
    const summary = h.q('details');
    assert.ok(backdrop.classList.contains('is-compact'));
    assert.equal(summary.open, false, 'desktop expansion is the positive control below');
    assert.equal(h.q('.ezil-upgrade-compact-title').textContent, 'EZiL Standard · $23/month · before applicable tax');
    assert.equal(h.q('.ezil-upgrade-compact-title').hidden, false);
    h.window.innerWidth = 760;
    h.window.dispatchEvent(new h.window.Event('resize'));
    assert.equal(backdrop.classList.contains('is-compact'), false, '390px applied the compact class above');
    assert.equal(summary.open, true);
    assert.equal(h.q('.ezil-upgrade-compact-title').hidden, true, 'compact title was visible above');
    h.window.innerWidth = 759;
    h.window.dispatchEvent(new h.window.Event('resize'));
    assert.ok(backdrop.classList.contains('is-compact'));
    h.handle.close();
    h.window.innerWidth = 1280;
    h.window.dispatchEvent(new h.window.Event('resize'));
    assert.ok(backdrop.classList.contains('is-compact'), 'released listener cannot update the detached backdrop; live resize did above');
    h.open();
    assert.equal(h.q('details').open, true);
    assert.equal(h.q('.ezil-upgrade-backdrop').classList.contains('is-compact'), false, 'the fresh desktop sheet differs from the compact sheet above');
});

test('embedded payment verifies status, waits for the webhook, then Done refreshes and closes', async h => {
    let summaries = 0;
    h.create = async () => ({ ok: true, data: embedded });
    h.summary = async () => ({ ok: true, data: ++summaries === 1 ? free : standard });
    h.open();
    assert.equal(h.q('[role="dialog"]').getAttribute('aria-modal'), 'true');
    await settle();
    assert.equal(h.mounted, 1);
    assert.equal(h.calls[0].method, 'billing.createCheckout');
    assert.equal(h.calls[0].input.sku, 'standard_monthly_v2');
    h.complete();
    assert.match(h.text(), /Confirming your payment…/);
    await settle();
    assert.equal(h.count('billing.checkoutStatus'), 1);
    assert.equal(h.calls.find(call => call.method === 'billing.checkoutStatus').input.sessionId, 'cs_test');
    assert.equal(h.q('[data-role="upgrade-success"]'), null, 'free summary cannot grant Standard; positive control after webhook below');
    assert.ok(h.timers.size > 0, 'confirmation has scheduled its next read and deadline');
    await h.tick(1500);
    assert.ok(h.q('[data-role="upgrade-success"]'));
    assert.match(h.text(), /You're on EZiL Standard/);
    assert.match(h.text(), /63 standard-hours each billing period/);
    assert.ok(h.q('[data-action="done"]'));
    h.click('[data-action="done"]');
    assert.equal(h.done, 1);
    assert.equal(h.destroyed, 1);
    assert.equal(h.q('[data-role="upgrade-sheet"]'), null, 'positive dialog control above');
    assert.equal(h.timers.size, 0, 'confirmation scheduled timers before success');
    assert.equal(h.document.activeElement, h.q('#opener'));
});

test('double open shares one pending checkout; closing and reopening starts a fresh session', async h => {
    const pending = deferred();
    h.create = () => pending.promise;
    const first = h.open();
    assert.equal(h.open(), first);
    assert.equal(h.count('billing.createCheckout'), 1);
    first.close();
    pending.resolve(embedded);
    await settle();
    assert.equal(h.loaded, 0, 'closed response must not load Stripe; reopened positive control below');
    h.create = async () => embedded;
    h.open();
    await settle();
    assert.equal(h.count('billing.createCheckout'), 2);
    assert.equal(h.loaded, 1);
    assert.equal(h.mounted, 1);
});

test('close during confirmation destroys checkout and cancels every polling timer', async h => {
    h.status = async () => ({ status: 'pending' });
    h.open();
    await settle();
    h.complete();
    await settle();
    assert.equal(h.count('billing.checkoutStatus'), 1);
    assert.equal(h.timers.size, 2, 'poll and deadline are both active');
    h.click('[data-action="close-sheet"]');
    assert.equal(h.destroyed, 1);
    assert.equal(h.timers.size, 0);
    await h.tick(60000);
    assert.equal(h.count('billing.checkoutStatus'), 1, 'positive query above must not recur after close');
    assert.equal(h.document.activeElement, h.q('#opener'));
});

test('late Stripe initialization is destroyed without mounting into a reopened sheet', async h => {
    const initialization = deferred();
    h.stripe.initEmbeddedCheckout = () => initialization.promise;
    h.open();
    await settle();
    h.handle.close();
    initialization.resolve(h.instance);
    await settle();
    assert.equal(h.destroyed, 1);
    assert.equal(h.mounted, 0, 'late closed initialization must not mount; next open is positive control');
    h.stripe.initEmbeddedCheckout = async () => h.instance;
    h.open();
    await settle();
    assert.equal(h.mounted, 1);
});

test('current Stripe.js createEmbeddedCheckoutPage is preferred over the legacy initializer', async h => {
    let legacyCalls = 0;
    h.stripe.initEmbeddedCheckout = async () => { legacyCalls++; return h.instance; };
    h.stripe.createEmbeddedCheckoutPage = async ({ fetchClientSecret }) => {
        assert.ok(await fetchClientSecret());
        return h.instance;
    };
    h.open();
    await settle();
    assert.equal(h.mounted, 1, 'the new initializer mounts the form');
    assert.equal(legacyCalls, 0, 'legacy initializer is only a fallback (positive control: every other test uses it alone)');
});

test('Stripe load failure retries the loader without creating another checkout', async h => {
    let attempts = 0;
    h.open({ loadStripe: async () => { if ( ++attempts === 1 ) throw new Error('offline'); return h.stripe; } });
    await settle();
    assert.match(h.text(), /Couldn't load the secure payment form — Try again/);
    assert.equal(h.mounted, 0, 'failed load cannot mount; Retry below does mount');
    h.click('[data-action="retry"]');
    await settle();
    assert.equal(attempts, 2);
    assert.equal(h.mounted, 1);
    assert.equal(h.count('billing.createCheckout'), 1);
});

test('redirect checkout opens a safe new tab and polls pending → complete every 1.5 seconds', async h => {
    h.create = async () => ({ mode: 'redirect', sessionId: 'cs_redirect', url: 'https://checkout.stripe.com/test' });
    let polls = 0;
    h.status = async () => ({ status: ++polls === 1 ? 'pending' : 'complete' });
    h.open();
    await settle();
    assert.deepEqual(h.opens, [['https://checkout.stripe.com/test', '_blank', 'noopener']]);
    assert.match(h.text(), /Finish in the new tab/);
    assert.equal(h.count('billing.checkoutStatus'), 1);
    assert.equal(h.count('billing.summary'), 0, 'pending checkout cannot fetch grants; complete control below');
    await h.tick(1499);
    assert.equal(h.count('billing.checkoutStatus'), 1);
    await h.tick(1);
    assert.equal(h.count('billing.checkoutStatus'), 2);
    assert.equal(h.count('billing.summary'), 1);
    assert.ok(h.q('[data-role="upgrade-success"]'));
});

test('summary that never grants Standard gets the honest timeout, not a success claim', async h => {
    h.summary = async () => free;
    h.open();
    await settle();
    h.complete();
    await settle();
    assert.ok(h.timers.size > 0);
    await h.tick(59999);
    assert.match(h.text(), /Confirming your payment…/);
    await h.tick(1);
    assert.match(h.text(), /Payment received — your plan updates in a moment\./);
    assert.equal(h.q('[data-role="upgrade-success"]'), null, 'a timely Standard response supplies the success control below');
    assert.equal(h.timers.size, 0, 'deadline was active above');
    const reads = h.count('billing.summary');
    await h.tick(60000);
    assert.equal(h.count('billing.summary'), reads, 'positive summary reads stop at the deadline');
    h.handle.close();
    h.summary = async () => standard;
    h.open();
    await settle();
    h.complete();
    await settle();
    assert.ok(h.q('[data-role="upgrade-success"]'), 'a timely Standard summary does produce success');
});

test('hung status and late summary cannot outrun the total deadline', async h => {
    const pending = deferred();
    h.status = () => pending.promise;
    h.open();
    await settle();
    h.complete();
    await settle();
    assert.equal(h.count('billing.checkoutStatus'), 1);
    await h.tick(60000);
    assert.match(h.text(), /We could not confirm your payment yet/);
    pending.resolve({ status: 'complete' });
    await settle();
    assert.equal(h.count('billing.summary'), 0, 'late status cannot restart polling; timely status reads summary below');
    h.handle.close();
    h.status = async () => ({ status: 'complete' });
    const summary = deferred();
    h.summary = () => summary.promise;
    h.open();
    await settle();
    h.complete();
    await settle();
    assert.equal(h.count('billing.summary'), 1);
    await h.tick(60000);
    summary.resolve(standard);
    await settle();
    assert.match(h.text(), /Payment received — your plan updates in a moment/);
    assert.equal(h.q('[data-role="upgrade-success"]'), null, 'timely Standard response succeeds in the control below');
    h.handle.close();
    h.summary = async () => standard;
    h.open();
    await settle();
    h.complete();
    await settle();
    assert.ok(h.q('[data-role="upgrade-success"]'));
});

test('createCheckout errors are escaped inline and Retry creates a working session', async h => {
    let attempts = 0;
    h.create = async () => ++attempts === 1 ? { ok: false, message: '<img src=x onerror=alert(1)> unavailable' } : embedded;
    h.open();
    await settle();
    assert.match(h.text(), /Could not reach billing. Try again./);
    assert.equal(h.q('[data-role="checkout-state"] img'), null, 'unrecognized server errors map to safe fallback copy');
    assert.equal(h.q('[data-action="retry"]').textContent, 'Retry');
    h.click('[data-action="retry"]');
    await settle();
    assert.equal(h.count('billing.createCheckout'), 2);
    assert.equal(h.mounted, 1);
});

test('focus is trapped in both directions, ESC restores focus and background interactivity', async h => {
    h.create = async () => { throw new Error('Checkout unavailable.'); };
    h.open();
    await settle();
    const close = h.q('[data-action="close-sheet"]');
    const retry = h.q('[data-action="retry"]');
    assert.equal(h.document.activeElement, close);
    assert.ok(h.q('#opener').hasAttribute('inert'));
    h.key('Tab', true);
    assert.equal(h.document.activeElement, retry);
    h.key('Tab');
    assert.equal(h.document.activeElement, close);
    h.q('#opener').focus();
    assert.equal(h.document.activeElement, close);
    h.q('[data-focus-edge="start"]').focus();
    assert.equal(h.document.activeElement, retry);
    h.q('[data-focus-edge="end"]').focus();
    assert.equal(h.document.activeElement, close);
    h.key('Escape');
    assert.equal(h.q('[role="dialog"]'), null, 'dialog existed and accepted focus above');
    assert.equal(h.document.activeElement, h.q('#opener'));
    assert.equal(h.q('#opener').hasAttribute('inert'), false, 'inert was set above');
});

test('removing the Settings container performs the same cleanup as close', async h => {
    h.summary = async () => free;
    h.open();
    await settle();
    h.complete();
    await settle();
    assert.ok(h.timers.size > 0);
    h.q('#container').remove();
    await settle();
    assert.equal(h.destroyed, 1);
    assert.equal(h.timers.size, 0, 'live confirmation timers existed above');
    assert.equal(h.document.activeElement, h.q('#opener'));
});

test('deep-link parsing consumes only billing intent and preserves other parameters', async h => {
    const parse = search => JSON.parse(JSON.stringify(h.window.sheetApi.parseBillingDeepLink(search)));
    assert.deepEqual(parse('?settings=billing&upgrade=pro&view=files&view=recent'), {
        initialTab: 'billing', openUpgrade: true, search: '?view=files&view=recent',
    });
    assert.deepEqual(parse('?settings=billing'), { initialTab: 'billing', openUpgrade: false, search: '' });
    assert.equal(parse('?settings=account&upgrade=pro'), null, 'matching billing intent accepted above');
    assert.equal(parse('?upgrade=pro'), null, 'upgrade requires matching billing intent above');
    assert.equal(parse('?settings=billing&upgrade=team').openUpgrade, false, 'pro is accepted above');
    assert.equal(parse('?settings=%62illing&upgrade=%70ro').openUpgrade, true);
});

test('default loader is single-flight, times out in 15 seconds and retries without a new session', async h => {
    h.open({ loadStripe: h.window.sheetApi.defaultLoadStripe });
    await settle();
    const firstScript = h.q('script[src="https://js.stripe.com/v3"]');
    assert.ok(firstScript);
    h.open();
    assert.equal(h.document.querySelectorAll('script').length, 1);
    assert.equal(h.timers.size, 1);
    await h.tick(14999);
    assert.match(h.text(), /Loading the secure payment form/);
    await h.tick(1);
    assert.match(h.text(), /Couldn't load the secure payment form/);
    assert.equal(h.q('script'), null, 'timed-out script existed above');
    h.click('[data-action="retry"]');
    await settle();
    assert.ok(h.q('script'));
    h.window.Stripe = key => { assert.equal(key, embedded.publishableKey); return h.stripe; };
    h.q('script').dispatchEvent(new h.window.Event('load'));
    await settle();
    assert.equal(h.mounted, 1);
    assert.equal(h.count('billing.createCheckout'), 1);
    // The loader's 15 s timer is gone; the one remaining timer is the session watcher.
    assert.equal(h.timers.size, 1, 'loader timer existed above; only the session watcher remains');
});

test('a paid session is noticed even when Stripe never calls onComplete', async h => {
    h.open();
    await settle();
    assert.equal(h.mounted, 1);
    assert.equal(h.count('billing.checkoutStatus'), 0, 'positive control: nothing polled before the first watch tick');
    h.status = async () => ({ status: 'complete' });
    await h.tick(4000);
    await settle();
    assert.ok(h.count('billing.checkoutStatus') >= 1, 'the watcher asked the server about the session');
    assert.match(h.text(), /Confirming your payment|You're on EZiL Standard|Payment received/);
});

test('closing while the default script loads cancels its timeout', async h => {
    h.open({ loadStripe: h.window.sheetApi.defaultLoadStripe });
    await settle();
    assert.ok(h.q('script'));
    assert.equal(h.timers.size, 1);
    h.handle.close();
    await settle();
    assert.equal(h.timers.size, 0);
    assert.equal(h.q('script'), null, 'script was inserted above');
});

test('a successful Stripe download is reused on the next fresh session', async h => {
    h.open({ loadStripe: h.window.sheetApi.defaultLoadStripe });
    await settle();
    const script = h.q('script');
    assert.ok(script);
    h.window.Stripe = () => h.stripe;
    script.dispatchEvent(new h.window.Event('load'));
    await settle();
    assert.equal(h.mounted, 1);
    h.handle.close();
    h.open({ loadStripe: h.window.sheetApi.defaultLoadStripe });
    await settle();
    assert.equal(h.count('billing.createCheckout'), 2);
    assert.equal(h.mounted, 2);
    assert.equal(h.document.querySelectorAll('script').length, 1);
    assert.equal(h.q('script'), script);
});

test('breakpoint changes collapse the summary and their listener is released on close', async h => {
    let listener;
    let removed;
    h.window.matchMedia = () => ({
        matches: false,
        addEventListener: (name, fn) => { assert.equal(name, 'change'); listener = fn; },
        removeEventListener: (name, fn) => { assert.equal(name, 'change'); removed = fn; },
    });
    h.open();
    assert.equal(h.q('details').open, true);
    listener({ matches: true });
    assert.equal(h.q('details').open, false, 'expanded desktop summary above is the positive control');
    listener({ matches: false });
    assert.equal(h.q('details').open, true);
    h.handle.close();
    assert.equal(removed, listener);
});

test('design text and button colours meet WCAG AA contrast', async () => {
    const luminance = hex => {
        const channels = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255)
            .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
    for ( const [ink, background] of [['f5f5f4', '0d1118'], ['9aa3ad', '0d1118'], ['9aa3ad', '141a23'], ['04060c', '00adb5']] ) {
        assert.ok(css.includes(`#${ink}`) && css.includes(`#${background}`), 'tested palette is present in the shipped stylesheet');
        assert.ok(contrast(ink, background) >= 4.5, `${ink} on ${background} meets AA`);
    }
});

test('redirect schemes are checked before opening; HTTPS is the positive control', async h => {
    h.create = async () => ({ mode: 'redirect', sessionId: 'cs_test', url: 'javascript:alert(1)' });
    h.open();
    await settle();
    assert.match(h.text(), /Could not open the secure checkout/);
    assert.equal(h.opens.length, 0, 'unsafe scheme blocked; valid HTTPS below opens');
    h.create = async () => ({ mode: 'redirect', sessionId: 'cs_test', url: 'https://checkout.stripe.com/test' });
    h.click('[data-action="retry"]');
    await settle();
    assert.equal(h.opens.length, 1);
});

test('copy keeps gated allowances honest and every control has a name', async h => {
    Object.defineProperty(h.window, 'innerWidth', { value: 390 });
    h.summary = async () => standard;
    h.open();
    await settle();
    assert.equal(h.q('details').open, false, 'mobile summary collapses; desktop control follows');
    assert.match(h.text(), /USD · before applicable tax/);
    assert.match(h.text(), /63 standard-hours each billing period/);
    h.complete();
    await settle();
    const success = h.q('[data-role="upgrade-success"]');
    assert.ok(success);
    assert.match(success.textContent, /63 standard-hours each billing period/);
    assert.doesNotMatch(h.text().replace(/standard-hours?/gi, ''), banned, 'positive rendered price, allowances and success asserted above');
    for ( const control of h.document.querySelectorAll('button, summary, iframe') ) {
        assert.ok(control.getAttribute('aria-label') || control.getAttribute('title') || control.textContent.trim());
    }
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /:focus-visible/);
    h.handle.close();
    Object.defineProperty(h.window, 'innerWidth', { value: 1280 });
    h.open();
    assert.equal(h.q('details').open, true);
});

test('Standard and Compute checkout copy comes from the offer and sizes', async h => {
    h.open();
    await settle();
    assert.match(h.text(), /Subscribe to EZiL Standard/);
    assert.match(h.text(), /\$23 \/month/);
    assert.match(h.text(), /63 standard-hours each billing period/);
    assert.match(h.text(), /2 vCPU · 8 GiB computer/);
    assert.doesNotMatch(h.text(), /Optional usage|\$20|\$3 AI|storage|Same standard computer/);
    h.handle.close();
    h.window.innerWidth = 390;
    h.open({ sku: computeOffer.sku, offer: computeOffer });
    await settle();
    assert.match(h.text(), /Subscribe to EZiL Compute/);
    assert.match(h.text(), /2, 4 or 8 vCPU computers, up to 32 GiB/);
    assert.match(h.text(), /Optional usage beyond 510 standard-hours at \$0.30 each — off unless you turn it on/);
    assert.equal(h.q('.ezil-upgrade-compact-title').textContent, 'EZiL Compute · $123.45/month · before applicable tax');
    assert.match(h.text(), /Sessions run up to 6 hours; files and installed tools are kept/);
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls.filter(c => c.method === 'billing.createCheckout').map(c => c.input))), [
        { sku: offer.sku }, { sku: computeOffer.sku },
    ]);
});

test('success requires the purchased SKU even when another paid plan is present', async h => {
    h.open({ sku: computeOffer.sku, offer: computeOffer });
    await settle();
    h.complete();
    await settle();
    assert.equal(h.q('[data-role="upgrade-success"]'), null);
    h.summary = async () => ({ plan: { id: 'pro' } });
    await h.tick(1500);
    assert.equal(h.q('[data-role="upgrade-success"]'), null);
    h.summary = async () => ({ plan: { sku: computeOffer.sku } });
    await h.tick(1500);
    assert.match(h.q('[data-role="upgrade-success"]').textContent, /You're on EZiL Compute/);
    assert.match(h.q('[data-role="upgrade-success"]').textContent, /510 standard-hours each billing period/);
});

test('v3 deep links select Standard and Premium while legacy links remain supported', async h => {
    const parse = h.window.sheetApi.parseBillingDeepLink;
    for ( const [value, expected] of [['standard', 'standard_monthly_v3'], ['premium', 'premium_monthly_v3'], ['compute', computeOffer.sku], ['pro', true], ['other', false], ['__proto__', false], ['constructor', false]] ) {
        const result = parse(`?view=files&settings=billing&upgrade=${value}&view=recent`);
        assert.equal(result.openUpgrade, expected);
        assert.equal(result.search, '?view=files&view=recent');
    }
    assert.equal(h.window.sheetApi.CONFIRM_POLL_MS, 1500);
    assert.equal(h.window.sheetApi.CONFIRM_DEADLINE_MS, 60000);
});

for ( const way of ['Escape', '×', 'backdrop', 'handle', 'Done', 'owner removed', 'backdrop removed'] ) {
    test(`onClose runs once for ${way}`, async h => {
        h.open();
        await settle();
        if ( way === 'Done' ) { h.complete(); await settle(); h.click('[data-action="done"]'); }
        else if ( way === 'Escape' ) h.key('Escape');
        else if ( way === '×' ) h.click('[data-action="close-sheet"]');
        else if ( way === 'backdrop' ) h.click('.ezil-upgrade-backdrop');
        else if ( way === 'owner removed' ) h.q('#container').remove();
        else if ( way === 'backdrop removed' ) h.q('.ezil-upgrade-backdrop').remove();
        else h.handle.close();
        await settle();
        h.handle.close();
        assert.equal(h.closed, 1);
        assert.equal(h.done, way === 'Done' ? 1 : 0);
        assert.equal(h.q('[role="dialog"]'), null);
        assert.equal(h.document.activeElement, h.q('#opener'));
    });
}

test('backdrop does not dismiss an in-flight checkout mutation', async h => {
    const pending = deferred();
    h.create = () => pending.promise;
    h.open();
    h.click('.ezil-upgrade-backdrop');
    assert.ok(h.q('[role="dialog"]'));
    assert.equal(h.closed, 0);
    pending.resolve(embedded);
    await settle();
    h.click('.ezil-upgrade-backdrop');
    assert.equal(h.closed, 1);
});

test('a late summary after close leaves both the old and reopened sheet untouched', async h => {
    const pending = deferred();
    h.summary = () => pending.promise;
    h.open();
    await settle();
    h.complete();
    await settle();
    const old = h.q('[role="dialog"]');
    h.handle.close();
    const oldHTML = old.innerHTML;
    h.open();
    await settle();
    const currentHTML = h.q('[role="dialog"]').innerHTML;
    pending.resolve(standard);
    await settle();
    assert.equal(old.innerHTML, oldHTML);
    assert.equal(h.q('[role="dialog"]').innerHTML, currentHTML);
    assert.equal(h.done, 0);
});

for ( const tier of ['standard', 'premium'] ) test(`v3 ${tier} checkout requires exact purchased SKU before success`, async h => {
    h.v3 = true;
    const summary = summaryV3(tier), offer = summary.catalog.offers.find(offer => offer.sku === summary.plan.sku);
    h.summary = async () => summaryV3('free');
    h.open({ sku: offer.sku, offer, sizes: undefined }); await settle();
    assert.equal(h.mounted, 1); assert.equal(h.calls[0].input.sku, offer.sku);
    assert.equal(h.document.querySelectorAll('.ezil-upgrade-allowances li').length, 3);
    assert.match(h.text(), /Usage included/); assert.doesNotMatch(h.text(), banned);
    h.complete(); await settle(); assert.equal(h.q('[data-role="upgrade-success"]'), null);
    h.summary = async () => summary;
    await h.tick(1500); assert.match(h.text(), new RegExp(`You're on ${offer.name}`));
    h.click('[data-action="done"]'); assert.equal(h.done, 1); assert.equal(h.destroyed, 1);
});
test('v3 failed checkout creation retries the chosen SKU and unpaid timeout never grants a plan', async h => {
    h.v3 = true;
    const offer = summaryV3().catalog.offers[1];
    h.create = async () => ({ ok: false, message: 'stripe_unavailable' });
    h.open({ sku: offer.sku, offer, sizes: undefined }); await settle();
    assert.match(h.text(), /Payments are unavailable/); assert.equal(h.mounted, 0);
    h.create = async () => embedded; h.click('[data-action="retry"]'); await settle();
    assert.equal(h.calls.at(-1).input.sku, offer.sku); assert.equal(h.mounted, 1);
    h.status = async () => 'open'; h.summary = async () => summaryV3('free');
    h.complete(); await h.tick(60000);
    assert.equal(h.q('[data-role="upgrade-success"]'), null);
    assert.doesNotMatch(h.text(), /You're on Standard/); assert.equal(h.done, 0);
});
let failed = 0;
for ( const { name, fn } of tests ) {
    const h = harness();
    try { await fn(h); await settle(); for ( const state of h.rendered ) assert.doesNotMatch(h.v3 ? state : state.replace(/standard-hours?/gi, ''), banned); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
    finally { h.cleanup(); }
}
console.log(`${tests.length - failed}/${tests.length} upgrade sheet tests passed`);
process.exitCode = failed ? 1 : 0;
