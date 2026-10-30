// EZiL app opening surface (round 5, decision D5). Physical app readiness stays owned by the caller.
//
// ONE calm surface while an app opens: the app icon, an "Opening {App}" title, ONE bar, ONE status
// line (the loading-stage sentence `computer-progress.js` `progressView` produced) and a muted
// elapsed/expected line. Nothing else unless the server says something needs the user (a hold,
// needs_operator, the ten-minute budget) or the open failed. No step list, no ticks, no ring, no
// reassurance/bytes/"Estimated" lines and never a dev paragraph: dev details live only in a
// closed, always-`hidden` <details> (data for diagnostics), and only when `features.devDetails`
// is boolean true.
//
// THE BAR (one source of truth per open):
//   fill = max(previous, 0.88·(1 − e^(−2.2·t/T)), stage floor)
//   t  = seconds since THIS client first saw this open (kept across re-opens, null polls and a
//        changed server timestamp: the live 1:25 → 0:01 reset cannot happen)
//   T  = the observation's expected seconds; without an observation there is no basis for a
//        position and the bar is an indeterminate sweep until a real signal arrives
//   floors: getting your computer 0.05, attaching 0.35, starting 0.60, opening the app 0.85
//   a measured transfer shows its real percent (cap 99); 100 only on the real ready signal.
//
// This file owns no clock: it reads `Date.now()` when the caller paints (the 250 ms tick) and when
// the shared observer reports. `computerProgress()`/`hasComputerProgress()` always return the LIVE
// observation, so every wait/fail verdict the callers take is unchanged; only the display holds
// the last observation of this open through a gap.

import {
    BOOT_FAILURE_COPY,
    BOOT_NOT_CONFIGURED_COPY,
    LONG_BOOT_MS,
    TYPICAL_BOOT_MS,
} from '../boot-phases.js';

import { observeComputerProgress, OPENING_COPY, OPENING_MILESTONES, formatElapsed, prefersReducedMotion } from './computer-progress.js';
import { isNative } from '../native-runtime.js';

import { LAUNCH_COPY } from '../launch-copy.js';

// Like the boot copy tables, static text is rendered via textContent.
const MIGRATION_COPY = {
    title: 'Moving your computer to AWS (India)',
    body: 'This first start takes a few minutes. Your files come with you.',
};

/** Copy owned by this surface. */
export const OPEN_COPY = {
    long: 'Taking longer than usual',
    stillStarting: 'Your computer is still starting',
    /** needs_operator, by the action the surface offers (never "check status" beside a Try again). */
    attentionRetry: 'Starting it stopped before it finished.',
    attentionManual: 'Your computer needs a fix on our side. Your files stay on your own disk.',
    retry: 'Try again',
    viewStatus: 'View computer status',
    details: 'Details',
};

const CURVE_MAX = 0.88;
const CURVE_RATE = 2.2;
/** Stage floors by server milestone index (requested … desktop_ready, then the client's url_received). */
const OPENING_FLOOR = [0.05, 0.05, 0.35, 0.6, 0.85, 0.85];
/**
 * Round 6 (R3-4): a connect (this open began on a running computer with nothing opening) eases from its
 * floor toward this over the server's connect expectation, instead of parking at 85% until the frame.
 */
const CONNECT_MAX = 0.97;
/**
 * Round 6 (seam C): the Worker's bound on a desktop taking this host boot's config (one push, its 30 s agent
 * tick, then a container stop and start: worker/src/aws-ice.ts AWS_DESKTOP_CONFIG_APPLY_MS). While the server
 * says the computer is preparing, this is the wait's expectation, measured from when it was first seen.
 */
