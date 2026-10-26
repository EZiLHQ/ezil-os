import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { aiCreditEntitlement, aiCreditOutboxItem } from './ai-credits';
import { aiCreditBackoffMs, drainAiCreditOutbox, type AiCreditOutboxRow, type AiCreditOutboxStore } from './ai-credit-outbox';
import { lookupAiAccount, missingAiAccountView, previewAiCreditRecovery } from './ai-credit-outbox-store';

const NOW = Date.parse('2026-10-21T00:00:00Z');
function row(overrides: Partial<AiCreditOutboxRow> = {}): AiCreditOutboxRow {
    const item = aiCreditOutboxItem('user', aiCreditEntitlement({ userId: 'user', sku: 'standard_monthly_v3',
        subscriptionId: 'sub', periodStart: new Date('2026-10-01Z'), periodEnd: new Date('2026-11-01Z'), invoiceId: 'in' }), 'grant', 'in');
    return { ...item, id: 'row', attempts: 1, ...overrides };
}
function fixture(rows = [row()]) {
    let now = NOW;
    const store = {
        claim: vi.fn<AiCreditOutboxStore['claim']>(async () => rows.shift() ?? null),
        accountFor: vi.fn<AiCreditOutboxStore['accountFor']>().mockResolvedValue('works-public-id'),
        pinAccount: vi.fn<AiCreditOutboxStore['pinAccount']>().mockResolvedValue(true),
        finish: vi.fn<AiCreditOutboxStore['finish']>().mockResolvedValue(undefined),
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const log = vi.fn();
    const config = { fundingUrl: 'https://gateway.test', fundingHmacSecret: 'outbox-test-secret' };
    const deps = { config, aiCredits: store, clock: () => now, fetch: fetcher, log };
    return { store, rows, fetcher, log, deps, setNow: (value: number) => { now = value; },
        run: (limit = 20, deadlineMs = now + 40_000) => drainAiCreditOutbox(deps, { limit, deadlineMs }) };
}

describe('AI credit outbox delivery', () => {
    it('delivers only after freezing the Works public id, with no internal metadata on the wire', async () => {
        const f = fixture();
        f.fetcher.mockImplementation(async () => {
            expect(f.store.pinAccount).toHaveBeenCalledTimes(1);
            return new Response(null, { status: 204 });
        });
        expect(await f.run()).toEqual({ claimed: 1, done: 1, failed: 0, retry: 0, skipped: 0 });
        const body = JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string);
        expect(body).toEqual({ eventId: row().eventKey, entitlementId: row().payload.entitlementId, action: 'grant',
            credits: 200, expiresAt: '2026-11-04T00:00:00.000Z', accountPublicId: 'works-public-id' });
        expect(f.store.finish).toHaveBeenCalledWith(expect.anything(), { status: 'done', reason: null }, NOW);
    });
    it('preserves a frozen account id on retry without looking up a changed mapping', async () => {
        const r = row(); r.payload.accountPublicId = 'original-account';
        const f = fixture([r]); await f.run();
        expect(f.store.accountFor).not.toHaveBeenCalled();
        expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string).accountPublicId).toBe('original-account');
    });
    it.each([500, 502, 503])('retries %s with persisted exponential backoff', async status => {
        const f = fixture([row({ attempts: 3 })]);
        f.fetcher.mockResolvedValue(new Response(null, { status }));
        expect(await f.run()).toMatchObject({ retry: 1 });
        expect(f.store.finish).toHaveBeenCalledWith(expect.anything(), { status: 'retry', reason: `http_${status}`, nextAttemptAt: NOW + 240_000 }, NOW);
    });
    it('caps backoff at one hour', () => {
        expect([1, 2, 3, 7, 9, 10].map(aiCreditBackoffMs)).toEqual([60_000, 120_000, 240_000, 3_600_000, 3_600_000, 3_600_000]);
    });
    it('fails on the tenth retryable attempt and never sends an eleventh after a crashed final lease', async () => {
        const f = fixture([row({ attempts: 10 })]);
        f.fetcher.mockRejectedValue(new Error('secret token'));
        expect(await f.run()).toMatchObject({ failed: 1, retry: 0 });
        expect(f.store.finish.mock.calls[0]![1]).toEqual({ status: 'failed', reason: 'attempts_exhausted' });
        const crashed = fixture([row({ attempts: 10, exhausted: true })]);
        await crashed.run();
        expect(crashed.fetcher).not.toHaveBeenCalled();
        expect(crashed.store.finish.mock.calls[0]![1]).toEqual({ status: 'failed', reason: 'attempts_exhausted' });
    });
    it.each([400, 401, 403, 409, 422, 429])('permanently fails HTTP %s without rescheduling', async status => {
        const f = fixture(); f.fetcher.mockResolvedValue(new Response(null, { status }));
        expect(await f.run()).toMatchObject({ failed: 1, retry: 0 });
        expect(f.store.finish.mock.calls[0]![1]).toEqual({ status: 'failed', reason: `http_${status}` });
    });
    it('waits for no_ai_account without a call or fabricated mapping', async () => {
        const f = fixture(); f.store.accountFor.mockResolvedValue(null);
        expect(await f.run()).toMatchObject({ skipped: 1, retry: 1, failed: 0 });
        expect(f.store.finish.mock.calls[0]![1]).toEqual({ status: 'retry', reason: 'no_ai_account', nextAttemptAt: NOW + 60_000 });
        expect(f.fetcher).not.toHaveBeenCalled(); expect(f.store.pinAccount).not.toHaveBeenCalled();
    });
    it.each(['lookup', 'gateway'] as const)('retains %s account waits beyond ten attempts and delivers when ready', async missing => {
        const f = fixture([row({ attempts: 25, dependencyWaits: 24 })]);
        if (missing === 'lookup') f.store.accountFor.mockResolvedValue(null);
        else f.fetcher.mockResolvedValue(Response.json({ error: { code: 'account_not_found' } }, { status: 404 }));
        expect(await f.run()).toMatchObject({ retry: 1, failed: 0 });
        expect(f.store.finish.mock.calls[0]![1]).toMatchObject({ status: 'retry', nextAttemptAt: NOW + 3_600_000 });
        f.rows.push(row({ attempts: 26, dependencyWaits: 25 }));
        f.store.accountFor.mockResolvedValue('pinned-account');
        f.fetcher.mockResolvedValue(new Response(null, { status: 204 }));
        expect(await f.run()).toMatchObject({ done: 1, failed: 0 });
    });
    it('retains the normal delivery failure budget after prolonged enrollment waiting', async () => {
        const f = fixture([row({ attempts: 26, dependencyWaits: 25 })]);
        f.fetcher.mockResolvedValue(new Response(null, { status: 503 }));
        expect(await f.run()).toMatchObject({ retry: 1, failed: 0 });
    });
    it.each(['fundingUrl', 'fundingHmacSecret'] as const)('does nothing when %s is missing and logs once', async key => {
        const f = fixture();
        const deps = { ...f.deps, config: { ...f.deps.config, [key]: undefined } };
        const result = await drainAiCreditOutbox(deps, { limit: 20, deadlineMs: NOW + 40_000 });
        await drainAiCreditOutbox(deps, { limit: 20, deadlineMs: NOW + 40_000 });
        expect(result.claimed).toBe(0);
        expect(f.store.claim).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
        expect(f.log).toHaveBeenCalledTimes(key === 'fundingUrl' ? 1 : 0);
        expect(JSON.stringify(f.log.mock.calls)).not.toContain('outbox-test-secret');
    });
    it.each([0, 1, 2])('honors row limit %s', async limit => {
        const f = fixture([row(), row(), row()]); await f.run(limit);
        expect(f.fetcher).toHaveBeenCalledTimes(limit); expect(f.store.claim).toHaveBeenCalledTimes(limit);
    });
    it('clamps excessively large limits', async () => {
        const f = fixture(Array.from({ length: 201 }, () => row())); await f.run(9999);
        expect(f.fetcher).toHaveBeenCalledTimes(200);
    });
    it('does not claim without enough time for the ten-second request and finishing', async () => {
        const f = fixture(); await f.run(20, NOW + 10_999);
        expect(f.store.claim).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    });
    it('stops between rows when the shared deadline is reached', async () => {
        const f = fixture([row(), row()]);
        f.fetcher.mockImplementation(async () => { f.setNow(NOW + 30_000); return new Response(null, { status: 204 }); });
        await f.run(); expect(f.store.claim).toHaveBeenCalledTimes(1); expect(f.fetcher).toHaveBeenCalledTimes(1);
    });
    it.each(['lookup', 'pin'] as const)('rechecks the deadline after %s', async slow => {
        const f = fixture();
        if (slow === 'lookup') f.store.accountFor.mockImplementation(async () => { f.setNow(NOW + 35_000); return 'account'; });
        else f.store.pinAccount.mockImplementation(async () => { f.setNow(NOW + 35_000); return true; });
        await f.run(); expect(f.fetcher).not.toHaveBeenCalled();
        expect(f.store.finish.mock.calls[0]![1].reason).toBe('deadline_or_lease');
    });
    it('does not send after losing the claim', async () => {
        const f = fixture(); f.store.pinAccount.mockResolvedValue(false);
        await f.run(); expect(f.fetcher).not.toHaveBeenCalled();
    });
    it('skips expired grants but delivers a revoke for an expired period', async () => {
        const r = row(); r.payload.expiresAt = new Date(NOW).toISOString();
        const f = fixture([r]); await f.run();
        expect(f.fetcher).not.toHaveBeenCalled(); expect(f.store.finish.mock.calls[0]![1].reason).toBe('expired');
        r.payload.action = 'revoke'; r.payload.eventId = `${r.payload.entitlementId}:revoke`; r.eventKey = r.payload.eventId as string; r.kind = 'ai_revoke';
        const revoke = fixture([r]); await revoke.run(); expect(revoke.fetcher).toHaveBeenCalledTimes(1);
    });
    it.each([{ protocol: 'legacy' }, { entitlementId: 'bad id' }, { action: 'restore' }, { eventId: 'wrong' },
        { credits: 0 }, { credits: 1.5 }, { credits: 1_000_001 }, { expiresAt: 'invalid' }])('rejects malformed payload %j', change => {
        const r = row(); Object.assign(r.payload, change);
        const f = fixture([r]);
        return f.run().then(() => {
            expect(f.fetcher).not.toHaveBeenCalled(); expect(f.store.finish.mock.calls[0]![1].reason).toBe('invalid_payload');
        });
    });
    it('rejects a mismatching row event key or kind', async () => {
        for (const change of [{ eventKey: 'other' }, { kind: 'ai_revoke' }]) {
            const f = fixture([row(change)]); await f.run(); expect(f.fetcher).not.toHaveBeenCalled();
        }
    });
    it('redacts SQL and HTTP errors in both logs and persisted failure reasons', async () => {
        const f = fixture(); f.store.accountFor.mockRejectedValue(new Error('postgres://secret JWT'));
        await f.run(); expect(f.store.finish.mock.calls[0]![1].reason).toBe('delivery_unavailable');
        expect(JSON.stringify([f.log.mock.calls, f.store.finish.mock.calls])).not.toMatch(/postgres:|JWT|outbox-test-secret/);
    });
});

