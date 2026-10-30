/**
 * Phase B (docs/compute/REVERSE-MOVE-CONTRACT.md): the AWS → Cloudflare move's surfaces, through the REAL routers, routing,
 * placement reads and reverse store; only the reverse table (an in-memory model of 0012 behind the fake placement db),
 * billing, the AWS preview and the Worker are faked.
 * - §5.3: routing returns the reverse providers as `kind: 'aws-ec2'` with their `reverse` marker; every open route answers
 *   the move right after routing, before the billing gate, the stop hold, the credential sync and any Worker call.
 * - §5.9: `computer.move.start`/`retry` (nested), their pinned refusal order, and the next-open trigger in `previewUrl`.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
    gate: vi.fn(), sync: vi.fn(), preview: vi.fn(), prepare: vi.fn(), schedule: vi.fn(),
    subs: [] as unknown[], billingFails: false, tabEnabled: true,
}));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string; email?: string } | null; db: unknown }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure.use(({ ctx, next }) => {
        if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
        return next({ ctx: { ...ctx, user: ctx.user } });
    }) };
});
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/env', () => ({ env: { TELEMETRY_ADMIN_EMAILS: 'ops@example.com' } }));
vi.mock('./computer-store', async original => ({ ...await original<Record<string, unknown>>(), stampOpened: vi.fn(async () => {}) }));
vi.mock('@/server/lib/ai-credential', () => ({ syncAiCredential: h.sync }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({
    config: { enforcementEnabled: true, tabEnabled: h.tabEnabled, meteringEnabled: true }, now: () => new Date('2026-10-30T12:00:00Z'),
    store: {
        subscriptionsFor: async () => { if (h.billingFails) throw new Error('billing down'); return h.subs; },
        openPaymentIssues: async () => [],
    },
}) }));
vi.mock('@/server/billing/v2/compute-access', async original => ({
    ...await original<Record<string, unknown>>(), gateComputerStart: h.gate, billingV2EntitlementReader: () => ({ read: async () => null }),
}));
vi.mock('@/server/lib/compute/aws-clients', () => ({ sharedAwsSdkCollaborators: () => ({}) }));
vi.mock('@/server/lib/compute/aws-preview', async original => ({
    ...await original<Record<string, unknown>>(), requestAwsPreview: h.preview, prepareAwsPoolSession: h.prepare,
}));
vi.mock('@/server/lib/cloudflare-guacamole-provider', async original => ({
    ...await original<Record<string, unknown>>(),
    resolveCloudflareGuacamoleConfig: () => ({ isConfigured: true, hasHmacSecret: true, workerUrl: 'https://worker.test/' }),
}));
vi.mock('@/server/lib/compute/provider-reverse-runtime', () => ({ scheduleReverseMove: h.schedule }));

import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';
import { computerRouter } from './computer';
import { awsPreviewAnswer, awsStatusAnswer, reverseMoveOnOpen, routeComputer, startReverseMove } from './compute-dispatch';
import { createFakePlacementDb, placementRow } from '@/server/lib/compute/fake-placement-db.test-support';
import { reverseBlockedProvider, reverseWaitingProvider } from '@/server/lib/compute/provider-reverse-placement';
import { REVERSE_MOVE_IN_FLIGHT } from '@/server/lib/compute/provider-reverse-store';
import { cloudflareComputeProvider } from '@/server/lib/compute/cloudflare';
import { stopComputerForPolicy } from '@/server/lib/compute/stop-policy';

const U = '11111111-1111-4111-8111-111111111111';
const C = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const M = '33333333-3333-4333-8333-333333333333';
const G = '44444444-4444-4444-8444-444444444444';
const J = '55555555-5555-4555-8555-555555555555';
const F = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';
const I = 'i-0123456789abcdef0', V = 'vol-0123456789abcdef0';
const AWS_ENV = {
    EZIL_COMPUTE_PLACEMENT_READS: '1', EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_KILL_SWITCH: '0',
    AWS_REGIONS: 'ap-south-1', AWS_MAX_RUNNING: '10', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '10',
    EZIL_AWS_USER_MONTHLY_HOURS: '100', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
};
const moving = { ok: false, error: 'computer_moving', errorCode: 'sandbox_starting', retryable: true,
    provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2', computeMoving: true };
const blocked = { ok: false, error: 'computer_move_needs_attention', errorCode: 'preconditions_unmet', retryable: false,
    provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2', computeMoveNeedsAttention: true };
/** A paid Standard period around the billing clock (standing.test.ts's fixture shape). */
const paidSub = { stripeSubscriptionId: 'sub', status: 'active', sku: 'standard_monthly_v3',
    currentPeriodStart: new Date('2026-10-10T00:00:00Z'), currentPeriodEnd: new Date('2026-11-10T00:00:00Z'), cancelAtPeriodEnd: false };

