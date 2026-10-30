// reverse-move-fixtures.mjs — EZiL-authored test support (not a suite). Phase B: the server shapes a
// reverse move (AWS → Cloudflare) sends the shell, built from docs/compute/REVERSE-MOVE-CONTRACT.md only
// (never from lane A's code):
//   - the open answers (§5.3: the reverse waiting and blocked answers, after compute-dispatch adds its flag);
//   - `computer.progress` during and after a move (§5.10: the moving view, the open-blocked row, terminal rows);
//   - `summary.computer.reverseMove` (§6.1, ComputerReverseMoveV3).

export const MOVE_COMPUTER = 'move-computer';
export const MOVE_STARTED = '2026-10-30T10:00:00.000Z';
export const MOVE_BUDGET = 13_200;

/** §5.3 the reverse waiting answer, as `previewUrl` / `codePreviewUrl` / `appPreviewUrl` return it (no `awsPreviewAnswer` rewrite). */
export const waitingAnswer = (extra = {}) => ({ ok: false, error: 'computer_moving', errorCode: 'sandbox_starting', retryable: true,
    computeProvider: 'aws-ec2', computeMoving: true, ...extra });
/** §5.3 the reverse blocked answer: a value, deterministic (`preconditions_unmet`). */
export const blockedAnswer = (extra = {}) => ({ ok: false, error: 'computer_move_needs_attention', errorCode: 'preconditions_unmet', retryable: false,
    computeProvider: 'aws-ec2', computeMoveNeedsAttention: true, ...extra });

/** §5.10 phases → the §6.1 step and the row state they come from. */
export const PHASES = {
    export_boot: { step: 0, state: 'booting' },
    exporting: { step: 0, state: 'exporting' },
    importing: { step: 1, state: 'copying' },
    checking: { step: 2, state: 'checking' },
    committing: { step: 3, state: 'flipping' },
};

const base = computerId => ({ version: 2, computerId, paused: false, operationsPaused: false, durable: true, resumePolicy: 'unavailable',
    etaSeconds: null, openingStartedAt: null, path: null, expectedSeconds: null, milestones: [], transition: null, selectedNextOpenHardware: null });

/** The move object of the moving view (§5.10), in flight. */
export function moveDto ({ phase = 'importing', bytesDone = 120_000_000, bytesTotal = 400_000_000, startedAt = MOVE_STARTED, expectedSeconds = 1_110,
    holdOpenable = true, placementState = 'STOPPED', outcome = null, reason = null, retry = null, openBlocked = false, moveId = 'move-1' } = {}) {
    const terminal = outcome !== null;
    return { moveId, direction: 'to_cloudflare', phase: terminal ? null : phase, step: terminal ? null : PHASES[phase].step, startedAt,
        phaseStartedAt: startedAt, expectedSeconds, budgetSeconds: MOVE_BUDGET, bytesDone, bytesTotal, outcome, reason, retry, openBlocked,
        holdOpenable: outcome === 'committed' ? null : holdOpenable, placementState };
}

/** §5.10 the moving view for an in-flight row. `lifecycleState` is always null; the real state is `move.placementState`. */
export function movingProgress ({ computerId = MOVE_COMPUTER, phase = 'importing', bytesDone, bytesTotal, startedAt = MOVE_STARTED, expectedSeconds = 1_110,
    holdOpenable = true, placementState = 'MOUNTING' } = {}) {
    const importing = phase === 'importing';
    const done = bytesDone === undefined ? (importing ? 120_000_000 : null) : bytesDone;
    const total = bytesTotal === undefined ? (['importing', 'checking', 'committing'].includes(phase) ? 400_000_000 : null) : bytesTotal;
    return { ...base(computerId), operation: 'moving', stage: 'moving', recordedStage: PHASES[phase].state, lifecycleState: null,
        needsOperator: false, active: true, startedAt, updatedAt: startedAt,
        bytes: { transferred: done, total }, percent: importing && done !== null && total ? Math.floor(100 * done / total) : null,
        transferStartedAt: importing ? startedAt : null, transferUpdatedAt: importing ? startedAt : null, typicalSeconds: expectedSeconds,
        move: moveDto({ phase, bytesDone: done, bytesTotal: total, startedAt, expectedSeconds, holdOpenable, placementState }) };
}

/** §5.10 the open-blocked row: the moving view with `stage: 'needs_operator'`. */
export function blockedProgress ({ computerId = MOVE_COMPUTER, reason = 'flip_stuck', holdOpenable = true } = {}) {
    return { ...base(computerId), operation: 'moving', stage: 'needs_operator', recordedStage: 'failed_needs_operator', lifecycleState: null,
        needsOperator: true, active: false, startedAt: MOVE_STARTED, updatedAt: MOVE_STARTED, bytes: { transferred: null, total: null }, percent: null,
        transferStartedAt: null, transferUpdatedAt: null, typicalSeconds: 1_110,
        move: moveDto({ outcome: 'failed_needs_operator', reason, retry: 'no', openBlocked: true, holdOpenable, bytesDone: null, bytesTotal: null }) };
}

/**
 * §5.10 a terminal row: today's placement description, plus `move` with its outcome. `stage` never identifies the
 * outcome: `failed_reopened` arrives with the hold's own stage, committed with the Cloudflare placement's.
 */
export function terminalProgress ({ computerId = MOVE_COMPUTER, outcome = 'committed', stage = outcome === 'committed' ? 'unavailable' : 'stopped',
    reason = outcome === 'committed' ? null : 'copy_stalled', retry = outcome === 'committed' ? null : outcome === 'failed_reopened' ? 'now' : 'no',
    holdOpenable = true, lifecycleState = stage === 'stopped' ? 'STOPPED' : null, operation = 'none' } = {}) {
    return { ...base(computerId), durable: false, resumePolicy: 'unavailable', operation, stage, recordedStage: stage, lifecycleState,
        needsOperator: stage === 'needs_operator', active: false, startedAt: null, updatedAt: MOVE_STARTED, bytes: { transferred: null, total: null },
        percent: null, transferStartedAt: null, transferUpdatedAt: null, typicalSeconds: 240,
        move: moveDto({ outcome, reason, retry, holdOpenable, openBlocked: false, bytesDone: null, bytesTotal: null }) };
}

/** §6.1 `summary.computer.reverseMove` (ComputerReverseMoveV3). Bytes are decimal strings here (numbers in `computer.progress`). */
export function reverseMove ({ stage = 'saving', bytesDone = '0', bytesTotal = null, reason = null, skipped = null, retainUntil = null,
    retry = null, openBlocked = false, holdOpenable = true } = {}) {
    return { direction: 'to_cloudflare', stage, bytesDone, bytesTotal, reason, skipped, retainUntil, retry, openBlocked, holdOpenable };
}
