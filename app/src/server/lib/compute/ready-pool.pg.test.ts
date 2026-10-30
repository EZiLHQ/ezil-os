/** Disposable PostgreSQL, production drizzle(postgres-js) codecs; no app DB/credential imports. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleStarter } from './aws-ec2';
import { fixtureDeployment } from './aws-intent.test-support';
import type { LifecycleWork } from './aws-intent';
import { buildLifecycleWork } from './aws-intent';
import { observePoolAdopt } from './aws-pool-adopt';
import { handlePoolClaim } from './aws-pool-claim';
import { readPoolProof } from './aws-pool-host';
import { poolFixture } from './aws-pool-test-support';
import { createPoolDispatchStore, poolJobAuthority, storedPoolWork } from './aws-pool-dispatch';
import { poolWork, runPoolReplenish, withPoolReplenishLock } from './aws-pool-replenish';
import { applyLifecycleReceipt, lifecycleExecutionArn, type LifecycleExecutionReader } from './aws-receipts';
import type { Placement, PlacementDb, PlacementExecutor } from './placement';
import { lockImagePlacement, lockPoolClaimPlacement, pinCloudflarePlacement, readAdmissionCounters, readImageAdmissionCounters, readPlacement, savePoolEnrollmentNonce, withAdmission } from './placement';
import { cancelComputerDemand, reservePoolDemand, resetCapacityAttempt, type PoolDemandDeps } from './aws-pool-demand';
import { closeExpiredDemands, closeOrphanedDemands, demandDeploymentDigest, hasDemandHoldForRouting, lockComputerDemandLive } from './capacity-demand';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { failedReplaceHistory } from './aws-historical-source.test-support';
import { createPoolDeps } from './aws-pool-runtime';
import * as poolData from './ready-pool';
import { leasePoolHost, markPoolHost, publishPoolClaim, readPendingPoolAdopt, readPoolClaim, readPoolDemand, recordPoolEnrollment, recordPoolReady,
    type PoolClass, type PoolHostState } from './ready-pool';

const PG = process.env.EZIL_PG_TEST_URL;
const NOW = new Date('2026-10-23T12:00:00.123Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const c: PoolClass = { region: 'ap-south-1', zoneId: 'aps1-az1', instanceType: 'm6i.large' };
const schema = `ready_pool_v2_${randomUUID().replaceAll('-', '')}`;
const directory = path.resolve(__dirname, '../../../../../docs/aws-computers/sql');
const claim = { computerId: uuid(101), generation: 3, leaseEpoch: 4, fence: uuid(201), volumeSerial: 'vol0123456789abcdef0' };
/** Observe-initial, one RunInstances that EC2 refused, Observe-instance, then the graph's terminal with `error`. */
const refusedLaunchHistory = (error: string) => [{ type: 'ExecutionStarted' },
    ...['Observe-initial', 'runInstances', 'Observe-instance'].map(name => ({ type: 'TaskStateEntered', stateEnteredEventDetails: { name } })),
    { type: 'ExecutionFailed', executionFailedEventDetails: { error, cause: 'VcpuLimitExceeded' } }] as HistoryEvent[];

