import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';

import { aiCreditEntitlement, aiCreditOutboxItem, aiFreeStarterEventKey } from './ai-credits';
import { aiRequestTimeoutMs, AI_GATEWAY_TIMEOUT_MS } from './ai-gateway-client';
import { drainAiCreditOutbox, type AiCreditOutboxRow, type AiCreditOutboxStore } from './ai-credit-outbox';

const stores = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('./ai-credit-outbox-store', async importOriginal => ({
    ...await importOriginal<typeof import('./ai-credit-outbox-store')>(),
    createAiCreditOutboxStore: stores.create,
}));

import { AI_STARTER_ADMISSION_MS, AI_STARTER_REQUEST_MS, deliverStarterCredits } from './ai-starter-delivery';

const USER = '3f2f95a1-5420-4a63-94f9-79b85a1ceeb4';
const NOW = Date.parse('2026-11-11T12:00:00Z');
const CONFIG = { fundingUrl: 'https://gateway.test', fundingHmacSecret: 'starter-test-secret' };
const CLIENT = {} as postgres.Sql;

function freeRow(overrides: Partial<AiCreditOutboxRow> = {}): AiCreditOutboxRow {
    const item = aiCreditOutboxItem(USER, aiCreditEntitlement({ userId: USER, sku: 'free_v3', subscriptionId: null,
        periodStart: new Date(NOW), periodEnd: null, invoiceId: null }), 'grant', null);
    return { ...item, id: 'row', attempts: 1, ...overrides };
}
function fakeStore(rows: AiCreditOutboxRow[] = [freeRow()]) {
    return {
        claim: vi.fn<AiCreditOutboxStore['claim']>(async () => rows.shift() ?? null),
        accountFor: vi.fn<AiCreditOutboxStore['accountFor']>(async () => 'works-public-id'),
        pinAccount: vi.fn<AiCreditOutboxStore['pinAccount']>(async () => true),
        finish: vi.fn<AiCreditOutboxStore['finish']>(async () => undefined),
        enrollFor: vi.fn<NonNullable<AiCreditOutboxStore['enrollFor']>>(async () => 'enrolled' as const),
    };
}
const ok = () => vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); stores.create.mockReset(); vi.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the Free starter event key', () => {
    it('is the exact key the sign-in enrollment queues, with no period start in it', () => {
        expect(aiFreeStarterEventKey(USER)).toBe(`ezil-os:v1:free-once:${USER}:grant`);
        expect(aiFreeStarterEventKey(USER)).toBe(freeRow().eventKey);
    });
});

describe('the scoped claim (one atomic SKIP LOCKED statement, the same fences)', () => {
    const scope = { userId: USER, eventKey: aiFreeStarterEventKey(USER), kind: 'ai_grant' } as const;
    const render = async (withScope: boolean) => {
        const { createAiCreditOutboxStore } = await vi.importActual<typeof import('./ai-credit-outbox-store')>('./ai-credit-outbox-store');
        const execute = vi.fn().mockResolvedValue([]);
        await createAiCreditOutboxStore({ execute } as unknown as Parameters<typeof createAiCreditOutboxStore>[0]).claim(NOW, withScope ? scope : undefined);
        return new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    };
    it('names the exact user, the exact event key and kind ai_grant inside the claim', async () => {
        const query = await render(true);
        expect(query.sql).toMatch(/pending\.user_id = \$\d+::uuid and pending\.event_key = \$\d+ and pending\.kind = \$\d+/);
        expect(query.params).toEqual(expect.arrayContaining([USER, scope.eventKey, 'ai_grant']));
        // Still one statement with the lease, the attempt fence and skip-locked.
        expect(query.sql).toMatch(/for update of pending skip locked limit 1/);
        expect(query.sql).toMatch(/set attempts = case/);
        expect(query.sql).toMatch(/leaseToken|\{delivery\}/);
    });
    it('is absent for the sweep: its claim is the oldest due row of anyone, as before', async () => {
        const query = await render(false);
        expect(query.sql).not.toMatch(/pending\.event_key = \$/);
        expect(query.sql).not.toMatch(/pending\.user_id = \$/);
        expect(query.params).not.toContain(USER);
    });
});