/** The held computer's placement (instance type m6i.xlarge = cmp-4: the D16 hold cannot open it). */
const held = (over: Row = {}) => placementRow({ computer_id: C, owner_user_id: U, provider: 'aws-ec2', state: 'STOPPED', region: 'ap-south-1',
    generation: 7, lease_epoch: 11, instance_type: 'm6i.xlarge', instance_id: I, volume_id: V, fs_uuid: F, fence_token: J, ...over });
const bootOf = { placementGeneration: 8, leaseEpoch: 12, region: 'ap-south-1', volumeId: V, jobId: J, instanceId: I, fsUuid: F,
    claimedAt: '2026-10-30T10:00:00.000Z' };
/** A reverse row as the store reads it back (`COLUMNS`: timestamps as PostgreSQL text, DB-clock ages). */
const moveRow = (over: Row = {}): Row => ({
    id: M, user_id: U, computer_id: C, started_by: 'user', state: 'copying', generation: G, export_boot: bootOf, export_head: null,
    import_progress: null, bytes_total: null, skipped: null, aws_volume_id: null, aws_fs_uuid: null, aws_snapshot_id: null, retain_until: null,
    attempts: 0, last_error: null, state_entered_at: '2026-10-30 10:00:00+00', commit_sent_at: null,
    created_at: '2026-10-30 09:59:00+00', updated_at: '2026-10-30 10:00:01.123456+00',
    age_created: 60, age_state_entered: 30, age_commit_sent: null, age_last_chunk: null, ...over,
});
const HOLDING_SQL = "state NOT IN ('committed', 'failed_reopened')";

/**
 * The fake placement db (real placement statements) plus an in-memory reverse table that answers the store's own SQL.
 * `present: false` is a database without 0012 (production): the probe says so, and any reverse statement throws.
 */
function world(placements: Row[], options: { present?: boolean; moves?: Row[]; forwardBusy?: boolean; imageJobs?: Row[]; meta?: Row[] } = {}) {
    const fake = createFakePlacementDb({ placements, imageJobs: options.imageJobs });
    const moves = (options.moves ?? []).map(r => ({ ...r }));
    const present = options.present ?? true;
    const dialect = new PgDialect();
    const reverseSql: string[] = [];
    const execute = async (q: SQL): Promise<unknown> => {
        const { sql: text, params } = dialect.sqlToQuery(q);
        if (text.startsWith("SELECT to_regclass('public.ezil_compute_reverse_moves')")) {
            reverseSql.push(text);
            return [{ present }];
        }
        if (text.includes('moves:lock-computer')) return [{ isolation: 'read committed' }];
        if (text.includes('transition:read')) return options.meta ?? [];
        if (text.startsWith('SELECT 1 AS busy FROM public.ezil_compute_migrations')) return options.forwardBusy ? [{ busy: 1 }] : [];
        // `readPlacementProvider` (the provider behind an image reservation): not modelled by the fake placement db.
        if (text.includes('placement:provider-table')) return [{ present: true }];
        if (text.includes('placement:provider */')) return fake.placements.filter(r => r.computer_id === params[0]).map(r => ({ provider: r.provider }));
        if (!text.includes('ezil_compute_reverse_moves')) return fake.db.execute(q);
        reverseSql.push(text);
        if (!present) throw new Error('relation "public.ezil_compute_reverse_moves" does not exist');
        const mine = (r: Row) => r.computer_id === String(params[0]).toLowerCase();
        const holding = (r: Row) => r.state !== 'committed' && r.state !== 'failed_reopened';
        if (text.startsWith('INSERT INTO public.ezil_compute_reverse_moves')) {
            if (moves.some(r => mine(r) && holding(r))) return [];
            const row = moveRow({ id: `${moves.length}`.padStart(8, '9') + M.slice(8), computer_id: String(params[0]).toLowerCase(),
                user_id: String(params[1]).toLowerCase(), started_by: params[2], state: 'requested', export_boot: null, age_state_entered: 0 });
            moves.push(row);
            return [row];
        }
        if (text.startsWith('SELECT')) {
            const own = moves.filter(r => mine(r) && (!text.includes(HOLDING_SQL) || holding(r)));
            return own.length ? [own[own.length - 1]] : [];
        }
        throw new Error(`unexpected reverse statement: ${text}`);
    };
    const db = { ...fake.db, execute, transaction: async <T>(fn: (tx: { execute: typeof execute }) => Promise<T>) => fn({ execute }),
        query: { computers: { findFirst: async () => ({ id: C }) } } };
    return { db, fake, moves, reverseSql };
}

