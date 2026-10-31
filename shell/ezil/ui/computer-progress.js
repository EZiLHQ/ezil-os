// Read-only observations; polling never advances allocation or migration.
//
// Round 3 (plan §6.5): this file owns the ONE opening surface. `AppSpinner` and
// `BootProgress` both render through `OpeningSurface`: app icon, app name, one
// status line, one thin determinate bar and a muted elapsed time. No step list,
// no percentage text, no countdown, no ring.
//
// The bar is a pure function of server fields (`openingStartedAt`, `expectedSeconds`,
// `milestones`) and the clock, so polls, reloads and two tabs agree without shared
// state: max(milestone floor, min(time ease, next milestone)). Both terms only grow.
import trpc from './Settings/trpc.js';
// Boot features without importing session.js (and its telemetry) into the loader.
const bootFeatures = () => (typeof window === 'undefined' ? undefined : window.__EZIL_BOOT__?.features);

const stages = {
    operations_paused: ['Computer startup is temporarily paused', 'Check this view later for an update.'],
    needs_operator: ['Your computer needs attention', 'Check the computer’s current status before trying again.'],
    queued: ['Waiting to start', 'Waiting for the saved request to begin.'],
    requested: ['Saving your files', 'Preparing the saved workspace for migration.'],
    fenced: ['Workspace secured', 'Preparing the saved workspace for migration.'],
    exported: ['Workspace saved', 'The saved workspace is ready for the new computer.'],
    provisioning: ['Preparing computer', 'Waiting for the new computer before restoring the saved workspace.'],
    restored: ['Workspace restored', 'Waiting for the apps to connect.'],
    committed: ['Starting your desktop', 'Waiting for the apps to connect.'],
    recovering: ['Recovering computer', 'Checking the saved transition before continuing.'],
    failed_reopened: ['Migration did not finish', 'The original computer was reopened. Check its current status before trying again.'],
    stopped: ['Computer stopped', 'Use the normal computer controls to start a session.'],
    leased: ['Preparing computer', 'A computer has been assigned; waiting for startup.'],
    starting: ['Starting computer', 'Startup is in progress.'],
    mounting: ['Attaching saved workspace', 'Reattaching the retained workspace volume, not copying it to a new workspace.'],
    running: ['Computer running', 'Waiting for this app to connect.'],
    draining: ['Saving the session', 'Waiting for the normal stop process to finish.'],
    stopping: ['Stopping computer', 'Waiting for the normal stop process to finish.'],
    retiring: ['Replacing computer', 'Waiting for the previous computer to retire.'],
    retired: ['Previous computer retired', 'Waiting for the current transition status.'],
    purge_eligible: ['Computer stopped', 'No active startup is recorded.'],
    warming: ['Preparing computer', 'Waiting for the computer’s startup checks.'],
    ready: ['Computer prepared', 'Waiting for this app to connect.'],
    claimed: ['Computer assigned', 'Waiting for this app to connect.'],
    switching: ['Saving and closing your session', ''],
    restarting: ['Restarting your computer', ''],
    // A capacity wait is an opening that has not leased yet; never "stopped".
    waiting_capacity: ['Waiting for a machine — this can take a few minutes', ''],
    unavailable: ['Progress unavailable', 'A current progress observation is not available.'],
};

/** Server milestones (contract `OPENING_MILESTONES_V3`), then the two the client stamps. */
export const OPENING_MILESTONES = ['requested', 'host_claimed', 'files_attached', 'desktop_starting', 'desktop_ready', 'url_received', 'first_frame'];
/** The least bar a reached milestone shows. `first_frame` (the ready event) alone is 100%. */
const MILESTONE_FLOOR = [0, 0.25, 0.45, 0.6, 0.78, 0.88, 1];
// The real placement order is LEASED → STARTING → MOUNTING → RUNNING (placement.ts):
// STARTING is the host booting; MOUNTING attaches the retained volume after it.
const openingStages = { provisioning: 0, switching: 0, restarting: 0, waiting_capacity: 0,
    leased: 1, claimed: 1, warming: 1, starting: 1, mounting: 2, running: 4, ready: 4 };
const migrationSteps = ['Saving your files', 'Getting your AWS computer', 'Moving your files', 'Starting your desktop'];
const migrationStages = { requested: 0, fenced: 0, exported: 1, provisioning: 1, restored: 2, committed: 3, mounting: 3, starting: 3, running: 3 };
/** Migration segments; a measured transfer moves the bar inside "Moving your files". */
const MIGRATION_FLOOR = [0, 0.12, 0.25, 0.85, 1];
const HOLD = ['operations_paused', 'needs_operator', 'queued', 'failed_reopened', 'stopped', 'retired', 'purge_eligible'];
/** Copy shared by both surfaces. */
export const OPENING_COPY = {
    long: 'Taking a little longer than usual',
    runningLong: "This is taking longer than usual. We're still working on it — you can keep this open or come back later.",
    feedback: 'Send feedback',
};
/** Ceiling for any bar that is not ready. */
const EASE_CAP = 0.9;

