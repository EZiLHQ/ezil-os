import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigrationRuntime, startPaidMigration } from './provider-migrate-runtime';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { fixtureDeployment } from './aws-intent.test-support';
import { LIFECYCLE_DEPLOYMENTS_ENV } from './aws-intent';
import type { ComputeMigration } from './provider-migrate-store';
import { readEnrollmentPlacement, consumeMigrationEnrollment, finishMigrationEnrollment, provisionFor, type MigrationProvision } from './provider-migrate-provision';
import { reduceMigration } from './provider-migrate';
import type { PlacementDb } from './placement';
import { readAdmissionCounters, withAdmission } from './placement';
import { PgDialect } from 'drizzle-orm/pg-core';
import { advanceMigration, sweepMigrations } from './provider-migrate-orchestrator';
import { lifecycleExecutionArn, type LifecycleExecutionReader } from './aws-receipts';
import type { Ec2EnrollmentView } from './aws-enroll';
import { MigrationConflictError } from './provider-migrate-store';
const fake = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('./provider-migrate-store', async original => ({ ...await original<typeof import('./provider-migrate-store')>(), createProviderMigrationStore: () => fake.store }));
vi.mock('./aws-clients', () => ({ sharedAwsSdkCollaborators: () => { throw new Error('AWS collaborators must be injected in tests'); } }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => { throw new Error('No DB in tests'); } }));
const C = '11111111-1111-4111-8111-111111111111', M = '22222222-2222-4222-8222-222222222222';
const D = fixtureDeployment('ap-south-1', ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge']);
const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '10', EZIL_AWS_USER_MONTHLY_HOURS: '100',
    EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600', EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    AWS_REGIONS: 'ap-south-1', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2',
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ 'ap-south-1': D }), EZIL_AWS_ENROLL_URL: 'https://app.example/api/compute/aws/enroll' };
function fixture(patch: Record<string, string | undefined> = {}, plan = 'standard_monthly_v3', size: 'std-2' | 'cmp-4' | 'cmp-8' = 'std-2') {
    let m = { id: M, computerId: C, userId: C, state: 'exported', generation: M, workspaceHead: { generation: M }, systemHead: null,
        sourceEtag: 'etag', sourceSystemEtag: null, updatedAt: '1', attempts: 0, lastError: null } as ComputeMigration;
    const mintRestoreToken = vi.fn(async () => 'a'.repeat(43)), saveProvision = vi.fn(async (current: ComputeMigration, provision: unknown) => {
        // The store's CAS on state and updated_at.
        if (current.state !== m.state || current.updatedAt !== m.updatedAt) throw new MigrationConflictError();
        m = { ...m, workspaceHead: { generation: M, _awsProvision: provision }, updatedAt: String(Number(m.updatedAt) + 1) };
    });
    const store = { readById: vi.fn(async () => m), readActiveByComputer: vi.fn(async () => m), mintRestoreToken, saveProvision,
        createOrGetActive: vi.fn(async () => m), applyTransition: vi.fn(async (current: ComputeMigration, event: Parameters<typeof reduceMigration>[1]) => {
            const d = reduceMigration(current, event); m = { ...m, ...d.migration }; return { ...d, migration: m };
        }) };
    fake.store = store;
    const db = createFakePlacementDb({ computers: [{ id: C, user_id: C }], placements: [] });
    const executions = { describe: vi.fn<LifecycleExecutionReader['describe']>(async () => ({ status: 'FAILED' })) };
    const describer = { describeForEnrollment: vi.fn(async (): Promise<Ec2EnrollmentView | null> => null),
        describeVolume: vi.fn(async () => null), findComputerResources: vi.fn(async () => ({ instances: [], volumes: [] })) };
    const start = vi.fn(async () => {}), deps = createMigrationRuntime(db.db, { env: { ...env, ...patch }, collaborators: { starter: { start }, executions, describer },
        entitlement: { read: async () => ({ status: 'active', planId: plan, provider: 'aws', source: 'billing_v2', size }) } });
    return { deps, db, start, store, executions, describer, get: () => m };
}
beforeEach(() => { fake.store = {}; });
describe('real migration admission and provisioning seam', () => {
    it.each([['standard_monthly_v3', 'cmp-8', 'm6i.large'], ['premium_monthly_v3', 'cmp-4', 'm6i.xlarge'],
        ['premium_monthly_v3', 'cmp-8', 'm6i.2xlarge']] as const)('uses entitled size for %s / %s', async (plan, size, machine) => {
        const f = fixture({ EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '10' }, plan, size);
        await f.deps.provision(f.get()); expect(f.start).toHaveBeenCalledOnce();
        const [region, work] = f.start.mock.calls[0]! as unknown as [string, { input: string }];
        expect(region).toBe('ap-south-1'); expect(work.input).toContain(machine);
        const saved = f.store.saveProvision.mock.calls[0]![1];
        expect(JSON.stringify(saved)).not.toContain('a'.repeat(43)); expect(JSON.stringify(saved)).not.toContain('identityToken');
        expect(f.db.placements).toEqual([]);
        await f.deps.provision(f.get()); expect(f.start).toHaveBeenCalledOnce(); expect(f.store.mintRestoreToken).toHaveBeenCalledOnce();
    });
    it.each([{ EZIL_AWS_COMPUTERS_ENABLED: '0' }, { EZIL_AWS_KILL_SWITCH: '1' }, { AWS_MAX_RUNNING: '0' },
        { EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '0' }, { AWS_REGIONS: 'us-east-1' }])('refusal %j creates no intent/token/instance', async patch => {
        const f = fixture(patch); await expect(f.deps.provision(f.get())).rejects.toThrow();
        expect(f.start).not.toHaveBeenCalled(); expect(f.store.mintRestoreToken).not.toHaveBeenCalled(); expect(f.store.saveProvision).not.toHaveBeenCalled();
    });
    it.each(['free_v3', 'standard_monthly_v2', 'compute_monthly_v2'])('refuses entitlement %s', async plan => {
        const f = fixture({}, plan); await expect(f.deps.provision(f.get())).rejects.toThrow(); expect(f.start).not.toHaveBeenCalled();
    });
    it.each(['cloudflare', 'aws-ec2', 'none'])('paid trigger filters published placement %s', async provider => {
        const f = fixture();
        if (provider !== 'none') f.db.placements.push(placementRow({ computer_id: C, owner_user_id: C, provider,
            workspace_store: provider === 'cloudflare' ? 'r2' : 'ebs' }));
        const db: PlacementDb = { transaction: f.db.db.transaction, execute: async () => [{ id: C }] };
        // Keep the real placement read; the only direct query here is the owned computer list.
        const { PgDialect } = await import('drizzle-orm/pg-core'); const dialect = new PgDialect();
        db.execute = q => dialect.sqlToQuery(q).sql.includes('FROM public.ezil_computers') ? Promise.resolve([{ id: C }]) : f.db.db.execute(q);
        f.deps.exclusive = async () => {}; // Scheduling is tested separately; no Worker calls.
        await startPaidMigration(C, 'standard_monthly_v3', { db, deps: f.deps });
        expect(f.store.createOrGetActive).toHaveBeenCalledTimes(provider === 'aws-ec2' ? 0 : 1);
        await startPaidMigration(C, 'standard_monthly_v2', { db, deps: f.deps });
        expect(f.store.createOrGetActive).toHaveBeenCalledTimes(provider === 'aws-ec2' ? 0 : 1);
    });
});

