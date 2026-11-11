import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { describe, expect, it } from 'vitest';
import { cancelFailedPreparation, preparationNeverMutated, type CancelPreparationRequest } from './aws-rebase-cancel';
import { rebaseSetup } from './aws-rebase.test-support';
import { assertNoImageReservation } from './placement';
import type { ImageJob } from './aws-rebase-store';
import { entered, exited, numbered as number, refusedAtFirstObservation, type Step } from './aws-rebase-cancel.test-support';

async function failedPreparation(code = 'writer_not_fenced') {
    const s = rebaseSetup();
    expect((await s.run('prepare')).status).toBe(202);
    const reserved = await s.current();
    const e = s.executions.get(reserved.preparationExecutionArn!)!;
    const start = new Date(Date.parse(reserved.createdAt) + 1000);
    Object.assign(e, { status: 'FAILED', error: 'RebasePreparationFailed', cause: code, startDate: start, stopDate: new Date(start.getTime() + 5000) });
    s.advance(10000);
    expect((await s.run('verify')).body).toMatchObject({ phase: 'failed', failureCode: code });
    const j = await s.current();
    let events = number(refusedAtFirstObservation(e, code), start);
    const deps = { store: s.store, now: () => new Date(Date.parse(j.updatedAt) + 60000), describer: s.deps.describer,
        executions: { describe: s.deps.executions.describe, history: async () => events } };
    const request = (mode: 'check' | 'apply', jobId = j.jobId): CancelPreparationRequest =>
        ({ schemaVersion: 1, operation: 'cancel-preparation', computerId: j.computerId, expectedJobId: jobId, mode });
    return { s, j, e, deps, request, start, setEvents: (next: HistoryEvent[]) => { events = next; }, steps: () => refusedAtFirstObservation(e, code) };
}

