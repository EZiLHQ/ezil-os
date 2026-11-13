// An expired AWS preview cookie is recovered through the signed-in OS, never by
// loading the refused editor URL again or accepting a navigation URL in a message.
//
// S13: an unavailable ORIGIN (the computer's tunnel absent, fenced or of another
// epoch after a placement change or an idle stop; the host not answering behind
// it) is recovered by reopening Code through the server's mint, which waits for
// the origin truthfully (starting) or gives up on its own deadline (unreachable).
// A known stopped computer stays behind its explicit Start. The automatic reopen
// runs at most ONCE per unresolved episode per tab, not once per time window: a
// slow failing reopen (the mint's wake clock is minutes) followed by another
// unavailable document must not earn another automatic reopen. Every later
// unavailable document says Code is unreachable and waits for an explicit Try
// again. Only an editor the server confirmed healthy (`resetOriginRecovery`,
// called by the Code window on its confirmed frame) opens a new episode.
export const CODE_AUTH_REQUIRED = 'ezil:code-auth-required';
export const CODE_ORIGIN_UNAVAILABLE = 'ezil:code-origin-unavailable';
const GUARD_KEY = 'ezil-os:code-auth-reload';
const ORIGIN_EPISODE_KEY = 'ezil-os:code-origin-reopened';
const MIN_GAP_MS = 30_000;

/** The editor was confirmed healthy: the next unavailable origin may be reopened automatically once more. */
export function resetOriginRecovery({ win = null, storage = null } = {}) {
    try { (storage ?? (win ?? window).sessionStorage).removeItem(ORIGIN_EPISODE_KEY); } catch { /* the episode guard then stays conservative */ }
}

export function attachCodeAuthRecovery({ iframe, frameUrl, current, desktopRunning,
    onStopped, onUnknown, reload = () => window.location.reload(),
    reopen = null, onUnreachable = null,
    win = window, storage = null, now = Date.now }) {
    const origin = new URL(frameUrl).origin;
    let disposed = false;
    let checking = false;
    let reloading = false;
    const live = () => !disposed && current() && iframe.src === frameUrl;
    /** Whether the guarded action may run now; records the attempt when it may. Throws when storage is unusable. */
    const guard = (key, explicit) => {
        const store = storage ?? win.sessionStorage;
        if (!explicit) {
            const previous = Number(store.getItem(key));
            if (previous > 0 && now() - previous < MIN_GAP_MS) return false;
        }
        store.setItem(key, String(now()));
        return true;
    };
    async function check() {
        checking = true;
        let running;
        try { running = await desktopRunning(); } catch { running = undefined; }
        checking = false;
        return running;
    }
    async function recover(explicit = false) {
        if (!live() || checking || reloading) return;
        const running = await check();
        if (!live() || reloading) return;
        if (running === false) { onStopped(); return; }
        const retry = () => { if (live()) void recover(true); };
        // A refused/unknown status can mean the OS session expired too. Reloading
        // the OS runs its normal auth bootstrap; it grants no computer access.
        // Only a known stopped computer stays behind its explicit Start action.
        if (!explicit) {
            try { if (!guard(GUARD_KEY, false)) { onUnknown(retry); return; } } catch { onUnknown(retry); return; }
        } else {
            try { guard(GUARD_KEY, true); } catch { /* explicit user retry */ }
        }
        reloading = true;
        reload(); // The existing top OS route preserves this computer, project and folder.
    }
    async function recoverOrigin(explicit = false) {
        if (!live() || checking || reloading) return;
        const running = await check();
        if (!live() || reloading) return;
        if (running === false) { onStopped(); return; }
        const retry = () => { if (live()) void recoverOrigin(true); };
        // Not knowing whether the computer runs is not "reopen it": the cover says so and its Retry asks again.
        if (running === undefined) { onUnknown(retry); return; }
        const unreachable = onUnreachable ?? onUnknown;
        // One automatic reopen per episode, however long each failed reopen took. An explicit retry also
        // belongs to the episode: what follows it is terminal again until the editor is confirmed.
        const store = storage ?? win.sessionStorage;
        if (!explicit) {
            try {
                if (store.getItem(ORIGIN_EPISODE_KEY)) { unreachable(retry); return; }
                store.setItem(ORIGIN_EPISODE_KEY, '1');
            } catch { unreachable(retry); return; }
        } else {
            try { store.setItem(ORIGIN_EPISODE_KEY, '1'); } catch { /* explicit user retry */ }
        }
        reloading = true;
        // The computer runs and its origin did not: reopen Code through the mint, which waits for the origin
        // on its own bounded clock. Without a reopen (an older caller) the OS reload does the same, once.
        (reopen ?? reload)();
    }
    const onMessage = (event) => {
        if (!live() || event.source !== iframe.contentWindow || event.origin !== origin) return;
        const type = event.data?.type;
        if (type === CODE_AUTH_REQUIRED) void recover();
        else if (type === CODE_ORIGIN_UNAVAILABLE) void recoverOrigin();
    };
    win.addEventListener('message', onMessage);
    return () => { disposed = true; win.removeEventListener('message', onMessage); };
}