export const PREPARE_EXPECTED_S = 150;
/** Migration steps: saving, getting the AWS computer, moving (the real percent governs), starting. */
const MIGRATION_FLOOR = [0.05, 0.05, 0.05, 0.6];
/** `progressView` maps a measured transfer into this segment of its own migration bar. */
const TRANSFER_SEGMENT = [0.25, 0.85];
const URL_RECEIVED = OPENING_MILESTONES.indexOf('url_received');
const FIRST_FRAME = OPENING_MILESTONES.indexOf('first_frame');
/** Server holds that are not failures: the server says wait; no bar. */
const HOLDS = ['operations_paused', 'queued'];
/** aria-valuenow is rewritten at most this often (and on a stage or state change). */
const ARIA_EVERY_MS = 5000;
/** The meta line appears after this long: a warm open finishes before it is ever read. */
const META_AFTER_S = 3;

/**
 * The bar position, 0..1. Pure.
 * @param {{t?: number, T?: number, floor?: number, prev?: number, real?: number|null, reducedMotion?: boolean}} input
 */
export function openingFill ({ t = 0, T = 240, floor = 0, prev = 0, real = null, reducedMotion = false } = {}) {
    const curve = real === null && T > 0 ? CURVE_MAX * (1 - Math.exp(-CURVE_RATE * Math.max(0, t) / T)) : 0;
    let value = Math.min(0.99, Math.max(curve, floor, real ?? 0));
    if (reducedMotion) value = Math.floor(value * 20 + 1e-9) / 20;
    return Math.max(prev, value);
}

const expectText = T => T < 60 ? 'usually under a minute' : `usually about ${Math.max(1, Math.round(T / 60))} min`;
/** Seam C: the preparing status. The meta line shows the elapsed time only, so nothing contradicts it. */
export const preparingText = app => `Preparing ${app} — the first open after your computer starts takes a minute or two.`;
const ICON_URL = /^(?:data:image\/(?:svg\+xml|png|gif|webp|jpeg)[;,]|https:\/\/|\/(?!\/))/;
const feedbackAvailable = () => typeof globalThis.window?.__EZIL_BOOT__?.desktopState?.endpoints?.feedback === 'string';
/** "Opening Code…" → "Code". */
const appNameOf = label => String(label ?? '').replace(/^Opening\s+/, '').replace(/…$/, '').trim();

/** Settings → Computer, through the shell's own registry. */
function viewComputerStatus () {
    try {
        const registry = globalThis.ezil?.registry;
        const payload = globalThis.window?.__EZIL_BOOT__;
        const ctx = { payload, computer: payload?.computer, desktopState: payload?.desktopState };
        void Promise.resolve(registry?.launch?.('settings', { ...(registry.launchContext?.(ctx) ?? ctx), initialTab: 'computers' })).catch(() => {});
    } catch { /* The surface never throws from a click. */ }
}

/**
 * Build the surface once. Returns a controller the caller drives with the same
 * `{ el, render, stamp, dispose }` shape every app window already uses.
 *
 * @param {object} opts
 * @param {string} [opts.computerId] Observe this computer's `computer.progress` (hosted only).
 * @param {() => void} [opts.onProgressChange]
 * @param {string} [opts.label] The title while opening: "Opening Browser…", "Opening Code…".
 * @param {string} [opts.appName] Defaults to the label's app.
 * @param {string} [opts.icon] The app's icon (a data: or same-origin URL).
 * @param {string} [opts.className] Extra root class (the desktop window keeps the `.ezil-boot` hooks).
 * @param {() => void} [opts.onRetry] Called by Try again.
 * @param {() => void} [opts.onViewStatus] Called by "View computer status" (default: Settings → Computer).
 * @param {() => boolean} [opts.isMigrating] Reads this computer's observed migration state.
 * @param {() => boolean} [opts.isLaunching] Reads this computer's observed fresh launch state.
 * @param {() => boolean} [opts.isPreparing] Round 6 (seam C): the server said this computer's desktop is taking its
 *   config (or code-server is starting after it). Seen once, the open shows that wait to its end.
 * @param {{title: string, body: string}} [opts.failureCopy] Static app-specific failure guidance.
 */
