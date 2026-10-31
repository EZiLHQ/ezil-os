/**
 * Phase B (docs/compute/REVERSE-MOVE-CONTRACT.md §5.10): `computer.progress` during an AWS → Cloudflare move. The real
 * `readComputerProgress`, placement reads and reverse store over the fake placement db with an in-memory 0012.
 * - In flight: the moving view, whatever the export boot's placement says (never `opening`, `stopping` or `needs_operator`
 *   from it, `lifecycleState` null with the real state in `move.placementState`, no opening record read or written).
 * - Open blocked: `stage: 'needs_operator'` from the move itself. Terminal and visible: today's description plus `move`.
 * - No 0012, or no row: today's output, byte for byte.
 */
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/billing/v2/compute-access', () => ({ billingV2EntitlementReader: () => ({ read: async () => null }) }));

import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { ENROLLMENT_FAILED, ENROLLMENT_HOST_RETIRE, INSTANCE_LOST } from './placement';
import { readComputerProgress, reverseMoveExpectedSeconds } from './progress';
import { REVERSE_MOVE_BUDGET_SECONDS } from './provider-reverse';
import { REVERSE_MOVE_IN_FLIGHT } from './provider-reverse-store';

type Row = Record<string, unknown>;
const U = '11111111-1111-4111-8111-111111111111';
const C = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const M = '33333333-3333-4333-8333-333333333333';
const J = '55555555-5555-4555-8555-555555555555';
const F = '66666666-6666-4666-8666-666666666666';
const I = 'i-0123456789abcdef0', V = 'vol-0123456789abcdef0';
const env = { EZIL_COMPUTE_PLACEMENT_READS: '1', EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_KILL_SWITCH: '0' };
const now = new Date('2026-10-30T12:00:00Z');
const computer = { userId: U, computerId: C };

const held = (over: Row = {}) => placementRow({ computer_id: C, owner_user_id: U, provider: 'aws-ec2', state: 'STOPPED', region: 'ap-south-1',
    generation: 8, lease_epoch: 12, instance_type: 'm6i.large', instance_id: I, volume_id: V, fs_uuid: F, fence_token: J,
    updated_at: new Date('2026-10-30T11:00:00Z'), ...over });
const boot = { placementGeneration: 8, leaseEpoch: 12, region: 'ap-south-1', volumeId: V, jobId: J, instanceId: I, fsUuid: F, claimedAt: '2026-10-30T10:00:00.000Z' };
const moveRow = (over: Row = {}): Row => ({
    id: M, user_id: U, computer_id: C, started_by: 'open', state: 'copying', generation: 'g', export_boot: boot, export_head: null,
    import_progress: null, bytes_total: null, skipped: null, aws_volume_id: null, aws_fs_uuid: null, aws_snapshot_id: null, retain_until: null,
    attempts: 0, last_error: null, state_entered_at: '2026-10-30 10:05:00.5+00', commit_sent_at: null,
    created_at: '2026-10-30 09:59:00.123456+00', updated_at: '2026-10-30 10:06:01.123456+00',
    age_created: 7200, age_state_entered: 3300, age_commit_sent: null, age_last_chunk: null, ...over,
});

