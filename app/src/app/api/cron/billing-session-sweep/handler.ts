import { reconcilePaidCloudflareUsers } from '@/server/lib/compute/provider-migrate-reconcile';
import { advanceStaleMigrations } from '@/server/lib/compute/provider-migrate-orchestrator';
import type { BillingDeps, StoredComputeEpoch } from '@/server/billing/ports';
import { drainAiCreditOutbox } from '@/server/billing/ai-credit-outbox';
import { billingMeteringActive, loadComputeBillingState, type ComputeBillingState } from '@/server/billing/v2/compute-access';
import type { ComputerRef } from '@/server/lib/compute/provider';
import type { PolicyStopReason, StopOutcome } from '@/server/lib/compute/stop-policy';

type SweepReason = Exclude<PolicyStopReason, 'user_stop'>;
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;
const RETRY_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface BillingSessionSweepCounts {
    examined: number;
    /** Successful stop calls, including retries. */
    stopped: number;
    /** All newly closed epochs; heartbeatClosed and awsStaleClosed are subsets. */
    closed: number;
    stopFailed: number;
    heartbeatClosed: number;
    retried: number;
    shadow: number;
    /** Round 3 D9: open AWS epochs whose computer is proven not running (stop receipt never arrived). */
    awsStaleClosed?: number;
    /** Round 3 D6: the AI credit outbox drain of this sweep. */
    ai?: { drained: number; delivered: number; retried: number; failed: number };
}

/** Placement evidence for a stale AWS epoch; `stoppedAt` is the provider-observed stop, when recorded. */
export type AwsStopProof = (computer: ComputerRef) => Promise<{ running: boolean; stoppedAt: Date | null }>;

