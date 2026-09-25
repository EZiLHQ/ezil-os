import { describe, expect, it } from 'vitest';

import { ComputerAppManifestV2Schema, getComputerManifestDigest } from './computer-app-manifest';
import { validateComputerPolicyAgainstManifest } from './approved-computer-app-policy';

const APP = 'a1111111-1111-4111-8111-111111111111';
const PUBLISHER = 'b2222222-2222-4222-8222-222222222222';
const SECRET = 'c3333333-3333-4333-8333-333333333333';
const DIGEST = `sha256:${'d'.repeat(64)}`;

function manifest(overrides: Record<string, unknown> = {}) {
    return {
        schemaVersion: 2, appId: APP, publisherId: PUBLISHER,
        name: 'Notes', slug: 'notes', version: '1.0.0',
        source: { kind: 'github', url: 'https://github.com/acme/notes', commitSha: 'a'.repeat(40) },
        runtime: { profile: 'node24-computer-v1', architecture: 'linux/amd64' },
        build: { recipe: 'npm-ci-v1', script: 'build' },
        services: [{ name: 'web', protocol: 'http', scope: 'installation', internalPort: 8080,
            process: { kind: 'node', entrypoint: 'dist/server.mjs', args: [] },
            preferredHostPort: 8080, health: { path: '/health', status: 200 }, dependsOn: [] }],
        launch: { mode: 'web', service: 'web', path: '/', embedding: { mode: 'iframe', sandbox: ['allow-scripts', 'allow-same-origin'] } },
        configuration: [], capabilities: ['projects.read'], secrets: [{ name: 'APP_TOKEN', ref: SECRET }],
        egressOrigins: ['https://api.partner.example.com'],
        resources: { cpu: 0.25, memoryMiB: 512, ephemeralDiskMiB: 1024, maxRuntimeSeconds: 3600 },
        persistence: { mode: 'computer-volume',
            privateDirectories: [{ name: 'state', containerPath: '/data/state' }],
            sharedFolders: [{ folder: 'Projects', access: 'read', scope: 'selected-projects', containerPath: '/workspace/projects' }],
            backup: { mode: 'daily-snapshot' } },
        update: { strategy: 'compatible', stateVersion: '1' },
        ...overrides,
    };
}

function policy(forManifest: unknown = manifest(), overrides: Record<string, unknown> = {}) {
    const parsed = ComputerAppManifestV2Schema.parse(forManifest);
    return {
        schemaVersion: 2,
        manifestDigest: getComputerManifestDigest(parsed),
        image: { reference: `registry.example.com/ezil/notes@${DIGEST}`, provenanceDigest: DIGEST },
        allowedOsOrigins: ['https://os.ezil.org'], appOriginBase: 'https://apps.ezil.org',
        launch: parsed.launch.mode === 'web'
            ? { mode: 'web', embedding: parsed.launch.embedding }
            : { mode: 'integration', adapter: parsed.launch.adapter },
        services: [{ name: 'web', scope: 'installation', processKind: 'node', internalPort: 8080 }],
        capabilities: ['projects.read'], secretBindings: [{ name: 'APP_TOKEN', ref: SECRET }],
        egressOrigins: ['https://api.partner.example.com'],
        mounts: { privateDirectories: ['state'], sharedFolders: [{ folder: 'Projects', access: 'read', scope: 'selected-projects' }] },
        resources: { cpuLimit: 0.5, memoryLimitMiB: 1024, ephemeralDiskLimitMiB: 2048, maxRuntimeSeconds: 3600 },
        lifecycle: { idleTimeoutSeconds: 600 }, quotas: { runningAppsPerComputer: 2 },
        backup: { mode: 'daily-snapshot', retentionDays: 7 },
        ...overrides,
    };
}

function reticleManifest() {
    return manifest({
        name: 'Reticle', slug: 'reticle',
        source: { kind: 'github', url: 'https://github.com/reticlehq/reticle', commitSha: '39cc34a84bfb78023154c9f4e99c61f3cbe8fc19' },
        build: { recipe: 'pnpm-workspace-v1', workspace: 'server', pnpmVersion: '10.33.2',
            lockfileDigest: `sha256:${'b'.repeat(64)}`, script: 'build' },
        services: [{ name: 'daemon', protocol: 'http', scope: 'selected-project', internalPort: 4400,
            process: { kind: 'reticle-daemon-v1' },
            preferredHostPort: 4400, health: { path: '/status', status: 200 }, dependsOn: [] }],
        launch: { mode: 'integration', adapter: 'reticle-v1', service: 'daemon' },
        capabilities: ['projects.read', 'projects.write', 'runs.read', 'mcp.invoke'],
        secrets: [], egressOrigins: [],
        persistence: { mode: 'computer-volume',
            privateDirectories: [{ name: 'state', containerPath: '/data/reticle' }],
            sharedFolders: [{ folder: 'Projects', access: 'read-write', scope: 'selected-projects', containerPath: '/workspace/projects' }],
            backup: { mode: 'daily-snapshot' } },
    });
}

