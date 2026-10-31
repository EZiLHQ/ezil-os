/** Single-use warm hosts. Callers own admission, lifecycle execution and transactions. */
import { sql } from 'drizzle-orm';
import { RUNNING_CLASS_STATES, type Placement, type PlacementExecutor } from './placement';
import { AWS_REGION_PATTERN, INSTANCE_VCPU, instanceVcpu, readAwsRegions } from './aws-config';

export const POOL_TYPES = ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge'] as const;
export type PoolClass = { region: string; zoneId: string; instanceType: typeof POOL_TYPES[number]; deployment?: import('./aws-intent').LifecycleDeployment };
export type PoolHostState = 'booting' | 'ready' | 'leased' | 'retiring' | 'retired' | 'failed';
export interface PoolHostRow {
    poolHostId: string; poolGeneration: number; region: string; zoneId: string; instanceType: string;
    instanceId: string | null; state: PoolHostState; readyAt: Date | null; enrolledAt: Date | null;
    leasedComputerId: string | null; leasedAt: Date | null; claimGeneration: number | null;
    claimPublishedAt?: Date | null;
    claimLeaseEpoch: number | null; claimFence: string | null; claimVolumeSerial: string | null;
}
export interface PoolDemand {
    pending?: number; opens15m: number; activeStandard: number; activePremium: number; bootMinutes: number | null;
    ready?: number; spares: number; vcpuInUse: number; regionVcpuCap: number; killSwitch: boolean;
    /** Active capacity demands' reserved vCPU in this region (capacity-demand.ts). Future demand, not physical liability. */
    demandVcpu?: number;
    /** Pool hosts an active demand needs gone: never adopted, retired once their provision settles. */
    earmarked?: string[];
    idleReady: { poolHostId: string; readyAt: Date; obsolete?: boolean; unusable?: boolean }[];
    booting: { poolHostId: string; createdAt: Date; enrolledAt?: Date }[];
}
export type PoolData = Pick<typeof import('./ready-pool'), 'recordPoolEnrollment' | 'recordPoolReady' | 'readPoolClaim' | 'markPoolHost' | 'readPoolDemand' | 'readPoolReadinessDiagnostics' | 'planPool' | 'POOL_POLICY'>;
export interface PoolReadinessDiagnostic {
    poolHostId: string; instanceId: string | null; createdAt: string; enrolledAt: string | null; health: string;
}
/** Demand-driven pool (founder, 2026-10-26): one ready spare per class while any paid user has
 * selected it, rising with activity. Idle spares never exceed that class's paid users. maxSpares is
 * only a runaway ceiling; the region vCPU cap still bounds every class. */
export const POOL_POLICY: Record<string, { minSpares: number; maxSpares: number }> = {
    'ap-south-1:m6i.large': { minSpares: 1, maxSpares: 16 },
    'ap-south-1:m6i.xlarge': { minSpares: 1, maxSpares: 8 },
    'ap-south-1:m6i.2xlarge': { minSpares: 1, maxSpares: 4 },
};
/** Production namespace prd (founder 2026-10-30, "one warm spare"): exactly one ready m6i.large
 * spare, larger classes always cold. The mum policy above is unchanged. */
export const PRD_POOL_POLICY: Record<string, { minSpares: number; maxSpares: number }> = {
    'ap-south-1:m6i.large': { minSpares: 1, maxSpares: 1 },
    'ap-south-1:m6i.xlarge': { minSpares: 0, maxSpares: 0 },
    'ap-south-1:m6i.2xlarge': { minSpares: 0, maxSpares: 0 },
};
/** The policy follows the class's namespace; a class without a deployment keeps the mum policy. */
export function poolPolicy(c: Pick<PoolClass, 'region' | 'instanceType' | 'deployment'>,
    base: Record<string, { minSpares: number; maxSpares: number }> = POOL_POLICY): { minSpares: number; maxSpares: number } {
    const table = c.deployment?.namespace === 'prd' ? PRD_POOL_POLICY : base;
    return table[`${c.region}:${c.instanceType}`] ?? { minSpares: 0, maxSpares: 0 };
}
const MINUTE = 60_000;
/**
 * Round 6 (R2-4): a booting spare that enrolled but is still not ready this long after its creation died
 * in its first readiness wait (host agent `pool.py` wait_ready raises pool_desktop_not_ready and the oneshot
 * guard never restarts). It is failed then instead of at ten minutes, and is not counted as a spare, so the
 * same replenish pass provisions its replacement (live 10-30: refills retired ~11 min after launch).
 */
export const POOL_BOOT_STALLED_MS = 6 * MINUTE;
/**
 * The agent's own wait after enrolling: start_warm, then wait_ready (180 s), then the ready POST, which
 * `pool.py` retries on 5xx/429 (a deploy window). An enrollment younger than this may still answer. That is
 * about four minutes plus a minute for the POST. Healthy live refills were ready in 84 s and 51 s (10-30).
 */
export const POOL_ENROLLED_READY_WAIT_MS = 5 * MINUTE;
const bootStalled = (h: { createdAt: Date; enrolledAt?: Date }, now: Date) => !!h.enrolledAt
    && now.getTime() - h.createdAt.getTime() > POOL_BOOT_STALLED_MS && now.getTime() - h.enrolledAt.getTime() > POOL_ENROLLED_READY_WAIT_MS;
