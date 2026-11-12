// Real Chromium pointer, touch, keyboard and focus for a card's 3-D Secure / OTP challenge portal above checkout, against the
// SOURCE sheet-frame.js and upgrade-sheet.js (the same matcher the checkout registers). The challenge frames are LOCAL
// SIMULATIONS served by request interception: this does not execute Stripe, log in, enter card or OTP data, create a checkout or pay.
// Only parent-owned iframe elements and their URLs are inspected by the source; the simulated frame's own page talks to the test.
//
// PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome \
// TMPDIR="$PWD/.tmp" node shell/ezil/ui/Settings/provider-3ds-browser-test.mjs
// SOURCE_SETTINGS_DIR + EXPECT_BASELINE_FAILURE=1 run an earlier source and EXPECT the lock (the reproduction); no bundle is read or generated.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
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
if ( ! chromium ) { console.error('SKIP: installed Playwright is unavailable; DOM simulation cannot prove browser focus or hit testing.'); process.exit(2); }

const sourceDir = process.env.SOURCE_SETTINGS_DIR || here;
const baseline = process.env.EXPECT_BASELINE_FAILURE === '1';
const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-3ds-source-'));
let source;
try {
    const entry = path.join(buildDir, 'entry.js');
    await fs.writeFile(entry, `import { openSheetFrame } from ${JSON.stringify(path.join(sourceDir, 'sheet-frame.js'))};
import * as upgrade from ${JSON.stringify(path.join(sourceDir, 'upgrade-sheet.js'))};
window.__sheet = { openSheetFrame, matcher: upgrade.isStripeModalFrame };`);
    source = execFileSync('bun', ['build', entry, '--target=browser', '--format=iife'], { encoding: 'utf8' });
} finally { await fs.rm(buildDir, { recursive: true, force: true }); }
const css = await fs.readFile(path.join(sourceDir, 'upgrade-sheet.css'), 'utf8');
const output = path.join(path.resolve(process.env.TMPDIR || '.tmp'), 'provider-3ds-browser');
await fs.mkdir(output, { recursive: true });

const FIXTURE = 'https://checkout-fixture.test';
const SIM_ORIGINS = new Set(['https://hooks.stripe.com', 'https://js.stripe.com', 'https://checkout.stripe.com', 'https://js.stripe.com:444', 'http://js.stripe.com',
    'https://js.stripe.com.evil.test', 'https://evil.test', 'https://ads.example.test']);
const CHALLENGE = `<!doctype html><html><body style="margin:0;background:#fff;font:20px system-ui;color:#111;height:100vh;display:grid;place-items:center">
<div style="padding:16px"><h1 style="font-size:22px">Simulated bank verification</h1>
<label>Code <input id="otp" autocomplete="off"></label> <input id="second" aria-label="Second field">
<button id="submit" type="button">Submit</button> <button id="cancel" type="button">Cancel</button></div>
<script>
 const post = message => parent.postMessage(message, '*');
 addEventListener('focusin', event => post('focus:' + event.target.id));
 document.getElementById('submit').onclick = () => post('challenge-complete');
 document.getElementById('cancel').onclick = () => post('challenge-cancel');
 addEventListener('keydown', event => { if ( event.key === 'Escape' ) post('challenge-cancel'); });
 post('ready');
</script></body></html>`;
// The repaired family is the OBSERVED real 3-D Secure challenge frame: js.stripe.com /v3/three-ds-2-challenge-<32 hex>.html, both hash
// variants found in the public Stripe.js v3 asset (sha256 c2d84621627c35aeadd5043cdc97d93baad14d1af61a073ca5879fb28dea5852). The two
// existing modal families are controls that must work before and after the repair.
const CHALLENGE_URLS = ['83d79dd1848b8340a7352627866559b5', '1f5879f0ae81e95dfa2ef27073cf759c'].map(hash => `https://js.stripe.com/v3/three-ds-2-challenge-${hash}.html`);
const CONTROL_URLS = [`https://js.stripe.com/v3/linked-accounts-inner-${'a'.repeat(32)}.html`, `https://js.stripe.com/v3/embedded-checkout-modal-${'b'.repeat(40)}.html`];
// `full`: the whole interaction matrix (three placements). The second variant of each family gets the state and hit-test checks.
const ACCEPTED = [...CHALLENGE_URLS.map((src, i) => ({ name: '3ds2 challenge ' + src.split('-').pop().slice(0, 8), src, repaired: true, full: i === 0 })),
    ...CONTROL_URLS.map((src, i) => ({ name: src.split('/').pop().slice(0, 24), src, repaired: false, full: i === 0 }))];
