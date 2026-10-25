import { describe, expect, it } from 'vitest';
import { buildLifecycleWork } from './aws-intent';
import { fixtureIntent } from './aws-intent.test-support';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { proveReplacementNeverLaunched, replacementWorkFromExecution, settleReplacementGeneration } from './aws-rebase-generation';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { readPlacement } from './placement';
import { applyLifecycleReceipt, lifecycleExecutionArn, type ReceiptDeps } from './aws-receipts';
import type { Ec2VolumeView, ReplacementWriter } from './aws-clients';
import type { Ec2EnrollmentView } from './aws-enroll';

const now = new Date('2026-10-22T12:00:00.000Z');
async function setup(pair: 'source' | 'target' = 'source') {
    const work = buildLifecycleWork(fixtureIntent('replace'));
    const i = work.intent;
    const tags = (target: boolean) => ({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot',
        'ezil:computer-id': i.computerId, 'ezil:generation': String(target ? i.targetGeneration : i.previousGeneration),
        'ezil:fence-token': target ? i.fenceToken : i.previousFenceToken! });
    const fake = createFakePlacementDb({ placements: [placementRow({ computer_id: i.computerId,
        generation: i.targetGeneration, lease_epoch: i.leaseEpoch, state: 'STARTING', region: i.deployment.region,
        zone_id: i.deployment.zoneId, instance_id: null, instance_type: i.instanceType, volume_id: i.dataVolumeId,
        lifecycle_job_id: i.jobId, lifecycle_digest: work.digest, fence_token: i.fenceToken,
        enroll_nonce_hash: 'a'.repeat(64), enroll_consumed_hash: 'b'.repeat(64), enroll_expires_at: now,
    })], usage: [i.previousInstanceId, 'i-22222222222222222'].map(instance_id => ({
        computer_id: i.computerId, user_id: '11111111-1111-4111-8111-111111111111', instance_id,
        instance_type: i.instanceType, started_at: new Date('2026-10-22T09:00:00Z'), stopped_at: null,
        egress_bytes: null, observed_by: 'lifecycle-receipt', updated_at: now,
    })) }, { clock: () => now });
    const p = (await readPlacement(fake.db, i.computerId)).record!;
    const source: Ec2EnrollmentView = { instanceId: i.previousInstanceId!, state: 'terminated', tags: tags(false),
        availabilityZone: 'ap-south-1a', availabilityZoneId: i.deployment.zoneId, publicIp: null, volumes: [] };
    const volume: Ec2VolumeView = { volumeId: i.dataVolumeId!, state: 'available', tags: { ...tags(pair === 'target'), 'ezil:backup': 'pilot' },
        attachments: [], encrypted: true, kmsKeyId: i.deployment.dataKeyArn };
    const targets: ReplacementWriter[] = [{ instanceId: 'i-22222222222222222', state: 'terminated', tags: tags(true),
        accountId: i.deployment.accountId, clientToken: '' }];
    const deps: ReceiptDeps = { db: fake.db, describer: { describeForEnrollment: async () => source,
        describeVolume: async () => volume, describeReplacementWriters: async (_r, token) => targets.map((t) => ({ ...t, clientToken: token })) } };
    const execution = { status: 'FAILED', input: work.input, executionArn: lifecycleExecutionArn(i.deployment, i.jobId),
        stateMachineVersionArn: i.deployment.stateMachineVersionArn, redriveCount: 0 };
    return { fake, work, p, source, volume, targets, deps, execution };
}

