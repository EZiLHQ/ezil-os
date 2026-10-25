import {
    AI_PACKS,
    CATALOG_VERSION,
    catalogPro,
    storageCapBytes,
    workspaceAllowanceSeconds,
} from './catalog';
import { checkoutAvailable, type BillingConfig } from './config';
import type { BillingSummaryEnabled, MeterState, PlanId, PlanStatus } from './types';

/** Structural rows let callers pass database records without coupling meters to the database. */
export interface SubscriptionRow {
    stripeSubscriptionId: string;
    status: string;
    sku: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
}

export interface IntervalRow {
    startedAt: Date;
    endedAt: Date | null;
    /**
     * Last heartbeat for an open interval. A Worker that dies without sending
     * `stop` leaves the interval open; it then stops counting
     * `OPEN_INTERVAL_GRACE_MS` after this instant instead of running to `now`
     * until the reconciler closes it.
     */
    lastSeenAt?: Date;
}

/** How long an open interval keeps counting past its last heartbeat. */
export const OPEN_INTERVAL_GRACE_MS = 15 * 60_000;

function openIntervalEnd(interval: IntervalRow, now: Date): number {
    if (interval.endedAt) return interval.endedAt.getTime();
    if (!interval.lastSeenAt) return now.getTime();
    return Math.min(now.getTime(), interval.lastSeenAt.getTime() + OPEN_INTERVAL_GRACE_MS);
}

type Window = { start: Date; end: Date };

/** UTC calendar boundaries keep Free's allowance independent of the server's timezone. */
export function freeWindow(now: Date): Window {
    const start = new Date(now);
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return { start, end };
}

/**
 * Clip before rounding so time outside the allowance window cannot consume it.
 * Round each computer interval separately: concurrent computers both count.
 */
export function workspaceUsedSeconds(intervals: IntervalRow[], window: Window, now: Date): number {
    return intervals.reduce((total, interval) => {
        const start = Math.max(interval.startedAt.getTime(), window.start.getTime());
        const end = Math.min(openIntervalEnd(interval, now), window.end.getTime());
        const durationMs = Math.max(0, end - start);
        return total + Math.ceil(durationMs / 60_000) * 60;
    }, 0);
}

export function workspaceState(remaining: number, allowance: number): MeterState {
    if (remaining <= 0) return 'exhausted';
    if (remaining <= allowance * 0.2) return 'low';
    return 'ok';
}

/** Integer comparisons preserve exact thresholds even above JavaScript's safe number range. */
export function storageState(used: bigint, cap: bigint): MeterState {
    if (used > cap) return 'over_cap';
    if (used * BigInt(100) >= cap * BigInt(95)) return 'exhausted';
    if (used * BigInt(100) >= cap * BigInt(80)) return 'low';
    return 'ok';
}

/**
 * Only a current active/trialing period grants Pro. Delinquent subscriptions
 * keep their billing status while using Free's calendar window and allowance.
 * Recency is measured by period end without reordering the caller's rows.
 */
export function resolvePlan(subs: SubscriptionRow[], now: Date): {
    plan: PlanId;
    status: PlanStatus;
    window: Window;
    renewsAt: Date | null;
    cancelsAt: Date | null;
} {
    let selected: SubscriptionRow | undefined;
    for (const sub of subs) {
        const current = (sub.status === 'active' || sub.status === 'trialing')
            && sub.currentPeriodStart !== null
            && sub.currentPeriodEnd !== null
            && now.getTime() >= sub.currentPeriodStart.getTime()
            && now.getTime() < sub.currentPeriodEnd.getTime();
        const pastDue = sub.status === 'past_due' || sub.status === 'unpaid';
        if (!current && !pastDue) continue;
        if (!selected || (sub.currentPeriodEnd?.getTime() ?? -Infinity)
            > (selected.currentPeriodEnd?.getTime() ?? -Infinity)) {
            selected = sub;
        }
    }

    if (selected && (selected.status === 'active' || selected.status === 'trialing')
        && selected.currentPeriodStart !== null && selected.currentPeriodEnd !== null) {
        return {
            plan: 'pro',
            status: selected.cancelAtPeriodEnd ? 'cancels' : 'active',
            window: { start: selected.currentPeriodStart, end: selected.currentPeriodEnd },
            renewsAt: selected.cancelAtPeriodEnd ? null : selected.currentPeriodEnd,
            cancelsAt: selected.cancelAtPeriodEnd ? selected.currentPeriodEnd : null,
        };
    }

    return {
        plan: 'free',
        status: selected ? 'past_due' : 'free',
        window: freeWindow(now),
        renewsAt: null,
        cancelsAt: null,
    };
}

/**
 * The shell consumes plain JSON, so dates and bigint balances are serialized
 * here. Storage callers supply the latest sample for each unpurged computer.
 * AI balances and purchases stay unavailable until the Gateway ledger is live.
 */
export function buildSummary(input: {
    config: BillingConfig;
    now: Date;
    subs: SubscriptionRow[];
    intervals: IntervalRow[];
    storage: { computerId: string; bytes: bigint; measuredAt: Date }[];
}): BillingSummaryEnabled {
    const { config, now, subs, intervals, storage } = input;
    const resolved = resolvePlan(subs, now);
    const allowanceSeconds = workspaceAllowanceSeconds(resolved.plan);
    const usedSeconds = workspaceUsedSeconds(intervals, resolved.window, now);
    const remainingSeconds = Math.max(0, allowanceSeconds - usedSeconds);
    const capBytes = storageCapBytes(resolved.plan, config.largeStorageEnabled);
    // Only the newest sample per computer counts, even if a caller passes
    // history: storage is a level, not a flow, so summing samples over time
    // would multiply it.
    const newest = new Map<string, { bytes: bigint; measuredAt: Date }>();
    for (const sample of storage) {
        const seen = newest.get(sample.computerId);
        if (!seen || sample.measuredAt.getTime() > seen.measuredAt.getTime()) newest.set(sample.computerId, sample);
    }
    let usedBytes = BigInt(0);
    let measuredAt: Date | null = null;
    for (const sample of newest.values()) {
        usedBytes += sample.bytes;
        if (measuredAt === null || sample.measuredAt.getTime() > measuredAt.getTime()) {
            measuredAt = sample.measuredAt;
        }
    }
    const checkout = checkoutAvailable(config);

    return {
        enabled: true,
        version: CATALOG_VERSION,
        plan: {
            id: resolved.plan,
            status: resolved.status,
            periodStart: resolved.window.start.toISOString(),
            periodEnd: resolved.window.end.toISOString(),
            renewsAt: resolved.renewsAt?.toISOString() ?? null,
            cancelsAt: resolved.cancelsAt?.toISOString() ?? null,
        },
        meters: {
            workspace: {
                usedSeconds,
                allowanceSeconds,
                remainingSeconds,
                resetsAt: resolved.window.end.toISOString(),
                state: workspaceState(remainingSeconds, allowanceSeconds),
            },
            storage: {
                usedBytes: usedBytes.toString(),
                capBytes: capBytes.toString(),
                state: storageState(usedBytes, capBytes),
                measuredAt: measuredAt?.toISOString() ?? null,
            },
            ai: {
                state: 'unavailable',
                trialMicro: '0',
                includedMicro: '0',
                purchasedMicro: '0',
                includedExpiresAt: null,
            },
        },
        actions: {
            checkout,
            portal: checkout && (resolved.plan === 'pro' || resolved.status === 'past_due'),
            topup: false,
        },
        catalog: {
            pro: catalogPro(),
            packs: AI_PACKS.map(pack => ({ ...pack })),
        },
    };
}
