/**
 * Reserve durable capacity demand after admission refused an open ONLY for capacity
 * (PoolCapacityPressure). Under the admission lock, in the order admission -> computer ->
 * demand -> pool rows: revalidate ownership and the source snapshot, then reserve the
 * smallest sufficient set of reclaimable idle pool capacity of any shape. Ready targets
 * get normal pool-retire work (dispatched after commit); booting targets are earmarked and
 * keep their provision job and full liability until provision settles. Nothing launches
 * here: the open's own retry admits once recomputed U + H + Q fits (validateCapacity).
 */
import { instanceVcpu, readAwsRegions, type Env } from './aws-config';
import { readLifecycleDeployments, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { sharedAwsSdkCollaborators } from './aws-clients';
import type { LifecycleStarter } from './aws-ec2';
import { createPoolDispatchStore } from './aws-pool-dispatch';
import { poolWork, type PoolDispatchStore } from './aws-pool-replenish';
import { startLifecycleJob } from './aws-receipts';
import { cancelExpiredAttempt, closeDemand, closeExpiredDemands, demandDeploymentDigest, insertDemand, lockComputerDemand, lockRegionDemands,
    terminalExpiredAttempt, type CleanupTarget } from './capacity-demand';
import { decideAdmission } from './admission';
import { readAwsAdmissionConfig } from './aws-config';
import { createProviderMigrationStore } from './provider-migrate-store';
import { utcMonthStart } from './usage';
import { assertNoImageReservation, lockComputerUnderAdmission, lockReclaimablePoolHosts, readAdmissionCounters, readCanaryComputer, readPlacement, readPoolMigrationReservations, withAdmission,
    type PlacementDb } from './placement';
import * as poolModule from './ready-pool';

export interface DemandRequest {
    kind: 'create' | 'wake'; userId: string; computerId: string; requestId: string;
    region: string; zoneId: string; instanceType: string; deploymentDigest: string;
    /** wake: the exact STOPPED placement generation/epoch the open read; create: null (no placement). */
    source: { generation: number; leaseEpoch: number } | null;
}
/** waiting: demand reserved (or already reserved for this exact target); retry: capacity fits now;
 * refused: no reclaimable capacity, another demand holds the region, or the snapshot changed. */
export type DemandOutcome = 'waiting' | 'retry' | 'refused';
export interface PoolDemandDeps {
    db: PlacementDb; store: PoolDispatchStore; starter?: LifecycleStarter; env: Env;
    deployments: Record<string, LifecycleDeployment>; now(): Date; killSwitch(): boolean; sleep?: (ms: number) => Promise<void>;
}
interface Candidate { id: string; generation: number; instanceType: string; vcpu: number; state: 'ready' | 'booting' }

/** Smallest sufficient reclaim, any shape: one host when one suffices (ready preferred, then smallest),
 * otherwise largest-first accumulation, ready before booting. At most 8 targets. */
export function pickReclaim(candidates: Candidate[], need: number): Candidate[] | null {
    if (need <= 0) return [];
    const rank = (c: Candidate) => c.state === 'ready' ? 0 : 1;
    const single = candidates.filter(c => c.vcpu >= need).sort((a, b) => rank(a) - rank(b) || a.vcpu - b.vcpu || a.id.localeCompare(b.id))[0];
    if (single) return [single];
    const picked: Candidate[] = []; let sum = 0;
    for (const c of [...candidates].sort((a, b) => rank(a) - rank(b) || b.vcpu - a.vcpu || a.id.localeCompare(b.id))) {
        if (sum >= need || picked.length === 8) break;
        picked.push(c); sum += c.vcpu;
    }
    return sum >= need ? picked : null;
}

export async function reservePoolDemand(deps: PoolDemandDeps, r: DemandRequest): Promise<DemandOutcome> {
    const deployment = deps.deployments[r.region];
    // The digest is derived from the validated configured deployment, never trusted from the caller.
    if (!deployment || deployment.zoneId !== r.zoneId || !poolModule.POOL_TYPES.includes(r.instanceType as poolModule.PoolClass['instanceType'])
        || demandDeploymentDigest(deployment) !== r.deploymentDigest) return 'refused';
    const prepared = await withAdmission(deps.db, async (tx, lock): Promise<{ outcome: DemandOutcome; works: LifecycleWork[] }> => {
        const none = (outcome: DemandOutcome) => ({ outcome, works: [] });
        await lockComputerUnderAdmission(tx, lock, r.computerId);
        const computer = await readCanaryComputer(tx, r.computerId);
        if (!computer || computer.deleted || computer.userId !== r.userId.toLowerCase()) return none('refused');
        // Image reservations exclude ordinary admission (readPlacement also fails closed on them): refuse, never error.
        try { await assertNoImageReservation(tx, r.computerId); } catch { return none('refused'); }
        const p = (await readPlacement(tx, r.computerId)).record;
        if (r.kind === 'create' ? p !== null || r.source !== null
            : !p || !r.source || p.provider !== 'aws-ec2' || p.ownerUserId !== r.userId.toLowerCase() || p.state !== 'STOPPED'
                || p.region !== r.region || p.generation !== r.source.generation || p.leaseEpoch !== r.source.leaseEpoch) return none('refused');
        // Full admission reauthorization under this lock, exactly as the open itself would be decided: image and provider
        // migration exclusions, current paid-pool eligibility, monthly caps, kill switch, one AWS computer per owner and
        // placement/demand capacity. Only pool liability may be what stands in the way.
        const migration = await createProviderMigrationStore(tx).readByComputer(r.computerId);
        if (migration && !['committed', 'failed_reopened', 'failed_needs_operator'].includes(migration.state)) return none('refused');
        const now = deps.now();
        // The CURRENT plan/size selection must still resolve to the requested type (a size changed between transactions refuses).
        const eligible = await poolModule.readPaidPoolEligibility(tx, r.userId, now);
        if (!eligible || eligible.instanceType !== r.instanceType) return none('refused');
        const counters = await readAdmissionCounters(tx, lock, { userId: r.userId, computerId: r.computerId, monthStart: utcMonthStart(now), now });
        const decision = decideAdmission({ config: readAwsAdmissionConfig(deps.env), counters, userId: r.userId, now,
            region: r.kind === 'create' ? { kind: 'create' } : { kind: 'lease', region: r.region }, instanceType: r.instanceType });
        if (!decision.admit || (decision.region !== undefined && decision.region !== r.region)) return none('refused');
        await closeExpiredDemands(tx, lock);
        const own = await lockComputerDemand(tx, lock, r.computerId);
        // An exact repeat reuses the reservation; a changed target never rewrites it.
        if (own) return none(own.kind === r.kind && own.region === r.region && own.instanceType === r.instanceType
            && own.deploymentDigest === r.deploymentDigest
            && own.sourceGeneration === (r.source?.generation ?? null) && own.sourceLeaseEpoch === (r.source?.leaseEpoch ?? null) ? 'waiting' : 'refused');
        if ((await lockRegionDemands(tx, lock, r.region)).length > 0) return none('refused');
        if (await terminalExpiredAttempt(tx, lock, { computerId: r.computerId, kind: r.kind,
            sourceGeneration: r.source?.generation ?? null, sourceLeaseEpoch: r.source?.leaseEpoch ?? null })) return none('refused');
        const c: poolModule.PoolClass = { region: r.region, zoneId: r.zoneId, instanceType: r.instanceType as poolModule.PoolClass['instanceType'] };
        const demand = await poolModule.readPoolDemand(tx, c, deps.now());
        const migrations = await readPoolMigrationReservations(tx);
        if (deps.killSwitch() || demand.killSwitch || !Number.isSafeInteger(migrations) || migrations < 0) return none('refused');
        const need = demand.vcpuInUse + migrations * 2 + instanceVcpu(r.instanceType) - demand.regionVcpuCap;
        if (need <= 0) return none('retry');
        const picked = pickReclaim((await lockReclaimablePoolHosts(tx, lock, r.region))
            .map(h => ({ ...h, vcpu: instanceVcpu(h.instanceType) })), need);
        if (!picked) return none('refused');
        const cleanup: CleanupTarget[] = [], works: LifecycleWork[] = [];
        for (const h of picked) {
            const cls: poolModule.PoolClass = { region: r.region, zoneId: deployment.zoneId, instanceType: h.instanceType as poolModule.PoolClass['instanceType'] };
            // Ready, or booting whose provision already settled with its instance identity (canRetire): retire now through
            // the normal guarded path. A booting host with pending/unknown provision is only earmarked.
            if (deps.store.canRetire ? await deps.store.canRetire(tx, h.id) : h.state === 'ready') {
                const host = await poolModule.markPoolHost(tx, h.id, [h.state], 'retiring', now);
                if (!host) throw new Error('demand_retire_conflict');
                const work = await deps.store.prepare(tx, cls, 'pool-retire', x => poolWork(cls, deployment, 'pool-retire', x), host);
                cleanup.push({ poolHostId: h.id, poolGeneration: h.generation, instanceType: h.instanceType, vcpu: h.vcpu, phase: 'retiring', jobId: work.intent.jobId });
                works.push(work);
            } else {
                cleanup.push({ poolHostId: h.id, poolGeneration: h.generation, instanceType: h.instanceType, vcpu: h.vcpu, phase: 'booting', jobId: null });
            }
        }
        await insertDemand(tx, lock, { requestId: r.requestId, ownerUserId: r.userId.toLowerCase(), computerId: r.computerId.toLowerCase(),
            kind: r.kind, region: r.region, zoneId: r.zoneId, instanceType: r.instanceType, vcpu: instanceVcpu(r.instanceType),
            deploymentDigest: r.deploymentDigest, sourceGeneration: r.source?.generation ?? null, sourceLeaseEpoch: r.source?.leaseEpoch ?? null, cleanup });
        return { outcome: 'waiting', works };
    });
    // Committed: dispatch the bound retirements outside any transaction (unknown outcomes reconcile later).
    for (const work of prepared.works) {
        if (!deps.starter) break;
        await deps.store.outcome(work, await startLifecycleJob(deps.starter, work.intent.deployment.region, work, deps.sleep));
    }
    return prepared.outcome;
}

/** Stop or close: the owner's own active demand is cancelled first (revision CAS). Committed retirements continue. */
export async function cancelComputerDemand(db: PlacementDb, computerId: string, ownerUserId: string): Promise<boolean> {
    return withAdmission(db, async (tx, lock) => {
        await lockComputerUnderAdmission(tx, lock, computerId);
        const own = await lockComputerDemand(tx, lock, computerId);
        if (own) return own.ownerUserId === ownerUserId.toLowerCase() && await closeDemand(tx, lock, own, 'cancelled');
        // No active demand: an explicit stop also releases a terminal expired attempt (the next open is a fresh attempt).
        return cancelExpiredAttempt(tx, lock, computerId, ownerUserId.toLowerCase());
    });
}

export function createPoolDemandDeps(db: PlacementDb, env: Env): PoolDemandDeps {
    const sdk = sharedAwsSdkCollaborators(env);
    const regions = readAwsRegions(env);
    const names = regions.ok ? regions.regions.map(x => x.name) : [];
    const configs = readLifecycleDeployments(env, names);
    return { db, env, store: createPoolDispatchStore(db, env, sdk), ...(sdk.starter ? { starter: sdk.starter } : {}),
        deployments: configs.ok ? configs.deployments : {}, now: () => new Date(), killSwitch: () => env.EZIL_AWS_KILL_SWITCH === '1' };
}
