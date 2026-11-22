import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { readEvidencePilot } from '@/server/assignment-evidence/contract';
import type { RetainedIdentity } from '@/server/auth/retained-identity';

import { GitAccessError, grantForStandaloneGit, STANDALONE_GIT_GRANT_URL } from './access';
import { privatePacketFor } from './private-packet';
import { parseRepositoryUrl } from './repo-url';

/**
 * Self-serve assignment enrollment boundary (RUN-1122).
 *
 * Every OS path that can create, grant or bind a standalone assignment repository is fixed to `github.ezil.work`, the
 * only canonical registry; any staging host is refused before a token leaves the server. The evidence pilot binds only
 * an operator-preprovisioned, committed repository. Self-serve creation exists only in the os-staging, QA-allowlisted
 * `./assignment-enrollment.ts`, which binds through Universe's enrollment handshake. If one of these assertions has to
 * change, the dependency it pins has moved.
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
const pilot = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    id: '0b6f7d1e-2c3a-4d5e-8f90-a1b2c3d4e5f6', ownerId: '1c7a8e2f-3d4b-4e6f-9a01-b2c3d4e5f6a7',
    computerId: '2d8b9f30-4e5c-4f70-8b12-c3d4e5f6a7b8', repositoryId: 'fg1wtcrexaf7acl0', repositoryUrl: CANONICAL,
    ref: 'refs/heads/main', baseSha: 'a'.repeat(40), ...overrides });
const stagingEnv = (config: string) => ({ BILLING_FUNDING_URL: 'https://ai-staging.ezil.work', EZIL_ASSIGNMENT_EVIDENCE_PILOT: config });

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

    it('binds an attempt only from an operator-preprovisioned, committed production repository on staging', () => {
        expect(readEvidencePilot(stagingEnv(pilot()))).toMatchObject({ repositoryUrl: CANONICAL, baseSha: 'a'.repeat(40) });
        expect(readEvidencePilot({ ...stagingEnv(pilot()), BILLING_FUNDING_URL: 'https://ai.ezil.work' })).toBeNull();
        for (const host of STAGING_HOSTS) {
            expect(readEvidencePilot(stagingEnv(pilot({ repositoryUrl: `https://${host}/default/assignment-1122.git` })))).toBeNull();
        }
        // A freshly created repository has no commit, so it cannot be bound until something initializes it.
        expect(readEvidencePilot(stagingEnv(pilot({ baseSha: '0'.repeat(40) })))).toBeNull();
        expect(readEvidencePilot(stagingEnv(pilot({ baseSha: undefined })))).toBeNull();
        // No client-supplied role or identity rides along in the binding.
        expect(readEvidencePilot(stagingEnv(pilot({ participantSub: identity.subject })))).toBeNull();
    });

    it('creates repositories only from the gated assignment enrollment controller', () => {
        const root = join(__dirname, '..', '..');
        const callers = (readdirSync(root, { recursive: true }) as string[])
            .filter(file => /\.(?:ts|tsx|js|mjs)$/.test(file) && !/\.test\.|test-support/.test(file))
            .filter(file => readFileSync(join(root, file), 'utf8').includes('/v2/repos'));
        expect(callers).toEqual([join('server', 'git', 'assignment-enrollment.ts')]);
    });
});
