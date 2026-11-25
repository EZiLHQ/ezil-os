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

export function workReturnAttempt(destination: string, path: typeof workReturnPath | '/app/assignment-enrollment' = workReturnPath): string | null {
    const prefix = path + '?attempt=';
    if (!destination.startsWith(prefix)) return null;
    const attempt = destination.slice(prefix.length);
    return uuid.test(attempt) && attempt.length === 36 ? attempt : null;
}

export function embeddedCodeAttempt(params: Record<string, string | string[] | undefined>): string | null {
    const {attempt, assignment, repo} = params;
    if (attempt !== undefined || typeof assignment !== 'string' || !uuid.test(assignment) || typeof repo !== 'string') return null;
    return assignmentRepositoryAttempt(repo) === assignment ? assignment : null;
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
