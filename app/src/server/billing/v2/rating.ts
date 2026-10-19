import {
    CATALOG_V2,
    MIN_START_ACTUAL_SECONDS,
    OVERAGE_MAX_CAP_CENTS,
    SESSION_MAX_SECONDS,
    SIZES,
    STD_SECONDS_PER_OVERAGE_CENT,
    type AdmitStart,
    type RatePeriod,
    type RateWindow,
    type UpgradeGrantStdSeconds,
    type WindowUsage,
} from './contract';
import { epochSeconds, isoSeconds } from './time';

export const rateWindow: RateWindow = ({ epochs, window, now }) => {
    const start = epochSeconds(window.start);
    const end = epochSeconds(window.end);
    const current = epochSeconds(now);
    const usage: WindowUsage = { actualSecondsBySize: {}, stdSeconds: 0 };

    for (const epoch of epochs) {
        const weight = SIZES[epoch.size].weight;
        if (epoch.weight !== weight) throw new RangeError('Epoch weight does not match its size');
        const ready = epochSeconds(epoch.readyAt, 'ceil');
        const ended = epoch.endedAt === null ? current : epochSeconds(epoch.endedAt);
        // Cap before clipping, including closed epochs whose verified stop arrived late.
        const boundedEnd = Math.min(ended, ready + SESSION_MAX_SECONDS);
        const actual = Math.max(0, Math.min(boundedEnd, end) - Math.max(ready, start));
        if (actual === 0) continue;
        usage.actualSecondsBySize[epoch.size] = (usage.actualSecondsBySize[epoch.size] ?? 0) + actual;
        usage.stdSeconds += actual * weight;
    }
    return usage;
};

export const ratePeriod: RatePeriod = ({ usedStdSeconds, allowanceStdSeconds, overage }) => {
    const remainingStdSeconds = Math.max(0, allowanceStdSeconds - usedStdSeconds);
    const overStdSeconds = Math.max(0, usedStdSeconds - allowanceStdSeconds);
    const overageCents = Math.floor(overStdSeconds / STD_SECONDS_PER_OVERAGE_CENT);
    return {
        allowanceStdSeconds,
        usedStdSeconds,
        remainingStdSeconds,
        overStdSeconds,
        overageCents,
        billableOverageCents: overage?.enabled ? Math.min(overageCents, overage.capCents) : 0,
    };
};

export const upgradeGrantStdSeconds: UpgradeGrantStdSeconds = ({
    fromSku, toSku, periodStart, periodEnd, effectiveAt,
}) => {
    const delta = CATALOG_V2[toSku].allowanceStdSeconds - CATALOG_V2[fromSku].allowanceStdSeconds;
    const end = epochSeconds(periodEnd);
    const periodSeconds = end - epochSeconds(periodStart);
    if (delta <= 0 || periodSeconds <= 0) return 0;
    const remaining = Math.min(periodSeconds, Math.max(0, end - epochSeconds(effectiveAt)));
    // The product may exceed Number's exact range even though the grant cannot.
    return Number(BigInt(delta) * BigInt(remaining) / BigInt(periodSeconds));
};

export const admitStart: AdmitStart = ({
    planSku, planActive, paymentIssue, upgradePending, size, usedStdSeconds,
    allowanceStdSeconds, overage, runningComputers, now,
}) => {
    if (planSku === null || !planActive) return { admit: false, reason: 'no_plan' };
    if (paymentIssue) return { admit: false, reason: 'payment_issue' };
    if (upgradePending) return { admit: false, reason: 'upgrade_pending' };
    const offer = CATALOG_V2[planSku];
    if (!offer.sizes.includes(size)) return { admit: false, reason: 'size_not_allowed' };
    if (runningComputers >= offer.maxConcurrentComputers) return { admit: false, reason: 'concurrent_limit' };

    const weight = SIZES[size].weight;
    const overageOn = offer.overage !== null && overage?.enabled === true;
    const capCents = Math.max(0, Math.min(overage?.capCents ?? 0, OVERAGE_MAX_CAP_CENTS));
    const overageSeconds = overageOn ? capCents * STD_SECONDS_PER_OVERAGE_CENT : 0;
    const headroom = Math.max(0, allowanceStdSeconds + overageSeconds - usedStdSeconds);
    const maxActual = Math.floor(headroom / weight);
    if (maxActual < MIN_START_ACTUAL_SECONDS) {
        return { admit: false, reason: overageOn ? 'overage_cap_reached' : 'allowance_exhausted' };
    }
    const maxRunSeconds = Math.min(SESSION_MAX_SECONDS, maxActual);
    return { admit: true, size, weight, maxRunSeconds, deadline: isoSeconds(epochSeconds(now) + maxRunSeconds) };
};
