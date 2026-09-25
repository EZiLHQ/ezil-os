import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlReplayGuard, signControlRequest, verifyControlRequest, type SignedControlRequest } from '../src/control-auth.js';

const secret = Buffer.alloc(32, 19);
const seconds = 1_790_326_000;
const now = seconds * 1000;
const nonce = 'test-request-0123456789';
function request(at = seconds): SignedControlRequest {
    const body = Buffer.from('{"installationId":"example","generation":3}');
    return { method: 'POST', path: '/v1/services/start', body,
        headers: signControlRequest('POST', '/v1/services/start', body, secret, at, nonce) };
}

test('accepts one exact signed request, then rejects replay', () => {
    const guard = new ControlReplayGuard();
    assert.deepEqual(verifyControlRequest(request(), secret, guard, now), { ok: true });
    assert.deepEqual(verifyControlRequest(request(), secret, guard, now), { ok: false, code: 'replayed_request' });
});

test('binds body, operation and computer-specific secret without consuming a valid nonce on failure', () => {
    const guard = new ControlReplayGuard();
    for (const modified of [
        { ...request(), body: Buffer.from('{"generation":4}') },
        { ...request(), path: '/v1/services/stop' },
    ]) {
        assert.deepEqual(verifyControlRequest(modified, secret, guard, now), { ok: false, code: 'invalid_signature' });
    }
    assert.deepEqual(verifyControlRequest(request(), Buffer.alloc(32, 20), guard, now),
        { ok: false, code: 'invalid_signature' });
    assert.deepEqual(verifyControlRequest(request(), secret, guard, now), { ok: true });
});

test('expiry uses the same precise boundary as replay retention', () => {
    const guard = new ControlReplayGuard();
    assert.deepEqual(verifyControlRequest(request(seconds - 60), secret, guard, now), { ok: true });
    assert.deepEqual(verifyControlRequest(request(seconds - 60), secret, guard, now + 1),
        { ok: false, code: 'stale_request' });
    assert.deepEqual(verifyControlRequest(request(seconds + 61), secret, new ControlReplayGuard(), now),
        { ok: false, code: 'stale_request' });
    assert.deepEqual(verifyControlRequest(request(), secret, new ControlReplayGuard(), Number.NaN),
        { ok: false, code: 'stale_request' });
});

test('rejects ambiguous paths, duplicate headers, arrays, oversized bodies and malformed signatures', () => {
    const input = request();
    for (const path of ['/v1/services//start', '/v1/services/start/', '/v1/../start', '/v1/start?x=1', '/v1/%2fstart']) {
        assert.deepEqual(verifyControlRequest({ ...input, path }, secret, new ControlReplayGuard(), now),
            { ok: false, code: 'invalid_request' });
    }
    for (const headers of [
        { ...input.headers, 'X-Ezil-Nonce': nonce },
        { ...input.headers, 'x-ezil-nonce': [nonce, nonce] },
        { ...input.headers, 'x-ezil-signature': 'sensitive-invalid-value' },
    ]) {
        const result = verifyControlRequest({ ...input, headers }, secret, new ControlReplayGuard(), now);
        assert.deepEqual(result, { ok: false, code: 'invalid_request' });
        assert.ok(!JSON.stringify(result).includes('sensitive-invalid-value'));
    }
    assert.deepEqual(verifyControlRequest({ ...input, body: Buffer.alloc(65_537) }, secret, new ControlReplayGuard(), now),
        { ok: false, code: 'invalid_request' });
});

test('normalizes header casing and fails closed at replay capacity', () => {
    const input = request();
    input.headers = Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toUpperCase(), value]));
    assert.deepEqual(verifyControlRequest(input, secret, new ControlReplayGuard(), now), { ok: true });
    const guard = new ControlReplayGuard();
    for (let i = 0; i < 10_000; i++) assert.equal(guard.reserve(`nonce-${i}`, now + 60_000, now), 'ok');
    assert.deepEqual(verifyControlRequest(request(), secret, guard, now), { ok: false, code: 'replay_capacity' });
    assert.equal(guard.reserve('after-expiry', now + 120_000, now + 60_001), 'ok');
});

test('rejects weak host configuration before it can authenticate anything', () => {
    assert.throws(() => verifyControlRequest(request(), Buffer.alloc(8), new ControlReplayGuard(), now), /control_secret_too_short/);
    assert.throws(() => signControlRequest('POST', '/v1/start', Buffer.alloc(0), secret, Number.NaN), /invalid_control_request/);
});
