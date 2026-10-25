/**
 * AWS admission (docs/AWS-COMPUTERS.md C-3 "Leasing and admission", §4, R9).
 *
 * One READ COMMITTED transaction:
 *   1. `withAdmission` — opens the transaction; the global advisory lock is
 *      its FIRST statement, and READ COMMITTED is asserted in that statement.
 *   2. `readAdmissionCounters` — the target computer's owner, running count, the user's other AWS
 *      computers, duplicate placements, this month's usage totals.
 *   3. `decideAdmission` — pure, below.
 *   4. On admit: `mintAdmissionTicket`, then `leasePlacement` (STOPPED → LEASED,
 *      lease_epoch + 1, by CAS) or `createAwsPlacement` with that ticket. All
 *      live in `placement.ts`, the only writer; neither runs on the lock alone.
 *
 * A disabled or invalid configuration refuses BEFORE any statement, so with
 * AWS off this module never touches the (not yet created) tables.
 */

import {
    type PlacementExecutor,
    withAdmission,
    ENROLLMENT_FAILED,
    createAwsPlacement,
    leasePlacement,
    mintAdmissionTicket,
    peekAdmissionCounters,
    readAdmissionCounters,
    readPlacement,
    type AdmissionCounters,
    type Placement,
    type PlacementDb,
    type PlacementFields,
} from './placement';
import { instanceTypeForTier, instanceVcpu, isAwsTier, readAwsAdmissionConfig, type AwsAdmissionConfig, type AwsTier, type Env } from './aws-config';
import { BYTES_PER_GB, usageFor, utcMonthStart } from './usage';

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
 * Exact running vCPU, as `readAdmissionCounters` supplies it. An absent region
 * has no running computers. Unplaced rows count against every region. Missing
 * vCPU data falls back to counts times 8; missing regional data uses the global
 * upper bound, so a pure caller never over-admits.
 */
export type RegionalCounters = {
    runningByRegion?: Readonly<Record<string, number>>;
    runningUnplaced?: number;
    runningVcpu?: number;
    runningVcpuByRegion?: Readonly<Record<string, number>>;
    runningVcpuUnplaced?: number;
};

function regionRunningVcpu(counters: { runningCount: number } & RegionalCounters, region: string): number {
    const regional = counters.runningVcpuByRegion ?? counters.runningByRegion;
    if (regional === undefined) return counters.runningVcpu ?? counters.runningCount * 8;
    const exact = Object.prototype.hasOwnProperty.call(regional, region) ? regional[region]! : 0;
    return exact * (counters.runningVcpuByRegion === undefined ? 8 : 1)
        + (counters.runningVcpuUnplaced ?? (counters.runningUnplaced ?? 0) * 8);
}

/**
 * Pure. Refusals in a fixed priority order; `reason` is the first and
 * `reasons` all of them. A launch must fit the vCPU budget; reaching a monthly
 * usage cap refuses.
 */
