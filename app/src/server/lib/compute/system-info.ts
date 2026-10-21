/**
 * What Settings → System may say about the machine behind a computer.
 *
 * 🔴 READ ONLY. This never creates, pins, leases or moves a placement: it reads
 * the placement row (`readPlacement`) and, for Cloudflare, the non-waking
 * signed sandbox system endpoint. It never starts a container and never calls
 * `resolveComputeProvider`, whose start path pins a no-row computer to
 * Cloudflare. A Settings tab that silently decided a computer's provider would
 * be the most expensive bug a monitor could have.
 *
 * 🔴 KNOWN OR SAID TO BE UNKNOWN. The image is reported by sandbox system metadata; the
 * machine size is the CONFIGURED size of the recorded instance type (AWS) or of
 * the container class the desktop Worker requests (Cloudflare), and `usage` is
 * always null until a real metrics source exists. A computer with no placement
 * row is reported as `unassigned`, not as Cloudflare: until its next start
 * decides, nothing has recorded where it runs.
 */
import { SIZES } from '@/server/billing/v2/contract';
import { deriveGuacamoleSandboxId, getGuacamoleSandboxSystem, resolveCloudflareGuacamoleConfig } from '../cloudflare-guacamole-provider';
import { isAwsComputersEnabled, isPlacementReadEnabled, type Env } from './aws-config';
import { readPlacement, type PlacementExecutor, type ResolvedPlacement } from './placement';

/**
 * Configured size of every AWS instance type a computer may record (aws-config.ts
 * `AWS_TIERS`). A type missing here renders its name with an unknown size; it is
 * never guessed from the user's plan.
 */
export const AWS_INSTANCE_SIZES: Readonly<Record<string, { vcpu: number; memoryMiB: number }>> = Object.freeze({
    't3a.medium': { vcpu: 2, memoryMiB: 4096 },
    't3.medium': { vcpu: 2, memoryMiB: 4096 },
    'm6i.large': { vcpu: 2, memoryMiB: 8192 },
    'm6i.xlarge': { vcpu: 4, memoryMiB: 16384 },
    'm6i.2xlarge': { vcpu: 8, memoryMiB: 32768 },
});

/**
 * The container class the desktop Worker requests (`worker/wrangler.toml`
 * `instance_type = { vcpu = 2, memory_mib = 6144, … }`). A test pins this
 * against that file so the two cannot drift.
 */
export const CLOUDFLARE_CONTAINER_SIZE = Object.freeze({ vcpu: 2, memoryMiB: 6144 });

export type SystemProvider = 'cloudflare' | 'aws-ec2' | 'unassigned' | 'unknown';

export interface SystemInfo {
    provider: SystemProvider;
    /**
     * - `placement`: the recorded placement row says so.
     * - `reads_off`: placement reads are disabled; nothing recorded was read, so the provider is
     *   `unknown` (see `configuredRouting` for what the deployment is configured to do).
     * - `no_placement`: no row yet; the next start decides.
     * - `unavailable`: the placement could not be read (missing table, integrity error).
     */
    providerSource: 'placement' | 'reads_off' | 'no_placement' | 'unavailable';
    /** Only with `reads_off`: where routing is CONFIGURED to start computers. A setting, not an observation. */
    configuredRouting?: 'cloudflare';
    /** The image reported by the signed, non-waking system endpoint; never inferred from configuration. */
    image: { id: string | null; source: 'running' | 'unknown' };
    machine: {
        vcpu: number | null;
        memoryMiB: number | null;
        instanceType: string | null;
        region: string | null;
        /** `configured`: the size of the recorded type/class. `unknown`: not known. Never measured. */
        source: 'configured' | 'unknown';
    };
    lifecycleState: string | null;
    /** No live resource metrics exist yet. */
    usage: null;
    plan?: { vcpu: number; memoryGB: number; region: 'ap-south-1'; status: 'preparing' | 'failed' | 'blocked' | 'ready'; reason: string | null; outcome: 'fresh_provision' | null };
}

export function describePlanPlacement(info: SystemInfo, entitlement: import('./tier').EntitlementRecord | null,
    migration: { state: string; reason: string | null; outcome: string | null } | null, env: Env): SystemInfo['plan'] | undefined {
    if (entitlement?.source !== 'billing_v2' || entitlement.status !== 'active' || entitlement.paymentIssue
        || entitlement.provider !== 'aws' || !['standard_monthly_v3', 'premium_monthly_v3'].includes(entitlement.planId ?? '')) return;
    const size = entitlement.planId === 'standard_monthly_v3' ? SIZES['std-2'] : entitlement.size && SIZES[entitlement.size];
    if (!size || size.provider !== 'aws') return;
    const blocked = !isAwsComputersEnabled(env) || (env.EZIL_AWS_KILL_SWITCH !== undefined && env.EZIL_AWS_KILL_SWITCH !== '0');
    const ready = info.provider === 'aws-ec2' && info.machine.region === 'ap-south-1'
        && info.machine.vcpu === size.vcpu && info.machine.memoryMiB === size.memoryGiB * 1024
        && ['RUNNING', 'STOPPED'].includes(info.lifecycleState ?? '');
    const failed = migration?.state.startsWith('failed_');
    return { vcpu: size.vcpu, memoryGB: size.memoryGiB, region: 'ap-south-1',
        status: blocked ? 'blocked' : ready ? 'ready' : failed ? 'failed' : 'preparing',
        reason: blocked ? 'AWS paused by operations' : failed ? 'AWS preparation failed; your existing workspace is retained' : null,
        outcome: migration?.outcome === 'fresh_provision' ? 'fresh_provision' : null };
}

