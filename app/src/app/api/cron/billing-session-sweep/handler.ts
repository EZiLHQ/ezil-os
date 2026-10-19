import type { BillingDeps, StoredComputeEpoch } from '@/server/billing/ports';
import { billingMeteringActive, loadComputeBillingState, type ComputeBillingState } from '@/server/billing/v2/compute-access';
import { SESSION_MAX_SECONDS } from '@/server/billing/v2/contract';
import type { ComputerRef } from '@/server/lib/compute/provider';
import type { PolicyStopReason, StopOutcome } from '@/server/lib/compute/stop-policy';

type SweepReason = Exclude<PolicyStopReason, 'user_stop'>;
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;
const RETRY_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface BillingSessionSweepCounts {
    examined: number;
    /** Successful stop calls, including retries. */
    stopped: number;
    /** All newly closed epochs; heartbeatClosed is a subset. */
    closed: number;
    stopFailed: number;
    heartbeatClosed: number;
    retried: number;
    shadow: number;
}

export async function handleBillingSessionSweep({ deps, now, stop, isStillRunning, limit = 50 }: {
    deps: BillingDeps;
    now: Date;
    stop: (computer: ComputerRef, reason: SweepReason) => Promise<StopOutcome>;
    isStillRunning: (computer: ComputerRef) => Promise<boolean>;
    limit?: number;
}): Promise<BillingSessionSweepCounts> {
    const counts = { examined: 0, stopped: 0, closed: 0, stopFailed: 0, heartbeatClosed: 0, retried: 0, shadow: 0 };
    if (!billingMeteringActive(deps.config)) return counts;

    const epochs = await deps.store.openEpochsForSweep({ limit });
    counts.examined = epochs.length;
    const policyCandidates: StoredComputeEpoch[] = [];
    // Correct stale Cloudflare usage before caching monthly state. The Worker
    // already idles these containers; this is accounting, even in shadow mode.
    for (const epoch of epochs) {
        const heartbeat = new Date(epoch.lastHeartbeatAt ?? epoch.readyAt);
        if (epoch.size === 'free-cf' && heartbeat.getTime() < now.getTime() - HEARTBEAT_STALE_MS) {
            if (await deps.store.closeEpoch({ computerId: epoch.computerId, endedAt: heartbeat, reason: 'idle_sleep' }) === 'closed') {
                counts.closed++;
                counts.heartbeatClosed++;
            }
        } else policyCandidates.push(epoch);
    }

    const states = new Map<string, Promise<ComputeBillingState>>();
    function stateFor(userId: string) {
        let state = states.get(userId);
        if (!state) {
            state = loadComputeBillingState(deps, userId, now);
            states.set(userId, state);
        }
        return state;
    }
    const attempted = new Set<string>();
    async function tryStop(computer: ComputerRef, reason: SweepReason) {
        attempted.add(computer.computerId);
        try {
            const outcome = await stop(computer, reason);
            if (outcome.result.ok) counts.stopped++;
            else counts.stopFailed++;
        } catch (error) {
            counts.stopFailed++;
            console.warn('[billing.sweep] stop failed', { ...computer, reason, error });
        }
    }

    for (const epoch of policyCandidates) {
        const maximum = Date.parse(epoch.readyAt) + SESSION_MAX_SECONDS * 1000;
        const deadline = Math.min(maximum, epoch.deadlineAt === null ? maximum : Date.parse(epoch.deadlineAt));
        const due = now.getTime() >= deadline;
        let reason: SweepReason;
        if (due && deadline === maximum) reason = 'session_max';
        else {
            const state = await stateFor(epoch.userId);
            const overageOn = state.family === 'compute' && state.overage?.enabled === true;
            if (!due) {
                const exhausted = overageOn
                    ? (state.summary.overage?.accruedCents ?? 0) >= state.overage!.capCents
                    : state.usedStdSeconds >= state.allowanceStdSeconds;
                if (!exhausted) continue;
            }
            reason = overageOn ? 'overage_cap' : 'allowance_exhausted';
        }
        const computer = { userId: epoch.userId, computerId: epoch.computerId };
        const endedAt = new Date(Math.min(now.getTime(), deadline));
        if (!deps.config.enforcementEnabled) {
            console.info('[billing.sweep] shadow', { ...computer, epochId: epoch.id, reason, endedAt });
            counts.shadow++;
            continue;
        }
        // Failed/asynchronous provider stops never extend a billable session.
        try {
            await tryStop(computer, reason);
        } finally {
            if (await deps.store.closeEpoch({ computerId: epoch.computerId, endedAt, reason }) === 'closed') counts.closed++;
        }
    }

    if (deps.config.enforcementEnabled) {
        const recent = await deps.store.policyClosedEpochsSince(new Date(now.getTime() - RETRY_WINDOW_MS), limit);
        for (const epoch of recent) {
            if (attempted.has(epoch.computerId)) continue;
            const computer = { userId: epoch.userId, computerId: epoch.computerId };
            let running = false;
            try { running = await isStillRunning(computer); } catch { /* No blind retries on an unavailable status. */ }
            if (!running) continue;
            counts.retried++;
            await tryStop(computer, epoch.endReason as SweepReason);
        }
    }
    return counts;
}
