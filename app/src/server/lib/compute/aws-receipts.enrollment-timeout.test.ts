import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));
afterEach(() => vi.restoreAllMocks());

import { createAwsEc2Provider, type LifecycleStarter } from './aws-ec2';
import { LIFECYCLE_DEPLOYMENTS_ENV, type LifecycleIntent } from './aws-intent';
import { fixtureDeployment } from './aws-intent.test-support';
import { applyLifecycleReceipt, FLEET_RECONCILE_LIMIT, reconcileAwsFleet } from './aws-receipts';
import { createFakePlacementDb, DEFAULT_OWNER, placementRow } from './fake-placement-db.test-support';
import {
    ENROLLMENT_FAILED, ENROLLMENT_HOST_RETIRE, ENROLLMENT_PENDING, ENROLLMENT_SUCCEEDED, failUnenrolledPlacement, INSTANCE_LOST,
    POOL_SESSION_PENDING, readPlacement, type Placement, type PlacementDb, type PlacementExecutor,
} from './placement';

const C = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const INSTANCE = 'i-11111111111111111';
const VOLUME = 'vol-11111111111111111';
const FENCE = 'fdfdfdfd-fdfd-4dfd-8dfd-fdfdfdfdfdfd';
const NOW = new Date('2026-10-27T12:00:00Z');
const EXPIRES = new Date(NOW.getTime() - 60_000);
/** This nonce's issue time: every nonce writer uses ENROLL_NONCE_TTL_SECONDS (600 s). */
const ISSUED = new Date(EXPIRES.getTime() - 600_000);
const D = fixtureDeployment('ap-south-1', ['t3a.medium', 't3.medium']);
const dialect = new PgDialect();

/** The wake's usage row, open since the job reported the instance running (MOUNTING). */
const openUsage = () => ({ computer_id: C, user_id: DEFAULT_OWNER, instance_id: INSTANCE, instance_type: 't3a.medium',
    started_at: ISSUED, stopped_at: null, egress_bytes: null, observed_by: 'x', updated_at: ISSUED });

function setup(over: Record<string, unknown> = {}, seed: { usage?: Record<string, unknown>[] } = {}) {
    const fake = createFakePlacementDb({ placements: [placementRow({
        computer_id: C, state: 'MOUNTING', generation: 2, lease_epoch: 3,
        region: D.region, zone_id: D.zoneId, instance_type: 't3a.medium', instance_id: INSTANCE, volume_id: VOLUME,
        fs_uuid: 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5', fence_token: FENCE,
        enroll_nonce_hash: 'a'.repeat(64), enroll_expires_at: EXPIRES,
        lease_until: new Date(NOW.getTime() + 3_600_000), ...over,
    })], computers: [{ id: C, user_id: DEFAULT_OWNER }], ...seed }, { clock: () => NOW });
    let race: { at: 'lock' | 'cas'; run: () => void } | undefined;
    const wrap = (tx: PlacementExecutor): PlacementExecutor => ({ execute: async q => {
        const { sql, params } = dialect.sqlToQuery(q);
        const rowLock = sql.startsWith('SELECT computer_id FROM public.ezil_computer_placements') && sql.endsWith('FOR UPDATE');
        if (race && (race.at === 'lock' ? rowLock : sql.includes('/* placement:cas */'))) {
            const run = race.run; race = undefined; run();
        }
        // The fake models advisory locks and CAS; record the explicit row lock for SQL assertions.
        if (rowLock) {
            fake.statements.push({ sql, params, tx: fake.statements.at(-1)?.tx ?? null });
            return { rows: [] };
        }
        return tx.execute(q);
    } });
    const db: PlacementDb = { execute: fake.db.execute, transaction: fn => fake.db.transaction(tx => fn(wrap(tx))) };
    const starts: LifecycleIntent[] = [];
    const starter: LifecycleStarter = { start: vi.fn(async (_region, work) => {
        starts.push(JSON.parse(JSON.parse(work.input).document));
    }) };
    const executions = { describe: vi.fn(async (): Promise<{ status: string; output?: string; error?: string; cause?: string; startDate?: Date; stopDate?: Date }> => ({ status: 'RUNNING' })) };
    const deps = { db, now: () => NOW, starter, executions, sleep: async () => {} };
    const current = async () => (await readPlacement(db, C)).record!;
    const tick = async (p?: Placement) => applyLifecycleReceipt(deps, p ?? await current(), D);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    return { ...fake, db, deps, current, tick, starts, warn, info,
        race: (run: () => void, at: 'lock' | 'cas' = 'lock') => { race = { at, run }; } };
}

