import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createAwsHostTransport, nativeDeliveryBody, type AwsNativeDelivery } from './aws-host-transport';

const TOKEN = `ezg_${'A'.repeat(43)}`;
const env = { EZIL_NATIVE_HOST_TRANSPORT: '1', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'fixture-secret', CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://worker.example' };
const instruction = '"\\'.repeat(8192);
const delivery = (over: Partial<AwsNativeDelivery> = {}): AwsNativeDelivery => ({
    profileId: 'ezil-native-claude-v1', kind: 'create', operationId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222', computerId: '33333333-3333-4333-8333-333333333333',
    ownerUserId: '44444444-4444-4444-8444-444444444444',
    placement: { generation: '7', leaseEpoch: '3', instanceId: 'i-0123456789abcdef0', fenceToken: '66666666-6666-4666-8666-666666666666' },
    leaseUntil: '2026-11-17T01:00:00.000Z',
    task: { taskRef: 'task:x', instructionRevision: 1, instructionDigest: `sha256:${createHash('sha256').update(instruction).digest('hex')}`, instruction },
    sourceAuthorization: { authorizationId: '77777777-7777-4777-8777-777777777777', epoch: '1', authorizationDeadline: '2026-11-17T01:00:00.000Z',
        clientId: 'ezil-mcp', profileId: 'ezil-native-claude-v1', policyId: '88888888-8888-4888-8888-888888888888', budgetMicro: '250000000',
        initialApprovalAt: '2026-11-16T22:00:00.000Z' },
    grant: { accessToken: TOKEN, tokenSha256: createHash('sha256').update(TOKEN).digest('hex'), grantId: '99999999-9999-4999-8999-999999999999',
        expiresAt: '2026-11-16T22:05:00.000Z' },
    ...over,
});
const signal = () => new AbortController().signal;

describe('AWS native host transport', () => {
    it('is off by default, renew is never supported and readiness is truthfully refused', async () => {
        const off = createAwsHostTransport({ env: {}, fetch: vi.fn() });
        expect([off.available, off.supportsKind('create'), off.supportsKind('renew')]).toEqual([false, false, false]);
        const on = createAwsHostTransport({ env, fetch: vi.fn() });
        expect([on.available, on.supportsKind('create'), on.supportsKind('renew')]).toEqual([true, true, false]);
        expect(await off.checkReadiness(delivery())).toEqual({ kind: 'refused' });
        expect(await off.deliver(delivery(), signal())).toEqual({ kind: 'refused', reason: 'host_unavailable' });
    });

    it('refuses unrepresentable counters, renew and token mismatch with zero network calls', async () => {
        const fetch = vi.fn();
        const t = createAwsHostTransport({ env, fetch });
        for (const d of [delivery({ placement: { ...delivery().placement, leaseEpoch: '2147483648' } }),
            delivery({ placement: { ...delivery().placement, generation: '07' } }), delivery({ kind: 'renew', task: null }),
            delivery({ grant: { ...delivery().grant, tokenSha256: 'f'.repeat(64) } })]) {
            expect(await t.deliver(d, signal())).toEqual({ kind: 'refused', reason: 'host_refused' });
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('sends once with a v2 envelope over the exact body and maps the Worker outcome', async () => {
        const cases: Array<[Response | Error, unknown]> = [
            [Response.json({ ok: true, outcome: 'acknowledged' }), { kind: 'acknowledged' }],
            [Response.json({ ok: false, outcome: 'refused', reason: 'placement_mismatch' }, { status: 409 }), { kind: 'refused', reason: 'placement_mismatch' }],
            [Response.json({ ok: false, outcome: 'unknown', reason: 'host_no_ack' }, { status: 502 }), { kind: 'unknown', reason: 'host_no_ack' }],
            [Response.json({ ok: false, error: 'hmac_signature_mismatch' }, { status: 401 }), { kind: 'refused', reason: 'host_refused' }],
            [new Error('reset'), { kind: 'unknown', reason: 'host_no_ack' }],
        ];
        for (const [answer, want] of cases) {
            const fetch = vi.fn(async () => { if (answer instanceof Error) throw answer; return answer; });
            const t = createAwsHostTransport({ env, fetch: fetch as unknown as typeof globalThis.fetch, now: () => 1_794_405_600_000 });
            expect(await t.deliver(delivery(), signal())).toEqual(want);
            expect(fetch).toHaveBeenCalledTimes(1);
            const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
            expect(new URL(url).pathname).toBe('/sandbox/guac-4444444444444444-3333333333334333/native-session');
            expect(init.body).toBe(nativeDeliveryBody(delivery()));
            expect(String((init.headers as Record<string, string>)['x-ezil-auth'])).toMatch(/^v2\./);
            expect(url).not.toContain(TOKEN);
        }
    });

    it('readiness is one authenticated read and requires exact nonce, digest, expiry and host evidence', async () => {
        const d = delivery();
        for (const mismatch of [false, true]) {
            const fetch = vi.fn(async (url: string, init: RequestInit) => {
                expect(init.method).toBe('GET'); expect(init.body).toBeUndefined();
                const raw = Buffer.from(new URL(url).pathname.split('/').at(-1)!, 'base64url').toString();
                const query = JSON.parse(raw);
                return Response.json({ ok: true, kind: 'ready', nonce: mismatch ? 'wrong' : query.nonce, expiresAt: query.expiresAt,
                    targetDigest: createHash('sha256').update(raw).digest('hex'), hostEpoch: 'a'.repeat(32), manifestSha256: 'b'.repeat(64) });
            });
            const t = createAwsHostTransport({ env, fetch: fetch as unknown as typeof globalThis.fetch });
            expect(await t.checkReadiness(d)).toEqual({ kind: mismatch ? 'unknown' : 'ready' });
            expect(fetch).toHaveBeenCalledTimes(1);
        }
    });

    it('a max-escaped 16 KiB instruction fits the 128 KiB body and keeps the sha256: task digest', () => {
        const body = nativeDeliveryBody(delivery());
        expect(Buffer.byteLength(body)).toBeLessThanOrEqual(131_072);
        expect(JSON.parse(body).task.instructionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(JSON.parse(body).grant.tokenSha256).toMatch(/^[0-9a-f]{64}$/);
    });
});
