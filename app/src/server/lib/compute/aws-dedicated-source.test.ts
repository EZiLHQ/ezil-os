import { describe, expect, it, vi } from 'vitest';
import { fixtureRebasePreparation } from './aws-intent.test-support';
import { buildRebasePreparation, RebasePreparationSchema } from './aws-rebase-preparation';
import { dedicatedSetup } from './aws-dedicated-source.test-support';
import { dedicatedProvisionWork, proveReleasedDedicatedHost, readReleasedDedicatedHostProof } from './aws-dedicated-source';
import { readRetiredSourceProof } from './aws-historical-source';
import { handleImageRebase } from './aws-rebase-orchestrator';
import { AwsClientError } from './aws-errors';
import { rebaseSetup } from './aws-rebase.test-support';
import { handleAwsEnrollment } from './aws-enroll';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { buildLifecycleWork } from './aws-intent';
import { applyLifecycleReceipt, lifecycleExecutionArn } from './aws-receipts';
import { releaseHistory } from './aws-historical-source.test-support';
import { parseImageJobRow, validateImageJob } from './aws-rebase-store';
vi.mock('./aws-identity', () => ({ readIdentityCertificate: () => 'test-certificate', verifyIdentitySignature: () => ({ ok: true }) }));
// Pass-through spies: each proof kind's reader is observable, so a test can prove the other kind was never consulted.
vi.mock('./aws-dedicated-source', async original => {
    const m = await original<typeof import('./aws-dedicated-source')>();
    return { ...m, readReleasedDedicatedHostProof: vi.fn(m.readReleasedDedicatedHostProof) };
});
vi.mock('./aws-historical-source', async original => {
    const m = await original<typeof import('./aws-historical-source')>();
    return { ...m, readRetiredSourceProof: vi.fn(m.readRetiredSourceProof) };
});
type Setup = Awaited<ReturnType<typeof dedicatedSetup>>;
const OTHER = '99999999-9999-4999-8999-999999999999';
const proof = (s: Setup) => proveReleasedDedicatedHost(s.p, s.target, s.row, s.provision, s.histories.get(s.provisionArn)!,
    s.retired, s.histories.get(s.releaseArn)!, s.releaseArn, s.deps.now());
