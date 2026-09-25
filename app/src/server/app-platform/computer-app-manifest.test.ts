import { describe, expect, it } from 'vitest';

import {
    checkComputerAppPilotCompatibility,
    getComputerManifestDigest,
    validateComputerAppManifest,
} from './computer-app-manifest';

export const APP_ID = 'a1111111-1111-4111-8111-111111111111';
export const PUBLISHER_ID = 'b2222222-2222-4222-8222-222222222222';
export const SECRET_ID = 'c3333333-3333-4333-8333-333333333333';
export const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;

export function nodeComputerApp(overrides: Record<string, unknown> = {}) {
    return {
        schemaVersion: 2, appId: APP_ID, publisherId: PUBLISHER_ID,
        name: 'Notes', slug: 'notes', version: '1.0.0',
        source: { kind: 'github', url: 'https://github.com/acme/notes', commitSha: 'a'.repeat(40) },
        runtime: { profile: 'node24-computer-v1', architecture: 'linux/amd64' },
        build: { recipe: 'npm-ci-v1', script: 'build' },
        services: [{
            name: 'web', protocol: 'http', scope: 'installation',
            process: { kind: 'node', entrypoint: 'dist/server.mjs', args: [] }, internalPort: 8080,
            preferredHostPort: 8080, health: { path: '/health', status: 200 }, dependsOn: [],
        }],
        launch: { mode: 'web', service: 'web', path: '/', embedding: { mode: 'iframe', sandbox: ['allow-scripts'] } },
        configuration: [], capabilities: [], secrets: [], egressOrigins: [],
        resources: { cpu: 0.25, memoryMiB: 512, ephemeralDiskMiB: 1024, maxRuntimeSeconds: 3600 },
        persistence: {
            mode: 'computer-volume',
            privateDirectories: [{ name: 'state', containerPath: '/data/state' }],
            sharedFolders: [{ folder: 'Documents', access: 'read', scope: 'whole-folder', containerPath: '/workspace/documents' }],
            backup: { mode: 'daily-snapshot' },
        },
        update: { strategy: 'compatible', stateVersion: '1' },
        ...overrides,
    };
}

export function reticleComputerApp(overrides: Record<string, unknown> = {}) {
    return nodeComputerApp({
        name: 'Reticle', slug: 'reticle',
        source: { kind: 'github', url: 'https://github.com/reticlehq/reticle', commitSha: '39cc34a84bfb78023154c9f4e99c61f3cbe8fc19' },
        build: {
            recipe: 'pnpm-workspace-v1', workspace: 'server', pnpmVersion: '10.33.2',
            lockfileDigest: `sha256:${'b'.repeat(64)}`, script: 'build',
        },
        services: [{
            name: 'daemon', protocol: 'http', scope: 'selected-project',
            process: { kind: 'reticle-daemon-v1' }, internalPort: 4400,
            preferredHostPort: 4400, health: { path: '/status', status: 200 }, dependsOn: [],
        }],
        launch: { mode: 'integration', adapter: 'reticle-v1', service: 'daemon' },
        capabilities: ['projects.read', 'projects.write', 'runs.read', 'mcp.invoke'],
        persistence: {
            mode: 'computer-volume',
            privateDirectories: [{ name: 'state', containerPath: '/data/reticle' }],
            sharedFolders: [{ folder: 'Projects', access: 'read-write', scope: 'selected-projects', containerPath: '/workspace/projects' }],
            backup: { mode: 'daily-snapshot' },
        },
        ...overrides,
    });
}

function issues(input: unknown) {
    const result = validateComputerAppManifest(input);
    expect(result.success).toBe(false);
    return result.success ? [] : result.issues;
}