/** The same predicate for `readPoolDemand`'s spare count: what planPool fails is never a spare. */
function bootStalledSql(now: Date) {
    return sql`(enrolled_at IS NOT NULL AND created_at < ${new Date(now.getTime() - POOL_BOOT_STALLED_MS).toISOString()}::timestamptz
                AND enrolled_at < ${new Date(now.getTime() - POOL_ENROLLED_READY_WAIT_MS).toISOString()}::timestamptz)`;
}
function rowsOf(result: unknown): Record<string, unknown>[] {
    const rows = Array.isArray(result) ? result : (result as { rows?: unknown } | null)?.rows;
    if (!Array.isArray(rows)) throw new Error('pool_result_invalid');
    return rows as Record<string, unknown>[];
}
function count(value: unknown): number {
    const n = Number(value);
    if (value === null || !Number.isSafeInteger(n) || n < 0) throw new Error('pool_count_invalid');
    return n;
}
function positive(value: unknown): number {
    const n = count(value);
    if (n === 0) throw new Error('pool_generation_invalid');
    return n;
}
function checkClass(c: PoolClass): void {
    if (!AWS_REGION_PATTERN.test(c.region) || !POOL_TYPES.includes(c.instanceType) || !c.zoneId) throw new Error('pool_class_invalid');
}
/** Provision input is immutable; a different release is not a compatible spare. */
function compatibleDeployment(c: PoolClass) {
    return c.deployment ? sql`(lifecycle_input::jsonb->>'document')::jsonb->'deployment' = ${JSON.stringify({...c.deployment, storage: {rootDeviceName:'/dev/sda1', ...c.deployment.storage}})}::jsonb` : sql`TRUE`;
}
/** Identical readiness predicate for leasing and counting usable warm capacity. */
function usableReady(at: string, host: ReturnType<typeof sql> = sql`ezil_compute_pool_hosts.id`) {
    return sql`state = 'ready' AND health = 'healthy'
                AND instance_id IS NOT NULL
                AND editor_ready_at IS NOT NULL AND editor_ready_at <= ${at}::timestamptz
                AND ready_at IS NOT NULL AND ready_at <= ${at}::timestamptz
                AND enrolled_at > ${at}::timestamptz - interval '10 minutes' AND enrolled_at <= ${at}::timestamptz
                AND generation > 0 AND generation <= ${Number.MAX_SAFE_INTEGER}
                AND leased_computer_id IS NULL AND leased_at IS NULL
                AND leased_generation IS NULL AND lease_token IS NULL
                AND NOT EXISTS (SELECT 1 FROM public.ezil_compute_capacity_demands demand, jsonb_array_elements(demand.cleanup) target
                    WHERE demand.closed_at IS NULL AND target->>'poolHostId' = (${host})::text)`;
}
const date = (value: unknown) => value == null ? null : new Date(value as string | Date);
const nullableString = (value: unknown) => value == null ? null : String(value);
function host(row: Record<string, unknown>): PoolHostRow {
    return {
        poolHostId: String(row.id), poolGeneration: positive(row.generation), region: String(row.region),
        zoneId: String(row.zone_id), instanceType: String(row.instance_type), instanceId: nullableString(row.instance_id),
        state: row.state as PoolHostState, readyAt: date(row.ready_at), enrolledAt: date(row.enrolled_at),
        leasedComputerId: nullableString(row.leased_computer_id), leasedAt: date(row.leased_at),
        claimGeneration: row.claim_generation == null ? null : positive(row.claim_generation),
        claimLeaseEpoch: row.claim_lease_epoch == null ? null : positive(row.claim_lease_epoch),
        ...(row.claim_generation != null ? { claimPublishedAt: date(row.updated_at) } : {}),
        claimFence: nullableString(row.claim_fence), claimVolumeSerial: nullableString(row.claim_volume_serial),
    };
}
function optionalHost(result: unknown): PoolHostRow | null {
    const row = rowsOf(result)[0];
    return row ? host(row) : null;
}
function requiredHost(result: unknown): PoolHostRow {
    const row = optionalHost(result);
    if (!row) throw new Error('pool_state_conflict');
    return row;
}

export async function leasePoolHost(tx: PlacementExecutor, c: PoolClass, computerId: string, priority: 1 | 2, now: Date): Promise<PoolHostRow | null> {
    checkClass(c);
    if (priority !== 1 && priority !== 2) throw new Error('pool_priority_invalid');
    const at = now!.toISOString();
    return optionalHost(await tx.execute(sql`
        UPDATE public.ezil_compute_pool_hosts
        SET state = 'leased', leased_computer_id = ${computerId}::uuid, leased_generation = generation,
            lease_token = gen_random_uuid(), leased_at = ${at}::timestamptz,
            pool_priority = ${priority}, updated_at = ${at}::timestamptz
        WHERE id = (
            SELECT id FROM public.ezil_compute_pool_hosts
            WHERE region = ${c.region} AND zone_id = ${c.zoneId} AND instance_type = ${c.instanceType}
                AND ${compatibleDeployment(c)}
                AND ${usableReady(at)}
            ORDER BY pool_priority DESC, ready_at ASC, id ASC
            FOR UPDATE SKIP LOCKED LIMIT 1
        ) RETURNING *
    `));
}