export function decideAdmission(input: {
    config: AwsAdmissionConfig;
    counters: Pick<AdmissionCounters, 'targetOwnerId' | 'targetPlacementOwnerId' | 'targetDeleted' | 'targetForeignUsage' | 'runningCount' | 'userOtherAwsComputers' | 'duplicates' | 'usage'> &
        RegionalCounters;
    userId: string;
    now: Date;
    /** Omitted only by callers that decide no placement (pure cap checks). */
    region?: RegionPlan;
    /** Type being launched; omitted/unknown counts as 8 vCPU. */
    instanceType?: string | null;
}): AdmissionDecision {
    const { config, counters } = input;
    if (!config.enabled) return { admit: false, reason: config.reason, reasons: [config.reason] };
    const { caps } = config;
    const requestedVcpu = instanceVcpu(input.instanceType);
    const usage = usageFor(counters.usage, input.userId);
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
    if ((counters.runningVcpu ?? counters.runningCount * 8) + requestedVcpu > caps.maxRunning * 2) reasons.push('max_running');
    if (counters.userOtherAwsComputers >= 1) reasons.push('user_has_aws_computer');
    if (usage.user.weightedSeconds >= caps.userMonthlyHours * 3_600) reasons.push('user_hours_cap');
    if (usage.global.weightedSeconds >= caps.globalMonthlyHours * 3_600) reasons.push('global_hours_cap');
    if (usage.user.egressBytes >= caps.userMonthlyEgressGb * BYTES_PER_GB) reasons.push('user_egress_cap');
    if (usage.global.egressBytes >= caps.globalMonthlyEgressGb * BYTES_PER_GB) reasons.push('global_egress_cap');
    let region: string | undefined;
    if (input.region?.kind === 'create') {
        region = config.regions.find((r) => regionRunningVcpu(counters, r.name) + requestedVcpu <= r.maxRunning * 2)?.name;
        if (region === undefined) reasons.push('region_capacity');
    } else if (input.region?.kind === 'lease') {
        const home = input.region.region;
        const configured = home === null ? undefined : config.regions.find((r) => r.name === home);
        if (configured === undefined) reasons.push('region_not_configured');
        else if (regionRunningVcpu(counters, configured.name) + requestedVcpu > configured.maxRunning * 2) reasons.push('region_capacity');
        else region = configured.name;
    }
    if (reasons.length > 0) return { admit: false, reason: reasons[0]!, reasons };
    return region === undefined ? { admit: true } : { admit: true, region };
}

export type AdmissionRequest =
    /** `userId` is the AUTHENTICATED session user; on create it becomes `owner_user_id`. */
    | {
          kind: 'lease';
          userId: string;
          computerId: string;
          expected: { generation: number; leaseEpoch: number };
          leaseUntil: Date;
          replace?: boolean;
          /** A paid plan change always replaces; admission reserves the new tier's vCPU. */
          resizeTo?: Exclude<AwsTier, 'free'>;
          /** Recorded in the lease's own compare-and-swap (this boot's job, fence and enrollment nonce hash). */
          fields?: PlacementFields;
      }
    /**
     * `tier` sizes the computer (`AWS_TIERS`); admission, not the caller,
     * chooses its region, so `fields.region` / `fields.instanceType` are ignored.
     */
    | {
          kind: 'create';
          userId: string;
          computerId: string;
          tier: AwsTier;
          fields?: PlacementFields;
          /**
           * Fields that depend on the region admission chose (the provision's job,
           * digest and zone), computed inside the admission transaction once the
           * region is known. Throwing aborts the transaction: nothing is written.
           */
          fieldsFor?: (region: string) => PlacementFields;
      };

export type AdmissionOutcome =
    | { admitted: true; placement: Placement }
    | { admitted: false; reason: AdmissionRefusal | 'cas_conflict' | 'placement_exists' | 'capacity_waiting'; reasons?: AdmissionRefusal[] };

export interface AdmissionDeps {
    env?: Env;
    now?: () => Date;
}

/**
 * Would admission admit a NEW aws-ec2 computer for this user right now? Read-only and
 * unlocked (`peekAdmissionCounters`), the same rules as `runAdmission` for a create
 * (config enabled, kill switch, ownership, running caps per region, one AWS computer
 * per user, monthly caps). Used to keep a canary computer on Cloudflare instead of
 * routing it to AWS only to be refused. Not a reservation: admission re-decides
 * under its lock, and a lost race refuses as before (no row written).
 */
export async function precheckAdmission(
    db: PlacementExecutor,
    input: { userId: string; computerId: string; tier?: AwsTier; env?: Env; now?: Date },
): Promise<AdmissionDecision> {
    const config = readAwsAdmissionConfig(input.env ?? process.env);
    if (!config.enabled) return { admit: false, reason: config.reason, reasons: [config.reason] };
    const now = input.now ?? new Date();
    const counters = await peekAdmissionCounters(db, { userId: input.userId, computerId: input.computerId, monthStart: utcMonthStart(now), now });
    return decideAdmission({ config, counters, userId: input.userId, now, region: { kind: 'create' }, instanceType: instanceTypeForTier(input.tier ?? 'free') });
}

