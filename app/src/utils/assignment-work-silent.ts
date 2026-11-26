/**
 * Shared, side-effect-free vocabulary of the silent sign-in a cold EZiL OS frame makes inside its own Universe
 * assignment tab (`@/server/auth/work-auth`, `@/app/assignment/work-return/silent-sign-in`). No secrets live here.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ownerTag = /^[0-9a-f]{16}$/;
const assignedRepo = /^https:\/\/github\.ezil\.work\/default\/u-([0-9a-f]{16})-a-([0-9a-f-]{36})\.git$/;

/** The hidden child's start, and the only path that may begin this flow. */
export const workAuthPath = '/assignment/work-auth';
/** child → the OS document that created it, same origin only. */
export const workAuthProtocol = 'ezil.assignment.work-auth/v1';
/**
 * Everything the child ever says. `signed_in`: this browser now holds an OS session for the assigned EZiL ID.
 * `sign_in_required`: id.ezil.work has no session to answer silently. `account_mismatch`: its session, or an existing
 * OS session, is another account. `unavailable`: anything else (lost or replayed transaction, a refused token, …).
 */
export const workAuthOutcomes = ['signed_in', 'sign_in_required', 'account_mismatch', 'unavailable'] as const;
export type WorkAuthOutcome = typeof workAuthOutcomes[number];
/** Marks an authorization `state` as this flow's, so its callback can never take the interactive path. */
export const workAuthStatePrefix = 'ezw1.';

/** The owner tag of the canonical repository assigned to exactly this attempt (`u-<owner>-a-<attempt>`), else null. */
export function assignedRepositoryOwner(repo: string, attemptId: string): string | null {
    const match = assignedRepo.exec(repo);
    return match && uuid.test(attemptId) && match[2] === attemptId ? match[1]! : null;
}

/** The start's query, exactly `attempt`, `owner` and `request` once each, in their fixed shapes; else null. */
export function workAuthQuery(params: URLSearchParams): { attempt: string; owner: string; request: string } | null {
    const keys = [...params.keys()];
    const [attempt, owner, request] = [params.get('attempt') ?? '', params.get('owner') ?? '', params.get('request') ?? ''];
    return keys.length === 3 && new Set(keys).size === 3 && uuid.test(attempt) && ownerTag.test(owner) && uuid.test(request)
        ? { attempt, owner, request } : null;
}