const VARIANTS = [
    { shape: 'direct', where: 'prepend', hidden: false, kind: 'late direct frame, prepended' },
    { shape: 'wrapped', where: 'append', hidden: false, kind: 'late wrapped frame, appended (equal z, later in body)' },
    { shape: 'deep', where: 'prepend', hidden: true, kind: 'preloaded hidden nested wrapper, then shown' },
];
const CH = '/v3/three-ds-2-challenge-83d79dd1848b8340a7352627866559b5.html';
const REJECTED = [
    // Never a visible portal here: the hidden fingerprint frame must not take modal focus, and these families were not observed as modals.
    ['3ds2 fingerprint frame (hidden, must not take focus)', 'https://js.stripe.com/v3/three-ds-2-fingerprint-658350543972a8642f189bbb754bdcad.html'],
    ['3ds2 fingerprint frame, other hash variant', 'https://js.stripe.com/v3/three-ds-2-fingerprint-e569ce592c54867587d6d21a98967815.html'],
    ['standalone 3ds challenge (not observed as a modal)', 'https://js.stripe.com/v3/standalone-3ds-challenge-0c3c3ff7db8400dce218abba8946972a.html'],
    ['authorize-with-url (not observed as a modal)', 'https://js.stripe.com/v3/authorize-with-url-inner-839afa90e1e464d6fd68c2f487882a2c.html'],
    ['documented hooks.stripe.com authentication URL (not observed as a portal)', 'https://hooks.stripe.com/three_d_secure/authenticate'],
    // The challenge path itself, malformed or from another origin.
    ['hash one hex digit short', 'https://js.stripe.com' + CH.replace('83d79dd1848b8340a7352627866559b5', '83d79dd1848b8340a735262786655b5')],
    ['hash one hex digit long', 'https://js.stripe.com' + CH.replace('83d79dd1848b8340a7352627866559b5', '83d79dd1848b8340a7352627866559b5a')],
    ['uppercase hash', 'https://js.stripe.com' + CH.replace('83d79dd1848b8340a7352627866559b5', '83D79DD1848B8340A7352627866559B5')],
    ['extra path segment', 'https://js.stripe.com' + CH.replace('challenge-', 'challenge-modal-')], ['other version path', 'https://js.stripe.com' + CH.replace('/v3/', '/v2/')],
    ['http scheme', 'http://js.stripe.com' + CH], ['subdomain-suffix origin', 'https://js.stripe.com.evil.test' + CH], ['other origin', 'https://evil.test' + CH],
    ['explicit other port', 'https://js.stripe.com:444' + CH], ['credentials in the URL', 'https://user:pass@js.stripe.com' + CH],
    ['unlisted js.stripe.com path', 'https://js.stripe.com/v3/some-other-frame.html'], ['another Stripe origin', 'https://checkout.stripe.com/c/pay/cs_fixture'],
    ['unrelated sibling origin', 'https://ads.example.test/frame'],
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const receipts = [];
const startedAt = new Date().toISOString();
const sha256 = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const mode = baseline ? 'baseline' : 'fixed';
const progressFile = path.join(output, `progress-${mode}.jsonl`);
await fs.rm(progressFile, { force: true });
// One private line per completed case, so a slow or interrupted run still shows exactly how far it got.
async function record(id, outcome) {
    receipts.push({ id, outcome });
    const handle = await fs.open(progressFile, 'a', 0o600);
    try { await handle.write(JSON.stringify({ at: new Date().toISOString(), id, outcome }) + '\n'); } finally { await handle.close(); }
}

// Step trace inside a full case (private), so a stall names its step instead of only timing out.
async function trace(id, step) {
    const handle = await fs.open(path.join(output, `steps-${mode}.jsonl`), 'a', 0o600);
    try { await handle.write(JSON.stringify({ at: new Date().toISOString(), id: id.slice(0, 80), step }) + '\n'); } finally { await handle.close(); }
}

async function newPage(viewport, touch) {
    const context = await browser.newContext({ viewport, ...(touch ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    page.setDefaultTimeout(2500);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if ( url.origin === FIXTURE && url.pathname === '/' ) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">
<button id="opener">Open checkout</button><main id="app"><p>Application page</p><button id="app-button">App control</button></main>
<div id="os-window" style="position:fixed;inset:0;z-index:999999999;background:#345;color:#fff;padding:24px">OS window</div>
<div id="preinert" inert><button>Pre-existing inert control</button></div><div id="container"></div></body></html>` });
        if ( SIM_ORIGINS.has(url.origin) ) return route.fulfill({ contentType: 'text/html', body: CHALLENGE });
        return route.abort('blockedbyclient');
    });
    await page.goto(`${FIXTURE}/`);
    await page.addStyleTag({ content: css + '\nbody { margin: 0; } #os-window { pointer-events: auto; }' });
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
        window.__log = [];
        const portalIframe = () => window.__portal?.iframe;
        window.addEventListener('message', event => {
            const iframe = portalIframe();
            if ( ! iframe || event.source !== iframe.contentWindow ) return;
            window.__log.push(String(event.data));
            if ( event.data === 'challenge-complete' || event.data === 'challenge-cancel' ) window.__portal.root.remove();
        });
        window.openSheet = () => {
            document.getElementById('opener').focus();
            const frame = window.__frame = window.__sheet.openSheetFrame({ container: document.getElementById('container'), title: 'Checkout fixture', onClose: () => { window.__closed = true; } });
            const pay = document.createElement('button'), email = document.createElement('input');
            pay.id = 'pay'; pay.type = 'button'; pay.textContent = 'Pay now'; email.id = 'email'; email.setAttribute('aria-label', 'Email');
            frame.content.append(pay, email);
            window.__release = frame.registerProviderPortals({ matchesFrame: window.__sheet.matcher });
            frame.dialog.querySelector('#pay').focus();
        };
        // shape: 'direct' | 'wrapped' | 'deep'; where: 'prepend' | 'append'; hidden: preload invisible, shown later.
        window.addPortal = ({ src, shape = 'direct', where = 'prepend', hidden = false, extraText = false, srcdoc = false, preInert = false }) => {
            const iframe = document.createElement('iframe');
            iframe.title = 'Locally simulated provider portal';
            if ( srcdoc ) iframe.setAttribute('srcdoc', '<p>unrelated</p>');
            iframe.src = src;
            iframe.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647;background:#fff';
            let root = iframe;
            if ( shape !== 'direct' ) {
                root = document.createElement('div');
                root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;' + (hidden ? 'visibility:hidden;opacity:0;' : '');
                if ( shape === 'deep' ) { const inner = document.createElement('div'); inner.append(iframe); root.append(inner); } else root.append(iframe);
                if ( extraText ) { const note = document.createElement('div'); note.textContent = 'application text'; root.append(note); }
            } else if ( hidden ) iframe.style.visibility = 'hidden';
            if ( preInert ) root.setAttribute('inert', '');
            document.body[where](root);
            window.__portal = { root, iframe };
            window.__log.length = 0;
        };
        window.showPortal = () => { const el = window.__portal.root; el.style.visibility = 'visible'; el.style.opacity = '1'; };
        window.snapshot = () => ({
            portalInert: window.__portal ? window.__portal.root.hasAttribute('inert') : null, dialogInert: window.__frame.dialog.hasAttribute('inert'), modal: window.__frame.dialog.getAttribute('aria-modal'),
            active: document.activeElement === window.__portal?.iframe ? 'portal' : (window.__frame.dialog.contains(document.activeElement) ? 'sheet' : (document.activeElement?.id || document.activeElement?.tagName)),
            inertIds: [...document.querySelectorAll('[inert]')].map(n => n.id || n.tagName).sort(), overflow: document.body.style.overflow, closed: !!window.__closed,
        });
        window.hitsPortal = () => { const r = window.__portal.iframe.getBoundingClientRect(); return [[.5, .5], [.2, .2], [.8, .8], [.5, .2], [.2, .8]]
            .map(([fx, fy]) => document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)).every(el => el === window.__portal.iframe); };
    });
    return { context, page, errors };
}
const frameOf = (page, src) => page.frames().find(frame => frame.url() === src);
async function waitFrame(page, src, tries = 80) {   // a new frame is about:blank until its simulated page has loaded
    for ( let i = 0; i < tries; i++ ) { const frame = frameOf(page, src); if ( frame ) return frame; await page.waitForTimeout(50); }
    return undefined;
}
const got = (page, message, timeout = 1500) => page.waitForFunction(m => window.__log.includes(m), message, { timeout }).then(() => true, () => false);
async function interact(page, touch, src) {
    const frame = await waitFrame(page, src); assert.ok(frame, 'the simulated challenge frame loaded: ' + src);
    await got(page, 'ready', 4000);
    const box = await frame.locator('#otp').boundingBox();
    if ( touch ) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); else await frame.locator('#otp').click();
    return { frame, focused: await got(page, 'focus:otp') };
}
// The challenge removes its iframe in response to a physical Escape. Chromium
// can leave that dispatch acknowledgment pending after the receiving frame dies.
// Require the actual cancellation effect within the normal short timeout, then
// release the key in the restored sheet; every focus/inert assertion still runs.
async function escapeChallenge (page, id) {
    let acknowledged = false;
    const press = page.keyboard.press('Escape').then(() => { acknowledged = true; });
    const removed = page.waitForFunction(() => !document.contains(window.__portal.root), null, { timeout: 2500 });
    await Promise.race([press, removed]);
    await removed;
    if ( ! acknowledged ) await trace(id, 'escape-removal-observed-before-dispatch-ack');
    await page.keyboard.up('Escape');
}
// BASELINE (the reproduction, run against the earlier source): ONE real challenge portal per viewport. The exact observed path, in a
// dedicated body DIV preloaded hidden and then shown (Stripe's own sequence). The earlier source makes it inert, so it can never take
// focus and a real click or tap cannot reach it. Every wait is explicit and short; this is not the fixed matrix.
async function reproduceLock(viewport, touch, label) {
    const { context, page } = await newPage(viewport, touch);
    const src = CHALLENGE_URLS[0], id = `${label} | real ${src.split('/').pop().slice(0, 28)} in a dedicated hidden-then-shown body DIV`;
    await page.evaluate(() => window.openSheet());
    await page.evaluate(opts => window.addPortal(opts), { src, shape: 'wrapped', where: 'prepend', hidden: true });
    await page.waitForTimeout(150);
    await page.evaluate(() => window.showPortal());
    await page.waitForTimeout(150);
    const state = await page.evaluate(() => window.snapshot());
    assert.equal(state.portalInert, true, id + ': the earlier source makes the challenge inert');
    assert.deepEqual([state.dialogInert, state.modal, state.active], [false, 'true', 'sheet'], id + ': the sheet keeps modal focus, the challenge never gets it');
    const frame = await waitFrame(page, src, 20);
    assert.ok(frame, id + ': the challenge frame did load (it is the lock, not a missing frame)');
    const box = await frame.locator('#otp').boundingBox({ timeout: 700 }).catch(() => null);
    assert.ok(box, id + ': the challenge input is laid out on screen');
    if ( touch ) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await got(page, 'focus:otp', 600), false, id + ': a real ' + (touch ? 'tap' : 'click') + ' cannot reach the locked challenge');
    // The click passes through the inert frame to whatever is behind it: here the sheet's backdrop, which dismisses checkout.
    const after = await page.evaluate(() => window.snapshot());
    assert.notEqual(after.active, 'portal', id + ': the challenge never takes focus');
    await record(id, after.closed ? 'LOCKED_AS_REPRODUCED_AND_THE_CLICK_FELL_THROUGH_AND_CLOSED_CHECKOUT' : 'LOCKED_AS_REPRODUCED');
    await context.close();
}

try {
    if ( ! baseline ) await checkProviderVisibility();
    for ( const touch of [false, true] ) for ( const viewport of [touch ? { width: 390, height: 844 } : { width: 1440, height: 900 }] ) {
        const label = `${touch ? 'phone-touch' : 'desktop'} ${viewport.width}x${viewport.height}`;
        if ( baseline ) { await reproduceLock(viewport, touch, label); continue; }
        // ------------------------------------------------------------------ 1. accepted portals: late-created, preloaded-then-shown, wrapped, stacked
        for ( const accepted of ACCEPTED ) for ( const variant of accepted.full ? VARIANTS : VARIANTS.slice(0, 1) ) {
            const { context, page, errors } = await newPage(viewport, touch);
            const id = `${label} | ${accepted.name} | ${variant.kind}`;
            await page.evaluate(() => window.openSheet());
            const inertBefore = (await page.evaluate(() => window.snapshot())).inertIds;   // the page behind an open checkout is inert by design
            await page.evaluate(opts => window.addPortal(opts), { src: accepted.src, ...variant });
            if ( variant.hidden ) {
                await page.waitForTimeout(150);
                const hiddenState = await page.evaluate(() => ({ dialogInert: window.__frame.dialog.hasAttribute('inert'), modal: window.__frame.dialog.getAttribute('aria-modal') }));
                assert.deepEqual(hiddenState, { dialogInert: false, modal: 'true' }, id + ': a hidden preload never takes the sheet');
                await page.evaluate(() => window.showPortal());
            }
            await page.waitForTimeout(150);
            const state = await page.evaluate(() => window.snapshot());
            assert.equal(state.portalInert, false, id + ': challenge portal is interactive');
            assert.equal(state.dialogInert, true, id + ': the sheet behind it is inert'); assert.equal(state.modal, 'false', id);
            assert.equal(state.active, 'portal', id + ': focus moved to the challenge');
            assert.ok(state.inertIds.includes('preinert') && state.inertIds.includes('os-window') && state.inertIds.includes('app'), id + ': siblings stay inert behind');
            assert.equal(await page.evaluate(() => window.hitsPortal()), true, id + ': mouse hit testing reaches the challenge above the sheet and the OS window');
            if ( ! accepted.full ) { await record(id, 'SHAPE_ACCEPTED_AND_FOCUSED'); await context.close(); continue; }
            // pointer / touch into the challenge, then typing
            await trace(id, 'state-and-hit-test-ok');
            const { frame, focused } = await interact(page, touch, accepted.src);
            await trace(id, 'pointer-reached-challenge');
            assert.equal(focused, true, id + ': a real ' + (touch ? 'tap' : 'click') + ' focuses the challenge input');
            await page.keyboard.type('123456'); assert.equal(await frame.locator('#otp').inputValue(), '123456', id + ': typing reaches the challenge');
            // keyboard: Tab/Shift+Tab stay in the challenge frame; the sheet's trap never takes focus back
            await page.keyboard.press('Tab'); assert.equal(await got(page, 'focus:second'), true, id);
            await page.keyboard.press('Tab'); assert.equal(await got(page, 'focus:submit'), true, id);
            await page.keyboard.press('Shift+Tab'); assert.equal(await got(page, 'focus:second'), true, id);
            assert.equal((await page.evaluate(() => window.snapshot())).active, 'portal', id + ': focus stays in the challenge while tabbing');
            // cancellation by Escape inside the challenge: the sheet stays open and everything is restored
            await trace(id, 'tabbed-before-escape');
            await frame.locator('#otp').focus(); await trace(id, 'otp-focused'); await escapeChallenge(page, id); await trace(id, 'escape-pressed');
            await page.waitForFunction(() => !document.contains(window.__portal.root));
            let restored = await page.evaluate(() => window.snapshot());
            assert.equal(restored.closed, false, id + ': Escape in the challenge did not close checkout');
            assert.deepEqual([restored.dialogInert, restored.modal, restored.active], [false, 'true', 'sheet'], id + ': sheet restored with focus inside it');
            assert.deepEqual(restored.inertIds, inertBefore, id + ': the inert set is exactly what it was before the challenge');
            // a second challenge (completion path) after the first
            await page.evaluate(opts => window.addPortal(opts), { src: accepted.src, shape: 'wrapped', where: 'prepend' });
            await page.waitForFunction(() => window.snapshot().active === 'portal');
            const second = await interact(page, touch, accepted.src); assert.equal(second.focused, true, id + ': second challenge usable');
            await second.frame.locator('#submit').click(); assert.equal(await got(page, 'challenge-complete'), true, id);
            await page.waitForFunction(() => !document.contains(window.__portal.root));
            restored = await page.evaluate(() => window.snapshot());
            assert.deepEqual([restored.closed, restored.dialogInert, restored.modal, restored.inertIds], [false, false, 'true', inertBefore], id + ': completion restores the sheet');
            // teardown: closing checkout releases only what it made inert and restores the page
            await page.evaluate(() => { window.__release?.(); window.__frame.close(); });
            await page.waitForFunction(() => window.__closed === true);
            const closed = await page.evaluate(() => ({ inert: [...document.querySelectorAll('[inert]')].map(n => n.id), overflow: document.body.style.overflow, opener: document.activeElement?.id }));
            assert.deepEqual(closed, { inert: ['preinert'], overflow: '', opener: 'opener' }, id + ': teardown');
            assert.deepEqual(errors, [], id);
            await record(id, 'USABLE_AND_RESTORED');
            await context.close();
        }
        // ------------------------------------------------------------------ 2. negatives: nothing outside the recognized shapes gets exempted
        for ( const [name, src] of REJECTED ) {
            const { context, page } = await newPage(viewport, touch);
            const id = `${label} | rejected: ${name}`;
            await page.evaluate(() => window.openSheet());
            await page.evaluate(opts => window.addPortal(opts), { src, shape: 'wrapped', where: 'prepend' });
            await page.waitForTimeout(200);
            const state = await page.evaluate(() => window.snapshot());
            assert.equal(state.portalInert, true, id + ': stays inert'); assert.deepEqual([state.dialogInert, state.modal, state.active], [false, 'true', 'sheet'], id + ': the sheet keeps focus and the modal');
            // A deliberately unreachable origin never loads its frame: do not wait for it. Where it does load, one short real click.
            const frame = await waitFrame(page, src, 6); if ( frame ) { await frame.locator('#otp').click({ timeout: 500, force: true }).catch(() => {}); }
            assert.equal(await got(page, 'focus:otp', 400), false, id + ': the unrecognized frame is never reachable');
            await record(id, 'KEPT_INERT'); await context.close();
        }
        // structure and ownership rules that must not loosen
        // A RECOGNIZED challenge URL is still refused when its structure or ownership is wrong.
        for ( const [name, opts] of [['srcdoc beside a recognized challenge src', { src: CHALLENGE_URLS[0], srcdoc: true, shape: 'wrapped' }],
            ['wrapper that also carries application text', { src: CHALLENGE_URLS[0], shape: 'wrapped', extraText: true }],
            ['portal already inert by another owner', { src: CHALLENGE_URLS[0], shape: 'wrapped', preInert: true }]] ) {
            const { context, page } = await newPage(viewport, touch); const id = `${label} | ${name}`;
            await page.evaluate(() => window.openSheet()); await page.evaluate(o => window.addPortal(o), opts); await page.waitForTimeout(200);
            const state = await page.evaluate(() => window.snapshot());
            assert.equal(state.portalInert, true, id + ': stays inert'); assert.deepEqual([state.dialogInert, state.modal], [false, 'true'], id);
            if ( name.startsWith('portal already') ) { await page.evaluate(() => { window.__release?.(); window.__frame.close(); }); await page.waitForFunction(() => window.__closed === true);
                assert.equal(await page.evaluate(() => window.__portal.root.hasAttribute('inert')), true, id + ': another owner\'s inert is never released'); }
            await record(id, 'KEPT_INERT'); await context.close();
        }
    }
} finally { await browser.close(); }
const outcomes = [...new Set(receipts.map(r => r.outcome))];
if ( ! receipts.length ) { console.error('SKIP: no case ran.'); process.exit(2); }
// Exact source and test bytes, and when this ran, so a receipt can be tied to the code that produced it.
const receipt = { mode, startedAt, finishedAt: new Date().toISOString(), cases: receipts.length, outcomes, viewports: ['desktop 1440x900', 'phone-touch 390x844'],
    source: { dir: sourceDir, 'sheet-frame.js': await sha256(path.join(sourceDir, 'sheet-frame.js')), 'upgrade-sheet.js': await sha256(path.join(sourceDir, 'upgrade-sheet.js')) },
    test: { file: path.basename(fileURLToPath(import.meta.url)), sha256: await sha256(fileURLToPath(import.meta.url)) } };
const receiptFile = path.join(output, `receipt-${mode}.json`);
await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(`${baseline ? 'BASELINE REPRODUCTION' : 'PASS'}: ${receipts.length} real-Chromium 3DS portal cases`, outcomes.join(', '), '| receipt', receiptFile);

// Visibility regressions run inside this registered CI/local browser suite.
// Every HTTP response below is a local mock; no Stripe transport.
async function checkProviderVisibility () {
let checks = 0;
    const visibilityBrowser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
        for ( const [name, initial] of [
            ['zero width', 'width:0;height:200px;border:0'],
            ['zero height', 'width:300px;height:0;border:0'],
            ['scaled to zero', 'width:300px;height:200px;border:0;transform:scale(0)'],
            ['transparent frame', 'width:300px;height:200px;border:0;opacity:0'],
            ['transparent ancestor', 'width:300px;height:200px;border:0'],
        ] ) {
            const page = await visibilityBrowser.newPage();
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
                const frame = __sheet.openSheetFrame({ container: document.querySelector('main'), title: 'Checkout' });
                frame.content.innerHTML = '<input id="checkout" aria-label="Payment field">';
                document.querySelector('#checkout').focus();
                window.fixture = frame;
                frame.registerProviderPortals({ matchesFrame: __sheet.matcher });
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
        const page = await visibilityBrowser.newPage();
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><button>Mock challenge</button>' }));
        await page.setContent('<!doctype html><body><main></main></body>');
        await page.addScriptTag({ content: source });
        await page.evaluate(() => {
            const root = document.createElement('div');
            root.id = 'provider';
            root.style.cssText = 'opacity:0;transition:opacity 100ms linear';
            root.innerHTML = '<iframe src="https://js.stripe.com/v3/three-ds-2-challenge-0123456789abcdef0123456789abcdef.html" style="width:300px;height:200px;border:0"></iframe>';
            document.body.append(root);
            window.fixture = __sheet.openSheetFrame({ container: document.querySelector('main'), title: 'Checkout' });
            fixture.registerProviderPortals({ matchesFrame: __sheet.matcher });
            void root.offsetWidth;
            root.style.opacity = '1';
        });
        await page.waitForFunction(() => fixture.dialog.hasAttribute('inert') && document.activeElement.tagName === 'IFRAME');
        checks++;
        await page.close();
        console.log('PASS opacity transition activates visible provider without another style mutation');
        assert.equal(checks, 26, 'all visibility assertions executed from the registered suite');
        await record('invisible-provider-ownership', `${checks}_VISIBILITY_ASSERTIONS_PASSED`);
        console.log(`${checks} real browser visibility assertions passed (registered provider-3ds suite)`);
    } finally { await visibilityBrowser.close(); }
}