describe('failed migration capacity release', () => {
    async function failed(state: ComputeMigration['state'] = 'failed_reopened') {
        const f = fixture(); await f.deps.provision(f.get());
        f.get().state = state;
        f.store.saveProvision.mockClear(); f.start.mockClear();
        f.deps.exclusive = async (_, run) => run();
        return { ...f, warn: vi.spyOn(console, 'warn').mockImplementation(() => {}) };
    }
    afterEach(() => { vi.restoreAllMocks(); });
    const instance = (state: string): Ec2EnrollmentView => ({ instanceId: 'i-11111111111111111', state,
        availabilityZone: 'ap-south-1a', availabilityZoneId: D.zoneId, publicIp: null, tags: {}, volumes: [] });
    /** The operator signal: structured `migration-boot-held` warnings. */
    const heldEvents = (f: Awaited<ReturnType<typeof failed>>) => f.warn.mock.calls.map(([line]) => String(line))
        .filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>).filter(e => e.event === 'migration-boot-held');
    /** Held for an operator: nothing started or released, and the reason signalled once. */
    function expectHeld(f: Awaited<ReturnType<typeof failed>>, reason: string) {
        expect(f.start).not.toHaveBeenCalled();
        expect(provisionFor(f.get())?.released).not.toBe(true);
        expect(provisionFor(f.get())?.held?.reason).toBe(reason);
        expect(heldEvents(f).map(e => e.reason)).toEqual([reason]);
    }
    it.each(['failed_reopened', 'failed_needs_operator'] as const)('sweeps %s with a terminal execution and no instance out of admission', async state => {
        const f = await failed(state), dialect = new PgDialect();
        // The placement fake has no migration table. Model its UNION row and pin the real SQL exclusion.
        const counters = () => withAdmission({ ...f.db.db, transaction: run => f.db.db.transaction(tx => run({ execute: async query => {
            const text = dialect.sqlToQuery(query).sql;
            if (/placement:count-(running|running-region|user)/.test(text)) {
                expect(text).toContain("COALESCE(m.workspace_head #>> '{_awsProvision,released}', 'false') <> 'true'");
                expect(text).toContain("m.state <> 'committed'");
                const n = provisionFor(f.get())?.released === true ? 0 : 1;
                if (text.includes('placement:count-running-region')) return n ? [{ region: 'ap-south-1', n, vcpu: 2 }] : [];
                return [{ n: text.includes('placement:count-user') ? 0 : n, vcpu: n * 2 }];
            }
            return tx.execute(query);
        } })) }, (tx, lock) => readAdmissionCounters(tx, lock, { computerId: C, userId: C, now: new Date(), monthStart: new Date(0) }));
        expect((await counters()).runningCount).toBe(1);
        await sweepMigrations({ claimStale: async () => [f.get()], advance: id => advanceMigration(f.deps, id) });
        expect(provisionFor(f.get())?.released).toBe(true);
        expect((await counters()).runningCount).toBe(0);
        expect(f.describer.describeForEnrollment).not.toHaveBeenCalled();
        await advanceMigration(f.deps, M);
        expect(f.store.saveProvision).toHaveBeenCalledOnce();
    });
    it.each(['RUNNING', 'PENDING_REDRIVE', 'UNKNOWN'])('keeps the reservation while execution is %s', async status => {
        const f = await failed(); f.executions.describe.mockResolvedValue({ status });
        await advanceMigration(f.deps, M);
        expect(provisionFor(f.get())?.released).not.toBe(true);
        expect(f.store.saveProvision).not.toHaveBeenCalled();
    });
    /** The incident shape: enrollment recorded the boot, then the tunnel never came up. */
    function enrolled(f: Awaited<ReturnType<typeof failed>>) {
        const intent = provisionFor(f.get())!;
        intent.placement.instanceId = 'i-11111111111111111'; intent.placement.volumeId = 'vol-11111111111111111';
        intent.placement.lastError = 'enroll_tunnel_pending';
        f.get().workspaceHead!._awsProvision = intent;
        return intent;
    }
    const bootTags = (p: { fenceToken: string | null }) => ({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': D.namespace,
        'ezil:computer-id': C, 'ezil:generation': '1', 'ezil:fence-token': p.fenceToken! });
    /** Launch and retire executions are told apart by their `computer-<jobId>` names. */
    function executionsBy(f: Awaited<ReturnType<typeof failed>>, launch: { status: string; output?: string }, retire: (arn: string) => Promise<{ status: string }>) {
        const launchJob = provisionFor(f.get())!.placement.lifecycleJobId!;
        f.executions.describe.mockImplementation(async (_region, arn) => arn.endsWith(`computer-${launchJob}`) ? launch : retire(arn));
    }
    const RETIRE_JOB = '44444444-4444-4444-8444-444444444444';
    function recordRetire(f: Awaited<ReturnType<typeof failed>>, intent: MigrationProvision, age: number, executionArn = lifecycleExecutionArn(D, RETIRE_JOB)) {
        intent.retire = { jobId: RETIRE_JOB, digest: 'ab'.repeat(32), requestedAt: new Date(Date.now() - age).toISOString(), executionArn };
        f.get().workspaceHead!._awsProvision = intent;
        return intent.retire;
    }
    const startedRetires = (f: Awaited<ReturnType<typeof failed>>) => f.start.mock.calls.map(call => {
        const [region, work] = call as unknown as [string, { name: string; input: string }];
        return { region, name: work.name, intent: JSON.parse(JSON.parse(work.input).document) };
    });
    it('retires a running failed boot through the lifecycle job, then releases it once terminated', async () => {
        const f = await failed(), intent = enrolled(f), running = { ...instance('running'), tags: bootTags(intent.placement) };
        let retireStatus = 'RUNNING';
        executionsBy(f, { status: 'SUCCEEDED' }, async () => ({ status: retireStatus }));
        f.describer.describeForEnrollment.mockResolvedValue(running);
        const recordedAtStart: (string | undefined)[] = [];
        f.start.mockImplementation(async () => { recordedAtStart.push(provisionFor(f.get())?.retire?.jobId); });
        await sweepMigrations({ claimStale: async () => [f.get()], advance: id => advanceMigration(f.deps, id) });
        const [started] = startedRetires(f), recorded = provisionFor(f.get())!;
        expect(f.start).toHaveBeenCalledOnce();
        expect(started).toMatchObject({ region: 'ap-south-1', name: `computer-${recorded.retire!.jobId}`, intent: {
            operation: 'retire', computerId: C, targetGeneration: 1, fenceToken: intent.placement.fenceToken,
            providerInstanceId: 'i-11111111111111111', dataVolumeId: 'vol-11111111111111111', userData: null } });
        // Recorded before the start, so the authority can find it; the launch identity is kept.
        expect(recordedAtStart).toEqual([recorded.retire!.jobId]);
        expect(recorded.retire!.executionArn).toBe(lifecycleExecutionArn(D, recorded.retire!.jobId));
        expect(recorded.placement.lifecycleJobId).toBe(intent.placement.lifecycleJobId);
        expect(recorded.released).not.toBe(true);
        // A running retire is followed, never duplicated, and the reservation is held under it.
        await advanceMigration(f.deps, M);
        f.describer.describeForEnrollment.mockResolvedValue({ ...running, state: 'stopped' });
        await advanceMigration(f.deps, M);
        expect(f.start).toHaveBeenCalledOnce();
        expect(provisionFor(f.get())?.released).not.toBe(true);
        retireStatus = 'SUCCEEDED';
        f.describer.describeForEnrollment.mockResolvedValue({ ...running, state: 'terminated' });
        await advanceMigration(f.deps, M);
        expect(provisionFor(f.get())?.released).toBe(true);
        expect(provisionFor(f.get())?.retire?.jobId).toBe(recorded.retire!.jobId);
        expect(f.start).toHaveBeenCalledOnce();
    });
    it('retires a host that never enrolled, named by the succeeded launch receipt', async () => {
        const f = await failed(), p = provisionFor(f.get())!.placement;
        const receipt = { schemaVersion: 1, jobId: p.lifecycleJobId, digest: p.lifecycleDigest, computerId: C, generation: 1,
            leaseEpoch: 1, fenceToken: p.fenceToken, instanceId: 'i-22222222222222222', volumeId: 'vol-22222222222222222', state: 'running' };
        executionsBy(f, { status: 'SUCCEEDED', output: JSON.stringify(receipt) }, async () => { throw { name: 'ExecutionDoesNotExist' }; });
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance('pending'), instanceId: receipt.instanceId, tags: bootTags(p) });
        await advanceMigration(f.deps, M);
        expect(f.describer.describeForEnrollment).toHaveBeenCalledWith('ap-south-1', receipt.instanceId);
        expect(startedRetires(f)[0]?.intent).toMatchObject({ operation: 'retire', providerInstanceId: receipt.instanceId, dataVolumeId: receipt.volumeId });
        expect(provisionFor(f.get())?.released).not.toBe(true);
    });
    // Each mismatch still parses as a receipt, so only the binding to this intent rejects it.
    it.each([
        ['missing', null], ['malformed', '{'], ['another job', { jobId: M }], ['another digest', { digest: 'cd'.repeat(32) }],
        ['another computer', { computerId: M }], ['another generation', { generation: 2 }], ['another lease epoch', { leaseEpoch: 2 }],
        ['another fence token', { fenceToken: '33333333-3333-4333-8333-333333333333' }], ['stopped', { state: 'stopped' }],
    ] as const)('holds a succeeded launch with a %s receipt and no enrolled instance', async (_kind, patch) => {
        const f = await failed(), p = provisionFor(f.get())!.placement;
        const receipt = { schemaVersion: 1, jobId: p.lifecycleJobId, digest: p.lifecycleDigest, computerId: C,
            generation: 1, leaseEpoch: 1, fenceToken: p.fenceToken, instanceId: 'i-22222222222222222', volumeId: 'vol-22222222222222222', state: 'running' };
        f.executions.describe.mockResolvedValue({ status: 'SUCCEEDED', output: typeof patch === 'object' && patch ? JSON.stringify({ ...receipt, ...patch }) : patch });
        await advanceMigration(f.deps, M);
        expect(f.describer.describeForEnrollment).not.toHaveBeenCalled();
        expectHeld(f, 'receipt_invalid');
    });
    it('keeps a receipt_invalid hold after the launch history expires', async () => {
        const f = await failed();
        f.executions.describe.mockResolvedValue({ status: 'SUCCEEDED', output: null });
        await advanceMigration(f.deps, M);
        // Step Functions purged the launch, long after its visibility grace: absent alone would release.
        f.executions.describe.mockRejectedValue({ name: 'ExecutionDoesNotExist' });
        const intent = provisionFor(f.get())!; intent.reservedAt = new Date(0).toISOString(); f.get().workspaceHead!._awsProvision = intent;
        await advanceMigration(f.deps, M);
        expectHeld(f, 'receipt_invalid');
    });
    it.each([
        ['fence token', { 'ezil:fence-token': '33333333-3333-4333-8333-333333333333' }],
        ['computer', { 'ezil:computer-id': M }],
        ['generation', { 'ezil:generation': '2' }],
        ['namespace', { 'ezil:stage': 'other' }],
        ['untagged', null],
    ] as const)('never retires or releases a foreign instance (%s)', async (_name, patch) => {
        const f = await failed(), intent = enrolled(f);
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance('running'), tags: patch ? { ...bootTags(intent.placement), ...patch } : {} });
        await advanceMigration(f.deps, M);
        expectHeld(f, 'foreign_instance');
    });
    it('never retires a boot from another deployment namespace', async () => {
        const f = await failed(), intent = enrolled(f);
        const canary = { ...D, namespace: 'canary', stateMachineVersionArn: D.stateMachineVersionArn.replace('ezil-pilot-', 'ezil-canary-') };
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance('running'), tags: bootTags(intent.placement) });
        const deps = createMigrationRuntime(f.db.db, { env: { ...env, [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ 'ap-south-1': canary }) },
            collaborators: { starter: { start: f.start }, executions: f.executions, describer: f.describer } });
        await deps.releaseProvision(f.get());
        expectHeld(f, 'foreign_instance');
    });
    it('signals a held boot at most once per row per ten minutes', async () => {
        const f = await failed(), intent = enrolled(f);
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance('running'), tags: {} });
        await advanceMigration(f.deps, M);
        const first = provisionFor(f.get())!.held!;
        expect(heldEvents(f)).toEqual([{ event: 'migration-boot-held', reason: 'foreign_instance', migrationId: M,
            computer: C.slice(0, 8), instanceId: intent.placement.instanceId, since: first.since }]);
        await advanceMigration(f.deps, M);
        expect(heldEvents(f)).toHaveLength(1); expect(f.store.saveProvision).toHaveBeenCalledOnce();
        // A new reason inside the interval is recorded, not signalled.
        f.db.placements.push(placementRow({ computer_id: C, owner_user_id: C, provider: 'aws-ec2', workspace_store: 'ebs' }));
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance('running'), tags: bootTags(intent.placement) });
        await advanceMigration(f.deps, M);
        expect(provisionFor(f.get())!.held).toMatchObject({ reason: 'aws_placement_published', signalledAt: first.signalledAt });
        expect(heldEvents(f)).toHaveLength(1);
        const aged = provisionFor(f.get())!, since = aged.held!.since;
        aged.held = { ...aged.held!, signalledAt: new Date(Date.now() - 11 * 60_000).toISOString() };
        f.get().workspaceHead!._awsProvision = aged;
        await advanceMigration(f.deps, M);
        expect(heldEvents(f).map(e => [e.reason, e.since])).toEqual([['foreign_instance', first.since], ['aws_placement_published', since]]);
        expect(f.start).not.toHaveBeenCalled();
    });
    it.each(['stopping', 'shutting-down', 'unknown'])('waits on an instance that is %s', async state => {
        const f = await failed(), intent = enrolled(f);
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance(state), tags: bootTags(intent.placement) });
        await advanceMigration(f.deps, M);
        expect(f.start).not.toHaveBeenCalled(); expect(f.store.saveProvision).not.toHaveBeenCalled();
    });
    it.each(['RUNNING', 'PENDING_REDRIVE'])('leaves a running instance alone while the launch job is %s', async status => {
        const f = await failed(), intent = enrolled(f);
        f.executions.describe.mockResolvedValue({ status });
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance('running'), tags: bootTags(intent.placement) });
        await advanceMigration(f.deps, M);
        expect(f.describer.describeForEnrollment).not.toHaveBeenCalled();
        expect(f.start).not.toHaveBeenCalled(); expect(f.store.saveProvision).not.toHaveBeenCalled();
    });
    it.each([[0, 0], [11 * 60_000, 1]])('re-issues a failed retire only after the retry interval (%s ms)', async (age, starts) => {
        const f = await failed(), intent = enrolled(f), retire = recordRetire(f, intent, age);
        executionsBy(f, { status: 'SUCCEEDED' }, async () => ({ status: 'FAILED' }));
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance('running'), tags: bootTags(intent.placement) });
        await advanceMigration(f.deps, M);
        if (starts) expect(provisionFor(f.get())!.retire!.jobId).not.toBe(retire.jobId);
        if (starts) expect(f.start).toHaveBeenCalledOnce();
        else expectHeld(f, 'retire_failed');
        expect(provisionFor(f.get())?.released).not.toBe(true);
    });
    it('follows a recorded retire by its own execution after the deployment changes', async () => {
        const f = await failed(), intent = enrolled(f);
        const before = lifecycleExecutionArn({ ...D, stateMachineVersionArn: D.stateMachineVersionArn.replace('-lifecycle:', '-lifecycleprev:') }, RETIRE_JOB);
        recordRetire(f, intent, 11 * 60_000, before);
        executionsBy(f, { status: 'SUCCEEDED' }, async arn => { if (arn === before) return { status: 'RUNNING' }; throw { name: 'ExecutionDoesNotExist' }; });
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance('stopped'), tags: bootTags(intent.placement) });
        await advanceMigration(f.deps, M);
        expect(f.executions.describe).toHaveBeenCalledWith('ap-south-1', before);
        expect(f.start).not.toHaveBeenCalled(); expect(f.store.saveProvision).not.toHaveBeenCalled();
    });
    it.each([[60_000, false], [6 * 60_000, true]])('releases a stopped boot under an absent retire only after the start settles (%s ms)', async (age, released) => {
        const f = await failed(), intent = enrolled(f);
        recordRetire(f, intent, age);
        executionsBy(f, { status: 'SUCCEEDED' }, async () => { throw { name: 'ExecutionDoesNotExist' }; });
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance('stopped'), tags: bootTags(intent.placement) });
        await advanceMigration(f.deps, M);
        expect(provisionFor(f.get())?.released === true).toBe(released);
        expect(f.start).not.toHaveBeenCalled();
    });
    it('lets one of two sweeps holding the same row record and start a retire', async () => {
        const f = await failed(), intent = enrolled(f);
        executionsBy(f, { status: 'SUCCEEDED' }, async () => ({ status: 'RUNNING' }));
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance('running'), tags: bootTags(intent.placement) });
        // Both read the row before either wrote; the store's CAS on updated_at decides.
        const first = f.get(), second = { ...f.get() };
        await f.deps.releaseProvision(first);
        await expect(f.deps.releaseProvision(second)).rejects.toBeInstanceOf(MigrationConflictError);
        expect(startedRetires(f).map(s => s.name)).toEqual([`computer-${provisionFor(f.get())!.retire!.jobId}`]);
    });
    it('starts no retire the authority would refuse while an AWS placement is published', async () => {
        const f = await failed(), intent = enrolled(f);
        f.db.placements.push(placementRow({ computer_id: C, owner_user_id: C, provider: 'aws-ec2', workspace_store: 'ebs' }));
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance('running'), tags: bootTags(intent.placement) });
        await advanceMigration(f.deps, M);
        expectHeld(f, 'aws_placement_published');
    });
    it.each(['starter', 'deployment'])('fails closed on a running instance without a %s', async missing => {
        const f = await failed(), intent = enrolled(f);
        f.describer.describeForEnrollment.mockResolvedValue({ ...instance('running'), tags: bootTags(intent.placement) });
        const deps = createMigrationRuntime(f.db.db, { env: missing === 'deployment' ? { ...env, [LIFECYCLE_DEPLOYMENTS_ENV]: undefined } : env,
            collaborators: missing === 'starter' ? { executions: f.executions, describer: f.describer } : { starter: { start: f.start }, executions: f.executions, describer: f.describer } });
        await deps.releaseProvision(f.get());
        expectHeld(f, `no_${missing}`);
    });
    it.each(['stopped', 'terminated', 'absent'])('releases after the recorded instance is confirmed %s', async state => {
        const f = await failed(), intent = provisionFor(f.get())!;
        intent.placement.instanceId = instance(state).instanceId;
        f.get().workspaceHead!._awsProvision = intent;
        f.describer.describeForEnrollment.mockResolvedValue(state === 'absent' ? null : instance(state));
        await advanceMigration(f.deps, M);
        expect(f.describer.describeForEnrollment).toHaveBeenCalledWith('ap-south-1', intent.placement.instanceId);
        expect(provisionFor(f.get())?.released).toBe(true);
    });
    it.each(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'])('accepts terminal execution %s', async status => {
        const f = await failed(), p = provisionFor(f.get())!.placement;
        // A succeeded launch always started an instance: its receipt names it, and it must be gone.
        const output = JSON.stringify({ schemaVersion: 1, jobId: p.lifecycleJobId, digest: p.lifecycleDigest, computerId: C, generation: 1,
            leaseEpoch: 1, fenceToken: p.fenceToken, instanceId: 'i-22222222222222222', volumeId: 'vol-22222222222222222', state: 'running' });
        f.executions.describe.mockResolvedValue({ status, output: status === 'SUCCEEDED' ? output : null });
        await advanceMigration(f.deps, M); expect(provisionFor(f.get())?.released).toBe(true);
        expect(f.describer.describeForEnrollment).toHaveBeenCalledTimes(status === 'SUCCEEDED' ? 1 : 0);
    });
    it.each([0, 6 * 60_000])('treats absent execution as never started only after visibility grace (%s ms)', async age => {
        const f = await failed(), intent = provisionFor(f.get())!;
        intent.reservedAt = new Date(Date.now() - age).toISOString(); f.get().workspaceHead!._awsProvision = intent;
        f.executions.describe.mockRejectedValue({ name: 'ExecutionDoesNotExist' });
        await advanceMigration(f.deps, M); expect(provisionFor(f.get())?.released === true).toBe(age > 0);
    });
    it.each(['execution', 'instance', 'identity', 'missing-executions', 'missing-describer', 'cas'])('fails closed on %s uncertainty', async failure => {
        const f = await failed(), intent = provisionFor(f.get())!;
        if (failure === 'execution') f.executions.describe.mockRejectedValue(new Error('unavailable'));
        if (failure === 'identity') intent.placement.lifecycleJobId = null;
        if (failure === 'instance' || failure === 'missing-describer') {
            intent.placement.instanceId = instance('running').instanceId;
            f.describer.describeForEnrollment.mockRejectedValue(new Error('unavailable'));
        }
        if (failure === 'cas') f.store.saveProvision.mockRejectedValue(new MigrationConflictError());
        f.get().workspaceHead!._awsProvision = intent;
        const deps = failure.startsWith('missing-') ? createMigrationRuntime(f.db.db, { collaborators:
            failure === 'missing-executions' ? { describer: f.describer } : { executions: f.executions } }) : f.deps;
        await sweepMigrations({ claimStale: async () => [f.get()], advance: () => deps.releaseProvision(f.get()) });
        expect(provisionFor(f.get())?.released).not.toBe(true);
    });
    it.each(['committed', 'provisioning'] as const)('does not release %s migrations', async state => {
        const f = await failed(state); await f.deps.releaseProvision(f.get());
        if (state === 'committed') await advanceMigration(f.deps, M);
        expect(f.executions.describe).not.toHaveBeenCalled(); expect(f.store.saveProvision).not.toHaveBeenCalled();
    });
});

