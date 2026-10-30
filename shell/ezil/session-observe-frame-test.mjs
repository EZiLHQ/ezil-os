// Run: node --test shell/ezil/session-observe-frame-test.mjs
// `observeFrame`'s verdict and retry flag, unit level (source module, stubbed fetch).
//
// Follow-up r5 (ACCEPT-9a755827 e2e-standard A3): Code failed with "Your desktop isn't
// answering" 0.8 s after the mint resolved. The first `confirm=frame` came back as an
// origin-side `http_error` whose status was not 500-504, which this function marked
// non-retryable, so Code stopped on the first ask with ~44 s of its 45 s budget left.
// On the code surface any origin `http_error` (401/404/410/52x included: the AWS preview
// auth hop, the host edge and the tunnel all answer those during a boot transition) is
// now retryable. Our OWN refusals stay terminal: an app-route 401/403 on
// `/api/shell/desktop`, and the server's `not_own_origin` / `provider_not_configured` /
// `bad_url`. The app route's HTTP status and the origin's `data.status` are never mixed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { observeFrame } from './session.js';

const FRAME = 'https://8443-guac-u1-c1-code.ezil.org/preview-bootstrap?token=t=1,v1=a';

async function observe (respond, surface = 'code') {
    const old = globalThis.fetch;
    const asked = [];
    globalThis.fetch = async (url, opts) => { asked.push(String(url)); return respond(opts); };
    try {
        return { observation: await observeFrame('c-1', FRAME, surface), asked };
    } finally { globalThis.fetch = old; }
}
const body = (data, status = 200) => async () => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const httpError = status => body({ ok: true, confirmed: false, reason: 'http_error', status });

const ORIGIN_STATUSES = [401, 403, 404, 410, 500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530];
for (const status of ORIGIN_STATUSES) {
    test(`code: origin http_error ${status} is an unconfirmed, RETRYABLE observation that names the hop`, async () => {
        const { observation, asked } = await observe(httpError(status));
        assert.equal(asked.length, 1);
        assert.match(asked[0], /confirm=frame/);
        assert.equal(observation.confirmed, false);
        assert.equal(observation.retryable, true);
        assert.equal(observation.reason, 'http_error');
        assert.equal(observation.status, status, 'the ORIGIN status, from the body');
    });
}

test('code: unreachable stays retryable (no origin status)', async () => {
    const { observation } = await observe(body({ ok: true, confirmed: false, reason: 'unreachable' }));
    assert.deepEqual([observation.confirmed, observation.retryable, observation.reason, observation.status], [false, true, 'unreachable', undefined]);
});

for (const status of [401, 403]) {
    for (const shape of ['json-error', 'non-json', 'contradictory-success', 'origin-http-error-body']) {
        test(`code: app-route HTTP ${status} (${shape}) is a terminal refusal, never the origin's status`, async () => {
            const payload = shape === 'json-error' ? JSON.stringify({ error: { code: 'UNAUTHORIZED' } })
                : shape === 'non-json' ? 'Access denied'
                    : shape === 'contradictory-success' ? JSON.stringify({ ok: true, confirmed: true, status: 200 })
                        : JSON.stringify({ ok: true, confirmed: false, reason: 'http_error', status: 503 });
            const { observation } = await observe(async () => new Response(payload, { status }));
            assert.equal(observation.confirmed, false);
            assert.equal(observation.retryable, false);
            assert.equal(observation.status, undefined, 'res.status (our route) never lands in the origin status');
            assert.equal(observation.routeStatus, status);
        });
    }
}

for (const reply of [
    { ok: true, confirmed: false, reason: 'not_own_origin' },
    { ok: true, confirmed: false, reason: 'not_own_origin', status: 503 },
    { ok: true, confirmed: false, reason: 'provider_not_configured' },
    { ok: true, confirmed: false, reason: 'bad_url' },
    { ok: true, confirmed: false },
    { ok: true, confirmed: false, status: 500 },
]) {
    test(`code: ${JSON.stringify(reply)} stays a terminal refusal`, async () => {
        const { observation } = await observe(body(reply));
        assert.equal(observation.confirmed, false);
        assert.equal(observation.retryable, false);
        assert.equal(observation.reason, reply.reason);
    });
}

test('desktop/preview surfaces keep the original 500-504 rule (only Code recovers 4xx/52x)', async () => {
    for (const surface of ['desktop', 'preview']) {
        assert.equal((await observe(httpError(401), surface)).observation.retryable, false);
        assert.equal((await observe(httpError(530), surface)).observation.retryable, false);
        assert.equal((await observe(httpError(502), surface)).observation.retryable, true);
    }
});

for (const [name, error] of [
    ['timed out', Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })],
    ['aborted', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })],
    ['network failure', new TypeError('fetch failed')],
]) {
    test(`a confirm request that ${name} is NOT an observation: undefined (retried), never false`, async () => {
        const { observation } = await observe(async () => { throw error; });
        assert.equal(observation.confirmed, undefined);
        assert.notEqual(observation.confirmed, false);
    });
}

test('a 5xx from our own route is unknown (retried), not a refusal', async () => {
    const { observation } = await observe(async () => new Response('bad gateway', { status: 502 }));
    assert.equal(observation.confirmed, undefined);
});

test('a well-formed positive is confirmed and carries its status', async () => {
    const { observation } = await observe(body({ ok: true, confirmed: true, status: 200 }));
    assert.equal(observation.confirmed, true);
    assert.equal(observation.status, 200);
});
