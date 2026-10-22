import { validateImageJob } from './aws-rebase-store';
import { describe, expect, it, vi } from 'vitest';
import { rebaseSetup } from './aws-rebase.test-support';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { nonceHashOf, handleAwsEnrollment } from './aws-enroll';
import { handleImageRebase } from './aws-rebase-orchestrator';

vi.mock('./aws-identity', () => ({ readIdentityCertificate: () => 'test-certificate', verifyIdentitySignature: () => ({ ok: true }) }));
async function launch() {
    const s = rebaseSetup(); expect((await s.run('prepare')).status).toBe(202);
    await s.completePreparation(); expect((await s.run('launch')).status).toBe(202); return s;
}
describe('image orchestration with the real locked store and provider doubles', () => {
    it('plans without writes, prepares once and launches only after a completed snapshot', async () => {
        const s = rebaseSetup(); expect((await s.run('plan')).body.eligible).toBe(true); expect(s.fake.imageJobs).toHaveLength(0);
        expect((await s.run('prepare')).status).toBe(202); expect((await s.run('prepare')).status).toBe(202);
        expect(s.started).toHaveLength(1); expect(s.fake.placements[0]!.enroll_nonce_hash).toBeNull();
        await s.completePreparation(); expect((await s.run('verify')).body.phase).toBe('snapshot_ready');
        expect(s.started).toHaveLength(1); expect((await s.run('launch')).status).toBe(202);
        const j = await s.current(); const lease = parseEnrollmentUserData(JSON.parse(j.launchDocument!).userData);
        expect(s.fake.placements[0]).toMatchObject({ generation: j.sourceGeneration, fence_token: j.sourceFenceToken,
            lease_epoch: j.targetLeaseEpoch, enroll_nonce_hash: nonceHashOf(lease.nonce), lifecycle_digest: j.launchDigest });
        await s.run('launch'); expect(s.started).toHaveLength(2);
    });
    it('completes only after target volume tags, host digest, enrollment and desktop health', async () => {
        const s = await launch(); await s.completeLaunch();
        expect((await s.run('verify')).body.phase).toBe('verifying');
        expect(s.fake.placements[0]!.lower_image_digest).toBe(s.source.fromDigest);
        let j = await s.current(); const lease = parseEnrollmentUserData(JSON.parse(j.launchDocument!).userData);
        const body = { computerId: j.computerId, generation: j.targetGeneration, leaseEpoch: j.targetLeaseEpoch, nonce: lease.nonce,
            identityDocument: JSON.stringify({ accountId: s.source.deployment.accountId, region: j.region, instanceId: s.provider.host!.instanceId,
                instanceType: 'm6i.large', availabilityZone: 'ap-south-1a' }), signature: 'x'.repeat(16), lowerImageDigest: j.toDigest };
        const tunnels = { createTunnel: vi.fn(async () => ({ ok: true as const, tunnelToken: 'test-tunnel-token' })), deleteTunnel: vi.fn() };
        const enrollDeps = { db: s.fake.db, env: s.env, now: s.deps.now, describer: s.deps.describer, tunnels, controlKeySecret: 'test-only-secret' };
        expect((await handleAwsEnrollment(enrollDeps, { ...body, lowerImageDigest: j.fromDigest })).status).toBe(403);
        expect(tunnels.createTunnel).not.toHaveBeenCalled();
        expect((await handleAwsEnrollment(enrollDeps, body)).status).toBe(200);
        expect((await handleAwsEnrollment(enrollDeps, body)).status).toBe(200);
        j = await s.current(); expect(j.hostEvidence?.lowerImageDigest).toBe(j.toDigest);
        expect(JSON.stringify(j.hostEvidence)).not.toMatch(/nonce|signature/);
        s.deps.desktopHealthy = async () => false;
        expect((await s.run('verify')).body.failureCode).toBe('desktop_unhealthy');
        expect(s.fake.placements[0]!.image_upgrade_job_id).toBe(j.jobId);
        s.deps.desktopHealthy = async () => true;
        expect((await s.run('verify')).body.phase).toBe('succeeded');
        const terminal = await s.store.read(j.jobId);
        expect(terminal).toMatchObject({ retentionHold: false, phase: 'succeeded' });
        expect(Date.parse(terminal!.retainUntil!) - Date.parse(terminal!.completedAt!)).toBeGreaterThanOrEqual(604800000);
        expect(s.fake.placements[0]).toMatchObject({ state: 'RUNNING', image_upgrade_job_id: null, lifecycle_job_id: null, lower_image_digest: j.toDigest });
        expect(s.deps.meter!.stopped).toHaveBeenCalled(); expect(s.deps.meter!.ready).toHaveBeenCalledTimes(1);
    });
    it('keeps a missing or foreign snapshot reserved and never mints a nonce', async () => {
        const s = rebaseSetup(); await s.run('prepare'); await s.completePreparation(); s.provider.snapshot!.ownerId = '999999999999';
        expect((await s.run('launch')).body.failureCode).toBe('snapshot_identity_mismatch');
        expect(s.started).toHaveLength(1); expect((await s.current()).launchDocument).toBeNull();
    });
    it('rejects forged execution input, aliases and redrives', async () => {
        for (const patch of [{ input: '{}' }, { stateMachineAliasArn: 'alias' }, { redriveCount: 1 }]) {
            const s = rebaseSetup(); await s.run('prepare'); await s.completePreparation();
            Object.assign(s.executions.get((await s.current()).preparationExecutionArn!)!, patch);
            expect((await s.run('launch')).body.failureCode).toBe('authority_revoked'); expect(s.started).toHaveLength(1);
        }
    });
    it('retains immutable launch bytes after an uncertain start and resumes with exact input', async () => {
        const s = rebaseSetup(); await s.run('prepare'); await s.completePreparation();
        s.deps.starter.start = vi.fn(async () => { throw new Error('transport'); });
        expect((await s.run('launch')).body.phase).toBe('unconfirmed');
        const before = await s.current(); expect(before.launchDocument).not.toBeNull();
        await s.run('verify'); expect(s.deps.starter.start).toHaveBeenCalledTimes(1);
        s.advance(481000); expect((await s.run('launch')).body.failureCode).toBe('enrollment_time_insufficient');
        expect((await s.current()).launchDocument).toBe(before.launchDocument);
        expect(s.deps.starter.start).toHaveBeenCalledTimes(1);
    });
    it('starts explicit recovery on the retained source version and keeps custody', async () => {
        const s = await launch(), j = await s.current();
        Object.assign(s.executions.get(j.launchExecutionArn!)!, { status: 'FAILED' });
        expect((await s.run('verify')).body.phase).toBe('failed');
        const r = await handleImageRebase(s.deps, { schemaVersion: 1, operation: 'recover', computerId: null, jobId: j.jobId });
        expect(r.body).toMatchObject({ computerId: j.computerId, jobId: j.jobId, eligible: true, failureCode: null, phase: 'restore_pending' });
        expect(s.started.at(-1)!.stateMachineArn).toBe(s.source.sourceDeployment.recoveryStateMachineVersionArn);
        expect(s.fake.placements[0]!.image_upgrade_job_id).toBe(j.jobId);
    });
    it('does not advance placement generation from a running receipt with source volume tags', async () => {
        const s = await launch(); await s.completeLaunch(); s.provider.volume.tags = { ...s.provider.volume.tags, 'ezil:generation': '1' };
        expect((await s.run('verify')).body.failureCode).toBe('generation_drift');
        expect(s.fake.placements[0]!.generation).toBe(1);
    });
    it('checks expected job IDs and owner under locks', async () => {
        const s = rebaseSetup(); await s.run('prepare');
        expect((await s.run('launch', '99999999-9999-4999-8999-999999999999')).status).toBe(409);
        s.fake.placements[0]!.owner_user_id = '99999999-9999-4999-8999-999999999999';
        expect((await s.run('verify')).status).toBe(409);
    });
});

