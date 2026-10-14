/**
 * AWS computer configuration from the environment (docs/AWS-COMPUTERS.md §4).
 *
 * 🔴 FAIL CLOSED. Absent configuration means AWS admission is disabled. Every
 * cap must be set explicitly to a non-negative integer when AWS is enabled;
 * a missing, empty, fractional, negative or non-numeric value disables
 * admission instead of becoming `NaN` (and `count >= NaN` is false, which
 * would admit). There are no numeric defaults: the pilot values in
 * `AWS_PILOT_VALUES` are what an operator should set, not what an unset
 * variable means.
 */

export type Env = Record<string, string | undefined>;

/** The only value that enables AWS admission and the aws-ec2 provider. */
export function isAwsComputersEnabled(env: Env = process.env): boolean {
    return env.EZIL_AWS_COMPUTERS_ENABLED === '1';
}

/**
 * Whether provider selection reads the placement table.
 *
 * 🔴 ONE-WAY. Once any placement row may exist this must stay on: with
 * reads off every computer resolves to Cloudflare, so an aws-ec2 computer
 * would silently fall back to an empty Cloudflare workspace. AWS admission
 * implies reads, so the AWS flag can never be on with reads off.
 */
export function isPlacementReadEnabled(env: Env = process.env): boolean {
    return env.EZIL_COMPUTE_PLACEMENT_READS === '1' || isAwsComputersEnabled(env);
}

export interface AwsAdmissionCaps {
    maxRunning: number;
    userMonthlyHours: number;
    globalMonthlyHours: number;
    userMonthlyEgressGb: number;
    globalMonthlyEgressGb: number;
}

/**
 * One region a computer may be created in, with its own running cap.
 *
 * 🔴 A computer is pinned to its data volume's region and zone. The region is
 * chosen ONCE, at creation (first region in `AWS_REGIONS` order with room),
 * and every later wake uses the placement's region; a full region refuses
 * (`region_capacity`), it never moves a computer.
 *
 * `maxRunning` is the computers this deployment may run there. It must come
 * from the region's VERIFIED On-Demand Standard vCPU quota minus every other
 * workload in the same quota (e.g. ezil-db-aws holds 4 of Mumbai's 5), divided
 * by the vCPU of the largest tier type. There is no default: an unset or
 * malformed cap disables AWS admission.
 */
export interface AwsRegionConfig {
    name: string;
    maxRunning: number;
}

export type AwsAdmissionConfig =
    | { enabled: false; reason: 'aws_disabled' | 'aws_config_invalid'; invalid?: string[] }
    | { enabled: true; killSwitch: boolean; caps: AwsAdmissionCaps; regions: AwsRegionConfig[] };

/** Ordered creation preference, e.g. `ap-south-1,us-east-1`. */
export const AWS_REGIONS_ENV = 'AWS_REGIONS';
/** At most this many regions: each is a separate lifecycle deployment and quota. */
export const MAX_AWS_REGIONS = 4;
/** Same grammar as infra/app-computers/lib/lifecycle/deployment.ts REGION_PATTERN. */
export const AWS_REGION_PATTERN = /^[a-z]{2}-(north|south|east|west|central|northeast|southeast|northwest|southwest)-[1-9]$/;

