import { osActorHeaders } from '@/server/assignment-video/os-actor';
import { expectedRepositoryURL } from './assignment-repository-name';
import 'server-only';

import { z } from 'zod';

import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { assignmentAuthority, productionAssignment } from '@/server/assignment-video/authority';
import { projectRepoOrigin, ProjectRepoError } from '@/server/works/project-repo';
import { fetchRepositoryTree, GitFetchError, type RepoFetcher } from '@/server/works/git-smart-http';

import { grantForStandaloneGit, GitAccessError } from './access';
import { assignmentManifest, BOOTSTRAP_REF, BootstrapError, pushAssignmentBootstrap } from './assignment-bootstrap';
import type { PrivateGitPacket } from './private-packet';

/**
 * Self-serve assignment repository enrollment (RUN-1122), os-staging only, for named QA Builders or the participant of a specifically enabled staging job.
 *
 * One signed-in participant, one Universe attempt, one new private repository on the standalone gateway, owned by
 * that participant's own EZiL ID:
 *
 * 1. Universe `prepare` (`POST {UNIVERSE_PROJECT_REPO_ORIGIN}/internal/assignment-repositories/enrollment`) checks the
 *    token's subject is the attempt's participant and answers the deterministic repository `name` and a challenge.
 * 2. Reconcile first: a write grant for the expected owner-bound URL. Only when the gateway has no such repository
 *    is `POST /v2/repos` called, and a 409 there is answered by the same grant read, never by a second create.
 * 3. The grant is the readback: the gateway must say this subject may write exactly that URL.
 * 4. The branch is read back. An empty repository receives the two-file bootstrap (create-only push) and is read
 *    again; anything else that is not exactly the bootstrap stays pending.
 * 5. Universe `complete` receives the verified URL, provider id, ref, starting SHA and manifest, which it verifies
 *    independently before it binds the attempt.
 *
 * The EZiL ID token goes only to Universe's fixed path and to the gateway. The Git grant goes only to the gateway.
 * Neither is returned, logged or put in an error message.
 */
export const ENROLLMENT_PATH = '/internal/assignment-repositories/enrollment';
export const STANDALONE_GIT_REPOS_URL = 'https://github.ezil.work/v2/repos';
/** The gateway's namespace for Builder-created repositories, as in the QA repository `default/os-code-url-20261110-a`. */
export { ASSIGNMENT_NAMESPACE, ownerRepositoryName, expectedRepositoryURL } from './assignment-repository-name';
export const QA_SUBJECTS_ENV = 'EZIL_ASSIGNMENT_ENROLLMENT_QA_SUBJECTS';
export const PILOT_JOBS_ENV = 'EZIL_ASSIGNMENT_ENROLLMENT_PILOT_JOB_IDS';
const decimalJobId = /^[1-9][0-9]{0,18}$/;
/** The only Universe this enrolls against: `UNIVERSE_PROJECT_REPO_ORIGIN` must be exactly staging's. */
export const ENROLLMENT_UNIVERSE_ORIGIN = 'https://universe-staging.ezil.work';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 16_384;
/** A challenge may not outlive this, plus clock difference. */
const CHALLENGE_MAX_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 30_000;

/** os-staging exactly (the evidence pilot's gate), staging Universe exactly, and a bounded QA subject or pilot-job configuration. */
export function assignmentEnrollmentEnabled(env: Record<string, string | undefined> = process.env): boolean {
    const authority = assignmentAuthority(env);
    if (!authority || env.UNIVERSE_PROJECT_REPO_ORIGIN !== authority.universe) return false;
    return authority === productionAssignment || qaSubjects(env).size > 0 || pilotJobIds(env).size > 0;
}

function pilotJobIds(env: Record<string,string|undefined>): Set<string> {
    const raw = env[PILOT_JOBS_ENV];
    if (!raw || raw.length > 2048) return new Set();
    const values = raw.split(',').map(value => value.trim());
    if (values.length > 64 || values.some(value => !decimalJobId.test(value))) return new Set();
    return new Set(values);
}

