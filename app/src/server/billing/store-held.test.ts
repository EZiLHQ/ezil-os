/** Round 6 R1-01: the held bound's candidate read, against the billing test database (BILLING_TEST_DATABASE_URL). */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '@/server/db/schema';
import { runningAwsComputersAfterEpochs, type HeldCandidate } from './store';

type Database = typeof import('@/server/db').db;
// Far ahead of any other suite's rows, so this suite's closes sort first (newest close first) without touching theirs.
const NOW = new Date('2090-01-01T07:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('runningAwsComputersAfterEpochs with Postgres', () => {
    let client: ReturnType<typeof postgres>;
    let db: Database;
    /** The computers this test made: other suites' rows (committed or not) are never this test's to assert or lock. */
    let mine: Set<string>;

    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
        db = drizzle(client, { schema });
    });
    // Everything, the placement tables included, lives in one rolled-back transaction.
    beforeEach(async () => {
        mine = new Set();
        await client`begin`;
        for (const file of ['0001_compute_placement.sql.txt', '0002_image_rebase.sql.txt'])
            await client.unsafe(readFileSync(path.resolve(__dirname, '../../../../docs/aws-computers/sql', file), 'utf8'));
    });
    afterEach(async () => { await client`rollback`; });
    afterAll(async () => { await client?.end(); });

    /** One owner with one computer, its epochs (newest last), its usage stops and, unless null, its placement. */
    async function computer(epochs: { size?: string; readyAt: Date; endedAt: Date | null; reason?: string }[],
        placement: { provider?: string; state?: string; job?: boolean; image?: boolean; lastError?: string; updatedAt?: Date } | null,
        usageStops: (Date | null)[] = []) {
        const userId = randomUUID(), computerId = randomUUID();
        mine.add(computerId);
        await client`insert into auth.users (id, created_at) values (${userId}::uuid, ${ago(90 * 24 * 60).toISOString()}::timestamptz)`;
        await client`insert into ezil_computers (id, user_id, slot) values (${computerId}::uuid, ${userId}::uuid, 1)`;
        for (const e of epochs) {
            const size = e.size ?? 'std-2';
            await client`insert into ezil_billing_compute_epochs (user_id, computer_id, size, weight, ready_at, ended_at, end_reason)
                values (${userId}::uuid, ${computerId}::uuid, ${size}, 1, ${e.readyAt.toISOString()}::timestamptz,
                    ${e.endedAt?.toISOString() ?? null}::timestamptz, ${e.endedAt ? e.reason ?? 'session_max' : null})`;
        }
        if (placement) {
            const provider = placement.provider ?? 'aws-ec2';
            await client.unsafe(`insert into public.ezil_computer_placements (computer_id, owner_user_id, provider, workspace_store,
                generation, lease_epoch, state, lifecycle_job_id, image_upgrade_job_id, last_error, updated_at)
                values ($1, $2, $3, $4, 1, 1, $5, $6, $7, $8, $9)`, [computerId, userId, provider, provider === 'aws-ec2' ? 'ebs' : 'r2',
                placement.state ?? 'RUNNING', placement.job ? randomUUID() : null, placement.image ? randomUUID() : null,
                placement.lastError ?? null, (placement.updatedAt ?? ago(30)).toISOString()]);
        }
        for (const [i, stoppedAt] of usageStops.entries()) {
            await client.unsafe(`insert into public.ezil_compute_usage (computer_id, user_id, instance_id, instance_type, started_at,
                stopped_at, observed_by, updated_at) values ($1, $2, $3, 'm6i.large', $4, $5, 'test', $6)`,
            [computerId, userId, `i-${i}`, ago(10 * 24 * 60).toISOString(), stoppedAt?.toISOString() ?? null, NOW.toISOString()]);
        }
        return { userId, computerId };
    }
    /** Every page from the first, kept to this test's computers. */
    async function all(limit = 200) {
        const seen: HeldCandidate[] = [];
        let after: string | null = null;
        for (let page = 0; page < 100; page++) {
            const read: Awaited<ReturnType<typeof runningAwsComputersAfterEpochs>> = await runningAwsComputersAfterEpochs(db, after, limit);
            seen.push(...read.candidates.filter(c => mine.has(c.computerId)));
            if (read.next === null) return seen;
            after = read.next;
        }
        throw new Error('pages never ended');
    }

    it('lists RUNNING and UNCONFIRMED aws-ec2 computers whose newest session closed, newest close first, at any age', async () => {
        const closed = await computer([{ readyAt: ago(120), endedAt: ago(60) }], { updatedAt: new Date('2090-01-01T06:30:00.123Z') });
        // A re-open whose epoch never opened: its newest epoch is the last (normally closed) session, 8 days back.
        const reopened = await computer([{ readyAt: ago(9 * 24 * 60), endedAt: ago(9 * 24 * 60 - 60), reason: 'allowance_exhausted' },
            { readyAt: ago(8 * 24 * 60 + 60), endedAt: ago(8 * 24 * 60), reason: 'user_stop' }], { updatedAt: ago(5) });
        // A stop Step Functions refused or failed: reported (with its job), never stopped from the sweep.
        const unconfirmed = await computer([{ readyAt: ago(300), endedAt: ago(240) }], { state: 'UNCONFIRMED', job: true });
        await computer([{ readyAt: ago(30), endedAt: null }], {}); // open: the policy pass's
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], { state: 'STOPPED' });
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], { state: 'STARTING' });
        await computer([{ size: 'free-cf', readyAt: ago(120), endedAt: ago(60) }], { provider: 'cloudflare', state: 'STOPPED' });
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], { provider: 'cloudflare', state: 'STOPPED' }); // paid CF rates std-2
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], null); // no placement row
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], { job: true });
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], { lastError: 'migration_pending:1234' });
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], { image: true });
        expect(await all()).toEqual([
            { ...closed, state: 'RUNNING', since: new Date('2090-01-01T06:30:00.123Z'), closedAt: ago(60), stoppedSinceClose: false },
            { ...unconfirmed, state: 'UNCONFIRMED', since: ago(30), closedAt: ago(240), stoppedSinceClose: false },
            { ...reopened, state: 'RUNNING', since: ago(5), closedAt: ago(8 * 24 * 60), stoppedSinceClose: false },
        ]);
        expect(await runningAwsComputersAfterEpochs(db, null, 0)).toEqual({ candidates: [], next: null });
    });

    it('says whether the host stopped after its session closed (a usage row closed since), whatever the row\'s updated_at', async () => {
        const close = ago(120);
        const neverStopped = await computer([{ readyAt: ago(180), endedAt: close }], { updatedAt: ago(10) }, [ago(2000), null]);
        const stoppedThenReopened = await computer([{ readyAt: ago(180), endedAt: close }], { updatedAt: ago(10) }, [ago(100), null]);
        const stoppedAtTheClose = await computer([{ readyAt: ago(180), endedAt: close }], { updatedAt: ago(10) }, [close]);
        const stopped = Object.fromEntries((await all()).map(c => [c.computerId, c.stoppedSinceClose]));
        expect(stopped).toEqual({ [neverStopped.computerId]: false, [stoppedThenReopened.computerId]: true, [stoppedAtTheClose.computerId]: true });
    });

    it('pages by (close, computer): Cloudflare computers never fill a page, and a held host behind newer closes is reached', async () => {
        // Newer closes first: two paid Cloudflare computers (filtered in SQL, before the LIMIT), then three AWS ones, two
        // of them closed at the same instant (the computer id breaks the tie, exactly, across the page boundary).
        for (const minutes of [10, 11]) await computer([{ readyAt: ago(minutes + 60), endedAt: ago(minutes) }], { provider: 'cloudflare', state: 'STOPPED' });
        await computer([{ readyAt: ago(80), endedAt: ago(20) }], { state: 'STOPPED' });
        const tied = [await computer([{ readyAt: ago(90), endedAt: ago(30) }], {}), await computer([{ readyAt: ago(90), endedAt: ago(30) }], {})]
            .sort((x, y) => (x.computerId < y.computerId ? 1 : -1));
        const first = await runningAwsComputersAfterEpochs(db, null, 2);
        // The STOPPED computer is read (it fills a slot) but not kept; the Cloudflare ones never reach the page.
        expect(first.candidates.map(c => c.computerId)).toEqual([tied[0]!.computerId]);
        expect(first.next).toMatch(/\|/);
        const second = await runningAwsComputersAfterEpochs(db, first.next, 2);
        expect(second.candidates.filter(c => mine.has(c.computerId)).map(c => c.computerId)).toEqual([tied[1]!.computerId]);
        await expect(runningAwsComputersAfterEpochs(db, 'not-a-cursor', 2)).rejects.toThrow('held cursor invalid');
    });
});
