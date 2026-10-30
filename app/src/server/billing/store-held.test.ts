/** Round 6 R1-01: the held bound's candidate read, against the billing test database (BILLING_TEST_DATABASE_URL). */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '@/server/db/schema';
import { runningAwsComputersAfterEpochs } from './store';

type Database = typeof import('@/server/db').db;
const NOW = new Date('2026-10-30T07:00:00.000Z');
const SINCE = new Date(NOW.getTime() - 7 * 86_400_000);
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('runningAwsComputersAfterEpochs with Postgres', () => {
    let client: ReturnType<typeof postgres>;
    let db: Database;

    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
        db = drizzle(client, { schema });
    });
    // Everything, the placement tables included, lives in one rolled-back transaction.
    beforeEach(async () => {
        await client`begin`;
        await client`update ezil_billing_compute_epochs set ended_at = greatest(ready_at, now()), end_reason = 'provider_stop' where ended_at is null`;
        await client`delete from ezil_billing_compute_epochs`;
    });
    afterEach(async () => { await client`rollback`; });
    afterAll(async () => { await client?.end(); });

    const placementTables = async () => {
        for (const file of ['0001_compute_placement.sql.txt', '0002_image_rebase.sql.txt'])
            await client.unsafe(readFileSync(path.resolve(__dirname, '../../../../docs/aws-computers/sql', file), 'utf8'));
    };
    /** One owner with one computer, its epochs (newest last) and, unless null, its placement. */
    async function computer(epochs: { size?: string; readyAt: Date; endedAt: Date | null; reason?: string }[],
        placement: { provider?: string; state?: string; job?: boolean; image?: boolean; lastError?: string; updatedAt?: Date } | null) {
        const userId = randomUUID(), computerId = randomUUID();
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
        return { userId, computerId };
    }

    it('lists RUNNING aws-ec2 computers whose newest AWS session closed, newest close first', async () => {
        await placementTables();
        const closed = await computer([{ readyAt: ago(120), endedAt: ago(60) }], { updatedAt: new Date('2026-10-30T06:30:00.123Z') });
        // A re-open whose epoch never opened: its newest epoch is the last (normally closed) session.
        const reopened = await computer([{ readyAt: ago(3000), endedAt: ago(2940), reason: 'allowance_exhausted' },
            { readyAt: ago(600), endedAt: ago(540), reason: 'user_stop' }], { updatedAt: ago(5) });
        await computer([{ readyAt: ago(30), endedAt: null }], {}); // open: the policy pass's
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], { state: 'STOPPED' });
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], { state: 'STARTING' });
        await computer([{ readyAt: ago(8 * 24 * 60 + 60), endedAt: ago(8 * 24 * 60) }], {}); // before the lookback
        await computer([{ size: 'free-cf', readyAt: ago(120), endedAt: ago(60) }], { provider: 'cloudflare', state: 'STOPPED' });
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], { provider: 'cloudflare', state: 'STOPPED' }); // paid CF rates std-2
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], null); // no placement row
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], { job: true });
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], { lastError: 'migration_pending:1234' });
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], { image: true });
        expect(await runningAwsComputersAfterEpochs(db, SINCE, 200)).toEqual([
            { ...closed, since: new Date('2026-10-30T06:30:00.123Z') },
            { ...reopened, since: ago(5) },
        ]);
        expect(await runningAwsComputersAfterEpochs(db, SINCE, 0)).toEqual([]);
    });

    it('bounds the candidates it reads, newest close first', async () => {
        await placementTables();
        const older = await computer([{ readyAt: ago(300), endedAt: ago(240) }], {});
        const newer = await computer([{ readyAt: ago(120), endedAt: ago(60) }], {});
        expect((await runningAwsComputersAfterEpochs(db, SINCE, 1)).map(c => c.computerId)).toEqual([newer.computerId]);
        expect((await runningAwsComputersAfterEpochs(db, SINCE, 2)).map(c => c.computerId)).toEqual([newer.computerId, older.computerId]);
    });

    it('a billing-only database (no placement table) reads as none', async () => {
        await computer([{ readyAt: ago(120), endedAt: ago(60) }], null);
        expect(await runningAwsComputersAfterEpochs(db, SINCE, 200)).toEqual([]);
    });
});
