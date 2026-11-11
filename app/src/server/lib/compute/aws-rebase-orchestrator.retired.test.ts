import { describe, expect, it, vi } from 'vitest';
import { retiredSourceSetup } from './aws-rebase.test-support';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { nonceHashOf } from './aws-enroll';
import { lifecycleExecutionArn } from './aws-receipts';

type Setup = ReturnType<typeof retiredSourceSetup>;
const OTHER = '99999999-9999-4999-8999-999999999999';
/** Refused before reservation: no job, no execution, no reservation. `hint` null: none sent; omitted: the proven release. */
async function refused(s: Setup, operation: 'plan' | 'prepare', code: string, hint: string | null = s.releaseArn) {
    expect((await s.request(operation, hint)).body).toMatchObject({ eligible: false, failureCode: code, jobId: null });
    expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0);
    expect(s.fake.placements[0]!.image_upgrade_job_id).toBeNull();
}

describe('DESIGN R2: a STOPPED computer whose regular (non-pool) host was released and aged out of EC2', () => {
    it('plans without writes, then reserves one preparation carrying only the proven release as retiredSource', async () => {
        const s = retiredSourceSetup();
        expect((await s.request('plan')).body).toMatchObject({ eligible: true, failureCode: null, jobId: null });
        expect(s.fake.imageJobs).toHaveLength(0); expect(s.started).toHaveLength(0);
        expect(s.deps.executions.history).toHaveBeenCalledWith('ap-south-1', s.releaseArn);
        expect(s.deps.describer.describeForEnrollment).toHaveBeenCalledTimes(1);
        expect((await s.request('prepare')).status).toBe(202);
        const j = await s.current(), document = JSON.parse(j.preparationDocument);
        expect(Object.keys(document).at(-1)).toBe('retiredSource');
        expect(document.retiredSource).toEqual({ releaseExecutionArn: s.releaseArn });
        expect(document).not.toHaveProperty('releasedPoolHost');
        // The source release still comes from the registry by the observed lower, never from the release's own deployment.
        expect(document.sourceDeployment.lowerImageDigest).toBe(s.fake.placements[0]!.lower_image_digest);
        expect(document).toMatchObject({ sourceInstanceId: s.source.sourceInstanceId, sourceVolumeId: s.source.sourceVolumeId,
            fsUuid: s.source.fsUuid, sourceGeneration: s.source.sourceGeneration, sourceLeaseEpoch: s.source.sourceLeaseEpoch,
            sourceFenceToken: s.source.sourceFenceToken });
        expect(s.started).toHaveLength(1); expect(JSON.parse(s.started[0]!.input).document).toBe(j.preparationDocument);
        expect(s.fake.placements[0]!.image_upgrade_job_id).toBe(j.jobId);
        // A reserved job resumes; it is never re-proven or re-reserved.
        const reads = vi.mocked(s.deps.executions.history!).mock.calls.length;
        expect((await s.request('prepare')).status).toBe(202);
        expect(s.fake.imageJobs).toHaveLength(1); expect(s.started).toHaveLength(1);
        expect(s.deps.executions.history).toHaveBeenCalledTimes(reads);
    });
    for (const operation of ['plan', 'prepare'] as const) {
        it(`${operation} refuses an aged-out regular source without a hint before any reservation or history read`, async () => {
            const s = retiredSourceSetup();
            await refused(s, operation, 'source_identity_mismatch', null);
            expect(s.deps.executions.history).not.toHaveBeenCalled();
        });
        it(`${operation} keeps the existing path for a listed source and ignores a hint`, async () => {
            const s = retiredSourceSetup(); s.provider.sourceListed = true;
            expect((await s.request(operation)).body).toMatchObject({ eligible: true, failureCode: null });
            expect(s.deps.executions.history).not.toHaveBeenCalled();
            if (operation === 'prepare') expect(JSON.parse((await s.current()).preparationDocument)).not.toHaveProperty('retiredSource');
        });
        it(`${operation} never resolves a shared lower from a release (no AMI evidence), even with a valid hint`, async () => {
            const s = retiredSourceSetup({ shared: true });
            await refused(s, operation, 'source_identity_mismatch');
            expect(s.deps.executions.history).not.toHaveBeenCalled();
        });
        it.each([
            ['generation', (s: Setup) => ({ targetGeneration: s.source.sourceGeneration + 1 })],
            ['lease epoch', (s: Setup) => ({ leaseEpoch: s.source.sourceLeaseEpoch + 1 })],
            ['fence token', () => ({ fenceToken: OTHER })],
            ['instance', () => ({ providerInstanceId: 'i-99999999999999999' })],
            ['volume', () => ({ dataVolumeId: 'vol-99999999999999999' })],
            ['computer', () => ({ computerId: OTHER })],
        ] as const)(`${operation} refuses a release of another %s`, async (_name, intent) => {
            const s = retiredSourceSetup(); s.setRelease(intent(s) as never);
            const arn = lifecycleExecutionArn(s.release().intent.deployment, s.release().intent.jobId);
            await refused(s, operation, 'source_identity_mismatch', arn);
        });
        it.each([
            ['not retired', { state: 'running' }],
            ['instance lost', { instanceLost: true }],
            ['other instance', { instanceId: 'i-99999999999999999' }],
            ['other volume', { volumeId: 'vol-99999999999999999' }],
            ['other generation', { generation: 999 }],
            ['other digest', { digest: 'f'.repeat(64) }],
        ] as const)(`${operation} refuses a receipt with %s`, async (_name, receipt) => {
            const s = retiredSourceSetup(); s.setRelease({}, receipt);
            await refused(s, operation, 'source_identity_mismatch');
        });
        it(`${operation} refuses a history without a positive terminated witness`, async () => {
            const s = retiredSourceSetup(); s.setRelease({}, {}, { Code: 32, Name: 'shutting-down' });
            await refused(s, operation, 'source_identity_mismatch');
        });
        it.each(['FAILED', 'RUNNING', 'ABORTED'])(`${operation} refuses a %s release`, async status => {
            const s = retiredSourceSetup(); s.executions.get(s.releaseArn)!.status = status;
            await refused(s, operation, 'source_identity_mismatch');
        });
        it(`${operation} refuses a release finishing after now, a redriven one and an aliased one`, async () => {
            for (const patch of [{ stopDate: new Date('2026-10-23T00:00:00.000Z') }, { redriveCount: 1 },
                { stateMachineAliasArn: 'arn:aws:states:ap-south-1:452630323510:stateMachineAlias:x' }]) {
                const s = retiredSourceSetup(); Object.assign(s.executions.get(s.releaseArn)!, patch);
                await refused(s, operation, 'source_identity_mismatch');
            }
        });
        it(`${operation} refuses a truncated or tampered history`, async () => {
            const s = retiredSourceSetup(); const h = s.histories.get(s.releaseArn)!;
            s.histories.set(s.releaseArn, h.slice(0, -1));
            await refused(s, operation, 'source_identity_mismatch');
        });
        it.each([
            ['malformed', 'arn:aws:states:ap-south-1:452630323510:execution:ezil-mum-lifecycle:not-a-job'],
            ['another machine', 'arn:aws:states:ap-south-1:452630323510:execution:ezil-other-lifecycle:computer-d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3'],
            ['absent', 'arn:aws:states:ap-south-1:452630323510:execution:PLACEHOLDER:computer-99999999-9999-4999-8999-999999999999'],
        ])(`${operation} refuses a %s hint`, async (_name, hint) => {
            const s = retiredSourceSetup();
            const machine = s.releaseArn.split(':')[6]!;
            await refused(s, operation, 'source_identity_mismatch', hint.replace('PLACEHOLDER', machine));
        });
        it(`${operation} refuses as a conflict when the placement moves while the release is being proven`, async () => {
            const s = retiredSourceSetup(), read = s.deps.executions.history!;
            s.deps.executions.history = vi.fn(async (region: string, arn: string) => { s.fake.placements[0]!.lease_epoch = 9; return read(region, arn); });
            await refused(s, operation, 'image_job_conflict');
        });
        it(`${operation} refuses as a conflict when a claim row appears while the release is being proven`, async () => {
            const s = retiredSourceSetup(), read = s.deps.executions.history!;
            s.deps.executions.history = vi.fn(async (region: string, arn: string) => { s.fake.poolHosts.push(s.row); return read(region, arn); });
            await refused(s, operation, 'image_job_conflict');
        });
    }
    for (const operation of ['plan', 'prepare'] as const) {
        it(`${operation} refuses a RUNNING placement whose host EC2 no longer lists before reservation, even with a proven release`, async () => {
            const s = retiredSourceSetup(); s.fake.placements[0]!.state = 'RUNNING';
            await refused(s, operation, 'source_identity_mismatch');
            expect(s.deps.executions.history).not.toHaveBeenCalled();
        });
        it(`${operation} keeps a RUNNING placement with a listed source on the existing path`, async () => {
            const s = retiredSourceSetup(); s.fake.placements[0]!.state = 'RUNNING'; s.provider.sourceListed = true;
            expect((await s.request(operation, null)).body).toMatchObject({ eligible: true, failureCode: null });
            if (operation === 'prepare') expect(JSON.parse((await s.current()).preparationDocument)).not.toHaveProperty('retiredSource');
        });
    }
    it('a recovered retry prepares from the live rebind host and drops retiredSource', async () => {
        const s = retiredSourceSetup();
        expect((await s.request('prepare')).status).toBe(202); await s.completePreparation();
        expect((await s.run('launch')).status).toBe(202);
        let j = await s.current();
        expect(JSON.parse(j.preparationDocument).retiredSource.releaseExecutionArn).toBe(s.releaseArn);
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
        expect(document).not.toHaveProperty('retiredSource'); expect(document).not.toHaveProperty('releasedPoolHost');
    });
});