/** The helper's receipt for the host retire recorded on `p`: instance terminated, data volume kept. */
const retiredReceipt = (p: Placement, over: Record<string, unknown> = {}) => JSON.stringify({
    schemaVersion: 1, jobId: p.lifecycleJobId, digest: p.lifecycleDigest, computerId: C, generation: p.generation,
    leaseEpoch: p.leaseEpoch, fenceToken: FENCE, instanceId: INSTANCE, volumeId: VOLUME, state: 'retired', ...over,
});

const providerOf = (s: ReturnType<typeof setup>) => createAwsEc2Provider({ ...s.deps, tierFor: async () => 'free', env: () => ({
    EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '10', AWS_REGIONS: D.region,
    EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2', EZIL_AWS_USER_MONTHLY_HOURS: '100',
    EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600', EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    EZIL_AWS_ENROLL_URL: 'https://app.example.test/api/compute/aws/enroll',
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ [D.region]: D }),
}) });
const CTX = { correlationId: 'timeout' };
const REF = { userId: DEFAULT_OWNER, computerId: C };
const OPEN = { sessionId: 's', desktopMode: 'neko' as const };
/** Refused for good by AWS (a 4xx answer): nothing ran. */
const refusal = () => Object.assign(new Error('AccessDeniedException'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
/** No answer (5xx): the request may have been carried out. */
const lostAnswer = () => Object.assign(new Error('InternalServerError'), { name: 'InternalServerError', $metadata: { httpStatusCode: 500 } });
/** The fleet pass retries a refused or failed host retire no sooner than this (aws-receipts.ts ENROLL_HOST_RETIRE_RETRY_MS). */
const RETRY_MS = 10 * 60_000;
/** What the classifying pass leaves behind: the retire of the refused host is recorded and started. */
const retireRecorded = { state: 'RETIRING', lastError: ENROLLMENT_HOST_RETIRE, generation: 2, leaseEpoch: 3,
    instanceId: INSTANCE, volumeId: VOLUME, fenceToken: FENCE, enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null };
const retireIntent = (p: Placement) => ({ operation: 'retire', jobId: p.lifecycleJobId, computerId: C, targetGeneration: 2, leaseEpoch: 3,
    fenceToken: FENCE, providerInstanceId: INSTANCE, dataVolumeId: VOLUME, previousInstanceId: null, previousGeneration: null,
    previousFenceToken: null, userData: null, instanceType: 't3a.medium' });

describe('MOUNTING enrollment timeout after the lifecycle job is cleared', () => {
    it.each([null, ENROLLMENT_PENDING])('classifies %j at the grace boundary and clears both nonce proofs once', async lastError => {
        const s = setup({ last_error: lastError, ...(lastError ? { enroll_nonce_hash: null, enroll_consumed_hash: 'a'.repeat(64) } : {}) });
        const before = await s.current();
        await s.tick(before);
        // Classified (both nonce proofs cleared), then the refused host's retire recorded and started in the same pass.
        const after = await s.current();
        expect(after).toMatchObject(retireRecorded);
        expect(after.lifecycleJobId).toMatch(/^[0-9a-f-]{36}$/);
        expect(after.lifecycleDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(s.starts).toEqual([expect.objectContaining(retireIntent(after))]);
        expect(s.deps.executions.describe).not.toHaveBeenCalled();
        await s.tick(before); // a stale observation: nothing
        await s.tick(); // the recorded job is followed (still running): nothing new
        expect(s.warn).toHaveBeenCalledExactlyOnceWith('[enroll-timeout]', {
            computerId: C, instanceId: INSTANCE, generation: 2, leaseEpoch: 3, enrollExpiresAt: EXPIRES, observedAt: NOW,
        });
        expect(s.deps.starter.start).toHaveBeenCalledOnce();
        expect(s.deps.executions.describe).toHaveBeenCalledOnce();
        expect(await s.current()).toEqual(after);
        expect(s.usage).toEqual([]);
        const sqls = s.statements.map(q => q.sql);
        const admission = sqls.findIndex(sql => sql.includes('placement:lock-admission'));
        const computer = sqls.findIndex(sql => sql.includes('placement:lock-computer'));
        const rowLock = sqls.findIndex(sql => sql.endsWith('FOR UPDATE'));
        const cas = sqls.findIndex(sql => sql.includes('placement:cas'));
        expect(admission).toBeGreaterThan(-1);
        expect(computer).toBeGreaterThan(admission);
        expect(rowLock).toBeGreaterThan(computer);
        expect(cas).toBeGreaterThan(rowLock);
        expect(sqls[cas]).toContain('updated_at =');
        expect(sqls[cas]).toContain('last_error IS NOT DISTINCT FROM');
    });

    it.each([0, 1_000, 59_000, 59_999])('keeps waiting %i ms after the nonce expires', async elapsed => {
        const s = setup({ enroll_expires_at: new Date(NOW.getTime() - elapsed) });
        const before = await s.current();
        await s.tick();
        expect(await s.current()).toEqual(before);
        expect(s.warn).not.toHaveBeenCalled();
    });

    it.each([
        ['presence in this epoch', { presence_at: new Date(EXPIRES.getTime() - 300_000) }],
        ['rebase presence stamped at the nonce issue time', { presence_at: ISSUED }],
        ['success marker', { last_error: ENROLLMENT_SUCCEEDED }],
        ['pool session pending', { last_error: POOL_SESSION_PENDING }],
        ['no deadline', { enroll_expires_at: null }],
        ['RUNNING', { state: 'RUNNING' }],
        ['lifecycle job', { lifecycle_job_id: FENCE, lifecycle_digest: 'd'.repeat(64) }],
    ] as const)('leaves a placement with %s untouched', async (_name, over) => {
        const s = setup(over);
        const before = await s.current();
        expect(await failUnenrolledPlacement(s.db, before, NOW)).toEqual({ ok: false, reason: 'cas_conflict' });
        await s.tick();
        expect(await s.current()).toEqual(before);
        expect(s.warn).not.toHaveBeenCalled();
    });

    it.each([
        ['an hour before this nonce', new Date(NOW.getTime() - 3_600_000)],
        ['1 ms before this nonce was issued', new Date(ISSUED.getTime() - 1)],
    ] as const)('classifies despite stale presence from an earlier session (%s)', async (_name, presenceAt) => {
        // presence_at is monotonic and never cleared by a lease, wake or replace: a returning
        // owner's earlier RUNNING session must not hide this epoch's enrollment failure.
        const s = setup({ presence_at: presenceAt }), before = await s.current();
        await s.tick(before);
        expect(await s.current()).toMatchObject(retireRecorded);
        expect(s.warn).toHaveBeenCalledOnce();
    });

    it('promotes an enrolled placement to RUNNING even after the deadline', async () => {
        const s = setup({ last_error: ENROLLMENT_SUCCEEDED, enroll_nonce_hash: null });
        await s.tick();
        expect(await s.current()).toMatchObject({ state: 'RUNNING', lastError: ENROLLMENT_SUCCEEDED });
        expect(s.warn).not.toHaveBeenCalled();
    });

    it.each([
        ['presence', { presence_at: NOW }],
        ['enrollment success', { last_error: ENROLLMENT_SUCCEEDED, enroll_nonce_hash: null }],
        ['pool session pending', { last_error: POOL_SESSION_PENDING }],
        ['RUNNING', { state: 'RUNNING' }],
        ['renewed deadline', { enroll_expires_at: new Date(NOW.getTime() + 60_000) }],
        ['row version', { updated_at: NOW }],
        ['generation', { generation: 3 }],
        ['lease epoch', { lease_epoch: 4 }],
        ['job', { lifecycle_job_id: FENCE }],
        ['instance', { instance_id: 'i-22222222222222222' }],
        ['volume', { volume_id: 'vol-22222222222222222' }],
        ['fence', { fence_token: C }],
    ] as const)('rejects stale observations when %s changes before the row lock', async (_name, change) => {
        const s = setup(), before = await s.current();
        s.race(() => Object.assign(s.placements[0]!, change));
        await s.tick(before);
        expect(s.placements[0]).toMatchObject({ state: 'MOUNTING', last_error: null, ...change });
        expect(s.warn).not.toHaveBeenCalled();
        expect(s.starts).toEqual([]);
    });

    it('does not classify or log when the final CAS loses the row version', async () => {
        const s = setup(), before = await s.current();
        s.race(() => { s.placements[0]!.updated_at = NOW; }, 'cas');
        await s.tick(before);
        expect(await s.current()).toEqual({ ...before, updatedAt: NOW });
        expect(s.statements.some(q => q.sql.includes('/* placement:cas */'))).toBe(true);
        expect(s.warn).not.toHaveBeenCalled();
    });

    it('classifies only once when two receipt polls race', async () => {
        const s = setup(), before = await s.current();
        await Promise.all([s.tick(before), s.tick(before)]);
        expect(await s.current()).toMatchObject(retireRecorded);
        expect(s.warn).toHaveBeenCalledOnce();
        expect(s.deps.starter.start).toHaveBeenCalledOnce();
    });

    it('leaves timeout recovery to the ordinary pass during terminal-only settlement', async () => {
        const s = setup(), before = await s.current();
        await applyLifecycleReceipt(s.deps, before, D, { terminalOnly: true });
        expect(await s.current()).toEqual(before);
        expect(s.warn).not.toHaveBeenCalled();
    });

    // In-transaction seam only: the host retire itself starts AFTER the classification commits
    // (a Step Functions start inside the transaction would be authorized against an uncommitted row).
    describe('retire seam (in-transaction hook)', () => {
        it('runs exactly once, inside the classifying transaction, only after a successful CAS', async () => {
            const s = setup(), before = await s.current();
            const seen: string[] = [];
            const retire = vi.fn(async (tx: PlacementExecutor) => {
                const { record } = await readPlacement(tx, C);
                seen.push(`${record!.state}:${record!.lastError}:${record!.instanceId}`);
            });
            expect(await failUnenrolledPlacement(s.db, before, NOW, retire)).toMatchObject({ ok: true });
            expect(retire).toHaveBeenCalledOnce();
            expect(seen).toEqual([`UNCONFIRMED:${ENROLLMENT_FAILED}:${INSTANCE}`]);
            const casAt = s.statements.findIndex(q => q.sql.includes('/* placement:cas */'));
            expect(s.statements.at(-1)!.tx).toBe(s.statements[casAt]!.tx);
            // Idempotent: the stale observation and the classified row both refuse before any work.
            expect(await failUnenrolledPlacement(s.db, before, NOW, retire)).toEqual({ ok: false, reason: 'cas_conflict' });
            expect(await failUnenrolledPlacement(s.db, await s.current(), NOW, retire)).toEqual({ ok: false, reason: 'cas_conflict' });
            expect(retire).toHaveBeenCalledOnce();
        });

        it.each(['lock', 'cas'] as const)('is not invoked when the row version changes at the %s step', async at => {
            const s = setup(), before = await s.current();
            const retire = vi.fn(async () => {});
            s.race(() => { s.placements[0]!.updated_at = NOW; }, at);
            expect(await failUnenrolledPlacement(s.db, before, NOW, retire)).toEqual({ ok: false, reason: 'cas_conflict' });
            expect(retire).not.toHaveBeenCalled();
            expect(s.placements[0]).toMatchObject({ state: 'MOUNTING' });
        });

        it('is not invoked when two classifications race; the loser sees a conflict', async () => {
            const s = setup(), before = await s.current();
            const retire = vi.fn(async () => {});
            const results = await Promise.all([failUnenrolledPlacement(s.db, before, NOW, retire), failUnenrolledPlacement(s.db, before, NOW, retire)]);
            expect(results.filter(r => r.ok)).toHaveLength(1);
            expect(retire).toHaveBeenCalledOnce();
        });

        it.each([
            ['enrollment succeeded', { last_error: ENROLLMENT_SUCCEEDED, enroll_nonce_hash: null }],
            ['host presence', { presence_at: NOW }],
            ['grace not elapsed', { enroll_expires_at: new Date(NOW.getTime() - 59_999) }],
        ] as const)('is never invoked when %s', async (_name, over) => {
            const s = setup(over), before = await s.current();
            const retire = vi.fn(async () => {});
            expect(await failUnenrolledPlacement(s.db, before, NOW, retire)).toEqual({ ok: false, reason: 'cas_conflict' });
            expect(retire).not.toHaveBeenCalled();
        });

        it('is not invoked when enrollment succeeds between the observation and the row lock', async () => {
            const s = setup(), before = await s.current();
            const retire = vi.fn(async () => {});
            s.race(() => Object.assign(s.placements[0]!, { last_error: ENROLLMENT_SUCCEEDED, enroll_nonce_hash: null }));
            expect(await failUnenrolledPlacement(s.db, before, NOW, retire)).toEqual({ ok: false, reason: 'cas_conflict' });
            expect(retire).not.toHaveBeenCalled();
            expect(s.placements[0]).toMatchObject({ state: 'MOUNTING', last_error: ENROLLMENT_SUCCEEDED });
        });

        it('a retire failure rolls the classification back', async () => {
            const s = setup(), before = await s.current();
            await expect(failUnenrolledPlacement(s.db, before, NOW, async () => { throw new Error('retire_conflict'); })).rejects.toThrow('retire_conflict');
            expect(await s.current()).toEqual(before);
        });

        it('without a starter the pass only classifies; the fleet pass retires the host once one is configured', async () => {
            const s = setup();
            await applyLifecycleReceipt({ db: s.db, now: () => NOW, executions: s.deps.executions }, await s.current(), D);
            expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED, instanceId: INSTANCE, fenceToken: FENCE, lifecycleJobId: null });
            expect(s.starts).toEqual([]);
            // Freshly classified: the fleet pass gives the inline start its retry spacing before taking over.
            expect(await reconcileAwsFleet(s.deps, { [D.region]: D })).toMatchObject({ checked: 1, hostRetires: 0 });
            expect(s.starts).toEqual([]);
            const later = { ...s.deps, now: () => new Date(NOW.getTime() + RETRY_MS + 1_000) };
            expect(await reconcileAwsFleet(later, { [D.region]: D })).toMatchObject({ checked: 1, hostRetires: 1 });
            expect(await s.current()).toMatchObject(retireRecorded);
            expect(s.starts).toEqual([expect.objectContaining({ operation: 'retire', providerInstanceId: INSTANCE })]);
        });
    });
});

describe('retiring the refused host (the enrollment-failure host retire)', () => {
    it('the retire receipt lands STOPPED with INSTANCE_LOST on the kept volume, never RETIRED, and the next open replaces onto it', async () => {
        const s = setup();
        await s.tick();
        const retiring = await s.current();
        expect(retiring).toMatchObject(retireRecorded);
        s.deps.executions.describe.mockResolvedValue({ status: 'SUCCEEDED', output: retiredReceipt(retiring), startDate: NOW, stopDate: NOW });
        await s.tick();
        const stopped = await s.current();
        expect(stopped).toMatchObject({ state: 'STOPPED', lastError: INSTANCE_LOST, generation: 2, leaseEpoch: 3,
            instanceId: INSTANCE, volumeId: VOLUME, fenceToken: FENCE, lifecycleJobId: null, lifecycleDigest: null });
        expect(s.usage).toEqual([]); // never opened: nothing to close
        await s.tick();
        expect(await s.current()).toEqual(stopped);
        expect(s.deps.starter.start).toHaveBeenCalledOnce();
        // The owner's next open REPLACES onto the retained volume, as for any lost instance.
        expect(await providerOf(s).ensure(CTX, REF, OPEN)).toMatchObject({ errorCode: 'computer_starting', computeLaunching: true });
        expect(s.starts).toHaveLength(2);
        expect(s.starts[1]).toMatchObject({ operation: 'replace', dataVolumeId: VOLUME, dataVolumeGiB: null,
            previousInstanceId: INSTANCE, previousGeneration: 2, previousFenceToken: FENCE, targetGeneration: 3, leaseEpoch: 4 });
        expect(await s.current()).toMatchObject({ state: 'STARTING', generation: 3, leaseEpoch: 4, volumeId: VOLUME, instanceId: null, lastError: null });
    });

    it('the retire receipt closes the dead generation\'s open usage row at the execution stop time', async () => {
        const s = setup({}, { usage: [openUsage()] });
        await s.tick();
        const retiring = await s.current();
        expect(s.usage).toEqual([expect.objectContaining({ instance_id: INSTANCE, stopped_at: null })]); // open until the instance is gone
        const stopDate = new Date(NOW.getTime() - 30_000);
        s.deps.executions.describe.mockResolvedValue({ status: 'SUCCEEDED', output: retiredReceipt(retiring), startDate: new Date(NOW.getTime() - 120_000), stopDate });
        await s.tick();
        expect(await s.current()).toMatchObject({ state: 'STOPPED', lastError: INSTANCE_LOST });
        expect(s.usage).toEqual([expect.objectContaining({ computer_id: C, instance_id: INSTANCE, stopped_at: stopDate, observed_by: 'lifecycle-receipt' })]);
        // Idempotent: a later look closes nothing again.
        await s.tick();
        expect(s.usage).toEqual([expect.objectContaining({ stopped_at: stopDate })]);
    });

    it('invalid stop evidence closes the usage row at the observation clock instead', async () => {
        const s = setup({}, { usage: [openUsage()] });
        await s.tick();
        const retiring = await s.current();
        s.deps.executions.describe.mockResolvedValue({ status: 'SUCCEEDED', output: retiredReceipt(retiring), startDate: NOW, stopDate: new Date(NOW.getTime() - 1) });
        await s.tick();
        expect(await s.current()).toMatchObject({ state: 'STOPPED', lastError: INSTANCE_LOST });
        expect(s.usage).toEqual([expect.objectContaining({ instance_id: INSTANCE, stopped_at: NOW })]);
    });

    it('a receipt for another instance or an unretired state is a conflict, not a stop', async () => {
        const s = setup();
        await s.tick();
        const retiring = await s.current();
        s.deps.executions.describe.mockResolvedValue({ status: 'SUCCEEDED', output: retiredReceipt(retiring, { instanceId: 'i-22222222222222222' }) });
        await s.tick();
        // As for any conflicting receipt: left for an operator with the job retained; no further retire is started.
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: 'receipt_conflict', instanceId: INSTANCE, lifecycleJobId: retiring.lifecycleJobId });
        const later = { ...s.deps, now: () => new Date(NOW.getTime() + RETRY_MS + 1_000) };
        expect(await reconcileAwsFleet(later, { [D.region]: D })).toMatchObject({ hostRetires: 0 });
        expect(s.deps.starter.start).toHaveBeenCalledOnce();
    });

    it('while the retire runs, the owner sees a retryable stopping computer, not an error', async () => {
        const s = setup();
        await s.tick();
        const provider = providerOf(s);
        expect(await provider.ensure(CTX, REF, OPEN)).toMatchObject({ ok: false, errorCode: 'computer_stopping', retryable: true });
        expect(await provider.status(CTX, REF)).toMatchObject({ ok: true, state: 'stopping', placementState: 'RETIRING' });
        expect(s.deps.starter.start).toHaveBeenCalledOnce();
        expect(await s.current()).toMatchObject(retireRecorded);
    });

    it('a FAILED retire execution returns the row to UNCONFIRMED with ENROLLMENT_FAILED (the owner can still replace) and is retried only after the spacing', async () => {
        const s = setup();
        await s.tick();
        s.deps.executions.describe.mockResolvedValue({ status: 'FAILED', error: 'States.TaskFailed', cause: 'lifecycle_volume_invalid' });
        await s.tick();
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED, instanceId: INSTANCE,
            volumeId: VOLUME, fenceToken: FENCE, generation: 2, leaseEpoch: 3, lifecycleJobId: null, lifecycleDigest: null });
        expect(s.warn).toHaveBeenCalledWith('[enroll-host-retire]', expect.objectContaining({ computerId: C, instanceId: INSTANCE, outcome: 'failed' }));
        s.deps.executions.describe.mockResolvedValue({ status: 'RUNNING' });
        expect(await reconcileAwsFleet(s.deps, { [D.region]: D })).toMatchObject({ hostRetires: 0 });
        expect(s.deps.starter.start).toHaveBeenCalledOnce();
        const later = { ...s.deps, now: () => new Date(NOW.getTime() + RETRY_MS + 1_000) };
        expect(await reconcileAwsFleet(later, { [D.region]: D })).toMatchObject({ hostRetires: 1 });
        expect(s.deps.starter.start).toHaveBeenCalledTimes(2);
        expect(await s.current()).toMatchObject(retireRecorded);
        // The owner's open still replaces an UNCONFIRMED/ENROLLMENT_FAILED row (no retire in flight).
        const again = setup({ state: 'UNCONFIRMED', last_error: ENROLLMENT_FAILED, enroll_nonce_hash: null, enroll_expires_at: null });
        expect(await providerOf(again).ensure(CTX, REF, OPEN)).toMatchObject({ errorCode: 'computer_starting', computeLaunching: true });
        expect(again.starts).toEqual([expect.objectContaining({ operation: 'replace', previousInstanceId: INSTANCE, targetGeneration: 3 })]);
    });

    it('a refused StartExecution leaves UNCONFIRMED with ENROLLMENT_FAILED and no job', async () => {
        const s = setup();
        s.deps.starter.start = vi.fn(async () => { throw refusal(); });
        await s.tick();
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED, instanceId: INSTANCE, lifecycleJobId: null, lifecycleDigest: null });
        expect(s.deps.starter.start).toHaveBeenCalledOnce();
        expect(s.warn).toHaveBeenCalledWith('[enroll-host-retire]', expect.objectContaining({ computerId: C, instanceId: INSTANCE, outcome: 'refused' }));
        expect(s.deps.executions.describe).not.toHaveBeenCalled();
    });

    it('an unknown StartExecution keeps the job and the marker; the later SUCCEEDED receipt still lands STOPPED', async () => {
        const s = setup();
        s.deps.starter.start = vi.fn(async () => { throw lostAnswer(); });
        await s.tick();
        const retiring = await s.current();
        expect(retiring).toMatchObject({ ...retireRecorded, lastError: `lifecycle_start_unknown:UNCONFIRMED:${ENROLLMENT_HOST_RETIRE}` });
        expect(retiring.lifecycleJobId).not.toBeNull();
        expect(s.deps.starter.start).toHaveBeenCalledTimes(3);
        s.deps.executions.describe.mockResolvedValue({ status: 'SUCCEEDED', output: retiredReceipt(retiring) });
        await s.tick();
        expect(await s.current()).toMatchObject({ state: 'STOPPED', lastError: INSTANCE_LOST, instanceId: INSTANCE, volumeId: VOLUME, lifecycleJobId: null });
    });

    it('the fleet pass retires an already-classified refused host (no job, older than the spacing) exactly once', async () => {
        // The backlog: a row classified before this code shipped, its instance still running for hours.
        const s = setup({ state: 'UNCONFIRMED', last_error: ENROLLMENT_FAILED, enroll_nonce_hash: null, enroll_expires_at: null,
            updated_at: new Date(NOW.getTime() - 4 * 3_600_000) });
        expect(await reconcileAwsFleet(s.deps, { [D.region]: D }, FLEET_RECONCILE_LIMIT)).toMatchObject({ checked: 1, hostRetires: 1, stopsStarted: 0 });
        const retiring = await s.current();
        expect(retiring).toMatchObject(retireRecorded);
        expect(s.starts).toEqual([expect.objectContaining(retireIntent(retiring))]);
        expect(await reconcileAwsFleet(s.deps, { [D.region]: D }, FLEET_RECONCILE_LIMIT)).toMatchObject({ checked: 1, hostRetires: 0 });
        expect(s.deps.starter.start).toHaveBeenCalledOnce();
        expect(await s.current()).toEqual(retiring);
    });

    it.each([
        ['a recorded job', { lifecycle_job_id: FENCE, lifecycle_digest: 'd'.repeat(64) }],
        ['another failure code', { last_error: 'capacity:aws_capacity' }],
        ['no instance recorded', { instance_id: null }],
        ['no volume recorded', { volume_id: null }],
        ['no fence', { fence_token: null }],
    ] as const)('the fleet pass never starts a host retire for an UNCONFIRMED row with %s', async (_name, over) => {
        const s = setup({ state: 'UNCONFIRMED', last_error: ENROLLMENT_FAILED, enroll_nonce_hash: null, enroll_expires_at: null,
            updated_at: new Date(NOW.getTime() - 4 * 3_600_000), ...over });
        const before = await s.current();
        expect(await reconcileAwsFleet(s.deps, { [D.region]: D })).toMatchObject({ hostRetires: 0 });
        expect(s.starts).toEqual([]);
        expect(await s.current()).toMatchObject({ state: before.state, lastError: before.lastError, instanceId: before.instanceId });
    });
});
