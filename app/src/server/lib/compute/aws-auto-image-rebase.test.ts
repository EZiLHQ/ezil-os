import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { advanceAutomaticImageRebase, listAutomaticImageRebaseCandidates, loadAutomaticImageRebase } from './aws-auto-image-rebase';
import { handleAwsEnrollment } from './aws-enroll';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { rebaseSetup } from './aws-rebase.test-support';

vi.mock('./aws-identity', () => ({ readIdentityCertificate: () => 'test-certificate', verifyIdentitySignature: () => ({ ok: true }) }));

function fixture() {
    const s = rebaseSetup();
    const computer = { id: s.source.computerId, userId: s.owner };
    Object.assign(s.env, { EZIL_AWS_AUTO_IMAGE_REBASE: '1' });
    const plan = () => loadAutomaticImageRebase(s.deps, computer);
    return { ...s, computer, plan, step: async () => advanceAutomaticImageRebase(s.deps, (await plan())!) };
}

describe('automatic image rebase on an authenticated open', () => {
    it('plans without dispatch and advances one operation at a time through verified enrollment', async () => {
        const s = fixture();
        const plan = await s.plan();
        expect(plan).toMatchObject({ computerId: s.computer.id, instanceType: 'm6i.large', phase: null,
            authority: { ownerUserId: s.owner, expectedSource: { sourceGeneration: s.source.sourceGeneration,
                sourceLeaseEpoch: s.source.sourceLeaseEpoch, fromDigest: s.source.fromDigest, toDigest: s.source.toDigest } } });
        expect((await s.plan())?.authority.jobId).toBe(plan!.authority.jobId);
        expect(s.fake.imageJobs).toHaveLength(0);
        expect(s.deps.describer.describeForEnrollment).not.toHaveBeenCalled();

        expect(await advanceAutomaticImageRebase(s.deps, plan!)).toBe('pending');
        const prepared = await s.current();
        expect(prepared.jobId).toBe(plan!.authority.jobId);
        expect(prepared.launchJobId).toBeNull();
        expect(s.started).toHaveLength(1);
        Object.assign(s.env, { EZIL_AWS_AUTO_IMAGE_REBASE: '0' });
        expect(await s.step()).toBe('pending');
        expect(s.started).toHaveLength(1);

        await s.completePreparation();
        expect(await s.step()).toBe('pending');
        expect((await s.current()).phase).toBe('snapshot_ready');
        expect(s.started).toHaveLength(1);
        expect(await s.step()).toBe('pending');
        const launched = await s.current();
        expect(launched.launchJobId).not.toBe(prepared.jobId);
        expect(launched.targetFenceToken).not.toBe(prepared.jobId);
        expect(s.started).toHaveLength(2);

        await s.completeLaunch();
        expect(await s.step()).toBe('pending');
        expect((await s.current()).phase).toBe('verifying');
        const { nonce } = parseEnrollmentUserData(JSON.parse(launched.launchDocument!).userData);
        const tunnels = { createTunnel: vi.fn(async () => ({ ok: true as const, tunnelToken: 'test-tunnel-token' })), deleteTunnel: vi.fn() };
        const enrollment = await handleAwsEnrollment({ db: s.fake.db, env: s.env, now: s.deps.now, describer: s.deps.describer, tunnels,
            controlKeySecret: 'test-only-secret' }, { computerId: launched.computerId, generation: launched.targetGeneration,
            leaseEpoch: launched.targetLeaseEpoch, nonce, signature: 'x'.repeat(16), lowerImageDigest: launched.toDigest,
            identityDocument: JSON.stringify({ accountId: s.source.deployment.accountId, region: launched.region,
                instanceId: s.provider.host!.instanceId, instanceType: 'm6i.large', availabilityZone: 'ap-south-1a' }) });
        expect(enrollment.status).toBe(200);
        s.deps.desktopHealthy = async () => false;
        expect(await s.step()).toBe('pending');
        s.deps.desktopHealthy = async () => true;
        expect(await s.step()).toBe('ready');
        expect(s.started).toHaveLength(2);
        expect(await s.plan()).toBeNull();
        expect(s.fake.placements[0]).toMatchObject({ state: 'RUNNING', lower_image_digest: launched.toDigest, image_upgrade_job_id: null });
    });

    it.each([
        ['running', { state: 'RUNNING' }],
        ['uncertain', { state: 'UNCONFIRMED' }],
        ['unknown lower', { lower_image_digest: null, lower_digest_observed_at: null }],
        ['unregistered lower', { lower_image_digest: `sha256:${'9'.repeat(64)}` }],
        ['active lifecycle', { lifecycle_job_id: '88888888-8888-4888-8888-888888888888', lifecycle_digest: '1'.repeat(64) }],
    ])('leaves the existing start guard in place for %s', async (_name, patch) => {
        const s = fixture();
        Object.assign(s.fake.placements[0]!, patch);
        expect(await s.plan()).toBeNull();
        expect(s.fake.imageJobs).toHaveLength(0);
        expect(s.started).toHaveLength(0);
    });

    it('requires the owner and the activation gate, and respects the AWS kill switch', async () => {
        const s = fixture();
        expect(await loadAutomaticImageRebase(s.deps, { ...s.computer, userId: '11111111-1111-4111-8111-111111111111' })).toBeNull();
        const plan = (await s.plan())!;
        Object.assign(s.env, { EZIL_AWS_AUTO_IMAGE_REBASE: 'true' });
        expect(await advanceAutomaticImageRebase(s.deps, plan)).toBe('blocked');
        Object.assign(s.env, { EZIL_AWS_AUTO_IMAGE_REBASE: '1', EZIL_AWS_KILL_SWITCH: '1' });
        expect(await advanceAutomaticImageRebase(s.deps, plan)).toBe('blocked');
        expect(s.fake.imageJobs).toHaveLength(0);
    });

    it('leaves a manual job reserved if it wins the planning race', async () => {
        const s = fixture();
        const plan = (await s.plan())!;
        await s.run('prepare');
        const manual = await s.current();
        expect(manual.jobId).not.toBe(plan.authority.jobId);
        await s.completePreparation();
        expect(await s.plan()).toBeNull();
        expect(await advanceAutomaticImageRebase(s.deps, plan)).toBe('blocked');
        expect(await s.current()).toEqual(manual);
        expect(s.started).toHaveLength(1);
    });

    it('does not start a new reservation if the source placement changes after planning', async () => {
        const s = fixture();
        const plan = (await s.plan())!;
        s.fake.placements[0]!.lease_epoch = plan.authority.expectedSource.sourceLeaseEpoch + 1;
        expect((await s.plan())?.authority.jobId).not.toBe(plan.authority.jobId);
        expect(await advanceAutomaticImageRebase(s.deps, plan)).toBe('blocked');
        expect(s.fake.imageJobs).toHaveLength(0);
    });

    it('preserves an unconfirmed reservation without retrying or starting a restore', async () => {
        const s = fixture();
        const plan = (await s.plan())!;
        s.deps.starter.start = vi.fn(async () => { throw new Error('lost transport response'); });
        expect(await advanceAutomaticImageRebase(s.deps, plan)).toBe('blocked');
        const held = await s.current();
        expect(held).toMatchObject({ jobId: plan.authority.jobId, phase: 'unconfirmed', retentionHold: true, recoveryDocument: null });
        expect(await s.plan()).toMatchObject({ phase: 'blocked', authority: { jobId: held.jobId } });
        expect(await advanceAutomaticImageRebase(s.deps, plan)).toBe('blocked');
        expect(s.deps.starter.start).toHaveBeenCalledTimes(1);
        expect(await s.current()).toEqual(held);
    });

    it('holds an active automatic job if its immutable target release changes', async () => {
        const s = fixture();
        const plan = (await s.plan())!;
        expect(await s.step()).toBe('pending');
        const deployments = JSON.parse(s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS);
        deployments[s.source.deployment.region].releases[1].agentCommit = '9'.repeat(40);
        s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify(deployments);
        expect(await s.plan()).toMatchObject({ phase: 'blocked', authority: { jobId: plan.authority.jobId } });
        expect(await advanceAutomaticImageRebase(s.deps, plan)).toBe('blocked');
        expect(s.started).toHaveLength(1);
    });

    it('does not fabricate a source retirement proof for an aged-out host', async () => {
        const s = fixture();
        s.provider.sourceListed = false;
        expect(await s.step()).toBe('blocked');
        expect(s.fake.imageJobs).toHaveLength(0);
        expect(s.started).toHaveLength(0);
    });

    it('concurrent opens keep one preparation reservation and dispatch', async () => {
        const s = fixture();
        const plan = (await s.plan())!;
        const outcomes = await Promise.all(Array.from({ length: 4 }, () => advanceAutomaticImageRebase(s.deps, plan)));
        expect(outcomes).toEqual(['pending', 'pending', 'pending', 'pending']);
        expect(s.fake.imageJobs).toHaveLength(1);
        expect(s.started).toHaveLength(1);
    });

    it('enumerates only a bounded, oldest-first prefix range of existing eligible-phase jobs', async () => {
        const s = fixture();
        const plan = (await s.plan())!;
        const candidate = { computerId: s.computer.id, ownerUserId: s.owner, jobId: plan.authority.jobId };
        const db = { execute: vi.fn(async (query: SQL) => {
            const { sql, params } = new PgDialect().sqlToQuery(query);
            expect(sql).toMatch(/WHERE job_id >= \$1::uuid\s+AND job_id < \$2::uuid AND phase IN/);
            expect(sql).toMatch(/ORDER BY updated_at, job_id LIMIT \$9/);
            const [min, max] = params as string[];
            expect(candidate.jobId > min! && candidate.jobId < max!).toBe(true);
            expect(params.slice(2)).toEqual(['reserved', 'fencing', 'snapshot_pending', 'snapshot_ready', 'launch_pending', 'verifying', 20]);
            return { rows: [candidate] };
        }) };
        expect(await listAutomaticImageRebaseCandidates(db, 0)).toEqual([]);
        expect(await listAutomaticImageRebaseCandidates(db, 100)).toEqual([candidate]);
        expect(db.execute).toHaveBeenCalledTimes(1);
    });
});