const formatBytes = bytes => bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
const vcpuOf = size => { const m = typeof size === 'string' && /^(?:std|cmp)-(\d+)$/.exec(size); return m ? Number(m[1]) : null; };
const time = value => { const at = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };

// ── Phase B: the reverse move (AWS → Cloudflare), reverse move contract §5.10, §6.4 ─────────────
// While a computer's files move from its AWS computer to its Free computer, `computer.progress` sends the
// MOVING VIEW (`operation: 'moving'`): nothing in it is an opening, and none of the opening clocks apply.
/** §5.10 `budgetSeconds`: the sum of the §5.4 deadlines. The shell never ends a move on its own clock before it + 300 s. */
export const MOVE_BUDGET_SECONDS = 13200;
/**
 * §6.2: the most a move copies (the export cap, lane A's `EXPORT_MAX_BYTES`, which reads this line), in bytes. Shown
 * only in the shell's MB unit (÷ 1,000,000, no decimals), always derived from here: no copy carries the number as a
 * literal. 🔴 Keep it a plain literal.
 */
export const MOVE_LIMIT_BYTES = 536870912;
/** §5.10 phases → the §6.1 step (the same step map the Computer tab's card uses). */
const MOVE_PHASES = { export_boot: 0, exporting: 0, importing: 1, checking: 2, committing: 3 };
const MOVE_OUTCOMES = ['committed', 'failed_reopened', 'failed_needs_operator'];
const MOVE_RETRY = ['now', 'after_aws_session', 'no'];
const count = value => Number.isFinite(value) && value >= 0 ? value : null;

/**
 * This computer's reverse move from a `computer.progress` answer (`move`, §5.10), from server fields only, or null.
 * Read for in-flight rows (the moving view) and for terminal rows alike: a terminal row keeps today's placement
 * description, so only `outcome` and `openBlocked` say how the move ended, never `stage`.
 */
export function moveOf (data, computerId) {
    if (!data || ![1, 2].includes(data.version) || data.computerId !== computerId) return null;
    const m = data.move;
    if (!m || typeof m !== 'object' || m.direction !== 'to_cloudflare') return null;
    const outcome = MOVE_OUTCOMES.includes(m.outcome) ? m.outcome : null;
    const phase = outcome === null && Object.hasOwn(MOVE_PHASES, m.phase) ? m.phase : null;
    const expected = Number.isFinite(m.expectedSeconds) && m.expectedSeconds > 0 ? m.expectedSeconds : null;
    return {
        moveId: typeof m.moveId === 'string' ? m.moveId : null, phase, step: phase === null ? null : MOVE_PHASES[phase],
        startedAtMs: time(m.startedAt), expectedSeconds: expected,
        budgetSeconds: Number.isFinite(m.budgetSeconds) && m.budgetSeconds > 0 ? m.budgetSeconds : MOVE_BUDGET_SECONDS,
        bytesDone: count(m.bytesDone), bytesTotal: count(m.bytesTotal) || null, outcome,
        // The same reason rule as the Computer tab's card (§6.1).
        reason: outcome !== null && /^[a-z0-9_:-]{1,64}$/i.test(String(m.reason ?? '')) ? m.reason : null,
        retry: MOVE_RETRY.includes(m.retry) ? m.retry : null,
        openBlocked: outcome === 'failed_needs_operator' && m.openBlocked === true,
        holdOpenable: typeof m.holdOpenable === 'boolean' ? m.holdOpenable : null,
    };
}

/**
 * §6.4 rule 3: what a moving open loop does after one `computer.progress` read. `ask`: the move is in flight (the
 * moving view) or committed (the open now opens the Free computer). `stop`: a failed outcome; the caller shows it and
 * NEVER asks again (after a failure an ordinary open is a D16 hold boot of the AWS computer). `wait`: the read says
 * nothing about this move (failed, another computer, no move): never an ask.
 */
export function moveAskOf (data, computerId) {
    const move = moveOf(data, computerId);
    if (!move) return 'wait';
    if (move.outcome === 'committed') return 'ask';
    if (move.outcome !== null) return 'stop';
    return data.operation === 'moving' && data.stage === 'moving' ? 'ask' : 'wait';
}

