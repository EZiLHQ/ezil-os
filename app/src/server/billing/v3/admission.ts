import { epochSeconds, isoSeconds } from '../v2/time';
import { SIZES, type SizeCode } from '../v2/contract';
import { AWS_MONTHLY_CAP_REASON } from '../../lib/compute/usage';
import { CATALOG_V3, type AdmitStartV3, type AdmitDecisionV3, type FairUseStatusOf } from './contract';

export const fairUseStatusOf: FairUseStatusOf = ({ usedSeconds, fairUseSeconds }) => {
    if (usedSeconds >= fairUseSeconds) return 'paused';
    return BigInt(usedSeconds) * BigInt(5) >= BigInt(fairUseSeconds) * BigInt(4) ? 'near' : 'ok';
};

// Extend admission locally while the wire contract remains pinned by the lead.
export const admitStart = (input: Parameters<AdmitStartV3>[0] & { size?: SizeCode }):
    AdmitDecisionV3 | { admit: false; reason: 'size_not_allowed' } => {
    if (input.sku === null || !input.planActive) return { admit: false, reason: 'no_plan' };
    if (input.paymentIssue) return { admit: false, reason: 'payment_issue' };
    if (input.runningComputers >= 1) return { admit: false, reason: 'concurrent_limit' };
    const offer = CATALOG_V3[input.sku];
    const size = input.size ?? offer.size;
    if (!offer.machineChoice.includes(size)) return { admit: false, reason: 'size_not_allowed' };
    const fairUse = input.legacyFree ? offer.legacyFairUseSeconds ?? offer.fairUseSeconds : offer.fairUseSeconds;
    const maxRunSeconds = Math.min(offer.sessionMaxSeconds ?? Infinity, Math.floor(Math.max(0, fairUse - input.usedSeconds) / SIZES[size].weight));
    if (maxRunSeconds < 60) return { admit: false, reason: 'fair_use_paused' };
    return { admit: true, size, maxRunSeconds,
        deadline: isoSeconds(epochSeconds(input.now) + maxRunSeconds),
        fromPool: offer.poolPriority > 0 && input.poolHostAvailable, poolPriority: offer.poolPriority };
};

/**
 * Round 3 D11: the AWS usage-ledger backstop (`ezil_compute_usage`) refuses with its own
 * code, never as fair use: the plan can show time left while the operator cap is reached.
 * The plan's own refusals keep precedence; Cloudflare starts are never affected.
 */
export const admitStartWithAwsCap = (input: Parameters<typeof admitStart>[0] & { awsMonthlyCapReached: boolean }):
    ReturnType<typeof admitStart> | { admit: false; reason: typeof AWS_MONTHLY_CAP_REASON } => {
    const decision = admitStart(input);
    return decision.admit && input.awsMonthlyCapReached && SIZES[decision.size].provider === 'aws'
        ? { admit: false, reason: AWS_MONTHLY_CAP_REASON } : decision;
};
