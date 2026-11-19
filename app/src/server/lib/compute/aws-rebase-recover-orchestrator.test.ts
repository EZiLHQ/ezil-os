import { expect, it, vi } from 'vitest';
import { resumeImageRecovery } from './aws-rebase-recover-orchestrator';
import { launchFor, preparationFor } from './aws-rebase-evidence';
import { recoveryFor } from './aws-rebase-recovery';
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

async function failedSplitRebase(crossAgent = false) {
    const s = rebaseSetup();
    const deployments = JSON.parse(s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS);
    const incumbent = deployments[s.source.deployment.region].releases[0];
    incumbent.preparationStateMachineVersionArn = incumbent.preparationStateMachineVersionArn.replace(/:[0-9]+$/, ':3');
    incumbent.recoveryStateMachineVersionArn = incumbent.recoveryStateMachineVersionArn.replace(/:[0-9]+$/, ':4');
    if (crossAgent) incumbent.agentCommit = 'd'.repeat(40);
    s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify(deployments);
    expect((await s.run('prepare')).status).toBe(202);
    await s.completePreparation();
    expect((await s.run('launch')).status).toBe(202);
    const launched = await s.current();
    Object.assign(s.executions.get(launched.launchExecutionArn!)!, { status: 'FAILED' });
    expect((await s.run('verify')).body.phase).toBe('failed');
    return { ...s, job: await s.current(), env: s.env as typeof s.env & { EZIL_AWS_IMAGE_RECOVERY_BRIDGE_V2?: string } };
}

it.each(['wrong', 'cross-agent'])('does not authorize or write V2 recovery with %s bridge approval', async mode => {
    const s = await failedSplitRebase(mode === 'cross-agent');
    const pin = s.job.jobId + ':' + s.job.preparationDigest;
    if (mode === 'cross-agent') s.env.EZIL_AWS_IMAGE_RECOVERY_BRIDGE_V2 = pin;
    if (mode === 'wrong') s.env.EZIL_AWS_IMAGE_RECOVERY_BRIDGE_V2 = s.job.jobId + ':' + '0'.repeat(64);
    const before = await s.store.inspect(s.source.computerId);
    const admit = vi.spyOn(s.store, 'admitRecovery');
    vi.mocked(s.deps.starter.start).mockClear();
    await expect(resumeImageRecovery(s.deps, s.job, true)).rejects.toThrow(/^operator_required$/);
    expect(admit).not.toHaveBeenCalled();
    expect(s.deps.starter.start).not.toHaveBeenCalled();
    expect(await s.store.inspect(s.source.computerId)).toEqual(before);
});

it('admits same-agent V2 only for the exact stored job and preparation digest', async () => {
    const s = await failedSplitRebase();
    s.env.EZIL_AWS_IMAGE_RECOVERY_BRIDGE_V2 = s.job.jobId + ':' + s.job.preparationDigest;
    vi.mocked(s.deps.starter.start).mockClear();
    const { job } = await resumeImageRecovery(s.deps, s.job, true);
    const work = recoveryFor(job), prep = preparationFor(job).intent;
    expect(job.phase).toBe('restore_pending');
    expect(work.intent).toMatchObject({ schemaVersion: 2, rebasePreparation: { digest: job.preparationDigest }, deployment: {
        amiId: prep.sourceDeployment.amiId, launchTemplateVersion: prep.sourceDeployment.launchTemplateVersion,
        lowerImageDigest: prep.sourceDeployment.lowerImageDigest, stateMachineVersionArn: prep.deployment.stateMachineVersionArn,
        preparationStateMachineVersionArn: prep.deployment.preparationStateMachineVersionArn,
        recoveryStateMachineVersionArn: prep.deployment.recoveryStateMachineVersionArn,
    } });
    expect(s.deps.starter.start).toHaveBeenCalledExactlyOnceWith(job.region, work);

    // Reconciliation uses the already admitted V2 document even after the pin is removed.
    delete s.env.EZIL_AWS_IMAGE_RECOVERY_BRIDGE_V2;
    await s.completeRecovery();
    const { job: rebound } = await resumeImageRecovery(s.deps, await s.current(), true);
    expect(rebound.phase).toBe('rebind_pending');
    expect(rebound.quarantinedVolumeId).toBe(job.sourceVolumeId);
    expect(rebound.restoredVolumeId).not.toBe(job.sourceVolumeId);
    expect(launchFor(rebound, 'rebind').intent.deployment).toEqual(work.intent.deployment);
});

it.each([undefined, '88888888-8888-4888-8888-888888888888:' + '0'.repeat(64)])('retains V1 when no bridge approval selects this job', async pin => {
    const s = await failedSplitRebase();
    s.env.EZIL_AWS_IMAGE_RECOVERY_BRIDGE_V2 = pin;
    const { job } = await resumeImageRecovery(s.deps, s.job, true);
    const work = recoveryFor(job), prep = preparationFor(job).intent;
    expect(work.intent.schemaVersion).toBe(1);
    expect(work.intent.deployment).toEqual(prep.sourceDeployment);
    expect(s.started.at(-1)?.input).toBe(work.input);
});
