// upgrade-sheet-test.mjs — EZiL-authored. Like the Settings harness, this
// drives DOM controls in jsdom with no transport. Evaluate the standalone
// module so fake Stripe and a deterministic clock exercise every race.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(new URL('./upgrade-sheet.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./upgrade-sheet.css', import.meta.url), 'utf8');
const embedded = { mode: 'embedded', sessionId: 'cs_test', clientSecret: 'test_client_secret', publishableKey: 'pk_test' };
const pro = { plan: { id: 'pro' }, meters: { storage: { capBytes: '20000000000' } } };
const free = { plan: { id: 'free' } };
const settle = async () => { for ( let i = 0; i < 20; i++ ) await Promise.resolve(); };
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function harness () {
    const dom = new JSDOM('<!doctype html><body><button id="opener">Upgrade to Pro</button><main id="container"></main></body>', {
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
    window.eval(`${source.replace(/^export /gm, '')}\nwindow.sheetApi = { openUpgradeSheet, parseBillingDeepLink, defaultLoadStripe };`);
    const calls = [];
    const opens = [];
    window.open = (...args) => { opens.push(args); return null; };
    let complete;
    let destroyed = 0;
    let mounted = 0;
    let loaded = 0;
    let done = 0;
    const h = {
        dom, window, document, timers, tick, calls, opens,
        q: selector => document.querySelector(selector),
        text: () => document.querySelector('[data-role="upgrade-sheet"]')?.textContent ?? '',
        create: async () => embedded,
        status: async () => ({ status: 'complete' }),
        summary: async () => pro,
        get mounted () { return mounted; },
        get destroyed () { return destroyed; },
        get loaded () { return loaded; },
        get done () { return done; },
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
            container: h.q('#container'), sku: 'pro_monthly_v1', trpc: h.trpc,
            onDone: () => { done++; }, loadStripe: h.loadStripe, now: () => time, ...options,
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
    h.summary = async () => pro;
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
    await h.tick(30000);
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
    assert.equal(h.q('.ezil-upgrade-compact-title').textContent, 'EZiL Pro · $20/month · Tax calculated at checkout');
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
    h.summary = async () => ({ ok: true, data: ++summaries === 1 ? free : pro });
    h.open();
    assert.equal(h.q('[role="dialog"]').getAttribute('aria-modal'), 'true');
    await settle();
    assert.equal(h.mounted, 1);
    assert.equal(h.calls[0].method, 'billing.createCheckout');
    assert.equal(h.calls[0].input.sku, 'pro_monthly_v1');
    h.complete();
    assert.match(h.text(), /Confirming your payment…/);
    await settle();
    assert.equal(h.count('billing.checkoutStatus'), 1);
    assert.equal(h.calls.find(call => call.method === 'billing.checkoutStatus').input.sessionId, 'cs_test');
    assert.equal(h.q('[data-role="upgrade-success"]'), null, 'free summary cannot grant Pro; positive control after webhook below');
    assert.ok(h.timers.size > 0, 'confirmation has scheduled its next read and deadline');
    await h.tick(1500);
    assert.ok(h.q('[data-role="upgrade-success"]'));
    assert.match(h.text(), /You're on EZiL Pro/);
    assert.match(h.text(), /20 GB storage · \$3 AI credits each month/);
    assert.match(h.text(), /AI assistant coming soon/);
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

test('summary that never grants Pro gets the honest timeout, not a success claim', async h => {
    h.summary = async () => free;
    h.open();
    await settle();
    h.complete();
    await settle();
    assert.ok(h.timers.size > 0);
    await h.tick(29999);
    assert.match(h.text(), /Confirming your payment…/);
    await h.tick(1);
    assert.match(h.text(), /Payment received — your plan updates in a moment\./);
    assert.equal(h.q('[data-role="upgrade-success"]'), null, 'a timely Pro response supplies the success control below');
    assert.equal(h.timers.size, 0, 'deadline was active above');
    const reads = h.count('billing.summary');
    await h.tick(60000);
    assert.equal(h.count('billing.summary'), reads, 'positive summary reads stop at the deadline');
    h.handle.close();
    h.summary = async () => pro;
    h.open();
    await settle();
    h.complete();
    await settle();
    assert.ok(h.q('[data-role="upgrade-success"]'), 'a timely Pro summary does produce success');
});

test('hung status and late summary cannot outrun the total deadline', async h => {
    const pending = deferred();
    h.status = () => pending.promise;
    h.open();
    await settle();
    h.complete();
    await settle();
    assert.equal(h.count('billing.checkoutStatus'), 1);
    await h.tick(30000);
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
    await h.tick(30000);
    summary.resolve(pro);
    await settle();
    assert.match(h.text(), /Payment received — your plan updates in a moment/);
    assert.equal(h.q('[data-role="upgrade-success"]'), null, 'timely Pro response succeeds in the control below');
    h.handle.close();
    h.summary = async () => pro;
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
    assert.match(h.text(), /<img src=x onerror=alert\(1\)> unavailable/);
    assert.equal(h.q('[data-role="checkout-state"] img'), null, 'message is visible text above, never executable markup');
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
    assert.equal(h.timers.size, 0, 'loader timer existed above');
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
    h.summary = async () => ({ ...pro, meters: { storage: { capBytes: '2000000000' } } });
    h.open();
    await settle();
    assert.equal(h.q('details').open, false, 'mobile summary collapses; desktop control follows');
    assert.match(h.text(), /USD · before applicable tax/);
    assert.match(h.text(), /2 GB storage today · 20 GB soon/);
    h.complete();
    await settle();
    const success = h.q('[data-role="upgrade-success"]');
    assert.ok(success);
    assert.match(success.textContent, /2 GB storage today · 20 GB soon/);
    assert.doesNotMatch(h.text(), /faster|instant|unlimited|priority|vcpu|gpu|heavy use|fair use|gpt|claude|gemini|llama/i, 'positive rendered price, allowances and success asserted above');
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

let failed = 0;
for ( const { name, fn } of tests ) {
    const h = harness();
    try { await fn(h); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
    finally { h.cleanup(); }
}
console.log(`${tests.length - failed}/${tests.length} upgrade sheet tests passed`);
process.exitCode = failed ? 1 : 0;