/**
 * 🔴 PHASE B: WHAT THE OPEN LOOP LAST LEARNT ABOUT EACH COMPUTER'S MOVE, for the opening surface. `apps/code.js` and
 * `apps/preview.js` are read-only (§1.1): they hand the surface a plain failure (`preconditions_unmet`,
 * `sandbox_starting`) without the move flags. So `session.js`'s wake loop notes here, per computer:
 *   - `blocked`: whether the LATEST open answer was the reverse blocked answer (`computeMoveNeedsAttention`); every
 *     answer overwrites it. The surface shows the open-blocked card at once from it (§6.2: never a spinner, never a
 *     retry), before any `computer.progress` read of its own has answered;
 *   - `move`/`readAt`: the move its latest `computer.progress` read saw (`moveOf`). The surface paints whichever of
 *     this and its own 5 s poll is newer, so the outcome the loop stopped on is on screen when the loop returns.
 * Server facts about one computer, whichever loop read them; never "this open watched a move" (that stays per open).
 * Kept in this file because both `session.js` and the surface already import it, and the loader never loads session.js.
 */
const loopMoves = new Map();
/** `session.js`, after each open answer for `computerId`. */
export function noteMoveAnswer (computerId, res) {
    if (!computerId) return;
    loopMoves.set(computerId, { ...loopMoves.get(computerId), blocked: res?.ok !== true && res?.computeMoveNeedsAttention === true });
}
/** `session.js`, after each `computer.progress` read of a moving open that saw this computer's move (`moveOf`, non-null). */
export function noteMoveRead (computerId, move, at = Date.now()) {
    if (!computerId || !move) return;
    loopMoves.set(computerId, { ...loopMoves.get(computerId), move, readAt: at });
}
/** The surface's read: `{blocked, move, readAt}` (each possibly absent), or null when no loop has noted anything. */
export function loopMoveOf (computerId) {
    return (computerId && loopMoves.get(computerId)) || null;
}

/** "120 MB of 2.4 GB copied": the Computer tab card's units (`moveView`), never the opening's `formatBytes`. */
export function moveBytesText (done, total) {
    if (!Number.isFinite(done) || done < 0 || !Number.isFinite(total) || total <= 0) return '';
    return `${(done / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })} MB of ${(total / 1e9).toLocaleString('en-US', { maximumFractionDigits: 1 })} GB copied`;
}

/** §6.3/§6.4: the Workspace folder is over the cap (`workspace_too_large`). `holdOpenable: false`: the Free hold can't open it. */
export function moveTooLargeText (holdOpenable) {
    return `Your Workspace folder is larger than a Free computer can hold (${formatBytes(MOVE_LIMIT_BYTES)}), so your files stay on your AWS computer. Nothing was deleted. ${
        holdOpenable === false ? 'Upgrade to use them again.' : 'Remove some files on your AWS computer and try again, or upgrade to keep using them.'}`;
}

/**
 * §6.4 the open overlay's words for a move (status line, one sentence). No countdown, no speed or duration claims,
 * no city or region names. The Computer tab's card (§6.3) words its steps for a card; these are the overlay's.
 */
export const MOVE_COPY = {
    moving: 'Moving your files to your Free computer',
    steps: ['Step 1 of 4: Saving your files.', 'Step 2 of 4: Copying your files.', 'Step 3 of 4: Checking your files.', 'Step 4 of 4: Switching to your Free computer.'],
    committed: 'Your files are on your Free computer',
    committedBody: 'Opening your Free computer.',
    failed: "We couldn't move your files",
    failedBody: "They're still on your AWS computer and nothing was deleted.",
    entitlementPaid: 'Your plan is active again, so your files stay on your AWS computer.',
    regionMissing: "This computer needs a fix on our side before it can open or move; we're looking into it.",
    unfinished: "We couldn't finish moving your files",
    finishing: "We're finishing moving your files",
    blockedBody: "Your files are safe and nothing was deleted. Your computer can't open until we've checked this; we're looking into it.",
    unsettledBody: "Your files are safe on your AWS computer and nothing was deleted. Your computer can't open until we've checked it; we're looking into it.",
    openAws: 'Open my AWS computer',
};

/** §6.4 the overlay's sentence for an in-flight move: the step, and on step 2 the bytes in the card's units. */
export function moveStepText (move) {
    const step = Math.min(3, Math.max(0, move?.step ?? 0));
    const bytes = step === 1 ? moveBytesText(move.bytesDone, move.bytesTotal) : '';
    return bytes ? `${MOVE_COPY.steps[1]} ${bytes}.` : MOVE_COPY.steps[step];
}

/**
 * §6.4 the overlay's outcome, keyed on `move.outcome` and `move.openBlocked` ONLY, never on `stage` (a terminal row
 * carries the placement's own stage). `needsAttention`: the open was answered `computeMoveNeedsAttention`, with or
 * without a `move` read yet. Returns null for a move still in flight. `openAws`: offer [Open my AWS computer] (it
 * re-asks the open: the D16 hold); `committed`: the bar is full and the ordinary Cloudflare open follows.
 */
