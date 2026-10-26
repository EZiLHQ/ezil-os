import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiBalanceState, enqueueFreeAiCredits, parseAiBalance, parseAiBalanceMicro, aiMicroBalanceState, readAiBalance, readAiAccount } from './ai-balance';
import type { OutboxInsert } from './ports';

const input = { config: { fundingUrl: 'https://gateway.test/' }, userId: 'current-user', headers: new Headers(),
    session: vi.fn(async () => ({ access_token: 'supabase-session-token', user: { id: 'current-user' } })) };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('AI balance', () => {
    it.each([[null, 500, 'unavailable'], [0, 500, 'exhausted'], [1, 500, 'low'], [50, 500, 'low'], [51, 500, 'ok'],
        [400, 4000, 'low'], [401, 4000, 'ok'], [2000, 20000, 'low'], [2001, 20000, 'ok'], [1, 0, 'ok']] as const)
    ('balance %s against grant %s is %s', (balance, grant, state) => expect(aiBalanceState(balance, grant)).toBe(state));
    it.each([[{ available_micro: '123456789' }, 123.456789], [{ available_micro: 1_000_000 }, 1], [{ available_micro: '999999' }, 0.999999],
        [{ available_micro: '0' }, 0], [{ credits: 4000 }, 4000], [{ credits: 0 }, 0], [null, null], [{}, null],
        [{ credits: -1 }, null], [{ credits: 1.5 }, 1.5], [{ credits: '1' }, null], [{ credits: Infinity }, null],
        [{ available_micro: '-1' }, null], [{ available_micro: 1.5 }, null], [{ available_micro: '1e6' }, null],
        [{ available_micro: '9007199254740992000000' }, null], [{ available_micro: null }, null]] as const)
    ('parses the isolated Gateway shape %j', (body, expected) => expect(parseAiBalance(body)).toBe(expected));
    it('uses only the current cookie session token with no redirects or shared cache', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ available_micro: '12000000' }));
        expect(await readAiBalance({ ...input, fetch: fetcher })).toBe(12);
        expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://gateway.test/v1/me/balance', {
            method: 'GET', headers: { Authorization: 'Bearer supabase-session-token' }, cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
        });
    });
    it('uses the authenticated bearer request token without reading a different cookie session', async () => {
        const session = vi.fn();
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ credits: 12 }));
        expect(await readAiBalance({ ...input, headers: new Headers({ authorization: 'Bearer request-token' }), session, fetch: fetcher })).toBe(12);
        expect(session).not.toHaveBeenCalled();
        expect(fetcher.mock.calls[0]![1]!.headers).toEqual({ Authorization: 'Bearer request-token' });
    });
    it.each([null, { access_token: 'foreign-token', user: { id: 'other-user' } }])('refuses an absent/mismatched cookie session %j', async session => {
        const fetcher = vi.fn<typeof fetch>();
        expect(await readAiBalance({ ...input, session: async () => session, fetch: fetcher })).toBeNull();
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('does not fall back to a cookie on a malformed Authorization header', async () => {
        const fetcher = vi.fn<typeof fetch>(); const session = vi.fn();
        expect(await readAiBalance({ ...input, headers: new Headers({ authorization: 'Basic bad' }), session, fetch: fetcher })).toBeNull();
        expect(fetcher).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled();
    });
    it('does nothing with an unset URL', async () => {
        const fetcher = vi.fn<typeof fetch>(); const session = vi.fn();
        expect(await readAiBalance({ ...input, config: { fundingUrl: undefined }, fetch: fetcher, session })).toBeNull();
        expect(fetcher).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled();
    });
    it.each([401, 403, 404, 409, 429, 500])('returns unavailable on HTTP %s', async status => {
        expect(await readAiBalance({ ...input, fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ credits: 100 }, { status })) })).toBeNull();
    });
    it.each(['session', 'fetch', 'body'] as const)('bounds a stalled %s to three seconds', async stall => {
        vi.useFakeTimers();
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => stall === 'fetch' ? new Promise(() => {})
            : { ok: true, json: () => new Promise(() => {}) } as Response);
        const session = stall === 'session' ? () => new Promise<never>(() => {}) : input.session;
        const pending = readAiBalance({ ...input, session, fetch: fetcher });
        let resolved = false; void pending.then(() => { resolved = true; });
        await vi.advanceTimersByTimeAsync(2999); expect(resolved).toBe(false);
        await vi.advanceTimersByTimeAsync(1); expect(await pending).toBeNull();
        if (stall === 'session') expect(fetcher).not.toHaveBeenCalled();
        else expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('never sends a token after a delayed session times out', async () => {
        vi.useFakeTimers(); let resolve!: (value: Awaited<ReturnType<typeof input.session>>) => void;
        const session = () => new Promise<Awaited<ReturnType<typeof input.session>>>(r => { resolve = r; });
        const fetcher = vi.fn<typeof fetch>(); const pending = readAiBalance({ ...input, session, fetch: fetcher });
        await vi.advanceTimersByTimeAsync(3000); expect(await pending).toBeNull();
        resolve({ access_token: 'late-token', user: { id: input.userId } });
        await vi.advanceTimersByTimeAsync(0); expect(fetcher).not.toHaveBeenCalled();
    });
    it('swallows malformed JSON and credential-bearing errors without logs', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        for (const fetcher of [vi.fn<typeof fetch>().mockResolvedValue(new Response('not json')),
            vi.fn<typeof fetch>().mockRejectedValue(new Error('supabase-session-token JWT secret'))]) {
            expect(await readAiBalance({ ...input, fetch: fetcher })).toBeNull();
        }
        expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    });
});

