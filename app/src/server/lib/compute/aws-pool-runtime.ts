import { observePoolAdopt } from './aws-pool-adopt';
import { sharedAwsSdkCollaborators } from './aws-clients';
import type { Env } from './aws-config';
import { isAwsComputersEnabled } from './aws-config';
import { buildLifecycleWork, readLifecycleDeployments } from './aws-intent';
import { lockPoolClaimPlacement, savePoolEnrollmentNonce, readPoolMigrationReservations, type Placement, type PlacementDb, type PlacementExecutor } from './placement';
import { instanceVcpu } from './aws-config';
import { admissionDryRun } from './admission';
import * as poolModule from './ready-pool';
import type { PoolClaimDeps } from './aws-pool-claim';
import { PoolCapacityPressure, poolGuard } from './aws-pool-errors';
import { closeDemand, lockComputerDemandLive } from './capacity-demand';
import { createPoolDemandDeps, reservePoolDemand } from './aws-pool-demand';
import { withPoolReplenishLock, type PoolDispatchStore, type PoolReplenishDeps } from './aws-pool-replenish';

import { createPoolDispatchStore } from './aws-pool-dispatch';
import { newPoolPassLogMemo, poolPassLine, runPoolReplenish, type PoolPassEntry } from './aws-pool-replenish';
import type { PoolDeps } from './aws-receipts';
/**
 * vCPU above the region cap, counted the ONE way pool opens and the round-3 switch preflight
 * both use: live placements plus every unretired pool host not bound to one (spares count),
 * other active demands, and two vCPU per migration reservation. `releaseVcpu` is a running
 * computer that stops before the boot; `addVcpu` is a boot not yet in `vcpuInUse`.
 */
export function poolVcpuExcess(input: { vcpuInUse: number; otherDemandVcpu: number; migrations: number; regionVcpuCap: number;
    releaseVcpu?: number; addVcpu?: number }): number {
    return input.vcpuInUse - (input.releaseVcpu ?? 0) + input.otherDemandVcpu + input.migrations * 2 + (input.addVcpu ?? 0) - input.regionVcpuCap;
}

export type SwitchCapacity = { ok: true; wait: boolean } | { ok: false; reason: string };

/**
 * Round 3 switch preflight (before any stop): can this RUNNING computer come back on
 * `targetType`? Admission's own rules first (`admissionDryRun`), then the pool count above:
 * a ready spare of the target class is already counted (adopting it adds nothing); otherwise
 * the target's vCPU is added and the computer's current vCPU released. Over the cap, only
 * reclaimable idle pool capacity may stand in the way (as `reservePoolDemand` decides):
 * enough of it is a capacity wait (`wait: true`), anything else refuses before the stop.
 */
export async function preflightSwitchCapacity(db: PlacementExecutor, p: Placement, targetType: string, env: Env, now: Date): Promise<SwitchCapacity> {
    const decision = await admissionDryRun(db, { userId: p.ownerUserId, placement: p, instanceType: targetType, env, now });
    if (!decision.admit) return { ok: false, reason: decision.reason };
    if (!p.region || !p.zoneId || !poolModule.POOL_TYPES.includes(targetType as poolModule.PoolClass['instanceType'])) return { ok: true, wait: false };
    const demand = await poolModule.readPoolDemand(db, { region: p.region, zoneId: p.zoneId, instanceType: targetType as poolModule.PoolClass['instanceType'] }, now);
    const migrations = await readPoolMigrationReservations(db);
    if (env.EZIL_AWS_KILL_SWITCH === '1' || demand.killSwitch || !Number.isSafeInteger(migrations) || migrations < 0) return { ok: false, reason: 'kill_switch' };
    const excess = poolVcpuExcess({ vcpuInUse: demand.vcpuInUse, otherDemandVcpu: demand.demandVcpu ?? 0, migrations, regionVcpuCap: demand.regionVcpuCap,
        releaseVcpu: instanceVcpu(p.instanceType), addVcpu: (demand.ready ?? 0) > 0 ? 0 : instanceVcpu(targetType) });
    if (excess <= 0) return { ok: true, wait: false };
    // Another demand holds the region, or too little idle pool capacity to reclaim: refuse now.
    if ((demand.demandVcpu ?? 0) > 0) return { ok: false, reason: 'region_capacity' };
    return await poolModule.readReclaimablePoolVcpu(db, p.region) >= excess ? { ok: true, wait: true } : { ok: false, reason: 'region_capacity' };
}

