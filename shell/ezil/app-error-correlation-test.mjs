// app-error-correlation-test.mjs — EZiL-authored. Run with Node; no browser or network.
// App-error coverage, producer side. A refusal value shaped exactly like the server's AWS answer (`awsAnswered`) goes
// through the shell's REAL parsers into the REAL `telemetry.capture`, into its local mirror only (never the wire), and
// then into the REAL feedback diagnostics builder, which carries the server id and reason only with the server
// capability. Nothing mutates a mirror entry by hand.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://os.example/os', pretendToBeVisual: true });
for ( const key of ['window', 'document', 'navigator'] ) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
const wire = [];
// Telemetry armed, so a wire leak would show; every network call is intercepted.
dom.window.__EZIL_BOOT__ = { computer: { id: '11111111-1111-4111-8111-111111111111' }, user: { id: '33333333-3333-4333-8333-333333333333' },
    desktopState: { endpoints: { telemetry: '/api/shell/telemetry' }, ui: {} } };
// The Blob a beacon carries is read back as text, so the assertions below see the real body.
globalThis.navigator.sendBeacon = (url, body) => { wire.push(body); return true; };

const session = await import('./session.js');
const telemetry = (await import('./telemetry.js')).default;
const { build_diagnostics } = await import('./ui/feedback/diagnostics.js');

const ID = '6f1c2a8e-5b7d-4c3e-9a1f-2b3c4d5e6f70';
// The server's answer for the canary case: an AWS ensure refusal on a second computer (`awsPreviewAnswer` + `awsAnswered`).
const refusal = { ok: false, error: 'user_has_aws_computer', errorCode: 'user_has_aws_computer', retryable: false,
    provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2', correlationId: ID, refusalReason: 'user_has_aws_computer' };

async function withAnswer (answer, run) {
    const old = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if ( String(url).includes('/telemetry') ) { wire.push(String(init?.body)); return { ok: true, status: 204, json: async () => ({}) }; }
        return { ok: true, status: 200, json: async () => answer };
    };
    try { return await run(); } finally { globalThis.fetch = old; }
}

for ( const [surface, open] of [
    ['Browser', () => session.openDesktop('computer-1')],
    ['Preview', () => session.previewUrl('computer-1')],
    ['Code', () => session.withWakeAndOneRetry(async () => session.pendingOrRefused(refusal), 'codePreviewUrl')],
] ) {
    await test(`${surface}: the parser carries the server's own id and bounded reason, beside the unchanged code`, async () => {
        const result = await withAnswer(refusal, open);
        assert.equal(result.ok, false);
        assert.equal(result.errorCode, 'user_has_aws_computer');
        assert.equal(result.serverCorrelationId, ID);
        assert.equal(result.reason, 'user_has_aws_computer');
    });
}

await test('only the explicit fields, each shape-checked; free text and look-alikes never become a reason or id', () => {
    assert.deepEqual(session.serverFailureOf({ error: 'user_has_aws_computer' }), {});
    assert.deepEqual(session.serverFailureOf({ correlationId: 'Bearer abc', refusalReason: 'https://x.test/?token=1' }), {});
    assert.deepEqual(session.serverFailureOf({ correlationId: ID.toUpperCase(), refusalReason: 'deadbeefcafe0123456789' }), {});
    assert.deepEqual(session.serverFailureOf({ correlationId: 'srv_0123456789ab', refusalReason: 'computer_starting' }),
        { serverCorrelationId: 'srv_0123456789ab', reason: 'computer_starting' });
    assert.deepEqual(session.serverFailureOf(undefined), {});
    // An answer without the new fields (an older server) parses exactly as before.
    const { correlationId, refusalReason, ...old } = refusal;
    assert.deepEqual(session.pendingOrRefused(old), { ok: false, errorCode: 'user_has_aws_computer', computeProvider: 'aws-ec2' });
});

await test('capture keeps them on the local mirror only, never on the wire', async () => {
    const result = await withAnswer(refusal, () => session.openDesktop('computer-1'));
    await withAnswer(refusal, async () => {
        // Exactly the desktop window's terminal #mint capture (`apps/desktop-window.js`).
        telemetry.capture({ eventClass: 'api_failure', site: 'ezil-os:apps/desktop#mint', code: result.errorCode,
            durationMs: 5, reason: result.reason, serverCorrelationId: result.serverCorrelationId });
        telemetry.capture({ eventClass: 'api_failure', site: 'ezil-os:apps/code#mint', code: 'other_failure',
            reason: 'Bearer secret', serverCorrelationId: 'not-an-id' });
        telemetry.flushNow();
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    const mirror = telemetry.recentEvents();
    assert.deepEqual({ reason: mirror.at(-2).reason, id: mirror.at(-2).serverCorrelationId }, { reason: 'user_has_aws_computer', id: ID });
    assert.equal('reason' in mirror.at(-1), false);
    assert.equal('serverCorrelationId' in mirror.at(-1), false);
    const sent = (await Promise.all(wire.map(body => typeof body === 'string' ? body : body.text()))).join('\n');
    assert.match(sent, /ezil-os:apps\/desktop#mint/, 'the event itself is still sent as before');
    assert.doesNotMatch(sent, new RegExp(ID));
    assert.doesNotMatch(sent, /user_has_aws_computer"?\s*,\s*"?serverCorrelationId|refusalReason|serverCorrelationId|"reason"/);
});

await test('feedback diagnostics carry them only when this server accepts them', () => {
    const newest = () => build_diagnostics().recentEvents.findLast(e => e.site === 'ezil-os:apps/desktop#mint');
    assert.deepEqual(newest(), { eventClass: 'api_failure', site: 'ezil-os:apps/desktop#mint', code: 'user_has_aws_computer' });
    dom.window.__EZIL_BOOT__.desktopState.ui.feedbackEventDiagnostics = true;
    assert.deepEqual(newest(), { eventClass: 'api_failure', site: 'ezil-os:apps/desktop#mint', code: 'user_has_aws_computer',
        reason: 'user_has_aws_computer', correlationId: ID });
    const rejected = build_diagnostics().recentEvents.findLast(e => e.site === 'ezil-os:apps/code#mint');
    assert.deepEqual(rejected, { eventClass: 'api_failure', site: 'ezil-os:apps/code#mint', code: 'other_failure' });
});
