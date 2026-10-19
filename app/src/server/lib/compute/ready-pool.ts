/** Offline, single-use ready pool. No lifecycle caller imports this module. */
import { sql, type SQL } from 'drizzle-orm';
import { AWS_REGION_PATTERN, instanceVcpu } from './aws-config';

export const POOL_INSTANCE_TYPES = ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge'] as const;
export type PoolInstanceType = typeof POOL_INSTANCE_TYPES[number];
export interface PoolExecutor { execute(query: SQL): Promise<unknown> }
export interface LeasedPoolHost {
    id: string;
    region: string;
    zoneId: string;
    instanceId: string;
    instanceType: PoolInstanceType;
    state: 'leased';
    generation: number;
    leasedGeneration: number;
    leasedComputerId: string;
    leaseToken: string;
    leasedAt: Date;
    editorReadyAt: Date;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
    const rows = Array.isArray(result) ? result : (result as { rows?: unknown } | null)?.rows;
    if (!Array.isArray(rows)) throw new Error('pool_result_invalid');
    return rows as Record<string, unknown>[];
}
function generationOf(value: unknown): number {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('pool_generation_invalid');
    return n;
}
function checkClass(region: string, instanceType: PoolInstanceType): void {
    if (!AWS_REGION_PATTERN.test(region) || !POOL_INSTANCE_TYPES.includes(instanceType)) throw new Error('pool_class_invalid');
}

/** One atomic statement, including candidate selection. No candidate means cold boot. */
export async function leasePoolHost(db: PoolExecutor, args: {
    region: string; instanceType: PoolInstanceType; computerId: string; now: Date;
}): Promise<LeasedPoolHost | null> {
    checkClass(args.region, args.instanceType);
    const at = args.now.toISOString();
    const rows = rowsOf(await db.execute(sql`
        UPDATE public.ezil_compute_pool_hosts
        SET state = 'leased', leased_computer_id = ${args.computerId}::uuid,
            leased_generation = generation, lease_token = gen_random_uuid(),
            leased_at = ${at}::timestamptz, generation = generation + 1, updated_at = ${at}::timestamptz
        WHERE id = (
            SELECT id FROM public.ezil_compute_pool_hosts
            WHERE region = ${args.region} AND instance_type = ${args.instanceType}
                AND state = 'ready' AND health = 'healthy' AND editor_ready_at IS NOT NULL
            ORDER BY editor_ready_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        RETURNING id, region, zone_id, instance_id, instance_type, state, generation,
            leased_generation, leased_computer_id, lease_token, leased_at, editor_ready_at
    `));
    const row = rows[0];
    if (!row) return null;
    return {
        id: String(row.id), region: String(row.region), zoneId: String(row.zone_id),
        instanceId: String(row.instance_id), instanceType: row.instance_type as PoolInstanceType,
        state: 'leased', generation: generationOf(row.generation), leasedGeneration: generationOf(row.leased_generation),
        leasedComputerId: String(row.leased_computer_id), leaseToken: String(row.lease_token),
        leasedAt: new Date(row.leased_at as string | Date), editorReadyAt: new Date(row.editor_ready_at as string | Date),
    };
}

/** Pass the returned host.generation (2 on first lease), not leasedGeneration (1).
 * Single-use hosts drain; they cannot return to the clean pool after user access. */
export async function releasePoolHost(db: PoolExecutor, args: {
    id: string; leaseToken: string; generation: number;
}): Promise<'released' | 'fenced'> {
    if (!Number.isSafeInteger(args.generation) || args.generation < 2) return 'fenced';
    const rows = rowsOf(await db.execute(sql`
        UPDATE public.ezil_compute_pool_hosts
        SET state = 'draining', leased_computer_id = NULL, leased_generation = NULL,
            lease_token = NULL, leased_at = NULL, updated_at = now()
        WHERE id = ${args.id}::uuid AND state = 'leased' AND lease_token = ${args.leaseToken}::uuid
            AND generation = ${args.generation} AND leased_generation = ${args.generation - 1}
        RETURNING id
    `));
    return rows.length === 1 ? 'released' : 'fenced';
}

export interface PoolCounts {
    region: string; instanceType: PoolInstanceType;
    ready: number; booting: number; leased: number; draining: number;
}
export interface PoolTarget { region: string; instanceType: PoolInstanceType; count: number }
export interface PoolBoot { region: string; instanceType: PoolInstanceType; count: number }

/** runningVcpu includes all existing/reserved compute, including the pool. maxHosts
 * caps all non-retired pool hosts. Booting hosts already satisfy the ready target.
 * Sorting by region then type makes allocation independent of input order. Invalid
 * counts refuse the entire plan; they must never create apparent spare capacity. */
export function replenishPlan(args: {
    pool: readonly PoolCounts[];
    runningVcpu: number;
    budget: { maxGlobalVcpu: number; maxHosts: number; maxBootsPerPass: number };
    targets: readonly PoolTarget[];
}): PoolBoot[] {
    const count = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) throw new Error('pool_count_invalid'); return n; };
    let hosts = 0;
    let poolVcpu = 0;
    const available = new Map<string, number>();
    const key = (r: string, t: string) => `${r}/${t}`;
    for (const row of args.pool) {
        checkClass(row.region, row.instanceType);
        const total = count(row.ready) + count(row.booting) + count(row.leased) + count(row.draining);
        hosts = count(hosts + total);
        poolVcpu = count(poolVcpu + total * instanceVcpu(row.instanceType));
        const k = key(row.region, row.instanceType);
        available.set(k, count((available.get(k) ?? 0) + row.ready + row.booting));
    }
    // Even an inconsistent global counter cannot omit known pool capacity.
    let vcpuLeft = Math.max(0, count(args.budget.maxGlobalVcpu) - Math.max(count(args.runningVcpu), poolVcpu));
    let hostSlots = Math.max(0, count(args.budget.maxHosts) - hosts);
    let bootsLeft = count(args.budget.maxBootsPerPass);
    const targets = new Map<string, PoolTarget>();
    for (const target of args.targets) {
        checkClass(target.region, target.instanceType);
        count(target.count);
        const k = key(target.region, target.instanceType);
        if (targets.has(k)) throw new Error('pool_target_duplicate');
        targets.set(k, target);
    }
    const plan: PoolBoot[] = [];
    for (const k of [...targets.keys()].sort()) {
        const target = targets.get(k)!;
        const vcpu = instanceVcpu(target.instanceType);
        const n = Math.min(Math.max(0, target.count - (available.get(k) ?? 0)), hostSlots, bootsLeft, Math.floor(vcpuLeft / vcpu));
        if (n > 0) plan.push({ region: target.region, instanceType: target.instanceType, count: n });
        hostSlots -= n; bootsLeft -= n; vcpuLeft -= n * vcpu;
    }
    return plan;
}
