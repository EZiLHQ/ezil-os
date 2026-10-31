import { reconcilePaidCloudflareUsers } from '@/server/lib/compute/provider-migrate-reconcile';
import { advanceStaleMigrations } from '@/server/lib/compute/provider-migrate-orchestrator';
import { advanceReverseMoves } from '@/server/lib/compute/provider-reverse-runtime';
import { createProviderReverseStore, REVERSE_MOVE_IN_FLIGHT, reverseMovesTablePresent } from '@/server/lib/compute/provider-reverse-store';
import type { PlacementExecutor } from '@/server/lib/compute/placement';
import type { BillingDeps, StoredComputeEpoch } from '@/server/billing/ports';
import type { HeldCandidate } from '@/server/billing/store';
import { drainAiCreditOutbox } from '@/server/billing/ai-credit-outbox';
import { billingMeteringActive, loadComputeBillingState, type ComputeBillingState } from '@/server/billing/v2/compute-access';
import type { ComputerRef } from '@/server/lib/compute/provider';
import type { PolicyStopReason, StopOutcome } from '@/server/lib/compute/stop-policy';

type SweepReason = Exclude<PolicyStopReason, 'user_stop'>;
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;
const RETRY_WINDOW_MS = 2 * 60 * 60 * 1000;
/**
 * Round 6: an AWS epoch opens right after its host goes RUNNING (aws-receipts.ts `step`), and a placement row's
 * `updated_at` is never before that. A RUNNING host whose row last changed longer ago than this, with no open
 * epoch, has none being opened: only then may a stop act on it (the held bound, and the retry: CR-4).
 */
export const RUNNING_GRACE_MS = 2 * 60 * 1000;
/** Round 6 R1-01: ledger rows (AWS computers with a closed newest session) one held page reads, and pages per pass. */
export const HELD_PAGE_SIZE = 100;
export const HELD_PAGES = 10;
/**
 * Round 6 R1-01: the held pass's own time, and the latest it may run into the sweep (from its start), so the
 * migration, reconcile and AI outbox steps after it keep their shared budget (the outbox drain ends at 40 s).
 */
export const HELD_BUDGET_MS = 10_000;
export const HELD_SWEEP_BUDGET_MS = 30_000;

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
    /** Round 6 R1-01: held (Free, files on AWS) hosts still RUNNING with no open session, stopped (or shadowed). */
    heldOverrun?: number;
    /** Round 3 D6: the AI credit outbox drain of this sweep. */
    ai?: { drained: number; delivered: number; retried: number; failed: number };
}

/** Placement evidence for a stale AWS epoch; `stoppedAt` is the provider-observed stop, when recorded. */
export type AwsStopProof = (computer: ComputerRef) => Promise<{ running: boolean; stoppedAt: Date | null }>;

/**
 * Round 6 R1-01: one page of aws-ec2 computers whose newest session is closed and which are RUNNING with nothing in
 * flight (or UNCONFIRMED), found through the billing ledger at any age (store.ts `runningAwsComputersAfterEpochs`);
 * `after` is the previous page's `next` (null first), `next` null on the last page.
 */
export type RunningAwsPlacements = (after: string | null, limit: number) =>
    Promise<{ candidates: readonly HeldCandidate[]; next: string | null }>;

/**
 * Phase B (REVERSE-MOVE-CONTRACT §5.4): whether the computer's NEWEST reverse move is in flight (`requested` … `flipping`).
 * Its export boot is no held session: it never reaches RUNNING, opens no epoch, and sits UNCONFIRMED after its release.
 */
export type ReverseMoveInFlight = (computerId: string) => Promise<boolean>;

/**
 * Phase B (REVERSE-MOVE-CONTRACT §5.4): the held pass's reverse-move read. The 0012 probe runs once per sweep (no 0012 →
 * never in flight: production); then the computer's newest row, in flight or not. A read error throws into the held
 * loop's own catch, which skips the computer (fail closed, never a stop).
 */
