/**
 * The reverse machine (REVERSE-MOVE-CONTRACT §5.4–§5.8) over fake ports: an in-memory reverse row with the store's own
 * rules (compare-and-swap, attempts, the `compensate:` marker), a mutable placement, and a scripted Worker. Ages are set
 * by hand: the machine never reads a clock for a deadline, only for its pass budget.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { MIGRATE_ACTION_TIMEOUT_MS } from '../cloudflare-guacamole-provider';
import {
    ENROLLMENT_FAILED, ENROLLMENT_HOST_RETIRE, ENROLLMENT_SUCCEEDED, ImageJobConflictError, INSTANCE_LOST, PlacementIntegrityError, type Placement,
} from './placement';
import {
    advanceReverseMove, classifyWorkerFailure, exportHeadFor, REVERSE_CALL_FIT_MS, REVERSE_DEADLINE_SECONDS, REVERSE_MOVE_BUDGET_SECONDS,
    REVERSE_OPERATOR_CODES, REVERSE_REOPEN_FINAL_CODES, reverseBootSettled, reverseCompensation, reverseDeadlineFailure, reverseFailureClass,
    reverseOpenBlocked, sweepReverseMoves, type ReversePorts, type ReverseWorkerResult,
} from './provider-reverse';
import {
    bitmapHas, bitmapSet, EXPORT_CHUNK_BYTES, importComplete, REVERSE_MOVE_MAX_ATTEMPTS, ReverseMoveConflictError,
    type ComputeReverseMove, type ReverseExportBoot, type ReverseMoveState,
} from './provider-reverse-store';

const U = '11111111-1111-4111-8111-111111111111';
const C = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const MOVE = '99999999-9999-4999-8999-999999999999';
const GEN = '77777777-7777-4777-8777-777777777777';
const JOB = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const VOL = 'vol-11111111111111111';
const I_OLD = 'i-11111111111111111', I_NEW = 'i-22222222222222222';
const BOOT: ReverseExportBoot = { placementGeneration: 5, leaseEpoch: 8, region: 'ap-south-1', volumeId: VOL, jobId: JOB, instanceId: null,
    fsUuid: 'abababab-abab-4bab-8bab-abababababab', claimedAt: '2026-10-30T09:00:00.000Z' };
const headOf = (sizes: number[]) => ({ generation: GEN, sha256: 'f'.repeat(64), entries: 9, skipped: 1, bytes: sizes.reduce((a, b) => a + b, 0),
    chunks: sizes.map((size, i) => ({ i, size, sha256: String(i % 10).repeat(64) })) });
const HEAD = headOf([EXPORT_CHUNK_BYTES, EXPORT_CHUNK_BYTES, 77]);

/** The held computer's STOPPED placement at N = 4, E = 7. */
const held = (over: Partial<Placement> = {}): Placement => ({ computerId: C, ownerUserId: U, provider: 'aws-ec2', store: 'ebs', generation: 4, leaseEpoch: 7,
    state: 'STOPPED', region: 'ap-south-1', zoneId: 'aps1-az1', instanceId: I_OLD, instanceType: 't3a.medium', volumeId: VOL, fsUuid: BOOT.fsUuid,
    tunnelId: null, enrollNonceHash: null, enrollExpiresAt: null, enrollConsumedHash: null, leaseUntil: null, presenceAt: null,
    fenceToken: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', lifecycleJobId: null, lifecycleDigest: null, lastError: INSTANCE_LOST,
    updatedAt: new Date('2026-10-30T08:00:00Z'), ...over });
/** The export boot's placement at N+1/E+1. */
const bootAt = (over: Partial<Placement> = {}) => held({ generation: 5, leaseEpoch: 8, lastError: null, ...over });

const ok = <T>(data: T): ReverseWorkerResult<T> => ({ ok: true, data });
const conflict = (reason: string) => ({ ok: false as const, error: 'conflict' as const, reason });

function row(over: Partial<ComputeReverseMove> = {}): ComputeReverseMove {
    return { id: MOVE, userId: U, computerId: C, startedBy: 'open', state: 'requested', generation: GEN, exportBoot: null, exportHead: null,
        importProgress: null, bytesTotal: null, skipped: null, awsVolumeId: null, awsFsUuid: null, awsSnapshotId: null, retainUntil: null,
        attempts: 0, lastError: null, stateEnteredAt: 't0', commitSentAt: null, createdAt: 't0', updatedAt: 'v0',
        ages: { created: 10, stateEntered: 10, commitSent: null, lastChunk: null }, ...over };
}

