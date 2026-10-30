/** Read-only progress from recorded stages and successful restore chunk responses. */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { SIZES, type SizeCode } from '@/server/billing/v2/contract';
import { OPENING_MILESTONES_V3, type OpeningMilestoneV3, type OpeningPathV3, type SwitchPhaseV3 } from '@/server/billing/v3/contract';
import type { EntitlementRecord } from './tier';
import { isAwsComputersEnabled, isPlacementReadEnabled, type Env } from './aws-config';
import { ENROLLMENT_SUCCEEDED, isUnenrolledPastGrace, POOL_SESSION_PENDING, PlacementOwnerError, readPlacement, type Placement, type PlacementState, type PlacementExecutor } from './placement';
import { ENROLL_NONCE_TTL_SECONDS } from './aws-rebase-lease';
import { MIGRATION_STATES, pendingRecovery, TERMINAL_MIGRATION_STATES, type MigrationState } from './provider-migrate';
import { createProviderMigrationStore, snapshotChunkSizes, type ComputeMigration } from './provider-migrate-store';
import { releaseHeal, releaseHealOf } from './release-heal';
import {
    REVERSE_MOVE_BUDGET_SECONDS, reverseHoldOpenable, reverseIso, reverseMoveReason, reverseMoveRetry, reverseMoveVisible, reverseOpenBlocked,
    reversePlacementView,
} from './provider-reverse';
import { createProviderReverseStore, REVERSE_MOVE_IN_FLIGHT, reverseMovesTablePresent, type ComputeReverseMove, type ReverseMoveState } from './provider-reverse-store';
import type { SwitchHealReasonV3 } from '@/server/billing/v3/contract';

function transferProgress(migration: ComputeMigration | null, stage: string, stopped: boolean) {
    const workspace = migration && !['requested', 'fenced'].includes(migration.state) ? snapshotChunkSizes(migration.workspaceHead) : null;
    const system = migration?.systemHead ? snapshotChunkSizes(migration.systemHead) : [];
    const total = workspace && system ? [...workspace, ...system].reduce((sum, size) => sum + size, 0) : null;
    const progress = total === null ? null : migration?.restoreProgress;
    const transferred = total === null ? null : progress?.bytes ?? 0;
    const iso = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    const transferStartedAt = iso(progress?.first), transferUpdatedAt = iso(progress?.last);
    const seconds = transferStartedAt && transferUpdatedAt ? (Date.parse(transferUpdatedAt) - Date.parse(transferStartedAt)) / 1000 : 0;
    const chunks = [progress?.workspace, progress?.system].reduce((count, bits) => count + (bits && /^[a-f0-9]{128}$/i.test(bits)
        ? [...bits].reduce((sum, hex) => sum + parseInt(hex, 16).toString(2).replaceAll('0', '').length, 0) : 0), 0);
    const rate = transferred !== null && seconds > 0 ? transferred / seconds : 0;
    return {
        bytes: { transferred, total },
        percent: transferred === null || total === null || total === 0 ? null : Math.max(0, Math.min(100, Math.floor(100 * transferred / total))),
        etaSeconds: !stopped && ['exported', 'provisioning'].includes(stage) && chunks >= 4 && rate > 0 && total !== null
            ? Math.ceil(Math.max(0, total - transferred!) / rate) : null,
        transferStartedAt, transferUpdatedAt,
        typicalSeconds: total === null ? null : Math.max(90, Math.min(600, Math.round(90 + total / 4_000_000))),
    };
}

/**
 * Typical seconds for an AWS open (provision or wake through desktop-ready), shown as the
 * shell's meter/countdown denominator. 240 s is the measured cold open (founder runs
 * 2026-10: 215-300 s), which is also the shell's own fallback. When the caller already holds
 * the pool class's boot p90 (ready-pool `boot_minutes`, in MINUTES) it is used instead.
 * Either figure is clamped to the same 90-600 s band as migration estimates, so a corrupt or
 * outlier observation can neither promise an instant open nor a ten-minute-plus one.
 */
export const OPENING_TYPICAL_SECONDS = 240;
export const TYPICAL_SECONDS_MIN = 90;
export const TYPICAL_SECONDS_MAX = 600;

/**
 * Round 6 (R3-4): what a RUNNING computer with nothing opening still waits for: an app connecting to it
 * (Code's mint and frame confirm, a desktop re-attach). Measured live 10-30: mint 0.5-2 s, frame confirm
 * ~6 s. Sent in the existing `expectedSeconds` so the shell shows a connect expectation instead of its
 * 240 s cold-open fallback ("usually about 4 min" over a running computer). Deliberately not clamped to
 * the 90-600 s opening band: a connect is not an opening.
 */
export const APP_CONNECT_EXPECTED_SECONDS = 30;

export function openingTypicalSeconds(poolBootP90Minutes?: number | null): number {
    const measured = typeof poolBootP90Minutes === 'number' && Number.isFinite(poolBootP90Minutes) && poolBootP90Minutes > 0
        ? Math.round(poolBootP90Minutes * 60) : OPENING_TYPICAL_SECONDS;
    return Math.max(TYPICAL_SECONDS_MIN, Math.min(TYPICAL_SECONDS_MAX, measured));
}