describe.skipIf(!PG)('P8 ready pool on production Drizzle PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 16, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`).replaceAll('auth.users', `${schema}.test_users`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const executor = (source: Pick<NonNullable<typeof production>, 'execute'>): PlacementExecutor => ({ execute: q => source.execute(scoped(q)) });
    const db: PlacementDb = { execute: q => executor(production!).execute(q), transaction: fn => production!.transaction(tx => fn(executor(tx))) };
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        for (const file of ['0001_compute_placement.sql.txt', '0002_image_rebase.sql.txt', '0002_ready_pool.sql.txt', '0003_pool_hosts_v2.sql.txt'])
            await client!.unsafe(local(readFileSync(path.join(directory, file), 'utf8')));
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0008_pool_dispatch.sql'), 'utf8')));
        // Leasing and demand reads consult active capacity demands (0009).
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0009_capacity_demands.sql'), 'utf8')));
        // Minimal fixtures for existing billing tables; production migrations require auth.users.
        // The real provider-migration table: capacity-demand reauthorization reads it through the production store.
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0006_compute_migrations.sql'), 'utf8')));
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0010_migration_restore_progress.sql'), 'utf8')));
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), metadata jsonb);
            CREATE TABLE ${schema}.test_users (id uuid PRIMARY KEY, deleted_at timestamptz, banned_until timestamptz);
            CREATE TABLE ${schema}.ezil_billing_size_preferences (user_id uuid PRIMARY KEY, size text);
            CREATE TABLE ${schema}.ezil_billing_grants (user_id uuid, subscription_id text, meter text, amount bigint, period_start timestamptz, period_end timestamptz);
            CREATE TABLE ${schema}.ezil_billing_payment_issues (user_id uuid, subscription_id text, invoice_kind text, resolved_at timestamptz, issue text);
            CREATE TABLE ${schema}.ezil_billing_subscriptions (
            stripe_subscription_id text PRIMARY KEY, user_id uuid, sku text, status text,
            current_period_start timestamptz, current_period_end timestamptz);
            CREATE TABLE ${schema}.ezil_billing_compute_epochs (
                id uuid PRIMARY KEY, user_id uuid, computer_id uuid, subscription_id text, size text, ready_at timestamptz);`);
    });
    beforeEach(async () => {
        await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_pool_hosts, ${schema}.ezil_computer_placements,
            ${schema}.ezil_billing_subscriptions, ${schema}.ezil_billing_compute_epochs, ${schema}.test_users,
            ${schema}.ezil_billing_grants, ${schema}.ezil_billing_size_preferences, ${schema}.ezil_billing_payment_issues,
            ${schema}.ezil_compute_capacity_demands, ${schema}.ezil_computers`);
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });
    async function boot(n = 1) {
        await db.execute(sql`INSERT INTO public.ezil_compute_pool_hosts (id, region, zone_id, instance_type, created_at, updated_at)
            VALUES (${uuid(n)}::uuid, ${c.region}, ${c.zoneId}, ${c.instanceType}, ${ago(4).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`);
    }
    async function ready(n = 1, readyAt = NOW) {
        await boot(n); await recordPoolEnrollment(db, uuid(n), `i-${n}`, ago(1));
        return recordPoolReady(db, uuid(n), { editorOk: true }, readyAt);
    }
    const lease = (n = 1, priority: 1 | 2 = 1) => db.transaction(tx => leasePoolHost(tx, c, uuid(100 + n), priority, NOW));

    describe('HOSTSWITCH pending adoption and claim publication', () => {
        afterEach(() => vi.restoreAllMocks());
        const current = async (id = uuid(1)) => (await db.execute(sql`SELECT * FROM public.ezil_compute_pool_hosts
            WHERE id = ${id}::uuid`) as Record<string, unknown>[])[0]!;
        const expectedClaim = {
            leasedComputerId: claim.computerId, claimGeneration: claim.generation, claimLeaseEpoch: claim.leaseEpoch,
            claimFence: claim.fence, claimVolumeSerial: claim.volumeSerial,
        };
        async function pending() { await ready(); await lease(); }
        async function twoPending() { await pending(); await ready(2); await lease(2); }

        it('returns null for an absent pending host', async () => {
            expect(await readPendingPoolAdopt(db, uuid(1), 'i-1')).toBeNull();
        });
        it('returns only the exact leased host and computer, with PostgreSQL NULL/date/bigint codecs', async () => {
            await twoPending();
            expect(await readPendingPoolAdopt(db, uuid(1), 'i-1')).toEqual({
                poolHostId: uuid(1), poolGeneration: 1, ...c, instanceId: 'i-1', state: 'leased',
                readyAt: NOW, enrolledAt: ago(1), leasedComputerId: uuid(101), leasedAt: NOW,
                claimGeneration: null, claimLeaseEpoch: null, claimFence: null, claimVolumeSerial: null,
            });
            expect(await readPendingPoolAdopt(db, uuid(2), 'i-2')).toMatchObject({ leasedComputerId: uuid(102) });
            expect(await readPoolClaim(db, uuid(1), 'i-1')).toBeNull();
        });
        it.each([
            [uuid(999), 'i-1'], [uuid(2), 'i-1'], [uuid(1), 'i-2'], [uuid(1), 'i-missing'],
        ])('hides pending adoption for host %s and instance %s', async (id, instance) => {
            await twoPending();
            expect(await readPendingPoolAdopt(db, id, instance)).toBeNull();
        });
        it.each(['booting', 'ready', 'failed', 'retiring', 'retired'])('hides a pending host in state %s', async state => {
            await pending();
            await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET state = ${state} WHERE id = ${uuid(1)}::uuid`);
            expect(await readPendingPoolAdopt(db, uuid(1), 'i-1')).toBeNull();
        });
        it.each(['leased_computer_id', 'instance_id'])('hides a pending host missing %s', async column => {
            await pending();
            await client!.unsafe(`UPDATE ${schema}.ezil_compute_pool_hosts SET ${column} = NULL`);
            expect(await readPendingPoolAdopt(db, uuid(1), 'i-1')).toBeNull();
        });
        it.each(['ready_at', 'enrolled_at', 'leased_at'])('decodes a pending row with nullable metadata %s', async column => {
            await pending();
            await client!.unsafe(`UPDATE ${schema}.ezil_compute_pool_hosts SET ${column} = NULL`);
            const row = await readPendingPoolAdopt(db, uuid(1), 'i-1');
            const field = { ready_at: 'readyAt', enrolled_at: 'enrolledAt', leased_at: 'leasedAt' }[column]!;
            expect(row).toMatchObject({ poolHostId: uuid(1), leasedComputerId: uuid(101), [field]: null });
        });
        // Every nonempty subset, including a fully published claim, must be excluded.
        it.each(Array.from({ length: 15 }, (_, i) => i + 1))('hides partial/published claims with non-NULL mask %i', async mask => {
            await pending();
            await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET
                claim_generation = ${mask & 1 ? claim.generation : null},
                claim_lease_epoch = ${mask & 2 ? claim.leaseEpoch : null},
                claim_fence = ${mask & 4 ? claim.fence : null},
                claim_volume_serial = ${mask & 8 ? claim.volumeSerial : null}
                WHERE id = ${uuid(1)}::uuid`);
            expect(await readPendingPoolAdopt(db, uuid(1), 'i-1')).toBeNull();
        });
        it('concurrent identical raw publications retain one timestamp and identical claim fields', async () => {
            await pending();
            const times = [new Date(NOW.getTime() + 1234), new Date(NOW.getTime() + 5678)];
            const [a, b] = await Promise.all(times.map(at => db.transaction(tx => publishPoolClaim(tx, uuid(1), claim, at))));
            expect(a).toEqual(b);
            expect(a).toMatchObject(expectedClaim);
            expect(times.map(at => at.getTime())).toContain(a!.claimPublishedAt!.getTime());
            const saved = await current();
            // Raw rows return timestamptz as text; compare the instant.
            expect(new Date(String(saved.updated_at)).getTime()).toBe(a!.claimPublishedAt!.getTime());
            for (const at of [new Date(NOW.getTime() + 30_000), new Date(NOW.getTime() - 30_000)]) {
                expect(await publishPoolClaim(db, uuid(1), claim, at)).toEqual(a);
                expect(await current()).toEqual(saved);
            }
            expect(await readPoolClaim(db, uuid(1), 'i-1')).toEqual(a);
            expect(await readPendingPoolAdopt(db, uuid(1), 'i-1')).toBeNull();
        });
        it('preserves the first publication time across later and earlier-clock retries', async () => {
            await pending();
            const first = new Date(NOW.getTime() + 1234);
            const published = await publishPoolClaim(db, uuid(1), claim, first);
            expect(published).toMatchObject({ ...expectedClaim, claimPublishedAt: first });
            const saved = await current();
            expect(new Date(String(saved.updated_at)).getTime()).toBe(first.getTime());
            for (const at of [new Date(first.getTime() + 60_000), new Date(first.getTime() - 60_000)]) {
                expect(await publishPoolClaim(db, uuid(1), claim, at)).toEqual(published);
                expect(await current()).toEqual(saved);
            }
        });
        it.each([
            { generation: 4 }, { leaseEpoch: 5 }, { fence: uuid(202) }, { volumeSerial: 'volfedcba98765432100' },
            { computerId: uuid(102) },
        ])('refuses a mismatched publication without changing any SQL column: %j', async patch => {
            await twoPending();
            const published = await publishPoolClaim(db, uuid(1), claim, NOW);
            const saved = await current(), other = await current(uuid(2));
            await expect(publishPoolClaim(db, uuid(1), { ...claim, ...patch }, ago(-1))).rejects.toThrow('pool_state_conflict');
            expect(await current()).toEqual(saved);
            expect(await current(uuid(2))).toEqual(other);
            expect(await readPoolClaim(db, uuid(1), 'i-1')).toEqual(published);
        });
        it.each(['booting', 'ready', 'failed', 'retiring', 'retired'])('cannot leak either computer claim through a host in state %s', async state => {
            await twoPending();
            await publishPoolClaim(db, uuid(1), claim, NOW);
            const other = await publishPoolClaim(db, uuid(2), { ...claim, computerId: uuid(102), generation: 8,
                leaseEpoch: 9, fence: uuid(202), volumeSerial: 'volfedcba98765432100' }, NOW);
            await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET state = ${state} WHERE id = ${uuid(1)}::uuid`);
            const saved = await current();
            expect(await readPoolClaim(db, uuid(1), 'i-1')).toBeNull();
            expect(await readPoolClaim(db, uuid(1), 'i-2')).toBeNull();
            expect(await readPoolClaim(db, uuid(2), 'i-1')).toBeNull();
            expect(await readPoolClaim(db, uuid(2), 'i-2')).toEqual(other);
            await expect(publishPoolClaim(db, uuid(1), claim, ago(-1))).rejects.toThrow('pool_state_conflict');
            expect(await current()).toEqual(saved);
        });

        async function adoption() {
            // Only authenticated provider evidence is synthetic; all storage, locks and CAS use PostgreSQL.
            const f = poolFixture(true), p = f.p, h = f.row;
            p.updatedAt = NOW;
            await db.execute(sql`INSERT INTO public.ezil_compute_pool_hosts
                (id, generation, region, zone_id, instance_type, instance_id, state, leased_computer_id, leased_at, updated_at)
                VALUES (${h.poolHostId}::uuid, ${h.poolGeneration}, ${h.region}, ${h.zoneId}, ${h.instanceType},
                    ${h.instanceId}, 'leased', ${p.computerId}::uuid, ${NOW.toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`);
            await db.execute(sql`INSERT INTO public.ezil_computer_placements
                (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state,
                    region, zone_id, instance_type, instance_id, volume_id, fs_uuid, fence_token,
                    lifecycle_job_id, lifecycle_digest, updated_at)
                VALUES (${p.computerId}::uuid, ${p.ownerUserId}::uuid, ${p.provider}, ${p.store}, ${p.generation},
                    ${p.leaseEpoch}, ${p.state}, ${p.region}, ${p.zoneId}, ${p.instanceType}, ${p.instanceId},
                    ${p.volumeId}, ${p.fsUuid}::uuid, ${p.fenceToken}::uuid, ${p.lifecycleJobId}::uuid,
                    ${p.lifecycleDigest}, ${NOW.toISOString()}::timestamptz)`);
            Object.assign(f.deps, { db, data: poolData, now: () => NOW,
                lockPlacement: lockPoolClaimPlacement, saveNonce: savePoolEnrollmentNonce });
            return f;
        }
        it('refuses a stale pool generation at the observer binding before reading tenant work', async () => {
            const f = await adoption(), saved = await current(f.row.poolHostId);
            const proof = { ...readPoolProof(f.request('claim')), poolGeneration: f.row.poolGeneration + 1 };
            // readPendingPoolAdopt has no generation argument; the observer owns this guard.
            await expect(observePoolAdopt(f.deps, proof, f)).rejects.toThrow('row_generation');
            expect(f.deps.executions!.describe).not.toHaveBeenCalled();
            expect(await current(f.row.poolHostId)).toEqual(saved);
        });
        it('concurrent host-poll and status-pass reconciliation publish exactly once and expose the first millisecond timestamp', async () => {
            const f = await adoption();
            const stale = (await readPlacement(db, f.p.computerId)).record!;
            let arrivals = 0, release!: () => void;
            const bothObserved = new Promise<void>(resolve => { release = resolve; });
            // Hold provider reads until BOTH callers have the same pre-publication placement snapshot.
            f.deps.executions!.describe = vi.fn(async () => {
                if (++arrivals === 2) release();
                await bothObserved;
                return f.execution;
            });
            const publish = vi.spyOn(poolData, 'publishPoolClaim'); // Calls the real SQL implementation.
            vi.spyOn(console, 'info').mockImplementation(() => {});
            const hostAt = new Date(NOW.getTime() + 1234), statusAt = new Date(NOW.getTime() + 5678);
            f.deps.now = () => hostAt;
            await Promise.all([
                observePoolAdopt(f.deps, readPoolProof(f.request('claim')), f),
                applyLifecycleReceipt({ db, now: () => statusAt, executions: f.deps.executions!,
                    pool: { leasePoolHost, buildWork: buildLifecycleWork, replenish: async () => {},
                        publishPoolClaim: (...args) => poolData.publishPoolClaim(...args) } },
                stale, f.deployment, { terminalOnly: true }),
            ]);
            expect(arrivals).toBe(2);
            expect(publish).toHaveBeenCalledTimes(1);
            const sent = publish.mock.calls[0]![2], first = publish.mock.calls[0]![3];
            expect(sent).toEqual({ computerId: stale.computerId, generation: stale.generation,
                leaseEpoch: stale.leaseEpoch, fence: stale.fenceToken, volumeSerial: f.receipt.volumeId!.replace('-', '') });
            expect([hostAt.getTime(), statusAt.getTime()]).toContain(first.getTime());
            const saved = await current(f.row.poolHostId);
            expect(new Date(String(saved.updated_at)).getTime()).toBe(first.getTime());
            expect(saved).toMatchObject({ claim_generation: String(sent.generation),
                claim_lease_epoch: String(sent.leaseEpoch), claim_fence: sent.fence, claim_volume_serial: sent.volumeSerial });
            expect(await readPendingPoolAdopt(db, f.row.poolHostId, f.doc.instanceId)).toBeNull();
            for (const at of [new Date(NOW.getTime() + 30_000), new Date(NOW.getTime() + 60_000)]) {
                f.deps.now = () => at;
                await publishPoolClaim(db, f.row.poolHostId, sent, at);
                const response = await handlePoolClaim(f.request('claim'), f.deps);
                expect(response.status).toBe(200);
                expect(await response.json()).toMatchObject({ ...sent, claimPublishedAtMs: first.getTime() });
                expect(await current(f.row.poolHostId)).toEqual(saved);
            }
        });
    });

    it('16 concurrent leases of one ready host produce exactly one winner', async () => {
        await ready();
        const results = await Promise.all(Array.from({ length: 16 }, (_, i) => lease(i)));
        const winners = results.filter(row => row !== null);
        expect(winners).toHaveLength(1);
        expect(results.filter(row => row === null)).toHaveLength(15);
        expect(winners[0]).toMatchObject({ poolHostId: uuid(1), state: 'leased', poolGeneration: 1, leasedAt: NOW });
    });
    it('SKIP LOCKED skips an uncommitted competing lease instead of waiting', async () => {
        await ready(1); await ready(2);
        await db.transaction(async tx => {
            expect((await leasePoolHost(tx, c, uuid(101), 1, NOW))?.poolHostId).toBe(uuid(1));
            const other = await lease(2);
            expect(other?.poolHostId).toBe(uuid(2));
        });
    }, 5_000);
    it('orders priority descending, then oldest ready time, then id; records requester priority', async () => {
        await ready(1, ago(0.9)); await ready(2, ago(0.5)); await ready(3, ago(0.2)); await ready(4, ago(0.5));
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET pool_priority = 2 WHERE id <> ${uuid(1)}::uuid`);
        expect((await lease(1, 2))?.poolHostId).toBe(uuid(2));
        expect((await lease(2, 2))?.poolHostId).toBe(uuid(4));
        expect((await lease(3, 2))?.poolHostId).toBe(uuid(3));
        expect((await lease(4))?.poolHostId).toBe(uuid(1));
        const rows = await db.execute(sql`SELECT pool_priority FROM public.ezil_compute_pool_hosts WHERE id = ${uuid(2)}::uuid`) as { pool_priority: number }[];
        expect(rows[0]!.pool_priority).toBe(2);
    });
    it.each([
        "health = 'unknown'", "health = 'unhealthy'", 'editor_ready_at = NULL', 'ready_at = NULL', 'instance_id = NULL',
        "zone_id = 'aps1-az2'", "region = 'us-east-1'", "instance_type = 'm6i.xlarge'", "state = 'booting'", "state = 'retired'",
        'enrolled_at = NULL', 'generation = 0', 'generation = 9007199254740992',
        `leased_computer_id = '${uuid(999)}'`, "leased_at = '2026-10-23T11:59:00Z'", 'leased_generation = 1', `lease_token = '${uuid(999)}'`,
    ])('refuses ineligible candidate: %s', async update => {
        await ready(); await client!.unsafe(`UPDATE ${schema}.ezil_compute_pool_hosts SET ${update}`);
        expect(await lease()).toBeNull();
    });
    it.each([10, 10.001, -0.001])('ready/lease enrollment freshness rejects age %s minutes', async age => {
        await ready();
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET enrolled_at = ${ago(age).toISOString()}::timestamptz`);
        await expect(recordPoolReady(db, uuid(1), { editorOk: true }, NOW)).rejects.toThrow('pool_state_conflict');
        expect(await lease()).toBeNull();
    });
    it('freshness accepts just under ten minutes and rejects future ready/editor timestamps', async () => {
        await ready();
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET enrolled_at = ${ago(9.999).toISOString()}::timestamptz`);
        expect((await recordPoolReady(db, uuid(1), { editorOk: true }, NOW)).readyAt).toEqual(NOW);
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET ready_at = ${ago(-1).toISOString()}::timestamptz`);
        expect(await lease()).toBeNull();
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET ready_at = ${NOW.toISOString()}::timestamptz,
            editor_ready_at = ${ago(-1).toISOString()}::timestamptz`);
        expect(await lease()).toBeNull();
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET editor_ready_at = ${NOW.toISOString()}::timestamptz`);
        expect(await lease()).not.toBeNull();
    });
    it('enrollment binds one identity, readiness requires enrollment and preserves first ready time', async () => {
        await boot();
        await expect(recordPoolReady(db, uuid(1), { editorOk: true }, NOW)).rejects.toThrow('pool_state_conflict');
        const enrolled = await recordPoolEnrollment(db, uuid(1), 'i-1', ago(1));
        expect(enrolled).toMatchObject({ poolGeneration: 1, state: 'booting', instanceId: 'i-1', readyAt: null, enrolledAt: ago(1) });
        await expect(recordPoolEnrollment(db, uuid(1), 'i-evil', NOW)).rejects.toThrow('pool_state_conflict');
        await expect(recordPoolReady(db, uuid(1), { editorOk: false }, NOW)).rejects.toThrow('pool_editor_unhealthy');
        await recordPoolReady(db, uuid(1), { editorOk: true }, ago(0.5));
        expect((await recordPoolReady(db, uuid(1), { editorOk: true }, NOW)).readyAt).toEqual(ago(0.5));
        await lease();
        await expect(recordPoolEnrollment(db, uuid(1), 'i-1', NOW)).rejects.toThrow('pool_state_conflict');
        await expect(recordPoolReady(db, uuid(1), { editorOk: true }, NOW)).rejects.toThrow('pool_state_conflict');
    });
    it('single use transitions and expected-state CAS cannot revive a retired host', async () => {
        await ready(); await lease();
        expect(await markPoolHost(db, uuid(1), ['ready'], 'retiring', NOW)).toBeNull();
        expect((await markPoolHost(db, uuid(1), ['leased'], 'retiring', NOW))?.state).toBe('retiring');
        expect(await markPoolHost(db, uuid(1), ['leased'], 'retiring', NOW)).toBeNull();
        expect((await markPoolHost(db, uuid(1), ['retiring'], 'retired', NOW))?.state).toBe('retired');
        expect(await markPoolHost(db, uuid(1), ['retired'], 'ready', NOW)).toBeNull();
        await expect(recordPoolEnrollment(db, uuid(1), 'i-1', NOW)).rejects.toThrow();
    });
    it('boot failure moves through failed and retiring before retired', async () => {
        await boot();
        for (const [from, to] of [['booting', 'failed'], ['failed', 'retiring'], ['retiring', 'retired']] as [PoolHostState, PoolHostState][])
            expect((await markPoolHost(db, uuid(1), [from], to, NOW))?.state).toBe(to);
    });

    describe('stranded retirement through durable SQL dispatch', () => {
        const instanceId = 'i-11111111111111111';
        const deployment = fixtureDeployment('ap-south-1');
        // Exercise the real demand/planner path without requesting any new hosts.
        beforeEach(() => { vi.stubEnv('EZIL_AWS_KILL_SWITCH', '1'); });
        afterEach(() => { vi.unstubAllEnvs(); });
        const current = async () => (await db.execute(sql`SELECT * FROM public.ezil_compute_pool_hosts
            WHERE id = ${uuid(1)}::uuid`) as Record<string, unknown>[])[0]!;
        async function stranded() {
            await boot();
            await recordPoolEnrollment(db, uuid(1), instanceId, ago(1));
            await markPoolHost(db, uuid(1), ['booting'], 'retiring', ago(0.5));
        }
        function runtime() {
            // Only the AWS boundary is doubled; locks, candidates, CAS, storage and reconciliation use PostgreSQL.
            const starter = { start: vi.fn<LifecycleStarter['start']>(async () => {}) };
            const executions = { describe: vi.fn<LifecycleExecutionReader['describe']>(async () => { throw new Error('describe unavailable'); }) };
            const store = createPoolDispatchStore(db, { EZIL_AWS_KILL_SWITCH: '1' }, { starter, executions });
            const run = () => runPoolReplenish({ db, data: poolData, store, starter, classes: [c],
                deployments: { [c.region]: deployment }, now: () => NOW,
                withLock: fn => withPoolReplenishLock(db, fn), log: () => {}, sleep: async () => {} });
            return { starter, executions, store, run };
        }
        function receipt(work: LifecycleWork) {
            const i = work.intent;
            return { schemaVersion: 1, jobId: i.jobId, digest: work.digest, computerId: i.computerId,
                generation: i.targetGeneration, leaseEpoch: i.leaseEpoch, fenceToken: i.fenceToken,
                poolHostId: i.poolHostId, poolGeneration: i.poolGeneration, volumeId: null,
                instanceId, state: 'retired' };
        }
        function execution(work: LifecycleWork, status = 'RUNNING', patch: Record<string, unknown> = {}) {
            return { status, input: work.input, output: JSON.stringify({ ...receipt(work), ...patch }),
                executionArn: lifecycleExecutionArn(deployment, work.intent.jobId), stateMachineVersionArn: work.stateMachineArn };
        }
        const startArgs = (work: LifecycleWork) => [c.region, { stateMachineArn: work.stateMachineArn, name: work.name, input: work.input }];

        it('retries retiring -> retiring in PostgreSQL without reviving a retired row', async () => {
            await stranded();
            const before = await current();
            expect(before).toMatchObject({ state: 'retiring', instance_id: instanceId, leased_computer_id: null, lifecycle_job_id: null });
            const retried = await markPoolHost(db, uuid(1), ['retiring'], 'retiring', NOW);
            expect(retried).toMatchObject({ poolHostId: uuid(1), state: 'retiring', instanceId, poolGeneration: 1, leasedComputerId: null });
            const after = await current();
            expect(new Date(String(after.updated_at))).toEqual(NOW);
            expect({ ...after, updated_at: before.updated_at }).toEqual(before);
            expect((await markPoolHost(db, uuid(1), ['retiring'], 'retired', NOW))?.state).toBe('retired');
            const retired = await current();
            for (const to of ['booting', 'ready', 'leased', 'failed', 'retiring'] as PoolHostState[])
                expect(await markPoolHost(db, uuid(1), ['retired', 'retiring'], to, NOW)).toBeNull();
            await expect(recordPoolEnrollment(db, uuid(1), instanceId, NOW)).rejects.toThrow('pool_state_conflict');
            await expect(recordPoolReady(db, uuid(1), { editorOk: true }, NOW)).rejects.toThrow('pool_state_conflict');
            expect(await lease()).toBeNull();
            expect(await current()).toEqual(retired);
        });

        it.each([
            ['never left Observe-initial', 'retired', 0, (w: LifecycleWork) => failedReplaceHistory(w.input, NOW)],
            ['had its only launch refused for capacity', 'retired', 0, () => refusedLaunchHistory('LifecycleRefused')],
            ['entered a launch and ended unconfirmed', 'failed', 2, () => refusedLaunchHistory('LifecycleUnconfirmed')],
        ] as const)('settles a FAILED provision that %s as %s in one reconcile and releases its vCPU only when proven', async (_case, state, vcpu, history) => {
            await boot();
            const w = poolWork(c, deployment, 'pool-provision', poolData.poolHostFromRow(await current()));
            await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET lifecycle_job_id = ${w.intent.jobId}::uuid,
                lifecycle_digest = ${w.digest}, lifecycle_input = ${w.input}, dispatch_status = 'started' WHERE id = ${uuid(1)}::uuid`);
            expect(await readPoolDemand(db, c, NOW)).toMatchObject({ vcpuInUse: 2 });
            const executions = {
                describe: vi.fn<LifecycleExecutionReader['describe']>(async () => ({ status: 'FAILED', input: w.input, output: null, stopDate: new Date(),
                    executionArn: lifecycleExecutionArn(deployment, w.intent.jobId), stateMachineVersionArn: w.stateMachineArn })),
                history: vi.fn(async () => history(w)),
            };
            const store = createPoolDispatchStore(db, { EZIL_AWS_KILL_SWITCH: '1' }, { starter: { start: vi.fn(async () => {}) }, executions });
            await store.reconcile!();
            expect(await current()).toMatchObject({ state, dispatch_status: 'settled', instance_id: null, lifecycle_job_id: w.intent.jobId });
            expect(await readPoolDemand(db, c, NOW)).toMatchObject({ vcpuInUse: vcpu });
            // Settled rows leave the reconcile window: a second pass reads nothing.
            await store.reconcile!();
            expect(executions.describe).toHaveBeenCalledTimes(1);
        });

        it.each(['no job', 'settled provision'])('dispatches an existing retiring row with %s once, then settles only its receipt', async prior => {
            await stranded();
            if (prior === 'settled provision') {
                const old = poolWork(c, deployment, 'pool-provision', poolData.poolHostFromRow(await current()));
                await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET lifecycle_job_id = ${old.intent.jobId}::uuid,
                    lifecycle_digest = ${old.digest}, lifecycle_input = ${old.input}, dispatch_status = 'settled' WHERE id = ${uuid(1)}::uuid`);
            }
            const h = runtime();
            const observed: Record<string, unknown>[] = [];
            h.starter.start.mockImplementation(async () => { observed.push(await current()); });
            const first = await h.run();
            expect(first).toMatchObject([{ retired: 1, provisioned: 0, retirements: [{ poolHostId: uuid(1), outcome: 'started' }] }]);
            expect(h.starter.start).toHaveBeenCalledTimes(1);
            const saved = await current(), work = storedPoolWork(saved);
            expect(work.intent).toMatchObject({ operation: 'pool-retire', poolHostId: uuid(1), providerInstanceId: instanceId, poolGeneration: 1 });
            expect(first![0]!.retirements).toEqual([{ poolHostId: uuid(1), jobId: work.intent.jobId, outcome: 'started' }]);
            expect(h.starter.start.mock.calls[0]).toEqual(startArgs(work));
            // A separate pool connection can see the pending work at StartExecution: the reservation committed first.
            expect(observed).toHaveLength(1);
            expect(observed[0]).toMatchObject({ state: 'retiring', dispatch_status: 'pending', lifecycle_job_id: work.intent.jobId,
                lifecycle_digest: work.digest, lifecycle_input: work.input });
            h.executions.describe.mockResolvedValue(execution(work));
            expect(await h.run()).toMatchObject([{ retired: 0, provisioned: 0, retirements: [] }]);
            expect(h.starter.start).toHaveBeenCalledTimes(1);
            expect(await current()).toEqual(saved);
            h.executions.describe.mockResolvedValue(execution(work, 'SUCCEEDED'));
            await h.store.reconcile!();
            expect(await current()).toMatchObject({ state: 'retired', dispatch_status: 'settled', instance_id: instanceId,
                lifecycle_job_id: work.intent.jobId, lifecycle_digest: work.digest, lifecycle_input: work.input });
            const retired = await current();
            expect(await markPoolHost(db, uuid(1), ['retired', 'retiring'], 'retiring', NOW)).toBeNull();
            expect(await h.run()).toMatchObject([{ retired: 0, provisioned: 0, retirements: [] }]);
            expect(h.starter.start).toHaveBeenCalledTimes(1);
            expect(await current()).toEqual(retired);
        });

        it('two concurrent stale candidates save only one job and cannot overwrite its input or execution name', async () => {
            await stranded();
            const h = runtime(), candidate = poolData.poolHostFromRow(await current());
            const prepare = () => db.transaction(tx => h.store.prepare(tx, c, 'pool-retire', host => poolWork(c, deployment, 'pool-retire', host), candidate));
            const results = await Promise.allSettled([prepare(), prepare()]);
            const winners = results.filter(r => r.status === 'fulfilled');
            const losers = results.filter(r => r.status === 'rejected');
            expect(winners).toHaveLength(1);
            expect(losers).toHaveLength(1);
            expect(losers[0]!.reason.message).toContain('dispatch_saved');
            const work = winners[0]!.value, saved = await current();
            expect(storedPoolWork(saved)).toEqual(work);
            expect(saved).toMatchObject({ state: 'retiring', dispatch_status: 'pending', lifecycle_job_id: work.intent.jobId,
                lifecycle_input: work.input, lifecycle_digest: work.digest });
            await expect(prepare()).rejects.toThrow('dispatch_saved');
            expect(await current()).toEqual(saved);
            const jobs = await db.execute(sql`SELECT count(*)::int AS count FROM public.ezil_compute_pool_hosts WHERE lifecycle_job_id IS NOT NULL`);
            expect(jobs).toMatchObject([{ count: 1 }]);
            expect(h.starter.start).not.toHaveBeenCalled();
        });

        it.each(['pending', 'unknown', 'started'])('guards a %s job while execution status is unavailable or inflight', async status => {
            await stranded();
            const h = runtime(); await h.run();
            await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET dispatch_status = ${status} WHERE id = ${uuid(1)}::uuid`);
            const saved = await current(), work = storedPoolWork(saved);
            h.starter.start.mockClear();
            expect(await h.store.retirementCandidates!(db, c, 'retiring')).toEqual([]);
            expect(await db.transaction(tx => h.store.canRetire!(tx, uuid(1)))).toBe(false);
            expect(await h.run()).toMatchObject([{ retired: 0, provisioned: 0, retirements: [] }]);
            expect(await current()).toEqual(saved);
            h.executions.describe.mockResolvedValue(execution(work));
            expect(await h.run()).toMatchObject([{ retired: 0, provisioned: 0, retirements: [] }]);
            expect(await current()).toEqual(saved);
            expect(h.starter.start).not.toHaveBeenCalled();
        });

        it('retries a missing unknown execution using the exact durable input and execution name', async () => {
            await stranded();
            const h = runtime();
            h.starter.start.mockRejectedValue(new Error('lost start response'));
            expect(await h.run()).toMatchObject([{ retired: 0, retirements: [{ outcome: 'unknown' }] }]);
            const saved = await current(), work = storedPoolWork(saved);
            expect(saved.dispatch_status).toBe('unknown');
            expect(h.starter.start.mock.calls.length).toBeGreaterThan(1);
            for (const call of h.starter.start.mock.calls) expect(call).toEqual(startArgs(work));
            h.starter.start.mockReset().mockResolvedValue(undefined);
            h.executions.describe.mockRejectedValue(Object.assign(new Error('absent'), { name: 'ExecutionDoesNotExist' }));
            expect(await h.run()).toMatchObject([{ retired: 0, provisioned: 0, retirements: [] }]);
            expect(h.starter.start.mock.calls).toEqual([startArgs(work)]);
            expect(storedPoolWork(await current())).toEqual(work);
            expect(await current()).toMatchObject({ state: 'retiring', dispatch_status: 'started' });
        });

        it.each([
            `leased_computer_id = '${uuid(101)}'`, 'claim_generation = 3', 'claim_lease_epoch = 4',
            `claim_fence = '${claim.fence}'`, `claim_volume_serial = '${claim.volumeSerial}'`,
            "state = 'leased'", "state = 'retired'", 'instance_id = NULL',
        ])('does not steal or dispatch an ineligible retiring candidate: %s', async update => {
            await stranded();
            await client!.unsafe(`UPDATE ${schema}.ezil_compute_pool_hosts SET ${update}`);
            const before = await current(), h = runtime();
            expect(await h.store.retirementCandidates!(db, c, 'retiring')).toEqual([]);
            expect(await h.run()).toMatchObject([{ retired: 0, provisioned: 0, retirements: [] }]);
            expect(h.starter.start).not.toHaveBeenCalled();
            expect(await current()).toEqual(before);
        });

        it.each([
            { jobId: uuid(999) }, { digest: 'f'.repeat(64) }, { instanceId: 'i-22222222222222222' },
            { fenceToken: uuid(999) }, { poolHostId: uuid(999) }, { poolGeneration: 2 },
            { generation: 2 }, { leaseEpoch: 2 }, { state: 'running' },
        ])('rejects a mismatched retirement receipt without changing the SQL row: %j', async patch => {
            await stranded();
            const h = runtime(); await h.run();
            const saved = await current(), work = storedPoolWork(saved);
            h.executions.describe.mockResolvedValue(execution(work, 'SUCCEEDED', patch));
            await expect(h.store.reconcile!()).rejects.toThrow('dispatch_receipt');
            expect(await current()).toEqual(saved);
            expect(h.starter.start).toHaveBeenCalledTimes(1);
        });

        it('denies authority and settlement when the instance no longer matches the saved job', async () => {
            await stranded();
            const h = runtime(); await h.run();
            const work = storedPoolWork(await current()), i = work.intent;
            const authority = { computerId: i.computerId, jobId: i.jobId, digest: work.digest, leaseEpoch: i.leaseEpoch,
                poolHostId: i.poolHostId!, poolGeneration: i.poolGeneration!, operation: i.operation };
            expect(await poolJobAuthority(db, authority, {})).toBe(true);
            await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET instance_id = 'i-22222222222222222' WHERE id = ${uuid(1)}::uuid`);
            const changed = await current();
            expect(await poolJobAuthority(db, authority, {})).toBe(false);
            h.executions.describe.mockResolvedValue(execution(work, 'SUCCEEDED'));
            await expect(h.store.reconcile!()).rejects.toThrow('dispatch_receipt');
            expect(await current()).toEqual(changed);
        });
    });
    it('claim is hidden until published, tied to holder/identity, immutable and hidden after retirement', async () => {
        await ready();
        await expect(publishPoolClaim(db, uuid(1), claim, NOW)).rejects.toThrow('pool_state_conflict');
        await lease(); expect(await readPoolClaim(db, uuid(1), 'i-1')).toBeNull();
        await expect(publishPoolClaim(db, uuid(1), { ...claim, computerId: uuid(999) }, NOW)).rejects.toThrow('pool_state_conflict');
        const published = await publishPoolClaim(db, uuid(1), claim, NOW);
        expect(published).toMatchObject({ claimGeneration: 3, claimLeaseEpoch: 4, claimFence: claim.fence, claimVolumeSerial: claim.volumeSerial });
        expect(await publishPoolClaim(db, uuid(1), claim, NOW)).toEqual(published);
        expect(await readPoolClaim(db, uuid(1), 'i-other')).toBeNull();
        expect(await readPoolClaim(db, uuid(2), 'i-1')).toBeNull();
        expect(await readPoolClaim(db, uuid(1), 'i-1')).toEqual(published);
        for (const patch of [{ generation: 4 }, { leaseEpoch: 5 }, { fence: uuid(202) }, { volumeSerial: 'volother' }])
            await expect(publishPoolClaim(db, uuid(1), { ...claim, ...patch }, NOW)).rejects.toThrow('pool_state_conflict');
        await markPoolHost(db, uuid(1), ['leased'], 'retiring', NOW);
        expect(await readPoolClaim(db, uuid(1), 'i-1')).toBeNull();
    });
    it.each(['claim_generation', 'claim_lease_epoch', 'claim_fence', 'claim_volume_serial', 'leased_computer_id'])('hides partial claim missing %s', async column => {
        await ready(); await lease(); await publishPoolClaim(db, uuid(1), claim, NOW);
        await client!.unsafe(`UPDATE ${schema}.ezil_compute_pool_hosts SET ${column} = NULL`);
        expect(await readPoolClaim(db, uuid(1), 'i-1')).toBeNull();
    });
    it('migration reapplies without data loss and leaves RLS and client privileges unchanged', async () => {
        await ready();
        for (let i = 0; i < 2; i++) await client!.unsafe(local(readFileSync(path.join(directory, '0003_pool_hosts_v2.sql.txt'), 'utf8')));
        expect(await lease()).not.toBeNull();
        const result = await client!.unsafe(`SELECT relrowsecurity,
            has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE') AS anon_access,
            has_table_privilege('authenticated', oid, 'SELECT,INSERT,UPDATE,DELETE') AS authenticated_access
            FROM pg_class WHERE oid = '${schema}.ezil_compute_pool_hosts'::regclass`);
        expect(result[0]).toMatchObject({ relrowsecurity: true, anon_access: false, authenticated_access: false });
    });

    async function subscriber(n: number, sku = 'standard_monthly_v3', status = 'active') {
        await db.execute(sql`INSERT INTO auth.users (id) VALUES (${uuid(n)}::uuid) ON CONFLICT DO NOTHING`);
        await db.execute(sql`INSERT INTO public.ezil_billing_grants VALUES (${uuid(n)}::uuid, ${`sub-${n}`}, 'compute_std_seconds', 3600,
            ${ago(60).toISOString()}::timestamptz, ${ago(-60).toISOString()}::timestamptz)`);
        await db.execute(sql`INSERT INTO public.ezil_billing_subscriptions VALUES (${`sub-${n}`}, ${uuid(n)}::uuid, ${sku}, ${status},
            ${ago(60).toISOString()}::timestamptz, ${ago(-60).toISOString()}::timestamptz)`);
    }
    async function placement(n: number, owner = n, instanceType = 'm6i.large', state = 'STOPPED') {
        await db.execute(sql`INSERT INTO public.ezil_computer_placements
            (computer_id, owner_user_id, provider, generation, lease_epoch, state, region, zone_id, instance_type, updated_at)
            VALUES (${uuid(n)}::uuid, ${uuid(owner)}::uuid, 'aws-ec2', 1, 1, ${state}, ${c.region}, ${c.zoneId}, ${instanceType}, ${NOW.toISOString()}::timestamptz)`);
    }
    async function epoch(n: number, computer: number, owner: number, minutes = 1, size = 'std-2') {
        await db.execute(sql`INSERT INTO public.ezil_billing_compute_epochs VALUES (${uuid(n)}::uuid, ${uuid(owner)}::uuid,
            ${uuid(computer)}::uuid, ${`sub-${owner}`}, ${size}, ${ago(minutes).toISOString()}::timestamptz)`);
    }
    it('demand counts distinct paid epochs and effective subscribers, excludes other classes/regions and delinquent periods', async () => {
        await subscriber(1); await subscriber(2, 'premium_monthly_v3'); await subscriber(3, 'premium_monthly_v3', 'past_due');
        await subscriber(4, 'premium_monthly_v3'); await subscriber(5); await subscriber(6); await subscriber(7);
        await placement(1); await placement(11, 1); await placement(2); await placement(3); await placement(4, 4, 'm6i.xlarge');
        await placement(5); await placement(6); await placement(7);
        await db.execute(sql`INSERT INTO public.ezil_billing_size_preferences VALUES (${uuid(4)}::uuid, 'cmp-4')`);
        await db.execute(sql`UPDATE public.ezil_computer_placements SET zone_id = 'aps1-az2' WHERE computer_id = ${uuid(5)}::uuid`);
        await db.execute(sql`UPDATE public.ezil_billing_subscriptions SET current_period_end = ${NOW.toISOString()}::timestamptz WHERE user_id = ${uuid(6)}::uuid`);
        await db.execute(sql`UPDATE public.ezil_billing_subscriptions SET current_period_start = ${ago(-1).toISOString()}::timestamptz WHERE user_id = ${uuid(7)}::uuid`);
        await epoch(101, 1, 1); await epoch(102, 11, 1); await epoch(103, 2, 2);
        await epoch(104, 2, 2, 15); await epoch(105, 2, 2, -1); await epoch(106, 4, 4, 1, 'cmp-4'); await epoch(107, 5, 5);
        await epoch(108, 1, 2); // Wrong owner cannot inflate demand.
        await ready(20); await boot(21);
        expect(await readPoolDemand(db, c, NOW)).toMatchObject({ opens15m: 3, activeStandard: 1, activePremium: 1, spares: 2,
            bootMinutes: 4, vcpuInUse: 4, idleReady: [{ poolHostId: uuid(20), readyAt: NOW }], booting: [{ poolHostId: uuid(21), createdAt: ago(4) }] });
        await db.execute(sql`INSERT INTO public.ezil_billing_grants SELECT user_id, 'sub-new', meter, amount, period_start, period_end FROM public.ezil_billing_grants WHERE user_id = ${uuid(1)}::uuid`);
        // A later effective paid period replaces the earlier SKU, rather than counting the owner twice.
        await db.execute(sql`INSERT INTO public.ezil_billing_subscriptions VALUES ('sub-new', ${uuid(1)}::uuid, 'premium_monthly_v3', 'active',
            ${ago(60).toISOString()}::timestamptz, ${ago(-120).toISOString()}::timestamptz)`);
        expect(await readPoolDemand(db, c, NOW)).toMatchObject({ activeStandard: 0, activePremium: 2 });
    });
    it('paid subscribers before first placement share by selected shape; usage cannot create eligibility', async () => {
        expect((await readPoolDemand(db, c, NOW)).activeStandard).toBe(0);
        await subscriber(1); await subscriber(2, 'premium_monthly_v3');
        await subscriber(3, 'premium_monthly_v3'); await subscriber(4, 'premium_monthly_v3');
        await db.execute(sql`INSERT INTO public.ezil_billing_size_preferences VALUES
            (${uuid(3)}::uuid, 'cmp-4'), (${uuid(4)}::uuid, 'cmp-8')`);
        expect(await readPoolDemand(db, c, NOW)).toMatchObject({activeStandard:1, activePremium:1, opens15m:0});
        for (const instanceType of ['m6i.xlarge','m6i.2xlarge'] as const)
            expect(await readPoolDemand(db, {...c, instanceType}, NOW)).toMatchObject({activeStandard:0, activePremium:1});
        await db.execute(sql`DELETE FROM public.ezil_billing_grants WHERE user_id = ${uuid(2)}::uuid`);
        await placement(2); await epoch(102, 2, 2);
        expect((await readPoolDemand(db, c, NOW)).activePremium).toBe(0);
    });
    it.each(['past_due','incomplete','unpaid','canceled','trialing'])('unpaid/inactive %s never supplies a spare floor', async status => {
        await subscriber(1, 'premium_monthly_v3', status);
        expect((await readPoolDemand(db, c, NOW)).activePremium).toBe(0);
    });
    it('expired, refunded, banned, deleted and payment-failed users do not count; failed upgrades preserve paid Standard', async () => {
        for (let n=1;n<=6;n++) await subscriber(n);
        await db.execute(sql`UPDATE public.ezil_billing_subscriptions SET current_period_end = ${NOW.toISOString()}::timestamptz WHERE user_id = ${uuid(1)}::uuid`);
        await db.execute(sql`INSERT INTO public.ezil_billing_grants SELECT user_id,subscription_id,meter,-amount,period_start,period_end
            FROM public.ezil_billing_grants WHERE user_id = ${uuid(2)}::uuid`);
        await db.execute(sql`UPDATE auth.users SET banned_until = ${ago(-1).toISOString()}::timestamptz WHERE id = ${uuid(3)}::uuid`);
        await db.execute(sql`UPDATE auth.users SET deleted_at = ${NOW.toISOString()}::timestamptz WHERE id = ${uuid(4)}::uuid`);
        await db.execute(sql`INSERT INTO public.ezil_billing_payment_issues VALUES
            (${uuid(5)}::uuid,'sub-5','subscription',NULL,'payment_failed'),
            (${uuid(6)}::uuid,'sub-6','upgrade',NULL,'payment_failed')`);
        expect((await readPoolDemand(db, c, NOW)).activeStandard).toBe(1);
    });
    it.each([2,4,5,10])('pending demand %i excludes in-flight jobs and reservations prevent another launch', async n => {
        for (let i=1;i<=n;i++) { await subscriber(i); await placement(i,i,'m6i.large','PROVISIONING'); }
        const d = await readPoolDemand(db,c,NOW);
        expect(d.pending).toBe(n);
        // Demand-driven (66d9ad63): never more spares than paid users of the class, so n paid + n pending targets n.
        expect(poolData.planPool(c,{...d,regionVcpuCap:100},NOW)).toMatchObject({target:n,provision:2});
        await db.execute(sql`UPDATE public.ezil_computer_placements SET lifecycle_job_id = ${uuid(900)}::uuid`);
        expect((await readPoolDemand(db,c,NOW)).pending).toBe(0);
        await boot(101);
        expect(poolData.planPool(c,{...await readPoolDemand(db,c,NOW),regionVcpuCap:100},NOW).provision).toBe(0);
    });
    it('concurrent and repeated real SQL replenishes reserve one shared floor exactly once', async () => {
        vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(NOW);
        vi.stubEnv('AWS_REGIONS','ap-south-1'); vi.stubEnv('EZIL_AWS_MAX_RUNNING_AP_SOUTH_1','20');
        vi.stubEnv('EZIL_AWS_KILL_SWITCH','0');
        try {
            await subscriber(1); await subscriber(2,'premium_monthly_v3');
            const starter = {start:vi.fn(async () => {})}, deployment = fixtureDeployment('ap-south-1');
            const deps = {db,data:poolData,store:createPoolDispatchStore(db,process.env,{starter}),starter,
                classes:[{...c,deployment}],deployments:{[c.region]:deployment},now:()=>NOW,
                withLock:<T>(run:(tx?:PlacementExecutor)=>Promise<T>)=>withPoolReplenishLock(db,run),log:()=>{}};
            // A rejected try-lock is safe and expected for the losing caller.
            await Promise.allSettled([runPoolReplenish(deps),runPoolReplenish(deps)]);
            await runPoolReplenish(deps);
            expect(starter.start).toHaveBeenCalledTimes(1);
            expect((await readPoolDemand(db,{...c,deployment},NOW)).spares).toBe(1);
        } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
    });
    it('production prd: a real SQL replenish reserves the floor spare bound to the prd release', async () => {
        vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(NOW);
        vi.stubEnv('AWS_REGIONS','ap-south-1'); vi.stubEnv('EZIL_AWS_MAX_RUNNING_AP_SOUTH_1','20');
        vi.stubEnv('EZIL_AWS_KILL_SWITCH','0');
        try {
            await subscriber(1);
            const pilot = fixtureDeployment('ap-south-1');
            const deployment = {...pilot,namespace:'prd',stateMachineVersionArn:pilot.stateMachineVersionArn.replace('ezil-pilot-','ezil-prd-')};
            const starter = {start:vi.fn<LifecycleStarter['start']>(async () => {})};
            const deps = {db,data:poolData,store:createPoolDispatchStore(db,process.env,{starter}),starter,
                classes:[{...c,deployment}],deployments:{[c.region]:deployment},now:()=>NOW,
                withLock:<T>(run:(tx?:PlacementExecutor)=>Promise<T>)=>withPoolReplenishLock(db,run),log:()=>{}};
            await runPoolReplenish(deps);
            expect(starter.start).toHaveBeenCalledTimes(1);
            const [region, work] = starter.start.mock.calls[0]!;
            expect(region).toBe('ap-south-1');
            expect(work.stateMachineArn).toBe(deployment.stateMachineVersionArn);
            expect(JSON.parse(JSON.parse(work.input).document)).toMatchObject({operation:'pool-provision',deployment:{namespace:'prd'}});
            expect((await readPoolDemand(db,{...c,deployment},NOW)).spares).toBe(1);
            // The spare is bound to the prd release: another namespace's open can never count or lease it.
            expect((await readPoolDemand(db,{...c,deployment:pilot},NOW)).spares).toBe(0);
        } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
    });
    it('selects the current subscription before evaluating funding or issues',async()=>{
        await subscriber(1);
        await db.execute(sql`INSERT INTO public.ezil_billing_subscriptions VALUES ('sub-later',${uuid(1)}::uuid,'premium_monthly_v3','active',
            ${ago(60).toISOString()}::timestamptz,${ago(-120).toISOString()}::timestamptz)`);
        expect(await readPoolDemand(db,c,NOW)).toMatchObject({activeStandard:0,activePremium:0});
        await db.execute(sql`INSERT INTO public.ezil_billing_grants SELECT ${uuid(2)}::uuid,'sub-later',meter,amount,period_start,period_end FROM public.ezil_billing_grants`);
        expect(await readPoolDemand(db,c,NOW)).toMatchObject({activeStandard:0,activePremium:0});
        await db.execute(sql`INSERT INTO public.ezil_billing_grants SELECT user_id,'sub-later',meter,amount,period_start,period_end FROM public.ezil_billing_grants WHERE user_id=${uuid(1)}::uuid`);
        expect(await readPoolDemand(db,c,NOW)).toMatchObject({activeStandard:0,activePremium:1});
        await db.execute(sql`INSERT INTO public.ezil_billing_payment_issues VALUES (${uuid(1)}::uuid,'sub-later','subscription',NULL,'payment_failed')`);
        expect(await readPoolDemand(db,c,NOW)).toMatchObject({activeStandard:0,activePremium:0});
    });
    it('equal-period subscription duplicates select deterministically before funding, independent of insertion order',async()=>{
        await subscriber(1);
        await db.execute(sql`INSERT INTO public.ezil_billing_subscriptions SELECT 'sub-0',user_id,'premium_monthly_v3',status,current_period_start,current_period_end FROM public.ezil_billing_subscriptions`);
        // sub-0 wins the shared end/start tie; sub-1 funding must not leak across IDs.
        expect(await readPoolDemand(db,c,NOW)).toMatchObject({activeStandard:0,activePremium:0});
        await db.execute(sql`INSERT INTO public.ezil_billing_grants SELECT user_id,'sub-0',meter,amount,period_start,period_end FROM public.ezil_billing_grants`);
        expect(await readPoolDemand(db,c,NOW)).toMatchObject({activeStandard:0,activePremium:1});
    });
    it('warm capacity uses the same health and freshness guards as leasing',async()=>{
        await subscriber(1);await ready(1);await boot(2);
        let d=await readPoolDemand(db,c,NOW);expect(d).toMatchObject({ready:1,spares:2});
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET ready_at=${ago(31).toISOString()}::timestamptz,enrolled_at=${ago(11).toISOString()}::timestamptz WHERE id=${uuid(1)}::uuid`);
        d=await readPoolDemand(db,c,NOW);expect(d).toMatchObject({ready:0,spares:1});
        expect(await leasePoolHost(db,c,uuid(1),1,NOW)).toBeNull();
        expect(poolData.planPool(c,d,NOW).retire).toEqual([uuid(1)]);
    });
    it('obsolete settled boot timeout remains visible while claimed or leased hosts are excluded',async()=>{
        await boot(1); await boot(2); await boot(3);
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET created_at=${ago(11).toISOString()}::timestamptz,dispatch_status='settled',instance_id='i-'||right(replace(id::text,'-',''),17)`);
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET leased_computer_id=${uuid(100)}::uuid WHERE id=${uuid(2)}::uuid`);
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET claim_generation=1 WHERE id=${uuid(3)}::uuid`);
        const key={...c,deployment:fixtureDeployment('ap-south-1')},d=await readPoolDemand(db,key,NOW);
        expect(d.booting.map(h=>h.poolHostId)).toEqual([uuid(1)]);
        expect(poolData.planPool(key,d,NOW).fail).toEqual([uuid(1)]);
        const starter={start:vi.fn(async()=>{})};
        await runPoolReplenish({db,data:poolData,store:createPoolDispatchStore(db,{}, {starter}),starter,
            classes:[key],deployments:{[c.region]:key.deployment},now:()=>NOW,
            withLock:run=>withPoolReplenishLock(db,run),log:()=>{}});
        expect(starter.start).toHaveBeenCalledTimes(1);
        const remaining=await db.execute(sql`SELECT id,state FROM public.ezil_compute_pool_hosts ORDER BY id`) as Record<string,unknown>[];
        expect(remaining.map(h=>h.state)).toEqual(['retiring','booting','booting']);
    });
    it('deployment-bound demand and leasing never consume another release', async () => {
        const deployment = fixtureDeployment('ap-south-1');
        await subscriber(100); await ready(1);
        const w = poolWork(c,deployment,'pool-provision',poolData.poolHostFromRow((await db.execute(sql`SELECT * FROM public.ezil_compute_pool_hosts` ) as Record<string,unknown>[])[0]!));
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET lifecycle_input = ${w.input}`);
        expect((await readPoolDemand(db,{...c,deployment},NOW)).spares).toBe(1);
        const foreign = {...c,deployment:{...deployment,amiId:'ami-99999999999999999'}};
        expect((await readPoolDemand(db,foreign,NOW)).spares).toBe(0);
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET ready_at = ${ago(31).toISOString()}::timestamptz`);
        expect(poolData.planPool(foreign,await readPoolDemand(db,foreign,NOW),NOW).retire).toEqual([uuid(1)]);
        expect(await leasePoolHost(db,foreign,uuid(100),1,NOW)).toBeNull();
        expect(await leasePoolHost(db,{...c,deployment},uuid(100),1,NOW)).not.toBeNull();
    });
    it('regional vCPU includes other zones/types, failing and retiring spares, without double-counting adopted hosts', async () => {
        await ready(1); await lease(); await placement(101, 1, 'm6i.large', 'RUNNING');
        await db.execute(sql`UPDATE public.ezil_computer_placements SET instance_id = 'i-1'`);
        await boot(2); await markPoolHost(db, uuid(2), ['booting'], 'failed', NOW);
        await boot(3); await markPoolHost(db, uuid(3), ['booting'], 'retiring', NOW);
        await placement(4, 4, 'm6i.xlarge', 'PROVISIONING');
        await db.execute(sql`UPDATE public.ezil_computer_placements SET zone_id = 'aps1-az2' WHERE computer_id = ${uuid(4)}::uuid`);
        await placement(5, 5, 'unknown', 'UNCONFIRMED');
        expect((await readPoolDemand(db, c, NOW)).vcpuInUse).toBe(18);
        await db.execute(sql`UPDATE public.ezil_computer_placements SET instance_id = NULL WHERE computer_id = ${uuid(101)}::uuid`);
        expect((await readPoolDemand(db, c, NOW)).vcpuInUse).toBe(18);
        await markPoolHost(db, uuid(3), ['retiring'], 'retired', NOW);
        expect((await readPoolDemand(db, c, NOW)).vcpuInUse).toBe(16);
    });
    it('boot p90 uses only successful class boots within 24 hours, including leased hosts', async () => {
        expect((await readPoolDemand(db, c, NOW)).bootMinutes).toBeNull();
        await ready(1); await ready(2); await lease();
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET created_at = ${ago(8).toISOString()}::timestamptz WHERE id = ${uuid(2)}::uuid`);
        await ready(3);
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET ready_at = ${ago(1440).toISOString()}::timestamptz,
            created_at = ${ago(1500).toISOString()}::timestamptz WHERE id = ${uuid(3)}::uuid`);
        expect((await readPoolDemand(db, c, NOW)).bootMinutes).toBeCloseTo(7.6);
    });

    describe('CAPACITY durable demand on production PostgreSQL (1.0.16 run B shape: 10 vCPU cap)', () => {
        const deployment = fixtureDeployment('ap-south-1', ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge']);
        const xl: PoolClass = { ...c, instanceType: 'm6i.xlarge' };
        const ENV = { EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '5', AWS_REGIONS: 'ap-south-1', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '5',
            EZIL_AWS_USER_MONTHLY_HOURS: '75', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '250', EZIL_AWS_USER_MONTHLY_EGRESS_GB: '100',
            EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '1000', EZIL_AWS_KILL_SWITCH: '0' };
        beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); });
        afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
        const computer = async (n: number, owner = n) => db.execute(sql`INSERT INTO public.ezil_computers (id, user_id) VALUES (${uuid(n)}::uuid, ${uuid(owner)}::uuid)`);
        const live = async (n: number, state: string, instanceId: string | null, instanceType = 'm6i.large') => {
            await computer(n);
            await db.execute(sql`INSERT INTO public.ezil_computer_placements
                (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, region, zone_id, instance_type, instance_id, updated_at)
                VALUES (${uuid(n)}::uuid, ${uuid(n)}::uuid, 'aws-ec2', 'ebs', 2, 3, ${state}, ${c.region}, ${c.zoneId}, ${instanceType}, ${instanceId}, ${NOW.toISOString()}::timestamptz)`);
        };
        const host = async (n: number, cls: PoolClass, state: 'booting' | 'ready') => {
            await db.execute(sql`INSERT INTO public.ezil_compute_pool_hosts (id, region, zone_id, instance_type, created_at, updated_at)
                VALUES (${uuid(n)}::uuid, ${cls.region}, ${cls.zoneId}, ${cls.instanceType}, ${ago(4).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`);
            if (state === 'ready') { await recordPoolEnrollment(db, uuid(n), `i-${String(n).padStart(17, '0')}`, ago(1)); await recordPoolReady(db, uuid(n), { editorOk: true }, NOW); }
        };
        // Other user 2 + builder 2 + phantom UNCONFIRMED 2 (no instance) = 6 vCPU of placements.
        const paid = async (n: number) => {
            await db.execute(sql`INSERT INTO auth.users (id) VALUES (${uuid(n)}::uuid) ON CONFLICT DO NOTHING`);
            await db.execute(sql`INSERT INTO public.ezil_billing_grants VALUES (${uuid(n)}::uuid, ${`sub-${n}`}, 'compute_std_seconds', 3600,
                ${ago(60).toISOString()}::timestamptz, ${ago(-60).toISOString()}::timestamptz)`);
            await db.execute(sql`INSERT INTO public.ezil_billing_subscriptions VALUES (${`sub-${n}`}, ${uuid(n)}::uuid, 'standard_monthly_v3', 'active',
                ${ago(60).toISOString()}::timestamptz, ${ago(-60).toISOString()}::timestamptz)`);
        };
        const requester = async (n: number) => { await computer(n); await paid(n); };
        const runB = async () => { await live(201, 'RUNNING', 'i-0000000000000a201'); await live(202, 'RUNNING', 'i-0000000000000a202'); await live(203, 'UNCONFIRMED', null); };
        const runtime = () => {
            const starter = { start: vi.fn<LifecycleStarter['start']>(async () => {}) };
            const store = createPoolDispatchStore(db, { EZIL_AWS_KILL_SWITCH: '0' }, { starter, executions: { describe: vi.fn() } });
            const deps: PoolDemandDeps = { db, store, starter, env: ENV, deployments: { [c.region]: deployment }, now: () => NOW, killSwitch: () => false, sleep: async () => {} };
            return { starter, store, deps };
        };
        const want = (n: number, instanceType = 'm6i.large', kind: 'create' | 'wake' = 'create', source: { generation: number; leaseEpoch: number } | null = null) => ({
            kind, userId: uuid(n), computerId: uuid(n), requestId: randomUUID(), region: c.region, zoneId: c.zoneId, instanceType,
            deploymentDigest: demandDeploymentDigest(deployment), source });
        const demands = async () => await db.execute(sql`SELECT * FROM public.ezil_compute_capacity_demands ORDER BY created_at, id`) as Record<string, unknown>[];
        const counts = async () => ({ placements: Number(((await db.execute(sql`SELECT count(*) AS n FROM public.ezil_computer_placements`)) as Record<string, unknown>[])[0]!.n),
            usage: Number(((await db.execute(sql`SELECT count(*) AS n FROM public.ezil_compute_usage`)) as Record<string, unknown>[])[0]!.n) });
        const validate = (n: number) => db.transaction(async () => withAdmission(db, async (tx, lock) => {
            await tx.execute(sql`INSERT INTO public.ezil_computer_placements
                (computer_id, owner_user_id, provider, generation, lease_epoch, state, region, zone_id, instance_type, updated_at)
                VALUES (${uuid(n)}::uuid, ${uuid(n)}::uuid, 'aws-ec2', 1, 1, 'PROVISIONING', ${c.region}, ${c.zoneId}, 'm6i.large', ${NOW.toISOString()}::timestamptz)`);
            // The capacity check reads only identity/region/zone/type; the raw row above is what regional accounting counts.
            const p = { computerId: uuid(n), region: c.region, zoneId: c.zoneId, instanceType: 'm6i.large' } as Placement;
            await createPoolDeps(db, { ...process.env, EZIL_AWS_KILL_SWITCH: '0' }).validateCapacity!(tx, p, lock);
            throw new Error('rollback-probe-ok');
        })).catch((e: Error) => e);

        it('first-ever open: a booting xlarge spare is earmarked (never adopted), demand reserved, zero placement/usage writes', async () => {
            await runB(); await host(301, xl, 'booting'); await requester(401);
            const before = await counts(), { deps, starter } = runtime();
            expect(await reservePoolDemand(deps, want(401))).toBe('waiting');
            expect(await counts()).toEqual(before);
            expect(starter.start).not.toHaveBeenCalled(); // booting: earmark only, its provision job and liability retained
            const [d] = await demands();
            expect(d).toMatchObject({ state: 'active', kind: 'create', vcpu: 2, region: c.region, instance_type: 'm6i.large', closed_at: null });
            expect(d!.cleanup).toEqual([{ poolHostId: uuid(301), poolGeneration: 1, instanceType: 'm6i.xlarge', vcpu: 4, phase: 'booting', jobId: null }]);
            expect(await readPoolDemand(db, c, NOW)).toMatchObject({ demandVcpu: 2, earmarked: [uuid(301)] });
            // Even once ready, the earmarked host is never leased.
            await recordPoolEnrollment(db, uuid(301), 'i-00000000000000301', ago(1)); await recordPoolReady(db, uuid(301), { editorOk: true }, NOW);
            expect(await db.transaction(tx => leasePoolHost(tx, xl, uuid(999), 1, NOW))).toBeNull();
            // Launch accounting: the earmarked host stays counted until retired; the open still cannot launch.
            expect(await validate(401)).toMatchObject({ message: 'open_pool_capacity' });
        });
        it('a ready idle spare of another shape is retired through normal durable work bound to the demand; launch waits for its terminal receipt', async () => {
            await runB(); await host(302, xl, 'ready'); await requester(402);
            const { deps, starter } = runtime();
            expect(await reservePoolDemand(deps, want(402))).toBe('waiting');
            const [d] = await demands(), spare = ((await db.execute(sql`SELECT * FROM public.ezil_compute_pool_hosts WHERE id = ${uuid(302)}::uuid`)) as Record<string, unknown>[])[0]!;
            expect(spare).toMatchObject({ state: 'retiring', dispatch_status: 'started' });
            expect((d!.cleanup as { jobId: string }[])[0]).toMatchObject({ poolHostId: uuid(302), phase: 'retiring', jobId: spare.lifecycle_job_id });
            expect(starter.start).toHaveBeenCalledTimes(1);
            expect((await readPoolDemand(db, c, NOW)).vcpuInUse).toBe(10); // still physically counted while retiring
            expect(await validate(402)).toMatchObject({ message: 'open_pool_capacity' });
            await markPoolHost(db, uuid(302), ['retiring'], 'retired', NOW); // the bound terminal receipt settled
            expect(await validate(402)).toMatchObject({ message: 'rollback-probe-ok' }); // fits now and consumes the demand...
            expect((await demands())[0]).toMatchObject({ state: 'active' }); // ...inside the probe transaction, which rolled back
        });
        it('the holder consumes its demand exactly once; another computer cannot take the reserved capacity', async () => {
            await runB(); await host(303, xl, 'ready'); await requester(403); await requester(404);
            const { deps } = runtime();
            expect(await reservePoolDemand(deps, want(403))).toBe('waiting');
            await markPoolHost(db, uuid(303), ['retiring'], 'retired', NOW);
            // U = 6 placements + 2 (the other computer's own new row) and H = 2 reserved for 403: 10, so 404 still fits only if H were ignored.
            await live(205, 'RUNNING', 'i-0000000000000a205');
            expect(await validate(404)).toMatchObject({ message: 'open_pool_capacity' });
            const consumed = await db.transaction(async () => withAdmission(db, async (tx, lock) => {
                await tx.execute(sql`DELETE FROM public.ezil_computer_placements WHERE computer_id = ${uuid(205)}::uuid`);
                await tx.execute(sql`INSERT INTO public.ezil_computer_placements
                    (computer_id, owner_user_id, provider, generation, lease_epoch, state, region, zone_id, instance_type, updated_at)
                    VALUES (${uuid(403)}::uuid, ${uuid(403)}::uuid, 'aws-ec2', 1, 1, 'PROVISIONING', ${c.region}, ${c.zoneId}, 'm6i.large', ${NOW.toISOString()}::timestamptz)`);
                const pool = createPoolDeps(db, { ...process.env, ...ENV });
                const p = { computerId: uuid(403), ownerUserId: uuid(403), region: c.region, zoneId: c.zoneId, instanceType: 'm6i.large' } as Placement;
                // Claimed before any pool lease, bound to this exact open, then consumed by the capacity check.
                const own = await pool.claimDemand!(tx, p, lock, { kind: 'create', source: null, deploymentDigest: demandDeploymentDigest(deployment) });
                expect(own).toMatchObject({ computerId: uuid(403) });
                await pool.validateCapacity!(tx, p, lock, own);
                return true;
            }));
            expect(consumed).toBe(true);
            expect((await demands())[0]).toMatchObject({ state: 'consumed', revision: 2 });
            expect((await readPoolDemand(db, c, NOW)).demandVcpu).toBe(0);
        });
        it('competing owners: exactly one active regional demand under real concurrent connections', async () => {
            await runB(); await host(304, xl, 'ready'); await host(305, xl, 'ready'); await requester(405); await requester(406);
            const { deps } = runtime();
            const outcomes = await Promise.all([reservePoolDemand(deps, want(405)), reservePoolDemand(deps, want(406))]);
            expect(outcomes.sort()).toEqual(['refused', 'waiting']);
            expect((await demands()).filter(d => d.closed_at === null)).toHaveLength(1);
        });
        it('an exact repeat reuses the reservation; a changed target never rewrites it; capacity that already fits retries', async () => {
            await runB(); await host(306, xl, 'ready'); await requester(407);
            const { deps } = runtime();
            expect(await reservePoolDemand(deps, want(407))).toBe('waiting');
            expect(await reservePoolDemand(deps, want(407))).toBe('waiting');
            expect(await reservePoolDemand(deps, want(407, 'm6i.xlarge'))).toBe('refused');
            expect(await demands()).toHaveLength(1);
            await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_capacity_demands, ${schema}.ezil_compute_pool_hosts`);
            await requester(408);
            expect(await reservePoolDemand(deps, want(408))).toBe('retry'); // 6 + 2 <= 10: nothing to reclaim
            expect(await demands()).toHaveLength(0);
        });
        it('no reclaimable capacity refuses without a demand; a stale wake snapshot refuses', async () => {
            await runB(); await live(206, 'RUNNING', 'i-0000000000000a206'); await live(207, 'RUNNING', 'i-0000000000000a207'); await requester(409);
            const { deps } = runtime();
            expect(await reservePoolDemand(deps, want(409))).toBe('refused');
            await db.execute(sql`UPDATE public.ezil_computer_placements SET state = 'STOPPED' WHERE computer_id = ${uuid(207)}::uuid`); await paid(207);
            expect(await reservePoolDemand(deps, want(207, 'm6i.large', 'wake', { generation: 2, leaseEpoch: 2 }))).toBe('refused');
            expect(await demands()).toHaveLength(0);
        });
        it('fixed DB-clock expiry and stop cancellation close demands; orphaned demands are cancelled', async () => {
            await runB(); await host(307, xl, 'ready'); await requester(410);
            const { deps } = runtime();
            expect(await reservePoolDemand(deps, want(410))).toBe('waiting');
            expect(await cancelComputerDemand(db, uuid(410), uuid(410))).toBe(true);
            expect((await demands())[0]).toMatchObject({ state: 'cancelled' });
            // Cancellation never undoes a committed retirement: it stays counted until its terminal receipt settles.
            expect(((await db.execute(sql`SELECT state FROM public.ezil_compute_pool_hosts WHERE id = ${uuid(307)}::uuid`)) as Record<string, unknown>[])[0]!.state).toBe('retiring');
            await markPoolHost(db, uuid(307), ['retiring'], 'retired', NOW);
            await host(308, xl, 'ready'); await requester(411);
            expect(await reservePoolDemand(deps, want(411))).toBe('waiting');
            await db.execute(sql`UPDATE public.ezil_compute_capacity_demands SET expires_at = now() - interval '1 second', created_at = now() - interval '2 seconds'
                WHERE computer_id = ${uuid(411)}::uuid`);
            expect(await withAdmission(db, (tx, lock) => closeExpiredDemands(tx, lock))).toBe(1);
            await markPoolHost(db, uuid(308), ['retiring'], 'retired', NOW);
            await host(309, xl, 'ready'); await requester(412);
            expect(await reservePoolDemand(deps, want(412))).toBe('waiting');
            await db.execute(sql`UPDATE public.ezil_computers SET deleted_at = now() WHERE id = ${uuid(412)}::uuid`);
            expect(await withAdmission(db, (tx, lock) => closeOrphanedDemands(tx, lock))).toBe(1);
            expect(Object.fromEntries((await demands()).map(d => [d.computer_id, d.state])))
                .toEqual({ [uuid(410)]: 'cancelled', [uuid(411)]: 'expired', [uuid(412)]: 'cancelled' });
        });
        it('a Cloudflare pin never wins against an active AWS demand', async () => {
            await runB(); await host(310, xl, 'ready'); await requester(413);
            expect(await reservePoolDemand(runtime().deps, want(413))).toBe('waiting');
            expect(await pinCloudflarePlacement(db, { computerId: uuid(413), userId: uuid(413) }, { honorDemand: true }))
                .toEqual({ provider: 'aws-ec2', store: 'ebs', record: null });
            expect((await readPlacement(db, uuid(413))).record).toBeNull();
        });
        // ---- Root early capacity review 23625381 (13:04Z): focused negatives ----
        it('P1: the reservation reauthorizes the whole open: unpaid, image-reserved, migrating, second-computer and over-cap owners never retire spares', async () => {
            const { deps, starter } = runtime();
            await runB(); await host(320, xl, 'ready');
            await computer(420); // not paid
            expect(await reservePoolDemand(deps, want(420))).toBe('refused');
            await live(421, 'STOPPED', null); await paid(421); // an image reservation on its (wake) placement
            await db.execute(sql`UPDATE public.ezil_computer_placements SET image_upgrade_job_id = ${randomUUID()}::uuid WHERE computer_id = ${uuid(421)}::uuid`);
            expect(await reservePoolDemand(deps, want(421, 'm6i.large', 'wake', { generation: 2, leaseEpoch: 3 }))).toBe('refused');
            await requester(422);
            await db.execute(sql`INSERT INTO public.ezil_compute_migrations (user_id, computer_id, from_provider, to_provider, to_size, state)
                VALUES (${uuid(422)}::uuid, ${uuid(422)}::uuid, 'cloudflare', 'aws-ec2', 'standard', 'requested')`);
            expect(await reservePoolDemand(deps, want(422))).toBe('refused');
            await requester(423); await live(424, 'STOPPED', null); // 424 is a second AWS computer of owner 423
            await db.execute(sql`UPDATE public.ezil_computer_placements SET owner_user_id = ${uuid(423)}::uuid WHERE computer_id = ${uuid(424)}::uuid`);
            await db.execute(sql`UPDATE public.ezil_computers SET user_id = ${uuid(423)}::uuid WHERE id = ${uuid(424)}::uuid`);
            expect(await reservePoolDemand(deps, want(423))).toBe('refused');
            expect(await demands()).toHaveLength(0);
            expect(starter.start).not.toHaveBeenCalled();
            expect(((await db.execute(sql`SELECT state FROM public.ezil_compute_pool_hosts WHERE id = ${uuid(320)}::uuid`)) as Record<string, unknown>[])[0]!.state).toBe('ready');
        });
        it('P2-3: a booting host whose provision already settled with its instance is retired at once, not earmarked', async () => {
            const { deps, starter, store } = runtime();
            await runB(); await host(321, xl, 'booting'); await requester(425);
            const provision = poolWork(xl, deployment, 'pool-provision', poolData.poolHostFromRow(((await db.execute(sql`SELECT * FROM public.ezil_compute_pool_hosts WHERE id = ${uuid(321)}::uuid`)) as Record<string, unknown>[])[0]!));
            await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET instance_id = 'i-00000000000000321', lifecycle_job_id = ${provision.intent.jobId}::uuid,
                lifecycle_digest = ${provision.digest}, lifecycle_input = ${provision.input}, dispatch_status = 'settled' WHERE id = ${uuid(321)}::uuid`);
            expect(await store.canRetire!(db, uuid(321))).toBe(true);
            expect(await reservePoolDemand(deps, want(425))).toBe('waiting');
            expect((await demands())[0]!.cleanup).toMatchObject([{ poolHostId: uuid(321), phase: 'retiring' }]);
            expect(starter.start).toHaveBeenCalledTimes(1);
        });
        it('P2-4: consumption needs this open\'s own LIVE, exactly bound demand; a mismatched or expired one grants no credit', async () => {
            const { deps } = runtime();
            await runB(); await host(322, xl, 'ready'); await requester(426);
            expect(await reservePoolDemand(deps, want(426))).toBe('waiting');
            await markPoolHost(db, uuid(322), ['retiring'], 'retired', NOW);
            const pool = createPoolDeps(db, { ...process.env, ...ENV });
            const claim = (binding: { kind: 'create' | 'wake'; source: { generation: number; leaseEpoch: number } | null; deploymentDigest: string }, patch: Partial<Placement> = {}) =>
                withAdmission(db, (tx, lock) => pool.claimDemand!(tx, { computerId: uuid(426), ownerUserId: uuid(426), region: c.region, zoneId: c.zoneId,
                    instanceType: 'm6i.large', ...patch } as Placement, lock, binding));
            const ok = { kind: 'create' as const, source: null, deploymentDigest: demandDeploymentDigest(deployment) };
            expect(await claim(ok)).toMatchObject({ computerId: uuid(426) });
            expect(await claim({ ...ok, deploymentDigest: 'b'.repeat(64) })).toBeNull();
            expect(await claim({ ...ok, kind: 'wake', source: { generation: 1, leaseEpoch: 1 } })).toBeNull();
            expect(await claim(ok, { instanceType: 'm6i.xlarge' })).toBeNull();
            expect(await claim(ok, { ownerUserId: uuid(999) })).toBeNull();
            await db.execute(sql`UPDATE public.ezil_compute_capacity_demands SET expires_at = now() - interval '1 second', created_at = now() - interval '2 seconds'`);
            expect(await claim(ok)).toBeNull(); // DB-clock expiry: no credit even before the sweep closes it
            expect((await demands())[0]).toMatchObject({ state: 'active' }); // never consumed while expired
        });
        it('P2-5: shared admission counters (ordinary and image) count pending demand once and hold the owner\'s one-computer allowance', async () => {
            const { deps } = runtime();
            await runB(); await host(323, xl, 'ready'); await requester(427); await requester(428);
            expect(await reservePoolDemand(deps, want(427))).toBe('waiting');
            const read = (computerId: string, userId: string) => withAdmission(db, (tx, lock) => readAdmissionCounters(tx, lock, { userId, computerId, monthStart: ago(60 * 24), now: NOW }));
            const other = await read(uuid(428), uuid(428)), mine = await read(uuid(427), uuid(427));
            expect(other.runningVcpu - mine.runningVcpu).toBe(2); // the demand counts for everyone else, never for its own open
            await computer(429, 427);
            expect((await read(uuid(429), uuid(427))).userOtherAwsComputers).toBe(1); // demand holds owner 427's allowance
        });
        it('P2-6: an expired attempt stays terminal however long polling continues; only the owner\'s explicit stop begins a fresh attempt', async () => {
            const { deps } = runtime();
            await runB(); await host(324, xl, 'ready'); await requester(430);
            expect(await reservePoolDemand(deps, want(430))).toBe('waiting');
            await db.execute(sql`UPDATE public.ezil_compute_capacity_demands SET expires_at = now() - interval '1 second', created_at = now() - interval '2 seconds'`);
            await markPoolHost(db, uuid(324), ['retiring'], 'retired', NOW); await host(325, xl, 'ready');
            // RETRY-118: the terminal answer is the distinct expired outcome carrying that attempt's id (was 'refused').
            const expiredId = async (n: number) => (await demands()).find(d => d.computer_id === uuid(n) && d.state === 'expired')?.id;
            expect(await reservePoolDemand(deps, want(430))).toEqual({ outcome: 'expired', attemptId: await expiredId(430) }); // the sweep closes it as expired; the attempt is terminal
            await db.execute(sql`UPDATE public.ezil_compute_capacity_demands SET closed_at = now() - interval '1 day',
                expires_at = now() - interval '1 day' + interval '1 second', created_at = now() - interval '1 day'`);
            expect(await reservePoolDemand(deps, want(430))).toEqual({ outcome: 'expired', attemptId: await expiredId(430) }); // elapsed time alone never restarts it
            expect(await cancelComputerDemand(db, uuid(430), uuid(430))).toBe(true); // explicit authenticated stop
            expect((await demands()).map(d => d.state).sort()).toEqual(['cancelled', 'expired']); // the expired record is kept
            expect(await reservePoolDemand(deps, want(430))).toBe('waiting'); // a fresh attempt
            expect(await cancelComputerDemand(db, uuid(430), uuid(999))).toBe(false); // never another owner's
        });
        it('RETRY-118: an explicit Retry resets only the owner\'s newest unreleased expired attempt; foreign, duplicate, placement, active and newer attempts touch nothing', async () => {
            const { deps } = runtime();
            await runB(); await host(340, xl, 'ready'); await requester(440); await requester(441);
            expect(await reservePoolDemand(deps, want(440))).toBe('waiting');
            await db.execute(sql`UPDATE public.ezil_compute_capacity_demands SET expires_at = now() - interval '1 second', created_at = now() - interval '2 seconds'
                WHERE computer_id = ${uuid(440)}::uuid`);
            // As in P2-6: the first reservation's reclaim settles; fresh idle capacity exists for the eventual reopen.
            await markPoolHost(db, uuid(340), ['retiring'], 'retired', NOW); await host(341, xl, 'ready');
            const outcome = await reservePoolDemand(deps, want(440));
            expect(outcome).toMatchObject({ outcome: 'expired' });
            const attemptId = (outcome as { attemptId: string }).attemptId;
            const rows = async () => (await demands()).filter(d => d.computer_id === uuid(440)).map(d => ({ id: d.id, state: d.state, closed_at: d.closed_at, revision: d.revision }));
            const snapshot = await rows();
            expect(snapshot).toEqual([expect.objectContaining({ id: attemptId, state: 'expired' })]);
            const reset = (over: Partial<{ computerId: string; ownerUserId: string; attemptId: string }> = {}) =>
                resetCapacityAttempt(db, { computerId: uuid(440), ownerUserId: uuid(440), attemptId, ...over });
            // Foreign owner, unknown id, another computer: not_found, no write.
            expect(await reset({ ownerUserId: uuid(441) })).toBe('not_found');
            expect(await reset({ attemptId: randomUUID() })).toBe('not_found');
            expect(await reset({ computerId: uuid(441), ownerUserId: uuid(441) })).toBe('not_found');
            expect(await rows()).toEqual(snapshot);
            // A placement admitted first: superseded, untouched.
            await db.execute(sql`INSERT INTO public.ezil_computer_placements
                (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, region, zone_id, instance_type, instance_id, updated_at)
                VALUES (${uuid(440)}::uuid, ${uuid(440)}::uuid, 'aws-ec2', 'ebs', 1, 1, 'UNCONFIRMED', ${c.region}, ${c.zoneId}, 'm6i.large', NULL, ${NOW.toISOString()}::timestamptz)`);
            expect(await reset()).toBe('superseded');
            expect(await rows()).toEqual(snapshot);
            await db.execute(sql`DELETE FROM public.ezil_computer_placements WHERE computer_id = ${uuid(440)}::uuid`); // fixture only
            // An active demand appearing first: superseded, untouched.
            const copy = (state: string, closed: string, expires: string, created = 'now()') => db.execute(sql.raw(`INSERT INTO ${schema}.ezil_compute_capacity_demands
                (request_id, owner_user_id, computer_id, kind, region, zone_id, instance_type, vcpu, deployment_digest, source_generation, source_lease_epoch,
                 state, cleanup, created_at, expires_at, closed_at)
                SELECT gen_random_uuid(), owner_user_id, computer_id, kind, region, zone_id, instance_type, vcpu, deployment_digest, source_generation, source_lease_epoch,
                    '${state}', '[]'::jsonb, ${created}, ${expires}, ${closed} FROM ${schema}.ezil_compute_capacity_demands WHERE id = '${attemptId}' RETURNING id`)) as Promise<Record<string, unknown>[]>;
            const [active] = await copy('active', 'NULL', "now() + interval '5 minutes'");
            expect(await reset()).toBe('superseded');
            await db.execute(sql`DELETE FROM public.ezil_compute_capacity_demands WHERE id = ${active!.id as string}::uuid`); // fixture only
            expect(await rows()).toEqual(snapshot);
            // A newer expired attempt exists: the older one is superseded.
            const [newer] = await copy('expired', "now() + interval '1 second'", "now() - interval '1 second'", "now() - interval '2 seconds'");
            expect(await reset()).toBe('superseded');
            await db.execute(sql`DELETE FROM public.ezil_compute_capacity_demands WHERE id = ${newer!.id as string}::uuid`); // fixture only
            expect(await rows()).toEqual(snapshot);
            // The owner's Retry: exactly one closed 'cancelled' marker; the expired record itself is kept unchanged.
            expect(await reset()).toBe('reset');
            const after = await rows();
            expect(after.filter(r => r.id === attemptId)).toEqual(snapshot);
            expect(after.map(r => r.state).sort()).toEqual(['cancelled', 'expired']);
            // A duplicate click: already_reset, no further row.
            expect(await reset()).toBe('already_reset');
            expect(await rows()).toEqual(after);
            // The reopen admits a fresh attempt; other computers' rows were never touched.
            expect(await reservePoolDemand(deps, want(440))).toBe('waiting');
            expect((await demands()).filter(d => d.computer_id === uuid(441))).toEqual([]);
        });
        it('routing hold: an unclosed demand holds across its deadline before any sweep, the expired attempt until released; a placement blocks release', async () => {
            const { deps } = runtime();
            await runB(); await host(326, xl, 'ready'); await requester(432);
            expect(await reservePoolDemand(deps, want(432))).toBe('waiting');
            const hold = (owner = 432) => hasDemandHoldForRouting(db, uuid(432), uuid(owner));
            const states = async () => (await demands()).map(d => d.state).sort();
            await db.execute(sql`UPDATE public.ezil_compute_capacity_demands SET expires_at = now() + interval '1 second', created_at = now() - interval '2 seconds'`);
            expect(await hold()).toBe(true); // immediately before the deadline
            await db.execute(sql`UPDATE public.ezil_compute_capacity_demands SET expires_at = now() - interval '1 second'`);
            expect(await states()).toEqual(['active']); // the deadline passed and no sweep ran
            expect(await hold()).toBe(true);
            expect(await hold(999)).toBe(false); // never another owner's
            expect(await reservePoolDemand(deps, want(432))).toMatchObject({ outcome: 'expired' }); // the sweep closes it as expired; terminal (RETRY-118: distinct outcome)
            expect(await states()).toEqual(['expired']);
            expect(await hold()).toBe(true);
            // A placement admitted before the stop's locks: the stop does not release the attempt.
            await db.execute(sql`INSERT INTO public.ezil_computer_placements
                (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, region, zone_id, instance_type, instance_id, updated_at)
                VALUES (${uuid(432)}::uuid, ${uuid(432)}::uuid, 'aws-ec2', 'ebs', 1, 1, 'UNCONFIRMED', ${c.region}, ${c.zoneId}, 'm6i.large', NULL, ${NOW.toISOString()}::timestamptz)`);
            expect(await cancelComputerDemand(db, uuid(432), uuid(432))).toBe(false);
            expect(await states()).toEqual(['expired']);
            await db.execute(sql`DELETE FROM public.ezil_computer_placements WHERE computer_id = ${uuid(432)}::uuid`); // fixture only
            expect(await cancelComputerDemand(db, uuid(432), uuid(432))).toBe(true);
            expect(await states()).toEqual(['cancelled', 'expired']);
            // RETRY-118 routing decision: the released attempt still records AWS intent for this owner (sticky).
            expect(await hold()).toBe(true);
            expect(await hold(999)).toBe(false);
        });
        describe('RETRY-118 backend (root review): typed wake reset, sticky routing, zero capacity credit', () => {
            const FS = 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5', FENCE = 'fe0fe0fe-fe0f-4e0f-8e0f-e0fe0fe0fe0f';
            /** A settled STOPPED AWS source as a completed normal stop leaves it (generation 2, epoch 3). */
            const stoppedSource = async (n: number) => {
                await requester(n);
                await db.execute(sql`INSERT INTO public.ezil_computer_placements
                    (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, region, zone_id, instance_type,
                     instance_id, volume_id, fs_uuid, fence_token, lifecycle_job_id, lifecycle_digest, updated_at)
                    VALUES (${uuid(n)}::uuid, ${uuid(n)}::uuid, 'aws-ec2', 'ebs', 2, 3, 'STOPPED', ${c.region}, ${c.zoneId}, 'm6i.large',
                        ${`i-${String(n).padStart(17, '0')}`}, ${`vol-${String(n).padStart(17, '0')}`}, ${FS}::uuid, ${FENCE}::uuid, NULL, NULL,
                        ${NOW.toISOString()}::timestamptz)`);
            };
            /** An expired attempt exactly as the sweep leaves it (valid created < expires <= closed timeline). */
            const expiredAttempt = async (n: number, kind: 'create' | 'wake', source: [number, number] | null, instanceType = 'm6i.xlarge') =>
                ((await db.execute(sql`INSERT INTO public.ezil_compute_capacity_demands
                    (request_id, owner_user_id, computer_id, kind, region, zone_id, instance_type, vcpu, deployment_digest,
                     source_generation, source_lease_epoch, state, cleanup, created_at, expires_at, closed_at)
                    VALUES (gen_random_uuid(), ${uuid(n)}::uuid, ${uuid(n)}::uuid, ${kind}, ${c.region}, ${c.zoneId}, ${instanceType}, 4,
                        ${demandDeploymentDigest(deployment)}, ${source?.[0] ?? null}::integer, ${source?.[1] ?? null}::integer, 'expired', '[]'::jsonb,
                        now() - interval '3 seconds', now() - interval '2 seconds', now() - interval '1 second') RETURNING id::text AS id`)) as Record<string, unknown>[])[0]!.id as string;
            const placementRowOf = async (n: number) => ((await db.execute(sql`SELECT * FROM public.ezil_computer_placements WHERE computer_id = ${uuid(n)}::uuid`)) as Record<string, unknown>[]);
            const demandRowsOf = async (n: number) => (await demands()).filter(d => d.computer_id === uuid(n));
            const poolRows = async () => (await db.execute(sql`SELECT * FROM public.ezil_compute_pool_hosts ORDER BY id`)) as Record<string, unknown>[];

            it('wake: only the exact settled STOPPED source resets (a resized target is fine); every mismatch writes nothing', async () => {
                await runB(); await host(342, xl, 'ready'); await stoppedSource(450);
                const attemptId = await expiredAttempt(450, 'wake', [2, 3]); // target m6i.xlarge over an m6i.large source: a resize
                const reset = () => resetCapacityAttempt(db, { computerId: uuid(450), ownerUserId: uuid(450), attemptId });
                const placementBefore = await placementRowOf(450), demandsBefore = await demandRowsOf(450), countsBefore = await counts();
                const poolBefore = await poolRows(), capacityBefore = await readPoolDemand(db, c, NOW);
                const mismatch = async (label: string, change: SQL, restore: SQL, expected: string = 'superseded') => {
                    await db.execute(change);
                    expect(await reset(), label).toBe(expected);
                    await db.execute(restore);
                    expect(await demandRowsOf(450), label).toEqual(demandsBefore);
                };
                const P = (set: SQL) => sql`UPDATE public.ezil_computer_placements SET ${set} WHERE computer_id = ${uuid(450)}::uuid`;
                await db.execute(sql`INSERT INTO auth.users (id) VALUES (${uuid(451)}::uuid) ON CONFLICT DO NOTHING`);
                await mismatch('placement owner', P(sql`owner_user_id = ${uuid(451)}::uuid`), P(sql`owner_user_id = ${uuid(450)}::uuid`));
                await mismatch('generation', P(sql`generation = 5`), P(sql`generation = 2`));
                await mismatch('lease epoch', P(sql`lease_epoch = 9`), P(sql`lease_epoch = 3`));
                await mismatch('region', P(sql`region = 'us-east-1'`), P(sql`region = ${c.region}`));
                await mismatch('zone', P(sql`zone_id = 'aps1-az3'`), P(sql`zone_id = ${c.zoneId}`));
                await mismatch('lifecycle job', P(sql`lifecycle_job_id = ${randomUUID()}::uuid`), P(sql`lifecycle_job_id = NULL`));
                await mismatch('lifecycle digest', P(sql`lifecycle_digest = ${'d'.repeat(64)}`), P(sql`lifecycle_digest = NULL`));
                await mismatch('not STOPPED', P(sql`state = 'RUNNING'`), P(sql`state = 'STOPPED'`));
                await mismatch('identity missing (fs uuid)', P(sql`fs_uuid = NULL`), P(sql`fs_uuid = ${FS}::uuid`));
                await mismatch('identity missing (volume)', P(sql`volume_id = NULL`), P(sql`volume_id = ${`vol-${String(450).padStart(17, '0')}`}`));
                await mismatch('image reservation', P(sql`image_upgrade_job_id = ${randomUUID()}::uuid`), P(sql`image_upgrade_job_id = NULL`));
                await mismatch('provider migration in flight', sql`INSERT INTO public.ezil_compute_migrations (user_id, computer_id, from_provider, to_provider, to_size, state)
                    VALUES (${uuid(450)}::uuid, ${uuid(450)}::uuid, 'cloudflare', 'aws-ec2', 'standard', 'fenced')`,
                    sql`DELETE FROM public.ezil_compute_migrations WHERE computer_id = ${uuid(450)}::uuid`);
                await mismatch('computer deleted', sql`UPDATE public.ezil_computers SET deleted_at = now() WHERE id = ${uuid(450)}::uuid`,
                    sql`UPDATE public.ezil_computers SET deleted_at = NULL WHERE id = ${uuid(450)}::uuid`, 'not_found');
                await mismatch('computer re-owned', sql`UPDATE public.ezil_computers SET user_id = ${uuid(451)}::uuid WHERE id = ${uuid(450)}::uuid`,
                    sql`UPDATE public.ezil_computers SET user_id = ${uuid(450)}::uuid WHERE id = ${uuid(450)}::uuid`, 'not_found');
                expect(await placementRowOf(450)).toEqual(placementBefore);
                // The valid STOPPED source: reset writes exactly the marker and nothing else.
                expect(await reset()).toBe('reset');
                expect(await placementRowOf(450)).toEqual(placementBefore);
                expect(await counts()).toEqual(countsBefore);
                expect(await poolRows()).toEqual(poolBefore);
                expect((await demandRowsOf(450)).map(d => d.state).sort()).toEqual(['cancelled', 'expired']);
                // Zero capacity credit: no active demand, and the regional demand/liability view is unchanged.
                expect(await readPoolDemand(db, c, NOW)).toEqual(capacityBefore);
                expect(await reset()).toBe('already_reset');
            });

            it('a computer that changed hands: the new owner can never reset the previous owner\'s attempt (demand owner check)', async () => {
                await requester(459); await requester(460);
                const previous = await expiredAttempt(459, 'create', null); // recorded while 459 owned the computer
                await db.execute(sql`UPDATE public.ezil_computers SET user_id = ${uuid(460)}::uuid WHERE id = ${uuid(459)}::uuid`);
                const before = await demandRowsOf(459);
                expect(await resetCapacityAttempt(db, { computerId: uuid(459), ownerUserId: uuid(460), attemptId: previous })).toBe('not_found');
                expect(await demandRowsOf(459)).toEqual(before);
            });

            it('create attempt with any placement present is superseded; a wake attempt with no placement is superseded', async () => {
                await stoppedSource(452);
                const create = await expiredAttempt(452, 'create', null);
                expect(await resetCapacityAttempt(db, { computerId: uuid(452), ownerUserId: uuid(452), attemptId: create })).toBe('superseded');
                await requester(453);
                const wake = await expiredAttempt(453, 'wake', [2, 3]);
                expect(await resetCapacityAttempt(db, { computerId: uuid(453), ownerUserId: uuid(453), attemptId: wake })).toBe('superseded');
                expect((await demands()).filter(d => d.state === 'cancelled')).toEqual([]);
            });

            it('concurrency: admission and reset serialize under the locks; whichever wins, exactly one marker and a consistent outcome', async () => {
                const { deps } = runtime();
                await runB(); await host(343, xl, 'ready'); await requester(454);
                expect(await reservePoolDemand(deps, want(454))).toBe('waiting');
                await db.execute(sql`UPDATE public.ezil_compute_capacity_demands SET expires_at = now() - interval '1 second', created_at = now() - interval '2 seconds'
                    WHERE computer_id = ${uuid(454)}::uuid`);
                await markPoolHost(db, uuid(343), ['retiring'], 'retired', NOW); await host(344, xl, 'ready');
                const first = await reservePoolDemand(deps, want(454)); // closes it as expired (terminal)
                expect(first).toMatchObject({ outcome: 'expired' });
                const attemptId = (first as { attemptId: string }).attemptId;
                const [reset, reopen] = await Promise.all([
                    resetCapacityAttempt(db, { computerId: uuid(454), ownerUserId: uuid(454), attemptId }),
                    reservePoolDemand(deps, want(454)),
                ]);
                expect(reset).toBe('reset');
                // Reset first → the reopen reserves a fresh attempt; admission first → it was still terminal.
                expect(reopen === 'waiting' || (typeof reopen === 'object' && reopen.attemptId === attemptId)).toBe(true);
                expect((await demandRowsOf(454)).filter(d => d.state === 'cancelled')).toHaveLength(1);
                // Admission-first for a create: a placement that commits before the reset makes it superseded.
                await requester(455);
                const created = await expiredAttempt(455, 'create', null);
                await db.execute(sql`INSERT INTO public.ezil_computer_placements
                    (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, region, zone_id, instance_type, instance_id, updated_at)
                    VALUES (${uuid(455)}::uuid, ${uuid(455)}::uuid, 'aws-ec2', 'ebs', 1, 1, 'UNCONFIRMED', ${c.region}, ${c.zoneId}, 'm6i.large', NULL, ${NOW.toISOString()}::timestamptz)`);
                expect(await resetCapacityAttempt(db, { computerId: uuid(455), ownerUserId: uuid(455), attemptId: created })).toBe('superseded');
            });

            it('routing: reset -> AWS disabled -> reopen never pins Cloudflare (selector and transactional guard); history is per owner', async () => {
                await requester(456);
                const attemptId = await expiredAttempt(456, 'create', null, 'm6i.large');
                expect(await resetCapacityAttempt(db, { computerId: uuid(456), ownerUserId: uuid(456), attemptId })).toBe('reset');
                expect(await hasDemandHoldForRouting(db, uuid(456), uuid(456))).toBe(true);
                // The transactional pin guard: no Cloudflare insert for this owner's computer.
                expect(await pinCloudflarePlacement(db, { computerId: uuid(456), userId: uuid(456) }, { honorDemand: true }))
                    .toEqual({ provider: 'aws-ec2', store: 'ebs', record: null });
                expect(await placementRowOf(456)).toEqual([]);
                // A different owner never inherits it (their own computer pins normally).
                expect(await hasDemandHoldForRouting(db, uuid(456), uuid(457))).toBe(false);
                // Consumed-only history (e.g. a later downgrade) still holds; capacity credit needs a live active demand.
                await requester(458);
                await db.execute(sql`INSERT INTO public.ezil_compute_capacity_demands
                    (request_id, owner_user_id, computer_id, kind, region, zone_id, instance_type, vcpu, deployment_digest, source_generation, source_lease_epoch,
                     state, cleanup, created_at, expires_at, closed_at)
                    VALUES (gen_random_uuid(), ${uuid(458)}::uuid, ${uuid(458)}::uuid, 'create', ${c.region}, ${c.zoneId}, 'm6i.large', 2,
                        ${demandDeploymentDigest(deployment)}, NULL, NULL, 'consumed', '[]'::jsonb, now() - interval '3 seconds', now() - interval '2 seconds', now() - interval '1 second')`);
                expect(await hasDemandHoldForRouting(db, uuid(458), uuid(458))).toBe(true);
                expect(await withAdmission(db, (tx, lock) => lockComputerDemandLive(tx, lock, uuid(458)))).toBeNull();
            });
        });
        it('size: a selection changed between the refused open and the reservation refuses (no stale retirement)', async () => {
            const { deps, starter } = runtime();
            await runB(); await host(327, xl, 'ready'); await requester(431); // Standard: resolves to m6i.large
            expect(await reservePoolDemand(deps, want(431, 'm6i.xlarge'))).toBe('refused'); // the stale 4-vCPU request
            expect(starter.start).not.toHaveBeenCalled();
            expect(await demands()).toHaveLength(0);
        });
        it('deployment: the digest covers the complete validated deployment; a stale or foreign digest never reserves or repeats', async () => {
            const base = demandDeploymentDigest(deployment);
            for (const changed of [{ launchTemplateId: 'lt-22222222222222222' }, { securityGroupId: 'sg-22222222222222222' },
                { subnetId: 'subnet-22222222222222222' }, { dataKeyArn: deployment.dataKeyArn.replace('1111', '2222') }, { storage: { ...deployment.storage, dataMaxGiB: 99 } }])
                expect(demandDeploymentDigest({ ...deployment, ...changed })).not.toBe(base);
            expect(demandDeploymentDigest({ ...deployment, storage: { rootDeviceName: '/dev/sda1', ...deployment.storage } })).toBe(base); // pool-work normalization
            const { deps } = runtime();
            await runB(); await host(328, xl, 'ready'); await requester(432);
            expect(await reservePoolDemand(deps, { ...want(432), deploymentDigest: 'b'.repeat(64) })).toBe('refused');
            expect(await reservePoolDemand(deps, want(432))).toBe('waiting');
            expect(await reservePoolDemand(deps, { ...want(432), deploymentDigest: 'b'.repeat(64) })).toBe('refused');
        });
        it('image admission counters (readImageAdmissionCounters) count other computers\' pending demand too', async () => {
            const { deps } = runtime();
            await runB(); await host(329, xl, 'ready'); await requester(433);
            expect(await reservePoolDemand(deps, want(433))).toBe('waiting');
            await db.execute(sql`UPDATE public.ezil_computer_placements SET image_upgrade_job_id = ${randomUUID()}::uuid WHERE computer_id = ${uuid(202)}::uuid`);
            const counts = await withAdmission(db, async (tx, lock) => {
                const p = (await lockImagePlacement(tx, lock, uuid(202)))!;
                return readImageAdmissionCounters(tx, lock, p, NOW);
            });
            const plain = await withAdmission(db, (tx, lock) => readAdmissionCounters(tx, lock, { userId: uuid(433), computerId: uuid(433), monthStart: ago(60 * 24), now: NOW }));
            expect(counts.runningVcpu).toBe(plain.runningVcpu + 2); // 433's own admission never counts its own demand; image admission does
        });
        it('a downstream eligibility read failure (after inventory) refuses with no demand and no retirement', async () => {
            const { deps, starter } = runtime();
            await runB(); await host(330, xl, 'ready'); await requester(434);
            const failing: PlacementDb = { execute: q => db.execute(q), transaction: fn => db.transaction(tx => fn({ execute: async q => {
                const text = new PgDialect().sqlToQuery(q).sql;
                if (/WITH\s+effective/.test(text) && text.includes('SELECT instance_type FROM eligible')) throw new Error('eligibility read failed');
                return tx.execute(q);
            } })) };
            await expect(reservePoolDemand({ ...deps, db: failing }, want(434))).rejects.toThrow('eligibility read failed');
            expect(await demands()).toHaveLength(0);
            expect(starter.start).not.toHaveBeenCalled();
            expect(((await db.execute(sql`SELECT state FROM public.ezil_compute_pool_hosts WHERE id = ${uuid(330)}::uuid`)) as Record<string, unknown>[])[0]!.state).toBe('ready');
        });
        it('forced interleaving: a reservation waits behind a transaction holding the admission lock, then sees its committed lease', async () => {
            const { deps } = runtime();
            await runB(); await host(331, xl, 'ready'); await requester(435);
            let release!: () => void; const held = new Promise<void>(r => { release = r; });
            let entered!: () => void; const inside = new Promise<void>(r => { entered = r; });
            const holder = withAdmission(db, async tx => {
                entered(); await held;
                await tx.execute(sql`UPDATE public.ezil_compute_pool_hosts SET state = 'leased', leased_computer_id = ${uuid(999)}::uuid,
                    leased_at = ${NOW.toISOString()}::timestamptz, leased_generation = generation, lease_token = gen_random_uuid() WHERE id = ${uuid(331)}::uuid`);
            });
            await inside;
            const reservation = reservePoolDemand(deps, want(435));
            await new Promise(r => setTimeout(r, 150));
            release(); await holder;
            expect(await reservation).toBe('refused'); // the only spare was leased first; nothing reclaimable remained
            expect(await demands()).toHaveLength(0);
        });
        it('the bound retirement completes through the real dispatch receipt path, after which the holder fits', async () => {
            const { deps, store } = runtime();
            await runB(); await host(332, xl, 'ready'); await requester(436);
            expect(await reservePoolDemand(deps, want(436))).toBe('waiting');
            const row = ((await db.execute(sql`SELECT * FROM public.ezil_compute_pool_hosts WHERE id = ${uuid(332)}::uuid`)) as Record<string, unknown>[])[0]!;
            const work = storedPoolWork(row), i = work.intent;
            const receipt = { schemaVersion: 1, jobId: i.jobId, digest: work.digest, computerId: i.computerId, generation: i.targetGeneration,
                leaseEpoch: i.leaseEpoch, fenceToken: i.fenceToken, poolHostId: i.poolHostId, poolGeneration: i.poolGeneration, volumeId: null,
                instanceId: row.instance_id, state: 'retired' };
            const executions = { describe: vi.fn(async () => ({ status: 'SUCCEEDED', input: work.input, output: JSON.stringify(receipt),
                executionArn: lifecycleExecutionArn(deployment, i.jobId), stateMachineVersionArn: work.stateMachineArn })) };
            await createPoolDispatchStore(db, { EZIL_AWS_KILL_SWITCH: '0' }, { starter: { start: vi.fn() }, executions }).reconcile!();
            expect(((await db.execute(sql`SELECT state FROM public.ezil_compute_pool_hosts WHERE id = ${uuid(332)}::uuid`)) as Record<string, unknown>[])[0]!.state).toBe('retired');
            void store;
            expect(await validate(436)).toMatchObject({ message: 'open_pool_capacity' }); // validate() probes WITHOUT a claim: no credit
        });
        it('schema: a demand cannot carry a partial source pair or a create with a source', async () => {
            const insert = (kind: string, gen: number | null, epoch: number | null) => db.execute(sql`INSERT INTO public.ezil_compute_capacity_demands
                (request_id, owner_user_id, computer_id, kind, region, zone_id, instance_type, vcpu, deployment_digest, source_generation, source_lease_epoch, state, expires_at)
                VALUES (${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${kind}, ${'r-' + randomUUID()}, 'z', 'm6i.large', 2, ${'a'.repeat(64)},
                    ${gen}::integer, ${epoch}::integer, 'active', now() + interval '1 minute')`);
            for (const [kind, gen, epoch] of [['wake', 1, null], ['wake', null, 1], ['wake', null, null], ['create', 1, null], ['create', null, 1], ['create', 1, 1]] as const)
                await expect(insert(kind, gen, epoch)).rejects.toThrow();
            await expect(insert('wake', 1, 1)).resolves.toBeDefined();
            await expect(insert('create', null, null)).resolves.toBeDefined();
        });
        it('replenish (admission lock first) and demand reservation run concurrently without deadlock; floors honor the reservation', async () => {
            await runB(); await host(311, xl, 'ready'); await requester(414);
            await paid(201);
            const { deps, store, starter } = runtime();
            const replenish = () => runPoolReplenish({ db, data: poolData, store, starter, classes: [c, xl], deployments: { [c.region]: deployment },
                now: () => NOW, withLock: fn => withPoolReplenishLock(db, fn), log: () => {}, sleep: async () => {} }).catch((e: { status?: number }) => e?.status === 204 ? null : Promise.reject(e));
            const results = await Promise.all([reservePoolDemand(deps, want(414)), replenish(), replenish()]);
            expect(results[0]).toBe('waiting');
            // The reserved 2 vCPU plus physical liability leaves no room for a fresh spare while the demand is active.
            const booting = ((await db.execute(sql`SELECT count(*) AS n FROM public.ezil_compute_pool_hosts WHERE state = 'booting'`)) as Record<string, unknown>[])[0]!.n;
            expect(Number(booting)).toBe(0);
        });
    });

    describe('ROUND 3 switch preflight, demand signal and opening reads (10 vCPU cap)', () => {
        const ENV = { EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '5', AWS_REGIONS: 'ap-south-1', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '5',
            EZIL_AWS_USER_MONTHLY_HOURS: '75', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '250', EZIL_AWS_USER_MONTHLY_EGRESS_GB: '100',
            EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '1000', EZIL_AWS_KILL_SWITCH: '0' };
        beforeEach(async () => {
            for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
            // Earlier suites may leave migration reservations (2 vCPU each); this block starts from none.
            await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_migrations`);
        });
        afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
        const xxl: PoolClass = { ...c, instanceType: 'm6i.2xlarge' };
        const live = async (n: number, state: string, instanceType = 'm6i.large', instanceId: string | null = `i-${String(n).padStart(17, '0')}`) => {
            await db.execute(sql`INSERT INTO public.ezil_computers (id, user_id) VALUES (${uuid(n)}::uuid, ${uuid(n)}::uuid) ON CONFLICT DO NOTHING`);
            await db.execute(sql`INSERT INTO public.ezil_computer_placements
                (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, region, zone_id, instance_type, instance_id, updated_at)
                VALUES (${uuid(n)}::uuid, ${uuid(n)}::uuid, 'aws-ec2', 'ebs', 2, 3, ${state}, ${c.region}, ${c.zoneId}, ${instanceType}, ${instanceId}, ${NOW.toISOString()}::timestamptz)`);
            return (await readPlacement(db, uuid(n))).record!;
        };
        const spare = async (n: number, cls: PoolClass, state: 'booting' | 'ready') => {
            await db.execute(sql`INSERT INTO public.ezil_compute_pool_hosts (id, region, zone_id, instance_type, created_at, updated_at)
                VALUES (${uuid(n)}::uuid, ${cls.region}, ${cls.zoneId}, ${cls.instanceType}, ${ago(4).toISOString()}::timestamptz, ${NOW.toISOString()}::timestamptz)`);
            if (state === 'ready') { await recordPoolEnrollment(db, uuid(n), `i-${String(n).padStart(17, '0')}`, ago(1)); await recordPoolReady(db, uuid(n), { editorOk: true }, NOW); }
        };
        const preflight = async (p: Placement, type: string) => (await import('./aws-pool-runtime')).preflightSwitchCapacity(db, p, type, { ...process.env, ...ENV }, NOW);

        it('8 vCPU near the cap: admission alone refuses before any stop', async () => {
            await live(201, 'RUNNING'); await live(202, 'RUNNING'); await live(203, 'UNCONFIRMED', 'm6i.large', null);
            const own = await live(501, 'RUNNING');
            expect(await preflight(own, 'm6i.2xlarge')).toEqual({ ok: false, reason: 'max_running' });
            // The same computer fits on 4 vCPU: its own 2 vCPU are released, never counted twice.
            expect(await preflight(own, 'm6i.xlarge')).toEqual({ ok: true, wait: false });
        });
        it('spares count the way pool opens count them: an unreclaimable spare refuses 8 vCPU; a READY 8 vCPU spare is adopted at net zero', async () => {
            const own = await live(501, 'RUNNING');
            // A host leased to another opening is counted and cannot be reclaimed.
            await spare(301, xxl, 'ready');
            await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET state = 'leased', leased_computer_id = ${uuid(777)}::uuid, leased_at = ${NOW.toISOString()}::timestamptz,
                leased_generation = generation, lease_token = gen_random_uuid() WHERE id = ${uuid(301)}::uuid`);
            expect(await preflight(own, 'm6i.2xlarge')).toEqual({ ok: false, reason: 'region_capacity' });
            await db.execute(sql`DELETE FROM public.ezil_compute_pool_hosts`);
            await spare(302, xxl, 'ready');
            expect(await preflight(own, 'm6i.2xlarge')).toEqual({ ok: true, wait: false });
        });
        it('over the cap only because of idle reclaimable spares: a capacity wait, not a refusal', async () => {
            const own = await live(501, 'RUNNING'); await live(201, 'RUNNING');
            await spare(303, { ...c, instanceType: 'm6i.xlarge' }, 'ready');
            // 2 + 2 + 4 (spare) − 2 + 8 = 14 > 10, and the idle 4 vCPU spare covers the 4 over.
            expect(await preflight(own, 'm6i.2xlarge')).toEqual({ ok: true, wait: true });
            expect(await poolData.readReclaimablePoolVcpu(db, c.region)).toBe(4);
        });
        it('poolVcpuExcess is the one count validateCapacity also uses', async () => {
            const { poolVcpuExcess } = await import('./aws-pool-runtime');
            expect(poolVcpuExcess({ vcpuInUse: 10, otherDemandVcpu: 0, migrations: 0, regionVcpuCap: 10 })).toBe(0);
            expect(poolVcpuExcess({ vcpuInUse: 8, otherDemandVcpu: 2, migrations: 1, regionVcpuCap: 10 })).toBe(2);
            expect(poolVcpuExcess({ vcpuInUse: 10, otherDemandVcpu: 0, migrations: 0, regionVcpuCap: 10, releaseVcpu: 2, addVcpu: 8 })).toBe(6);
        });

        const premium = async (n: number) => {
            await subscriber(n, 'premium_monthly_v3');
            await db.execute(sql`INSERT INTO public.ezil_billing_size_preferences VALUES (${uuid(n)}::uuid, 'cmp-8')`);
            await placement(n);
            await db.execute(sql`INSERT INTO public.ezil_computers (id, user_id) VALUES (${uuid(n)}::uuid, ${uuid(n)}::uuid) ON CONFLICT DO NOTHING`);
        };
        const switching = (n: number, over: Record<string, unknown> = {}) => db.execute(sql`UPDATE public.ezil_computers SET metadata = jsonb_build_object('transition',
            ${JSON.stringify({ kind: 'switch', target: 'cmp-8', phase: 'waking', requestedAt: ago(1).toISOString(), ...over })}::jsonb) WHERE id = ${uuid(n)}::uuid`);
        it('demand signal: an in-flight switch to 8 vCPU is one waiting open of that class, and raises the planned spares', async () => {
            await premium(1); await premium(2);
            const before = await readPoolDemand(db, xxl, NOW);
            expect(before).toMatchObject({ activePremium: 2, pending: 0 });
            expect(poolData.planPool(xxl, { ...before, regionVcpuCap: 100 }, NOW).target).toBe(1);
            await switching(1);
            const after = await readPoolDemand(db, xxl, NOW);
            expect(after.pending).toBe(1);
            expect(poolData.planPool(xxl, { ...after, regionVcpuCap: 100 }, NOW).target).toBe(2);
            // Within the cap: no room, no extra spare.
            expect(poolData.planPool(xxl, { ...after, regionVcpuCap: 8 }, NOW).target).toBe(1);
            // Other classes are untouched.
            expect((await readPoolDemand(db, { ...c, instanceType: 'm6i.xlarge' }, NOW)).pending).toBe(0);
        });
        it.each([
            ['an ended switch', { phase: 'done' }], ['a stale switch', { requestedAt: ago(30).toISOString() }], ['a restart', { kind: 'restart' }],
            ['another target', { target: 'cmp-4' }],
        ])('demand signal ignores %s', async (_name, over) => {
            await premium(1);
            await switching(1, over);
            expect((await readPoolDemand(db, xxl, NOW)).pending).toBe(0);
        });
        it('demand signal ignores a forged record of a non-subscriber and counts one unit per user', async () => {
            await premium(1);
            await db.execute(sql`INSERT INTO public.ezil_computers (id, user_id) VALUES (${uuid(9)}::uuid, ${uuid(9)}::uuid), (${uuid(10)}::uuid, ${uuid(1)}::uuid)`);
            await switching(9); await switching(1); await switching(10);
            expect((await readPoolDemand(db, xxl, NOW)).pending).toBe(1);
        });

        it('opening reads: this epoch\'s pool lease times, the warm median, and an active capacity demand', async () => {
            await ready(1); await lease(1);
            await publishPoolClaim(db, uuid(1), { ...claim, computerId: uuid(101), leaseEpoch: 4 }, ago(-0.1));
            await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET session_ready_at = ${ago(-0.3).toISOString()}::timestamptz WHERE id = ${uuid(1)}::uuid`);
            expect(await poolData.readPoolOpening(db, { computerId: uuid(101), leaseEpoch: 4 }, NOW))
                .toEqual({ leasedAt: NOW, claimPublishedAt: ago(-0.1), sessionReadyAt: ago(-0.3) });
            expect(await poolData.readPoolOpening(db, { computerId: uuid(101), leaseEpoch: 5 }, NOW)).toBeNull();
            expect(await poolData.readPoolOpening(db, { computerId: uuid(102), leaseEpoch: 4 }, NOW)).toBeNull();
            expect(await poolData.readWarmOpenSeconds(db, c)).toBe(18);
            expect(await poolData.readWarmOpenSeconds(db, { ...c, instanceType: 'm6i.xlarge' })).toBeNull();
            expect(await poolData.hasActiveCapacityDemand(db, uuid(101), NOW)).toBe(false);
        });
    });
});
