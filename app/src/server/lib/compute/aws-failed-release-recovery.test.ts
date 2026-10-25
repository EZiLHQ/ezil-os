import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { buildLifecycleWork } from './aws-intent';
import { fixtureIntent } from './aws-intent.test-support';
import { D, failedReleaseHistory, failedReleaseSetup, NOW, START, STOP, TERMINATED } from './aws-failed-release.test-support';
import { proveFailedReleaseTermination } from './aws-failed-release-proof';
import { reconcileFailedRelease, type ReconcileReleaseRequest } from './aws-pool-release-recovery';
import { applyLifecycleReceipt, lifecycleExecutionArn, POOL_RELEASED } from './aws-receipts';

afterEach(() => vi.restoreAllMocks());
type Setup = ReturnType<typeof failedReleaseSetup>;
const cas = (s: Setup) => s.statements.filter(x => x.sql.includes('placement:cas') || x.sql.includes('placement:pool-recovery')).length;

describe('failed release whose host it already terminated (incident 2026-10-25)', () => {
    it.each([['terminated (still listed)', false], ['aged out of EC2', true]] as const)('%s: one ordinary release replay, then STOPPED pool_released at the witnessed termination time; gen 1 / epoch 1 kept', async (_name, agedOut) => {
        const s = failedReleaseSetup();
        if (agedOut) vi.mocked(s.deps.describer!.describeForEnrollment).mockResolvedValue(null);
        await s.tick();
        expect(await s.current()).toMatchObject({ state: 'RECOVERING', generation: 1, leaseEpoch: 1 });
        expect(await s.context()).toMatchObject({ basis: 'failed_release_termination', stoppedAt: TERMINATED.toISOString(),
            sourceStartedAt: START.toISOString(), sourceJobId: s.original.intent.jobId, error: null });
        expect(s.starts).toHaveLength(1);
        expect(s.starts[0]!.intent).toMatchObject({ operation: 'release', targetGeneration: 1, leaseEpoch: 1, providerInstanceId: s.original.intent.providerInstanceId,
            dataVolumeId: s.original.intent.dataVolumeId, fenceToken: s.original.intent.fenceToken, deployment: D });
        expect(s.starts[0]!.intent.jobId).not.toBe(s.original.intent.jobId);
        await s.tick(); // replay RUNNING: no second start
        expect(s.starts).toHaveLength(1);
        s.finish(); await s.tick();
        expect(await s.current()).toMatchObject({ state: 'STOPPED', generation: 1, leaseEpoch: 1, lastError: POOL_RELEASED, lifecycleJobId: null,
            volumeId: s.original.intent.dataVolumeId });
        // Billing ends at the authenticated TerminateInstances result, never at recovery time (NOW).
        expect(s.usage[0]!.stopped_at).toEqual(TERMINATED);
        expect(s.meter.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ endedAt: TERMINATED, reason: 'provider_stop' }));
        expect(s.log).toHaveBeenCalledWith(JSON.stringify({ event: 'pool-recovery-usage-close', computer: s.original.intent.computerId.slice(0, 8),
            basis: 'failed_release_termination', stoppedAt: TERMINATED.toISOString() }));
        await s.tick(); expect(s.starts).toHaveLength(1);
    });

    it('a shutting-down host waits: no start, no write, no history read', async () => {
        const s = failedReleaseSetup(); s.host.state = 'shutting-down';
        const before = await s.current(), writes = cas(s);
        await s.tick();
        expect(s.starts).toHaveLength(0); expect(cas(s)).toBe(writes);
        expect(await s.current()).toEqual(before);
        expect(s.deps.executions!.history).not.toHaveBeenCalled();
        s.host.state = 'terminated'; await s.tick(); expect(s.starts).toHaveLength(1);
    });
    it('a shutting-down host whose disk is still detaching also just waits', async () => {
        const s = failedReleaseSetup(); s.host.state = 'shutting-down';
        s.volume.state = 'in-use'; s.volume.attachments = [{ instanceId: s.original.intent.providerInstanceId!, state: 'detaching' }];
        const before = await s.current();
        await s.tick();
        expect(s.starts).toHaveLength(0); expect(await s.current()).toEqual(before);
    });

    const refusals: [string, (s: Setup) => void, string][] = [
        ['aged out and no history reader', s => { vi.mocked(s.deps.describer!.describeForEnrollment).mockResolvedValue(null); delete (s.deps.executions as { history?: unknown }).history; }, 'history_reader_missing'],
        ['host still stopped (the stopped/attached branch keeps its diagnostic)', s => { s.host.state = 'stopped'; }, 'volume_attachment'],
        ['host running', s => { s.host.state = 'running'; }, 'volume_attachment'],
        ['wrong host id', s => { s.host.instanceId = 'i-99999999999999999'; }, 'instance_identity'],
        ['wrong host type', s => { s.host.instanceType = 'm6i.xlarge'; }, 'instance_identity'],
        ['wrong host zone', s => { s.host.availabilityZoneId = 'aps1-az2'; }, 'instance_identity'],
        ['no launch-template provenance', s => { delete (s.host.tags as Record<string, string>)['aws:ec2launchtemplate:id']; }, 'instance_identity'],
        ['foreign launch template', s => { (s.host.tags as Record<string, string>)['aws:ec2launchtemplate:id'] = 'lt-99999999999999999'; }, 'instance_identity'],
        ['still pooled', s => { (s.host.tags as Record<string, string>)['ezil:pool'] = '1'; }, 'instance_identity'],
        ['contradictory host claim alias', s => { (s.host.tags as Record<string, string>)['ezil:computer'] = '99999999-9999-4999-8999-999999999999'; }, 'instance_identity'],
        ['contradictory host fence alias', s => { (s.host.tags as Record<string, string>)['ezil:fence'] = '99999999-9999-4999-8999-999999999999'; }, 'instance_identity'],
        ['foreign host namespace', s => { (s.host.tags as Record<string, string>)['ezil:namespace'] = 'pilot'; }, 'instance_identity'],
        ['wrong host generation', s => { (s.host.tags as Record<string, string>)['ezil:generation'] = '2'; }, 'instance_identity'],
        ['data disk still mapped', s => { s.host.volumes = [{ volumeId: s.original.intent.dataVolumeId!, deviceName: '/dev/sdf', deleteOnTermination: false, tags: {} }]; }, 'instance_disks'],
        ['retained root mapping', s => { s.host.volumes = [{ volumeId: 'vol-22222222222222222', deviceName: '/dev/sda1', deleteOnTermination: false, tags: {} }]; }, 'instance_disks'],
        ['two root mappings', s => { s.host.volumes = [{ volumeId: 'vol-22222222222222222', deviceName: '/dev/sda1', deleteOnTermination: true, tags: {} },
            { volumeId: 'vol-33333333333333333', deviceName: '/dev/sda1', deleteOnTermination: true, tags: {} }]; }, 'instance_disks'],
        ['extra mapping', s => { s.host.volumes = [{ volumeId: 'vol-22222222222222222', deviceName: '/dev/sda1', deleteOnTermination: true, tags: {} },
            { volumeId: 'vol-33333333333333333', deviceName: '/dev/sdg', deleteOnTermination: true, tags: {} }]; }, 'instance_disks'],
        ['wrong KMS key', s => { s.volume.kmsKeyId = 'arn:aws:kms:ap-south-1:123456789012:key/other'; }, 'volume_identity'],
        ['wrong volume zone', s => { s.volume.zoneId = 'aps1-az2'; }, 'volume_identity'],
        ['unencrypted volume', s => { s.volume.encrypted = false; }, 'volume_identity'],
        ['not gp3', s => { s.volume.volumeType = 'gp2'; }, 'volume_identity'],
        ['volume type unknown', s => { delete s.volume.volumeType; }, 'volume_identity'],
        ['volume size below range', s => { s.volume.sizeGiB = 10; }, 'volume_identity'],
        ['volume size unknown', s => { delete s.volume.sizeGiB; }, 'volume_identity'],
        ['contradictory volume alias', s => { s.volume.tags = { ...s.volume.tags, 'ezil:computer': '99999999-9999-4999-8999-999999999999' }; }, 'volume_identity'],
        ['foreign volume namespace', s => { s.volume.tags = { ...s.volume.tags, 'ezil:namespace': 'pilot' }; }, 'volume_identity'],
        ['volume attached elsewhere', s => { s.volume.state = 'in-use'; s.volume.attachments = [{ instanceId: 'i-99999999999999999', state: 'attached' }]; }, 'volume_attachment'],
        ['volume detaching', s => { s.volume.attachments = [{ instanceId: s.original.intent.providerInstanceId!, state: 'detaching' }]; }, 'volume_attachment'],
        ['volume creating', s => { s.volume.state = 'creating'; }, 'volume_attachment'],
    ];
    it.each(refusals)('refuses %s: no start, usage stays open', async (_name, mutate, error) => {
        const s = failedReleaseSetup(); mutate(s);
        await s.tick();
        expect(s.starts).toHaveLength(0);
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', generation: 1, leaseEpoch: 1, lifecycleJobId: s.original.intent.jobId });
        expect(await s.context()).toEqual({ error });
        expect(s.usage[0]!.stopped_at).toBeNull(); expect(s.meter.stopped).not.toHaveBeenCalled();
    });

    it.each([
        ['in 2099', (c: Record<string, string>) => { c.stoppedAt = '2099-01-01T00:00:00.000Z'; }, true],
        ['before the failed release started', (c: Record<string, string>) => { c.stoppedAt = new Date(START.getTime() - 1).toISOString(); }, true],
        ['after the failed release stopped', (c: Record<string, string>) => { c.stoppedAt = new Date(STOP.getTime() + 1).toISOString(); }, true],
        ['unparseable', (c: Record<string, string>) => { c.stoppedAt = 'not-a-time'; }, true],
        ['missing the source interval', (c: Record<string, string>) => { delete c.sourceStoppedAt; }, true],
        // Self-consistent but moved: only the settlement re-witness against the original release catches it.
        ['source interval moved', (c: Record<string, string>) => { c.sourceStartedAt = new Date(START.getTime() - 3_600_000).toISOString(); c.stoppedAt = new Date(START.getTime() - 60_000).toISOString(); }, false],
    ])('a corrupted saved termination time (%s) never settles or closes usage', async (_name, corrupt, early) => {
        const s = failedReleaseSetup(); await s.tick();
        const row = s.placements[0]!, context = JSON.parse(String(row.last_error).slice('pool_release_recovery:'.length));
        corrupt(context); row.last_error = 'pool_release_recovery:' + JSON.stringify(context);
        if (early) { // detected before replay/settlement, while the replay is still RUNNING
            await s.tick();
            expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED' }); expect(await s.context()).toMatchObject({ error: 'replay_identity' });
        }
        s.finish(); await s.tick(); await s.tick();
        expect((await s.current()).state).not.toBe('STOPPED');
        expect(s.usage[0]!.stopped_at).toBeNull(); expect(s.meter.stopped).not.toHaveBeenCalled();
    });

    it('settlement re-proves the ORIGINAL failed release: a different (still valid) witnessed time refuses', async () => {
        const s = failedReleaseSetup(); await s.tick();
        const h = failedReleaseHistory(s.original);
        const n = h.findIndex(e => e.type === 'TaskSucceeded' && e.taskSucceededEventDetails?.resource === 'terminateInstances');
        for (const e of h.slice(n, n + 2)) e.timestamp = new Date(TERMINATED.getTime() + 10); // the result and its state exit
        expect(proveFailedReleaseTermination(s.failed, h, s.original)?.terminatedAt).toEqual(new Date(TERMINATED.getTime() + 10));
        s.histories.set(s.failed.executionArn!, h);
        s.finish(); await s.tick();
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED' });
        expect(await s.context()).toMatchObject({ error: 'replay_identity', stoppedAt: TERMINATED.toISOString() });
        expect(s.usage[0]!.stopped_at).toBeNull();
    });

    it('a replay execution that started before the witnessed termination never settles', async () => {
        const s = failedReleaseSetup(); await s.tick();
        const e = s.finish(); e.startDate = new Date(TERMINATED.getTime() - 1);
        await s.tick();
        expect((await s.current()).state).not.toBe('STOPPED'); expect(s.usage[0]!.stopped_at).toBeNull();
    });

    it('settlement waits (RECOVERING) while the original failed release cannot be read, then settles', async () => {
        const s = failedReleaseSetup(); await s.tick(); s.finish();
        const history = s.histories.get(s.failed.executionArn!)!; s.histories.delete(s.failed.executionArn!);
        await s.tick();
        expect(await s.current()).toMatchObject({ state: 'RECOVERING' });
        expect(await s.context()).toMatchObject({ error: 'describe_unavailable' });
        expect(s.usage[0]!.stopped_at).toBeNull();
        s.histories.set(s.failed.executionArn!, history); await s.tick();
        expect(await s.current()).toMatchObject({ state: 'STOPPED' }); expect(s.usage[0]!.stopped_at).toEqual(TERMINATED);
    });

    it.each([
        ['a foreign namespace alias', (s: Setup) => { s.volume.tags = { ...s.volume.tags, 'ezil:namespace': 'pilot' }; }],
        ['a foreign computer alias', (s: Setup) => { s.volume.tags = { ...s.volume.tags, 'ezil:computer': '99999999-9999-4999-8999-999999999999' }; }],
    ])('final settlement re-checks every present volume alias: %s added after the reservation refuses', async (_name, mutate) => {
        const s = failedReleaseSetup(); await s.tick(); mutate(s);
        s.finish(); await s.tick();
        expect((await s.current()).state).not.toBe('STOPPED');
        expect(s.usage[0]!.stopped_at).toBeNull();
    });

    it('a concurrent reservation (job CAS) starts exactly one replay', async () => {
        const s = failedReleaseSetup(); const stale = await s.current();
        await Promise.all([applyLifecycleReceipt(s.deps, stale, D), applyLifecycleReceipt(s.deps, stale, D)]);
        expect(s.starts).toHaveLength(1);
    });

    it('a placement whose epoch moved after the read loses the reservation CAS and starts nothing', async () => {
        const s = failedReleaseSetup(); const stale = await s.current();
        s.placements[0]!.lease_epoch = 2;
        await applyLifecycleReceipt(s.deps, stale, D);
        expect(s.starts).toHaveLength(0);
        expect(s.placements[0]).toMatchObject({ state: 'UNCONFIRMED', lease_epoch: 2, lifecycle_job_id: s.original.intent.jobId });
    });

    it('a failed replay is never retried through the terminated branch (one attempt per lifecycle version)', async () => {
        const s = failedReleaseSetup(); await s.tick(); s.finish('FAILED'); await s.tick();
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED' });
        await s.tick(); await s.tick();
        expect(s.starts).toHaveLength(1);
        expect(s.usage[0]!.stopped_at).toBeNull();
    });

    it('after a failed replay, even a new lifecycle version never re-enters the terminated branch (its replay has no witness)', async () => {
        const s = failedReleaseSetup(); await s.tick(); s.finish('FAILED'); await s.tick();
        const next = { ...D, stateMachineVersionArn: D.stateMachineVersionArn.replace(':19', ':20') };
        await applyLifecycleReceipt(s.deps, await s.current(), next);
        expect(s.starts).toHaveLength(1);
        expect(await s.context()).toMatchObject({ error: 'volume_attachment' });
        expect(s.deps.executions!.history).toHaveBeenCalledTimes(1); // only the original failed release's history was ever read
    });

    it('a failed STOP (not a release) never enters the terminated branch', async () => {
        const s = failedReleaseSetup();
        const stop = buildLifecycleWork({ ...fixtureIntent('stop'), deployment: D, targetGeneration: 1, leaseEpoch: 1 });
        s.placements[0]!.lifecycle_job_id = stop.intent.jobId; s.placements[0]!.lifecycle_digest = stop.digest;
        s.executions.set(lifecycleExecutionArn(D, stop.intent.jobId), { ...s.failed, input: stop.input, executionArn: lifecycleExecutionArn(D, stop.intent.jobId) });
        await s.tick();
        expect(s.starts).toHaveLength(0);
        expect(await s.context()).toEqual({ error: 'volume_attachment' });
    });
});