export interface ProgressOptions {
    /** Pool class boot p90 in minutes, only when the caller already has it; never read here. */
    poolBootP90Minutes?: number | null;
    /** Round 3: this opening (`describeOpening`), already merged with its stored record. */
    opening?: OpeningRecord | null;
    /** Median measured warm claim → session-ready seconds of the placement's class (null = none measured). */
    warmMedianSeconds?: number | null;
    /** The computer's switch/restart transition with its resolved phase. */
    transition?: TransitionView | null;
    /** An active capacity demand holds this computer's open (the wake is waiting for room). */
    capacityWaiting?: boolean;
    /** This opening adopted a warm pool host (a switch or restart wake included). */
    warmAdopted?: boolean;
}

export function describeProgress(computerId: string, placement: Placement | null, migration: ComputeMigration | null, env: Env, now = new Date(), entitlement: EntitlementRecord | null = null, options: ProgressOptions = {}) {
    const active = migration && !TERMINAL_MIGRATION_STATES.includes(migration.state) ? migration : null;
    const aws = placement?.provider === 'aws-ec2' || !!active
        || (entitlement?.provider === 'aws' && entitlement.status === 'active' && !entitlement.paymentIssue);
    const paused = aws && (!isAwsComputersEnabled(env) || (env.EZIL_AWS_KILL_SWITCH !== undefined && env.EZIL_AWS_KILL_SWITCH !== '0'));
    const lifecycle = placement?.provider === 'aws-ec2' ? placement.state : null;
    let operation: 'migration' | 'opening' | 'stopping' | 'none' = active ? 'migration' : 'none';
    let stage: Lowercase<PlacementState> | MigrationState | 'recovering' | 'unavailable' = 'unavailable';
    // A terminal failure belongs to the current recorded transition only if it
    // is at least as recent as the placement. A later placement supersedes it.
    const relevantFailure = migration?.state.startsWith('failed_')
        && (!placement || Date.parse(migration.updatedAt) >= placement.updatedAt.getTime());
    if (active) stage = pendingRecovery(active) ? 'recovering' : active.state;
    else if (relevantFailure) stage = migration!.state;
    else if (lifecycle) {
        stage = lifecycle.toLowerCase() as Lowercase<PlacementState>;
        if (['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'WARMING', 'CLAIMED'].includes(lifecycle)) operation = 'opening';
        if (['STOPPING', 'DRAINING', 'RETIRING'].includes(lifecycle)) operation = 'stopping';
    }
    const switching = options.transition && TRANSITION_IN_FLIGHT.includes(options.transition.phase) ? options.transition : null;
    let transitionStage: 'switching' | 'restarting' | 'waiting_capacity' | null = null;
    // Round 5 D2: the switch's failed pool release is being healed (resolveTransition reason `stop_healing`): still switching.
    const healing = !!switching && switching.reason === 'stop_healing' && (lifecycle === 'UNCONFIRMED' || lifecycle === 'RECOVERING');
    if (!active && !relevantFailure && lifecycle && (['STOPPED', 'RUNNING', 'DRAINING', 'STOPPING'].includes(lifecycle) || healing)) {
        // A capacity wait is an opening that has not leased yet, never "stopped".
        if (lifecycle === 'STOPPED' && options.capacityWaiting) transitionStage = 'waiting_capacity';
        else if (switching) transitionStage = switching.kind === 'restart' ? 'restarting' : 'switching';
        if (transitionStage) operation = 'opening';
    }
    // A plain Stop whose release is being replayed (RECOVERING with its replay intent) is still that stop. A bare
    // UNCONFIRMED failed:* row is not: any failed lifecycle job writes it, so without a transition it keeps its hold.
    if (!active && !relevantFailure && !switching && lifecycle === 'RECOVERING' && releaseHealOf(placement) === 'pending') {
        stage = 'stopping';
        operation = 'stopping';
    }
    const selectedSize = entitlement?.source === 'billing_v2' && entitlement.status === 'active' && !entitlement.paymentIssue && entitlement.provider === 'aws' && entitlement.size && entitlement.planId ? SIZES[entitlement.size] : null;
    const selected = selectedSize?.provider === 'aws' ? selectedSize : null;
    // The enrollment nonce (TTL + grace, placement.ts `isUnenrolledPastGrace`) has expired with no
    // host presence this epoch: the open has failed even before the receipt pass records
    // UNCONFIRMED. Same MOUNTING-only predicate as that CAS, so progress never shows a failure
    // that no transition resolves.
    const enrollmentExpired = !active && !relevantFailure && !!placement && isUnenrolledPastGrace(placement, now);
    const needsOperator = stage === 'failed_needs_operator' || (lifecycle === 'UNCONFIRMED' && !healing) || enrollmentExpired;
    // A cutoff must never be presented as active transfer. Keep recordedStage for diagnostics.
    const opening = (operation === 'opening' || operation === 'migration') && !paused && !needsOperator ? options.opening ?? null : null;
    // Round 6 (R3-4): running with nothing opening, stopping or failed: only an app's connect is left.
    const connecting = operation === 'none' && lifecycle === 'RUNNING' && !active && !relevantFailure && !paused && !needsOperator;
    return {
        version: 2 as const, computerId, observedAt: now.toISOString(), operation,
        stage: paused ? 'operations_paused' : needsOperator ? 'needs_operator' : transitionStage ?? (stage === 'requested' ? 'queued' : stage), recordedStage: stage,
        lifecycleState: lifecycle, paused, operationsPaused: paused, needsOperator,
        active: !paused && !needsOperator && operation !== 'none' && stage !== 'requested',
        startedAt: active ? new Date(active.createdAt).toISOString() : null,
        updatedAt: active || relevantFailure ? new Date(migration!.updatedAt).toISOString() : placement?.updatedAt.toISOString() ?? null,
        durable: !!active, resumePolicy: active ? 'saved_workspace_only' as const : 'unavailable' as const,
        ...transferProgress(operation === 'migration' ? migration : null, stage, paused || needsOperator),
        // An open has no byte count; it still has a bounded typical duration while it is underway.
        ...(operation === 'opening' ? { typicalSeconds: paused || needsOperator ? null : opening
            ? expectedOpeningSeconds(opening.path, options.warmMedianSeconds, options.warmAdopted) : openingTypicalSeconds(options.poolBootP90Minutes) } : {}),
        // Round 3 (contract v3 OpeningProgressV3): one server-stamped opening shared by every tab.
        openingStartedAt: opening?.startedAt ?? null,
        path: opening?.path ?? null,
        expectedSeconds: opening ? opening.path === 'migrate' ? transferProgress(migration, stage, false).typicalSeconds ?? expectedOpeningSeconds('cold', null)
            : expectedOpeningSeconds(opening.path, options.warmMedianSeconds, options.warmAdopted) : connecting ? APP_CONNECT_EXPECTED_SECONDS : null,
        milestones: opening ? OPENING_MILESTONES_V3.flatMap(key => opening.milestones[key] ? [{ key, at: opening.milestones[key]! }] : []) : [],
        transition: options.transition ?? null,
        selectedNextOpenHardware: selected ? { size: entitlement!.size!, vcpu: selected.vcpu, memoryGiB: selected.memoryGiB, effective: 'next_open' as const } : null,
        hardware: { instanceType: placement?.instanceType ?? null, source: placement ? 'placement' as const : 'unavailable' as const },
    };
}

// ── Phase B: an AWS → Cloudflare move (docs/compute/REVERSE-MOVE-CONTRACT.md §5.10) ─────────

/** The move's phases and their §6.1 steps (the same as `REVERSE_MOVE_DTO_STAGE`'s, so the overlay and the Computer tab agree). */
const REVERSE_PHASE: Readonly<Partial<Record<ReverseMoveState, { phase: 'export_boot' | 'exporting' | 'importing' | 'checking' | 'committing'; step: 0 | 1 | 2 | 3 }>>> = {
    requested: { phase: 'export_boot', step: 0 }, booting: { phase: 'export_boot', step: 0 }, exporting: { phase: 'exporting', step: 0 },
    copying: { phase: 'importing', step: 1 }, checking: { phase: 'checking', step: 2 }, flipping: { phase: 'committing', step: 3 },
};
/** Seconds of the export boot, the capture, and the check + host retire + commit; the import is 1 MiB/s (§5.10, provisional). */
const REVERSE_EXPECTED = { boot: OPENING_TYPICAL_SECONDS, capture: 120, importUnknown: 120, finish: 150, min: 600, max: 3600 } as const;
/** The bar's time ease only, never shown as a number (no duration claims): `clamp(240 + 120 + import + 150, 600, 3600)`. */
export function reverseMoveExpectedSeconds(bytesTotal: number | null): number {
    const importSeconds = bytesTotal === null ? REVERSE_EXPECTED.importUnknown : Math.ceil(bytesTotal / 1_048_576);
    return Math.max(REVERSE_EXPECTED.min, Math.min(REVERSE_EXPECTED.max,
        REVERSE_EXPECTED.boot + REVERSE_EXPECTED.capture + importSeconds + REVERSE_EXPECTED.finish));
}
/** `computer.progress`'s additive `move` (§5.10): absent with no visible reverse row; old shells ignore it. */
export function reverseMoveProgress(m: ComputeReverseMove, placement: Placement | null) {
    const view = reversePlacementView(placement);
    const phase = REVERSE_PHASE[m.state] ?? null;
    const terminal = !REVERSE_MOVE_IN_FLIGHT.includes(m.state);
    return {
        moveId: m.id, direction: 'to_cloudflare' as const,
        phase: phase?.phase ?? null, step: phase?.step ?? null,
        startedAt: reverseIso(m.createdAt), phaseStartedAt: reverseIso(m.stateEnteredAt),
        expectedSeconds: reverseMoveExpectedSeconds(m.bytesTotal), budgetSeconds: REVERSE_MOVE_BUDGET_SECONDS,
        bytesDone: m.bytesTotal === null ? null : m.importProgress?.bytes ?? 0, bytesTotal: m.bytesTotal,
        outcome: terminal ? m.state as 'committed' | 'failed_reopened' | 'failed_needs_operator' : null,
        reason: reverseMoveReason(m), retry: reverseMoveRetry(m, view), openBlocked: reverseOpenBlocked(m),
        holdOpenable: m.state === 'committed' ? null : reverseHoldOpenable(view),
        // Diagnostics only: the export boot's real placement state (no shell reads it; `lifecycleState` is null).
        placementState: view?.provider === 'aws-ec2' ? view.state : null,
    };
}
/**
 * 🔴 The moving view (§5.10, pinned; `version` stays 2): an in-flight row, or an open-blocked `failed_needs_operator` one.
 * Nothing placement-derived drives it: never `opening` or `stopping`, no lifecycle stage, no `needsOperator` from the export
 * boot's UNCONFIRMED or enrollment expiry, no capacity wait, no transition, no 6a connect expectation, and no opening record
 * read or written (`openingOptions` is not called). `stage: 'moving'` is unknown to an old shell, whose `progressView`
 * returns null: no opening bar, no `needs_operator`, no wrong copy. An in-flight move continues under the kill switch.
 */
export function describeReverseMoving(computerId: string, m: ComputeReverseMove, placement: Placement | null, now = new Date()) {
    const move = reverseMoveProgress(m, placement);
    const blocked = reverseOpenBlocked(m);
    const transferred = move.bytesDone, total = move.bytesTotal;
    const progress = m.importProgress;
    return {
        version: 2 as const, computerId, observedAt: now.toISOString(), operation: 'moving' as const,
        stage: blocked ? 'needs_operator' as const : 'moving' as const, recordedStage: m.state,
        lifecycleState: null, paused: false, operationsPaused: false, needsOperator: blocked,
        active: REVERSE_MOVE_IN_FLIGHT.includes(m.state),
        startedAt: move.startedAt, updatedAt: reverseIso(m.updatedAt),
        durable: true as const, resumePolicy: 'unavailable' as const,
        bytes: { transferred, total },
        percent: move.phase === 'importing' && transferred !== null && total !== null && total > 0
            ? Math.max(0, Math.min(100, Math.floor(100 * transferred / total))) : null,
        etaSeconds: null,
        transferStartedAt: reverseIso(progress?.first), transferUpdatedAt: reverseIso(progress?.last),
        typicalSeconds: move.expectedSeconds,
        openingStartedAt: null, path: null, expectedSeconds: null, milestones: [],
        transition: null, selectedNextOpenHardware: null,
        hardware: { instanceType: placement?.instanceType ?? null, source: placement ? 'placement' as const : 'unavailable' as const },
        move,
    };
}
/** The computer's newest reverse row (§3.4 probe first: no 0012 is no row), or `'foreign'` for another owner's. */
async function readReverseMove(db: PlacementExecutor, computer: { computerId: string; userId: string }): Promise<ComputeReverseMove | 'foreign' | null> {
    if (!(await reverseMovesTablePresent(db))) return null;
    const m = await createProviderReverseStore(db).readByComputer(computer.computerId);
    if (!m) return null;
    return m.userId !== computer.userId.toLowerCase() || m.computerId !== computer.computerId.toLowerCase() ? 'foreign' : m;
}

/** Caller first checks live computer ownership; this repeats ownership for both stored records. */
export async function readComputerProgress(db: PlacementExecutor, computer: { computerId: string; userId: string }, env: Env = process.env, now = new Date()) {
    if (!isPlacementReadEnabled(env)) return describeProgress(computer.computerId, null, null, env);
    try {
        // Phase B (§5.10): the newest reverse row decides BEFORE anything placement-derived. With no 0012 or no row, today's
        // output byte for byte. Owner-checked exactly as the forward row below.
        const reverse = await readReverseMove(db, computer);
        if (reverse === 'foreign') return null;
        if (reverse && (REVERSE_MOVE_IN_FLIGHT.includes(reverse.state) || reverseOpenBlocked(reverse))) {
            let record: Placement | null = null;
            // The export boot's placement is diagnostics only here: an unreadable one (an image reservation racing `requested`)
            // still shows the move. Another owner's placement is NOT_FOUND, as below.
            try { record = (await readPlacement(db, computer.computerId, computer.userId)).record; }
            catch (error) { if (error instanceof PlacementOwnerError) throw error; }
            return describeReverseMoving(computer.computerId, reverse, record, now);
        }
        const placement = await readPlacement(db, computer.computerId, computer.userId);
        const migration = await createProviderMigrationStore(db).readByComputer(computer.computerId);
        if (migration && (migration.userId !== computer.userId.toLowerCase() || migration.computerId !== computer.computerId.toLowerCase())) return null;
        if (migration && !MIGRATION_STATES.includes(migration.state)) throw new Error('invalid migration state');
        let entitlement: EntitlementRecord | null = null;
        try {
            const { billingV2EntitlementReader } = await import('@/server/billing/v2/compute-access');
            entitlement = await billingV2EntitlementReader().read(computer.userId);
        } catch { /* An unavailable preference must not hide actual progress. */ }
        const described = describeProgress(computer.computerId, placement.record, migration, env, now, entitlement,
            await openingOptions(db, computer, placement.record, migration, now));
        // A terminal row (24 h, DB clock) adds its outcome; it never takes over `stage` (a reverse `failed_reopened` is not
        // the forward "original computer was reopened"). The shell keys the outcome on `move` alone (§6.4).
        return reverse && reverseMoveVisible(reverse) ? { ...described, move: reverseMoveProgress(reverse, placement.record) } : described;
    } catch (error) {
        if (error instanceof PlacementOwnerError) return null;
        // No raw database/provider errors in the user contract; never infer a running operation.
        return describeProgress(computer.computerId, null, null, env);
    }
}

/**
 * Round 3 inputs of one progress read (each optional: a failed read hides only its own field).
 * The opening's milestones are stamped once into the computer row's `opening` record, so every
 * tab and every later read sees the same start time and never a regressing milestone.
 */
async function openingOptions(db: PlacementExecutor, computer: { computerId: string; userId: string }, p: Placement | null,
    migration: ComputeMigration | null, now: Date): Promise<ProgressOptions> {
    const options: ProgressOptions = {};
    const pool = await import('./ready-pool');
    const quiet = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => { try { return await read(); } catch { return fallback; } };
    const meta = await quiet(() => readComputerMeta(db, computer), null);
    const resolved = meta?.transition ? resolveTransition(meta.transition, p, now) : null;
    // The DTO shows the reconciled transition (a recovered or superseded failure is not "didn't finish");
    // the opening below keeps the unreconciled phase, so a recovered `done` never relabels its path.
    const reconciled = meta?.transition ? reconcileTransition(meta.transition, p, now) : null;
    options.transition = meta?.transition && reconciled?.current ? transitionView(meta.transition, reconciled) : null;
    const aws = p?.provider === 'aws-ec2' ? p : null;
    if (aws?.state === 'STOPPED') options.capacityWaiting = await quiet(() => pool.hasActiveCapacityDemand(db, aws.computerId, now), false);
    const poolTimes = aws ? await quiet(() => pool.readPoolOpening(db, aws, now), null) : null;
    options.warmAdopted = !!poolTimes?.leasedAt;
    if (aws?.region && aws.instanceType) options.warmMedianSeconds = await quiet(() => pool.readWarmOpenSeconds(db, { region: aws.region!, instanceType: aws.instanceType! }), null);
    const migrating = !!migration && !TERMINAL_MIGRATION_STATES.includes(migration.state);
    const opening = describeOpening({ placement: p, stored: meta?.opening ?? null, transition: meta?.transition && resolved ? { t: meta.transition, phase: resolved.phase } : null,
        pool: poolTimes, migrating, now });
    options.opening = opening;
    if (opening && meta && canonicalJson(opening) !== canonicalJson(meta.rawOpening)) {
        // First writer wins: a concurrent tab's stamp is kept and read back on its next poll.
        await quiet(() => writeOpening(db, computer, meta.rawOpening, opening), false);
    }
    return options;
}

// ── One computer, selectable configuration (round 3, contract v3 D5) ─────────
//
// The transition record and the opening record live in the computer row's own
// `ezil_computers.metadata` JSONB (keys `transition` and `opening`): no new column or
// table. That column is owner-writable through RLS, so both records are ADVISORY:
// they are parsed strictly, bound to the owner, and never authorize anything. The
// one-host guarantee is the placement compare-and-swap (generation, lease epoch,
// state, fence) the existing stop and replace paths already use, and the size a wake
// boots is the billing preference only the server writes after its entitlement checks.

export const TRANSITION_STOP_TIMEOUT_MS = 200_000;
export const TRANSITION_WAKE_TIMEOUT_MS = 600_000;
/** A driver still polling its stop answers up to this long after the stop budget. */
export const TRANSITION_STOP_GRACE_MS = 30_000;
/** Older in-flight records are past every budget: they can only resolve as failed. */
export const TRANSITION_MAX_AGE_MS = TRANSITION_STOP_TIMEOUT_MS + TRANSITION_STOP_GRACE_MS + TRANSITION_WAKE_TIMEOUT_MS;
export const TRANSITION_IN_FLIGHT: readonly SwitchPhaseV3[] = ['requested', 'stopping', 'waking'];
export type TransitionKind = 'switch' | 'restart';
export type AwsSizeCode = Exclude<SizeCode, 'free-cf'>;
export const AWS_SIZE_CODES: readonly AwsSizeCode[] = ['std-2', 'cmp-4', 'cmp-8'];

const isoTime = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)));
const uuidText = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const TRANSITION_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const transitionSchema = z.object({
    v: z.literal(1), transitionId: uuidText, requestId: z.string().regex(TRANSITION_REQUEST_ID),
    kind: z.enum(['switch', 'restart']), computerId: uuidText, userId: uuidText,
    current: z.enum(['std-2', 'cmp-4', 'cmp-8']), target: z.enum(['std-2', 'cmp-4', 'cmp-8']),
    phase: z.enum(['requested', 'stopping', 'waking', 'done', 'failed']), reason: z.string().regex(/^[a-z0-9_:]{1,64}$/).nullable(),
    fromGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    fromLeaseEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requestedAt: isoTime, stoppingAt: isoTime.nullable(), wakingAt: isoTime.nullable(), endedAt: isoTime.nullable(),
}).strict();
export type ComputerTransition = z.infer<typeof transitionSchema>;