function world(placements: Row[], options: { present?: boolean; moves?: Row[] } = {}) {
    const fake = createFakePlacementDb({ placements }, { clock: () => now });
    const present = options.present ?? true;
    const dialect = new PgDialect();
    const execute = async (q: SQL): Promise<unknown> => {
        const { sql: text, params } = dialect.sqlToQuery(q);
        if (text.startsWith("SELECT to_regclass('public.ezil_compute_reverse_moves')")) return [{ present }];
        if (!text.includes('ezil_compute_reverse_moves')) return fake.db.execute(q);
        if (!present) throw new Error('relation "public.ezil_compute_reverse_moves" does not exist');
        const own = (options.moves ?? []).filter(r => r.computer_id === String(params[0]).toLowerCase());
        return own.length ? [own[own.length - 1]] : [];
    };
    return { db: { ...fake.db, execute }, fake };
}
const read = (w: ReturnType<typeof world>) => readComputerProgress(w.db as never, computer, env, now);
/** Statements of the opening record and the pool timings (`openingOptions`): never run for a move. */
const openingStatements = (w: ReturnType<typeof world>) => w.fake.statements.filter(s => s.sql.includes('transition:') || s.sql.includes('ezil_computers')
    || s.sql.includes('pool'));

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('the moving view (§5.10, pinned): nothing placement-derived drives it', () => {
    const exportBootPlacements: [string, Row][] = [
        ['LEASED', { state: 'LEASED', lifecycle_job_id: J, lease_until: new Date('2026-10-30T15:00:00Z') }],
        ['STARTING', { state: 'STARTING', lifecycle_job_id: J }],
        ['MOUNTING', { state: 'MOUNTING', enroll_expires_at: new Date('2026-10-30T12:10:00Z') }],
        ['MOUNTING past enrollment grace', { state: 'MOUNTING', enroll_expires_at: new Date('2026-10-30T09:00:00Z'), enroll_nonce_hash: 'a'.repeat(64) }],
        ['UNCONFIRMED/ENROLLMENT_FAILED (releaseExportBoot)', { state: 'UNCONFIRMED', last_error: ENROLLMENT_FAILED }],
        ['RECOVERING', { state: 'RECOVERING', last_error: ENROLLMENT_HOST_RETIRE, lifecycle_job_id: J }],
        ['RETIRING', { state: 'RETIRING', last_error: ENROLLMENT_HOST_RETIRE, lifecycle_job_id: J }],
        ['STOPPED/INSTANCE_LOST', { state: 'STOPPED', last_error: INSTANCE_LOST }],
    ];
    const cases = REVERSE_MOVE_IN_FLIGHT.flatMap(state => exportBootPlacements.map(([name, p]) => [state, name, p] as const));
    it.each(cases)('%s with the export boot %s: operation moving, no needsOperator, lifecycleState null, no opening read or written', async (state, _name, p) => {
        const w = world([held(p)], { moves: [moveRow({ state })] });
        const out = await read(w);
        expect(out).toMatchObject({ version: 2, operation: 'moving', stage: 'moving', recordedStage: state, lifecycleState: null,
            needsOperator: false, paused: false, operationsPaused: false, active: true, durable: true, resumePolicy: 'unavailable',
            etaSeconds: null, openingStartedAt: null, path: null, expectedSeconds: null, milestones: [], transition: null, selectedNextOpenHardware: null,
            hardware: { instanceType: 'm6i.large', source: 'placement' },
            move: { moveId: M, direction: 'to_cloudflare', outcome: null, reason: null, retry: null, openBlocked: false, holdOpenable: true,
                placementState: (p as { state: string }).state, budgetSeconds: REVERSE_MOVE_BUDGET_SECONDS } });
        expect(out!.typicalSeconds).toBe((out as { move: { expectedSeconds: number } }).move.expectedSeconds);
        expect(openingStatements(w)).toEqual([]);
    });
    it('phases and steps follow REVERSE_MOVE_DTO_STAGE\'s; timestamps are ISO from the DB-clock text', async () => {
        const expect_ = { requested: ['export_boot', 0], booting: ['export_boot', 0], exporting: ['exporting', 0], copying: ['importing', 1],
            checking: ['checking', 2], flipping: ['committing', 3] } as const;
        for (const state of REVERSE_MOVE_IN_FLIGHT) {
            const out = await read(world([held()], { moves: [moveRow({ state })] })) as { move: Row; startedAt: string; updatedAt: string };
            expect([out.move.phase, out.move.step], state).toEqual(expect_[state as keyof typeof expect_]);
            expect(out.move).toMatchObject({ startedAt: '2026-10-30T09:59:00.123Z', phaseStartedAt: '2026-10-30T10:05:00.500Z' });
            expect(out.startedAt).toBe('2026-10-30T09:59:00.123Z');
            expect(out.updatedAt).toBe('2026-10-30T10:06:01.123Z');
        }
    });
    it('importing: bytes, a floored percent, the transfer clock; before the head bytes are null; expected seconds ease only', async () => {
        const progress = { bitmap: '0'.repeat(128), bytes: 100_000_000, archiveSha256: 'a'.repeat(64), first: '2026-10-30T10:06:00+00:00', last: '2026-10-30T10:07:30.25+00:00' };
        const out = await read(world([held()], { moves: [moveRow({ state: 'copying', bytes_total: 300_000_000, import_progress: progress })] }));
        expect(out).toMatchObject({ bytes: { transferred: 100_000_000, total: 300_000_000 }, percent: 33,
            transferStartedAt: '2026-10-30T10:06:00.000Z', transferUpdatedAt: '2026-10-30T10:07:30.250Z',
            move: { bytesDone: 100_000_000, bytesTotal: 300_000_000, expectedSeconds: 240 + 120 + Math.ceil(300_000_000 / 1_048_576) + 150 } });
        const before = await read(world([held()], { moves: [moveRow({ state: 'exporting' })] }));
        expect(before).toMatchObject({ bytes: { transferred: null, total: null }, percent: null, move: { bytesDone: null, bytesTotal: null, expectedSeconds: 630 } });
        const checking = await read(world([held()], { moves: [moveRow({ state: 'checking', bytes_total: 300_000_000, import_progress: progress })] }));
        expect(checking).toMatchObject({ percent: null });
        expect([reverseMoveExpectedSeconds(null), reverseMoveExpectedSeconds(0), reverseMoveExpectedSeconds(536_870_912)]).toEqual([630, 600, 1022]);
        expect(reverseMoveExpectedSeconds(10_000_000_000)).toBe(3600);
    });
    it('an in-flight move continues under the kill switch: never paused or operations_paused', async () => {
        const out = await readComputerProgress(world([held({ state: 'MOUNTING' })], { moves: [moveRow({ state: 'booting' })] }).db as never, computer,
            { ...env, EZIL_AWS_KILL_SWITCH: '1' }, now);
        expect(out).toMatchObject({ operation: 'moving', stage: 'moving', paused: false, operationsPaused: false });
    });
    it('a held computer the hold cannot open: move.holdOpenable false', async () => {
        const out = await read(world([held({ instance_type: 'm6i.2xlarge' })], { moves: [moveRow()] }));
        expect(out).toMatchObject({ move: { holdOpenable: false } });
    });
    it('an image reservation racing requested still shows the move (placementState null); another owner\'s row is NOT_FOUND (null)', async () => {
        const reserved = await read(world([held({ image_upgrade_job_id: J })], { moves: [moveRow({ state: 'requested' })] }));
        expect(reserved).toMatchObject({ operation: 'moving', move: { placementState: null }, hardware: { source: 'unavailable' } });
        expect(await read(world([held()], { moves: [moveRow({ user_id: '22222222-2222-4222-8222-222222222222' })] }))).toBeNull();
    });
});