/** `ap-south-1` → `EZIL_AWS_MAX_RUNNING_AP_SOUTH_1`. */
export function regionCapEnv(region: string): string {
    return `EZIL_AWS_MAX_RUNNING_${region.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Computer size tiers (founder decision 2026-10-14). Types are in preference
 * order; the first is what a new computer records. Every type must be in the
 * lifecycle deployment's instance-type allowlist, or the intent is refused.
 * - free: 2 vCPU / 4 GiB. Burstable, launched with standard CPU credits
 *   (T3 defaults to unlimited, which bills surplus CPU).
 * - plus: 2 vCPU / 8 GiB.
 */
export const AWS_TIERS = {
    free: ['t3a.medium', 't3.medium'],
    plus: ['m6i.large'],
} as const satisfies Record<string, readonly string[]>;
export type AwsTier = keyof typeof AWS_TIERS;

/** Data-volume size at provision (infra DEFAULT_DATA_TIERS_GIB: free 20, premium 50); must fall inside the deployment's range. */
export const AWS_TIER_DATA_GIB: Readonly<Record<AwsTier, number>> = { free: 20, plus: 50 };

export function isAwsTier(value: unknown): value is AwsTier {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AWS_TIERS, value);
}

/** The instance type a new computer of `tier` records. Throws on an unknown tier: never a default size. */
export function instanceTypeForTier(tier: AwsTier): string {
    if (!isAwsTier(tier)) throw new Error('aws_tier_invalid');
    return AWS_TIERS[tier][0];
}

/** Regions in order, or the names of the invalid settings. Never a partial list. */
export function readAwsRegions(env: Env): { ok: true; regions: AwsRegionConfig[] } | { ok: false; invalid: string[] } {
    const raw = env[AWS_REGIONS_ENV];
    const names = raw === undefined ? [] : raw.split(',');
    if (
        names.length === 0 ||
        names.length > MAX_AWS_REGIONS ||
        names.some((n) => !AWS_REGION_PATTERN.test(n)) ||
        new Set(names).size !== names.length
    ) {
        return { ok: false, invalid: [AWS_REGIONS_ENV] };
    }
    const regions: AwsRegionConfig[] = [];
    const invalid: string[] = [];
    for (const name of names) {
        const n = strictCount(env[regionCapEnv(name)]);
        if (n === null) invalid.push(regionCapEnv(name));
        else regions.push({ name, maxRunning: n });
    }
    return invalid.length > 0 ? { ok: false, invalid } : { ok: true, regions };
}

export const AWS_CAP_ENV: Record<keyof AwsAdmissionCaps, string> = {
    maxRunning: 'AWS_MAX_RUNNING',
    userMonthlyHours: 'EZIL_AWS_USER_MONTHLY_HOURS',
    globalMonthlyHours: 'EZIL_AWS_GLOBAL_MONTHLY_HOURS',
    userMonthlyEgressGb: 'EZIL_AWS_USER_MONTHLY_EGRESS_GB',
    globalMonthlyEgressGb: 'EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB',
};

/** Documented pilot values (§4). Per-user and egress caps have no pinned value yet. */
export const AWS_PILOT_VALUES = { maxRunning: 2, globalMonthlyHours: 600 } as const;

function strictCount(value: string | undefined): number | null {
    if (value === undefined || !/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
}

export function readAwsAdmissionConfig(env: Env = process.env): AwsAdmissionConfig {
    if (!isAwsComputersEnabled(env)) return { enabled: false, reason: 'aws_disabled' };
    const caps: Partial<AwsAdmissionCaps> = {};
    const invalid: string[] = [];
    for (const [key, name] of Object.entries(AWS_CAP_ENV) as [keyof AwsAdmissionCaps, string][]) {
        const n = strictCount(env[name]);
        if (n === null) invalid.push(name);
        else caps[key] = n;
    }
    const regions = readAwsRegions(env);
    if (!regions.ok) invalid.push(...regions.invalid);
    if (invalid.length > 0 || !regions.ok) return { enabled: false, reason: 'aws_config_invalid', invalid };
    // Kill switch: anything but absent or exactly '0' is ON.
    const kill = env.EZIL_AWS_KILL_SWITCH;
    return { enabled: true, killSwitch: kill !== undefined && kill !== '0', caps: caps as AwsAdmissionCaps, regions: regions.regions };
}

// ── Enrollment and wake (C-6) ────────────────────────────────────────────

/** Where hosts post their C-6 enrollment: `https://<app host>/api/compute/aws/enroll`, nothing else. */
export const AWS_ENROLL_URL_ENV = 'EZIL_AWS_ENROLL_URL';
export const AWS_ENROLL_PATH = '/api/compute/aws/enroll';

/** The configured enrollment URL, or null when unset or anything but a plain HTTPS URL to the enroll path. */
export function readAwsEnrollUrl(env: Env): string | null {
    const raw = env[AWS_ENROLL_URL_ENV]?.trim();
    if (!raw) return null;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port !== '' && url.port !== '443')) return null;
    if (url.pathname !== AWS_ENROLL_PATH || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(url.hostname)) return null;
    return `https://${url.hostname}${AWS_ENROLL_PATH}`;
}

/**
 * How a STOPPED computer wakes.
 * - `replace` (default): a NEW instance boots on the retained data volume
 *   (generation + 1). Its launch user data carries this epoch's one-time
 *   enrollment nonce, so it needs no permission beyond the launch.
 * - `start`: the SAME instance is started in place. Its nonce must be written
 *   into user data while it is stopped (`ModifyInstanceAttribute`, userData only),
 *   which the lifecycle deployment enables with `features.userDataNonce` only
 *   after the staging proof. Without that, a started host has no nonce and can
 *   never enroll, so `start` is refused unless the operator declares the
 *   feature on (`EZIL_AWS_LIFECYCLE_USERDATA_NONCE=1`, mirroring the deployed
 *   lifecycle settings).
 */
export const AWS_WAKE_MODE_ENV = 'EZIL_AWS_WAKE_MODE';
export const AWS_USERDATA_NONCE_ENV = 'EZIL_AWS_LIFECYCLE_USERDATA_NONCE';
export type AwsWakeMode = 'replace' | 'start';

export function readAwsWakeMode(env: Env): { ok: true; mode: AwsWakeMode } | { ok: false; invalid: string } {
    const raw = env[AWS_WAKE_MODE_ENV];
    if (raw === undefined || raw === 'replace') return { ok: true, mode: 'replace' };
    if (raw === 'start') return env[AWS_USERDATA_NONCE_ENV] === '1' ? { ok: true, mode: 'start' } : { ok: false, invalid: AWS_USERDATA_NONCE_ENV };
    return { ok: false, invalid: AWS_WAKE_MODE_ENV };
}