async function withPlanInfo(info: SystemInfo, db: PlacementExecutor, computer: { computerId: string; userId: string }, env: Env): Promise<SystemInfo> {
    try {
        const { billingV2EntitlementReader } = await import('@/server/billing/v2/compute-access');
        const entitlement = await billingV2EntitlementReader().read(computer.userId);
        if (!entitlement || entitlement.provider !== 'aws') return info;
        let migration = null;
        if (isPlacementReadEnabled(env)) {
            const { migrationStatusFor } = await import('./provider-migrate-orchestrator');
            try {
                const status = await migrationStatusFor(computer.userId, computer.computerId, db);
                if (status && typeof status === 'object') migration = status;
            } catch { migration = { state: 'failed_needs_operator', reason: 'status_unavailable', outcome: null }; }
        }
        const plan = describePlanPlacement(info, entitlement, migration, env);
        if (plan) info.plan = plan;
    } catch { /* Optional billing metadata cannot hide actual placement. */ }
    return info;
}


const UNKNOWN_MACHINE: SystemInfo['machine'] = Object.freeze({ vcpu: null, memoryMiB: null, instanceType: null, region: null, source: 'unknown' as const });
const UNKNOWN_IMAGE: SystemInfo['image'] = Object.freeze({ id: null, source: 'unknown' });

/** Pure: a resolved placement → what may be shown. */
export function describePlacement(placement: ResolvedPlacement): SystemInfo {
    const record = placement.record;
    if (!record) {
        return { provider: 'unassigned', providerSource: 'no_placement', image: { ...UNKNOWN_IMAGE }, machine: { ...UNKNOWN_MACHINE }, lifecycleState: null, usage: null };
    }
    if (record.provider === 'aws-ec2') {
        const size = record.instanceType ? AWS_INSTANCE_SIZES[record.instanceType] : undefined;
        return {
            provider: 'aws-ec2',
            providerSource: 'placement',
            image: { ...UNKNOWN_IMAGE },
            machine: {
                vcpu: size?.vcpu ?? null,
                memoryMiB: size?.memoryMiB ?? null,
                instanceType: record.instanceType,
                region: record.region,
                source: size ? 'configured' : 'unknown',
            },
            lifecycleState: record.state,
            usage: null,
        };
    }
    return {
        provider: 'cloudflare',
        providerSource: 'placement',
        image: { ...UNKNOWN_IMAGE },
        machine: { ...CLOUDFLARE_CONTAINER_SIZE, instanceType: null, region: null, source: 'configured' },
        lifecycleState: null,
        usage: null,
    };
}

/**
 * The computer's system info. The caller must already have proven the live
 * computer row is the user's (`liveOwnedComputer`); this additionally refuses a
 * placement recorded for another owner by returning `null` (→ NOT_FOUND).
 */
export async function readSystemInfo(
    db: PlacementExecutor,
    computer: { computerId: string; userId: string },
    env: Env = process.env,
): Promise<SystemInfo | null> {
    if (!isPlacementReadEnabled(env)) {
        // No placement table is read with reads off (it may not exist). Routing is CONFIGURED to start
        // computers on Cloudflare, but that is a setting, not an observation of where this computer
        // runs (a computer placed while the flags were different could run elsewhere). So the provider
        // is unknown and no machine size is claimed; `configuredRouting` carries the setting separately.
        return withPlanInfo({
            provider: 'unknown',
            providerSource: 'reads_off',
            configuredRouting: 'cloudflare',
            image: { ...UNKNOWN_IMAGE },
            machine: { ...UNKNOWN_MACHINE },
            lifecycleState: null,
            usage: null,
        }, db, computer, env);
    }
    let placement: ResolvedPlacement;
    try {
        placement = await readPlacement(db, computer.computerId);
    } catch {
        return { provider: 'unknown', providerSource: 'unavailable', image: { ...UNKNOWN_IMAGE }, machine: { ...UNKNOWN_MACHINE }, lifecycleState: null, usage: null };
    }
    if (placement.record && placement.record.ownerUserId !== computer.userId.toLowerCase()) return null;
    const info = describePlacement(placement);
    if (info.provider === 'cloudflare') {
        try {
            // Read only, bounded by the signed system helper's 10-second timeout.
            const system = await getGuacamoleSandboxSystem(
                resolveCloudflareGuacamoleConfig(),
                deriveGuacamoleSandboxId(computer.userId, computer.computerId),
            );
            const id = system.imageId;
            if (system.ok === true && typeof id === 'string' && id !== 'unknown'
                && id.length >= 1 && id.length <= 128 && !/[^A-Za-z0-9._:-]/.test(id)) {
                info.image = { id, source: 'running' };
            }
        } catch {
            // An unavailable image must never hide the recorded provider or configured size.
        }
    }
    return withPlanInfo(info, db, computer, env);
}
