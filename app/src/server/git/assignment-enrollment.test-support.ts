import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fake world for assignment enrollment: Universe's enrollment endpoint (which, like the PHP receiver, verifies the
 * completion against the repository itself), the standalone gateway's v2 create and grant, and smart HTTP served by
 * real `git upload-pack` / `git receive-pack` over a bare repository. No network.
 */
export const SUBJECT = 'auth0|qa-assignment-builder';
export const ATTEMPT = '3f0c2a1e-5b6d-4e7f-8a90-b1c2d3e4f5a6';
export const ORIGIN = 'https://universe-staging.ezil.work';
export const NAME = `a-${ATTEMPT}`;
export const PROVIDER = 'fg1wtcrexaf7acl0';
export const ID_TOKEN = 'private-id-token';
export const GIT_TOKEN = 'opaque-gateway-credential';
export const REPO = `https://github.ezil.work/default/u-${createHash('sha256').update(SUBJECT, 'utf8').digest('hex').slice(0, 16)}-${NAME}.git`;
export const ENV = {
    BILLING_FUNDING_URL: 'https://ai-staging.ezil.work', UNIVERSE_PROJECT_REPO_ORIGIN: ORIGIN,
    EZIL_ASSIGNMENT_ENROLLMENT_QA_SUBJECTS: `auth0|someone-else, ${SUBJECT}`,
};
export const identity = (overrides: Record<string, unknown> = {}) => ({ token: ID_TOKEN, issuer: 'https://id.ezil.work/', subject: SUBJECT,
    expiresAt: Date.now() + 3_600_000, userId: '11111111-1111-4111-8111-111111111111', sessionId: 'session-a', ...overrides });

export interface Call { url: string; method: string; headers: Headers; json?: Record<string, unknown> }