export async function handleBillingSessionSweep({ deps, now, stop, isStillRunning, awsStopProof, limit = 50 }: {
    deps: BillingDeps;
    now: Date;
    stop: (computer: ComputerRef, reason: SweepReason) => Promise<StopOutcome>;
    isStillRunning: (computer: ComputerRef) => Promise<boolean>;
    /** Placement proof for stale AWS epochs (with the proven stop time); omitted = no AWS stale closes. */
    awsStopProof?: AwsStopProof;
    limit?: number;
}): Promise<BillingSessionSweepCounts> {
    const startedAt = Date.now();
    const counts = { examined: 0, stopped: 0, closed: 0, stopFailed: 0, heartbeatClosed: 0, retried: 0, shadow: 0, awsStaleClosed: 0,
        ai: { drained: 0, delivered: 0, retried: 0, failed: 0 } };
    const drain = async () => {
        try {
            const drained = await drainAiCreditOutbox(deps, { limit: 25, deadlineMs: startedAt + 40_000 });
            counts.ai = { drained: drained.claimed, delivered: drained.done, retried: drained.retry, failed: drained.failed };
        } catch { console.warn('[billing.ai] outbox sweep unavailable'); }
    };
    const finish = () => {
        console.info(JSON.stringify({ event: 'billing-sweep', ...counts }));
        return counts;
    };
    if (!billingMeteringActive(deps.config)) { await drain(); return finish(); }

    const epochs = await deps.store.openEpochsForSweep({ limit });
    counts.examined = epochs.length;
    const policyCandidates: StoredComputeEpoch[] = [];
    // An AWS heartbeat only proves the owner was present, never that the host stopped: a stale
    // AWS epoch closes only on placement proof, at the proven stop time, else its last heartbeat.
    // `isStillRunning` is not proof (the route maps read errors to false), so without
    // `awsStopProof` AWS epochs keep the policy path only.
    async function provenStop(epoch: StoredComputeEpoch, heartbeat: Date): Promise<Date | null> {
        if (!awsStopProof) return null;
        try {
            const proof = await awsStopProof({ userId: epoch.userId, computerId: epoch.computerId });
            if (proof.running !== false) return null;
            const stoppedAt = proof.stoppedAt?.getTime();
            return stoppedAt !== undefined && Number.isFinite(stoppedAt) && stoppedAt >= Date.parse(epoch.readyAt)
                ? new Date(Math.min(stoppedAt, now.getTime())) : heartbeat;
        } catch {
            return null; // Unknown placement state never closes metered time.
        }
    }
    // Correct stale Cloudflare usage before caching monthly state. The Worker
    // already idles these containers; this is accounting, even in shadow mode.
    for (const epoch of epochs) {
        const heartbeat = new Date(epoch.lastHeartbeatAt ?? epoch.readyAt);
        const stale = heartbeat.getTime() < now.getTime() - HEARTBEAT_STALE_MS;
        if (epoch.size === 'free-cf' && stale) {
            if (await deps.store.closeEpoch({ computerId: epoch.computerId, epochId: epoch.id, endedAt: heartbeat, reason: 'idle_sleep' }) === 'closed') {
                counts.closed++;
                counts.heartbeatClosed++;
            }
            continue;
        }
        const stoppedAt = epoch.size !== 'free-cf' && stale ? await provenStop(epoch, heartbeat) : null;
        if (stoppedAt === null) { policyCandidates.push(epoch); continue; }
        // 'provider_stop' (the AWS receipt's own reason): the end-reason check allows no new value without a migration.
        if (await deps.store.closeEpoch({ computerId: epoch.computerId, epochId: epoch.id, endedAt: stoppedAt, reason: 'provider_stop' }) === 'closed') {
            counts.closed++;
            counts.awsStaleClosed++;
            console.info(JSON.stringify({ event: 'billing-sweep-close', cause: 'sweep_stale', epochId: epoch.id,
                computerId: epoch.computerId, endedAt: stoppedAt.toISOString(), proven: stoppedAt !== heartbeat }));
        }
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
        const state = await stateFor(epoch.userId);
        const maximum = state.sessionMaxSeconds === null ? Infinity : Date.parse(epoch.readyAt) + state.sessionMaxSeconds * 1000;
        const storedDeadline = state.sessionMaxSeconds === null && state.summary.version === 3
            ? state.summary.computer.activeDeadline : epoch.deadlineAt;
        const stored = storedDeadline === null ? Infinity : Date.parse(storedDeadline);
        // Round 6 R1-04: a session opened on a paid plan with no session cap (its stored deadline lies past this
        // plan's cap) and still open on Free ends at the drop: its recorded time, else now (the sweep runs every
        // minute), never back-dated to ready + 1 h, and never before the Free hour itself.
        const paidEra = state.planSku === 'free_v3' && maximum !== Infinity && stored > maximum + 1000;
        const dropAt = state.freeSince ? Math.min(Date.parse(state.freeSince), now.getTime()) : now.getTime();
        const deadline = paidEra ? Math.max(maximum, dropAt) : Math.min(maximum, stored);
        const due = now.getTime() >= deadline;
        const overageOn = state.family === 'compute' && state.overage?.enabled === true;
        // Round 6 CR-1: store.ts rounds readiness up and the deadline down to whole seconds, so a session cut by the
        // cap can be stored one second short of ready + cap (05:42:01 → 06:42:00). That bound is still the cap unless
        // the allowance is spent (used is clamped at deadline_at); an allowance bound sits a full second or more lower.
        const sessionCut = deadline >= maximum - 1000 && (overageOn || state.usedStdSeconds < state.allowanceStdSeconds);
        let reason: SweepReason;
        if (state.paymentIssue) reason = 'allowance_exhausted';
        else if (state.sessionMaxSeconds !== null && due && sessionCut) reason = 'session_max';
        else {
            if (!due) {
                const exhausted = overageOn
                    ? (state.summary.version === 2 ? state.summary.overage?.accruedCents ?? 0 : 0) >= state.overage!.capCents
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
            if (await deps.store.closeEpoch({ computerId: epoch.computerId, epochId: epoch.id, endedAt, reason }) === 'closed') counts.closed++;
        }
    }

    if (deps.config.enforcementEnabled) {
        const recent = await deps.store.policyClosedEpochsSince(new Date(now.getTime() - RETRY_WINDOW_MS), limit);
        for (const epoch of recent) {
            if (attempted.has(epoch.computerId)) continue;
            // A close under the retired paid cap must not stop a still-running job.
            if (epoch.endReason === 'session_max' && (await stateFor(epoch.userId)).sessionMaxSeconds === null) continue;
            const computer = { userId: epoch.userId, computerId: epoch.computerId };
            let running = false;
            try { running = await isStillRunning(computer); } catch { /* No blind retries on an unavailable status. */ }
            if (!running) continue;
            counts.retried++;
            await tryStop(computer, epoch.endReason as SweepReason);
        }
    }
    await advanceStaleMigrations(startedAt);
    await reconcilePaidCloudflareUsers(startedAt);
    await drain();
    return finish();
}