const openingSchema = z.object({
    v: z.literal(1), generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    leaseEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), startedAt: isoTime,
    path: z.enum(['warm', 'cold', 'switch', 'migrate', 'restart']),
    milestones: z.object(Object.fromEntries(OPENING_MILESTONES_V3.map(key => [key, isoTime.optional()])) as Record<OpeningMilestoneV3, z.ZodOptional<typeof isoTime>>).strict(),
}).strict();
export type OpeningRecord = z.infer<typeof openingSchema>;

function rowsOf(result: unknown): Record<string, unknown>[] {
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    return ((result as { rows?: Record<string, unknown>[] } | null)?.rows ?? []) as Record<string, unknown>[];
}
/** jsonb reorders keys: compare stored and computed records by sorted keys. */
export function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v) ?? 'null';
}
const jsonValue = (value: unknown): unknown => {
    if (typeof value !== 'string') return value ?? null;
    try { return JSON.parse(value); } catch { return null; }
};

/** A stored transition, or null when absent, malformed, or not this owner's computer. */
export function parseTransition(value: unknown, computer: { computerId: string; userId: string }): ComputerTransition | null {
    const parsed = transitionSchema.safeParse(jsonValue(value));
    if (!parsed.success) return null;
    const t = parsed.data;
    return t.computerId === computer.computerId.toLowerCase() && t.userId === computer.userId.toLowerCase() ? t : null;
}
export function parseOpening(value: unknown): OpeningRecord | null {
    const parsed = openingSchema.safeParse(jsonValue(value));
    return parsed.success ? parsed.data : null;
}