describe('ended moves (§5.10): open blocked takes over; any other visible terminal row only adds `move`', () => {
    it.each([['boot_unsettled', {}], ['already_imported', {}], ['flip_stuck', { commit_sent_at: '2026-10-30 11:00:00+00' }]] as const)(
        'failed_needs_operator %s (open blocked): the moving view with stage needs_operator', async (code, over) => {
            const w = world([held({ state: 'UNCONFIRMED', last_error: ENROLLMENT_FAILED })], { moves: [moveRow({ state: 'failed_needs_operator', last_error: code, ...over })] });
            expect(await read(w)).toMatchObject({ operation: 'moving', stage: 'needs_operator', needsOperator: true, active: false, lifecycleState: null,
                move: { outcome: 'failed_needs_operator', openBlocked: true, reason: code, retry: 'no', phase: null, step: null } });
            expect(openingStatements(w)).toEqual([]);
        });
    it('failed_reopened: the hold\'s own description (never the forward "reopened" stage) plus move', async () => {
        const plain = await read(world([held()]));
        const out = await read(world([held()], { moves: [moveRow({ state: 'failed_reopened', last_error: 'copy_stalled' })] }));
        expect(out).toEqual({ ...plain, move: expect.objectContaining({ outcome: 'failed_reopened', reason: 'copy_stalled', retry: 'now', openBlocked: false,
            holdOpenable: true, phase: null, step: null, placementState: 'STOPPED' }) });
        expect(out!.stage).toBe('stopped');
    });
    it('abort_unconfirmed (placement settled): ordinary description plus move, openBlocked false', async () => {
        const out = await read(world([held()], { moves: [moveRow({ state: 'failed_needs_operator', last_error: 'abort_unconfirmed' })] }));
        expect(out).toMatchObject({ operation: 'none', lifecycleState: 'STOPPED', move: { outcome: 'failed_needs_operator', openBlocked: false, retry: 'no' } });
    });
    it('committed: the Cloudflare placement\'s description plus move; reason null even with a spent snapshot reason; holdOpenable null', async () => {
        const cf = placementRow({ computer_id: C, owner_user_id: U, provider: 'cloudflare', workspace_store: 'r2', updated_at: new Date('2026-10-30T11:00:00Z') });
        const plain = await read(world([cf]));
        const out = await read(world([cf], { moves: [moveRow({ state: 'committed', last_error: 'snapshot_failed', commit_sent_at: '2026-10-30 11:00:00+00',
            retain_until: '2026-11-13T11:00:00Z' })] }));
        expect(out).toEqual({ ...plain, move: expect.objectContaining({ outcome: 'committed', reason: null, retry: null, holdOpenable: null, placementState: null }) });
    });
    it('a terminal row older than 24 h (DB clock) adds nothing', async () => {
        const plain = await read(world([held()]));
        expect(await read(world([held()], { moves: [moveRow({ state: 'failed_reopened', last_error: 'copy_stalled', age_state_entered: 86_400 })] }))).toStrictEqual(plain);
    });
});

describe('no 0012 or no row: today\'s output, byte for byte', () => {
    it.each([['RUNNING', {}], ['MOUNTING', { enroll_expires_at: new Date('2026-10-30T12:10:00Z') }], ['STOPPED', {}], ['UNCONFIRMED', {}]] as const)('%s', async (state, over) => {
        const today = await readComputerProgress(createFakePlacementDb({ placements: [held({ state, ...over })] }, { clock: () => now }).db as never, computer, env, now);
        expect(await read(world([held({ state, ...over })], { present: false, moves: [moveRow()] }))).toStrictEqual(today);
        expect(await read(world([held({ state, ...over })]))).toStrictEqual(today);
        expect(today).not.toHaveProperty('move');
    });
});
