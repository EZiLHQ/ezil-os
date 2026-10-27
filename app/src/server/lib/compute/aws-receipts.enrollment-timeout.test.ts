import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));
afterEach(() => vi.restoreAllMocks());

import { createAwsEc2Provider, type LifecycleStarter } from './aws-ec2';
import { LIFECYCLE_DEPLOYMENTS_ENV, type LifecycleIntent } from './aws-intent';
import { fixtureDeployment } from './aws-intent.test-support';
import { applyLifecycleReceipt } from './aws-receipts';
import { createFakePlacementDb, DEFAULT_OWNER, placementRow } from './fake-placement-db.test-support';
import {
    ENROLLMENT_FAILED, ENROLLMENT_PENDING, ENROLLMENT_SUCCEEDED, failUnenrolledPlacement, POOL_SESSION_PENDING,
    readPlacement, type Placement, type PlacementDb, type PlacementExecutor,
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

function setup(over: Record<string, unknown> = {}) {
    const fake = createFakePlacementDb({ placements: [placementRow({
        computer_id: C, state: 'MOUNTING', generation: 2, lease_epoch: 3,
        region: D.region, zone_id: D.zoneId, instance_type: 't3a.medium', instance_id: INSTANCE, volume_id: VOLUME,
        fs_uuid: 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5', fence_token: FENCE,
        enroll_nonce_hash: 'a'.repeat(64), enroll_expires_at: EXPIRES,
        lease_until: new Date(NOW.getTime() + 3_600_000), ...over,
    })], computers: [{ id: C, user_id: DEFAULT_OWNER }] }, { clock: () => NOW });
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
    const executions = { describe: vi.fn(async () => ({ status: 'RUNNING' })) };
    const deps = { db, now: () => NOW, starter, executions };
    const current = async () => (await readPlacement(db, C)).record!;
    const tick = async (p?: Placement) => applyLifecycleReceipt(deps, p ?? await current(), D);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    return { ...fake, db, deps, current, tick, starts, warn,
        race: (run: () => void, at: 'lock' | 'cas' = 'lock') => { race = { at, run }; } };
}

describe('MOUNTING enrollment timeout after the lifecycle job is cleared', () => {
    it.each([null, ENROLLMENT_PENDING])('classifies %j at the grace boundary and clears both nonce proofs once', async lastError => {
        const s = setup({ last_error: lastError, ...(lastError ? { enroll_nonce_hash: null, enroll_consumed_hash: 'a'.repeat(64) } : {}) });
        const before = await s.current();
        await s.tick(before);
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED,
            generation: 2, leaseEpoch: 3, instanceId: INSTANCE, volumeId: VOLUME, fenceToken: FENCE,
            lifecycleJobId: null, lifecycleDigest: null, enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null });
        await s.tick(before);
        await s.tick();
        expect(s.warn).toHaveBeenCalledExactlyOnceWith('[enroll-timeout]', {
            computerId: C, instanceId: INSTANCE, generation: 2, leaseEpoch: 3, enrollExpiresAt: EXPIRES, observedAt: NOW,
        });
        expect(s.starts).toEqual([]);
        expect(s.deps.executions.describe).not.toHaveBeenCalled();
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
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED, instanceId: INSTANCE });
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
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED });
        expect(s.warn).toHaveBeenCalledOnce();
    });

    it('leaves timeout recovery to the ordinary pass during terminal-only settlement', async () => {
        const s = setup(), before = await s.current();
        await applyLifecycleReceipt(s.deps, before, D, { terminalOnly: true });
        expect(await s.current()).toEqual(before);
        expect(s.warn).not.toHaveBeenCalled();
    });

    // Seam only: no production caller passes `retire` (KNOWN GAP, see failUnenrolledPlacement).
    describe('retire seam (unused in production)', () => {
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

        // KNOWN GAP (host leak, brief item 3 NOT delivered): pins today's behaviour so the
        // follow-up that adds an instance-only stop must change this test deliberately.
        it('KNOWN GAP: the receipt pass classifies but stops nothing; the refused host runs until a reopen replaces it', async () => {
            const s = setup();
            await s.tick();
            expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED, instanceId: INSTANCE, fenceToken: FENCE, lifecycleJobId: null });
            expect(s.starts).toEqual([]);
            expect(s.deps.starter.start).not.toHaveBeenCalled();
        });
    });

    it('the next ensure replaces the refused instance on the same volume', async () => {
        const s = setup();
        await s.tick();
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED });
        expect(s.starts).toEqual([]);
        const provider = createAwsEc2Provider({ ...s.deps, tierFor: async () => 'free', env: () => ({
            EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '10', AWS_REGIONS: D.region,
            EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2', EZIL_AWS_USER_MONTHLY_HOURS: '100',
            EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600', EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
            EZIL_AWS_ENROLL_URL: 'https://app.example.test/api/compute/aws/enroll',
            [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ [D.region]: D }),
        }) });
        expect(await provider.ensure({ correlationId: 'timeout' }, { userId: DEFAULT_OWNER, computerId: C },
            { sessionId: 's', desktopMode: 'neko' })).toMatchObject({ errorCode: 'computer_starting', computeLaunching: true });
        expect(s.starts).toHaveLength(1);
        expect(s.starts[0]).toMatchObject({ operation: 'replace', dataVolumeId: VOLUME, dataVolumeGiB: null,
            previousInstanceId: INSTANCE, previousGeneration: 2, previousFenceToken: FENCE, targetGeneration: 3, leaseEpoch: 4 });
        expect(await s.current()).toMatchObject({ state: 'STARTING', generation: 3, leaseEpoch: 4,
            volumeId: VOLUME, instanceId: null, lastError: null });
        expect(s.warn).toHaveBeenCalledOnce();
    });
});
