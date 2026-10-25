import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));
import { D, failedReleaseSetup, START, STOP, TERMINATED } from './aws-failed-release.test-support';
import { reconcileFailedRelease, reconcilePoolReleaseRecovery } from './aws-pool-release-recovery';
import { applyLifecycleReceipt, lifecycleExecutionArn, POOL_RELEASED } from './aws-receipts';

afterEach(() => vi.restoreAllMocks());
const currentDeployment = { ...D, stateMachineVersionArn: D.stateMachineVersionArn.replace(':19', ':20') };
type Setup = ReturnType<typeof failedReleaseSetup>;
const proofKeys = ['basis', 'sourceJobId', 'sourceExecutionArn', 'sourceDigest', 'sourceStateMachineVersionArn',
    'sourceStartedAt', 'sourceStoppedAt', 'stoppedAt'] as const;
const proof = (context: Record<string, unknown>) => Object.fromEntries(proofKeys.map(k => [k, context[k]]));
async function failedReplay() {
    const s = failedReleaseSetup();
    await s.tick();
    const originalProof = proof(await s.context());
    const e = s.finish('FAILED');
    e.error = 'LifecycleUnconfirmed'; e.cause = 'initial Lambda explicitDeny';
    // No EC2 work/witness in this replay. Only the original source history may be read.
    s.histories.set(e.executionArn!, []);
    await s.tick();
    const replayJob = (await s.current()).lifecycleJobId!;
    const request = { schemaVersion: 1 as const, operation: 'reconcile-release' as const,
        computerId: s.original.intent.computerId, expectedJobId: replayJob,
        releaseExecutionArn: lifecycleExecutionArn(D, replayJob) };
    const retry = () => reconcileFailedRelease(s.deps, { [D.region]: currentDeployment }, request);
    return { ...s, originalProof, request, retry };
}

