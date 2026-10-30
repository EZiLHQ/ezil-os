/**
 * AWS → Cloudflare moves (Phase B): the reverse machine (docs/compute/REVERSE-MOVE-CONTRACT.md §5).
 *
 * Pure decisions plus one step chain per row, over injected ports (`provider-reverse-runtime.ts` wires the database,
 * the Worker import routes, the lifecycle receipts and billing). This module opens no connection and reads no clock
 * for a deadline:
 *
 * - 🔴 **Deadlines are the DB clock.** Every deadline compares the row's `ages` (PostgreSQL's `clock_timestamp()` minus a
 *   DB-written anchor, computed when the row was read or written, §5.4). `clock()` measures this pass's own budget only.
 * - **One external call at a time, only if its own timeout fits** what is left of the pass (§5.4, §4.1), so a pass ends
 *   by its start + 90 s.
 * - **The closed outcome table** (§5.5): every Worker answer of every step maps to `retry`, `reopen`,
 *   `reopen_after_session`, `reopen_final` or `operator`. Anything not in the table is `worker_conflict` (final).
 * - **Compensation before release** (§5.7): a pre-flip failure keeps its state while it aborts the Worker import and
 *   settles the export host, then writes `failed_*`. The decision is durable on the row (`recordCompensation`).
 * - 🔴 **The point of no return** is `checking → flipping` (transaction 1 sets `commit_sent_at`). `flipping` only ever
 *   commits, retries the same commit, or ends `failed_needs_operator` (`flip_stuck` and the commit's own codes).
 */
import { AWS_REGION_PATTERN } from './aws-config';
import { ENROLLMENT_FAILED, ENROLLMENT_HOST_RETIRE, ENROLLMENT_SUCCEEDED, ImageJobConflictError, type Placement } from './placement';
import {
    bitmapHas, EXPORT_MAX_CHUNKS, importComplete, REVERSE_MOVE_COMPENSABLE, REVERSE_MOVE_IN_FLIGHT, ReverseMoveConflictError, validExportHead,
    type ComputeReverseMove, type ProviderReverseStore, type ReverseExportBoot, type ReverseExportHead, type ReverseMoveFailure, type ReverseMoveState,
} from './provider-reverse-store';

// ── The closed vocabulary (§5.5) ─────────────────────────────────────────

/** `failed_reopened`, Try again offered (`retry: 'now'`, except `entitlement_paid`). */
export const REVERSE_REOPEN_CODES = ['entitlement_paid', 'kill_switch', 'computer_busy', 'boot_unavailable', 'boot_failed', 'boot_timeout',
    'export_timeout', 'export_failed', 'copy_stalled', 'copy_timeout', 'check_timeout', 'import_corrupt', 'import_lost', 'requested_retries',
    'booting_retries', 'exporting_retries', 'copying_retries', 'checking_retries', 'operator_released', 'operator_cleared'] as const;
/** `failed_reopened`, Try again refused while the placement's lease epoch is still the export boot's (no AWS session since). */
export const REVERSE_REOPEN_AFTER_SESSION_CODES = ['workspace_too_large'] as const;
/** `failed_reopened`, Try again refused until an operator sets `operator_cleared`; each logs `[reverse-move] anomaly` from the machine. */
export const REVERSE_REOPEN_FINAL_CODES = ['head_moved', 'head_invalid', 'head_unreadable', 'system_head_moved', 'import_busy', 'import_mismatch',
    'store_unsupported', 'prefix_mismatch', 'export_refused', 'workspace_missing', 'worker_conflict', 'boot_refused', 'region_missing'] as const;
/** The two `reopen` codes with the "try later" copy (§6.3). */
export const REVERSE_TRY_LATER_CODES = ['kill_switch', 'boot_unavailable'] as const;
/** `failed_needs_operator`. Only `abort_unconfirmed` lets Open work (its placement settled first); the rest are open blocked. */
export const REVERSE_OPERATOR_CODES = ['abort_unconfirmed', 'flip_stuck', 'import_head_moved', 'import_not_verified', 'already_imported',
    'commit_in_progress', 'boot_unsettled'] as const;
/** Open blocked without `commit_sent_at` (§5.3); every row with `commit_sent_at` is open blocked too. */
export const REVERSE_OPEN_BLOCKED_CODES = ['already_imported', 'commit_in_progress', 'boot_unsettled'] as const;
/** In-flight `recordRetry` codes; a compensation counts its abort tries on its own marker. */
export const REVERSE_RETRY_CODES = ['unavailable', 'not_found', 'lost_race', 'container_running', 'export_host_mismatch', 'import_not_started',
    'system_head_moved', 'commit_unavailable'] as const;

