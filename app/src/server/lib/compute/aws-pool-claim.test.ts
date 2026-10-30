import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePoolClaim } from './aws-pool-claim';
import { observePoolAdopt } from './aws-pool-adopt';
import { poolFixture } from './aws-pool-test-support';
import * as placement from './placement';
import * as pool from './ready-pool';

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function pendingAdopt() {
    const f = poolFixture(true);
    let published = false;
    f.execution.status = 'RUNNING';
    vi.spyOn(pool, 'readPendingPoolAdopt').mockImplementation(async () => published ? null : f.row);
    vi.spyOn(placement, 'readPlacement').mockResolvedValue({ record: f.p, provider: 'aws-ec2', store: 'ebs' });
    vi.spyOn(pool, 'publishPoolClaim').mockImplementation(async () => { published = true; return f.row; });
    vi.spyOn(placement, 'publishAttachedPoolClaim').mockImplementation(async (_db, _p, _volume, write) => {
        await write(f.deps.db);
    });
    vi.mocked(f.deps.data.readPoolClaim).mockImplementation(async () => published ? f.row : null);
    // Authentication takes a snapshot, as the real EC2 describer does.
    vi.mocked(f.deps.describer!.describeForEnrollment).mockImplementation(async () => structuredClone(f.view));
    f.deps.observeAdopt = (proof, identity, poll) => observePoolAdopt(f.deps, proof, identity, poll);
    return f;
}