describe('ordinary replace and resize generation settlement', () => {
    it.each(['source', 'target'] as const)('failure after launch with %s volume tags reconciles the exact pair', async (pair) => {
        const s = await setup(pair);
        await applyLifecycleReceipt({ ...s.deps, executions: { describe: async () => s.execution } }, s.p, s.work.intent.deployment);
        const p = (await readPlacement(s.fake.db, s.p.computerId)).record!;
        expect(p.state).toBe('STOPPED');
        expect(p.generation).toBe(pair === 'source' ? s.work.intent.previousGeneration : s.work.intent.targetGeneration);
        expect(p.fenceToken).toBe(pair === 'source' ? s.work.intent.previousFenceToken : s.work.intent.fenceToken);
        expect(p.leaseEpoch).toBe(s.p.leaseEpoch);
        expect([p.lifecycleJobId, p.lifecycleDigest, p.enrollNonceHash, p.enrollConsumedHash, p.enrollExpiresAt]).toEqual([null, null, null, null, null]);
        expect(s.fake.usage).toHaveLength(2);
        for (const row of s.fake.usage) expect(row).toMatchObject({ stopped_at: now, observed_by: 'generation-reconcile' });
        expect(await settleReplacementGeneration(s.deps, s.p, s.work)).toBe('unconfirmed');
    });
    it('a definite StartExecution refusal may restore a stopped source without inventing a target', async () => {
        const s = await setup(); s.targets.length = 0; s.source.state = 'stopped'; s.source.instanceType = 't3a.medium';
        s.source.volumes = [{ volumeId: s.volume.volumeId, deleteOnTermination: false, tags: s.volume.tags! }];
        s.volume.state = 'in-use'; s.volume.attachments = [{ instanceId: s.source.instanceId, state: 'attached' }];
        expect(await settleReplacementGeneration(s.deps, s.p, s.work, true)).toBe('settled');
        expect(s.fake.placements[0]!.generation).toBe(1);
        expect(s.fake.placements[0]!.lease_epoch).toBe(4);
        expect(s.fake.placements[0]!.instance_type).toBe('t3a.medium');
        for (const row of s.fake.usage) expect(row).toMatchObject({ stopped_at: now, observed_by: 'generation-reconcile' });
    });
    it('a lower_digest_mismatch host refusal with no enrollment closes usage when resolved to STOPPED', async () => {
        const s = await setup();
        s.fake.placements[0]!.enroll_consumed_hash = null;
        const p = (await readPlacement(s.fake.db, s.p.computerId)).record!;
        await applyLifecycleReceipt({ ...s.deps, executions: { describe: async () => ({ ...s.execution,
            error: 'LifecycleRefused', cause: 'lower_digest_mismatch' }) } }, p, s.work.intent.deployment);
        expect(s.fake.placements[0]).toMatchObject({ state: 'STOPPED', enroll_consumed_hash: null, lifecycle_job_id: null });
        for (const row of s.fake.usage) expect(row).toMatchObject({ stopped_at: now, observed_by: 'generation-reconcile' });
    });
    it.each(['missing target', 'live target', 'live source', 'unknown volume', 'wrong tags', 'foreign key', 'owner race', 'job race', 'epoch race'])(
        '%s cannot release a failed replacement', async (fault) => {
            const s = await setup();
            if (fault === 'missing target') s.targets.length = 0;
            if (fault === 'live target') s.targets[0]!.state = 'running';
            if (fault === 'live source') s.source.state = 'running';
            if (fault === 'unknown volume') s.volume.attachments = undefined;
            if (fault === 'wrong tags') s.volume.tags = { ...s.volume.tags, 'ezil:generation': '42' };
            if (fault === 'foreign key') s.volume.kmsKeyId = 'foreign';
            if (fault === 'owner race') s.fake.placements[0]!.owner_user_id = '22222222-2222-4222-8222-222222222222';
            if (fault === 'job race') s.fake.placements[0]!.lifecycle_job_id = '22222222-2222-4222-8222-222222222222';
            if (fault === 'epoch race') s.fake.placements[0]!.lease_epoch = 5;
            expect(await settleReplacementGeneration(s.deps, s.p, s.work)).toBe(fault === 'wrong tags' ? 'generation_drift' : 'unconfirmed');
            expect(s.fake.placements[0]!.state).toBe('STARTING');
            expect(s.fake.usage.every(row => row.stopped_at === null)).toBe(true);
        });
    it.each(['hash', 'version', 'alias', 'redrive', 'execution', 'duplicate'])('rejects %s execution evidence', async (fault) => {
        const s = await setup();
        const e = { ...s.execution, stateMachineAliasArn: undefined as string | undefined };
        if (fault === 'hash') e.input = e.input.replace(s.work.digest, 'f'.repeat(64));
        if (fault === 'version') e.stateMachineVersionArn += '1';
        if (fault === 'alias') e.stateMachineAliasArn = 'alias';
        if (fault === 'redrive') e.redriveCount = 1;
        if (fault === 'execution') e.executionArn += 'x';
        if (fault === 'duplicate') {
            // Insert exactly one duplicate envelope key; leave nested/serialized JSON intact.
            expect(e.input.startsWith('{')).toBe(true);
            e.input = '{"schemaVersion":1,' + e.input.slice(1);
            expect(JSON.parse(e.input)).toEqual(JSON.parse(s.execution.input));
        }
        expect(replacementWorkFromExecution(s.p, s.work.intent.deployment, e)).toBeNull();
    });
});