type Op = 'begin' | 'pull' | 'verify' | 'commit' | 'abort';
/** A fake world: one reverse row with the store's rules, one placement, a scripted Worker, every call recorded. */
function world(initial: Partial<ComputeReverseMove>, p: Placement | null, opts: {
    kill?: boolean; paid?: boolean; paidAtFlip?: boolean; epoch?: boolean; reserved?: boolean; claim?: string; budgetMs?: number;
    worker?: Partial<Record<Op, (m: ComputeReverseMove, from?: number, count?: number) => ReverseWorkerResult<unknown>>>;
    onSettle?: (p: Placement) => Placement | null;
    flipThrows?: Error;
} = {}) {
    let current = row(initial), version = 0, now = 0;
    let placement = p;
    const calls: string[] = [], logs: Record<string, unknown>[] = [], writes: string[] = [];
    const cas = (expected: ComputeReverseMove, patch: Partial<ComputeReverseMove>, write: string) => {
        if (expected.updatedAt !== current.updatedAt || expected.state !== current.state) throw new ReverseMoveConflictError('lost_race');
        const entered = patch.state !== undefined && patch.state !== current.state;
        current = { ...current, ...patch, updatedAt: `v${++version}`, ages: { ...current.ages, ...(entered ? { stateEntered: 0 } : {}), ...patch.ages } };
        writes.push(write);
        return current;
    };
    const store: ReversePorts['store'] = {
        readById: async () => current,
        recordExportBoot: async (m, boot) => cas(m, { state: 'booting', exportBoot: boot }, `boot:${boot.instanceId ?? '-'}`),
        advance: async (m, to) => cas(m, { state: to, attempts: 0, lastError: null, ...(to === 'flipping' ? { commitSentAt: 'sent', ages: { ...m.ages, commitSent: 0 } } : {}) }, `advance:${to}`),
        recordExportHead: async (m, head) => cas(m, { state: 'copying', exportHead: head, bytesTotal: head.bytes, skipped: head.skipped, importProgress: null, attempts: 0, lastError: null }, 'head'),
        async recordImportProgress(m, indices) {
            const before = m.importProgress?.bitmap ?? '0'.repeat(128), fresh = indices.filter(i => !bitmapHas(before, i));
            if (!fresh.length) return m;
            return cas(m, { importProgress: { bitmap: bitmapSet(before, fresh), bytes: 0, archiveSha256: m.exportHead!.sha256, first: 'f', last: 'l' },
                attempts: 0, lastError: null, ages: { ...m.ages, lastChunk: 0 } }, `progress:${fresh.join(',')}`);
        },
        async recordRetry(m, reason) {
            if (m.state !== 'flipping' && m.attempts >= REVERSE_MOVE_MAX_ATTEMPTS) return { move: m, exhausted: true };
            return { move: cas(m, { attempts: Math.min(m.attempts + 1, 5), lastError: reason }, `retry:${reason}`), exhausted: false };
        },
        recordCompensation: async (m, marker) => cas(m, { attempts: 0, lastError: marker }, marker),
        fail: async (m, to, reason) => {
            if (to === 'failed_reopened' && m.commitSentAt !== null) throw new ReverseMoveConflictError('illegal_transition');
            return cas(m, { state: to, lastError: reason }, `${to}:${reason}`);
        },
    };
    const answer = (op: Op, m: ComputeReverseMove, from?: number, count?: number): ReverseWorkerResult<unknown> => {
        calls.push(op === 'pull' ? `pull:${from}+${count}` : op);
        const scripted = opts.worker?.[op]?.(m, from, count);
        if (scripted) return scripted;
        if (op === 'pull') {
            if (count === 0) return ok({ export: { state: 'ready' }, head: { v: 1, moveId: MOVE, ...HEAD }, stored: [], next: 0 });
            const n = m.exportHead!.chunks.length, stored = Array.from({ length: Math.min(count!, n - from!) }, (_, k) => from! + k);
            return ok({ export: { state: 'ready' }, head: null, stored, next: null });
        }
        if (op === 'commit') return ok({ committed: true, store: 'r2' });
        return ok({ export: { state: 'capturing' } });
    };
    const ports: ReversePorts = {
        store,
        clock: () => now,
        killSwitchOn: () => opts.kill === true,
        paid: async () => opts.paid === true,
        openEpoch: async () => opts.epoch === true,
        async readPlacement() {
            if (opts.reserved) throw new ImageJobConflictError();
            return placement && { ...placement };
        },
        async claim(m, at) {
            calls.push('claim');
            if (opts.claim) return { admitted: false, reason: opts.claim };
            placement = { ...at, state: 'STARTING', generation: at.generation + 1, leaseEpoch: at.leaseEpoch + 1, instanceId: null, lifecycleJobId: JOB, lastError: null };
            return { admitted: true, move: await store.recordExportBoot(m, { ...BOOT, jobId: JOB }) };
        },
        async settleBoot(at) { calls.push('settleBoot'); if (opts.onSettle) placement = opts.onSettle(at); },
        async releaseBoot() {
            calls.push('releaseBoot');
            placement = { ...placement!, state: 'RETIRING', lastError: ENROLLMENT_HOST_RETIRE, lifecycleJobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
        },
        async retireHost() {
            calls.push('retireHost');
            placement = { ...placement!, state: 'RETIRING', lastError: ENROLLMENT_HOST_RETIRE, lifecycleJobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
        },
        worker: {
            begin: async m => { now += 1000; return answer('begin', m) as never; },
            pull: async (m, from, count) => { now += 1000; return answer('pull', m, from, count) as never; },
            verify: async m => { now += 1000; return answer('verify', m) as never; },
            commit: async m => { now += 1000; return answer('commit', m) as never; },
            abort: async m => { now += 1000; return answer('abort', m) as never; },
        },
        async toFlipping(m) { calls.push('toFlipping'); return opts.paidAtFlip ? 'paid' : store.advance(m, 'flipping'); },
        async flip(m, kind) {
            calls.push(`flip:${kind}`);
            if (opts.flipThrows) throw opts.flipThrows;
            placement = { ...placement!, provider: 'cloudflare', store: 'r2', generation: 1, leaseEpoch: 0 };
            return cas(m, { state: 'committed', awsVolumeId: m.exportBoot!.volumeId }, 'finish');
        },
        async afterCommit() { calls.push('afterCommit'); },
        async failSettled(m, to, reason) {
            calls.push(`failSettled:${reason}`);
            return reverseBootSettled(placement, m.exportBoot!) ? store.fail(m, to, reason) : null;
        },
        log: (event, fields) => { logs.push({ event, ...fields }); },
    };
    const deadline = () => opts.budgetMs ?? 90_000;
    return {
        ports, calls, logs, writes,
        get row() { return current; }, set row(m: ComputeReverseMove) { current = m; },
        get placement() { return placement; }, set placement(x: Placement | null) { placement = x; },
        age(ages: Partial<ComputeReverseMove['ages']>) { current = { ...current, ages: { ...current.ages, ...ages } }; },
        pass: () => advanceReverseMove(ports, current, now + deadline()),
    };
}

describe('the closed vocabulary (§5.5, §5.5.1)', () => {
    it('reopen_final is exactly the runbook operator_cleared list; the classes are disjoint', () => {
        const contract = readFileSync(path.resolve(__dirname, '../../../../../docs/compute/REVERSE-MOVE-CONTRACT.md'), 'utf8');
        const block = /-- runbook: operator_cleared[\s\S]*?last_error IN \(([\s\S]*?)\)/.exec(contract)![1]!;
        expect([...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort()).toEqual([...REVERSE_REOPEN_FINAL_CODES].sort());
        expect(reverseFailureClass('workspace_too_large')).toBe('reopen_after_session');
        expect(reverseFailureClass('boot_unavailable')).toBe('reopen');
        expect(reverseFailureClass('boot_unsettled')).toBe('operator');
        expect(reverseFailureClass('snapshot_failed')).toBeNull();
        expect(reverseFailureClass('unavailable')).toBeNull();
        expect(REVERSE_OPERATOR_CODES).toContain('abort_unconfirmed');
    });
    it('openBlocked: commit_sent_at, or already_imported / commit_in_progress / boot_unsettled; never abort_unconfirmed', () => {
        const nop = (lastError: string, commitSentAt: string | null = null) => ({ state: 'failed_needs_operator' as const, lastError, commitSentAt });
        expect(reverseOpenBlocked(nop('flip_stuck', 'sent'))).toBe(true);
        for (const code of ['already_imported', 'commit_in_progress', 'boot_unsettled']) expect(reverseOpenBlocked(nop(code)), code).toBe(true);
        expect(reverseOpenBlocked(nop('abort_unconfirmed'))).toBe(false);
        expect(reverseOpenBlocked({ state: 'failed_reopened', lastError: 'boot_unsettled', commitSentAt: null })).toBe(false);
    });
    it('the call fits are the Worker client\'s own timeouts (§4.1)', () => {
        expect(REVERSE_CALL_FIT_MS.begin).toBe(MIGRATE_ACTION_TIMEOUT_MS['import/begin']);
        expect(REVERSE_CALL_FIT_MS.pull).toBe(MIGRATE_ACTION_TIMEOUT_MS['import/pull']);
        expect(REVERSE_CALL_FIT_MS.commit).toBe(MIGRATE_ACTION_TIMEOUT_MS['import/commit']);
        expect(REVERSE_CALL_FIT_MS.abort).toBe(MIGRATE_ACTION_TIMEOUT_MS['import/abort']);
    });
});

describe('§5.5 Worker answers', () => {
    const u = { ok: false as const, error: 'unavailable' as const }, nf = { ok: false as const, error: 'not_found' as const };
    it.each([
        ['begin', u, { kind: 'retry', code: 'unavailable' }], ['begin', nf, { kind: 'retry', code: 'not_found' }],
        ['begin', conflict('container_running'), { kind: 'retry', code: 'container_running' }],
        ['begin', conflict('export_host_mismatch'), { kind: 'retry', code: 'export_host_mismatch' }],
        ['begin', conflict('head_moved'), { kind: 'fail', failure: 'reopen_final', code: 'head_moved' }],
        ['begin', conflict('system_head_moved'), { kind: 'fail', failure: 'reopen_final', code: 'system_head_moved' }],
        ['begin', conflict('export_refused'), { kind: 'fail', failure: 'reopen_final', code: 'export_refused' }],
        ['begin', conflict('other'), { kind: 'fail', failure: 'reopen_final', code: 'worker_conflict' }],
        ['begin', conflict('already_imported'), { kind: 'fail', failure: 'operator', code: 'already_imported' }],
        ['pull', conflict('import_not_started'), { kind: 'retry', code: 'import_not_started' }],
        ['pull', conflict('workspace_too_large'), { kind: 'fail', failure: 'reopen_after_session', code: 'workspace_too_large' }],
        ['pull', conflict('export_capture_failed'), { kind: 'fail', failure: 'reopen', code: 'export_failed' }],
        ['pull', conflict('export_desktop_stop_failed'), { kind: 'fail', failure: 'reopen', code: 'export_failed' }],
        ['pull', conflict('export_staging_space'), { kind: 'fail', failure: 'reopen', code: 'export_failed', anomaly: true }],
        ['pull', conflict('export_head_invalid'), { kind: 'fail', failure: 'reopen', code: 'export_failed', anomaly: true }],
        ['pull', conflict('export_workspace_missing'), { kind: 'fail', failure: 'reopen_final', code: 'workspace_missing' }],
        ['pull', conflict('chunk_mismatch'), { kind: 'fail', failure: 'reopen', code: 'import_corrupt' }],
        ['pull', conflict('prefix_mismatch'), { kind: 'fail', failure: 'reopen_final', code: 'prefix_mismatch' }],
        ['pull', conflict('other'), { kind: 'fail', failure: 'reopen_final', code: 'worker_conflict' }],
        ['verify', nf, { kind: 'retry', code: 'not_found' }],
        ['verify', conflict('not_verified'), { kind: 'fail', failure: 'reopen', code: 'import_corrupt' }],
        ['verify', conflict('import_not_started'), { kind: 'fail', failure: 'reopen', code: 'import_lost' }],
        ['verify', conflict('other'), { kind: 'fail', failure: 'reopen_final', code: 'worker_conflict' }],
        ['commit', u, { kind: 'retry', code: 'commit_unavailable' }], ['commit', conflict('other'), { kind: 'retry', code: 'commit_unavailable' }],
        ['commit', conflict('import_not_started'), { kind: 'retry', code: 'import_not_started' }],
        ['commit', conflict('system_head_moved'), { kind: 'retry', code: 'system_head_moved' }],
        ['commit', conflict('head_moved'), { kind: 'fail', failure: 'operator', code: 'import_head_moved' }],
        ['commit', conflict('store_unsupported'), { kind: 'fail', failure: 'operator', code: 'import_not_verified' }],
        ['abort', u, { kind: 'retry', code: 'unavailable' }],
        ['abort', conflict('commit_in_progress'), { kind: 'fail', failure: 'operator', code: 'commit_in_progress' }],
    ] as const)('%s %j → %j', (step, result, expected) => {
        expect(classifyWorkerFailure(step, result)).toEqual(expected);
    });
});

describe('§5.4 deadlines (DB clock, through ages)', () => {
    it('the budget is the sum of the deadlines, 13200 s; copying is 125 min', () => {
        expect(REVERSE_MOVE_BUDGET_SECONDS).toBe(13200);
        expect(REVERSE_DEADLINE_SECONDS.copying).toBe(7500);
    });
    it.each([
        ['booting', { stateEntered: 900 }, 'boot_timeout'], ['booting', { stateEntered: 899 }, null],
        ['exporting', { stateEntered: 1200 }, 'export_timeout'],
        ['copying', { stateEntered: 7500, lastChunk: 1 }, 'copy_timeout'], ['copying', { stateEntered: 700, lastChunk: 599 }, null],
        ['copying', { stateEntered: 700, lastChunk: 600 }, 'copy_stalled'], ['copying', { stateEntered: 600, lastChunk: null }, 'copy_stalled'],
        ['checking', { stateEntered: 1200 }, 'check_timeout'],
        ['flipping', { stateEntered: 99_999, commitSent: 1799 }, null], ['flipping', { stateEntered: 0, commitSent: 1800 }, 'flip_stuck'],
    ] as const)('%s with %j → %s', (state, ages, expected) => {
        const base: ComputeReverseMove['ages'] = { created: 0, stateEntered: 0, commitSent: null, lastChunk: null };
        expect(reverseDeadlineFailure({ state, ages: { ...base, ...ages } })).toBe(expected);
    });
});

describe('requested (§5.1.1, the deadline rule)', () => {
    it('claims a STOPPED held placement: requested → booting in the claim; the next step reads the boot', async () => {
        const w = world({}, held());
        const m = await w.pass();
        expect(m.state).toBe('booting');
        expect(w.calls[0]).toBe('claim');
        expect(w.writes).toEqual(['boot:-']);
    });
    it('the kill switch fails it as kill_switch (no claim, nothing to compensate)', async () => {
        const w = world({}, held(), { kill: true });
        expect(await w.pass()).toMatchObject({ state: 'failed_reopened', lastError: 'kill_switch' });
        expect(w.calls).toEqual([]);
    });
    it('a paid entitlement ends it as entitlement_paid', async () => {
        const w = world({}, held(), { paid: true });
        expect(await w.pass()).toMatchObject({ state: 'failed_reopened', lastError: 'entitlement_paid' });
    });
    it('a null or invalid region is region_missing (reopen_final, anomaly), before any claim', async () => {
        for (const region of [null, 'mumbai']) {
            const w = world({}, held({ region }));
            expect(await w.pass(), String(region)).toMatchObject({ state: 'failed_reopened', lastError: 'region_missing' });
            expect(w.calls).toEqual([]);
            expect(w.logs).toEqual([expect.objectContaining({ event: 'anomaly', code: 'region_missing' })]);
        }
    });
    it('not claimable (RUNNING, a job, an image reservation, an open epoch) waits with no write, then computer_busy at 600 s', async () => {
        const cases: [string, Placement, Parameters<typeof world>[2]][] = [
            ['running', held({ state: 'RUNNING' }), {}], ['job', held({ lifecycleJobId: JOB }), {}],
            ['reserved', held(), { reserved: true }], ['open epoch', held(), { epoch: true }],
        ];
        for (const [name, p, opts] of cases) {
            const w = world({}, p, opts);
            expect(await w.pass(), name).toMatchObject({ state: 'requested', attempts: 0, lastError: null });
            expect(w.writes, name).toEqual([]);
            w.age({ created: 600 });
            expect(await w.pass(), name).toMatchObject({ state: 'failed_reopened', lastError: 'computer_busy' });
            expect(w.calls, name).not.toContain('claim');
        }
    });
    it('an openEpoch read that fails counts as open (fail closed, §5.1.1): no claim, no write, then computer_busy at 600 s', async () => {
        // r7 integration (verifier mutant E18): `.catch(() => true)` is the fail-closed read; a refused read never claims.
        const w = world({}, held());
        let reads = 0;
        w.ports.openEpoch = async () => { reads++; throw new Error('billing store unavailable'); };
        expect(await w.pass()).toMatchObject({ state: 'requested', attempts: 0, lastError: null });
        expect(w.writes).toEqual([]);
        w.age({ created: 600 });
        expect(await w.pass()).toMatchObject({ state: 'failed_reopened', lastError: 'computer_busy' });
        expect(w.calls).not.toContain('claim');
        expect(reads).toBe(2);
    });
    it('a capacity, fleet or move-cap refusal waits (no retry count), then boot_unavailable (try later) at the deadline pass', async () => {
        for (const reason of ['max_running', 'region_capacity', 'global_hours_cap', 'move_capacity', 'cas_conflict', 'duplicate_placement', 'region_not_configured']) {
            const w = world({}, held(), { claim: reason });
            expect(await w.pass(), reason).toMatchObject({ state: 'requested', attempts: 0 });
            w.age({ created: 600 });
            expect(await w.pass(), reason).toMatchObject({ state: 'failed_reopened', lastError: 'boot_unavailable' });
            expect(w.logs.filter(l => l.code === reason).length, reason).toBe(['duplicate_placement', 'region_not_configured'].includes(reason) ? 2 : 0);
        }
    });
    it('admission try-later reasons are kill_switch; computer-specific refusals are boot_refused (final, anomaly)', async () => {
        for (const reason of ['aws_disabled', 'aws_config_invalid', 'kill_switch'])
            expect(await world({}, held(), { claim: reason }).pass(), reason).toMatchObject({ state: 'failed_reopened', lastError: 'kill_switch' });
        for (const reason of ['user_has_aws_computer', 'computer_not_owned', 'computer_deleted']) {
            const w = world({}, held(), { claim: reason });
            expect(await w.pass(), reason).toMatchObject({ state: 'failed_reopened', lastError: 'boot_refused' });
            expect(w.logs).toEqual([expect.objectContaining({ event: 'anomaly', code: 'boot_refused', admission: reason })]);
        }
        expect(await world({}, held(), { claim: 'region_missing' }).pass()).toMatchObject({ state: 'failed_reopened', lastError: 'region_missing' });
    });
    it('a claim that does not fit the pass is not attempted, and the deadline is not decided on that pass', async () => {
        const w = world({ ages: { created: 700, stateEntered: 700, commitSent: null, lastChunk: null } }, held(), { budgetMs: 10_000 });
        expect(await w.pass()).toMatchObject({ state: 'requested' });
        expect(w.calls).toEqual([]);
    });
});

describe('booting → exporting → copying → checking → flipping → committed', () => {
    it('one row, pass after pass, to committed: the claim, the receipts, the export, back-to-back pulls, verify, release, the flip', async () => {
        const w = world({}, held(), {
            onSettle: p => p.state === 'STARTING' ? { ...p, state: 'MOUNTING', lifecycleJobId: null, instanceId: I_NEW, lastError: ENROLLMENT_SUCCEEDED }
                : p.state === 'RETIRING' ? { ...p, state: 'STOPPED', lifecycleJobId: null, lastError: INSTANCE_LOST } : p,
        });
        // Pass 1: the claim, the boot's receipt (enrolled: the instance recorded on the same claim), the export (the host is
        // ready at once here), one pull of 64 (3 chunks), the verify, the host retire; the retire's receipt lands STOPPED.
        let m = await w.pass();
        expect(w.writes).toEqual(['boot:-', `boot:${I_NEW}`, 'advance:exporting', 'head', 'progress:0,1,2', 'advance:checking']);
        expect(m).toMatchObject({ state: 'checking', exportBoot: { instanceId: I_NEW, placementGeneration: 5, leaseEpoch: 8 }, exportHead: HEAD });
        expect(w.calls).toEqual(['claim', 'settleBoot', 'begin', 'pull:0+0', 'pull:0+64', 'verify', 'releaseBoot', 'settleBoot']);
        expect(w.placement).toMatchObject({ state: 'STOPPED', generation: 5, leaseEpoch: 8, lifecycleJobId: null });
        // Pass 2: transaction 1 (the point of no return), the commit, transaction 2, the paid catch-up.
        w.calls.length = 0;
        m = await w.pass();
        expect(m).toMatchObject({ state: 'committed', awsVolumeId: VOL });
        expect(w.calls).toEqual(['toFlipping', 'commit', 'flip:r2', 'afterCommit']);
        expect(w.placement).toMatchObject({ provider: 'cloudflare', generation: 1, leaseEpoch: 0 });
    });
    it('a boot that settled failed (UNCONFIRMED, or STOPPED by the undo at N) is boot_failed: compensated, then failed_reopened once settled', async () => {
        const w = world({ state: 'booting', exportBoot: BOOT }, bootAt({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED }), {
            onSettle: p => ({ ...p, state: 'STOPPED', lifecycleJobId: null, lastError: INSTANCE_LOST }),
        });
        let m = await w.pass();
        // Never reached exporting: no Worker abort; the host step retires the refused host.
        expect(w.writes).toEqual(['compensate:boot_failed:host']);
        expect(w.calls).toEqual(['retireHost']);
        expect(m).toMatchObject({ state: 'booting', lastError: 'compensate:boot_failed:host' });
        m = await w.pass();
        expect(w.calls).toEqual(['retireHost', 'settleBoot']);
        m = await w.pass();
        expect(m).toMatchObject({ state: 'failed_reopened', lastError: 'boot_failed' });
        expect(w.calls.at(-1)).toBe('failSettled:boot_failed');
        // A refused replace settled at generation N (E+1) counts as settled.
        const n = world({ state: 'booting', exportBoot: BOOT }, held({ leaseEpoch: 8, lastError: 'lifecycle_start_failed' }));
        expect(await n.pass()).toMatchObject({ state: 'failed_reopened', lastError: 'boot_failed' });
    });
    it('booting past 15 min is boot_timeout (state_entered_at of booting)', async () => {
        const w = world({ state: 'booting', exportBoot: BOOT, ages: { created: 9000, stateEntered: 900, commitSent: null, lastChunk: null } },
            bootAt({ state: 'MOUNTING', instanceId: I_NEW, lastError: 'enroll_tunnel_pending' }));
        const m = await w.pass();
        expect(m).toMatchObject({ state: 'booting', lastError: 'compensate:boot_timeout:host' });
        expect(w.calls).toContain('releaseBoot');
    });
    it('exporting: a capturing host waits with no write; past 20 min, export_timeout aborts the import first', async () => {
        const capturing = { pull: () => ok({ export: { state: 'capturing' }, head: null, stored: [], next: 0 }) };
        const w = world({ state: 'exporting', exportBoot: { ...BOOT, instanceId: I_NEW } }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }), { worker: capturing });
        expect(await w.pass()).toMatchObject({ state: 'exporting', lastError: null });
        expect(w.writes).toEqual([]);
        w.age({ stateEntered: 1200 });
        const m = await w.pass();
        expect(w.writes).toEqual(['compensate:export_timeout', 'compensate:export_timeout:host']);
        expect(w.calls).toEqual(['begin', 'pull:0+0', 'begin', 'pull:0+0', 'abort', 'releaseBoot']);
        expect(m.lastError).toBe('compensate:export_timeout:host');
    });
    it('an invalid head from the host (app-side check) is export_failed with an anomaly', async () => {
        const w = world({ state: 'exporting', exportBoot: { ...BOOT, instanceId: I_NEW } }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }),
            { worker: { pull: () => ok({ export: { state: 'ready' }, head: { v: 1, moveId: 'someone-else', ...HEAD }, stored: [], next: 0 }) } });
        await w.pass();
        expect(w.writes[0]).toBe('compensate:export_failed');
        expect(w.logs).toContainEqual(expect.objectContaining({ event: 'anomaly', code: 'export_head_invalid' }));
        expect(exportHeadFor({ id: MOVE, generation: GEN }, { v: 1, moveId: MOVE, ...HEAD })).toEqual(HEAD);
        expect(exportHeadFor({ id: MOVE, generation: GEN }, { v: 2, moveId: MOVE, ...HEAD })).toBeNull();
    });
    it('a Worker retry is recordRetry; five in a row (attempts 5) is <state>_retries, compensated', async () => {
        const w = world({ state: 'exporting', exportBoot: { ...BOOT, instanceId: I_NEW } }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }),
            { worker: { begin: () => ({ ok: false, error: 'unavailable' }) } });
        for (let i = 1; i <= 5; i++) expect(await w.pass()).toMatchObject({ state: 'exporting', attempts: i, lastError: 'unavailable' });
        await w.pass();
        expect(w.writes.at(-2)).toBe('compensate:exporting_retries');
    });
    it('copying: pulls back to back (count 64) until the budget, records progress, advances to checking when complete', async () => {
        const big = headOf([...Array(200).fill(EXPORT_CHUNK_BYTES), 9]);
        const w = world({ state: 'copying', exportBoot: { ...BOOT, instanceId: I_NEW }, exportHead: big }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }),
            { worker: { verify: () => ({ ok: false, error: 'unavailable' }) } });
        const m = await w.pass();
        expect(w.calls.slice(0, 4)).toEqual(['pull:0+64', 'pull:64+64', 'pull:128+64', 'pull:192+64']);
        expect(importComplete(m) || m.state === 'checking').toBe(true);
        expect(m.state).toBe('checking');
    });
    it('copying: a pull that does not fit the pass is never started (40 s)', async () => {
        const w = world({ state: 'copying', exportBoot: { ...BOOT, instanceId: I_NEW }, exportHead: HEAD }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }), { budgetMs: 39_999 });
        await w.pass();
        expect(w.calls).toEqual([]);
    });
    it('copying: no new chunk for 10 min is copy_stalled; import_not_started retries and the next pass begins again', async () => {
        const stuck = world({ state: 'copying', exportBoot: { ...BOOT, instanceId: I_NEW }, exportHead: HEAD,
            ages: { created: 0, stateEntered: 2000, commitSent: null, lastChunk: 600 } }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }),
        { worker: { pull: () => ok({ export: { state: 'ready' }, head: null, stored: [], next: 0 }) } });
        await stuck.pass();
        expect(stuck.writes[0]).toBe('compensate:copy_stalled');
        let lost = true;
        const w = world({ state: 'copying', exportBoot: { ...BOOT, instanceId: I_NEW }, exportHead: HEAD }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }),
            { worker: { pull: (_m, from, count) => lost ? (lost = false, conflict('import_not_started')) : ok({ export: { state: 'ready' }, head: null, stored: [from!, 1, 2].slice(0, count), next: null }),
                verify: () => ({ ok: false, error: 'unavailable' }) } });
        expect(await w.pass()).toMatchObject({ state: 'copying', lastError: 'import_not_started', attempts: 1 });
        await w.pass();
        expect(w.calls).toEqual(['pull:0+64', 'begin', 'pull:0+64', 'verify']);
    });
    it('r7 fixer (§5.5): copying import_not_started after a recorded chunk is import_lost (a fresh begin would clear the Worker\'s records)', async () => {
        const big = headOf([...Array(100).fill(EXPORT_CHUNK_BYTES), 9]);
        let pulls = 0;
        const w = world({ state: 'copying', exportBoot: { ...BOOT, instanceId: I_NEW }, exportHead: big }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }),
            { worker: { pull: (_m, from, count) => ++pulls === 1 ? ok({ export: { state: 'ready' }, head: null, stored: Array.from({ length: count! }, (_, k) => from! + k), next: 64 })
                : conflict('import_not_started') } });
        await w.pass();
        // Chunks 0-63 recorded, then the key is gone: never retried, never re-begun; compensation toward failed_reopened('import_lost').
        expect(w.writes.slice(0, 2)).toEqual([`progress:${Array.from({ length: 64 }, (_, k) => k).join(',')}`, 'compensate:import_lost']);
        expect(w.calls.slice(0, 2)).toEqual(['pull:0+64', 'pull:64+64']);
        expect(w.calls).not.toContain('begin');
        expect(w.writes).not.toContain('retry:import_not_started');
    });
    it('checking: verify, then the host retire; the flip waits for STOPPED at N+1/E+1; not_verified is import_corrupt', async () => {
        const w = world({ state: 'checking', exportBoot: { ...BOOT, instanceId: I_NEW }, exportHead: HEAD }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }));
        expect(await w.pass()).toMatchObject({ state: 'checking' });
        expect(w.calls).toEqual(['verify', 'releaseBoot', 'settleBoot']);
        w.placement = bootAt({ state: 'STOPPED', instanceId: I_NEW, lastError: INSTANCE_LOST });
        expect((await w.pass()).state).toBe('committed');
        const bad = world({ state: 'checking', exportBoot: { ...BOOT, instanceId: I_NEW }, exportHead: HEAD }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }),
            { worker: { verify: () => conflict('not_verified') } });
        await bad.pass();
        expect(bad.writes[0]).toBe('compensate:import_corrupt');
        const paid = world({ state: 'checking', exportBoot: { ...BOOT, instanceId: I_NEW }, exportHead: HEAD },
            bootAt({ state: 'STOPPED', instanceId: I_NEW, lastError: INSTANCE_LOST }), { paidAtFlip: true });
        const m = await paid.pass();
        expect(m).toMatchObject({ state: 'failed_reopened', lastError: 'entitlement_paid' });
        expect(paid.calls).toEqual(['toFlipping', 'abort', 'failSettled:entitlement_paid']);
    });
});

