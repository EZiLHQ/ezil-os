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
export function watchRuntimeOnReturn ({ computerId, isLive, reboot, desktopRunning, doc = globalThis.document, win = globalThis.window, now = () => Date.now() }) {
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

export default { RECHECK_AFTER_AWAY_MS, watchRuntimeOnReturn };
