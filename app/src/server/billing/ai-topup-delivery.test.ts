import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aiTopupOutboxItem } from './ai-credits';
import { customTopupPack } from './catalog';
import type { AiCreditClaimScope, AiCreditOutboxRow, AiCreditOutboxStore } from './ai-credit-outbox';
import { AI_TOPUP_ADMISSION_MS, AI_TOPUP_BUDGET_MS, AI_TOPUP_REQUEST_MS, deliverPaidTopup } from './ai-topup-delivery';

const USER = '3f2f95a1-5420-4a63-94f9-79b85a1ceeb4';
const OTHER = '22222222-2222-4222-8222-222222222222';
const INTENT = 'pi_3SyntheticTopup';
const NOW = Date.parse('2026-11-26T09:00:00Z');
const CONFIG = { fundingUrl: 'https://gateway.test', fundingHmacSecret: 'topup-test-secret' };
const receipt = aiTopupOutboxItem(USER, customTopupPack(2500)!, INTENT, new Date(NOW + 365 * 86_400_000))!;
const SCOPE: AiCreditClaimScope = { userId: USER, eventKey: receipt.eventKey, kind: 'ai_grant' };

function fakeStore(rows: AiCreditOutboxRow[] = [{ ...receipt, id: 'row', attempts: 1 }], scope: AiCreditClaimScope | null = SCOPE) {
    return {
        claim: vi.fn<AiCreditOutboxStore['claim']>(async () => rows.shift() ?? null),
        accountFor: vi.fn<AiCreditOutboxStore['accountFor']>(async () => 'member-public-id'),
        pinAccount: vi.fn<AiCreditOutboxStore['pinAccount']>(async () => true),
        finish: vi.fn<AiCreditOutboxStore['finish']>(async () => undefined),
        enrollFor: vi.fn<NonNullable<AiCreditOutboxStore['enrollFor']>>(async () => 'enrolled' as const),
        topupScope: vi.fn<NonNullable<AiCreditOutboxStore['topupScope']>>(async () => scope),
    };
}
const ok = () => vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); info = vi.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('deliverPaidTopup (one scoped attempt for one paid top-up receipt)', () => {
    it('claims exactly the stored receipt\'s scope, sends its idempotent event once with a 2 s budget, and finishes it', async () => {
        const store = fakeStore(), fetcher = ok();
        expect(await deliverPaidTopup({ config: CONFIG, aiCredits: store }, { paymentIntentId: INTENT, fetch: fetcher })).toBe('delivered');
        expect(store.topupScope).toHaveBeenCalledWith({ paymentIntentId: INTENT });
        expect(store.claim).toHaveBeenCalledTimes(1);
        // Always the sole-receipt claim, whatever the store's scope answer carried: the claim re-checks for a reversal.
        expect(store.claim.mock.calls[0]![1]).toEqual({ ...SCOPE, soleReceipt: true });
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(String(fetcher.mock.calls[0]![0])).toBe('https://gateway.test/v1/integrations/entitlements');
        expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ eventId: `ezil-os:v1:topup:ai_custom_v2:${INTENT}:grant`,
            entitlementId: `ezil-os:v1:topup:ai_custom_v2:${INTENT}`, action: 'grant', credits: 250, expiresAt: expect.any(String), accountPublicId: 'member-public-id' });
        expect(store.pinAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'row' }), 'member-public-id');
        expect(store.finish).toHaveBeenCalledWith(expect.anything(), { status: 'done', reason: null }, expect.any(Number));
        // A scoped delivery never enrolls anyone: a top-up is only sold to an enrolled member.
        expect(store.enrollFor).not.toHaveBeenCalled();
        expect(AI_TOPUP_REQUEST_MS).toBe(2_000);
    });

    it('the payer\'s poll narrows the scope to the signed-in user, and a scope of anyone else is refused before any claim', async () => {
        const mine = fakeStore();
        expect(await deliverPaidTopup({ config: CONFIG, aiCredits: mine }, { paymentIntentId: INTENT, userId: USER, fetch: ok() })).toBe('delivered');
        expect(mine.topupScope).toHaveBeenCalledWith({ paymentIntentId: INTENT, userId: USER });
        // Defence in depth beside the store's own owner filter: a store that answered with another owner's row.
        const foreign = fakeStore(undefined, SCOPE), fetcher = ok();
        expect(await deliverPaidTopup({ config: CONFIG, aiCredits: foreign }, { paymentIntentId: INTENT, userId: OTHER, fetch: fetcher })).toBe('skipped');
        expect(foreign.claim).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([{ fundingUrl: undefined, fundingHmacSecret: 'secret' }, { fundingUrl: 'https://gateway.test', fundingHmacSecret: undefined },
        { fundingUrl: undefined, fundingHmacSecret: undefined }])('a deliverable receipt while funding is not configured (%j) is pending, not "nothing to deliver": no claim, one fixed warning', async config => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const store = fakeStore(), fetcher = ok();
        expect(await deliverPaidTopup({ config, aiCredits: store }, { paymentIntentId: INTENT, fetch: fetcher })).toBe('queued');
        expect(store.topupScope).toHaveBeenCalledWith({ paymentIntentId: INTENT });
        // No attempt or backoff is spent while it cannot be sent; restoring the configuration delivers it.
        expect(store.claim).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled();
        expect(warn.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([{ event: 'ai-topup-delivery', status: 'pending', attempts: null, reason: 'funding_unconfigured' }]);
        expect(await deliverPaidTopup({ config: CONFIG, aiCredits: store }, { paymentIntentId: INTENT, fetch: fetcher })).toBe('delivered');
        // With no receipt of this payment, missing configuration is still nothing to deliver, and says nothing.
        warn.mockClear();
        expect(await deliverPaidTopup({ config, aiCredits: fakeStore(undefined, null) }, { paymentIntentId: INTENT, fetch: fetcher })).toBe('skipped');
        expect(warn).not.toHaveBeenCalled();
    });

    it('skips, claiming nothing, when the payment has no deliverable receipt or the store cannot scope', async () => {
        const fetcher = ok();
        const none = fakeStore(undefined, null);
        expect(await deliverPaidTopup({ config: CONFIG, aiCredits: none }, { paymentIntentId: INTENT, fetch: fetcher })).toBe('skipped');
        expect(none.claim).not.toHaveBeenCalled();
        expect(await deliverPaidTopup({ config: CONFIG }, { paymentIntentId: INTENT, fetch: fetcher })).toBe('skipped');
        const legacy = { ...fakeStore(), topupScope: undefined };
        expect(await deliverPaidTopup({ config: CONFIG, aiCredits: legacy }, { paymentIntentId: INTENT, fetch: fetcher })).toBe('skipped');
        expect(legacy.claim).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('admission is one clock observation: a clock that ticks on every read never refuses the default budget', async () => {
        let at = NOW;
        const clock = vi.fn(() => at++);
        const store = fakeStore(), fetcher = ok();
        expect(await deliverPaidTopup({ config: CONFIG, aiCredits: store }, { paymentIntentId: INTENT, fetch: fetcher, clock })).toBe('delivered');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(AI_TOPUP_BUDGET_MS).toBeGreaterThan(AI_TOPUP_ADMISSION_MS);
    });

    it('a caller\'s deadline under 3.25 s is skipped with nothing read or claimed; exactly 3.25 s is admitted', async () => {
        const short = fakeStore();
        expect(await deliverPaidTopup({ config: CONFIG, aiCredits: short }, { paymentIntentId: INTENT, deadlineAt: NOW + AI_TOPUP_ADMISSION_MS - 1, fetch: ok() })).toBe('skipped');
        expect(short.topupScope).not.toHaveBeenCalled();
        const exact = fakeStore();
        expect(await deliverPaidTopup({ config: CONFIG, aiCredits: exact }, { paymentIntentId: INTENT, deadlineAt: NOW + AI_TOPUP_ADMISSION_MS, fetch: ok() })).toBe('delivered');
    });

    it.each([
        ['a Gateway 503', async () => new Response(null, { status: 503 }), 'http_503'],
        ['a network failure', async () => { throw new Error('socket closed https://gateway.test/secret'); }, 'transport_unavailable'],
        ['a missing Gateway account', async () => Response.json({ error: { code: 'account_not_found' } }, { status: 404 }), 'account_not_found'],
    ] as const)('pending exit: %s leaves the receipt queued in its normal retry state, with no alert', async (_name, respond, reason) => {
        const store = fakeStore();
        const fetcher = vi.fn<typeof fetch>(respond as () => Promise<Response>);
        const alert = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await deliverPaidTopup({ config: CONFIG, aiCredits: store }, { paymentIntentId: INTENT, fetch: fetcher })).toBe('queued');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(store.finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'retry', reason }), expect.any(Number));
        expect(alert).not.toHaveBeenCalled();
    });

    it.each([
        ['the Gateway refuses the event', [{ ...receipt, id: 'row', attempts: 1 }], async () => Response.json({ error: { code: 'event_conflict', message: 'body for pi_x' } }, { status: 409 }), 'event_conflict', 1],
        ['the Gateway rejects the request', [{ ...receipt, id: 'row', attempts: 1 }], async () => new Response('denied for member-public-id', { status: 403 }), 'http_403', 1],
        ['its attempts ran out', [{ ...receipt, id: 'row', attempts: 11, exhausted: true }], async () => new Response(null, { status: 204 }), 'attempts_exhausted', 0],
    ] as const)('permanent exit: %s ends in review with one sanitized alert, and is never reported as delivered or pending', async (_name, rows, respond, reason, requests) => {
        const store = fakeStore(rows.map(row => ({ ...row })));
        const fetcher = vi.fn<typeof fetch>(respond as () => Promise<Response>);
        const alert = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await deliverPaidTopup({ config: CONFIG, aiCredits: store }, { paymentIntentId: INTENT, userId: USER, fetch: fetcher })).toBe('review');
        expect(fetcher).toHaveBeenCalledTimes(requests);
        expect(store.finish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'failed', reason }), expect.any(Number));
        expect(alert).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(alert.mock.calls[0]![0]))).toEqual({ event: 'ai-topup-delivery-alert', alert: 'paid_topup_not_credited', reason });
        const logged = [...alert.mock.calls, ...info.mock.calls].map(call => String(call[0])).join('\n');
        for (const needle of [INTENT, 'pi_', 'ezil-os:v1:topup', USER, 'member-public-id', 'body for', 'denied']) expect(logged).not.toContain(needle);
    });

    it('a receipt that is not due or is leased by another worker (no claim) is queued without a request', async () => {
        const store = fakeStore([]), fetcher = ok();
        expect(await deliverPaidTopup({ config: CONFIG, aiCredits: store }, { paymentIntentId: INTENT, fetch: fetcher })).toBe('queued');
        expect(store.claim).toHaveBeenCalledTimes(1);
        expect(fetcher).not.toHaveBeenCalled();
        expect(store.finish).not.toHaveBeenCalled();
    });

    it('never throws: a failing scope read, claim or finish is queued', async () => {
        for (const broken of ['topupScope', 'claim', 'finish'] as const) {
            const store = fakeStore();
            store[broken].mockRejectedValue(new Error('db down postgres://user:secret@host/db'));
            await expect(deliverPaidTopup({ config: CONFIG, aiCredits: store }, { paymentIntentId: INTENT, fetch: ok() })).resolves.toBe('queued');
        }
    });

    it('logs one fixed-shape line per attempt, with no payment, receipt, user or account id in it', async () => {
        await deliverPaidTopup({ config: CONFIG, aiCredits: fakeStore() }, { paymentIntentId: INTENT, userId: USER, fetch: ok() });
        await deliverPaidTopup({ config: CONFIG, aiCredits: fakeStore() }, { paymentIntentId: INTENT, fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })) });
        const lines = info.mock.calls.map(call => String(call[0]));
        expect(lines.map(line => JSON.parse(line))).toEqual([
            { event: 'ai-topup-delivery', status: 'done', attempts: 1, reason: null },
            { event: 'ai-topup-delivery', status: 'retry', attempts: 1, reason: 'http_503' },
        ]);
        for (const needle of [INTENT, 'pi_', receipt.eventKey, 'ezil-os:v1:topup', USER, 'member-public-id', 'ai-outbox']) {
            expect(lines.join('\n')).not.toContain(needle);
        }
    });
});
