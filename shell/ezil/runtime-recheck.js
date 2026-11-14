// runtime-recheck.js — EZiL-authored. Not Puter code.
//
// When someone comes BACK to a window whose computer may have idle-stopped
// while they were away, ask before the stale frame is used.
//
// A preview URL is bound to the container runtime that minted it. Once the
// Worker idle-stops the computer (`IDLE_STOP_MS`, nobody present), every
// request from the still-open frame answers `410 STALE_PREVIEW_URL` — raw JSON
// inside the window — and nothing in the window used to notice. Production
// 2026-10-04 showed exactly that body to the founder.
//
// The rule, deliberately narrow:
//   * Only on RETURN — the tab becoming visible again, or the window regaining
//     focus — after having been away at least `RECHECK_AFTER_AWAY_MS`. Never on
//     a timer, so an abandoned tab never wakes anything (the billing rule the
//     whole idle-stop path exists for), and never during a boot, where "not
//     running yet" is the normal answer.
//   * Only the cheap status probe (`session.desktopRunning`: never wakes a
//     container) is asked, and only an explicit `false` acts. `undefined` (no
//     answer) is not an observation and does nothing.
//   * Only a window whose frame was live (`isLive()`) reboots, through its own
//     `start_boot()` — the same bounded boot path, fresh URL, same computer.

/** Shorter than the server's 10-minute idle window, so any absence that could have ended in a stop is re-checked. */
export const RECHECK_AFTER_AWAY_MS = 5 * 60_000;

/**
 * @param {{ computerId: string, isLive: () => boolean, reboot: () => void,
 *           desktopRunning: (id: string) => Promise<boolean|undefined>,
 *           doc?: Document, win?: Window, now?: () => number }} opts
 * @returns {() => void} stop watching
 */
function watchLegacyRuntimeOnReturn ({ computerId, isLive, reboot, desktopRunning, doc = globalThis.document, win = globalThis.window, now = () => Date.now() }) {
    let away_since = null;
    let stopped = false;
    let checking = false;
    const present = () => doc.visibilityState === 'visible'
        && (typeof doc.hasFocus !== 'function' || doc.hasFocus());

    const on_change = async () => {
        if ( stopped ) return;
        if ( ! present() ) {
            if ( away_since === null ) away_since = now();
            return;
        }
        if ( away_since === null ) return;
        const away_ms = now() - away_since;
        away_since = null;
        if ( away_ms < RECHECK_AFTER_AWAY_MS || checking || ! isLive() ) return;
        checking = true;
        try {
            const running = await desktopRunning(computerId);
            if ( ! stopped && running === false && isLive() ) reboot();
        } finally {
            checking = false;
        }
    };

    doc.addEventListener('visibilitychange', on_change);
    win.addEventListener('focus', on_change);
    win.addEventListener('blur', on_change);
    return () => {
        stopped = true;
        doc.removeEventListener('visibilitychange', on_change);
        win.removeEventListener('focus', on_change);
        win.removeEventListener('blur', on_change);
    };
}

/**
 * Code opts into one unknown-answer retry and truthful checking/unknown UI. Other callers retain the exact legacy
 * return policy above. The generation getter binds a chain to its account and boot attempt. Only cheap GETs run;
 * an in-flight GET keeps its existing timeout, but close/away/generation changes discard its answer and future retry.
 */
export function watchRuntimeOnReturn (options) {
    if ( options.retryUnknownMs === undefined ) return watchLegacyRuntimeOnReturn(options);
    const { computerId, isLive, reboot, desktopRunning, generation, onCheckState = () => {},
        retryUnknownMs, doc = globalThis.document, win = globalThis.window, now = () => Date.now(),
        schedule = setTimeout, cancel = clearTimeout, online = () => win.navigator?.onLine !== false } = options;
    if ( ! Number.isInteger(retryUnknownMs) || retryUnknownMs < 0 || retryUnknownMs > 5000 || typeof generation !== 'function' ) {
        throw new TypeError('A bounded retry and generation getter are required');
    }
    let awaySince = null, stopped = false, inFlight = false, chain = null, timer = null;
    const present = () => doc.visibilityState === 'visible' && (typeof doc.hasFocus !== 'function' || doc.hasFocus());
    const currentScope = scope => {
        try { return !stopped && isLive() && generation() === scope; } catch { return false; }
    };
    const current = candidate => chain === candidate && currentScope(candidate.scope);
    const clearTimer = () => { if (timer !== null) cancel(timer); timer = null; };
    const retryFor = scope => () => {
        if (currentScope(scope) && present()) begin(scope);
    };
    const notify = (candidate, state) => { if (current(candidate)) onCheckState(state, retryFor(candidate.scope)); };
    const abandon = (showUnknown = false) => {
        clearTimer();
        if (chain && showUnknown) notify(chain, 'unknown');
        chain = null;
    };
    async function probe (candidate) {
        if (!current(candidate)) { if (chain === candidate) abandon(); return; }
        if (!present() || !online()) { abandon(true); return; }
        if (inFlight) return; // The old bounded GET's finally starts a queued current chain, never overlaps it.
        inFlight = true;
        let answer;
        try { answer = await desktopRunning(computerId); } catch { answer = undefined; }
        finally { inFlight = false; }
        if (current(candidate)) {
            if (!present() || !online()) abandon(true);
            else if (answer === false) { chain = null; clearTimer(); reboot(); }
            else if (answer === true) { notify(candidate, 'running'); chain = null; }
            else if (candidate.retryLeft) {
                candidate.retryLeft = false;
                timer = schedule(() => { timer = null; void probe(candidate); }, retryUnknownMs);
            } else abandon(true);
        } else if (chain === candidate) abandon();
        if (chain && chain !== candidate) void probe(chain);
    }
    function begin (scope) {
        abandon();
        const candidate = { scope, retryLeft: true }; chain = candidate;
        if (!current(candidate)) { abandon(); return; }
        if (!present() || !online()) { abandon(true); return; }
        notify(candidate, 'checking');
        void probe(candidate);
    }
    const change = () => {
        if (stopped) return;
        if (!present()) {
            if (awaySince === null) awaySince = now();
            abandon(true); return;
        }
        if (awaySince === null) return;
        const elapsed = now() - awaySince; awaySince = null;
        if (elapsed < RECHECK_AFTER_AWAY_MS || !isLive()) return;
        begin(generation());
    };
    const offline = () => abandon(true);
    doc.addEventListener('visibilitychange', change);
    win.addEventListener('focus', change); win.addEventListener('blur', change); win.addEventListener('offline', offline);
    return () => {
        stopped = true; abandon();
        doc.removeEventListener('visibilitychange', change);
        win.removeEventListener('focus', change); win.removeEventListener('blur', change); win.removeEventListener('offline', offline);
    };
}

export default { RECHECK_AFTER_AWAY_MS, watchRuntimeOnReturn };
