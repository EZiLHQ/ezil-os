// `ezil.assignment.work/v2`, child side, for an assignment embedded by its own Universe workspace page.
// 🔴 The shell's copy of `respondToWorkDiscover` in app/src/utils/assignment-work-auth.ts (the bundle cannot import
// app/src). `app/src/utils/assignment-work-auth.test.ts` runs both on one fixture, so a one-sided change fails.
export const WORK_HOST = 'https://universe-staging.ezil.work';
export const WORK_PROTOCOL = 'ezil.assignment.work/v2';
const OS = 'https://os-staging.ezil.work';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const states = ['authentication_required', 'preparing', 'ready', 'unavailable'];

/**
 * The OS document is the direct child of a top-level page on staging. Where the browser names the ancestors, that one
 * ancestor must be the Universe origin. The parent's origin itself is trusted only from each `discover` it sends.
 */
export function embeddedWorkFrame(win) {
    const ancestors = win?.location?.ancestorOrigins;
    return Boolean(win) && win.location.origin === OS && win !== win.top && win.parent === win.top
        && (ancestors == null || (ancestors.length === 1 && ancestors[0] === WORK_HOST));
}

/**
 * Answers only the actual parent window at the exact Universe origin, only for this attempt, echoing that discover's
 * challenge, and posts only to that origin, never `*`. `push` re-sends the current state against the latest accepted
 * challenge, which `onDiscover` receives before the reply. Replies carry no proof, repository, computer or recording id.
 */
export function respondToWorkDiscover(attemptId, win, current, onDiscover) {
    if (!uuid.test(attemptId) || !embeddedWorkFrame(win)) return {dispose() {}, push() {}};
    let challenge = null;
    const push = () => {
        const type = current();
        if (challenge && states.includes(type)) win.parent.postMessage({protocol:WORK_PROTOCOL, type, attemptId, challenge}, WORK_HOST);
    };
    const receive = (event) => {
        const data = event.data;
        if (event.source !== win.parent || event.origin !== WORK_HOST || data?.protocol !== WORK_PROTOCOL || data.type !== 'discover'
            || data.attemptId !== attemptId || typeof data.challenge !== 'string' || !uuid.test(data.challenge)) return;
        challenge = data.challenge;
        onDiscover?.(challenge);
        push();
    };
    win.addEventListener('message', receive);
    return {dispose: () => win.removeEventListener('message', receive), push};
}
