import { describe, expect, it } from 'vitest';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { proveHistoricalSource, reconcileReplacementWithHistoricalSource, terminationWitnessed } from './aws-historical-source';
import { historicalSourceSetup, releaseHistory, REPLACE_JOB } from './aws-historical-source.test-support';
import { ImageJobConflictError } from './placement';

type Setup = Awaited<ReturnType<typeof historicalSourceSetup>>;
const run = (s: Setup) => reconcileReplacementWithHistoricalSource(s.deps, s.deployments, s.request);
const untouched = (s: Setup) => expect(s.placements[0]).toMatchObject({ state: 'UNCONFIRMED', generation: s.replace.intent.targetGeneration,
    lease_epoch: s.replace.intent.leaseEpoch, lifecycle_job_id: REPLACE_JOB, instance_id: null });

describe('reconcile-replacement with an authenticated historical source (1.0.16 canary shape)', () => {
    it('settles the vanished released source to its proven generation, keeps the epoch, revokes job authority, fences the tunnel, starts nothing', async () => {
        const s = await historicalSourceSetup();
        expect(await run(s)).toBe('settled');
        expect(await s.current()).toMatchObject({ state: 'STOPPED', generation: s.stopped.generation, fenceToken: s.stopped.fenceToken,
            instanceId: s.stopped.instanceId, leaseEpoch: s.replace.intent.leaseEpoch, lastError: 'instance_lost',
            lifecycleJobId: null, lifecycleDigest: null, enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null });
        expect(s.tunnels.deleteTunnel).toHaveBeenCalledTimes(1);
        expect(s.starts).toHaveLength(1);
        // Replay after settlement: the failed job no longer exists, so nothing else happens.
        expect(await run(s)).toBe('not_applicable');
        expect(s.tunnels.deleteTunnel).toHaveBeenCalledTimes(1);
    });
    it('the witness reads the release exactly as recorded: real adopt-recovery input, not a hint', async () => {
        const s = await historicalSourceSetup();
        const proof = proveHistoricalSource(s.releaseExecution, s.histories.get(s.releaseArn)!, s.replace, s.replaceExecution.startDate, s.releaseArn);
        expect(proof).toEqual({ instanceId: s.stopped.instanceId, releaseExecutionArn: s.releaseArn });
        expect(JSON.parse(JSON.parse(s.release.input).document).adoptRecoverRelease).toBeDefined();
    });

    const placementCases: [string, (s: Setup) => void, string][] = [
        ['another expected job', s => { s.request.expectedJobId = '11111111-1111-4111-8111-111111111111'; }, 'not_applicable'],
        ['a deleted computer', s => { s.computers[0]!.deleted_at = new Date(); }, 'not_applicable'],
        ['no history reader', s => { (s.deps.executions as { history?: unknown }).history = undefined; }, 'not_applicable'],
        ['an unreadable failed-replace history', s => { s.histories.delete(s.replaceExecution.executionArn!); }, 'launch_not_disproven'],
        ['a launch entered in the failed replace', s => { s.histories.get(s.replaceExecution.executionArn!)![3]!.stateEnteredEventDetails = { name: 'runInstances' }; }, 'launch_not_disproven'],
        ['a hint for another machine', s => { s.request.sourceRetirementExecutionArn = s.releaseArn.replace('ezil-mum-lifecycle', 'ezil-other-lifecycle'); }, 'source_not_proven'],
        ['a malformed hint', s => { s.request.sourceRetirementExecutionArn = s.releaseArn + 'x'; }, 'source_not_proven'],
        ['the failed replace itself as the hint', s => { s.request.sourceRetirementExecutionArn = s.replaceExecution.executionArn!; }, 'source_not_proven'],
    ];
    it.each(placementCases)('%s changes nothing', async (_label, edit, outcome) => {
        const s = await historicalSourceSetup(); edit(s);
        expect(await run(s)).toBe(outcome); untouched(s);
        expect(s.tunnels.deleteTunnel).not.toHaveBeenCalled();
    });
    it('an image reservation refuses before any read', async () => {
        const s = await historicalSourceSetup(); s.placements[0]!.image_upgrade_job_id = '11111111-1111-4111-8111-111111111111';
        await expect(run(s)).rejects.toBeInstanceOf(ImageJobConflictError);
        expect(s.executions.describe).not.toHaveBeenCalled(); untouched(s);
    });
    it('an unknown hint execution refuses with an error and changes nothing', async () => {
        const s = await historicalSourceSetup(); s.executionMap.delete(s.releaseArn);
        await expect(run(s)).rejects.toThrow(); untouched(s);
    });

    const terminate = (h: HistoryEvent[]) => h.find(e => e.type === 'TaskSucceeded' && e.taskSucceededEventDetails?.resource === 'terminateInstances')!;
    const output = (instanceId: string, code: number, name: string) => JSON.stringify({ TerminatingInstances: [{ CurrentState: { Code: code, Name: name }, InstanceId: instanceId }] });
    const sourceCases: [string, (s: Setup) => void][] = [
        ['only shutting-down acknowledged', s => { s.histories.set(s.releaseArn, releaseHistory(s.release.input, s.releaseExecution.output!, s.stopped.instanceId!,
            s.releaseExecution.startDate!, { Code: 32, Name: 'shutting-down' })); }],
        // Root final review (12:43Z): contradictory execution/history bindings.
        ['a Describe answer for another execution than the hint', s => { s.executionMap.get(s.releaseArn)!.executionArn = s.releaseArn.replace(/.$/, c => c === '0' ? '1' : '0'); }],
        ['terminal history output that differs from the Describe receipt', s => { const h = s.histories.get(s.releaseArn)!; h.at(-1)!.executionSucceededEventDetails = { output: '{}' }; }],
        ['a missing source start', s => { s.executionMap.get(s.releaseArn)!.startDate = undefined; }],
        ['a source start after its stop', s => { const e = s.executionMap.get(s.releaseArn)!; e.startDate = new Date(e.stopDate!.getTime() + 1); }],
        ['a witness timestamped after the replace started', s => { terminate(s.histories.get(s.releaseArn)!).timestamp = new Date(s.replaceExecution.startDate!.getTime() + 1); }],
        ['a history event before the source started', s => { s.histories.get(s.releaseArn)![1]!.timestamp = new Date(s.releaseExecution.startDate!.getTime() - 1); }],
        ['a terminate scheduled in another region', s => { s.histories.get(s.releaseArn)!.find(e => e.type === 'TaskScheduled')!.taskScheduledEventDetails!.region = 'us-east-1'; }],
        ['a connected TaskStarted for runInstances', s => { s.histories.get(s.releaseArn)!.find(e => e.type === 'TaskStarted')!.taskStartedEventDetails = { resource: 'runInstances', resourceType: 'aws-sdk:ec2' }; }],
        ['a TaskSucceeded of another resource type', s => { terminate(s.histories.get(s.releaseArn)!).taskSucceededEventDetails!.resourceType = 'aws-sdk:lambda'; }],
        ['Code 48 without Name terminated', s => { terminate(s.histories.get(s.releaseArn)!).taskSucceededEventDetails!.output = output(s.stopped.instanceId!, 48, 'shutting-down'); }],
        ['Name terminated without Code 48', s => { terminate(s.histories.get(s.releaseArn)!).taskSucceededEventDetails!.output = output(s.stopped.instanceId!, 32, 'terminated'); }],
        ['a witness for another instance', s => { terminate(s.histories.get(s.releaseArn)!).taskSucceededEventDetails!.output = output('i-0ffffffffffffffff', 48, 'terminated'); }],
        ['a terminate request for another instance', s => { s.histories.get(s.releaseArn)!.find(e => e.type === 'TaskScheduled')!.taskScheduledEventDetails!.parameters = JSON.stringify({ InstanceIds: ['i-0ffffffffffffffff'] }); }],
        ['a broken witness chain', s => { const h = s.histories.get(s.releaseArn)!; terminate(h).previousEventId = 1; }],
        ['receipt-only retirement (no terminate call)', s => { s.histories.set(s.releaseArn, s.histories.get(s.releaseArn)!.filter(e => !(e.type === 'TaskScheduled' || e.type === 'TaskStarted' || e.type === 'TaskSucceeded'))); }],
        ['a truncated event', s => { terminate(s.histories.get(s.releaseArn)!).taskSucceededEventDetails!.outputDetails = { truncated: true }; }],
        ['an id gap', s => { s.histories.set(s.releaseArn, s.histories.get(s.releaseArn)!.filter(e => e.id !== 3)); }],
        ['another started input', s => { s.histories.get(s.releaseArn)![0]!.executionStartedEventDetails = { input: '{}' }; }],
        ['an incomplete (non-terminal) history', s => { s.histories.set(s.releaseArn, s.histories.get(s.releaseArn)!.slice(0, -1)); }],
        ['a failed release', s => { s.executionMap.get(s.releaseArn)!.status = 'FAILED'; }],
        ['a redriven release', s => { s.executionMap.get(s.releaseArn)!.redriveCount = 1; }],
        ['an aliased release', s => { s.executionMap.get(s.releaseArn)!.stateMachineAliasArn = 'alias'; }],
        ['a release that finished after the replace started', s => { s.executionMap.get(s.releaseArn)!.stopDate = new Date(s.replaceExecution.startDate!.getTime() + 1); }],
        ['a receipt that lost its instance', s => { const e = s.executionMap.get(s.releaseArn)!; e.output = JSON.stringify({ ...JSON.parse(e.output!), instanceLost: true }); }],
        ['a receipt for another volume', s => { const e = s.executionMap.get(s.releaseArn)!; e.output = JSON.stringify({ ...JSON.parse(e.output!), volumeId: 'vol-0ffffffffffffffff' }); }],
        ['a release of another generation', s => { const e = s.executionMap.get(s.releaseArn)!; e.output = JSON.stringify({ ...JSON.parse(e.output!), generation: 4 }); }],
        ['a terminate call scheduled from another state', s => { const h = s.histories.get(s.releaseArn)!;
            const scheduled = h.find(e => e.type === 'TaskScheduled')!; h.find(e => e.id === scheduled.previousEventId)!.stateEnteredEventDetails = { name: 'detachVolume' }; }],
        ['a history ending in a second start instead of success', s => { const h = s.histories.get(s.releaseArn)!;
            h[h.length - 1] = { ...h[h.length - 1]!, type: 'ExecutionStarted', executionSucceededEventDetails: undefined, executionStartedEventDetails: { input: s.release.input } }; }],
        ['a tampered release input', s => { const e = s.executionMap.get(s.releaseArn)!; e.input = e.input!.replace('"schemaVersion":1', '"schemaVersion":1 '); }],
    ];
    it.each(sourceCases)('%s is not a source proof', async (_label, edit) => {
        const s = await historicalSourceSetup(); edit(s);
        expect(await run(s)).toBe('source_not_proven'); untouched(s);
        expect(s.tunnels.deleteTunnel).not.toHaveBeenCalled();
    });

    const settlementCases: [string, (s: Setup) => void][] = [
        ['a still-listed source with a contradictory alias', s => { s.describer.describeForEnrollment.mockResolvedValue({ instanceId: s.stopped.instanceId!, state: 'terminated',
            availabilityZone: 'ap-south-1a', availabilityZoneId: s.deployment.zoneId, publicIp: null, volumes: [],
            tags: { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': s.deployment.namespace, 'ezil:computer-id': s.stopped.computerId,
                'ezil:generation': String(s.stopped.generation), 'ezil:fence-token': s.stopped.fenceToken!, 'ezil:fence': '11111111-1111-4111-8111-111111111111' } }); }],
        ['a discovered writer', s => { s.describer.describeReplacementWriters.mockResolvedValue([{ instanceId: 'i-0eeeeeeeeeeeeeeee', state: 'terminated', tags: {},
            accountId: s.deployment.accountId, clientToken: '' }] as never[]); }],
        ['an attached volume', s => { s.volume.state = 'in-use'; s.volume.attachments = [{ instanceId: s.stopped.instanceId!, state: 'attached' }]; }],
        ['a volume tagged for another generation', s => { s.volume.tags = { ...s.volume.tags, 'ezil:generation': '9' }; }],
        // Root final review (12:43Z): the current volume of an absent-source settlement.
        ['a volume in another zone', s => { (s.volume as { zoneId?: string }).zoneId = 'aps1-az99'; }],
        ['a volume without a zone', s => { delete (s.volume as { zoneId?: string }).zoneId; }],
        ['a volume with a foreign computer alias', s => { s.volume.tags = { ...s.volume.tags, 'ezil:computer': '11111111-1111-4111-8111-111111111111' }; }],
        ['a volume with a foreign fence alias', s => { s.volume.tags = { ...s.volume.tags, 'ezil:fence': '11111111-1111-4111-8111-111111111111' }; }],
        ['a volume with a foreign namespace alias', s => { s.volume.tags = { ...s.volume.tags, 'ezil:namespace': 'foreign' }; }],
        ['a failed tunnel fence', s => { s.tunnels.deleteTunnel.mockResolvedValue({ ok: false } as never); }],
        ['a concurrent epoch 9', s => { const describe = s.describer.describeVolume.getMockImplementation()!;
            s.describer.describeVolume.mockImplementation(async (...args) => { s.placements[0]!.lease_epoch = 9; return describe(...args); }); }],
    ];
    it.each(settlementCases)('%s keeps the placement unsettled', async (_label, edit) => {
        const s = await historicalSourceSetup(); edit(s);
        expect(['unconfirmed', 'generation_drift']).toContain(await run(s));
        expect(s.placements[0]).toMatchObject({ state: 'UNCONFIRMED', generation: s.replace.intent.targetGeneration, lifecycle_job_id: REPLACE_JOB });
    });

    it('the release must precede the replace epoch (never a later or equal historical lease)', async () => {
        const s = await historicalSourceSetup(), h = s.histories.get(s.releaseArn)!;
        const at = (leaseEpoch: number) => proveHistoricalSource(s.releaseExecution, h, { ...s.replace, intent: { ...s.replace.intent, leaseEpoch } }, s.replaceExecution.startDate, s.releaseArn);
        expect(at(s.replace.intent.leaseEpoch)).not.toBeNull();
        expect(at(s.release.intent.leaseEpoch)).toBeNull();
        expect(at(s.release.intent.leaseEpoch - 1)).toBeNull();
    });
    it('terminationWitnessed requires every terminate request to be answered', async () => {
        const s = await historicalSourceSetup(), h = s.histories.get(s.releaseArn)!;
        const bounds = { input: s.release.input, output: s.releaseExecution.output!, startedAt: s.releaseExecution.startDate!, stoppedAt: s.releaseExecution.stopDate!, region: s.deployment.region };
        expect(terminationWitnessed(h, bounds, s.stopped.instanceId!)).toBe(true);
        const unanswered = h.filter(e => !(e.type === 'TaskSucceeded' && e.taskSucceededEventDetails?.resource === 'terminateInstances'));
        expect(terminationWitnessed(unanswered.map((e, n) => ({ ...e, id: n + 1, previousEventId: n })), bounds, s.stopped.instanceId!)).toBe(false);
        // Valid zero predecessors (the first state entered after ExecutionStarted) stay valid.
        expect(terminationWitnessed(h.map(e => e.id === 2 ? { ...e, previousEventId: 0 } : e), bounds, s.stopped.instanceId!)).toBe(true);
    });
});
