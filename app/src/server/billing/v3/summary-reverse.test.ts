/**
 * Phase B (docs/compute/REVERSE-MOVE-CONTRACT.md §6.1, §6.1.1): `summary.computer.reverseMove`, `moveOnOpen` and
 * `moveAvailable` from the pure builder input, and the router's move computer (`reverseMoveSummaryInput`).
 * `computer.move` stays null in every case: an old cached shell renders it with a [Try again] that opens the computer.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn() }));
vi.mock('@/server/auth/auth0', () => ({ auth0Enabled: () => false }));

import { readBillingConfig } from '../config';
import { HOLD_SIZE } from './admission';
import { buildSummaryV3, reverseMoveFields, type ReverseMoveSummaryInput } from './summary';
import { meteredSizeForInstanceType } from '@/server/lib/compute/aws-config';
import { reverseFounderOwned, reverseIso, reverseMoveRetry, type ReverseMovePlacementView } from '@/server/lib/compute/provider-reverse';
import type { ComputeReverseMove, ReverseMoveState } from '@/server/lib/compute/provider-reverse-store';
import { reverseMoveSummaryInput, type UserPlacement } from '@/server/api/routers/billing';

const now = new Date('2026-10-30T12:00:00Z');
type Input = Parameters<typeof buildSummaryV3>[0];
const base = (): Input => ({ config: readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture' }), now, userCreatedAt: null,
    subs: [], epochs: [], grants: [], consent: null, planChanges: [], paymentIssues: [], storage: [], sizePreference: null, hasCustomer: false,
    placementProvider: 'aws-ec2' });
const paidSub = { sku: 'standard_monthly_v3' as const, stripeSubscriptionId: 'sub', status: 'active', currentPeriodStart: new Date('2026-10-10T00:00:00Z'),
    currentPeriodEnd: new Date('2026-11-10T00:00:00Z'), cancelAtPeriodEnd: false };

const U = '11111111-1111-4111-8111-111111111111';
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', C2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', C3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const boot = { placementGeneration: 8, leaseEpoch: 12, region: 'ap-south-1', volumeId: 'vol-0123456789abcdef0', jobId: null, instanceId: null,
    fsUuid: null, claimedAt: '2026-10-30T10:00:00.000Z' };
const move = (over: Partial<ComputeReverseMove> = {}): ComputeReverseMove => ({
    id: '33333333-3333-4333-8333-333333333333', userId: U, computerId: C1, startedBy: 'user', state: 'copying', generation: 'g',
    exportBoot: boot, exportHead: null, importProgress: null, bytesTotal: null, skipped: null, awsVolumeId: null, awsFsUuid: null,
    awsSnapshotId: null, retainUntil: null, attempts: 0, lastError: null, stateEnteredAt: '2026-10-30 10:00:00+00', commitSentAt: null,
    createdAt: '2026-10-30 09:59:00+00', updatedAt: '2026-10-30 10:00:01.123456+00',
    ages: { created: 60, stateEntered: 30, commitSent: null, lastChunk: null }, ...over,
});
const aws = (over: Partial<ReverseMovePlacementView> = {}): ReverseMovePlacementView =>
    ({ provider: 'aws-ec2', state: 'STOPPED', leaseEpoch: 12, lifecycleJobId: null, instanceType: 'm6i.large', ...over });
const rm = (over: Partial<ReverseMoveSummaryInput> = {}): ReverseMoveSummaryInput =>
    ({ tablePresent: true, row: null, placement: aws(), awsEnabled: true, killSwitchOn: false, founderOwned: false, ...over });
const computer = (input: Partial<Input> = {}) => buildSummaryV3({ ...base(), ...input }).computer;

describe('summary.computer.reverseMove (§6.1)', () => {
    it('omitted input is today\'s output exactly (no new key); computer.move is null', () => {
        const today = computer();
        expect(today).not.toHaveProperty('reverseMove');
        expect(today).not.toHaveProperty('moveOnOpen');
        expect(today).not.toHaveProperty('moveAvailable');
        expect(today.move).toBeNull();
        expect(computer({ reverseMove: rm({ tablePresent: false, row: move() }) })).toMatchObject({ reverseMove: null, moveOnOpen: false, moveAvailable: false, move: null });
    });
    it.each([['requested', 'saving'], ['booting', 'saving'], ['exporting', 'saving'], ['copying', 'copying'], ['checking', 'checking'], ['flipping', 'flipping']] as const)(
        'in flight %s → stage %s, no reason, no retry; computer.move stays null', (state, stage) => {
            const c = computer({ reverseMove: rm({ row: move({ state, lastError: 'compensate:copy_stalled' }) }) });
            expect(c.reverseMove).toEqual({ direction: 'to_cloudflare', stage, bytesDone: '0', bytesTotal: null, reason: null, skipped: null,
                retainUntil: null, retry: null, openBlocked: false, holdOpenable: true });
            expect(c.move).toBeNull();
        });
    it('copying carries decimal bytes and the head\'s skipped count', () => {
        const row = move({ bytesTotal: 536_870_912, skipped: 3, exportHead: { generation: 'g' } as never,
            importProgress: { bitmap: '0'.repeat(128), bytes: 1_048_576, archiveSha256: 'a'.repeat(64), first: 'x', last: 'y' } });
        expect(computer({ reverseMove: rm({ row }) }).reverseMove).toMatchObject({ bytesDone: '1048576', bytesTotal: '536870912', skipped: 3 });
    });
    it('a committed row: retainUntil ISO, reason null even with a spent snapshot reason, holdOpenable null, retry null', () => {
        const row = move({ state: 'committed', lastError: 'snapshot_failed', retainUntil: new Date('2026-11-13T10:00:00Z'), commitSentAt: '2026-10-30 10:30:00+00' });
        expect(computer({ placementProvider: 'cloudflare', reverseMove: rm({ row, placement: { provider: 'cloudflare', state: null, leaseEpoch: null,
            lifecycleJobId: null, instanceType: null } }) }).reverseMove).toEqual({ direction: 'to_cloudflare', stage: 'committed', bytesDone: '0', bytesTotal: null,
            reason: null, skipped: null, retainUntil: '2026-11-13T10:00:00.000Z', retry: null, openBlocked: false, holdOpenable: null });
    });
    it('24 h visibility on the DB clock: an ended row older than a day is null; a failed_needs_operator row is always shown', () => {
        expect(computer({ reverseMove: rm({ row: move({ state: 'failed_reopened', lastError: 'copy_stalled', ages: { created: 9e4, stateEntered: 86_399, commitSent: null, lastChunk: null } }) }) }).reverseMove).not.toBeNull();
        expect(computer({ reverseMove: rm({ row: move({ state: 'failed_reopened', lastError: 'copy_stalled', ages: { created: 9e4, stateEntered: 86_400, commitSent: null, lastChunk: null } }) }) }).reverseMove).toBeNull();
        expect(computer({ reverseMove: rm({ row: move({ state: 'failed_needs_operator', lastError: 'abort_unconfirmed', ages: { created: 9e6, stateEntered: 9e6, commitSent: null, lastChunk: null } }) }) }).reverseMove)
            .toMatchObject({ stage: 'failed_needs_operator', reason: 'abort_unconfirmed', retry: 'no', openBlocked: false });
    });
    it('openBlocked: commit sent, or already_imported / commit_in_progress / boot_unsettled', () => {
        for (const [over, blocked] of [[{ lastError: 'boot_unsettled' }, true], [{ lastError: 'already_imported' }, true], [{ lastError: 'commit_in_progress' }, true],
            [{ lastError: 'flip_stuck', commitSentAt: '2026-10-30 11:00:00+00' }, true], [{ lastError: 'abort_unconfirmed' }, false]] as const) {
            expect(computer({ reverseMove: rm({ row: move({ state: 'failed_needs_operator', ...over }) }) }).reverseMove?.openBlocked, JSON.stringify(over)).toBe(blocked);
        }
    });
});

describe('retry and holdOpenable (§6.1.1, r5)', () => {
    it.each(['m6i.large', 'm6i.xlarge', 'm6i.2xlarge'])('holdOpenable is 6a\'s held-closed test for %s: holdOpenable === (awsSize === HOLD_SIZE)', type => {
        const size = meteredSizeForInstanceType(type)!;
        const c = computer({ awsSize: size, reverseMove: rm({ row: move(), placement: aws({ instanceType: type }) }) });
        expect(c.reverseMove!.holdOpenable).toBe(c.awsSize!.size === HOLD_SIZE);
        expect(c.reverseMove!.holdOpenable).toBe(type === 'm6i.large');
    });
    it('reopen → now; entitlement_paid → no; operator_cleared → now; reopen_final → no; failed_needs_operator → no', () => {
        const r = (lastError: string, state: ReverseMoveState = 'failed_reopened') => reverseMoveRetry(move({ state, lastError }), aws());
        expect(r('copy_stalled')).toBe('now');
        expect(r('boot_unavailable')).toBe('now');
        expect(r('entitlement_paid')).toBe('no');
        expect(r('operator_cleared')).toBe('now');
        expect(r('head_moved')).toBe('no');
        expect(r('region_missing')).toBe('no');
        expect(r('abort_unconfirmed', 'failed_needs_operator')).toBe('no');
        expect(reverseMoveRetry(move({ state: 'committed' }), aws())).toBeNull();
    });
    it('workspace_too_large: after_aws_session → now once the lease epoch passes the export boot\'s; never on a computer the hold cannot open', () => {
        const row = move({ state: 'failed_reopened', lastError: 'workspace_too_large' });
        expect(reverseMoveRetry(row, aws({ leaseEpoch: 12 }))).toBe('after_aws_session');
        expect(reverseMoveRetry(row, aws({ leaseEpoch: 13 }))).toBe('now');
        expect(reverseMoveRetry(row, aws({ leaseEpoch: 12, instanceType: 'm6i.xlarge' }))).toBe('no');
        // The summary agrees, and moveAvailable follows (start would answer move_unavailable).
        expect(computer({ reverseMove: rm({ row, placement: aws({ instanceType: 'm6i.xlarge' }) }) })).toMatchObject({ reverseMove: { retry: 'no', holdOpenable: false }, moveAvailable: false });
        expect(computer({ reverseMove: rm({ row, placement: aws({ leaseEpoch: 13 }) }) })).toMatchObject({ reverseMove: { retry: 'now' }, moveAvailable: true });
    });
});

describe('moveOnOpen and moveAvailable (§6.1.1)', () => {
    it('a held computer with no row: both true; founder-owned only turns moveOnOpen off', () => {
        expect(computer({ reverseMove: rm() })).toMatchObject({ reverseMove: null, moveOnOpen: true, moveAvailable: true });
        expect(computer({ reverseMove: rm({ founderOwned: true }) })).toMatchObject({ moveOnOpen: false, moveAvailable: true });
    });
    it.each([['m6i.xlarge (cmp-4)', 'm6i.xlarge'], ['m6i.2xlarge (cmp-8)', 'm6i.2xlarge'], ['an unknown size', null]] as const)(
        'r7 fixer: a held-closed computer, %s: moveOnOpen false (the open trigger never fires for it), the click still offered', (_name, instanceType) => {
            expect(computer({ reverseMove: rm({ placement: aws({ instanceType }) }) })).toMatchObject({ moveOnOpen: false, moveAvailable: true });
        });
    it('the kill switch, AWS disabled, a paid standing or a Cloudflare placement: neither', () => {
        for (const over of [{ killSwitchOn: true }, { awsEnabled: false }] as const) {
            expect(computer({ reverseMove: rm(over) }), JSON.stringify(over)).toMatchObject({ moveOnOpen: false, moveAvailable: false });
        }
        expect(computer({ subs: [paidSub], reverseMove: rm() })).toMatchObject({ moveOnOpen: false, moveAvailable: false });
        expect(computer({ placementProvider: 'cloudflare', reverseMove: rm({ placement: null }) })).toMatchObject({ moveOnOpen: false, moveAvailable: false });
    });
    it('after a failure only a click starts a move: moveOnOpen false; an uncleared reopen_final also turns moveAvailable off', () => {
        expect(computer({ reverseMove: rm({ row: move({ state: 'failed_reopened', lastError: 'copy_stalled' }) }) })).toMatchObject({ moveOnOpen: false, moveAvailable: true });
        expect(computer({ reverseMove: rm({ row: move({ state: 'failed_reopened', lastError: 'boot_refused' }) }) })).toMatchObject({ moveOnOpen: false, moveAvailable: false });
        expect(computer({ reverseMove: rm({ row: move({ state: 'failed_reopened', lastError: 'operator_cleared' }) }) })).toMatchObject({ moveAvailable: true });
    });
    it('a holding row: moveOnOpen false (the move is already on), and a committed newest row does not block a new one', () => {
        expect(computer({ reverseMove: rm({ row: move({ state: 'booting' }) }) })).toMatchObject({ moveOnOpen: false });
        expect(computer({ reverseMove: rm({ row: move({ state: 'committed', ages: { created: 9e5, stateEntered: 9e5, commitSent: 9e5, lastChunk: null } }) }) }))
            .toMatchObject({ reverseMove: null, moveOnOpen: true, moveAvailable: true });
    });
    it('reverseMoveFields: omitted → no key; no 0012 → null/false', () => {
        expect(reverseMoveFields(undefined, 'files_on_aws')).toEqual({});
        expect(reverseMoveFields(rm({ tablePresent: false }), 'files_on_aws')).toEqual({ reverseMove: null, moveOnOpen: false, moveAvailable: false });
    });
});

describe('the founder-owned rule (§5.9.1): fail-closed, exact domain', () => {
    const operator = (email: string) => email === 'ops@example.com';
    it.each([
        ['founder@ezil.work', true], ['contact@EZIL.WORK', true], [' someone@ezil.work ', true], ['ops@example.com', true],
        ['', true], [null, true], [undefined, true], ['no-at-sign', true], ['user@', true],
        ['person@example.com', false], ['x@notezil.work', false], ['x@ezil.work.example.com', false],
    ] as const)('%s → %s', async (email, expected) => {
        expect(await reverseFounderOwned(email, operator)).toBe(expected);
    });
    it('an operator check that throws counts as founder-owned', async () => {
        expect(await reverseFounderOwned('person@example.com', () => { throw new Error('env'); })).toBe(true);
    });
});

describe('reverseIso: PostgreSQL ::text and ISO both read as ISO 8601', () => {
    it.each([['2026-10-30 07:49:50.123456+00', '2026-10-30T07:49:50.123Z'], ['2026-10-30T07:49:50.123456+00', '2026-10-30T07:49:50.123Z'],
        ['2026-10-30 13:19:50+05:30', '2026-10-30T07:49:50.000Z'], ['2026-10-30T07:49:50+00:00', '2026-10-30T07:49:50.000Z'], ['garbage', null], [null, null]] as const)(
        '%s → %s', (text, iso) => { expect(reverseIso(text)).toBe(iso); });
});

describe('the summary\'s move computer (billing.ts reverseMoveSummaryInput, §6.1.1)', () => {
    const view = (instanceType = 'm6i.large'): ReverseMovePlacementView => aws({ instanceType });
    const cf: ReverseMovePlacementView = { provider: 'cloudflare', state: null, leaseEpoch: null, lifecycleJobId: null, instanceType: null };
    /** A DbReader answering the 0012 probe and `readByComputer` from per-computer newest rows (store COLUMNS shape). */
    const reader = (newest: Record<string, Record<string, unknown> | null>, present = true) => ({ execute: async (q: unknown) => {
        const { PgDialect } = await import('drizzle-orm/pg-core');
        const { sql: text, params } = new PgDialect().sqlToQuery(q as never);
        if (text.includes('to_regclass')) return [{ present }];
        if (!present) throw new Error('no 0012');
        const row = newest[String(params[0])];
        return row ? [row] : [];
    } });
    const rowOf = (computerId: string, state: string, stateEntered = 30, over: Record<string, unknown> = {}) => ({ id: `${computerId.slice(0, 8)}-3333-4333-8333-333333333333`,
        user_id: U, computer_id: computerId, started_by: 'user', state, generation: 'g', export_boot: boot, attempts: 0, last_error: null,
        state_entered_at: '2026-10-30 10:00:00+00', commit_sent_at: null, created_at: '2026-10-30 09:00:00+00', updated_at: '2026-10-30 10:00:00+00',
        age_created: 100, age_state_entered: stateEntered, ...over });
    const placement = (computers: UserPlacement['computers']): UserPlacement => ({ provider: 'aws-ec2', awsVolumes: [], computers });
    const user = { id: U, email: 'person@example.com' };
    const notOperator = () => false;
    const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_KILL_SWITCH: '0', AWS_REGIONS: 'ap-south-1', AWS_MAX_RUNNING: '10',
        EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '10', EZIL_AWS_USER_MONTHLY_HOURS: '100', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
        EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200' };

    it('1. the computer whose newest row holds wins over the aws-ec2 computer and a newer terminal row', async () => {
        const input = await reverseMoveSummaryInput(reader({ [C1]: rowOf(C1, 'committed', 10), [C2]: rowOf(C2, 'copying'), [C3]: null }) as never,
            placement([{ computerId: C1, provider: 'cloudflare', placement: cf }, { computerId: C2, provider: 'aws-ec2', placement: view() },
                { computerId: C3, provider: 'aws-ec2', placement: view('m6i.xlarge') }]), user, notOperator, env);
        expect(input).toMatchObject({ tablePresent: true, row: { computerId: C2, state: 'copying' }, placement: view(), awsEnabled: true, killSwitchOn: false, founderOwned: false });
    });
    it('2. else the aws-ec2 computer (the lowest id), with its own newest row', async () => {
        const input = await reverseMoveSummaryInput(reader({ [C3]: rowOf(C3, 'failed_reopened', 50, { last_error: 'copy_stalled' }), [C2]: null }) as never,
            placement([{ computerId: C3, provider: 'aws-ec2', placement: view('m6i.xlarge') }, { computerId: C2, provider: 'aws-ec2', placement: view() }]), user, notOperator, env);
        expect(input).toMatchObject({ row: null, placement: view() });
    });
    it('3. else the newest visible terminal row (after a commit the placement is Cloudflare); 4. else none', async () => {
        const input = await reverseMoveSummaryInput(reader({ [C1]: rowOf(C1, 'committed', 500), [C2]: rowOf(C2, 'committed', 20), [C3]: rowOf(C3, 'committed', 90_000) }) as never,
            placement([{ computerId: C1, provider: 'cloudflare', placement: cf }, { computerId: C2, provider: 'cloudflare', placement: cf },
                { computerId: C3, provider: 'cloudflare', placement: cf }]), user, notOperator, env);
        expect(input).toMatchObject({ row: { computerId: C2, state: 'committed' }, placement: cf });
        const none = await reverseMoveSummaryInput(reader({ [C1]: rowOf(C1, 'committed', 90_000) }) as never,
            placement([{ computerId: C1, provider: 'cloudflare', placement: cf }]), user, notOperator, env);
        expect(none).toMatchObject({ tablePresent: true, row: null, placement: null });
        // Placement reads off: no computer ids, so no move computer.
        expect(await reverseMoveSummaryInput(reader({}) as never, { provider: null, awsVolumes: [], computers: [] }, user, notOperator, env))
            .toMatchObject({ tablePresent: true, row: null, placement: null });
    });
    it('another owner\'s row on a live computer is ignored; a deleted computer is not in the live list at all', async () => {
        const input = await reverseMoveSummaryInput(reader({ [C2]: rowOf(C2, 'copying', 30, { user_id: '22222222-2222-4222-8222-222222222222' }) }) as never,
            placement([{ computerId: C2, provider: 'aws-ec2', placement: view() }]), user, notOperator, env);
        expect(input).toMatchObject({ row: null, placement: view() });
    });
    it('no 0012, an injected placement double without computers, or a failed read → undefined (today\'s summary)', async () => {
        expect(await reverseMoveSummaryInput(reader({}, false) as never, placement([{ computerId: C1, provider: 'aws-ec2', placement: view() }]), user, notOperator, env)).toBeUndefined();
        expect(await reverseMoveSummaryInput(reader({}) as never, { provider: 'aws-ec2', awsVolumes: [] }, user, notOperator, env)).toBeUndefined();
        const failing = { execute: async () => { throw new Error('down'); } };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await reverseMoveSummaryInput(failing as never, placement([{ computerId: C1, provider: 'aws-ec2', placement: view() }]), user, notOperator, env)).toBeUndefined();
        expect(warn).toHaveBeenCalledWith('[billing.summary] reverse move unavailable');
        warn.mockRestore();
    });
    it('founder-owned from the email and the operator check; the kill switch from aws-config', async () => {
        const one = placement([{ computerId: C1, provider: 'aws-ec2', placement: view() }]);
        expect(await reverseMoveSummaryInput(reader({}) as never, one, { id: U, email: 'contact@ezil.work' }, notOperator, env)).toMatchObject({ founderOwned: true });
        expect(await reverseMoveSummaryInput(reader({}) as never, one, user, () => true, env)).toMatchObject({ founderOwned: true });
        expect(await reverseMoveSummaryInput(reader({}) as never, one, user, notOperator, { ...env, EZIL_AWS_KILL_SWITCH: '1' })).toMatchObject({ killSwitchOn: true, awsEnabled: true });
        expect(await reverseMoveSummaryInput(reader({}) as never, one, user, notOperator, {})).toMatchObject({ awsEnabled: false, killSwitchOn: false });
    });
});
