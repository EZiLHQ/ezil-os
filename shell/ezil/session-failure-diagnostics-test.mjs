// session-failure-diagnostics-test.mjs — EZiL-authored. Run: node shell/ezil/session-failure-diagnostics-test.mjs
//
// FEEDBACK-DIAG: production feedback for "We couldn't start your computer"
// said only `unauthorized`; the server log said `worker_http_401
// hmac_signature_mismatch`. The server now sends a bounded `reason` and the
// `correlationId` of its log line beside the public code. This suite proves
// the shell keeps both — allowlisted — on the failure result of every start /
// mint path in `session.js`, and records them in telemetry's LOCAL mirror only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { captureUnavailable, openDesktop, pendingOrRefused, previewUrl, withWakeAndOneRetry } from './session.js';
import telemetry, { recentEvents } from './telemetry.js';
import { failureFields, isCorrelationId, isFailureReason } from './failure-diagnostics.js';

const CORR = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const HMAC = { ok: false, errorCode: 'unauthorized', provider: 'cloudflare-guacamole',
    error: 'worker_http_401: {"ok":false,"error":"hmac_signature_mismatch"}',
    reason: 'worker_http_401:hmac_signature_mismatch', correlationId: CORR };
const SECRETS = [
    'https://worker.example.test/sandbox/preview?token=abc123', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    'Bearer abcdef0123456789', 'a3f9c0d1'.repeat(4), 'alice@example.com', 'Worker_HTTP_401',
];

/** Every network call answers `answer` (a 200 body) or `{status, body}`. */
async function withServer (answer, run) {
    const oldFetch = globalThis.fetch;
    let asks = 0;
    globalThis.fetch = async () => {
        asks++;
        const { status = 200, body } = answer.status ? answer : { body: answer };
        return { ok: status < 400, status, json: async () => body };
    };
    try {
        return await run(() => asks);
    } finally {
        globalThis.fetch = oldFetch;
    }
}

for ( const [surface, open] of [['Browser', () => openDesktop('computer-1')], ['Preview', () => previewUrl('computer-1')]] ) {
    await test(`${surface}: a Worker HMAC 401 value keeps its reason and correlation id`, async () => {
        await withServer(HMAC, async (asks) => {
            const result = await open();
            assert.equal(result.errorCode, 'unauthorized');
            assert.equal(result.reason, 'worker_http_401:hmac_signature_mismatch');
            assert.equal(result.correlationId, CORR);
            assert.equal(asks(), 1, 'a deterministic refusal is still asked exactly once');
        });
    });

    await test(`${surface}: a thrown 502 keeps the fields from the error body`, async () => {
        const body = { error: { code: 'BAD_GATEWAY', message: 'Something went wrong on our side.',
            reason: 'worker_http_502:desktop_failed_to_start', correlationId: 'srv_0123456789ab' } };
        await withServer({ status: 502, body }, async () => {
            const result = await open();
            assert.equal(result.reason, 'worker_http_502:desktop_failed_to_start');
            assert.equal(result.correlationId, 'srv_0123456789ab');
        });
    });

    await test(`${surface}: an app-session 401 says so`, async () => {
        const body = { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.', reason: 'session_missing' } };
        await withServer({ status: 401, body }, async () => {
            const result = await open();
            assert.equal(result.errorCode, 'unauthorized');
            assert.equal(result.reason, 'session_missing');
            assert.equal('correlationId' in result, false);
        });
    });

    await test(`${surface}: secret-shaped fields are dropped on both paths, never repaired`, async () => {
        for ( const secret of SECRETS ) {
            await withServer({ ...HMAC, reason: secret, correlationId: secret }, async () => {
                const result = await open();
                assert.equal('reason' in result, false, secret);
                assert.equal('correlationId' in result, false, secret);
            });
            await withServer({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'No', reason: secret, correlationId: secret } } }, async () => {
                const result = await open();
                assert.equal('reason' in result, false, secret);
                assert.equal('correlationId' in result, false, secret);
            });
        }
    });

    await test(`${surface}: an older server (no new fields) yields the exact old shape`, async () => {
        await withServer({ ok: false, errorCode: 'unauthorized', error: 'x' }, async () => {
            const result = await open();
            assert.equal('reason' in result, false);
            assert.equal('correlationId' in result, false);
        });
    });
}