describe('Works account lookup', () => {
    it('performs a parameterized read-only lookup of the real Works public_id', async () => {
        const execute = vi.fn().mockResolvedValue([]);
        const userId = "user'; not SQL";
        await lookupAiAccount({ execute } as unknown as Parameters<typeof lookupAiAccount>[0], userId);
        const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
        expect(query.sql).toBe('select public_id from ezil_works.ai_members where auth_user_id = $1::uuid limit 1');
        expect(query.params).toEqual([userId]);
    });
    it.each(['42P01', '3F000'])('treats missing schema/view %s as absent, including Drizzle causes', async code => {
        const execute = vi.fn().mockRejectedValue({ cause: { code } });
        expect(await lookupAiAccount({ execute } as unknown as Parameters<typeof lookupAiAccount>[0], 'user')).toBeNull();
        expect(execute).toHaveBeenCalledTimes(1);
    });
    it.each([{ rows: [] }, { rows: [{ public_id: null }] }, { rows: [{ public_id: 'works-id' }] }])('returns only the mapped public_id %j', async ({ rows }) => {
        const execute = vi.fn().mockResolvedValue(rows);
        expect(await lookupAiAccount({ execute } as unknown as Parameters<typeof lookupAiAccount>[0], 'user')).toBe(rows[0]?.public_id ?? null);
    });
    it.each(['42501', '08006', undefined])('does not swallow non-missing database errors %s', async code => {
        const error = { code, message: 'credential' };
        const execute = vi.fn().mockRejectedValue(error);
        await expect(lookupAiAccount({ execute } as unknown as Parameters<typeof lookupAiAccount>[0], 'user')).rejects.toBe(error);
        expect(missingAiAccountView(error)).toBe(false);
    });
});

