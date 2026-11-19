import { describe, expect, it, vi } from 'vitest';
import { handleImageRebase, isAutomaticImageJob } from './aws-rebase-orchestrator';
import { nonceHashOf } from './aws-enroll';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { rebaseSetup, releasedPoolSetup } from './aws-rebase.test-support';
import { applyLifecycleReceipt } from './aws-receipts';
import { readPlacement } from './placement';

function setup() {
    const s = rebaseSetup();
    const advance = (overrides: { ownerUserId?: string; allowStart?: boolean; canBoot?: () => Promise<boolean> } = {}) =>
        handleImageRebase(s.deps, { schemaVersion: 1, operation: 'prepare', computerId: s.source.computerId, jobId: null },
            { ownerUserId: s.owner, allowStart: true, canBoot: async () => true, ...overrides });
    return { ...s, advanceClock: s.advance, advance };
}

describe('automatic image updates using a saved retirement', () => {
    function released(retiredReleaseColumn = true) {
        const s = releasedPoolSetup({ shared: true, retiredReleaseColumn });
        const row = s.fake.placements[0]!;
        const settle = async () => {
            Object.assign(row, { state: 'STOPPING', lifecycle_job_id: s.release().intent.jobId, lifecycle_digest: s.release().digest });
            const { record } = await readPlacement(s.fake.db, s.source.computerId);
            await applyLifecycleReceipt({ db: s.fake.db, executions: s.deps.executions, now: s.deps.now }, record!, s.provisioned);
        };
        const advance = () => handleImageRebase(s.deps,
            { schemaVersion: 1, operation: 'prepare', computerId: s.source.computerId, jobId: null },
            { ownerUserId: s.owner, allowStart: true, canBoot: async () => true });
        return { ...s, row, settle, advance };
    }

    it('records the normal retirement in the STOPPED transaction and reuses one verified image job across opens', async () => {
        const s = released();
        await s.settle();
        expect(s.row).toMatchObject({ state: 'STOPPED', lifecycle_job_id: null, lifecycle_digest: null,
            retired_host_release: { executionArn: s.releaseArn } });
        const first = await s.advance();
        expect(first.body).toMatchObject({ eligible: true, phase: 'fencing' });
        expect(first.body.jobId).not.toBeNull();
        expect(JSON.parse((await s.current()).preparationDocument).releasedPoolHost.releaseExecutionArn).toBe(s.releaseArn);
        expect(s.deps.executions.history).toHaveBeenCalledWith('ap-south-1', s.releaseArn);
        const historyReads = vi.mocked(s.deps.executions.history!).mock.calls.length;
        expect((await s.advance()).body.jobId).toBe(first.body.jobId);
        expect(s.deps.executions.history).toHaveBeenCalledTimes(historyReads);
        expect(s.started).toHaveLength(1);
        expect(s.fake.imageJobs).toHaveLength(1);
    });

    it.each(['failed', 'ambiguous', 'mismatched'] as const)('does not save an automatic hint for a %s release', async fault => {
        const s = released();
        const execution = s.executions.get(s.releaseArn)!;
        if (fault === 'failed') execution.status = 'FAILED';
        if (fault === 'ambiguous') execution.redriveCount = 1;
        if (fault === 'mismatched') execution.stateMachineVersionArn = s.provisioned.stateMachineVersionArn.replace(/:[0-9]+$/, ':99');
        await s.settle();
        expect(s.row.retired_host_release).toBeUndefined();
        expect((await s.advance()).body.jobId).toBeNull();
        expect(s.started).toHaveLength(0);
    });

    it('still settles a normal release on older schemas and accepts an independently proven manual hint', async () => {
        const s = released(false);
        await s.settle();
        expect(s.row).toMatchObject({ state: 'STOPPED', lifecycle_job_id: null });
        expect(s.row.retired_host_release).toBeUndefined();
        expect((await s.advance()).body).toMatchObject({ jobId: null, failureCode: 'source_identity_mismatch' });
        expect(s.deps.executions.history).not.toHaveBeenCalled();
        expect((await s.request('plan')).body).toMatchObject({ eligible: true, jobId: null });
        expect(s.started).toHaveLength(0);
    });

    it('ignores a persisted hint after a different allocation', async () => {
        const s = released();
        await s.settle();
        s.row.lease_epoch = Number(s.row.lease_epoch) + 1;
        expect((await s.store.inspect(s.source.computerId)).placement?.retiredHostReleaseArn).toBeUndefined();
        expect((await s.advance()).body.jobId).toBeNull();
        expect(s.deps.executions.history).not.toHaveBeenCalled();
    });

    it('rechecks the retained hint under the reservation lock', async () => {
        const s = released();
        await s.settle();
        const describeVolume = s.deps.describer.describeVolume;
        s.deps.describer.describeVolume = vi.fn(async (region, volumeId) => {
            s.row.retired_host_release = null;
            return describeVolume(region, volumeId);
        });
        expect((await s.advance()).body).toMatchObject({ jobId: null, failureCode: 'image_job_conflict' });
        expect(s.deps.executions.history).toHaveBeenCalledWith('ap-south-1', s.releaseArn);
        expect(s.started).toHaveLength(0);
    });

    it('does not substitute the saved hint for positive termination history', async () => {
        const s = released();
        s.setRelease({}, {}, { Code: 32, Name: 'shutting-down' });
        await s.settle();
        expect(s.row.retired_host_release).toBeDefined();
        expect((await s.advance()).body).toMatchObject({ jobId: null, failureCode: 'source_identity_mismatch' });
        expect(s.started).toHaveLength(0);
    });
});

