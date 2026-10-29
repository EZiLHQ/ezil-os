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
    await check('diagnostics clamp values and read only rendered stream measurements', () => {
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
        assert.deepEqual(data.stream, { kbps: 124, rttMs: 24 });
        vitals.remove();
        document.body.classList.remove('device-phone');
    });
    await check('chip mounts once; stays reachable (compact) in a visible fullbleed window while the pill is off', async () => {
        feedback.mount_feedback_chip(); feedback.mount_feedback_chip();
        assert.equal(document.querySelectorAll('.ezil-feedback-chip').length, 1);
        const chip = document.querySelector('.ezil-feedback-chip');
        assert.equal(chip.getAttribute('aria-label'), 'Feedback');
        const parent = document.createElement('div');
        parent.innerHTML = '<div class="window ezil-fullbleed"></div>';
        document.body.append(parent);
        await tick();
        assert.notEqual(chip.style.display, 'none', 'no pill: the chip is the only Feedback entry in fullbleed');
        assert.equal(chip.classList.contains('ezil-feedback-chip-fullbleed'), true);
        assert.equal(window.getComputedStyle(chip.querySelector('span')).display, 'none', 'icon only in the control strip');
        assert.equal(build_diagnostics().fullbleed, true);
        // With the floating-controls pill on, the pill offers Feedback and the chip steps aside.
        window.__EZIL_BOOT__.desktopState.ui.floatingControls = true;
        parent.firstChild.setAttribute('style', 'x: 1');
        await tick();
        assert.equal(chip.style.display, 'none');
        delete window.__EZIL_BOOT__.desktopState.ui.floatingControls;
        parent.style.display = 'none';
        await tick();
        assert.notEqual(chip.style.display, 'none');
        assert.equal(chip.classList.contains('ezil-feedback-chip-fullbleed'), false);
        assert.equal(build_diagnostics().fullbleed, false);
        parent.style.display = '';
        parent.firstChild.classList.remove('ezil-fullbleed');
        await tick();
        assert.notEqual(chip.style.display, 'none');
        assert.equal(chip.classList.contains('ezil-feedback-chip-fullbleed'), false);
        parent.remove();
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
    await check('the outbox keeps only the newest 10 unconfirmed sends, and a flush sends no more', async () => {
        open(); setDescription('Queued report 10');
        const template = payload();
        const seeded = Array.from({ length: 10 }, (_, i) => {
            const clientRequestId = crypto.randomUUID();
            return { clientRequestId, body: JSON.stringify({ ...template, clientRequestId, description: `Queued report ${i}` }) };
        });
        window.localStorage.setItem(outboxKey, JSON.stringify(seeded));
        setOnline(false);
        respond = async () => { throw new TypeError('Failed to fetch'); };
        send(); await until(() => /offline/.test(status()));
        const kept = stored(outboxKey);
        assert.deepEqual(kept.map(entry => entry.clientRequestId), [...seeded.slice(1), { clientRequestId: template.clientRequestId }]
            .map(entry => entry.clientRequestId), 'an 11th queued send drops the oldest');
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
        pane.innerHTML = troubleshoot.html();
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
        assert.equal(calls.length, count, 'opening the form sends nothing');
        close(); assert.equal(document.activeElement, entry, 'closing the form returns focus to the Settings button');
        delete window.__EZIL_BOOT__.desktopState.endpoints.feedback;
        assert.equal(tab.available(), false, 'no endpoint: no Feedback tab');
        entry.click();
        assert.equal(current(), null);
        assert.equal(calls.length, count);
        pane.remove();
    });
    console.log(`\n${checks} feedback checks passed. jsdom does not validate browser layout or real capture.`);
} finally {
    trace.end();
    hooks.deregister();
    dom.window.close();
}