function reticlePolicy(input = reticleManifest()) {
    return policy(input, {
        services: [{ name: 'daemon', scope: 'selected-project', processKind: 'reticle-daemon-v1', internalPort: 4400 }],
        capabilities: ['projects.read', 'projects.write', 'runs.read', 'mcp.invoke'],
        secretBindings: [], egressOrigins: [],
        mounts: { privateDirectories: ['state'], sharedFolders: [{ folder: 'Projects', access: 'read-write', scope: 'selected-projects' }] },
    });
}

function issue(inputManifest: unknown, inputPolicy: unknown, path: (string | number)[], code?: string) {
    const result = validateComputerPolicyAgainstManifest(inputManifest, inputPolicy);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path, ...(code ? { code } : {}) }),
    ]));
}

describe('ApprovedComputerAppPolicyV2', () => {
    it('accepts a bounded Node policy with a narrower selected-project mount', () => {
        expect(validateComputerPolicyAgainstManifest(manifest(), policy())).toMatchObject({ success: true });
        const requestedWholeFolder = manifest({ persistence: { mode: 'computer-volume',
            privateDirectories: [{ name: 'state', containerPath: '/data/state' }],
            sharedFolders: [{ folder: 'Projects', access: 'read-write', scope: 'whole-folder', containerPath: '/workspace/projects' }],
            backup: { mode: 'daily-snapshot' } } });
        expect(validateComputerPolicyAgainstManifest(requestedWholeFolder, policy(requestedWholeFolder))).toMatchObject({ success: true });
    });

    it('accepts Reticle only with matching project-scoped daemon and selected-project write mount', () => {
        const input = reticleManifest();
        expect(validateComputerPolicyAgainstManifest(input, reticlePolicy(input))).toMatchObject({ success: true });
        issue(input, { ...reticlePolicy(input), mounts: { privateDirectories: ['state'], sharedFolders: [] } },
            ['policy', 'mounts', 'sharedFolders'], 'integration_requires_approved_projects');
        issue(input, { ...reticlePolicy(input), capabilities: [] },
            ['policy', 'capabilities'], 'integration_requires_approved_project_capabilities');
        issue(input, { ...reticlePolicy(input), capabilities: ['projects.read'] },
            ['policy', 'capabilities'], 'integration_requires_approved_project_capabilities');
        issue(input, { ...reticlePolicy(input), capabilities: ['projects.write'] },
            ['policy', 'capabilities'], 'custom');
    });

    it('rejects an approval that widens a project mount to the whole folder', () => {
        issue(manifest(), { ...policy(), mounts: { privateDirectories: ['state'],
            sharedFolders: [{ folder: 'Projects', access: 'read', scope: 'whole-folder' }] } },
        ['policy', 'mounts', 'sharedFolders', 0], 'folder_authority_exceeds_request');
        issue(manifest(), { ...policy(), mounts: { privateDirectories: ['state'],
            sharedFolders: [{ folder: 'Projects', access: 'read-write', scope: 'selected-projects' }] } },
        ['policy', 'mounts', 'sharedFolders', 0], 'folder_authority_exceeds_request');
    });

    it('rejects OS origins inside the installation-origin namespace', () => {
        issue(manifest(), { ...policy(), allowedOsOrigins: [`https://i-${APP}.apps.ezil.org`] },
            ['policy', 'appOriginBase'], 'custom');
        issue(manifest(), { ...policy(), allowedOsOrigins: ['https://nested.apps.ezil.org'] },
            ['policy', 'appOriginBase'], 'custom');
        expect(validateComputerPolicyAgainstManifest(manifest(), policy())).toMatchObject({ success: true });
    });

    it('bounds the base host so a generated installation origin remains a valid DNS name', () => {
        const base = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(28)}.com`;
        expect(base.length).toBe(215);
        issue(manifest(), { ...policy(), appOriginBase: `https://${base}` },
            ['policy', 'appOriginBase'], 'custom');
        expect(validateComputerPolicyAgainstManifest(manifest(), {
            ...policy(), appOriginBase: `https://${base.replace(`${'d'.repeat(28)}.com`, `${'d'.repeat(27)}.com`)}`,
        })).toMatchObject({ success: true });
    });

    it('requires explicit web embedding approval without extra sandbox authority', () => {
        issue(manifest(), { ...policy(), launch: { mode: 'web', embedding: { mode: 'iframe',
            sandbox: ['allow-scripts', 'allow-same-origin', 'allow-popups'] } } },
        ['policy', 'launch', 'embedding', 'sandbox', 2], 'authority_exceeds_request');
        issue(manifest(), { ...policy(), launch: { mode: 'web', embedding: { mode: 'external' } } },
            ['policy', 'launch', 'embedding', 'mode'], 'embedding_mode_mismatch');
        issue(manifest(), { ...policy(), launch: { mode: 'integration', adapter: 'reticle-v1' } },
            ['policy', 'launch', 'mode'], 'launch_mode_mismatch');
        const requested = manifest({ launch: { mode: 'web', service: 'web', path: '/',
            embedding: { mode: 'iframe', sandbox: ['allow-scripts', 'allow-same-origin', 'allow-forms'] } } });
        expect(validateComputerPolicyAgainstManifest(requested, policy(requested, {
            launch: { mode: 'web', embedding: { mode: 'iframe', sandbox: ['allow-scripts', 'allow-same-origin'] } },
        }))).toMatchObject({ success: true });
    });

    it('requires a same-origin iframe only when web capabilities are approved', () => {
        issue(manifest(), { ...policy(), launch: { mode: 'web', embedding: { mode: 'iframe', sandbox: ['allow-scripts'] } } },
            ['policy', 'launch', 'embedding', 'sandbox'], 'capabilities_require_same_origin');
        const noSameOrigin = manifest({ launch: { mode: 'web', service: 'web', path: '/',
            embedding: { mode: 'iframe', sandbox: ['allow-scripts'] } } });
        issue(noSameOrigin, policy(noSameOrigin),
            ['manifest', 'launch', 'embedding', 'sandbox'], 'capabilities_require_same_origin');
        expect(validateComputerPolicyAgainstManifest(noSameOrigin, policy(noSameOrigin, { capabilities: [] })))
            .toMatchObject({ success: true });
        const external = manifest({ launch: { mode: 'web', service: 'web', path: '/', embedding: { mode: 'external' } } });
        issue(external, policy(external), ['policy', 'capabilities'], 'external_window_has_no_bridge');
    });

    it('rejects a service whose approved scope or internal port differs from the manifest', () => {
        issue(manifest(), { ...policy(), services: [{ name: 'web', scope: 'selected-project', processKind: 'node', internalPort: 8080 }] },
            ['policy', 'services', 0], 'service_mismatch');
        issue(manifest(), { ...policy(), services: [{ name: 'web', scope: 'installation', processKind: 'node', internalPort: 9000 }] },
            ['policy', 'services', 0], 'service_mismatch');
        issue(manifest(), { ...policy(), services: [{ name: 'web', scope: 'installation', processKind: 'reticle-daemon-v1', internalPort: 8080 }] },
            ['policy', 'services', 0], 'service_mismatch');
    });

    it('binds the exact immutable manifest and rejects extra authority', () => {
        issue(manifest({ version: '2.0.0' }), policy(), ['policy', 'manifestDigest'], 'manifest_mismatch');
        issue(manifest(), { ...policy(), capabilities: ['projects.read', 'mcp.invoke'] },
            ['policy', 'capabilities', 1], 'authority_exceeds_request');
        issue(manifest(), { ...policy(), egressOrigins: ['https://other.example.com'] },
            ['policy', 'egressOrigins', 0], 'authority_exceeds_request');
        issue(manifest(), { ...policy(), secretBindings: [{ name: 'APP_TOKEN', ref: APP }] },
            ['policy', 'secretBindings', 0], 'secret_binding_mismatch');
    });

    it('rejects missing resources, excessive lifetime, backup mismatch and unknown policy fields', () => {
        issue(manifest(), { ...policy(), resources: { ...policy().resources, memoryLimitMiB: 256 } },
            ['policy', 'resources'], 'requirements_not_met');
        issue(manifest(), { ...policy(), resources: { ...policy().resources, maxRuntimeSeconds: 7200 } },
            ['policy', 'resources', 'maxRuntimeSeconds'], 'authority_exceeds_request');
        issue(manifest(), { ...policy(), backup: { mode: 'none' } }, ['policy', 'backup'], 'backup_mismatch');
        issue(manifest(), { ...policy(), arbitraryUpstreamPort: 1234 }, ['policy']);
    });

    it('never includes secret values or unknown property names in public issues', () => {
        const sentinel = 'PRIVATE_KEY_DO_NOT_ECHO';
        const result = validateComputerPolicyAgainstManifest(
            { ...manifest(), [sentinel]: sentinel },
            { ...policy(), [sentinel]: sentinel, secretBindings: [{ name: sentinel, ref: sentinel, value: sentinel }] },
        );
        expect(result.success).toBe(false);
        expect(JSON.stringify(result)).not.toContain(sentinel);
    });
});