describe('ComputerAppManifestV2', () => {
    it('accepts a pinned Node web app with a persistent computer volume', () => {
        const result = validateComputerAppManifest(nodeComputerApp());
        expect(result.success).toBe(true);
        if (result.success) expect(checkComputerAppPilotCompatibility(result.data)).toEqual({ success: true, data: 'node-web' });
    });

    it('accepts the pinned Reticle workspace as a project-scoped integration candidate', () => {
        const result = validateComputerAppManifest(reticleComputerApp());
        expect(result.success).toBe(true);
        if (result.success) expect(checkComputerAppPilotCompatibility(result.data)).toEqual({ success: true, data: 'reticle-integration' });
    });

    it('recognizes a digest-pinned OCI image but does not admit it to this pilot', () => {
        const input = nodeComputerApp({
            source: { kind: 'oci', image: `registry.example.com/acme/notes@${IMAGE_DIGEST}` },
            runtime: { profile: 'oci-linux-amd64', architecture: 'linux/amd64' }, build: undefined,
            services: [{ ...nodeComputerApp().services[0], process: { kind: 'oci-entrypoint' } }],
        });
        const result = validateComputerAppManifest(input);
        expect(result.success).toBe(true);
        if (result.success) expect(checkComputerAppPilotCompatibility(result.data)).toMatchObject({
            success: false, issues: [{ path: ['source', 'kind'], code: 'unsupported_source' }],
        });
        for (const image of ['registry.example.com/acme/notes:latest', 'registry.example.com/acme/notes']) {
            expect(issues(nodeComputerApp({ source: { kind: 'oci', image }, build: undefined,
                runtime: { profile: 'oci-linux-amd64', architecture: 'linux/amd64' },
                services: [{ ...nodeComputerApp().services[0], process: { kind: 'oci-entrypoint' } }] }))).not.toHaveLength(0);
        }
    });

    it('rejects unpinned source and unknown versions or fields', () => {
        expect(issues(nodeComputerApp({ source: { kind: 'github', url: 'https://github.com/acme/notes', commitSha: 'main' } })))
            .toContainEqual({ path: ['source', 'commitSha'], code: 'too_small' });
        expect(issues(nodeComputerApp({ schemaVersion: 3 }))).not.toHaveLength(0);
        expect(issues(nodeComputerApp({ cloudCredentials: 'should-never-be-accepted' }))).not.toHaveLength(0);
        expect(issues(nodeComputerApp({ services: [{ ...nodeComputerApp().services[0], hostPort: 4400 }] }))).not.toHaveLength(0);
    });

    it('rejects control characters in names without returning their values', () => {
        for (const value of ['Notes\nInjected', 'Notes\u0000Injected', 'Notes\u009bInjected']) {
            const result = validateComputerAppManifest(nodeComputerApp({ name: value }));
            expect(result.success).toBe(false);
            expect(JSON.stringify(result)).not.toContain(value);
        }
    });

    it('rejects unsafe source, entrypoint, paths and ports', () => {
        for (const url of ['http://github.com/acme/notes', 'https://user:pass@github.com/acme/notes',
            'https://github.com/acme/notes/tree/main', 'https://127.0.0.1/acme/notes']) {
            expect(issues(nodeComputerApp({ source: { kind: 'github', url, commitSha: 'a'.repeat(40) } }))).not.toHaveLength(0);
        }
        for (const entrypoint of ['../server.js', '/tmp/server.js', '--inspect.js', 'server.ts']) {
            expect(issues(nodeComputerApp({ services: [{ ...nodeComputerApp().services[0],
                process: { kind: 'node', entrypoint } }] }))).not.toHaveLength(0);
        }
        expect(issues(nodeComputerApp({ launch: { mode: 'web', service: 'web', path: '//evil.example.com', embedding: { mode: 'external' } } }))).not.toHaveLength(0);
        expect(issues(nodeComputerApp({ services: [{ ...nodeComputerApp().services[0], internalPort: 80 }] }))).not.toHaveLength(0);
        expect(issues(nodeComputerApp({ persistence: { mode: 'computer-volume', privateDirectories: [{ name: 'state', containerPath: '/data/../state' }], sharedFolders: [], backup: { mode: 'daily-snapshot' } } }))).not.toHaveLength(0);
    });

    it('rejects duplicate, missing, cyclic, and wrongly scoped services', () => {
        const web = nodeComputerApp().services[0];
        expect(issues(nodeComputerApp({ services: [web, web] }))).toContainEqual({ path: ['services'], code: 'custom' });
        expect(issues(nodeComputerApp({ services: [{ ...web, dependsOn: ['missing'] }] })))
            .toContainEqual({ path: ['services', 0, 'dependsOn', 0], code: 'custom' });
        expect(issues(nodeComputerApp({ services: [{ ...web, dependsOn: ['web'] }] })))
            .toContainEqual({ path: ['services', 0, 'dependsOn', 0], code: 'custom' });
        expect(issues(nodeComputerApp({ services: [{ ...web, scope: 'selected-project' }] })))
            .toContainEqual({ path: ['launch', 'service'], code: 'custom' });
        expect(issues(nodeComputerApp({ services: [{ ...web, process: { kind: 'reticle-daemon-v1' } }] })))
            .toContainEqual({ path: ['services', 0, 'process'], code: 'custom' });
        const projectService = { ...web, name: 'project-api', scope: 'selected-project', dependsOn: [] };
        expect(issues(nodeComputerApp({ services: [{ ...web, dependsOn: ['project-api'] }, projectService] })))
            .toContainEqual({ path: ['services', 0, 'dependsOn', 0], code: 'custom' });
        expect(validateComputerAppManifest(nodeComputerApp({
            services: [web, { ...projectService, dependsOn: ['web'] }],
        }))).toMatchObject({ success: true });
    });

    it('allows two independent processes to use the same internal port and preserves dependency order', () => {
        const web = nodeComputerApp().services[0];
        const api = { ...web, name: 'api', dependsOn: [], preferredHostPort: 8080 };
        const result = validateComputerAppManifest(nodeComputerApp({
            services: [{ ...web, dependsOn: ['api'] }, api],
        }));
        expect(result.success).toBe(true);
    });

    it('requires Reticle integration to bind only an explicitly selected project', () => {
        const base = reticleComputerApp();
        expect(issues({ ...base, source: nodeComputerApp().source }))
            .toContainEqual({ path: ['services', 0, 'process'], code: 'custom' });
        const wrongMount = { mode: 'computer-volume', privateDirectories: [],
            sharedFolders: [{ folder: 'Projects', access: 'read-write', scope: 'whole-folder', containerPath: '/workspace/projects' }],
            backup: { mode: 'daily-snapshot' } };
        const result = validateComputerAppManifest({ ...base, persistence: wrongMount });
        expect(result.success).toBe(true);
        if (result.success) expect(checkComputerAppPilotCompatibility(result.data).success).toBe(false);
        const noWrite = validateComputerAppManifest({ ...base, capabilities: ['projects.read'] });
        expect(noWrite.success).toBe(true);
        if (noWrite.success) expect(checkComputerAppPilotCompatibility(noWrite.data).success).toBe(false);
    });

    it('separates configuration fields from secret references and never echoes their values', () => {
        const sentinel = 'PRIVATE_VALUE_MUST_NOT_APPEAR';
        expect(issues(nodeComputerApp({ configuration: [{ name: 'TOKEN', kind: 'text', required: true }],
            secrets: [{ name: 'TOKEN', ref: SECRET_ID }] })))
            .toContainEqual({ path: ['configuration', 0, 'name'], code: 'custom' });
        const error = issues(nodeComputerApp({ [sentinel]: sentinel, secrets: [{ name: 'TOKEN', ref: SECRET_ID, value: sentinel }] }));
        expect(JSON.stringify(error)).not.toContain(sentinel);
    });

    it('hashes normalized immutable content and changes when source or services change', () => {
        const a = validateComputerAppManifest(nodeComputerApp());
        const { schemaVersion, appId, ...rest } = nodeComputerApp();
        const reordered = validateComputerAppManifest({ ...rest, appId, schemaVersion });
        expect(a.success && reordered.success).toBe(true);
        if (!a.success || !reordered.success) return;
        expect(getComputerManifestDigest(a.data)).toBe(getComputerManifestDigest(reordered.data));
        const changed = validateComputerAppManifest(nodeComputerApp({ services: [{ ...nodeComputerApp().services[0], internalPort: 8081 }] }));
        expect(changed.success).toBe(true);
        if (changed.success) expect(getComputerManifestDigest(changed.data)).not.toBe(getComputerManifestDigest(a.data));
    });
});
