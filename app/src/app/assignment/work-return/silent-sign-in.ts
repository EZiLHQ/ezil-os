import { respondToWorkDiscover, type WorkState } from '@/utils/assignment-work-auth';
import { assignedRepositoryOwner, workAuthOutcomes, workAuthPath, workAuthProtocol, type WorkAuthOutcome } from '@/utils/assignment-work-silent';

/** How long the hidden child may take before the frame asks for the ordinary sign-in instead. */
export const SILENT_TIMEOUT_MS = 12_000;
/** One silent attempt per assignment per tab in this long, across this frame's own reload. */
export const SILENT_MARKER_KEY = 'ezil.assignment.work-auth';
export const SILENT_MARKER_TTL_MS = 5 * 60_000;

/** True once, and only when the tab can remember it: without that there is no proof a reload would not try again. */
function claim(win: Window, attemptId: string): boolean {
    try {
        const now = Date.now();
        const seen: unknown = JSON.parse(win.sessionStorage.getItem(SILENT_MARKER_KEY) ?? 'null');
        if (seen && typeof seen === 'object' && (seen as { attempt?: unknown }).attempt === attemptId) {
            const at = (seen as { at?: unknown }).at;
            if (typeof at === 'number' && at <= now && now - at < SILENT_MARKER_TTL_MS) return false;
        }
        win.sessionStorage.setItem(SILENT_MARKER_KEY, JSON.stringify({ attempt: attemptId, at: now }));
        return win.sessionStorage.getItem(SILENT_MARKER_KEY) !== null;
    } catch {
        return false;
    }
}

/**
 * A cold EZiL OS frame (no OS session) inside its own Universe assignment tab.
 *
 * Nothing happens until the actual Universe parent has asked (`respondToWorkDiscover`: this document is that tab's
 * direct child, the message came from that window at that exact origin, for this attempt). Then, once per assignment
 * per tab, ONE hidden same-origin child tries a silent EZiL ID sign-in (`@/server/auth/work-auth`) while this frame
 * answers `preparing`. The child's answer counts only from that child's own window at this origin, carrying this
 * attempt's random request id and one of the fixed outcomes.
 *
 * - `signed_in` for this attempt: only THIS frame reloads. The Universe tab, and its screen capture, stay as they are.
 * - anything else, or no answer in time: the child is removed and the frame answers `authentication_required`, which
 *   is Universe's existing top-level sign-in. Nothing is retried, and no sign-in page is ever shown in a frame.
 * - no usable sessionStorage, no assigned repository in the address, or not `/app/code`: no attempt at all.
 */
export function silentWorkSignIn(attemptId: string, win: Window, onPending?: (pending: boolean) => void): () => void {
    let state: WorkState = 'authentication_required';
    let asked = false, done = false, request: string | null = null;
    let child: HTMLIFrameElement | null = null;
    let timer: ReturnType<Window['setTimeout']> | undefined;
    function cleanup() {
        win.removeEventListener('message', receive);
        win.clearTimeout(timer);
        child?.remove();
        child = null;
    }
    function finish(outcome: WorkAuthOutcome, answeredAttempt: unknown) {
        if (done) return;
        done = true;
        cleanup();
        // Still `preparing` until the new document answers for itself.
        if (outcome === 'signed_in' && answeredAttempt === attemptId) { win.location.reload(); return; }
        state = 'authentication_required';
        onPending?.(false);
        responder.push();
    }
    function receive(event: MessageEvent) {
        const data = event.data as { protocol?: unknown; request?: unknown; attemptId?: unknown; outcome?: unknown } | null;
        if (!child || event.source !== child.contentWindow || event.origin !== win.location.origin || !data || typeof data !== 'object'
            || data.protocol !== workAuthProtocol || data.request !== request
            || !(workAuthOutcomes as readonly unknown[]).includes(data.outcome)) return;
        finish(data.outcome as WorkAuthOutcome, data.attemptId);
    }
    function begin() {
        if (asked) return;
        asked = true;
        try {
            const owner = win.location.pathname === '/app/code'
                ? assignedRepositoryOwner(new URLSearchParams(win.location.search).get('repo') ?? '', attemptId) : null;
            if (!owner || !claim(win, attemptId)) return;
            request = win.crypto.randomUUID();
            const frame = win.document.createElement('iframe');
            frame.hidden = true;
            frame.tabIndex = -1;
            frame.setAttribute('aria-hidden', 'true');
            frame.referrerPolicy = 'no-referrer';
            frame.style.display = 'none';
            frame.src = workAuthPath + '?' + new URLSearchParams({ attempt: attemptId, owner, request });
            child = frame;
            win.addEventListener('message', receive);
            timer = win.setTimeout(() => finish('unavailable', null), SILENT_TIMEOUT_MS);
            win.document.body.append(frame);
            state = 'preparing';
            onPending?.(true);
        } catch {
            cleanup();
            done = true;
            state = 'authentication_required';
        }
    }
    // `begin` runs inside the accepted discover, before its reply is sent, so that reply already says `preparing`.
    const responder = respondToWorkDiscover(attemptId, win, () => state, begin);
    return () => { done = true; cleanup(); responder.dispose(); };
}