const noMutation = (s: Setup) => { expect(s.fake.imageJobs).toHaveLength(1); expect(s.started).toHaveLength(0); expect(s.fake.poolHosts).toHaveLength(0); };
describe('dedicated launch + retirement source proof', () => {
    it('automatically updates a released dedicated host with an ambiguous lower using the saved normal retirement', async () => {
        const s = await dedicatedSetup(true);
        s.advance(2_000);
        const placement = s.fake.placements[0]!;
        Object.assign(placement, { state: 'STOPPING', lifecycle_job_id: s.release.intent.jobId, lifecycle_digest: s.release.digest });
        await applyLifecycleReceipt({ db: s.fake.db, executions: s.deps.executions, now: s.deps.now },
            { ...s.p, state: 'STOPPING', lifecycleJobId: s.release.intent.jobId, lifecycleDigest: s.release.digest }, s.target);
        expect(placement).toMatchObject({ state: 'STOPPED', retired_host_release: { executionArn: s.releaseArn } });
        const update = await handleImageRebase(s.deps, { schemaVersion: 1, operation: 'prepare', computerId: s.j.computerId, jobId: null },
            { ownerUserId: s.owner, allowStart: true, canBoot: async () => true });
        expect(update.body).toMatchObject({ eligible: true, phase: 'fencing' });
        const job = await s.current();
        expect(job.sourceRelease).toEqual(s.sourceRelease);
        expect(JSON.parse(job.preparationDocument).releasedDedicatedHost.releaseExecutionArn).toBe(s.releaseArn);
        expect(s.started).toHaveLength(1);
    });

    it('selects original provision tuple despite a conflicting requested retirement AMI and ambiguous shared lower', async () => {
        const s = await dedicatedSetup();
        expect(s.release.intent.deployment.amiId).not.toBe(s.source.amiId);
        expect(proof(s)?.provisioned).toEqual(s.source);
        expect((await s.request('plan')).body).toMatchObject({ eligible: true, failureCode: null }); noMutation(s);
        expect((await s.request('prepare')).status).toBe(202);
        const j = await s.current(), p = JSON.parse(j.preparationDocument);
        expect(j.sourceRelease).toEqual(s.sourceRelease); expect(p.sourceDeployment.amiId).toBe(s.source.amiId);
        expect(p.releasedPoolHost).toBeUndefined(); expect(p.releasedDedicatedHost).toEqual({
            imageJobId: s.row.imageJobId, provisionDigest: s.row.digest, provisionExecutionArn: s.provisionArn, releaseExecutionArn: s.releaseArn });
        expect(Object.keys(p).at(-1)).toBe('releasedDedicatedHost'); expect(s.started).toHaveLength(1);
        expect(s.fake.poolHosts).toHaveLength(0);
    });
    it.each([
        ['ownerUserId', OTHER], ['computerId', OTHER], ['generation', 8], ['leaseEpoch', 1], ['fenceToken', OTHER],
        ['volumeId', 'vol-99999999999999999'], ['instanceId', 'i-99999999999999999'], ['fsUuid', OTHER],
        ['state', 'RUNNING'], ['store', 'other'], ['instanceType', 'c6i.xlarge'], ['lifecycleJobId', OTHER],
        ['lowerImageDigest', 'sha256:' + 'f'.repeat(64)], ['region', 'us-east-1'], ['zoneId', 'aps1-az2'],
    ] as const)('rejects changed current placement %s', async (key, value) => {
        const s = await dedicatedSetup(); Object.assign(s.p, { [key]: value }); expect(proof(s)).toBeNull(); noMutation(s);
    });
    it.each(['document', 'digest', 'executionArn', 'imageJobId', 'phase', 'instanceId', 'volumeId', 'fsUuid', 'fenceToken', 'ownerUserId'] as const)(
        'rejects tampered archived %s', async key => {
            const s = await dedicatedSetup(); Object.assign(s.row, { [key]: key === 'document' ? s.row.document + ' ' : 'tamper' });
            expect(dedicatedProvisionWork(s.p, s.target, s.row)).toBeNull(); expect(proof(s)).toBeNull();
        });
    it.each(['provision', 'retired'] as const)('rejects failed/redriven/aliased/changed-input %s', async field => {
        for (const patch of [{ status: 'FAILED' }, { redriveCount: 1 }, { stateMachineAliasArn: 'alias' }, { input: '{}' },
            { stateMachineVersionArn: 'foreign' }, { executionArn: 'foreign' }]) {
            const s = await dedicatedSetup(); Object.assign(s[field], patch); expect(proof(s)).toBeNull(); noMutation(s);
        }
    });
    it.each(['wrongImage', 'wrongInstance', 'splitInstances', 'disconnected', 'duplicate', 'truncated', 'missing', 'tag', 'requestImage', 'clientToken'] as const)(
        'rejects %s launch evidence rather than scanning for any matching AMI', async fault => {
            const s = await dedicatedSetup(), h = s.histories.get(s.provisionArn)!;
            const done = h[4]!.taskSucceededEventDetails!, params = JSON.parse(h[2]!.taskScheduledEventDetails!.parameters!);
            const output = JSON.parse(done.output!);
            if (fault === 'wrongImage') output.Instances[0].ImageId = s.target.amiId;
            if (fault === 'wrongInstance') output.Instances[0].InstanceId = 'i-99999999999999999';
            if (fault === 'splitInstances') output.Instances = [{ InstanceId: s.p.instanceId, ImageId: s.target.amiId, InstanceType: 'm6i.large' },
                { InstanceId: 'i-99999999999999999', ImageId: s.source.amiId, InstanceType: 'm6i.large' }];
            done.output = JSON.stringify(output);
            if (fault === 'disconnected') h[4]!.previousEventId = 2;
            if (fault === 'duplicate') h[5] = { ...structuredClone(h[4]!), id: 6, previousEventId: 4 };
            if (fault === 'truncated') done.outputDetails = { truncated: true };
            if (fault === 'missing') h.splice(4, 1);
            if (fault === 'tag') params.TagSpecifications[0].Tags.push({ Key: 'extra', Value: 'tamper' });
            if (fault === 'requestImage') params.ImageId = s.target.amiId;
            if (fault === 'clientToken') params.ClientToken = 'f'.repeat(64);
            h[2]!.taskScheduledEventDetails!.parameters = JSON.stringify(params);
            expect(proof(s)).toBeNull(); noMutation(s);
        });
    it.each(['missingWitness', 'notTerminated', 'wrongInstance', 'truncated', 'replayTime', 'wrongLease'] as const)(
        'rejects %s retirement evidence', async fault => {
            const s = await dedicatedSetup(), h = s.histories.get(s.releaseArn)!;
            const witness = h.find(e => e.type === 'TaskSucceeded' && e.taskSucceededEventDetails?.resource === 'terminateInstances')!;
            if (fault === 'missingWitness') witness.taskSucceededEventDetails!.resource = 'describeInstances';
            if (fault === 'notTerminated') witness.taskSucceededEventDetails!.output = JSON.stringify({ TerminatingInstances: [{
                InstanceId: s.p.instanceId, CurrentState: { Code: 32, Name: 'shutting-down' } }] });
            if (fault === 'wrongInstance') witness.taskSucceededEventDetails!.output = JSON.stringify({ TerminatingInstances: [{
                InstanceId: 'i-99999999999999999', CurrentState: { Code: 48, Name: 'terminated' } }] });
            if (fault === 'truncated') h[0]!.executionStartedEventDetails!.inputDetails = { truncated: true };
            if (fault === 'replayTime') s.retired.startDate = new Date(s.provision.startDate!.getTime() - 1);
            if (fault === 'wrongLease') { const r = JSON.parse(s.retired.output); r.leaseEpoch--; s.retired.output = JSON.stringify(r); }
            expect(proof(s)).toBeNull();
        });
    it('requires explicit exact retirement hint and no listed EC2 source, including terminated', async () => {
        for (const hint of [null, 'arn:aws:states:nope']) {
            const s = await dedicatedSetup(); expect((await s.request('prepare', hint)).body.eligible).toBe(false);
            expect(s.deps.executions.describe).not.toHaveBeenCalled(); noMutation(s);
        }
        for (const state of ['terminated', 'running', 'stopped']) {
            const s = await dedicatedSetup(); s.provider.host = { instanceId: s.p.instanceId!, imageId: s.source.amiId, state,
                availabilityZone: 'ap-south-1a', availabilityZoneId: s.p.zoneId!, publicIp: null, tags: {}, volumes: [] };
            expect((await s.request('prepare')).body).toMatchObject({ eligible: false, failureCode: 'source_identity_mismatch' }); noMutation(s);
        }
    });
    it('rejects missing/ambiguous/nonterminal archive without creating a pool row', async () => {
        for (const fault of ['missing', 'ambiguous', 'failed'] as const) {
            const s = await dedicatedSetup();
            if (fault === 'missing') s.fake.imageJobs.splice(0);
            if (fault === 'ambiguous') s.fake.imageJobs.push({ ...s.fake.imageJobs[0]!, job_id: OTHER });
            if (fault === 'failed') s.fake.imageJobs[0]!.phase = 'failed';
            expect((await s.request('prepare')).body.eligible).toBe(false);
            expect(s.started).toHaveLength(0); expect(s.fake.poolHosts).toHaveLength(0);
        }
    });
    it('rechecks exact current placement after external proof reads', async () => {
        const s = await dedicatedSetup(), real = s.deps.describer.describeForEnrollment;
        s.deps.describer.describeForEnrollment = vi.fn(async (region, id) => {
            s.fake.placements[0]!.fence_token = OTHER; return real(region, id);
        });
        expect((await s.request('prepare')).body.eligible).toBe(false); noMutation(s);
    });
});

