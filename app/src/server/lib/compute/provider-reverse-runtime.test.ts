/**
 * The reverse machine's runtime (REVERSE-MOVE-CONTRACT §5.1.2, §5.4, §7.2) against the fake placement database:
 * - the §5.1.2 parity test: the export boot's intent equals the wake's own cold replace for the same STOPPED placement,
 *   driving aws-ec2.ts with a recording starter (only `jobId`, `fenceToken` and the nonce inside `userData` differ);
 * - the claim's post-commit start and the wake's undo for a replace;
 * - the sweep driver with a test double for lane O's `advanceReverseSnapshots` (the seam file is lane O's).
 */
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));

import { createAwsEc2Provider, type LifecycleStarter } from './aws-ec2';
import { LIFECYCLE_DEPLOYMENTS_ENV, type LifecycleIntent } from './aws-intent';
import { fixtureDeployment } from './aws-intent.test-support';
import { isPoolMode } from './aws-receipts';
import { createFakePlacementDb, placementRow, type Row } from './fake-placement-db.test-support';
import { INSTANCE_LOST, readPlacement, type PlacementDb, type PlacementExecutor } from './placement';
import { advanceReverseMoves, createReverseRuntime, EXPORT_BOOT_LEASE_MS } from './provider-reverse-runtime';
import type { ComputeReverseMove } from './provider-reverse-store';

const U1 = '11111111-1111-4111-8111-111111111111';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const MOVE = '99999999-9999-4999-8999-999999999999';
const GEN = '77777777-7777-4777-8777-777777777777';
const NOW = new Date('2026-10-14T06:00:00Z');
const D = fixtureDeployment('ap-south-1', ['t3a.medium', 't3.medium', 'm6i.large']);
const ENROLL_URL = 'https://app.example.test/api/compute/aws/enroll';
const env = (over: Record<string, string> = {}) => ({
    EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '10', EZIL_AWS_USER_MONTHLY_HOURS: '100', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200', AWS_REGIONS: 'ap-south-1', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2',
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ 'ap-south-1': D }), EZIL_AWS_ENROLL_URL: ENROLL_URL, ...over,
});
/** The held computer: STOPPED at N = 3, E = 7. */
const stopped = (over: Row = {}) => placementRow({ computer_id: C1, owner_user_id: U1, generation: 3, lease_epoch: 7, region: 'ap-south-1', zone_id: 'aps1-az1',
    instance_type: 't3a.medium', instance_id: 'i-11111111111111111', volume_id: 'vol-11111111111111111', fs_uuid: 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5',
    fence_token: 'fe0fe0fe-fe0f-4e0f-8e0f-e0fe0fe0fe0f', ...over });
const move = (over: Partial<ComputeReverseMove> = {}): ComputeReverseMove => ({ id: MOVE, userId: U1, computerId: C1, startedBy: 'open', state: 'requested',
    generation: GEN, exportBoot: null, exportHead: null, importProgress: null, bytesTotal: null, skipped: null, awsVolumeId: null, awsFsUuid: null,
    awsSnapshotId: null, retainUntil: null, attempts: 0, lastError: null, stateEnteredAt: 't', commitSentAt: null, createdAt: 't', updatedAt: 'u0',
    ages: { created: 5, stateEntered: 5, commitSent: null, lastChunk: null }, ...over });

function recordingStarter(fail?: () => Error) {
    const intents: LifecycleIntent[] = [];
    const starter: LifecycleStarter = { async start(_region, work) {
        intents.push(JSON.parse((JSON.parse(work.input) as { document: string }).document));
        if (fail) throw fail();
    } };
    return { starter, intents };
}
const leaseOf = (userData: string | null) => JSON.parse(Buffer.from(userData!, 'base64').toString('utf8')) as Record<string, unknown>;

