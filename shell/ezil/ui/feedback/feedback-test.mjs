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
    desktopState: { endpoints: { feedback: '/api/shell/feedback' }, ui: { feedbackScreenshots: true, feedbackEventDiagnostics: true } } };
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
let defaultCapture = false;
/** Share of the viewport the window snapshot reports as masked embedded app. */
let snapshotCoverage = 0;
let manualClick = false;
document.addEventListener('click', event => {
    if ( ! event.target.closest?.('[data-capture]') ) return;
    manualClick = true;
    queueMicrotask(() => { manualClick = false; });
}, true);
let encodeResult = () => new window.Blob([imageBytes], { type: 'image/webp' });
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJx8AAAAASUVORK5CYII=', 'base64');
let editorResult = () => ({ blob: new window.Blob([imageBytes], { type: 'image/png' }), contentType: 'image/png', width: 1, height: 1 });
globalThis.__feedbackCapture = {
    supported: () => supported,
    desktopSupported: () => desktopSupported,
    encode: (canvas, limit, options) => Promise.resolve(options?.signal?.aborted ? null : encodeResult(canvas, limit)),
    capture: (kind, options) => {
        if ( kind === 'shell' && options?.info ) options.info.frameCoverage = snapshotCoverage;
        // The default screenshot also calls the shell snapshot at open. Existing checks drive the manual buttons,
        // so unless a check opts in (`defaultCapture = true`) the default one is answered with no image, unrecorded.
        if ( kind === 'shell' && ! manualClick && ! defaultCapture ) return Promise.resolve(null);
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
    upload: (file, options) => { captureCalls.push(`upload:${file.name}`); captureOptions.push(options); return nextCanvas(); },
};
const imageFileUrl = new URL('./image-file.js', import.meta.url).href;
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
        source: 'export const open_redact_editor = (canvas, options) => globalThis.__feedbackCapture.edit(canvas, options);'
            + 'export const encode_under_limit = (canvas, limit, options) => globalThis.__feedbackCapture.encode(canvas, limit, options);' };
    if ( url === imageFileUrl ) return { format: 'module', shortCircuit: true,
        source: 'export const uploaded_image_canvas = (file, options) => globalThis.__feedbackCapture.upload(file, options);' };
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
// FEEDBACK-DIAG: the server allowlist itself (no `@/` imports, erasable TS only), to pin the shell twin to it.
const serverFailure = await import('../../../../app/src/server/lib/failure-diagnostics.ts');
const shellFailure = await import('../../failure-diagnostics.js');
const session = await import('../../session.js');
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
        if ( ! flushing ) {
            const box = document.querySelector('.ezil-feedback-preview');
            if ( ! box.open ) { box.open = true; box.dispatchEvent(new window.Event('toggle')); }
            assert.equal(options.body, box.querySelector('pre').textContent, 'preview is the exact request body at dispatch');
        }
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
// The preview renders only while open (the default screenshot makes the body large): opening it is the reader's act.
const showPreview = () => { const box = current().querySelector('.ezil-feedback-preview'); if ( ! box.open ) { box.open = true; box.dispatchEvent(new window.Event('toggle')); } };
const payload = () => { showPreview(); return JSON.parse(current().querySelector('pre').textContent); };
const status = () => current().querySelector('.ezil-feedback-result').textContent;
const setDescription = value => { form().elements.description.value = value; form().elements.description.dispatchEvent(new window.Event('input', { bubbles: true })); };
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
    await check('FEEDBACK-DIAG: the shell allowlist answers exactly as the server allowlist', () => {
        const values = [
            'worker_http_401', 'worker_http_401:hmac_signature_mismatch', 'aws_preview_unavailable:enrollment_failed',
            'aws_preview_unavailable:worker_status_401:hmac_signature_mismatch', 'sandbox_starting', 'session_missing',
            'desktop_frame_http_error_404', 'http2_v2_ec2', 'a:b:c', 'a:b:c:d', '', ':a', 'a:', 'a__b', '_a', 'a_',
            'x'.repeat(48), 'x'.repeat(49), `${'abcde_'.repeat(15)}x`, 'https://worker.example.test/?token=abc',
            'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature', 'Bearer abc', 'a3f9c0d1'.repeat(4), 'deadbeefcafe', 'deadbee',
            'Worker_HTTP_401', 'ts_1730367000000', 'http_40100', 'abc1234', 'abcdefghijklmnop', 'alice@example.com',
            '7c9e6679-7425-40de-944b-e07fc1f90ae7', '7C9E6679-7425-40DE-944B-E07FC1F90AE7', 'cid_lq2x8k9a3f8d7c6b', 'cid_',
            'srv_0123456789ab', 'srv_0123456789', serverFailure.newShortCorrelationId(), undefined, null, 401, {}, ['worker_http_401'],
        ];
        for ( const value of values ) {
            const label = JSON.stringify(value) ?? String(value);
            assert.equal(shellFailure.isReasonSegment(value), serverFailure.isReasonSegment(value), `segment ${label}`);
            assert.equal(shellFailure.isFailureReason(value), serverFailure.isFailureReason(value), `reason ${label}`);
            assert.equal(shellFailure.isCorrelationId(value), serverFailure.isCorrelationId(value), `correlation ${label}`);
        }
        assert.equal(shellFailure.FAILURE_REASON_MAX, serverFailure.FAILURE_REASON_MAX);
        assert.equal(shellFailure.FAILURE_REASON_MAX_SEGMENTS, serverFailure.FAILURE_REASON_MAX_SEGMENTS);
    });
    await check('FEEDBACK-DIAG: a simulated Worker HMAC 401 reaches the diagnostics as {code, reason, correlationId}', async () => {
        const corr = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
        const realFetch = globalThis.fetch;
        // The server's answer to POST /api/shell/desktop, exactly as the router now builds it.
        globalThis.fetch = window.fetch = async () => ({ ok: true, status: 200, json: async () => ({
            ok: false, errorCode: 'unauthorized', provider: 'cloudflare-guacamole',
            error: 'worker_http_401: {"ok":false,"error":"hmac_signature_mismatch"}',
            reason: 'worker_http_401:hmac_signature_mismatch', correlationId: corr,
        }) });
        let res;
        try { res = await session.openDesktop(computerId); } finally { globalThis.fetch = window.fetch = realFetch; }
        assert.equal(res.errorCode, 'unauthorized');
        // Exactly the `apps/desktop#mint` capture in `apps/desktop-window.js`.
        telemetry.capture({ eventClass: 'api_failure', site: 'ezil-os:apps/desktop#mint', code: res.errorCode,
            detail: res.message, reason: res.reason, serverCorrelationId: res.correlationId });
        const data = build_diagnostics();
        diagnosticsSchema.parse(data);
        assert.deepEqual(data.recentEvents.at(-1), { eventClass: 'api_failure', site: 'ezil-os:apps/desktop#mint',
            code: 'unauthorized', reason: 'worker_http_401:hmac_signature_mismatch', correlationId: corr });
        // `detail` (the raw Worker text) stays out of feedback, as before.
        assert.doesNotMatch(JSON.stringify(data.recentEvents), /detail|"error"|\{"ok"/);
        console.log(`EXAMPLE diagnostics.recentEvents tail: ${JSON.stringify(data.recentEvents.slice(-2))}`);
        assert.equal(calls.length, 0, 'no feedback request was sent by building diagnostics');
    });
    await check('FEEDBACK-DIAG: secret-shaped fields never reach the diagnostics; only the newest ten events are annotated', () => {
        for ( const secret of ['https://worker.example.test/?token=SECRET', 'Bearer SECRET', 'a3f9c0d1'.repeat(4)] ) {
            telemetry.capture({ eventClass: 'api_failure', site: 's', code: 'c', reason: secret, serverCorrelationId: secret });
        }
        for ( let i = 0; i < 15; i++ ) {
            telemetry.capture({ eventClass: 'api_failure', site: 's', code: 'c', reason: `worker_http_${500 + i}`, serverCorrelationId: 'srv_0123456789ab' });
        }
        const data = build_diagnostics();
        diagnosticsSchema.parse(data);
        assert.doesNotMatch(JSON.stringify(data), /SECRET|a3f9c0d1a3f9/);
        const annotated = data.recentEvents.filter(event => 'reason' in event || 'correlationId' in event);
        assert.equal(annotated.length, 10);
        assert.equal(annotated.at(-1).reason, 'worker_http_514');
        assert.equal(annotated[0].reason, 'worker_http_505');
    });
    await check('FEEDBACK-DIAG: the worst-case annotated report still fits the 32 KiB no-screenshot body', () => {
        for ( let i = 0; i < 60; i++ ) {
            telemetry.capture({ eventClass: 'e'.repeat(40), site: 's'.repeat(96), code: `c${i}`.padEnd(64, 'x'),
                reason: ['abcdefghijklmno_abcdefghijklmno_abcdefghijklmn', 'bbcdefghijklmno_abcdefghijklmno_abcdefghijklmn'].join(':'),
                serverCorrelationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' });
        }
        const diagnostics = build_diagnostics();
        diagnosticsSchema.parse(diagnostics);
        const body = JSON.stringify({ v: 1, clientRequestId: '44444444-4444-4444-8444-444444444444', category: 'bug',
            description: '\u{20AC}'.repeat(4000), computerId, diagnostics });
        feedbackSubmitSchema.parse(JSON.parse(body));
        assert.ok(new TextEncoder().encode(body).byteLength < 32 * 1024, `${new TextEncoder().encode(body).byteLength} bytes`);
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
    await check('one optional description, default attachments, live preview, no pre-submit request', async () => {
        open();
        assert.equal(modalCalls, 1);
        assert.equal(current().getAttribute('aria-labelledby'), current().querySelector('h2').id);
        assert.equal(form().elements.description.required, false, 'no required question');
        assert.equal(form().elements.description.maxLength, 4000);
        assert.equal(form().elements.category, undefined, 'no category picker');
        assert.equal(current().querySelector('.ezil-feedback-bug'), null, 'no bug questionnaire');
        assert.equal(current().querySelector('select'), null);
        assert.equal(form().elements.diagnostics.checked, true, 'diagnostics selected by default');
        assert.equal(form().elements.screenshot.checked, true, 'screenshot selected by default');
        assert.equal(current().querySelector('[type="submit"]').disabled, false, 'a blank report can be sent');
        assert.equal(payload().category, 'bug');
        assert.equal(payload().description, '');
        assert.ok(payload().diagnostics?.recentEvents, 'the diagnostic snapshot is taken at open');
        diagnosticsSchema.parse(payload().diagnostics);
        assert.equal(payload().screenshot, null, 'capture unavailable: the report carries no image and is not blocked');
        assert.equal(payload().computerId, computerId);
        await until(() => /No screenshot was captured automatically/.test(current().querySelector('[data-role="capture-note"]').textContent));
        assert.equal(current().querySelector('[type="submit"]').disabled, false);
        change('diagnostics', false);
        assert.equal(payload().diagnostics, null, 'the attachment can still be switched off');
        change('screenshot', false);
        change('diagnostics', true);
        change('screenshot', true);
        await tick();
        feedback.open_feedback_dialog({ source: 'chip' });
        assert.equal(modalCalls, 1);
        setDescription('The desktop froze.');
        assert.equal(current().querySelector('#ezil-feedback-counter').textContent, '', 'the character count stays out of the way until it matters');
        setDescription('y'.repeat(3100));
        assert.match(current().querySelector('#ezil-feedback-counter').textContent, /3100 \/ 4000/);
        setDescription('The desktop froze.');
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
    await check('touch primary pointer: the first focus is the heading, never a text field (no keyboard over Send); a fine pointer keeps the description', () => {
        const realMatchMedia = window.matchMedia;
        window.matchMedia = query => ({ matches: query === '(pointer: coarse)', addEventListener () {}, removeEventListener () {} });
        try {
            open();
            const focused = document.activeElement;
            assert.equal(focused.id, 'ezil-feedback-heading');
            assert.ok(current().contains(focused));
            assert.equal(focused.matches('input, textarea, select, [contenteditable]'), false);
            assert.equal(form().elements.description.hasAttribute('autofocus'), false, 'no text field asks for the first focus');
            assert.equal(current().querySelector('#ezil-feedback-heading').hasAttribute('autofocus'), true, 'showModal focuses the heading');
            assert.equal(current().querySelector('[type="submit"]').disabled, false, 'a blank report is sendable from the first screen');
            close();
        } finally { window.matchMedia = realMatchMedia; }
        open();
        assert.equal(document.activeElement.id, 'ezil-feedback-description');
        assert.equal(form().elements.description.hasAttribute('autofocus'), true);
        close();
    });
    await check('a draft saved by the earlier bug form keeps its text; the length limit still holds Send', () => {
        const legacyId = '44444444-4444-4444-8444-444444444444';
        window.localStorage.setItem(draftKey, JSON.stringify({ clientRequestId: legacyId, category: 'idea', description: 'Cannot open the desktop',
            bug: { activity: 'Opening a project', steps: '1. Click Browser', expected: 'Desktop opens', actual: 'Spinner stays', reproducibility: 'Every time', impact: 'Blocked' } }));
        open();
        assert.match(payload().description, /^Summary \/ context\nCannot open the desktop\n\nWhat were you doing\?\nOpening a project/);
        assert.match(payload().description, /Steps to reproduce\n1\. Click Browser/);
        assert.match(payload().description, /Impact\nBlocked$/);
        assert.equal(payload().clientRequestId, legacyId);
        assert.equal(payload().category, 'bug');
        form().elements.description.value = payload().description + '!';
        form().elements.description.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.deepEqual(Object.keys(stored(draftKey)), ['clientRequestId', 'category', 'description'], 'it is saved back as one description');
        form().elements.description.value = 'x'.repeat(4001);
        form().elements.description.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(current().querySelector('[type="submit"]').disabled, true);
        form().elements.description.value = '';
        form().elements.description.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(current().querySelector('[type="submit"]').disabled, false, 'a blank report is sendable');
        close(); window.localStorage.removeItem(draftKey);
    });
    await check('an overlong legacy draft is restored whole (never truncated); Send asks to shorten it', () => {
        window.localStorage.setItem(draftKey, JSON.stringify({ clientRequestId: '55555555-5555-4555-8555-555555555555', category: 'bug',
            description: 'Short summary', bug: { activity: 'a'.repeat(1500), steps: 'b'.repeat(1500), expected: 'c'.repeat(1500), actual: 'd'.repeat(1500), impact: 'TAIL_MARKER' } }));
        open();
        const text = form().elements.description.value;
        assert.ok(text.length > 4000, 'the migrated text is longer than one report may be');
        assert.ok(text.endsWith('Impact\nTAIL_MARKER'), 'the tail of the saved text is not cut');
        assert.equal(payload().description, text);
        assert.equal(current().querySelector('[type="submit"]').disabled, true, 'sending waits for the person to shorten it');
        assert.match(current().querySelector('#ezil-feedback-counter').textContent, /shorten the description/);
        form().elements.description.value = text.slice(-100);
        form().elements.description.dispatchEvent(new window.Event('input', { bubbles: true }));
        assert.equal(current().querySelector('[type="submit"]').disabled, false);
        close(); window.localStorage.removeItem(draftKey);
    });
    await check('default capture: the masked window snapshot is attached without the editor, and a blank report sends with it', async () => {
        defaultCapture = true;
        try {
            const shells = captureCalls.length, editors = editorOptions.length, requests = calls.length;
            open();
            await until(() => ! current().querySelector('.ezil-feedback-image').hidden);
            assert.equal(current().querySelector('pre').textContent, '', 'the large body is rendered only while the preview is open');
            assert.deepEqual(captureCalls.slice(shells), ['shell'], 'only the EZiL window snapshot: no tab or desktop picker, no editor');
            assert.equal(editorOptions.length, editors);
            assert.equal(captureOptions.at(-1).hide, undefined, 'no hide-and-restore step: the snapshot excludes this dialog itself');
            assert.equal(payload().screenshot.contentType, 'image/webp');
            assert.equal(calls.length, requests, 'nothing uploads until Send');
            assert.equal(current().querySelector('[data-role="capture-note"]').textContent, '');
            assert.equal(current().querySelector('[type="submit"]').disabled, false);
            respond = async () => ({ status: 201, ok: true, json: async () => ({ id: reportId, screenshotAccepted: true }) });
            send();
            await until(() => status().includes(reportId));
            const body = JSON.parse(calls.at(-1).body);
            assert.equal(calls.length, requests + 1);
            assert.equal(body.description, '');
            assert.equal(body.category, 'bug');
            assert.ok(body.diagnostics?.recentEvents);
            assert.ok(body.screenshot.dataBase64.length > 0);
            close();
        } finally { defaultCapture = false; }
    });
    await check('a failed, empty, oversized or unencodable default capture never blocks Send', async () => {
        defaultCapture = true;
        const canvas = () => Promise.resolve(document.createElement('canvas'));
        const wide = () => { const c = document.createElement('canvas'); c.width = 5000; c.height = 10; return Promise.resolve(c); };
        const realEncode = encodeResult;
        try {
            for ( const [label, setup] of [
                ['capture rejects', () => { nextCanvas = () => Promise.reject(new Error('capture failed')); }],
                ['no canvas', () => { nextCanvas = () => Promise.resolve(null); }],
                ['unencodable', () => { nextCanvas = canvas; encodeResult = () => null; }],
                ['over the byte limit', () => { nextCanvas = canvas; encodeResult = () => ({ size: 2 * 1024 * 1024, type: 'image/webp' }); }],
                ['over the pixel limit', () => { nextCanvas = wide; }],
            ] ) {
                nextCanvas = canvas; encodeResult = realEncode;
                setup();
                open();
                await until(() => /No screenshot was captured automatically/.test(current().querySelector('[data-role="capture-note"]').textContent));
                assert.equal(current().querySelector('[type="submit"]').disabled, false, label);
                assert.equal(payload().screenshot, null, label);
                const requests = calls.length;
                send();
                await until(() => status().includes(reportId));
                assert.equal(calls.length, requests + 1, label);
                const body = JSON.parse(calls.at(-1).body);
                assert.equal(body.screenshot, null, label);
                assert.equal(body.description, '', `${label}: blank`);
                assert.ok(body.diagnostics, label);
                close();
            }
        } finally { defaultCapture = false; nextCanvas = canvas; encodeResult = realEncode; }
    });
    await check('Send while the default screenshot is still capturing waits briefly; a late capture never changes the frozen body or id', async () => {
        defaultCapture = true;
        const requests = calls.length;
        try {
            // (1) Ready within the wait: it is included, and a repeated Send makes no second request.
            let ready;
            nextCanvas = () => new Promise(resolve => { ready = resolve; });
            open(); setDescription('Sent while capturing');
            send(); send();
            assert.equal(calls.length, requests, 'waiting for the screenshot');
            assert.equal(current().querySelector('[type="submit"]').disabled, true);
            assert.match(current().querySelector('[data-role="capture-note"]').textContent, /Finishing the screenshot/);
            ready(document.createElement('canvas'));
            await until(() => status().includes(reportId));
            assert.equal(calls.length, requests + 1, 'one report');
            assert.ok(JSON.parse(calls.at(-1).body).screenshot, 'the screenshot that finished in time is included');
            close();
            // (2) Not ready within the wait: sent without it; the late capture cannot alter the body, and a retry is byte-identical.
            respond = async () => { throw new TypeError('Failed to fetch'); };
            let late;
            nextCanvas = () => new Promise(resolve => { late = resolve; });
            open(); setDescription('Capture never finishes');
            const sentBefore = calls.length;
            send();
            await new Promise(resolve => setTimeout(resolve, feedback.AUTO_CAPTURE_WAIT_MS + 300));
            await until(() => calls.length === sentBefore + 1 && ! current().querySelector('[type="submit"]').disabled);
            const first = JSON.parse(calls.at(-1).body);
            assert.equal(first.screenshot, null);
            assert.equal(stored(outboxKey).filter(entry => entry.clientRequestId === first.clientRequestId).length, 1, 'kept for retry');
            late(document.createElement('canvas')); await tick(); await tick();
            assert.equal(current().querySelector('.ezil-feedback-image').hidden, true, 'a late capture is discarded');
            send(); await until(() => calls.length === sentBefore + 2);
            assert.equal(calls.at(-1).body, calls.at(-2).body, 'the retry is the same request, byte for byte');
            assert.equal(JSON.parse(calls.at(-1).body).clientRequestId, first.clientRequestId);
            respond = async () => ({ status: 201, ok: true, json: async () => ({ id: reportId, screenshotAccepted: true }) });
            await until(() => ! current().querySelector('[type="submit"]').disabled);
            send(); await until(() => status().includes(reportId));
            assert.equal(calls.at(-1).body, calls.at(-2).body);
            close();
        } finally { defaultCapture = false; nextCanvas = () => Promise.resolve(document.createElement('canvas')); }
    });
    await check('legacy queued idea and other reports preserve their exact bytes and id until a real edit', async () => {
        const realRespond = respond;
        try {
            respond = async () => { throw new TypeError('Failed to fetch'); };
            for (const category of ['idea', 'other']) {
                const id = crypto.randomUUID(), text = `Older ${category} report`;
                // Older bodies can use a different JSON layout: replay preserves wire bytes, not just parsed values.
                const body = JSON.stringify({ v: 1, clientRequestId: id, category, description: text,
                    computerId, diagnostics: null, screenshot: null });
                window.localStorage.setItem(draftKey, JSON.stringify({ clientRequestId: id, category, description: text }));
                window.localStorage.setItem(outboxKey, JSON.stringify([{ clientRequestId: id, body }]));
                setOnline(false); open();
                assert.equal(payload().category, category);
                assert.equal(payload().clientRequestId, id);
                assert.equal(current().querySelector('pre').textContent, body, 'the preview is the original frozen wire body');
                setOnline(true);
                const count = calls.length; send();
                await until(() => calls.length === count + 1 && !current().querySelector('[type="submit"]').disabled);
                assert.equal(calls.at(-1).body, body);
                assert.deepEqual(stored(outboxKey).map(entry => entry.clientRequestId), [id], 'no second queued request is created');
                setDescription(`Edited ${category} report`);
                assert.notEqual(payload().clientRequestId, id, 'a real edit safely forks the request');
                assert.equal(stored(outboxKey)[0].body, body, 'the original pending request stays frozen');
                close(); window.localStorage.removeItem(outboxKey); window.localStorage.removeItem(draftKey);
            }
        } finally { respond = realRespond; setOnline(true); window.localStorage.removeItem(outboxKey); window.localStorage.removeItem(draftKey); }
    });
    await check('a restored old-category report keeps its id through automatic diagnostic downgrade and retry', async () => {
        const realRespond = respond;
        try {
            for (const category of ['idea', 'other']) {
                const id = crypto.randomUUID(), text = `Queued ${category} diagnostics`;
                const diagnostics = { deviceClass: 'desktop', fullscreen: false, fullbleed: false,
                    recentEvents: [{ eventClass: 'api_failure', site: 's', code: 'unauthorized',
                        reason: 'worker_http_401:hmac_signature_mismatch', correlationId: 'srv_0123456789ab' }] };
                const body = JSON.stringify({ v: 1, clientRequestId: id, category, description: text,
                    computerId, diagnostics, screenshot: null });
                window.localStorage.setItem(draftKey, JSON.stringify({ clientRequestId: id, category, description: text }));
                window.localStorage.setItem(outboxKey, JSON.stringify([{ clientRequestId: id, body }]));
                respond = async (_url, options) => {
                    if (JSON.parse(options.body).diagnostics.recentEvents.some(e => 'reason' in e || 'correlationId' in e)) return { status: 400 };
                    throw new TypeError('Failed to fetch');
                };
                setOnline(false); open(); setOnline(true);
                const count = calls.length; send();
                await until(() => calls.length === count + 2 && !current().querySelector('[type="submit"]').disabled);
                const lean = calls.at(-1).body;
                assert.equal(calls[count].body, body);
                assert.equal(JSON.parse(lean).category, category);
                assert.equal(payload().category, category);
                assert.equal(payload().clientRequestId, id);
                assert.equal(current().querySelector('pre').textContent, lean);
                assert.equal(stored(outboxKey)[0].body, lean);
                assert.deepEqual(stored(outboxKey).map(entry => entry.clientRequestId), [id]);
                send(); await until(() => calls.length === count + 3 && !current().querySelector('[type="submit"]').disabled);
                assert.equal(calls.at(-1).body, lean, 'a later retry keeps the same downgraded bytes');
                close(); window.localStorage.removeItem(outboxKey); window.localStorage.removeItem(draftKey);
            }
        } finally { respond = realRespond; setOnline(true); window.localStorage.removeItem(outboxKey); window.localStorage.removeItem(draftKey); }
    });
    await check('an old structured draft shows the queued request text rather than a new formatting of its fields', () => {
        const id = crypto.randomUUID(), description = 'Original summary';
        const bug = { activity: 'Opening a project', steps: 'Click the icon', expected: 'An editor',
            actual: 'A spinner', reproducibility: 'Every time', impact: 'Blocked' };
        const text = [['Summary / context', description], ['What were you doing?', bug.activity],
            ['Steps to reproduce', bug.steps], ['Expected result', bug.expected], ['Actual result', bug.actual],
            ['Reproducibility', bug.reproducibility], ['Impact', bug.impact]].map(([label, value]) => `${label}\n${value}`).join('\n\n');
        const body = JSON.stringify({ v: 1, clientRequestId: id, category: 'bug', description: text,
            computerId, diagnostics: null, screenshot: null });
        window.localStorage.setItem(draftKey, JSON.stringify({ clientRequestId: id, category: 'bug', description, bug }));
        window.localStorage.setItem(outboxKey, JSON.stringify([{ clientRequestId: id, body }]));
        try {
            setOnline(false); open();
            assert.equal(form().elements.description.value, text);
            assert.equal(payload().description, text);
            assert.equal(payload().clientRequestId, id);
            assert.equal(current().querySelector('pre').textContent, body);
            close();
        } finally { setOnline(true); window.localStorage.removeItem(outboxKey); window.localStorage.removeItem(draftKey); }
    });
    await check('reopening after a send that got no answer resumes that same request byte for byte (text or blank), never a second report', async () => {
        defaultCapture = true;
        const realRespond = respond;
        try {
            respond = async () => { throw new TypeError('Failed to fetch'); };
            for ( const text of ['Reopen me', ''] ) {
                window.localStorage.removeItem(draftKey);
                open();
                if ( text ) setDescription(text);
                await until(() => ! current().querySelector('.ezil-feedback-image').hidden);
                const requests = calls.length;
                send();
                await until(() => calls.length === requests + 1 && ! current().querySelector('[type="submit"]').disabled);
                const first = calls.at(-1).body;
                const id = JSON.parse(first).clientRequestId;
                assert.ok(JSON.parse(first).screenshot && JSON.parse(first).diagnostics, 'default attachments were sent');
                close();
                // A new event in the ring would change a fresh snapshot: the resumed request must keep the queued one.
                telemetry.capture({ eventClass: 'api_failure', site: 's', code: `between_opens_${text.length}` });
                const shells = captureCalls.length;
                // Reopened later: another computer is current, and (blank case) from an error screen with a code to prefill.
                const originalComputer = JSON.parse(first).computerId;
                setCurrentComputer({ id: '66666666-6666-4666-8666-666666666666' });
                if ( text ) open();
                else { document.querySelector('#opener').focus(); feedback.open_feedback_dialog({ source: 'opening', errorCode: 'billing_files_on_aws' }); }
                assert.equal(payload().clientRequestId, id, `${text || 'blank'}: the same request id`);
                assert.equal(payload().computerId, originalComputer, 'the queued request keeps the computer it was sent for');
                assert.equal(form().elements.description.value, text, 'no new prefill on a resumed request');
                assert.equal(current().querySelector('pre').textContent, first, 'the preview is the queued body');
                assert.equal(captureCalls.length, shells, 'no new capture for a request that is already queued');
                assert.equal(current().querySelector('.ezil-feedback-image').hidden, false, 'the queued screenshot is shown');
                send();
                await until(() => calls.length === requests + 2 && ! current().querySelector('[type="submit"]').disabled);
                assert.equal(calls.at(-1).body, first, 'the re-send is byte-identical');
                close();
                setCurrentComputer({ id: originalComputer });
                window.localStorage.removeItem(outboxKey);
                window.localStorage.removeItem(draftKey);
            }
        } finally { defaultCapture = false; respond = realRespond; }
    });
    await check('switching the screenshot off aborts the default capture, switching it on starts one, and a manual capture replaces it', async () => {
        defaultCapture = true;
        try {
            nextCanvas = () => new Promise(() => {});
            const shells = captureCalls.length;
            open();
            const first = captureOptions.at(-1).signal;
            assert.equal(captureCalls.length, shells + 1);
            change('screenshot', false);
            assert.equal(first.aborted, true);
            assert.equal(payload().screenshot, null);
            change('screenshot', true);
            assert.equal(captureCalls.length, shells + 2, 'selecting it again captures again');
            const second = captureOptions.at(-1).signal;
            current().querySelector('[data-capture="shell"]').click();
            assert.equal(second.aborted, true, 'a manual capture takes over from the default one');
            close();
            assert.equal(captureOptions.at(-1).signal.aborted, true, 'closing the form aborts the capture');
        } finally { defaultCapture = false; nextCanvas = () => Promise.resolve(document.createElement('canvas')); }
    });
    await check('failure references require the upstream capability and remain bounded', () => {
        // The merged fixture advertises feedbackEventDiagnostics; this case drives the flag itself (absent for
        // the negative, true for the positive) and restores the prior value so later cases are unaffected.
        const priorDiag = window.__EZIL_BOOT__.desktopState.ui.feedbackEventDiagnostics;
        delete window.__EZIL_BOOT__.desktopState.ui.feedbackEventDiagnostics;
        try {
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
        } finally {
            if (priorDiag === undefined) delete window.__EZIL_BOOT__.desktopState.ui.feedbackEventDiagnostics;
            else window.__EZIL_BOOT__.desktopState.ui.feedbackEventDiagnostics = priorDiag;
        }
    });
    await check('the reporter is told about the server-added context, and the client preview stays client-only', () => {
        open();
        // A short notice is always visible; the full text sits in the collapsed diagnostics details.
        const consentNote = current().querySelector('[data-role="server-context-note"]').textContent;
        assert.match(consentNote, /With diagnostics on/);
        assert.match(consentNote, /not shown in the preview/);
        assert.ok(consentNote.length < 200, 'the always-visible notice is succinct');
        const detail = current().querySelector('.ezil-feedback-details [data-role="server-context-detail"]').textContent;
        assert.match(detail, /after you press Send, so it is not in the preview/);
        assert.match(detail, /never addresses, IDs or anyone else's data/);
        assert.equal(current().querySelector('.ezil-feedback-details').open, false, 'details start collapsed');
        assert.match(current().querySelector('[data-role="server-context-preview-note"]').textContent, /does not appear here/);
        change('diagnostics', true);
        assert.doesNotMatch(JSON.stringify(payload()), /serverContext/);
        close();
    });
    await check('the server-context notice stays visible with diagnostics on or off; on is the default and unchecking it sends no diagnostics', async () => {
        const visible = el => { for ( let n = el; n && n !== document; n = n.parentElement ) { const s = window.getComputedStyle(n); if ( n.hidden || s.display === 'none' || s.visibility === 'hidden' ) return false; } return true; };
        open();
        const note = () => current().querySelector('[data-role="server-context-note"]');
        assert.equal(form().elements.diagnostics.checked, true, 'selected by default');
        assert.equal(visible(note()), true, 'the notice is shown with diagnostics on');
        change('diagnostics', false);
        assert.equal(visible(note()), true, 'the notice does not depend on the checkbox');
        assert.equal(payload().diagnostics, null, 'opt-out: no diagnostics in the body, so the server adds no context (it only does so for a report carrying diagnostics)');
        const requests = calls.length;
        await tick();
        send();
        await until(() => calls.length === requests + 1);
        assert.equal(JSON.parse(calls.at(-1).body).diagnostics, null, 'the sent report carries no diagnostics');
        await until(() => status().includes(reportId));
        close();
    });
    await check('compact and honest: capture scope caption, one context line from observed facts, details collapsed', async () => {
        defaultCapture = true;
        try {
            setCurrentComputer({ id: computerId, name: 'Work PC' });
            open();
            const scope = () => current().querySelector('[data-role="capture-scope-text"]').textContent;
            assert.match(scope(), /No screenshot attached\. Embedded apps are never captured automatically/);
            await until(() => ! current().querySelector('.ezil-feedback-image').hidden);
            assert.match(scope(), /Embedded app not captured/);
            assert.match(scope(), /EZiL OS window only/);
            assert.ok(current().querySelector('[data-role="capture-scope"] [data-capture="tab"]'), 'one optional "Capture what I see" next to the caption');
            // Short text only in the open form; the long explanations are inside collapsed details.
            for ( const p of current().querySelectorAll('.ezil-feedback-fields > p.ezil-feedback-muted') ) assert.ok(p.textContent.length < 220, `succinct: ${p.textContent.slice(0, 40)}`);
            assert.equal(current().querySelector('.ezil-feedback-details').open, false);
            // One line of observed facts only; never steps, expected or actual.
            const line = () => current().querySelector('[data-role="context-line"]');
            assert.equal(line().hidden, false);
            assert.match(line().textContent, /^Noticed: .*computer “Work PC”/);
            assert.doesNotMatch(line().textContent, /steps|expected|actual|reproduc/i);
            change('diagnostics', false);
            assert.doesNotMatch(line().textContent, /app /, 'diagnostics-derived facts go away with the checkbox');
            change('diagnostics', true);
            // A manual capture names its own source; removing leaves an honest empty state.
            current().querySelector('[data-capture="tab"]').click();
            await until(() => /browser surface you chose/.test(scope()));
            assert.doesNotMatch(scope(), /EZiL OS window only/);
            current().querySelector('[data-action="remove-screenshot"]').click();
            assert.match(scope(), /No screenshot attached/);
            close();
        } finally { defaultCapture = false; setCurrentComputer({ id: computerId }); }
    });
    await check('expanded diagnostics are consented, frozen, refreshed and downgraded on a strict old server', async () => {
        window.__EZIL_BOOT__.desktopState.ui.feedbackReportBundle = true;
        open(); setDescription('Snapshot test');
        assert.ok(payload().diagnostics, 'selected by default: the snapshot is taken when the form opens');
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
    // FEEDBACK-DIAG rollback safety. A server from before these keys parses each
    // `recentEvents[]` entry as `{eventClass, site, code}.strict()`: emulated exactly.
    const rollbackPreview = () => { showPreview(); return current().querySelector('pre').textContent; };
    const oldServerAccepts = body => (JSON.parse(body).diagnostics?.recentEvents ?? [])
        .every(event => Object.keys(event).every(key => ['eventClass', 'site', 'code'].includes(key)));
    const oldServer = async (url, options) => oldServerAccepts(options.body)
        ? { status: 201, json: async () => ({ id: reportId, screenshotAccepted: false }) } : { status: 400 };
    const hmacFailure = { eventClass: 'api_failure', site: 'ezil-os:apps/desktop#mint', code: 'unauthorized' };
    const recordHmacFailure = () => telemetry.capture({ ...hmacFailure,
        reason: 'worker_http_401:hmac_signature_mismatch', serverCorrelationId: 'srv_0123456789ab' });
    const posts = from => calls.slice(from).filter(c => c.method === 'POST');
    await check('FEEDBACK-DIAG: new shell + old server (no ui.feedbackEventDiagnostics): no reason/correlationId in preview or body', async () => {
        delete window.__EZIL_BOOT__.desktopState.ui.feedbackEventDiagnostics;
        try {
            recordHmacFailure();
            assert.deepEqual(build_diagnostics().recentEvents.at(-1), hmacFailure);
            open(); setDescription('Old server report'); change('diagnostics', true);
            assert.ok(oldServerAccepts(rollbackPreview()), 'the preview carries neither key');
            respond = oldServer;
            const count = calls.length;
            send(); await until(() => status().includes(reportId));
            assert.equal(posts(count).length, 1, 'accepted first time: no 400, no second request');
            assert.ok(oldServerAccepts(posts(count)[0].body));
            assert.deepEqual(JSON.parse(posts(count)[0].body).diagnostics.recentEvents.at(-1), hmacFailure, 'the event itself is still sent');
            close();
        } finally {
            window.__EZIL_BOOT__.desktopState.ui.feedbackEventDiagnostics = true;
        }
    });
    await check('FEEDBACK-DIAG: new shell + new server (ui.feedbackEventDiagnostics): {code, reason, correlationId} in preview and body', async () => {
        recordHmacFailure();
        open(); setDescription('New server report'); change('diagnostics', true);
        const before = rollbackPreview();
        respond = async () => ({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: false }) });
        const count = calls.length;
        send(); await until(() => status().includes(reportId));
        assert.equal(posts(count).length, 1);
        assert.equal(posts(count)[0].body, before);
        assert.deepEqual(JSON.parse(before).diagnostics.recentEvents.at(-1), { ...hmacFailure,
            reason: 'worker_http_401:hmac_signature_mismatch', correlationId: 'srv_0123456789ab' });
        close();
    });
    await check('FEEDBACK-DIAG: server rolled back under a tab that still advertises the keys: one lean re-send, report kept', async () => {
        recordHmacFailure();
        open(); setDescription('Rolled back report'); change('diagnostics', true);
        const before = rollbackPreview();
        assert.equal(oldServerAccepts(before), false, 'the stale payload still says the keys are accepted');
        respond = oldServer;
        let count = calls.length;
        flushing = true; // the lean re-send is, by design, not the preview
        send(); await until(() => status().includes(reportId));
        flushing = false;
        assert.equal(posts(count).length, 2);
        assert.equal(posts(count)[0].body, before);
        const [sent, lean] = posts(count).map(c => JSON.parse(c.body));
        for ( const event of sent.diagnostics.recentEvents ) { delete event.reason; delete event.correlationId; }
        assert.deepEqual(lean, sent, 'only the two keys were removed');
        assert.equal(stored(outboxKey), null); assert.equal(stored(draftKey), null);
        close();
        // A report the new shell queued offline and replays after the rollback.
        const queuedId = crypto.randomUUID();
        window.localStorage.setItem(outboxKey, JSON.stringify([{ clientRequestId: queuedId,
            body: JSON.stringify({ ...JSON.parse(before), clientRequestId: queuedId }, null, 2) }]));
        count = calls.length;
        flushing = true;
        await feedback.flush_feedback_outbox();
        flushing = false;
        assert.deepEqual(posts(count).map(c => oldServerAccepts(c.body)), [false, true]);
        assert.equal(stored(outboxKey), null, 'delivered, not dropped');
        // A 400 the keys did not cause is still final: no third request, text back in the draft.
        open(); setDescription('Refused for another reason'); change('diagnostics', true);
        respond = async () => ({ status: 400 });
        count = calls.length;
        flushing = true;
        send(); await until(() => ! current().querySelector('[type="submit"]').disabled);
        flushing = false;
        assert.equal(posts(count).length, 2);
        assert.match(status(), /could not be accepted/);
        close();
        assert.equal(stored(draftKey).description, 'Refused for another reason');
        open(); setDescription(''); close();
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
        open(); setDescription('Half-written report'); change('diagnostics', false);
        const id = payload().clientRequestId;
        close();
        open();
        assert.equal(form().elements.description.value, 'Half-written report');
        assert.equal(payload().category, 'bug');
        assert.equal(payload().clientRequestId, id);
        assert.equal(form().elements.diagnostics.checked, true, 'attachment choices are never remembered: each form starts from the defaults');
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
    await check('the opening screen error code is an observed fact outside the comment box: shown, sent as one final line, never duplicated, bounded and redacted', async () => {
        const openWith = errorCode => { document.querySelector('#opener').focus(); feedback.open_feedback_dialog({ source: 'opening', errorCode }); };
        const line = () => current().querySelector('[data-role="context-line"]');
        window.localStorage.removeItem(draftKey);
        openWith('billing_files_on_aws');
        assert.equal(form().elements.description.value, '', 'the optional comment stays empty');
        assert.match(line().textContent, /error code billing_files_on_aws/);
        assert.equal(payload().description, 'Error code: billing_files_on_aws', 'a blank comment still sends the code');
        assert.equal(current().querySelector('[type="submit"]').disabled, false);
        setDescription('Code would not open after I cancelled');
        assert.equal(payload().description, 'Code would not open after I cancelled\n\nError code: billing_files_on_aws');
        assert.equal(stored(draftKey).description, 'Code would not open after I cancelled', 'the draft keeps only the comment');
        close();
        // An older draft that already holds the line is not duplicated.
        window.localStorage.setItem(draftKey, JSON.stringify({ clientRequestId: '77777777-7777-4777-8777-777777777777', category: 'bug',
            description: 'Old note\n\nError code: billing_files_on_aws' }));
        openWith('billing_files_on_aws');
        assert.equal((payload().description.match(/Error code: billing_files_on_aws/g) ?? []).length, 1, 'once');
        close(); window.localStorage.removeItem(draftKey);
        // Invalid or secret-looking codes are neither shown nor sent.
        for ( const bad of ['not a code!', 'sk-proj-abc123', 'x'.repeat(65), 7, null, undefined] ) {
            openWith(bad);
            assert.doesNotMatch(line().textContent, /error code/, String(bad));
            assert.doesNotMatch(payload().description, /Error code/, `${String(bad)}: not sent`);
            close();
        }
        // The line counts toward the 4,000 limit, so a near-full comment cannot push the report over it silently.
        openWith('billing_payment_issue');
        setDescription('x'.repeat(3995));
        assert.equal(current().querySelector('[type="submit"]').disabled, true);
        assert.match(current().querySelector('#ezil-feedback-counter').textContent, /shorten the description/);
        setDescription(''); close();
        window.localStorage.removeItem(draftKey);
    });
    await check('a queued report that carried an error code reopens as the same request even from an opener without one', async () => {
        const realRespond = respond;
        try {
            respond = async () => { throw new TypeError('Failed to fetch'); };
            window.localStorage.removeItem(draftKey);
            document.querySelector('#opener').focus();
            feedback.open_feedback_dialog({ source: 'opening', errorCode: 'billing_files_on_aws' });
            setDescription('Queued with a code');
            await tick();
            const requests = calls.length;
            send();
            await until(() => calls.length === requests + 1 && ! current().querySelector('[type="submit"]').disabled);
            const first = calls.at(-1).body;
            assert.match(JSON.parse(first).description, /Queued with a code\n\nError code: billing_files_on_aws$/);
            close();
            open();
            assert.equal(JSON.stringify(payload(), null, 2), first, 'the same body: the queued request keeps its error line');
            assert.equal(form().elements.description.value, 'Queued with a code', 'the comment box holds only the comment');
            close();
        } finally {
            respond = realRespond;
            window.localStorage.removeItem(outboxKey);
            window.localStorage.removeItem(draftKey);
        }
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
        await tick(); // the default screenshot (unavailable here) has settled
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
    // ── Several images (server advertises `ui.feedbackScreenshotsMax`) ──────────────────────────────
    const ui = window.__EZIL_BOOT__.desktopState.ui;
    let distinct = 0;
    /** Each editor result is a different valid PNG (the width byte differs), like distinct screenshots. */
    const distinctResult = () => {
        const bytes = Buffer.from(imageBytes); bytes.writeUInt32BE(++distinct + 1, 16);
        return { blob: new window.Blob([bytes], { type: 'image/png' }), contentType: 'image/png', width: 1, height: 1 };
    };
    const png = name => new window.File([imageBytes], name, { type: 'image/png' });
    const paste = (target, files, text = null) => {
        const event = new window.Event('paste', { bubbles: true, cancelable: true });
        const items = files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file }));
        if ( text !== null ) items.push({ kind: 'string', type: 'text/plain', getAsFile: () => null });
        Object.defineProperty(event, 'clipboardData', { value: { items } });
        target.dispatchEvent(event);
        return event;
    };
    const rows = () => [...current().querySelectorAll('[data-role="images"] > li')];
    const multi = async run => {
        const realEditor = editorResult;
        ui.feedbackScreenshotsMax = 5; editorResult = distinctResult;
        try { await run(); } finally { delete ui.feedbackScreenshotsMax; editorResult = realEditor; if ( current() ) close(); }
    };

    await check('paste: an image pasted into the description goes through the editor and joins the report; text pastes are untouched; nothing uploads', async () => {
        await multi(async () => {
            open(); setDescription('Pasted screenshots');
            const requests = calls.length, editors = editorOptions.length;
            const textPaste = paste(form().elements.description, [], 'plain words');
            assert.equal(textPaste.defaultPrevented, false, 'a text paste stays a normal paste');
            const imagePaste = paste(form().elements.description, [png('one.png')]);
            assert.equal(imagePaste.defaultPrevented, true);
            await until(() => rows().length === 1 && ! current().querySelector('[type="submit"]').disabled);
            assert.ok(captureCalls.includes('upload:one.png'));
            assert.equal(editorOptions.length, editors + 1, 'the pasted image opened in the editor');
            assert.equal(current().querySelector('[data-role="capture-scope-text"]').textContent, 'Pasted from your clipboard.');
            assert.equal(calls.length, requests, 'pasting uploads nothing');
            assert.ok(payload().screenshot, 'one image keeps the single-image key');
            assert.equal(payload().screenshots, undefined);
        });
    });

    await check('several images: pasted, attached and captured images are listed, previewed and sent in order as `screenshots`, only on Send', async () => {
        await multi(async () => {
            open(); setDescription('Three images');
            const requests = calls.length;
            paste(current(), [png('a.png'), png('b.png')]);
            await until(() => rows().length === 2 && ! current().querySelector('[type="submit"]').disabled);
            current().querySelector('[data-capture="tab"]').click();
            await until(() => rows().length === 3 && ! current().querySelector('[type="submit"]').disabled);
            assert.deepEqual(rows().map(row => row.querySelector('span').textContent.replace(/ · .*/, '')), ['1. Pasted', '2. Pasted', '3. Screen capture']);
            assert.match(current().querySelector('[data-role="images-heading"]').textContent, /3 of 5 images/);
            const body = payload();
            assert.equal(body.screenshot, null);
            assert.equal(body.screenshots.length, 3);
            assert.equal(new Set(body.screenshots.map(image => image.dataBase64)).size, 3);
            feedbackSubmitSchema.parse(body);
            // Draft saves and preview toggles never upload, and the draft never holds an image.
            setDescription('Three images, edited'); showPreview();
            assert.equal(calls.length, requests);
            assert.doesNotMatch(window.localStorage.getItem(draftKey) ?? '', /dataBase64|base64/);
            const before = current().querySelector('pre').textContent;
            respond = async () => ({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: true, screenshotCount: 3 }) });
            send(); await until(() => status().includes(reportId));
            assert.equal(calls.length, requests + 1, 'one request, on Send');
            assert.equal(calls.at(-1).body, before, 'the request is the previewed body');
        });
    });

    await check('per image: edit replaces that image in place, remove drops only that one, and limits are enforced before the editor', async () => {
        await multi(async () => {
            open();
            paste(current(), [png('a.png'), png('b.png'), png('c.png')]);
            await until(() => rows().length === 3 && ! current().querySelector('[type="submit"]').disabled);
            const [first, second, third] = payload().screenshots.map(image => image.dataBase64);
            // The editor's limit is what the report total leaves after the other images, never above 1.5 MiB.
            assert.equal(editorOptions.at(-1).limit, Math.floor(1.5 * 1024 * 1024));
            const img = rows()[1].querySelector('img');
            Object.defineProperties(img, { naturalWidth: { value: 1 }, naturalHeight: { value: 1 } });
            const realContext = window.HTMLCanvasElement.prototype.getContext;
            window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage () {} });
            try {
                rows()[1].querySelector('[data-capture="edit"]').click();
                await until(() => ! current().querySelector('[type="submit"]').disabled && payload().screenshots[1].dataBase64 !== second);
            } finally { window.HTMLCanvasElement.prototype.getContext = realContext; }
            const edited = payload().screenshots.map(image => image.dataBase64);
            assert.equal(edited.length, 3);
            assert.equal(edited[0], first); assert.equal(edited[2], third);
            assert.match(rows()[1].textContent, /Pasted/, 'an edit keeps where the image came from');
            rows()[0].querySelector('[data-action="remove-screenshot"]').click();
            assert.deepEqual(payload().screenshots.map(image => image.dataBase64), [edited[1], third]);
            // Fill to the count limit: add controls are disabled, and a further paste never reaches the editor.
            paste(current(), [png('d.png'), png('e.png'), png('f.png'), png('g.png')]);
            await until(() => rows().length === 5 && ! current().querySelector('[type="submit"]').disabled);
            assert.equal(current().querySelector('[data-capture="tab"]').disabled, true);
            assert.equal(form().elements.screenshotFile.disabled, true);
            const editors = editorOptions.length;
            paste(current(), [png('h.png')]);
            await tick(); await tick();
            assert.equal(editorOptions.length, editors);
            assert.match(current().querySelector('[data-role="capture-note"]').textContent, /already has 5 screenshots/);
            feedbackSubmitSchema.parse(payload());
        });
    });

    await check('the same screenshot twice is refused locally with a note (the server would 400 the whole report); an edit into a duplicate keeps the prior image', async () => {
        await multi(async () => {
            open();
            const requests = calls.length;
            const same = () => ({ blob: new window.Blob([imageBytes], { type: 'image/png' }), contentType: 'image/png', width: 1, height: 1 });
            editorResult = same;
            paste(current(), [png('first.png')]);
            await until(() => rows().length === 1 && ! current().querySelector('[type="submit"]').disabled);
            paste(current(), [png('again.png')]);
            await until(() => captureCalls.includes('upload:again.png') && ! current().querySelector('[type="submit"]').disabled);
            assert.equal(rows().length, 1, 'a repeated paste does not add a row');
            assert.equal(current().querySelector('[data-role="capture-note"]').textContent, 'This screenshot is already attached.');
            // A second, different image; then editing it into a copy of the first keeps it as it was.
            editorResult = distinctResult;
            paste(current(), [png('other.png')]);
            await until(() => rows().length === 2 && ! current().querySelector('[type="submit"]').disabled);
            const before = payload().screenshots.map(image => image.dataBase64);
            editorResult = same;
            const img = rows()[1].querySelector('img');
            Object.defineProperties(img, { naturalWidth: { value: 1 }, naturalHeight: { value: 1 } });
            const realContext = window.HTMLCanvasElement.prototype.getContext;
            window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage () {} });
            const editors = editorOptions.length;
            try {
                rows()[1].querySelector('[data-capture="edit"]').click();
                await until(() => editorOptions.length > editors && ! current().querySelector('[type="submit"]').disabled);
            } finally { window.HTMLCanvasElement.prototype.getContext = realContext; }
            assert.deepEqual(payload().screenshots.map(image => image.dataBase64), before, 'both images and their order are unchanged');
            assert.match(current().querySelector('[data-role="capture-note"]').textContent, /already attached/);
            assert.equal(calls.length, requests, 'nothing uploaded');
            respond = async () => ({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: true, screenshotCount: 2 }) });
            send(); await until(() => status().includes(reportId));
            const sent = JSON.parse(calls.at(-1).body).screenshots.map(image => image.dataBase64);
            assert.equal(new Set(sent).size, sent.length, 'the report carries no duplicate, so the server has no reason to refuse it');
        });
    });

    await check('several images: the byte budget is shared, and turning screenshots off sends no image key at all', async () => {
        await multi(async () => {
            open();
            const big = Math.floor(1.2 * 1024 * 1024);
            const realEditor = editorResult;
            editorResult = () => ({ blob: new window.Blob([Buffer.alloc(big, 7)], { type: 'image/png' }), contentType: 'image/png', width: 1, height: 1 });
            try {
                paste(current(), [png('big.png')]);
                await until(() => rows().length === 1 && ! current().querySelector('[type="submit"]').disabled);
                paste(current(), [png('next.png')]);
                await until(() => editorOptions.at(-1).limit < big && ! current().querySelector('[type="submit"]').disabled);
                assert.equal(editorOptions.at(-1).limit, Math.floor(1.75 * 1024 * 1024) - big, 'the second image may use only what is left');
                assert.equal(rows().length, 1, 'an image over what is left is refused, not attached');
                assert.match(status(), /too large/);
            } finally { editorResult = realEditor; }
            change('screenshot', false);
            const body = payload();
            assert.equal(body.screenshot, null);
            assert.equal('screenshots' in body, false, 'consent off: no image list');
            assert.equal(rows().length, 0);
        });
    });

    await check('a multi-image report queued offline reopens and re-sends byte for byte', async () => {
        await multi(async () => {
            window.localStorage.removeItem(draftKey); window.localStorage.removeItem(outboxKey);
            open(); setDescription('Queued images');
            paste(current(), [png('a.png'), png('b.png')]);
            await until(() => rows().length === 2 && ! current().querySelector('[type="submit"]').disabled);
            respond = async () => { throw new TypeError('Failed to fetch'); };
            const requests = calls.length;
            send(); await until(() => calls.length === requests + 1 && ! current().querySelector('[type="submit"]').disabled);
            const first = calls.at(-1).body;
            close();
            open();
            assert.equal(current().querySelector('pre').textContent || (showPreview(), current().querySelector('pre').textContent), first);
            assert.equal(rows().length, 2);
            assert.match(rows()[0].textContent, /Queued with this report/);
            respond = async () => ({ status: 201, json: async () => ({ id: reportId, screenshotAccepted: false, screenshotCount: 0 }) });
            send(); await until(() => status().includes(reportId));
            assert.equal(calls.at(-1).body, first, 'the re-send is byte-identical');
            assert.match(status(), /Your images weren't stored/, 'a budget refusal is said plainly');
            window.localStorage.removeItem(outboxKey); window.localStorage.removeItem(draftKey);
        });
    });

    await check('an embedded app in the window snapshot: the image is attached (overlays survive) with one note offering a real capture', async () => {
        defaultCapture = true; snapshotCoverage = 0.8;
        try {
            open();
            await until(() => ! current().querySelector('.ezil-feedback-image').hidden);
            assert.match(current().querySelector('[data-role="capture-note"]').textContent, /^To include the open app, use "Capture what I see"/);
            assert.match(current().querySelector('[data-role="capture-scope-text"]').textContent, /Embedded app not captured/, 'the limitation is stated once, beside the image');
            assert.ok(payload().screenshot, 'the snapshot is still attached');
            close();
            snapshotCoverage = 0.05;
            open();
            await until(() => ! current().querySelector('.ezil-feedback-image').hidden);
            assert.equal(current().querySelector('[data-role="capture-note"]').textContent, '', 'no note when the app covers little');
            close();
        } finally { defaultCapture = false; snapshotCoverage = 0; }
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
            // A list whose headers never arrive fails the same readable way.
            respond = stall;
            const headless = feedback.list_my_reports();
            await until(() => timers.length === 3);
            timers[2].fn();
            assert.match(String((await settled(headless)).error?.message), /Could not load your reports/, '🔴 a stall before headers is readable too');
            respond = async () => ({ status: 200, ok: true, json: async () => null });
            await assert.rejects(feedback.list_my_reports(), /Could not load your reports/, '🔴 a null body is a readable failure');
            const reports = [{ id: reportId, category: 'bug', createdAt: '2026-10-15', descriptionPreview: 'Desktop froze', hasScreenshot: false, status: 'new' }];
            respond = async () => ({ status: 200, ok: true, json: async () => ({ reports }) });
            assert.deepEqual(await feedback.list_my_reports(), reports);
            assert.equal(timers.at(-1).cleared, true, '🔴 a successful list clears its deadline');
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
    await check('only the newest report load may write, and a failed delete keeps one truthful message', async () => {
        window.__EZIL_BOOT__.desktopState.endpoints.feedback = '/api/shell/feedback';
        const { default: troubleshoot } = await import('../Settings/tabs/troubleshoot.js');
        const { default: feedbackTab } = await import('../Settings/tabs/feedback.js');
        const reports = [{ id: reportId, category: 'bug', createdAt: '2026-10-15', descriptionPreview: 'Desktop froze', hasScreenshot: false, status: 'new' }];
        // Each GET waits on its own gate, so the test decides the settle order.
        const gates = [];
        respond = (url, options) => options.method === 'GET'
            ? new Promise((resolve, reject) => gates.push({ resolve, reject }))
            : Promise.resolve({ status: 503 });
        const answer = (gate, list = reports) => gate.resolve({ status: 200, ok: true, json: async () => ({ reports: list }) });
        const stale = [{ ...reports[0], descriptionPreview: 'STALE older answer' }];
        // Settings → Feedback: init loads once; Refresh starts a second load.
        const settings = document.createElement('div');
        settings.innerHTML = feedbackTab.html();
        document.body.append(settings);
        feedbackTab.init($(settings));
        settings.querySelector('[data-action="refresh-reports"]').click();
        await until(() => gates.length === 2);
        const statusHost = settings.querySelector('[data-role="feedback-status-reports"]');
        answer(gates[1]);
        await until(() => /Desktop froze/.test(statusHost.textContent));
        gates[0].reject(new Error('Could not load your reports. Try again.'));
        await tick(); await tick();
        assert.match(statusHost.textContent, /Desktop froze/, '🔴 an older failed load never replaces the newer list (Settings)');
        // An older load that succeeds late is discarded too.
        settings.querySelector('[data-action="refresh-reports"]').click();
        settings.querySelector('[data-action="refresh-reports"]').click();
        await until(() => gates.length === 4);
        answer(gates[3]);
        await until(() => /Desktop froze/.test(statusHost.textContent));
        answer(gates[2], stale);
        await tick(); await tick();
        assert.doesNotMatch(statusHost.textContent, /STALE/, '🔴 an older successful load never replaces the newer list (Settings)');
        settings.remove();
        // Troubleshoot: same race through its explicit load.
        const pane = document.createElement('div');
        pane.innerHTML = troubleshoot.html();
        document.body.append(pane);
        troubleshoot.init($(pane));
        const load = pane.querySelector('[data-action="load-reports"]');
        load.click(); load.click();
        await until(() => gates.length === 6);
        answer(gates[5]);
        await until(() => pane.querySelector('.ezil-feedback-reports li'));
        gates[4].reject(new Error('Could not load your reports. Try again.'));
        await tick(); await tick();
        assert.ok(pane.querySelector('.ezil-feedback-reports li'), '🔴 an older failed load never replaces the newer list (Troubleshoot)');
        load.click(); load.click();
        await until(() => gates.length === 8);
        answer(gates[7]);
        await until(() => /Desktop froze/.test(pane.querySelector('[data-role="feedback-reports"]').textContent));
        answer(gates[6], stale);
        await tick(); await tick();
        assert.doesNotMatch(pane.querySelector('[data-role="feedback-reports"]').textContent, /STALE/,
            '🔴 an older successful load never replaces the newer list (Troubleshoot)');
        // Two failed deletes leave one message that does not claim the report is still there.
        window.confirm = () => true;
        const remove = pane.querySelector('.ezil-feedback-reports button');
        remove.click(); await until(() => ! remove.disabled && pane.querySelector('.ezil-settings-error'));
        remove.click(); await tick(); await until(() => ! remove.disabled);
        const messages = pane.querySelectorAll('.ezil-feedback-reports li .ezil-settings-error');
        assert.equal(messages.length, 1, '🔴 repeated failures update one message');
        assert.match(messages[0].textContent, /Could not confirm.*load your reports again to check/);
        pane.remove();
    });
    console.log(`\n${checks} feedback checks passed. jsdom does not validate browser layout or real capture.`);
} finally {
    trace.end();
    hooks.deregister();
    dom.window.close();
}
