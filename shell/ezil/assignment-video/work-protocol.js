// `ezil.assignment.work/v2`, child side, for an assignment embedded by its own Universe workspace page.
// 🔴 The shell's copy of `respondToWorkDiscover` in app/src/utils/assignment-work-auth.ts (the bundle cannot import
// app/src). `app/src/utils/assignment-work-auth.test.ts` runs both on one fixture, so a one-sided change fails.
export const WORK_PROTOCOL = 'ezil.assignment.work/v2';
// The one Universe origin that may frame each EZiL OS origin. OS and Universe are selected as one deployment, so
// production pairs only with production and staging only with staging; no other host is ever a parent.
const WORK_HOSTS = new Map([
    ['https://os.ezil.work', 'https://universe.ezil.work'],
    ['https://os-staging.ezil.work', 'https://universe-staging.ezil.work'],
]);
export const workHostFor = origin => WORK_HOSTS.get(origin) ?? null;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const states = ['authentication_required', 'preparing', 'ready', 'unavailable'];

/**
 * The paired Universe origin when this OS document is the direct child of a top-level page, else null. Where the
 * browser names the ancestors, that one ancestor must be that origin. The parent's origin itself is trusted only from
 * each `discover` it sends.
 */
export function embeddedWorkHost(win) {
    const host = workHostFor(win?.location?.origin);
    const ancestors = win?.location?.ancestorOrigins;
    return host && win !== win.top && win.parent === win.top
        && (ancestors == null || (ancestors.length === 1 && ancestors[0] === host)) ? host : null;
}
export const embeddedWorkFrame = win => embeddedWorkHost(win) !== null;

/**
 * Answers only the actual parent window at the exact paired Universe origin, only for this attempt, echoing that
 * discover's challenge, and posts only to that origin, never `*`. `push` re-sends the current state against the latest
 * accepted challenge, which `onDiscover` receives before the reply. Replies carry no proof, repository, computer or
 * recording id.
 */
export function respondToWorkDiscover(attemptId, win, current, onDiscover) {
    const host = uuid.test(attemptId) ? embeddedWorkHost(win) : null;
    if (!host) return {dispose() {}, push() {}};
    let challenge = null;
    const push = () => {
        const type = current();
        if (challenge && states.includes(type)) win.parent.postMessage({protocol:WORK_PROTOCOL, type, attemptId, challenge}, host);
    };
    const receive = (event) => {
        const data = event.data;
        if (event.source !== win.parent || event.origin !== host || data?.protocol !== WORK_PROTOCOL || data.type !== 'discover'
            || data.attemptId !== attemptId || typeof data.challenge !== 'string' || !uuid.test(data.challenge)) return;
        challenge = data.challenge;
        onDiscover?.(challenge);
        push();
    };
    win.addEventListener('message', receive);
    return {dispose: () => win.removeEventListener('message', receive), push};
}