export type ReverseFailureClass = 'reopen' | 'reopen_after_session' | 'reopen_final' | 'operator';
const has = (list: readonly string[], code: string | null): boolean => code !== null && list.includes(code);
/** The §5.5 class of a failure code, or null for a code outside the closed vocabulary. */
export function reverseFailureClass(code: string | null): ReverseFailureClass | null {
    if (has(REVERSE_REOPEN_CODES, code)) return 'reopen';
    if (has(REVERSE_REOPEN_AFTER_SESSION_CODES, code)) return 'reopen_after_session';
    if (has(REVERSE_REOPEN_FINAL_CODES, code)) return 'reopen_final';
    if (has(REVERSE_OPERATOR_CODES, code)) return 'operator';
    return null;
}
/** §5.3 / §6.1.1: a `failed_needs_operator` row whose commit may have been sent, or whose code blocks Open. */
export function reverseOpenBlocked(m: Pick<ComputeReverseMove, 'state' | 'commitSentAt' | 'lastError'>): boolean {
    return m.state === 'failed_needs_operator' && (m.commitSentAt !== null || has(REVERSE_OPEN_BLOCKED_CODES, m.lastError));
}

// ── Deadlines (§5.4; every one on the DB clock, through `ages`) ──────────

/** Seconds per state. `requested` from `created_at`, `flipping` from `commit_sent_at`, the rest from `state_entered_at`. */
export const REVERSE_DEADLINE_SECONDS = { requested: 600, booting: 900, exporting: 1200, copying: 7500, checking: 1200, flipping: 1800 } as const;
/** `copying` with no new chunk since `import_progress.last` (or `state_entered_at` before the first chunk). */
export const REVERSE_COPY_STALL_SECONDS = 600;
/** A compensation that cannot settle the export host by its state's deadline + this ends `boot_unsettled` (operator). */
export const REVERSE_COMPENSATION_GRACE_SECONDS = 1800;
/** The sum of the §5.4 deadlines: a move is terminal by then plus the per-state detection lag (§5.10). */
export const REVERSE_MOVE_BUDGET_SECONDS = Object.values(REVERSE_DEADLINE_SECONDS).reduce((a, b) => a + b, 0);

type InFlight = Exclude<ReverseMoveState, 'committed' | 'failed_reopened' | 'failed_needs_operator'>;
/** The deadline failure of an in-flight row past its state's own bound (not `requested`: its outcome is decided by its pass). */
export function reverseDeadlineFailure(m: Pick<ComputeReverseMove, 'state' | 'ages'>): string | null {
    const entered = m.ages.stateEntered;
    switch (m.state) {
        case 'booting': return entered >= REVERSE_DEADLINE_SECONDS.booting ? 'boot_timeout' : null;
        case 'exporting': return entered >= REVERSE_DEADLINE_SECONDS.exporting ? 'export_timeout' : null;
        case 'copying':
            if (entered >= REVERSE_DEADLINE_SECONDS.copying) return 'copy_timeout';
            return (m.ages.lastChunk ?? entered) >= REVERSE_COPY_STALL_SECONDS ? 'copy_stalled' : null;
        case 'checking': return entered >= REVERSE_DEADLINE_SECONDS.checking ? 'check_timeout' : null;
        case 'flipping': return m.ages.commitSent !== null && m.ages.commitSent >= REVERSE_DEADLINE_SECONDS.flipping ? 'flip_stuck' : null;
        default: return null;
    }
}
/** §5.4: compensation runs while the row keeps its state, so its bound is that state's deadline + 30 min on `state_entered_at`. */
export function reverseCompensationExpired(m: Pick<ComputeReverseMove, 'state' | 'ages'>): boolean {
    const deadline = REVERSE_DEADLINE_SECONDS[m.state as InFlight];
    return deadline !== undefined && m.ages.stateEntered >= deadline + REVERSE_COMPENSATION_GRACE_SECONDS;
}

// ── Worker answers → §5.5 outcomes ──────────────────────────────────────

/** The Worker client's failure shapes (`MigrateResult`, cloudflare-guacamole-provider.ts). */
export type ReverseWorkerFailure = { ok: false; error: 'not_found' | 'unavailable' } | { ok: false; error: 'conflict'; reason?: string };
export type ReverseWorkerResult<T> = { ok: true; data: T } | ReverseWorkerFailure;
export type ReverseAnswer =
    | { kind: 'retry'; code: (typeof REVERSE_RETRY_CODES)[number] }
    | { kind: 'fail'; failure: ReverseFailureClass; code: string; anomaly?: true };
export type ReverseWorkerStep = 'begin' | 'pull' | 'verify' | 'commit' | 'abort';

