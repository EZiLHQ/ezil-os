/**
 * What Settings → System may say about the machine behind a computer.
 *
 * 🔴 READ ONLY. This never creates, pins, leases or moves a placement: it reads
 * the placement row (`readPlacement`) and nothing else, and it never calls
 * `resolveComputeProvider`, whose start path pins a no-row computer to
 * Cloudflare. A Settings tab that silently decided a computer's provider would
 * be the most expensive bug a monitor could have.
 *
 * 🔴 KNOWN OR SAID TO BE UNKNOWN. Nothing here is a live measurement; the
 * machine size is the CONFIGURED size of the recorded instance type (AWS) or of
 * the container class the desktop Worker requests (Cloudflare), and `usage` is
 * always null until a real metrics source exists. A computer with no placement
 * row is reported as `unassigned`, not as Cloudflare: until its next start
 * decides, nothing has recorded where it runs.
 */
import { isPlacementReadEnabled, type Env } from './aws-config';
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
}

const UNKNOWN_MACHINE: SystemInfo['machine'] = Object.freeze({ vcpu: null, memoryMiB: null, instanceType: null, region: null, source: 'unknown' as const });

/** Pure: a resolved placement → what may be shown. */
export function describePlacement(placement: ResolvedPlacement): SystemInfo {
    const record = placement.record;
    if (!record) {
        return { provider: 'unassigned', providerSource: 'no_placement', machine: { ...UNKNOWN_MACHINE }, lifecycleState: null, usage: null };
    }
    if (record.provider === 'aws-ec2') {
        const size = record.instanceType ? AWS_INSTANCE_SIZES[record.instanceType] : undefined;
        return {
            provider: 'aws-ec2',
            providerSource: 'placement',
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
        return {
            provider: 'unknown',
            providerSource: 'reads_off',
            configuredRouting: 'cloudflare',
            machine: { ...UNKNOWN_MACHINE },
            lifecycleState: null,
            usage: null,
        };
    }
    let placement: ResolvedPlacement;
    try {
        placement = await readPlacement(db, computer.computerId);
    } catch {
        return { provider: 'unknown', providerSource: 'unavailable', machine: { ...UNKNOWN_MACHINE }, lifecycleState: null, usage: null };
    }
    if (placement.record && placement.record.ownerUserId !== computer.userId.toLowerCase()) return null;
    return describePlacement(placement);
}
