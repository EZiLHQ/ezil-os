/**
 * Explicit Free access override → the AWS → Cloudflare move (Phase B), reconciled by the billing sweep.
 *
 * An operator's signed `assign` with `access_override: true` and sku `free_v3` (effective-access.ts; the source lane's
 * 0038_operator_access_overrides.sql) makes the account Free while its Stripe billing stays. A paid computer of that
 * account still sits on AWS: this lane moves it onto Free Cloudflare with the EXISTING reverse machine, and it OWNS the
 * AWS stop of such a computer (the sweep's own policy, retry and held-overrun stops defer to it: handler.ts, through
 * `explicitFreeOverrideState`), because those stops are unfenced and the policy pass keeps a paid-era AWS session open
 * until at least the Free hour, while the operator asked for the move now.
 *
 * Bounded and fail-closed, one small pass per sweep (`billing-session-sweep`, before the forward migration steps and the
 * reverse pass, which stays last):
 * - no-op without placement reads, with AWS disabled or the admission kill switch on (a paused rollout), with billing off
 *   (`tabEnabled`: no standing, as `heldStanding`), or without 0019 (`ezil_operator_entitlements`) or 0012
 *   (`ezil_compute_reverse_moves`): nothing is read or written then;
 * - candidates are the account's OWN live computers whose placement is aws-ec2 and ACTIONABLE (RUNNING or STOPPED with
 *   no lifecycle job, no reverse row holding it), joined to a LIVE explicit Free override row
 *   (`to_jsonb(o)->>'access_override' = 'true'`: a database without 0038's column simply yields none), at most
 *   `OVERRIDE_PASS_LIMIT` per pass, within the sweep's shared launch budget. Computers mid-boot, draining, stopping, in
 *   a move or behind a job are not listed (so they never starve the actionable ones); they are picked up once settled.
 *   The pass logs how many such deferred computers the override set has;
 * - a computer with a holding reverse row, forward work, a switch/restart transition or an image reservation is left
 *   alone (the move or the transition owns it);
 * - RUNNING with no job, an open billing session or not: the policy stop (`stopComputerForPolicy`) through routing, with
 *   an `AwsStopGuard` (aws-ec2.ts) that re-reads the override and the conflicts on the exact fresh row right before the
 *   draining compare-and-swap (C-3 then fences owner, generation, lease epoch, state and job). The stop's receipt closes
 *   the open session through the ordinary meter (aws-receipts.ts): no billing write here. A Cloudflare route is never
 *   stopped from here;
 * - STOPPED with no job and no lingering open session: the override is re-read, then `startReverseMove`
 *   (compute-dispatch.ts: the click's own pinned checks, `startedBy: 'cron'`, and its `confirmStart` re-read right before
 *   the create: natural Free after an expired override is not this lane's) creates the durable row the reverse pass
 *   drives. A session still open on a STOPPED row (the receipt not yet applied) defers to the sweep that closes it. A
 *   later upgrade or an expired override ends the move through the machine's own pre-flip standing re-check
 *   (`entitlement_paid`), and a paid owner after the commit gets the forward move (`afterCommit`); no new mechanism here.
 * A per-computer failure is logged and skipped; it never stops the other candidates or the rest of the sweep.
 */
import { sql } from 'drizzle-orm';
import type { ComputerMoveStartOutputV3 } from '@/server/billing/v3/contract';
import { accessOverrideInEffect, type AccessRow } from '@/server/billing/v3/effective-access';
import type { ComputeBillingState } from '@/server/billing/v2/compute-access';
import type { StopOutcome } from './stop-policy';
import { isPlacementReadEnabled, readAwsAdmissionConfig, type Env } from './aws-config';
import { ImageJobConflictError, PlacementIntegrityError, PlacementOwnerError, readPlacement, type Placement, type PlacementDb, type PlacementExecutor } from './placement';
import { createProviderReverseStore, forwardMoveBusy, reverseMovesTablePresent } from './provider-reverse-store';

