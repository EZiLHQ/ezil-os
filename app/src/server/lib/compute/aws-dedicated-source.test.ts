import { describe, expect, it, vi } from 'vitest';
import { fixtureRebasePreparation } from './aws-intent.test-support';
import { buildRebasePreparation, RebasePreparationSchema } from './aws-rebase-preparation';
import { dedicatedSetup } from './aws-dedicated-source.test-support';
import { dedicatedProvisionWork, proveReleasedDedicatedHost } from './aws-dedicated-source';
vi.mock('./aws-identity', () => ({ readIdentityCertificate: () => 'test-certificate', verifyIdentitySignature: () => ({ ok: true }) }));
type Setup = Awaited<ReturnType<typeof dedicatedSetup>>;
const OTHER = '99999999-9999-4999-8999-999999999999';
const proof = (s: Setup) => proveReleasedDedicatedHost(s.p, s.target, s.row, s.provision, s.histories.get(s.provisionArn)!,
    s.retired, s.histories.get(s.releaseArn)!, s.releaseArn, s.deps.now());
const noMutation = (s: Setup) => { expect(s.fake.imageJobs).toHaveLength(1); expect(s.started).toHaveLength(0); expect(s.fake.poolHosts).toHaveLength(0); };
describe('dedicated launch + retirement source proof', () => {
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
    });
});
