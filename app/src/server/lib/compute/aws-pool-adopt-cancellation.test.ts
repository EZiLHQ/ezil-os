import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { handlePoolClaim } from './aws-pool-claim';
import { observePoolAdopt } from './aws-pool-adopt';
import { poolFixture } from './aws-pool-test-support';
import { createFakePlacementDb, placementRow, type Row } from './fake-placement-db.test-support';
import { readPlacement, type PlacementDb, type PlacementExecutor } from './placement';
import * as pool from './ready-pool';

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

/** Real observer, receipt, admission/attachment CAS and pool publication SQL.
 * Only the SQL executor and provider evidence are in-memory. This models
 * transaction rollback and command ordering; it is not live Postgres proof.
 */
function adoption(pause?: (sql: string) => Promise<void>) {
    const f = poolFixture(true);
    const p = f.p;
    const initial = placementRow({ computer_id: p.computerId, owner_user_id: p.ownerUserId,
        generation: p.generation, lease_epoch: p.leaseEpoch, state: p.state, region: p.region,
        zone_id: p.zoneId, instance_type: p.instanceType, instance_id: p.instanceId,
        volume_id: p.volumeId, fs_uuid: p.fsUuid, fence_token: p.fenceToken,
        lifecycle_job_id: p.lifecycleJobId, lifecycle_digest: p.lifecycleDigest, updated_at: p.updatedAt });
    const fake = createFakePlacementDb({ placements: [initial], computers: [{ id: p.computerId, user_id: p.ownerUserId }] },
        { yield: async () => {}, clock: f.deps.now });
    const host: Row = { id: f.row.poolHostId, generation: f.row.poolGeneration, region: p.region,
        zone_id: p.zoneId, instance_type: p.instanceType, instance_id: p.instanceId, state: 'leased',
        leased_computer_id: p.computerId, claim_generation: null, claim_lease_epoch: null,
        claim_fence: null, claim_volume_serial: null, updated_at: p.updatedAt };
    const dialect = new PgDialect();
    const commands: string[] = [];
    const execute = (tx: PlacementExecutor, transactional: boolean): PlacementExecutor['execute'] => async query => {
        const q = dialect.sqlToQuery(query), sql = q.sql.trim();
        commands.push(sql);
        let result: unknown;
        if (sql.includes('public.ezil_compute_pool_hosts')) {
            if (sql.startsWith('UPDATE')) {
                if (!transactional) throw new Error('publication outside transaction');
                const [generation, epoch, fence, serial, at, id, computer] = q.params;
                expect(id).toBe(host.id); expect(computer).toBe(host.leased_computer_id);
                expect(host.state).toBe('leased');
                Object.assign(host, { claim_generation: generation, claim_lease_epoch: epoch,
                    claim_fence: fence, claim_volume_serial: serial, updated_at: at });
                result = { rows: [{ ...host }] };
            } else {
                const pending = sql.includes('claim_generation IS NULL');
                result = { rows: (host.claim_generation === null) === pending ? [{ ...host }] : [] };
            }
        } else result = await tx.execute(query);
        await pause?.(sql);
        return result;
    };
    const committed = vi.fn(), rolledBack = vi.fn();
    const db: PlacementDb = { execute: execute(fake.db, false), transaction: vi.fn(run => fake.db.transaction(async tx => {
        const saved = { ...host };
        try { const result = await run({ execute: execute(tx, true) }); committed(); return result; }
        catch (error) { Object.assign(host, saved); rolledBack(); throw error; }
    })) };
    f.deps.db = db;
    f.deps.data.readPoolClaim = pool.readPoolClaim;
    f.deps.lockPlacement = vi.fn(async tx => (await readPlacement(tx, p.computerId)).record);
    f.deps.observeAdopt = (proof, identity, poll) => observePoolAdopt(f.deps, proof, identity, poll);
    const publish = vi.spyOn(pool, 'publishPoolClaim');
    return { ...f, fake, host, initial, commands, committed, rolledBack, publish };
}