describe('failed-release termination witness (the failed execution\'s own history)', () => {
    type Edit = (h: HistoryEvent[], s: Setup) => HistoryEvent[] | void;
    const at = (h: HistoryEvent[], type: string, resource?: string) => h.find(e => e.type === type
        && (!resource || (Object.values(e).find(v => v && typeof v === 'object' && 'resource' in (v as object)) as { resource?: string } | undefined)?.resource === resource))!;
    const reid = (h: HistoryEvent[]) => h.map((e, n) => ({ ...e, id: n + 1, previousEventId: e.previousEventId === 0 ? 0 : n }));
    const defects: [string, Edit][] = [
        ['truncated output', h => { at(h, 'TaskSucceeded', 'terminateInstances').taskSucceededEventDetails!.outputDetails = { truncated: true }; }],
        ['disconnected task chain', h => { at(h, 'TaskStarted', 'terminateInstances').previousEventId = 1; }],
        ['foreign instance in the request', h => { at(h, 'TaskScheduled', 'terminateInstances').taskScheduledEventDetails!.parameters = JSON.stringify({ InstanceIds: ['i-99999999999999999'] }); }],
        ['foreign instance in the result', h => { const d = at(h, 'TaskSucceeded', 'terminateInstances').taskSucceededEventDetails!;
            d.output = d.output!.replaceAll('i-11111111111111111', 'i-99999999999999999'); }],
        ['shutting-down result, not terminated', h => { const d = at(h, 'TaskSucceeded', 'terminateInstances').taskSucceededEventDetails!;
            d.output = d.output!.replace('"Code":48,"Name":"terminated"', '"Code":32,"Name":"shutting-down"'); }],
        ['no terminate call at all', h => reid(h.filter(e => !JSON.stringify(e).includes('terminateInstances')))],
        ['unanswered terminate', h => reid(h.filter(e => !(e.type === 'TaskSucceeded' && e.taskSucceededEventDetails?.resource === 'terminateInstances')))],
        ['foreign region', h => { at(h, 'TaskScheduled', 'terminateInstances').taskScheduledEventDetails!.region = 'us-east-1'; }],
        ['a non-release provider call (a fully consistent startInstances chain)', h => {
            for (const e of h) {
                const d = (e.taskScheduledEventDetails ?? e.taskStartedEventDetails ?? e.taskSucceededEventDetails) as { resource?: string } | undefined;
                if (d?.resource === 'stopInstances') d.resource = 'startInstances';
                for (const n of [e.stateEnteredEventDetails, e.stateExitedEventDetails]) if (n?.name === 'stopInstances') n.name = 'startInstances';
            } }],
        ['a detach start naming another resource', h => { at(h, 'TaskStarted', 'detachVolume').taskStartedEventDetails!.resource = 'stopInstances'; }],
        ['an extra TaskSubmitted event in a chain', h => { const n = h.indexOf(at(h, 'TaskStarted', 'detachVolume'));
            const submitted = { ...structuredClone(h[n]!), type: 'TaskSubmitted' } as HistoryEvent; delete submitted.taskStartedEventDetails;
            submitted.taskSubmittedEventDetails = { resourceType: 'aws-sdk:ec2', resource: 'detachVolume', output: '{}' };
            const out = [...h.slice(0, n + 1), submitted, ...h.slice(n + 1)].map((e, k) => ({ ...e, id: k + 1 }));
            // Keep every original link: shift references to ids after the insertion; the new event hangs off the TaskStarted.
            return out.map((e, k) => k === n + 1 ? { ...e, previousEventId: n + 1 } : { ...e, previousEventId: e.previousEventId! > n ? e.previousEventId! + 1 : e.previousEventId });
        }],
        ['an unanswered earlier terminate request, even with a later witness', h => {
            const n = h.findIndex(e => e.type === 'TaskStateEntered' && e.stateEnteredEventDetails?.name === 'terminateInstances');
            const extra = h.slice(n, n + 3).map(e => structuredClone(e)); // entered, scheduled, started; never answered
            return reid([...h.slice(0, n), ...extra, ...h.slice(n)]); }],
        ['execution failure not connected to the Fail state', h => { h.at(-1)!.previousEventId = h.at(-1)!.id! - 2; }],
        ['whole history before the execution started', h => h.map(e => ({ ...e, timestamp: new Date(e.timestamp!.getTime() - 3_600_000) }))],
        ['whole history after the execution stopped', h => h.map(e => ({ ...e, timestamp: new Date(e.timestamp!.getTime() + 3_600_000) }))],
        ['detach of a foreign volume', h => { at(h, 'TaskScheduled', 'detachVolume').taskScheduledEventDetails!.parameters = JSON.stringify({ VolumeId: 'vol-99999999999999999', InstanceId: 'i-11111111111111111' }); }],
        ['scheduled outside its own task state', h => { at(h, 'TaskScheduled', 'terminateInstances').previousEventId =
            h.find(e => e.type === 'TaskStateEntered' && e.stateEnteredEventDetails?.name === 'stopInstances')!.id; }],
        ['scheduled after a non-task event', h => { at(h, 'TaskScheduled', 'terminateInstances').previousEventId = 3; }],
        ['no Fail state', h => reid(h.filter(e => e.type !== 'FailStateEntered'))],
        ['succeeded, not failed', h => { const last = h.at(-1)!; last.type = 'ExecutionSucceeded'; }],
        ['different failure error', h => { h.at(-1)!.executionFailedEventDetails!.error = 'States.Timeout'; }],
        ['different failure cause', h => { h.at(-1)!.executionFailedEventDetails!.cause = 'other'; }],
        ['wrong job input (another execution)', (h, s) => { const other = buildLifecycleWork({ ...s.original.intent, jobId: '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d' });
            h[0]!.executionStartedEventDetails!.input = other.input; }],
        ['another state machine version', h => { h[0]!.executionStartedEventDetails!.stateMachineVersionArn = D.stateMachineVersionArn.replace(':19', ':18'); }],
        ['termination before the job started (prestart)', h => { at(h, 'TaskSucceeded', 'terminateInstances').timestamp = new Date(START.getTime() - 1); }],
        ['termination after the execution stopped (future)', h => { at(h, 'TaskSucceeded', 'terminateInstances').timestamp = new Date(STOP.getTime() + 1); }],
        ['out-of-order timestamps', h => { h[5]!.timestamp = new Date(START.getTime()); h[6]!.timestamp = new Date(START.getTime() + 5000); }],
        ['unknown event type', h => { h[2]!.type = 'MapRunStarted'; }],
        ['non-sequential ids', h => { h[3]!.id = 99; }],
        ['too short', h => h.slice(0, 2)],
        // Root early review P2-1: every provider event belongs to one connected, identity-checked chain.
        ['foreign stop output', h => { const d = at(h, 'TaskSucceeded', 'stopInstances').taskSucceededEventDetails!;
            d.output = d.output!.replaceAll('i-11111111111111111', 'i-99999999999999999'); }],
        ['foreign detach output (volume)', h => { const d = at(h, 'TaskSucceeded', 'detachVolume').taskSucceededEventDetails!;
            d.output = d.output!.replace('vol-11111111111111111', 'vol-99999999999999999'); }],
        ['foreign detach output (instance)', h => { const d = at(h, 'TaskSucceeded', 'detachVolume').taskSucceededEventDetails!;
            d.output = d.output!.replace('i-11111111111111111', 'i-99999999999999999'); }],
        ['orphan runInstances result', h => { const n = h.findIndex(e => e.type === 'TaskStateEntered' && e.stateEnteredEventDetails?.name === 'terminateInstances');
            const orphan = { ...structuredClone(at(h, 'TaskSucceeded', 'stopInstances')), taskSucceededEventDetails: { resourceType: 'aws-sdk:ec2', resource: 'runInstances',
                output: JSON.stringify({ Instances: [{ InstanceId: 'i-99999999999999999' }] }), outputDetails: { truncated: false } } };
            orphan.timestamp = h[n - 1]!.timestamp;
            const out = reid([...h.slice(0, n), orphan, ...h.slice(n)]); out[n]!.previousEventId = 2; return out; }],
        ['orphan TaskStarted', h => { const n = h.findIndex(e => e.type === 'TaskStateEntered' && e.stateEnteredEventDetails?.name === 'terminateInstances');
            const orphan = structuredClone(at(h, 'TaskStarted', 'stopInstances')); orphan.timestamp = h[n - 1]!.timestamp;
            const out = reid([...h.slice(0, n), orphan, ...h.slice(n)]); out[n]!.previousEventId = 2; return out; }],
        ['second outcome for one terminate start', h => { const n = h.indexOf(at(h, 'TaskSucceeded', 'terminateInstances'));
            const twin = structuredClone(h[n]!); const out = reid([...h.slice(0, n + 1), twin, ...h.slice(n + 1)]); out[n + 1]!.previousEventId = out[n]!.previousEventId; return out; }],
        ['stop outcome chained to the terminate start', h => { at(h, 'TaskSucceeded', 'stopInstances').previousEventId = at(h, 'TaskStarted', 'terminateInstances').id; }],
        ['a submitted (.sync) task', h => { at(h, 'TaskStarted', 'detachVolume').type = 'TaskSubmitted'; }],
        ['disconnected final-failure ancestry', h => { h.at(-2)!.previousEventId = 1; }],
        ['Fail state reached after a successful observe', h => { const exited = h.find(e => e.id === h.at(-2)!.previousEventId)!;
            const failed = h.find(e => e.id === exited.previousEventId)!; failed.type = 'LambdaFunctionSucceeded'; delete failed.lambdaFunctionFailedEventDetails; }],
        ['orphan observer result', h => { const n = h.findIndex(e => e.type === 'LambdaFunctionSucceeded'); h[n]!.previousEventId = 1; }],
    ];
    it('the intact history proves exactly the witnessed termination time', () => {
        const s = failedReleaseSetup();
        expect(proveFailedReleaseTermination(s.failed, failedReleaseHistory(s.original), s.original))
            .toEqual({ instanceId: s.original.intent.providerInstanceId, executionArn: s.failed.executionArn, terminatedAt: TERMINATED });
    });
    it.each(defects)('refuses %s (aged-out host: no start, usage open)', async (_name, edit) => {
        const s = failedReleaseSetup(); vi.mocked(s.deps.describer!.describeForEnrollment).mockResolvedValue(null);
        const history = failedReleaseHistory(s.original);
        s.histories.set(s.failed.executionArn!, edit(history, s) ?? history);
        expect(proveFailedReleaseTermination(s.failed, s.histories.get(s.failed.executionArn!)!, s.original)).toBeNull();
        await s.tick();
        expect(s.starts).toHaveLength(0);
        expect(await s.context()).toEqual({ error: 'termination_not_proven' });
        expect(s.usage[0]!.stopped_at).toBeNull();
    });
    it.each([
        ['execution not FAILED', (s: Setup) => { s.failed.status = 'SUCCEEDED'; }],
        ['redriven execution', (s: Setup) => { s.failed.redriveCount = 1; }],
        ['execution input differs from the job', (s: Setup) => { s.failed.input = s.failed.input + ' '; }],
        ['execution stopped before it started', (s: Setup) => { s.failed.stopDate = new Date(START.getTime() - 1); }],
    ])('the proof itself refuses %s', (_name, mutate) => {
        const s = failedReleaseSetup(); mutate(s);
        expect(proveFailedReleaseTermination(s.failed, failedReleaseHistory(s.original), s.original)).toBeNull();
    });
    it('only a release can be witnessed', () => {
        const s = failedReleaseSetup();
        const stop = buildLifecycleWork({ ...s.original.intent, operation: 'stop' });
        expect(proveFailedReleaseTermination({ ...s.failed, input: stop.input, executionArn: lifecycleExecutionArn(D, stop.intent.jobId) },
            failedReleaseHistory(stop), stop)).toBeNull();
    });
});