await test('the wake loop records reason + server correlation id in the LOCAL mirror only', async () => {
    const captured = [];
    // The wire event is built after the mirror; spy on the mirror by reading it back.
    const before = recentEvents().length;
    const answer = { ok: false, errorCode: 'fetch_failed', reason: 'worker_http_502', correlationId: 'srv_0123456789ab' };
    const result = await withWakeAndOneRetry(async () => answer, 'codePreviewUrl');
    assert.equal(result, answer);
    for ( const e of recentEvents().slice(before) ) captured.push(e);
    const retry = captured.find(e => e.code === 'auto_retry_fetch_failed');
    assert.ok(retry, JSON.stringify(captured));
    assert.equal(retry.reason, 'worker_http_502');
    assert.equal(retry.serverCorrelationId, 'srv_0123456789ab');
    assert.equal('correlationId' in retry, false, 'the trace correlation id field is not reused');
});

await test('an honest "not available" answer still records its reason + server correlation id, as skipped', async () => {
    for ( const [site, errorCode, reason] of [
        ['ezil-os:apps/code#mint', 'code_preview_unavailable', 'code_preview_port_not_exposed'],
        ['ezil-os:apps/preview#mint', 'app_preview_unavailable', 'app_preview_expose_failed'],
    ] ) {
        // The router's 200 value, through the same parse both windows use.
        const res = pendingOrRefused({ ok: false, errorCode, error: 'x', reason, correlationId: CORR });
        const before = recentEvents().length;
        assert.equal(await withWakeAndOneRetry(async () => res, 'codePreviewUrl'), res);
        assert.equal(recentEvents().length, before, 'not retried by the wake loop, so nothing there records it');
        captureUnavailable(site, res);
        assert.deepEqual(recentEvents().slice(before).map(({ eventClass, site: s, code, outcome, reason: r, serverCorrelationId }) =>
            ({ eventClass, site: s, code, outcome, reason: r, serverCorrelationId })),
        [{ eventClass: 'api_failure', site, code: errorCode, outcome: 'skipped', reason, serverCorrelationId: CORR }]);
    }
    const before = recentEvents().length;
    captureUnavailable('ezil-os:apps/code#mint', pendingOrRefused({ ok: false, errorCode: 'code_preview_unavailable' }));
    const [entry] = recentEvents().slice(before);
    assert.equal('reason' in entry || 'serverCorrelationId' in entry, false, 'an older server: the event, nothing more');
});

await test('capture() drops a reason or id that fails the allowlist, and keeps the event', () => {
    for ( const secret of SECRETS ) {
        const before = recentEvents().length;
        telemetry.capture({ eventClass: 'api_failure', site: 'ezil-os:apps/code#mint', code: 'unauthorized',
            reason: secret, serverCorrelationId: secret });
        const [entry] = recentEvents().slice(before);
        assert.equal(entry.code, 'unauthorized');
        assert.equal('reason' in entry, false, secret);
        assert.equal('serverCorrelationId' in entry, false, secret);
    }
});

await test('failureFields copies only the two validated fields', () => {
    assert.deepEqual(failureFields({ ...HMAC, detail: 'x', token: 'y' }),
        { reason: 'worker_http_401:hmac_signature_mismatch', correlationId: CORR });
    assert.deepEqual(failureFields(null), {});
    assert.deepEqual(failureFields('worker_http_401'), {});
    assert.equal(isFailureReason('a:b:c:d'), false);
    assert.equal(isCorrelationId(CORR.toUpperCase()), false);
});