const FINAL_BEGIN = ['head_moved', 'head_invalid', 'head_unreadable', 'system_head_moved', 'import_busy', 'store_unsupported', 'prefix_mismatch', 'export_refused'];
const FINAL_IMPORT = ['import_mismatch', 'store_unsupported', 'prefix_mismatch'];
/** §5.5, row by row. A code the row does not list (including the Worker's `other`) is `worker_conflict` before the flip. */
export function classifyWorkerFailure(step: ReverseWorkerStep, result: ReverseWorkerFailure): ReverseAnswer {
    const reason = result.error === 'conflict' ? result.reason ?? 'other' : result.error;
    const fail = (failure: ReverseFailureClass, code: string, anomaly = false): ReverseAnswer =>
        anomaly ? { kind: 'fail', failure, code, anomaly: true } : { kind: 'fail', failure, code };
    const retry = (code: (typeof REVERSE_RETRY_CODES)[number]): ReverseAnswer => ({ kind: 'retry', code });
    switch (step) {
        case 'begin':
            if (reason === 'unavailable' || reason === 'not_found' || reason === 'container_running' || reason === 'export_host_mismatch') return retry(reason);
            if (reason === 'already_imported') return fail('operator', 'already_imported');
            return fail('reopen_final', FINAL_BEGIN.includes(reason) ? reason : 'worker_conflict');
        case 'pull':
            if (reason === 'unavailable' || reason === 'not_found' || reason === 'export_host_mismatch' || reason === 'import_not_started') return retry(reason);
            if (reason === 'workspace_too_large') return fail('reopen_after_session', 'workspace_too_large');
            if (reason === 'export_capture_failed' || reason === 'export_desktop_stop_failed') return fail('reopen', 'export_failed');
            if (reason === 'export_staging_space' || reason === 'export_head_invalid') return fail('reopen', 'export_failed', true);
            if (reason === 'export_workspace_missing') return fail('reopen_final', 'workspace_missing');
            if (reason === 'chunk_mismatch') return fail('reopen', 'import_corrupt');
            if (reason === 'already_imported') return fail('operator', 'already_imported');
            return fail('reopen_final', FINAL_IMPORT.includes(reason) ? reason : 'worker_conflict');
        case 'verify':
            if (reason === 'unavailable' || reason === 'not_found') return retry(reason);
            if (reason === 'not_verified') return fail('reopen', 'import_corrupt');
            if (reason === 'import_not_started') return fail('reopen', 'import_lost');
            return fail('reopen_final', FINAL_IMPORT.includes(reason) ? reason : 'worker_conflict');
        case 'commit':
            // Past the point of no return: only the commit's own operator codes end it; everything else retries the SAME commit
            // until `flip_stuck` (the Worker reads P first and every step is idempotent, §4.4).
            if (reason === 'head_moved') return fail('operator', 'import_head_moved');
            if (reason === 'not_verified' || FINAL_IMPORT.includes(reason)) return fail('operator', 'import_not_verified');
            if (reason === 'import_not_started' || reason === 'system_head_moved') return retry(reason);
            return retry('commit_unavailable');
        case 'abort':
            if (reason === 'already_imported' || reason === 'commit_in_progress') return fail('operator', reason);
            return retry(reason === 'not_found' ? 'not_found' : 'unavailable');
    }
}

// ── Ports ────────────────────────────────────────────────────────────────