export function createPoolDeps(db: PlacementDb, env: Env): PoolDeps {
    return { readyAt: poolModule.readPoolSessionReadyAt, retireLease: poolModule.retirePoolLease, leasePoolHost: poolModule.leasePoolHost, publishPoolClaim: poolModule.publishPoolClaim, buildWork: buildLifecycleWork,
        async claimDemand(tx, p, lock, b) {
            const found = await lockComputerDemandLive(tx, lock, p.computerId);
            if (!found) return null;
            const d = found.demand;
            return found.live && d.ownerUserId === p.ownerUserId && d.computerId === p.computerId && d.instanceType === p.instanceType
                && d.region === p.region && d.zoneId === p.zoneId && d.deploymentDigest === b.deploymentDigest && d.kind === b.kind
                && d.sourceGeneration === (b.source?.generation ?? null) && d.sourceLeaseEpoch === (b.source?.leaseEpoch ?? null) ? d : null;
        },
        async validateCapacity(tx, p, lock, own) {
            const demand = await poolModule.readPoolDemand(tx, { region: p.region!, zoneId: p.zoneId!, instanceType: p.instanceType as poolModule.PoolClass['instanceType'] }, new Date());
            const migrations = await readPoolMigrationReservations(tx);
            poolGuard('open_pool_capacity', env.EZIL_AWS_KILL_SWITCH !== '1' && !demand.killSwitch
                && Number.isSafeInteger(migrations) && migrations >= 0, 503);
            // Reservation credit only for this open's own live, exactly bound demand (claimed before any pool lease).
            // Without a claim (legacy callers) there is no credit: every active demand counts as someone else's.
            const credit = own ? own.vcpu : 0;
            const others = Math.max(0, (demand.demandVcpu ?? 0) - credit);
            if (poolVcpuExcess({ vcpuInUse: demand.vcpuInUse, otherDemandVcpu: others, migrations, regionVcpuCap: demand.regionVcpuCap }) > 0)
                throw new PoolCapacityPressure({ computerId: p.computerId, region: p.region!, zoneId: p.zoneId!, instanceType: p.instanceType! });
            if (own) poolGuard('open_demand_consumed', await closeDemand(tx, lock, own, 'consumed'), 503);
        },
        async reserveDemand(request) { return reservePoolDemand(createPoolDemandDeps(db, env), request); },
        async replenish() { await runPoolReplenish(createPoolReplenishDeps(db, env)); } };
}
export function createPoolHostDeps(db: PlacementDb, env: Env): PoolClaimDeps {
    const sdk = sharedAwsSdkCollaborators(env);
    const deps: PoolClaimDeps = { db, data: poolModule, env, now: () => new Date(), describer: sdk.describer ?? null, executions: sdk.executions ?? null,
        lockPlacement: lockPoolClaimPlacement, saveNonce: savePoolEnrollmentNonce };
    deps.observeAdopt = (proof, identity, poll) => observePoolAdopt(deps, proof, identity, poll);
    return deps;
}

/** Process-wide (module-level) memo: every cron GET builds fresh deps, so the memo must outlive them (D4). */
const poolPassLogMemo = newPoolPassLogMemo();
function logPoolPass(entries: PoolPassEntry[], failed: boolean): void {
    const line = poolPassLine(entries, poolPassLogMemo, new Date(), { failed });
    if (line) console.info(line);
}

/** Production cron and post-lease replenishment share durable dispatch. */
export function createPoolReplenishDeps(db: PlacementDb, env: Env, store?: PoolDispatchStore): PoolReplenishDeps {
    poolGuard('cron_enabled', isAwsComputersEnabled(env), 503);
    const data = poolModule;
    const sdk = sharedAwsSdkCollaborators(env);
    poolGuard('cron_starter', sdk.starter, 503);
    const regions = (env.AWS_REGIONS ?? '').split(',').map(r => r.trim()).filter(Boolean);
    const configs = readLifecycleDeployments(env, regions);
    poolGuard('cron_deployments', configs.ok && regions.length > 0, 503);
    return { db, data, store: store ?? createPoolDispatchStore(db, env, sdk), starter: sdk.starter, deployments: configs.deployments,
        classes: regions.flatMap(region => poolModule.POOL_TYPES.filter(type => configs.deployments[region]!.instanceTypes.includes(type))
            .map(instanceType => ({ region, zoneId: configs.deployments[region]!.zoneId, instanceType, deployment: configs.deployments[region]! }))),
        now: () => new Date(), withLock: run => withPoolReplenishLock(db, run), log: logPoolPass };
}
