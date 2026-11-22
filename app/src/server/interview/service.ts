/**
 * The interview route handlers (docs/contracts/interview-evidence-v1.md §7.3), as pure `{status, body}` producers.
 *
 * Authentication stays the one implementation: a route resolves `ctx.user` through `createTRPCContext` (shell-http
 * for the candidate, bearer + `isTelemetryAdmin` for admin) and passes the result in. These handlers add only the
 * interview-specific recognition the contract defines (candidate by EZiL ID subject before consent, by OS account
 * after it; telemetry-admin for the operator routes). Every refusal uses the shell body `{error:{code, message}}`.
 *
 * The staging gate is checked FIRST in every handler, so a closed gate is 404 `not_found` even for an
 * unauthenticated caller (acceptance A6). Nothing is written for a non-candidate (A3, A4).
 */
import { isTelemetryAdmin } from '@/server/telemetry/admin';

import { INTERVIEW_NOTICE, NOTICE_SHA256, NOTICE_VERSION } from './notice';
import { validateClientEvent } from './events';
import {
    acceptConsent, appendClientEvents, finishInterview, getInterviewById, getInterviewByUrl, isCandidate,
    listEvents, registerInterview, startInterview, type InterviewDb, type InterviewRow,
} from './store';

export interface HandlerResult { status: number; body: unknown }

const ok = (status: number, body: unknown): HandlerResult => ({ status, body });
const refuse = (status: number, code: string, message: string): HandlerResult => ({ status, body: { error: { code, message } } });
const GATE_OFF = refuse(404, 'not_found', 'Not found.');
const UNAUTHENTICATED: HandlerResult = { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.', reason: 'session_missing' } } };
const IDENTITY_REFRESH: HandlerResult = refuse(409, 'IDENTITY_REFRESH_REQUIRED', 'Confirm your EZiL ID to continue.');

/** Lowercase UUID v4 (schema `$defs/uuid`): the interviewId minted by Works. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BIGINT_RE = /^[1-9][0-9]{0,18}$/;

/**
 * The canonical git-qa remote for a raw `?repo=` address, lowercased exactly like github.com (`works/repo-url.ts`
 * and the os-access gate), or null when it is not a git-qa repository URL. Accepts an optional `.git` and trailing
 * slash on input; the stored and looked-up form is always `https://git-qa.ezil.work/<owner>/<name>.git`.
 */
export function canonicalGitQaUrl(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length > 256) return null;
    let url: URL;
    try { url = new URL(raw); } catch { return null; }
    if (url.protocol !== 'https:' || url.host !== 'git-qa.ezil.work' || url.search || url.hash || url.username || url.password) return null;
    const match = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.exec(url.pathname.replace(/\.git$/, '').replace(/\/$/, ''));
    if (!match) return null;
    const owner = match[1]!.toLowerCase();
    const name = match[2]!.toLowerCase();
    if (name.includes('..') || name.endsWith('.') || name.endsWith('.git')) return null;
    return `https://git-qa.ezil.work/${owner}/${name}.git`;
}

const identityOf = (row: InterviewRow) => ({
    interviewId: row.interviewId,
    repositoryId: row.repositoryId,
    canonicalURL: row.canonicalUrl,
    osUserId: row.osUserId,
    ezilIdSubject: row.ownerEzilIdSubject,
    worksAccountId: row.worksAccountId,
});

/** The candidate's own EZiL ID subject when available, else null (the route resolves the retained identity). */
export type SubjectThunk = () => Promise<string | null>;

// ── Shell: POST /api/shell/interview-consent ────────────────────────────────────────────────────────────────────
export async function consentStatus(db: InterviewDb, input: {
    gateOn: boolean; osUserId: string | null; subject: SubjectThunk; url: unknown;
}): Promise<HandlerResult> {
    if (!input.gateOn) return GATE_OFF;
    if (input.osUserId === null) return UNAUTHENTICATED;
    const canonicalUrl = canonicalGitQaUrl(input.url);
    if (!canonicalUrl) return ok(200, { interview: null });
    const row = await getInterviewByUrl(db, canonicalUrl);
    if (!row) return ok(200, { interview: null });
    let ezilIdSubject: string | null = null;
    if (row.osUserId === null) {
        ezilIdSubject = await input.subject();
        if (ezilIdSubject === null) return IDENTITY_REFRESH;
    }
    if (!isCandidate(row, { osUserId: input.osUserId, ezilIdSubject })) return refuse(404, 'repo_not_found', 'Repository not found.');
    return ok(200, { interview: { interviewId: row.interviewId, state: row.state, notice: INTERVIEW_NOTICE } });
}