describe('migration enrollment intent', () => {
    it('enrolls the hidden boot without publishing an AWS placement', async () => {
        const f = fixture(); await f.deps.provision(f.get());
        const p = (await readEnrollmentPlacement(f.db.db, C)).record!;
        expect(p.provider).toBe('aws-ec2'); expect(f.db.placements).toHaveLength(0);
        const input = { computerId: C, expected: p, nonceHash: p.enrollNonceHash!,
            fields: { instanceId: 'i-11111111111111111', volumeId: 'vol-11111111111111111' } };
        const consumed = await consumeMigrationEnrollment(f.db.db, input);
        expect(consumed.ok).toBe(true);
        expect((await consumeMigrationEnrollment(f.db.db, input)).ok).toBe(false);
        if (!consumed.ok) throw new Error('consume');
        expect((await finishMigrationEnrollment(f.db.db, { computerId: C, expected: consumed.placement, success: true })).ok).toBe(true);
        expect(provisionFor(f.get())!.placement.lastError).toBe('enroll_succeeded');
        expect(f.db.placements).toHaveLength(0);
    });
    it.each(['generation', 'lease', 'nonce', 'instance', 'expired', 'recovery'])('rejects %s enrollment mismatch', async guard => {
        const f = fixture(); await f.deps.provision(f.get()); const intent = provisionFor(f.get())!;
        const p = intent.placement;
        if (guard === 'instance') p.instanceId = 'i-22222222222222222';
        if (guard === 'expired') p.enrollExpiresAt = new Date(0);
        await f.store.saveProvision(f.get(), intent);
        if (guard === 'recovery') f.get().lastError = 'recovery:abort:restore';
        const result = await consumeMigrationEnrollment(f.db.db, { computerId: C,
            expected: { ...p, generation: guard === 'generation' ? 9 : p.generation, leaseEpoch: guard === 'lease' ? 9 : p.leaseEpoch },
            nonceHash: guard === 'nonce' ? 'f'.repeat(64) : p.enrollNonceHash!,
            fields: { instanceId: 'i-11111111111111111', volumeId: 'vol-11111111111111111' } });
        expect(result.ok).toBe(false);
    });
});
