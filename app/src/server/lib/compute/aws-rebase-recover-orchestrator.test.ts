import { expect, it, vi } from 'vitest';
import { resumeImageRecovery } from './aws-rebase-recover-orchestrator';
import { preparationFor } from './aws-rebase-evidence';
import { rebaseSetup } from './aws-rebase.test-support';

it('refuses legacy null-pin recovery with matching agents and preserves custody, snapshot and phase', async () => {
    const s = rebaseSetup();
    const deployments = JSON.parse(s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS);
    Object.assign(deployments[s.source.deployment.region].releases[0], {
        preparationStateMachineVersionArn: null, recoveryStateMachineVersionArn: null,
    });
    s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify(deployments);
    expect((await s.run('prepare')).status).toBe(202);
    await s.completePreparation();
    expect((await s.run('launch')).status).toBe(202);
    const launched = await s.current();
    Object.assign(s.executions.get(launched.launchExecutionArn!)!, { status: 'FAILED' });
    expect((await s.run('verify')).body.phase).toBe('failed');

    const before = await s.store.inspect(s.source.computerId), job = before.job!;
    expect(preparationFor(job).intent.sourceDeployment).toMatchObject({
        preparationStateMachineVersionArn: null, recoveryStateMachineVersionArn: null,
    });
    expect(job.sourceRelease.agentCommit).toBe(job.targetRelease.agentCommit);
    expect(job).toMatchObject({ phase: 'failed', retentionHold: true, snapshotId: 'snap-11111111111111111',
        recoveryDocument: null, rebindDocument: null, restoredVolumeId: null });
    const started = structuredClone(s.started), executions = structuredClone(s.executions), snapshot = structuredClone(s.provider.snapshot);
    const admitRecovery = vi.spyOn(s.store, 'admitRecovery'), admitRebind = vi.spyOn(s.store, 'admitRebind');
    vi.mocked(s.deps.starter.start).mockClear();

    // Assert the orchestrator's exact refusal, before the outer handler can mask an unrelated error.
    await expect(resumeImageRecovery(s.deps, job, true)).rejects.toThrow(/^operator_required$/);
    expect(await s.run('recover', job.jobId)).toMatchObject({
        status: 409, body: { failureCode: 'operator_required', phase: 'failed' },
    });
    expect(admitRecovery).not.toHaveBeenCalled(); expect(admitRebind).not.toHaveBeenCalled();
    expect(s.deps.starter.start).not.toHaveBeenCalled();
    expect(s.started).toEqual(started); expect(s.executions).toEqual(executions);
    expect(await s.store.inspect(s.source.computerId)).toEqual(before);
    expect(s.provider.snapshot).toEqual(snapshot);
});