describe('reconcile-release operator consumer', () => {
    const request = (s: Setup, over: Partial<ReconcileReleaseRequest> = {}): ReconcileReleaseRequest => ({ schemaVersion: 1, operation: 'reconcile-release',
        computerId: s.original.intent.computerId, expectedJobId: s.original.intent.jobId, releaseExecutionArn: s.failed.executionArn!, ...over });
    it('recovering, then settled for the reserved replay job; the original job no longer applies', async () => {
        const s = failedReleaseSetup();
        expect(await reconcileFailedRelease(s.deps, { [D.region]: D }, request(s))).toEqual({ outcome: 'recovering', error: null });
        expect(s.starts).toHaveLength(1);
        const replay = s.starts[0]!.intent.jobId, arn = lifecycleExecutionArn(D, replay);
        expect(await reconcileFailedRelease(s.deps, { [D.region]: D }, request(s))).toEqual({ outcome: 'not_applicable', error: null });
        expect(await reconcileFailedRelease(s.deps, { [D.region]: D }, request(s, { expectedJobId: replay, releaseExecutionArn: arn }))).toEqual({ outcome: 'recovering', error: null });
        s.finish();
        expect(await reconcileFailedRelease(s.deps, { [D.region]: D }, request(s, { expectedJobId: replay, releaseExecutionArn: arn }))).toEqual({ outcome: 'settled', error: null });
        expect(s.usage[0]!.stopped_at).toEqual(TERMINATED);
        expect(s.starts).toHaveLength(1);
    });
    it('waiting for a shutting-down host; source_not_proven without a witness; unconfirmed on an identity refusal', async () => {
        const w = failedReleaseSetup(); w.host.state = 'shutting-down';
        expect(await reconcileFailedRelease(w.deps, { [D.region]: D }, request(w))).toEqual({ outcome: 'waiting', error: null });
        const p = failedReleaseSetup(); vi.mocked(p.deps.describer!.describeForEnrollment).mockResolvedValue(null);
        p.histories.set(p.failed.executionArn!, failedReleaseHistory(p.original).filter(e => e.type !== 'FailStateEntered'));
        expect(await reconcileFailedRelease(p.deps, { [D.region]: D }, request(p))).toEqual({ outcome: 'source_not_proven', error: 'termination_not_proven' });
        expect(await reconcileFailedRelease(p.deps, { [D.region]: D }, request(p))).toEqual({ outcome: 'source_not_proven', error: 'termination_not_proven' });
        const k = failedReleaseSetup(); k.volume.kmsKeyId = 'other';
        expect(await reconcileFailedRelease(k.deps, { [D.region]: D }, request(k))).toEqual({ outcome: 'unconfirmed', error: 'volume_identity' });
        for (const s of [w, p, k]) expect(s.starts).toHaveLength(0);
    });
    it.each([
        ['a different expected job', (s: Setup) => request(s, { expectedJobId: '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d' }), 'not_applicable'],
        ['a hint naming another execution', (s: Setup) => request(s, { releaseExecutionArn: lifecycleExecutionArn(D, '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d') }), 'source_not_proven'],
        ['a hint on another machine', (s: Setup) => request(s, { releaseExecutionArn: s.failed.executionArn!.replace('ezil-mum-lifecycle', 'ezil-other') }), 'source_not_proven'],
        ['another computer', (s: Setup) => request(s, { computerId: '99999999-9999-4999-8999-999999999999' }), 'not_applicable'],
    ] as const)('%s → %s, nothing started or written', async (_name, build, outcome) => {
        const s = failedReleaseSetup(); const before = await s.current();
        expect((await reconcileFailedRelease(s.deps, { [D.region]: D }, build(s))).outcome).toBe(outcome);
        expect(s.starts).toHaveLength(0); expect(await s.current()).toEqual(before);
    });
    it('refuses a foreign owner, a deleted computer, a non-pool deployment, a STOPPED row and a RECOVERING row without this replay', async () => {
        const cases: ((s: Setup) => Record<string, typeof D> | void)[] = [
            s => { s.computers[0]!.user_id = '99999999-9999-4999-8999-999999999999'; },
            s => { s.computers[0]!.deleted_at = NOW; },
            () => ({ [D.region]: { ...D, namespace: 'pilot' } }),
            s => { s.placements[0]!.state = 'STOPPED'; },
            s => { s.placements[0]!.state = 'RECOVERING'; },
        ];
        for (const edit of cases) {
            const s = failedReleaseSetup(); const deployments = edit(s) ?? { [D.region]: D };
            expect((await reconcileFailedRelease(s.deps, deployments, request(s))).outcome).toBe('not_applicable');
            expect(s.starts).toHaveLength(0);
        }
    });
    it('refuses an UNCONFIRMED row whose expected job is not a release', async () => {
        const s = failedReleaseSetup();
        const stop = buildLifecycleWork({ ...fixtureIntent('stop'), deployment: D, targetGeneration: 1, leaseEpoch: 1 });
        s.placements[0]!.lifecycle_job_id = stop.intent.jobId; s.placements[0]!.lifecycle_digest = stop.digest;
        s.executions.set(lifecycleExecutionArn(D, stop.intent.jobId), { ...s.failed, input: stop.input, executionArn: lifecycleExecutionArn(D, stop.intent.jobId) });
        expect((await reconcileFailedRelease(s.deps, { [D.region]: D }, request(s, { expectedJobId: stop.intent.jobId,
            releaseExecutionArn: lifecycleExecutionArn(D, stop.intent.jobId) }))).outcome).toBe('not_applicable');
        expect(s.starts).toHaveLength(0);
    });
});