export async function consentAccept(db: InterviewDb, input: {
    gateOn: boolean; osUserId: string | null; subject: SubjectThunk;
    interviewId: unknown; noticeVersion: unknown; noticeSha256: unknown; now: () => string;
}): Promise<HandlerResult> {
    if (!input.gateOn) return GATE_OFF;
    if (input.osUserId === null) return UNAUTHENTICATED;
    if (typeof input.interviewId !== 'string' || !UUID_V4.test(input.interviewId)) return refuse(404, 'repo_not_found', 'Repository not found.');
    const row = await getInterviewById(db, input.interviewId);
    if (!row) return refuse(404, 'repo_not_found', 'Repository not found.');
    let ezilIdSubject: string | null = null;
    if (row.osUserId === null) {
        ezilIdSubject = await input.subject();
        if (ezilIdSubject === null) return IDENTITY_REFRESH;
    }
    if (!isCandidate(row, { osUserId: input.osUserId, ezilIdSubject })) return refuse(404, 'repo_not_found', 'Repository not found.');
    if (input.noticeVersion !== NOTICE_VERSION || input.noticeSha256 !== NOTICE_SHA256) return refuse(409, 'notice_mismatch', 'The recording notice has changed; reload to read it again.');
    const result = await acceptConsent(db, {
        // The bound identity-tuple subject is always the Works owner's EZiL ID subject (contract §1; the candidate
        // IS the owner). It is a non-null 1-255-char column, so never the empty-string fallback the old expression
        // risked; `ezilIdSubject` above only decides candidate recognition before consent.
        interviewId: input.interviewId, osUserId: input.osUserId, ezilIdSubject: row.ownerEzilIdSubject,
        noticeSha256: NOTICE_SHA256, noticeVersion: NOTICE_VERSION, at: input.now(),
    });
    switch (result.kind) {
        case 'consented':
        case 'idempotent':
            return ok(200, { accepted: true, state: 'consented' });
        case 'wrong_state':
            return refuse(409, 'interview_state', 'This interview can no longer be accepted.');
        case 'not_candidate':
            return refuse(404, 'repo_not_found', 'Repository not found.');
    }
}

// ── Shell: POST /api/shell/interview-events ─────────────────────────────────────────────────────────────────────
export async function eventsBatch(db: InterviewDb, input: {
    gateOn: boolean; osUserId: string | null; interviewId: unknown; events: unknown; now: () => string; perMinute?: number;
}): Promise<HandlerResult> {
    if (!input.gateOn) return GATE_OFF;
    if (input.osUserId === null) return UNAUTHENTICATED;
    if (typeof input.interviewId !== 'string' || !UUID_V4.test(input.interviewId)) return refuse(404, 'not_found', 'Not found.');
    if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 20) return refuse(400, 'invalid_event', 'A batch is 1 to 20 valid events.');
    const clean = [];
    for (const event of input.events) {
        const valid = validateClientEvent(event);
        if (!valid) return refuse(400, 'invalid_event', 'A batch is 1 to 20 valid events.');
        clean.push(valid);
    }
    const result = await appendClientEvents(db, {
        interviewId: input.interviewId, osUserId: input.osUserId, events: clean, at: input.now(), perMinute: input.perMinute,
    });
    switch (result.kind) {
        case 'accepted': return ok(202, { accepted: result.accepted });
        case 'rate_limited': return refuse(429, 'rate_limited', 'Too many events; slow down.');
        case 'not_found': return refuse(404, 'not_found', 'Not found.');
    }
}

// ── Admin: createTRPCContext bearer + isTelemetryAdmin (the route computes `authz`) ──────────────────────────────
export type Authz = 'ok' | 'unauthorized' | 'forbidden';

/**
 * Admin authorization reuses the existing telemetry-admin gate, so adding a bearer-authenticated CLI route adds no
 * new way to AUTHORIZE: `createTRPCContext` resolved the user, `isTelemetryAdmin` decides. 401 when no user resolved,
 * 403 when the user is not a telemetry admin.
 */
export function adminAuthzOf(user: { email?: string | null } | null | undefined, allowList: string | undefined): Authz {
    if (!user) return 'unauthorized';
    return isTelemetryAdmin(user.email, allowList) ? 'ok' : 'forbidden';
}

function adminGuard(gateOn: boolean, authz: Authz): HandlerResult | null {
    if (!gateOn) return GATE_OFF;
    if (authz === 'unauthorized') return refuse(401, 'unauthorized', 'Sign in to continue.');
    if (authz === 'forbidden') return refuse(403, 'forbidden', 'Not permitted.');
    return null;
}

/**
 * E4 (§7.1): the OS admin routes require an `Authorization: Bearer` header and must NOT fall back to the Supabase
 * session cookie, so they cannot be driven from a browser page. The route resolves `createTRPCContext` ONLY when a
 * bearer is present, so a cookie-only request never reaches the cookie fallback. A6 still wins: a closed gate is 404
 * for everyone, bearer or not. Returns a short-circuit `{status, body}`, or null to proceed to `createTRPCContext`.
 */
export function adminBearerPrecheck(gateOn: boolean, authorization: string | null | undefined): HandlerResult | null {
    if (typeof authorization === 'string' && /^Bearer[ \t]+\S/i.test(authorization.trim())) return null;
    return gateOn ? refuse(401, 'unauthorized', 'Sign in to continue.') : GATE_OFF;
}

