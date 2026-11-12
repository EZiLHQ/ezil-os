// An expired AWS preview cookie is recovered through the signed-in OS, never by
// loading the refused editor URL again or accepting a navigation URL in a message.
export const CODE_AUTH_REQUIRED = 'ezil:code-auth-required';
const GUARD_KEY = 'ezil-os:code-auth-reload';
const MIN_GAP_MS = 30_000;

export function attachCodeAuthRecovery({ iframe, frameUrl, current, desktopRunning,
    onStopped, onUnknown, reload = () => window.location.reload(),
    win = window, storage = null, now = Date.now }) {
    const origin = new URL(frameUrl).origin;
    let disposed = false;
    let checking = false;
    let reloading = false;
    const live = () => !disposed && current() && iframe.src === frameUrl;
    async function recover(explicit = false) {
        if (!live() || checking || reloading) return;
        checking = true;
        let running;
        try { running = await desktopRunning(); } catch { running = undefined; }
        checking = false;
        if (!live() || reloading) return;
        if (running === false) { onStopped(); return; }
        const retry = () => { if (live()) void recover(true); };
        // A refused/unknown status can mean the OS session expired too. Reloading
        // the OS runs its normal auth bootstrap; it grants no computer access.
        // Only a known stopped computer stays behind its explicit Start action.
        if (!explicit) {
            try {
                const previous = Number((storage ?? win.sessionStorage).getItem(GUARD_KEY));
                if (previous > 0 && now() - previous < MIN_GAP_MS) { onUnknown(retry); return; }
                (storage ?? win.sessionStorage).setItem(GUARD_KEY, String(now()));
            } catch { onUnknown(retry); return; }
        } else {
            try { (storage ?? win.sessionStorage).setItem(GUARD_KEY, String(now())); } catch { /* explicit user retry */ }
        }
        reloading = true;
        reload(); // The existing top OS route preserves this computer, project and folder.
    }
    const onMessage = (event) => {
        if (!live() || event.source !== iframe.contentWindow || event.origin !== origin
            || event.data?.type !== CODE_AUTH_REQUIRED) return;
        void recover();
    };
    win.addEventListener('message', onMessage);
    return () => { disposed = true; win.removeEventListener('message', onMessage); };
}