describe('flipping (§5.6): past the point of no return', () => {
    const flipping = (over: Partial<ComputeReverseMove> = {}) => ({ state: 'flipping' as ReverseMoveState, exportBoot: { ...BOOT, instanceId: I_NEW },
        exportHead: HEAD, commitSentAt: 'sent', ages: { created: 0, stateEntered: 0, commitSent: 10, lastChunk: null }, ...over });
    const stopped = () => bootAt({ state: 'STOPPED', instanceId: I_NEW, lastError: INSTANCE_LOST });
    it('retries the same commit, never exhausted, never reopened; flip_stuck at 30 min after commit_sent_at', async () => {
        const w = world(flipping({ attempts: 5 }), stopped(), { worker: { commit: () => ({ ok: false, error: 'unavailable' }) } });
        for (let i = 0; i < 3; i++) expect(await w.pass()).toMatchObject({ state: 'flipping', lastError: 'commit_unavailable', attempts: 5 });
        w.age({ commitSent: 1800 });
        expect(await w.pass()).toMatchObject({ state: 'failed_needs_operator', lastError: 'flip_stuck', commitSentAt: 'sent' });
        expect(w.calls).not.toContain('abort');
    });
    it('the commit\'s own operator codes; the paid catch-up runs after commit; a flip that throws retries the same commit', async () => {
        expect(await world(flipping(), stopped(), { worker: { commit: () => conflict('head_moved') } }).pass())
            .toMatchObject({ state: 'failed_needs_operator', lastError: 'import_head_moved' });
        expect(await world(flipping(), stopped(), { worker: { commit: () => conflict('not_verified') } }).pass())
            .toMatchObject({ state: 'failed_needs_operator', lastError: 'import_not_verified' });
        const w = world(flipping(), stopped(), { flipThrows: new Error('reverse_flip_source_mismatch') });
        expect(await w.pass()).toMatchObject({ state: 'flipping', lastError: 'commit_unavailable' });
        expect(w.logs).toContainEqual(expect.objectContaining({ event: 'error', step: 'flip' }));
    });
});

