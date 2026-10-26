// Simulated provider portals in jsdom; no Stripe transport or cross-origin DOM.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [fileURLToPath(new URL('../../../../app/', import.meta.url))] }));
const source = (await build({ stdin: {
    contents: "import { openSheetFrame } from './sheet-frame.js'; window.openSheetFrame = openSheetFrame;",
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
}, bundle: true, write: false, format: 'iife', target: 'es2022' })).outputFiles[0].text;
const settle = async () => { for ( let i = 0; i < 10; i++ ) await Promise.resolve(); };
const turn = () => new Promise(resolve => setTimeout(resolve, 10));
const providerURL = 'https://js.stripe.com/v3/linked-accounts-inner-0123456789abcdef0123456789abcdef.html';
const tests = [];
const test = (name, run) => tests.push({ name, run });
function harness () {
    const dom = new JSDOM('<body><button id="opener">Billing</button><main></main><aside inert="original">Background</aside></body>', {
        url: 'https://example.test', pretendToBeVisual: true, runScripts: 'outside-only',
    });
    const { window: win } = dom, doc = win.document;
    win.eval(source);
    const opener = doc.querySelector('#opener');
    opener.focus();
    let closed = 0, disposed = 0;
    const frame = win.openSheetFrame({ container: doc.querySelector('main'), title: 'Checkout',
        onClose: () => closed++, dispose: () => disposed++ });
    frame.content.innerHTML = '<button>First</button><iframe title="Embedded checkout"></iframe><button>Last</button>';
    const checkout = frame.content.querySelector('iframe');
    checkout.focus();
    const register = () => frame.registerProviderPortals({ matchesFrame: iframe => iframe.getAttribute('src') === providerURL });
    const portal = ({ direct = false, hidden = false, root } = {}) => {
        const iframe = doc.createElement('iframe');
        iframe.src = providerURL;
        iframe.title = 'Simulated provider';
        root ??= direct ? iframe : doc.createElement('div');
        if ( root !== iframe ) root.append(iframe);
        if ( hidden ) root.style.display = 'none';
        doc.body.prepend(root);
        return { root, iframe };
    };
    const key = key => {
        const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        doc.activeElement.dispatchEvent(event);
        return event;
    };
    return { win, doc, frame, opener, checkout, register, portal, key,
        get closed () { return closed; }, get disposed () { return disposed; },
        cleanup: () => { frame.close(); win.close(); } };
}

