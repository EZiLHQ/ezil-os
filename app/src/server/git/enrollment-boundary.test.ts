import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { RetainedIdentity } from '@/server/auth/retained-identity';

import { GitAccessError, grantForStandaloneGit, STANDALONE_GIT_GRANT_URL } from './access';
import { assignmentManifest, assignmentMarker, bootstrapFiles, BOOTSTRAP_REF } from './assignment-bootstrap';
import { assignmentEnrollmentEnabled, enrollAssignmentRepository, expectedRepositoryURL, qaSubjectAllowed } from './assignment-enrollment';
import { privatePacketFor } from './private-packet';
import { parseRepositoryUrl } from './repo-url';

/**
 * Self-serve assignment enrollment boundary (RUN-1122).
 *
 * Every OS path that can create, grant or bind a standalone assignment repository is fixed to `github.ezil.work`, the
 * only canonical registry; any staging host is refused before a token leaves the server. Self-serve creation exists
 * only in the os-staging, QA-allowlisted `./assignment-enrollment.ts`, which binds through Universe's enrollment
 * handshake. If one of these assertions has to change, the dependency it pins has moved.
 */
const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const identity: RetainedIdentity = { token: 'private-id-token', issuer: 'https://id.ezil.work/', subject: 'auth0|builder-1122',
    expiresAt: NOW + 600_000, userId: 'user', sessionId: 'session' };
const CANONICAL = 'https://github.ezil.work/default/assignment-1122.git';
const STAGING_HOSTS = ['git-staging.ezil.work', 'git-qa.ezil.work', 'git.ezil.work'];
const packet = (canonicalURL: string) => ({ version: 2,
    repository: { id: 'fg1wtcrexaf7acl0', canonicalURL, ref: 'refs/heads/main' },
    identity: { issuer: identity.issuer, subject: identity.subject },
    git: { username: 'ezil', token: 'opaque-gateway-credential', expiresAt: '2026-11-22T12:04:00.000Z', scope: 'write' } });
const ATTEMPT = '3f0c2a1e-5b6d-4e7f-8a90-b1c2d3e4f5a6';
const STAGE = { BILLING_FUNDING_URL: 'https://ai-staging.ezil.work', UNIVERSE_PROJECT_REPO_ORIGIN: 'https://universe-staging.ezil.work',
    EZIL_ASSIGNMENT_ENROLLMENT_QA_SUBJECTS: identity.subject };
const OWNED = expectedRepositoryURL(identity.subject, `a-${ATTEMPT}`);
const file = (path: string, content: string, mode = '100644') => ({ path, kind: 'file' as const, mode, content: Buffer.from(content, 'utf8') });
const bootstrapTree = () => [{ path: '.ezil', kind: 'dir' as const, mode: '40000' },
    ...[...bootstrapFiles(OWNED)].map(([path, content]) => file(path, content))];

