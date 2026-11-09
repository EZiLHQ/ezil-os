// feedback-test.mjs — EZiL-authored. Run with Node; no browser or network.
// Actual form/diagnostics/schema, with contract doubles for FCAPTURE's modules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body><button id="opener">Open</button></body></html>',
    { url: 'https://feedback.test/os', pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;
for ( const key of ['window', 'document', 'navigator', 'MutationObserver', 'FileReader', 'Blob'] ) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : window[key] });
}
const style = document.createElement('style');
style.textContent = readFileSync(new URL('./feedback.css', import.meta.url), 'utf8');
document.head.append(style);
// jsdom has no top layer. These doubles exercise lifecycle events, not pixels.
let modalCalls = 0;
window.HTMLDialogElement.prototype.showModal = function () { modalCalls++; this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };

const computerId = '11111111-1111-4111-8111-111111111111';
const reportId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
window.__EZIL_BOOT__ = { computer: { id: computerId }, user: { id: accountId, email: 'BOOT_SECRET@example.test' },
    desktopState: { endpoints: { feedback: '/api/shell/feedback' }, ui: { feedbackScreenshots: true } } };
globalThis.ezil = { version: '1' };
document.cookie = '__Host-ezil-os-auth=SECRET; Secure; Path=/';
assert.match(document.cookie, /SECRET/);
const iframe = document.createElement('iframe');
iframe.src = 'https://HOST_SECRET.token.example.test/';
document.body.append(iframe);

const captureCalls = [];
const captureOptions = [];
const editorOptions = [];
let supported = true;
let desktopSupported = true;
let nextCanvas = () => Promise.resolve(document.createElement('canvas'));
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJx8AAAAASUVORK5CYII=', 'base64');
let editorResult = () => ({ blob: new window.Blob([imageBytes], { type: 'image/png' }), contentType: 'image/png', width: 1, height: 1 });
globalThis.__feedbackCapture = {
    supported: () => supported,
    desktopSupported: () => desktopSupported,
    capture: (kind, options) => {
        captureCalls.push(kind);
        captureOptions.push(options);
        if ( options?.hide ) {
            const restore = options.hide();
            assert.equal(typeof restore, 'function');
            assert.equal(window.getComputedStyle(document.querySelector('dialog')).visibility, 'hidden');
            restore();
        }
        return nextCanvas();
    },
    edit: (canvas, options) => { assert.equal(canvas.tagName, 'CANVAS'); captureCalls.push('editor'); editorOptions.push(options); return Promise.resolve(editorResult()); },
};
const captureUrl = new URL('./capture.js', import.meta.url).href;
const editorUrl = new URL('./redact-editor.js', import.meta.url).href;
const hooks = registerHooks({ load (url, context, next) {
    if ( url === captureUrl ) return { format: 'module', shortCircuit: true, source: `
        export const tab_capture_supported = () => globalThis.__feedbackCapture.supported();
        export const desktop_capture_supported = () => globalThis.__feedbackCapture.desktopSupported();
        export const capture_shell_snapshot = options => globalThis.__feedbackCapture.capture('shell', options);
        export const capture_tab_frame = options => globalThis.__feedbackCapture.capture('tab', options);
        export const capture_desktop_frame = options => globalThis.__feedbackCapture.capture('desktop', options);` };
    if ( url === editorUrl ) return { format: 'module', shortCircuit: true,
        source: 'export const open_redact_editor = (canvas, options) => globalThis.__feedbackCapture.edit(canvas, options);' };
    return next(url, context);
} });

const feedback = await import('./feedback.js');
const { build_diagnostics } = await import('./diagnostics.js');
const { scan } = await import('./secret-scan.js');
const telemetry = await import('../../telemetry.js');
const { beginTrace, ambientTraceRef } = await import('../../trace.js');
const { default: log } = await import('../../log.js');
const { setCurrentComputer } = await import('../../session.js');
const { feedbackSubmitSchema, diagnosticsSchema } = await import('../../../../app/src/server/feedback/types.ts');
log.debug('LOG_SECRET');
// Seed the real ring, then make any attempted read fail immediately.
assert.ok(log.ringBuffer().some(entry => entry.msg.includes('LOG_SECRET')));
const readRing = log.ringBuffer;
log.ringBuffer = () => { throw new Error('Feedback must not read the log ring'); };
Object.defineProperty(document, 'cookie', { configurable: true, get () { throw new Error('cookie read'); } });
// Only the opaque account id may be read (it keys the local draft); every other user field throws.
Object.defineProperty(window.__EZIL_BOOT__, 'user', { configurable: true, value: Object.defineProperties({}, {
    id: { enumerable: true, value: accountId },
    email: { enumerable: true, get () { throw new Error('boot user email read'); } },
    name: { enumerable: true, get () { throw new Error('boot user name read'); } },
}) });
Object.defineProperty(iframe, 'src', { configurable: true, get () { throw new Error('iframe src read'); } });
for ( let i = 0; i < 60; i++ ) telemetry.capture({ eventClass: 'api_failure', site: 's'.repeat(96), code: 'failure', detail: 'EVENT_SECRET@example.test' });
const trace = beginTrace('desktop');
trace.step('display');

const calls = [];
let flushing = false;
let respond = async () => ({ status: 201, ok: true, json: async () => ({ id: reportId, screenshotAccepted: true }) });
globalThis.fetch = window.fetch = (url, options) => {
    if ( options.method === 'POST' ) {
        if ( ! flushing ) assert.equal(options.body, document.querySelector('.ezil-feedback-preview pre').textContent, 'preview is the exact request body at dispatch');
        feedbackSubmitSchema.parse(JSON.parse(options.body));
    }
    calls.push({ url, ...options });
    return respond(url, options);
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until (predicate) {
    for ( let i = 0; i < 100 && ! predicate(); i++ ) await tick();
    assert.ok(predicate(), 'asynchronous UI completed');
}
let checks = 0;
async function check (label, run) { await run(); checks++; console.log(`PASS ${label}`); }
const current = () => document.querySelector('dialog.ezil-feedback-dialog');
const form = () => current().querySelector('form');
const payload = () => JSON.parse(current().querySelector('pre').textContent);
const status = () => current().querySelector('.ezil-feedback-result').textContent;
const setDescription = value => { form().elements.category.value = 'idea'; form().elements.description.value = value; form().elements.description.dispatchEvent(new window.Event('input', { bubbles: true })); };
const change = (name, checked) => { form().elements[name].checked = checked; form().elements[name].dispatchEvent(new window.Event('change', { bubbles: true })); };
const send = () => form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
const close = () => current().querySelector('[data-action="cancel"]').click();
const open = () => { document.querySelector('#opener').focus(); feedback.open_feedback_dialog({ source: 'pill' }); };
const draftKey = `ezil:feedback:draft:v1:${accountId}`;
const outboxKey = `ezil:feedback:outbox:v1:${accountId}`;
const stored = key => JSON.parse(window.localStorage.getItem(key) ?? 'null');
const setOnline = value => Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });

