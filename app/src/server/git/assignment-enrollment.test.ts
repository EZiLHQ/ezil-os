import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { assignmentMarker, bootstrapObjects, packObjects } from './assignment-bootstrap';
import { enrollAssignmentRepository, expectedRepositoryURL, type EnrollmentError } from './assignment-enrollment';
import { ATTEMPT, ENV, fakeWorld, GIT_TOKEN, ID_TOKEN, identity, NAME, ORIGIN, PROVIDER, REPO, SUBJECT } from './assignment-enrollment.test-support';

const worlds: Array<ReturnType<typeof fakeWorld>> = [];
const world = () => { const w = fakeWorld(); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });
const enroll = (w: ReturnType<typeof fakeWorld>, env: Record<string, string | undefined> = ENV, who = identity()) =>
    enrollAssignmentRepository({ identity: who, attemptId: ATTEMPT }, { fetch: w.fetch, env });
const refused = async (promise: Promise<unknown>, code: EnrollmentError['code']) => expect(promise).rejects.toMatchObject({ code });
const routes = (w: ReturnType<typeof fakeWorld>) => w.calls.map(c => `${c.method} ${c.url.replace(REPO, '<repo>')}${c.json?.action ? ` ${c.json.action}` : ''}${c.json?.scope ? ` ${c.json.scope}` : ''}`);
const MARKER = `{"schema":"ezil.assignment/v1","recorder":"assignment-recorder-v1","repositoryUrl":"${REPO}","consentVersion":3,`
    + '"notice":"Do not edit, modify, or delete this assignment marker. EZiL Code records disclosed assignment activity and shows recording status. Interruptions may affect submission."}\n';

