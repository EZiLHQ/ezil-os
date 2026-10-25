/**
 * Durable capacity demand (app/drizzle/0009_capacity_demands.sql).
 *
 * An authenticated AWS open whose admission is refused ONLY because reclaimable idle pool
 * liability (unleased, unclaimed spares) occupies the regional vCPU budget reserves its
 * capacity here instead of failing. No placement, lifecycle job, enrollment nonce or usage
 * row exists while it waits. Every write runs under the global admission lock, in the order
 * admission -> computer -> demand -> pool rows. Expiry is a fixed DB-clock deadline that
 * polling never renews; it is closed explicitly under the lock.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { assertHeldAdmissionLock, type AdmissionLock, type PlacementExecutor } from './placement';

export const DEMAND_TTL_SECONDS = 300;
/** The complete validated deployment a demand is bound to (sorted-key canonical JSON, storage normalized exactly as
 * pool work normalizes it), so a changed launch template, security group, AMI, version or any other field never matches. */
export function demandDeploymentDigest(d: object & { storage?: object }): string {
    const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
    const normalized = { ...d, storage: { rootDeviceName: '/dev/sda1', ...(d.storage ?? {}) } };
    return createHash('sha256').update(JSON.stringify(canonical(normalized))).digest('hex');
}
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
/** A spare this demand needs gone. `retiring`: normal retirement work bound (jobId). `booting`: earmarked only, its
 * provision job and full liability retained until provision settles; it is then retired normally. */
export const CleanupTargetSchema = z.object({ poolHostId: Uuid, poolGeneration: z.number().int().positive(),
    instanceType: z.string().min(1).max(32), vcpu: z.number().int().positive().max(64),
    phase: z.enum(['retiring', 'booting']), jobId: Uuid.nullable() }).strict();
export type CleanupTarget = z.infer<typeof CleanupTargetSchema>;
const Row = z.object({ id: Uuid, request_id: Uuid, owner_user_id: Uuid, computer_id: Uuid, kind: z.enum(['create', 'wake']),
    region: z.string().min(1), zone_id: z.string().min(1), instance_type: z.string().min(1), vcpu: z.coerce.number().int().positive(),
    deployment_digest: z.string().regex(/^[0-9a-f]{64}$/), source_generation: z.coerce.number().int().positive().nullable(),
    source_lease_epoch: z.coerce.number().int().positive().nullable(), state: z.enum(['active', 'consumed', 'cancelled', 'expired']),
    revision: z.coerce.number().int().positive(), cleanup: z.array(CleanupTargetSchema).max(8),
    created_at: z.coerce.date(), expires_at: z.coerce.date(), closed_at: z.coerce.date().nullable() });
export interface CapacityDemand {
    id: string; requestId: string; ownerUserId: string; computerId: string; kind: 'create' | 'wake';
    region: string; zoneId: string; instanceType: string; vcpu: number; deploymentDigest: string;
    sourceGeneration: number | null; sourceLeaseEpoch: number | null;
    state: 'active' | 'consumed' | 'cancelled' | 'expired'; revision: number; cleanup: CleanupTarget[];
    createdAt: Date; expiresAt: Date; closedAt: Date | null;
}
function rowsOf(result: unknown): Record<string, unknown>[] {
    const rows = Array.isArray(result) ? result : (result as { rows?: unknown } | null)?.rows;
    if (!Array.isArray(rows)) throw new Error('demand_result_invalid');
    return rows as Record<string, unknown>[];
}
function parse(raw: Record<string, unknown>): CapacityDemand {
    const r = Row.parse({ ...raw, cleanup: typeof raw.cleanup === 'string' ? JSON.parse(raw.cleanup) : raw.cleanup });
    if ((r.state === 'active') !== (r.closed_at === null) || (r.kind === 'create') !== (r.source_generation === null && r.source_lease_epoch === null)
        || !(r.expires_at > r.created_at)) throw new Error('demand_row_invalid');
    return { id: r.id, requestId: r.request_id, ownerUserId: r.owner_user_id, computerId: r.computer_id, kind: r.kind, region: r.region,
        zoneId: r.zone_id, instanceType: r.instance_type, vcpu: r.vcpu, deploymentDigest: r.deployment_digest,
        sourceGeneration: r.source_generation, sourceLeaseEpoch: r.source_lease_epoch, state: r.state, revision: r.revision,
        cleanup: r.cleanup, createdAt: r.created_at, expiresAt: r.expires_at, closedAt: r.closed_at };
}

