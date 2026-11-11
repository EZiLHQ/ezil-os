import { describe, expect, it, vi } from 'vitest';
import { handleImageRebase } from './aws-rebase-orchestrator';
import { releasedPoolSetup, RELEASED_POOL_HOST } from './aws-rebase.test-support';
import { fixtureReleaseRegistry106 } from './aws-rebase-release-registry.test-support';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { nonceHashOf } from './aws-enroll';
import { LifecycleDeploymentSchema } from './aws-intent';

type Setup = ReturnType<typeof releasedPoolSetup>;
const OTHER = '99999999-9999-4999-8999-999999999999';
/** Refused before reservation: no job, no execution started. `hint` null: none sent; omitted: the proven release. */
async function refused(s: Setup, operation: 'plan' | 'prepare', code: string, hint: string | null = s.releaseArn) {
    expect((await s.request(operation, hint)).body).toMatchObject({ eligible: false, failureCode: code, jobId: null });
    expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0);
    expect(s.fake.placements[0]!.image_upgrade_job_id).toBeNull();
}

describe('DESIGN R: a STOPPED computer whose warm-pool host was released', () => {
    it('plans without writes, then reserves one preparation pinned to the provisioned record of a shared lower', async () => {
        const s = releasedPoolSetup({ shared: true });
        expect((await s.request('plan')).body).toMatchObject({ eligible: true, failureCode: null, jobId: null });
        expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0);
        expect(s.deps.executions.history).toHaveBeenCalledWith('ap-south-1', s.releaseArn);
        expect(s.deps.describer.describeForEnrollment).toHaveBeenCalledTimes(1);
        expect((await s.request('prepare')).status).toBe(202);
        const j = await s.current(), document = JSON.parse(j.preparationDocument);
        // 1.0.5 and 1.0.6 share lower 34ac; the aged-out host has no AMI to observe, so only the proven tuple selects 1.0.5.
        expect(j.sourceRelease).toEqual(s.f.release105);
        expect(document.sourceDeployment).toMatchObject({ amiId: s.f.release105.amiId, stateMachineVersionArn: s.f.release105.stateMachineVersionArn });
        expect(Object.keys(document).at(-1)).toBe('releasedPoolHost');
        expect(document.releasedPoolHost).toEqual({ poolHostId: RELEASED_POOL_HOST, lifecycleDigest: s.provision().digest, releaseExecutionArn: s.releaseArn });
        expect(s.started).toHaveLength(1); expect(JSON.parse(s.started[0]!.input).document).toBe(j.preparationDocument);
        expect(s.fake.placements[0]!.image_upgrade_job_id).toBe(j.jobId);
        // A reserved job resumes; it is never re-proven or re-reserved.
        const reads = vi.mocked(s.deps.executions.history!).mock.calls.length;
        expect((await s.request('prepare')).status).toBe(202);
        expect(s.fake.imageJobs).toHaveLength(1); expect(s.started).toHaveLength(1);
        expect(s.deps.executions.history).toHaveBeenCalledTimes(reads);
    });
    it('plans and prepares a proven legacy launch with absent image keys using the retained source record', async () => {
        const s = releasedPoolSetup({ shared: true });
        const fields = ['lowerImageDigest', 'previousLowerImageDigest', 'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn'];
        const legacy = LifecycleDeploymentSchema.parse(Object.fromEntries(Object.entries(s.provisioned).filter(([k]) => !fields.includes(k))));
        const record = { ...s.f.release105, previousLowerImageDigest: null, previousLowerImageRef: null,
            preparationStateMachineVersionArn: null };
        s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [s.f.entry.region]: { ...s.f.entry,
            releases: s.f.entry.releases.map(r => r === s.f.release105 ? record : r) } });
        s.setProvision(legacy); s.setRelease({ deployment: legacy });
        const canonicalProvision = s.provision().input;
        expect((await s.request('plan')).body).toMatchObject({ eligible: true, failureCode: null, jobId: null });
        expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0);
        expect((await s.request('prepare')).status).toBe(202);
        const job = await s.current(), document = JSON.parse(job.preparationDocument);
        expect(job.sourceRelease).toEqual(record);
        expect(document.sourceDeployment).toMatchObject({ amiId: record.amiId, launchTemplateVersion: record.launchTemplateVersion,
            stateMachineVersionArn: record.stateMachineVersionArn, lowerImageDigest: record.lowerImageDigest,
            previousLowerImageDigest: null, preparationStateMachineVersionArn: null,
            recoveryStateMachineVersionArn: record.recoveryStateMachineVersionArn });
        expect(document.releasedPoolHost).toEqual({ poolHostId: RELEASED_POOL_HOST,
            lifecycleDigest: s.provision().digest, releaseExecutionArn: s.releaseArn });
        expect(s.started).toHaveLength(1); expect(JSON.parse(s.started[0]!.input).document).toBe(job.preparationDocument);
        expect(s.provision().input).toBe(canonicalProvision);
        expect(fields.every(k => !Object.prototype.hasOwnProperty.call(legacy, k))).toBe(true);
    });
    it('accepts a unique lower whose aged-out host is the released one', async () => {
        const s = releasedPoolSetup();
        expect((await s.request('prepare')).status).toBe(202);
        const j = await s.current();
        expect(j.sourceRelease.amiId).toBe(s.provisioned.amiId);
        expect(JSON.parse(j.preparationDocument).releasedPoolHost.poolHostId).toBe(RELEASED_POOL_HOST);
    });
    it('selects the exact tuple among same-AMI records differing only in workflow versions, where an AMI view cannot', async () => {
        const alias = (s: Setup) => {
            const twin = { ...s.f.release105, preparationStateMachineVersionArn: s.f.release105.preparationStateMachineVersionArn.replace(/:1$/, ':7'),
                recoveryStateMachineVersionArn: s.f.release105.recoveryStateMachineVersionArn.replace(/:1$/, ':7'), createdAt: '2026-10-21T11:00:00.000Z' };
            s.f.entry.releases.splice(2, 0, twin); s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [s.f.entry.region]: s.f.entry });
        };
        const s = releasedPoolSetup({ shared: true }); alias(s);
        expect((await s.request('prepare')).status).toBe(202);
        expect((await s.current()).sourceRelease).toEqual(s.f.release105);
        // Window prerequisite: a live host observed by AMI alone now matches both records.
        const live = releasedPoolSetup({ shared: true }); alias(live); live.fake.poolHosts.splice(0);
        live.provider.host = { ...live.terminatedHost(), state: 'stopped', tags: { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot',
            'ezil:computer-id': live.source.computerId, 'ezil:generation': '1', 'ezil:fence-token': live.source.sourceFenceToken } };
        await refused(live, 'prepare', 'release_mismatch', null);
    });

    for (const operation of ['plan', 'prepare'] as const) {
        it.each([
            ['missing', null], ['not an ARN', 'arn:aws:states:nope'], ['another machine', 'recovery'], ['another account', 'account'],
            ['another region', 'region'],
        ] as const)(`${operation} refuses a %s release hint before any execution read`, async (_name, fault) => {
            const s = releasedPoolSetup({ shared: true });
            const hint = fault === null ? null : fault === 'recovery' ? s.releaseArn.replace('-lifecycle:', '-recovery:')
                : fault === 'account' ? s.releaseArn.replace('123456789012', '999999999999')
                : fault === 'region' ? s.releaseArn.replace(':ap-south-1:', ':us-east-1:') : fault;
            await refused(s, operation, 'source_identity_mismatch', hint);
            expect(s.deps.executions.describe).not.toHaveBeenCalled(); expect(s.deps.executions.history).not.toHaveBeenCalled();
        });
        it(`${operation} refuses the provision execution named as the release`, async () => {
            const s = releasedPoolSetup({ shared: true }); await refused(s, operation, 'source_identity_mismatch', s.provisionArn);
        });
        // Any listed host, even the exact terminated claim of this allocation: launch, recovery and maintenance accept an
        // absent source but refuse its claim tags after the snapshot (infra rebase-preparation.test.ts, released launch).
        it.each(['terminated', 'shutting-down', 'running', 'stopped', 'stopping', 'pending'])(`${operation} refuses a listed %s host, never stopping it`, async state => {
            const s = releasedPoolSetup({ shared: true }); s.provider.host = { ...s.terminatedHost(), state };
            await refused(s, operation, 'source_identity_mismatch');
            expect(s.deps.executions.history).toHaveBeenCalledTimes(1);
        });
        // No matching retired claim row: R never applies; the shared lower needs a live AMI view, which an aged-out host lacks.
        it.each([
            ['state', 'leased'], ['state', 'retiring'], ['state', 'failed'], ['dispatch_status', 'started'], ['dispatch_status', null],
            ['leased_computer_id', OTHER], ['instance_id', 'i-99999999999999999'], ['region', 'us-east-1'], ['zone_id', 'aps1-az2'],
            ['claim_generation', 2], ['claim_lease_epoch', 2], ['claim_fence', OTHER], ['claim_volume_serial', 'vol99999999999999999'],
            ['lifecycle_job_id', null], ['lifecycle_digest', null], ['lifecycle_input', null],
        ] as const)(`${operation} never uses a pool row whose %s is %s`, async (column, value) => {
            const s = releasedPoolSetup({ shared: true }); s.row[column] = value;
            await refused(s, operation, 'source_identity_mismatch');
            expect(s.deps.executions.history).not.toHaveBeenCalled();
        });
        it(`${operation} refuses a placement whose epoch moved past the claim (stale row)`, async () => {
            const s = releasedPoolSetup({ shared: true }); s.fake.placements[0]!.lease_epoch = 4;
            await refused(s, operation, 'source_identity_mismatch'); expect(s.deps.executions.history).not.toHaveBeenCalled();
        });
        it(`${operation} refuses two matching retired rows as a conflict`, async () => {
            const s = releasedPoolSetup({ shared: true }); s.fake.poolHosts.push({ ...s.row, id: OTHER });
            await refused(s, operation, 'image_job_conflict');
        });
        it.each([
            ['digest', (s: Setup) => { s.row.lifecycle_digest = 'f'.repeat(64); }],
            ['input', (s: Setup) => { s.row.lifecycle_input = String(s.row.lifecycle_input).replace(s.provisioned.amiId, s.f.release106.amiId); }],
            ['re-hashed input', (s: Setup) => {
                // A consistent rewrite of the app record (AMI swapped, digest recomputed) still differs from the provider-held input.
                const recorded = s.provisionArn, real = s.executions.get(recorded)!;
                s.setProvision({ ...s.provisioned, amiId: s.f.release106.amiId }); s.executions.set(recorded, real);
            }],
            ['pool generation', (s: Setup) => { s.row.generation = 2; }], ['instance type', (s: Setup) => { s.row.instance_type = 'm6i.xlarge'; }],
        ] as const)(`${operation} refuses a tampered row %s`, async (_name, tamper) => {
            const s = releasedPoolSetup({ shared: true }); tamper(s);
            await refused(s, operation, 'source_identity_mismatch');
        });
        it.each([
            ['RUNNING', { status: 'RUNNING' }], ['FAILED', { status: 'FAILED' }], ['TIMED_OUT', { status: 'TIMED_OUT' }],
            ['redriven', { redriveCount: 1 }], ['aliased', { stateMachineAliasArn: 'alias' }], ['without stopDate', { stopDate: undefined }],
            ['another version', { stateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-pilot-lifecycle:99' }],
            ['receipt instance', { output: 'instanceId' }], ['receipt host', { output: 'poolHostId' }], ['receipt state', { output: 'state' }],
            // The receipt alone still matches the row: only the provider-held input binds this execution to it.
            ['started with another input', { input: '{"schemaVersion":1}' }],
        ] as const)(`${operation} refuses a provision execution that is %s`, async (_name, patch) => {
            const s = releasedPoolSetup({ shared: true }), e = s.executions.get(s.provisionArn)!;
            const out = JSON.parse(e.output!);
            if ('output' in patch) Object.assign(e, { output: JSON.stringify({ ...out, [patch.output]: patch.output === 'instanceId'
                ? 'i-99999999999999999' : patch.output === 'state' ? 'retired' : OTHER }) });
            else Object.assign(e, patch);
            await refused(s, operation, 'source_identity_mismatch');
        });
        it(`${operation} refuses an absent provision execution`, async () => {
            const s = releasedPoolSetup({ shared: true }); s.executions.delete(s.provisionArn);
            await refused(s, operation, 'source_identity_mismatch');
        });
        it.each([
            ['RUNNING', { status: 'RUNNING' }], ['FAILED', { status: 'FAILED' }], ['redriven', { redriveCount: 1 }], ['aliased', { stateMachineAliasArn: 'alias' }],
            ['started before the provision stopped', { startDate: new Date('2026-10-21T09:03:00.000Z') }],
            ['stopped after now', { stopDate: new Date('2026-10-22T12:00:01.000Z') }],
        ] as const)(`${operation} refuses a release execution %s`, async (_name, patch) => {
            const s = releasedPoolSetup({ shared: true }); Object.assign(s.executions.get(s.releaseArn)!, patch);
            await refused(s, operation, 'source_identity_mismatch');
        });
        it.each([
            ['computer', { computerId: OTHER }], ['generation', { targetGeneration: 2 }], ['lease epoch (stale)', { leaseEpoch: 2 }],
            ['fence', { fenceToken: OTHER }], ['instance', { providerInstanceId: 'i-99999999999999999' }], ['volume', { dataVolumeId: 'vol-99999999999999999' }],
        ] as const)(`${operation} refuses a release of another %s, even with a receipt naming this allocation`, async (_name, patch) => {
            const s = releasedPoolSetup({ shared: true }), x = s.source;
            await refused(s, operation, 'source_identity_mismatch', s.setRelease(patch, { computerId: x.computerId, generation: x.sourceGeneration,
                leaseEpoch: x.sourceLeaseEpoch, fenceToken: x.sourceFenceToken, instanceId: x.sourceInstanceId, volumeId: x.sourceVolumeId }));
        });
        it.each([
            ['stopped', { state: 'stopped' }], ['lost', { state: 'stopped', instanceLost: true }], ['another volume', { volumeId: 'vol-99999999999999999' }],
            ['another computer', { computerId: OTHER }], ['another generation', { generation: 2 }], ['another epoch', { leaseEpoch: 2 }],
            ['another fence', { fenceToken: OTHER }], ['another instance', { instanceId: 'i-99999999999999999' }], ['another digest', { digest: 'f'.repeat(64) }],
        ] as const)(`${operation} refuses a release receipt that is %s`, async (_name, receipt) => {
            const s = releasedPoolSetup({ shared: true }); s.setRelease({}, receipt);
            await refused(s, operation, 'source_identity_mismatch');
        });
        it.each([[32, 'shutting-down'], [16, 'running'], [80, 'stopped']] as const)(`${operation} refuses a release whose TerminateInstances answered %s %s`, async (Code, Name) => {
            const s = releasedPoolSetup({ shared: true }); s.setRelease({}, {}, { Code, Name });
            await refused(s, operation, 'source_identity_mismatch');
        });
        it(`${operation} refuses an absent release execution, an absent history, and a reader without history`, async () => {
            let s = releasedPoolSetup({ shared: true }); s.executions.delete(s.releaseArn);
            await refused(s, operation, 'source_identity_mismatch');
            s = releasedPoolSetup({ shared: true }); s.histories.delete(s.releaseArn);
            await refused(s, operation, 'source_identity_mismatch');
            s = releasedPoolSetup({ shared: true }); delete s.deps.executions.history;
            await refused(s, operation, 'source_identity_mismatch'); expect(s.deps.executions.describe).not.toHaveBeenCalled();
        });
        it.each(['RUNNING', 'DRAINING'])(`${operation} refuses a %s placement with a matching retired row`, async state => {
            const s = releasedPoolSetup({ shared: true }); s.fake.placements[0]!.state = state;
            await refused(s, operation, 'source_identity_mismatch');
        });
        it(`${operation} keeps a NULL lower source_digest_unknown without reading the pool row`, async () => {
            const s = releasedPoolSetup({ shared: true }), read = vi.spyOn(s.store, 'releasedPoolHost');
            Object.assign(s.fake.placements[0]!, { lower_image_digest: null, lower_digest_observed_at: null });
            await refused(s, operation, 'source_digest_unknown'); expect(read).not.toHaveBeenCalled();
        });
        it(`${operation} refuses a lower absent from the registry as release_mismatch`, async () => {
            const s = releasedPoolSetup({ shared: true }); s.fake.placements[0]!.lower_image_digest = 'sha256:' + '9'.repeat(64);
            await refused(s, operation, 'release_mismatch');
        });
        it(`${operation} refuses a provisioned tuple with no registry record`, async () => {
            const s = releasedPoolSetup({ shared: true });
            s.setProvision({ ...s.provisioned, recoveryStateMachineVersionArn: s.provisioned.recoveryStateMachineVersionArn!.replace(/:1$/, ':99') });
            await refused(s, operation, 'release_mismatch');
        });
        it(`${operation} refuses a provisioned tuple matching two records`, async () => {
            const s = releasedPoolSetup({ shared: true });
            s.f.entry.releases.splice(2, 0, { ...s.f.release105, agentCommit: 'f'.repeat(40), createdAt: '2026-10-21T11:00:00.000Z' });
            s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [s.f.entry.region]: s.f.entry });
            await refused(s, operation, 'release_mismatch');
        });
        it(`${operation} keeps the target's unsupported predecessor`, async () => {
            const s = releasedPoolSetup({ shared: true }), f = fixtureReleaseRegistry106();
            s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [f.entry.region]: f.entry });
            await refused(s, operation, 'unsupported_predecessor');
        });
        it.each(['placement', 'row'] as const)(`${operation} refuses %s drift during the EC2 observation`, async target => {
            const s = releasedPoolSetup({ shared: true }), reserve = vi.spyOn(s.store, 'reserve');
            s.deps.describer.describeForEnrollment = vi.fn(async () => {
                if (target === 'placement') s.fake.placements[0]!.updated_at = new Date('2026-10-23T00:00:00Z'); else s.row.dispatch_status = 'unknown';
                return null;
            });
            await refused(s, operation, 'image_job_conflict');
            expect(reserve).not.toHaveBeenCalled();
        });
    }

    it.each([
        ['row no longer retired', (s: Setup) => { s.row.state = 'leased'; }],
        ['row replaced by another host', (s: Setup) => { s.row.id = OTHER; }],
        ['row digest changed', (s: Setup) => { s.row.lifecycle_digest = 'e'.repeat(64); }],
        ['row gone', (s: Setup) => { s.fake.poolHosts.splice(0); }],
        ['placement no longer STOPPED', (s: Setup) => { s.fake.placements[0]!.state = 'RUNNING'; }],
        ['lifecycle start (job recorded)', (s: Setup) => { s.fake.placements[0]!.lifecycle_job_id = OTHER; }],
        ['epoch moved', (s: Setup) => { s.fake.placements[0]!.lease_epoch = 4; }],
    ] as const)('reserve re-checks the released row under its own lock: %s', async (_name, change) => {
        const s = releasedPoolSetup({ shared: true }), reserve = s.store.reserve.bind(s.store);
        s.store.reserve = vi.fn(async (...args: Parameters<typeof reserve>) => { change(s); return reserve(...args); });
        expect((await s.request('prepare')).body).toMatchObject({ eligible: false, failureCode: 'image_job_conflict', jobId: null });
        expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0); expect(s.fake.placements[0]!.image_upgrade_job_id).toBeNull();
    });
    it.each(['launch', 'verify', 'recover'] as const)('keeps the release hint out of %s requests', async operation => {
        const s = releasedPoolSetup({ shared: true });
        await expect(handleImageRebase(s.deps, { schemaVersion: 1, operation, computerId: s.source.computerId, jobId: operation === 'recover' ? OTHER : null,
            sourceRetirementExecutionArn: s.releaseArn })).rejects.toThrow();
        expect(s.deps.executions.describe).not.toHaveBeenCalled();
    });
    it('without a released row an aged-out host is no longer reserved blind: R2 refuses it before reservation without a hint', async () => {
        const s = releasedPoolSetup(); s.fake.poolHosts.splice(0);
        await refused(s, 'prepare', 'source_identity_mismatch', null);
        expect(s.deps.describer.describeForEnrollment).toHaveBeenCalledTimes(1); expect(s.deps.executions.history).not.toHaveBeenCalled();
    });
    it('a recovered retry prepares from the live rebind host, never the released pool host', async () => {
        const s = releasedPoolSetup({ shared: true });
        expect((await s.request('prepare')).status).toBe(202); await s.completePreparation();
        expect((await s.run('launch')).status).toBe(202);
        let j = await s.current();
        expect(JSON.parse(j.preparationDocument).releasedPoolHost.poolHostId).toBe(RELEASED_POOL_HOST);
        Object.assign(s.executions.get(j.launchExecutionArn!)!, { status: 'FAILED' });
        await s.run('verify'); expect((await s.run('recover', j.jobId)).body.phase).toBe('restore_pending');
        await s.completeRecovery(); expect((await s.run('recover', j.jobId)).body.phase).toBe('rebind_pending');
        await s.completeRebind(); j = await s.current();
        const lease = parseEnrollmentUserData(JSON.parse(j.rebindDocument!).userData);
        await s.store.enrollMaintenance(j, { nonceHash: nonceHashOf(lease.nonce), instanceId: s.provider.host!.instanceId, lowerImageDigest: j.fromDigest,
            report: { v: 1, recoveryJobId: j.recoveryJobId!, snapshotId: j.snapshotId!, originalVolumeId: j.sourceVolumeId, volumeId: j.restoredVolumeId!, fsUuid: j.fsUuid } }, s.deps.now());
        expect((await s.run('recover', j.jobId)).body.phase).toBe('recovered');
        const child = await s.current(), document = JSON.parse(child.preparationDocument);
        expect(child).toMatchObject({ parentJobId: j.jobId, sourceInstanceId: s.provider.host!.instanceId, sourceVolumeId: j.restoredVolumeId });
        expect(document).not.toHaveProperty('releasedPoolHost');
        expect(child.sourceRelease).toEqual(s.f.release105);
    });
});
