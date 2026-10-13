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

export type AwsAdmissionConfig =
    | { enabled: false; reason: 'aws_disabled' | 'aws_config_invalid'; invalid?: string[] }
    | { enabled: true; killSwitch: boolean; caps: AwsAdmissionCaps };

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
    if (invalid.length > 0) return { enabled: false, reason: 'aws_config_invalid', invalid };
    // Kill switch: anything but absent or exactly '0' is ON.
    const kill = env.EZIL_AWS_KILL_SWITCH;
    return { enabled: true, killSwitch: kill !== undefined && kill !== '0', caps: caps as AwsAdmissionCaps };
}