/** The export host's status (§2.4), as the Worker forwards it. */
export interface ReverseExportStatusView { state: 'none' | 'capturing' | 'ready' | 'failed' }
export interface ReverseWorker {
    begin(m: ComputeReverseMove): Promise<ReverseWorkerResult<{ export: ReverseExportStatusView }>>;
    pull(m: ComputeReverseMove, from: number, count: number): Promise<ReverseWorkerResult<{
        export: ReverseExportStatusView; head: Record<string, unknown> | null; stored: number[]; next: number | null }>>;
    verify(m: ComputeReverseMove): Promise<ReverseWorkerResult<unknown>>;
    commit(m: ComputeReverseMove): Promise<ReverseWorkerResult<{ store?: string }>>;
    abort(m: ComputeReverseMove): Promise<ReverseWorkerResult<unknown>>;
}
/** `admitExportBoot`'s answer (admission.ts), after the runtime built the lease and recorded the claim. */
export type ReverseClaimOutcome = { admitted: true; move: ComputeReverseMove } | { admitted: false; reason: string };
export interface ReversePorts {
    store: Pick<ProviderReverseStore, 'readById' | 'advance' | 'recordExportBoot' | 'recordExportHead' | 'recordImportProgress' | 'recordRetry'
        | 'recordCompensation' | 'fail'>;
    /** Milliseconds, for this pass's own budget only (never a deadline). */
    clock(): number;
    /** The AWS admission kill switch (`aws-config.ts`): it gates new work (`requested`) only. */
    killSwitchOn(): boolean;
    /** The owner's standing gives a paid computer (`paidAccess`). A throw is unknown (never paid before the flip). */
    paid(userId: string): Promise<boolean>;
    /** An open billing epoch for the computer while metering is active (§5.1.1). A throw counts as open. */
    openEpoch(computerId: string): Promise<boolean>;
    /** The computer's placement; throws `ImageJobConflictError` while an image job holds it. */
    readPlacement(computerId: string): Promise<Placement | null>;
    /** §5.1: build the lease (§5.1.2), `admitExportBoot` with the claim recorded in its transaction, then start the job after commit. */
    claim(m: ComputeReverseMove, p: Placement): Promise<ReverseClaimOutcome>;
    /** Apply the export boot's current lifecycle receipt (export-boot mode, aws-receipts.ts). */
    settleBoot(p: Placement): Promise<void>;
    /** `releaseExportBoot`, then (after it commits) `retireUnenrolledHost` (§5.2). */
    releaseBoot(p: Placement, boot: ReverseExportBoot): Promise<void>;
    /** `retireUnenrolledHost` for a boot already handed back (UNCONFIRMED/`ENROLLMENT_FAILED`), or a resumed host retire. */
    retireHost(p: Placement): Promise<void>;
    worker: ReverseWorker;
    /** §5.6 transaction 1: the locked re-read and entitlement re-check, then `advance(m, 'flipping')` over that transaction. */
    toFlipping(m: ComputeReverseMove): Promise<ComputeReverseMove | 'paid' | 'not_ready'>;
    /** §5.6 transaction 2: `flipPlacementToCloudflare` with `finish` in the same transaction. */
    flip(m: ComputeReverseMove, store: string): Promise<ComputeReverseMove>;
    /** §5.6 step 4: a paid owner gets the forward move onto a fresh volume. Never throws out. */
    afterCommit(m: ComputeReverseMove): Promise<void>;
    /** §5.7 step 3: `fail` in a transaction that holds the computer lock and re-reads the placement as settled; null when it is not. */
    failSettled(m: ComputeReverseMove, to: ReverseMoveFailure, reason: string): Promise<ComputeReverseMove | null>;
    log(event: 'anomaly' | 'error', fields: Record<string, unknown>): void;
}

/** Per-call fit in this pass (§5.4): the Worker's own timeouts (§4.1); AWS work (admission + StartExecution, a receipt read) 30 s. */
export const REVERSE_CALL_FIT_MS = { begin: 60_000, pull: 40_000, commit: 30_000, abort: 60_000, aws: 30_000 } as const;
/** Chunks per `pull` (§4.3: at most 64). */
export const REVERSE_PULL_COUNT = 64;

// ── Pure helpers on the row and the placement ───────────────────────────

const COMPENSATION = /^compensate:([a-z_]+)(?::(host|unconfirmed))?$/;
/** The compensation a row is in, from its durable marker (`recordCompensation`), or null. */
export function reverseCompensation(m: Pick<ComputeReverseMove, 'state' | 'lastError'>): { code: string; step: 'abort' | 'host' | 'unconfirmed' } | null {
    if (!REVERSE_MOVE_COMPENSABLE.includes(m.state)) return null;
    const match = COMPENSATION.exec(m.lastError ?? '');
    if (!match || reverseFailureClass(match[1]!) === null) return null;
    return { code: match[1]!, step: (match[2] as 'host' | 'unconfirmed' | undefined) ?? 'abort' };
}
/** The export boot's own placement: `aws-ec2` at the claim's N+1/E+1 on its volume. */
const atClaim = (p: Placement | null, boot: ReverseExportBoot): p is Placement => !!p && p.provider === 'aws-ec2'
    && p.generation === boot.placementGeneration && p.leaseEpoch === boot.leaseEpoch && p.volumeId === boot.volumeId;
const BOOT_STATES: readonly string[] = ['LEASED', 'STARTING', 'MOUNTING'];
/**
 * §5.7 step 2, settled (pinned): `aws-ec2`, STOPPED, no job, the claim's volume, lease epoch ≥ E+1, generation N or N+1. A refused
 * or failed export-boot replace settles back to generation N at E+1 (`settleReplacementGeneration`); the host retire lands N+1/E+1.
 */