describe('compensation (§5.7)', () => {
    const copying = { state: 'copying' as ReverseMoveState, exportBoot: { ...BOOT, instanceId: I_NEW }, exportHead: HEAD };
    it('abort first; an abort still failing after 5 tries, with the host settled, is failed_needs_operator(abort_unconfirmed)', async () => {
        const w = world({ ...copying, lastError: 'compensate:import_corrupt' }, bootAt({ state: 'STOPPED', instanceId: I_NEW, lastError: INSTANCE_LOST }),
            { worker: { abort: () => ({ ok: false, error: 'unavailable' }) } });
        for (let i = 1; i <= 5; i++) expect(await w.pass()).toMatchObject({ state: 'copying', attempts: i, lastError: 'compensate:import_corrupt' });
        const m = await w.pass();
        expect(m).toMatchObject({ state: 'failed_needs_operator', lastError: 'abort_unconfirmed' });
        expect(w.writes.slice(-2)).toEqual(['compensate:import_corrupt:unconfirmed', 'failed_needs_operator:abort_unconfirmed']);
    });
    it('a host that never settles is boot_unsettled at the state\'s deadline + 30 min, with or without the abort', async () => {
        for (const lastError of ['compensate:copy_stalled:host', 'compensate:copy_stalled:unconfirmed', 'compensate:copy_stalled']) {
            const w = world({ ...copying, lastError, ages: { created: 0, stateEntered: 7500 + 1800, commitSent: null, lastChunk: 0 } },
                bootAt({ state: 'UNCONFIRMED', instanceId: I_NEW, lastError: 'receipt_conflict' }));
            expect(await w.pass(), lastError).toMatchObject({ state: 'failed_needs_operator', lastError: 'boot_unsettled' });
            expect(w.calls, lastError).not.toContain('abort');
        }
        const early = world({ ...copying, lastError: 'compensate:copy_stalled:host', ages: { created: 0, stateEntered: 7500 + 1799, commitSent: null, lastChunk: 0 } },
            bootAt({ state: 'UNCONFIRMED', instanceId: I_NEW, lastError: 'receipt_conflict' }));
        expect(await early.pass()).toMatchObject({ state: 'copying', lastError: 'compensate:copy_stalled:host' });
    });
    it('the abort\'s already_imported / commit_in_progress are operator codes at once', async () => {
        const w = world({ ...copying, lastError: 'compensate:copy_stalled' }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }),
            { worker: { abort: () => conflict('commit_in_progress') } });
        expect(await w.pass()).toMatchObject({ state: 'failed_needs_operator', lastError: 'commit_in_progress' });
    });
    it('the decision survives passes: an aborted import is never begun again, and the host step releases a MOUNTING boot', async () => {
        const w = world({ ...copying, lastError: 'compensate:workspace_too_large' }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }));
        await w.pass();
        expect(w.calls).toEqual(['abort', 'releaseBoot']);
        w.calls.length = 0;
        await w.pass();
        expect(w.calls).toEqual(['settleBoot']);
        w.placement = bootAt({ state: 'STOPPED', instanceId: I_NEW, lastError: INSTANCE_LOST });
        expect(await w.pass()).toMatchObject({ state: 'failed_reopened', lastError: 'workspace_too_large' });
        expect(w.calls).not.toContain('begin');
        expect(reverseCompensation({ state: 'copying', lastError: 'compensate:unknown_code' })).toBeNull();
    });
    it('settled = STOPPED, no job, the volume, epoch ≥ E+1, generation N or N+1', () => {
        expect(reverseBootSettled(bootAt({ state: 'STOPPED' }), BOOT)).toBe(true);
        expect(reverseBootSettled(held({ leaseEpoch: 8 }), BOOT)).toBe(true);
        expect(reverseBootSettled(held(), BOOT)).toBe(false);
        expect(reverseBootSettled(bootAt({ state: 'STOPPED', lifecycleJobId: JOB }), BOOT)).toBe(false);
        expect(reverseBootSettled(bootAt({ state: 'STOPPED', volumeId: 'vol-22222222222222222' }), BOOT)).toBe(false);
        expect(reverseBootSettled(bootAt({ state: 'RETIRING' }), BOOT)).toBe(false);
        expect(reverseBootSettled(bootAt({ state: 'STOPPED', generation: 3 }), BOOT)).toBe(false);
    });
});

