import { describe, expect, it, vi } from 'vitest';
import { handleImageRebase } from './aws-rebase-orchestrator';
import { rebaseSetup } from './aws-rebase.test-support';
import { fixtureReleaseRegistry106, fixtureSharedLowerSuccessor, LOWER_102, LOWER_105 } from './aws-rebase-release-registry.test-support';

function sharedLowerSetup() {
    const s = rebaseSetup(), f = fixtureSharedLowerSuccessor();
    s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [f.entry.region]: f.entry });
    s.fake.placements[0]!.lower_image_digest = LOWER_105;
    s.provider.host = { instanceId: s.source.sourceInstanceId, imageId: f.release105.amiId, state: 'stopped',
        availabilityZone: 'ap-south-1a', availabilityZoneId: f.entry.zoneId, publicIp: null, volumes: [],
        tags: { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': f.entry.namespace,
            'ezil:computer-id': s.source.computerId, 'ezil:generation': String(s.source.sourceGeneration),
            'ezil:fence-token': s.source.sourceFenceToken } };
    return { ...s, f };
}

describe('shared lower source observation before reservation', () => {
    it.each(['release105', 'release106'] as const)('pins %s from the observed AMI and preserves it on retry', async key => {
        const s = sharedLowerSetup();
        s.provider.host!.imageId = s.f[key].amiId;
        const reserve = vi.spyOn(s.store, 'reserve');
        s.deps.describer.describeForEnrollment = vi.fn(async (region, instanceId) => {
            expect([region, instanceId]).toEqual([s.f.entry.region, s.source.sourceInstanceId]);
            expect(reserve).not.toHaveBeenCalled();
            expect(s.fake.imageJobs).toHaveLength(0);
            expect(s.started).toHaveLength(0);
            return s.provider.host;
        });
        expect((await s.run('prepare')).status).toBe(202);
        const job = await s.current();
        expect(job.sourceRelease).toEqual(s.f[key]);
        expect(JSON.parse(job.preparationDocument).sourceDeployment.amiId).toBe(s.f[key].amiId);
        expect(reserve).toHaveBeenCalledTimes(1);
        s.provider.host!.imageId = 'ami-99999999999999999';
        s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = '{}';
        expect((await s.run('prepare')).status).toBe(202);
        expect((await s.current()).sourceRelease).toEqual(job.sourceRelease);
        expect((await s.current()).preparationDocument).toBe(job.preparationDocument);
        expect(s.deps.describer.describeForEnrollment).toHaveBeenCalledTimes(1);
        expect(s.started).toHaveLength(1);
    });

    for (const operation of ['plan', 'prepare'] as const) {
        it.each(['running', 'stopped'])(`${operation} accepts a live source in state %s`, async state => {
            const s = sharedLowerSetup(); s.provider.host!.state = state;
            expect((await s.run(operation)).body).toMatchObject({ eligible: true, failureCode: null });
            expect(s.deps.describer.describeForEnrollment).toHaveBeenCalledTimes(1);
            expect(s.fake.imageJobs).toHaveLength(operation === 'prepare' ? 1 : 0);
        });
        it.each(['release105', 'release106'] as const)(`${operation} resolves %s but refuses target 1.0.6's unsupported predecessor`, async key => {
            const s = sharedLowerSetup(), f = fixtureReleaseRegistry106();
            s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [f.entry.region]: f.entry });
            s.provider.host!.imageId = f[key].amiId;
            expect((await s.run(operation)).body).toMatchObject({ eligible: false, failureCode: 'unsupported_predecessor', jobId: null });
            expect(s.deps.describer.describeForEnrollment).toHaveBeenCalledTimes(1);
            expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0);
        });
        it.each([undefined, '', 'ami-99999999999999999', 'ami-22222222222222222'])(`${operation} refuses missing/unknown/different-lower ImageId %s`, async imageId => {
            const s = sharedLowerSetup(); s.provider.host!.imageId = imageId;
            expect((await s.run(operation)).body).toMatchObject({ eligible: false, failureCode: 'release_mismatch', jobId: null });
            expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0);
        });
        it(`${operation} refuses duplicate selected lower/AMI records before reservation`, async () => {
            const s = sharedLowerSetup(); s.f.entry.releases.splice(2, 0, { ...s.f.release105, agentCommit: 'f'.repeat(40) });
            s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [s.f.entry.region]: s.f.entry });
            expect((await s.run(operation)).body).toMatchObject({ eligible: false, failureCode: 'release_mismatch', jobId: null });
            expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0);
        });
        it.each(['absent', 'terminated', 'shutting-down', 'pending', 'unknown', 'wrong-instance', 'wrong-zone',
            'ezil:managed-by', 'ezil:stage', 'ezil:computer-id', 'ezil:generation', 'ezil:fence-token'])(`${operation} refuses source identity %s`, async fault => {
            const s = sharedLowerSetup();
            if (fault === 'absent') s.provider.host = null;
            else if (fault === 'wrong-instance') s.provider.host!.instanceId = 'i-99999999999999999';
            else if (fault === 'wrong-zone') s.provider.host!.availabilityZoneId = 'use1-az1';
            else if (fault.startsWith('ezil:')) s.provider.host!.tags = { ...s.provider.host!.tags, [fault]: 'foreign' };
            else s.provider.host!.state = fault;
            expect((await s.run(operation)).body).toMatchObject({ eligible: false, failureCode: 'source_identity_mismatch', jobId: null });
            expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0);
        });
        it(`${operation} refuses a placement without an instance id without describing`, async () => {
            const s = sharedLowerSetup(); s.fake.placements[0]!.instance_id = null;
            expect((await s.run(operation)).body).toMatchObject({ failureCode: 'source_identity_mismatch', eligible: false });
            expect(s.deps.describer.describeForEnrollment).not.toHaveBeenCalled();
            expect(s.fake.imageJobs).toHaveLength(0);
        });
        it.each([
            ['instance_id', 'i-99999999999999999'], ['lower_image_digest', LOWER_102], ['generation', 2], ['lease_epoch', 4],
            ['fence_token', '99999999-9999-4999-8999-999999999999'], ['volume_id', 'vol-99999999999999999'],
            ['fs_uuid', '99999999-9999-4999-8999-999999999999'], ['region', 'us-east-1'], ['zone_id', 'use1-az1'],
            ['state', 'RUNNING'], ['instance_type', 'm6i.xlarge'], ['updated_at', new Date('2026-10-23T00:00:00Z')],
            ['lower_digest_observed_at', new Date('2026-10-23T00:00:00Z')],
            ['lifecycle_job_id', '99999999-9999-4999-8999-999999999999'],
            ['owner_user_id', '99999999-9999-4999-8999-999999999999'],
        ] as const)(`${operation} refuses placement %s drift during observation`, async (field, value) => {
            const s = sharedLowerSetup();
            s.deps.describer.describeForEnrollment = vi.fn(async () => {
                Object.assign(s.fake.placements[0]!, { [field]: value });
                return s.provider.host;
            });
            const reserve = vi.spyOn(s.store, 'reserve');
            expect((await s.run(operation)).body).toMatchObject({ eligible: false, failureCode: 'image_job_conflict', jobId: null });
            expect(reserve).not.toHaveBeenCalled();
            expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0);
        });
        it(`${operation} refuses placement deletion during observation`, async () => {
            const s = sharedLowerSetup();
            s.deps.describer.describeForEnrollment = async () => { s.fake.placements.splice(0); return s.provider.host; };
            expect((await s.run(operation)).body).toMatchObject({ eligible: false, failureCode: 'image_job_conflict', jobId: null });
            expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0);
        });
        it(`${operation} leaves unique 8dbc behavior unchanged with no source observation`, async () => {
            const s = rebaseSetup(), f = fixtureReleaseRegistry106();
            s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [f.entry.region]: f.entry });
            s.fake.placements[0]!.lower_image_digest = LOWER_102;
            expect((await s.run(operation)).body).toMatchObject({ eligible: true, failureCode: null });
            expect(s.deps.describer.describeForEnrollment).not.toHaveBeenCalled();
            if (operation === 'prepare') expect((await s.current()).sourceRelease).toEqual(f.release102);
        });
    }
    it('refuses provider errors before reservation', async () => {
        const s = sharedLowerSetup(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            s.deps.describer.describeForEnrollment = async () => { throw new Error('describe failed'); };
            expect((await s.run('prepare')).body).toMatchObject({ eligible: false, failureCode: 'operator_required', jobId: null });
            expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0);
        } finally { log.mockRestore(); }
    });
    it.each(['imageId', 'amiId', 'sourceRelease'])('keeps HTTP input closed to %s', async field => {
        const s = sharedLowerSetup();
        await expect(handleImageRebase(s.deps, { schemaVersion: 1, operation: 'prepare', computerId: s.source.computerId,
            jobId: null, [field]: s.f.release105.amiId })).rejects.toThrow();
        expect(s.deps.describer.describeForEnrollment).not.toHaveBeenCalled(); expect(s.fake.imageJobs).toHaveLength(0);
    });
});