/** Candidates one pass considers (and the SQL's own bound). */
export const OVERRIDE_PASS_LIMIT = 10;
/** The sweep's shared launch budget (provider-migrate-reconcile.ts uses the same 40 s from the handler's start). */
export const OVERRIDE_PASS_BUDGET_MS = 40_000;

export interface OverrideMoveCandidate { userId: string; computerId: string }

export interface OverrideReconcileCounts {
    candidates: number;
    /** Override computers on AWS not listed this pass (mid-boot, draining, a job, a holding reverse row): picked up once settled. */
    deferred: number;
    /** Guarded policy stops that were accepted (`ok`, or a stop job now recorded: `stopping`). */
    stopped: number;
    /** Reverse rows created (or found holding) through `startReverseMove`. */
    started: number;
    skipped: number;
    errors: number;
}

/** Whether the lane runs at all: placement reads on, AWS enabled, the admission kill switch off. */
export function freeOverrideLaneEnabled(env: Env = process.env): boolean {
    const config = readAwsAdmissionConfig(env);
    return isPlacementReadEnabled(env) && config.enabled && !config.killSwitch;
}

/**
 * The loaded billing state of an owner under an explicit Free override (summary v3: plan `free_v3` decided by an operator
 * row marked `override`; an ordinary operator grant is never Free). The sweep's own AWS stops defer to this lane for such
 * an owner; every other Free, paid or Cloudflare policy decision is unchanged.
 */
export function explicitFreeOverrideState(state: Pick<ComputeBillingState, 'summary'>): boolean {
    const summary = state.summary;
    if (summary.version !== 3) return false;
    const access = summary.plan.access;
    return summary.plan.sku === 'free_v3' && access?.source === 'operator' && access.override === true;
}

const rowsOf = (result: unknown): Record<string, unknown>[] =>
    (Array.isArray(result) ? result : (result as { rows?: Record<string, unknown>[] } | null)?.rows) ?? [];

/** The live explicit Free override predicate, in SQL: `access_override` through to_jsonb, so a schema without 0038 yields none. */
const liveFreeOverride = (at: string) => sql`o.sku = 'free_v3' AND to_jsonb(o)->>'access_override' = 'true' AND o.ended_at IS NULL
    AND o.starts_at <= ${at}::timestamptz AND (o.ends_at IS NULL OR o.ends_at > ${at}::timestamptz)`;
/** The override set: the account's own live computers whose placement is aws-ec2, with a live explicit Free override. */
const overrideSet = (at: string) => sql`FROM public.ezil_computers c
    JOIN public.ezil_computer_placements p ON p.computer_id = c.id AND p.owner_user_id = c.user_id AND p.provider = 'aws-ec2'
    WHERE c.deleted_at IS NULL AND EXISTS (SELECT 1 FROM public.ezil_operator_entitlements o WHERE o.user_id = c.user_id AND ${liveFreeOverride(at)})`;
/** Actionable: RUNNING or STOPPED with no lifecycle job, and no reverse row holding the computer (requires 0012). */
const actionable = sql`p.state IN ('RUNNING', 'STOPPED') AND p.lifecycle_job_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.ezil_compute_reverse_moves m WHERE m.computer_id = c.id AND m.state NOT IN ('committed', 'failed_reopened'))`;

/**
 * The actionable override set, oldest placement write first (a stable order: a bounded pass makes progress), with the
 * count of the set's other computers (deferred until they settle). Requires 0019 and 0012 (the caller probes both).
 */