/** Identity authentication is performed by the enrollment endpoint before this CAS. */
export async function recordPoolEnrollment(db: PlacementExecutor, poolHostId: string, instanceId: string, now: Date): Promise<PoolHostRow> {
    if (!instanceId) throw new Error('pool_instance_invalid');
    return requiredHost(await db.execute(sql`
        UPDATE public.ezil_compute_pool_hosts SET instance_id = ${instanceId}, enrolled_at = ${now.toISOString()}::timestamptz,
            updated_at = ${now.toISOString()}::timestamptz
        WHERE id = ${poolHostId}::uuid AND state IN ('booting', 'ready')
            AND leased_computer_id IS NULL AND leased_at IS NULL
            AND (instance_id IS NULL OR instance_id = ${instanceId})
        RETURNING *
    `));
}
export async function recordPoolReady(db: PlacementExecutor, poolHostId: string, health: { editorOk: boolean }, now: Date): Promise<PoolHostRow> {
    if (health.editorOk !== true) throw new Error('pool_editor_unhealthy');
    const at = now.toISOString();
    return requiredHost(await db.execute(sql`
        UPDATE public.ezil_compute_pool_hosts SET state = 'ready', health = 'healthy',
            editor_ready_at = COALESCE(editor_ready_at, ${at}::timestamptz),
            ready_at = COALESCE(ready_at, ${at}::timestamptz), updated_at = ${at}::timestamptz
        WHERE id = ${poolHostId}::uuid AND state IN ('booting', 'ready')
            AND instance_id IS NOT NULL AND leased_computer_id IS NULL AND leased_at IS NULL
            AND enrolled_at > ${at}::timestamptz - interval '10 minutes' AND enrolled_at <= ${at}::timestamptz
        RETURNING *
    `));
}

/** Publish only AFTER successful adopt/attach. Endpoint supplies the epoch's one-time enroll nonce separately. */
export async function publishPoolClaim(db: PlacementExecutor, poolHostId: string, claim: {
    computerId: string; generation: number; leaseEpoch: number; fence: string; volumeSerial: string;
}, now: Date): Promise<PoolHostRow> {
    positive(claim.generation); positive(claim.leaseEpoch);
    if (!claim.fence || !claim.volumeSerial) throw new Error('pool_claim_invalid');
    return requiredHost(await db.execute(sql`
        UPDATE public.ezil_compute_pool_hosts SET claim_generation = ${claim.generation}, claim_lease_epoch = ${claim.leaseEpoch},
            claim_fence = ${claim.fence}, claim_volume_serial = ${claim.volumeSerial},
            updated_at = CASE WHEN claim_generation IS NULL THEN ${now.toISOString()}::timestamptz ELSE updated_at END
        WHERE id = ${poolHostId}::uuid AND state = 'leased' AND leased_computer_id = ${claim.computerId}::uuid
            AND ((claim_generation IS NULL AND claim_lease_epoch IS NULL AND claim_fence IS NULL AND claim_volume_serial IS NULL)
                OR (claim_generation = ${claim.generation} AND claim_lease_epoch = ${claim.leaseEpoch}
                AND claim_fence = ${claim.fence} AND claim_volume_serial = ${claim.volumeSerial}))
        RETURNING *
    `));
}
export async function readPoolClaim(db: PlacementExecutor, poolHostId: string, instanceId: string): Promise<PoolHostRow | null> {
    return optionalHost(await db.execute(sql`
        SELECT * FROM public.ezil_compute_pool_hosts
        WHERE id = ${poolHostId}::uuid AND instance_id = ${instanceId} AND state = 'leased'
            AND leased_computer_id IS NOT NULL AND claim_generation IS NOT NULL AND claim_lease_epoch IS NOT NULL
            AND claim_fence IS NOT NULL AND claim_volume_serial IS NOT NULL
    `));
}

/** Readiness and leasing have dedicated guarded writes; generic marks can only move toward retirement. */
export async function markPoolHost(db: PlacementExecutor, poolHostId: string, from: PoolHostState[], to: PoolHostState, now: Date): Promise<PoolHostRow | null> {
    const predecessors: Partial<Record<PoolHostState, PoolHostState[]>> = {
        failed: ['booting'], retiring: ['booting', 'ready', 'leased', 'failed', 'retiring'], retired: ['retiring'],
    };
    const allowed = from.filter(state => predecessors[to]?.includes(state));
    if (!allowed.length) return null;
    return optionalHost(await db.execute(sql`
        UPDATE public.ezil_compute_pool_hosts SET state = ${to}, updated_at = ${now.toISOString()}::timestamptz
        WHERE id = ${poolHostId}::uuid AND state IN (${sql.join(allowed.map(state => sql`${state}`), sql`, `)}) RETURNING *
    `));
}

