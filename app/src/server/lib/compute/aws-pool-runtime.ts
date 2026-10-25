import { observePoolAdopt } from './aws-pool-adopt';
import { sharedAwsSdkCollaborators } from './aws-clients';
import type { Env } from './aws-config';
import { isAwsComputersEnabled } from './aws-config';
import { buildLifecycleWork, readLifecycleDeployments } from './aws-intent';
import { lockPoolClaimPlacement, savePoolEnrollmentNonce, readPoolMigrationReservations, type PlacementDb } from './placement';
import * as poolModule from './ready-pool';
import type { PoolClaimDeps } from './aws-pool-claim';
import { poolGuard } from './aws-pool-errors';
import { withPoolReplenishLock, type PoolDispatchStore, type PoolReplenishDeps } from './aws-pool-replenish';

import { createPoolDispatchStore } from './aws-pool-dispatch';
import { runPoolReplenish } from './aws-pool-replenish';
import type { PoolDeps } from './aws-receipts';
export function createPoolDeps(db: PlacementDb, env: Env): PoolDeps {
    return { readyAt: poolModule.readPoolSessionReadyAt, retireLease: poolModule.retirePoolLease, leasePoolHost: poolModule.leasePoolHost, publishPoolClaim: poolModule.publishPoolClaim, buildWork: buildLifecycleWork,
        async validateCapacity(tx, p) {
            const demand = await poolModule.readPoolDemand(tx, { region: p.region!, zoneId: p.zoneId!, instanceType: p.instanceType as poolModule.PoolClass['instanceType'] }, new Date());
            const migrations = await readPoolMigrationReservations(tx);
            poolGuard('open_pool_capacity', env.EZIL_AWS_KILL_SWITCH !== '1' && !demand.killSwitch
                && Number.isSafeInteger(migrations) && migrations >= 0 && demand.vcpuInUse + migrations * 2 <= demand.regionVcpuCap, 503);
        },
        async replenish() { await runPoolReplenish(createPoolReplenishDeps(db, env)); } };
}
export function createPoolHostDeps(db: PlacementDb, env: Env): PoolClaimDeps {
    const sdk = sharedAwsSdkCollaborators(env);
    const deps: PoolClaimDeps = { db, data: poolModule, env, now: () => new Date(), describer: sdk.describer ?? null, executions: sdk.executions ?? null,
        lockPlacement: lockPoolClaimPlacement, saveNonce: savePoolEnrollmentNonce };
    deps.observeAdopt = (proof, identity, poll) => observePoolAdopt(deps, proof, identity, poll);
    return deps;
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
        now: () => new Date(), withLock: run => withPoolReplenishLock(db, run), log: record => console.info('pool-replenish', record) };
}