describe('explicit dry-run AI recovery', () => {
    it('selects only requested, valid, unexpired account failures without writes or legacy conversion', async () => {
        const make = (key: string, lastError: string | null, overrides: Partial<ReturnType<typeof row>> = {}) => {
            const value = row();
            const entitlementId = `ezil-os:v1:free-once:${key}`;
            return { ...value, ...overrides, eventKey: `${entitlementId}:grant`, deliveredAt: null, lastError,
                payload: { ...value.payload, entitlementId, eventId: `${entitlementId}:grant`, delivery: { status: 'failed' }, ...overrides.payload } };
        };
        const eligible = make('eligible', 'no_ai_account');
        const gateway = make('gateway', 'account_not_found');
        const exhausted = make('exhausted', 'attempts_exhausted');
        const ambiguous404 = make('unknown404', 'http_404');
        const expired = make('expired', 'no_ai_account', { payload: { expiresAt: new Date(NOW).toISOString() } });
        const done = { ...make('done', 'no_ai_account'), deliveredAt: new Date(NOW).toISOString() };
        const legacy = make('legacy', 'no_ai_account', { payload: { protocol: undefined, amountUsdMicro: '10000000' } });
        const rows = [eligible, gateway, exhausted, ambiguous404, expired, done, legacy];
        const execute = vi.fn().mockResolvedValue(rows);
        const eventKeys = [...rows.map(value => value.eventKey), 'missing'];
        const result = await previewAiCreditRecovery({ execute } as unknown as Parameters<typeof previewAiCreditRecovery>[0], { eventKeys, now: NOW });
        expect(result).toMatchObject({ dryRun: true, selected: 8, eligible: 2, legacyCount: 1 });
        expect(result.decisions.map(value => value.reason)).toEqual(['eligible_dependency_wait', 'eligible_dependency_wait',
            'unproven_dependency_failure', 'unproven_dependency_failure', 'expired', 'already_delivered', 'unsupported_protocol', 'not_found']);
        const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
        expect(query.sql).toMatch(/^select /);
        expect(query.sql).not.toMatch(/\b(update|insert|delete)\b/i);
        expect(query.params).toEqual(eventKeys);
    });
    it('does not query for an empty selection and rejects unbounded selections', async () => {
        const execute = vi.fn();
        const db = { execute } as unknown as Parameters<typeof previewAiCreditRecovery>[0];
        expect(await previewAiCreditRecovery(db, { eventKeys: [], now: NOW })).toMatchObject({ dryRun: true, selected: 0 });
        await expect(previewAiCreditRecovery(db, { eventKeys: Array(201).fill('key'), now: NOW })).rejects.toThrow(TypeError);
        expect(execute).not.toHaveBeenCalled();
    });
});