it('concurrent prepare requests reserve exactly one immutable job', async () => {
    const s = rebaseSetup();
    const results = await Promise.all(Array.from({ length: 4 }, () => s.run('prepare')));
    expect(results.some(r => r.status === 202)).toBe(true);
    expect(s.fake.imageJobs).toHaveLength(1);
    expect(s.started).toHaveLength(1);
});

it('revokes image authority on owner/phase/job/epoch/digest mismatch', async () => {
    const s = await launch(), j = await s.current();
    const authority = { computerId: j.computerId, imageJobId: j.jobId, imageJobPhase: 'launch' as const,
        jobId: j.launchJobId!, leaseEpoch: j.targetLeaseEpoch!, digest: j.launchDigest! };
    expect(await s.store.authority(authority, s.deps.now())).toBe(true);
    for (const patch of [{ jobId: j.jobId }, { leaseEpoch: j.sourceLeaseEpoch }, { digest: j.preparationDigest }, { imageJobPhase: 'recovery' as const }])
        expect(await s.store.authority({ ...authority, ...patch }, s.deps.now())).toBe(false);
    s.advance(600000); expect(await s.store.authority(authority, s.deps.now())).toBe(false);
});

it('logs an uncoded prepare failure (class and message only) before answering operator_required', async () => {
    const s = rebaseSetup(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        s.deps.describer.describeVolume = async () => { throw new TypeError('describe exploded'); };
        const r = await s.run('prepare');
        expect(r.status).toBe(503); expect(r.body.failureCode).toBe('operator_required'); expect(s.fake.imageJobs).toHaveLength(0);
        expect(log).toHaveBeenCalledWith('[image-rebase] unexpected failure', expect.objectContaining({ operation: 'prepare', name: 'TypeError', message: 'describe exploded', jobId: null }));
    } finally { log.mockRestore(); }
});

