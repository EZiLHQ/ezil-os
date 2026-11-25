const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const codeRepo = /^https:\/\/github\.ezil\.work\/default\/u-[0-9a-f]{16}-a-([0-9a-f-]{36})\.git$/;
export function assignmentRepositoryAttempt(repo: string): string | null {
    const attempt = codeRepo.exec(repo)?.[1];
    return attempt && uuid.test(attempt) ? attempt : null;
}

export function isAssignmentCodeReturn(path: string): boolean {
    const url = new URL(path, 'https://os.ezil.work');
    if (url.pathname !== '/app/code' || url.searchParams.has('project') || url.searchParams.getAll('repo').length !== 1
        || url.searchParams.getAll('assignment').length > 1) return false;
    const attempt = assignmentRepositoryAttempt(url.searchParams.get('repo') ?? '');
    const hint = url.searchParams.get('assignment');
    return !!attempt && (hint === null || hint === attempt);
}

export const workReturnPath = '/assignment/work-return';
export const embeddedWorkReturnSuffix = '&workspace=1';

export function workReturnAttempt(destination: string, path: typeof workReturnPath | '/app/assignment-enrollment' = workReturnPath): string | null {
    const prefix = path + '?attempt=';
    if (!destination.startsWith(prefix)) return null;
    const value = destination.slice(prefix.length);
    const embedded = path === workReturnPath && value.endsWith(embeddedWorkReturnSuffix);
    const attempt = embedded ? value.slice(0, -embeddedWorkReturnSuffix.length) : value;
    return uuid.test(attempt) && attempt.length === 36 ? attempt : null;
}

export function embeddedCodeAttempt(params: Record<string, string | string[] | undefined>): string | null {
    const {attempt, assignment, repo} = params;
    if (attempt !== undefined || typeof assignment !== 'string' || !uuid.test(assignment) || typeof repo !== 'string') return null;
    return assignmentRepositoryAttempt(repo) === assignment ? assignment : null;
}

const workHost = 'https://universe-staging.ezil.work';
const workProtocol = 'ezil.assignment.work/v2';
export type WorkState = 'authentication_required' | 'preparing' | 'ready' | 'unavailable';
const workStates: readonly WorkState[] = ['authentication_required', 'preparing', 'ready', 'unavailable'];

/**
 * The OS document is the direct child of a top-level Universe page on staging. Where the browser names the ancestors,
 * that one ancestor must be the Universe origin; the parent's origin itself is only trusted from each `discover`.
 */
function embeddedWorkFrame(win: Window): boolean {
    const ancestors = (win.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    return win.location.origin === 'https://os-staging.ezil.work' && win !== win.top && win.parent === win.top
        && (ancestors == null || (ancestors.length === 1 && ancestors[0] === workHost));
}

/**
 * `ezil.assignment.work/v2`, child side. Answers only the actual parent window at the exact Universe origin, only for
 * this attempt, echoing that discover's challenge, and posts only to that origin. `push` re-sends the current state
 * against the latest accepted challenge, which `onDiscover` receives before the reply. Replies carry no proof,
 * repository, computer or recording identifier.
 * 🔴 `shell/ezil/assignment-video/work-protocol.js` is the shell's copy; `assignment-work-auth.test.ts` runs both on one fixture.
 */
export function respondToWorkDiscover(attemptId: string, win: Window, current: () => WorkState, onDiscover?: (challenge: string) => void):
    { dispose: () => void; push: () => void } {
    if (!uuid.test(attemptId) || !embeddedWorkFrame(win)) return { dispose: () => {}, push: () => {} };
    let challenge: string | null = null;
    const push = () => {
        const type = current();
        if (challenge && workStates.includes(type)) win.parent.postMessage({protocol:workProtocol, type, attemptId, challenge}, workHost);
    };
    const receive = (event: MessageEvent) => {
        const data = event.data;
        if (event.source !== win.parent || event.origin !== workHost || data?.protocol !== workProtocol || data.type !== 'discover'
            || data.attemptId !== attemptId || typeof data.challenge !== 'string' || !uuid.test(data.challenge)) return;
        challenge = data.challenge;
        onDiscover?.(data.challenge);
        push();
    };
    win.addEventListener('message', receive);
    return { dispose: () => win.removeEventListener('message', receive), push };
}

/** Only an authenticated parent handoff can prepare the workspace. This reply only explains a sign-in requirement. */
export function listenForWorkSignIn(attemptId: string, win: Window): () => void {
    return respondToWorkDiscover(attemptId, win, () => 'authentication_required').dispose;
}

/**
 * The single framing rule the embed adds: on os-staging, the exact canonical assignment Code entry may be framed by
 * the Universe staging origin only. Every other path, host and query keeps today's headers (no policy is returned).
 */
export function assignmentEmbedFramePolicy(publicOrigin: string, url: { pathname: string; searchParams: URLSearchParams }): string | null {
    if (publicOrigin !== 'https://os-staging.ezil.work' || url.pathname !== '/app/code') return null;
    const params: Record<string, string | string[]> = {};
    for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key);
        params[key] = values.length === 1 ? values[0]! : values;
    }
    return embeddedCodeAttempt(params) ? 'frame-ancestors ' + workHost : null;
}