export function moveOutcomeCopy (move, { needsAttention = false } = {}) {
    if (needsAttention || (move?.outcome === 'failed_needs_operator' && move.openBlocked === true)) {
        return move?.reason === 'boot_unsettled'
            ? { status: MOVE_COPY.unfinished, body: MOVE_COPY.unsettledBody, openAws: false, feedback: true, blocked: true }
            : { status: MOVE_COPY.finishing, body: MOVE_COPY.blockedBody, openAws: false, feedback: true, blocked: true };
    }
    if (move?.outcome === 'committed') return { status: MOVE_COPY.committed, body: MOVE_COPY.committedBody, openAws: false, feedback: false, committed: true };
    const keep = move?.holdOpenable === false ? '' : ', and you can keep using it';
    if (move?.outcome === 'failed_needs_operator') {
        return { status: MOVE_COPY.unfinished, body: `They're safe on your AWS computer and nothing was deleted${keep}. We're looking into it.`,
            openAws: move.holdOpenable === true, feedback: true };
    }
    if (move?.outcome !== 'failed_reopened') return null;
    const body = move.reason === 'entitlement_paid' ? MOVE_COPY.entitlementPaid
        : move.reason === 'workspace_too_large' ? moveTooLargeText(move.holdOpenable)
            : move.reason === 'region_missing' ? `${MOVE_COPY.failedBody} ${MOVE_COPY.regionMissing}` : MOVE_COPY.failedBody;
    return { status: MOVE_COPY.failed, body, openAws: move.holdOpenable === true && move.reason !== 'region_missing', feedback: true };
}

/** The moving view's bar: four equal steps; a measured copy fills step 2's segment. */
const MOVE_FLOOR = [0, 0.25, 0.5, 0.75, 1];

/**
 * §5.10 + §6.4: the moving view (`operation: 'moving'`) as the overlay shows it. In flight: the step and its bar,
 * never an opening (`activeAws` false: no opening budget, no ten-minute stop). The open-blocked row (stage
 * `needs_operator`): the needs-attention card, from the move itself.
 */
function movingView (data, move, { now, firstObservedAt, features }) {
    const blocked = data.stage === 'needs_operator' || move.outcome !== null;
    const startedAtMs = move.startedAtMs ?? time(data.startedAt) ?? firstObservedAt;
    const typical = Number.isFinite(data.typicalSeconds) && data.typicalSeconds > 0 ? data.typicalSeconds : 600;
    const expected = move.expectedSeconds ?? typical;
    const step = move.step ?? 0;
    const outcome = blocked ? moveOutcomeCopy(move, { needsAttention: true }) : null;
    const fraction = step === 1 && move.bytesDone !== null && move.bytesTotal ? Math.min(1, move.bytesDone / move.bytesTotal) : null;
    return {
        stage: blocked ? 'needs_operator' : 'moving', path: null,
        title: blocked ? outcome.status : MOVE_COPY.moving, body: blocked ? outcome.body : moveStepText(move),
        bytes: blocked ? '' : step === 1 ? moveBytesText(move.bytesDone, move.bytesTotal) : '',
        manualAttention: blocked,
        active: !blocked && data.active === true, activeAws: false,
        elapsed: Math.max(0, (now - startedAtMs) / 1000), expected, reached: step, serverReady: false,
        bar: blocked ? null : { startedAtMs, expected, reached: step, floors: MOVE_FLOOR,
            migrationFraction: fraction === null ? null : MOVE_FLOOR[1] + (MOVE_FLOOR[2] - MOVE_FLOOR[1]) * fraction },
        connect: false, connectExpected: null, indeterminate: false, transition: null,
        openingKey: `move:${move.moveId ?? startedAtMs}`,
        updated: features?.devDetails === true && typeof data.updatedAt === 'string' && Number.isFinite(Date.parse(data.updatedAt))
            ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(data.updatedAt)) : null,
        moving: true, move,
    };
}
/**
 * The loading-stage sentence for a reached server milestone (HF3). "Almost there" only at
 * desktop_ready (reached 4, the server's ready): never earlier, never for a hold or failure.
 */
function stageBody (reached, path, appName) {
    if (reached >= 4) return `Almost there — waiting for ${appName || 'your desktop'} to connect.`;
    if (reached >= 3) return `The desktop is starting. ${appName ? `${appName} opens` : 'Your apps open'} next.`;
    if (reached >= 2) return 'Your files are attached. The desktop is starting.';
    if (reached >= 1) return 'A machine is ready and starting up.';
    return path === 'cold' ? 'Preparing a new machine — this can take a few minutes.' : 'Finding a machine for your computer.';
}