/** A single class plan. The caller holds the advisory lock and shares the two-boot budget across classes. */
export function planPool(c: PoolClass, d: PoolDemand, now: Date): { target: number; provision: number; retire: string[]; fail: string[] } {
    for (const n of [d.opens15m, d.activeStandard, d.activePremium, d.spares, d.vcpuInUse, d.regionVcpuCap]) count(n);
    const boot = d.bootMinutes ?? 4;
    if (!Number.isFinite(boot) || boot <= 0) throw new Error('pool_boot_minutes_invalid');
    const policy = poolPolicy(c);
    const recent = Math.ceil(d.opens15m * boot / 15);
    const base = Math.ceil(0.04 * d.activeStandard + 0.10 * d.activePremium);
    const pending = count(d.pending ?? 0);
    const paid = d.activeStandard + d.activePremium;
    const want = Math.max(policy.minSpares, base, recent, pending + policy.minSpares);
    // Founder 2026-10-26: the minimum is one. The base class keeps one warm spare even with no
    // paid user yet, so the first upgrade adopts instantly; larger classes warm only once selected.
    const floor = c.instanceType === 'm6i.large' ? policy.minSpares : 0;
    // One computer per user: idle spares beyond the class's paid users (or waiting opens) can never be claimed.
    const desired = paid + pending > 0 ? Math.min(policy.maxSpares, want, Math.max(paid, pending)) : floor;
    const capacity = Math.floor((d.regionVcpuCap - d.vcpuInUse - count(d.demandVcpu ?? 0)) / instanceVcpu(c.instanceType)) + d.spares;
    const target = d.killSwitch ? 0 : Math.max(0, Math.min(desired, capacity));
    const excess = Math.max(0, d.spares - target);
    const aged = d.idleReady.filter(h => d.killSwitch || now.getTime() - h.readyAt.getTime() > 30 * MINUTE)
        .sort((a, b) => b.readyAt.getTime() - a.readyAt.getTime() || a.poolHostId.localeCompare(b.poolHostId));
    const ready = d.ready ?? Math.max(0,d.spares-d.booting.filter(h => !bootStalled(h, now)).length);
    const readyExcess = Math.min(excess,Math.max(0,ready-target));
    const retire = [...aged.filter(h => h.obsolete || h.unusable), ...aged.filter(h => !h.obsolete && !h.unusable).slice(0, readyExcess)]
        .slice(0, 2).map(h => h.poolHostId);
    const fail = d.booting.filter(h => now.getTime() - h.createdAt.getTime() > 10 * MINUTE || bootStalled(h, now)).map(h => h.poolHostId);
    return { target, provision: Math.min(2, Math.max(0, target - d.spares)), retire, fail };
}

/** The paid-pool eligibility CTEs (effective subscription per user, then eligible), shared by demand planning and
 * capacity-demand reauthorization. `user` narrows to one subject. Ends inside the WITH list (caller continues it). */
function eligibleCtes(at: string, user?: string) {
    const only = user ? sql` AND s.user_id = ${user}::uuid` : sql``;
    return sql`
        effective AS (
            SELECT DISTINCT ON (s.user_id) s.user_id, s.sku, s.status, s.stripe_subscription_id, s.current_period_start, s.current_period_end,
                CASE WHEN s.sku = 'standard_monthly_v3' THEN 'm6i.large'
                    WHEN pref.size = 'cmp-4' THEN 'm6i.xlarge'
                    WHEN pref.size = 'cmp-8' THEN 'm6i.2xlarge' ELSE 'm6i.large' END AS instance_type
            FROM public.ezil_billing_subscriptions s
            JOIN auth.users u ON u.id = s.user_id
            LEFT JOIN public.ezil_billing_size_preferences pref ON pref.user_id = s.user_id
            WHERE s.status IN ('active','trialing')${only} AND s.sku IN ('standard_monthly_v3', 'premium_monthly_v3',
                'standard_monthly_v2','compute_monthly_v2','pro_monthly_v1')
                AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until <= ${at}::timestamptz)
                AND s.current_period_start <= ${at}::timestamptz AND s.current_period_end > ${at}::timestamptz
            ORDER BY s.user_id, s.current_period_end DESC, s.current_period_start DESC, s.stripe_subscription_id COLLATE "C"
        ), eligible AS (
            SELECT s.* FROM effective s WHERE s.status = 'active' AND s.sku IN ('standard_monthly_v3','premium_monthly_v3')
                AND COALESCE((SELECT sum(g.amount) FROM public.ezil_billing_grants g
                    WHERE g.user_id = s.user_id AND g.subscription_id = s.stripe_subscription_id
                        AND g.meter = 'compute_std_seconds' AND g.period_start < s.current_period_end
                        AND g.period_end > s.current_period_start AND g.period_start <= ${at}::timestamptz
                        AND g.period_end > ${at}::timestamptz), 0) > 0
                AND NOT EXISTS (SELECT 1 FROM public.ezil_billing_payment_issues issue
                    WHERE issue.user_id = s.user_id AND issue.subscription_id = s.stripe_subscription_id
                        AND issue.invoice_kind = 'subscription' AND issue.resolved_at IS NULL AND issue.issue <> 'voided')
        )`;
}
/** Capacity-demand reauthorization: the owner's paid-pool eligibility right now (active v3 period, compute grant, no
 * open payment issue, live auth user) and the instance type their CURRENT plan/size selection resolves to — the same
 * predicate and mapping pool planning uses. null when not eligible. */