describe('self-serve assignment enrollment boundary', () => {
    it('grants only against the production gateway', () => {
        expect(STANDALONE_GIT_GRANT_URL).toBe('https://github.ezil.work/v2/git/grant');
    });

    it.each(STAGING_HOSTS)('refuses %s before the EZiL ID token leaves the server', async host => {
        const fetcher = vi.fn();
        await expect(grantForStandaloneGit(identity, `https://${host}/default/assignment-1122.git`, { fetch: fetcher as unknown as typeof fetch, now: () => NOW }))
            .rejects.toMatchObject({ code: 'invalid_response' } satisfies Pick<GitAccessError, 'code'>);
        expect(fetcher).not.toHaveBeenCalled();
        expect(parseRepositoryUrl(`https://${host}/default/assignment-1122.git`)).toEqual({ ok: false, reason: 'unsupported_host' });
    });

    it('accepts a gateway packet only for the canonical host it asked about', () => {
        expect(privatePacketFor(packet(CANONICAL), CANONICAL, identity, NOW)).not.toBeNull();
        for (const host of STAGING_HOSTS) {
            const staging = `https://${host}/default/assignment-1122.git`;
            expect(privatePacketFor(packet(staging), staging, identity, NOW)).toBeNull();
            // The split-registry case: a staging gateway answers with a canonical-looking production link.
            expect(privatePacketFor(packet(CANONICAL), staging, identity, NOW)).toBeNull();
        }
    });

    it('enrolls only on os-staging against staging Universe for an exactly allowlisted QA subject', async () => {
        expect(assignmentEnrollmentEnabled(STAGE)).toBe(true);
        for (const env of [
            { ...STAGE, BILLING_FUNDING_URL: 'https://ai.ezil.work' },
            { ...STAGE, BILLING_FUNDING_URL: undefined },
            { ...STAGE, UNIVERSE_PROJECT_REPO_ORIGIN: 'https://universe.ezil.work' },
            { ...STAGE, UNIVERSE_PROJECT_REPO_ORIGIN: 'https://universe-staging.ezil.work/' },
            { ...STAGE, EZIL_ASSIGNMENT_ENROLLMENT_QA_SUBJECTS: '' },
        ]) expect(assignmentEnrollmentEnabled(env)).toBe(false);
        expect(qaSubjectAllowed(identity.subject, STAGE)).toBe(true);
        for (const subject of ['auth0|builder', 'AUTH0|BUILDER-1122', `${identity.subject} `, 'auth0|builder-11220'])
            expect(qaSubjectAllowed(subject, STAGE)).toBe(false);
        // Refused before any request: production, a non-allowlisted subject, an expired token, a malformed attempt.
        const fetcher = vi.fn();
        const deps = { fetch: fetcher as unknown as typeof fetch, now: () => NOW };
        for (const [who, attemptId, env] of [
            [identity, ATTEMPT, { ...STAGE, BILLING_FUNDING_URL: 'https://ai.ezil.work' }],
            [{ ...identity, subject: 'auth0|builder-other' }, ATTEMPT, STAGE],
            [{ ...identity, expiresAt: NOW }, ATTEMPT, STAGE],
            [identity, ATTEMPT.toUpperCase(), STAGE],
        ] as const) {
            await expect(enrollAssignmentRepository({ identity: who, attemptId }, { ...deps, env })).rejects.toMatchObject({ code: 'not_authorized' });
        }
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('binds only the owner-bound repository holding exactly the C1 marker and README on main', () => {
        expect(BOOTSTRAP_REF).toBe('refs/heads/main');
        expect(OWNED).toMatch(/^https:\/\/github\.ezil\.work\/default\/u-[0-9a-f]{16}-a-3f0c2a1e-5b6d-4e7f-8a90-b1c2d3e4f5a6\.git$/);
        expect(parseRepositoryUrl(OWNED)).toMatchObject({ ok: true, host: 'github.ezil.work', canonicalURL: OWNED });
        const marker = assignmentMarker(OWNED);
        expect(marker).toBe(`{"schema":"ezil.assignment/v1","recorder":"assignment-recorder-v1","repositoryUrl":"${OWNED}","consentVersion":3,`
            + '"notice":"Do not edit, modify, or delete this assignment marker. EZiL Code records disclosed assignment activity and shows recording status. Interruptions may affect submission."}\n');
        expect(assignmentManifest(OWNED, bootstrapTree())).toBe(createHash('sha256').update(marker, 'utf8').digest('hex'));
        // Anything else is not this assignment's start: another URL in the marker, an extra, edited, executable or missing file.
        expect(assignmentManifest(CANONICAL, bootstrapTree())).toBeNull();
        expect(assignmentManifest(OWNED, [...bootstrapTree(), file('main.py', 'print(1)\n')])).toBeNull();
        expect(assignmentManifest(OWNED, bootstrapTree().map(e => e.path === 'README.md' ? file(e.path, '# edited\n') : e))).toBeNull();
        expect(assignmentManifest(OWNED, bootstrapTree().map(e => e.path === '.ezil/assignment.json' ? file(e.path, marker, '100755') : e))).toBeNull();
        expect(assignmentManifest(OWNED, bootstrapTree().filter(e => e.path !== 'README.md'))).toBeNull();
        expect(assignmentManifest(OWNED, [])).toBeNull();
    });

    it('creates repositories only from the gated assignment enrollment controller', () => {
        const root = join(__dirname, '..', '..');
        const callers = (readdirSync(root, { recursive: true }) as string[])
            .filter(file => /\.(?:ts|tsx|js|mjs)$/.test(file) && !/\.test\.|test-support/.test(file))
            .filter(file => readFileSync(join(root, file), 'utf8').includes('/v2/repos'));
        expect(callers).toEqual([join('server', 'git', 'assignment-enrollment.ts')]);
    });
});