try {
    await check('secret scan kinds, exact offsets, repeatability and harmless text', () => {
        for ( const [text, kind] of [
            ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature', 'JWT'], ['sk-proj-abc123', 'sk- token'],
            [['AKIA', '1234567890ABCDEF'].join(''), 'AWS access key'], ['ghp_abc123', 'GitHub token'],
            [['xox', 'b-123-456-abc'].join(''), 'Slack token'], ['xoxp-abc123', 'Slack token'], ['Bearer abc.def', 'Bearer token'],
            ['__Host-ezil-os-auth', 'auth cookie'], ['sb-project-auth-token', 'auth cookie'], ['test+tag@example.com', 'email address'],
        ] ) {
            const fixture = 'prefix ' + text;
            assert.ok(scan(fixture).some(match => match.kind === kind && match.index === 7));
            assert.deepEqual(scan(fixture), scan(fixture));
        }
        assert.deepEqual(scan('The desktop froze after I clicked Settings.'), []);
    });
    await check('diagnostics obey schema and never read seeded private sources', () => {
        const data = build_diagnostics();
        diagnosticsSchema.parse(data);
        assert.equal(data.traceId, trace.id);
        assert.equal(ambientTraceRef(), trace, 'diagnostics must not end a trace');
        assert.equal(data.recentEvents.length, 50);
        assert.equal(data.recentEvents[0].site.length, 80);
        assert.deepEqual(Object.keys(data.recentEvents[0]), ['eventClass', 'site', 'code']);
        assert.doesNotMatch(JSON.stringify(data), /SECRET|example\.test|auth-token|detail|outcome/);
        assert.equal(calls.length, 0);
    });
    await check('diagnostics clamp values and exclude DOM stream measurements', () => {
        globalThis.ezil.version = 'v'.repeat(100);
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 100 });
        Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: {
            brands: [{ brand: 'Not A Brand', version: '99' }, { brand: 'Chromium', version: '140.0' }],
            getHighEntropyValues () { throw new Error('high entropy forbidden'); },
        } });
        const vitals = document.createElement('div');
        vitals.className = 'ezil-settings-system';
        vitals.innerHTML = '<div class="ezil-sys-row"><div class="ezil-sys-k">Bitrate</div><div class="ezil-sys-v">123.7 kbit/s</div></div>'
            + '<div class="ezil-sys-row"><div class="ezil-sys-k">Round trip</div><div class="ezil-sys-v">24 ms</div></div>';
        document.body.append(vitals);
        document.body.classList.add('device-phone');
        const data = build_diagnostics();
        diagnosticsSchema.parse(data);
        assert.equal(data.shellVersion.length, 64);
        assert.equal(data.viewport.dpr, 16);
        assert.equal(data.deviceClass, 'phone');
        assert.deepEqual(data.browser, { family: 'Chromium', major: 140 });
        assert.equal(data.stream, undefined, 'DOM text is excluded');
        vitals.remove();
        document.body.classList.remove('device-phone');
    });
    await check('in-app icon: mounted once, icon only, hidden on the home screen, shown only while an app window is open', async () => {
        feedback.mount_feedback_chip(); feedback.mount_feedback_chip();
        assert.equal(document.querySelectorAll('.ezil-feedback-chip').length, 1);
        const chip = document.querySelector('.ezil-feedback-chip');
        assert.equal(chip.getAttribute('aria-label'), 'Send feedback');
        assert.equal(chip.title, 'Send feedback', 'the tooltip names the action');
        assert.equal(chip.textContent.trim(), '', 'no text label');
        assert.equal(chip.querySelectorAll('svg').length, 1);
        const shown = () => chip.style.display !== 'none';
        assert.equal(shown(), false, 'home screen (no app window): no icon');
        const parent = document.createElement('div');
        parent.innerHTML = '<div class="window window-alert" data-app=""></div>';
        document.body.append(parent);
        await tick();
        assert.equal(shown(), false, 'an alert is not an app window');
        parent.insertAdjacentHTML('beforeend', '<div class="window" data-app="settings" data-is_minimized="0"></div>');
        const win = parent.lastElementChild;
        await tick();
        assert.equal(shown(), true, 'an open app window shows the icon');
        assert.equal(chip.classList.contains('ezil-feedback-chip-fullbleed'), false);
        win.setAttribute('data-is_minimized', 'true');
        await tick();
        assert.equal(shown(), false, 'minimised: back on the home screen');
        win.setAttribute('data-is_minimized', 'false');
        await tick();
        assert.equal(shown(), true, 'restored');
        win.setAttribute('data-closing', '1');
        await tick();
        assert.equal(shown(), false, 'hidden as soon as the window starts closing');
        win.remove();
        await tick();
        assert.equal(shown(), false);
        parent.insertAdjacentHTML('beforeend', '<div class="window ezil-fullbleed" data-app="desktop"></div>');
        await tick();
        assert.equal(shown(), true, 'no pill: shown in a full-bleed desktop');
        assert.equal(chip.classList.contains('ezil-feedback-chip-fullbleed'), true, 'placed in the control strip');
        assert.equal(build_diagnostics().fullbleed, true);
        // With the floating-controls pill on, the pill offers Feedback and the icon steps aside.
        window.__EZIL_BOOT__.desktopState.ui.floatingControls = true;
        parent.lastElementChild.setAttribute('style', 'x: 1');
        await tick();
        assert.equal(shown(), false);
        delete window.__EZIL_BOOT__.desktopState.ui.floatingControls;
        parent.style.display = 'none';
        await tick();
        assert.equal(shown(), false, 'a window that is not rendered is not open');
        assert.equal(chip.classList.contains('ezil-feedback-chip-fullbleed'), false);
        assert.equal(build_diagnostics().fullbleed, false);
        parent.style.display = '';
        await tick();
        assert.equal(shown(), true);
        parent.remove();
        await tick();
        assert.equal(shown(), false, 'every window closed: hidden again');
    });
    // Gate G3, 2026-10-31: the Browser's strip is 43px and Code's 28px
    // (ezil-shell.css), so the icon mirrors the FRONT full view's
    // `--ezil-control-strip-height` and its declared `--ezil-feedback-look`.
    // jsdom resolves custom properties; the windows here declare them inline
    // as ezil-shell.css does for the real ones. Pixels: code-full-view-browser-test.
    await check('in-app icon: in a full view it takes the FRONT full view\'s strip height and look, and writes only on a change', async () => {
        feedback.mount_feedback_chip();
        const chip = document.querySelector('.ezil-feedback-chip');
        const strip = () => chip.style.getPropertyValue('--ezil-feedback-strip-h');
        const look = () => chip.dataset.look ?? null;
        const parent = document.createElement('div');
        parent.innerHTML = '<div class="window ezil-fullbleed" data-app="desktop" style="z-index: 5; --ezil-control-strip-height: 43px"></div>'
            + '<div class="window" data-app="code" style="z-index: 9; --ezil-control-strip-height: 28px; --ezil-feedback-look: outline"></div>';
        document.body.append(parent);
        const [browserWin, codeWin] = parent.children;
        await tick();
        assert.equal(chip.classList.contains('ezil-feedback-chip-fullbleed'), true);
        assert.deepEqual([strip(), look()], ['43px', null], 'only the Browser is full: its strip, the default look');
        codeWin.classList.add('ezil-fullbleed');
        await tick();
        assert.deepEqual([strip(), look()], ['28px', 'outline'], '🔴 Code full in front: Code\'s strip and its outlined look');
        browserWin.style.zIndex = '12';
        await tick();
        assert.deepEqual([strip(), look()], ['43px', null], 'positive control: the Browser back in front takes its strip back');
        browserWin.style.zIndex = '9';
        await tick();
        assert.deepEqual([strip(), look()], ['28px', 'outline'], 'a tie goes to the later window in the document');
        codeWin.style.display = 'none';
        await tick();
        assert.deepEqual([strip(), look()], ['43px', null], 'a full view that is not rendered is not in front');
        codeWin.style.display = '';
        codeWin.style.setProperty('--ezil-control-strip-height', '2em');
        codeWin.style.setProperty('--ezil-feedback-look', 'Outline!');
        await tick();
        assert.deepEqual([strip(), look()], ['', null], 'a value that is not a plain px length or look word is not copied (the CSS fallbacks apply)');
        codeWin.style.setProperty('--ezil-control-strip-height', '28px');
        codeWin.style.setProperty('--ezil-feedback-look', 'outline');
        await tick();
        assert.deepEqual([strip(), look()], ['28px', 'outline']);
        // Writes only on a change: a window mutation that changes nothing sets
        // no style property and no attribute on the icon. (A same-value CSSOM
        // write queues no mutation record, so the style writes are counted at
        // the call; an attribute set queues one even when the value is equal.)
        const writes = [];
        const watch = new MutationObserver(records => writes.push(...records.map(r => `attribute ${r.attributeName}`)));
        watch.observe(chip, { attributes: true });
        for ( const method of ['setProperty', 'removeProperty'] ) {
            const real = chip.style[method].bind(chip.style);
            chip.style[method] = (...args) => { writes.push(`${method} ${args[0]}`); return real(...args); };
        }
        parent.setAttribute('class', 'unrelated');
        await tick(); await tick();
        watch.disconnect();
        delete chip.style.setProperty;
        delete chip.style.removeProperty;
        assert.deepEqual(writes, [], 'nothing changed, nothing written to the icon');
        // The strip height is a `pointer: coarse` media query; flipping one
        // mutates nothing, so the icon also re-reads it on the query's change.
        const query = new window.EventTarget();
        query.matches = false;
        const realMatchMedia = window.matchMedia;
        window.matchMedia = () => query;
        feedback.mount_feedback_chip();
        const coarse = document.createElement('style');
        coarse.textContent = '.window[data-app="code"].ezil-fullbleed { --ezil-control-strip-height: 44px !important; }';
        document.head.append(coarse);
        await tick();
        assert.equal(strip(), '28px', 'setup: a stylesheet change alone is not observed');
        query.dispatchEvent(new window.Event('change'));
        assert.equal(strip(), '44px', '🔴 the pointer query\'s change re-reads the strip');
        coarse.remove();
        codeWin.classList.remove('ezil-fullbleed');
        browserWin.classList.remove('ezil-fullbleed');
        await tick();
        assert.deepEqual([strip(), look(), chip.classList.contains('ezil-feedback-chip-fullbleed')], ['', null, false], 'no full view: neither is set');
        parent.remove();
        window.matchMedia = realMatchMedia;
        feedback.mount_feedback_chip();
        await tick();
    });
    await check('native dialog semantics, default-off consent, live preview, no pre-submit request', () => {
        open();
        assert.equal(modalCalls, 1);
        assert.equal(current().getAttribute('aria-labelledby'), current().querySelector('h2').id);
        assert.equal(form().elements.description.required, true);
        assert.equal(form().elements.description.maxLength, 4000);
        assert.equal(form().elements.diagnostics.checked, false);
        assert.equal(form().elements.screenshot.checked, false);
        assert.equal(payload().category, 'bug');
        assert.equal(payload().diagnostics, null);
        assert.equal(payload().screenshot, null);
        assert.equal(payload().computerId, computerId);
        feedback.open_feedback_dialog({ source: 'chip' });
        assert.equal(modalCalls, 1);
        setDescription('The desktop froze.');
        assert.match(current().querySelector('#ezil-feedback-counter').textContent, /18 \/ 4000/);
        change('diagnostics', true);
        assert.doesNotMatch(current().querySelector('pre').textContent, /SECRET|example\.test/);
        assert.equal(calls.length, 0);
    });
    await check('429 preserves form; retry reuses ID; body is exactly the preview; success reports image rejection', async () => {
        const id = payload().clientRequestId;
        const before = current().querySelector('pre').textContent;
        let resolve;
        respond = () => new Promise(r => { resolve = r; });
        send();
        assert.equal(current().querySelector('[type="submit"]').disabled, true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].body, before);
        assert.equal(calls[0].credentials, 'same-origin');
        send(); assert.equal(calls.length, 1);
        resolve({ status: 429, json: async () => ({ error: 'rate_limited' }) });
        await until(() => status().includes("You've sent several"));
        assert.equal(status(), "You've sent several reports this hour — try again later.");
        assert.equal(form().elements.description.value, 'The desktop froze.');
        respond = async () => ({ status: 200, json: async () => ({ id: reportId, screenshotAccepted: false }) });
        send();
        await until(() => status().includes(reportId));
        assert.equal(JSON.parse(calls[1].body).clientRequestId, id);
        // No screenshot was attached, so a server-side screenshotAccepted:false must not claim an image was dropped.
        assert.doesNotMatch(status(), /image wasn't stored/);
        assert.doesNotMatch(calls[1].body, /SECRET|example\.test/);
        const count = calls.length;
        send(); assert.equal(calls.length, count, 'success cannot be submitted twice');
        close();
        assert.equal(document.activeElement.id, 'opener');
    });
    await check('rich bugs validate all fields, preserve drafts and total text without truncation', () => {
        window.localStorage.removeItem(draftKey); open();
        setDescription('Cannot open the desktop');
        form().elements.category.value = 'bug';
        form().dispatchEvent(new window.Event('change', { bubbles: true }));
        assert.equal(current().querySelector('[type="submit"]').disabled, true);
        for (const [key, value] of Object.entries({ activity: 'Opening a project', steps: '1. Click Browser', expected: 'Desktop opens', actual: 'Spinner stays', reproducibility: 'Every time', impact: 'Blocked' })) form().elements[key].value = value;
        form().dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(current().querySelector('[type="submit"]').disabled, false);
        assert.match(payload().description, /Steps to reproduce\n1. Click Browser/);
        const before = payload().description; close(); open();
        assert.equal(payload().description, before);
        assert.equal(form().elements.steps.value, '1. Click Browser');
        form().elements.actual.value = 'x'.repeat(4000);
        form().dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(current().querySelector('[type="submit"]').disabled, true);
        assert.match(payload().description, new RegExp('x{4000}'));
        close(); window.localStorage.removeItem(draftKey);
    });
    await check('failure references require the upstream capability and remain bounded', () => {
        const events = telemetry.recentEvents();
        const event = events.at(-1);
        event.reason = 'worker_http_401:hmac_signature_mismatch';
        event.serverCorrelationId = 'srv_0123456789ab';
        assert.equal(build_diagnostics().recentEvents.at(-1).reason, undefined);
        window.__EZIL_BOOT__.desktopState.ui.feedbackEventDiagnostics = true;
        assert.equal(build_diagnostics().recentEvents.at(-1).reason, event.reason);
        assert.equal(build_diagnostics().recentEvents.at(-1).correlationId, event.serverCorrelationId);
        event.reason = 'https://private.test/?token=secret';
        event.serverCorrelationId = 'Bearer private';
        assert.equal(build_diagnostics().recentEvents.at(-1).reason, undefined);
        assert.equal(build_diagnostics().recentEvents.at(-1).correlationId, undefined);
        delete event.reason; delete event.serverCorrelationId;
        delete window.__EZIL_BOOT__.desktopState.ui.feedbackEventDiagnostics;
    });
    await check('expanded diagnostics are consented, frozen, refreshed and downgraded on a strict old server', async () => {
        window.__EZIL_BOOT__.desktopState.ui.feedbackReportBundle = true;
        open(); setDescription('Snapshot test');
        assert.equal(payload().diagnostics, null);
        change('diagnostics', true);
        const snapshot = JSON.stringify(payload().diagnostics);
        assert.equal(payload().diagnostics.recentEvents.length, 50);
        assert.ok(payload().diagnostics.tracePhases.some(p => p.code === 'display'));
        telemetry.capture({ eventClass: 'api_failure', site: 's', code: 'new_failure' });
        setDescription('Edited context');
        assert.equal(JSON.stringify(payload().diagnostics), snapshot);
        current().querySelector('[data-action="refresh-diagnostics"]').click();
        assert.equal(payload().diagnostics.recentEvents.at(-1).code, 'new_failure');
        const original = payload(); const count = calls.length;
        respond = async () => calls.length === count + 1 ? { status: 400 } : { status: 201, json: async () => ({ id: reportId }) };
        send(); await until(() => status().includes(reportId));
        const first = JSON.parse(calls[count].body), second = JSON.parse(calls[count + 1].body);
        assert.deepEqual(first, original);
        assert.equal(second.description, original.description);
        assert.equal(second.clientRequestId, original.clientRequestId);
        assert.equal(second.diagnostics.session, undefined);
        assert.equal(second.diagnostics.tracePhases, undefined);
        assert.equal(second.diagnostics.recentEvents[0].ageMs, undefined);
        assert.equal(current().querySelector('pre').textContent, calls[count + 1].body);
        assert.ok(Buffer.byteLength(calls[count].body) < 32768);
        close(); delete window.__EZIL_BOOT__.desktopState.ui.feedbackReportBundle;
        respond = async () => ({ status: 201, ok: true, json: async () => ({ id: reportId, screenshotAccepted: true }) });
    });
    await check('editing an unconfirmed report forks its ID before an old receipt can discard edits', async () => {
        open(); setDescription('Original unconfirmed report');
        const originalId = payload().clientRequestId;
        respond = async () => { throw new TypeError('Failed to fetch'); };
        send(); await until(() => stored(outboxKey)?.some(entry => entry.clientRequestId === originalId) && !current().querySelector('[type="submit"]').disabled);
        setDescription('New evidence after the first attempt');
        assert.notEqual(payload().clientRequestId, originalId);
        window.dispatchEvent(new window.CustomEvent('ezil:feedback-sent', { detail: { clientRequestId: originalId, id: reportId } }));
        assert.equal(current().querySelector('.ezil-feedback-fields').hidden, false);
        assert.equal(form().elements.description.value, 'New evidence after the first attempt');
        close(); window.localStorage.removeItem(outboxKey); window.localStorage.removeItem(draftKey);
        respond = async () => ({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: true }) });
    });
    await check('completed app trace keeps matching ID, app and phases in the diagnostic bundle', () => {
        const completed = beginTrace('desktop'); completed.step('display'); completed.end('ok');
        window.__EZIL_BOOT__.desktopState.ui.feedbackReportBundle = true;
        const snapshot = build_diagnostics();
        assert.equal(snapshot.traceId, completed.id);
        assert.equal(snapshot.traceApp, 'desktop');
        assert.equal(snapshot.tracePhases[0].code, 'display');
        diagnosticsSchema.parse(snapshot);
        delete window.__EZIL_BOOT__.desktopState.ui.feedbackReportBundle;
    });
    await check('quota failure retains text and never claims an image report is saved for automatic retry', async () => {
        open(); setDescription('Keep my report when storage fills');
        const prototype = Object.getPrototypeOf(window.localStorage);
        const original = prototype.setItem;
        prototype.setItem = function (key, value) {
            if (key === outboxKey) throw new Error('QuotaExceededError');
            return original.call(this, key, value);
        };
        try {
            respond = async () => ({ status: 503 });
            send(); await until(() => status().includes('Could not save this report'));
            assert.equal(stored(draftKey).description, 'Keep my report when storage fills');
            assert.match(status(), /copy your report text/);
            assert.equal(stored(outboxKey), null);
        } finally {
            prototype.setItem = original;
            close();
            window.localStorage.removeItem(draftKey);
            respond = async () => ({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: true }) });
        }
    });
    await check('all capture tiers use the editor; tab capture starts synchronously; no upload before Submit', async () => {
        open(); setDescription('Screenshot report'); change('screenshot', true);
        const count = calls.length;
        for ( const kind of ['shell', 'tab', 'desktop'] ) {
            const index = captureCalls.length;
            current().querySelector(`[data-capture="${kind}"]`).click();
            assert.equal(captureCalls[index], kind, 'capture starts in the click stack');
            await until(() => payload().screenshot !== null && ! current().querySelector('[type="submit"]').disabled);
            assert.equal(captureCalls[index + 1], 'editor');
            assert.equal(payload().screenshot.dataBase64, imageBytes.toString('base64'));
            assert.equal(calls.length, count);
            if ( kind !== 'desktop' ) {
                current().querySelector('[data-action="remove-screenshot"]').click();
                assert.equal(payload().screenshot, null);
            }
        }
        const attached = current().querySelector('.ezil-feedback-image img');
        Object.defineProperties(attached, { naturalWidth: { value: 1 }, naturalHeight: { value: 1 } });
        const originalContext = window.HTMLCanvasElement.prototype.getContext;
        let source;
        window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage(image) { source = image; } });
        const editCount = captureCalls.length;
        current().querySelector('[data-capture="edit"]').click();
        await until(() => captureCalls.length > editCount && !current().querySelector('[type="submit"]').disabled);
        assert.equal(source, attached, 'editing starts from the redacted attached image');
        assert.equal(captureCalls.at(-1), 'editor');
        window.HTMLCanvasElement.prototype.getContext = originalContext;
        respond = async () => ({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: true }) });
        const before = current().querySelector('pre').textContent;
        send(); await until(() => status().includes(reportId));
        assert.equal(calls.at(-1).body, before);
        close();
    });
    await check('revoking screenshot consent discards a pending capture', async () => {
        open(); setDescription('Capture cancelled'); change('screenshot', true);
        let finish;
        nextCanvas = () => new Promise(resolve => { finish = resolve; });
        current().querySelector('[data-capture="tab"]').click();
        change('screenshot', false);
        finish(document.createElement('canvas'));
        await until(() => ! current().querySelector('[type="submit"]').disabled);
        assert.equal(payload().screenshot, null);
        assert.equal(current().querySelector('.ezil-feedback-image').hidden, true);
        assert.doesNotMatch(status(), /Preparing/);
        nextCanvas = () => Promise.resolve(document.createElement('canvas'));
        close();
    });
    await check('warnings are advisory; 400/413/network errors preserve text; Escape restores focus', async () => {
        open(); setDescription('Contact test@example.com or sk-example123');
        assert.equal(current().querySelector('.ezil-feedback-warning').hidden, false);
        assert.equal(current().querySelector('[type="submit"]').disabled, false);
        for ( const code of [400, 413, 500] ) {
            respond = async () => ({ status: code });
            send(); await until(() => ! current().querySelector('[type="submit"]').disabled);
            assert.match(status(), code === 400 ? /could not be accepted/ : code === 413 ? /too large/ : /Could not send/);
            if ( code === 500 ) assert.match(status(), /server could not take it.*press Send to try again/, '🔴 a server error while online names the retry action');
            if ( code === 500 ) assert.doesNotMatch(status(), /connection comes back/, 'no reconnect promise after a server answer');
            assert.equal(form().elements.description.value, 'Contact test@example.com or sk-example123');
        }
        respond = async () => { throw new Error('offline'); };
        send(); await until(() => ! current().querySelector('[type="submit"]').disabled);
        assert.match(status(), /Check your connection/);
        current().dispatchEvent(new window.Event('cancel', { cancelable: true }));
        assert.equal(current(), null);
        assert.equal(document.activeElement.id, 'opener');
    });
    await check('a send that got no answer is kept and re-sent once, byte-for-byte, on `online`', async () => {
        const queued = stored(outboxKey);
        assert.equal(queued.length, 1, '400/413 were dropped; only the unanswered send is queued');
        const sentBefore = calls.filter(c => c.method === 'POST').at(-1).body;
        assert.equal(queued[0].body, sentBefore, 'the queued body is exactly what was last sent');
        assert.equal(JSON.parse(queued[0].body).clientRequestId, queued[0].clientRequestId);
        assert.equal(stored(draftKey).clientRequestId, queued[0].clientRequestId, 'the draft keeps the same id');
        flushing = true;
        respond = async () => ({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: false }) });
        const count = calls.length;
        window.dispatchEvent(new window.Event('online'));
        await until(() => stored(outboxKey) === null);
        assert.equal(calls.length, count + 1, 'exactly one request on reconnect');
        assert.equal(calls.at(-1).body, sentBefore);
        assert.equal(stored(draftKey), null, 'a confirmed send clears its draft');
        window.dispatchEvent(new window.Event('online')); await tick();
        assert.equal(calls.length, count + 1, 'nothing left to resend');
        flushing = false;
    });
    await check('offline submit says so, keeps the open form, and completes it on reconnect', async () => {
        open(); setDescription('Sent while offline');
        const id = payload().clientRequestId;
        const body = current().querySelector('pre').textContent;
        setOnline(false);
        respond = async () => { throw new TypeError('Failed to fetch'); };
        send(); await until(() => /offline/.test(status()));
        assert.equal(status(), "You're offline. Your report is saved and will be sent when you're back online.");
        assert.equal(form().elements.description.value, 'Sent while offline');
        // Still offline: an `online` from a flaky link must not spray requests.
        let count = calls.length;
        await feedback.flush_feedback_outbox();
        assert.equal(calls.length, count);
        setOnline(true);
        flushing = true;
        respond = async () => ({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: false }) });
        count = calls.length;
        window.dispatchEvent(new window.Event('online'));
        await until(() => /Thanks — we got it/.test(status()));
        flushing = false;
        assert.equal(calls.length, count + 1);
        assert.equal(calls.at(-1).body, body);
        assert.equal(JSON.parse(calls.at(-1).body).clientRequestId, id);
        assert.equal(current().querySelector('[type="submit"]').hidden, true);
        assert.equal(stored(outboxKey), null); assert.equal(stored(draftKey), null);
        close();
    });
    // Deadline timers are the only ones at or above the base allowance; the fakes record them instead.
    function fakeDeadlines () {
        const timers = [];
        const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
        globalThis.setTimeout = (fn, ms, ...rest) => {
            if ( ms < feedback.SEND_DEADLINE.baseMs ) return realSetTimeout(fn, ms, ...rest);
            const timer = { fn, ms, cleared: false };
            timers.push(timer);
            return timer;
        };
        globalThis.clearTimeout = timer => { if ( timers.includes(timer) ) timer.cleared = true; else realClearTimeout(timer); };
        timers.restore = () => { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; };
        return timers;
    }
    const stalledBody = (url, options) => Promise.resolve({ status: 201, json: () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }) });
    const queuedReport = (id, description, base64 = null) => JSON.stringify({ v: 1, clientRequestId: id, category: 'bug', description,
        ...(base64 ? { screenshot: { contentType: 'image/png', dataBase64: base64 } } : {}) });
    await check('a send that never answers times out, says so truthfully, unlocks the form and re-sends the same id', async () => {
        open(); setDescription('Stalled send');
        const id = payload().clientRequestId;
        const body = current().querySelector('pre').textContent;
        let signal;
        respond = (url, options) => new Promise((resolve, reject) => {
            signal = options.signal;
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
        const timers = fakeDeadlines();
        try {
            send(); await until(() => timers.length === 1);
            assert.equal(timers[0].ms, feedback.send_deadline_ms(body.length), 'the deadline follows the body size');
            assert.ok(timers[0].ms >= 40_000 && timers[0].ms < 60_000, 'a text report keeps a short but real deadline');
            assert.match(status(), /^Sending…/, 'setup: the request is still pending');
            assert.equal(signal.aborted, false);
            timers[0].fn();
            await until(() => ! current().querySelector('[type="submit"]').disabled);
        } finally { timers.restore(); }
        assert.equal(signal.aborted, true, '🔴 the deadline aborts the request');
        assert.match(status(), /didn't answer in time.*press Send to try again/, '🔴 a timeout names the retry action');
        assert.doesNotMatch(status(), /online|connection comes back|Check your connection/, 'no reconnect promise while online');
        assert.equal(stored(outboxKey).at(-1).body, body, 'the unanswered body stays queued');
        // Pressing Send again reuses the id, which the server answers as a replay.
        respond = async () => ({ status: 200, json: async () => ({ id: reportId, screenshotAccepted: false }) });
        send(); await until(() => /Thanks — we got it/.test(status()));
        assert.equal(JSON.parse(calls.at(-1).body).clientRequestId, id);
        assert.equal(stored(outboxKey), null);
        close();
    });
    await check('a large report gets a bounded size-aware deadline, text goes first, and a timeout never starves the queue', async () => {
        const bigId = '77777777-7777-4777-8777-777777777777', textId = '88888888-8888-4888-8888-888888888888';
        const laterId = '99999999-9999-4999-8999-999999999999';
        const big = queuedReport(bigId, 'Large queued report', 'A'.repeat(2 * 1024 * 1024));
        const later = queuedReport(laterId, 'Larger queued report', 'A'.repeat(2 * 1024 * 1024 + 4));
        const text = queuedReport(textId, 'Text queued behind it');
        // A maximum screenshot over a 40 kbit/s uplink fits its deadline, and the deadline stays bounded.
        assert.ok(feedback.send_deadline_ms(big.length) > big.length * 8 / 40_000 * 1000, '🔴 the client waits out a slow but live uplink');
        assert.ok(feedback.send_deadline_ms(big.length + 32 * 1024) <= 10 * 60_000, 'the 1.5 MiB image cap bounds the deadline');
        window.localStorage.setItem(outboxKey, JSON.stringify([{ clientRequestId: bigId, body: big, draft: null },
            { clientRequestId: textId, body: text, draft: null }, { clientRequestId: laterId, body: later, draft: null }]));
        const timers = fakeDeadlines();
        flushing = true;
        try {
            // Headers arrive for the first large report, then its body stalls; the others are answered.
            respond = (url, options) => JSON.parse(options.body).clientRequestId === bigId ? stalledBody(url, options)
                : Promise.resolve({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: false }) });
            const count = calls.length;
            const first = feedback.flush_feedback_outbox();
            await until(() => timers.length === 2);
            assert.equal(timers[0].ms, feedback.send_deadline_ms(text.length));
            assert.equal(timers[0].cleared, true, '🔴 a confirmed send clears its deadline timer');
            assert.equal(timers[1].ms, feedback.send_deadline_ms(big.length));
            await tick();
            assert.equal(timers[1].cleared, false, 'setup: the body read is still pending');
            timers[1].fn();
            await first;
            assert.deepEqual(calls.slice(count).map(c => JSON.parse(c.body).clientRequestId), [textId, bigId, laterId],
                '🔴 smallest first, and the flush moves past a timed-out entry');
            assert.equal(timers[1].cleared, true, 'the deadline timer is released after an abort');
            assert.deepEqual(stored(outboxKey).map(entry => entry.body), [big], '🔴 an abort during the body read keeps the entry');
            // A slow upload that answers before its deadline completes normally.
            respond = () => new Promise(resolve => setTimeout(() => resolve({ status: 200, json: async () => ({ id: reportId, screenshotAccepted: true }) }), 5));
            await feedback.flush_feedback_outbox();
            assert.equal(stored(outboxKey), null);
            assert.equal(timers[3].cleared, true);
            // A network failure (not a timeout) still stops the flush: the rest would fail the same way.
            window.localStorage.setItem(outboxKey, JSON.stringify([
                { clientRequestId: textId, body: text, draft: null }, { clientRequestId: bigId, body: big, draft: null }]));
            respond = async () => { throw new TypeError('Failed to fetch'); };
            const before = calls.length;
            await feedback.flush_feedback_outbox();
            assert.equal(calls.length, before + 1, 'one attempt, then wait for the network');
            assert.equal(stored(outboxKey).length, 2);
            window.localStorage.removeItem(outboxKey);
        } finally { timers.restore(); flushing = false; }
    });
    await check('a flush never rewrites the stored order, and equal-size entries go oldest first', async () => {
        const ids = ['c1111111-1111-4111-8111-111111111111', 'c2222222-2222-4222-8222-222222222222',
            'c3333333-3333-4333-8333-333333333333', 'c4444444-4444-4444-8444-444444444444'];
        // Oldest first in storage: two equal text bodies, one screenshot, then another equal text body.
        const bodies = [queuedReport(ids[0], 'Equal A'), queuedReport(ids[1], 'Equal B'),
            queuedReport(ids[2], 'Screenshot', 'A'.repeat(70 * 1024)), queuedReport(ids[3], 'Equal C')];
        const seeded = ids.map((clientRequestId, i) => ({ clientRequestId, body: bodies[i], draft: null }));
        window.localStorage.setItem(outboxKey, JSON.stringify(seeded));
        flushing = true;
        try {
            const count = calls.length;
            const before = window.localStorage.getItem(outboxKey);
            respond = async () => { throw new TypeError('Failed to fetch'); };
            await feedback.flush_feedback_outbox();
            assert.equal(window.localStorage.getItem(outboxKey), before, '🔴 a flush leaves the stored age order untouched');
            // Only the screenshot is answered with a retryable server error, so it stays queued.
            respond = async (url, options) => JSON.parse(options.body).clientRequestId === ids[2]
                ? { status: 503 } : { status: 201, json: async () => ({ id: reportId, screenshotAccepted: false }) };
            await feedback.flush_feedback_outbox();
            assert.deepEqual(calls.slice(count + 1).map(c => JSON.parse(c.body).clientRequestId), [ids[0], ids[1], ids[3], ids[2]],
                '🔴 equal sizes keep their age order; the larger body goes last');
            assert.deepEqual(stored(outboxKey).map(entry => entry.clientRequestId), [ids[2]]);
            window.localStorage.removeItem(outboxKey);
        } finally { flushing = false; }
    });
    await check('a timeout on the compatibility re-send still counts as a timeout', async () => {
        const leanId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nextId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        const withDiagnostics = JSON.stringify({ v: 1, clientRequestId: leanId, category: 'bug', description: 'Old server',
            diagnostics: { traceApp: 'desktop' } });
        const next = queuedReport(nextId, 'Queued after the downgraded report, long enough to sort after it');
        window.localStorage.setItem(outboxKey, JSON.stringify([
            { clientRequestId: leanId, body: withDiagnostics, draft: null }, { clientRequestId: nextId, body: next, draft: null }]));
        const timers = fakeDeadlines();
        flushing = true;
        try {
            // The older strict server refuses the extension (400); the lean re-send then stalls.
            respond = (url, options) => {
                const sent = JSON.parse(options.body);
                if ( sent.clientRequestId === nextId ) return Promise.resolve({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: false }) });
                return sent.diagnostics?.traceApp ? Promise.resolve({ status: 400 }) : stalledBody(url, options);
            };
            const count = calls.length;
            const flush = feedback.flush_feedback_outbox();
            await until(() => timers.length === 2);
            await tick();
            timers[1].fn();
            await flush;
            assert.equal(calls.length, count + 3, '🔴 the lean timeout lets the flush reach the next entry');
            assert.equal(stored(outboxKey).length, 1);
            assert.equal(JSON.parse(stored(outboxKey)[0].body).diagnostics?.traceApp, undefined, 'the lean body is what stays queued');
            window.localStorage.removeItem(outboxKey);
        } finally { timers.restore(); flushing = false; }
    });
    await check('a timeout with a full outbox says the report could not be saved', async () => {
        open(); setDescription('Unqueued stalled report');
        const template = payload();
        const seeded = Array.from({ length: 10 }, () => {
            const clientRequestId = crypto.randomUUID();
            return { clientRequestId, body: JSON.stringify({ ...template, clientRequestId }) };
        });
        window.localStorage.setItem(outboxKey, JSON.stringify(seeded));
        respond = stalledBody;
        const timers = fakeDeadlines();
        try {
            send(); await until(() => timers.length === 1);
            await tick();
            timers[0].fn();
            await until(() => ! current().querySelector('[type="submit"]').disabled);
        } finally { timers.restore(); }
        assert.match(status(), /Could not save this report/, '🔴 never claims a report is saved when it was not queued');
        close();
        window.localStorage.removeItem(outboxKey);
        window.localStorage.removeItem(draftKey);
    });
    await check('reports carry the switched current computer, frozen through a later switch and replay', async () => {
        const computerB = '55555555-5555-4555-8555-555555555555';
        const computerC = '66666666-6666-4666-8666-666666666666';
        setCurrentComputer({ id: computerB });
        open(); setDescription('Filed on computer B');
        assert.equal(payload().computerId, computerB, 'preview names the current computer, not the boot one');
        const body = current().querySelector('pre').textContent;
        setOnline(false);
        respond = async () => { throw new TypeError('Failed to fetch'); };
        send(); await until(() => /offline/.test(status()));
        assert.equal(JSON.parse(stored(outboxKey).at(-1).body).computerId, computerB);
        // Switch away and drop the dialog (as a reload would); the queued body must not follow.
        setCurrentComputer({ id: computerC });
        close();
        setOnline(true);
        flushing = true;
        respond = async () => ({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: false }) });
        const count = calls.length;
        await feedback.flush_feedback_outbox();
        await until(() => stored(outboxKey) === null);
        flushing = false;
        assert.equal(calls.length, count + 1);
        assert.equal(calls.at(-1).body, body, 'replay sends the frozen body unchanged');
        assert.equal(JSON.parse(calls.at(-1).body).computerId, computerB);
        open();
        assert.equal(payload().computerId, computerC, 'a new report snapshots the computer current at open');
        close();
        setCurrentComputer(null);
        window.localStorage.removeItem(draftKey);
        open();
        assert.equal(payload().computerId, computerId, 'cleared choice falls back to the boot computer');
        close();
    });
    await check('a definitive refusal is not retried and keeps the text for editing', async () => {
        open(); setDescription('Refused report');
        respond = async () => ({ status: 415 });
        send(); await until(() => ! current().querySelector('[type="submit"]').disabled);
        assert.equal(stored(outboxKey), null);
        close();
        open();
        assert.equal(form().elements.description.value, 'Refused report');
        const count = calls.length;
        window.dispatchEvent(new window.Event('online')); await tick();
        assert.equal(calls.length, count);
        setDescription('');
        assert.equal(stored(draftKey), null, 'an emptied form leaves no draft behind');
        close();
    });
    await check('a full outbox keeps all 10 pending reports and retains the unqueued draft', async () => {
        open(); setDescription('Queued report 10');
        const template = payload();
        const seeded = Array.from({ length: 10 }, (_, i) => {
            const clientRequestId = crypto.randomUUID();
            return { clientRequestId, body: JSON.stringify({ ...template, clientRequestId, description: `Queued report ${i}` }) };
        });
        window.localStorage.setItem(outboxKey, JSON.stringify(seeded));
        setOnline(false);
        respond = async () => { throw new TypeError('Failed to fetch'); };
        send(); await until(() => /Could not save this report/.test(status()));
        const kept = stored(outboxKey);
        assert.deepEqual(kept.map(entry => entry.clientRequestId), seeded.map(entry => entry.clientRequestId),
            'a new report never evicts an unconfirmed report');
        assert.equal(stored(draftKey).description, 'Queued report 10', 'the unqueued report remains a text draft');
        close();
        // A stored list longer than the cap (an older build, another tab) is read capped too.
        window.localStorage.setItem(outboxKey, JSON.stringify([seeded[0], ...kept]));
        setOnline(true);
        flushing = true;
        respond = async () => ({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: false }) });
        const count = calls.length;
        await feedback.flush_feedback_outbox();
        flushing = false;
        assert.deepEqual(calls.slice(count).filter(c => c.method === 'POST').map(c => JSON.parse(c.body).clientRequestId),
            kept.map(entry => entry.clientRequestId), 'only the newest 10 are sent, oldest first');
        assert.equal(stored(outboxKey), null);
    });
    await check('resume_feedback_outbox alone mounts no icon: queued sends go once; `online` and bfcache restore stay watched', async () => {
        // Drop the icon mounted above (and its `online` listener) to exercise the resume on its own.
        window.dispatchEvent(new window.Event('ezil:teardown'));
        assert.equal(document.querySelector('.ezil-feedback-chip'), null);
        open(); const template = payload(); close();
        const queue = description => {
            const clientRequestId = crypto.randomUUID();
            return { clientRequestId, body: JSON.stringify({ ...template, clientRequestId, description }) };
        };
        const first = queue('Queued before a reload');
        window.localStorage.setItem(outboxKey, JSON.stringify([first]));
        setOnline(true);
        flushing = true;
        respond = async () => ({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: false }) });
        let count = calls.length;
        feedback.resume_feedback_outbox(); feedback.resume_feedback_outbox();
        await until(() => stored(outboxKey) === null);
        assert.deepEqual(calls.slice(count).map(c => c.body), [first.body], 'sent once, byte for byte');
        assert.equal(document.querySelector('.ezil-feedback-chip'), null, 'resuming the outbox mounts no icon');
        count = calls.length;
        const later = queue('Queued while offline');
        window.localStorage.setItem(outboxKey, JSON.stringify([later]));
        window.dispatchEvent(new window.Event('online'));
        await until(() => stored(outboxKey) === null);
        const restored = queue('Queued before the page was cached');
        window.localStorage.setItem(outboxKey, JSON.stringify([restored]));
        window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: false }));
        await tick();
        assert.notEqual(stored(outboxKey), null, 'an ordinary pageshow is not a restore');
        window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
        await until(() => stored(outboxKey) === null);
        assert.deepEqual(calls.slice(count).map(c => c.body), [later.body, restored.body]);
        flushing = false;
    });
    await check('a back/forward-cache restore runs two flushes (icon remount + restore listener) yet sends each report once', async () => {
        assert.equal(stored(outboxKey), null);
        feedback.mount_feedback_chip();
        open(); const template = payload(); close();
        const queue = description => {
            const clientRequestId = crypto.randomUUID();
            return { clientRequestId, body: JSON.stringify({ ...template, clientRequestId, description }) };
        };
        const slow = queue('Queued first, answered slowly');
        const quick = queue('Queued second, answered at once');
        window.localStorage.setItem(outboxKey, JSON.stringify([slow, quick]));
        setOnline(true);
        flushing = true;
        let release = null;
        const created = { status: 201, json: async () => ({ id: reportId, screenshotAccepted: false }) };
        respond = (url, options) => JSON.parse(options.body).clientRequestId === slow.clientRequestId
            ? new Promise(resolve => { release = () => resolve(created); }) : Promise.resolve(created);
        const count = calls.length;
        window.dispatchEvent(new window.PageTransitionEvent('pagehide', { persisted: true }));
        window.dispatchEvent(new window.PageTransitionEvent('pageshow', { persisted: true }));
        await until(() => release && ! stored(outboxKey)?.some(entry => entry.clientRequestId === quick.clientRequestId));
        release();
        await until(() => stored(outboxKey) === null);
        await tick();
        const sent = calls.slice(count).map(c => JSON.parse(c.body).description);
        assert.deepEqual(sent.toSorted(), [quick, slow].map(entry => JSON.parse(entry.body).description).toSorted(),
            `each queued report is POSTed once (${JSON.stringify(sent)})`);
        assert.equal(document.querySelectorAll('.ezil-feedback-chip').length, 1, 'the icon is back, once');
        window.dispatchEvent(new window.Event('ezil:teardown'));
        flushing = false;
    });
    await check('the draft survives closing, keeps its id, is per account and never holds an email', async () => {
        open(); setDescription('Half-written report'); change('diagnostics', true);
        form().elements.category.value = 'idea';
        form().querySelector('input[value="idea"]').dispatchEvent(new window.Event('change', { bubbles: true }));
        const id = payload().clientRequestId;
        close();
        open();
        assert.equal(form().elements.description.value, 'Half-written report');
        assert.equal(form().elements.category.value, 'idea');
        assert.equal(payload().clientRequestId, id);
        assert.equal(form().elements.diagnostics.checked, false, 'consent is never remembered');
        close();
        for ( let i = 0; i < window.localStorage.length; i++ ) {
            const key = window.localStorage.key(i);
            assert.doesNotMatch(key + window.localStorage.getItem(key), /SECRET|example\.test|@/);
        }
        const user = window.__EZIL_BOOT__.user;
        Object.defineProperty(window.__EZIL_BOOT__, 'user', { configurable: true, value: { id: '44444444-4444-4444-8444-444444444444' } });
        open();
        assert.equal(form().elements.description.value, '', 'another account on this browser sees nothing');
        assert.notEqual(payload().clientRequestId, id);
        close();
        Object.defineProperty(window.__EZIL_BOOT__, 'user', { configurable: true, value: user });
        open(); setDescription(''); close();
    });
    await check('Round 4: the opening screen\'s error code is prefilled, appended once to a saved draft, and kept within 4,000 characters', async () => {
        const openWith = errorCode => { document.querySelector('#opener').focus(); feedback.open_feedback_dialog({ source: 'opening', errorCode }); };
        openWith('billing_files_on_aws');
        assert.equal(form().elements.description.value, 'Error code: billing_files_on_aws\n\n', 'no draft: the code leads the report');
        setDescription(''); close();
        open(); setDescription('Code would not open after I cancelled'); close();
        openWith('billing_files_on_aws');
        assert.equal(form().elements.description.value, 'Code would not open after I cancelled\n\nError code: billing_files_on_aws',
            'a saved draft keeps its text and gains the code');
        setDescription(form().elements.description.value); close();
        openWith('billing_files_on_aws');
        assert.equal((form().elements.description.value.match(/Error code: billing_files_on_aws/g) ?? []).length, 1, 'appended once');
        close();
        openWith('not a code!');
        assert.doesNotMatch(form().elements.description.value, /not a code/, 'an invalid code is never written');
        const full = 'x'.repeat(3995);
        setDescription(full); close();
        openWith('billing_payment_issue');
        assert.equal(form().elements.description.value, full, 'a draft at the limit is not pushed past 4,000 characters');
        setDescription(''); close();
    });
    await check('teardown and navigation close the form, abort pending captures and leave Back unhandled', async () => {
        const count = calls.length;
        for ( const type of ['ezil:teardown', 'popstate', 'pagehide', 'hashchange'] ) {
            open(); setDescription('Interrupted report'); change('screenshot', true);
            let finish;
            nextCanvas = () => new Promise(resolve => { finish = resolve; });
            const button = current().querySelector('[data-capture="shell"]');
            const captures = captureCalls.length;
            button.click(); button.click();
            assert.equal(captureCalls.length, captures + 1);
            const { signal } = captureOptions.at(-1);
            const event = new window.Event(type, { cancelable: true });
            window.dispatchEvent(event);
            assert.equal(event.defaultPrevented, false);
            assert.equal(current(), null);
            assert.equal(signal.aborted, true);
            finish(document.createElement('canvas'));
            await tick();
            assert.equal(current(), null);
            assert.equal(captureCalls.length, captures + 1, 'late capture must not open editor');
        }
        nextCanvas = () => Promise.resolve(document.createElement('canvas'));
        assert.equal(calls.length, count);
        assert.equal(document.querySelector('.ezil-feedback-chip'), null);
        feedback.mount_feedback_chip();
        window.dispatchEvent(new window.Event('pagehide'));
        assert.equal(document.querySelector('.ezil-feedback-chip'), null);
        window.dispatchEvent(new window.Event('pageshow'));
        assert.equal(document.querySelectorAll('.ezil-feedback-chip').length, 1);
    });
    await check('cancelled capture cannot unlock or reveal a newer pending capture', async () => {
        open(); setDescription('Recapture'); change('screenshot', true);
        let oldFinish, newFinish;
        nextCanvas = () => new Promise(resolve => { oldFinish = resolve; });
        current().querySelector('[data-capture="shell"]').click();
        const oldSignal = captureOptions.at(-1).signal;
        change('screenshot', false);
        assert.equal(oldSignal.aborted, true);
        assert.equal(current().classList.contains('ezil-feedback-capturing'), false);
        change('screenshot', true);
        nextCanvas = () => new Promise(resolve => { newFinish = resolve; });
        current().querySelector('[data-capture="shell"]').click();
        oldFinish(document.createElement('canvas')); await tick();
        assert.equal(current().querySelector('[data-capture="shell"]').disabled, true);
        assert.equal(current().querySelector('[type="submit"]').disabled, true);
        assert.equal(current().classList.contains('ezil-feedback-capturing'), true);
        assert.equal(status(), 'Preparing screenshot…');
        assert.equal(payload().screenshot, null);
        newFinish(document.createElement('canvas'));
        await until(() => payload().screenshot !== null);
        nextCanvas = () => Promise.resolve(document.createElement('canvas'));
        close();
    });
    await check('editor Cancel returns to the draft; closing the form aborts editing and discards late edits', async () => {
        open(); setDescription('Keep this draft'); change('screenshot', true);
        const originalEditor = editorResult;
        editorResult = () => null;
        current().querySelector('[data-capture="shell"]').click();
        await until(() => !current().querySelector('[type="submit"]').disabled);
        assert.equal(form().elements.description.value, 'Keep this draft');
        assert.equal(payload().screenshot, null);
        let finish;
        editorResult = () => new Promise(resolve => { finish = resolve; });
        current().querySelector('[data-capture="shell"]').click();
        await until(() => !!finish);
        const { signal } = editorOptions.at(-1);
        close();
        assert.equal(signal.aborted, true);
        finish(originalEditor()); await tick();
        assert.equal(current(), null);
        editorResult = originalEditor;
        open();
        assert.equal(form().elements.description.value, 'Keep this draft', 'the text draft survives closing the form');
        assert.equal(payload().screenshot, null, 'a screenshot is never part of the saved draft');
        setDescription('');
        close();
    });
    await check('closing during submission is truthful and late success cannot change a new draft', async () => {
        open(); setDescription('Submitted report');
        let finish;
        respond = () => new Promise(resolve => { finish = resolve; });
        const count = calls.length;
        send(); send();
        assert.equal(calls.length, count + 1);
        assert.equal(current().querySelector('[data-action="cancel"]').textContent, 'Close');
        assert.match(status(), /Closing this window does not cancel the report/);
        const sentId = JSON.parse(calls.at(-1).body).clientRequestId;
        close(); open(); setDescription('New draft');
        finish({ status: 201, json: async () => ({ id: reportId }) }); await tick();
        assert.equal(form().elements.description.value, 'New draft');
        assert.notEqual(payload().clientRequestId, sentId);
        assert.equal(status(), '');
        assert.equal(calls.length, count + 1);
        close();
    });
    await check('screenshot and tab support flags hide unavailable controls; disabled feedback stays dark', async () => {
        supported = false;
        open(); assert.equal(current().querySelector('[data-capture="tab"]'), null); close();
        desktopSupported = false;
        open(); change('screenshot', true);
        assert.equal(current().querySelector('[data-capture="desktop"]'), null, 'no registered desktop frame: no dead "Capture the desktop"');
        assert.notEqual(current().querySelector('[data-capture="shell"]'), null);
        close();
        window.__EZIL_BOOT__.desktopState.ui.feedbackScreenshots = false;
        open(); assert.equal(form().elements.screenshot, undefined); close();
        delete window.__EZIL_BOOT__.desktopState.endpoints.feedback;
        const count = calls.length;
        feedback.open_feedback_dialog({ source: 'troubleshoot' });
        assert.equal(current(), null);
        assert.equal(feedback.feedback_enabled(), false);
        assert.deepEqual(await feedback.list_my_reports(), []);
        assert.equal(await feedback.delete_my_report(reportId), false);
        assert.equal(calls.length, count);
        window.__EZIL_BOOT__.desktopState.endpoints.feedback = '/api/shell/feedback';
    });
    await check('report GET and DELETE use the endpoint and same-origin credentials', async () => {
        const reports = [{ id: reportId, category: 'bug', createdAt: '2026-10-15', descriptionPreview: 'Desktop froze', hasScreenshot: false, status: 'new' }];
        respond = async () => ({ status: 200, ok: true, json: async () => ({ reports }) });
        assert.deepEqual(await feedback.list_my_reports(), reports);
        assert.equal(calls.at(-1).method, 'GET');
        respond = async () => ({ status: 204 });
        assert.equal(await feedback.delete_my_report(reportId), true);
        assert.equal(calls.at(-1).url, `/api/shell/feedback?id=${reportId}`);
        assert.equal(calls.at(-1).credentials, 'same-origin');
        const count = calls.length;
        assert.equal(await feedback.delete_my_report('invalid'), false);
        assert.equal(calls.length, count);
    });
    await check('a stalled report list or delete fails at its deadline instead of loading forever', async () => {
        const timers = [];
        const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
        globalThis.setTimeout = (fn, ms, ...rest) => {
            if ( ms !== feedback.REPORTS_DEADLINE_MS ) return realSetTimeout(fn, ms, ...rest);
            const timer = { fn, ms, cleared: false };
            timers.push(timer);
            return timer;
        };
        globalThis.clearTimeout = timer => { if ( timers.includes(timer) ) timer.cleared = true; else realClearTimeout(timer); };
        // Without a signal the request can only hang, exactly as a real stalled one would.
        const stall = (url, options) => new Promise((resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
        const settled = promise => Promise.race([promise.then(value => ({ value }), error => ({ error })),
            new Promise(resolve => realSetTimeout(() => resolve({ hung: true }), 200))]);
        try {
            // The list's headers arrive, then its body stalls.
            respond = (url, options) => Promise.resolve({ status: 200, ok: true, json: () => stall(url, options) });
            const listing = feedback.list_my_reports();
            await until(() => timers.length === 1);
            assert.ok(feedback.REPORTS_DEADLINE_MS >= 10_000 && feedback.REPORTS_DEADLINE_MS <= 30_000);
            timers[0].fn();
            const listed = await settled(listing);
            assert.equal(listed.hung, undefined, '🔴 the deadline ends a stalled list');
            assert.match(String(listed.error?.message), /Could not load your reports/, 'with the readable error');
            assert.equal(timers[0].cleared, true, 'the list deadline is released');
            respond = stall;
            const removal = feedback.delete_my_report(reportId);
            await until(() => timers.length === 2);
            timers[1].fn();
            assert.deepEqual(await settled(removal), { value: false }, '🔴 a stalled delete settles as not deleted');
            assert.equal(timers[1].cleared, true, 'the delete deadline is released');
            const reports = [{ id: reportId, category: 'bug', createdAt: '2026-10-15', descriptionPreview: 'Desktop froze', hasScreenshot: false, status: 'new' }];
            respond = async () => ({ status: 200, ok: true, json: async () => ({ reports }) });
            assert.deepEqual(await feedback.list_my_reports(), reports);
            assert.equal(timers[2].cleared, true, '🔴 a successful list clears its deadline');
        } finally { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; }
    });
    await check('Troubleshoot entry and reports are gated; explicit load, escaped preview and confirmed deletion', async () => {
        // Existing Troubleshoot deliberately reads the diagnostic-log ring;
        // the feedback isolation checks above have already kept that forbidden.
        log.ringBuffer = readRing;
        Object.defineProperty(window.__EZIL_BOOT__, 'user', { configurable: true, value: { email: 'BOOT_SECRET@example.test' } });
        window.eval(readFileSync(new URL('../../../src/lib/jquery-3.6.1/jquery-3.6.1.min.js', import.meta.url), 'utf8'));
        globalThis.$ = globalThis.jQuery = window.jQuery;
        globalThis.html_encode = value => { const el = document.createElement('span'); el.textContent = String(value); return el.innerHTML; };
        const { default: troubleshoot } = await import('../Settings/tabs/troubleshoot.js');
        const pane = document.createElement('div');
        const { default: feedbackTab } = await import('../Settings/tabs/feedback.js');
        pane.innerHTML = feedbackTab.html() + troubleshoot.html();
        const statusHost = pane.querySelector('[data-role="feedback-status-reports"]');
        document.body.append(pane);
        const $pane = $(pane);
        const count = calls.length;
        troubleshoot.init($pane);
        assert.equal(calls.length, count);
        const entry = pane.querySelector('[data-action="report-problem"]');
        assert.equal(entry.previousElementSibling.dataset.action, 'copy-diagnostics');
        entry.click();
        assert.equal(current().querySelector('h2').textContent, 'Send feedback');
        assert.equal(calls.length, count);
        close(); assert.equal(document.activeElement, entry);
        respond = async () => ({ status: 200, ok: true, json: async () => ({ reports: [{ id: reportId,
            category: 'idea', createdAt: '2026-10-15', descriptionPreview: '<img src=x onerror=alert(1)>', hasScreenshot: true, status: 'new' }] }) });
        pane.querySelector('[data-action="load-reports"]').click();
        await until(() => pane.querySelector('.ezil-feedback-reports li'));
        assert.equal(pane.querySelector('.ezil-feedback-reports img'), null);
        assert.equal(statusHost.textContent, '', 'Troubleshoot never writes into the other Feedback pane');
        assert.match(pane.querySelector('.ezil-feedback-reports').textContent, /Idea/);
        const remove = pane.querySelector('.ezil-feedback-reports button');
        window.confirm = () => false;
        const before = calls.length;
        remove.click(); await tick(); assert.equal(calls.length, before);
        window.confirm = () => true;
        respond = async () => ({ status: 204 });
        remove.click();
        await until(() => ! pane.querySelector('.ezil-feedback-reports li'));
        assert.equal(calls.at(-1).method, 'DELETE');
        assert.match(pane.textContent, /database backups expire on their own schedule/);
        // A send from the dialog refreshes the already-loaded list ("Your reports").
        entry.click(); setDescription('Shows up in Your reports');
        respond = async (url, options) => options.method === 'POST'
            ? { status: 201, json: async () => ({ id: reportId, screenshotAccepted: false }) }
            : { status: 200, ok: true, json: async () => ({ reports: [{ id: reportId, category: 'bug', createdAt: '2026-10-28',
                descriptionPreview: 'Shows up in Your reports', hasScreenshot: false, status: 'new' }] }) };
        send();
        await until(() => /Shows up in Your reports/.test(pane.querySelector('[data-role="feedback-reports"]').textContent));
        assert.equal(calls.at(-1).method, 'GET');
        close();
        delete window.__EZIL_BOOT__.desktopState.endpoints.feedback;
        troubleshoot.onActivate($pane);
        assert.equal(pane.querySelector('[data-action="report-problem"]'), null);
        assert.equal(pane.querySelector('[data-role="feedback-reports"]'), null);
        pane.remove();
    });
    await check('Settings → Feedback: a labelled button opens the existing form, returns focus, and is gated on the endpoint', async () => {
        window.__EZIL_BOOT__.desktopState.endpoints.feedback = '/api/shell/feedback';
        const { default: tab } = await import('../Settings/tabs/feedback.js');
        assert.equal(tab.id, 'feedback');
        assert.equal(tab.label, 'Feedback');
        assert.equal(tab.available(), true);
        const pane = document.createElement('div');
        pane.innerHTML = tab.html();
        document.body.append(pane);
        const count = calls.length;
        tab.init($(pane));
        const entry = pane.querySelector('[data-action="send-feedback"]');
        assert.equal(entry.tagName, 'BUTTON');
        assert.equal(entry.type, 'button');
        assert.equal(entry.textContent, 'Send feedback');
        entry.click();
        assert.equal(current().querySelector('h2').textContent, 'Send feedback');
        assert.equal(calls.length, count + 1, 'Settings loads reports once; opening the form sends nothing');
        assert.equal(calls[count].method, 'GET');
        await tick();
        assert.match(pane.querySelector('[data-role="feedback-status-reports"]').textContent, /New/);
        close(); assert.equal(document.activeElement, entry, 'closing the form returns focus to the Settings button');
        delete window.__EZIL_BOOT__.desktopState.endpoints.feedback;
        assert.equal(tab.available(), false, 'no endpoint: no Feedback tab');
        entry.click();
        assert.equal(current(), null);
        assert.equal(calls.length, count + 1);
        pane.remove();
    });
    console.log(`\n${checks} feedback checks passed. jsdom does not validate browser layout or real capture.`);
} finally {
    trace.end();
    hooks.deregister();
    dom.window.close();
}