/** "0:42", "12:05". */
export function formatElapsed (seconds) {
    const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The bar position, 0..1. Pure and monotonic in `elapsed` and in the floors:
 * the time ease reaches 90% of the way at `expected` and never passes the next
 * milestone; a reached milestone lifts it to its floor. Only `ready` is 1.
 * Reduced motion advances in 10% steps.
 */
export function openingFraction ({ floor = 0, ceiling = EASE_CAP, elapsed = 0, expected = 240, ready = false, reducedMotion = false } = {}) {
    if (ready) return 1;
    const t = expected > 0 ? Math.min(1, Math.max(0, elapsed) / expected) : 0;
    const eased = EASE_CAP * (1 - (1 - t) ** 2);
    let value = Math.max(floor, Math.min(eased, ceiling, EASE_CAP));
    // Whole 10% steps: still monotonic, never above the smooth value.
    if (reducedMotion) value = Math.floor(value * 10 + 1e-9) / 10;
    return Math.min(value, 0.99);
}

/**
 * The bar and elapsed time of a view at `now`. Recomputed on every paint so the
 * elapsed time ticks on the caller's existing clock. `client` is the highest
 * client milestone index (5 = url_received, 6 = first_frame).
 */
export function openingAt (view, now = Date.now(), { reducedMotion = false, client = 0 } = {}) {
    if (!view?.bar) return null;
    const { startedAtMs, expected, floors, reached, migrationFraction } = view.bar;
    const elapsed = Math.max(0, (now - startedAtMs) / 1000);
    const index = Math.min(floors.length - 1, Math.max(reached, client));
    const ready = index >= floors.length - 1;
    const floor = Math.max(floors[index], migrationFraction ?? 0);
    const ceiling = index + 1 < floors.length ? Math.max(floor, floors[index + 1]) : 1;
    const fraction = openingFraction({ floor, ceiling, elapsed, expected, ready, reducedMotion });
    return { percent: Math.round(fraction * 100), elapsed, elapsedText: formatElapsed(elapsed), long: !ready && elapsed > expected };
}

/**
 * `openRequested`: this tab has asked to open the computer (its open is in flight). Until the server
 * records that opening, a stopped computer reads "Starting your computer" with an indeterminate bar,
 * never "Computer stopped". Only the copy changes: `stage`, `active`, `activeAws` and `bar` stay the
 * server's, so every wait/fail decision that reads them is unchanged.
 */
export function progressView(data, computerId, { features = bootFeatures(), now = Date.now(), firstObservedAt = now, appName, openRequested = false } = {}) {
    if (!data || ![1, 2].includes(data.version) || data.computerId !== computerId) return null;
    // Phase B (§6.4): the moving view BEFORE the needs_operator mapping (the open-blocked row sends `needsOperator`
    // and stage `needs_operator`; it is the move's card, not "Your computer needs attention") and before the
    // unknown-stage return (`moving` is a stage only this branch knows).
    if (data.operation === 'moving') {
        const move = moveOf(data, computerId);
        return move ? movingView(data, move, { now, firstObservedAt, features }) : null;
    }
    const stage = data.operationsPaused === true || data.paused === true || data.stage === 'operations_paused' ? 'operations_paused'
        : data.needsOperator === true || ['needs_operator', 'failed_needs_operator'].includes(data.stage) ? 'needs_operator' : data.stage;
    if (!Object.hasOwn(stages, stage) || stage === 'unavailable') return null;
    const migration = data.operation === 'migration';
    // computer.progress records AWS placement stages; Cloudflare reports unavailable.
    const opening = ['opening', 'none'].includes(data.operation) && Object.hasOwn(openingStages, stage);
    const moving = migration && Object.hasOwn(migrationStages, stage)
        ? stage === 'provisioning' && data.bytes?.transferred > 0 ? 2 : migrationStages[stage] : -1;
    // Server milestones never regress; a stage can only lift what they say.
    const stamped = Array.isArray(data.milestones) ? data.milestones.reduce((max, m) => {
        const i = OPENING_MILESTONES.indexOf(m?.key);
        return i >= 0 && i <= 4 && time(m.at) !== null ? Math.max(max, i) : max;
    }, -1) : -1;
    const reached = opening ? Math.max(openingStages[stage], stamped) : moving;
    const serverReady = opening && reached >= 4;
    const transition = data.transition && typeof data.transition === 'object' ? data.transition : null;
    const path = ['warm', 'cold', 'switch', 'migrate', 'restart'].includes(data.path) ? data.path : migration ? 'migrate'
        : ['switch', 'restart'].includes(transition?.kind) && ['requested', 'stopping', 'waking'].includes(transition.phase) ? transition.kind : null;
    // The 600 s budget clock is unchanged: the migration's own start, else this tab's first observation.
    const startedAt = time(data.startedAt);
    const elapsed = Math.max(0, (now - (startedAt ?? firstObservedAt)) / 1000);
    // The bar's clock is the server-stamped opening start, shared by every tab and reload.
    const openingStartedAt = time(data.openingStartedAt) ?? startedAt ?? firstObservedAt;
    // Round 6 (R3-4): running with nothing opening: only an app's connect is left, and the server sends that
    // connect's expectation in `expectedSeconds`. It is kept apart (`connectExpected`): an open that began as an
    // opening and reaches this state keeps the expectation it always had, never a 30 s one at minute three.
    const connect = opening && data.operation === 'none' && stage === 'running';
    const expectation = [data.expectedSeconds, data.typicalSeconds].find(v => Number.isFinite(v) && v > 0);
    const expected = (connect ? undefined : expectation) ?? 240;
    const measured = Number.isFinite(data.bytes?.transferred) && data.bytes.transferred >= 0
        && Number.isFinite(data.bytes?.total) && data.bytes.total >= 0;
    const percent = measured && Number.isFinite(data.percent) && data.percent >= 0 && data.percent <= 100 ? Math.min(99, data.percent) : null;
    const target = vcpuOf(transition?.target);
    const machine = target ? `Getting ${/^(8|11|18)$/.test(String(target)) ? 'an' : 'a'} ${target} vCPU machine` : 'Getting your new machine';
    const waking = transition?.phase === 'waking';
    const starting = !appName || path === 'switch' ? 'Starting your desktop' : `Starting ${appName}`;
    const preOpening = openRequested === true && ['stopped', 'purge_eligible'].includes(stage) && !opening && !migration;
    const hold = HOLD.includes(stage);
    // HF3: while an AWS opening or switch is underway the body is ONE loading-stage sentence, keyed by
    // the server's `reached` (never the client clock), set together with the title so the two agree.
    let title = stages[stage][0], body = preOpening || moving >= 0 || (opening && !hold) ? '' : stages[stage][1];
    if (preOpening) title = 'Starting your computer';
    else if (moving >= 0) title = migrationSteps[moving];
    else if (opening) {
        const healing = IN_FLIGHT.includes(transition?.phase) && transition.reason === 'stop_healing';
        if (healing) {
            title = `Recovering your computer before the ${transition.kind === 'restart' ? 'restart' : 'switch'}`;
            body = 'A release did not confirm; the computer is being checked. Your files are safe.';
        } else if (stage === 'switching') {
            title = waking ? machine : stages.switching[0];
            body = waking ? 'Starting your computer on the new configuration.' : 'Your files stay with your computer.';
        } else if (stage === 'restarting') {
            title = waking ? 'Starting your computer' : stages.restarting[0];
            body = waking ? 'Starting your computer again.' : 'Your files stay with your computer.';
        } else if (stage === 'waiting_capacity') {
            title = stages.waiting_capacity[0]; body = stageBody(0, path, appName);
        } else if (reached >= 3) { title = starting; body = stageBody(reached, path, appName); }
        else if (reached >= 2) { title = 'Attaching your files'; body = stageBody(2, path, appName); }
        else if (path === 'switch') { title = machine; body = 'Starting your computer on the new configuration.'; }
        else { title = 'Starting your computer'; body = stageBody(reached, path, appName); }
    }
    const bar = hold || (!opening && moving < 0) ? null : {
        startedAtMs: openingStartedAt, expected, reached: opening ? reached : moving,
        floors: opening ? MILESTONE_FLOOR : MIGRATION_FLOOR,
        migrationFraction: moving === 2 && percent !== null ? MIGRATION_FLOOR[2] + (MIGRATION_FLOOR[3] - MIGRATION_FLOOR[2]) * percent / 100 : null,
    };
    // Phase B (§5.10): a terminal reverse row keeps today's description and adds `move` (its outcome). With no
    // visible row the view is exactly today's.
    const reverse = moveOf(data, computerId);
    const view = {
        stage, path, title,
        // One loading-stage sentence while opening; none while moving; other states keep one explanatory sentence.
        body,
        bytes: moving === 2 && measured ? `${formatBytes(data.bytes.transferred)} of ${formatBytes(data.bytes.total)}` : '',
        manualAttention: data.recordedStage === 'failed_needs_operator' || data.stage === 'failed_needs_operator',
        active: data.active === true && !['operations_paused', 'needs_operator', 'queued', 'unavailable', 'failed_reopened', 'stopped', 'retired', 'purge_eligible'].includes(stage),
        activeAws: data.active === true && ['migration', 'opening'].includes(data.operation) && !serverReady
            && !['operations_paused', 'needs_operator', 'queued', 'failed_reopened', 'stopped', 'retired', 'purge_eligible'].includes(stage),
        elapsed, expected, reached, serverReady, bar,
        connect, connectExpected: connect ? expectation ?? null : null,
        // No server opening to measure yet: the surface shows an indeterminate bar, never a guessed position.
        indeterminate: preOpening,
        transition: transition ? { transitionId: transition.transitionId, kind: transition.kind, phase: transition.phase, target: transition.target,
            reason: typeof transition.reason === 'string' ? transition.reason : null } : null,
        // The opening, not its path: `cold` becomes `warm` when a pool host is adopted mid-opening.
        openingKey: String(openingStartedAt),
        updated: features?.devDetails === true && typeof data.updatedAt === 'string' && Number.isFinite(Date.parse(data.updatedAt))
            ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(data.updatedAt)) : null,
    };
    return reverse ? { ...view, moving: false, move: reverse } : view;
}