// Root reviewer's exact in-memory repros (team/ROOT-CONTINUE-118-1529.md), with the "required instead" assertions.
describe('root reviewer exact repros (ROOT-CONTINUE-118-1529)', () => {
    const edits: [string, (h: HistoryEvent[]) => void][] = [
        ['foreign stop output', h => {
            h.find(e => e.type === 'TaskSucceeded' && e.taskSucceededEventDetails?.resource === 'stopInstances')!
                .taskSucceededEventDetails!.output = JSON.stringify({ StoppingInstances: [{ InstanceId: 'i-99999999999999999', CurrentState: { Code: 64, Name: 'stopping' } }] });
        }],
        ['foreign detach output', h => {
            h.find(e => e.type === 'TaskSucceeded' && e.taskSucceededEventDetails?.resource === 'detachVolume')!
                .taskSucceededEventDetails!.output = JSON.stringify({ InstanceId: 'i-99999999999999999', VolumeId: 'vol-99999999999999999' });
        }],
        ['orphan RunInstances result (a provider result chained to a Lambda start)', h => {
            const e = h.find(x => x.type === 'LambdaFunctionSucceeded')!;
            e.type = 'TaskSucceeded'; delete e.lambdaFunctionSucceededEventDetails;
            e.taskSucceededEventDetails = { resourceType: 'aws-sdk:ec2', resource: 'runInstances', output: '{"Instances":[{"InstanceId":"i-99999999999999999"}]}' };
        }],
        ['disconnected final failure', h => { h.at(-2)!.previousEventId = 1; }],
    ];
    it.each(edits)('%s: proof null, zero starts, UNCONFIRMED, usage open, no meter stop', async (_name, mutate) => {
        const s = failedReleaseSetup();
        const h = failedReleaseHistory(s.original);
        mutate(h);
        s.histories.set(s.failed.executionArn!, h);
        const proof = proveFailedReleaseTermination(s.failed, h, s.original);
        await s.tick();
        expect(proof).toBeNull();
        expect(s.starts).toHaveLength(0);
        expect((await s.current()).state).toBe('UNCONFIRMED');
        expect(s.usage[0]!.stopped_at).toBeNull();
        expect(s.meter.stopped).not.toHaveBeenCalled();
    });

    it('preserves the legitimate AWS zero predecessor (PassStateEntered 2 -> 0)', () => {
        const s = failedReleaseSetup();
        const h = failedReleaseHistory(s.original);
        expect(h[1]!.type).toBe('PassStateEntered'); h[1]!.previousEventId = 0;
        expect(proveFailedReleaseTermination(s.failed, h, s.original)?.terminatedAt).toEqual(TERMINATED);
    });

    it.each([
        ['future', '2099-01-01T00:00:00.000Z'],
        ['before source start', new Date(START.getTime() - 1).toISOString()],
    ])('%s saved termination time: never STOPPED, usage open, no meter stop, one start', async (_name, badTime) => {
        const s = failedReleaseSetup();
        await s.tick();
        expect(s.starts).toHaveLength(1);
        const context = await s.context();
        context.stoppedAt = badTime;
        s.placements[0]!.last_error = 'pool_release_recovery:' + JSON.stringify(context);
        s.finish();
        await s.tick();
        expect((await s.current()).state).not.toBe('STOPPED');
        expect(s.usage[0]!.stopped_at).toBeNull();
        expect(s.meter.stopped).not.toHaveBeenCalled();
        expect(s.starts).toHaveLength(1);
    });

    it('refuses a conflicting current volume namespace at settlement', async () => {
        const s = failedReleaseSetup();
        await s.tick();
        expect(s.starts).toHaveLength(1);
        (s.volume.tags as Record<string, string>)['ezil:namespace'] = 'foreign';
        s.finish();
        await s.tick();
        expect((await s.current()).state).not.toBe('STOPPED');
        expect(s.usage[0]!.stopped_at).toBeNull();
        expect(s.meter.stopped).not.toHaveBeenCalled();
        expect(s.starts).toHaveLength(1);
    });
});
