import { describe, expect, it } from 'vitest';
import {
    validateRepositoryInspection, validateRepositorySubmission,
} from './repository-submission';

const submissionId = '11111111-1111-4111-8111-111111111111';
const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const file = (path: string, line = 1) => ({ kind: 'file', path, line });

function submission(overrides: Record<string, unknown> = {}) {
    return {
        schemaVersion: 1,
        repositoryUrl: 'https://github.com/reticlehq/reticle',
        clientRequestId: submissionId,
        ...overrides,
    };
}

function inspection(overrides: Record<string, unknown> = {}) {
    return {
        schemaVersion: 1,
        submissionId,
        repositoryUrl: 'https://github.com/example/notes',
        commitSha: sha,
        archiveDigest: digest,
        workspaces: [{
            path: '.', name: 'notes', packageManager: 'npm', workspaceDependencies: [],
            evidence: [file('package.json', 1)],
        }],
        launchTargets: [{
            name: 'web', workspacePath: '.', kind: 'web', entrypointPath: 'dist/server.mjs',
            internalPort: 8080, dependsOn: [], evidence: [file('package.json', 8)],
        }],
        stateRequirements: [{ kind: 'filesystem', evidence: [file('src/state.ts', 12)] }],
        license: { identifier: 'MIT', evidence: [file('LICENSE', 1)] },
        compatibility: { status: 'pilot-candidate', reasons: [] },
        ...overrides,
    };
}

function submissionIssues(input: unknown) {
    const result = validateRepositorySubmission(input);
    expect(result.success).toBe(false);
    return result.success ? [] : result.issues;
}
function inspectionIssues(input: unknown) {
    const result = validateRepositoryInspection(input);
    expect(result.success).toBe(false);
    return result.success ? [] : result.issues;
}

describe('repository submission', () => {
    it('accepts public HTTPS repository URLs for inspection, including a non-GitHub host', () => {
        const github = validateRepositorySubmission(submission({
            repositoryUrl: 'https://github.com/reticlehq/reticle/',
            requestedCommitSha: sha.toUpperCase(),
        }));
        expect(github).toMatchObject({
            success: true, data: {
                repositoryUrl: 'https://github.com/reticlehq/reticle',
                requestedCommitSha: sha,
            },
        });
        expect(validateRepositorySubmission(submission({
            repositoryUrl: 'https://gitlab.com/group/subgroup/repo.git',
        })).success).toBe(true);
    });

    it.each([
        'http://github.com/reticlehq/reticle',
        'https://user:pass@github.com/reticlehq/reticle',
        'https://127.0.0.1/owner/repo',
        'https://169.254.169.254/owner/repo',
        'https://localhost/owner/repo',
        'https://github.com:8443/owner/repo',
        'https://github.com/owner/repo?token=secret',
        'https://github.com/owner/repo%2fhidden',
        'https://github.com/owner/x/../repo',
        'https://github.com/owner//repo',
        'https://github.com/owner',
    ])('rejects ambiguous or non-public repository syntax: %s', (url) => {
        expect(submissionIssues(submission({ repositoryUrl: url }))).toContainEqual({
            path: ['repositoryUrl'], code: 'custom',
        });
    });

    it('requires strict versioned input and returns field paths without secret values', () => {
        expect(submissionIssues(submission({ schemaVersion: 2 }))).not.toHaveLength(0);
        expect(submissionIssues(submission({ requestedCommitSha: 'main' }))).not.toHaveLength(0);
        expect(submissionIssues(submission({ awsCredentials: 'private-value' }))).not.toHaveLength(0);
        const result = validateRepositorySubmission(submission({
            repositoryUrl: 'https://github.com/owner/repo?token=private-value',
        }));
        expect(JSON.stringify(result)).not.toContain('private-value');
    });
});

describe('evidence-backed repository inspection', () => {
    it('accepts a pinned web target with source evidence and a root workspace', () => {
        expect(validateRepositoryInspection(inspection()).success).toBe(true);
    });

    it('accepts a Reticle daemon only with its explicit integration adapter', () => {
        const reticle = inspection({
            repositoryUrl: 'https://github.com/reticlehq/reticle',
            workspaces: [{
                path: '.', name: 'reticle', packageManager: 'pnpm',
                workspaceDependencies: ['@reticle/server'],
                evidence: [file('pnpm-workspace.yaml', 1)],
            }, {
                path: 'server', name: '@reticle/server', packageManager: 'pnpm',
                workspaceDependencies: [], evidence: [file('server/package.json', 1)],
            }],
            launchTargets: [{
                name: 'daemon', workspacePath: 'server', kind: 'service',
                integrationAdapter: 'reticle-v1', internalPort: 4400,
                dependsOn: [], evidence: [file('server/package.json', 8)],
            }],
            license: { identifier: 'FSL-1.1-ALv2', evidence: [file('LICENSE', 1)] },
            compatibility: { status: 'needs-configuration', reasons: ['license-review-required'] },
        });
        expect(validateRepositoryInspection(reticle).success).toBe(true);
        expect(inspectionIssues({
            ...reticle, repositoryUrl: 'https://github.com/example/other',
        })).toContainEqual({ path: ['launchTargets', 0, 'integrationAdapter'], code: 'custom' });
    });

    it('records unsupported hosts explicitly without rejecting their safe URL syntax', () => {
        const result = validateRepositoryInspection(inspection({
            repositoryUrl: 'https://gitlab.com/group/repo',
            compatibility: { status: 'unsupported', reasons: ['unsupported-host'] },
        }));
        expect(result.success).toBe(true);
    });

    it('rejects fabricated readiness, missing evidence, unknown workspaces and unpinned results', () => {
        expect(inspectionIssues(inspection({ commitSha: 'main' }))).not.toHaveLength(0);
        expect(inspectionIssues(inspection({
            launchTargets: [{ ...inspection().launchTargets[0], evidence: [] }],
        }))).not.toHaveLength(0);
        expect(inspectionIssues(inspection({
            launchTargets: [{ ...inspection().launchTargets[0], workspacePath: 'missing' }],
        }))).toContainEqual({ path: ['launchTargets', 0, 'workspacePath'], code: 'custom' });
        expect(inspectionIssues(inspection({
            launchTargets: [{ ...inspection().launchTargets[0], kind: 'service' }],
        }))).toContainEqual({ path: ['compatibility'], code: 'custom' });
        expect(inspectionIssues(inspection({
            compatibility: { status: 'pilot-candidate', reasons: ['unsupported-storage'] },
        }))).toContainEqual({ path: ['compatibility'], code: 'custom' });
        expect(inspectionIssues(inspection({ hiddenProviderKey: 'private-value' }))).not.toHaveLength(0);
    });
});