/** Close every active demand whose fixed deadline passed (DB clock). Committed retirements continue. */
export async function closeExpiredDemands(tx: PlacementExecutor, lock: AdmissionLock): Promise<number> {
    assertHeldAdmissionLock(tx, lock);
    return rowsOf(await tx.execute(sql`/* demand:expire */ UPDATE public.ezil_compute_capacity_demands
        SET state = 'expired', closed_at = now(), revision = revision + 1
        WHERE closed_at IS NULL AND expires_at <= now() RETURNING id`)).length;
}
/** Cancel active demands whose computer no longer exists, was deleted, or changed hands. */
export async function closeOrphanedDemands(tx: PlacementExecutor, lock: AdmissionLock): Promise<number> {
    assertHeldAdmissionLock(tx, lock);
    return rowsOf(await tx.execute(sql`/* demand:orphan */ UPDATE public.ezil_compute_capacity_demands d
        SET state = 'cancelled', closed_at = now(), revision = revision + 1
        WHERE d.closed_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.ezil_computers c
            WHERE c.id = d.computer_id AND c.user_id = d.owner_user_id AND c.deleted_at IS NULL) RETURNING d.id`)).length;
}
/** The active demands of a region, row-locked in stable id order (at most one by index). */
export async function lockRegionDemands(tx: PlacementExecutor, lock: AdmissionLock, region: string): Promise<CapacityDemand[]> {
    assertHeldAdmissionLock(tx, lock);
    return rowsOf(await tx.execute(sql`/* demand:region */ SELECT * FROM public.ezil_compute_capacity_demands
        WHERE region = ${region} AND closed_at IS NULL ORDER BY id FOR UPDATE`)).map(parse);
}
/** The computer's active demand, if any (the caller already holds the computer lock). */
export async function lockComputerDemand(tx: PlacementExecutor, lock: AdmissionLock, computerId: string): Promise<CapacityDemand | null> {
    assertHeldAdmissionLock(tx, lock);
    const rows = rowsOf(await tx.execute(sql`/* demand:computer */ SELECT * FROM public.ezil_compute_capacity_demands
        WHERE computer_id = ${computerId}::uuid AND closed_at IS NULL ORDER BY id FOR UPDATE`)).map(parse);
    if (rows.length > 1) throw new Error('demand_duplicate_active');
    return rows[0] ?? null;
}
/** The computer's active demand with its DB-clock liveness, for consumption (the caller holds admission + computer locks). */
export async function lockComputerDemandLive(tx: PlacementExecutor, lock: AdmissionLock, computerId: string): Promise<{ demand: CapacityDemand; live: boolean } | null> {
    assertHeldAdmissionLock(tx, lock);
    const rows = rowsOf(await tx.execute(sql`/* demand:computerlive */ SELECT *, (expires_at > now()) AS live FROM public.ezil_compute_capacity_demands
        WHERE computer_id = ${computerId}::uuid AND closed_at IS NULL ORDER BY id FOR UPDATE`));
    if (rows.length > 1) throw new Error('demand_duplicate_active');
    if (!rows[0]) return null;
    const { live, ...raw } = rows[0];
    return { demand: parse(raw), live: live === true };
}
/** A stable open attempt (computer + kind + source snapshot) whose reservation EXPIRED stays terminal: polling the same
 * attempt can never restart the fixed deadline, however much time passes. Only an explicit authenticated owner
 * cancellation (stop) after that expiry — recorded as a later closed 'cancelled' marker — begins a fresh attempt. */
export async function terminalExpiredAttempt(tx: PlacementExecutor, lock: AdmissionLock, key: {
    computerId: string; kind: 'create' | 'wake'; sourceGeneration: number | null; sourceLeaseEpoch: number | null }): Promise<boolean> {
    assertHeldAdmissionLock(tx, lock);
    return rowsOf(await tx.execute(sql`/* demand:terminal */ SELECT d.id FROM public.ezil_compute_capacity_demands d
        WHERE d.computer_id = ${key.computerId}::uuid AND d.kind = ${key.kind}
            AND d.source_generation IS NOT DISTINCT FROM ${key.sourceGeneration}::integer
            AND d.source_lease_epoch IS NOT DISTINCT FROM ${key.sourceLeaseEpoch}::integer AND d.state = 'expired'
            AND NOT EXISTS (SELECT 1 FROM public.ezil_compute_capacity_demands c WHERE c.computer_id = d.computer_id
                AND c.state = 'cancelled' AND c.closed_at >= d.closed_at)
        LIMIT 1`)).length > 0;
}
/** The owner's explicit cancellation of an expired attempt: a closed 'cancelled' marker row (the expired record is kept). */
export async function cancelExpiredAttempt(tx: PlacementExecutor, lock: AdmissionLock, computerId: string, ownerUserId: string): Promise<boolean> {
    assertHeldAdmissionLock(tx, lock);
    return rowsOf(await tx.execute(sql`/* demand:cancelexpired */ INSERT INTO public.ezil_compute_capacity_demands
        (request_id, owner_user_id, computer_id, kind, region, zone_id, instance_type, vcpu, deployment_digest,
         source_generation, source_lease_epoch, state, cleanup, created_at, expires_at, closed_at)
        SELECT gen_random_uuid(), d.owner_user_id, d.computer_id, d.kind, d.region, d.zone_id, d.instance_type, d.vcpu, d.deployment_digest,
            d.source_generation, d.source_lease_epoch, 'cancelled', '[]'::jsonb, now(), now() + interval '1 second', now()
        FROM public.ezil_compute_capacity_demands d
        WHERE d.computer_id = ${computerId}::uuid AND d.owner_user_id = ${ownerUserId}::uuid AND d.state = 'expired'
            AND NOT EXISTS (SELECT 1 FROM public.ezil_compute_capacity_demands c WHERE c.computer_id = d.computer_id
                AND c.state = 'cancelled' AND c.closed_at >= d.closed_at)
        ORDER BY d.closed_at DESC LIMIT 1 RETURNING id`)).length === 1;
}
/** Routing only: this owner's computer holds an unclosed AWS demand (whatever its deadline: a passed but not yet swept demand
 * still holds) or a terminal expired attempt not yet released by a stop. Either keeps the computer on the AWS path, so its open
 * is answered by AWS and its stop can release the attempt. Capacity credit keeps its own live-deadline rule. */