describe('assignment repository enrollment', () => {
    it('creates, bootstraps and binds one new owner-bound private repository through the real git protocol', async () => {
        const w = world();
        const result = await enroll(w);
        const head = w.head();
        expect(result).toEqual({ status: 'bound', attemptId: ATTEMPT, repositoryUrl: REPO, ref: 'refs/heads/main', baseSha: head });
        expect(routes(w)).toEqual([
            `POST ${ORIGIN}/internal/assignment-repositories/enrollment prepare`,
            'POST https://github.ezil.work/v2/git/grant write',
            'POST https://github.ezil.work/v2/repos',
            'POST https://github.ezil.work/v2/git/grant write',
            'GET <repo>/info/refs?service=git-upload-pack',
            'GET <repo>/info/refs?service=git-receive-pack',
            'POST <repo>/git-receive-pack',
            'GET <repo>/info/refs?service=git-upload-pack',
            'POST <repo>/git-upload-pack',
            `POST ${ORIGIN}/internal/assignment-repositories/enrollment complete`,
        ]);
        expect(w.calls[2]!.json).toEqual({ name: NAME, visibility: 'private' });
        // The repository holds exactly the C1 marker and README, and the manifest is the marker file's own bytes.
        expect(w.git(['ls-tree', '-r', '--name-only', 'refs/heads/main']).toString()).toBe('.ezil/assignment.json\nREADME.md\n');
        expect(w.git(['show', 'refs/heads/main:.ezil/assignment.json']).toString()).toBe(MARKER);
        expect(assignmentMarker(REPO)).toBe(MARKER);
        const complete = w.calls.at(-1)!.json!;
        expect(Object.keys(complete).sort()).toEqual(['action', 'assignmentManifestSha256', 'attemptId', 'baseSha', 'challenge', 'providerId', 'ref', 'repositoryUrl', 'userIdToken']);
        expect(complete).toMatchObject({ providerId: PROVIDER, baseSha: head, assignmentManifestSha256: createHash('sha256').update(MARKER).digest('hex') });
        // The Git grant never reaches Universe; the EZiL ID token reaches only Universe's body and the gateway's v2 API.
        for (const call of w.calls) {
            expect(JSON.stringify(call.json ?? {})).not.toContain(GIT_TOKEN);
            if (call.url.startsWith(REPO)) expect(call.headers.get('authorization')).not.toContain(ID_TOKEN);
            expect(call.url).not.toContain(ID_TOKEN);
        }
        expect(w.git(['fsck', '--strict']).toString()).toBe('');
    });

    it('reconciles a retry by the owner grant: no second create and no second push', async () => {
        const w = world();
        await enroll(w);
        const head = w.head();
        w.calls.length = 0;
        expect(await enroll(w)).toMatchObject({ status: 'bound', baseSha: head });
        expect(w.state).toMatchObject({ creates: 1, pushes: 1, completions: 2 });
        expect(routes(w)).not.toContain('POST https://github.ezil.work/v2/repos');
    });

    it('settles a create race (409) by the grant read, never a second create', async () => {
        const w = world();
        w.state.createStatus = 409;
        expect(await enroll(w)).toMatchObject({ status: 'bound' });
        expect(w.state.creates).toBe(1);
    });

    it('leaves a repository with unrelated content pending and never asks Universe to bind it', async () => {
        const w = world();
        w.state.exists = true;
        const foreign = w.seedForeign();
        expect(await enroll(w)).toEqual({ status: 'pending', attemptId: ATTEMPT, repositoryUrl: REPO, reason: 'repository_not_empty' });
        expect(w.head()).toBe(foreign);
        expect(w.state).toMatchObject({ creates: 0, pushes: 0, completions: 0 });
    });

    it('refuses a repository this subject can only read', async () => {
        const w = world();
        Object.assign(w.state, { exists: true, scope: 'read' });
        await refused(enroll(w), 'not_owner');
        expect(w.state).toMatchObject({ creates: 0, pushes: 0, completions: 0 });
    });

    it('refuses before any request off os-staging, for a subject not on the QA allowlist, or without Universe', async () => {
        for (const [env, who] of [
            [{ ...ENV, BILLING_FUNDING_URL: 'https://ai.ezil.work' }, identity()],
            [{ ...ENV, EZIL_ASSIGNMENT_ENROLLMENT_QA_SUBJECTS: 'auth0|someone-else' }, identity()],
            [{ ...ENV, UNIVERSE_PROJECT_REPO_ORIGIN: 'https://universe.example/path' }, identity()],
            [{ ...ENV, UNIVERSE_PROJECT_REPO_ORIGIN: 'https://universe.ezil.work' }, identity()],
            [ENV, identity({ subject: 'auth0|qa-assignment-builder-2' })],
            [ENV, identity({ expiresAt: Date.now() - 1 })],
        ] as const) {
            const w = world();
            await refused(enroll(w, env, who), 'not_authorized');
            expect(w.calls).toEqual([]);
        }
    });

    it('maps Universe refusals and stops before the gateway', async () => {
        for (const [status, code] of [[401, 'identity_refused'], [403, 'not_authorized'], [409, 'attempt_closed'], [429, 'rate_limited'], [500, 'unavailable']] as const) {
            const w = world();
            w.state.prepareStatus = status;
            await refused(enroll(w), code);
            expect(w.calls).toHaveLength(1);
        }
    });

    it('accepts only the a-<attemptId> repository name from Universe', async () => {
        for (const name of ['a-00000000-0000-4000-8000-000000000000', 'assignment', `b-${ATTEMPT}`]) {
            const w = world();
            w.state.prepareName = name;
            await refused(enroll(w), 'unavailable');
            expect(w.calls).toHaveLength(1);
        }
    });

    it('trusts no gateway create answer that is not the expected owner-bound URL', async () => {
        const w = world();
        w.state.createURL = 'https://github.ezil.work/default/u-0000000000000000-assignment-3f0c2a1e.git';
        await refused(enroll(w), 'unavailable');
        expect(w.state).toMatchObject({ pushes: 0, completions: 0 });
    });

    it('does not report bound when Universe answers anything but the submitted binding', async () => {
        const w = world();
        w.state.completeTamper = answer => ({ ...answer, baseSha: 'f'.repeat(40) });
        await refused(enroll(w), 'unavailable');
    });

    it('derives the owner-bound name from the UTF-8 subject', () => {
        expect(expectedRepositoryURL(SUBJECT, NAME)).toBe(REPO);
        expect(expectedRepositoryURL('auth0|é', 'a')).toBe(`https://github.ezil.work/default/u-${createHash('sha256').update(Buffer.from('auth0|é', 'utf8')).digest('hex').slice(0, 16)}-a.git`);
    });

    it('packs the bootstrap commit deterministically', () => {
        const a = bootstrapObjects(REPO, ATTEMPT, 1_795_000_000);
        expect(bootstrapObjects(REPO, ATTEMPT, 1_795_000_000).commit).toBe(a.commit);
        expect(packObjects(a.objects).subarray(0, 4).toString('latin1')).toBe('PACK');
    });
});