const git = (args: string[], input?: Buffer | string) => {
    const result = spawnSync('git', args, { input, env: { ...process.env, GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com',
        GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com' }, maxBuffer: 64 << 20 });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
    return result.stdout;
};
const pkt = (line: string) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`;

export function fakeWorld(origin = ORIGIN) {
    const dir = mkdtempSync(join(tmpdir(), 'ezil-enroll-'));
    const bare = join(dir, 'repo.git');
    git(['init', '--quiet', '--bare', '--initial-branch=main', bare]);
    const state = {
        exists: false, scope: 'write' as 'write' | 'read', createStatus: 201, createURL: REPO, prepareStatus: 200, prepareName: NAME, prepareJobId: undefined as string | undefined,
        boundReply: null as Record<string, unknown> | null,
        completeTamper: null as null | ((body: Record<string, unknown>) => Record<string, unknown>), creates: 0, pushes: 0, completions: 0,
    };
    const calls: Call[] = [];
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    const head = () => { try { return git(['--git-dir', bare, 'rev-parse', 'refs/heads/main']).toString().trim(); } catch { return null; } };
    const basic = `Basic ${Buffer.from(`ezil:${GIT_TOKEN}`).toString('base64')}`;
    const fetcher = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
        const url = String(input);
        const headers = new Headers(init.headers);
        const method = init.method ?? 'GET';
        const text = typeof init.body === 'string' ? init.body : undefined;
        const call: Call = { url, method, headers, ...(text ? { json: JSON.parse(text) } : {}) };
        calls.push(call);
        if (init.redirect !== 'error') throw new Error(`redirects must be refused: ${url}`);
        if (url === `${origin}/internal/assignment-repositories/enrollment`) {
            const body = call.json!;
            if (body.userIdToken !== ID_TOKEN || body.attemptId !== ATTEMPT) return json({ error: 'not_authorized' }, 403);
            if (body.action === 'prepare') {
                if (state.prepareStatus !== 200) return json({ error: 'refused' }, state.prepareStatus);
                if (state.boundReply) return json(state.boundReply);
                return json({ attemptId: ATTEMPT, name: state.prepareName, ...(state.prepareJobId ? { jobId:state.prepareJobId } : {}), challenge: 'challenge_0123456789abcdef', expiresAt: new Date(Date.now() + 600_000).toISOString() });
            }
            // The receiver's independent verification: the anchored HEAD and the marker bytes, read from the repository.
            const sha = head();
            const marker = sha ? git(['--git-dir', bare, 'show', 'refs/heads/main:.ezil/assignment.json']) : null;
            if (body.challenge !== 'challenge_0123456789abcdef' || body.repositoryUrl !== REPO || body.providerId !== PROVIDER
                || body.ref !== 'refs/heads/main' || body.baseSha !== sha || !marker
                || body.assignmentManifestSha256 !== createHash('sha256').update(marker).digest('hex')) return json({ error: 'verification_failed' }, 409);
            state.completions += 1;
            const answer = { attemptId: ATTEMPT, status: 'bound', repositoryUrl: REPO, ref: body.ref, baseSha: sha };
            return json(state.completeTamper ? state.completeTamper(answer) : answer);
        }
        if (url === 'https://github.ezil.work/v2/repos') {
            if (headers.get('authorization') !== `Bearer ${ID_TOKEN}`) return json({ error: 'unauthorized' }, 401);
            state.creates += 1;
            if (state.createStatus === 201) { state.exists = true; return json({ repoURL: state.createURL, ref: 'refs/heads/main', providerId: PROVIDER }, 201); }
            if (state.createStatus === 409) state.exists = true;
            return json({ error: 'refused' }, state.createStatus);
        }
        if (url === 'https://github.ezil.work/v2/git/grant') {
            if (headers.get('authorization') !== `Bearer ${ID_TOKEN}`) return json({ error: 'unauthorized' }, 401);
            const { repoURL, scope } = call.json as { repoURL: string; scope: 'read' | 'write' };
            if (!state.exists || repoURL !== REPO) return json({ error: 'not_found' }, 404);
            if (scope === 'write' && state.scope === 'read') return json({ error: 'forbidden' }, 403);
            return json({ version: 2, repository: { id: PROVIDER, canonicalURL: REPO, ref: 'refs/heads/main' },
                identity: { issuer: 'https://id.ezil.work/', subject: SUBJECT },
                git: { username: 'ezil', token: GIT_TOKEN, expiresAt: new Date(Date.now() + 240_000).toISOString(), scope } });
        }
        for (const service of ['upload-pack', 'receive-pack'] as const) {
            if (headers.get('authorization') !== basic && url.startsWith(REPO)) return new Response(null, { status: 401 });
            if (url === `${REPO}/info/refs?service=git-${service}`) {
                const ad = Buffer.concat([Buffer.from(`${pkt(`# service=git-${service}\n`)}0000`), git([service, '--stateless-rpc', '--advertise-refs', bare])]);
                return new Response(new Uint8Array(ad), { headers: { 'content-type': `application/x-git-${service}-advertisement` } });
            }
            if (url === `${REPO}/git-${service}` && method === 'POST') {
                if (service === 'receive-pack') state.pushes += 1;
                const out = git([service, '--stateless-rpc', bare], Buffer.from(init.body as Uint8Array));
                return new Response(new Uint8Array(out), { headers: { 'content-type': `application/x-git-${service}-result` } });
            }
        }
        throw new Error(`unexpected request ${method} ${url}`);
    };
    /** An unrelated commit, as if the repository had been used for something else. */
    const seedForeign = () => {
        const blob = git(['--git-dir', bare, 'hash-object', '-w', '--stdin'], 'print("hello")\n').toString().trim();
        const tree = git(['--git-dir', bare, 'mktree'], `100644 blob ${blob}\tmain.py\n`).toString().trim();
        const commit = git(['--git-dir', bare, 'commit-tree', tree, '-m', 'unrelated']).toString().trim();
        git(['--git-dir', bare, 'update-ref', 'refs/heads/main', commit]);
        return commit;
    };
    return { state, calls, head, seedForeign, bare, git: (args: string[]) => git(['--git-dir', bare, ...args]),
        fetch: fetcher as unknown as typeof fetch, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