export function reverseBootSettled(p: Placement | null, boot: ReverseExportBoot): boolean {
    return !!p && p.provider === 'aws-ec2' && p.state === 'STOPPED' && p.lifecycleJobId === null && p.volumeId === boot.volumeId
        && p.leaseEpoch >= boot.leaseEpoch && (p.generation === boot.placementGeneration || p.generation === boot.placementGeneration - 1);
}
/** §5.6 step 1: the flip's own precondition stays strict: STOPPED at N+1/E+1 with no job (its path is always the host retire). */
export function reverseReadyToFlip(p: Placement | null, boot: ReverseExportBoot): boolean {
    return atClaim(p, boot) && p.state === 'STOPPED' && p.lifecycleJobId === null;
}
const hostRetireResumable = (p: Placement) => p.provider === 'aws-ec2' && p.lifecycleJobId === null
    && ((p.state === 'UNCONFIRMED' && p.lastError === ENROLLMENT_FAILED) || (p.state === 'RECOVERING' && p.lastError === ENROLLMENT_HOST_RETIRE));

/** The host's export head (§2.3): `v` 1, this move's id, valid for its generation; stored without `v` and `moveId`. */
export function exportHeadFor(m: Pick<ComputeReverseMove, 'id' | 'generation'>, raw: Record<string, unknown> | null): ReverseExportHead | null {
    if (!raw || raw.v !== 1 || raw.moveId !== m.id) return null;
    const { v: _v, moveId: _moveId, ...rest } = raw;
    const head = rest as unknown as ReverseExportHead;
    return validExportHead(head, m.generation) ? head : null;
}
const firstMissing = (m: ComputeReverseMove): number => {
    const head = m.exportHead!, bitmap = m.importProgress?.archiveSha256 === head.sha256 ? m.importProgress.bitmap : null;
    for (let i = 0; i < head.chunks.length; i++) if (!bitmap || !bitmapHas(bitmap, i)) return i;
    return head.chunks.length;
};

// ── The step chain ───────────────────────────────────────────────────────

type Progress = { next: ComputeReverseMove } | { wait: ComputeReverseMove };
const next = (m: ComputeReverseMove): Progress => ({ next: m });
const wait = (m: ComputeReverseMove): Progress => ({ wait: m });
const ADMISSION_TRY_LATER = ['aws_disabled', 'aws_config_invalid', 'kill_switch'];
const ADMISSION_REFUSED = ['user_has_aws_computer', 'computer_not_owned', 'computer_deleted'];
const ADMISSION_FLEET_WAIT = ['duplicate_placement', 'region_not_configured'];
const REACHED_EXPORT: readonly ReverseMoveState[] = ['exporting', 'copying', 'checking'];

/**
 * Drive one claimed row, step after step, until it waits, ends, or the pass is out of time (`deadlineMs`, the pass's
 * start + 90 s). Returns the last copy of the row. A lost compare-and-swap ends this row's pass (another driver moved it;
 * both are safe: the Worker serialises per DO and every write is a CAS). Other errors propagate to the driver.
 */
