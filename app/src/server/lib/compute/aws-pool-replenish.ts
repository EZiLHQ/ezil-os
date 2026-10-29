import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { LifecycleStarter } from './aws-ec2';
import { buildLifecycleWork, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { startLifecycleJob } from './aws-receipts';
import { withAdmission, type AdmissionLock, type PlacementDb, type PlacementExecutor } from './placement';
import { closeExpiredDemands, closeOrphanedDemands, lockRegionDemands, updateDemandCleanup } from './capacity-demand';
import { instanceVcpu } from './aws-config';
import { poolGuard } from './aws-pool-errors';
import type { PoolClass, PoolData, PoolHostRow, PoolReadinessDiagnostic } from './ready-pool';

/** Durable launch reservations and job storage are implemented in aws-pool-dispatch.ts; prepare commits BEFORE StartExecution and retains unknown jobs
 * for recovery, with the same jobId, digest and input. Provision reservations must
 * recheck the kill switch and region cap under the existing admission lock. Never
 * reserve a fake computer. A recovery pass must settle unknown/refused jobs and
 * failed hosts left over after the two-retirement budget is exhausted. Hosts
 * already retiring are recovered independently of the planner's budget. */
export interface PoolDispatchStore {
    prepare(tx: PlacementExecutor, c: PoolClass, operation: 'pool-provision' | 'pool-retire',
        build: (host: PoolHostRow) => LifecycleWork, host?: PoolHostRow): Promise<LifecycleWork>;
    reconcile?(): Promise<void>;
    canRetire?(tx: PlacementExecutor, id: string): Promise<boolean>;
    retirementCandidates?(tx: PlacementExecutor, c: PoolClass, state: 'failed' | 'retiring'): Promise<string[]>;
    outcome(work: LifecycleWork, outcome: 'started' | 'refused' | 'unknown'): Promise<void>;
}
export interface PoolPassRecord {
    target: number; recent: number; base: number; spares: number; provisioned: number; retired: number;
    retirements: { poolHostId: string; jobId: string; outcome: 'pending' | 'started' | 'refused' | 'unknown' }[];
    slowHosts: PoolReadinessDiagnostic[];
}
/** One class's record in a pass, paired at push time (the planner reorders classes by floor priority). */
export interface PoolPassEntry { c: PoolClass; record: PoolPassRecord }
export interface PoolReplenishDeps {
    db: PlacementDb; data: PoolData; store: PoolDispatchStore; starter: LifecycleStarter;
    classes: PoolClass[]; deployments: Record<string, LifecycleDeployment>; now(): Date;
    withLock<T>(run: (tx?: PlacementExecutor, lock?: AdmissionLock) => Promise<T>): Promise<T | null>;
    /** Called exactly once per pass that took the lock; `failed` when the pass threw (the error is rethrown). */
    log(entries: PoolPassEntry[], failed: boolean): void;
    sleep?: (ms: number) => Promise<void>;
}
/** Transaction lock works through transaction poolers; the transaction stays open
 * throughout demand reads and reservations. Dispatch begins after commit. The global
 * admission lock is taken FIRST (admission -> computer -> demand -> pool rows), so
 * replenishment and demand reservation never lock pool rows in opposite orders. */
export function withPoolReplenishLock<T>(db: PlacementDb, run: (tx?: PlacementExecutor, lock?: AdmissionLock) => Promise<T>): Promise<T | null> {
    return withAdmission(db, async (tx, lock) => {
        const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(1163554896, 0) AS locked`);
        const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
        poolGuard('replenish_locked', (rows?.[0] as { locked?: boolean } | undefined)?.locked === true, 204);
        return run(tx, lock);
    });
}
/** Reserved demand is future liability for planning: fold it into the in-use vCPU exactly once. */
const withDemand = <D extends { vcpuInUse: number; demandVcpu?: number }>(d: D): D => ({ ...d, vcpuInUse: d.vcpuInUse + (d.demandVcpu ?? 0), demandVcpu: 0 });
export function poolWork(c: PoolClass, d: LifecycleDeployment, operation: 'pool-provision' | 'pool-retire', host: PoolHostRow): LifecycleWork {
    poolGuard('work_class', host.region === c.region && host.zoneId === c.zoneId && host.instanceType === c.instanceType
        && d.region === c.region && d.zoneId === c.zoneId);
    return buildLifecycleWork({ schemaVersion: 1, jobId: randomUUID(), computerId: host.poolHostId, revision: 1,
        operation, targetGeneration: host.poolGeneration, fenceToken: randomUUID(), poolHostId: host.poolHostId,
        poolGeneration: host.poolGeneration, providerInstanceId: operation === 'pool-retire' ? host.instanceId : null,
        dataVolumeId: null, previousGeneration: null, previousInstanceId: null, previousFenceToken: null,
        deployment: d, instanceType: c.instanceType, dataVolumeGiB: null, leaseEpoch: 1, userData: null });
}
export async function runPoolReplenish(deps: PoolReplenishDeps): Promise<PoolPassRecord[] | null> {
    await deps.store.reconcile?.();
    const records: PoolPassRecord[] = [];
    const entries: PoolPassEntry[] = [];
    let prepared;
    try { prepared = await deps.withLock(async (locked, lock) => {
        let provisionBudget = 2, retireBudget = 2;
        // Demand hygiene under the same admission-ordered transaction: fixed DB-clock expiry, and
        // demands whose computer was deleted or changed hands are cancelled (committed retirements continue).
        if (locked && lock) { await closeExpiredDemands(locked, lock); await closeOrphanedDemands(locked, lock); }
        const jobs: { work: LifecycleWork; record: PoolPassRecord }[] = [];
        const reservedRetirements = new Set<string>();
        const db = locked ?? deps.db;
        // Protect per-shape minimums before weighted/recent-demand surplus. Snapshots
        // choose priority only; demand/capacity are reread after earlier reservations.
        const snapshots = await Promise.all(deps.classes.map(async c => ({c, demand:withDemand(await deps.data.readPoolDemand(db,c,deps.now())), minimum:0})));
        const floorCapacity = new Map<string,number>();
        for (const s of snapshots) {
            const reservedSpares=snapshots.filter(p=>p.c.region===s.c.region)
                .reduce((sum,p)=>sum+p.demand.spares*instanceVcpu(p.c.instanceType),0);
            const remaining=floorCapacity.get(s.c.region) ?? Math.max(0,s.demand.regionVcpuCap-Math.max(0,s.demand.vcpuInUse-reservedSpares));
            const wanted=!s.demand.killSwitch && s.demand.activeStandard+s.demand.activePremium>0
                && (deps.data.POOL_POLICY[`${s.c.region}:${s.c.instanceType}`]?.minSpares ?? 0)>0;
            s.minimum=wanted && remaining>=instanceVcpu(s.c.instanceType) ? 1 : 0;
            floorCapacity.set(s.c.region,remaining-s.minimum*instanceVcpu(s.c.instanceType));
        }
        snapshots.sort((a,b)=>Number(b.minimum>b.demand.spares)-Number(a.minimum>a.demand.spares));
        for (const snapshot of snapshots) {
            const {c}=snapshot, now=deps.now();
            const raw = await deps.data.readPoolDemand(db, c, now), demand = withDemand(raw);
            const peers=snapshots.filter(s=>s.c.region===c.region);
            const floorMissing=peers.some(s=>!s.demand.killSwitch && s.demand.activeStandard+s.demand.activePremium>0
                && (deps.data.POOL_POLICY[`${s.c.region}:${s.c.instanceType}`]?.minSpares ?? 0)>0 && s.demand.spares<1);
            const protectedVcpu=peers.filter(s=>s!==snapshot).reduce((sum,s)=>sum+Math.max(0,s.minimum-s.demand.spares)*instanceVcpu(s.c.instanceType),0);
            const capacity=Math.max(0,Math.min(demand.regionVcpuCap-protectedVcpu,
                floorMissing ? demand.vcpuInUse+(snapshot.minimum-demand.spares)*instanceVcpu(c.instanceType) : demand.regionVcpuCap));
            const plan = deps.data.planPool(c, {...demand,regionVcpuCap:capacity}, now);
            // Protected future launches can lower the capacity-derived target to zero
            // while surplus is still retiring. That is not permission to remove an
            // eligible shape's last usable ready host; launch capacity stays unchanged.
            if (snapshot.minimum > 0 && !demand.killSwitch && demand.activeStandard+demand.activePremium>0
                && (deps.data.POOL_POLICY[`${c.region}:${c.instanceType}`]?.minSpares ?? 0)>0) {
                let removableReady=Math.max(0,(demand.ready ?? Math.max(0,demand.spares-demand.booting.length))-1);
                plan.retire=plan.retire.filter(id=>{
                    const host=demand.idleReady.find(h=>h.poolHostId===id);
                    if (host?.obsolete || host?.unusable) return true;
                    return !!host && removableReady-- > 0;
                });
            }
            poolGuard('plan_counts', Number.isSafeInteger(plan.provision) && plan.provision >= 0
                && Number.isSafeInteger(plan.target) && plan.target >= 0, 503);
            const record: PoolPassRecord = { target: plan.target, recent: Math.ceil(demand.opens15m * (demand.bootMinutes ?? 4) / 15),
                base: Math.ceil(.04 * demand.activeStandard + .10 * demand.activePremium), spares: demand.spares, provisioned: 0, retired: 0,
                retirements: [], slowHosts: await deps.data.readPoolReadinessDiagnostics(db, c, now) };
            records.push(record); entries.push({ c, record });
            const reserve = async (operation: 'pool-provision' | 'pool-retire', id?: string,
                from: import('./ready-pool').PoolHostState[] = ['ready', 'failed', 'retiring']) => {
                if (id && reservedRetirements.has(id)) return false;
                const prepare = async (tx: PlacementExecutor) => {
                    if (id && deps.store.canRetire && !await deps.store.canRetire(tx, id)) return null;
                    const host = id ? await deps.data.markPoolHost(tx, id, from, 'retiring', now) : undefined;
                    if (id && !host) return null;
                    return deps.store.prepare(tx, c, operation, h => poolWork(c, deps.deployments[c.region]!, operation, h), host ?? undefined);
                };
                const work = locked ? await prepare(locked) : await deps.db.transaction(prepare);
                if (!work) return false;
                jobs.push({ work, record });
                if (id) {
                    reservedRetirements.add(id);
                    record.retirements.push({ poolHostId: id, jobId: work.intent.jobId, outcome: 'pending' });
                }
                return true;
            };
            // Reserve all stranded retirements under the same lock. Active/unknown
            // jobs retain their stored identity and are handled by reconcile().
            for (const id of await deps.store.retirementCandidates?.(db, c, 'retiring') ?? []) await reserve('pool-retire', id);
            // A demand's earmarked booting host whose provision settled (ready/failed) is retired now: the demand's
            // pressure exception to the floor and the 30-minute idle age. Its retirement job is bound to the demand.
            if (locked && lock) for (const d of await lockRegionDemands(locked, lock, c.region)) {
                let cleanup = d.cleanup, changed = false;
                for (const t of d.cleanup) {
                    // Retire once provision settled with an instance identity (canRetire), ready or not: never wait
                    // for readiness or the boot timeout. Pending/unknown provision jobs are left untouched.
                    if (t.phase !== 'booting' || t.instanceType !== c.instanceType || reservedRetirements.has(t.poolHostId)) continue;
                    if (!deps.store.canRetire || !await deps.store.canRetire(locked, t.poolHostId)) continue;
                    if (!await reserve('pool-retire', t.poolHostId, ['booting', 'ready', 'failed'])) continue;
                    const job = record.retirements.find(x => x.poolHostId === t.poolHostId)?.jobId ?? null;
                    cleanup = cleanup.map(x => x.poolHostId === t.poolHostId ? { ...x, phase: 'retiring' as const, jobId: job } : x); changed = true;
                }
                if (changed) poolGuard('replenish_demand_cleanup', await updateDemandCleanup(locked, lock, d, cleanup), 503);
            }
            for (const id of plan.fail) await deps.data.markPoolHost(db, id, ['booting'], 'failed', now);
            const failed = await deps.store.retirementCandidates?.(db, c, 'failed') ?? [];
            for (const id of new Set([...failed, ...plan.fail, ...plan.retire])) {
                if (retireBudget === 0) break;
                if (await reserve('pool-retire', id)) retireBudget--;
            }
            const provisions = Math.min(plan.provision, provisionBudget);
            for (let n = 0; n < provisions; n++) await reserve('pool-provision');
            provisionBudget -= provisions;
            snapshot.demand={...demand,spares:demand.spares+provisions};
        }
        return { records, entries, jobs };
    });
    } catch (error) { if (entries.length) deps.log(entries, true); throw error; }
    if (!prepared) return null;
    // The advisory transaction, including all demand reads and boot reservations, has committed.
    let failed = true;
    try {
        for (const { work, record } of prepared.jobs) {
            const outcome = await startLifecycleJob(deps.starter, work.intent.deployment.region, work, deps.sleep);
            const retirement = record.retirements.find(r => r.jobId === work.intent.jobId);
            if (retirement) retirement.outcome = outcome;
            await deps.store.outcome(work, outcome);
            if (outcome === 'started') record[work.intent.operation === 'pool-provision' ? 'provisioned' : 'retired']++;
        }
        failed = false;
    } finally { deps.log(prepared.entries, failed); }
    return prepared.records;
}

/**
 * D4 (round 5) log memo: the last emitted per-class target/spares signature, when any line was emitted,
 * and whether that line was a failed pass (so the first good pass after it is logged as the recovery).
 */
export interface PoolPassLogMemo { signature: string | null; emittedAt: number | null; failed: boolean }
export const POOL_LOG_HEARTBEAT_MS = 15 * 60_000;
export function newPoolPassLogMemo(): PoolPassLogMemo { return { signature: null, emittedAt: null, failed: false }; }
/**
 * The ONE compact pool-replenish line for a pass, or null when nothing changed. A pass is a change when it
 * dispatched (provisioned+retired>0), reserved retirements, saw slow hosts, failed, is the first good pass
 * after a failed one, or its per-class target/spares signature differs from the last emitted line. An
 * unchanged pass emits at most one `heartbeat` line per 15 minutes. Updates `memo` only when it returns a line.
 */
export function poolPassLine(entries: PoolPassEntry[], memo: PoolPassLogMemo, now: Date, opts: { failed?: boolean } = {}): string | null {
    const failed = !!opts.failed;
    const classes = entries.map(({ c, record: r }) => ({ region: c.region, type: c.instanceType, target: r.target, spares: r.spares,
        provisioned: r.provisioned, retired: r.retired, retirements: r.retirements, slowHosts: r.slowHosts }));
    const signature = classes.map(k => `${k.region}:${k.type}:${k.target}:${k.spares}`).sort().join(',');
    const changed = failed || memo.failed || signature !== memo.signature
        || classes.some(k => k.provisioned + k.retired > 0 || k.retirements.length > 0 || k.slowHosts.length > 0);
    const heartbeatDue = memo.emittedAt === null || now.getTime() - memo.emittedAt >= POOL_LOG_HEARTBEAT_MS;
    if (!changed && !heartbeatDue) return null;
    memo.signature = signature; memo.emittedAt = now.getTime(); memo.failed = failed;
    return JSON.stringify({ event: 'pool-replenish', ...(failed ? { failed: true } : {}), ...(changed ? {} : { heartbeat: true }), classes });
}
