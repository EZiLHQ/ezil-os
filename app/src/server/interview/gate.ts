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
 * Frozen signature from the contract commit; the os-capture lane fills in the body (contract §7.5, vectors
 * `openGateCases`). Candidate is checked before state, so another EZiL ID is `repo_not_found` in every state and
 * leaves no record. `computer.opened` is written only on an allowed `open`, best-effort — a failed evidence write
 * never blocks the candidate's own computer.
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

import { stagingGitQaAccepted } from '@/server/works/project-repo';

import { getInterviewByUrl, isCandidate, writeComputerOpened, type InterviewDb } from './store';

/** `^[A-Za-z0-9_-]{1,128}$` — the schema's `data:computer.opened.computerId`. Server-supplied; never from the browser. */
const COMPUTER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export async function interviewOpenGate(input: InterviewOpenGateInput): Promise<InterviewOpenGateResult> {
    // Off on production and anywhere the staging gate is closed: the caller proceeds as for any repository.
    if (!stagingGitQaAccepted()) return { kind: 'none' };
    const { db } = await import('@/server/db');
    return runInterviewOpenGate(db, input, () => new Date().toISOString());
}

/** The gate decision with an injected DB and clock, so each `openGateCases` row is proven on PGlite. */
export async function runInterviewOpenGate(
    db: InterviewDb, input: InterviewOpenGateInput, now: () => string,
): Promise<InterviewOpenGateResult> {
    const row = await getInterviewByUrl(db, input.canonicalURL);
    if (!row) return { kind: 'none' };
    if (!isCandidate(row, { osUserId: input.osUserId, ezilIdSubject: input.ezilIdSubject })) {
        return { kind: 'refuse', status: 404, code: 'repo_not_found' };
    }
    if (row.state === 'finished') return { kind: 'refuse', status: 409, code: 'interview_finished' };
    if (row.state !== 'started') return { kind: 'refuse', status: 409, code: 'interview_not_started' };
    if (input.purpose === 'open' && COMPUTER_ID_RE.test(input.computerId)) {
        try {
            await writeComputerOpened(db, row.interviewId, input.computerId, now());
        } catch {
            // Evidence is best-effort; the candidate's own computer must open regardless.
            console.warn('[interview] computer.opened write failed', { interviewId: row.interviewId });
        }
    }
    return { kind: 'allow', interviewId: row.interviewId };
}