it('reconciles an immutable failed execution after promotion changed the current version', async () => {
    const s = await setup();
    const promoted = { ...s.work.intent.deployment, stateMachineVersionArn: s.work.stateMachineArn.replace(/:1$/, ':2') };
    expect(replacementWorkFromExecution(s.p, promoted, s.execution)).toEqual(s.work);
});

// 1.0.16 canary cc7ef7bf (2026-10-25): cold replace 77629354 right after a pool release failed at Observe-initial,
// before any launch. Event ids, predecessors, types and state names below mirror its real 10-event history.
const T0 = Date.parse('2026-10-25T11:07:54.199Z');
function canaryHistory(input: string): HistoryEvent[] {
    const e = (id: number, previousEventId: number, type: string, ms: number, extra: Partial<HistoryEvent> = {}): HistoryEvent =>
        ({ id, previousEventId, type: type as HistoryEvent['type'], timestamp: new Date(T0 + ms), ...extra });
    return [
        e(1, 0, 'ExecutionStarted', 0, { executionStartedEventDetails: { input } }),
        e(2, 0, 'PassStateEntered', 19, { stateEnteredEventDetails: { name: 'Init' } }),
        e(3, 2, 'PassStateExited', 19, { stateExitedEventDetails: { name: 'Init' } }),
        e(4, 3, 'TaskStateEntered', 19, { stateEnteredEventDetails: { name: 'Observe-initial' } }),
        e(5, 4, 'LambdaFunctionScheduled', 19, { lambdaFunctionScheduledEventDetails: { resource: 'arn:aws:lambda:ap-south-1:123456789012:function:helper' } }),
        e(6, 5, 'LambdaFunctionStarted', 40),
        e(7, 6, 'LambdaFunctionFailed', 380, { lambdaFunctionFailedEventDetails: { error: 'LifecycleFailure', cause: 'lifecycle_instance_invalid' } }),
        e(8, 7, 'TaskStateExited', 380, { stateExitedEventDetails: { name: 'Observe-initial' } }),
        e(9, 8, 'FailStateEntered', 380, { stateEnteredEventDetails: { name: 'Unconfirmed' } }),
        e(10, 9, 'ExecutionFailed', 400, { executionFailedEventDetails: { error: 'LifecycleUnconfirmed' } }),
    ];
}
async function releasedSetup(placementState: 'STARTING' | 'UNCONFIRMED' = 'UNCONFIRMED') {
    const s = await setup('source'), i = s.work.intent;
    s.fake.placements[0]!.state = placementState;
    const p = (await readPlacement(s.fake.db, i.computerId)).record!;
    // The released pool host: claim identity, pool tag removed at claim, no cold-launch keys.
    s.source.tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot', 'ezil:namespace': 'pilot',
        'ezil:pool-host': '98703145-8dff-4138-b632-cc3584321bc9', 'ezil:computer': i.computerId,
        'ezil:generation': String(i.previousGeneration), 'ezil:fence': i.previousFenceToken! };
    s.targets.length = 0;
    const history = canaryHistory(s.work.input);
    const deps: ReceiptDeps = { ...s.deps, executions: { describe: async () => s.execution, history: async () => history } };
    return { ...s, p, history, deps };
}