export async function readPaidPoolEligibility(db: PlacementExecutor, userId: string, now: Date): Promise<{ instanceType: string } | null> {
    const at = now.toISOString();
    const rows = rowsOf(await db.execute(sql`WITH ${eligibleCtes(at, userId)} SELECT instance_type FROM eligible`));
    if (rows.length > 1) throw new Error('pool_eligibility_ambiguous');
    return rows[0] ? { instanceType: String(rows[0].instance_type) } : null;
}

/**
 * Round 3 demand signal: an eligible subscriber of this class whose configuration switch to it
 * is in flight (the computer row's advisory `transition`, at most one unit per user, inside the
 * transition's own time budget) is one waiting open, so the next replenish pass warms the
 * class within the region cap. Only the larger classes: the base class always keeps a spare.
 */
function switchingDemand(c: PoolClass, at: string) {
    const size = c.instanceType === 'm6i.2xlarge' ? 'cmp-8' : c.instanceType === 'm6i.xlarge' ? 'cmp-4' : null;
    if (!size) return sql`0`;
    return sql`(SELECT count(DISTINCT c.user_id) FROM public.ezil_computers c JOIN subscribers s ON s.user_id = c.user_id
        WHERE c.deleted_at IS NULL AND jsonb_typeof(c.metadata) = 'object' AND jsonb_typeof(c.metadata->'transition') = 'object'
            AND c.metadata->'transition'->>'kind' = 'switch' AND c.metadata->'transition'->>'target' = ${size}
            AND c.metadata->'transition'->>'phase' IN ('requested', 'stopping', 'waking')
            AND COALESCE(c.metadata->'transition'->>'requestedAt', '') > ${new Date(Date.parse(at) - SWITCH_DEMAND_WINDOW_MS).toISOString()})`;
}
/** A switch's whole budget (stop 200 s + grace 30 s + wake 600 s); older records are stale. */
export const SWITCH_DEMAND_WINDOW_MS = 830_000;

/** One snapshot: billing epochs measure recent demand, never subscription eligibility.
 * Paid subscribers use their stored size selection and sticky placement zone; new users default to Mumbai.
 * Hosts linked to a live placement count only once in regional capacity, including during adoption.
 */