describe('W0.3 restore delivery', () => {
    function restore(overrides: Partial<AiCreditOutboxRow> = {}) {
        const r = row(overrides);
        r.kind = 'ai_restore';
        r.eventKey = `${r.payload.entitlementId}:restore:dp_D`;
        r.payload = { ...r.payload, eventId: r.eventKey, action: 'restore' };
        return r;
    }
    it('keeps hold waits durable beyond ten attempts, then records the explicit result', async () => {
        const r = restore({ attempts: 26, dependencyWaits: 25 });
        const f = fixture([r]);
        f.fetcher.mockResolvedValue(Response.json({ error: { code: 'restore_hold_pending' } }, { status: 409 }));
        expect(await f.run()).toMatchObject({ retry: 1, failed: 0 });
        expect(f.store.finish.mock.calls[0]![1]).toMatchObject({ status: 'retry', reason: 'restore_hold_pending', nextAttemptAt: NOW + 3_600_000 });
        f.rows.push(restore({ attempts: 27, dependencyWaits: 26 }));
        f.fetcher.mockResolvedValue(Response.json({ event_id: r.eventKey, outcome: 'restored' }));
        expect(await f.run()).toMatchObject({ done: 1 });
        expect(f.store.finish.mock.calls[1]![1]).toEqual({ status: 'done', reason: null, outcome: 'restored' });
    });
    it.each(['restore_expired', 'restore_nothing_forfeited', 'restore_refused_terminal'])('delivers expired restore requests to obtain %s', async outcome => {
        const r = restore(); r.payload.expiresAt = new Date(NOW - 1).toISOString();
        const f = fixture([r]);
        f.fetcher.mockResolvedValue(Response.json({ event_id: r.eventKey, outcome }));
        expect(await f.run()).toMatchObject({ done: 1, failed: 0 });
        expect(f.store.finish.mock.calls[0]![1]).toEqual({ status: 'done', reason: null, outcome });
    });
    it.each(['restore_mismatch', 'restore_not_revoked', 'restore_review_required'])('persists manual review for %s without retrying', async code => {
        const f = fixture([restore()]);
        f.fetcher.mockResolvedValue(Response.json({ error: { code, message: 'private upstream text' } }, { status: 409 }));
        expect(await f.run()).toMatchObject({ failed: 1, retry: 0 });
        expect(f.store.finish.mock.calls[0]![1]).toEqual({ status: 'failed', reason: code, reviewRequired: true });
        expect(JSON.stringify(f.log.mock.calls)).not.toContain('private upstream text');
    });
});

describe('restore receipt conflicts after enqueue', () => {
    it.each(['terminal', 'review', 'mismatch'] as const)('refuses %s without a funding request', async disposition => {
        const r = row(); r.kind = 'ai_restore'; r.eventKey = `${r.payload.entitlementId}:restore:dp_D`;
        r.payload = { ...r.payload, action: 'restore', eventId: r.eventKey };
        if (disposition === 'mismatch') r.restoreConflict = true;
        else r.restoreDisposition = disposition;
        const f = fixture([r]); await f.run();
        expect(f.fetcher).not.toHaveBeenCalled();
        expect(f.store.finish.mock.calls[0]![1]).toEqual(disposition === 'terminal'
            ? { status: 'done', reason: null, outcome: 'restore_refused_terminal' }
            : { status: 'failed', reason: disposition === 'review' ? 'restore_review_required' : 'restore_mismatch', reviewRequired: true });
    });
});