test('base billing frame inerts new siblings and restores exactly its own inert changes', async h => {
    const extra = h.doc.createElement('button');
    h.doc.body.append(extra);
    await settle();
    assert.ok(extra.hasAttribute('inert'));
    extra.focus(); // jsdom does not enforce inert; the focus trap still must.
    assert.ok(h.frame.dialog.contains(h.doc.activeElement));
    h.frame.close();
    assert.equal(extra.hasAttribute('inert'), false);
    assert.equal(h.doc.querySelector('aside').getAttribute('inert'), 'original');
    assert.equal(h.doc.activeElement, h.opener);
});
test('matching provider-looking frames have no exemption without registration', async h => {
    const { root, iframe } = h.portal();
    await settle();
    assert.ok(root.hasAttribute('inert'));
    iframe.focus();
    assert.ok(h.frame.dialog.contains(h.doc.activeElement));
    h.key('Escape');
    assert.equal(h.closed, 1);
});
test('registration does not adopt a pre-existing matching portal', async h => {
    const { root } = h.portal();
    h.register();
    await settle();
    assert.ok(root.hasAttribute('inert'));
    assert.equal(h.frame.dialog.getAttribute('aria-modal'), 'true');
});
test('a matching iframe inside an unrelated body subtree never exempts its siblings', async h => {
    h.register();
    const root = h.doc.createElement('div');
    root.innerHTML = '<button>Unrelated action</button>';
    h.portal({ root });
    await settle();
    assert.ok(root.hasAttribute('inert'));
    assert.equal(h.frame.dialog.getAttribute('aria-modal'), 'true');
});
test('provider focus and Escape belong to the portal, then checkout focus and Escape recover', async h => {
    h.register();
    const { root, iframe } = h.portal();
    // Focus may occur synchronously, before MutationObserver delivery.
    iframe.focus();
    assert.equal(h.doc.activeElement, iframe);
    assert.ok(h.frame.dialog.hasAttribute('inert'));
    assert.equal(h.frame.dialog.getAttribute('aria-modal'), 'false');
    let providerEscape = 0;
    h.doc.addEventListener('keydown', event => { if ( event.key === 'Escape' ) providerEscape++; });
    assert.equal(h.key('Escape').defaultPrevented, false);
    assert.equal(providerEscape, 1);
    assert.equal(h.closed, 0);
    h.frame.dialog.querySelector('[data-action="close-sheet"]').click();
    h.frame.dialog.parentElement.click();
    assert.equal(h.closed, 0);
    h.opener.focus();
    assert.equal(h.doc.activeElement, iframe);
    root.remove();
    await settle();
    assert.equal(h.doc.activeElement, h.checkout);
    assert.equal(h.frame.dialog.hasAttribute('inert'), false);
    assert.equal(h.frame.dialog.getAttribute('aria-modal'), 'true');
    assert.equal(h.key('Escape').defaultPrevented, true);
    assert.equal(h.closed, 1);
    assert.equal(h.disposed, 1);
});
test('hidden preload, show, hide and re-show preserve the original checkout focus', async h => {
    h.register();
    const { root, iframe } = h.portal({ hidden: true });
    await settle();
    assert.equal(root.hasAttribute('inert'), false);
    assert.equal(h.frame.dialog.hasAttribute('inert'), false);
    for ( let i = 0; i < 2; i++ ) {
        root.style.display = 'block';
        await settle();
        assert.equal(h.doc.activeElement, iframe);
        root.style.display = 'none';
        await settle();
        assert.equal(h.doc.activeElement, h.checkout);
        assert.equal(h.frame.dialog.getAttribute('aria-modal'), 'true');
    }
});
test('two consecutive provider portals retain the checkout and recover after both close', async h => {
    h.register();
    const first = h.portal();
    await settle();
    const second = h.portal({ direct: true });
    first.root.remove();
    await settle();
    assert.equal(h.doc.activeElement, second.iframe);
    assert.equal(h.closed, 0);
    second.root.remove();
    await settle();
    assert.equal(h.doc.activeElement, h.checkout);
});
test('navigation to an untrusted src revokes the portal exemption', async h => {
    h.register();
    const { root, iframe } = h.portal();
    await settle();
    iframe.src = 'https://unrelated.example/';
    await settle();
    assert.ok(root.hasAttribute('inert'));
    assert.equal(h.doc.activeElement, h.checkout);
    assert.equal(h.frame.dialog.getAttribute('aria-modal'), 'true');
});
test('pre-existing inert on a new provider root remains intact and never activates it', async h => {
    h.register();
    const root = h.doc.createElement('div');
    root.setAttribute('inert', 'provider-owned');
    h.portal({ root });
    await settle();
    assert.equal(h.frame.dialog.getAttribute('aria-modal'), 'true');
    h.frame.close();
    assert.equal(root.getAttribute('inert'), 'provider-owned');
});
test('unregister restores checkout and prevents late provider frames taking over', async h => {
    const release = h.register();
    const first = h.portal();
    await settle();
    release();
    assert.equal(h.doc.activeElement, h.checkout);
    assert.ok(first.root.hasAttribute('inert'));
    const second = h.portal();
    await settle();
    assert.ok(second.root.hasAttribute('inert'));
    release();
    assert.equal(h.closed, 0);
});
test('owner removal during provider interaction cleans up once, including listeners', async h => {
    const release = h.register();
    const { root } = h.portal();
    await settle();
    h.doc.querySelector('main').remove();
    await settle();
    h.frame.close();
    assert.equal(h.closed, 0, 'detaching the owner lets the provider finish its hide cleanup');
    root.style.display = 'none';
    await turn();
    release();
    assert.equal(h.closed, 1);
    assert.equal(h.disposed, 1);
    assert.equal(h.doc.body.style.overflow, '');
    assert.equal(h.doc.activeElement, h.opener);
    const other = h.doc.createElement('button');
    h.doc.body.append(other);
    await settle();
    other.focus();
    assert.equal(h.doc.activeElement, other);
    assert.equal(other.hasAttribute('inert'), false);
    assert.equal(h.key('Escape').defaultPrevented, false);
});
test('queued close waits for a provider wrapper to finish fading after its iframe disappears', async h => {
    h.register();
    const { root, iframe } = h.portal();
    await settle();
    h.frame.close();
    iframe.remove();
    await turn();
    assert.equal(h.closed, 0, 'an empty fading provider wrapper has not run hide cleanup yet');
    root.style.display = 'none';
    await turn();
    assert.equal(h.closed, 1);
    assert.equal(h.disposed, 1);
    assert.equal(h.doc.activeElement, h.opener);
    assert.equal(h.doc.body.style.overflow, '');
});
let failed = 0;
for ( const { name, run } of tests ) {
    const h = harness();
    try { await run(h); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
    finally { h.cleanup(); }
}
console.log(`${tests.length - failed}/${tests.length} sheet frame tests passed (simulated provider portals)`);
process.exitCode = failed ? 1 : 0;