function qaSubjects(env: Record<string, string | undefined>): Set<string> {
    const raw = env[QA_SUBJECTS_ENV];
    if (!raw || raw.length > 4096) return new Set();
    return new Set(raw.split(',').map(s => s.trim()).filter(s => /^[^\s,\x00-\x1f\x7f]{1,255}$/u.test(s)));
}

/** Exact EZiL ID subjects only; no pattern, prefix or case folding. */
export function qaSubjectAllowed(subject: string, env: Record<string, string | undefined> = process.env): boolean {
    return qaSubjects(env).has(subject);
}

export type EnrollmentErrorCode =
    /** Universe or the gateway refused the EZiL ID token: refresh the retained identity. */
    | 'identity_refused'
    /** Not this attempt's participant, not a permitted Builder, or the attempt does not exist. */
    | 'not_authorized'
    /** Universe 409: the attempt is closed or already bound to another repository. */
    | 'attempt_closed'
    | 'rate_limited'
    /** The repository at the owner-bound URL is not writable by this subject. */
    | 'not_owner'
    /** Unreachable, or an answer that is not the contract. */
    | 'unavailable';

export class EnrollmentError extends Error {
    constructor(readonly code: EnrollmentErrorCode) { super(`assignment_enrollment_${code}`); }
}
const fail = (code: EnrollmentErrorCode): never => { throw new EnrollmentError(code); };

export type EnrollmentResult =
    | { status: 'bound'; attemptId: string; repositoryUrl: string; ref: string; baseSha: string }
    /** Created and owned, but not bootstrapped: Universe was not asked to bind it. */
    | { status: 'pending'; attemptId: string; repositoryUrl: string; reason: 'repository_not_empty' | 'repository_unreadable' };

export interface EnrollmentDeps {
    fetch?: typeof fetch;
    env?: Record<string, string | undefined>;
    now?: () => number;
    signal?: AbortSignal;
    readTree?: RepoFetcher;
}

const prepareResponse = z.object({
    jobId: z.string().regex(decimalJobId).optional(),
    attemptId: z.string().regex(UUID),
    name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
    challenge: z.string().regex(/^[A-Za-z0-9_-]{16,512}$/),
    expiresAt: z.string().datetime(),
}).strict();

const completeResponse = z.object({
    attemptId: z.string().regex(UUID),
    status: z.literal('bound'),
    repositoryUrl: z.string(),
    ref: z.string(),
    baseSha: z.string().regex(SHA),
}).strict();

async function boundedJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) return fail('unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > RESPONSE_MAX_BYTES) fail('unavailable');
            chunks.push(value);
        }
    } finally { void reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail('unavailable'); }
}

const UNIVERSE_REFUSALS: Readonly<Record<number, EnrollmentErrorCode>> = {
    401: 'identity_refused', 403: 'not_authorized', 404: 'not_authorized', 409: 'attempt_closed', 429: 'rate_limited',
};