export interface ComputerMeta { transition: ComputerTransition | null; opening: OpeningRecord | null; rawTransition: unknown; rawOpening: unknown }

/** The live, owned computer row's advisory records; null when the row is not the caller's live computer. */
export async function readComputerMeta(db: PlacementExecutor, computer: { computerId: string; userId: string }): Promise<ComputerMeta | null> {
    const rows = rowsOf(await db.execute(sql`/* transition:read */ SELECT
            CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata->'transition' END AS transition,
            CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata->'opening' END AS opening
        FROM public.ezil_computers
        WHERE id = ${computer.computerId.toLowerCase()}::uuid AND user_id = ${computer.userId.toLowerCase()}::uuid AND deleted_at IS NULL`));
    if (rows.length !== 1) return null;
    const rawTransition = jsonValue(rows[0]!.transition), rawOpening = jsonValue(rows[0]!.opening);
    return { transition: parseTransition(rawTransition, computer), opening: parseOpening(rawOpening), rawTransition, rawOpening };
}

const METADATA_OBJECT = sql`CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END`;

/**
 * Write `next` as the computer's transition only when the stored one is still `expected`:
 * `null` = no in-flight transition this caller knows of (absent, malformed, or ended), or the
 * exact stored transition id and phase. One UPDATE on one row: Postgres row locking makes two
 * concurrent writers serialize, and the loser matches zero rows.
 */