describe('host claim adoption long-poll', () => {
    it.each(['authentication', 'pool row', 'placement', 'execution', 'prepublication authentication'])
    ('cancels a deferred %s read without publishing when it later succeeds', async stage => {
        for (const stop of ['abort', 'deadline']) {
            vi.restoreAllMocks();
            vi.spyOn(console, 'info').mockImplementation(() => {});
            const f = pendingAdopt();
            f.execution.status = 'SUCCEEDED';
            let release!: () => void;
            const deferred = new Promise<void>(resolve => { release = resolve; });
            if (stage === 'authentication') vi.mocked(f.deps.describer!.describeForEnrollment)
                .mockImplementationOnce(async () => { await deferred; return f.view; });
            if (stage === 'pool row') vi.mocked(pool.readPendingPoolAdopt)
                .mockImplementationOnce(async () => { await deferred; return f.row; });
            if (stage === 'placement') vi.mocked(placement.readPlacement)
                .mockImplementationOnce(async () => { await deferred; return { record: f.p, provider: 'aws-ec2', store: 'ebs' }; });
            if (stage === 'execution') vi.mocked(f.deps.executions!.describe)
                .mockImplementationOnce(async () => { await deferred; return f.execution; });
            if (stage === 'prepublication authentication') vi.mocked(f.deps.describer!.describeForEnrollment)
                .mockResolvedValueOnce(f.view).mockImplementationOnce(async () => { await deferred; return f.view; });
            const controller = new AbortController();
            const done = vi.fn();
            const held = handlePoolClaim(new Request(f.request('claim'), { signal: controller.signal }), f.deps).then(done);
            await vi.advanceTimersByTimeAsync(0);
            expect(done).not.toHaveBeenCalled();
            if (stop === 'abort') controller.abort();
            else await vi.advanceTimersByTimeAsync(5_000);
            await held;
            expect((done.mock.calls[0]![0] as Response).status).toBe(204);
            expect(pool.publishPoolClaim).not.toHaveBeenCalled();
            expect(placement.publishAttachedPoolClaim).not.toHaveBeenCalled();
            expect(f.deps.db.transaction).not.toHaveBeenCalled();
            expect(f.deps.saveNonce).not.toHaveBeenCalled();
            const reads = vi.mocked(f.deps.executions!.describe).mock.calls.length;
            await vi.advanceTimersByTimeAsync(10_000);
            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(f.deps.executions!.describe).toHaveBeenCalledTimes(reads);
            expect(pool.publishPoolClaim).not.toHaveBeenCalled();
            expect(f.deps.db.transaction).not.toHaveBeenCalled();
            expect(console.info).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        }
    });

    it.each(['abort', 'deadline'])('stops on %s during the post-hold refresh before the nonce transaction', async stop => {
        const f = pendingAdopt();
        let release!: () => void;
        const deferred = new Promise<void>(resolve => { release = resolve; });
        vi.mocked(f.deps.describer!.describeForEnrollment).mockResolvedValueOnce(f.view).mockResolvedValueOnce(f.view)
            .mockImplementationOnce(async () => { await deferred; return f.view; });
        const controller = new AbortController();
        const held = handlePoolClaim(new Request(f.request('claim'), { signal: controller.signal }), f.deps);
        await vi.advanceTimersByTimeAsync(0);
        f.execution.status = 'SUCCEEDED';
        await vi.advanceTimersByTimeAsync(250);
        expect(f.deps.describer!.describeForEnrollment).toHaveBeenCalledTimes(3);
        expect(pool.publishPoolClaim).toHaveBeenCalledOnce();
        if (stop === 'abort') controller.abort();
        else await vi.advanceTimersByTimeAsync(4_750);
        expect((await held).status).toBe(204);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.deps.db.transaction).not.toHaveBeenCalled();
        expect(f.deps.saveNonce).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('uses the remaining budget for a read on a later observation, then consumes a late rejection', async () => {
        const f = pendingAdopt();
        let reject!: (error: Error) => void;
        const deferred = new Promise<never>((_resolve, fail) => { reject = fail; });
        const held = handlePoolClaim(f.request('claim'), f.deps);
        await vi.advanceTimersByTimeAsync(4_500);
        vi.mocked(f.deps.executions!.describe).mockImplementationOnce(() => deferred);
        await vi.advanceTimersByTimeAsync(500);
        expect((await held).status).toBe(204);
        reject(new Error('late dependency failure'));
        await vi.advanceTimersByTimeAsync(0);
        expect(pool.publishPoolClaim).not.toHaveBeenCalled();
        expect(f.deps.db.transaction).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects a success observed at ten seconds even if the timer has not fired', async () => {
        const f = pendingAdopt();
        f.execution.status = 'SUCCEEDED';
        vi.mocked(f.deps.executions!.describe).mockImplementationOnce(async () => {
            vi.spyOn(performance, 'now').mockReturnValue(10_000);
            return f.execution;
        });
        expect((await handlePoolClaim(f.request('claim'), f.deps)).status).toBe(204);
        expect(pool.publishPoolClaim).not.toHaveBeenCalled();
        expect(f.deps.db.transaction).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a pre-aborted request performs no authentication or observation', async () => {
        const f = pendingAdopt();
        const controller = new AbortController(); controller.abort();
        expect((await handlePoolClaim(new Request(f.request('claim'), { signal: controller.signal }), f.deps)).status).toBe(204);
        expect(f.deps.describer!.describeForEnrollment).not.toHaveBeenCalled();
        expect(pool.readPendingPoolAdopt).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('returns the claim on the next status poll and refreshes pre-adopt host tags', async () => {
        const f = pendingAdopt();
        const adopted = structuredClone(f.view);
        f.view.tags = { ...f.view.tags, 'ezil:pool': '1' };
        delete f.view.tags['ezil:computer'];
        f.view.volumes = f.view.volumes.slice(0, 1);
        const done = vi.fn();
        const held = handlePoolClaim(f.request('claim'), f.deps).then(done);
        await vi.advanceTimersByTimeAsync(499);
        expect(done).not.toHaveBeenCalled();
        expect(f.deps.db.transaction).not.toHaveBeenCalled();
        expect(f.deps.lockPlacement).not.toHaveBeenCalled();
        expect(f.deps.saveNonce).not.toHaveBeenCalled();
        expect(f.deps.describer!.describeForEnrollment).toHaveBeenCalledTimes(1);
        Object.assign(f.view, adopted);
        f.execution.status = 'SUCCEEDED';
        await vi.advanceTimersByTimeAsync(1);
        await held;
        const response = done.mock.calls[0]![0] as Response;
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ computerId: f.p.computerId, generation: f.p.generation,
            leaseEpoch: f.p.leaseEpoch, enrollNonce: expect.any(String) });
        expect(f.deps.saveNonce).toHaveBeenCalledOnce();
        expect(f.deps.describer!.describeForEnrollment).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('answers unchanged 204 at five seconds, with bounded execution reads and no transaction', async () => {
        const f = pendingAdopt();
        const done = vi.fn();
        const held = handlePoolClaim(f.request('claim'), f.deps).then(done);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(done).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await held;
        const response = done.mock.calls[0]![0] as Response;
        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(f.deps.executions!.describe).toHaveBeenCalledTimes(20);
        expect(f.deps.describer!.describeForEnrollment).toHaveBeenCalledOnce();
        expect(f.deps.db.transaction).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('aborts on disconnect with no further reads, timers or nonce writes', async () => {
        const f = pendingAdopt();
        const controller = new AbortController();
        const held = handlePoolClaim(new Request(f.request('claim'), { signal: controller.signal }), f.deps);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        expect((await held).status).toBe(204);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(f.deps.executions!.describe).toHaveBeenCalledOnce();
        expect(f.deps.db.transaction).not.toHaveBeenCalled();
        expect(f.deps.saveNonce).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['FAILED', 'ABORTED', 'TIMED_OUT'])('stops immediately when adoption becomes %s', async status => {
        const f = pendingAdopt();
        const held = handlePoolClaim(f.request('claim'), f.deps);
        await vi.advanceTimersByTimeAsync(0);
        f.execution.status = status;
        await vi.advanceTimersByTimeAsync(250);
        expect((await held).status).toBe(204);
        expect(f.deps.saveNonce).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['fence', 'namespace', 'receipt', 'generation'])('preserves the %s guard when state changes during the hold', async field => {
        const f = pendingAdopt();
        const held = handlePoolClaim(f.request('claim'), f.deps);
        await vi.advanceTimersByTimeAsync(0);
        f.execution.status = 'SUCCEEDED';
        if (field === 'fence') f.view.tags['ezil:fence'] = 'changed';
        if (field === 'namespace') f.view.tags['ezil:namespace'] = 'changed';
        if (field === 'receipt') f.execution.output = JSON.stringify({ ...f.receipt, fenceToken: 'changed' });
        if (field === 'generation') f.p.generation++;
        await vi.advanceTimersByTimeAsync(250);
        expect((await held).status).not.toBe(200);
        expect(f.deps.saveNonce).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
