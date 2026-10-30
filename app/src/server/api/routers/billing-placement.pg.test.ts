import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';
import { computers } from '@/server/db/schema';

vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/lib/compute/provider-migrate-orchestrator', () => ({ schedulePaidMigration: vi.fn() }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => { throw new Error('Tests must inject billing ports'); } }));

import { userPlacementProvider } from './billing';

type Database = typeof import('@/server/db').db;

/**
 * Round 4: the summary's placement read against real SQL. The billing test database has no placement table
 * (it ships with the AWS schema), so the scenario creates the columns the read uses inside its rollback.
 */
describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('userPlacementProvider with Postgres', () => {
    let client: ReturnType<typeof postgres>;
    let db: Database;
    let user: string;
    let other: string;
    const ids = { a: '', b: '', foreign: '' };

    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
        db = drizzle(client, { schema });
    });
    beforeEach(async () => {
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        await client`begin`;
        user = randomUUID();
        other = randomUUID();
        Object.assign(ids, { a: randomUUID(), b: randomUUID(), foreign: randomUUID() });
        await client`insert into auth.users (id) values (${user}::uuid), (${other}::uuid)`;
        await db.insert(computers).values([{ id: ids.a, userId: user, slot: 1 }, { id: ids.b, userId: user, slot: 2 },
            { id: ids.foreign, userId: other, slot: 1 }]);
    });
    afterEach(async () => { await client`rollback`; vi.unstubAllEnvs(); });
    afterAll(async () => { await client?.end(); });

    const createTable = () => client`create table if not exists public.ezil_computer_placements (
        computer_id uuid primary key, owner_user_id uuid not null, provider text not null)`;
    const place = (computerId: string, owner: string, provider: string) =>
        client`insert into public.ezil_computer_placements (computer_id, owner_user_id, provider) values (${computerId}::uuid, ${owner}::uuid, ${provider})`;

    it('null without the placement table', async () => {
        await client`drop table if exists public.ezil_computer_placements`;
        await expect(userPlacementProvider(db, user)).resolves.toBeNull();
    });

    it('aws-ec2 when any live computer of the user has it; deleted and foreign computers never count', async () => {
        await createTable();
        await expect(userPlacementProvider(db, user)).resolves.toBeNull();
        await place(ids.a, user, 'cloudflare');
        await expect(userPlacementProvider(db, user)).resolves.toBe('cloudflare');
        await place(ids.foreign, other, 'aws-ec2');
        await expect(userPlacementProvider(db, user)).resolves.toBe('cloudflare');
        await place(ids.b, user, 'aws-ec2');
        await expect(userPlacementProvider(db, user)).resolves.toBe('aws-ec2');
        await client`update ezil_computers set deleted_at = now() where id = ${ids.b}::uuid`;
        await expect(userPlacementProvider(db, user)).resolves.toBe('cloudflare');
    });
});