/**
 * `onChange(view, move)`: the view (`progressView`), and on every answered poll this computer's reverse move
 * (`moveOf`, or null). A committed move's row arrives with the Cloudflare placement's stage, which has no view, so
 * the move travels on its own. `move` is undefined when nothing was read (a failed poll, a hidden tab).
 */
export function observeComputerProgress({ computerId, element, onChange, query = trpc.query, appName, openRequested = () => false }) {
    let watching = false, generation = 0, timer, deadline, operation, firstObservedAt;
    async function poll() {
        if (!watching || document.hidden || !element.isConnected) return;
        clearTimeout(timer);
        const own = ++generation;
        let ownDeadline;
        try {
            const result = await Promise.race([
                query('computer.progress', { computerId }),
                new Promise((_, reject) => { deadline = ownDeadline = setTimeout(() => reject(Error('timeout')), 15000); }),
            ]);
            if (watching && own === generation && element.isConnected) {
                const now = Date.now();
                const requested = openRequested() === true;
                let view = result.ok ? progressView(result.data, computerId, { now, appName, openRequested: requested }) : null;
                if (view) {
                    const key = JSON.stringify([result.data.operation, result.data.startedAt ?? null]);
                    if (operation !== key) { operation = key; firstObservedAt = now; }
                    view = progressView(result.data, computerId, { now, firstObservedAt, appName, openRequested: requested });
                }
                onChange(view, result.ok ? moveOf(result.data, computerId) : undefined);
            }
        } catch {
            if (watching && own === generation && element.isConnected) onChange(null);
        } finally {
            clearTimeout(ownDeadline);
            if (watching && own === generation && element.isConnected) timer = setTimeout(poll, 5000);
        }
    }
    const visibility = () => {
        if (document.hidden) { generation++; clearTimeout(timer); clearTimeout(deadline); onChange(null); }
        else void poll();
    };
    return {
        start() {
            if (watching || !computerId || !element.isConnected) return;
            watching = true; document.addEventListener('visibilitychange', visibility); void poll();
        },
        stop() {
            watching = false; generation++; clearTimeout(timer); clearTimeout(deadline);
            document.removeEventListener('visibilitychange', visibility);
        },
    };
}