describe('dedicated preparation protocol and locked reservation', () => {
    it('rechecks instance type, store, archive bytes and ambiguity at the final reservation lock', async () => {
        for (const fault of ['instanceType', 'store', 'archive', 'ambiguity'] as const) {
            const s = await dedicatedSetup(), reserve = s.deps.store.reserve;
            s.deps.store.reserve = async (...args) => {
                if (fault === 'instanceType') s.fake.placements[0]!.instance_type = 'c6i.xlarge';
                if (fault === 'store') s.fake.placements[0]!.workspace_store = 'other';
                if (fault === 'archive') s.fake.imageJobs[0]!.launch_digest = 'f'.repeat(64);
                if (fault === 'ambiguity') s.fake.imageJobs.push({ ...s.fake.imageJobs[0]!, job_id: OTHER });
                return reserve(...args);
            };
            expect((await s.request('prepare')).body.eligible, fault).toBe(false);
            expect(s.started).toHaveLength(0); expect(s.fake.imageJobs).toHaveLength(fault === 'ambiguity' ? 2 : 1);
            expect(s.fake.placements[0]!.image_upgrade_job_id).toBeNull();
        }
    });
    it('appends only the distinct field; strict old helpers refuse it, and wrong identity/extra keys cannot parse', async () => {
        const s = await dedicatedSetup();
        const released = { imageJobId: s.row.imageJobId, provisionDigest: s.row.digest,
            provisionExecutionArn: s.provisionArn, releaseExecutionArn: s.releaseArn };
        const base = fixtureRebasePreparation();
        expect(buildRebasePreparation({ ...base.intent, releasedDedicatedHost: undefined }).document).toBe(base.document);
        const work = buildRebasePreparation({ ...base.intent, releasedDedicatedHost: released });
        const old = RebasePreparationSchema.innerType().omit({ releasedDedicatedHost: true }).strict();
        expect(old.safeParse(base.intent).success).toBe(true); expect(old.safeParse(work.intent).success).toBe(false);
        for (const patch of [{ extra: true }, { provisionDigest: 'short' }, { imageJobId: 'not-uuid' },
            { provisionExecutionArn: released.releaseExecutionArn },
            { provisionExecutionArn: released.provisionExecutionArn.replace('-lifecycle:', '-recovery:') },
            { releaseExecutionArn: released.releaseExecutionArn.replace('123456789012', '999999999999') }]) {
            expect(() => buildRebasePreparation({ ...base.intent, releasedDedicatedHost: { ...released, ...patch } })).toThrow();
        }
        expect(() => buildRebasePreparation({ ...work.intent, releasedPoolHost: { poolHostId: OTHER, lifecycleDigest: 'a'.repeat(64),
            releaseExecutionArn: s.releaseArn } })).toThrow();
        // Closed three-way exclusivity: never R2 together with a dedicated proof.
        expect(() => buildRebasePreparation({ ...work.intent, retiredSource: { releaseExecutionArn: s.releaseArn } })).toThrow();
    });
});