export async function hasDemandHoldForRouting(db: PlacementExecutor, computerId: string, ownerUserId: string): Promise<boolean> {
    return rowsOf(await db.execute(sql`/* demand:hold */ SELECT d.id FROM public.ezil_compute_capacity_demands d
        WHERE d.computer_id = ${computerId}::uuid AND d.owner_user_id = ${ownerUserId}::uuid
            AND (d.closed_at IS NULL
                OR (d.state = 'expired' AND NOT EXISTS (SELECT 1 FROM public.ezil_compute_capacity_demands c
                    WHERE c.computer_id = d.computer_id AND c.state = 'cancelled' AND c.closed_at >= d.closed_at)))
        LIMIT 1`)).length > 0;
}
/** Unlocked read for routing/status only: never renews, launches or decides capacity. */
export async function readActiveDemandForComputer(db: PlacementExecutor, computerId: string): Promise<CapacityDemand | null> {
    const rows = rowsOf(await db.execute(sql`/* demand:peek */ SELECT * FROM public.ezil_compute_capacity_demands
        WHERE computer_id = ${computerId}::uuid AND closed_at IS NULL AND expires_at > now() ORDER BY id LIMIT 2`)).map(parse);
    if (rows.length > 1) throw new Error('demand_duplicate_active');
    return rows[0] ?? null;
}

export interface NewDemand {
    requestId: string; ownerUserId: string; computerId: string; kind: 'create' | 'wake'; region: string; zoneId: string;
    instanceType: string; vcpu: number; deploymentDigest: string; sourceGeneration: number | null; sourceLeaseEpoch: number | null;
    cleanup: CleanupTarget[];
}
export async function insertDemand(tx: PlacementExecutor, lock: AdmissionLock, d: NewDemand): Promise<CapacityDemand> {
    assertHeldAdmissionLock(tx, lock);
    const cleanup = z.array(CleanupTargetSchema).max(8).parse(d.cleanup);
    const rows = rowsOf(await tx.execute(sql`/* demand:insert */ INSERT INTO public.ezil_compute_capacity_demands
        (request_id, owner_user_id, computer_id, kind, region, zone_id, instance_type, vcpu, deployment_digest,
         source_generation, source_lease_epoch, state, cleanup, created_at, expires_at)
        VALUES (${d.requestId}::uuid, ${d.ownerUserId}::uuid, ${d.computerId}::uuid, ${d.kind}, ${d.region}, ${d.zoneId}, ${d.instanceType},
            ${d.vcpu}, ${d.deploymentDigest}, ${d.sourceGeneration}, ${d.sourceLeaseEpoch}, 'active', ${JSON.stringify(cleanup)}::jsonb,
            now(), now() + make_interval(secs => ${DEMAND_TTL_SECONDS}))
        RETURNING *`));
    if (rows.length !== 1) throw new Error('demand_insert_conflict');
    return parse(rows[0]!);
}
/** Revision CAS: an active demand is closed exactly once. */
export async function closeDemand(tx: PlacementExecutor, lock: AdmissionLock, d: CapacityDemand, state: 'consumed' | 'cancelled'): Promise<boolean> {
    assertHeldAdmissionLock(tx, lock);
    return rowsOf(await tx.execute(sql`/* demand:close */ UPDATE public.ezil_compute_capacity_demands
        SET state = ${state}, closed_at = now(), revision = revision + 1
        WHERE id = ${d.id}::uuid AND revision = ${d.revision} AND closed_at IS NULL RETURNING id`)).length === 1;
}
/** Revision CAS on the cleanup list (an earmarked booting host whose retirement is now bound). */
export async function updateDemandCleanup(tx: PlacementExecutor, lock: AdmissionLock, d: CapacityDemand, cleanup: CleanupTarget[]): Promise<CapacityDemand | null> {
    assertHeldAdmissionLock(tx, lock);
    const parsed = z.array(CleanupTargetSchema).max(8).parse(cleanup);
    const rows = rowsOf(await tx.execute(sql`/* demand:cleanup */ UPDATE public.ezil_compute_capacity_demands
        SET cleanup = ${JSON.stringify(parsed)}::jsonb, revision = revision + 1
        WHERE id = ${d.id}::uuid AND revision = ${d.revision} AND closed_at IS NULL RETURNING *`));
    return rows[0] ? parse(rows[0]) : null;
}
