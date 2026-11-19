import { describe, expect, it, vi } from 'vitest';
import { fixtureRebaseRelease } from './aws-intent.test-support';
import type { LifecycleDeployment } from './aws-intent';
import { handleImageRebase, ImageRebaseRequestSchema, type ImageRebaseRequest } from './aws-rebase-orchestrator';
import { rebaseManifestSha256 } from './aws-rebase-release';
import { releasedPoolSetup } from './aws-rebase.test-support';

function successor(deployment: LifecycleDeployment, hex: 'd' | 'f', n: number): LifecycleDeployment {
    const version = (arn: string) => arn.replace(/:[0-9]+$/, ':' + n);
    return { ...deployment, amiId: 'ami-' + hex.repeat(17), previousLowerImageDigest: deployment.lowerImageDigest,
        lowerImageDigest: 'sha256:' + hex.repeat(64), launchTemplateVersion: String(n),
        stateMachineVersionArn: version(deployment.stateMachineVersionArn),
        preparationStateMachineVersionArn: version(deployment.preparationStateMachineVersionArn!),
        recoveryStateMachineVersionArn: version(deployment.recoveryStateMachineVersionArn!) };
}

function manifest(d: LifecycleDeployment) {
    const repository = `${d.accountId}.dkr.ecr.${d.region}.amazonaws.com/desktop`;
    return { ...fixtureRebaseRelease(d), lowerImageRef: `${repository}@${d.lowerImageDigest}`,
        previousLowerImageRef: d.previousLowerImageDigest === null ? null : `${repository}@${d.previousLowerImageDigest}` };
}

function setup(intervening = false) {
    const s = releasedPoolSetup();
    const env = s.deps.env;
    const retainedDeployment = s.source.deployment;
    const next = successor(retainedDeployment, 'd', 49);
    const activeDeployment = intervening ? successor(next, 'f', 50) : next;
    const retained = manifest(retainedDeployment);
    const active = manifest(activeDeployment);
    const bridge = intervening ? [manifest(next)] : [];
    const releases = [manifest(s.provisioned), retained, ...bridge, active];
    const approval = { schemaVersion: 1, computerId: s.source.computerId, ownerUserId: s.owner,
        sourceGeneration: s.source.sourceGeneration, sourceLeaseEpoch: s.source.sourceLeaseEpoch,
        sourceFenceToken: s.source.sourceFenceToken, sourceLowerDigest: s.source.fromDigest,
        activeManifestSha256: rebaseManifestSha256(active), retainedManifestSha256: rebaseManifestSha256(retained),
        ...(bridge[0] ? { interveningManifestSha256: rebaseManifestSha256(bridge[0]) } : {}) };
    const record = { ...activeDeployment, releases };
    const apply = () => {
        env.EZIL_AWS_RETAINED_REBASE_APPROVAL = JSON.stringify(approval);
        env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [activeDeployment.region]: record });
    };
    env.EZIL_AWS_ENROLL_URL = 'https://os-staging.ezil.work/api/compute/aws/enroll';
    s.deps.allowRetainedTarget = true;
    apply();
    const request = (operation: 'plan' | 'prepare', overrides: Partial<ImageRebaseRequest> = {}) => ({
        schemaVersion: 1, operation, computerId: s.source.computerId, jobId: null,
        retainedTargetManifestSha256: approval.retainedManifestSha256, sourceRetirementExecutionArn: s.releaseArn, ...overrides,
    });
    const signed = (operation: 'plan' | 'prepare', overrides: Partial<ImageRebaseRequest> = {}) =>
        handleImageRebase(s.deps, request(operation, overrides));
    return { ...s, active, bridge, env, approval, apply, record, retained, retainedDeployment, next, signed, request };
}