export async function advanceReverseMove(ports: ReversePorts, m0: ComputeReverseMove, deadlineMs: number): Promise<ComputeReverseMove> {
    const fits = (ms: number) => deadlineMs - ports.clock() >= ms;
    const anomaly = (m: ComputeReverseMove, code: string, extra: Record<string, unknown> = {}) =>
        ports.log('anomaly', { moveId: m.id, computer: m.computerId.slice(0, 8), state: m.state, code, ...extra });

    /** A decided pre-flip failure: an operator code is written at once; with no claim nothing needs compensating; else compensate. */
    const startFailure = async (m: ComputeReverseMove, code: string): Promise<ComputeReverseMove> => {
        const failure = reverseFailureClass(code);
        if (failure === 'reopen_final') anomaly(m, code);
        if (failure === 'operator') return ports.store.fail(m, 'failed_needs_operator', code);
        if (!m.exportBoot) return ports.store.fail(m, 'failed_reopened', code);
        return ports.store.recordCompensation(m, REACHED_EXPORT.includes(m.state) ? `compensate:${code}` : `compensate:${code}:host`);
    };
    const answer = async (m: ComputeReverseMove, step: ReverseWorkerStep, result: ReverseWorkerFailure): Promise<Progress> => {
        const a = classifyWorkerFailure(step, result);
        if (a.kind === 'fail') {
            if (a.anomaly) anomaly(m, a.code, { step, reason: result.error === 'conflict' ? result.reason ?? 'other' : result.error });
            return next(await startFailure(m, a.code));
        }
        const r = await ports.store.recordRetry(m, a.code);
        return r.exhausted ? next(await startFailure(m, `${m.state}_retries`)) : wait(r.move);
    };
    const placement = async (computerId: string): Promise<Placement | null> => ports.readPlacement(computerId);

    async function requested(m: ComputeReverseMove): Promise<Progress> {
        if (ports.killSwitchOn()) return next(await startFailure(m, 'kill_switch'));
        let p: Placement | null = null, reserved = false;
        try { p = await placement(m.computerId); } catch (error) {
            if (!(error instanceof ImageJobConflictError)) throw error;
            reserved = true;
        }
        if (p && p.provider === 'aws-ec2' && p.ownerUserId === m.userId && (typeof p.region !== 'string' || !AWS_REGION_PATTERN.test(p.region)))
            return next(await startFailure(m, 'region_missing'));
        let claimable = !reserved && !!p && p.provider === 'aws-ec2' && p.ownerUserId === m.userId && p.state === 'STOPPED' && p.lifecycleJobId === null;
        if (claimable) claimable = !(await ports.openEpoch(m.computerId).catch(() => true));
        if (claimable) {
            // The deadline's outcome is decided only from a pass that attempted the claim (§5.1.1): no attempt, no decision.
            if (!fits(REVERSE_CALL_FIT_MS.aws)) return wait(m);
            const outcome = await ports.claim(m, p!);
            if (outcome.admitted) return next(outcome.move);
            if (ADMISSION_TRY_LATER.includes(outcome.reason)) return next(await startFailure(m, 'kill_switch'));
            if (ADMISSION_REFUSED.includes(outcome.reason)) {
                anomaly(m, 'boot_refused', { admission: outcome.reason });
                return next(await ports.store.fail(m, 'failed_reopened', 'boot_refused'));
            }
            if (outcome.reason === 'region_missing') return next(await startFailure(m, 'region_missing'));
            if (ADMISSION_FLEET_WAIT.includes(outcome.reason)) anomaly(m, outcome.reason);
        }
        if (m.ages.created >= REVERSE_DEADLINE_SECONDS.requested) return next(await startFailure(m, claimable ? 'boot_unavailable' : 'computer_busy'));
        return wait(m);
    }

    async function booting(m: ComputeReverseMove): Promise<Progress> {
        const boot = m.exportBoot!;
        let p = await placement(m.computerId);
        if (atClaim(p, boot) && BOOT_STATES.includes(p.state) && p.lifecycleJobId !== null && fits(REVERSE_CALL_FIT_MS.aws)) {
            await ports.settleBoot(p);
            p = await placement(m.computerId);
        }
        if (atClaim(p, boot) && p.state === 'MOUNTING') {
            // Record what the boot proved (its instance) on the SAME claim, then advance once enrollment succeeded.
            let row = m;
            if (p.instanceId && (boot.instanceId === null || boot.fsUuid === null) && (boot.instanceId === null || boot.instanceId === p.instanceId))
                row = await ports.store.recordExportBoot(m, { ...boot, instanceId: p.instanceId, fsUuid: boot.fsUuid ?? p.fsUuid });
            if (p.lifecycleJobId === null && p.lastError === ENROLLMENT_SUCCEEDED && row.exportBoot?.instanceId === p.instanceId)
                return next(await ports.store.advance(row, 'exporting'));
            if (row !== m) return next(row);
        }
        if (!(atClaim(p, boot) && BOOT_STATES.includes(p.state))) return next(await startFailure(m, 'boot_failed'));
        return wait(m);
    }

    async function exporting(m: ComputeReverseMove): Promise<Progress> {
        if (!fits(REVERSE_CALL_FIT_MS.begin)) return wait(m);
        const begun = await ports.worker.begin(m);
        if (!begun.ok) return answer(m, 'begin', begun);
        if (!fits(REVERSE_CALL_FIT_MS.pull)) return wait(m);
        const polled = await ports.worker.pull(m, 0, 0);
        if (!polled.ok) return answer(m, 'pull', polled);
        if (polled.data.export.state !== 'ready' || !polled.data.head) return wait(m);
        const head = exportHeadFor(m, polled.data.head);
        if (!head) {
            anomaly(m, 'export_head_invalid', { side: 'app' });
            return next(await startFailure(m, 'export_failed'));
        }
        return next(await ports.store.recordExportHead(m, head));
    }

    async function copying(m0: ComputeReverseMove): Promise<Progress> {
        let m = m0;
        if (m.lastError === 'import_not_started') {
            // §5.5: the Worker lost the import; begin again (idempotent for this move and generation).
            if (!fits(REVERSE_CALL_FIT_MS.begin)) return wait(m);
            const begun = await ports.worker.begin(m);
            if (!begun.ok) return answer(m, 'begin', begun);
        }
        for (;;) {
            if (importComplete(m)) return next(await ports.store.advance(m, 'checking'));
            if (!fits(REVERSE_CALL_FIT_MS.pull)) return wait(m);
            const pulled = await ports.worker.pull(m, Math.min(firstMissing(m), EXPORT_MAX_CHUNKS - 1), REVERSE_PULL_COUNT);
            if (!pulled.ok) return answer(m, 'pull', pulled);
            const n = m.exportHead!.chunks.length;
            const stored = [...new Set(pulled.data.stored)].filter(i => i < n);
            const before = m;
            if (stored.length) m = await ports.store.recordImportProgress(m, stored);
            if (m === before) return wait(m);
        }
    }

    async function checking(m: ComputeReverseMove): Promise<Progress> {
        const boot = m.exportBoot!;
        let p = await placement(m.computerId);
        if (atClaim(p, boot) && p.state === 'MOUNTING' && p.lifecycleJobId === null) {
            // (1) verified, then (2) the host retire: once the placement left MOUNTING, verification already passed.
            if (!fits(REVERSE_CALL_FIT_MS.commit)) return wait(m);
            const verified = await ports.worker.verify(m);
            if (!verified.ok) return answer(m, 'verify', verified);
            if (!fits(REVERSE_CALL_FIT_MS.aws)) return wait(m);
            await ports.releaseBoot(p, boot);
            p = await placement(m.computerId);
        }
        if (reverseReadyToFlip(p, boot)) {
            const flipping = await ports.toFlipping(m);
            if (flipping === 'paid') return next(await startFailure(m, 'entitlement_paid'));
            return flipping === 'not_ready' ? wait(m) : next(flipping);
        }
        if (p && p.lifecycleJobId !== null && fits(REVERSE_CALL_FIT_MS.aws)) await ports.settleBoot(p);
        else if (p && hostRetireResumable(p) && fits(REVERSE_CALL_FIT_MS.aws)) await ports.retireHost(p);
        return wait(m);
    }

    async function flipping(m: ComputeReverseMove): Promise<Progress> {
        if (!fits(REVERSE_CALL_FIT_MS.commit)) return wait(m);
        const committed = await ports.worker.commit(m);
        if (!committed.ok) {
            const a = classifyWorkerFailure('commit', committed);
            if (a.kind === 'fail') return next(await ports.store.fail(m, 'failed_needs_operator', a.code));
            return wait((await ports.store.recordRetry(m, a.code)).move);
        }
        let done: ComputeReverseMove;
        try { done = await ports.flip(m, committed.data.store ?? ''); } catch (error) {
            if (error instanceof ReverseMoveConflictError) throw error;
            // The placement is not the retired export boot (or the store is not r2): the same commit is retried until flip_stuck.
            ports.log('error', { moveId: m.id, state: m.state, step: 'flip', error: error instanceof Error ? error.message.slice(0, 80) : 'unknown' });
            return wait((await ports.store.recordRetry(m, 'commit_unavailable')).move);
        }
        await ports.afterCommit(done).catch(() => ports.log('error', { moveId: m.id, step: 'after_commit' }));
        return next(done);
    }

    async function compensate(m: ComputeReverseMove, c: { code: string; step: 'abort' | 'host' | 'unconfirmed' }): Promise<Progress> {
        let unconfirmed = c.step === 'unconfirmed';
        if (c.step === 'abort' && !reverseCompensationExpired(m)) {
            if (!fits(REVERSE_CALL_FIT_MS.abort)) return wait(m);
            const aborted = await ports.worker.abort(m);
            if (aborted.ok) return next(await ports.store.recordCompensation(m, `compensate:${c.code}:host`));
            const a = classifyWorkerFailure('abort', aborted);
            if (a.kind === 'fail') return next(await ports.store.fail(m, 'failed_needs_operator', a.code));
            const r = await ports.store.recordRetry(m, m.lastError!);
            return r.exhausted ? next(await ports.store.recordCompensation(m, `compensate:${c.code}:unconfirmed`)) : wait(r.move);
        }
        if (c.step === 'abort') unconfirmed = true;
        const to: ReverseMoveFailure = unconfirmed ? 'failed_needs_operator' : 'failed_reopened';
        const reason = unconfirmed ? 'abort_unconfirmed' : c.code;
        const boot = m.exportBoot;
        if (!boot) return next(await ports.store.fail(m, to, reason));
        const p = await placement(m.computerId);
        if (reverseBootSettled(p, boot)) {
            const done = await ports.failSettled(m, to, reason);
            return done ? next(done) : wait(m);
        }
        if (reverseCompensationExpired(m)) return next(await ports.store.fail(m, 'failed_needs_operator', 'boot_unsettled'));
        if (p && fits(REVERSE_CALL_FIT_MS.aws)) {
            if (atClaim(p, boot) && p.state === 'MOUNTING' && p.lifecycleJobId === null) await ports.releaseBoot(p, boot);
            else if (p.provider === 'aws-ec2' && p.lifecycleJobId !== null) await ports.settleBoot(p);
            else if (hostRetireResumable(p)) await ports.retireHost(p);
        }
        return wait(m);
    }

    async function step(m: ComputeReverseMove): Promise<Progress> {
        if (m.state === 'flipping') return flipping(m);
        const c = reverseCompensation(m);
        if (c) return compensate(m, c);
        switch (m.state) {
            case 'requested': return requested(m);
            case 'booting': return booting(m);
            case 'exporting': return exporting(m);
            case 'copying': return copying(m);
            case 'checking': return checking(m);
            default: return wait(m);
        }
    }

    let m = m0;
    try {
        // §5.8: the entitlement is re-read at every pre-flip pass (and once more in transaction 1, under the locks).
        if (REVERSE_MOVE_COMPENSABLE.includes(m.state) && !reverseCompensation(m)
            && await ports.paid(m.userId).catch(() => false)) m = await startFailure(m, 'entitlement_paid');
        for (let guard = 0; guard < 1000 && REVERSE_MOVE_IN_FLIGHT.includes(m.state); guard++) {
            const progress = await step(m);
            if ('next' in progress) { m = progress.next; continue; }
            m = progress.wait;
            // No progress this pass: the state's own deadline, on the DB clock (`requested` decided its own above).
            const late = reverseDeadlineFailure(m);
            if (!late || reverseCompensation(m)) break;
            m = m.state === 'flipping' ? await ports.store.fail(m, 'failed_needs_operator', late) : await startFailure(m, late);
        }
    } catch (error) {
        if (error instanceof ReverseMoveConflictError && error.reason === 'lost_race') return m;
        throw error;
    }
    return m;
}

