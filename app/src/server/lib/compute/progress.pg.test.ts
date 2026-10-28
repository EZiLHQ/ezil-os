/** Disposable PostgreSQL only: the round-3 advisory transition/opening records in `ezil_computers.metadata`. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacementExecutor } from './placement';
import { readComputerMeta, readComputerProgress, TRANSITION_MAX_AGE_MS, writeOpening, writeTransition, type ComputerTransition, type OpeningRecord } from './progress';

// The billing preference read is not under test here (it never reaches this disposable schema).
vi.mock('@/server/billing/v2/compute-access', () => ({ billingV2EntitlementReader: () => ({ read: async () => null }) }));

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `transition_test_${randomUUID().replaceAll('-', '')}`;
const C = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const U = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const computer = { computerId: C, userId: U };
const T0 = '2026-10-28T10:00:00.000Z';
const transition = (over: Partial<ComputerTransition> = {}): ComputerTransition => ({
    v: 1, transitionId: '22222222-2222-4222-8222-222222222222', requestId: 'request-0001', kind: 'switch', computerId: C, userId: U,
    current: 'std-2', target: 'cmp-8', phase: 'requested', reason: null, fromGeneration: 3, fromLeaseEpoch: 7,
    requestedAt: T0, stoppingAt: null, wakingAt: null, endedAt: null, ...over,
});

describe.skipIf(!PG)('transition records on production Drizzle PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 10, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const db: PlacementExecutor = { execute: q => production!.execute(scoped(q)) };
    const metadata = async () => ((await client!.unsafe(`SELECT metadata FROM ${schema}.ezil_computers WHERE id = '${C}'`))[0] as unknown as { metadata: unknown }).metadata;
    const setMetadata = (value: string) => client!.unsafe(`UPDATE ${schema}.ezil_computers SET metadata = ${value} WHERE id = '${C}'`);
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL DEFAULT 'Computer',
            slot smallint NOT NULL DEFAULT 1, deleted_at timestamptz, metadata jsonb)`);
        // The real placement, pool, demand and provider-migration tables a progress read touches.
        for (const file of ['0001_compute_placement.sql.txt', '0002_image_rebase.sql.txt', '0002_ready_pool.sql.txt', '0003_pool_hosts_v2.sql.txt'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql', file), 'utf8')));
        for (const file of ['0006_compute_migrations.sql', '0008_pool_dispatch.sql', '0009_capacity_demands.sql', '0010_migration_restore_progress.sql'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle', file), 'utf8')));
    });
    beforeEach(async () => {
        await client!.unsafe(`TRUNCATE ${schema}.ezil_computers, ${schema}.ezil_computer_placements, ${schema}.ezil_compute_migrations`);
        await client!.unsafe(`INSERT INTO ${schema}.ezil_computers (id, user_id, metadata) VALUES ('${C}', '${U}', '{"keep": {"x": 1}}')`);
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });

    it('reads only the live owned row; other metadata keys survive every write', async () => {
        expect(await readComputerMeta(db, computer)).toMatchObject({ transition: null, opening: null });
        expect(await readComputerMeta(db, { computerId: C, userId: OTHER })).toBeNull();
        expect(await writeTransition(db, computer, null, transition())).toBe(true);
        expect((await readComputerMeta(db, computer))!.transition).toEqual(transition());
        expect(await metadata()).toMatchObject({ keep: { x: 1 }, transition: { transitionId: transition().transitionId } });
        await client!.unsafe(`UPDATE ${schema}.ezil_computers SET deleted_at = now()`);
        expect(await readComputerMeta(db, computer)).toBeNull();
        expect(await writeTransition(db, computer, null, transition({ requestId: 'request-0002' }))).toBe(false);
    });

    it('a non-object or malformed stored value never breaks a read or a first write', async () => {
        for (const value of [`'[1,2]'`, `'"text"'`, `'{"transition": [1]}'`, `'{"transition": {"phase": "waking"}}'`, 'NULL']) {
            await setMetadata(value);
            expect(await readComputerMeta(db, computer)).toMatchObject({ transition: null });
            expect(await writeTransition(db, computer, null, transition())).toBe(true);
            expect((await readComputerMeta(db, computer))!.transition).toEqual(transition());
        }
    });

    it('the null guard refuses an in-flight transition, and allows an ended or stale one', async () => {
        expect(await writeTransition(db, computer, null, transition())).toBe(true);
        expect(await writeTransition(db, computer, null, transition({ transitionId: randomUUID(), requestId: 'request-0002' }))).toBe(false);
        for (const phase of ['stopping', 'waking'] as const) {
            await setMetadata(`jsonb_build_object('transition', '${JSON.stringify(transition({ phase }))}'::jsonb)`);
            expect(await writeTransition(db, computer, null, transition({ transitionId: randomUUID() }))).toBe(false);
        }
        for (const phase of ['done', 'failed'] as const) {
            await setMetadata(`jsonb_build_object('transition', '${JSON.stringify(transition({ phase }))}'::jsonb)`);
            expect(await writeTransition(db, computer, null, transition({ transitionId: randomUUID() }))).toBe(true);
        }
        // An in-flight record older than every budget can be replaced.
        await setMetadata(`jsonb_build_object('transition', '${JSON.stringify(transition({ phase: 'waking' }))}'::jsonb)`);
        const later = new Date(Date.parse(T0) + TRANSITION_MAX_AGE_MS + 1000).toISOString();
        expect(await writeTransition(db, computer, null, transition({ transitionId: randomUUID(), requestedAt: later }))).toBe(true);
    });

    it('the phase CAS moves only the exact stored id and phase', async () => {
        const t = transition();
        await writeTransition(db, computer, null, t);
        expect(await writeTransition(db, computer, { transitionId: t.transitionId, phase: 'stopping' }, { ...t, phase: 'waking' })).toBe(false);
        expect(await writeTransition(db, computer, { transitionId: randomUUID(), phase: 'requested' }, { ...t, phase: 'stopping' })).toBe(false);
        expect(await writeTransition(db, computer, { transitionId: t.transitionId, phase: 'requested' }, { ...t, phase: 'stopping', stoppingAt: T0 })).toBe(true);
        expect((await readComputerMeta(db, computer))!.transition).toMatchObject({ phase: 'stopping', stoppingAt: T0 });
        expect(await writeTransition(db, { computerId: C, userId: OTHER }, { transitionId: t.transitionId, phase: 'stopping' }, { ...t, phase: 'failed' })).toBe(false);
    });

    it('two concurrent first writers: exactly one transition is recorded', async () => {
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
            writeTransition(db, computer, null, transition({ transitionId: randomUUID(), requestId: `request-000${i}` }))));
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('the opening record: first writer wins against the exact previous value (jsonb key order is irrelevant)', async () => {
        const opening: OpeningRecord = { v: 1, generation: 4, leaseEpoch: 8, startedAt: T0, path: 'cold', milestones: { requested: T0 } };
        expect(await writeOpening(db, computer, null, opening)).toBe(true);
        expect(await writeOpening(db, computer, null, { ...opening, startedAt: '2026-10-28T11:00:00.000Z' })).toBe(false);
        const meta = await readComputerMeta(db, computer);
        expect(meta!.opening).toEqual(opening);
        const next = { ...opening, milestones: { requested: T0, host_claimed: T0 } };
        expect(await writeOpening(db, computer, meta!.rawOpening, next)).toBe(true);
        expect(await writeOpening(db, computer, meta!.rawOpening, { ...next, path: 'warm' })).toBe(false);
        expect((await readComputerMeta(db, computer))!.opening).toEqual(next);
        expect(await metadata()).toMatchObject({ keep: { x: 1 } });
    });

    it('readComputerProgress: a switch in flight reports its stored opening, milestones and transition view, then stamps the wake', async () => {
        const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_COMPUTE_PLACEMENT_READS: '1', EZIL_AWS_KILL_SWITCH: '0' };
        const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
        const place = (state: string, generation: number, epoch: number, instanceType: string) => client!.unsafe(`INSERT INTO ${schema}.ezil_computer_placements
            (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, region, zone_id, instance_type, volume_id, updated_at)
            VALUES ('${C}', '${U}', 'aws-ec2', 'ebs', ${generation}, ${epoch}, '${state}', 'ap-south-1', 'aps1-az1', '${instanceType}', 'vol-11111111111111111', '${at(1)}')`);
        const view = { transitionId: transition().transitionId, kind: 'switch', current: 'std-2', target: 'cmp-8', reason: null, requestedAt: T0, endedAt: null, revertAvailable: false };
        // Stopping the old host: the opening belongs to the next lease epoch and starts at the request.
        await place('STOPPING', 3, 7, 'm6i.large');
        await writeTransition(db, computer, null, transition({ phase: 'stopping', stoppingAt: at(1) }));
        const opening: OpeningRecord = { v: 1, generation: 3, leaseEpoch: 8, startedAt: T0, path: 'switch', milestones: { requested: T0 } };
        await writeOpening(db, computer, null, opening);
        expect(await readComputerProgress(db, computer, env, new Date(at(30)))).toMatchObject({
            operation: 'opening', stage: 'switching', openingStartedAt: T0, path: 'switch', expectedSeconds: 300, typicalSeconds: 300,
            milestones: [{ key: 'requested', at: T0 }], transition: { ...view, phase: 'stopping' },
        });
        // Waking on the new epoch: stored stamps win over the read time; a newly reached milestone is stamped once.
        await client!.unsafe(`TRUNCATE ${schema}.ezil_computer_placements`);
        await place('MOUNTING', 4, 8, 'm6i.2xlarge');
        await setMetadata(`jsonb_build_object('keep', '{"x": 1}'::jsonb, 'transition', '${JSON.stringify(transition({ phase: 'waking', stoppingAt: at(1), wakingAt: at(60) }))}'::jsonb,
            'opening', '${JSON.stringify({ ...opening, milestones: { requested: T0, host_claimed: at(100) } })}'::jsonb)`);
        const milestones = [{ key: 'requested', at: T0 }, { key: 'host_claimed', at: at(100) }, { key: 'files_attached', at: at(120) }];
        expect(await readComputerProgress(db, computer, env, new Date(at(120)))).toMatchObject({
            operation: 'opening', stage: 'mounting', openingStartedAt: T0, path: 'switch', expectedSeconds: 300, milestones, transition: { ...view, phase: 'waking' },
        });
        expect((await readComputerMeta(db, computer))!.opening).toEqual({ v: 1, generation: 4, leaseEpoch: 8, startedAt: T0, path: 'switch',
            milestones: { requested: T0, host_claimed: at(100), files_attached: at(120) } });
        // A later read keeps the first stamps.
        expect((await readComputerProgress(db, computer, env, new Date(at(150))))!.milestones).toEqual(milestones);
        expect(await metadata()).toMatchObject({ keep: { x: 1 } });
    });
});