describe('signed retained intermediate image update', () => {
    it.each([false, true])('plans and launches the exact retained tuple with intervening manifest %s', async intervening => {
        const s = setup(intervening);
        const originalRegistry = s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS;
        expect((await s.signed('plan')).body).toMatchObject({ eligible: true, jobId: null });
        expect(s.started).toHaveLength(0);

        const first = await s.signed('prepare');
        expect(first.body).toMatchObject({ eligible: true, phase: 'fencing' });
        const jobId = first.body.jobId!;
        expect(jobId).toBeTruthy();
        const job = await s.current();
        expect(job.targetRelease).toEqual(s.retained);
        expect(JSON.parse(job.preparationDocument)).toMatchObject({
            deployment: s.retainedDeployment, releasedPoolHost: { releaseExecutionArn: s.releaseArn },
        });
        expect((await s.signed('prepare')).body.jobId).toBe(jobId);
        expect((await s.signed('prepare', { sourceRetirementExecutionArn: s.provisionArn })).body.failureCode).toBe('image_job_conflict');
        expect((await s.run('prepare')).body.failureCode).toBe('image_job_conflict');
        expect(s.started).toHaveLength(1);
        await s.completePreparation();
        expect((await s.signed('prepare', { jobId })).body.phase).toBe('snapshot_ready');
        expect((await s.run('launch')).body.failureCode).toBe('image_job_conflict');

        delete s.env.EZIL_AWS_RETAINED_REBASE_APPROVAL;
        expect((await s.run('launch', jobId)).body).toMatchObject({ eligible: true, jobId, phase: 'launch_pending' });
        expect((await s.run('launch', jobId)).body.jobId).toBe(jobId);
        expect(s.started.map(x => x.stateMachineArn)).toEqual([
            s.retainedDeployment.preparationStateMachineVersionArn, s.retainedDeployment.stateMachineVersionArn,
        ]);
        expect(JSON.parse((await s.current()).launchDocument!).deployment).toEqual(s.retainedDeployment);
        expect(s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS).toBe(originalRegistry);
        expect(s.fake.imageJobs).toHaveLength(1);
    });

    it('preserves the normal adjacent update to the active release', async () => {
        const s = setup(true);
        s.setProvision(s.next);
        s.setRelease({ deployment: s.next });
        s.fake.placements[0]!.lower_image_digest = s.next.lowerImageDigest;
        expect((await s.signed('plan', { retainedTargetManifestSha256: undefined })).body).toMatchObject({ eligible: true, jobId: null });
        expect((await s.signed('prepare', { retainedTargetManifestSha256: undefined })).body.phase).toBe('fencing');
        expect((await s.current()).targetRelease).toEqual(s.active);
    });

    it('requires authenticated operator capability and never selects a retained target on owner open', async () => {
        const s = setup();
        expect((await handleImageRebase({ ...s.deps, allowRetainedTarget: undefined }, s.request('prepare'))).body.failureCode).toBe('operator_required');
        expect((await handleImageRebase(s.deps, s.request('prepare'), {
            ownerUserId: s.owner, allowStart: true, canBoot: async () => true,
        })).body.failureCode).toBe('operator_required');
        expect((await s.signed('plan', { retainedTargetManifestSha256: undefined })).body.failureCode).toBe('unsupported_predecessor');
        expect(ImageRebaseRequestSchema.safeParse({ ...s.request('prepare'), sourceRetirementExecutionArn: undefined }).success).toBe(false);
        expect(ImageRebaseRequestSchema.safeParse({ ...s.request('prepare'), operation: 'launch' }).success).toBe(false);
        expect(s.started).toHaveLength(0);
    });

    it.each(['owner', 'lease', 'production', 'pin', 'retirement', 'duplicate', 'bridge', 'bridge-link'] as const)(
        'refuses %s drift before reservation', async fault => {
            const s = setup(true);
            if (fault === 'owner') s.approval.ownerUserId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
            if (fault === 'lease') s.fake.placements[0]!.lease_epoch = s.approval.sourceLeaseEpoch + 1;
            if (fault === 'production') s.env.EZIL_AWS_ENROLL_URL = 'https://os.ezil.work/api/compute/aws/enroll';
            if (fault === 'pin') s.approval.activeManifestSha256 = 'f'.repeat(64);
            if (fault === 'retirement') s.executions.get(s.releaseArn)!.status = 'FAILED';
            if (fault === 'duplicate') s.record.releases.splice(1, 0, s.retained);
            if (fault === 'bridge') delete s.approval.interveningManifestSha256;
            if (fault === 'bridge-link') {
                const bridge = s.bridge[0]!;
                bridge.previousLowerImageRef = s.active.lowerImageRef;
                s.approval.interveningManifestSha256 = rebaseManifestSha256(bridge);
            }
            s.apply();
            expect((await s.signed('prepare')).body).toMatchObject({ eligible: false, jobId: null });
            expect(s.fake.imageJobs).toHaveLength(0);
            expect(s.started).toHaveLength(0);
        });

    it('rechecks private approval after source validation and before the locked reservation', async () => {
        const s = setup();
        const describeVolume = s.deps.describer.describeVolume;
        s.deps.describer.describeVolume = vi.fn(async (region, volume) => {
            delete s.env.EZIL_AWS_RETAINED_REBASE_APPROVAL;
            return describeVolume(region, volume);
        });
        expect((await s.signed('prepare')).body).toMatchObject({ jobId: null, failureCode: 'image_job_conflict' });
        expect(s.deps.executions.history).toHaveBeenCalledWith('ap-south-1', s.releaseArn);
        expect(s.started).toHaveLength(0);
        expect(s.fake.imageJobs).toHaveLength(0);
    });
});