export async function runAdmission(db: PlacementDb, request: AdmissionRequest, deps: AdmissionDeps = {}): Promise<AdmissionOutcome> {
    const config = readAwsAdmissionConfig(deps.env ?? process.env);
    if (!config.enabled) return { admitted: false, reason: config.reason, reasons: [config.reason] };
    const now = (deps.now ?? (() => new Date()))();

    // An unknown tier refuses before any statement: never a default size.
    const requestedTier = request.kind === 'create' ? request.tier : request.resizeTo;
    if ((request.kind === 'create' || requestedTier !== undefined) &&
        (!isAwsTier(requestedTier) || (request.kind === 'lease' && requestedTier === 'free'))) {
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
        const placement = request.kind === 'lease' ? (await readPlacement(tx, request.computerId)).record : null;
        if (request.kind === 'lease' && placement &&
            (placement.generation !== request.expected.generation || placement.leaseEpoch !== request.expected.leaseEpoch)) {
            return { admitted: false, reason: 'cas_conflict' };
        }
        const replace = request.kind === 'lease' && (request.replace || request.resizeTo !== undefined);
        const region: RegionPlan =
            request.kind === 'create' ? { kind: 'create' } : { kind: 'lease', region: placement?.region ?? null };
        // A resize or enrollment recovery replaces its own running slot. Count the
        // new type below, without charging both old and new vCPU against capacity.
        if (request.kind === 'lease' && replace && placement?.provider === 'aws-ec2' &&
            ((placement.state === 'UNCONFIRMED' && placement.lastError === ENROLLMENT_FAILED) ||
                (placement.state === 'RUNNING' && request.resizeTo !== undefined)) && placement.region &&
            placement.generation === request.expected.generation && placement.leaseEpoch === request.expected.leaseEpoch) {
            counters.runningCount = Math.max(0, counters.runningCount - 1);
            const reusedVcpu = instanceVcpu(placement.instanceType);
            counters.runningVcpu = Math.max(0, counters.runningVcpu - reusedVcpu);
            counters.runningVcpuByRegion = {
                ...counters.runningVcpuByRegion,
                [placement.region]: Math.max(0, (counters.runningVcpuByRegion[placement.region] ?? 0) - reusedVcpu),
            };
            counters.runningByRegion = {
                ...counters.runningByRegion,
                [placement.region]: Math.max(0, (counters.runningByRegion[placement.region] ?? 0) - 1),
            };
        }
        const instanceType = request.kind === 'create' ? instanceTypeForTier(request.tier)
            : request.resizeTo !== undefined ? instanceTypeForTier(request.resizeTo) : placement?.instanceType;
        const decision = decideAdmission({ config, counters, userId: request.userId, now, region, instanceType });
        if (!decision.admit) return { admitted: false, reason: decision.reason, reasons: decision.reasons };

        // The only place a ticket is minted: after the decision admitted this exact request.
        const ticket = mintAdmissionTicket(tx, lock, { computerId: request.computerId, userId: request.userId, kind: request.kind });
        const result =
            request.kind === 'lease'
                ? await leasePlacement(tx, lock, ticket, {
                      computerId: request.computerId,
                      ownerUserId: request.userId,
                      expected: request.expected,
                      leaseUntil: request.leaseUntil,
                      replace,
                      resizeInstanceType: request.resizeTo !== undefined ? instanceType! : undefined,
                      fields: request.fields,
                  })
                : await createAwsPlacement(tx, lock, ticket, {
                      computerId: request.computerId,
                      ownerUserId: request.userId,
                      fields: {
                          ...request.fields,
                          ...request.fieldsFor?.(decision.region!),
                          // Admission's own decisions always win over caller-supplied fields.
                          region: decision.region!,
                          instanceType: instanceTypeForTier(request.tier),
                      },
                  });
        if (!result.ok) return { admitted: false, reason: result.reason === 'illegal_transition' ? 'cas_conflict' : result.reason };
        return { admitted: true, placement: result.placement };
    });
}
