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
    const expected = [data.expectedSeconds, data.typicalSeconds].find(v => Number.isFinite(v) && v > 0) ?? 240;
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
    return {
        stage, path, title,
        // One loading-stage sentence while opening; none while moving; other states keep one explanatory sentence.
        body,
        bytes: moving === 2 && measured ? `${formatBytes(data.bytes.transferred)} of ${formatBytes(data.bytes.total)}` : '',
        manualAttention: data.recordedStage === 'failed_needs_operator' || data.stage === 'failed_needs_operator',
        active: data.active === true && !['operations_paused', 'needs_operator', 'queued', 'unavailable', 'failed_reopened', 'stopped', 'retired', 'purge_eligible'].includes(stage),
        activeAws: data.active === true && ['migration', 'opening'].includes(data.operation) && !serverReady
            && !['operations_paused', 'needs_operator', 'queued', 'failed_reopened', 'stopped', 'retired', 'purge_eligible'].includes(stage),
        elapsed, expected, reached, serverReady, bar,
        // No server opening to measure yet: the surface shows an indeterminate bar, never a guessed position.
        indeterminate: preOpening,
        transition: transition ? { transitionId: transition.transitionId, kind: transition.kind, phase: transition.phase, target: transition.target,
            reason: typeof transition.reason === 'string' ? transition.reason : null } : null,
        // The opening, not its path: `cold` becomes `warm` when a pool host is adopted mid-opening.
        openingKey: String(openingStartedAt),
        updated: features?.devDetails === true && typeof data.updatedAt === 'string' && Number.isFinite(Date.parse(data.updatedAt))
            ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(data.updatedAt)) : null,
    };
}

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
                onChange(view);
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
 *   model.body     one sentence, only for failures and hold states
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