describe('Free summary grant', () => {
    it('enqueues one Free grant across repeat summaries, preserving the initial expiry', async () => {
        const rows = new Map<string, OutboxInsert>();
        const store = { enqueueOutbox: vi.fn(async (item: OutboxInsert) => {
            if (rows.has(item.eventKey)) return 'duplicate' as const;
            rows.set(item.eventKey, item); return 'queued' as const;
        }) };
        await enqueueFreeAiCredits(store, 'user', 'free_v3', new Date('2026-10-21Z'));
        await enqueueFreeAiCredits(store, 'user', 'free_v3', new Date('2026-11-21Z'));
        expect(rows.size).toBe(1);
        expect([...rows.values()][0]).toMatchObject({ eventKey: 'ezil-os:v1:free-once:user:grant',
            payload: { credits: 500, expiresAt: '2027-10-21T00:00:00.000Z' } });
    });
    it.each(['legacy', 'standard_monthly_v3', 'premium_monthly_v3'])('does not give %s a Free grant', async sku => {
        const store = { enqueueOutbox: vi.fn() };
        await enqueueFreeAiCredits(store, 'user', sku, new Date()); expect(store.enqueueOutbox).not.toHaveBeenCalled();
    });
    it('keeps summary readable and redacts a failed enqueue', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(enqueueFreeAiCredits({ enqueueOutbox: vi.fn().mockRejectedValue(new Error('postgres://secret-token')) },
            'user', 'free_v3', new Date())).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledExactlyOnceWith('[billing.ai] free grant enqueue unavailable');
    });
});