describe('adopt publication cancellation with actual receipt and attachment transactions', () => {
    it.each(['admission lock', 'attachment CAS', 'publication'])('drains the %s command and rolls back on cancellation', async stage => {
        for (const stop of ['abort', 'deadline']) {
            vi.restoreAllMocks();
            vi.spyOn(console, 'info').mockImplementation(() => {});
            const gate = deferred(), entered = vi.fn();
            const f = adoption(async sql => {
                const match = stage === 'admission lock' ? sql.includes('placement:lock-admission')
                    : stage === 'attachment CAS' ? sql.includes('placement:cas')
                        : sql.startsWith('UPDATE public.ezil_compute_pool_hosts');
                if (match) { entered(); await gate.promise; }
            });
            const controller = new AbortController(), done = vi.fn();
            const held = handlePoolClaim(new Request(f.request('claim'), { signal: controller.signal }), f.deps).then(done);
            await vi.advanceTimersByTimeAsync(0);
            expect(entered).toHaveBeenCalledOnce();
            if (stop === 'abort') controller.abort();
            else await vi.advanceTimersByTimeAsync(5_000);
            // Do not return while a transactional command/publication is running.
            expect(done).not.toHaveBeenCalled();
            const issued = f.commands.length;
            gate.resolve();
            await held;
            expect((done.mock.calls[0]![0] as Response).status).toBe(204);
            expect(f.commands).toHaveLength(issued);
            expect(f.committed).not.toHaveBeenCalled();
            expect(f.rolledBack).toHaveBeenCalledOnce();
            expect(f.host.claim_generation).toBeNull();
            expect(f.fake.placements).toEqual([f.initial]);
            expect(f.deps.saveNonce).not.toHaveBeenCalled();
            expect(console.info).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        }
    });

    it('does not enter a transaction whose connection becomes available after disconnect', async () => {
        const f = adoption(), gate = deferred(), entered = vi.fn();
        const transaction = f.deps.db.transaction;
        f.deps.db.transaction = async run => { entered(); await gate.promise; return transaction(run); };
        const controller = new AbortController();
        const held = handlePoolClaim(new Request(f.request('claim'), { signal: controller.signal }), f.deps);
        await vi.advanceTimersByTimeAsync(0);
        expect(entered).toHaveBeenCalledOnce();
        controller.abort();
        const issued = f.commands.length;
        gate.resolve();
        expect((await held).status).toBe(204);
        expect(f.commands).toHaveLength(issued);
        expect(f.publish).not.toHaveBeenCalled();
        expect(f.deps.saveNonce).not.toHaveBeenCalled();
        expect(f.rolledBack).toHaveBeenCalledOnce();
    });

    it.each(['abort', 'deadline'])('bounds a provider read inside the nonce transaction on %s', async stop => {
        const f = adoption(), gate = deferred();
        vi.mocked(f.deps.executions!.describe).mockResolvedValueOnce(f.execution)
            .mockImplementationOnce(async () => { await gate.promise; return f.execution; });
        const controller = new AbortController();
        const held = handlePoolClaim(new Request(f.request('claim'), { signal: controller.signal }), f.deps);
        await vi.advanceTimersByTimeAsync(0);
        expect(f.deps.executions!.describe).toHaveBeenCalledTimes(2);
        // The earlier publication already committed while the request was active.
        expect(f.publish).toHaveBeenCalledOnce();
        expect(f.committed).toHaveBeenCalledOnce();
        if (stop === 'abort') controller.abort();
        else await vi.advanceTimersByTimeAsync(5_000);
        expect((await held).status).toBe(204);
        expect(f.rolledBack).toHaveBeenCalledOnce();
        gate.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.deps.saveNonce).not.toHaveBeenCalled();
        expect(f.publish).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['claim read', 'placement lock', 'nonce write'])('settles the %s before rolling back a cancelled nonce transaction', async stage => {
        for (const stop of ['abort', 'deadline']) {
            vi.restoreAllMocks();
            vi.spyOn(console, 'info').mockImplementation(() => {});
            const f = adoption(), gate = deferred(), entered = vi.fn();
            const pause = async () => { entered(); await gate.promise; };
            if (stage === 'claim read') {
                const read = f.deps.data.readPoolClaim;
                f.deps.data.readPoolClaim = async (...args) => { const result = await read(...args); await pause(); return result; };
            } else if (stage === 'placement lock') {
                const lock = f.deps.lockPlacement;
                f.deps.lockPlacement = async (...args) => { const result = await lock(...args); await pause(); return result; };
            } else vi.mocked(f.deps.saveNonce).mockImplementationOnce(async () => { await pause(); return true; });
            const controller = new AbortController(), done = vi.fn();
            const held = handlePoolClaim(new Request(f.request('claim'), { signal: controller.signal }), f.deps).then(done);
            await vi.advanceTimersByTimeAsync(0);
            expect(entered).toHaveBeenCalledOnce();
            if (stop === 'abort') controller.abort();
            else await vi.advanceTimersByTimeAsync(5_000);
            expect(done).not.toHaveBeenCalled();
            gate.resolve();
            await held;
            expect((done.mock.calls[0]![0] as Response).status).toBe(204);
            expect(f.committed).toHaveBeenCalledOnce(); // Earlier publication only.
            expect(f.rolledBack).toHaveBeenCalledOnce();
            expect(f.deps.saveNonce).toHaveBeenCalledTimes(stage === 'nonce write' ? 1 : 0);
            expect(vi.getTimerCount()).toBe(0);
        }
    });

    it('a deferred successful execution publishes and issues the unchanged claim within budget', async () => {
        const f = adoption(), gate = deferred();
        vi.mocked(f.deps.executions!.describe).mockImplementationOnce(async () => { await gate.promise; return f.execution; });
        const held = handlePoolClaim(f.request('claim'), f.deps);
        await vi.advanceTimersByTimeAsync(4_999);
        gate.resolve();
        const response = await held;
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ computerId: f.p.computerId, generation: f.p.generation,
            leaseEpoch: f.p.leaseEpoch, fence: f.p.fenceToken, enrollNonce: expect.any(String) });
        expect(f.publish).toHaveBeenCalledOnce();
        expect(f.deps.saveNonce).toHaveBeenCalledOnce();
        expect(f.committed).toHaveBeenCalledTimes(2);
        expect(f.rolledBack).not.toHaveBeenCalled();
        expect(f.fake.usage).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});