export async function freeOverrideCandidates(db: PlacementExecutor, now: Date, limit = OVERRIDE_PASS_LIMIT):
    Promise<{ candidates: OverrideMoveCandidate[]; deferred: number }> {
    const count = Number.isFinite(limit) ? Math.max(0, Math.min(OVERRIDE_PASS_LIMIT, Math.trunc(limit))) : 0;
    if (!count) return { candidates: [], deferred: 0 };
    const at = now.toISOString();
    const listed = rowsOf(await db.execute(sql`/* reverse:override-candidates */ SELECT c.id::text AS computer_id, c.user_id::text AS user_id
        ${overrideSet(at)} AND ${actionable}
        ORDER BY p.updated_at ASC, c.id LIMIT ${count}`));
    const other = rowsOf(await db.execute(sql`/* reverse:override-deferred */ SELECT count(*)::int AS n ${overrideSet(at)} AND NOT (${actionable})`));
    return { candidates: listed.map(row => ({ userId: String(row.user_id).toLowerCase(), computerId: String(row.computer_id).toLowerCase() })),
        deferred: Number(other[0]?.n ?? 0) || 0 };
}

/**
 * Whether an explicit Free override is in effect for the account at `now`: the exact rows re-read (every override row of
 * the account, through to_jsonb), decided by the pure rule every tier reader shares (`accessOverrideInEffect`). A paid
 * override newer than the Free one wins there, as it does for the effective tier.
 */
export async function freeOverrideInEffect(db: PlacementExecutor, userId: string, now: Date): Promise<boolean> {
    const result = await db.execute(sql`/* reverse:override-reread */ SELECT ref, sku, starts_at, ends_at, ended_at
        FROM public.ezil_operator_entitlements o
        WHERE o.user_id = ${userId.toLowerCase()}::uuid AND to_jsonb(o)->>'access_override' = 'true'
        ORDER BY starts_at DESC, ref LIMIT 50`);
    const rows: AccessRow[] = rowsOf(result).map(r => ({
        ref: String(r.ref), revision: 0, userId: userId.toLowerCase(), accountPublicId: '', sku: String(r.sku) as AccessRow['sku'], accessOverride: true,
        startsAt: new Date(r.starts_at as string | Date), endsAt: r.ends_at == null ? null : new Date(r.ends_at as string | Date),
        endedAt: r.ended_at == null ? null : new Date(r.ended_at as string | Date),
    }));
    return accessOverrideInEffect(rows, now)?.sku === 'free_v3';
}

/** What the pass reads and does, as ports (the production wiring is `reconcileFreeOverrideMovesInSweep`). */
export interface OverrideReconcilePorts {
    startedAt: number;
    clock?: () => number;
    limit?: number;
    /** `freeOverrideLaneEnabled`. */
    enabled(): boolean;
    /** 0019 and 0012 both present. */
    schemaPresent(): Promise<boolean>;
    candidates(limit: number): Promise<{ candidates: OverrideMoveCandidate[]; deferred: number }>;
    overrideLive(userId: string): Promise<boolean>;
    /** A holding reverse row, forward work, or a switch/restart transition in flight. A throw is a conflict. */
    conflicting(candidate: OverrideMoveCandidate): Promise<boolean>;
    /** The caller's own placement; throws `PlacementOwnerError` / `ImageJobConflictError` / `PlacementIntegrityError` like `readPlacement`. */
    readPlacement(candidate: OverrideMoveCandidate): Promise<Placement | null>;
    /** An open billing epoch (while metering is active). A throw counts as open. */
    openEpoch(computerId: string): Promise<boolean>;
    /** The guarded policy stop for exactly `p`; null when the route is not aws-ec2 (never a Cloudflare terminate). */
    stop(candidate: OverrideMoveCandidate, p: Placement): Promise<StopOutcome | null>;
    /** `startReverseMove` with `startedBy: 'cron'` and the override re-read as its `confirmStart`. */
    start(candidate: OverrideMoveCandidate): Promise<ComputerMoveStartOutputV3>;
    log?: (event: string, fields: Record<string, unknown>) => void;
}

/** Stop outcomes that mean the stop is now recorded on the placement (a job running, or already stopped). */
const STOP_ACCEPTED: readonly string[] = ['stopping', 'already_stopped', 'not_running', 'destroyed'];

