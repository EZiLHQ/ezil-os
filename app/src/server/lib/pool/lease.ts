import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';

import { POOL_HARD_MAX, type PoolConfig } from './config';
import { getActivePlan, type EntitlementSource } from './entitlement-source';
import { assertShapeEligible, type ShapeId } from './shapes';

export interface PoolExecutor {
    execute(query: SQL): PromiseLike<unknown>;
}

export interface PoolDb extends PoolExecutor {
    transaction<T>(work: (tx: PoolExecutor) => Promise<T>, config?: { isolationLevel: 'read committed' }): Promise<T>;
}

export type PoolSlot = {
    id: string;
    shape: ShapeId;
    sandbox_id: string;
    state: 'warming' | 'ready' | 'leased' | 'draining' | 'destroyed';
    created_at: Date | string;
    ready_at: Date | string | null;
    leased_at: Date | string | null;
    lease_id: string | null;
    leased_to_user_id: string | null;
    leased_computer_id: string | null;
    last_error: string | null;
};

async function rows<T>(db: PoolExecutor, query: SQL): Promise<T[]> {
    return await db.execute(query) as T[];
}

function liveLeaseConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const e = error as { code?: string; constraint_name?: string; constraint?: string; cause?: unknown };
    return (e.code === '23505' && ['ezil_pool_slots_live_user_idx', 'ezil_pool_slots_live_computer_idx']
        .includes(e.constraint_name ?? e.constraint ?? '')) || (e.cause !== error && liveLeaseConflict(e.cause));
}

/** Call only after computer ownership is checked. Null means use the cold-start path. */
export async function claim(db: PoolDb, config: PoolConfig, entitlements: EntitlementSource,
    input: { shape: ShapeId; userId: string; computerId: string }): Promise<PoolSlot | null> {
    const plan = await getActivePlan(entitlements, input.userId);
    assertShapeEligible(input.shape, plan);
    if (!config.enabled || config.maxTotal <= 0 || config.targets[input.shape] <= 0) return null;

    try {
        return await db.transaction(async (tx) => {
            // A count in the UPDATE alone races under MVCC. Serialize shape claims,
            // then take a fresh READ COMMITTED snapshot for the reserve predicate.
            await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ezil_pool_claim_${input.shape}`}))`);
            const claimed = await rows<PoolSlot>(tx, sql`
                update ezil_pool_slots set state = 'leased', lease_id = ${randomUUID()}::uuid,
                    leased_at = now(), leased_to_user_id = ${input.userId}::uuid,
                    leased_computer_id = ${input.computerId}::uuid
                where id = (
                    select id from ezil_pool_slots
                    where state = 'ready' and shape = ${input.shape}
                        and ready_at >= now() - ${config.readyTtlSeconds} * interval '1 second'
                        and (${plan === 'subscriber'} or (
                            select count(*) from ezil_pool_slots
                            where state = 'ready' and shape = ${input.shape}
                        ) > ${config.subscriberReserve})
                    order by ready_at for update skip locked limit 1
                ) and state = 'ready'
                returning *
            `);
            return claimed[0] ?? null;
        }, { isolationLevel: 'read committed' });
    } catch (error) {
        if (liveLeaseConflict(error)) return null;
        throw error;
    }
}

/** Inserts warming reservations under the lock; boot containers only after commit. */
export async function refillPlan(db: PoolDb, config: PoolConfig): Promise<PoolSlot[]> {
    if (!config.enabled || config.maxTotal <= 0) return [];
    return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ezil_pool_refill'))`);
        const counts = await rows<{ shape: ShapeId; state: PoolSlot['state']; count: number }>(tx, sql`
            select shape, state, count(*)::int as count from ezil_pool_slots
            where state <> 'destroyed' group by shape, state
        `);
        let total = counts.reduce((sum, row) => sum + row.count, 0);
        const plan: PoolSlot[] = [];
        for (const shape of ['standard', 'performance'] as const) {
            let available = counts.filter((row) => row.shape === shape && ['warming', 'ready'].includes(row.state))
                .reduce((sum, row) => sum + row.count, 0);
            while (available < config.targets[shape] && total < Math.min(config.maxTotal, POOL_HARD_MAX)) {
                const id = randomUUID();
                const inserted = await rows<PoolSlot>(tx, sql`
                    insert into ezil_pool_slots (id, shape, sandbox_id, state)
                    values (${id}::uuid, ${shape}, ${`pool-${shape}-${id}`}, 'warming') returning *
                `);
                if (!inserted[0]) throw new Error('pool_insert_returned_no_row');
                plan.push(inserted[0]);
                available++;
                total++;
            }
        }
        return plan;
    }, { isolationLevel: 'read committed' });
}

export async function markReady(db: PoolExecutor, config: PoolConfig, slotId: string,
    probes: { desktopStream: boolean; codeServerHttpStatus: number; relay: boolean }): Promise<PoolSlot | null> {
    if (!config.enabled || !probes.desktopStream || probes.codeServerHttpStatus !== 200 || !probes.relay) return null;
    const ready = await rows<PoolSlot>(db, sql`
        update ezil_pool_slots set state = 'ready', ready_at = now()
        where id = ${slotId}::uuid and state = 'warming' returning *
    `);
    return ready[0] ?? null;
}

/** Must confirm actual container destruction; throw on any unconfirmed teardown. */
export type DestroySandbox = (sandboxId: string) => Promise<void>;

async function destroySlots(db: PoolExecutor, slots: PoolSlot[], destroySandbox: DestroySandbox) {
    const destroyed: PoolSlot[] = [];
    for (const slot of slots) {
        try {
            await destroySandbox(slot.sandbox_id);
        } catch {
            await db.execute(sql`update ezil_pool_slots set last_error = 'sandbox_destroy_failed'
                where id = ${slot.id}::uuid and state = 'draining'`);
            continue;
        }
        destroyed.push(...await rows<PoolSlot>(db, sql`
            update ezil_pool_slots set state = 'destroyed', last_error = null
            where id = ${slot.id}::uuid and state = 'draining' returning *
        `));
    }
    return destroyed;
}

/** Draining rows retain capacity until destruction succeeds. Cleanup also works after disabling refill. */
export async function release(db: PoolExecutor,
    input: { leaseId: string; userId: string; computerId: string }, destroySandbox: DestroySandbox): Promise<PoolSlot | null> {
    const slots = await rows<PoolSlot>(db, sql`
        update ezil_pool_slots set state = 'draining'
        where lease_id = ${input.leaseId}::uuid and leased_to_user_id = ${input.userId}::uuid
            and leased_computer_id = ${input.computerId}::uuid and state in ('leased', 'draining') returning *
    `);
    return (await destroySlots(db, slots, destroySandbox))[0] ?? null;
}

export async function reapExpired(db: PoolExecutor, config: PoolConfig, destroySandbox: DestroySandbox): Promise<PoolSlot[]> {
    const slots = await rows<PoolSlot>(db, sql`
        update ezil_pool_slots set state = 'draining'
        where id in (
            select id from ezil_pool_slots
            where (state = 'ready' and ready_at < now() - ${config.readyTtlSeconds} * interval '1 second')
                or state = 'draining'
            for update skip locked
        ) and state in ('ready', 'draining') returning *
    `);
    return destroySlots(db, slots, destroySandbox);
}
