import { Buffer } from 'node:buffer';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { placementRow, DEFAULT_OWNER } from './fake-placement-db.test-support';
import {
    consumeEnrollmentNonce, createPlacement, lockImagePlacement, parsePlacementRow,
    reconcileReplacementGeneration, setImageReservation, transitionPlacement, withAdmission, writeImagePlacement,
    type PlacementDb, type PlacementExecutor,
} from './placement';

const computerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = new Date('2026-10-22T12:34:56.789Z');
const timestampFields = ['enrollExpiresAt', 'lowerDigestObservedAt', 'leaseUntil', 'presenceAt'] as const;
const dialect = new PgDialect();

// Capture the real SQL without pretending to implement PostgreSQL precision.
// placement.pg.test.ts checks persisted values and races through the real driver.
function capture() {
    const row = placementRow({ computer_id: computerId, state: 'LEASED', generation: 2, lease_epoch: 4,
        lifecycle_job_id: jobId, lifecycle_digest: 'a'.repeat(64), fence_token: jobId, volume_id: 'vol-11111111111111111',
        lower_image_digest: null, lower_digest_observed_at: null, image_upgrade_job_id: null });
    const statements: ReturnType<PgDialect['sqlToQuery']>[] = [];
    const tx: PlacementExecutor = { execute: async q => {
        const query = dialect.sqlToQuery(q);
        statements.push(query);
        if (/placement:lock-/.test(query.sql)) return [{ isolation: 'read committed' }];
        if (/placement:image-reservation/.test(query.sql)) return [];
        return [row];
    } };
    const db: PlacementDb = { ...tx, transaction: fn => fn(tx) };
    const statement = (tag: string) => {
        const found = statements.find(q => q.sql.includes(`/* placement:${tag} */`));
        expect(found).toBeDefined();
        return found!;
    };
    return { row, db, statement };
}

describe('placement timestamp binds with production codecs', () => {
    it('reproduces the Date Bind failure without opening a socket', async () => {
        const client = postgres({ host: '127.0.0.1', database: 'unused', username: 'unused', password: 'unused',
            max: 10, idle_timeout: 20, prepare: false });
        try {
            drizzle(client);
            const serialize = client.options.serializers[1184]!;
            expect(serialize(at)).toBe(at);
            // Intentionally pass the driver's runtime value to the Bind length
            // operation, including the invalid Date case TypeScript would reject.
            expect(() => Buffer.byteLength(serialize(at) as string)).toThrow(/string|Buffer/);
            expect(Buffer.byteLength(serialize(at.toISOString()) as string)).toBe(24);
        } finally { await client.end(); }
    });

    it.each(timestampFields)('binds image %s as ISO text', async key => {
        const c = capture();
        await withAdmission(c.db, async (tx, lock) => {
            const p = (await lockImagePlacement(tx, lock, computerId))!;
            await writeImagePlacement(tx, lock, p, { [key]: at });
        });
        const query = c.statement('image-write');
        expect(query.params[0]).toBe(at.toISOString());
        expect(query.params.some(v => v instanceof Date)).toBe(false);
        expect(query.sql).toContain('$1::timestamptz');
    });

    it.each(timestampFields)('keeps image %s NULL', async key => {
        const c = capture();
        await withAdmission(c.db, async (tx, lock) => {
            const p = (await lockImagePlacement(tx, lock, computerId))!;
            await writeImagePlacement(tx, lock, p, { [key]: null });
        });
        expect(c.statement('image-write').params[0]).toBeNull();
    });

    it('normalizes the ordinary enrollment digest observation bind', async () => {
        const c = capture();
        await consumeEnrollmentNonce(c.db, { computerId, expected: { state: 'STARTING', generation: 2, leaseEpoch: 4 },
            nonceHash: 'a'.repeat(64), fields: { instanceId: 'i-11111111111111111', volumeId: 'vol-11111111111111111' },
            lowerImageDigest: `sha256:${'a'.repeat(64)}`, observedAt: at });
        const query = c.statement('enroll-digest');
        expect(query.params[1]).toBe(at.toISOString());
        expect(query.params.some(v => v instanceof Date)).toBe(false);
        expect(query.sql).toContain('lower_digest_observed_at = $2::timestamptz');
    });
});

describe('placement updated_at SQL contract', () => {
    it('creates placements with whole milliseconds', async () => {
        const c = capture();
        const db: PlacementDb = { ...c.db, transaction: fn => c.db.transaction(tx => fn({ execute: q =>
            dialect.sqlToQuery(q).sql.includes('/* placement:read */') ? Promise.resolve([]) : tx.execute(q) })) };
        await createPlacement(db, { computerId, ownerUserId: DEFAULT_OWNER, provider: 'cloudflare', state: 'STOPPED' });
        expect(c.statement('insert').sql).toContain("date_trunc('milliseconds', now())");
    });

    it.each(['cas', 'image-cas', 'image-write'])('%s advances whole milliseconds even when now() repeats', async tag => {
        const c = capture();
        if (tag === 'cas') await transitionPlacement(c.db, { computerId, ownerUserId: DEFAULT_OWNER,
            expected: { state: 'LEASED', generation: 2, leaseEpoch: 4 }, to: 'STARTING' });
        else await withAdmission(c.db, async (tx, lock) => {
            const p = (await lockImagePlacement(tx, lock, computerId))!;
            if (tag === 'image-cas') await setImageReservation(tx, lock, p, jobId);
            else await writeImagePlacement(tx, lock, p, { lastError: 'test' });
        });
        expect(c.statement(tag).sql).toContain("updated_at = GREATEST(date_trunc('milliseconds', now()), date_trunc('milliseconds', updated_at) + interval '1 millisecond')");
    });

    it('keeps the exact timestamp and owner CAS predicates', async () => {
        const c = capture(), expected = parsePlacementRow(c.row, computerId);
        await reconcileReplacementGeneration(c.db, expected, { generation: 1, fenceToken: jobId,
            instanceId: 'i-11111111111111111', instanceLost: true });
        const query = c.statement('cas');
        expect(query.sql).toMatch(/AND updated_at = \$\d+::timestamptz/);
        expect(query.sql).toMatch(/AND owner_user_id = \$\d+::uuid/);
        expect(query.params).toContain(expected.updatedAt.toISOString());
    });
});