export async function readPoolDemand(db: PlacementExecutor, c: PoolClass, now: Date): Promise<PoolDemand> {
    checkClass(c);
    const at = now.toISOString();
    const vcpu = (column: ReturnType<typeof sql>) => sql`CASE ${column} ${sql.join(Object.entries(INSTANCE_VCPU)
        .map(([type, n]) => sql`WHEN ${type} THEN ${n}::int`), sql` `)} ELSE 8 END`;
    const running = sql.join(RUNNING_CLASS_STATES.map(state => sql`${state}`), sql`, `);
    const row = rowsOf(await db.execute(sql`
        WITH ${eligibleCtes(at)}, subscribers AS (
            SELECT s.* FROM eligible s WHERE s.instance_type = ${c.instanceType}
                AND (EXISTS (SELECT 1 FROM public.ezil_computer_placements p WHERE p.owner_user_id = s.user_id
                    AND p.provider = 'aws-ec2' AND p.region = ${c.region} AND p.zone_id = ${c.zoneId}
                    AND p.state NOT IN ('RETIRED', 'PURGE_ELIGIBLE'))
                OR (${c.region} = 'ap-south-1' AND NOT EXISTS (SELECT 1 FROM public.ezil_computer_placements p
                    WHERE p.owner_user_id = s.user_id AND p.provider = 'aws-ec2' AND p.state NOT IN ('RETIRED', 'PURGE_ELIGIBLE'))))
        ), class_placements AS (
            SELECT * FROM public.ezil_computer_placements
            WHERE provider = 'aws-ec2' AND region = ${c.region} AND zone_id = ${c.zoneId} AND instance_type = ${c.instanceType}
                AND state NOT IN ('RETIRED', 'PURGE_ELIGIBLE')
        ), all_class_hosts AS (
            SELECT *, COALESCE((${compatibleDeployment(c)}), false) AS compatible FROM public.ezil_compute_pool_hosts
            WHERE region = ${c.region} AND zone_id = ${c.zoneId} AND instance_type = ${c.instanceType}
        ), class_hosts AS (
            SELECT * FROM all_class_hosts WHERE compatible
        ), live_placements AS (
            SELECT * FROM public.ezil_computer_placements
            WHERE provider = 'aws-ec2' AND (region = ${c.region} OR region IS NULL) AND state IN (${running})
        )
        SELECT
            (SELECT count(DISTINCT e.id) FROM public.ezil_billing_compute_epochs e
                JOIN public.ezil_billing_subscriptions s ON s.stripe_subscription_id = e.subscription_id AND s.user_id = e.user_id
                WHERE e.size = ${c.instanceType === 'm6i.2xlarge' ? 'cmp-8' : c.instanceType === 'm6i.xlarge' ? 'cmp-4' : 'std-2'} AND e.ready_at > ${at}::timestamptz - interval '15 minutes' AND e.ready_at <= ${at}::timestamptz
                    AND s.sku IN ('standard_monthly_v3', 'premium_monthly_v3')
                    AND EXISTS (SELECT 1 FROM public.ezil_computer_placements p WHERE p.computer_id = e.computer_id
                        AND p.owner_user_id = e.user_id AND p.provider = 'aws-ec2' AND p.region = ${c.region} AND p.zone_id = ${c.zoneId})) AS opens,
            (SELECT count(*) FROM subscribers WHERE sku = 'standard_monthly_v3') AS standard,
            (SELECT count(*) FROM subscribers WHERE sku = 'premium_monthly_v3') AS premium,
            (SELECT count(*) FROM class_placements p JOIN subscribers s ON s.user_id = p.owner_user_id
                WHERE p.state IN ('PROVISIONING', 'STARTING') AND p.instance_id IS NULL
                    AND p.lifecycle_job_id IS NULL) AS pending,
            ${switchingDemand(c, at)} AS switching,
            (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (ready_at - created_at)) / 60)
                FROM class_hosts WHERE ready_at > ${at}::timestamptz - interval '24 hours'
                    AND ready_at <= ${at}::timestamptz AND ready_at > created_at) AS boot_minutes,
            (SELECT count(*) FROM class_hosts WHERE (state = 'booting' AND NOT ${bootStalledSql(now)}) OR (${usableReady(at, sql`class_hosts.id`)})) AS spares,
            (SELECT count(*) FROM class_hosts WHERE ${usableReady(at, sql`class_hosts.id`)}) AS ready,
            COALESCE((SELECT sum(${vcpu(sql`instance_type`)}) FROM live_placements), 0)
                + COALESCE((SELECT sum(${vcpu(sql`h.instance_type`)}) FROM public.ezil_compute_pool_hosts h
                    WHERE h.region = ${c.region} AND h.state <> 'retired'
                        AND NOT EXISTS (SELECT 1 FROM live_placements p WHERE p.instance_id = h.instance_id
                            OR (p.computer_id = h.leased_computer_id AND p.instance_id IS NULL))), 0) AS vcpu,
            (SELECT COALESCE(json_agg(json_build_object('poolHostId', id, 'readyAt', ready_at, 'obsolete', NOT compatible, 'unusable', NOT COALESCE((${usableReady(at, sql`all_class_hosts.id`)}),false))), '[]')
                FROM all_class_hosts WHERE state = 'ready' AND leased_at IS NULL AND leased_computer_id IS NULL AND ready_at IS NOT NULL) AS idle_ready,
            (SELECT COALESCE(json_agg(json_build_object('poolHostId', id, 'createdAt', created_at, 'enrolledAt', enrolled_at)), '[]')
                FROM all_class_hosts WHERE state = 'booting' AND leased_computer_id IS NULL AND leased_at IS NULL
                    AND claim_generation IS NULL AND claim_lease_epoch IS NULL AND claim_fence IS NULL AND claim_volume_serial IS NULL) AS booting,
            COALESCE((SELECT sum(demand.vcpu) FROM public.ezil_compute_capacity_demands demand
                WHERE demand.region = ${c.region} AND demand.closed_at IS NULL AND demand.expires_at > ${at}::timestamptz), 0) AS demand_vcpu,
            (SELECT COALESCE(json_agg(target->>'poolHostId'), '[]') FROM public.ezil_compute_capacity_demands demand, jsonb_array_elements(demand.cleanup) target
                WHERE demand.region = ${c.region} AND demand.closed_at IS NULL) AS earmarked
    `))[0];
    if (!row) throw new Error('pool_demand_missing');
    const regions = readAwsRegions(process.env);
    const regionVcpuCap = regions.ok ? (regions.regions.find(r => r.name === c.region)?.maxRunning ?? 0) * 2 : 0;
    return {
        pending: count(row.pending ?? 0) + count(row.switching ?? 0), opens15m: count(row.opens), activeStandard: count(row.standard), activePremium: count(row.premium),
        bootMinutes: row.boot_minutes == null ? null : Number(row.boot_minutes), spares: count(row.spares), ready: count(row.ready ?? 0),
        vcpuInUse: count(row.vcpu), regionVcpuCap, killSwitch: process.env.EZIL_AWS_KILL_SWITCH === '1',
        demandVcpu: count(row.demand_vcpu ?? 0), earmarked: ((row.earmarked ?? []) as unknown[]).map(String),
        idleReady: (row.idle_ready as { poolHostId: string; readyAt: string; obsolete?: boolean; unusable?: boolean }[]).map(h => ({ poolHostId:h.poolHostId, readyAt: new Date(h.readyAt), ...(h.obsolete ? {obsolete:true} : {}), ...(h.unusable ? {unusable:true} : {}) })),
        booting: (row.booting as { poolHostId: string; createdAt: string; enrolledAt?: string | null }[]).map(h => ({ poolHostId: h.poolHostId,
            createdAt: new Date(h.createdAt), ...(h.enrolledAt ? { enrolledAt: new Date(h.enrolledAt) } : {}) })),
    };
}

export { host as poolHostFromRow };