describe('replace after a pool release that never launched (1.0.16 canary)', () => {
    it.each(['UNCONFIRMED', 'STARTING'] as const)('%s: settles to the proven previous generation, preserving the epoch and revoking job authority', async (state) => {
        const s = await releasedSetup(state), i = s.work.intent;
        await applyLifecycleReceipt(s.deps, s.p, i.deployment);
        const p = (await readPlacement(s.fake.db, i.computerId)).record!;
        expect(p).toMatchObject({ state: 'STOPPED', generation: i.previousGeneration, fenceToken: i.previousFenceToken,
            instanceId: i.previousInstanceId, leaseEpoch: s.p.leaseEpoch, lastError: 'instance_lost' });
        expect([p.lifecycleJobId, p.lifecycleDigest, p.enrollNonceHash, p.enrollConsumedHash, p.enrollExpiresAt]).toEqual([null, null, null, null, null]);
    });
    it('the real canary history structure is a no-launch proof; it is no proof for another input', async () => {
        const s = await releasedSetup();
        expect(proveReplacementNeverLaunched(s.execution, s.work, s.history)).toBe(true);
        expect(proveReplacementNeverLaunched({ ...s.execution, input: s.execution.input + ' ' }, s.work, s.history)).toBe(false);
    });
    const malformed: [string, (h: HistoryEvent[]) => HistoryEvent[]][] = [
        ['a negative predecessor', h => h.map(e => e.id === 3 ? { ...e, previousEventId: -1 } : e)],
        ['a forward predecessor', h => h.map(e => e.id === 3 ? { ...e, previousEventId: 3 } : e)],
        ['a first event with a predecessor', h => h.map(e => e.id === 1 ? { ...e, previousEventId: 1 } : e)],
        ['an entered state without a name', h => h.map(e => e.id === 4 ? { ...e, stateEnteredEventDetails: {} as HistoryEvent['stateEnteredEventDetails'] } : e)],
        ['an exited state without a name', h => h.map(e => e.id === 8 ? { ...e, stateExitedEventDetails: undefined } : e)],
        ['an orphan runInstances exit', h => h.map(e => e.id === 8 ? { ...e, stateExitedEventDetails: { name: 'runInstances' } } : e)],
        ['a runInstances entry', h => h.map(e => e.id === 4 ? { ...e, stateEnteredEventDetails: { name: 'runInstances' } } : e)],
        ['a runBurstableInstances entry', h => h.map(e => e.id === 4 ? { ...e, stateEnteredEventDetails: { name: 'runBurstableInstances' } } : e)],
        ['a scheduled launch call', h => [...h.slice(0, 5), { ...h[5]!, type: 'TaskScheduled', taskScheduledEventDetails: { resource: 'runInstances',
            resourceType: 'aws-sdk:ec2', region: 'ap-south-1', parameters: '{}' } }, ...h.slice(6)]],
        ['a task event without its details', h => [...h.slice(0, 5), { ...h[5]!, type: 'TaskStarted' }, ...h.slice(6)]],
        ['an unknown event type', h => h.map(e => e.id === 6 ? { ...e, type: 'MapRunStarted' as HistoryEvent['type'] } : e)],
        ['a redrive', h => h.map(e => e.id === 6 ? { ...e, type: 'ExecutionRedriven' as HistoryEvent['type'] } : e)],
        ['a second ExecutionStarted', h => h.map(e => e.id === 6 ? { ...e, type: 'ExecutionStarted' as HistoryEvent['type'] } : e)],
        ['a missing terminal event', h => h.slice(0, -1)],
        ['an id gap', h => h.filter(e => e.id !== 6)],
        ['a missing timestamp', h => h.map(e => e.id === 6 ? { ...e, timestamp: undefined } : e)],
        ['truncated output', h => h.map(e => e.id === 7 ? { ...e, lambdaFunctionFailedEventDetails: { error: 'x', cause: 'y' },
            taskSucceededEventDetails: { resource: 'r', resourceType: 't', outputDetails: { truncated: true } } } : e)],
        ['another started input', h => h.map(e => e.id === 1 ? { ...e, executionStartedEventDetails: { input: '{}' } } : e)],
    ];
    it.each(malformed)('%s is not a no-launch proof and settles nothing', async (_label, edit) => {
        const s = await releasedSetup(), i = s.work.intent, bad = edit(structuredClone(s.history));
        expect(proveReplacementNeverLaunched(s.execution, s.work, bad)).toBe(false);
        await applyLifecycleReceipt({ ...s.deps, executions: { describe: async () => s.execution, history: async () => bad } }, s.p, i.deployment);
        expect((await readPlacement(s.fake.db, i.computerId)).record).toMatchObject({ state: 'UNCONFIRMED', generation: i.targetGeneration, lifecycleJobId: i.jobId });
    });
    const contradictions: [string, (s: Awaited<ReturnType<typeof releasedSetup>>) => void][] = [
        ['no history reader', s => { s.deps.executions = { describe: async () => s.execution }; }],
        ['a history read failure', s => { s.deps.executions = { describe: async () => s.execution, history: async () => { throw new Error('throttled'); } }; }],
        ['a VANISHED source (absence is never termination proof)', s => { s.deps.describer!.describeForEnrollment = async () => null; }],
        ['a shutting-down released source', s => { s.source.state = 'shutting-down'; }],
        ['a stopped released source', s => { s.source.state = 'stopped'; }],
        ['a source in another zone', s => { s.source.availabilityZoneId = 'use1-az1'; }],
        ['a released source with a foreign cold-launch alias', s => { s.source.tags = { ...s.source.tags, 'ezil:computer-id': '22222222-2222-4222-8222-222222222222' }; }],
        ['a released source still pooled', s => { s.source.tags = { ...s.source.tags, 'ezil:pool': '1' }; }],
        ['a released source without pool-host', s => { s.source.tags = Object.fromEntries(Object.entries(s.source.tags).filter(([k]) => k !== 'ezil:pool-host')); }],
        ['a released source with another fence', s => { s.source.tags = { ...s.source.tags, 'ezil:fence': '22222222-2222-4222-8222-222222222222' }; }],
        ['a released source in another namespace', s => { s.source.tags = { ...s.source.tags, 'ezil:namespace': 'other' }; }],
        // A fully valid terminated writer (job client token, target tags, account) still contradicts the no-launch proof.
        ['a discovered writer despite the no-launch history', s => { s.targets.push({ instanceId: 'i-22222222222222222', state: 'terminated',
            tags: { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot', 'ezil:computer-id': s.work.intent.computerId,
                'ezil:generation': String(s.work.intent.targetGeneration), 'ezil:fence-token': s.work.intent.fenceToken },
            accountId: s.work.intent.deployment.accountId, clientToken: '' }); }],
        ['a volume still attached', s => { s.volume.state = 'in-use'; s.volume.attachments = [{ instanceId: s.source.instanceId, state: 'attached' }]; }],
    ];
    it.each(contradictions)('%s keeps the placement UNCONFIRMED', async (_label, edit) => {
        const s = await releasedSetup(), i = s.work.intent;
        edit(s);
        await applyLifecycleReceipt(s.deps, s.p, i.deployment);
        expect((await readPlacement(s.fake.db, i.computerId)).record).toMatchObject({ state: 'UNCONFIRMED', generation: i.targetGeneration, lifecycleJobId: i.jobId });
    });
    it('a STOPPED released pool source is never accepted, even with a definite start refusal', async () => {
        const s = await releasedSetup();
        s.source.state = 'stopped'; s.source.instanceType = 't3a.medium';
        s.source.volumes = [{ volumeId: s.volume.volumeId, deleteOnTermination: false, tags: s.volume.tags! }];
        s.volume.state = 'in-use'; s.volume.attachments = [{ instanceId: s.source.instanceId, state: 'attached' }];
        expect(await settleReplacementGeneration(s.deps, s.p, s.work, true)).toBe('unconfirmed');
        expect(s.fake.placements[0]!.state).toBe('UNCONFIRMED');
    });
    it('a canonical-valid source carrying a foreign claim alias cannot settle even an ordinary launched replacement', async () => {
        const s = await setup();
        s.source.tags = { ...s.source.tags, 'ezil:computer': '22222222-2222-4222-8222-222222222222' };
        expect(await settleReplacementGeneration(s.deps, s.p, s.work)).toBe('unconfirmed');
        s.source.tags = { ...s.source.tags, 'ezil:computer': s.work.intent.computerId, 'ezil:fence': '22222222-2222-4222-8222-222222222222' };
        expect(await settleReplacementGeneration(s.deps, s.p, s.work)).toBe('unconfirmed');
        s.source.tags = { ...s.source.tags, 'ezil:fence': s.work.intent.previousFenceToken! };
        expect(await settleReplacementGeneration(s.deps, s.p, s.work)).toBe('settled');
    });
});