export async function reconcileFreeOverrideMoves(ports: OverrideReconcilePorts): Promise<OverrideReconcileCounts> {
    const counts: OverrideReconcileCounts = { candidates: 0, deferred: 0, stopped: 0, started: 0, skipped: 0, errors: 0 };
    const clock = ports.clock ?? Date.now;
    const log = ports.log ?? ((event, fields) => console.info(JSON.stringify({ event, ...fields })));
    const expired = () => clock() - ports.startedAt >= OVERRIDE_PASS_BUDGET_MS;
    if (!ports.enabled() || expired()) return counts;
    if (!(await ports.schemaPresent())) return counts;
    const limit = Math.max(0, Math.min(OVERRIDE_PASS_LIMIT, Math.trunc(ports.limit ?? OVERRIDE_PASS_LIMIT)));
    const listed = await ports.candidates(limit);
    const candidates = listed.candidates.slice(0, limit);
    counts.candidates = candidates.length;
    counts.deferred = listed.deferred;
    const seen = new Set<string>();
    for (const candidate of candidates) {
        if (expired()) break;
        const computer = candidate.computerId.slice(0, 8);
        // One attempt per computer per pass, whatever the listing repeats.
        if (seen.has(candidate.computerId)) { counts.skipped++; continue; }
        seen.add(candidate.computerId);
        const skip = (reason: string, extra: Record<string, unknown> = {}) => { counts.skipped++; log('override-move-skip', { computer, reason, ...extra }); };
        try {
            // The override is re-read before anything else: a candidate listed a moment ago may be paid again.
            if (!(await ports.overrideLive(candidate.userId))) { skip('override_gone'); continue; }
            if (await ports.conflicting(candidate).catch(() => true)) { skip('conflicting_work'); continue; }
            let p: Placement | null;
            try { p = await ports.readPlacement(candidate); } catch (error) {
                if (error instanceof PlacementOwnerError || error instanceof ImageJobConflictError || error instanceof PlacementIntegrityError) {
                    skip('placement_unavailable', { error: error.name });
                    continue;
                }
                throw error;
            }
            if (!p || p.provider !== 'aws-ec2' || p.ownerUserId !== candidate.userId) { skip('not_own_aws'); continue; }
            if (p.lifecycleJobId !== null) { skip('lifecycle_job'); continue; }
            if (p.state === 'STOPPED') {
                // A session still open on a stopped host: its receipt (or the sweep's stale close) ends it; never written here.
                if (await ports.openEpoch(candidate.computerId).catch(() => true)) { skip('open_session_stopped'); continue; }
                if (expired()) break;
                const started = await ports.start(candidate);
                if (started.ok) {
                    counts.started++;
                    log('override-move-start', { computer, stage: started.move.stage });
                } else skip(`start_${started.reason}`);
                continue;
            }
            if (p.state !== 'RUNNING') { skip(`placement_${p.state.toLowerCase()}`); continue; }
            if (expired()) break;
            // RUNNING, a session open or not: the operator asked for the move, and only this guarded stop may end it.
            const outcome = await ports.stop(candidate, p);
            if (!outcome) { skip('route_not_aws'); continue; }
            const accepted = outcome.kind === 'aws-ec2' && (outcome.result.ok || STOP_ACCEPTED.includes(outcome.result.outcome ?? ''));
            if (accepted) counts.stopped++; else counts.errors++;
            log('override-move-stop', { computer, accepted, outcome: outcome.result.outcome ?? (outcome.result.ok ? 'ok' : 'failed') });
        } catch (error) {
            counts.errors++;
            console.warn('[reverse-move] override reconcile candidate failed', { computer, error: error instanceof Error ? error.name : 'unknown' });
        }
    }
    if (counts.candidates || counts.deferred) log('override-move-pass', { ...counts });
    return counts;
}

/**
 * The billing sweep's step. Imports its runtime lazily (as the forward reconcile does) and only once the flags allow:
 * a sweep of a deployment without the feature touches nothing. Never throws out of the handler.
 */