describe('the row\'s pass', () => {
    it('a lost compare-and-swap ends the row\'s pass without throwing', async () => {
        const w = world({}, held());
        w.ports.claim = async () => { throw new ReverseMoveConflictError('lost_race'); };
        expect(await w.pass()).toMatchObject({ state: 'requested' });
    });
});

/**
 * 🔴 Only the driver bounds a move (§5.4). A step that throws on every pass (an unreadable placement row, a claim whose
 * intent the deployment refuses, a Worker call that throws) must still end at its state's deadline; before it, the throw
 * goes to the sweep (errors++) and nothing is written.
 */
describe('a step that throws still meets its deadline (§5.4)', () => {
    const integrity = () => new PlacementIntegrityError('duplicate_placement', C);
    it('requested: a claim that throws waits with no write, logged; the deadline pass ends it boot_unavailable (claim attempted)', async () => {
        const w = world({}, held());
        w.ports.claim = async () => { throw new Error('connection reset'); };
        expect(await w.pass()).toMatchObject({ state: 'requested', attempts: 0, lastError: null });
        expect(w.writes).toEqual([]);
        expect(w.logs).toEqual([expect.objectContaining({ event: 'error', step: 'claim', error: 'connection reset' })]);
        w.age({ created: 600 });
        expect(await w.pass()).toMatchObject({ state: 'failed_reopened', lastError: 'boot_unavailable' });
        expect(w.writes).toEqual(['failed_reopened:boot_unavailable']);
    });
    it('requested: an intent the deployment refuses, or an incomplete placement, waits with an anomaly line, then boot_unavailable', async () => {
        for (const reason of ['intent_invalid', 'placement_incomplete']) {
            const w = world({}, held(), { claim: reason });
            expect(await w.pass(), reason).toMatchObject({ state: 'requested', attempts: 0, lastError: null });
            expect(w.writes, reason).toEqual([]);
            expect(w.logs, reason).toEqual([expect.objectContaining({ event: 'anomaly', code: reason })]);
            w.age({ created: 600 });
            expect(await w.pass(), reason).toMatchObject({ state: 'failed_reopened', lastError: 'boot_unavailable' });
        }
    });
    it('requested: a placement read that throws (not an image reservation) is not claimable: no claim, then computer_busy at 600 s', async () => {
        const w = world({}, held());
        w.ports.readPlacement = async () => { throw integrity(); };
        expect(await w.pass()).toMatchObject({ state: 'requested', lastError: null });
        expect(w.calls).not.toContain('claim');
        expect(w.logs).toEqual([expect.objectContaining({ event: 'error', step: 'placement', error: 'placement_integrity:duplicate_placement' })]);
        w.age({ created: 600 });
        expect(await w.pass()).toMatchObject({ state: 'failed_reopened', lastError: 'computer_busy' });
    });
    it('booting: every read throws; before 15 min the pass throws with no write; past it boot_timeout compensates; past + 30 min boot_unsettled', async () => {
        const w = world({ state: 'booting', exportBoot: BOOT, ages: { created: 9000, stateEntered: 899, commitSent: null, lastChunk: null } },
            bootAt({ state: 'MOUNTING', instanceId: I_NEW }));
        w.ports.readPlacement = async () => { throw integrity(); };
        await expect(w.pass()).rejects.toThrow('placement_integrity:duplicate_placement');
        expect(w.writes).toEqual([]);
        w.age({ stateEntered: 900 });
        expect(await w.pass()).toMatchObject({ state: 'booting', lastError: 'compensate:boot_timeout:host' });
        expect(w.logs).toContainEqual(expect.objectContaining({ event: 'error', step: 'deadline', to: 'booting' }));
        // The compensation reads the placement too: it throws until the bound, then the operator code (open blocked).
        w.age({ stateEntered: 900 + 1799 });
        await expect(w.pass()).rejects.toThrow('placement_integrity');
        w.age({ stateEntered: 900 + 1800 });
        expect(await w.pass()).toMatchObject({ state: 'failed_needs_operator', lastError: 'boot_unsettled' });
        expect(w.writes).toEqual(['compensate:boot_timeout:host', 'failed_needs_operator:boot_unsettled']);
    });
    it('copying: a pull that throws past the copy deadline aborts the import first (compensation), like any deadline', async () => {
        const w = world({ state: 'copying', exportBoot: { ...BOOT, instanceId: I_NEW }, exportHead: HEAD,
            ages: { created: 0, stateEntered: 7500, commitSent: null, lastChunk: 1 } }, bootAt({ state: 'MOUNTING', instanceId: I_NEW }),
        { worker: { pull: () => { throw new Error('fetch failed'); } } });
        expect(await w.pass()).toMatchObject({ state: 'copying', lastError: 'compensate:copy_timeout' });
    });
    it('flipping: a commit that throws is never reopened; flip_stuck at 30 min after commit_sent_at', async () => {
        const w = world({ state: 'flipping', exportBoot: { ...BOOT, instanceId: I_NEW }, exportHead: HEAD, commitSentAt: 'sent',
            ages: { created: 0, stateEntered: 0, commitSent: 1799, lastChunk: null } }, bootAt({ state: 'STOPPED', instanceId: I_NEW, lastError: INSTANCE_LOST }),
        { worker: { commit: () => { throw new Error('fetch failed'); } } });
        await expect(w.pass()).rejects.toThrow('fetch failed');
        w.age({ commitSent: 1800 });
        expect(await w.pass()).toMatchObject({ state: 'failed_needs_operator', lastError: 'flip_stuck', commitSentAt: 'sent' });
        expect(w.calls).not.toContain('abort');
    });
    it('a deadline write that loses its race hands the original error to the sweep', async () => {
        const w = world({ state: 'booting', exportBoot: BOOT, ages: { created: 9000, stateEntered: 900, commitSent: null, lastChunk: null } }, null);
        w.ports.readPlacement = async () => { throw integrity(); };
        w.ports.store.recordCompensation = async () => { throw new ReverseMoveConflictError('lost_race'); };
        await expect(w.pass()).rejects.toThrow('placement_integrity');
    });
});

