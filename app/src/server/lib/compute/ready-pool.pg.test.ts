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
import type { PlacementDb, PlacementExecutor } from './placement';
import { lockPoolClaimPlacement, readPlacement, savePoolEnrollmentNonce } from './placement';
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
        // Minimal fixtures for existing billing tables; production migrations require auth.users.
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_compute_migrations (computer_id uuid, state text);
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
            ${schema}.ezil_billing_grants, ${schema}.ezil_billing_size_preferences, ${schema}.ezil_billing_payment_issues`);
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
        expect(poolData.planPool(c,{...d,regionVcpuCap:100},NOW)).toMatchObject({target:Math.min(4,n+1),provision:2});
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
});