export async function writeTransition(db: PlacementExecutor, computer: { computerId: string; userId: string },
    expected: { transitionId: string; phase: SwitchPhaseV3 } | null, next: ComputerTransition): Promise<boolean> {
    const stored = sql`(${METADATA_OBJECT})->'transition'`;
    const guard = expected === null
        ? sql`(${stored} IS NULL OR jsonb_typeof(${stored}) <> 'object' OR COALESCE(${stored}->>'phase', '') NOT IN ('requested', 'stopping', 'waking')
            OR COALESCE(${stored}->>'requestedAt', '') < ${new Date(Date.parse(next.requestedAt) - TRANSITION_MAX_AGE_MS).toISOString()})`
        : sql`(jsonb_typeof(${stored}) = 'object' AND ${stored}->>'transitionId' = ${expected.transitionId} AND ${stored}->>'phase' = ${expected.phase})`;
    const rows = rowsOf(await db.execute(sql`/* transition:write */ UPDATE public.ezil_computers
        SET metadata = jsonb_set(${METADATA_OBJECT}, '{transition}', ${JSON.stringify(transitionSchema.parse(next))}::jsonb)
        WHERE id = ${computer.computerId.toLowerCase()}::uuid AND user_id = ${computer.userId.toLowerCase()}::uuid AND deleted_at IS NULL
            AND ${guard}
        RETURNING id`));
    return rows.length === 1;
}