describe('sweepReverseMoves (§5.4, §7.2)', () => {
    const base = () => {
        const order: string[] = [];
        const lines: Record<string, unknown>[] = [];
        return { order, lines, input: {
            handlerStartedAt: 1_000, clock: () => 41_000,
            tablePresent: async () => { order.push('probe'); return true; },
            snapshots: async (i: { deadlineMs: number }) => { order.push(`snapshot:${i.deadlineMs}`); return { status: 'held' }; },
            claimStale: async (limit: number) => { order.push(`claim:${limit}`); return [row({ id: 'a' }), row({ id: 'b', state: 'copying' })]; },
            drive: async (m: ComputeReverseMove, deadlineMs: number) => { order.push(`drive:${m.id}:${deadlineMs}`); return m; },
            log: (_line: string, fields: Record<string, unknown>) => { lines.push(fields); },
        } };
    };
    it('snapshot step first (20 s), then claimStale(10), rows driven against start + 90 s; one line with the start offset', async () => {
        const t = base();
        const summary = await sweepReverseMoves(t.input);
        expect(t.order).toEqual(['probe', 'snapshot:61000', 'claim:10', 'drive:a:131000', 'drive:b:131000']);
        expect(summary).toEqual({ startOffsetMs: 40_000, snapshot: 'held', claimed: 2, states: { requested: 1, copying: 1 }, errors: 0 });
        expect(t.lines).toEqual([summary]);
    });
    it('nothing after handler start + 150 s, nothing without 0012, and nothing ever throws', async () => {
        const late = base();
        expect(await sweepReverseMoves({ ...late.input, clock: () => 151_001 })).toBeNull();
        expect(late.order).toEqual([]);
        const bare = base();
        expect(await sweepReverseMoves({ ...bare.input, tablePresent: async () => false })).toBeNull();
        expect(bare.order).toEqual([]);
        const broken = base();
        expect(await sweepReverseMoves({ ...broken.input, claimStale: async () => { throw new Error('db down'); } })).toBeNull();
        const failing = base();
        const summary = await sweepReverseMoves({ ...failing.input, snapshots: async () => { throw new Error('x'); },
            drive: async m => { if (m.id === 'a') throw new Error('boom'); return m; } });
        expect(summary).toMatchObject({ snapshot: 'error', errors: 1, states: { copying: 1 } });
    });
});
