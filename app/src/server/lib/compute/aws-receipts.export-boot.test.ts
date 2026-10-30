/**
 * The receipts' export-boot mode (REVERSE-MOVE-CONTRACT §5.2): a reverse move's export boot keeps every receipt rule but
 * two. STARTING → MOUNTING opens no usage row, and MOUNTING → RUNNING is never taken (no meter.ready, no epoch). The
 * mode is keyed on the reverse row's claim (`readByExportBoot`), probed after `reverseMovesTablePresent`.
 */
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { ComputeMeter } from '@/server/billing/v2/compute-meter';
import { applyLifecycleReceipt, isReverseExportBoot, type LifecycleExecutionReader } from './aws-receipts';
import { fixtureDeployment } from './aws-intent.test-support';
import type { LifecycleStarter } from './aws-ec2';
import { createFakePlacementDb, placementRow, type Row } from './fake-placement-db.test-support';
import { ENROLLMENT_FAILED, ENROLLMENT_HOST_RETIRE, ENROLLMENT_SUCCEEDED, readPlacement, type PlacementDb, type PlacementExecutor } from './placement';

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));

const U1 = '11111111-1111-4111-8111-111111111111';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const NOW = new Date('2026-10-20T00:00:00Z');
const D = fixtureDeployment('ap-south-1', ['t3a.medium', 't3.medium', 'm6i.large']);
const JOB = 'ababab00-abab-4bab-8bab-abababababab';
const DIGEST = 'd'.repeat(64);
const FENCE = 'fdfdfdfd-fdfd-4dfd-8dfd-fdfdfdfdfdfd';
const INSTANCE = 'i-22222222222222222';
const VOL = 'vol-11111111111111111';
const MOVE = '99999999-9999-4999-8999-999999999999';
/** The export boot: a replace to N+1 = 5, E+1 = 8, on the held computer's volume. */
const bootRow = (over: Row = {}) => placementRow({ computer_id: C1, owner_user_id: U1, state: 'STARTING', generation: 5, lease_epoch: 8,
    region: 'ap-south-1', zone_id: 'aps1-az1', instance_type: 't3a.medium', instance_id: null, volume_id: VOL,
    fs_uuid: 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5', fence_token: FENCE, lifecycle_job_id: JOB, lifecycle_digest: DIGEST,
    enroll_nonce_hash: 'a'.repeat(64), enroll_expires_at: new Date(NOW.getTime() + 300_000), lease_until: new Date(NOW.getTime() + 200 * 60_000), ...over });
const receipt = (over: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, jobId: JOB, digest: DIGEST, computerId: C1,
    generation: 5, leaseEpoch: 8, fenceToken: FENCE, instanceId: INSTANCE, volumeId: VOL, state: 'running', ...over });
/** The reverse row `readByExportBoot` returns (the store's own row shape, as PostgreSQL returns it). */
const reverseRow = (state = 'booting') => ({ id: MOVE, user_id: U1, computer_id: C1, started_by: 'open', state, generation: '77777777-7777-4777-8777-777777777777',
    export_boot: { placementGeneration: 5, leaseEpoch: 8, region: 'ap-south-1', volumeId: VOL, jobId: JOB, instanceId: null, fsUuid: null, claimedAt: NOW.toISOString() },
    export_head: null, import_progress: null, bytes_total: null, skipped: null, aws_volume_id: null, aws_fs_uuid: null, aws_snapshot_id: null,
    retain_until: null, attempts: 0, last_error: null, state_entered_at: NOW.toISOString(), commit_sent_at: null, created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(), age_created: 60, age_state_entered: 60, age_commit_sent: null, age_last_chunk: null });

/** The fake placement DB, plus the 0012 probe and `readByExportBoot` answered as `tables` says. */
function setup(rows: Row[], exec: { status: string; output?: string; startDate?: Date }, tables: { present: boolean; claim: boolean } = { present: true, claim: true }) {
    const fake = createFakePlacementDb({ placements: rows, computers: [{ id: C1, user_id: U1 }] }, { clock: () => NOW });
    const dialect = new PgDialect();
    const lookups: unknown[][] = [];
    const wrap = (x: PlacementExecutor): PlacementExecutor => ({ execute: async (q: SQL) => {
        const { sql: text, params } = dialect.sqlToQuery(q);
        if (text.startsWith("SELECT to_regclass('public.ezil_compute_reverse_moves')")) return { rows: [{ present: tables.present }] };
        if (text.includes('FROM public.ezil_compute_reverse_moves')) {
            if (!tables.present) throw new Error('relation "public.ezil_compute_reverse_moves" does not exist');
            expect(text).toMatch(/state <> 'committed'/);
            lookups.push(params);
            return { rows: tables.claim ? [reverseRow()] : [] };
        }
        // The fake models advisory locks and the CAS; the explicit row lock of the enrollment-failure path is a no-op here.
        if (text.startsWith('SELECT computer_id FROM public.ezil_computer_placements') && text.endsWith('FOR UPDATE')) return { rows: [] };
        return x.execute(q);
    } });
    const db: PlacementDb = { execute: q => wrap(fake.db).execute(q), transaction: fn => fake.db.transaction(tx => fn(wrap(tx))) };
    const executions: LifecycleExecutionReader = { describe: async () => exec };
    const meter = { ready: vi.fn(async () => 'opened'), stopped: vi.fn(async () => 'closed') } as unknown as ComputeMeter;
    const starts: string[] = [];
    const starter: LifecycleStarter = { start: async (_region, work) => { starts.push(JSON.parse(JSON.parse(work.input).document).operation); } };
    const deps = { db, executions, meter, starter, now: () => NOW, clock: () => NOW, sleep: async () => {}, newId: () => crypto.randomUUID() };
    const current = async () => (await readPlacement(db, C1)).record!;
    return { ...fake, db, deps, meter, lookups, starts, current };
}
const ok = { status: 'SUCCEEDED', output: receipt(), startDate: new Date(NOW.getTime() - 60_000) };