// ── The pass (billing-session-sweep, last; §5.4) ─────────────────────────

/** The pass's own budget, from its own start. */
export const REVERSE_PASS_BUDGET_MS = 90_000;
/** No pass starts later than this after the handler started: the next tick takes the rows. */
export const REVERSE_PASS_LATEST_START_MS = 150_000;
/** The snapshot step's reserved share of the budget (lane O, §7.2: a no-op in v1). */
export const REVERSE_SNAPSHOT_BUDGET_MS = 20_000;
/** Rows a pass claims (the store's maximum); driven concurrently, one step chain per row. */
export const REVERSE_PASS_CLAIM = 10;

export interface ReversePassSummary {
    startOffsetMs: number;
    snapshot: string;
    claimed: number;
    states: Record<string, number>;
    errors: number;
}
/**
 * One reverse pass. Does nothing after `handlerStartedAt + 150 s` or without 0012. Order: lane O's snapshot step (§7.2),
 * awaited, with its 20 s; then `claimStale(10)` (rows past `requested` first) driven concurrently until the pass's
 * start + 90 s. One log line. Never throws: a failed row is logged and left for the next tick.
 */
export async function sweepReverseMoves(input: {
    handlerStartedAt: number;
    clock?: () => number;
    tablePresent(): Promise<boolean>;
    snapshots(input: { deadlineMs: number }): Promise<{ status: string }>;
    claimStale(limit: number): Promise<ComputeReverseMove[]>;
    drive(m: ComputeReverseMove, deadlineMs: number): Promise<ComputeReverseMove>;
    log?: (line: string, fields: Record<string, unknown>) => void;
}): Promise<ReversePassSummary | null> {
    const clock = input.clock ?? Date.now, log = input.log ?? ((line, fields) => console.info(line, fields));
    try {
        const startedAt = clock();
        if (startedAt - input.handlerStartedAt > REVERSE_PASS_LATEST_START_MS) return null;
        if (!(await input.tablePresent())) return null;
        const deadlineMs = startedAt + REVERSE_PASS_BUDGET_MS;
        let snapshot = 'error';
        try { snapshot = (await input.snapshots({ deadlineMs: startedAt + REVERSE_SNAPSHOT_BUDGET_MS })).status; } catch { /* informational only */ }
        const claimed = await input.claimStale(REVERSE_PASS_CLAIM);
        const states: Record<string, number> = {};
        let errors = 0;
        await Promise.all(claimed.map(async m => {
            try {
                const after = await input.drive(m, deadlineMs);
                states[after.state] = (states[after.state] ?? 0) + 1;
            } catch {
                errors++;
                console.warn('[reverse-move] row failed', { moveId: m.id, state: m.state });
            }
        }));
        const summary = { startOffsetMs: startedAt - input.handlerStartedAt, snapshot, claimed: claimed.length, states, errors };
        log('[reverse-move] pass', { ...summary });
        return summary;
    } catch {
        console.warn('[reverse-move] pass unavailable');
        return null;
    }
}
