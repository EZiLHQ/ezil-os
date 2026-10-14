/**
 * AWS admission (docs/AWS-COMPUTERS.md C-3 "Leasing and admission", §4, R9).
 *
 * One READ COMMITTED transaction:
 *   1. `withAdmission` — opens the transaction; the global advisory lock is
 *      its FIRST statement, and READ COMMITTED is asserted in that statement.
 *   2. `readAdmissionCounters` — the target computer's owner, running count, the user's other AWS
 *      computers, duplicate placements, this month's usage rows.
 *   3. `decideAdmission` — pure, below.
 *   4. On admit: `leasePlacement` (STOPPED → LEASED, lease_epoch + 1, by CAS)
 *      or `createAwsPlacement`. Both live in `placement.ts`, the only writer.
 *
 * A disabled or invalid configuration refuses BEFORE any statement, so with
 * AWS off this module never touches the (not yet created) tables.
 */

import {
    withAdmission,
    createAwsPlacement,
    leasePlacement,
    readAdmissionCounters,
    readPlacement,
    type AdmissionCounters,
    type Placement,
    type PlacementDb,
    type PlacementFields,
} from './placement';
import { instanceTypeForTier, isAwsTier, readAwsAdmissionConfig, type AwsAdmissionConfig, type AwsTier, type Env } from './aws-config';
import { BYTES_PER_GB, summarizeUsage, utcMonthStart } from './usage';

export type AdmissionRefusal =
    | 'aws_disabled'
    | 'aws_config_invalid'
    | 'computer_not_owned'
    | 'computer_deleted'
    | 'kill_switch'
    | 'duplicate_placement'
    | 'max_running'
    | 'user_has_aws_computer'
    | 'user_hours_cap'
    | 'global_hours_cap'
    | 'user_egress_cap'
    | 'global_egress_cap'
    | 'aws_tier_invalid'
    | 'region_not_configured'
    | 'region_capacity';

/**
 * Where the computer lives. `create`: pick the first configured region with
 * room. `lease`: the placement's own region (sticky; C-1/R1), which must
 * still be configured and have room. Never another region.
 */
export type RegionPlan = { kind: 'create' } | { kind: 'lease'; region: string | null };

export type AdmissionDecision = { admit: true; region?: string } | { admit: false; reason: AdmissionRefusal; reasons: AdmissionRefusal[] };

/**
 * Exact per-region running counts, when the counter read supplies them.
 * Until then each region is checked against the GLOBAL running count: an
 * upper bound on any one region's count, so a region can be refused while it
 * still has room, but is never over-admitted.
 */
export type RegionalCounters = { runningByRegion?: Readonly<Record<string, number>> };

function regionRunning(counters: { runningCount: number } & RegionalCounters, region: string): number {
    const exact = counters.runningByRegion?.[region];
    return exact === undefined ? counters.runningCount : exact;
}

/**
 * Pure. Refusals in a fixed priority order; `reason` is the first and
 * `reasons` all of them. Every comparison is `>=`: reaching a cap refuses.
 */