/** Record this opening's server-stamped milestones; the stored value must still be `previous` (first writer wins). */
export async function writeOpening(db: PlacementExecutor, computer: { computerId: string; userId: string },
    previous: unknown, next: OpeningRecord): Promise<boolean> {
    const stored = sql`(${METADATA_OBJECT})->'opening'`;
    const rows = rowsOf(await db.execute(sql`/* transition:opening */ UPDATE public.ezil_computers
        SET metadata = jsonb_set(${METADATA_OBJECT}, '{opening}', ${JSON.stringify(openingSchema.parse(next))}::jsonb)
        WHERE id = ${computer.computerId.toLowerCase()}::uuid AND user_id = ${computer.userId.toLowerCase()}::uuid AND deleted_at IS NULL
            AND ${previous === null || previous === undefined ? sql`${stored} IS NULL` : sql`${stored} = ${JSON.stringify(previous)}::jsonb`}
        RETURNING id`));
    return rows.length === 1;
}

const OPENING_STATES: readonly PlacementState[] = ['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING'];
const ms = (value: string | null | undefined) => value ? Date.parse(value) : NaN;

/**
 * The phase a stored transition is really in, derived from the placement (pure; reads
 * never write a phase). A later lease epoch RUNNING on the target type is `done`; the old
 * epoch still running past the stop budget, a wake past its budget, or a placement that
 * fell to UNCONFIRMED/RECOVERING (`capacity:*` included) is `failed` with a reason.
 */