let info: ReturnType<typeof vi.spyOn>;
const lines = () => info.mock.calls.map(c => String(c[0])).filter(l => l.includes('"event":"aws-preview"')).map(l => JSON.parse(l) as Row);
const guac = (db: unknown, email = 'person@example.com') => cloudflareGuacamoleRouter.createCaller({ user: { id: U, email }, db } as never);
const computers = (db: unknown) => computerRouter.createCaller({ user: { id: U, email: 'person@example.com' }, db } as never);
const open = (db: unknown, procedure: 'previewUrl' | 'appPreviewUrl' | 'codePreviewUrl' | 'restartDesktop', email?: string) =>
    procedure === 'previewUrl' ? guac(db, email).previewUrl({ sessionId: C, computerId: C }) : guac(db, email)[procedure]({ computerId: C });

beforeEach(() => {
    for (const [k, v] of Object.entries(AWS_ENV)) vi.stubEnv(k, v);
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'test-secret');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no Worker call during a move'); }));
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.gate.mockReset().mockResolvedValue({ allowed: false, reason: 'files_on_aws' });
    h.sync.mockReset().mockResolvedValue(undefined);
    h.preview.mockReset().mockRejectedValue(new Error('no AWS preview during a move'));
    h.prepare.mockReset().mockResolvedValue(undefined);
    h.schedule.mockReset();
    h.subs = [];
    h.billingFails = false;
    h.tabEnabled = true;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('routing (§5.3): both reverse providers are kind aws-ec2, with the marker only routing sets', () => {
    it.each(REVERSE_MOVE_IN_FLIGHT)('%s → the waiting provider, reverse: moving, with the placement\'s own type', async state => {
        const { db } = world([held({ state: 'MOUNTING' })], { moves: [moveRow({ state })] });
        expect(await routeComputer(db, { userId: U, computerId: C }))
            .toEqual({ kind: 'aws-ec2', provider: reverseWaitingProvider, instanceType: 'm6i.xlarge', reverse: 'moving' });
    });
    it.each(['boot_unsettled', 'already_imported', 'commit_in_progress'])('failed_needs_operator %s → the blocked provider, reverse: blocked', async code => {
        const { db } = world([held()], { moves: [moveRow({ state: 'failed_needs_operator', last_error: code })] });
        expect(await routeComputer(db, { userId: U, computerId: C }))
            .toEqual({ kind: 'aws-ec2', provider: reverseBlockedProvider, instanceType: 'm6i.xlarge', reverse: 'blocked' });
        const sent = world([held()], { moves: [moveRow({ state: 'failed_needs_operator', last_error: 'flip_stuck', commit_sent_at: '2026-10-30 11:00:00+00' })] });
        expect(await routeComputer(sent.db, { userId: U, computerId: C })).toMatchObject({ reverse: 'blocked' });
    });
    it('abort_unconfirmed, failed_reopened, committed, none and no 0012: ordinary routing, no marker', async () => {
        for (const moves of [[moveRow({ state: 'failed_needs_operator', last_error: 'abort_unconfirmed' })],
            [moveRow({ state: 'failed_reopened', last_error: 'copy_stalled' })], [moveRow({ state: 'committed' })], []]) {
            const routed = await routeComputer(world([held()], { moves }).db, { userId: U, computerId: C });
            expect(routed.kind).toBe('aws-ec2');
            expect(routed).not.toHaveProperty('reverse');
            expect((routed as { provider: unknown }).provider).not.toBe(reverseWaitingProvider);
        }
        const bare = world([held()], { present: false, moves: [moveRow()] });
        expect(await routeComputer(bare.db, { userId: U, computerId: C })).not.toHaveProperty('reverse');
        expect(bare.reverseSql).toHaveLength(1);
    });
    it('a Cloudflare computer adds no reverse read (the flip swaps the row in the commit\'s own transaction)', async () => {
        const { db, reverseSql } = world([placementRow({ computer_id: C, owner_user_id: U, provider: 'cloudflare', workspace_store: 'r2' })],
            { moves: [moveRow({ state: 'committed' })] });
        expect(await routeComputer(db, { userId: U, computerId: C })).toEqual({ kind: 'cloudflare', provider: cloudflareComputeProvider });
        expect(reverseSql).toEqual([]);
    });
    it('another owner\'s reverse row is NOT_FOUND, as the forward row', async () => {
        const { db } = world([held()], { moves: [moveRow({ user_id: OTHER })] });
        await expect(routeComputer(db, { userId: U, computerId: C })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
});

describe('the open routes during a move (§5.3, r6): the move\'s answer right after routing', () => {
    const surfaces = [['desktop', 'previewUrl'], ['app', 'appPreviewUrl'], ['code', 'codePreviewUrl']] as const;
    // Both held Free users the gate would refuse: a 4 vCPU computer (files_on_aws) and a 2 vCPU one with its Free hours used up.
    const heldUsers = [['cmp-4 (not the hold size)', 'm6i.xlarge', 'files_on_aws'], ['std-2, Free hours used up', 'm6i.large', 'fair_use_paused']] as const;
    describe.each(heldUsers)('%s', (_name, instanceType, refusal) => {
        it.each(surfaces)('%s: the waiting answer, never billing_*; no gate, stop hold, credential sync, preview or Worker call', async (surface, procedure) => {
            h.gate.mockResolvedValue({ allowed: false, reason: refusal });
            const { db, fake } = world([held({ state: 'MOUNTING', instance_type: instanceType, generation: 8, lease_epoch: 12 })], { moves: [moveRow({ state: 'booting' })] });
            const answer = await open(db, procedure);
            // toEqual: no computePreparing, computeLaunching or computeMigrating, and error keeps the provider code.
            expect(answer).toEqual(moving);
            expect(h.gate).not.toHaveBeenCalled();
            expect(h.sync).not.toHaveBeenCalled();
            expect(h.preview).not.toHaveBeenCalled();
            expect(h.prepare).not.toHaveBeenCalled();
            expect(fetch).not.toHaveBeenCalled();
            expect(fake.statements.some(s => s.sql.includes('placement:usage-last-stop'))).toBe(false);
            expect(lines()).toEqual([expect.objectContaining({ event: 'aws-preview', surface, status: null, error: 'sandbox_starting', reason: 'computer_moving' })]);
            // Control: with the move ended, the same ask meets the gate's refusal (the move answer precedes it).
            const ended = world([held({ instance_type: instanceType })], { moves: [moveRow({ state: 'failed_reopened', last_error: 'copy_stalled' })] });
            await expect(open(ended.db, procedure)).resolves.toMatchObject({ errorCode: `billing_${refusal}` });
        });
    });
    it.each(surfaces)('%s: an open-blocked row answers the blocked value (deterministic, no spinner, no re-ask)', async (surface, procedure) => {
        const { db } = world([held()], { moves: [moveRow({ state: 'failed_needs_operator', last_error: 'boot_unsettled' })] });
        expect(await open(db, procedure)).toEqual(blocked);
        expect(h.gate).not.toHaveBeenCalled();
        expect(lines()).toEqual([expect.objectContaining({ surface, error: 'preconditions_unmet', reason: 'computer_move_needs_attention' })]);
    });
    it('restartDesktop answers the move bare (no aws-preview line); nothing restarts', async () => {
        const { db } = world([held({ state: 'MOUNTING', generation: 8, lease_epoch: 12 })], { moves: [moveRow({ state: 'exporting' })] });
        const answer = await open(db, 'restartDesktop');
        expect(answer).toEqual({ ...moving, correlationId: expect.any(String) });
        expect(h.gate).not.toHaveBeenCalled();
        expect(lines()).toEqual([]);
        const stuck = world([held()], { moves: [moveRow({ state: 'failed_needs_operator', last_error: 'already_imported' })] });
        expect(await open(stuck.db, 'restartDesktop')).toEqual({ ...blocked, correlationId: expect.any(String) });
    });
    it('status during a move carries computeMoving (the shell keys on the flag)', async () => {
        const { db } = world([held({ state: 'MOUNTING', generation: 8, lease_epoch: 12 })], { moves: [moveRow({ state: 'copying' })] });
        expect(await guac(db).status({ computerId: C })).toMatchObject({ ok: false, error: 'computer_moving', state: 'starting', computeMoving: true });
        expect(await guac(db).status({ computerId: C })).not.toHaveProperty('computeMigrating');
    });
});

describe('the next-open trigger (D20, §5.9): previewUrl, before routing, fail-closed', () => {
    const stopped = () => world([held()]);
    it('a held STOPPED computer: creates an open row, schedules one immediate drive and answers the waiting value', async () => {
        const w = stopped();
        expect(await open(w.db, 'previewUrl')).toEqual(moving);
        expect(w.moves).toEqual([expect.objectContaining({ computer_id: C, user_id: U, started_by: 'open', state: 'requested' })]);
        expect(h.schedule).toHaveBeenCalledWith(w.moves[0]!.id);
        expect(h.gate).not.toHaveBeenCalled();
        // The hosted-app routes and status never trigger.
        const quiet = stopped();
        for (const procedure of ['appPreviewUrl', 'codePreviewUrl', 'restartDesktop'] as const) await open(quiet.db, procedure);
        await guac(quiet.db).status({ computerId: C });
        expect(quiet.moves).toEqual([]);
    });
    it.each([
        ['ezil.work account', { email: 'founder@EZIL.work' }],
        ['operator allow-list', { email: 'ops@example.com' }],
        ['no email', { email: '' }],
        ['paid standing', { subs: [paidSub] }],
        ['standing unreadable', { billingFails: true }],
        ['billing off (no plan, no standing)', { tabOff: true }],
        ['kill switch on', { env: { EZIL_AWS_KILL_SWITCH: '1' } }],
        ['AWS disabled', { env: { EZIL_AWS_COMPUTERS_ENABLED: '0' } }],
        ['RUNNING', { placement: { state: 'RUNNING' } }],
        ['a lifecycle job', { placement: { lifecycle_job_id: J } }],
        ['a live lease', { placement: { lease_until: new Date(Date.now() + 600_000) } }],
        ['a failed_reopened newest row', { moves: [moveRow({ state: 'failed_reopened', last_error: 'copy_stalled' })] }],
        ['forward work', { forwardBusy: true }],
        ['no 0012', { present: false }],
    ] as const)('no row: %s (the open proceeds as the D16 hold)', async (_name, setup: Row) => {
        if (setup.subs) h.subs = setup.subs as unknown[];
        if (setup.billingFails) h.billingFails = true;
        if (setup.tabOff) h.tabEnabled = false;
        for (const [k, v] of Object.entries((setup.env as Record<string, string>) ?? {})) vi.stubEnv(k, v);
        const w = world([held(setup.placement as Row)], { moves: setup.moves as Row[], forwardBusy: setup.forwardBusy as boolean, present: setup.present as boolean });
        const created = await reverseMoveOnOpen(w.db as never, { userId: U, computerId: C }, { email: setup.email ?? 'person@example.com' });
        expect(created).toBeNull();
        expect(w.moves.filter(r => r.started_by === 'open')).toEqual([]);
        expect(h.schedule).not.toHaveBeenCalled();
    });
    it('a switch/restart transition in flight is not a trigger (its stop passes through STOPPED)', async () => {
        const transition = { v: 1, transitionId: J, requestId: 'req-12345678', kind: 'restart', computerId: C, userId: U, current: 'std-2', target: 'std-2',
            phase: 'waking', reason: null, fromGeneration: 7, fromLeaseEpoch: 11, requestedAt: new Date().toISOString(), stoppingAt: null, wakingAt: null, endedAt: null };
        const w = world([held()], { meta: [{ transition, opening: null }] });
        expect(await reverseMoveOnOpen(w.db as never, { userId: U, computerId: C }, { email: 'person@example.com' })).toBeNull();
    });
    it('a committed newest row does not stop a new open move (a Free user again after a later paid period)', async () => {
        const w = world([held()], { moves: [moveRow({ state: 'committed' })] });
        expect(await reverseMoveOnOpen(w.db as never, { userId: U, computerId: C }, { email: 'person@example.com' }))
            .toMatchObject({ startedBy: 'open', state: 'requested' });
    });
});

describe('computer.move.start / retry (§5.9): nested, pinned order, every refusal a value', () => {
    const ask = (db: unknown, kind: 'start' | 'retry') => computers(db).move[kind]({ computerId: C });
    const placementStates: [string, Row][] = [
        ['LEASED', { state: 'LEASED', lifecycle_job_id: J }], ['STARTING', { state: 'STARTING', lifecycle_job_id: J }],
        ['MOUNTING', { state: 'MOUNTING' }], ['MOUNTING with a job', { state: 'MOUNTING', lifecycle_job_id: J }],
        ['UNCONFIRMED', { state: 'UNCONFIRMED', last_error: 'enrollment_failed' }], ['RECOVERING', { state: 'RECOVERING' }],
        ['RETIRING', { state: 'RETIRING' }], ['STOPPED', { state: 'STOPPED', last_error: 'instance_lost' }],
    ];
    const cases = [...REVERSE_MOVE_IN_FLIGHT, 'failed_needs_operator'].flatMap(state => placementStates.map(([name, p]) => [state, name, p] as const));
    it.each(cases)('%s with the export boot %s: start returns that row, retry answers move_in_progress', async (state, _name, p) => {
        const w = world([held({ generation: 8, lease_epoch: 12, ...p })], { moves: [moveRow({ state, ...(state === 'failed_needs_operator' ? { last_error: 'boot_unsettled' } : {}) })] });
        const started = await ask(w.db, 'start');
        expect(started).toMatchObject({ ok: true, move: { direction: 'to_cloudflare', holdOpenable: false } });
        expect(await ask(w.db, 'retry')).toEqual({ ok: false, reason: 'move_in_progress' });
        expect(w.moves).toHaveLength(1);
    });
    it('the kill switch turned on mid-move: start still returns the row', async () => {
        vi.stubEnv('EZIL_AWS_KILL_SWITCH', '1');
        const w = world([held({ state: 'MOUNTING', generation: 8, lease_epoch: 12 })], { moves: [moveRow({ state: 'copying', bytes_total: 2_000_000, import_progress: {
            bitmap: '0'.repeat(128), bytes: 1_000_000, archiveSha256: 'a'.repeat(64), first: '2026-10-30T10:00:00+00:00', last: '2026-10-30T10:01:00+00:00' } })] });
        expect(await ask(w.db, 'start')).toEqual({ ok: true, move: { direction: 'to_cloudflare', stage: 'copying', bytesDone: '1000000', bytesTotal: '2000000',
            reason: null, skipped: null, retainUntil: null, retry: null, openBlocked: false, holdOpenable: false } });
    });
    it('a STOPPED held computer with nothing in the way: a user row, one immediate drive; retry creates a new row after a failure', async () => {
        const w = world([held()]);
        const started = await ask(w.db, 'start');
        expect(started).toEqual({ ok: true, move: expect.objectContaining({ stage: 'saving', retry: null, openBlocked: false, holdOpenable: false }) });
        expect(w.moves).toEqual([expect.objectContaining({ started_by: 'user', state: 'requested' })]);
        expect(h.schedule).toHaveBeenCalledTimes(1);
        const again = world([held({ instance_type: 'm6i.large' })], { moves: [moveRow({ state: 'failed_reopened', last_error: 'copy_stalled' })] });
        expect(await ask(again.db, 'retry')).toEqual({ ok: true, move: expect.objectContaining({ stage: 'saving', holdOpenable: true }) });
        expect(again.moves.map(r => r.started_by)).toEqual(['user', 'user']);
    });
    it('only user and open rows are ever written (no cron in v1)', async () => {
        const viaClick = world([held()]);
        await ask(viaClick.db, 'start');
        const viaOpen = world([held()]);
        await open(viaOpen.db, 'previewUrl');
        expect([...viaClick.moves, ...viaOpen.moves].map(r => r.started_by)).toEqual(['user', 'open']);
    });

    describe('refusals, in check order', () => {
        it('1. no 0012 → move_unsupported, before anything else', async () => {
            const w = world([held({ state: 'RUNNING' })], { present: false });
            for (const kind of ['start', 'retry'] as const) expect(await ask(w.db, kind)).toEqual({ ok: false, reason: 'move_unsupported' });
        });
        it('2. another owner\'s holding row → move_not_held', async () => {
            const w = world([held()], { moves: [moveRow({ user_id: OTHER })] });
            expect(await ask(w.db, 'start')).toEqual({ ok: false, reason: 'move_not_held' });
        });
        it('3. not held: a paid standing, billing off, or a Cloudflare placement → move_not_held', async () => {
            h.subs = [paidSub];
            expect(await ask(world([held()]).db, 'start')).toEqual({ ok: false, reason: 'move_not_held' });
            h.subs = [];
            h.tabEnabled = false;
            expect(await ask(world([held()]).db, 'start')).toEqual({ ok: false, reason: 'move_not_held' });
            h.tabEnabled = true;
            const cf = world([placementRow({ computer_id: C, owner_user_id: U, provider: 'cloudflare', workspace_store: 'r2' })]);
            expect(await ask(cf.db, 'start')).toEqual({ ok: false, reason: 'move_not_held' });
        });
        it('4. the kill switch, or AWS disabled → move_paused (before forward work and the placement checks)', async () => {
            vi.stubEnv('EZIL_AWS_KILL_SWITCH', '1');
            expect(await ask(world([held({ state: 'RUNNING' })], { forwardBusy: true }).db, 'start')).toEqual({ ok: false, reason: 'move_paused' });
            vi.stubEnv('EZIL_AWS_KILL_SWITCH', '0');
            vi.stubEnv('EZIL_AWS_COMPUTERS_ENABLED', '0');
            expect(await ask(world([held()]).db, 'retry')).toEqual({ ok: false, reason: 'move_paused' });
        });
        it('5. forward work → move_busy', async () => {
            expect(await ask(world([held({ state: 'RUNNING' })], { forwardBusy: true }).db, 'start')).toEqual({ ok: false, reason: 'move_busy' });
        });
        it('6. move_unavailable precedes move_computer_running: an uncleared final failure, or too large with no AWS session since', async () => {
            const final = world([held({ state: 'RUNNING' })], { moves: [moveRow({ state: 'failed_reopened', last_error: 'head_moved' })] });
            expect(await ask(final.db, 'start')).toEqual({ ok: false, reason: 'move_unavailable' });
            const tooLarge = world([held({ state: 'RUNNING', instance_type: 'm6i.large', lease_epoch: 12 })],
                { moves: [moveRow({ state: 'failed_reopened', last_error: 'workspace_too_large' })] });
            expect(await ask(tooLarge.db, 'retry')).toEqual({ ok: false, reason: 'move_unavailable' });
            // An AWS session since (lease epoch above the export boot's) lifts it; operator_cleared lifts a final one.
            const since = world([held({ lease_epoch: 13 })], { moves: [moveRow({ state: 'failed_reopened', last_error: 'workspace_too_large' })] });
            expect(await ask(since.db, 'start')).toMatchObject({ ok: true });
            const cleared = world([held()], { moves: [moveRow({ state: 'failed_reopened', last_error: 'operator_cleared' })] });
            expect(await ask(cleared.db, 'start')).toMatchObject({ ok: true });
        });
        it.each(['RUNNING', 'LEASED', 'STARTING', 'MOUNTING', 'DRAINING', 'STOPPING'])('7. %s → move_computer_running', async state => {
            expect(await ask(world([held({ state })]).db, 'start')).toEqual({ ok: false, reason: 'move_computer_running' });
        });
        it('7. STOPPED with a lifecycle job → move_computer_running', async () => {
            expect(await ask(world([held({ lifecycle_job_id: J })]).db, 'start')).toEqual({ ok: false, reason: 'move_computer_running' });
        });
        it.each(['UNCONFIRMED', 'RECOVERING', 'RETIRING'])('8. %s → move_computer_unsettled', async state => {
            expect(await ask(world([held({ state })]).db, 'retry')).toEqual({ ok: false, reason: 'move_computer_unsettled' });
        });
        it('8. an image-rebase reservation (ImageJobConflictError) → move_computer_unsettled, never a throw', async () => {
            const w = world([held({ image_upgrade_job_id: J })]);
            expect(await ask(w.db, 'start')).toEqual({ ok: false, reason: 'move_computer_unsettled' });
            expect(w.moves).toEqual([]);
        });
        it('an unreadable standing is "not now" (move_busy), never a move', async () => {
            h.billingFails = true;
            expect(await ask(world([held()]).db, 'start')).toEqual({ ok: false, reason: 'move_busy' });
        });
        it('a computer that is not the caller\'s live computer → move_not_held', async () => {
            const w = world([held()]);
            const db = { ...w.db, query: { computers: { findFirst: async () => undefined } } };
            expect(await ask(db, 'start')).toEqual({ ok: false, reason: 'move_not_held' });
        });
    });

    it('startReverseMove maps the store\'s create refusals to values (forward_active under the lock → move_busy)', async () => {
        const w = world([held()]);
        let busyChecks = 0;
        const db = { ...w.db, execute: async (q: SQL) => {
            const text = new PgDialect().sqlToQuery(q).sql;
            // The plain read says free; the create's own check under the computer lock finds forward work.
            if (text.startsWith('SELECT 1 AS busy FROM public.ezil_compute_migrations')) return busyChecks++ === 0 ? [] : [{ busy: 1 }];
            return w.db.execute(q);
        } };
        const transactional = { ...db, transaction: async <T>(fn: (tx: typeof db) => Promise<T>) => fn(db) };
        expect(await startReverseMove(transactional as never, { userId: U, computerId: C }, 'start', { schedule: () => {} }))
            .toEqual({ ok: false, reason: 'move_busy' });
    });
});

/**
 * §5.2 actor: billing-session-sweep. Its only placement-acting path is `tryStop` → `stopComputerForPolicy`, which routes; during
 * a move it meets the waiting provider's stop (`computer_moving`), counted as a failed stop: nothing reaches AWS or the row.
 * (Its held pass also skips an in-flight move: handler.test.ts; its epoch reads write nothing.)
 */
describe('§5.2 actors: the sweep\'s policy stop never stops an export boot', () => {
    it.each([['LEASED', { state: 'LEASED', lifecycle_job_id: J }], ['STARTING', { state: 'STARTING', lifecycle_job_id: J }], ['MOUNTING', { state: 'MOUNTING' }]] as const)(
        'export boot %s: stop and confirmed stop answer computer_moving; the placement and usage are untouched', async (_name, p) => {
            for (const confirm of [false, true]) {
                const w = world([held({ generation: 8, lease_epoch: 12, ...p })], { moves: [moveRow({ state: 'booting' })] });
                const before = JSON.stringify(w.fake.placements);
                for (const reason of ['session_max', 'allowance_exhausted', 'user_stop'] as const) {
                    expect(await stopComputerForPolicy(w.db, { userId: U, computerId: C }, reason, { confirm }))
                        .toEqual({ kind: 'aws-ec2', result: { ok: false, terminated: false, outcome: 'computer_moving' } });
                }
                expect(JSON.stringify(w.fake.placements)).toBe(before);
                expect(w.fake.usage).toEqual([]);
                expect(w.fake.statements.some(s => /^(UPDATE|INSERT|DELETE)/.test(s.sql))).toBe(false);
            }
        });
    it('an open-blocked row: the blocked provider\'s stop, also a refusal', async () => {
        const w = world([held()], { moves: [moveRow({ state: 'failed_needs_operator', last_error: 'boot_unsettled' })] });
        expect(await stopComputerForPolicy(w.db, { userId: U, computerId: C }, 'session_max'))
            .toEqual({ kind: 'aws-ec2', result: { ok: false, terminated: false, outcome: 'computer_move_needs_attention' } });
    });
});

describe('compute-dispatch flags (§5.3): computeMoving / computeMoveNeedsAttention next to computeMigrating', () => {
    const preview = vi.fn(async () => { throw new Error('never previewed'); });
    it('awsPreviewAnswer rewrites error to the errorCode, so the flag is the only carrier', async () => {
        expect(await awsPreviewAnswer(await reverseWaitingProvider.ensure({ correlationId: 'c' }, { userId: U, computerId: C }, { sessionId: C, desktopMode: 'neko' }), preview))
            .toEqual({ ok: false, error: 'sandbox_starting', errorCode: 'sandbox_starting', retryable: true, provider: 'cloudflare-guacamole',
                computeProvider: 'aws-ec2', computeMoving: true });
        expect(await awsPreviewAnswer(await reverseBlockedProvider.ensure({ correlationId: 'c' }, { userId: U, computerId: C }, { sessionId: C, desktopMode: 'neko' }), preview))
            .toEqual({ ok: false, error: 'preconditions_unmet', errorCode: 'preconditions_unmet', retryable: false, provider: 'cloudflare-guacamole',
                computeProvider: 'aws-ec2', computeMoveNeedsAttention: true });
        expect(preview).not.toHaveBeenCalled();
    });
    it('only the reverse providers\' codes set them; never computeMigrating', async () => {
        expect(awsStatusAnswer({ ok: false, error: 'computer_move_needs_attention' })).toMatchObject({ computeMoveNeedsAttention: true });
        expect(awsStatusAnswer({ ok: false, error: 'computer_moving' })).not.toHaveProperty('computeMigrating');
        for (const error of ['computer_starting', 'computer_migrating', 'capacity_unavailable']) {
            const status = awsStatusAnswer({ ok: false, error });
            expect(status, error).not.toHaveProperty('computeMoving');
            expect(status, error).not.toHaveProperty('computeMoveNeedsAttention');
        }
        expect(awsStatusAnswer({ ok: true, error: 'computer_moving' } as never)).not.toHaveProperty('computeMoving');
    });
});
