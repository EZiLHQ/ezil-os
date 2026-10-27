import { describe, expect, it, vi } from 'vitest';
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));
import { ADOPT_STALL_MS, authorizeStalledAdoptRelease, RELEASE_RETRY_AFTER_MS, failStalledPoolAdopt, replaceStalledPoolAdopt } from './aws-pool-adopt-stall';
import { CLAIM_AT, stalledAdoptSetup } from './aws-pool-adopt-stall.test-support';
import { buildLifecycleWork } from './aws-intent';
import { applyLifecycleReceipt, lifecycleExecutionArn } from './aws-receipts';
import { ENROLLMENT_FAILED, ENROLLMENT_SUCCEEDED, ImageJobConflictError } from './placement';

describe('pool adoption stalled before session-ready', () => {
    it('recovers once at 180 seconds, releases the adopted host, then admits a cold replacement on the retained volume', async () => {
        const s = stalledAdoptSetup(), before = await s.current();
        s.at(ADOPT_STALL_MS - 1); await s.tick();
        expect((await s.current()).state).toBe('STARTING');
        s.at(ADOPT_STALL_MS); await s.tick();
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED,
            generation: before.generation, leaseEpoch: before.leaseEpoch, volumeId: before.volumeId, instanceId: before.instanceId,
            enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null });
        expect(s.host).toMatchObject({ state: 'retiring', leased_computer_id: before.computerId });
        expect(await s.ensure()).toMatchObject({ errorCode: 'computer_starting', retryable: true });
        expect(s.starts.map(w => w.intent.operation)).toEqual(['release']);
        expect(s.starts[0]!.intent).toMatchObject({ dataVolumeId: before.volumeId, dataVolumeGiB: null,
            targetGeneration: before.generation, leaseEpoch: before.leaseEpoch, providerInstanceId: before.instanceId });
        expect(await s.status()).toMatchObject({ ok: true, state: 'starting' });
        await s.tick(); expect(s.starts).toHaveLength(1);
        s.finish(); await s.tick();
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED, lifecycleJobId: null });
        expect(s.host.state).toBe('retired');
        expect(await s.ensure()).toMatchObject({ errorCode: 'computer_starting', retryable: true });
        expect(s.starts.map(w => w.intent.operation)).toEqual(['release', 'replace']);
        expect(s.starts[1]!.intent).toMatchObject({ dataVolumeId: before.volumeId, previousInstanceId: before.instanceId,
            previousGeneration: before.generation, previousFenceToken: before.fenceToken,
            targetGeneration: before.generation + 1, leaseEpoch: before.leaseEpoch + 1 });
        expect(s.deps.pool!.leasePoolHost).not.toHaveBeenCalled();
        expect(s.usage).toEqual([]); expect(s.meter.ready).not.toHaveBeenCalled(); expect(s.meter.stopped).not.toHaveBeenCalled();
    });

    it('does not retire an adoption that becomes session-ready at 179 seconds', async () => {
        const s = stalledAdoptSetup(); s.at(179_000); await s.ready();
        s.at(ADOPT_STALL_MS + 60_000); await s.tick();
        expect(await s.current()).toMatchObject({ state: 'RUNNING', lastError: ENROLLMENT_SUCCEEDED });
        expect(s.host.state).toBe('leased'); expect(s.starts).toEqual([]);
        expect(s.meter.ready).toHaveBeenCalledOnce();
    });

    it('retains the newly created volume when the first adoption stalls', async () => {
        const s = stalledAdoptSetup(), p = await s.current(); s.at(ADOPT_STALL_MS);
        const first = buildLifecycleWork({ ...s.adopt.intent, dataVolumeId: null, dataVolumeGiB: 20 });
        s.placements[0]!.lifecycle_digest = first.digest;
        s.placements[0]!.last_error = null;
        const output = JSON.parse(s.original.output!);
        Object.assign(s.original, { input: first.input, output: JSON.stringify({ ...output, digest: first.digest }) });
        await s.tick(); await s.tick();
        expect(s.starts[0]!.intent).toMatchObject({ operation: 'release', dataVolumeId: p.volumeId });
        expect((await s.current()).volumeId).toBe(p.volumeId);
    });

    it('leaves a RUNNING placement with a lapsed lease untouched by the background pass', async () => {
        const s = stalledAdoptSetup();
        Object.assign(s.placements[0]!, { state: 'RUNNING', last_error: ENROLLMENT_SUCCEEDED,
            lease_until: new Date('2026-10-27T11:00:00Z') });
        const before = await s.current(); s.at(1_200_000); await s.fleet();
        expect(await s.current()).toEqual(before); expect(s.host.state).toBe('leased'); expect(s.starts).toEqual([]);
    });

    it('concurrent background passes release and replace once without any browser action', async () => {
        const s = stalledAdoptSetup(); s.at(ADOPT_STALL_MS);
        await Promise.all([s.fleet(), s.fleet()]);
        await Promise.all([s.fleet(), s.fleet()]);
        expect(s.starts.map(w => w.intent.operation)).toEqual(['release']);
        s.finish(); await Promise.all([s.fleet(), s.fleet()]);
        await s.fleet();
        expect(s.starts.map(w => w.intent.operation)).toEqual(['release', 'replace']);
        expect(await s.current()).toMatchObject({ state: 'STARTING', generation: 6, leaseEpoch: 7 });
    });

    it.each(['generation', 'lease_epoch', 'fence_token', 'instance_id', 'lifecycle_job_id', 'lifecycle_digest'])('refuses placement %s drift under the recovery lock', async field => {
        const s = stalledAdoptSetup(); s.at(ADOPT_STALL_MS);
        const p = await s.current();
        s.race(() => { s.placements[0]![field] = field === 'generation' || field === 'lease_epoch' ? 9
            : field === 'lifecycle_digest' ? 'b'.repeat(64) : field === 'instance_id' ? 'i-22222222222222222'
                : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; });
        expect(await failStalledPoolAdopt(s.deps, p, s.original)).toBe(false);
        expect(s.host.state).toBe('leased'); expect(s.placements[0]!.state).toBe('STARTING'); expect(s.starts).toEqual([]);
    });

    it.each(['claim_generation', 'claim_lease_epoch', 'claim_fence', 'claim_volume_serial', 'leased_generation', 'lease_token', 'leased_at', 'session_ready_at'])('refuses changed pool claim evidence: %s', async field => {
        const s = stalledAdoptSetup(); s.at(ADOPT_STALL_MS);
        const before = await s.current();
        s.race(() => { s.host[field] = field === 'session_ready_at' ? new Date() : null; });
        expect(await failStalledPoolAdopt(s.deps, before, s.original)).toBe(false);
        expect(await s.current()).toEqual(before); expect(s.host.state).toBe('leased'); expect(s.starts).toEqual([]);
    });

    it('a session-ready winner between the preflight and lock is never failed', async () => {
        const s = stalledAdoptSetup(); s.at(ADOPT_STALL_MS);
        const p = await s.current();
        s.race(() => Object.assign(s.placements[0]!, { last_error: ENROLLMENT_SUCCEEDED }));
        expect(await failStalledPoolAdopt(s.deps, p, s.original)).toBe(false);
        expect(s.host.state).toBe('leased'); expect(s.placements[0]!.last_error).toBe(ENROLLMENT_SUCCEEDED);
    });

    it('rolls back on an image reservation and never retires a host with tenant usage', async () => {
        const image = stalledAdoptSetup(); image.at(ADOPT_STALL_MS);
        const before = await image.current();
        image.placements[0]!.image_upgrade_job_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        await expect(failStalledPoolAdopt(image.deps, before, image.original)).rejects.toBeInstanceOf(ImageJobConflictError);
        expect(image.host.state).toBe('leased');
        const used = stalledAdoptSetup(); used.at(ADOPT_STALL_MS);
        used.usage.push({ computer_id: used.adopt.intent.computerId, instance_id: used.adopt.intent.providerInstanceId, stopped_at: null });
        await expect(failStalledPoolAdopt(used.deps, await used.current(), used.original)).rejects.toThrow('adopt_recovery_usage');
        expect(used.host.state).toBe('leased'); expect((await used.current()).state).toBe('STARTING');
    });

    it('terminal-only claim observation never starts stall recovery', async () => {
        const s = stalledAdoptSetup(); s.at(ADOPT_STALL_MS);
        await applyLifecycleReceipt(s.deps, await s.current(), s.d, { terminalOnly: true });
        expect((await s.current()).state).toBe('STARTING'); expect(s.host.state).toBe('leased');
    });

    it('replays a reserved release after a lost start using the same job and digest', async () => {
        const s = stalledAdoptSetup(); s.at(ADOPT_STALL_MS); await s.tick(); await s.tick();
        const release = s.starts[0]!;
        s.executions.delete(lifecycleExecutionArn(s.d, release.intent.jobId));
        await s.tick();
        expect(s.starts).toEqual([release, release]);
        s.finish(); await s.fleet();
        expect(s.starts.at(-1)!.intent.operation).toBe('replace');
    });

    it('authorizes only the stall path\'s own release while the bound pool lease is retiring', async () => {
        const s = stalledAdoptSetup();
        expect(await authorizeStalledAdoptRelease(s.db, await s.current())).toBe(false);
        s.at(ADOPT_STALL_MS); await s.tick(); await s.tick();
        const p = await s.current();
        expect(p.state).toBe('UNCONFIRMED');
        expect(await authorizeStalledAdoptRelease(s.db, p)).toBe(true);
        expect(await authorizeStalledAdoptRelease(s.db, { ...p, lastError: 'other' })).toBe(false);
        expect(await authorizeStalledAdoptRelease(s.db, { ...p, lifecycleJobId: null })).toBe(false);
        expect(await authorizeStalledAdoptRelease(s.db, { ...p, leaseEpoch: p.leaseEpoch + 1 })).toBe(false);
        s.finish(); await s.fleet();
        expect(await authorizeStalledAdoptRelease(s.db, await s.current())).toBe(false);
    });

    it('retries a FAILED release once it has settled, as a new job, then replaces normally', async () => {
        const s = stalledAdoptSetup(); s.at(ADOPT_STALL_MS); await s.tick(); await s.tick();
        const failed = s.starts[0]!;
        expect(failed.intent.operation).toBe('release');
        Object.assign(s.executions.get(lifecycleExecutionArn(s.d, failed.intent.jobId))!, { status: 'FAILED', stopDate: new Date(CLAIM_AT.getTime() + ADOPT_STALL_MS) });
        s.at(ADOPT_STALL_MS + RELEASE_RETRY_AFTER_MS - 1); await s.tick();
        expect(s.starts).toHaveLength(1);
        s.at(ADOPT_STALL_MS + RELEASE_RETRY_AFTER_MS); await s.tick();
        expect(s.starts).toHaveLength(2);
        const retry = s.starts[1]!;
        expect(retry.intent.operation).toBe('release');
        expect(retry.intent.jobId).not.toBe(failed.intent.jobId);
        s.finish(); await s.fleet();
        expect(s.starts.at(-1)!.intent.operation).toBe('replace');
    });

    it.each(['generation', 'leaseEpoch', 'volumeId', 'instanceId', 'fenceToken'])('never admits replacement from a mismatched release receipt: %s', async field => {
        const s = stalledAdoptSetup(); s.at(ADOPT_STALL_MS); await s.tick(); await s.tick(); s.finish();
        const release = s.starts[0]!, e = s.executions.get(lifecycleExecutionArn(s.d, release.intent.jobId))!;
        e.output = JSON.stringify({ ...JSON.parse(e.output!), [field]: field === 'generation' || field === 'leaseEpoch' ? 99 : 'changed' });
        await s.fleet();
        expect(s.host.state).toBe('retiring'); expect(s.starts).toHaveLength(1);
    });

    it('keeps a refused replacement admission retryable on the next background pass', async () => {
        const s = stalledAdoptSetup(); s.at(ADOPT_STALL_MS); await s.tick(); await s.tick(); s.finish();
        Object.assign(s.env, { EZIL_AWS_KILL_SWITCH: '1' }); await s.fleet();
        expect(s.host.state).toBe('retired'); expect(s.starts).toHaveLength(1);
        Object.assign(s.env, { EZIL_AWS_KILL_SWITCH: '0' }); await s.fleet();
        expect(s.starts.map(w => w.intent.operation)).toEqual(['release', 'replace']);
    });

    it('a delayed background replacement never renews a newer RUNNING session', async () => {
        const s = stalledAdoptSetup(); s.at(ADOPT_STALL_MS); await s.tick(); await s.tick(); s.finish(); await s.tick();
        const failed = await s.current();
        Object.assign(s.placements[0]!, { state: 'RUNNING', generation: 6, lease_epoch: 7, last_error: ENROLLMENT_SUCCEEDED });
        const ready = await s.current();
        await replaceStalledPoolAdopt(s.deps, failed, s.env);
        expect(await s.current()).toEqual(ready); expect(s.starts).toHaveLength(1);
    });
});
