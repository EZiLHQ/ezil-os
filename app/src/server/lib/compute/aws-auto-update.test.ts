import { describe, expect, it, vi } from 'vitest';
import { handleImageRebase, isAutomaticImageJob } from './aws-rebase-orchestrator';
import { nonceHashOf } from './aws-enroll';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { rebaseSetup } from './aws-rebase.test-support';

function setup() {
    const s = rebaseSetup();
    const advance = (overrides: { ownerUserId?: string; allowStart?: boolean; canBoot?: () => Promise<boolean> } = {}) =>
        handleImageRebase(s.deps, { schemaVersion: 1, operation: 'prepare', computerId: s.source.computerId, jobId: null },
            { ownerUserId: s.owner, allowStart: true, canBoot: async () => true, ...overrides });
    return { ...s, advanceClock: s.advance, advance };
}

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