/** Enroll `attemptId` for the holder of `identity`. Throws only `EnrollmentError`. */
export async function enrollAssignmentRepository(
    input: { identity: RetainedIdentity; attemptId: string }, deps: EnrollmentDeps = {},
): Promise<EnrollmentResult> {
    const { identity, attemptId } = input;
    const env = deps.env ?? process.env;
    const now = deps.now ?? Date.now;
    const fetcher = deps.fetch ?? fetch;
    if (!UUID.test(attemptId) || !assignmentEnrollmentEnabled(env)) fail('not_authorized');
    const production = assignmentAuthority(env) === productionAssignment;
    const namedQa = !production && qaSubjectAllowed(identity.subject, env);
    const permittedJobs = pilotJobIds(env);
    if (identity.issuer !== 'https://id.ezil.work/' || !identity.userId || !identity.subject || !identity.sessionId
        || !identity.token || identity.expiresAt <= now() || (!production && !namedQa && permittedJobs.size === 0)) fail('not_authorized');
    let origin: string;
    try { origin = projectRepoOrigin(env); } catch (error) { if (error instanceof ProjectRepoError) fail('unavailable'); throw error; }
    const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);

    const universe = async (body: Record<string, string>): Promise<unknown> => {
        let response: Response;
        try {
            const endpoint = new URL(ENROLLMENT_PATH, origin);
            const serialized = JSON.stringify({ ...body, userIdToken: identity.token, attemptId });
            const proof = production ? osActorHeaders(identity,endpoint.href,attemptId,serialized,now(),env) : {};
            response = await fetcher(endpoint, {
                method: 'POST', redirect: 'error', cache: 'no-store',
                signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
                headers: { 'content-type': 'application/json', ...proof }, body: serialized,
            });
        } catch { return fail('unavailable'); }
        const refused = UNIVERSE_REFUSALS[response.status];
        if (refused) { void response.body?.cancel().catch(() => {}); fail(refused); }
        if (response.status !== 200) { void response.body?.cancel().catch(() => {}); fail('unavailable'); }
        return boundedJson(response);
    };

    // 1. Universe: is this the attempt's participant, and what is the repository called?
    const prepareReply = await universe({ action: 'prepare' });
    // A reload can arrive after the participant has already edited or pushed. Only the authenticated stored binding
    // and a fresh write grant can resume the checkout; never reinitialize or compare their new tree to the initial tree.
    const existing = completeResponse.extend({providerId:z.string().regex(/^[a-z0-9]{1,64}$/),jobId:z.string().regex(decimalJobId)}).safeParse(prepareReply);
    if (existing.success) {
        const bound = existing.data;
        const canonical = expectedRepositoryURL(identity.subject, 'a-' + attemptId);
        if (bound.attemptId !== attemptId || bound.repositoryUrl !== canonical || bound.ref !== BOOTSTRAP_REF
            || (!production && !namedQa && !permittedJobs.has(bound.jobId))) return fail('not_authorized');
        try {
            const grant = await grantForStandaloneGit(identity, canonical, {fetch:fetcher,signal,now});
            if(grant.git.scope !== 'write' || grant.repository.id !== bound.providerId || grant.repository.ref !== bound.ref)
                return fail('not_owner');
        } catch (error) {
            if (error instanceof EnrollmentError) throw error;
            if (error instanceof GitAccessError && error.code === 'identity_refused') return fail('identity_refused');
            return fail('unavailable');
        }
        return {status:'bound',attemptId,repositoryUrl:canonical,ref:bound.ref,baseSha:bound.baseSha};
    }
    const prepared = prepareResponse.safeParse(prepareReply);
    // The repository name is bound to the attempt: `a-<attemptId>`, nothing else.
    if (!prepared.success || prepared.data.attemptId !== attemptId || prepared.data.name !== `a-${attemptId}`) return fail('unavailable');
    // Only authenticated Universe prepare can name the active attempt's job. The browser cannot supply a job ID.
    if (!namedQa && (!prepared.data.jobId || (!production && !permittedJobs.has(prepared.data.jobId)))) fail('not_authorized');
    const { name, challenge } = prepared.data;
    const challengeExpiry = Date.parse(prepared.data.expiresAt);
    if (!(challengeExpiry > now()) || challengeExpiry > now() + CHALLENGE_MAX_MS + CLOCK_SKEW_MS) fail('unavailable');
    const repositoryUrl = expectedRepositoryURL(identity.subject, name);

    // 2-3. Reconcile by an authenticated owner grant; create only when the gateway has no such repository.
    const grant = async (): Promise<PrivateGitPacket | null> => {
        try {
            const packet = await grantForStandaloneGit(identity, repositoryUrl, { fetch: fetcher, signal, now });
            return packet.git.scope === 'write' ? packet : fail('not_owner');
        } catch (error) {
            if (error instanceof EnrollmentError) throw error;
            if (error instanceof GitAccessError && error.code === 'not_found') return null;
            if (error instanceof GitAccessError && error.code === 'identity_refused') fail('identity_refused');
            return fail('unavailable');
        }
    };
    let packet = await grant();
    let createdProviderId: string | undefined;
    if (!packet) {
        createdProviderId = await createRepository(identity, name, repositoryUrl, fetcher, signal);
        packet = await grant();
        if (!packet) fail('unavailable');
    }
    if (packet!.repository.canonicalURL !== repositoryUrl || (createdProviderId && packet!.repository.id !== createdProviderId)
        || packet!.repository.ref !== BOOTSTRAP_REF) fail('unavailable');
    const owned = packet!;

    // 4. Read the branch back; bootstrap an empty repository once, then read it again.
    const readTree = deps.readTree ?? fetchRepositoryTree;
    const read = async () => {
        try { return await readTree({ canonicalURL: repositoryUrl, ref: owned.repository.ref, username: owned.git.username, token: owned.git.token, signal }, fetcher); }
        catch (error) {
            if (error instanceof GitFetchError && error.code === 'empty_repository') return 'empty' as const;
            if (error instanceof GitFetchError && error.code === 'ref_not_found') return 'not_empty' as const;
            return 'unreadable' as const;
        }
    };
    let tree = await read();
    if (tree === 'empty') {
        try {
            await pushAssignmentBootstrap({ canonicalURL: repositoryUrl, attemptId, username: owned.git.username, token: owned.git.token, signal, now }, fetcher);
        } catch (error) {
            // A concurrent bootstrap of the same attempt is settled by the readback below, not by this answer.
            if (!(error instanceof BootstrapError) || (error.code !== 'not_empty' && error.code !== 'rejected')) {
                return { status: 'pending', attemptId, repositoryUrl, reason: 'repository_unreadable' };
            }
        }
        tree = await read();
    }
    if (tree === 'unreadable' || tree === 'empty') return { status: 'pending', attemptId, repositoryUrl, reason: 'repository_unreadable' };
    const manifest = tree === 'not_empty' ? null : assignmentManifest(repositoryUrl, tree.entries);
    if (tree === 'not_empty' || !manifest || !SHA.test(tree.head)) return { status: 'pending', attemptId, repositoryUrl, reason: 'repository_not_empty' };

    // 5. Universe binds the attempt after verifying the same facts itself.
    if (Date.parse(prepared.data.expiresAt) <= now()) fail('attempt_closed');
    const completion = {
        action: 'complete', challenge, repositoryUrl, providerId: owned.repository.id, ref: owned.repository.ref,
        baseSha: tree.head, assignmentManifestSha256: manifest,
    };
    const completed = completeResponse.safeParse(await universe(completion));
    if (!completed.success || completed.data.attemptId !== attemptId || completed.data.repositoryUrl !== repositoryUrl
        || completed.data.ref !== completion.ref || completed.data.baseSha !== completion.baseSha) fail('unavailable');
    return { status: 'bound', attemptId, repositoryUrl, ref: completion.ref, baseSha: completion.baseSha };
}

/** `POST /v2/repos`; resolves with the provider id, or undefined after a 409 (the caller's grant read settles it). */
async function createRepository(identity: RetainedIdentity, name: string, expected: string, fetcher: typeof fetch, signal: AbortSignal): Promise<string | undefined> {
    let response: Response;
    try {
        response = await fetcher(STANDALONE_GIT_REPOS_URL, {
            method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
            headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name, visibility: 'private' }),
        });
    } catch { return fail('unavailable'); }
    if (response.status === 409) { void response.body?.cancel().catch(() => {}); return undefined; }
    if (response.status === 401) { void response.body?.cancel().catch(() => {}); fail('identity_refused'); }
    if (response.status === 403) { void response.body?.cancel().catch(() => {}); fail('not_authorized'); }
    if (response.status !== 201) { void response.body?.cancel().catch(() => {}); fail('unavailable'); }
    const created = z.object({ repoURL: z.literal(expected), ref: z.literal(BOOTSTRAP_REF), providerId: z.string().regex(/^[a-z0-9]{16}$/) })
        .safeParse(await boundedJson(response));
    return created.success ? created.data.providerId : fail('unavailable');
}
