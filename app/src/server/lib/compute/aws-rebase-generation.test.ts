import { describe, expect, it } from 'vitest';
import { buildLifecycleWork } from './aws-intent';
import { fixtureIntent } from './aws-intent.test-support';
import { replacementWorkFromExecution, settleReplacementGeneration } from './aws-rebase-generation';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { readPlacement } from './placement';
import { applyLifecycleReceipt, lifecycleExecutionArn, type ReceiptDeps } from './aws-receipts';
import type { Ec2VolumeView, ReplacementWriter } from './aws-clients';
import type { Ec2EnrollmentView } from './aws-enroll';

const now = new Date('2026-10-22T12:00:00.000Z');
async function setup(pair: 'source' | 'target' = 'source') {
    const work = buildLifecycleWork(fixtureIntent('replace'));
    const i = work.intent;
    const tags = (target: boolean) => ({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot',
        'ezil:computer-id': i.computerId, 'ezil:generation': String(target ? i.targetGeneration : i.previousGeneration),
        'ezil:fence-token': target ? i.fenceToken : i.previousFenceToken! });
    const fake = createFakePlacementDb({ placements: [placementRow({ computer_id: i.computerId,
        generation: i.targetGeneration, lease_epoch: i.leaseEpoch, state: 'STARTING', region: i.deployment.region,
        zone_id: i.deployment.zoneId, instance_id: null, instance_type: i.instanceType, volume_id: i.dataVolumeId,
        lifecycle_job_id: i.jobId, lifecycle_digest: work.digest, fence_token: i.fenceToken,
        enroll_nonce_hash: 'a'.repeat(64), enroll_consumed_hash: 'b'.repeat(64), enroll_expires_at: now,
    })], usage: [i.previousInstanceId, 'i-22222222222222222'].map(instance_id => ({
        computer_id: i.computerId, user_id: '11111111-1111-4111-8111-111111111111', instance_id,
        instance_type: i.instanceType, started_at: new Date('2026-10-22T09:00:00Z'), stopped_at: null,
        egress_bytes: null, observed_by: 'lifecycle-receipt', updated_at: now,
    })) }, { clock: () => now });
    const p = (await readPlacement(fake.db, i.computerId)).record!;
    const source: Ec2EnrollmentView = { instanceId: i.previousInstanceId!, state: 'terminated', tags: tags(false),
        availabilityZone: 'ap-south-1a', availabilityZoneId: i.deployment.zoneId, publicIp: null, volumes: [] };
    const volume: Ec2VolumeView = { volumeId: i.dataVolumeId!, state: 'available', tags: { ...tags(pair === 'target'), 'ezil:backup': 'pilot' },
        attachments: [], encrypted: true, kmsKeyId: i.deployment.dataKeyArn };
    const targets: ReplacementWriter[] = [{ instanceId: 'i-22222222222222222', state: 'terminated', tags: tags(true),
        accountId: i.deployment.accountId, clientToken: '' }];
    const deps: ReceiptDeps = { db: fake.db, describer: { describeForEnrollment: async () => source,
        describeVolume: async () => volume, describeReplacementWriters: async (_r, token) => targets.map((t) => ({ ...t, clientToken: token })) } };
    const execution = { status: 'FAILED', input: work.input, executionArn: lifecycleExecutionArn(i.deployment, i.jobId),
        stateMachineVersionArn: i.deployment.stateMachineVersionArn, redriveCount: 0 };
    return { fake, work, p, source, volume, targets, deps, execution };
}