describe('deliverStarterCredits (the sign-in attempt on the enrollment\'s owned client)', () => {
    it('claims exactly that grant, sends the idempotent event with a 2 s budget, and finishes it', async () => {
        const store = fakeStore(); stores.create.mockReturnValue(store);
        const fetcher = ok();
        const result = await deliverStarterCredits({ client: CLIENT, userId: USER, deadlineAt: NOW + 5_000, config: CONFIG, fetch: fetcher });
        expect(result).toBe('delivered');
        expect(store.claim).toHaveBeenCalledTimes(1);
        expect(store.claim.mock.calls[0]![1]).toEqual({ userId: USER, eventKey: `ezil-os:v1:free-once:${USER}:grant`, kind: 'ai_grant' });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ eventId: `ezil-os:v1:free-once:${USER}:grant`,
            entitlementId: `ezil-os:v1:free-once:${USER}`, action: 'grant', credits: 10, expiresAt: expect.any(String), accountPublicId: 'works-public-id' });
        expect(store.pinAccount).toHaveBeenCalledTimes(1);
        expect(store.finish).toHaveBeenCalledWith(expect.anything(), { status: 'done', reason: null }, expect.any(Number));
        expect(store.enrollFor).not.toHaveBeenCalled();
    });

    it('delivers an old pending100 receipt unchanged under its original event identity after the new10 policy', async () => {
        const historical = freeRow();
        historical.payload = { ...historical.payload, credits: 100, expiresAt: '2027-10-01T00:00:00.000Z' };
        const store = fakeStore([historical]); stores.create.mockReturnValue(store);
        const fetcher = ok();
        expect(freeRow().payload.credits).toBe(10);
        expect(await deliverStarterCredits({ client: CLIENT, userId: USER, deadlineAt: NOW + 5_000, config: CONFIG, fetch: fetcher })).toBe('delivered');
        const sent = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
        expect(sent).toMatchObject({ eventId: `ezil-os:v1:free-once:${USER}:grant`, entitlementId: `ezil-os:v1:free-once:${USER}`,
            credits: 100, expiresAt: '2027-10-01T00:00:00.000Z' });
        expect(store.claim.mock.calls[0]![1]!.eventKey).toBe(historical.eventKey);
    });

    it('never enrolls from inside the attempt, even with no account yet: the row retries for the sweep', async () => {
        const store = fakeStore(); store.accountFor.mockResolvedValue(null); stores.create.mockReturnValue(store);
        const fetcher = ok();
        expect(await deliverStarterCredits({ client: CLIENT, userId: USER, deadlineAt: NOW + 5_000, config: CONFIG, fetch: fetcher })).toBe('queued');
        expect(store.enrollFor).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled();
        expect(store.finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'retry', reason: 'no_ai_account' }), expect.any(Number));
    });

    it('under 3.25 s left it does not claim, take a lease or count an attempt', async () => {
        const store = fakeStore(); stores.create.mockReturnValue(store);
        const fetcher = ok();
        expect(AI_STARTER_ADMISSION_MS).toBe(AI_STARTER_REQUEST_MS + 1_000 + 250);
        expect(await deliverStarterCredits({ client: CLIENT, userId: USER, deadlineAt: NOW + AI_STARTER_ADMISSION_MS - 1, config: CONFIG, fetch: fetcher })).toBe('skipped');
        expect(store.claim).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled();
        expect(stores.create).not.toHaveBeenCalled();
        // Exactly the admission margin still attempts: the budget is never "too small" to try.
        expect(await deliverStarterCredits({ client: CLIENT, userId: USER, deadlineAt: NOW + AI_STARTER_ADMISSION_MS, config: CONFIG, fetch: fetcher })).toBe('delivered');
    });

    it('without a funding URL or secret it does nothing', async () => {
        const store = fakeStore(); stores.create.mockReturnValue(store);
        for (const config of [{}, { fundingUrl: 'https://gateway.test' }, { fundingHmacSecret: 'x' }, { fundingUrl: '', fundingHmacSecret: '' }]) {
            expect(await deliverStarterCredits({ client: CLIENT, userId: USER, deadlineAt: NOW + 5_000, config, fetch: ok() })).toBe('skipped');
        }
        expect(store.claim).not.toHaveBeenCalled();
    });

    it('a Gateway that never answers is aborted at 2 s and the row goes to retry, not to failed', async () => {
        const store = fakeStore(); stores.create.mockReturnValue(store);
        const aborted = vi.fn();
        const hang = vi.fn<typeof fetch>((_url, init) => new Promise((_, reject) => {
            init!.signal!.addEventListener('abort', () => { aborted(); reject(new Error('aborted')); });
        }));
        const attempt = deliverStarterCredits({ client: CLIENT, userId: USER, deadlineAt: NOW + 5_000, config: CONFIG, fetch: hang });
        await vi.advanceTimersByTimeAsync(AI_STARTER_REQUEST_MS - 1);
        expect(aborted).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(await attempt).toBe('queued');
        expect(aborted).toHaveBeenCalledTimes(1);
        expect(store.finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'retry', reason: 'transport_unavailable' }), expect.any(Number));
    });

    it('a lost acknowledgement (Gateway 204, then the finish write fails) is resent by the sweep with the identical event', async () => {
        const row = freeRow();
        const store = fakeStore([row]); store.finish.mockRejectedValueOnce(new Error('socket cut'));
        stores.create.mockReturnValue(store);
        const first = ok();
        expect(await deliverStarterCredits({ client: CLIENT, userId: USER, deadlineAt: NOW + 5_000, config: CONFIG, fetch: first })).toBe('queued');
        const firstBody = first.mock.calls[0]![1]!.body as string;
        // The row is still `processing`; once its 30 s lease lapses the sweep claims it again (unscoped) and resends it.
        const sweepStore = fakeStore([{ ...row, attempts: 2 }]);
        const second = ok();
        await drainAiCreditOutbox({ config: CONFIG, aiCredits: sweepStore, clock: () => NOW + 31_000, fetch: second, log: () => {} },
            { limit: 25, deadlineMs: NOW + 31_000 + 40_000 });
        expect(sweepStore.claim.mock.calls[0]![1]).toBeUndefined();
        expect(second.mock.calls[0]![1]!.body).toBe(firstBody);
    });

    it('a claim that finds nothing (the sweep holds the lease, or it was delivered) sends nothing and is not an error', async () => {
        const store = fakeStore([]); stores.create.mockReturnValue(store);
        const fetcher = ok();
        expect(await deliverStarterCredits({ client: CLIENT, userId: USER, deadlineAt: NOW + 5_000, config: CONFIG, fetch: fetcher })).toBe('queued');
        expect(fetcher).not.toHaveBeenCalled();
        expect(store.finish).not.toHaveBeenCalled();
    });

    it('two concurrent sign-ins send the one grant once: the second claim finds the first\'s lease', async () => {
        const rows = [freeRow()];
        const store = fakeStore(rows); stores.create.mockReturnValue(store);   // claim shifts the row: the atomic claim, in miniature
        const fetcher = ok();
        const results = await Promise.all([1, 2].map(() => deliverStarterCredits({ client: CLIENT, userId: USER, deadlineAt: NOW + 5_000, config: CONFIG, fetch: fetcher })));
        expect(results.sort()).toEqual(['delivered', 'queued']);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('a throwing store or a failed database read is "queued", never a thrown error', async () => {
        const store = fakeStore(); store.claim.mockRejectedValue(new Error('connection terminated')); stores.create.mockReturnValue(store);
        await expect(deliverStarterCredits({ client: CLIENT, userId: USER, deadlineAt: NOW + 5_000, config: CONFIG, fetch: ok() })).resolves.toBe('queued');
    });
});