describe('automatic image updates on owner open', () => {
    it('reuses one job across opens and waits for the verified snapshot before launch', async () => {
        const s = setup();
        const first = await s.advance();
        expect(first.body).toMatchObject({ eligible: true, phase: 'fencing' });
        expect(first.body.jobId).not.toBeNull();
        expect((await s.advance({ allowStart: false })).body.jobId).toBe(first.body.jobId);
        expect(s.started).toHaveLength(1);
        await s.completePreparation();
        expect((await s.advance({ allowStart: false })).body.phase).toBe('snapshot_ready');
        expect(s.started).toHaveLength(1);
        expect((await s.advance({ allowStart: false })).body.phase).toBe('launch_pending');
        expect(s.started).toHaveLength(2);
    });

    async function dispatched() {
        const s = setup();
        await s.advance();
        await s.completePreparation();
        await s.advance();
        await s.advance();
        await s.completeLaunch();
        await s.run('verify');
        const job = await s.current();
        const lease = parseEnrollmentUserData(JSON.parse(job.launchDocument!).userData);
        const instanceId = s.provider.host!.instanceId;
        await s.store.enroll(job, { nonceHash: nonceHashOf(lease.nonce), instanceId, volumeId: job.sourceVolumeId,
            lowerImageDigest: job.toDigest }, s.deps.now());
        await s.store.finishEnroll(await s.current(), { instanceId, success: true }, s.deps.now());
        return { ...s, job };
    }

    it('settles and meters an enrolled automatic launch without a Code poll or another AWS dispatch', async () => {
        const s = await dispatched();
        const [job] = (await s.store.launchedForVerification()).filter(isAutomaticImageJob);
        expect(job?.jobId).toBe(s.job.jobId);
        expect((await s.run('verify', job!.jobId)).body.phase).toBe('succeeded');
        expect(s.started).toHaveLength(2);
        expect(s.deps.meter!.ready).toHaveBeenCalledTimes(1);
        expect(await s.store.launchedForVerification()).toEqual([]);
    });

    it('continues observing a dispatched launch if billing now refuses another dispatch', async () => {
        const s = await dispatched();
        const canBoot = vi.fn(async () => false);
        expect((await s.advance({ canBoot })).body.phase).toBe('succeeded');
        expect(s.started).toHaveLength(2);
    });

    it('ends update progress if the enrolled desktop remains unhealthy past the launch deadline', async () => {
        const s = await dispatched();
        s.deps.desktopHealthy = async () => false;
        expect((await s.run('verify', s.job.jobId)).body).toMatchObject({ phase: 'verifying', failureCode: 'desktop_unhealthy' });
        s.advanceClock(601_000);
        expect((await s.run('verify', s.job.jobId)).body).toMatchObject({ phase: 'failed', failureCode: 'desktop_unhealthy' });
        expect(s.started).toHaveLength(2);
        expect((await s.current()).snapshotId).not.toBeNull();
    });

    it('cannot create work without an owner open, or after billing refuses it', async () => {
        const s = setup();
        expect((await s.advance({ allowStart: false })).body.jobId).toBeNull();
        expect((await s.advance({ ownerUserId: '11111111-1111-4111-8111-111111111111' })).body.jobId).toBeNull();
        expect((await s.advance({ canBoot: async () => false })).body.jobId).toBeNull();
        expect(s.started).toHaveLength(0);
    });

    it('does not advance a job started by an operator', async () => {
        const s = setup();
        await s.run('prepare');
        await s.completePreparation();
        expect((await s.advance()).body.jobId).toBeNull();
        expect(s.started).toHaveLength(1);
        expect((await s.current()).phase).toBe('fencing');
    });

    it('does not reserve a volume whose previous host has no retirement proof', async () => {
        const s = setup();
        s.provider.sourceListed = false;
        expect((await s.advance()).body).toMatchObject({ jobId: null, failureCode: 'source_identity_mismatch' });
        expect(s.started).toHaveLength(0);
    });
});