export async function reconcileFreeOverrideMovesInSweep(startedAt: number, env: Env = process.env): Promise<OverrideReconcileCounts | null> {
    const enabled = freeOverrideLaneEnabled(env);
    if (!enabled || Date.now() - startedAt >= OVERRIDE_PASS_BUDGET_MS) return null;
    try {
        const [{ db }, { operatorEntitlementsInstalled }, dispatch, { stopComputerForPolicy }, { getBillingDeps }, { billingMeteringActive },
            { readComputerMeta, resolveTransition, TRANSITION_IN_FLIGHT }] = await Promise.all([
            import('@/server/db'), import('@/server/entitlements/operator/installed'), import('@/server/api/routers/compute-dispatch'),
            import('./stop-policy'), import('@/server/billing/deps'), import('@/server/billing/v2/compute-access'), import('./progress'),
        ]);
        const placements = db as unknown as PlacementDb;
        const billing = getBillingDeps();
        // Billing off (`tabEnabled` false): no plan, no standing, no override; `heldStanding` refuses the move the same way.
        if (!billing.config.tabEnabled) return null;
        const now = () => billing.now();
        const store = createProviderReverseStore(placements);
        const overrideLive = (userId: string) => freeOverrideInEffect(placements, userId, now());
        const conflicting = async (candidate: OverrideMoveCandidate): Promise<boolean> => {
            if (await store.readActiveByComputer(candidate.computerId)) return true;
            if (await forwardMoveBusy(placements, candidate.computerId)) return true;
            const meta = await readComputerMeta(placements, candidate);
            if (!meta) return true; // Not the owner's live computer row.
            if (!meta.transition) return false;
            const { record } = await readPlacement(placements, candidate.computerId, candidate.userId);
            return TRANSITION_IN_FLIGHT.includes(resolveTransition(meta.transition, record, now()).phase);
        };
        return await reconcileFreeOverrideMoves({
            startedAt,
            enabled: () => enabled,
            schemaPresent: async () => await operatorEntitlementsInstalled(placements) && await reverseMovesTablePresent(placements),
            candidates: limit => freeOverrideCandidates(placements, now(), limit),
            overrideLive,
            conflicting,
            readPlacement: async candidate => (await readPlacement(placements, candidate.computerId, candidate.userId)).record,
            openEpoch: async computerId => billingMeteringActive(billing.config) && (await billing.store.openEpochFor(computerId)) !== null,
            stop: async (candidate, p) => {
                // The guard: the exact row read here, re-confirmed (override still Free, nothing conflicting) on the fresh row
                // immediately before the draining CAS. Merged OVER the default collaborators: the starter, meter, etc. stay.
                const aws = { ...dispatch.defaultAwsCollaborators(env), stopGuard: {
                    expected: { ownerUserId: p.ownerUserId, generation: p.generation, leaseEpoch: p.leaseEpoch, instanceId: p.instanceId, fenceToken: p.fenceToken },
                    // The override re-read is the LAST read before the CAS: conflicts first, then the exact Free standing.
                    confirm: async (fresh: Placement) => fresh.computerId === p.computerId && fresh.ownerUserId === candidate.userId
                        && !(await conflicting(candidate)) && await overrideLive(candidate.userId),
                } };
                const routed = await dispatch.routeComputer(db, candidate, { env, aws });
                if (routed.kind !== 'aws-ec2') return null;
                return stopComputerForPolicy(db, candidate, 'session_max', { route: async () => routed });
            },
            start: candidate => dispatch.startReverseMove(placements, candidate, 'start',
                { env, billing: () => billing, now, startedBy: 'cron', confirmStart: () => overrideLive(candidate.userId) }),
        });
    } catch (error) {
        console.warn('[reverse-move] override reconcile unavailable', { error: error instanceof Error ? error.name : 'unknown' });
        return null;
    }
}