export function reverseMoveInFlightFor(executor: PlacementExecutor): ReverseMoveInFlight {
    let present: Promise<boolean> | null = null;
    return async computerId => {
        present ??= reverseMovesTablePresent(executor);
        if (!(await present)) return false;
        const m = await createProviderReverseStore(executor).readByComputer(computerId);
        return m !== null && REVERSE_MOVE_IN_FLIGHT.includes(m.state);
    };
}

export async function handleBillingSessionSweep({ deps, now, stop, isStillRunning, awsStopProof, runningAwsPlacements, reverseMoveInFlight, limit = 50 }: {
    deps: BillingDeps;
    now: Date;
    stop: (computer: ComputerRef, reason: SweepReason) => Promise<StopOutcome>;
    /** `closedAt`: the policy close being retried. A host that stopped after it is a later open, never that session. */
    isStillRunning: (computer: ComputerRef, closedAt: Date) => Promise<boolean>;
    /** Placement proof for stale AWS epochs (with the proven stop time); omitted = no AWS stale closes. */
    awsStopProof?: AwsStopProof;
    /** The held bound's placement read; omitted = no held pass. */
    runningAwsPlacements?: RunningAwsPlacements;
    /** Phase B: the held pass skips a computer in a reverse move; omitted (no 0012, tests) = round 6a's held pass exactly. */
    reverseMoveInFlight?: ReverseMoveInFlight;
    limit?: number;
}): Promise<BillingSessionSweepCounts> {
    const startedAt = Date.now();
    const counts = { examined: 0, stopped: 0, closed: 0, stopFailed: 0, heartbeatClosed: 0, retried: 0, shadow: 0, awsStaleClosed: 0,
        heldOverrun: 0, ai: { drained: 0, delivered: 0, retried: 0, failed: 0 } };
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
    // Phase B: the reverse pass is the LAST step on both paths (§5.4). Only it enforces a move's deadlines, so it runs with
    // metering off too; after drain(), because reconcile and the outbox start no work after + 40 s and the pass may take 90 s.
    if (!billingMeteringActive(deps.config)) { await drain(); await advanceReverseMoves(startedAt); return finish(); }

    // Phase B (§5.4, r7 fixer): the reverse pass runs even when a step below throws (the epoch read, one user's billing
    // state, a close): only it enforces a move's deadlines, and while a row is in flight every open meets the waiting
    // provider. The error still fails the sweep afterwards.
    try {
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
            // Round 6 R2-3: a paid plan (no session cap) whose new period's grant is still on its way is not out of
            // allowance; GRANT_PENDING_SECONDS bounds the wait (compute-access.ts).
            if (state.grantPending) continue;
            const maximum = state.sessionMaxSeconds === null ? Infinity : Date.parse(epoch.readyAt) + state.sessionMaxSeconds * 1000;
            const storedDeadline = state.sessionMaxSeconds === null && state.summary.version === 3
                ? state.summary.computer.activeDeadline : epoch.deadlineAt;
            const stored = storedDeadline === null ? Infinity : Date.parse(storedDeadline);
            // Round 6 R1-04: a session opened on a paid plan with no session cap (its stored deadline lies past this
            // plan's cap) and still open on Free ends at the drop: its recorded time, else now (the sweep runs every
            // minute), never back-dated to ready + 1 h, and never before the Free hour itself. Only a STORED deadline says
            // paid era (openComputeEpochAtReady always stores one): a Worker-opened free-cf epoch has none, and keeps its hour.
            const paidEra = state.planSku === 'free_v3' && storedDeadline !== null && maximum !== Infinity && stored > maximum + 1000;
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
                try { running = await isStillRunning(computer, new Date(epoch.endedAt!)); } catch { /* No blind retries on an unavailable status. */ }
                if (!running) continue;
                counts.retried++;
                await tryStop(computer, epoch.endReason as SweepReason);
            }
        }

        // Round 6 R1-01: a held host (Free, its files still on AWS: the D16 hold) is bounded by its session alone, and
        // the policy pass above sees open sessions only. One still RUNNING with no open epoch is stopped every pass until
        // it is not RUNNING: its session closed but the host never stopped (a stop that left the row RUNNING: a lost CAS,
        // a config failure; also past RETRY_WINDOW_MS), or a later open's epoch never opened (a metering error). A stop
        // refused or failed by Step Functions leaves the row UNCONFIRMED, which nothing here may stop: it is reported
        // (`held-unconfirmed`) for an operator. Candidates come from the billing ledger at any age, paged within
        // HELD_BUDGET_MS; a computer that never had an epoch needs a placement-side lister (placement.ts, C-2). Paid hosts
        // are not touched here: no lapsed-lease stop (ROOT-FLEET-LEASE-INCIDENT-118); their policy closes keep the window.
        if (runningAwsPlacements) {
            const heldDeadline = Math.min(Date.now() + HELD_BUDGET_MS, startedAt + HELD_SWEEP_BUDGET_MS);
            let after: string | null = null;
            for (let page = 0; page < HELD_PAGES; page++) {
                if (Date.now() >= heldDeadline) { console.warn('[billing.sweep] held pass out of time', { page }); break; }
                let read: Awaited<ReturnType<RunningAwsPlacements>>;
                try { read = await runningAwsPlacements(after, HELD_PAGE_SIZE); } catch { console.warn('[billing.sweep] held scan unavailable'); break; }
                for (const candidate of read.candidates) {
                    const computer = { userId: candidate.userId, computerId: candidate.computerId };
                    if (attempted.has(computer.computerId) || now.getTime() - candidate.since.getTime() < RUNNING_GRACE_MS) continue;
                    try {
                        // Phase B (§5.4): a computer whose newest reverse move is in flight is the move's, never a held session: no
                        // held-overrun, no held-unconfirmed, no stop. A throw is the catch below: skipped, never stopped (fail closed).
                        if (reverseMoveInFlight && await reverseMoveInFlight(computer.computerId)) continue;
                        if (await deps.store.openEpochFor(computer.computerId)) continue;
                        const state = await stateFor(computer.userId);
                        // The gate's hold test (compute-access.ts gateComputerStart): Free-effective with an AWS computer.
                        if (!state.v3 || state.provider === 'aws') continue;
                        const closedSeconds = Math.floor((now.getTime() - candidate.closedAt.getTime()) / 1000);
                        if (candidate.state === 'UNCONFIRMED') {
                            console.warn(JSON.stringify({ event: 'held-unconfirmed', computer: computer.computerId.slice(0, 8), closedSeconds }));
                            continue;
                        }
                        counts.heldOverrun++;
                        // 'closed': the closed session's host never stopped (over since that close). 'none': it stopped, and
                        // this later run never opened an epoch (over since the row's last write: at least that long).
                        const session = candidate.stoppedSinceClose ? 'none' : 'closed';
                        console.info(JSON.stringify({ event: 'held-overrun', computer: computer.computerId.slice(0, 8), session,
                            enforced: deps.config.enforcementEnabled,
                            overSeconds: session === 'closed' ? closedSeconds : Math.floor((now.getTime() - candidate.since.getTime()) / 1000) }));
                        if (!deps.config.enforcementEnabled) { counts.shadow++; continue; }
                        await tryStop(computer, 'session_max');
                    } catch {
                        console.warn('[billing.sweep] held check failed', { computer: computer.computerId.slice(0, 8) });
                    }
                }
                if (read.next === null) break;
                after = read.next;
            }
        }
        await advanceStaleMigrations(startedAt);
        await reconcilePaidCloudflareUsers(startedAt);
        await drain();
    } finally {
        await advanceReverseMoves(startedAt);
    }
    return finish();
}