export function decideAdmission(input: {
    config: AwsAdmissionConfig;
    counters: Pick<AdmissionCounters, 'targetOwnerId' | 'targetPlacementOwnerId' | 'targetDeleted' | 'targetForeignUsage' | 'runningCount' | 'userOtherAwsComputers' | 'duplicates' | 'usage'> &
        RegionalCounters;
    userId: string;
    now: Date;
    /** Omitted only by callers that decide no placement (pure cap checks). */
    region?: RegionPlan;
}): AdmissionDecision {
    const { config, counters } = input;
    if (!config.enabled) return { admit: false, reason: config.reason, reasons: [config.reason] };
    const { caps } = config;
    const usage = summarizeUsage(counters.usage, input.userId, input.now);
    const reasons: AdmissionRefusal[] = [];
    // The caller's pair is re-checked here: caps are per user, so admitting
    // for a computer the user does not own would bypass them.
    // The placement's owner_user_id is authoritative (C-2). ezil_computers is
    // user-writable, so its row is only a precondition; usage metered to
    // anyone else means the computer changed hands.
    const caller = input.userId.toLowerCase();
    if (
        (counters.targetPlacementOwnerId !== null && counters.targetPlacementOwnerId.toLowerCase() !== caller) ||
        counters.targetOwnerId === null ||
        counters.targetOwnerId.toLowerCase() !== input.userId.toLowerCase() ||
        counters.targetForeignUsage > 0
    ) {
        reasons.push('computer_not_owned');
    }
    if (counters.targetDeleted) reasons.push('computer_deleted');
    if (config.killSwitch) reasons.push('kill_switch');
    if (counters.duplicates.length > 0) reasons.push('duplicate_placement');
    if (counters.runningCount >= caps.maxRunning) reasons.push('max_running');
    if (counters.userOtherAwsComputers >= 1) reasons.push('user_has_aws_computer');
    if (usage.user.hours >= caps.userMonthlyHours) reasons.push('user_hours_cap');
    if (usage.global.hours >= caps.globalMonthlyHours) reasons.push('global_hours_cap');
    if (usage.user.egressBytes >= caps.userMonthlyEgressGb * BYTES_PER_GB) reasons.push('user_egress_cap');
    if (usage.global.egressBytes >= caps.globalMonthlyEgressGb * BYTES_PER_GB) reasons.push('global_egress_cap');
    let region: string | undefined;
    if (input.region?.kind === 'create') {
        region = config.regions.find((r) => regionRunning(counters, r.name) < r.maxRunning)?.name;
        if (region === undefined) reasons.push('region_capacity');
    } else if (input.region?.kind === 'lease') {
        const home = input.region.region;
        const configured = home === null ? undefined : config.regions.find((r) => r.name === home);
        if (configured === undefined) reasons.push('region_not_configured');
        else if (regionRunning(counters, configured.name) >= configured.maxRunning) reasons.push('region_capacity');
        else region = configured.name;
    }
    if (reasons.length > 0) return { admit: false, reason: reasons[0]!, reasons };
    return region === undefined ? { admit: true } : { admit: true, region };
}

export type AdmissionRequest =
    /** `userId` is the AUTHENTICATED session user; on create it becomes `owner_user_id`. */
    | { kind: 'lease'; userId: string; computerId: string; expected: { generation: number; leaseEpoch: number }; leaseUntil: Date; replace?: boolean }
    /**
     * `tier` sizes the computer (`AWS_TIERS`); admission, not the caller,
     * chooses its region, so `fields.region` / `fields.instanceType` are ignored.
     */
    | { kind: 'create'; userId: string; computerId: string; tier: AwsTier; fields?: PlacementFields };

export type AdmissionOutcome =
    | { admitted: true; placement: Placement }
    | { admitted: false; reason: AdmissionRefusal | 'cas_conflict' | 'placement_exists'; reasons?: AdmissionRefusal[] };

export interface AdmissionDeps {
    env?: Env;
    now?: () => Date;
}

export async function runAdmission(db: PlacementDb, request: AdmissionRequest, deps: AdmissionDeps = {}): Promise<AdmissionOutcome> {
    const config = readAwsAdmissionConfig(deps.env ?? process.env);
    if (!config.enabled) return { admitted: false, reason: config.reason, reasons: [config.reason] };
    const now = (deps.now ?? (() => new Date()))();

    // An unknown tier refuses before any statement: never a default size.
    if (request.kind === 'create' && !isAwsTier(request.tier)) {
        return { admitted: false, reason: 'aws_tier_invalid', reasons: ['aws_tier_invalid'] };
    }

    return withAdmission(db, async (tx, lock) => {
        const counters = await readAdmissionCounters(tx, lock, {
            userId: request.userId,
            computerId: request.computerId,
            monthStart: utcMonthStart(now),
            now,
        });
        // The lease's region is the placement's own, read inside this transaction
        // after the lock: never caller-supplied.
        const region: RegionPlan =
            request.kind === 'create' ? { kind: 'create' } : { kind: 'lease', region: (await readPlacement(tx, request.computerId)).record?.region ?? null };
        const decision = decideAdmission({ config, counters, userId: request.userId, now, region });
        if (!decision.admit) return { admitted: false, reason: decision.reason, reasons: decision.reasons };

        const result =
            request.kind === 'lease'
                ? await leasePlacement(tx, lock, {
                      computerId: request.computerId,
                      ownerUserId: request.userId,
                      expected: request.expected,
                      leaseUntil: request.leaseUntil,
                      replace: request.replace,
                  })
                : await createAwsPlacement(tx, lock, {
                      computerId: request.computerId,
                      ownerUserId: request.userId,
                      fields: { ...request.fields, region: decision.region!, instanceType: instanceTypeForTier(request.tier) },
                  });
        if (!result.ok) return { admitted: false, reason: result.reason === 'illegal_transition' ? 'cas_conflict' : result.reason };
        return { admitted: true, placement: result.placement };
    });
}