describe('trusted source kind: registry source count selects R2 or dedicated before any proof', () => {
    const unique = (s: Setup) => {
        s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [s.target.region]: { ...s.target,
            releases: [s.sourceRelease, JSON.parse(s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS!)[s.target.region].releases.at(-1)] } });
    };
    const absentLaunch = (s: Setup) => {
        const history = s.deps.executions.history!;
        s.deps.executions.history = vi.fn(async (region: string, arn: string) => {
            if (arn === s.provisionArn) throw new AwsClientError('aws_config', false, 'ExecutionDoesNotExist');
            return history(region, arn);
        });
        s.executions.delete(s.provisionArn);
    };
    const reset = () => { vi.mocked(readReleasedDedicatedHostProof).mockClear(); vi.mocked(readRetiredSourceProof).mockClear(); };
    it.each(['succeeded', 'duplicate'] as const)(
        'a unique lower stays MAIN R2 with a %s archive and the old launch gone; the dedicated reader is never called', async archive => {
            const s = await dedicatedSetup(); unique(s); absentLaunch(s);
            if (archive === 'duplicate') s.fake.imageJobs.push({ ...s.fake.imageJobs[0]!, job_id: OTHER });
            reset(); const lookup = vi.spyOn(s.deps.store, 'releasedDedicatedHost');
            expect((await s.request('prepare')).status).toBe(202);
            const p = JSON.parse((await s.current()).preparationDocument);
            expect(p.retiredSource).toEqual({ releaseExecutionArn: s.releaseArn });
            expect(p.releasedDedicatedHost).toBeUndefined(); expect(p.releasedPoolHost).toBeUndefined();
            expect(readRetiredSourceProof).toHaveBeenCalledTimes(1);
            expect(readReleasedDedicatedHostProof).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
        });
    it('a unique lower stays MAIN R2 for a genuine recovered archive of the current host; the dedicated reader is never called', async () => {
        // The real recovery path (aws-rebase-orchestrator.test): failed launch -> restore -> maintenance rebind -> recovered parent.
        const s = rebaseSetup(); expect((await s.run('prepare')).status).toBe(202);
        await s.completePreparation(); expect((await s.run('launch')).status).toBe(202);
        let j = await s.current();
        Object.assign(s.executions.get(j.launchExecutionArn!)!, { status: 'FAILED' });
        await s.run('verify'); expect((await s.run('recover', j.jobId)).body.phase).toBe('restore_pending');
        await s.completeRecovery(); expect((await s.run('recover', j.jobId)).body.phase).toBe('rebind_pending');
        j = await s.current();
        const lease = parseEnrollmentUserData(JSON.parse(j.rebindDocument!).userData);
        await s.completeRebind();
        const report = { v: 1, recoveryJobId: j.recoveryJobId, snapshotId: j.snapshotId, originalVolumeId: j.sourceVolumeId, volumeId: j.restoredVolumeId, fsUuid: j.fsUuid };
        expect(await handleAwsEnrollment({ db: s.fake.db, env: s.env, now: s.deps.now, describer: s.deps.describer }, {
            computerId: j.computerId, generation: j.rebindGeneration, leaseEpoch: j.rebindLeaseEpoch, nonce: lease.nonce,
            identityDocument: JSON.stringify({ accountId: s.source.deployment.accountId, region: j.region, instanceId: s.provider.host!.instanceId,
                instanceType: 'm6i.large', availabilityZone: 'ap-south-1a' }), signature: 'x'.repeat(16), lowerImageDigest: j.fromDigest, ebsRestore: report }))
            .toEqual({ status: 200, body: { maintenance: true, accepted: true } });
        expect((await s.run('recover', j.jobId)).body.phase).toBe('recovered');
        const archive = s.fake.imageJobs.find(r => r.job_id === j.jobId)!;
        // The linked retry child is not part of this case: drop it and let the rebind host age out after a normal release.
        s.fake.imageJobs.splice(0, s.fake.imageJobs.length, archive);
        const placed = s.fake.placements[0]!;
        Object.assign(placed, { state: 'STOPPED', image_upgrade_job_id: null, lifecycle_job_id: null, lifecycle_digest: null,
            enroll_nonce_hash: null, enroll_consumed_hash: null, enroll_expires_at: null });
        s.provider.host = null; Object.assign(s.provider.restoredVolume!, { state: 'available', attachments: [] });
        const p = (await s.store.inspect(j.computerId)).placement!;
        // Precondition: a genuine recovered archive (production parser + validator) that enrolled THIS current host.
        const parsed = validateImageJob(parseImageJobRow({ ...archive }));
        expect(parsed).toMatchObject({ phase: 'recovered', retentionHold: true });
        expect(parsed.hostEvidence).toMatchObject({ instanceId: p.instanceId, volumeId: p.volumeId, generation: p.generation });
        expect(parsed.hostEvidence!.ebsRestore).toBeDefined();
        // A valid normal retirement of the rebind host; no launch history exists for it at all.
        const d = s.source.deployment, RELEASE = 'e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4';
        const release = buildLifecycleWork({ schemaVersion: 1, jobId: RELEASE, computerId: p.computerId, revision: 1, operation: 'release',
            targetGeneration: p.generation, leaseEpoch: p.leaseEpoch, fenceToken: p.fenceToken!, providerInstanceId: p.instanceId,
            dataVolumeId: p.volumeId, previousGeneration: null, previousInstanceId: null, previousFenceToken: null,
            deployment: d, instanceType: 'm6i.large', dataVolumeGiB: null, userData: null });
        const releaseArn = lifecycleExecutionArn(d, RELEASE), start = new Date(s.deps.now().getTime() - 60_000);
        const output = JSON.stringify({ schemaVersion: 1, jobId: RELEASE, digest: release.digest, computerId: p.computerId, generation: p.generation,
            leaseEpoch: p.leaseEpoch, fenceToken: p.fenceToken, instanceId: p.instanceId, volumeId: p.volumeId, state: 'retired' });
        s.executions.set(releaseArn, { executionArn: releaseArn, status: 'SUCCEEDED', stateMachineVersionArn: release.stateMachineArn, redriveCount: 0,
            startDate: start, stopDate: new Date(start.getTime() + 1000), input: release.input, output });
        const history = releaseHistory(release.input, output, p.instanceId!, start);
        s.deps.executions.history = vi.fn(async (_region: string, arn: string) => {
            if (arn !== releaseArn) throw new AwsClientError('aws_config', false, 'ExecutionDoesNotExist');
            return structuredClone(history);
        });
        reset(); const lookup = vi.spyOn(s.deps.store, 'releasedDedicatedHost');
        s.started.splice(0);
        expect((await handleImageRebase(s.deps, { schemaVersion: 1, operation: 'prepare', computerId: p.computerId, jobId: null,
            sourceRetirementExecutionArn: releaseArn })).status).toBe(202);
        const prep = JSON.parse((await s.current()).preparationDocument);
        expect(prep.retiredSource).toEqual({ releaseExecutionArn: releaseArn }); expect(prep.releasedDedicatedHost).toBeUndefined();
        expect(readRetiredSourceProof).toHaveBeenCalledTimes(1);
        expect(readReleasedDedicatedHostProof).not.toHaveBeenCalled(); expect(lookup).not.toHaveBeenCalled();
    });
    it('a shared lower with a valid archive is dedicated only; R2 is never called', async () => {
        const s = await dedicatedSetup(); reset();
        expect((await s.request('prepare')).status).toBe(202);
        expect(JSON.parse((await s.current()).preparationDocument).releasedDedicatedHost?.imageJobId).toBe(s.row.imageJobId);
        expect(readReleasedDedicatedHostProof).toHaveBeenCalledTimes(1); expect(readRetiredSourceProof).not.toHaveBeenCalled();
    });
    it.each(['missingArchive', 'expiredLaunch', 'wrongImage', 'partialArchive', 'duplicate', 'nonterminal'] as const)(
        'a shared lower with %s fails closed with the valid R2 release never consulted', async fault => {
            const s = await dedicatedSetup(); reset();
            if (fault === 'missingArchive') s.fake.imageJobs.splice(0);
            if (fault === 'expiredLaunch') absentLaunch(s);
            if (fault === 'wrongImage') {
                const done = s.histories.get(s.provisionArn)![4]!.taskSucceededEventDetails!, out = JSON.parse(done.output!);
                out.Instances[0].ImageId = s.target.amiId; done.output = JSON.stringify(out);
            }
            if (fault === 'partialArchive') s.fake.imageJobs[0]!.fs_uuid = OTHER;
            if (fault === 'duplicate') s.fake.imageJobs.push({ ...s.fake.imageJobs[0]!, job_id: OTHER });
            if (fault === 'nonterminal') s.fake.imageJobs[0]!.phase = 'failed';
            // A row the production validator refuses (hostEvidence.fsUuid != fsUuid; a failed phase with no failureCode, which
            // `active`/inspect also reads) is an image_job_conflict before any proof reader; every other fault is a mismatch.
            const malformed = fault === 'partialArchive' || fault === 'nonterminal';
            expect((await s.request('prepare')).body).toMatchObject({ eligible: false,
                failureCode: malformed ? 'image_job_conflict' : 'source_identity_mismatch' });
            expect(readRetiredSourceProof).not.toHaveBeenCalled();
            if (fault === 'missingArchive' || malformed) expect(readReleasedDedicatedHostProof).not.toHaveBeenCalled();
            expect(s.started).toHaveLength(0); expect(s.fake.imageJobs.some(j => j.phase === 'reserved')).toBe(false);
            expect(s.fake.placements[0]!.image_upgrade_job_id).toBeNull();
        });
    it('a pool claim row selects the pool path: neither the dedicated nor the R2 reader runs', async () => {
        const s = await dedicatedSetup(); reset();
        s.fake.poolHosts.push({ id: OTHER, generation: 1, region: s.p.region, zone_id: s.p.zoneId, instance_type: 'm6i.large',
            instance_id: s.p.instanceId, state: 'retired', leased_computer_id: s.p.computerId, claim_generation: s.p.generation,
            claim_lease_epoch: s.p.leaseEpoch, claim_fence: s.p.fenceToken, claim_volume_serial: s.p.volumeId!.replace('-', ''),
            dispatch_status: 'settled', lifecycle_job_id: OTHER, lifecycle_digest: 'a'.repeat(64), lifecycle_input: '{}' });
        expect((await s.request('prepare')).body.eligible).toBe(false);
        expect(readReleasedDedicatedHostProof).not.toHaveBeenCalled(); expect(readRetiredSourceProof).not.toHaveBeenCalled();
        expect(s.started).toHaveLength(0);
    });
});