describe('exact AI account projection', () => {
    it.each([['1', 0.000001], ['999999', 0.999999], ['1000001', 1.000001], ['0', 0],
        ['9007199254740991', null], ['9007199254740991000000', Number.MAX_SAFE_INTEGER],
        ['9007199254740992000000', null]] as const)('retains %s microcredits without silently rounding', (micro, number) => {
        expect(parseAiBalanceMicro({ available_micro: micro })).toBe(micro);
        expect(parseAiBalance({ available_micro: micro })).toBe(number);
        expect(aiMicroBalanceState(micro, 500)).toBe(micro === '0' ? 'exhausted' : BigInt(micro) <= BigInt(50000000) ? 'low' : 'ok');
    });
    it('rejects unsafe JSON numbers and excess fractional precision but accepts exact decimal strings', () => {
        expect(parseAiBalanceMicro({ available_micro: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
        expect(parseAiBalanceMicro({ available_micro: String(Number.MAX_SAFE_INTEGER + 1) })).not.toBeNull();
        expect(parseAiBalance({ credits: 0.0000001 })).toBeNull();
    });
    function fetcher(overrides: Record<string, unknown> = {}) {
        const bodies: Record<string, unknown> = {
            '/v1/me/balance': { available_micro: '1000001', held_micro: '20', state: 'ok' },
            '/v1/models': { killswitch: false, pause: null },
            '/v1/me/limits': { policy: { policy: {} }, pauses: [], entitlement: { required: false, basis: 'not_required' } },
            '/v1/me/usage': { object: 'list', data: [] }, ...overrides,
        };
        return vi.fn<typeof fetch>(async url => Response.json(bodies[new URL(String(url)).pathname]));
    }
    it('captures one current-user credential for all four independently validated reads', async () => {
        const session = vi.fn(input.session), fetch = fetcher();
        expect(await readAiAccount({ ...input, session, fetch })).toMatchObject({ balanceMicro: '1000001', balance: 1.000001,
            heldMicro: '20', spendingState: 'available', recentUsage: { rows: [] }, limitsState: 'available' });
        expect(session).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(4);
        for (const [, options] of fetch.mock.calls) expect(options).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store',
            headers: { Authorization: 'Bearer supabase-session-token' } });
    });
    it.each(['operations', 'reconciliation'] as const)('preserves global %s pause with a positive balance', async pause => {
        const result = await readAiAccount({ ...input, fetch: fetcher({ '/v1/models': { killswitch: true, pause } }) });
        expect(result).toMatchObject({ balance: 1.000001, balanceState: 'ok', spendingState: `paused_${pause}` });
    });
    it('finds the global pause even when an exhausted wallet hides it', async () => {
        expect(await readAiAccount({ ...input, fetch: fetcher({ '/v1/me/balance': { available_micro: '0', state: 'exhausted' },
            '/v1/models': { killswitch: true, pause: 'operations' } }) })).toMatchObject({ balanceState: 'exhausted', spendingState: 'paused_operations' });
    });
    it('keeps successful balance and usage reads when limits are unavailable', async () => {
        expect(await readAiAccount({ ...input, fetch: fetcher({ '/v1/me/limits': null }) })).toMatchObject({ balance: 1.000001,
            spendingState: 'unavailable', usageState: 'available', limitsState: 'unavailable', limits: null });
    });
    it('does not claim spending is available when the wallet is unknown', async () => {
        expect(await readAiAccount({ ...input, fetch: fetcher({ '/v1/me/balance': null }) })).toMatchObject({ balance: null,
            spendingState: 'unavailable', usageState: 'available', limitsState: 'available' });
    });
    it('keeps limits and their policy pause when balance and usage fail', async () => {
        expect(await readAiAccount({ ...input, fetch: fetcher({ '/v1/me/balance': null, '/v1/me/usage': {},
            '/v1/me/limits': { pauses: [{ scope: 'account', reason: 'private' }] } }) })).toMatchObject({ balance: null,
            balanceState: 'unavailable', spendingState: 'paused_policy', usageState: 'unavailable', limits: { pauses: [{ scope: 'account' }] } });
    });
    it('does not treat a model/client pause as an account-wide pause', async () => {
        expect(await readAiAccount({ ...input, fetch: fetcher({ '/v1/me/limits': { policy: { policy: {} }, pauses: [{ scope: 'model' }, { scope: 'client' }],
            entitlement: { required: false, basis: 'not_required' } } }) })).toMatchObject({ spendingState: 'available' });
    });
    it('reports a required but missing entitlement as a policy pause with a positive balance', async () => {
        expect(await readAiAccount({ ...input, fetch: fetcher({ '/v1/me/limits': { policy: { policy: {} }, pauses: [],
            entitlement: { required: true, basis: null } } }) })).toMatchObject({ balance: 1.000001, spendingState: 'paused_policy' });
    });
    it('keeps an unreadable effective policy unknown rather than implying no limits', async () => {
        expect(await readAiAccount({ ...input, fetch: fetcher({ '/v1/me/limits': { policy: {}, pauses: [],
            entitlement: { required: false, basis: 'not_required' } } }) })).toMatchObject({ balance: 1.000001, spendingState: 'unavailable' });
    });
    it('cancels delayed requests immediately and clears deadline timers', async () => {
        vi.useFakeTimers(); const controller = new AbortController();
        const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
        const pending = readAiAccount({ ...input, signal: controller.signal, fetch });
        await vi.advanceTimersByTimeAsync(1); controller.abort();
        expect(await pending).toMatchObject({ balance: null, spendingState: 'unavailable', recentUsage: null, limits: null });
        expect(vi.getTimerCount()).toBe(0);
        for (const [, options] of fetch.mock.calls) expect(options?.signal?.aborted).toBe(true);
    });
});