export const prefersReducedMotion = () => {
    try { return globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true; } catch { return false; }
};
const feedbackAvailable = () => typeof globalThis.window?.__EZIL_BOOT__?.desktopState?.endpoints?.feedback === 'string';
const ICON_URL = /^(?:data:image\/(?:svg\+xml|png|gif|webp|jpeg)[;,]|https:\/\/|\/(?!\/))/;

/**
 * The one opening surface. Builds its DOM once; `paint(model)` only updates it.
 *
 *   model.status   the one status line (or a failure title)
 *   model.body     one sentence: the loading stage while opening, or a failure / hold explanation
 *   model.percent  0..100 for a determinate bar, 'indeterminate', or null (no bar)
 *   model.key      the opening the percent belongs to; the bar never regresses within one
 *   model.meta     muted line: the elapsed time, or the long-wait note
 *   model.retry / model.feedback  show Try again / Send feedback
 *
 * @param {{appName?: string, icon?: string, onRetry?: () => void, feedbackCode?: () => (string|undefined), statusClass?: string, subClass?: string}} [opts]
 */
export function OpeningSurface ({ appName = '', icon, onRetry, feedbackCode, statusClass = '', subClass = '' } = {}) {
    const panel = document.createElement('div');
    panel.className = 'ezil-opening';
    panel.innerHTML = `
        <div class="ezil-opening-icon" aria-hidden="true"></div>
        <p class="ezil-opening-name"></p>
        <h1 class="ezil-boot-title ezil-opening-status ${statusClass}"></h1>
        <div class="ezil-opening-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" hidden><div class="ezil-opening-fill"></div></div>
        <p class="ezil-opening-meta" hidden></p>
        <p class="ezil-boot-sub ezil-opening-sub ${subClass}" hidden></p>
        <div class="ezil-boot-actions" hidden>
            <button type="button" class="ezil-boot-retry">Try again</button>
            <button type="button" class="ezil-opening-feedback" hidden></button>
        </div>`;
    const el = sel => panel.querySelector(sel);
    const el_icon = el('.ezil-opening-icon'), el_name = el('.ezil-opening-name'), el_status = el('.ezil-opening-status');
    const el_bar = el('.ezil-opening-bar'), el_fill = el('.ezil-opening-fill'), el_meta = el('.ezil-opening-meta');
    const el_sub = el('.ezil-opening-sub'), el_actions = el('.ezil-boot-actions'), el_retry = el('.ezil-boot-retry');
    const el_feedback = el('.ezil-opening-feedback');
    const name = String(appName || '').trim();
    el_name.textContent = name; el_name.hidden = !name;
    if (typeof icon === 'string' && ICON_URL.test(icon)) {
        const img = document.createElement('img'); img.alt = ''; img.src = icon; el_icon.appendChild(img);
    } else el_icon.textContent = (name || 'E').slice(0, 1).toUpperCase();
    el_feedback.textContent = OPENING_COPY.feedback;
    const swallow = e => { e.preventDefault(); e.stopPropagation(); };
    el_retry.addEventListener('click', e => { swallow(e); if (typeof onRetry === 'function') onRetry(); });
    el_feedback.addEventListener('click', e => {
        swallow(e);
        // L3's dialog; it prefills the error code (round 4).
        void import('./feedback/feedback.js').then(m => m.open_feedback_dialog?.({ source: 'opening', errorCode: feedbackCode?.() }))
            .catch(() => {});
    });
    let high = { key: null, percent: 0 };
    function paint (model) {
        el_status.textContent = model.status ?? '';
        el_sub.textContent = model.body ?? ''; el_sub.hidden = !model.body;
        const percent = model.percent;
        el_bar.hidden = percent === null || percent === undefined;
        panel.dataset.reducedMotion = String(prefersReducedMotion());
        if (percent === 'indeterminate') {
            el_bar.dataset.indeterminate = 'true'; el_bar.removeAttribute('aria-valuenow'); el_fill.style.width = '';
        } else if (typeof percent === 'number') {
            // Never regress within one opening, whatever a poll or a clock says.
            if (high.key !== (model.key ?? null)) high = { key: model.key ?? null, percent: 0 };
            const shown = Math.max(high.percent, Math.min(100, Math.max(0, Math.round(percent))));
            high.percent = shown;
            delete el_bar.dataset.indeterminate;
            el_bar.setAttribute('aria-valuenow', String(shown));
            el_bar.setAttribute('aria-label', model.status || 'Opening');
            el_fill.style.width = `${shown}%`;
        }
        el_meta.textContent = model.meta ?? ''; el_meta.hidden = !model.meta;
        el_retry.hidden = !model.retry;
        el_feedback.hidden = !(model.feedback && feedbackAvailable());
        el_actions.hidden = el_retry.hidden && el_feedback.hidden;
        panel.dataset.long = String(!!model.long);
    }
    return { el: panel, paint, shown: () => high.percent };
}