/** The fake database plus the reverse table: the claim's count and the reverse row's `recordExportBoot` CAS. */
function reverseDb(seed: Parameters<typeof createFakePlacementDb>[0]) {
    const fake = createFakePlacementDb(seed, { clock: () => NOW });
    const dialect = new PgDialect();
    const recorded: Record<string, unknown>[] = [];
    const wrap = (x: PlacementExecutor): PlacementExecutor => ({ execute: async (q: SQL) => {
        const { sql: text, params } = dialect.sqlToQuery(q);
        if (text.includes('reverse:count-host-bound')) return { rows: [{ n: 0 }] };
        if (text.startsWith('UPDATE public.ezil_compute_reverse_moves')) {
            const boot = params.map(p => { try { return JSON.parse(String(p)); } catch { return null; } }).find(p => p && typeof p === 'object' && 'placementGeneration' in p);
            recorded.push(boot);
            return { rows: [{ id: MOVE, user_id: U1, computer_id: C1, started_by: 'open', state: 'booting', generation: GEN, export_boot: boot, attempts: 0,
                state_entered_at: 't1', created_at: 't', updated_at: 'u1', age_created: 5, age_state_entered: 0 }] };
        }
        return x.execute(q);
    } });
    const db: PlacementDb = { execute: q => wrap(fake.db).execute(q), transaction: fn => fake.db.transaction(tx => fn(wrap(tx))) };
    return { ...fake, db, recorded };
}