/** Read-only early warning. Host age is measured from creation, as in the unchanged ten-minute failure rule. */
export async function readPoolReadinessDiagnostics(db: PlacementExecutor, c: PoolClass, now: Date): Promise<PoolReadinessDiagnostic[]> {
    checkClass(c);
    return rowsOf(await db.execute(sql`
        SELECT id, instance_id, created_at, enrolled_at, health FROM public.ezil_compute_pool_hosts
        WHERE region = ${c.region} AND zone_id = ${c.zoneId} AND instance_type = ${c.instanceType}
            AND state = 'booting' AND ready_at IS NULL
            AND created_at < ${now.toISOString()}::timestamptz - interval '5 minutes'
        ORDER BY created_at, id
    `)).map(row => ({ poolHostId: String(row.id), instanceId: nullableString(row.instance_id),
        createdAt: date(row.created_at)!.toISOString(), enrolledAt: date(row.enrolled_at)?.toISOString() ?? null,
        health: String(row.health) }));
}

/** A refused adopt still consumes the host. Never retire a published tenant claim. */
export async function retireRefusedPoolLease(db: PlacementExecutor, poolHostId: string,
    p: { computerId: string; instanceId: string | null }): Promise<void> {
    const changed = rowsOf(await db.execute(sql`/* pool:refused-adopt */
        UPDATE public.ezil_compute_pool_hosts SET state = 'retiring', leased_computer_id = NULL, updated_at = now()
        WHERE id = ${poolHostId}::uuid AND instance_id = ${p.instanceId}
            AND leased_computer_id = ${p.computerId}::uuid AND state = 'leased'
            AND claim_generation IS NULL AND claim_lease_epoch IS NULL
            AND claim_fence IS NULL AND claim_volume_serial IS NULL
        RETURNING id`));
    if (changed.length !== 1) throw new Error('pool_refusal_conflict');
}

/** A confirmed release burns the single-use host; cold fallback has no matching pool row. */
export async function retirePoolLease(db: PlacementExecutor, p: { computerId: string; instanceId: string | null; generation: number; leaseEpoch: number }): Promise<void> {
    await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET state = 'retired', updated_at = now()
        WHERE state IN ('leased', 'retiring') AND instance_id = ${p.instanceId} AND leased_computer_id = ${p.computerId}::uuid
            AND claim_generation = ${p.generation} AND claim_lease_epoch = ${p.leaseEpoch}`);
}

/** leased_at is the immutable claim time; enrollment and repeated receipt polls cannot extend it. */
export async function isStalledPoolLease(db: PlacementExecutor, poolHostId: string, p: Placement,
    now: Date, stallMs: number, lock = false): Promise<boolean> {
    return rowsOf(await db.execute(sql`SELECT id FROM public.ezil_compute_pool_hosts
        WHERE id = ${poolHostId}::uuid AND state = 'leased' AND instance_id = ${p.instanceId}
            AND leased_computer_id = ${p.computerId}::uuid AND region = ${p.region} AND zone_id = ${p.zoneId}
            AND instance_type = ${p.instanceType} AND generation = leased_generation AND lease_token IS NOT NULL
            AND claim_generation = ${p.generation} AND claim_lease_epoch = ${p.leaseEpoch}
            AND claim_fence = ${p.fenceToken} AND claim_volume_serial = ${p.volumeId!.replace('-', '')}
            AND session_ready_at IS NULL AND leased_at <= ${new Date(now.getTime() - stallMs).toISOString()}::timestamptz
        ${lock ? sql`FOR UPDATE` : sql``}`)).length === 1;
}

/** Keep the tenant binding while release runs: spare pool-retire must never take this attached host. */
export async function hasFailedPoolLease(db: PlacementExecutor, p: Placement, state: 'retiring' | 'retired'): Promise<boolean> {
    return rowsOf(await db.execute(sql`SELECT id FROM public.ezil_compute_pool_hosts
        WHERE state = ${state} AND instance_id = ${p.instanceId} AND leased_computer_id = ${p.computerId}::uuid
            AND claim_generation = ${p.generation} AND claim_lease_epoch = ${p.leaseEpoch}
            AND claim_fence = ${p.fenceToken} AND claim_volume_serial = ${p.volumeId?.replace('-', '') ?? null}
            AND session_ready_at IS NULL`)).length === 1;
}

/** Durable tenant readiness belongs to the claimed epoch, independently of placement updated_at. */
export async function recordPoolSessionReady(db: PlacementExecutor, poolHostId: string,
    p: { computerId: string; instanceId: string | null; generation: number; leaseEpoch: number }, at: Date): Promise<boolean> {
    return rowsOf(await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET session_ready_at = ${at.toISOString()}::timestamptz
        WHERE id = ${poolHostId}::uuid AND state = 'leased' AND instance_id = ${p.instanceId}
            AND leased_computer_id = ${p.computerId}::uuid AND claim_generation = ${p.generation}
            AND claim_lease_epoch = ${p.leaseEpoch} AND session_ready_at IS NULL RETURNING id`)).length === 1;
}
export async function readPoolSessionReadyAt(db: PlacementExecutor, poolHostId: string,
    p: { computerId: string; instanceId: string | null; generation: number; leaseEpoch: number }): Promise<Date | null> {
    const found = rowsOf(await db.execute(sql`SELECT session_ready_at FROM public.ezil_compute_pool_hosts
        WHERE id = ${poolHostId}::uuid AND state = 'leased' AND instance_id = ${p.instanceId}
            AND leased_computer_id = ${p.computerId}::uuid AND claim_generation = ${p.generation} AND claim_lease_epoch = ${p.leaseEpoch}`));
    const at = found.length === 1 ? date(found[0]!.session_ready_at) : null;
    return at && Number.isFinite(at.getTime()) ? at : null;
}