describe('the export-boot mode of applyLifecycleReceipt (§5.2)', () => {
    it('STARTING → MOUNTING with the receipt fields and no usage row; enrolled, it stays MOUNTING (no RUNNING, no epoch)', async () => {
        const s = setup([bootRow({ last_error: ENROLLMENT_SUCCEEDED, enroll_nonce_hash: null, instance_id: INSTANCE })], ok);
        await applyLifecycleReceipt(s.deps, await s.current(), D);
        expect(s.placements[0]).toMatchObject({ state: 'MOUNTING', lifecycle_job_id: null, instance_id: INSTANCE, generation: 5, lease_epoch: 8 });
        expect(s.usage).toEqual([]);
        expect(s.meter.ready).not.toHaveBeenCalled();
        // The lookup keyed on exactly this boot: computer, N+1, E+1, volume.
        expect(s.lookups[0]).toEqual(expect.arrayContaining([C1, 5, 8, VOL]));
        // Later passes: the cleared-job branch never takes RUNNING for it either.
        for (let i = 0; i < 3; i++) await applyLifecycleReceipt(s.deps, await s.current(), D);
        expect(s.placements[0]).toMatchObject({ state: 'MOUNTING', last_error: ENROLLMENT_SUCCEEDED });
        expect(s.usage).toEqual([]);
        expect(s.meter.ready).not.toHaveBeenCalled();
    });

    it('LEASED → STARTING → MOUNTING in one call, still no usage', async () => {
        const s = setup([bootRow({ state: 'LEASED' })], ok);
        await applyLifecycleReceipt(s.deps, await s.current(), D);
        expect(s.placements[0]).toMatchObject({ state: 'MOUNTING', lifecycle_job_id: null });
        expect(s.usage).toEqual([]);
    });

    it('control: the same boot with no reverse claim (or no 0012) is an ordinary boot: MOUNTING opens usage, enrolled goes RUNNING with an epoch', async () => {
        for (const tables of [{ present: true, claim: false }, { present: false, claim: false }]) {
            const s = setup([bootRow({ last_error: ENROLLMENT_SUCCEEDED, enroll_nonce_hash: null, instance_id: INSTANCE })], ok, tables);
            await applyLifecycleReceipt(s.deps, await s.current(), D);
            expect(s.placements[0], JSON.stringify(tables)).toMatchObject({ state: 'RUNNING' });
            expect(s.usage, JSON.stringify(tables)).toHaveLength(1);
            expect(s.meter.ready, JSON.stringify(tables)).toHaveBeenCalledTimes(1);
            if (!tables.present) expect(s.lookups).toEqual([]);
        }
    });

    it('a failed execution fails exactly like a Free open: UNCONFIRMED, no usage', async () => {
        const s = setup([bootRow()], { status: 'FAILED' });
        await applyLifecycleReceipt(s.deps, await s.current(), D);
        expect(s.placements[0]).toMatchObject({ state: 'UNCONFIRMED' });
        expect(s.usage).toEqual([]);
    });

    it('an unenrolled MOUNTING boot past grace is failed and its host retired, unchanged (failUnenrolledPlacement + retireUnenrolledHost)', async () => {
        const s = setup([bootRow({ state: 'MOUNTING', lifecycle_job_id: null, lifecycle_digest: null, instance_id: INSTANCE,
            enroll_expires_at: new Date(NOW.getTime() - 120_000) })], ok);
        await applyLifecycleReceipt(s.deps, await s.current(), D);
        expect(s.placements[0]).toMatchObject({ state: 'RETIRING', last_error: ENROLLMENT_HOST_RETIRE });
        expect(s.starts).toEqual(['retire']);
        expect(s.usage).toEqual([]);
    });

    it('the host retire after releaseExportBoot lands STOPPED/INSTANCE_LOST at N+1/E+1 and opens nothing', async () => {
        // releaseExportBoot left it UNCONFIRMED/ENROLLMENT_FAILED; retireUnenrolledHost recorded RETIRING with its job.
        const s = setup([bootRow({ state: 'RETIRING', instance_id: INSTANCE, last_error: ENROLLMENT_HOST_RETIRE, enroll_nonce_hash: null })],
            { status: 'SUCCEEDED', output: receipt({ state: 'retired' }), startDate: new Date(NOW.getTime() - 60_000) });
        await applyLifecycleReceipt(s.deps, await s.current(), D);
        expect(s.placements[0]).toMatchObject({ state: 'STOPPED', last_error: 'instance_lost', generation: 5, lease_epoch: 8, lifecycle_job_id: null });
        expect(s.usage).toEqual([]);
        expect(s.meter.ready).not.toHaveBeenCalled();
        void ENROLLMENT_FAILED;
    });

    it('isReverseExportBoot reads nothing outside the boot states or for a row without a valid volume', async () => {
        for (const over of [{ state: 'RUNNING' }, { state: 'STOPPED' }, { state: 'UNCONFIRMED' }, { volume_id: null }, { volume_id: 'vol-NOPE' },
            { provider: 'cloudflare', workspace_store: 'r2' }] as Row[]) {
            const s = setup([bootRow(over)], ok);
            expect(await isReverseExportBoot(s.db, await s.current()), JSON.stringify(over)).toBe(false);
            expect(s.lookups, JSON.stringify(over)).toEqual([]);
        }
        const s = setup([bootRow()], ok);
        expect(await isReverseExportBoot(s.db, await s.current())).toBe(true);
    });
});