describe('request timeouts are validated; the sweep keeps its 10 s', () => {
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, AI_GATEWAY_TIMEOUT_MS + 1])('rejects %s', value => {
        expect(() => aiRequestTimeoutMs(value)).toThrow(RangeError);
    });
    it.each([1, 2_000, AI_GATEWAY_TIMEOUT_MS])('accepts %s', value => expect(aiRequestTimeoutMs(value)).toBe(value));
    it('the drain refuses a bad per-request timeout before claiming anything', async () => {
        const store = fakeStore();
        await expect(drainAiCreditOutbox({ config: CONFIG, aiCredits: store, clock: () => NOW, fetch: ok(), log: () => {} },
            { limit: 1, deadlineMs: NOW + 40_000, requestTimeoutMs: 0 })).rejects.toThrow(RangeError);
        expect(store.claim).not.toHaveBeenCalled();
    });
    it('a scoped drain never enrolls, even with all the time in the world (the guard, not just the small budget)', async () => {
        const store = fakeStore(); store.accountFor.mockResolvedValue(null);
        await drainAiCreditOutbox({ config: CONFIG, aiCredits: store, clock: () => NOW, fetch: ok(), log: () => {} },
            { limit: 1, deadlineMs: NOW + 120_000, requestTimeoutMs: AI_STARTER_REQUEST_MS,
                scope: { userId: USER, eventKey: aiFreeStarterEventKey(USER), kind: 'ai_grant' } });
        expect(store.enrollFor).not.toHaveBeenCalled();
        // The sweep (no scope) with the same time and no account does enroll: the guard is what differs.
        const sweep = fakeStore(); sweep.accountFor.mockResolvedValue(null);
        await drainAiCreditOutbox({ config: CONFIG, aiCredits: sweep, clock: () => NOW, fetch: ok(), log: () => {} }, { limit: 1, deadlineMs: NOW + 120_000 });
        expect(sweep.enrollFor).toHaveBeenCalledTimes(1);
    });
    it('the sweep\'s defaults are unchanged: no scope on the claim and a 10 s request needing 11 s of deadline', async () => {
        const store = fakeStore(); const fetcher = ok();
        await drainAiCreditOutbox({ config: CONFIG, aiCredits: store, clock: () => NOW, fetch: fetcher, log: () => {} }, { limit: 1, deadlineMs: NOW + 10_999 });
        expect(store.claim).not.toHaveBeenCalled();
        await drainAiCreditOutbox({ config: CONFIG, aiCredits: store, clock: () => NOW, fetch: fetcher, log: () => {} }, { limit: 1, deadlineMs: NOW + 11_000 });
        expect(store.claim.mock.calls[0]![1]).toBeUndefined();
    });
});
