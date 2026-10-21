import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendAiCreditEvent, signAiGatewayBody } from './ai-gateway-client';

const event = { eventId: 'ent:grant', entitlementId: 'ent', accountPublicId: 'account', action: 'grant' as const,
    credits: 4000, expiresAt: '2026-11-04T00:00:00.000Z' };
const options = { url: 'https://gateway.test/', secret: 'fixed-test-key', event, now: () => 1792569600999 };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('signed AI Gateway client', () => {
    it('signs documented timestamp-dot-UTF8-body bytes (including non-ASCII)', () => {
        const body = '{"message":"EZiL café","credits":4000}';
        expect(signAiGatewayBody('fixed-test-key', '1792569600', body)).toBe('v1=e1cd311c9ac0e88611380f7160f03ba26427795812617477ee437d463b65d21e');
        expect(signAiGatewayBody('fixed-test-key', '1792569600', body)).toBe(
            `v1=${createHmac('sha256', 'fixed-test-key').update(Buffer.concat([Buffer.from('1792569600.'), Buffer.from(body)])).digest('hex')}`,
        );
        expect(signAiGatewayBody('fixed-test-key', '1792569600', body + '\n')).not.toBe(signAiGatewayBody('fixed-test-key', '1792569600', body));
    });
    it('posts precisely the six signed fields once, in seconds, without redirects', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
        expect(await sendAiCreditEvent({ ...options, fetch: fetcher })).toEqual({ status: 'ok' });
        expect(fetcher).toHaveBeenCalledTimes(1);
        const [url, init] = fetcher.mock.calls[0]!;
        expect(url).toBe('https://gateway.test/v1/integrations/entitlements');
        expect(init).toMatchObject({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal), body: JSON.stringify(event) });
        expect(init?.headers).toEqual({ 'Content-Type': 'application/json', 'X-EZiL-Timestamp': '1792569600',
            'X-EZiL-Signature': signAiGatewayBody(options.secret, '1792569600', init!.body as string) });
    });
    it.each([200, 201, 204, 299, 300, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503])('maps HTTP %s', async status => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
        expect(await sendAiCreditEvent({ ...options, fetch: fetcher })).toEqual(status < 300 ? { status: 'ok' }
            : { status: status >= 500 ? 'retryable' : 'permanent', reason: `http_${status}` });
    });
    it('treats event_conflict as permanent and logs only the entitlement id', async () => {
        const log = vi.fn();
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'event_conflict', message: 'secret JWT' } }, { status: 409 }));
        expect(await sendAiCreditEvent({ ...options, fetch: fetcher, log })).toEqual({ status: 'permanent', reason: 'event_conflict' });
        expect(log).toHaveBeenCalledExactlyOnceWith('[billing.ai] event_conflict', { entitlementId: 'ent' });
    });
    it.each(['fetch', 'body'] as const)('times out a stalled %s at ten seconds and aborts', async stall => {
        vi.useFakeTimers();
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => stall === 'fetch' ? new Promise(() => {})
            : { status: 409, ok: false, json: () => new Promise(() => {}) } as Response);
        const pending = sendAiCreditEvent({ ...options, fetch: fetcher });
        let resolved = false;
        void pending.then(() => { resolved = true; });
        await vi.advanceTimersByTimeAsync(9999);
        expect(resolved).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toEqual({ status: 'retryable', reason: 'transport_unavailable' });
        expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('never logs transport errors containing credentials', async () => {
        const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('fixed-test-key JWT user-token'));
        expect(await sendAiCreditEvent({ ...options, fetch: fetcher })).toMatchObject({ status: 'retryable' });
        expect(log).not.toHaveBeenCalled();
    });
});