export async function adminRegister(db: InterviewDb, input: { gateOn: boolean; authz: Authz; body: unknown }): Promise<HandlerResult> {
    const denied = adminGuard(input.gateOn, input.authz);
    if (denied) return denied;
    const body = input.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse(400, 'invalid_request', 'Invalid body.');
    const { interviewId, repositoryId, canonicalURL, handle, ownerEzilIdSubject, worksAccountId } = body as Record<string, unknown>;
    if (typeof interviewId !== 'string' || !UUID_V4.test(interviewId)
        || typeof repositoryId !== 'string' || !BIGINT_RE.test(repositoryId)
        || typeof canonicalURL !== 'string'
        || typeof handle !== 'string' || handle.length < 1 || handle.length > 100
        || typeof ownerEzilIdSubject !== 'string' || ownerEzilIdSubject.length < 1 || ownerEzilIdSubject.length > 255
        || typeof worksAccountId !== 'string' || !BIGINT_RE.test(worksAccountId)) {
        return refuse(400, 'invalid_request', 'Invalid body.');
    }
    // E5 (§7.3): the canonicalURL must already be the exact form the os-access git-qa parser produces
    // (https://git-qa.ezil.work/<owner>/<name>.git, lowercase as Works returns it). A non-canonical spelling —
    // uppercase owner/name, a trailing slash, an explicit :443, a missing .git — is refused, never normalised, so
    // the gate's and consent's exact-string lookups only ever key on the one spelling.
    if (canonicalGitQaUrl(canonicalURL) !== canonicalURL) return refuse(400, 'invalid_request', 'canonicalURL is not in canonical form.');
    const outcome = await registerInterview(db, { interviewId, repositoryId, canonicalUrl: canonicalURL, handle, ownerEzilIdSubject, worksAccountId });
    if (outcome === 'conflict') return refuse(409, 'conflict', 'A different interview already exists for this id or URL.');
    const row = await getInterviewById(db, interviewId);
    return ok(outcome === 'created' ? 201 : 200, { interviewId, state: row!.state, identity: identityOf(row!) });
}

export async function adminGet(db: InterviewDb, input: { gateOn: boolean; authz: Authz; interviewId: unknown }): Promise<HandlerResult> {
    const denied = adminGuard(input.gateOn, input.authz);
    if (denied) return denied;
    if (typeof input.interviewId !== 'string' || !UUID_V4.test(input.interviewId)) return refuse(404, 'not_found', 'Not found.');
    const row = await getInterviewById(db, input.interviewId);
    if (!row) return refuse(404, 'not_found', 'Not found.');
    return ok(200, {
        interviewId: row.interviewId, state: row.state, identity: identityOf(row), noticeSha256: row.noticeSha256,
        registeredAt: row.registeredAt, consentedAt: row.consentedAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
    });
}

export async function adminStart(db: InterviewDb, input: { gateOn: boolean; authz: Authz; interviewId: unknown; now: () => string }): Promise<HandlerResult> {
    const denied = adminGuard(input.gateOn, input.authz);
    if (denied) return denied;
    if (typeof input.interviewId !== 'string' || !UUID_V4.test(input.interviewId)) return refuse(404, 'not_found', 'Not found.');
    const result = await startInterview(db, input.interviewId, input.now());
    if (result === 'not_found') return refuse(404, 'not_found', 'Not found.');
    if (result === 'wrong_state') return refuse(409, 'interview_state', 'The interview must be consented to start.');
    const row = await getInterviewById(db, input.interviewId);
    return ok(200, { interviewId: input.interviewId, state: 'started', startedAt: row!.startedAt });
}

export async function adminFinish(db: InterviewDb, input: { gateOn: boolean; authz: Authz; interviewId: unknown; now: () => string }): Promise<HandlerResult> {
    const denied = adminGuard(input.gateOn, input.authz);
    if (denied) return denied;
    if (typeof input.interviewId !== 'string' || !UUID_V4.test(input.interviewId)) return refuse(404, 'not_found', 'Not found.');
    const result = await finishInterview(db, input.interviewId, input.now());
    if (result === 'not_found') return refuse(404, 'not_found', 'Not found.');
    const row = await getInterviewById(db, input.interviewId);
    return ok(200, { interviewId: input.interviewId, state: 'finished', finishedAt: row!.finishedAt });
}

export async function adminEvents(db: InterviewDb, input: { gateOn: boolean; authz: Authz; interviewId: unknown }): Promise<HandlerResult> {
    const denied = adminGuard(input.gateOn, input.authz);
    if (denied) return denied;
    if (typeof input.interviewId !== 'string' || !UUID_V4.test(input.interviewId)) return refuse(404, 'not_found', 'Not found.');
    const row = await getInterviewById(db, input.interviewId);
    if (!row) return refuse(404, 'not_found', 'Not found.');
    const events = await listEvents(db, input.interviewId);
    return ok(200, { v: 1, interviewId: row.interviewId, identity: identityOf(row), events });
}
