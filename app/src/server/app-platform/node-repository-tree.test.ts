import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectNodeRepositoryTree } from './node-repository-tree';
import { validateRepositoryInspection } from './repository-submission';

const RETICLE_URL = 'https://github.com/reticlehq/reticle';
const roots: string[] = [];

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'ezil-repository-tree-'));
    roots.push(root);
    const put = async (path: string, contents: string) => {
        const absolute = join(root, path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, contents);
    };
    await put('package.json', JSON.stringify({
        name: 'reticle-monorepo', packageManager: 'pnpm@10.33.2', private: true,
    }));
    await put('pnpm-workspace.yaml', `packages:\n  - 'core'\n  - 'server'\n  - 'apps/*'\n`);
    await put('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
    await put('core/package.json', JSON.stringify({ name: '@reticlehq/core' }));
    await put('server/package.json', JSON.stringify({
        name: '@reticlehq/server', license: 'FSL-1.1-ALv2',
        dependencies: { '@reticlehq/core': 'workspace:*' },
    }));
    await put('server/bin/reticle.js', 'export { main } from "../dist/index.js";\n');
    await put('server/src/command/cli/cli-parse.ts', 'const usage = "reticle serve [--port N]";\n');
    await put('README.md', 'State is kept in ~/.reticle on the computer.\n');
    await put('apps/bench-app/package.json', JSON.stringify({
        name: '@reticlehq/bench-app', private: true,
        dependencies: { '@reticlehq/core': 'workspace:*' },
        scripts: { dev: 'vite' },
    }));
    // The apps/* glob also sees this grouping directory. It is not itself a package.
    await mkdir(join(root, 'apps/examples'), { recursive: true });
    return { root, put };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bounded Node repository tree inspection', () => {
    it('finds Reticle’s workspace closure and daemon without treating its benchmark fixture as the product UI', async () => {
        const { root } = await fixture();
        const result = await inspectNodeRepositoryTree(root, RETICLE_URL);

        expect(result.workspaces.map(({ path }) => path)).toEqual(['.', 'apps/bench-app', 'core', 'server']);
        expect(result.workspaces.find(({ path }) => path === 'server')?.workspaceDependencies)
            .toEqual(['@reticlehq/core']);
        expect(result.launchTargets).toEqual([expect.objectContaining({
            name: 'reticle-daemon', kind: 'service', integrationAdapter: 'reticle-v1',
            workspacePath: 'server', internalPort: 4400,
        })]);
        expect(result.launchTargets.some((target) => target.workspacePath === 'apps/bench-app')).toBe(false);
        expect(result.stateRequirements).toEqual([expect.objectContaining({ kind: 'filesystem' })]);
        expect(result.license?.identifier).toBe('FSL-1.1-ALv2');
        expect(result.compatibility).toEqual({
            status: 'needs-configuration',
            reasons: ['configuration-required', 'license-review-required'],
        });

        const contract = validateRepositoryInspection({
            schemaVersion: 1,
            submissionId: '11111111-1111-1111-1111-111111111111',
            repositoryUrl: RETICLE_URL,
            commitSha: '39cc34a84bfb78023154c9f4e99c61f3cbe8fc19',
            archiveDigest: `sha256:${'a'.repeat(64)}`,
            ...result,
        });
        expect(contract).toMatchObject({ success: true });
    });

    it('does not infer an integration adapter from a URL alone', async () => {
        const { root, put } = await fixture();
        await put('server/src/command/cli/cli-parse.ts', 'const usage = "unrelated command";\n');
        const result = await inspectNodeRepositoryTree(root, RETICLE_URL);

        expect(result.launchTargets).toEqual([]);
        expect(result.compatibility.reasons).toContain('missing-web-ui');
        expect(result.license).toBeUndefined();
    });

    it('reports a non-GitHub host without reading its checkout as an approved source', async () => {
        const result = await inspectNodeRepositoryTree('/path/does/not/exist', 'https://git.example.com/org/repo');
        expect(result).toMatchObject({
            workspaces: [], launchTargets: [],
            compatibility: { status: 'unsupported', reasons: ['unsupported-host'] },
        });
    });

    it('ignores a package.json symlink that escapes the checkout', async () => {
        const { root } = await fixture();
        const outside = await mkdtemp(join(tmpdir(), 'ezil-repository-outside-'));
        roots.push(outside);
        await writeFile(join(outside, 'private.json'), JSON.stringify({ name: '@reticlehq/server' }));
        await rm(join(root, 'server/package.json'));
        await symlink(join(outside, 'private.json'), join(root, 'server/package.json'));

        const result = await inspectNodeRepositoryTree(root, RETICLE_URL);
        expect(result.workspaces.some(({ path }) => path === 'server')).toBe(false);
        expect(result.launchTargets).toEqual([]);
    });

    it('does not follow a symlinked workspace directory', async () => {
        const { root } = await fixture();
        const outside = await mkdtemp(join(tmpdir(), 'ezil-repository-outside-'));
        roots.push(outside);
        await writeFile(join(outside, 'package.json'), JSON.stringify({ name: '@reticlehq/server' }));
        await rm(join(root, 'server'), { recursive: true });
        await symlink(outside, join(root, 'server'));

        const result = await inspectNodeRepositoryTree(root, RETICLE_URL);
        expect(result.workspaces.some(({ path }) => path === 'server')).toBe(false);
        expect(result.launchTargets).toEqual([]);
    });

    it('recognizes a locked npm repository without a packageManager declaration', async () => {
        const { root, put } = await fixture();
        await put('package.json', JSON.stringify({ name: 'plain-npm-app' }));
        await rm(join(root, 'pnpm-workspace.yaml'));
        await rm(join(root, 'pnpm-lock.yaml'));
        await put('package-lock.json', '{"lockfileVersion":3}');

        const result = await inspectNodeRepositoryTree(root, 'https://github.com/example/plain-npm-app');
        expect(result.workspaces).toEqual([expect.objectContaining({
            path: '.', name: 'plain-npm-app', packageManager: 'npm',
        })]);
        expect(result.compatibility.reasons).not.toContain('missing-lockfile');
        expect(result.compatibility.reasons).not.toContain('build-or-runtime-unknown');
    });

    it('reports unsupported workspace globs and missing lockfiles explicitly', async () => {
        const { root, put } = await fixture();
        await put('pnpm-workspace.yaml', "packages:\n  - '**/package'\n");
        await rm(join(root, 'pnpm-lock.yaml'));

        const result = await inspectNodeRepositoryTree(root, RETICLE_URL);
        expect(result.compatibility.reasons).toContain('build-or-runtime-unknown');
        expect(result.compatibility.reasons).toContain('missing-lockfile');
        expect(result.launchTargets).toEqual([]);
    });
});