export function resolveTransition(t: ComputerTransition, p: Placement | null, now: Date): { phase: SwitchPhaseV3; reason: string | null } {
    if (t.phase === 'done' || t.phase === 'failed') return { phase: t.phase, reason: t.reason };
    if (!p || p.provider !== 'aws-ec2') return { phase: 'failed', reason: 'placement_missing' };
    const moved = p.leaseEpoch > t.fromLeaseEpoch;
    if (moved && p.state === 'RUNNING') return p.instanceType === SIZES[t.target].machine ? { phase: 'done', reason: null } : { phase: 'failed', reason: 'size_not_applied' };
    // Round 5 D2: this switch's own release failed and is being healed: still stopping, bounded by the existing stop bound.
    const heal = releaseHeal(t, p);
    if (heal === 'failed') return { phase: 'failed', reason: 'release_heal_failed' satisfies SwitchHealReasonV3 };
    if (heal === 'pending') {
        return now.getTime() - (ms(t.stoppingAt) || ms(t.requestedAt)) > TRANSITION_STOP_TIMEOUT_MS + TRANSITION_STOP_GRACE_MS
            ? { phase: 'failed', reason: 'release_heal_timeout' satisfies SwitchHealReasonV3 } : { phase: t.phase, reason: 'stop_healing' satisfies SwitchHealReasonV3 };
    }
    if (p.state === 'UNCONFIRMED' || p.state === 'RECOVERING') {
        return { phase: 'failed', reason: p.lastError?.startsWith('capacity:') ? 'capacity_unavailable' : 'unconfirmed' };
    }
    if (['RETIRING', 'RETIRED', 'PURGE_ELIGIBLE'].includes(p.state)) return { phase: 'failed', reason: 'computer_retired' };
    const elapsed = (from: number) => now.getTime() - from;
    if (!moved && p.state !== 'STOPPED' && t.phase !== 'waking') {
        if (elapsed(ms(t.stoppingAt) || ms(t.requestedAt)) > TRANSITION_STOP_TIMEOUT_MS + TRANSITION_STOP_GRACE_MS) return { phase: 'failed', reason: 'stop_timeout' };
        return { phase: t.phase, reason: null };
    }
    const wakeFrom = ms(t.wakingAt) || (ms(t.stoppingAt) || ms(t.requestedAt)) + TRANSITION_STOP_TIMEOUT_MS;
    if (elapsed(wakeFrom) > TRANSITION_WAKE_TIMEOUT_MS) return { phase: 'failed', reason: 'wake_timeout' };
    return { phase: 'waking', reason: null };
}

export interface ReconciledTransition { phase: SwitchPhaseV3; reason: string | null; current: boolean }
/**
 * What a stored transition means NOW against the placement (pure). A stored failure is
 * advisory history: a later lease epoch may have run the target anyway (a heal released the
 * host and the user's own open booted the switch's size), or the user's own later opening
 * may have replaced it. In flight → `resolveTransition`, current; stored `done` → as stored.
 * A stored failure is obsolete once the AWS placement is past the switch's own epoch (> from + 1).
 * At exactly from + 1: RUNNING on the target is `done` (recovered); with no wake recorded the
 * epoch is the user's later opening (superseded, not current); its own wake RUNNING elsewhere
 * is `size_not_applied`; its own wake not running keeps the stored failure. At or before the
 * switch's epoch (or no AWS placement) nothing has happened since: a real failure stays.
 */
export function reconcileTransition(t: ComputerTransition, p: Placement | null, now: Date): ReconciledTransition {
    const resolved = resolveTransition(t, p, now);
    // In flight (even one that resolves failed) and stored `done`: the resolved phase, current.
    if (t.phase !== 'failed') return { ...resolved, current: true };
    const aws = p?.provider === 'aws-ec2' ? p : null;
    if (!aws || aws.leaseEpoch <= t.fromLeaseEpoch) return { ...resolved, current: true };
    if (aws.leaseEpoch > t.fromLeaseEpoch + 1) return { ...resolved, current: false };
    if (aws.state === 'RUNNING' && aws.instanceType === SIZES[t.target].machine) return { phase: 'done', reason: null, current: true };
    if (t.wakingAt === null) return { ...resolved, current: false };
    if (aws.state === 'RUNNING') return { phase: 'failed', reason: 'size_not_applied', current: true };
    return { ...resolved, current: true };
}

export interface TransitionView {
    transitionId: string; kind: TransitionKind; current: AwsSizeCode; target: AwsSizeCode;
    phase: SwitchPhaseV3; reason: string | null; requestedAt: string; endedAt: string | null;
    /** A failed switch offers "Back to <current>" (= a normal switch to `current`). */
    revertAvailable: boolean;
}
export function transitionView(t: ComputerTransition, resolved: { phase: SwitchPhaseV3; reason: string | null }): TransitionView {
    return { transitionId: t.transitionId, kind: t.kind, current: t.current, target: t.target, phase: resolved.phase, reason: resolved.reason,
        requestedAt: t.requestedAt, endedAt: t.endedAt, revertAvailable: t.kind === 'switch' && resolved.phase === 'failed' && t.current !== t.target };
}

/** Where a durable pool lease of THIS epoch says the warm open is (ready-pool `readPoolOpening`). */
export interface PoolOpeningTimes { leasedAt: Date | null; claimPublishedAt: Date | null; sessionReadyAt: Date | null }

export const WARM_EXPECTED_DEFAULT_SECONDS = 90;
/** Seconds a stop takes before a switch or restart can wake (bounded; never a client guess). */
export const TRANSITION_STOP_EXPECTED_SECONDS = 60;
const clampSeconds = (s: number) => Math.max(TYPICAL_SECONDS_MIN, Math.min(TYPICAL_SECONDS_MAX, Math.round(s)));