describe('explicit cancel of a failed pre-snapshot image job', () => {
    it('check proves eligibility without writing; apply cancels, releases the reservation and keeps the failed history', async () => {
        const t = await failedPreparation();
        const before = JSON.stringify([t.s.fake.imageJobs, t.s.fake.placements]);
        expect(await cancelFailedPreparation(t.deps, t.request('check'))).toBe('eligible');
        expect(JSON.stringify([t.s.fake.imageJobs, t.s.fake.placements])).toBe(before);
        await expect(assertNoImageReservation(t.s.fake.db, t.j.computerId)).rejects.toThrow('image_job_conflict');

        expect(await cancelFailedPreparation(t.deps, t.request('apply'))).toBe('cancelled');
        const done = (await t.s.store.read(t.j.jobId))!;
        expect(done).toMatchObject({ phase: 'cancelled', failureCode: 'writer_not_fenced', retentionHold: false,
            preparationExecutionArn: t.j.preparationExecutionArn, preparationDocument: t.j.preparationDocument, snapshotId: null, launchDocument: null });
        expect(done.completedAt).toBe(done.updatedAt);
        expect(t.s.fake.placements[0]).toMatchObject({ state: 'STOPPED', image_upgrade_job_id: null, generation: t.j.sourceGeneration,
            fence_token: t.j.sourceFenceToken, lease_epoch: t.j.sourceLeaseEpoch, instance_id: t.j.sourceInstanceId, volume_id: t.j.sourceVolumeId });
        await expect(assertNoImageReservation(t.s.fake.db, t.j.computerId)).resolves.toBeUndefined();
        expect(t.s.started).toHaveLength(1);

        // Replay is idempotent and writes nothing.
        const after = JSON.stringify([t.s.fake.imageJobs, t.s.fake.placements]);
        expect(await cancelFailedPreparation(t.deps, t.request('apply'))).toBe('cancelled');
        expect(JSON.stringify([t.s.fake.imageJobs, t.s.fake.placements])).toBe(after);
    });

    it('verify and recover never cancel', async () => {
        const t = await failedPreparation();
        expect((await t.s.run('verify')).body.phase).toBe('failed');
        expect((await t.s.run('recover', t.j.jobId)).body.phase).toBe('failed');
        expect((await t.s.store.read(t.j.jobId))!.phase).toBe('failed');
        expect(t.s.fake.placements[0]!.image_upgrade_job_id).toBe(t.j.jobId);
    });

    it('refuses any history that reached an EC2 task, retried the failure, or is partial', async () => {
        const t = await failedPreparation();
        const steps = t.steps(), observe = steps.findIndex(s => s.type === 'ChoiceStateExited');
        const mutate = (name: string): Step[] => [...steps.slice(0, observe + 1),
            entered('PassStateEntered', 'PersistControl'), exited('PassStateExited', 'PersistControl'),
            entered('ChoiceStateEntered', 'Decide'), exited('ChoiceStateExited', 'Decide'),
            entered('TaskStateEntered', name),
            { type: 'TaskScheduled', taskScheduledEventDetails: { resourceType: 'aws-sdk:ec2', resource: name, region: 'ap-south-1', parameters: '{}' } },
            ...steps.slice(-2)];
        const variants: [string, HistoryEvent[]][] = [
            ['stop', number(mutate('stopInstances'), t.start)],
            ['terminate', number(mutate('terminateInstances'), t.start)],
            ['snapshot', number(mutate('createSnapshot'), t.start)],
            ['gap', number(steps, t.start).filter(e => e.id !== 5)],
            ['truncated', number(steps.map(s => s.type === 'LambdaFunctionSucceeded'
                ? { ...s, lambdaFunctionSucceededEventDetails: { ...s.lambdaFunctionSucceededEventDetails, outputDetails: { truncated: true } } } : s), t.start)],
            ['other code', number(steps.map(s => s.type === 'LambdaFunctionSucceeded'
                ? { ...s, lambdaFunctionSucceededEventDetails: { output: JSON.stringify({ decision: 'failed', code: 'source_identity_mismatch' }) } } : s), t.start)],
            ['wait loop', number([...steps.slice(0, observe + 1), entered('WaitStateEntered', 'Wait'), ...steps.slice(observe + 1)], t.start)],
            // A mutating state entered without a recorded schedule event (path check alone).
            ['unscheduled mutation state', number(mutate('stopInstances').filter(s => s.type !== 'TaskScheduled'), t.start)],
            // An EC2 SDK task event inside an otherwise exact path (event allow-list alone).
            ['ec2 task on exact path', number([...steps.slice(0, 5),
                { type: 'TaskScheduled', taskScheduledEventDetails: { resourceType: 'aws-sdk:ec2', resource: 'stopInstances', region: 'ap-south-1', parameters: '{}' } },
                ...steps.slice(5)], t.start)],
            ['outside execution', number(steps, new Date(t.start.getTime() - 1000))],
            ['empty', []],
        ];
        for (const [name, events] of variants) {
            t.setEvents(events);
            expect(await cancelFailedPreparation(t.deps, t.request('apply')), name).toBe('execution_not_proven');
        }
        t.setEvents(number(steps, t.start));
        for (const patch of [{ status: 'ABORTED' }, { status: 'RUNNING' }, { redriveCount: 1 }, { error: 'RebasePreparationUnconfirmed' },
            { cause: 'source_identity_mismatch' }, { input: '{}' }, { stopDate: null }]) {
            const original = { ...t.e };
            Object.assign(t.e, patch);
            expect(preparationNeverMutated(t.j, t.e, number(steps, t.start)), JSON.stringify(patch)).toBe(false);
            Object.assign(t.e, original);
        }
        expect((await t.s.store.read(t.j.jobId))!.phase).toBe('failed');
        expect(t.s.fake.placements[0]!.image_upgrade_job_id).toBe(t.j.jobId);
    });

    it('refuses a source volume or instance that is not exactly the untouched reserved source', async () => {
        const t = await failedPreparation(), volume = t.s.provider.volume, original = JSON.parse(JSON.stringify(volume));
        const restore = () => { Object.assign(volume, JSON.parse(JSON.stringify(original))); t.s.provider.host = null; };
        const cases: (() => void)[] = [
            () => { volume.state = 'in-use'; },
            () => { volume.attachments = [{ instanceId: t.j.sourceInstanceId, state: 'attached' }]; },
            () => { volume.tags = { ...volume.tags, 'ezil:generation': String(t.j.sourceGeneration + 1) }; },
            () => { volume.tags = { ...volume.tags, 'ezil:fence-token': '99999999-9999-4999-8999-999999999999' }; },
            () => { (volume as { tags: Record<string, string> }).tags = { ...volume.tags, 'ezil:pool': 'x' }; },
            () => { volume.encrypted = false; },
            () => { volume.sizeGiB = (volume.sizeGiB ?? 0) + 1; },
            () => { t.s.provider.host = { instanceId: t.j.sourceInstanceId, state: 'running', tags: {}, volumes: [] } as never; },
            () => { t.s.provider.host = { instanceId: t.j.sourceInstanceId, state: 'shutting-down', tags: {}, volumes: [] } as never; },
        ];
        for (const [index, change] of cases.entries()) {
            restore(); change();
            expect(await cancelFailedPreparation(t.deps, t.request('apply')), String(index)).toBe('provider_not_proven');
        }
        restore();
        t.s.provider.host = { instanceId: t.j.sourceInstanceId, state: 'terminated', tags: {}, volumes: [] } as never;
        expect(await cancelFailedPreparation(t.deps, t.request('check'))).toBe('eligible');
        expect((await t.s.store.read(t.j.jobId))!.phase).toBe('failed');
    });

    it('refuses other jobs, other computers and placement drift', async () => {
        const t = await failedPreparation();
        expect(await cancelFailedPreparation(t.deps, t.request('apply', '99999999-9999-4999-8999-999999999999'))).toBe('not_applicable');
        expect(await cancelFailedPreparation(t.deps, { ...t.request('apply'), computerId: '99999999-9999-4999-8999-999999999999' })).toBe('not_applicable');
        const row = t.s.fake.placements[0]!, original = { ...row };
        for (const drift of [{ generation: Number(row.generation) + 1 }, { fence_token: '99999999-9999-4999-8999-999999999999' },
            { lease_epoch: Number(row.lease_epoch) + 1 }, { owner_user_id: '99999999-9999-4999-8999-999999999999' }, { state: 'RUNNING' }]) {
            Object.assign(row, drift);
            await expect(t.deps.store.cancelPreparation(t.j, t.deps.now()), JSON.stringify(drift)).rejects.toThrow('image_job_conflict');
            Object.assign(row, original);
        }
        // A stale expected row loses the job CAS.
        await expect(t.s.store.cancelPreparation({ ...t.j, updatedAt: new Date(Date.parse(t.j.updatedAt) - 1).toISOString() } as ImageJob,
            t.deps.now())).rejects.toThrow('image_job_conflict');
        expect((await t.s.store.read(t.j.jobId))!.phase).toBe('failed');
    });

    it('never cancels a job that is still running or reached a snapshot', async () => {
        const s = rebaseSetup();
        expect((await s.run('prepare')).status).toBe(202);
        const j = await s.current();
        const deps = { store: s.store, now: () => new Date(Date.parse(j.updatedAt) + 1000), describer: s.deps.describer,
            executions: { describe: s.deps.executions.describe, history: async () => [] } };
        const request: CancelPreparationRequest = { schemaVersion: 1, operation: 'cancel-preparation', computerId: j.computerId, expectedJobId: j.jobId, mode: 'apply' };
        expect(await cancelFailedPreparation(deps, request)).toBe('not_applicable');
        await s.completePreparation(); await s.run('verify');
        expect((await s.current()).phase).toBe('snapshot_ready');
        expect(await cancelFailedPreparation(deps, request)).toBe('not_applicable');
        await expect(s.store.cancelPreparation(await s.current(), deps.now())).rejects.toThrow('image_job_conflict');
        // Failed AFTER a snapshot: the evidence exists, so it is recovery's, never a pre-snapshot cancel.
        const ready = await s.current();
        const failed = await s.store.transition(ready, { ...ready, phase: 'failed', failureCode: 'launch_failed',
            updatedAt: new Date(Date.parse(ready.updatedAt) + 1).toISOString() });
        expect(failed.snapshotId).not.toBeNull();
        expect(await cancelFailedPreparation(deps, request)).toBe('not_applicable');
        await expect(s.store.cancelPreparation(failed, new Date(Date.parse(failed.updatedAt) + 1))).rejects.toThrow('image_job_conflict');
        expect((await s.store.read(j.jobId))!.phase).toBe('failed');
    });
});