export function AppSpinner ({ computerId, onProgressChange, label = 'Opening…', appName, icon, className, onRetry, onViewStatus,
    failureCopy, isMigrating = () => false, isLaunching = () => false, isPreparing = () => false } = {}) {
    const root = document.createElement('div');
    root.className = 'ezil-app-spinner';
    if (typeof className === 'string' && className) root.classList.add(...className.split(/\s+/).filter(Boolean));
    root.dataset.state = 'opening';
    root.innerHTML = `
        <div class="ezil-opening ezil-app-spinner-panel">
            <div class="ezil-opening-icon" aria-hidden="true"></div>
            <h1 class="ezil-opening-title ezil-boot-title ezil-app-spinner-label" aria-live="polite"></h1>
            <div class="ezil-opening-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="ezil-opening-fill"></div></div>
            <p class="ezil-opening-status ezil-boot-sub ezil-app-spinner-sub" aria-live="polite" hidden></p>
            <p class="ezil-opening-meta" aria-hidden="true" hidden></p>
            <div class="ezil-boot-actions" hidden>
                <button type="button" class="ezil-opening-action ezil-boot-retry" hidden></button>
                <button type="button" class="ezil-opening-action ezil-opening-view-status" hidden></button>
                <button type="button" class="ezil-opening-action is-secondary ezil-opening-feedback" hidden></button>
            </div>
            <details class="ezil-opening-details" hidden><summary></summary><p class="ezil-opening-details-text"></p></details>
        </div>`;
    const el = sel => root.querySelector(sel);
    const el_icon = el('.ezil-opening-icon'), el_title = el('.ezil-opening-title'), el_bar = el('.ezil-opening-bar');
    const el_fill = el('.ezil-opening-fill'), el_status = el('.ezil-opening-status'), el_meta = el('.ezil-opening-meta');
    const el_actions = el('.ezil-boot-actions'), el_retry = el('.ezil-boot-retry'), el_view = el('.ezil-opening-view-status');
    const el_feedback = el('.ezil-opening-feedback'), el_details = el('.ezil-opening-details'), el_details_text = el('.ezil-opening-details-text');

    const name = String(appName ?? appNameOf(label) ?? '').trim();
    if (typeof icon === 'string' && ICON_URL.test(icon)) {
        const img = document.createElement('img'); img.alt = ''; img.src = icon; el_icon.appendChild(img);
    } else el_icon.textContent = (name || 'E').slice(0, 1).toUpperCase();
    el_retry.textContent = OPEN_COPY.retry;
    el_feedback.textContent = OPENING_COPY.feedback;
    el('.ezil-opening-details summary').textContent = OPEN_COPY.details;

    let failureCode;
    const swallow = e => { e.preventDefault(); e.stopPropagation(); };
    // Try again releases a ten-minute hold: the next progress paint may start a fresh open.
    el_retry.addEventListener('click', e => { swallow(e); if (open) open.hold = false; if (typeof onRetry === 'function') onRetry(); });
    el_view.addEventListener('click', e => { swallow(e); (typeof onViewStatus === 'function' ? onViewStatus : viewComputerStatus)(); });
    el_feedback.addEventListener('click', e => {
        swallow(e);
        // L3's dialog; it prefills the RAW server code (round 4).
        void import('./feedback/feedback.js').then(m => m.open_feedback_dialog?.({ source: 'opening', errorCode: failureCode }))
            .catch(() => {});
    });

    let observation = null, latestState = null, latestExtra = {}, progressChecked = false, client = 0;
    /**
     * This open, from the client's first sight of it to ready / failure. `t0` anchors the elapsed
     * clock; `high` is the bar's high-water; `view`/`T` hold the last observation for the display
     * (`T`: the last OPENING expectation; a connect answer carries none); `connect`: this open is a
     * connect, set by its first opening-or-connect observation and cleared for good by an opening
     * (or a move) seen inside it (round 6, R3-4). `prepare`: round 6 seam C, `{at, from}` (this open's
     * elapsed seconds and its bar) when the server first said the computer is preparing; never cleared.
     */
    let open = null;
    let aria = { at: -Infinity, key: null };

    // Rendered as `progress` = this window's open is in flight: a not-yet-recorded opening never reads "stopped".
    // A fresh open after a concluded one gets a fresh observer, so no first-sight clock carries over.
    const makeObserver = () => computerId && !isNative() ? observeComputerProgress({ computerId, element: root, appName: name,
        openRequested: () => latestState?.kind === 'progress', onChange: value => {
            observation = value; progressChecked = true;
            if (latestState) render(latestState, latestExtra);
            onProgressChange?.();
        } }) : null;
    let observer = makeObserver();
    root.dataset.progress = observer ? 'pending' : 'none';
    el_title.textContent = label;

    /**
     * Write the DOM. textContent only; nothing is rebuilt.
     * @param {{state: string, title: string, status?: string, meta?: string, bar: null | 'indeterminate' | number,
     *   retry?: boolean, view?: boolean, feedback?: boolean, details?: string|null}} m
     */
    function paint (m) {
        const now = Date.now();
        const changed = root.dataset.state !== m.state || el_status.textContent !== (m.status ?? '');
        root.dataset.state = m.state;
        root.dataset.reducedMotion = String(prefersReducedMotion());
        // Live regions are written only when their words change: a 250 ms tick never re-announces.
        if (el_title.textContent !== m.title) el_title.textContent = m.title;
        if (el_status.textContent !== (m.status ?? '')) el_status.textContent = m.status ?? '';
        el_status.hidden = !m.status;
        el_meta.textContent = m.meta ?? ''; el_meta.hidden = !m.meta;
        el_bar.hidden = m.bar === null;
        el_bar.setAttribute('aria-label', m.title);
        if (m.bar === 'indeterminate') {
            el_bar.dataset.indeterminate = 'true'; delete el_bar.dataset.percent;
            el_bar.removeAttribute('aria-valuenow'); el_bar.removeAttribute('aria-valuetext');
            el_fill.style.width = '';
        } else if (typeof m.bar === 'number') {
            const percent = Math.max(0, Math.min(100, Math.round(m.bar * 100)));
            delete el_bar.dataset.indeterminate;
            el_bar.dataset.percent = String(percent);
            // The fill follows every paint (the 250 ms tick); the CSS transition smooths it.
            el_fill.style.width = `${percent}%`;
            const key = `${m.state}|${m.status ?? ''}`;
            if (changed || aria.key !== key || now - aria.at >= ARIA_EVERY_MS || percent === 100 || !el_bar.hasAttribute('aria-valuenow')) {
                el_bar.setAttribute('aria-valuenow', String(percent));
                el_bar.setAttribute('aria-valuetext', m.state === 'long' ? `${m.status || m.title}, ${OPEN_COPY.long.toLowerCase()}` : (m.status || m.title));
                aria = { at: now, key };
            }
        }
        el_retry.hidden = !m.retry;
        el_view.hidden = !m.view;
        // Its words exist only while it is offered: a hidden control adds no copy to the surface.
        el_view.textContent = m.view ? OPEN_COPY.viewStatus : '';
        el_feedback.hidden = !(m.feedback && feedbackAvailable());
        el_actions.hidden = el_retry.hidden && el_view.hidden && el_feedback.hidden;
        // Dev details are data for diagnostics only: the block never paints on the surface.
        el_details_text.textContent = m.details ?? '';
        el_details.hidden = true;
        el_details.open = false;
    }

    /** This open concluded (ready, failed, not configured): the next progress paint is a fresh open. */
    const endOpen = () => { if (open) { open.ended = true; open.hold = false; } };
    const elapsedOf = () => open ? Math.max(0, (Date.now() - open.t0) / 1000) : 0;
    const metaFor = (t, T, long) => long ? `${OPEN_COPY.long} · ${formatElapsed(t)}` : t >= META_AFTER_S ? `${formatElapsed(t)} · ${expectText(T)}` : '';
    const reduced = () => prefersReducedMotion();
    const frozen = () => open && open.high > 0 ? open.high : null;

    /**
     * Round 6 (seam C): the preparing wait. Its expectation is the Worker's 150 s bound from when it was first seen
     * (never "under a minute"), stated by the status line; the meta line shows only the elapsed time until that bound
     * passes. The bar eases from where it stood when preparing was seen toward CONNECT_MAX over that bound, so it
     * never steps back or parks; 100 only on the first frame.
     */
    function paintPreparing (t, floor, details) {
        const since = Math.max(0, t - open.prepare.at);
        const long = since >= PREPARE_EXPECTED_S;
        const from = Math.max(open.prepare.from, floor);
        const real = from + (CONNECT_MAX - from) * (1 - Math.exp(-CURVE_RATE * since / PREPARE_EXPECTED_S));
        open.high = client >= FIRST_FRAME ? 1 : openingFill({ t, T: PREPARE_EXPECTED_S, floor, prev: open.high, real, reducedMotion: reduced() });
        const app = name || 'your desktop';
        paint({
            state: long ? 'long' : 'opening', title: label,
            status: client >= URL_RECEIVED ? `Waiting for ${app} to answer…` : preparingText(app),
            meta: long ? `${OPEN_COPY.long} · ${formatElapsed(t)}` : t >= META_AFTER_S ? formatElapsed(t) : '',
            bar: open.high, details,
        });
    }

    /**
     * @param {import('../boot-phases.js').BootUiState} state
     * @param {{elapsedMs?: number, reopening?: boolean}} [extra] `reopening`: the desktop window is
     *   re-asking because the AWS observation said the computer is still opening.
     */
    function render (state, extra = {}) {
        latestState = state; latestExtra = extra ?? {};
        const pending = state.kind === 'progress' || state.kind === 'failed';
        if (!pending) { observer?.stop(); observation = null; progressChecked = false; }
        // Round 4: the raw server code (e.g. `billing_files_on_aws`), not the classified reason.
        failureCode = state.kind === 'failed' ? state.errorCode ?? state.reason : observation?.stage === 'needs_operator' ? 'needs_operator' : undefined;
        const activeTimeout = state.kind === 'failed' && state.reason === 'timeout' && observation?.activeAws;
        // The ten-minute stop reads the longer of the clock the user sees (this live open's) and the
        // server's; `observedBudgetSpent`: the desktop window's own ten-minute clock ran out first.
        // An open the ten-minute stop ended keeps its clock (`hold`) until Try again, so the stop
        // never flips back to a fresh 0:00 open on the next tick.
        const clientT = open && (!open.ended || open.hold) ? elapsedOf() : 0;
        const runningLong = (state.kind === 'progress' || activeTimeout) && observation?.activeAws
            && (Math.max(clientT, observation.elapsed) >= 600 || state.observedBudgetSpent === true);
        root.setAttribute('data-kind', activeTimeout ? 'progress' : state.kind);
        // The caller's estimate and its one real signal, as data for diagnostics; never drawn.
        if (state.kind === 'progress') { root.dataset.phase = state.currentPhase ?? ''; root.dataset.confirmed = String(state.confirmed === true); }
        else delete root.dataset.phase;
        root.classList.toggle('ezil-app-spinner-running-long', !!runningLong);
        const progressing = state.kind === 'progress' || activeTimeout;

        // The open: started by the first progress paint after a concluded one, never by a re-open.
        if (progressing && !runningLong && (!open || open.ended)) {
            if (open && observer) { observer.stop(); observer = makeObserver(); observation = null; progressChecked = false; }
            open = { t0: Date.now(), high: 0, view: null, T: null, ended: false, hold: false, connect: null, prepare: null };
            client = 0;
        }
        // Seam C: latched for the rest of this open, so a later answer without the flag (the desktop's container
        // restarting) never flips it back to a connect's expectation.
        if (open && !open.ended && progressing && !open.prepare && client < URL_RECEIVED && isPreparing() === true) {
            open.prepare = { at: elapsedOf(), from: open.high };
        }
        if (pending) observer?.start();
        if (observer) root.dataset.progress = observation ? 'observed' : progressChecked ? 'unavailable' : 'pending';
        if (open && observation && progressing) {
            open.view = observation;
            // A connect answer's `expected` is only the 240 s fallback: it never replaces an opening's own.
            if (observation.connect !== true) open.T = observation.expected ?? open.T;
            // Holds (no bar) neither make nor break a connect; an opening seen inside one makes it an opening to the end.
            if (observation.bar) open.connect = (open.connect ?? true) && observation.connect === true;
        }
        const view = observation ?? (progressing && open && !open.ended ? open.view : null);
        const details = view?.updated ? `Last recorded update: ${view.updated}` : null;

        const showObservation = pending && view && (progressing
            || ['operations_paused', 'needs_operator', 'queued', 'failed_reopened'].includes(view.stage));
        if (showObservation) {
            const stage = view.stage;
            const attention = stage === 'needs_operator';
            const hold = HOLDS.includes(stage);
            const reopened = stage === 'failed_reopened';
            // The existing predicate: one action, never from a client clock alone.
            const retry = !!(runningLong || reopened || (state.kind === 'failed' && attention && !view.manualAttention));
            const viewStatus = !retry && ((attention && view.manualAttention) || stage === 'operations_paused');
            if (runningLong || attention || hold || reopened) {
                if (open && runningLong) { open.ended = true; open.hold = true; } else if (open && state.kind === 'failed') endOpen();
                paint({
                    state: reopened ? 'failed' : 'attention',
                    title: runningLong ? label : view.title,
                    status: runningLong ? OPENING_COPY.runningLong
                        : attention ? (view.manualAttention ? OPEN_COPY.attentionManual : OPEN_COPY.attentionRetry) : view.body,
                    bar: attention || runningLong ? frozen() : null,
                    retry, view: viewStatus, feedback: attention || retry, details,
                });
                return;
            }
            const t = elapsedOf();
            if (open?.prepare) {
                const reached = Math.max(0, view.bar?.reached ?? 0);
                const opening = !view.bar || view.bar.floors.length === OPENING_MILESTONES.length;
                const floor = opening ? OPENING_FLOOR[Math.min(Math.max(reached, Math.min(client, URL_RECEIVED)), OPENING_FLOOR.length - 1)] : 0;
                paintPreparing(t, floor, details);
                return;
            }
            // Round 6 (R3-4): a connect (this open began on a running computer with nothing opening) runs on the
            // server's connect expectation; an opening that reaches running keeps the expectation it had.
            const connecting = view.connect === true && open?.connect === true && view.connectExpected > 0;
            const T = connecting ? view.connectExpected : view.connect === true && open?.T ? open.T : view.expected ?? open?.T ?? 240;
            const long = t >= T;
            let bar = 'indeterminate';
            if (view.bar || open?.high > 0 || client >= URL_RECEIVED) {
                const opening = !view.bar || view.bar.floors.length === OPENING_MILESTONES.length;
                const reached = Math.max(0, view.bar?.reached ?? 0);
                const index = Math.max(reached, opening ? Math.min(client, URL_RECEIVED) : 0);
                const floor = opening ? OPENING_FLOOR[Math.min(index, OPENING_FLOOR.length - 1)] : MIGRATION_FLOOR[Math.min(reached, MIGRATION_FLOOR.length - 1)];
                const mf = view.bar?.migrationFraction;
                // A connect eases from its floor toward CONNECT_MAX; `real` carries that position, as a transfer's does.
                const real = connecting ? floor + (CONNECT_MAX - floor) * (1 - Math.exp(-CURVE_RATE * t / T))
                    : Number.isFinite(mf) ? (mf - TRANSFER_SEGMENT[0]) / (TRANSFER_SEGMENT[1] - TRANSFER_SEGMENT[0]) : null;
                open.high = client >= FIRST_FRAME ? 1 : openingFill({ t, T, floor, prev: open.high, real, reducedMotion: reduced() });
                bar = open.high;
            }
            const app = name || 'your desktop';
            const status = connecting ? client >= URL_RECEIVED ? `Waiting for ${app} to answer…` : `Connecting to ${app}…`
                : view.body || [view.title, view.bytes].filter(Boolean).join(' · ');
            paint({ state: long ? 'long' : 'opening', title: label, status, meta: metaFor(t, T, long), bar, details });
            return;
        }

        if ( progressing ) {
            // Optional AWS/migration metadata must not replace physical app startup.
            const copy = observer ? null : isMigrating() === true ? MIGRATION_COPY : isLaunching() === true ? LAUNCH_COPY : null;
            const t = elapsedOf();
            if (open?.prepare) {
                paintPreparing(t, client >= URL_RECEIVED ? OPENING_FLOOR[URL_RECEIVED] : state.confirmed === true ? OPENING_FLOOR[3] : 0, null);
                return;
            }
            // An AWS observer that has not answered yet: elapsed only. Its expectation is unknown,
            // so neither "under a minute" nor "taking longer" may be claimed.
            const awaiting = root.dataset.progress === 'pending';
            const long = !awaiting && t >= LONG_BOOT_MS / 1000;
            // No observation: no basis for a position until a real signal (the desktop process is
            // up, or the open answered with a URL). Then the stage floor, never a timer, sets it.
            let bar = 'indeterminate';
            const signal = client >= URL_RECEIVED ? OPENING_FLOOR[URL_RECEIVED] : state.confirmed === true ? OPENING_FLOOR[3] : 0;
            if (client >= FIRST_FRAME) bar = open.high = 1;
            else if (signal > 0 || open.high > 0) bar = open.high = Math.max(open.high, Math.min(0.99, signal));
            paint({
                state: long ? 'long' : 'opening',
                title: copy ? copy.title : label,
                status: copy ? copy.body : extra?.reopening ? OPEN_COPY.stillStarting : '',
                meta: awaiting ? (t >= META_AFTER_S ? formatElapsed(t) : '') : metaFor(t, TYPICAL_BOOT_MS / 1000, long), bar,
            });
            return;
        }

        if ( state.kind === 'not_configured' ) {
            // Nothing to retry: no provider is configured, so the next attempt fails identically.
            endOpen();
            paint({ state: 'attention', title: BOOT_NOT_CONFIGURED_COPY.title, status: BOOT_NOT_CONFIGURED_COPY.body, bar: null });
            return;
        }

        if ( state.kind === 'failed' ) {
            endOpen();
            // `state.copy`: the caller's app-specific words for this one failure (round 6: Code on a running computer).
            const copy = failureCopy ?? state.copy ?? BOOT_FAILURE_COPY[state.reason] ?? BOOT_FAILURE_COPY.unknown;
            paint({ state: 'failed', title: copy.title, status: copy.body, bar: null, retry: true, feedback: true });
            return;
        }

        // 'ready' and 'ready_unverified': the real ready signal. The bar completes and the surface
        // fades; the caller reveals the frame under it (the last frame stays, so no white flash).
        endOpen();
        paint({ state: 'done', title: el_title.textContent || label, status: el_status.textContent, bar: 1 });
    }

    /** The caller's client milestones: `url_received`, then `first_frame` (the bar's 100%); null marks a fresh attempt. */
    function stamp (key) {
        // A fresh attempt inside the same open (a re-open) keeps the elapsed clock and the bar.
        if (key === null) { client = 0; return; }
        const i = OPENING_MILESTONES.indexOf(key);
        if (i > client) { client = i; if (latestState) render(latestState, latestExtra); }
    }

    return { el: root, render, stamp, hasComputerProgress: () => observation !== null, computerProgress: () => observation,
        dispose: () => observer?.stop() };
}

export default AppSpinner;