/** Only the host claim observer uses this: ordinary claim reads remain published-only. */
export async function readPendingPoolAdopt(db: PlacementExecutor, poolHostId: string, instanceId: string): Promise<PoolHostRow | null> {
    return optionalHost(await db.execute(sql`
        SELECT * FROM public.ezil_compute_pool_hosts
        WHERE id = ${poolHostId}::uuid AND instance_id = ${instanceId} AND state = 'leased'
            AND leased_computer_id IS NOT NULL AND claim_generation IS NULL AND claim_lease_epoch IS NULL
            AND claim_fence IS NULL AND claim_volume_serial IS NULL
    `));
}

/** Round 3 progress: the durable warm-open times of THIS lease epoch's pool host for `computerId`, or null (a cold open). */
export async function readPoolOpening(db: PlacementExecutor, p: { computerId: string; leaseEpoch: number }, now: Date):
    Promise<{ leasedAt: Date | null; claimPublishedAt: Date | null; sessionReadyAt: Date | null } | null> {
    const row = rowsOf(await db.execute(sql`/* pool:opening */ SELECT leased_at,
            CASE WHEN claim_generation IS NOT NULL THEN updated_at END AS claim_published_at, session_ready_at
        FROM public.ezil_compute_pool_hosts
        WHERE leased_computer_id = ${p.computerId}::uuid AND state = 'leased' AND leased_at IS NOT NULL
            AND (claim_lease_epoch IS NULL OR claim_lease_epoch = ${p.leaseEpoch})
            AND leased_at > ${now.toISOString()}::timestamptz - interval '1 hour'
        ORDER BY leased_at DESC, id LIMIT 1`))[0];
    return row ? { leasedAt: date(row.leased_at), claimPublishedAt: date(row.claim_published_at), sessionReadyAt: date(row.session_ready_at) } : null;
}

/** Median measured warm open (pool `leased_at` → tenant `session_ready_at`) over the class's last `limit` adoptions, in seconds. */
export async function readWarmOpenSeconds(db: PlacementExecutor, c: { region: string; instanceType: string }, limit = 20): Promise<number | null> {
    const row = rowsOf(await db.execute(sql`/* pool:warm-median */ SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS median
        FROM (SELECT extract(epoch FROM (session_ready_at - leased_at)) AS seconds FROM public.ezil_compute_pool_hosts
            WHERE region = ${c.region} AND instance_type = ${c.instanceType} AND leased_at IS NOT NULL
                AND session_ready_at IS NOT NULL AND session_ready_at > leased_at
            ORDER BY session_ready_at DESC, id LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}) recent`))[0];
    const median = row?.median == null ? null : Number(row.median);
    return median !== null && Number.isFinite(median) && median > 0 ? median : null;
}

/** An active capacity demand holds this computer's open: the wake waits for room (never shown as "stopped"). */
export async function hasActiveCapacityDemand(db: PlacementExecutor, computerId: string, now: Date): Promise<boolean> {
    return rowsOf(await db.execute(sql`/* pool:demand-active */ SELECT 1 AS active FROM public.ezil_compute_capacity_demands
        WHERE computer_id = ${computerId}::uuid AND closed_at IS NULL AND expires_at > ${now.toISOString()}::timestamptz LIMIT 1`)).length === 1;
}

/** Read-only twin of placement.ts `lockReclaimablePoolHosts` (same predicate, no lock): idle pool vCPU a capacity demand could reclaim. */
export async function readReclaimablePoolVcpu(db: PlacementExecutor, region: string): Promise<number> {
    const vcpu = sql.join(Object.entries(INSTANCE_VCPU).map(([type, n]) => sql`WHEN ${type} THEN ${n}::int`), sql` `);
    const row = rowsOf(await db.execute(sql`/* pool:reclaimable */ SELECT COALESCE(sum(CASE h.instance_type ${vcpu} ELSE 8 END), 0) AS vcpu
        FROM public.ezil_compute_pool_hosts h
        WHERE h.region = ${region} AND h.state IN ('ready', 'booting')
            AND h.leased_computer_id IS NULL AND h.leased_at IS NULL AND h.leased_generation IS NULL AND h.lease_token IS NULL
            AND h.claim_generation IS NULL AND h.claim_lease_epoch IS NULL AND h.claim_fence IS NULL AND h.claim_volume_serial IS NULL
            AND NOT EXISTS (SELECT 1 FROM public.ezil_computer_placements p WHERE p.provider = 'aws-ec2'
                AND p.state NOT IN ('RETIRED', 'PURGE_ELIGIBLE') AND h.instance_id IS NOT NULL AND p.instance_id = h.instance_id)
            AND NOT EXISTS (SELECT 1 FROM public.ezil_compute_capacity_demands d, jsonb_array_elements(d.cleanup) t
                WHERE d.closed_at IS NULL AND t->>'poolHostId' = h.id::text)`))[0];
    return count(row?.vcpu ?? 0);
}