it('admission refuses a kill switch without changing source counters or storing a launch nonce', async () => {
    const s = rebaseSetup(); await s.run('prepare'); await s.completePreparation();
    Object.assign(s.env, { EZIL_AWS_KILL_SWITCH: '1' });
    expect((await s.run('launch')).body.failureCode).toBe('operator_required');
    expect(s.fake.placements[0]).toMatchObject({ generation: 1, lease_epoch: 3, enroll_nonce_hash: null });
    expect((await s.current()).launchDocument).toBeNull();
});

async function recovering() {
    const s = await launch(), j = await s.current();
    Object.assign(s.executions.get(j.launchExecutionArn!)!, { status: 'FAILED' });
    await s.run('verify'); expect((await s.run('recover', j.jobId)).body.phase).toBe('restore_pending');
    return s;
}
it('restores a different volume, enrolls maintenance without credentials and atomically prepares a linked retry', async () => {
    const s = await recovering(); await s.completeRecovery();
    let j = await s.current(); expect((await s.run('recover', j.jobId)).body.phase).toBe('rebind_pending');
    j = await s.current();
    const lease = parseEnrollmentUserData(JSON.parse(j.rebindDocument!).userData);
    expect(lease.ebsRestore).toMatchObject({ volumeId: j.restoredVolumeId, originalVolumeId: j.sourceVolumeId, fromDigest: j.fromDigest, maintenance: true });
    expect(lease.leaseEpoch).toBeGreaterThan(j.targetLeaseEpoch!); expect(lease.generation).toBeGreaterThan(j.targetGeneration!);
    expect(s.fake.placements[0]!.volume_id).not.toBe(j.sourceVolumeId);
    await s.completeRebind();
    const report = { v: 1, recoveryJobId: j.recoveryJobId, snapshotId: j.snapshotId, originalVolumeId: j.sourceVolumeId, volumeId: j.restoredVolumeId, fsUuid: j.fsUuid };
    const body = { computerId: j.computerId, generation: j.rebindGeneration, leaseEpoch: j.rebindLeaseEpoch, nonce: lease.nonce,
        identityDocument: JSON.stringify({ accountId: s.source.deployment.accountId, region: j.region, instanceId: s.provider.host!.instanceId,
            instanceType: 'm6i.large', availabilityZone: 'ap-south-1a' }), signature: 'x'.repeat(16), lowerImageDigest: j.fromDigest, ebsRestore: report };
    const enrollDeps = { db: s.fake.db, env: s.env, now: s.deps.now, describer: s.deps.describer };
    expect(await handleAwsEnrollment(enrollDeps, body)).toEqual({ status: 200, body: { maintenance: true, accepted: true } });
    expect(await handleAwsEnrollment(enrollDeps, body)).toEqual({ status: 200, body: { maintenance: true, accepted: true } });
    expect(s.fake.placements[0]!.state).not.toBe('RUNNING');
    expect((await s.run('recover', j.jobId)).body.phase).toBe('recovered');
    const parent = await s.store.read(j.jobId), child = await s.current();
    expect(parent).toMatchObject({ retentionHold: true, phase: 'recovered', quarantinedVolumeId: j.sourceVolumeId });
    expect(() => validateImageJob({ ...parent, phase: 'succeeded', retentionHold: false, retainUntil: '2026-11-01T00:00:00.000Z' })).toThrow();
    expect(child).toMatchObject({ parentJobId: j.jobId, sourceVolumeId: j.restoredVolumeId, sourceGeneration: j.rebindGeneration, sourceLeaseEpoch: j.rebindLeaseEpoch });
    expect(child.jobId).not.toBe(j.jobId); expect(child.snapshotId).toBeNull();
    expect(s.fake.placements[0]!.image_upgrade_job_id).toBe(child.jobId);
    expect(s.started.at(-1)!.name).toBe('computer-' + child.jobId);
    await s.completePreparation(); expect((await s.run('launch')).status).toBe(202);
    const retry = await s.current();
    expect(retry.snapshotId).not.toBe(j.snapshotId);
    expect(retry.sourceVolumeId).toBe(j.restoredVolumeId);
    const retryLease = parseEnrollmentUserData(JSON.parse(retry.launchDocument!).userData);
    expect(retryLease.rebase?.volumeId).toBe(j.restoredVolumeId);
    expect(retryLease.rebasePermit?.preparationJobId).toBe(child.jobId);
});
it('refuses a restore with wrong snapshot lineage before any maintenance nonce is issued', async () => {
    const s = await recovering(); await s.completeRecovery(); s.provider.restoredVolume!.snapshotId = 'snap-22222222222222222';
    const j = await s.current(); expect((await s.run('recover', j.jobId)).body.failureCode).toBe('restore_lineage_mismatch');
    expect((await s.current()).rebindDocument).toBeNull(); expect(s.fake.placements[0]!.enroll_nonce_hash).toBeNull();
});