describe('§5.1.2 parity: the export boot is the wake\'s own cold replace', () => {
    const cases = [
        ['STOPPED with INSTANCE_LOST (start mode, not pool)', stopped({ last_error: INSTANCE_LOST }),
            env({ EZIL_AWS_WAKE_MODE: 'start', EZIL_AWS_LIFECYCLE_USERDATA_NONCE: '1' })],
        ['plain STOPPED with wakeMode replace', stopped(), env({ EZIL_AWS_WAKE_MODE: 'replace' })],
    ] as const;
    it.each(cases)('%s: equal except jobId, fenceToken and the nonce inside userData', async (_name, row, e) => {
        expect(isPoolMode(D)).toBe(false);
        // The wake, through the real provider (round 6a's grant-pending wait answered "not pending").
        const wakeDb = createFakePlacementDb({ placements: [{ ...row }], computers: [{ id: C1, user_id: U1 }] }, { clock: () => NOW });
        const wake = recordingStarter();
        const provider = createAwsEc2Provider({ db: wakeDb.db, env: () => e, now: () => NOW, newId: () => crypto.randomUUID(), starter: wake.starter,
            tierFor: async () => 'free', grantPending: async () => false, randomBytes: () => Buffer.alloc(32, 7), sleep: async () => {} });
        expect(await provider.ensure({ correlationId: 'c' }, { userId: U1, computerId: C1 }, { sessionId: 's', desktopMode: 'neko' }))
            .toMatchObject({ errorCode: 'computer_starting' });
        // The export boot, through the runtime's claim.
        const exportDb = reverseDb({ placements: [{ ...row }], computers: [{ id: C1, user_id: U1 }] });
        const boot = recordingStarter();
        const runtime = createReverseRuntime(exportDb.db, { env: e, aws: { starter: boot.starter }, newId: () => crypto.randomUUID(),
            randomBytes: () => Buffer.alloc(32, 9), sleep: async () => {} });
        const p = (await readPlacement(exportDb.db, C1)).record!;
        const outcome = await runtime.claim(move(), p);
        expect(outcome).toMatchObject({ admitted: true, move: { state: 'booting' } });
        expect([wake.intents.length, boot.intents.length]).toEqual([1, 1]);
        const [a, b] = [wake.intents[0]!, boot.intents[0]!];
        expect(a.operation).toBe('replace');
        const strip = (i: LifecycleIntent) => ({ ...i, jobId: null, fenceToken: null, userData: null });
        expect(strip(b)).toEqual(strip(a));
        const nonceless = (i: LifecycleIntent) => { const lease = leaseOf(i.userData); delete lease.nonce; return lease; };
        expect(nonceless(b)).toEqual(nonceless(a));
        expect(leaseOf(b.userData)).not.toEqual(leaseOf(a.userData));
        expect(b).toMatchObject({ targetGeneration: 4, leaseEpoch: 8, previousGeneration: 3, instanceType: 't3a.medium', dataVolumeGiB: null });
        // The claim recorded the boot on the reverse row in the lease's own transaction, and the lease is 200 min.
        expect(exportDb.recorded).toEqual([expect.objectContaining({ placementGeneration: 4, leaseEpoch: 8, region: 'ap-south-1',
            volumeId: 'vol-11111111111111111', jobId: b.jobId, instanceId: null, fsUuid: 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5' })]);
        expect(exportDb.placements[0]).toMatchObject({ state: 'STARTING', generation: 4, lease_epoch: 8, lifecycle_job_id: b.jobId, instance_id: null,
            fence_token: b.fenceToken, instance_type: 't3a.medium' });
        expect(new Date(exportDb.placements[0]!.lease_until as string).getTime() - Date.now()).toBeGreaterThan(EXPORT_BOOT_LEASE_MS - 60_000);
    });
});

describe('the claim\'s start after commit (the wake\'s undo for a replace)', () => {
    const refused = () => Object.assign(new Error('refused'), { name: 'ExecutionLimitExceeded', $metadata: { httpStatusCode: 400 } });
    const lost = () => Object.assign(new Error('socket hang up'), { name: 'Error', code: 'ECONNRESET' });
    it('refused, with no settle evidence → UNCONFIRMED with the nonce proofs cleared; lost → kept LEASED, marked start-unknown (undo UNCONFIRMED)', async () => {
        for (const [fail, state, mark] of [[refused, 'UNCONFIRMED', null], [lost, 'LEASED', 'lifecycle_start_unknown:UNCONFIRMED']] as const) {
            const x = reverseDb({ placements: [stopped({ last_error: INSTANCE_LOST })], computers: [{ id: C1, user_id: U1 }] });
            const start = recordingStarter(fail);
            const runtime = createReverseRuntime(x.db, { env: env(), aws: { starter: start.starter }, sleep: async () => {} });
            expect(await runtime.claim(move(), (await readPlacement(x.db, C1)).record!)).toMatchObject({ admitted: true });
            expect(x.placements[0], state).toMatchObject({ state, generation: 4, lease_epoch: 8, ...(mark ? { last_error: mark } : { enroll_nonce_hash: null }) });
        }
    });
    it('a deployment that cannot start a job is aws_config_invalid (try later); an unconfigured region waits; nothing is leased', async () => {
        const x = reverseDb({ placements: [stopped()], computers: [{ id: C1, user_id: U1 }] });
        const p = (await readPlacement(x.db, C1)).record!;
        expect(await createReverseRuntime(x.db, { env: env() }).claim(move(), p)).toEqual({ admitted: false, reason: 'aws_config_invalid' });
        expect(await createReverseRuntime(x.db, { env: env({ EZIL_AWS_ENROLL_URL: '' }), aws: { starter: recordingStarter().starter } }).claim(move(), p))
            .toEqual({ admitted: false, reason: 'aws_config_invalid' });
        expect(await createReverseRuntime(x.db, { env: env(), aws: { starter: recordingStarter().starter } }).claim(move(), { ...p, region: 'us-east-1' }))
            .toEqual({ admitted: false, reason: 'region_not_configured' });
        expect(x.placements[0]).toMatchObject({ state: 'STOPPED', lease_epoch: 7 });
    });
    it('an intent the deployment refuses (its type is not listed) or an incomplete row is a wait value: nothing leased, no job, no throw', async () => {
        for (const [over, reason] of [[{ instance_type: 'm6i.2xlarge' }, 'intent_invalid'], [{ fs_uuid: null }, 'placement_incomplete']] as const) {
            const x = reverseDb({ placements: [stopped({ ...over, last_error: INSTANCE_LOST })], computers: [{ id: C1, user_id: U1 }] });
            const start = recordingStarter();
            const runtime = createReverseRuntime(x.db, { env: env(), aws: { starter: start.starter }, sleep: async () => {} });
            expect(await runtime.claim(move(), (await readPlacement(x.db, C1)).record!), reason).toEqual({ admitted: false, reason });
            expect(x.placements[0], reason).toMatchObject({ state: 'STOPPED', generation: 3, lease_epoch: 7, lifecycle_job_id: null });
            expect(start.intents, reason).toEqual([]);
            expect(x.recorded, reason).toEqual([]);
        }
    });
    it('a write that fails after the claim committed still answers admitted (the row is booting; the boot pass hands it to the receipts)', async () => {
        const x = reverseDb({ placements: [stopped({ last_error: INSTANCE_LOST })], computers: [{ id: C1, user_id: U1 }] });
        const start = recordingStarter();
        let leased = false;
        const db: PlacementDb = { execute: q => x.db.execute(q), transaction: async fn => {
            // The admission transaction commits; the next one (the STARTING transition after the start) fails.
            if (leased) throw new Error('connection reset');
            const result = await x.db.transaction(fn);
            leased = true;
            return result;
        } };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const outcome = await createReverseRuntime(db, { env: env(), aws: { starter: start.starter }, sleep: async () => {} })
            .claim(move(), (await readPlacement(x.db, C1)).record!);
        expect(outcome).toMatchObject({ admitted: true, move: { state: 'booting' } });
        expect(start.intents).toHaveLength(1);
        expect(x.placements[0]).toMatchObject({ state: 'LEASED', generation: 4, lease_epoch: 8 });
        expect(warn).toHaveBeenCalledWith('[reverse-move] error', expect.objectContaining({ step: 'claim_start', error: 'connection reset' }));
        warn.mockRestore();
    });
});

describe('advanceReverseMoves: the sweep\'s last step (§5.4, §7.2)', () => {
    const probeDb = (present: boolean, claimed: unknown[] = []) => {
        const sqls: string[] = [];
        const db: PlacementDb = { execute: async (q: SQL) => {
            const text = new PgDialect().sqlToQuery(q).sql;
            sqls.push(text);
            if (text.includes('to_regclass')) return [{ present }];
            if (text.startsWith('WITH stale AS')) return claimed;
            throw new Error(`unexpected ${text.slice(0, 40)}`);
        }, transaction: async fn => fn(db) };
        return { db, sqls };
    };
    it('lane O\'s snapshot step (a test double here) runs first, with the pass start + 20 s, then claimStale(10)', async () => {
        const { db, sqls } = probeDb(true);
        const order: string[] = [];
        const snapshots = vi.fn(async (input: { deadlineMs: number }) => { order.push(`snapshot:${input.deadlineMs}`); return { status: 'held' as const }; });
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        await advanceReverseMoves(1_000, { db, snapshots, clock: () => 5_000 });
        expect(order).toEqual(['snapshot:25000']);
        expect(sqls.map(s => s.slice(0, 13))).toEqual(['SELECT to_reg', 'WITH stale AS']);
        expect(sqls[1]).toMatch(/ORDER BY \(state = 'requested'\), updated_at, id LIMIT \$1/);
        expect(info).toHaveBeenCalledWith('[reverse-move] pass', { startOffsetMs: 4_000, snapshot: 'held', claimed: 0, states: {}, errors: 0 });
        info.mockRestore();
    });
    it('no 0012 (production): one probe, no snapshot step, no claim; never throws out of the handler', async () => {
        const { db, sqls } = probeDb(false);
        const snapshots = vi.fn(async () => ({ status: 'held' }));
        await advanceReverseMoves(1_000, { db, snapshots, clock: () => 2_000 });
        expect(sqls).toHaveLength(1);
        expect(snapshots).not.toHaveBeenCalled();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const broken: PlacementDb = { execute: async () => { throw new Error('db down'); }, transaction: async () => { throw new Error('db down'); } };
        await expect(advanceReverseMoves(1_000, { db: broken, snapshots, clock: () => 2_000 })).resolves.toBeUndefined();
        warn.mockRestore();
    });
});