describe('ordinary replace and resize generation settlement', () => {
    it.each(['source', 'target'] as const)('failure after launch with %s volume tags reconciles the exact pair', async (pair) => {
        const s = await setup(pair);
        await applyLifecycleReceipt({ ...s.deps, executions: { describe: async () => s.execution } }, s.p, s.work.intent.deployment);
        const p = (await readPlacement(s.fake.db, s.p.computerId)).record!;
        expect(p.state).toBe('STOPPED');
        expect(p.generation).toBe(pair === 'source' ? s.work.intent.previousGeneration : s.work.intent.targetGeneration);
        expect(p.fenceToken).toBe(pair === 'source' ? s.work.intent.previousFenceToken : s.work.intent.fenceToken);
        expect(p.leaseEpoch).toBe(s.p.leaseEpoch);
        expect([p.lifecycleJobId, p.lifecycleDigest, p.enrollNonceHash, p.enrollConsumedHash, p.enrollExpiresAt]).toEqual([null, null, null, null, null]);
        expect(s.fake.usage).toHaveLength(2);
        for (const row of s.fake.usage) expect(row).toMatchObject({ stopped_at: now, observed_by: 'generation-reconcile' });
        expect(await settleReplacementGeneration(s.deps, s.p, s.work)).toBe('unconfirmed');
    });
    it('a definite StartExecution refusal may restore a stopped source without inventing a target', async () => {
        const s = await setup(); s.targets.length = 0; s.source.state = 'stopped'; s.source.instanceType = 't3a.medium';
        s.source.volumes = [{ volumeId: s.volume.volumeId, deleteOnTermination: false, tags: s.volume.tags! }];
        s.volume.state = 'in-use'; s.volume.attachments = [{ instanceId: s.source.instanceId, state: 'attached' }];
        expect(await settleReplacementGeneration(s.deps, s.p, s.work, true)).toBe('settled');
        expect(s.fake.placements[0]!.generation).toBe(1);
        expect(s.fake.placements[0]!.lease_epoch).toBe(4);
        expect(s.fake.placements[0]!.instance_type).toBe('t3a.medium');
        for (const row of s.fake.usage) expect(row).toMatchObject({ stopped_at: now, observed_by: 'generation-reconcile' });
    });
    it('a lower_digest_mismatch host refusal with no enrollment closes usage when resolved to STOPPED', async () => {
        const s = await setup();
        s.fake.placements[0]!.enroll_consumed_hash = null;
        const p = (await readPlacement(s.fake.db, s.p.computerId)).record!;
        await applyLifecycleReceipt({ ...s.deps, executions: { describe: async () => ({ ...s.execution,
            error: 'LifecycleRefused', cause: 'lower_digest_mismatch' }) } }, p, s.work.intent.deployment);
        expect(s.fake.placements[0]).toMatchObject({ state: 'STOPPED', enroll_consumed_hash: null, lifecycle_job_id: null });
        for (const row of s.fake.usage) expect(row).toMatchObject({ stopped_at: now, observed_by: 'generation-reconcile' });
    });
    it.each(['missing target', 'live target', 'live source', 'unknown volume', 'wrong tags', 'foreign key', 'owner race', 'job race', 'epoch race'])(
        '%s cannot release a failed replacement', async (fault) => {
            const s = await setup();
            if (fault === 'missing target') s.targets.length = 0;
            if (fault === 'live target') s.targets[0]!.state = 'running';
            if (fault === 'live source') s.source.state = 'running';
            if (fault === 'unknown volume') s.volume.attachments = undefined;
            if (fault === 'wrong tags') s.volume.tags = { ...s.volume.tags, 'ezil:generation': '42' };
            if (fault === 'foreign key') s.volume.kmsKeyId = 'foreign';
            if (fault === 'owner race') s.fake.placements[0]!.owner_user_id = '22222222-2222-4222-8222-222222222222';
            if (fault === 'job race') s.fake.placements[0]!.lifecycle_job_id = '22222222-2222-4222-8222-222222222222';
            if (fault === 'epoch race') s.fake.placements[0]!.lease_epoch = 5;
            expect(await settleReplacementGeneration(s.deps, s.p, s.work)).toBe(fault === 'wrong tags' ? 'generation_drift' : 'unconfirmed');
            expect(s.fake.placements[0]!.state).toBe('STARTING');
            expect(s.fake.usage.every(row => row.stopped_at === null)).toBe(true);
        });
    it.each(['hash', 'version', 'alias', 'redrive', 'execution', 'duplicate'])('rejects %s execution evidence', async (fault) => {
        const s = await setup();
        const e = { ...s.execution, stateMachineAliasArn: undefined as string | undefined };
        if (fault === 'hash') e.input = e.input.replace(s.work.digest, 'f'.repeat(64));
        if (fault === 'version') e.stateMachineVersionArn += '1';
        if (fault === 'alias') e.stateMachineAliasArn = 'alias';
        if (fault === 'redrive') e.redriveCount = 1;
        if (fault === 'execution') e.executionArn += 'x';
        if (fault === 'duplicate') {
            // Insert exactly one duplicate envelope key; leave nested/serialized JSON intact.
            expect(e.input.startsWith('{')).toBe(true);
            e.input = '{"schemaVersion":1,' + e.input.slice(1);
            expect(JSON.parse(e.input)).toEqual(JSON.parse(s.execution.input));
        }
        expect(replacementWorkFromExecution(s.p, s.work.intent.deployment, e)).toBeNull();
    });
});

it('reconciles an immutable failed execution after promotion changed the current version', async () => {
    const s = await setup();
    const promoted = { ...s.work.intent.deployment, stateMachineVersionArn: s.work.stateMachineArn.replace(/:1$/, ':2') };
    expect(replacementWorkFromExecution(s.p, promoted, s.execution)).toEqual(s.work);
});