export function expectedOpeningSeconds(path: OpeningPathV3, warmMedianSeconds: number | null | undefined, warmTarget = false): number {
    const warm = typeof warmMedianSeconds === 'number' && Number.isFinite(warmMedianSeconds) && warmMedianSeconds > 0 ? warmMedianSeconds : null;
    if (path === 'warm') return clampSeconds(warm ?? WARM_EXPECTED_DEFAULT_SECONDS);
    if (path === 'switch' || path === 'restart') return clampSeconds(TRANSITION_STOP_EXPECTED_SECONDS + (warmTarget && warm !== null ? warm : OPENING_TYPICAL_SECONDS));
    return clampSeconds(OPENING_TYPICAL_SECONDS);
}

/**
 * The opening a placement is in, with monotonic milestones. Stored milestones win
 * (first stamp); newly observed ones take their durable time when one exists (pool
 * `leased_at`, claim publish, `session_ready_at`, the lease's nonce issue time), else
 * `now`. A later milestone is never emitted without every earlier one, and times never
 * decrease. Returns null when nothing is opening.
 */
export function describeOpening(input: {
    placement: Placement | null; stored: OpeningRecord | null; transition: { t: ComputerTransition; phase: SwitchPhaseV3 } | null;
    pool: PoolOpeningTimes | null; migrating: boolean; now: Date;
}): OpeningRecord | null {
    const { placement: p, stored, transition, pool, now } = input;
    const live = transition && (TRANSITION_IN_FLIGHT.includes(transition.phase)
        || (transition.phase === 'done' && !!p && p.leaseEpoch === transition.t.fromLeaseEpoch + 1)) ? transition.t : null;
    const aws = p?.provider === 'aws-ec2' ? p : null;
    const opening = !!aws && (OPENING_STATES.includes(aws.state) || aws.state === 'RUNNING');
    if (!live && !opening) return null;
    // The epoch an opening belongs to: a transition's stop phase is the NEXT epoch's opening.
    const leaseEpoch = live && (!aws || aws.leaseEpoch <= live.fromLeaseEpoch) ? live.fromLeaseEpoch + 1 : aws!.leaseEpoch;
    const generation = aws?.generation ?? 0;
    const same = stored && stored.leaseEpoch === leaseEpoch ? stored : null;
    // RUNNING with no record of its opening: it opened before anyone watched; nothing to report.
    if (!same && !live && aws!.state === 'RUNNING') return null;
    const reached = !!aws && aws.leaseEpoch === leaseEpoch;
    const warm = !!pool?.leasedAt;
    const leaseIssued = aws?.enrollExpiresAt ? aws.enrollExpiresAt.getTime() - ENROLL_NONCE_TTL_SECONDS * 1000 : NaN;
    const plausible = (t: number) => Number.isFinite(t) && t <= now.getTime() && t > now.getTime() - TRANSITION_MAX_AGE_MS;
    const startedAt = same?.startedAt ?? (live ? live.requestedAt
        : new Date(warm && plausible(pool!.leasedAt!.getTime()) ? pool!.leasedAt!.getTime() : plausible(leaseIssued) ? leaseIssued : now.getTime()).toISOString());
    const path: OpeningPathV3 = live ? live.kind : input.migrating ? 'migrate' : warm ? 'warm' : same?.path ?? 'cold';
    const at = (d: Date | null | undefined) => d && plausible(d.getTime()) ? d.toISOString() : now.toISOString();
    const observed: Partial<Record<OpeningMilestoneV3, string>> = { requested: startedAt };
    if (reached && aws) {
        const enrolled = aws.enrollConsumedHash !== null || aws.lastError === ENROLLMENT_SUCCEEDED || aws.lastError === POOL_SESSION_PENDING;
        observed.host_claimed = warm ? at(pool!.leasedAt) : plausible(leaseIssued) && !live ? new Date(leaseIssued).toISOString() : now.toISOString();
        if (aws.state === 'MOUNTING' || aws.state === 'RUNNING' || (warm && pool!.claimPublishedAt)) observed.files_attached = warm && pool!.claimPublishedAt ? at(pool!.claimPublishedAt) : now.toISOString();
        if (enrolled || aws.state === 'RUNNING') observed.desktop_starting = now.toISOString();
        if (aws.state === 'RUNNING') observed.desktop_ready = warm && pool!.sessionReadyAt ? at(pool!.sessionReadyAt) : now.toISOString();
    }
    const merged: Partial<Record<OpeningMilestoneV3, string>> = {};
    let last = -1;
    OPENING_MILESTONES_V3.forEach((key, i) => { if (same?.milestones[key] || observed[key]) last = i; });
    let floor = Date.parse(startedAt);
    for (let i = last; i >= 0; i--) {
        // Fill a gap with the earliest later stamp: an earlier milestone is never later than one after it.
        const key = OPENING_MILESTONES_V3[i]!;
        const own = same?.milestones[key] ?? observed[key];
        const next = i < last ? Date.parse(merged[OPENING_MILESTONES_V3[i + 1]!]!) : Infinity;
        merged[key] = new Date(Math.min(own ? Date.parse(own) : next, next)).toISOString();
    }
    for (const key of OPENING_MILESTONES_V3) {
        if (!merged[key]) break;
        floor = Math.max(floor, Date.parse(merged[key]!));
        merged[key] = new Date(floor).toISOString();
    }
    return { v: 1, generation, leaseEpoch, startedAt, path, milestones: merged };
}
