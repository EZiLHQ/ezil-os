/**
 * The interview open gate (`docs/contracts/interview-evidence-v1.md` §7.5): asked before Code mints, wakes or grants
 * anything for a git-qa repository address (`purpose: 'open'`, `/api/shell/code-preview-url`) and before each Git
 * access renewal (`purpose: 'renew'`, `/api/shell/code-git-access`).
 *
 *  - `none`: the staging gate is off, or no interview has this repository; the caller proceeds as for any repository.
 *  - `refuse`: answer `status` with `code` and do nothing else (`repo_not_found` for anyone but the candidate,
 *    `interview_not_started` before the operator starts it, `interview_finished` after finish).
 *  - `allow`: the interview is started and the caller is its candidate; on `open` the gate has written `computer.opened`.
 *
 * Frozen signature. STUB from the contract commit: it always answers `none`; the os-capture lane replaces the body.
 */
export type InterviewOpenPurpose = 'open' | 'renew';

export interface InterviewOpenGateInput {
    /** Canonical `https://git-qa.ezil.work/<owner>/<name>.git`, as `parseRepositoryUrl` returned it. */
    canonicalURL: string;
    /** The signed-in OS account (GoTrue `auth.users.id`). */
    osUserId: string;
    /** The caller's EZiL ID subject, when the retained identity has one. */
    ezilIdSubject: string | null;
    computerId: string;
    purpose: InterviewOpenPurpose;
}

export type InterviewOpenRefusalCode = 'repo_not_found' | 'interview_not_started' | 'interview_finished';

export type InterviewOpenGateResult =
    | { kind: 'none' }
    | { kind: 'allow'; interviewId: string }
    | { kind: 'refuse'; status: 404 | 409; code: InterviewOpenRefusalCode };

export async function interviewOpenGate(input: InterviewOpenGateInput): Promise<InterviewOpenGateResult> {
    void input;
    return { kind: 'none' };
}
