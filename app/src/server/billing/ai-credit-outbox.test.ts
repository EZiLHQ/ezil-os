import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { aiCreditEntitlement, aiCreditOutboxItem } from './ai-credits';
import { aiCreditBackoffMs, drainAiCreditOutbox, planAiCreditRequeue, type AiCreditOutboxRow, type AiCreditOutboxStore } from './ai-credit-outbox';
import { lookupAiAccount, missingAiAccountView, previewAiCreditRecovery, requeueFailedAiCredits } from './ai-credit-outbox-store';

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

describe('round 3 D6/D5: outbox log lines and operator requeue', () => {
    it('logs one JSON line per finished row, including a grant that expired waiting for an account', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const expired = row({ id: 'r2', attempts: 7 }); expired.payload.expiresAt = new Date(NOW).toISOString();
        const f = fixture([row(), expired]); f.store.accountFor.mockResolvedValueOnce(null);
        await f.run();
        expect(info.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([
            { event: 'ai-outbox', eventKey: row().eventKey, status: 'retry', attempts: 1, reason: 'no_ai_account' },
            { event: 'ai-outbox', eventKey: row().eventKey, status: 'failed', attempts: 7, reason: 'expired' }]);
        expect(JSON.stringify(info.mock.calls)).not.toMatch(/outbox-test-secret|works-public-id/);
        info.mockRestore();
    });
    const candidate = (over: Partial<Parameters<typeof planAiCreditRequeue>[0]> = {}) =>
        ({ ...row(), attempts: 10, lastError: 'attempts_exhausted', revoked: false, ...over });
    it.each([
        ['attempts_exhausted', {}, 'eligible'],
        ['no account', { lastError: 'no_ai_account' }, 'eligible'],
        ['gateway 503', { lastError: 'http_503' }, 'eligible'],
        ['permanent 409', { lastError: 'event_conflict' }, 'not_retryable'],
        ['permanent 400', { lastError: 'http_400' }, 'not_retryable'],
        ['revoked root', { revoked: true }, 'revoked'],
        ['restore', { kind: 'ai_restore' }, 'invalid_payload'],
    ] as const)('decides %s', (_name, over, decision) => expect(planAiCreditRequeue(candidate(over), NOW)).toBe(decision));
    it('never replays a grant past its immutable expiry, or one marked for review', () => {
        const expired = candidate({ lastError: 'expired' }); expired.payload = { ...expired.payload, expiresAt: new Date(NOW).toISOString() };
        expect(planAiCreditRequeue(expired, NOW)).toBe('still_expired');
        const review = candidate(); review.payload = { ...review.payload, delivery: { status: 'failed', reviewRequired: true } };
        expect(planAiCreditRequeue(review, NOW)).toBe('not_retryable');
    });
    it('is a dry run unless applied, and resets only eligible rows under the delivery fence', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const failed = { ...candidate(), payload: { ...row().payload, delivery: { status: 'failed', nextAttemptAt: null } } };
        const execute = vi.fn().mockResolvedValueOnce([failed, { ...failed, id: 'r2', lastError: 'event_conflict' }]);
        const dry = await requeueFailedAiCredits({ execute } as never, { eventKeys: [failed.eventKey], apply: false, now: NOW });
        expect(dry).toMatchObject({ dryRun: true, selected: 2, eligible: 1, requeued: 0,
            decisions: [{ eventKey: failed.eventKey, decision: 'eligible' }, { eventKey: failed.eventKey, lastError: 'event_conflict', decision: 'not_retryable' }] });
        expect(execute).toHaveBeenCalledTimes(1);
        execute.mockResolvedValueOnce([failed]).mockResolvedValueOnce([{ id: 'row' }]);
        expect(await requeueFailedAiCredits({ execute } as never, { userId: '11111111-1111-4111-8111-111111111111', apply: true, now: NOW }))
            .toMatchObject({ dryRun: false, requeued: 1, decisions: [{ decision: 'requeued' }] });
        const update = new PgDialect().sqlToQuery(execute.mock.calls[2]![0]);
        expect(update.sql).toMatch(/set attempts = 0, last_error = null/);
        expect(update.sql).toMatch(/attempts = \$\d+ and delivered_at is null\s+and payload->'delivery' = /);
        expect(update.params).toEqual(expect.arrayContaining([JSON.stringify({ status: 'retry', nextAttemptAt: NOW, requeuedAt: NOW,
            requeuedFrom: 'attempts_exhausted' }), 'row', 10, JSON.stringify(failed.payload.delivery)]));
        execute.mockResolvedValueOnce([failed]).mockResolvedValueOnce([]);
        expect((await requeueFailedAiCredits({ execute } as never, { eventKeys: ['x'], apply: true, now: NOW })).decisions[0]!.decision).toBe('lost_race');
        expect(info.mock.calls.map(call => JSON.parse(String(call[0])).decision)).toEqual(['eligible', 'not_retryable', 'requeued', 'lost_race']);
        info.mockRestore();
    });
    it('refuses an empty, unbounded or malformed selection before any query', async () => {
        const execute = vi.fn();
        for (const input of [{}, { eventKeys: [] }, { eventKeys: Array.from({ length: 201 }, (_, i) => `k${i}`) }, { userId: 'not-a-uuid' }, { eventKeys: [''] }]) {
            await expect(requeueFailedAiCredits({ execute } as never, { ...input, apply: false, now: NOW })).rejects.toThrow(TypeError);
        }
        expect(execute).not.toHaveBeenCalled();
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

describe('round 5 D1: drain-side enrollment for rows waiting on the AI account', () => {
    const userRow = (userId: string, overrides: Partial<AiCreditOutboxRow> = {}) => {
        const r = row(overrides); return { ...r, userId, id: `${userId}-${r.id}` };
    };
    function enrolling(rows: AiCreditOutboxRow[], results: Record<string, Awaited<ReturnType<NonNullable<AiCreditOutboxStore['enrollFor']>>>>) {
        const f = fixture(rows);
        const enrolled = new Set<string>();
        f.store.accountFor.mockImplementation(async r => enrolled.has(r.userId) ? 'works-public-id' : null);
        const enrollFor = vi.fn<NonNullable<AiCreditOutboxStore['enrollFor']>>(async userId => {
            const result = results[userId] ?? 'needs_ezil_id';
            if (result === 'enrolled') enrolled.add(userId);
            return result;
        });
        Object.assign(f.store, { enrollFor });
        return { ...f, enrollFor };
    }
    const lines = (info: ReturnType<typeof vi.spyOn>) => info.mock.calls.map(call => JSON.parse(String(call[0])));

    it('enrolls, re-resolves the account and delivers in the same pass', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const f = enrolling([userRow('u1')], { u1: 'enrolled' });
        expect(await f.run()).toMatchObject({ claimed: 1, done: 1, retry: 0, skipped: 0 });
        expect(f.enrollFor).toHaveBeenCalledExactlyOnceWith('u1');
        expect(f.store.accountFor).toHaveBeenCalledTimes(2);
        expect(f.store.pinAccount).toHaveBeenCalledWith(expect.anything(), 'works-public-id');
        expect(f.fetcher).toHaveBeenCalledOnce();
        expect(lines(info)).toEqual([{ event: 'ai-outbox', eventKey: row().eventKey, status: 'done', attempts: 1, reason: null, enroll: 'enrolled' }]);
        info.mockRestore();
    });
    it('parks needs_ezil_id rows for 24 h as a dependency wait (never failed), enrolling each user once per pass', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const f = enrolling([userRow('u1', { attempts: 71, dependencyWaits: 70 }), userRow('u1', { attempts: 71, dependencyWaits: 70 })], {});
        expect(await f.run()).toMatchObject({ claimed: 2, retry: 2, failed: 0, skipped: 2 });
        expect(f.enrollFor).toHaveBeenCalledOnce();
        for (const [, result] of f.store.finish.mock.calls) {
            expect(result).toEqual({ status: 'retry', reason: 'no_ai_account', blockedBy: 'needs_ezil_id', nextAttemptAt: NOW + 24 * 3_600_000 });
        }
        expect(lines(info).map(line => line.enroll)).toEqual(['needs_ezil_id', 'needs_ezil_id']);
        expect(f.fetcher).not.toHaveBeenCalled();
        info.mockRestore();
    });
    it.each(['refused:email_unconfirmed', 'refused:subject_mismatch', 'unavailable:timeout', 'unavailable:disabled'] as const)
    ('keeps %s as an hourly-capped no_ai_account wait with the code recorded', async code => {
        const f = enrolling([userRow('u1', { attempts: 3 })], { u1: code });
        expect(await f.run()).toMatchObject({ retry: 1, failed: 0 });
        expect(f.store.finish.mock.calls[0]![1]).toEqual({ status: 'retry', reason: 'no_ai_account', blockedBy: code, nextAttemptAt: NOW + 240_000 });
    });
    it('calls enrollFor for at most three users per pass; the rest wait without a call', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const f = enrolling(['u1', 'u2', 'u3', 'u4'].map(id => userRow(id)), {});
        await f.run();
        expect(f.enrollFor.mock.calls.map(([id]) => id)).toEqual(['u1', 'u2', 'u3']);
        expect(f.store.finish.mock.calls[3]![1]).toEqual({ status: 'retry', reason: 'no_ai_account', nextAttemptAt: NOW + 60_000 });
        expect(lines(info)[3].enroll).toBe('deferred');
        info.mockRestore();
    });
    it('does not enroll with less than the enrollment budget left before the deadline', async () => {
        const f = enrolling([userRow('u1')], { u1: 'enrolled' });
        await f.run(20, NOW + 19_999);
        expect(f.enrollFor).not.toHaveBeenCalled();
        expect(f.store.finish.mock.calls[0]![1]).toEqual({ status: 'retry', reason: 'no_ai_account', nextAttemptAt: NOW + 60_000 });
        const enough = enrolling([userRow('u1')], { u1: 'enrolled' });
        await enough.run(20, NOW + 20_000);
        expect(enough.enrollFor).toHaveBeenCalledOnce();
    });
    it('a throwing enrollFor stays an account wait, never delivery_unavailable', async () => {
        const f = enrolling([userRow('u1')], {});
        f.enrollFor.mockRejectedValue(new Error('postgres://private:secret@host'));
        await f.run();
        expect(f.store.finish.mock.calls[0]![1]).toEqual({ status: 'retry', reason: 'no_ai_account',
            blockedBy: 'unavailable:connect_failed', nextAttemptAt: NOW + 60_000 });
    });
    it('only grants trigger enrollment; an unenrolled revoke waits as before', async () => {
        const revoke = aiCreditOutboxItem('u1', aiCreditEntitlement({ userId: 'u1', sku: 'standard_monthly_v3',
            subscriptionId: 'sub', periodStart: new Date('2026-10-01Z'), periodEnd: new Date('2026-11-01Z'), invoiceId: 'in' }), 'revoke', 'in');
        const f = enrolling([{ ...revoke, id: 'rv', attempts: 1 }], { u1: 'enrolled' });
        await f.run();
        expect(f.enrollFor).not.toHaveBeenCalled();
        expect(f.store.finish.mock.calls[0]![1]).toEqual({ status: 'retry', reason: 'no_ai_account', nextAttemptAt: NOW + 60_000 });
    });
    // Review fix (r5 L1, lost wakeup): a sign-in can link, enroll and kick while this row is processing
    // (the kick skips processing rows), so the drain re-reads the account before parking it for a day.
    it('re-resolves the account before a needs_ezil_id park and delivers when a concurrent sign-in enrolled the user', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const f = enrolling([userRow('u1', { attempts: 71, dependencyWaits: 70 })], {});
        let enrolledConcurrently = false;
        f.store.accountFor.mockImplementation(async () => enrolledConcurrently ? 'works-public-id' : null);
        f.enrollFor.mockImplementation(async () => { enrolledConcurrently = true; return 'needs_ezil_id'; });
        expect(await f.run()).toMatchObject({ claimed: 1, done: 1, retry: 0, skipped: 0 });
        expect(f.store.accountFor).toHaveBeenCalledTimes(2);
        expect(f.store.pinAccount).toHaveBeenCalledWith(expect.anything(), 'works-public-id');
        expect(f.fetcher).toHaveBeenCalledOnce();
        expect(lines(info)[0]).toMatchObject({ status: 'done', enroll: 'needs_ezil_id' });
        info.mockRestore();
    });
    it('a re-resolve miss after enrolled stays an hourly-capped wait', async () => {
        const f = enrolling([userRow('u1')], {});
        f.enrollFor.mockResolvedValue('enrolled');
        await f.run();
        expect(f.store.accountFor).toHaveBeenCalledTimes(2);
        expect(f.store.finish.mock.calls[0]![1]).toEqual({ status: 'retry', reason: 'no_ai_account', blockedBy: 'enrolled', nextAttemptAt: NOW + 60_000 });
    });
});
