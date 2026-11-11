import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiCreditsPendingFor } from './ai-credits-pending';

// Never initialize the application pool or read shared application credentials.
vi.mock('@/server/db', () => ({ db: {} }));
const fixtureUrl = process.env.AI_CREDITS_PENDING_TEST_DATABASE_URL;
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-11T12:00:00Z');
const payload = () => ({ protocol: 'ezil-ai-credits-v1', credits: 100, expiresAt: '2026-11-12T12:00:00.000Z' });

/** Explicit disposable LOOPBACK database only; creates its own four-column fixture, never migrations. */
describe.skipIf(!fixtureUrl)('pending credit evidence with actual PostgreSQL', () => {
    let client: ReturnType<typeof postgres>, database: ReturnType<typeof drizzle>, created = false;
    beforeAll(async () => {
        const target = new URL(fixtureUrl!);
        if (!['postgres:', 'postgresql:'].includes(target.protocol)
            || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
            || !/^\/credits_pending_[a-z0-9_]+$/.test(target.pathname)) {
            throw new Error('Disposable loopback credits_pending_* database required');
        }
        client = postgres(fixtureUrl!, { max: 1, prepare: false, connect_timeout: 3, idle_timeout: 2 });
        database = drizzle(client);
        const [actual] = await client`select current_database() as name`;
        expect(actual!.name).toBe(target.pathname.slice(1));
        // No IF NOT EXISTS: refuse any preexisting table rather than touching it.
        await client`create table public.ezil_billing_outbox (
            user_id uuid not null, kind text not null, payload jsonb not null, delivered_at timestamptz
        )`;
        created = true;
    });
    beforeEach(async () => { await client`truncate public.ezil_billing_outbox`; });
    afterAll(async () => {
        try { if (created) await client`drop table public.ezil_billing_outbox`; }
        finally { await client?.end({ timeout: 2 }); }
    });
    async function insert(options: { owner?: string; kind?: string; body?: unknown; delivered?: boolean } = {}) {
        await client`insert into public.ezil_billing_outbox (user_id, kind, payload, delivered_at)
            values (${options.owner ?? OWNER}::uuid, ${options.kind ?? 'ai_grant'},
                ${JSON.stringify(options.body ?? payload())}::jsonb, ${options.delivered ? NOW.toISOString() : null}::timestamptz)`;
    }
    const pending = () => aiCreditsPendingFor(OWNER, database as Parameters<typeof aiCreditsPendingFor>[1], NOW);

    it('proves an empty negative, then reads a live whole-credit receipt', async () => {
        expect(await pending()).toBe(false);
        await insert(); expect(await pending()).toBe(true);
    });
    it.each(['2026-11-11T11:59:59Z', NOW.toISOString()])('does not report expired receipt %s', async expiresAt => {
        await insert({ body: { ...payload(), expiresAt } }); expect(await pending()).toBe(false);
    });
    it('ignores delivered, failed, foreign-owner, wrong-protocol and non-grant receipts', async () => {
        await insert({ delivered: true });
        await insert({ body: { ...payload(), delivery: { status: 'failed' } } });
        await insert({ owner: OTHER });
        await insert({ body: { ...payload(), protocol: 'wrong-protocol' } });
        await insert({ kind: 'ai_revoke' });
        expect(await pending()).toBe(false);
    });
    it.each(['100', 0, -1, 0.5, 1_000_001, null])('malformed credits %s are unknown, never false', async credits => {
        await insert({ body: { ...payload(), credits } }); expect(await pending()).toBeUndefined();
    });
    it.each(['not-a-date', null, 123])('malformed expiry %s is unknown without a guessed balance', async expiresAt => {
        await insert({ body: { ...payload(), expiresAt } }); expect(await pending()).toBeUndefined();
    });
    it('an ISO-shaped invalid calendar date causes SQL failure and omission, not false', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await insert({ body: { ...payload(), expiresAt: '2026-99-99T12:00:00Z' } });
            expect(await pending()).toBeUndefined();
            expect(warn).toHaveBeenCalledExactlyOnceWith('[billing.ai] pending credits unavailable');
            // The failed read transaction rolls back and leaves this fixture connection usable.
            expect((await client`select 1 as ok`)[0]!.ok).toBe(1);
        } finally { warn.mockRestore(); }
    });
    it('a known live receipt wins over a malformed numeric receipt, while malformed alone stays unknown', async () => {
        await insert({ body: { ...payload(), credits: 'bad' } });
        expect(await pending()).toBeUndefined();
        await insert(); expect(await pending()).toBe(true);
    });
    it('a real competing table lock times out as unknown and leaves the connection usable', async () => {
        await insert();
        const locker = postgres(fixtureUrl!, { max: 1, prepare: false, connect_timeout: 3 });
        let unlock!: () => void, locked!: () => void, lockFailed!: (error: unknown) => void;
        const release = new Promise<void>(resolve => { unlock = resolve; });
        const ready = new Promise<void>((resolve, reject) => { locked = resolve; lockFailed = reject; });
        const held = locker.begin(async tx => {
            await tx`lock table public.ezil_billing_outbox in access exclusive mode`;
            locked(); await release;
        }).catch(error => { lockFailed(error); throw error; });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await ready;
            expect(await pending()).toBeUndefined();
            expect(warn).toHaveBeenCalledExactlyOnceWith('[billing.ai] pending credits unavailable');
        } finally {
            unlock();
            try { await held; } finally { await locker.end({ timeout: 2 }); warn.mockRestore(); }
        }
        expect(await pending()).toBe(true);
    });

    it('sets actual read-only, statement and lock limits only inside its transaction', async () => {
        let observed: unknown;
        const probe = {
            transaction: async (work: Parameters<typeof database.transaction>[0], options: Parameters<typeof database.transaction>[1]) =>
                database.transaction(async tx => {
                    const result = await work(tx);
                    observed = [...await tx.execute(sql`select current_setting('transaction_read_only') as read_only,
                        current_setting('statement_timeout') as statement_timeout,
                        current_setting('lock_timeout') as lock_timeout`)];
                    return result;
                }, options),
        } as Parameters<typeof aiCreditsPendingFor>[1];
        const [before] = await client`select current_setting('statement_timeout') as statement_timeout,
            current_setting('lock_timeout') as lock_timeout`;
        expect(await aiCreditsPendingFor(OWNER, probe, NOW)).toBe(false);
        expect(observed).toEqual([{ read_only: 'on', statement_timeout: '1s', lock_timeout: '500ms' }]);
        const [after] = await client`select current_setting('statement_timeout') as statement_timeout,
            current_setting('lock_timeout') as lock_timeout`;
        expect(after).toEqual(before);
    });
});
