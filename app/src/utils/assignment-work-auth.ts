const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const codeRepo = /^https:\/\/github\.ezil\.work\/default\/u-[0-9a-f]{16}-a-([0-9a-f-]{36})\.git$/;
export const workReturnPath = '/assignment/work-return';

export function workReturnAttempt(destination: string): string | null {
    const prefix = workReturnPath + '?attempt=';
    if (!destination.startsWith(prefix)) return null;
    const attempt = destination.slice(prefix.length);
    return uuid.test(attempt) && attempt.length === 36 ? attempt : null;
}

export function embeddedCodeAttempt(params: Record<string, string | string[] | undefined>): string | null {
    const {attempt, assignment, repo} = params;
    if (attempt !== undefined || typeof assignment !== 'string' || !uuid.test(assignment) || typeof repo !== 'string') return null;
    return codeRepo.exec(repo)?.[1] === assignment ? assignment : null;
}

/** Only an authenticated parent handoff can prepare the workspace. This reply only explains a sign-in requirement. */
export function listenForWorkSignIn(attemptId: string, win: Window): () => void {
    const universe = 'https://universe-staging.ezil.work';
    const protocol = 'ezil.assignment.work/v2';
    if (!uuid.test(attemptId) || win.location.origin !== 'https://os-staging.ezil.work' || win === win.top || win.parent !== win.top)
        return () => {};
    const receive = (event: MessageEvent) => {
        const data = event.data;
        if (event.source !== win.parent || event.origin !== universe || data?.protocol !== protocol || data.type !== 'discover'
            || data.attemptId !== attemptId || typeof data.challenge !== 'string' || !uuid.test(data.challenge)) return;
        win.parent.postMessage({protocol, type:'authentication_required', attemptId, challenge:data.challenge}, universe);
    };
    win.addEventListener('message', receive);
    return () => win.removeEventListener('message', receive);
}