/** Shell event a Settings switch/restart dispatches: `{ computerId, transitionId? }`. */
export const TRANSITION_EVENT = 'ezil:computer-transition';
const IN_FLIGHT = ['requested', 'stopping', 'waking'];
/** ~16 minutes of 5 s polls: past every server budget (200 s stop + 600 s wake). */
const TRANSITION_MAX_POLLS = 200;

/**
 * Watch one switch or restart until the server settles it, then call `onSettled`
 * once with the transition (`phase` 'done' or 'failed'). Read-only: the same
 * `computer.progress` polling as the spinner, hidden-tab aware.
 *
 * A settled transition counts only when it is the one asked for (`transitionId`)
 * or, without an id, after this watch saw one in flight, so the record of an
 * earlier switch can never trigger a re-open.
 */
export function watchComputerTransition ({ computerId, element, transitionId = null, onSettled, query }) {
    let polls = 0, seenInFlight = false, done = false;
    const observer = observeComputerProgress({ computerId, element, query, onChange: view => {
        if (done || !view) return;
        if (++polls > TRANSITION_MAX_POLLS) { done = true; observer.stop(); return; }
        const t = view.transition;
        if (!t || (transitionId && t.transitionId !== transitionId)) return;
        if (IN_FLIGHT.includes(t.phase)) { seenInFlight = true; transitionId ??= t.transitionId; return; }
        if (['done', 'failed'].includes(t.phase) && (seenInFlight || transitionId)) {
            done = true; observer.stop(); onSettled?.(t);
        }
    } });
    observer.start();
    return { stop () { done = true; observer.stop(); }, active: () => !done };
}