it('a source release with an older agent cannot authorize maintenance', async () => {
    const s = rebaseSetup();
    const map = JSON.parse(s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS); map[s.source.deployment.region].releases[0].agentCommit = 'f'.repeat(40);
    s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify(map);
    await s.run('prepare'); await s.completePreparation(); await s.run('launch');
    const j = await s.current(); Object.assign(s.executions.get(j.launchExecutionArn!)!, { status: 'FAILED' }); await s.run('verify');
    expect((await s.run('recover', j.jobId)).body.failureCode).toBe('operator_required');
    expect((await s.current()).recoveryDocument).toBeNull();
});

it('a target that has reported host evidence cannot be automatically restored', async () => {
    const s = await launch(); await s.completeLaunch(); await s.run('verify');
    let j = await s.current(); const lease = parseEnrollmentUserData(JSON.parse(j.launchDocument!).userData);
    await s.store.enroll(j, { nonceHash: nonceHashOf(lease.nonce), instanceId: s.provider.host!.instanceId, volumeId: j.sourceVolumeId,
        lowerImageDigest: j.toDigest }, s.deps.now());
    j = await s.current(); await s.store.finishEnroll(j, { instanceId: s.provider.host!.instanceId, success: false }, s.deps.now());
    expect((await s.run('recover', j.jobId)).body.failureCode).toBe('operator_required');
    expect((await s.current()).recoveryDocument).toBeNull();
});

it('reconciles an accepted launch whose StartExecution response was lost without rotating the nonce', async () => {
    const s = rebaseSetup(); await s.run('prepare'); await s.completePreparation();
    const start = s.deps.starter.start;
    s.deps.starter.start = async (region, work) => { await start(region, work); throw new Error('lost response'); };
    expect((await s.run('launch')).body.phase).toBe('unconfirmed');
    const before = await s.current();
    expect((await s.run('verify')).body.phase).toBe('launch_pending');
    expect((await s.current()).launchDocument).toBe(before.launchDocument);
    expect(s.started).toHaveLength(2);
});