describe('failed termination replay on a promoted deployment', () => {
    it.each([false, true])('retries once with original proof, absent host=%s, then re-witnesses and closes at original cutoff', async absent => {
        const s = await failedReplay();
        if (absent) vi.mocked(s.deps.describer!.describeForEnrollment).mockResolvedValue(null);
        expect(await s.retry()).toEqual({ outcome: 'recovering', error: null });
        expect(s.starts).toHaveLength(2);
        const next = s.starts[1]!;
        expect(next.intent).toMatchObject({ operation: 'release', deployment: currentDeployment, targetGeneration: 1, leaseEpoch: 1,
            providerInstanceId: s.original.intent.providerInstanceId, dataVolumeId: s.original.intent.dataVolumeId,
            fenceToken: s.original.intent.fenceToken });
        expect(next.intent.jobId).not.toBe(s.request.expectedJobId);
        expect(proof(await s.context())).toEqual(s.originalProof);
        expect(s.usage[0]!.stopped_at).toBeNull(); expect(s.meter.stopped).not.toHaveBeenCalled();
        expect(await s.retry()).toEqual({ outcome: 'not_applicable', error: null }); // stale replay job
        await reconcilePoolReleaseRecovery(s.deps, await s.current(), currentDeployment); // RUNNING
        expect(s.starts).toHaveLength(2);
        s.finish();
        await reconcilePoolReleaseRecovery(s.deps, await s.current(), currentDeployment);
        expect(await s.current()).toMatchObject({ state: 'STOPPED', generation: 1, leaseEpoch: 1, lastError: POOL_RELEASED });
        expect(s.usage[0]!.stopped_at).toEqual(TERMINATED);
        expect(s.meter.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ endedAt: TERMINATED }));
        expect(vi.mocked(s.deps.executions.history!).mock.calls.every(([, arn]) => arn === s.failed.executionArn)).toBe(true);
    });

    it('same version suppresses retries; promoted concurrent callers reserve exactly one execution', async () => {
        const s = await failedReplay();
        await s.tick(); await s.tick(); expect(s.starts).toHaveLength(1);
        expect(await s.context()).toMatchObject({ error: 'recovery_retry_awaits_new_deployment' });
        const stale = await s.current();
        await Promise.all([reconcilePoolReleaseRecovery(s.deps, stale, currentDeployment), reconcilePoolReleaseRecovery(s.deps, stale, currentDeployment)]);
        expect(s.starts).toHaveLength(2); expect(proof(await s.context())).toEqual(s.originalProof);
        s.finish('FAILED'); await reconcilePoolReleaseRecovery(s.deps, await s.current(), currentDeployment);
        await reconcilePoolReleaseRecovery(s.deps, await s.current(), currentDeployment);
        expect(s.starts).toHaveLength(2); expect(s.usage[0]!.stopped_at).toBeNull();
    });

    it.each([false, true])('preserves original version-19 proof through failed 19 and 20 replays, then settles on 21; absent=%s', async absent => {
        const s = await failedReplay();
        if (absent) vi.mocked(s.deps.describer!.describeForEnrollment).mockResolvedValue(null);
        const originalProof = { basis: 'failed_release_termination', sourceJobId: s.original.intent.jobId,
            sourceExecutionArn: s.failed.executionArn, sourceDigest: s.original.digest, sourceStateMachineVersionArn: D.stateMachineVersionArn,
            sourceStartedAt: START.toISOString(), sourceStoppedAt: STOP.toISOString(), stoppedAt: TERMINATED.toISOString() };
        const unchangedIdentity = { generation: 1, leaseEpoch: 1, instanceId: s.original.intent.providerInstanceId,
            volumeId: s.original.intent.dataVolumeId, fenceToken: s.original.intent.fenceToken };
        const stillOpen = async (starts: number) => {
            expect(s.starts).toHaveLength(starts);
            expect(proof(await s.context())).toEqual(originalProof);
            expect(await s.current()).toMatchObject(unchangedIdentity);
            expect(s.usage[0]!.stopped_at).toBeNull();
            expect(s.meter.stopped).not.toHaveBeenCalled();
        };
        await stillOpen(1); // original release -> failed version-19 replay
        for (let n = 0; n < 3; n++) {
            await s.tick();
            expect(await s.context()).toMatchObject({ error: 'recovery_retry_awaits_new_deployment' });
            await stillOpen(1);
        }
        // Infrastructure may already be 21, but the installed app still selects 20 during rollout.
        expect(await s.retry()).toEqual({ outcome: 'recovering', error: null });
        expect(s.starts[1]!.stateMachineArn).toBe(currentDeployment.stateMachineVersionArn);
        await stillOpen(2);
        await applyLifecycleReceipt(s.deps, await s.current(), currentDeployment); // running version 20
        await stillOpen(2);
        const failed20 = s.finish('FAILED');
        failed20.error = 'LifecycleUnconfirmed'; failed20.cause = 'initial Lambda explicitDeny';
        s.histories.set(failed20.executionArn!, []); // neither replay supplies a termination witness
        await applyLifecycleReceipt(s.deps, await s.current(), currentDeployment);
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED' });
        await stillOpen(2);
        for (let n = 0; n < 3; n++) { // minute reconciler before app promotion must not create more version-20 jobs
            await applyLifecycleReceipt(s.deps, await s.current(), currentDeployment);
            expect(await s.context()).toMatchObject({ error: 'recovery_retry_awaits_new_deployment' });
            await stillOpen(2);
        }
        const promoted = { ...D, stateMachineVersionArn: D.stateMachineVersionArn.replace(':19', ':21') };
        const request20 = { ...s.request, expectedJobId: s.starts[1]!.intent.jobId, releaseExecutionArn: failed20.executionArn! };
        expect(await reconcileFailedRelease(s.deps, { [D.region]: promoted }, request20)).toEqual({ outcome: 'recovering', error: null });
        await stillOpen(3);
        expect(s.starts.map(w => w.stateMachineArn)).toEqual([D.stateMachineVersionArn, currentDeployment.stateMachineVersionArn, promoted.stateMachineVersionArn]);
        expect(new Set(s.starts.map(w => w.intent.jobId)).size).toBe(3);
        expect(s.starts.every(w => w.intent.operation === 'release')).toBe(true);
        expect(await reconcileFailedRelease(s.deps, { [D.region]: promoted }, request20)).toEqual({ outcome: 'not_applicable', error: null });
        await applyLifecycleReceipt(s.deps, await s.current(), promoted); // running version 21
        await stillOpen(3);
        const historyReads = vi.mocked(s.deps.executions.history!).mock.calls.length;
        s.finish();
        const request21 = { ...s.request, expectedJobId: s.starts[2]!.intent.jobId,
            releaseExecutionArn: lifecycleExecutionArn(promoted, s.starts[2]!.intent.jobId) };
        expect(await reconcileFailedRelease(s.deps, { [D.region]: promoted }, request21)).toEqual({ outcome: 'settled', error: null });
        expect(await s.current()).toMatchObject({ ...unchangedIdentity, state: 'STOPPED', lastError: POOL_RELEASED, lifecycleJobId: null });
        expect(s.deps.executions.history).toHaveBeenCalledTimes(historyReads + 1); // settlement re-witnesses the original again
        expect(vi.mocked(s.deps.executions.history!).mock.calls.every(([, arn]) => arn === originalProof.sourceExecutionArn)).toBe(true);
        expect(s.usage[0]!.stopped_at).toEqual(TERMINATED);
        expect(s.meter.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ endedAt: TERMINATED }));
        expect(await reconcileFailedRelease(s.deps, { [D.region]: promoted }, request21)).toEqual({ outcome: 'not_applicable', error: null });
        expect(s.starts).toHaveLength(3); expect(s.meter.stopped).toHaveBeenCalledTimes(1);
    });

    it('a moved epoch defeats the existing CAS', async () => {
        const s = await failedReplay(), stale = await s.current();
        s.placements[0]!.lease_epoch = 2;
        await reconcilePoolReleaseRecovery(s.deps, stale, currentDeployment);
        expect(s.starts).toHaveLength(1); expect(s.usage[0]!.stopped_at).toBeNull();
    });

    it('the hint must name the current replay, never the original source', async () => {
        const s = await failedReplay();
        const result = await reconcileFailedRelease(s.deps, { [D.region]: currentDeployment },
            { ...s.request, releaseExecutionArn: s.failed.executionArn! });
        expect(result.outcome).toBe('source_not_proven'); expect(s.starts).toHaveLength(1);
    });

    it.each(proofKeys.filter(k => k !== 'basis'))('refuses corrupted saved %s before reserving', async key => {
        const s = await failedReplay(), context = await s.context();
        context[key] = key.endsWith('At') ? '2026-10-25T14:36:08.446Z' : 'corrupted';
        s.placements[0]!.last_error = 'pool_release_recovery:' + JSON.stringify(context);
        await s.retry();
        expect(s.starts).toHaveLength(1); expect(s.usage[0]!.stopped_at).toBeNull();
        expect(s.meter.stopped).not.toHaveBeenCalled();
    });

    it.each(['missing history', 'truncated history', 'changed timestamp', 'wrong source version', 'wrong source ARN', 'changed source input'])(
        'refuses %s when revalidating the original source', async defect => {
            const s = await failedReplay();
            const events = s.histories.get(s.failed.executionArn!)!;
            if (defect === 'missing history') s.histories.delete(s.failed.executionArn!);
            if (defect === 'truncated history') events.pop();
            if (defect === 'changed timestamp') {
                const at = events.findIndex(e => e.type === 'TaskSucceeded' && e.taskSucceededEventDetails?.resource === 'terminateInstances');
                events[at]!.timestamp = new Date(TERMINATED.getTime() - 1);
            }
            if (defect === 'wrong source version') s.failed.stateMachineVersionArn = currentDeployment.stateMachineVersionArn;
            if (defect === 'wrong source ARN') s.failed.executionArn += '-foreign';
            if (defect === 'changed source input') s.failed.input = s.starts[0]!.input;
            await s.retry();
            expect(s.starts).toHaveLength(1); expect(s.usage[0]!.stopped_at).toBeNull();
        });

    const defects: [string, (s: Setup) => void][] = [
        ...['ezil:computer', 'ezil:computer-id', 'ezil:fence', 'ezil:fence-token', 'ezil:namespace', 'ezil:stage', 'ezil:generation'].flatMap(key => [
            [`foreign host ${key}`, (s: Setup) => { (s.host.tags as Record<string, string>)[key] = 'foreign'; }],
            [`foreign volume ${key}`, (s: Setup) => { s.volume.tags = { ...s.volume.tags, [key]: 'foreign' }; }],
        ] as [string, (s: Setup) => void][]),
        ['wrong KMS', s => { s.volume.kmsKeyId = 'foreign'; }],
        ['wrong zone', s => { s.volume.zoneId = 'aps1-az2'; }],
        ['wrong size', s => { s.volume.sizeGiB = 1; }],
        ['unencrypted', s => { s.volume.encrypted = false; }],
        ['attached elsewhere', s => { s.volume.attachments = [{ instanceId: 'i-99999999999999999', state: 'attached' }]; }],
        ['still running', s => { s.host.state = 'running'; }],
    ];
    it.each(defects)('refuses %s on promoted retry', async (_name, mutate) => {
        const s = await failedReplay(); mutate(s); await s.retry();
        expect(s.starts).toHaveLength(1); expect(s.usage[0]!.stopped_at).toBeNull(); expect(s.meter.stopped).not.toHaveBeenCalled();
    });

    it('shutting-down waits without writes, even with the disk detaching', async () => {
        const s = await failedReplay(); s.host.state = 'shutting-down';
        s.volume.state = 'in-use'; s.volume.attachments = [{ instanceId: s.host.instanceId, state: 'detaching' }];
        const before = await s.current(), reads = vi.mocked(s.deps.executions.history!).mock.calls.length;
        await s.retry();
        expect(await s.current()).toEqual(before); expect(s.starts).toHaveLength(1);
        expect(s.deps.executions.history).toHaveBeenCalledTimes(reads); expect(s.meter.stopped).not.toHaveBeenCalled();
    });

    it('settlement re-witnesses the original after the second reservation; corruption never closes usage', async () => {
        const s = await failedReplay(); await s.retry();
        s.histories.get(s.failed.executionArn!)!.pop(); s.finish();
        await reconcilePoolReleaseRecovery(s.deps, await s.current(), currentDeployment);
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED' });
        expect(s.usage[0]!.stopped_at).toBeNull(); expect(s.meter.stopped).not.toHaveBeenCalled();
    });
});
