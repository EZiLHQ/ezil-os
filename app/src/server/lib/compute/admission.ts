/**
 * AWS admission (docs/AWS-COMPUTERS.md C-3 "Leasing and admission", §4, R9).
 *
 * One READ COMMITTED transaction:
 *   1. `takeAdmissionLock` — the global advisory lock, FIRST statement.
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
    takeAdmissionLock,
    createAwsPlacement,
    leasePlacement,
    readAdmissionCounters,
    type AdmissionCounters,
    type Placement,
    type PlacementDb,
    type PlacementFields,
} from './placement';
import { readAwsAdmissionConfig, type AwsAdmissionConfig, type Env } from './aws-config';
import { BYTES_PER_GB, summarizeUsage, utcMonthStart } from './usage';

export type AdmissionRefusal =
    | 'aws_disabled'
    | 'aws_config_invalid'
    | 'computer_not_owned'
    | 'kill_switch'
    | 'duplicate_placement'
    | 'max_running'
    | 'user_has_aws_computer'
    | 'user_hours_cap'
    | 'global_hours_cap'
    | 'user_egress_cap'
    | 'global_egress_cap';

export type AdmissionDecision = { admit: true } | { admit: false; reason: AdmissionRefusal; reasons: AdmissionRefusal[] };

/**
 * Pure. Refusals in a fixed priority order; `reason` is the first and
 * `reasons` all of them. Every comparison is `>=`: reaching a cap refuses.
 */
export function decideAdmission(input: {
    config: AwsAdmissionConfig;
    counters: Pick<AdmissionCounters, 'targetOwnerId' | 'runningCount' | 'userOtherAwsComputers' | 'duplicates' | 'usage'>;
    userId: string;
    now: Date;
}): AdmissionDecision {
    const { config, counters } = input;
    if (!config.enabled) return { admit: false, reason: config.reason, reasons: [config.reason] };
    const { caps } = config;
    const usage = summarizeUsage(counters.usage, input.userId, input.now);
    const reasons: AdmissionRefusal[] = [];
    // The caller's pair is re-checked here: caps are per user, so admitting
    // for a computer the user does not own would bypass them.
    if (counters.targetOwnerId === null || counters.targetOwnerId.toLowerCase() !== input.userId.toLowerCase()) reasons.push('computer_not_owned');
    if (config.killSwitch) reasons.push('kill_switch');
    if (counters.duplicates.length > 0) reasons.push('duplicate_placement');
    if (counters.runningCount >= caps.maxRunning) reasons.push('max_running');
    if (counters.userOtherAwsComputers >= 1) reasons.push('user_has_aws_computer');
    if (usage.user.hours >= caps.userMonthlyHours) reasons.push('user_hours_cap');
    if (usage.global.hours >= caps.globalMonthlyHours) reasons.push('global_hours_cap');
    if (usage.user.egressBytes >= caps.userMonthlyEgressGb * BYTES_PER_GB) reasons.push('user_egress_cap');
    if (usage.global.egressBytes >= caps.globalMonthlyEgressGb * BYTES_PER_GB) reasons.push('global_egress_cap');
    return reasons.length === 0 ? { admit: true } : { admit: false, reason: reasons[0]!, reasons };
}

export type AdmissionRequest =
    | { kind: 'lease'; userId: string; computerId: string; expected: { generation: number; leaseEpoch: number }; leaseUntil: Date; replace?: boolean }
    | { kind: 'create'; userId: string; computerId: string; fields?: PlacementFields };

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

    return db.transaction(async (tx) => {
        const lock = await takeAdmissionLock(tx);
        const counters = await readAdmissionCounters(tx, lock, {
            userId: request.userId,
            computerId: request.computerId,
            monthStart: utcMonthStart(now),
            now,
        });
        const decision = decideAdmission({ config, counters, userId: request.userId, now });
        if (!decision.admit) return { admitted: false, reason: decision.reason, reasons: decision.reasons };

        const result =
            request.kind === 'lease'
                ? await leasePlacement(tx, lock, {
                      computerId: request.computerId,
                      expected: request.expected,
                      leaseUntil: request.leaseUntil,
                      replace: request.replace,
                  })
                : await createAwsPlacement(tx, lock, { computerId: request.computerId, fields: request.fields });
        if (!result.ok) return { admitted: false, reason: result.reason === 'illegal_transition' ? 'cas_conflict' : result.reason };
        return { admitted: true, placement: result.placement };
    });
}
