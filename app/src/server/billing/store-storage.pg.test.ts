import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '@/server/db/schema';
import { authUsers, billingStorageSamples } from '@/server/db/schema';
import { createBillingStore } from './store';

type Database = typeof import('@/server/db').db;

/**
 * `insertStorageSampleOnce` against a disposable migrated database: the host agent's
 * retried sample is one row, even when the retries race. The table is append-only, so the
 * race case leaves its committed rows (random ids) behind; run it on a throwaway database.
 */
describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('host storage samples are recorded once (Postgres)', () => {
    let client: ReturnType<typeof postgres>;
    let db: Database;

    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 8, prepare: false });
        db = drizzle(client, { schema }) as unknown as Database;
    });

    afterAll(async () => {
        await client?.end();
    });

    it('records the first sample, answers a retry as duplicate, and keeps distinct instants and sources', async () => {
        class Rollback extends Error {}
        await expect(db.transaction(async tx => {
            const store = createBillingStore(tx as unknown as Database);
            const userId = randomUUID();
            const computerId = randomUUID();
            await tx.insert(authUsers).values({ id: userId });
            const at = new Date('2026-11-01T12:00:00Z');
            const sample = { computerId, bytes: BigInt(1024), measuredAt: at, source: 'host-agent' };
            expect(await store.insertStorageSampleOnce!(userId, sample)).toBe('recorded');
            expect(await store.insertStorageSampleOnce!(userId, sample)).toBe('duplicate');
            expect(await store.insertStorageSampleOnce!(userId, { ...sample, bytes: BigInt(1) })).toBe('duplicate');
            // Positive controls: a later instant and another source are new samples.
            const later = new Date('2026-11-01T12:15:00Z');
            expect(await store.insertStorageSampleOnce!(userId, { ...sample, measuredAt: later, bytes: BigInt(4096) })).toBe('recorded');
            expect(await store.insertStorageSampleOnce!(userId, { ...sample, source: 'worker' })).toBe('recorded');
            const rows = await tx.select().from(billingStorageSamples).where(eq(billingStorageSamples.computerId, computerId));
            expect(rows).toHaveLength(3);
            expect(await store.latestStorageFor(userId)).toEqual([{ computerId, bytes: BigInt(4096), measuredAt: later }]);
            throw new Rollback();
        })).rejects.toBeInstanceOf(Rollback);
    });

    it('records one row when eight retries of the same sample race on separate connections', async () => {
        const store = createBillingStore(db);
        const userId = randomUUID();
        const computerId = randomUUID();
        await db.insert(authUsers).values({ id: userId });
        const sample = { computerId, bytes: BigInt(2048), measuredAt: new Date('2026-11-01T12:30:00Z'), source: 'host-agent' };
        const outcomes = await Promise.all(Array.from({ length: 8 }, () => store.insertStorageSampleOnce!(userId, sample)));
        expect(outcomes.filter(o => o === 'recorded')).toHaveLength(1);
        expect(outcomes.filter(o => o === 'duplicate')).toHaveLength(7);
        const rows = await db.select().from(billingStorageSamples).where(eq(billingStorageSamples.computerId, computerId));
        expect(rows).toHaveLength(1);
    });
});
